import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// One game at a time: the host has one screen and one stream.
let current = null;
let lastStopped = null;

function failure(entry) {
  if (entry.error) return new Error(`Could not launch ${entry.command}: ${entry.error.message}`);
  if (entry.exit) {
    const reason = entry.exit.signal ? `signal ${entry.exit.signal}` : `code ${entry.exit.code}`;
    return new Error(`${entry.command} exited before startup completed (${reason}). Check the host's game logs.`);
  }
  return null;
}

export function currentGame() {
  return current && { ...current.info, startedAt: current.startedAt };
}

/** Starts the resolved game's executable. Throws if one is already running or the exe is missing. */
export function launch(resolved, { spawnFn = spawn } = {}) {
  if (current) {
    throw new Error(`${current.info.game.name} is already running. Use /jackbox-stop first.`);
  }
  if (!fs.existsSync(resolved.exe)) {
    throw new Error(`Executable not found on the host: ${resolved.exe}`);
  }
  const [cmd, ...cmdArgs] = [...(resolved.runner ?? []), resolved.exe, ...resolved.args];
  const child = spawnFn(cmd, cmdArgs, {
    cwd: path.dirname(resolved.exe),
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: false,
  });
  const entry = { child, info: resolved, command: cmd, startedAt: new Date(), spawned: false, exit: null, error: null };
  current = entry;
  const clear = () => {
    if (current === entry) current = null;
  };
  child.once('spawn', () => { entry.spawned = true; });
  child.once('exit', (code, signal) => {
    entry.exit = { code, signal };
    clear();
  });
  child.on('error', (err) => {
    entry.error = err;
    console.error(`[launcher] ${resolved.exe} failed:`, err.message);
    if (!entry.spawned && !child.pid) clear();
  });
  return entry;
}

/** Confirms that the process spawned and survived an initial startup interval. */
export function waitForLaunch(entry, { settleMs = 750, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let settleTimer;
    let timeoutTimer;
    const finish = (error) => {
      clearTimeout(settleTimer);
      clearTimeout(timeoutTimer);
      entry.child.off('spawn', onSpawn);
      entry.child.off('exit', onExit);
      entry.child.off('error', onError);
      if (error) reject(error);
      else resolve(entry);
    };
    const onExit = () => finish(failure(entry));
    const onError = () => finish(failure(entry));
    const onSpawn = () => {
      if (settleTimer) return;
      settleTimer = setTimeout(() => finish(failure(entry)), settleMs);
    };
    entry.child.on('spawn', onSpawn);
    entry.child.on('exit', onExit);
    entry.child.on('error', onError);
    timeoutTimer = setTimeout(() => finish(new Error(`Timed out waiting for ${entry.command} to start.`)), timeoutMs);
    const error = failure(entry);
    if (error) finish(error);
    else if (entry.spawned) onSpawn();
  });
}

/** Kills the running game, if any. Returns what was stopped or null. */
export function stop({ spawnFn = spawn, entry: requestedEntry } = {}) {
  if (current && requestedEntry && current !== requestedEntry) throw new Error('A different game is now running.');
  const entry = current ?? requestedEntry;
  if (!entry) return null;
  const { child, info } = entry;
  current = null;
  lastStopped = entry;
  // A previous failed signal should not make a later stop attempt fail before
  // the process has a chance to acknowledge the new signal.
  if (!entry.exit && (entry.spawned || child.pid)) entry.error = null;
  child.kill();
  // Wine keeps the game alive after its launcher process dies; end the whole session.
  if (/wine|proton/i.test(info.runner?.[0] ?? '')) {
    const cleanup = { child: spawnFn('wineserver', ['-k'], { stdio: ['ignore', 'inherit', 'inherit'] }), exit: null, error: null };
    entry.cleanup = cleanup;
    cleanup.child.once('exit', (code, signal) => { cleanup.exit = { code, signal }; });
    cleanup.child.once('error', (error) => { cleanup.error = error; });
  }
  return info;
}

/** Waits for both the game and Wine cleanup before another game can start. */
export async function waitForStop(entry = lastStopped, { timeoutMs = 5000 } = {}) {
  if (!entry) return;
  const wait = (processEntry, label, requireSuccess = false) => new Promise((resolve, reject) => {
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      processEntry.child.off('exit', onExit);
      processEntry.child.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => {
      const exit = processEntry.exit;
      finish(requireSuccess && (exit.code !== 0 || exit.signal)
        ? new Error(`${label} failed (${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}).`)
        : null);
    };
    const onError = () => finish(requireSuccess || processEntry.spawned || processEntry.child.pid
      ? new Error(`${label} failed: ${processEntry.error.message}`) : null);
    processEntry.child.on('exit', onExit);
    processEntry.child.on('error', onError);
    timer = setTimeout(() => finish(new Error(`Timed out waiting for ${label} to stop.`)), timeoutMs);
    if (processEntry.exit) onExit();
    else if (processEntry.error) onError();
  });
  await Promise.all([wait(entry, entry.command), ...(entry.cleanup ? [wait(entry.cleanup, 'wineserver -k', true)] : [])]);
}
