import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pickRoomCode } from '../src/screen.js';
import { startStream, stopStream, waitForStream, ffmpegArgs } from '../src/streaming.js';

const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const word = (text, height, conf = 90) => `5\t1\t1\t1\t1\t1\t0\t0\t50\t${height}\t${conf}\t${text}`;

test('picks the tallest four-capital-letter word as the room code', () => {
  const tsv = [header, word('ROOM', 30), word('CODE', 30), word('WXYZ', 20), word('QBRT', 80), word('jackbox.tv', 25)].join('\n');
  assert.equal(pickRoomCode(tsv), 'QBRT');
});

test('ignores low-confidence reads and screens with no code', () => {
  assert.equal(pickRoomCode([header, word('ABCD', 80, 30)].join('\n')), null);
  assert.equal(pickRoomCode([header, word('ROOM', 80), word('Quiplash', 60)].join('\n')), null);
});

test('streaming stays off without STREAM_PUBLIC_URL', async () => {
  let spawned = false;
  const result = await startStream({ game: { name: 'x' }, env: {}, spawnFn: () => { spawned = true; } });
  assert.equal(result, null);
  assert.equal(spawned, false);
});

test('streaming starts ffmpeg once and stops it', async () => {
  const env = { STREAM_PUBLIC_URL: 'http://1.2.3.4:8889/game', DISPLAY: ':99' };
  const calls = [];
  const child = Object.assign(new EventEmitter(), { kill: (sig) => { calls.push(['kill', sig]); child.emit('exit', 0); } });
  const spawnFn = (cmd, args) => { calls.push([cmd, args]); return child; };
  assert.deepEqual(await startStream({ game: { name: 'Q' }, env, spawnFn }), { url: env.STREAM_PUBLIC_URL });
  await startStream({ game: { name: 'Q' }, env, spawnFn });
  assert.equal(calls.filter(([c]) => c === 'ffmpeg').length, 1);
  await stopStream();
  assert.deepEqual(calls.at(-1), ['kill', 'SIGINT']);
});

test('ffmpeg publishes H.264 and Opus to the local MediaMTX path', () => {
  const args = ffmpegArgs({ DISPLAY: ':99' });
  assert.ok(args.includes('libx264') && args.includes('libopus'));
  assert.equal(args.at(-1), 'rtsp://127.0.0.1:8554/game');
});

const streamEnv = { STREAM_PUBLIC_URL: 'https://example.com/game', STREAM_PUBLISH_URL: 'rtsp://127.0.0.1:8554/test' };
const avMedia = { streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] };

function encoder() {
  const child = new EventEmitter();
  child.kill = () => { child.emit('exit', 0, null); return true; };
  return child;
}

test('stream readiness retries until RTSP has both video and audio', async () => {
  const child = encoder();
  await startStream({ env: streamEnv, spawnFn: () => child });
  let probes = 0;
  try {
    const ready = await waitForStream({ env: streamEnv, pollMs: 1, timeoutMs: 1000, probe: async ({ url, timeoutMs, signal }) => {
      assert.equal(url, streamEnv.STREAM_PUBLISH_URL);
      assert.ok(timeoutMs > 0 && timeoutMs <= 1000);
      assert.equal(signal.aborted, false);
      probes++;
      return probes === 1 ? { streams: [{ codec_type: 'video' }] } : avMedia;
    } });
    assert.deepEqual(ready, { url: streamEnv.STREAM_PUBLIC_URL });
    assert.equal(probes, 2);
  } finally { await stopStream(); }
});

test('video without audio never passes stream readiness', async () => {
  const child = encoder();
  await startStream({ env: streamEnv, spawnFn: () => child });
  try {
    await assert.rejects(waitForStream({ env: streamEnv, pollMs: 2, timeoutMs: 20,
      probe: async () => ({ streams: [{ codec_type: 'video' }] }),
    }), /Timed out waiting for RTSP video and audio: RTSP stream is missing audio/);
  } finally { await stopStream(); }
});

test('a hung media probe is bounded and receives cancellation', async () => {
  const child = encoder();
  await startStream({ env: streamEnv, spawnFn: () => child });
  let probeSignal;
  try {
    await assert.rejects(waitForStream({ env: streamEnv, timeoutMs: 20, probe: ({ signal }) => {
      probeSignal = signal;
      return new Promise(() => {});
    } }), /Timed out waiting for RTSP video and audio/);
    assert.equal(probeSignal.aborted, true);
  } finally { await stopStream(); }
});

test('stream readiness preserves an encoder spawn failure before the waiter starts', async () => {
  const child = encoder();
  await startStream({ env: streamEnv, spawnFn: () => child });
  child.emit('error', new Error('spawn ffmpeg ENOENT'));
  await assert.rejects(waitForStream({ env: streamEnv, probe: async () => avMedia }), /Could not start ffmpeg: spawn ffmpeg ENOENT/);
});

test('an encoder exit interrupts a pending probe immediately', async () => {
  const child = encoder();
  await startStream({ env: streamEnv, spawnFn: () => child });
  const pending = waitForStream({ env: streamEnv, timeoutMs: 100, probe: () => new Promise(() => {}) });
  child.emit('exit', 1, null);
  await assert.rejects(pending, /ffmpeg exited before the stream was ready \(code 1\)/);
});

test('a stale encoder error cannot clear the replacement encoder', async () => {
  const first = encoder();
  await startStream({ env: streamEnv, spawnFn: () => first });
  await stopStream();
  const second = encoder();
  await startStream({ env: streamEnv, spawnFn: () => second });
  first.emit('error', new Error('old encoder failure'));
  try {
    assert.deepEqual(await waitForStream({ env: streamEnv, probe: async () => avMedia }), { url: streamEnv.STREAM_PUBLIC_URL });
  } finally { await stopStream(); }
});

test('stopping waits for exit and escalates an unresponsive encoder', async () => {
  const child = encoder();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') child.emit('exit', null, signal);
    return true;
  };
  await startStream({ env: streamEnv, spawnFn: () => child });
  let stopped = false;
  const pending = stopStream({ graceMs: 10, timeoutMs: 100 }).then(() => { stopped = true; });
  await new Promise(setImmediate);
  assert.equal(stopped, false);
  await assert.rejects(startStream({ env: streamEnv, spawnFn: () => encoder() }), /previous stream is still stopping/);
  await pending;
  assert.deepEqual(signals, ['SIGINT', 'SIGKILL']);
});

test('a stop timeout retains the encoder until a later stop succeeds', async () => {
  const child = encoder();
  child.kill = () => true;
  await startStream({ env: streamEnv, spawnFn: () => child });
  await assert.rejects(stopStream({ graceMs: 5, timeoutMs: 15 }), /Timed out stopping ffmpeg/);
  await assert.rejects(startStream({ env: streamEnv, spawnFn: () => encoder() }), /previous stream is still stopping/);
  child.kill = () => { child.emit('exit', 0, null); return true; };
  await stopStream();
});

test('a failed encoder signal rejects stop and permits a later stop retry', async () => {
  const child = encoder();
  await startStream({ env: streamEnv, spawnFn: () => child });
  child.emit('spawn');
  child.kill = () => { child.emit('error', new Error('kill EPERM')); return false; };
  await assert.rejects(stopStream(), /Could not stop ffmpeg: kill EPERM/);
  await assert.rejects(startStream({ env: streamEnv, spawnFn: () => encoder() }), /previous stream is still stopping/);
  child.kill = () => { child.emit('exit', 0, null); return true; };
  await stopStream();
});
