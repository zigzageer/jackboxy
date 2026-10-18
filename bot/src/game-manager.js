import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { launch, stop, waitForLaunch, waitForStop } from './launcher.js';
import { startStream, stopStream, waitForStream } from './streaming.js';
import { sendKeys } from './screen.js';
import { configPath, loadConfig, MENU_KEYS } from './config.js';

function controlError(message) {
  const error = new Error(message);
  error.code = 'GAME_CONTROL';
  return error;
}

// One display means one game. Serialize startup, shutdown and input so a delayed
// request (or an old process exiting) cannot affect a replacement game.
export function createGameManager({
  launchGame = launch, stopGame = stop, launchReady = waitForLaunch, stopped = waitForStop,
  startCapture = startStream, stopCapture = stopStream, streamReady = waitForStream,
  send = sendKeys, env = process.env, now = Date.now,
} = {}) {
  let session = null;
  let reserved = false;
  let operations = Promise.resolve();
  const serialize = (fn) => {
    const result = operations.then(fn);
    operations = result.catch(() => {});
    return result;
  };
  const active = (id) => {
    if (!session || session.id !== id) throw controlError('This game session has ended. Open the link for the current game.');
    return session;
  };

  async function cleanup(target) {
    if (session !== target) return null;
    target.phase = 'stopping';
    target.navigationVersion++;
    try {
      let stopError;
      try { if (target.entry) stopGame({ entry: target.entry }); }
      catch (error) { stopError = error; }
      // Both cleanups must complete before another game can reserve the display.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => stopCapture()),
        target.entry ? Promise.resolve().then(() => stopped(target.entry)) : Promise.resolve(),
      ]);
      const failure = results.find((result) => result.status === 'rejected');
      if (stopError) throw stopError;
      if (failure) throw failure.reason;
      if (session === target) session = null;
      return target;
    } catch (error) {
      target.phase = 'error';
      throw new Error(`Could not fully stop the game: ${error.message}. Check the server logs before launching another pack.`);
    }
  }

  async function start(resolved, { guildId, ownerId, configFile = configPath() } = {}) {
    if (reserved || session) throw controlError('A game is already running or starting. Use /jackbox-stop first.');
    reserved = true;
    return serialize(async () => {
      const target = {
        id: randomUUID(), token: randomBytes(32).toString('base64url'),
        game: resolved.game, pack: resolved.pack, guildId, ownerId, configFile,
        phase: 'starting', roomCode: null, startedAt: new Date(now()),
        menuStatus: 'manual', navigationVersion: 0, capturedSteps: [],
        lastInputAt: null, captureOpen: true, resolved,
      };
      session = target;
      try {
        target.entry = launchGame(resolved);
        target.startedAt = target.entry.startedAt;
        target.entry.child.once('exit', () => {
          if (session !== target || ['stopping', 'error'].includes(target.phase)) return;
          serialize(() => cleanup(target)).catch((error) => console.error('[game]', error.message));
        });
        await launchReady(target.entry);
        target.stream = await startCapture({ game: resolved.game, env });
        if (target.stream) await streamReady({ env });
        if (target.entry.exit || target.entry.error || target.entry.child.exitCode != null || target.entry.child.signalCode != null) {
          throw new Error('The game exited during stream startup. Check the Wine logs.');
        }
        target.phase = 'running';
        return target;
      } catch (error) {
        try { await cleanup(target); }
        catch (cleanupError) { throw new Error(`${error.message}. ${cleanupError.message}`); }
        throw error;
      } finally {
        reserved = false;
      }
    });
  }

  function stopSession(expectedId = session?.id) {
    return serialize(() => {
      if (!session) return null;
      return cleanup(active(expectedId));
    });
  }

  function pressKey(key, expectedId = session?.id) {
    return serialize(async () => {
      const target = active(expectedId);
      if (target.phase !== 'running') throw controlError('Wait until the game is running.');
      if (!MENU_KEYS.has(key)) throw controlError('Unsupported menu key.');
      // Taking manual control cancels any pending automatic sequence.
      target.navigationVersion++;
      if (target.menuStatus === 'replaying' || target.menuStatus === 'ready') {
        target.captureOpen = false;
        target.menuStatus = 'manual';
      }
      if (target.captureOpen && target.capturedSteps.length >= 60) throw controlError('Menu recording is full. Restart the pack to record again.');
      const pressedAt = now();
      const previousAt = target.lastInputAt ?? new Date(target.startedAt).getTime();
      if (target.captureOpen && pressedAt - previousAt > 300_000) throw controlError('Menu recording took too long. Restart the pack to record again.');
      await send([key], { delayMs: 0 });
      if (target.captureOpen) {
        target.capturedSteps.push({ key, delayMs: Math.max(0, Math.round(pressedAt - previousAt)) });
        target.lastInputAt = pressedAt;
      }
    });
  }

  // Run outside the lifecycle queue while sleeping, revalidating the session at
  // every key. Stop/manual control must remain responsive during the delay.
  async function navigate(expectedId) {
    const target = active(expectedId);
    const { resolved } = target;
    const steps = resolved.menuSteps?.length ? resolved.menuSteps : (resolved.keys ?? []).map((key, index) => ({
      key, delayMs: index === 0 ? (resolved.menuDelayMs ?? 20_000) : 400,
    }));
    if (!resolved.viaPackMenu || !steps.length) return;
    target.captureOpen = false;
    target.menuStatus = 'replaying';
    const version = ++target.navigationVersion;
    let first = true;
    for (const step of steps) {
      // Late stream startup may consume the first wait, but must never collapse
      // pauses between Return and keys meant for a newly opened submenu.
      const dueAt = (first ? new Date(target.startedAt).getTime() : now()) + step.delayMs;
      first = false;
      // Short cancellable waits avoid keeping an exited bot alive for minutes.
      while (now() < dueAt) {
        if (session !== target || target.navigationVersion !== version || target.phase !== 'running') return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(200, dueAt - now())));
      }
      const sent = await serialize(async () => {
        if (session !== target || target.navigationVersion !== version || target.phase !== 'running') return false;
        try { await send([step.key], { delayMs: 0 }); }
        catch (error) { target.menuStatus = 'manual'; throw error; }
        return true;
      });
      if (!sent) return;
    }
    if (session === target && target.navigationVersion === version) target.menuStatus = 'ready';
  }

  function saveMenu(expectedId = session?.id) {
    return serialize(() => {
      const target = active(expectedId);
      if (target.phase !== 'running' || !target.captureOpen || !target.capturedSteps.length || !target.resolved.viaPackMenu) {
        throw controlError('Record from a fresh pack launch: select the game with the buttons, then save at its lobby.');
      }
      const file = fs.realpathSync(target.configFile);
      const config = loadConfig(file);
      const game = config.packs[target.pack.key]?.games[target.game.key];
      if (!game) throw controlError('This game was removed from the configuration.');
      game.menuSteps = target.capturedSteps.map((step) => ({ ...step }));
      const temp = path.join(path.dirname(file), `.jackbox-menu-${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: fs.statSync(file).mode & 0o777 });
        fs.renameSync(temp, file);
      } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      }
      target.captureOpen = false;
      target.menuStatus = 'saved';
    });
  }

  return { start, stop: stopSession, pressKey, navigate, saveMenu, current: () => session };
}

export const games = createGameManager();
