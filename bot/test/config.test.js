import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadConfig, resolveGame, packChoices, gameChoices } from '../src/config.js';
import { launch, stop, currentGame } from '../src/launcher.js';

const example = loadConfig(new URL('../games.example.json', import.meta.url).pathname);

test('resolves a pack game to the pack exe', () => {
  const r = resolveGame(example, '3', 'quiplash2');
  assert.equal(r.game.name, 'Quiplash 2');
  assert.match(r.exe, /The Jackbox Party Pack 3\.exe$/);
  assert.equal(r.viaPackMenu, true);
});

test('matches names loosely', () => {
  assert.equal(resolveGame(example, 'The Jackbox Party Pack 3', 'Trivia Murder Party').game.key, 'triviamurderparty');
  assert.equal(resolveGame(example, '3', 'Quiplash-2').game.key, 'quiplash2');
});

test('a game with its own exe is not launched via a pack menu', () => {
  const r = resolveGame(example, 'standalone', 'quiplash3');
  assert.match(r.exe, /Quiplash3\.exe$/);
  assert.equal(r.viaPackMenu, false);
});

test('unknown pack or game returns null', () => {
  assert.equal(resolveGame(example, '99', 'quiplash2'), null);
  assert.equal(resolveGame(example, '3', 'drawful'), null);
});

test('autocomplete filters by typed text', () => {
  assert.deepEqual(packChoices(example, '3').map((c) => c.value), ['3']);
  assert.deepEqual(gameChoices(example, '3', 'quip').map((c) => c.value), ['quiplash2']);
  assert.deepEqual(gameChoices(example, 'nope', ''), []);
});

test('rejects a game with no exe anywhere', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jb-')), 'g.json');
  fs.writeFileSync(file, JSON.stringify({ packs: { 1: { games: { drawful: {} } } } }));
  assert.throws(() => loadConfig(file), /has no exe/);
});

test('launcher allows one game at a time and clears on exit', () => {
  const exe = process.execPath; // any file that exists
  const fake = new EventEmitter();
  fake.kill = () => fake.emit('exit', 0);
  const calls = [];
  const spawnFn = (...args) => { calls.push(args); return fake; };
  const resolved = { exe, args: ['-x'], game: { name: 'Quiplash 2' }, pack: { name: 'Pack 3' } };

  launch(resolved, { spawnFn });
  assert.equal(calls[0][0], exe);
  assert.equal(calls[0][2].cwd, path.dirname(exe));
  assert.equal(currentGame().game.name, 'Quiplash 2');
  assert.throws(() => launch(resolved, { spawnFn }), /already running/);
  assert.equal(stop().game.name, 'Quiplash 2');
  assert.equal(currentGame(), null);
});

test('runner prefixes the launch command', () => {
  const fake = new EventEmitter();
  fake.kill = () => fake.emit('exit', 0);
  const calls = [];
  const spawnFn = (...args) => { calls.push(args); return fake; };
  launch({ exe: process.execPath, args: ['-x'], runner: ['wine'], game: { name: 'G' }, pack: {} }, { spawnFn });
  assert.deepEqual([calls[0][0], calls[0][1]], ['wine', [process.execPath, '-x']]);
  stop();
});

test('launcher refuses a missing exe', () => {
  assert.throws(() => launch({ exe: '/no/such/game.exe', args: [], game: {}, pack: {} }), /not found/);
});
