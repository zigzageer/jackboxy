import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const script = fileURLToPath(new URL('./contracts/game-reference/scripts/validate-town.mjs', import.meta.url));

export async function validateTownFile({ town, guildId, directory, signal }) {
  signal?.throwIfAborted();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const input = path.join(directory, `.town-validation-${randomUUID()}.json`);
  await writeFile(input, JSON.stringify(town), { flag: 'wx', mode: 0o600 });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      let failure;
      let timedOut = false;
      const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script, input, guildId], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const collect = (chunk) => { output = (output + chunk.toString()).slice(-4000); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const abort = () => { child.kill('SIGTERM'); };
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20_000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.once('error', (error) => { failure = error; });
      child.once('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) return reject(signal.reason);
        if (failure) return reject(new Error('Could not start the shared town validator.', { cause: failure }));
        if (timedOut) return reject(new Error('The shared town validator exceeded its time limit.'));
        if (code !== 0) return reject(new Error(`Town map validation failed. ${output.trim() || `The shared validator exited with code ${code}.`}`));
        resolve();
      });
    });
    return town;
  } finally {
    await rm(input, { force: true });
  }
}
