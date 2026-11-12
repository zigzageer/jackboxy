import { fileURLToPath } from 'node:url';
import { createCodexRunner as createSharedRunner } from './rpg/codex-runner.mjs';
export { CODEX_OWNER_ID, CodexRunnerError, sanitizeCodexText } from './rpg/codex-runner.mjs';

export function createCodexRunner(options = {}) {
  return createSharedRunner({ workdir: fileURLToPath(new URL('../../', import.meta.url)), ...options });
}
export const codex = createCodexRunner();
