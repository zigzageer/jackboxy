import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// One game at a time: the host has one screen and one stream.
let current = null;

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
    stdio: 'ignore',
    windowsHide: false,
  });
  const entry = { child, info: resolved, startedAt: new Date() };
  current = entry;
  const clear = () => {
    if (current === entry) current = null;
  };
  child.once('exit', clear);
  child.once('error', (err) => {
    console.error(`[launcher] ${resolved.exe} failed:`, err);
    clear();
  });
  return entry;
}

/** Kills the running game, if any. Returns what was stopped or null. */
export function stop({ spawnFn = spawn } = {}) {
  if (!current) return null;
  const { child, info } = current;
  current = null;
  child.kill();
  // Wine keeps the game alive after its launcher process dies; end the whole session.
  if (/wine|proton/i.test(info.runner?.[0] ?? '')) {
    spawnFn('wineserver', ['-k'], { stdio: 'ignore' }).once('error', () => {});
  }
  return info;
}
