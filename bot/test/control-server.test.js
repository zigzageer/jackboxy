import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createControlServer } from '../src/control-server.js';

const origin = 'https://games.example.test';
const token = 'per-game-private-capability';
const headers = { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function fixture(t, callbacks = {}) {
  let session = {
    id: 'session-1', token, game: { name: 'Quiplash' }, pack: { name: 'Party Pack 3' },
    roomCode: 'ABCD', phase: 'running', menuStatus: 'manual',
  };
  let reads = 0;
  let onRead = () => {};
  const calls = [];
  const server = createControlServer({
    env: { CONTROL_PUBLIC_URL: origin, STREAM_PUBLIC_URL: 'https://stream.example.test/game' },
    getSession: () => { reads += 1; onRead(); return session; },
    pressKey: async (key, id) => { calls.push(['key', key, id]); await callbacks.pressKey?.(key, id); },
    stopGame: async (id) => { calls.push(['stop', id]); await callbacks.stopGame?.(id); },
    saveMenu: async (id) => { calls.push(['menu', id]); await callbacks.saveMenu?.(id); },
  });
  assert.equal(server.listening, false);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  function open(path, options = {}) {
    let request;
    const result = new Promise((resolve, reject) => {
      request = http.request({
        hostname: '127.0.0.1', port: server.address().port, path,
        method: options.method || 'GET', headers: options.headers || {}, agent: false,
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) });
        });
      });
      request.on('error', reject);
    });
    return { request, result };
  }
  async function request(path, options = {}) {
    const pending = open(path, options);
    pending.request.end(options.body);
    return pending.result;
  }
  return {
    request, open, calls,
    post: (path, body, override = {}) => request(path, { method: 'POST', headers, body: JSON.stringify(body), ...override }),
    setSession: (value) => { session = value; },
    nextSession: () => { session = { ...session, id: 'session-2', token: 'new-private-capability' }; },
    nextRead: () => new Promise((resolve) => { onRead = () => { onRead = () => {}; resolve(); }; }),
    readCount: () => reads,
  };
}

test('serves a public player and sanitized status without leaking the capability', async (t) => {
  const app = await fixture(t);
  const status = await app.request('/api/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.json(), {
    active: true, sessionId: 'session-1', game: 'Quiplash', pack: 'Party Pack 3', roomCode: 'ABCD',
    streamUrl: 'https://stream.example.test/game', phase: 'running', menuStatus: 'manual',
  });
  assert.equal(status.text.includes(token), false);
  assert.equal(status.headers['cache-control'], 'no-store');
  assert.equal(status.headers['referrer-policy'], 'no-referrer');
  const page = await app.request('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /Live Jackbox game video and audio/);
  assert.match(page.text, /https:\/\/jackbox\.tv/);
  assert.match(page.text, /id="host-panel"[^>]* hidden/);
  assert.equal(page.text.includes(token), false);
  assert.match(page.headers['content-security-policy'], /frame-src https:\/\/stream\.example\.test/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  for (const asset of ['/app.js', '/styles.css']) assert.equal((await app.request(asset)).status, 200);
  assert.equal((await app.request('/healthz')).json().ok, true);
  assert.equal((await app.request('/../src/control-server.js')).status, 404);
});

test('spectators cannot press keys, stop games, save steps, or validate as host', async (t) => {
  const app = await fixture(t);
  for (const path of ['/api/key', '/api/stop', '/api/menu']) {
    const response = await app.post(path, path === '/api/key' ? { key: 'Return' } : {}, {
      headers: { Origin: origin, 'Content-Type': 'application/json' },
    });
    assert.equal(response.status, 401, path);
  }
  assert.equal((await app.request('/api/host')).status, 401);
  assert.deepEqual(app.calls, []);
});

test('a host can validate its link and send a whitelisted key with the captured session ID', async (t) => {
  const app = await fixture(t);
  const host = await app.request('/api/host', { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(host.json(), { authorized: true, sessionId: 'session-1' });
  assert.equal((await app.post('/api/key', { key: 'Return' })).status, 200);
  assert.deepEqual(app.calls, [['key', 'Return', 'session-1']]);
});

test('a host can stop the captured session', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.post('/api/stop', {})).status, 200);
  assert.deepEqual(app.calls, [['stop', 'session-1']]);
});

test('a host can save menu steps for the captured session', async (t) => {
  const app = await fixture(t);
  const response = await app.post('/api/menu', {});
  assert.equal(response.status, 200);
  assert.match(response.json().message, /saved/);
  assert.deepEqual(app.calls, [['menu', 'session-1']]);
});

test('invalid keys, extra parameters, JSON, content types and large bodies never reach controls', async (t) => {
  const app = await fixture(t);
  for (const body of [{ key: 'ctrl+alt+Delete' }, { key: 'Return; touch /tmp/no' }, { key: 'Up', extra: true }, [], null]) {
    assert.equal((await app.post('/api/key', body)).status, 400);
  }
  assert.equal((await app.post('/api/stop', { key: 'Return' })).status, 400);
  assert.equal((await app.post('/api/menu', { steps: ['Return'] })).status, 400);
  assert.equal((await app.post('/api/key', {}, { body: '{' })).status, 400);
  assert.equal((await app.post('/api/key', {}, { headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await app.post('/api/key', {}, { headers: { ...headers, 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await app.post('/api/key', { key: 'x'.repeat(1100) })).status, 413);
  // A chunked body has no Content-Length for an attacker to omit or falsify.
  const chunked = app.open('/api/key', { method: 'POST', headers });
  chunked.request.write('{"key":"');
  chunked.request.write('x'.repeat(1100));
  chunked.request.end('"}');
  assert.equal((await chunked.result).status, 413);
  assert.deepEqual(app.calls, []);
});

test('rejects wrong, missing and null origins independently of the supplied token', async (t) => {
  const app = await fixture(t);
  for (const badOrigin of ['https://evil.example', 'null', `${origin}.evil.example`, undefined]) {
    const supplied = { ...headers };
    if (badOrigin === undefined) delete supplied.Origin;
    else supplied.Origin = badOrigin;
    assert.equal((await app.post('/api/key', { key: 'Return' }, { headers: supplied })).status, 403);
  }
  assert.deepEqual(app.calls, []);
});

test('rejects stale tokens and controls when no session is active', async (t) => {
  const app = await fixture(t);
  app.nextSession();
  assert.equal((await app.post('/api/key', { key: 'Return' })).status, 401);
  assert.equal((await app.post('/api/stop', {})).status, 401);
  app.setSession(null);
  assert.equal((await app.post('/api/key', { key: 'Return' })).status, 409);
  assert.equal((await app.post('/api/stop', {})).status, 409);
  const idle = (await app.request('/api/status')).json();
  assert.equal(idle.active, false);
  assert.equal(idle.game, null);
  assert.deepEqual(app.calls, []);
});

test('revalidates the session after a delayed request body and never carries a stale control across games', async (t) => {
  const app = await fixture(t);
  const observed = app.nextRead();
  const pending = app.open('/api/key', { method: 'POST', headers });
  pending.request.write('{"key":');
  await observed;
  app.nextSession();
  pending.request.end('"Return"}');
  assert.equal((await pending.result).status, 409);
  assert.deepEqual(app.calls, []);
});

test('rejects overlapping controls instead of queueing them, and rate limits a session', async (t) => {
  let release;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const app = await fixture(t, { pressKey: async () => { started(); await blocked; } });
  const first = app.post('/api/key', { key: 'Return' });
  await entered;
  assert.equal((await app.post('/api/stop', {})).status, 429);
  assert.equal((await app.post('/api/menu', {})).status, 429);
  release();
  assert.equal((await first).status, 200);
  const cooldown = await app.post('/api/key', { key: 'Down' });
  assert.equal(cooldown.status, 429);
  assert.equal(cooldown.headers['retry-after'], '1');
  assert.deepEqual(app.calls, [['key', 'Return', 'session-1']]);
});

test('unexpected callback errors return a generic error without exposing private details', async (t) => {
  const app = await fixture(t, { pressKey: async () => { throw new Error(`private path /secret/${token}`); } });
  const messages = [];
  const originalError = console.error;
  console.error = (...args) => messages.push(args.join(' '));
  t.after(() => { console.error = originalError; });
  const response = await app.post('/api/key', { key: 'Up' });
  assert.equal(response.status, 500);
  assert.equal(response.text.includes(token), false);
  assert.equal(response.text.includes('/secret/'), false);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].includes(token), false);
  assert.match(messages[0], /\[redacted\]/);
});

test('curated game-control validation errors are safe to show without expiring the capability', async (t) => {
  const app = await fixture(t, { saveMenu: async () => { throw Object.assign(new Error('Reach the lobby before saving menu steps.'), { code: 'GAME_CONTROL' }); } });
  const response = await app.post('/api/menu', {});
  assert.equal(response.status, 409);
  assert.deepEqual(response.json(), { error: 'Reach the lobby before saving menu steps.', code: 'GAME_CONTROL' });
});

test('rejects unsafe URLs and control URLs whose base path cannot serve the UI', () => {
  for (const url of ['javascript:alert(1)', 'https://user:password@example.com', 'https://example.com/subpath', 'https://example.com/?token=1', 'https://example.com/#token=1']) {
    assert.throws(() => createControlServer({ env: { CONTROL_PUBLIC_URL: url } }), /CONTROL_PUBLIC_URL/);
  }
  assert.throws(() => createControlServer({ env: { STREAM_PUBLIC_URL: 'file:///private' } }), /STREAM_PUBLIC_URL/);
});
