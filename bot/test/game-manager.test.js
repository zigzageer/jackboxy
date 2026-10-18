import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGameManager } from '../src/game-manager.js';
import { loadConfig, resolveGame } from '../src/config.js';
import { waitForLaunch, waitForStop } from '../src/launcher.js';

const resolved = {
  pack: { key: '3', name: 'Pack 3' }, game: { key: 'quiplash2', name: 'Quiplash 2' },
  exe: process.execPath, args: [], runner: [], keys: [], viaPackMenu: true,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function host(overrides = {}) {
  const calls = { launches: [], stops: [], captureStarts: [], captureStops: 0, sent: [] };
  const now = overrides.now ?? Date.now;
  const manager = createGameManager({
    env: {}, now,
    launchGame: (game) => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
      const entry = { child, startedAt: new Date(now()) };
      calls.launches.push({ game, entry });
      return entry;
    },
    stopGame: ({ entry }) => {
      calls.stops.push(entry);
      if (entry.child.exitCode == null) {
        entry.child.exitCode = 0;
        entry.child.emit('exit', 0, null);
      }
    },
    launchReady: async () => {}, stopped: async () => {},
    startCapture: async (options) => { calls.captureStarts.push(options); return { url: 'https://watch.test/game' }; },
    stopCapture: async () => { calls.captureStops++; }, streamReady: async () => {},
    send: async (keys) => { calls.sent.push(...keys); },
    ...overrides,
  });
  return { manager, calls };
}

test('startup reserves the display before launch and waits for the stream before reporting success', async (t) => {
  const launched = deferred();
  const stream = deferred();
  const { manager, calls } = host({ launchReady: () => launched.promise, streamReady: () => stream.promise });
  t.after(async () => { launched.resolve(); stream.resolve(); await manager.stop(); });
  const starting = manager.start(resolved, { guildId: 'guild' });
  await assert.rejects(manager.start(resolved), /already running or starting/);
  await new Promise(setImmediate);
  assert.equal(calls.launches.length, 1);
  assert.equal(calls.captureStarts.length, 0);
  assert.equal(manager.current().phase, 'starting');
  launched.resolve();
  await new Promise(setImmediate);
  assert.equal(calls.captureStarts.length, 1);
  assert.equal(manager.current().phase, 'starting');
  await assert.rejects(manager.start(resolved), /already running or starting/);
  stream.resolve();
  const session = await starting;
  assert.equal(session.phase, 'running');
  assert.equal(session.guildId, 'guild');
  assert.ok(session.token.length >= 40);
});

test('stream readiness failure stops the launched game and capture and frees the display', async (t) => {
  let attempts = 0;
  const { manager, calls } = host({ streamReady: async () => {
    if (++attempts === 1) throw new Error('RTSP has no audio');
  } });
  t.after(() => manager.stop());
  await assert.rejects(manager.start(resolved), /RTSP has no audio/);
  assert.equal(calls.stops.length, 1);
  assert.equal(calls.captureStops, 1);
  assert.equal(manager.current(), null);
  const replacement = await manager.start(resolved);
  assert.equal(replacement.phase, 'running');
  assert.equal(calls.launches.length, 2);
});

test('the display remains occupied until both process and capture cleanup finish', async (t) => {
  const processStopped = deferred();
  const captureStopped = deferred();
  const { manager } = host({ stopped: () => processStopped.promise, stopCapture: () => captureStopped.promise });
  t.after(async () => { processStopped.resolve(); captureStopped.resolve(); await manager.stop(); });
  const session = await manager.start(resolved);
  const stopping = manager.stop(session.id);
  await new Promise(setImmediate);
  assert.equal(manager.current().phase, 'stopping');
  await assert.rejects(manager.start(resolved), /already running or starting/);
  processStopped.resolve();
  await new Promise(setImmediate);
  assert.equal(manager.current().id, session.id);
  await assert.rejects(manager.start(resolved), /already running or starting/);
  captureStopped.resolve();
  await stopping;
  assert.equal(manager.current(), null);
});

test('failed cleanup blocks another launch until a later stop succeeds', async (t) => {
  t.mock.method(console, 'error', () => {});
  let failCleanup = true;
  const { manager, calls } = host({ stopCapture: async () => {
    if (failCleanup) throw new Error('capture still alive');
  } });
  const session = await manager.start(resolved);
  await assert.rejects(manager.stop(session.id), /Could not fully stop the game: capture still alive/);
  await new Promise(setImmediate);
  assert.equal(manager.current().phase, 'error');
  await assert.rejects(manager.start(resolved), /already running or starting/);
  assert.equal(calls.launches.length, 1);
  failCleanup = false;
  await manager.stop(session.id);
  assert.equal(manager.current(), null);
});

test('old session controls cannot send input or stop a replacement game', async (t) => {
  const { manager, calls } = host();
  t.after(() => manager.stop());
  const old = await manager.start(resolved);
  await manager.stop(old.id);
  const replacement = await manager.start(resolved);
  assert.notEqual(replacement.id, old.id);
  assert.notEqual(replacement.token, old.token);
  await assert.rejects(manager.pressKey('Return', old.id), /session has ended/);
  await assert.rejects(manager.stop(old.id), /session has ended/);
  await assert.rejects(manager.navigate(old.id), /session has ended/);
  await assert.rejects(manager.saveMenu(old.id), /session has ended/);
  assert.equal(manager.current().id, replacement.id);
  assert.deepEqual(calls.sent, []);
  assert.equal(calls.stops.length, 1);
});

test('an unexpected game exit removes the session and expires its controls', async () => {
  const { manager, calls } = host();
  const session = await manager.start(resolved);
  session.entry.child.exitCode = 1;
  session.entry.child.emit('exit', 1, null);
  await new Promise(setImmediate);
  assert.equal(manager.current(), null);
  assert.equal(calls.captureStops, 1);
  await assert.rejects(manager.pressKey('Return', session.id), /session has ended/);
});

test('saving a recorded menu keeps the rest of the configuration and measured delays', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jackbox-menu-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'games.json');
  const config = {
    runner: ['wine'], custom: { keep: true },
    packs: { 3: { name: 'Pack 3', exe: '/games/pack3.exe', args: ['-windowed'], menuDelayMs: 200,
      games: { quiplash2: { name: 'Quiplash 2', aliases: ['quip'], keys: ['Down', 'Return'], custom: 'keep this too' } } } },
  };
  fs.writeFileSync(file, JSON.stringify(config));
  let clock = 1_000;
  const { manager, calls } = host({ now: () => clock });
  t.after(() => manager.stop());
  const session = await manager.start(resolveGame(loadConfig(file), '3', 'quip'), { configFile: file });
  clock = 1_180;
  await manager.pressKey('Down', session.id);
  clock = 1_630;
  await manager.pressKey('Return', session.id);
  await manager.saveMenu(session.id);
  const saved = loadConfig(file);
  config.packs[3].games.quiplash2.menuSteps = [
    { key: 'Down', delayMs: 180 }, { key: 'Return', delayMs: 450 },
  ];
  assert.deepEqual(saved, config);
  assert.deepEqual(calls.sent, ['Down', 'Return']);
  assert.equal(session.menuStatus, 'saved');
  await manager.pressKey('space', session.id);
  await assert.rejects(manager.saveMenu(session.id), /fresh pack launch/);
  assert.deepEqual(loadConfig(file), config);
  assert.deepEqual(fs.readdirSync(directory), ['games.json']);
});

test('recorded menu replay honors the launch delay and pauses between keys', async (t) => {
  const sent = [];
  const { manager } = host({ now: Date.now, send: async ([key]) => sent.push({ key, at: Date.now() }) });
  t.after(() => manager.stop());
  const session = await manager.start({ ...resolved, keys: ['Escape'], menuSteps: [
    { key: 'Down', delayMs: 20 }, { key: 'Return', delayMs: 25 },
  ] });
  await manager.navigate(session.id);
  assert.deepEqual(sent.map(({ key }) => key), ['Down', 'Return']);
  const startedAt = session.startedAt.getTime();
  assert.ok(sent[0].at >= startedAt + 20);
  assert.ok(sent[1].at - sent[0].at >= 25);
  assert.equal(session.menuStatus, 'ready');
});

test('late stream readiness preserves the saved pause before opening the next submenu', async (t) => {
  const sent = [];
  const { manager } = host({
    now: Date.now,
    streamReady: () => new Promise((resolve) => setTimeout(resolve, 100)),
    send: async ([key]) => { sent.push({ key, at: Date.now() }); },
  });
  t.after(() => manager.stop());
  const session = await manager.start({ ...resolved, menuSteps: [
    { key: 'Return', delayMs: 20 }, { key: 'Down', delayMs: 25 },
  ] });
  assert.ok(Date.now() - session.startedAt.getTime() > 45, 'stream readiness consumed both original launch-relative deadlines');
  await manager.navigate(session.id);
  assert.deepEqual(sent.map(({ key }) => key), ['Return', 'Down']);
  assert.ok(sent[1].at - sent[0].at >= 25, 'opening a submenu must retain its recorded pause after late stream readiness');
  assert.equal(session.menuStatus, 'ready');
});

test('taking manual control cancels the remaining recorded menu keys', async (t) => {
  const firstKey = deferred();
  const sent = [];
  const { manager } = host({ send: async ([key]) => { sent.push(key); if (key === 'Down') firstKey.resolve(); } });
  t.after(() => manager.stop());
  const session = await manager.start({ ...resolved, menuSteps: [
    { key: 'Down', delayMs: 0 }, { key: 'Return', delayMs: 40 },
  ] });
  const navigating = manager.navigate(session.id);
  await firstKey.promise;
  await manager.pressKey('Escape', session.id);
  await navigating;
  assert.deepEqual(sent, ['Down', 'Escape']);
  assert.equal(session.menuStatus, 'manual');
});

test('stopping during a recorded menu delay prevents later key presses', async () => {
  const { manager, calls } = host();
  const session = await manager.start({ ...resolved, menuSteps: [{ key: 'Return', delayMs: 40 }] });
  const navigating = manager.navigate(session.id);
  await manager.stop(session.id);
  await navigating;
  assert.deepEqual(calls.sent, []);
  assert.equal(manager.current(), null);
});

test('a real launched process is reaped before its game session finishes stopping', async (t) => {
  const manager = createGameManager({
    env: {}, startCapture: async () => null, stopCapture: async () => {},
    launchReady: (entry) => waitForLaunch(entry, { settleMs: 10, timeoutMs: 2_000 }),
    stopped: (entry) => waitForStop(entry, { timeoutMs: 2_000 }),
  });
  t.after(() => manager.stop());
  const session = await manager.start({ ...resolved, args: ['-e', 'setInterval(() => {}, 1000)'] });
  assert.equal(session.phase, 'running');
  assert.ok(session.entry.child.pid > 0);
  await manager.stop(session.id);
  assert.equal(manager.current(), null);
  assert.ok(session.entry.child.exitCode !== null || session.entry.child.signalCode !== null);
});
