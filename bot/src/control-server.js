import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ALLOWED_KEYS = new Set(['Up', 'Down', 'Left', 'Right', 'Return', 'Escape', 'space', 'Tab']);
const MAX_BODY_BYTES = 1024;
const CONTROL_COOLDOWN_MS = 150;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function publicUrl(value, name) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTP or HTTPS URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be an HTTP or HTTPS URL without credentials`);
  }
  if (name === 'CONTROL_PUBLIC_URL' && (url.pathname !== '/' || url.search || url.hash)) {
    throw new Error('CONTROL_PUBLIC_URL must use the origin root without a query or fragment');
  }
  url.hash = '';
  return url;
}

function tokenMatches(actual, supplied) {
  if (typeof actual !== 'string' || !actual || typeof supplied !== 'string' || !supplied || supplied.length > 4096) return false;
  // Fixed-size digests keep comparisons constant-time even for different token lengths.
  return timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(supplied).digest());
}

function bearerToken(request) {
  const header = request.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
}

function readJson(request) {
  if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json'
      || ![undefined, 'identity'].includes(request.headers['content-encoding'])) {
    request.resume();
    throw new RequestError(415, 'Use an application/json request body.');
  }
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
    request.resume();
    throw new RequestError(413, 'Request body is too large.');
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    const fail = (error) => { if (!done) { done = true; reject(error); } };
    request.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        fail(new RequestError(413, 'Request body is too large.'));
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      if (done) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid object');
        done = true;
        resolve(body);
      } catch { fail(new RequestError(400, 'Request body must be a JSON object.')); }
    });
    request.on('aborted', () => fail(new RequestError(400, 'Request was interrupted.')));
    request.on('error', () => fail(new RequestError(400, 'Could not read the request.')));
  });
}

/** Creates an unlistened server. Only the per-game capability authorizes controls. */
export function createControlServer({
  env = process.env,
  getSession = () => null,
  pressKey = async () => {},
  stopGame = async () => {},
  saveMenu = async () => {},
} = {}) {
  const controlUrl = publicUrl(env.CONTROL_PUBLIC_URL, 'CONTROL_PUBLIC_URL');
  const streamUrl = publicUrl(env.STREAM_PUBLIC_URL, 'STREAM_PUBLIC_URL');
  const allowedOrigin = controlUrl?.origin;
  const assets = new Map([
    ['/', ['text/html; charset=utf-8', readFileSync(new URL('../web/index.html', import.meta.url))]],
    ['/app.js', ['text/javascript; charset=utf-8', readFileSync(new URL('../web/app.js', import.meta.url))]],
    ['/styles.css', ['text/css; charset=utf-8', readFileSync(new URL('../web/styles.css', import.meta.url))]],
  ]);
  let busy = false;
  let lastControl = null;

  function authorize(request, { mutation = false } = {}) {
    const origin = request.headers.origin;
    if ((mutation && (!allowedOrigin || origin !== allowedOrigin)) || (origin && origin !== allowedOrigin)) {
      throw new RequestError(403, 'This control origin is not allowed.');
    }
    const session = getSession();
    if (!session) throw new RequestError(409, 'No game is running.');
    const token = bearerToken(request);
    if (!tokenMatches(session.token, token)) throw new RequestError(401, 'A current host control link is required.');
    return { id: session.id, token };
  }

  function revalidate(captured) {
    const current = getSession();
    if (!current || current.id !== captured.id || !tokenMatches(current.token, captured.token)) {
      throw new RequestError(409, 'The game changed. Open its new host control link.');
    }
  }

  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', [
      "default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
      `frame-src ${streamUrl?.origin || "'none'"}`, "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
    ].join('; '));

    function send(status, body, type = 'application/json; charset=utf-8') {
      if (response.destroyed || response.writableEnded) return;
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(type.startsWith('application/json') ? JSON.stringify(body) : body);
      response.writeHead(status, { 'Content-Type': type, 'Content-Length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    }

    async function route() {
      let pathname;
      try { pathname = new URL(request.url, 'http://control.invalid').pathname; }
      catch { throw new RequestError(400, 'Invalid request URL.'); }
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (assets.has(pathname)) {
          const [type, body] = assets.get(pathname);
          send(200, body, type);
        } else if (pathname === '/healthz') {
          send(200, { ok: true });
        } else if (pathname === '/api/status') {
          const session = getSession();
          send(200, {
            active: Boolean(session), sessionId: session?.id ?? null,
            game: session?.game?.name ?? null, pack: session?.pack?.name ?? null,
            roomCode: session?.roomCode ?? null, streamUrl: streamUrl?.href ?? null,
            phase: session?.phase ?? null, menuStatus: session?.menuStatus ?? null,
          });
        } else if (pathname === '/api/host') {
          const session = authorize(request);
          send(200, { authorized: true, sessionId: session.id });
        } else throw new RequestError(404, 'Not found.');
        return;
      }
      if (request.method !== 'POST') throw new RequestError(405, 'Method not allowed.');
      if (!['/api/key', '/api/stop', '/api/menu'].includes(pathname)) throw new RequestError(404, 'Not found.');
      const captured = authorize(request, { mutation: true });
      const body = await readJson(request);
      if (pathname === '/api/key' && (Object.keys(body).length !== 1 || !ALLOWED_KEYS.has(body.key))) {
        throw new RequestError(400, 'Choose a supported menu key.');
      }
      if (pathname !== '/api/key' && Object.keys(body).length !== 0) throw new RequestError(400, 'This control does not accept parameters.');
      revalidate(captured);
      if (busy || (lastControl?.id === captured.id && Date.now() - lastControl.at < CONTROL_COOLDOWN_MS)) {
        response.setHeader('Retry-After', '1');
        throw new RequestError(429, 'Wait a moment before sending another control.');
      }
      // No pending queue: a slow key/stop cannot accumulate commands for a later game.
      busy = true;
      lastControl = { id: captured.id, at: Date.now() };
      try {
        revalidate(captured);
        if (pathname === '/api/key') await pressKey(body.key, captured.id);
        else if (pathname === '/api/stop') await stopGame(captured.id);
        else await saveMenu(captured.id);
        send(200, pathname === '/api/menu' ? { ok: true, message: 'Menu steps saved for future launches.' } : { ok: true });
      } finally { busy = false; }
    }

    route().catch((error) => {
      request.resume();
      const expectedControlError = error?.code === 'GAME_CONTROL';
      if (!(error instanceof RequestError) && !expectedControlError) {
        let message = typeof error?.message === 'string' ? error.message : 'Unknown control failure';
        const secrets = [bearerToken(request), ...Object.entries(env)
          .filter(([name, value]) => /TOKEN|SECRET|PASSWORD|API_KEY/i.test(name) && typeof value === 'string' && value.length >= 8)
          .map(([, value]) => value)];
        try { secrets.push(getSession()?.token); } catch { /* The failing session reader may be the cause. */ }
        for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
        console.error('[control]', message.slice(0, 1000));
      }
      send(error instanceof RequestError ? error.status : expectedControlError ? 409 : 500, {
        error: error instanceof RequestError || expectedControlError ? error.message : 'The control could not be completed.',
        ...(expectedControlError ? { code: 'GAME_CONTROL' } : {}),
      });
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}
