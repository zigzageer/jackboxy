import { spawn } from 'node:child_process';

// Captures the host's screen and game audio with ffmpeg and publishes it to the
// local MediaMTX server, which serves it to browsers over WebRTC at
// STREAM_PUBLIC_URL. Discord bot accounts cannot Go Live, so players watch
// through that link (and later through a Discord Activity wrapping it).
//
// Off unless STREAM_PUBLIC_URL is set, so the bot still runs on a plain PC.

let ffmpeg = null;
let lastStream = null;

export function streamEnabled(env = process.env) {
  return Boolean(env.STREAM_PUBLIC_URL);
}

/** ffmpeg arguments for a low-latency H.264 + Opus stream (the codecs WebRTC browsers play). */
export function ffmpegArgs(env = process.env) {
  const size = env.STREAM_SIZE || '1280x720';
  const fps = env.STREAM_FPS || '30';
  const bitrate = env.STREAM_BITRATE || '2500k';
  return [
    '-loglevel', 'warning',
    '-thread_queue_size', '512', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', fps, '-video_size', size, '-i', env.DISPLAY || ':99',
    '-thread_queue_size', '512', '-f', 'pulse', '-i', env.STREAM_AUDIO_SOURCE || 'game.monitor',
    ...videoCodecArgs(env.STREAM_CODEC, bitrate, fps),
    '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', env.STREAM_PUBLISH_URL || 'rtsp://127.0.0.1:8554/game',
  ];
}

// H.264 baseline plays in every browser and in Discord, and is cheap to encode.
// STREAM_CODEC=vp8 is a fallback for browsers built without H.264.
function videoCodecArgs(codec, bitrate, fps) {
  const rate = ['-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bitrate, '-g', String(Number(fps) * 2), '-pix_fmt', 'yuv420p'];
  if (codec === 'vp8') return ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', ...rate];
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'baseline', ...rate];
}

/** Starts the capture if streaming is configured. Returns { url } for players, or null when off. */
export async function startStream({ game, spawnFn = spawn, env = process.env } = {}) {
  if (!streamEnabled(env)) return null;
  if (ffmpeg?.stopping) throw new Error('The previous stream is still stopping.');
  if (!ffmpeg) {
    const child = spawnFn('ffmpeg', ffmpegArgs(env), { stdio: ['ignore', 'ignore', 'inherit'] });
    const entry = { child, spawned: false, exit: null, error: null, stopping: false };
    ffmpeg = entry;
    lastStream = entry;
    child.once('spawn', () => { entry.spawned = true; });
    child.once('exit', (code, signal) => {
      entry.exit = { code, signal };
      // Only an exit we did not ask for is worth logging.
      if (ffmpeg === entry) ffmpeg = null;
      if (!entry.stopping) console.error(`[streaming] ffmpeg exited with code ${code}`);
    });
    child.on('error', (err) => {
      entry.error = err;
      console.error('[streaming] could not start ffmpeg:', err.message);
      if (ffmpeg === entry && !entry.spawned && !child.pid) ffmpeg = null;
    });
    console.log(`[streaming] starting capture for ${game?.name ?? 'the screen'}`);
  }
  return { url: env.STREAM_PUBLIC_URL };
}

function encoderFailure(entry) {
  if (!entry) return new Error('No ffmpeg stream has been started.');
  if (entry.error) return new Error(`Could not start ffmpeg: ${entry.error.message}`);
  if (entry.exit) return new Error(`ffmpeg exited before the stream was ready (${entry.exit.signal ? `signal ${entry.exit.signal}` : `code ${entry.exit.code}`}). Check the host's ffmpeg logs.`);
  if (entry.stopping) return new Error('The stream is stopping.');
  return null;
}

// Probe the actual RTSP media, rather than treating an open HTTP port as proof
// that the encoder successfully captured the display and audio sink.
function probeMedia({ url, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let output = '';
    let errors = '';
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        child?.kill('SIGKILL');
        reject(error);
      } else resolve(result);
    };
    const onAbort = () => finish(new Error('Stream probe cancelled.'));
    try {
      child = spawn('ffprobe', [
        '-v', 'error', '-rtsp_transport', 'tcp', '-rw_timeout', String(Math.ceil(timeoutMs * 1000)),
        '-show_entries', 'stream=codec_type', '-of', 'json', url,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish(new Error(`Could not start ffprobe: ${error.message}`));
      return;
    }
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-65536); });
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-8192); });
    child.once('error', (error) => finish(new Error(`Could not start ffprobe: ${error.message}`)));
    child.once('close', (code) => {
      if (code !== 0) {
        // ffprobe may echo authenticated URLs. Keep credentials out of errors.
        const details = errors.replace(/rtsps?:\/\/[^\s'"<>]+/gi, '[RTSP stream]').trim();
        finish(new Error(`ffprobe exited with code ${code}${details ? `: ${details}` : ''}`));
        return;
      }
      try { finish(null, JSON.parse(output)); }
      catch { finish(new Error('ffprobe returned invalid media information.')); }
    });
    timer = setTimeout(() => finish(new Error('ffprobe timed out while reading the RTSP stream.')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Confirms that MediaMTX serves both video and audio from this encoder. */
export function waitForStream({ probe = probeMedia, env = process.env, timeoutMs = 10000, pollMs = 250 } = {}) {
  const entry = ffmpeg ?? lastStream;
  return new Promise((resolve, reject) => {
    const initialError = encoderFailure(entry);
    if (initialError) { reject(initialError); return; }
    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;
    let timer;
    let pollTimer;
    let done = false;
    let lastError = null;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(pollTimer);
      entry.child.off('exit', onFailure);
      entry.child.off('error', onFailure);
      controller.abort();
      if (error) reject(error);
      else resolve({ url: env.STREAM_PUBLIC_URL });
    };
    const onFailure = () => finish(encoderFailure(entry));
    const check = async () => {
      if (done) return;
      const error = encoderFailure(entry);
      if (error) { finish(error); return; }
      try {
        const media = await probe({
          url: env.STREAM_PUBLISH_URL || 'rtsp://127.0.0.1:8554/game',
          timeoutMs: Math.max(1, deadline - Date.now()), signal: controller.signal,
        });
        if (done) return;
        const types = new Set(media?.streams?.map((stream) => stream.codec_type));
        if (types.has('video') && types.has('audio')) { finish(encoderFailure(entry)); return; }
        lastError = new Error(`RTSP stream is missing ${['video', 'audio'].filter((type) => !types.has(type)).join(' and ')}.`);
      } catch (error) {
        lastError = error;
      }
      if (!done) pollTimer = setTimeout(check, Math.min(pollMs, Math.max(1, deadline - Date.now())));
    };
    entry.child.on('exit', onFailure);
    entry.child.on('error', onFailure);
    timer = setTimeout(() => finish(new Error(`Timed out waiting for RTSP video and audio${lastError ? `: ${lastError.message}` : '.'}`)), timeoutMs);
    void check();
  });
}

/** Stops capture completely before a subsequent game can reuse the stream. */
export async function stopStream({ graceMs = 2000, timeoutMs = 5000 } = {}) {
  if (!ffmpeg) return;
  const entry = ffmpeg;
  if (entry.stopPromise) return entry.stopPromise;
  entry.stopping = true;
  const pending = new Promise((resolve, reject) => {
    let graceTimer;
    let timeoutTimer;
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(graceTimer);
      clearTimeout(timeoutTimer);
      entry.child.off('exit', onExit);
      entry.child.off('error', onError);
      if (error) reject(error);
      else {
        if (ffmpeg === entry) ffmpeg = null;
        resolve();
      }
    };
    const onExit = () => finish();
    const onError = (error) => finish(new Error(`Could not stop ffmpeg: ${error.message}`));
    entry.child.on('exit', onExit);
    entry.child.on('error', onError);
    graceTimer = setTimeout(() => {
      try { entry.child.kill('SIGKILL'); }
      catch (error) { finish(error); }
    }, graceMs);
    timeoutTimer = setTimeout(() => finish(new Error('Timed out stopping ffmpeg; check the host before starting another stream.')), timeoutMs);
    try { entry.child.kill('SIGINT'); }
    catch (error) { finish(error); }
  });
  entry.stopPromise = pending;
  try { await pending; }
  finally { if (entry.stopPromise === pending) entry.stopPromise = null; }
}
