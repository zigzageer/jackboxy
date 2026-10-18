import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Linux-host helpers for the virtual screen the game runs on: grab a frame,
// press keys (to pick a game in a pack's menu), and read the room code.
// They need DISPLAY plus ffmpeg, xdotool and tesseract, which server/install.sh sets up.

const run = promisify(execFile);
const display = () => process.env.DISPLAY || ':99';

export function screenAvailable(env = process.env) {
  return process.platform === 'linux' && Boolean(env.DISPLAY);
}

/** One PNG frame of the virtual screen. */
export async function screenshot() {
  const { stdout } = await run('ffmpeg', [
    '-loglevel', 'error', '-f', 'x11grab', '-video_size', process.env.STREAM_SIZE || '1280x720',
    '-i', display(), '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-',
  ], { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

/** Presses xdotool key names in order, e.g. ["Down", "Down", "Return"]. */
export async function sendKeys(keys, { delayMs = 400 } = {}) {
  if (!keys?.length) return;
  await run('xdotool', ['key', '--delay', String(delayMs), ...keys], { env: { ...process.env, DISPLAY: display() } });
}

// Uppercase four-letter words Jackbox screens show that are not room codes.
const NOT_CODES = new Set(['ROOM', 'CODE', 'JOIN', 'PLAY', 'MENU', 'BACK', 'EXIT', 'HELP', 'GAME', 'MORE', 'NEXT', 'SKIP', 'DONE', 'QUIT']);

/**
 * Picks the room code out of tesseract TSV output: Jackbox codes are four
 * capital letters and are the largest such word on the lobby screen.
 */
export function pickRoomCode(tsv) {
  let best = null;
  for (const line of tsv.split('\n').slice(1)) {
    const cols = line.split('\t');
    if (cols.length < 12) continue;
    const height = Number(cols[9]);
    const conf = Number(cols[10]);
    const text = cols[11].trim();
    if (!/^[A-Z]{4}$/.test(text) || NOT_CODES.has(text) || conf < 60) continue;
    if (!best || height > best.height) best = { code: text, height };
  }
  return best?.code ?? null;
}

export async function readRoomCodeOnce() {
  const png = await screenshot();
  const tesseract = execFile('tesseract', ['stdin', 'stdout', 'tsv'], { maxBuffer: 5 * 1024 * 1024 });
  const out = new Promise((resolve, reject) => {
    let data = '';
    tesseract.stdout.on('data', (d) => { data += d; });
    tesseract.once('error', reject);
    tesseract.once('close', () => resolve(data));
  });
  tesseract.stdin.end(png);
  return pickRoomCode(await out);
}

/** Polls the screen until a room code shows up, or returns null after timeoutMs. */
export async function waitForRoomCode({ timeoutMs = 180_000, intervalMs = 4_000, isCancelled = () => false } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !isCancelled()) {
    try {
      const code = await readRoomCodeOnce();
      if (code) return code;
    } catch (err) {
      console.error('[screen] room code read failed:', err.message);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}
