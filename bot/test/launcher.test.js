import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { launch, stop, currentGame, waitForLaunch, waitForStop } from '../src/launcher.js';

function processDouble({ exitOnKill = true } = {}) {
  const child = new EventEmitter();
  child.kill = () => {
    if (exitOnKill) child.emit('exit', 0, null);
    return true;
  };
  return child;
}

function game(name = 'Test game', runner) {
  return { exe: process.execPath, args: [], game: { name }, pack: {}, runner };
}

test('launch waits for spawn and a survival interval, preserving host logs', async () => {
  const child = processDouble();
  let options;
  const entry = launch(game(), { spawnFn: (_cmd, _args, opts) => { options = opts; return child; } });
  try {
    let ready = false;
    const pending = waitForLaunch(entry, { settleMs: 15, timeoutMs: 1000 }).then(() => { ready = true; });
    await new Promise(setImmediate);
    assert.equal(ready, false);
    child.emit('spawn');
    assert.equal(ready, false);
    await pending;
    assert.equal(ready, true);
    assert.deepEqual(options.stdio, ['ignore', 'inherit', 'inherit']);
  } finally { stop({ entry }); }
});

test('launch readiness rejects an asynchronous spawn failure, even before waiting', async () => {
  const child = processDouble();
  const entry = launch(game(), { spawnFn: () => child });
  child.emit('error', new Error('spawn wine ENOENT'));
  await assert.rejects(waitForLaunch(entry), /Could not launch.*spawn wine ENOENT/);
  assert.equal(currentGame(), null);
});

test('launch readiness rejects a process that exits during startup', async () => {
  const child = processDouble();
  const entry = launch(game(), { spawnFn: () => child });
  const pending = waitForLaunch(entry, { settleMs: 30, timeoutMs: 100 });
  child.emit('spawn');
  child.emit('exit', 53, null);
  await assert.rejects(pending, /exited before startup completed \(code 53\)/);
  assert.equal(currentGame(), null);
});

test('launch readiness is bounded when spawn never arrives', async () => {
  const child = processDouble();
  const entry = launch(game(), { spawnFn: () => child });
  try {
    await assert.rejects(waitForLaunch(entry, { timeoutMs: 15 }), /Timed out waiting/);
    assert.equal(child.listenerCount('spawn'), 1); // launcher metadata listener only
  } finally { stop({ entry }); }
});

test('a real child spawns, survives readiness, and exits before stop resolves', async () => {
  const entry = launch({ ...game(), args: ['-e', 'setTimeout(() => {}, 5000)'] });
  try {
    await waitForLaunch(entry, { settleMs: 20, timeoutMs: 2000 });
    assert.equal(entry.spawned, true);
    assert.equal(entry.exit, null);
  } finally {
    stop({ entry });
    await waitForStop(entry, { timeoutMs: 2000 });
  }
  assert.ok(entry.exit);
});

test('a real game process that immediately fails is rejected', async () => {
  const entry = launch({ ...game(), args: ['-e', 'process.exit(7)'] });
  await assert.rejects(waitForLaunch(entry, { settleMs: 500, timeoutMs: 2000 }), /code 7/);
  assert.equal(currentGame(), null);
});

test('a late exit from an old game cannot clear the new game', () => {
  const first = processDouble({ exitOnKill: false });
  const old = launch(game('First'), { spawnFn: () => first });
  stop({ entry: old });
  const second = processDouble();
  const next = launch(game('Second'), { spawnFn: () => second });
  try {
    first.emit('exit', 0, null);
    assert.equal(currentGame().game.name, 'Second');
  } finally { stop({ entry: next }); }
});

test('stop clears the singleton before a synchronous exit and waits for Wine cleanup', async () => {
  const child = processDouble();
  const cleanup = processDouble();
  const entry = launch(game('Wine game', ['wine']), { spawnFn: () => child });
  let stopped = false;
  stop({ entry, spawnFn: (command, args) => {
    assert.equal(currentGame(), null);
    assert.equal(command, 'wineserver');
    assert.deepEqual(args, ['-k']);
    return cleanup;
  } });
  const pending = waitForStop(entry, { timeoutMs: 100 }).then(() => { stopped = true; });
  await new Promise(setImmediate);
  assert.equal(stopped, false);
  cleanup.emit('exit', 0, null);
  await pending;
  assert.equal(stopped, true);
});

test('an exited Wine launch can still be cleaned up using its entry', async () => {
  const child = processDouble();
  const cleanup = processDouble();
  const entry = launch(game('Wine game', ['wine']), { spawnFn: () => child });
  child.emit('exit', 1, null);
  assert.equal(currentGame(), null);
  assert.equal(stop({ entry, spawnFn: () => cleanup }).game.name, 'Wine game');
  cleanup.emit('exit', 2, null);
  await assert.rejects(waitForStop(entry), /wineserver -k failed \(code 2\)/);
});

test('stop readiness times out rather than allowing an unconfirmed stop', async () => {
  const child = processDouble({ exitOnKill: false });
  const entry = launch(game(), { spawnFn: () => child });
  stop({ entry });
  await assert.rejects(waitForStop(entry, { timeoutMs: 15 }), /Timed out waiting.*to stop/);
  child.emit('exit', 0, null);
});

test('a failed signal does not count as a stopped running process', async () => {
  const child = processDouble();
  const entry = launch(game(), { spawnFn: () => child });
  child.emit('spawn');
  child.kill = () => { child.emit('error', new Error('kill EPERM')); return false; };
  stop({ entry });
  await assert.rejects(waitForStop(entry), /failed: kill EPERM/);
  child.kill = () => { setImmediate(() => child.emit('exit', 0, null)); return true; };
  stop({ entry });
  await waitForStop(entry);
});

test('a runtime process error does not make a still-running game disappear', () => {
  const child = processDouble();
  const entry = launch(game(), { spawnFn: () => child });
  child.emit('spawn');
  try {
    child.emit('error', new Error('kill EPERM'));
    assert.equal(currentGame().game.name, 'Test game');
    assert.throws(() => launch(game(), { spawnFn: () => processDouble() }), /already running/);
  } finally { stop({ entry }); }
});
