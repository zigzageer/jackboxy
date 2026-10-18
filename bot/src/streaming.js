import { spawn } from 'node:child_process';

// Captures the host's screen and game audio with ffmpeg and publishes it to the
// local MediaMTX server, which serves it to browsers over WebRTC at
// STREAM_PUBLIC_URL. Discord bot accounts cannot Go Live, so players watch
// through that link (and later through a Discord Activity wrapping it).
//
// Off unless STREAM_PUBLIC_URL is set, so the bot still runs on a plain PC.

let ffmpeg = null;

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
  if (!ffmpeg) {
    const child = spawnFn('ffmpeg', ffmpegArgs(env), { stdio: ['ignore', 'ignore', 'inherit'] });
    ffmpeg = child;
    child.once('exit', (code) => {
      // Only an exit we did not ask for is worth logging.
      if (ffmpeg !== child) return;
      ffmpeg = null;
      console.error(`[streaming] ffmpeg exited with code ${code}`);
    });
    child.once('error', (err) => {
      console.error('[streaming] could not start ffmpeg:', err.message);
      if (ffmpeg === child) ffmpeg = null;
    });
    console.log(`[streaming] streaming ${game?.name ?? 'the screen'} to ${env.STREAM_PUBLIC_URL}`);
  }
  return { url: env.STREAM_PUBLIC_URL };
}

export async function stopStream() {
  if (!ffmpeg) return;
  const child = ffmpeg;
  ffmpeg = null;
  child.kill('SIGINT');
}
