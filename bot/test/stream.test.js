import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pickRoomCode } from '../src/screen.js';
import { startStream, stopStream, ffmpegArgs } from '../src/streaming.js';

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
  const child = Object.assign(new EventEmitter(), { kill: (sig) => calls.push(['kill', sig]) });
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
