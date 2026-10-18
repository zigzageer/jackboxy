'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');

const helper = path.resolve(__dirname, '..', 'jackbox-web-test');
const root = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(helper, 'utf8');
const inline = source.split("<<'NODE'\n")[1].replace(/\nNODE\s*$/, '');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jackbox-web-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'games.json'), JSON.stringify({ packs: { 3: {
    exe: '/fixture/Pack 3.exe', games: { quiplash2: {
      name: 'Quiplash 2', aliases: ['quiplash'], keys: ['Down', 'Return'],
    } },
  } } }));
  return dir;
}

function shellFixture(t) {
  const dir = fixture(t);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}');
  for (const name of ['game-manager', 'control-server']) fs.writeFileSync(path.join(dir, 'src', `${name}.js`), '');
  for (const name of ['id', 'systemctl', 'sudo']) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n` +
      `const fs=require('node:fs'); const name=${JSON.stringify(name)};\n` +
      `if(name==='id') console.log(process.env.TEST_UID || '0');\n` +
      `else fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({name,args:process.argv.slice(2),cwd:process.cwd(),input:name==='sudo'?fs.readFileSync(0,'utf8'):''})+'\\n');\n`, { mode: 0o755 });
  }
  const log = path.join(dir, 'calls.jsonl');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, JACKBOX_BOT_DIR: dir, TEST_LOG: log, PUBLIC_IP: '203.0.113.9' };
  delete env.CONTROL_PUBLIC_URL;
  delete env.STREAM_PUBLIC_URL;
  delete env.STREAM_FPS;
  delete env.STREAM_BITRATE;
  delete env.WINEDEBUG;
  delete env.LIBGL_ALWAYS_SOFTWARE;
  delete env.LIBGL_DEBUG;
  return { dir, log, env, calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function shellRun(f, args = [], env = f.env) {
  return spawnSync('script', ['-q', '-e', '-c', ['bash', helper, ...args].map(quote).join(' '), '/dev/null'], { env, encoding: 'utf8', timeout: 5000 });
}

test('foreground shell wires the installed services and jackbox environment without Discord', (t) => {
  const f = shellFixture(t);
  const result = shellRun(f);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const calls = f.calls();
  assert.deepEqual(calls.slice(0, 2).map(({ name, args }) => [name, args]), [
    ['systemctl', ['stop', 'jackbox-bot']],
    ['systemctl', ['start', 'jackbox-screen', 'jackbox-wm', 'jackbox-audio', 'jackbox-stream']],
  ]);
  const run = calls[2];
  assert.equal(run.name, 'sudo');
  assert.equal(run.cwd, f.dir);
  assert.deepEqual(run.args.slice(0, 3), ['-u', 'jackbox', 'env']);
  const node = run.args.indexOf('node');
  const env = Object.fromEntries(run.args.slice(3, node).map((value) => {
    const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)];
  }));
  assert.deepEqual(Object.fromEntries(['HOME', 'DISPLAY', 'XDG_RUNTIME_DIR', 'WINEPREFIX', 'WINEDEBUG'].map((key) => [key, env[key]])), {
    HOME: '/opt/jackbox/home', DISPLAY: ':99', XDG_RUNTIME_DIR: '/run/jackbox', WINEPREFIX: '/opt/jackbox/wine', WINEDEBUG: '-all',
  });
  assert.equal(env.CONTROL_HOST, '0.0.0.0');
  assert.equal(env.CONTROL_PORT, '3000');
  assert.equal(env.STREAM_FPS, '24');
  assert.equal(env.STREAM_BITRATE, '1800k');
  assert.equal(env.LIBGL_ALWAYS_SOFTWARE, '0');
  assert.equal(env.LIBGL_DEBUG, '');
  assert.equal(env.JACKBOX_CONFIG, path.join(f.dir, 'games.json'));
  assert.deepEqual(run.args.slice(node), ['node', '--input-type=module', '-', '3', 'quiplash']);
  assert.equal(run.input, inline + '\n');
  assert.doesNotMatch(run.input, /discord\.js|dotenv|src\/index\.js|games\.navigate\(/i);
});

test('shell forwards explicit stream and graphics diagnostics and passes game text literally', (t) => {
  const f = shellFixture(t);
  const game = 'quiplash; touch SHOULD_NOT_EXIST';
  const result = shellRun(f, ['3', game], {
    ...f.env, STREAM_FPS: '30', STREAM_BITRATE: '2500k',
    WINEDEBUG: '-all,err+all', LIBGL_ALWAYS_SOFTWARE: '1', LIBGL_DEBUG: 'verbose',
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const args = f.calls()[2].args;
  assert.ok(args.includes('STREAM_FPS=30'));
  assert.ok(args.includes('STREAM_BITRATE=2500k'));
  assert.ok(args.includes('WINEDEBUG=-all,err+all'));
  assert.ok(args.includes('LIBGL_ALWAYS_SOFTWARE=1'));
  assert.ok(args.includes('LIBGL_DEBUG=verbose'));
  assert.equal(args.at(-1), game);
  assert.equal(fs.existsSync(path.join(f.dir, 'SHOULD_NOT_EXIST')), false);
});

test('shell rejects missing address, non-root and noninteractive runs before service changes', (t) => {
  for (const env of [{ PUBLIC_IP: '' }, { TEST_UID: '1000' }]) {
    const f = shellFixture(t);
    const result = shellRun(f, [], { ...f.env, ...env });
    assert.equal(result.status, 1);
    assert.deepEqual(f.calls(), []);
  }
  const f = shellFixture(t);
  const result = spawnSync('bash', [helper], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /interactive terminal/);
  assert.deepEqual(f.calls(), []);
});

async function nodeFixture(t, { failLaunch = false } = {}) {
  const dir = fixture(t);
  for (const name of ['config', 'control-server']) {
    fs.writeFileSync(path.join(dir, 'src', `${name}.js`), `export * from ${JSON.stringify(pathToFileURL(path.join(root, 'bot/src', `${name}.js`)).href)};\n`);
  }
  fs.writeFileSync(path.join(dir, 'src/game-manager.js'), `
    import { createGameManager } from ${JSON.stringify(pathToFileURL(path.join(root, 'bot/src/game-manager.js')).href)};
    import { EventEmitter } from 'node:events';
    import { appendFileSync } from 'node:fs';
    const log = (event, data) => appendFileSync(process.env.TEST_LOG, JSON.stringify({event, data})+'\\n');
    export const games = createGameManager({
      launchGame(resolved) { log('launch', resolved); return {child: new EventEmitter(), startedAt: new Date()}; },
      async launchReady() { ${failLaunch ? "throw new Error('fixture launch failed');" : ''} },
      stopGame({entry}) { log('stop-game'); entry.child.emit('exit', 0, null); },
      async stopped() {},
      async startCapture({env}) { log('capture', {stream:env.STREAM_PUBLIC_URL}); return {url:env.STREAM_PUBLIC_URL}; },
      async stopCapture() { log('stop-capture'); }, async streamReady() {},
      async send(keys) { log('key', keys); },
    });
  `);
  const listener = http.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const log = path.join(dir, 'events.jsonl');
  const url = `http://127.0.0.1:${port}`;
  return { dir, port, url, log, events: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
    start() {
      const child = spawn(process.execPath, ['--input-type=module', '-'], {
        cwd: dir, env: { PATH: process.env.PATH, JACKBOX_CONFIG: path.join(dir, 'games.json'), TEST_LOG: log, CONTROL_PUBLIC_URL: url, CONTROL_HOST: '127.0.0.1', CONTROL_PORT: String(port) },
      });
      let output = '';
      let errors = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { errors += chunk; });
      const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
      child.stdin.end(inline);
      return { child, exited, output: () => output, errors: () => errors };
    },
  };
}

async function ready(run) {
  if (run.output().includes('Private host')) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Helper did not start: ${run.errors()}`)), 5000);
    const check = () => { if (run.output().includes('Private host')) finish(); };
    const exited = () => finish(new Error(`Helper exited early: ${run.errors()}`));
    function finish(error) {
      clearTimeout(timer); run.child.stdout.off('data', check); run.child.off('exit', exited);
      if (error) reject(error); else resolve();
    }
    run.child.stdout.on('data', check); run.child.once('exit', exited);
    check();
  });
}

test('inline helper serves real browser controls, skips replay and cleans only its game and capture on Ctrl+C', { timeout: 10000 }, async (t) => {
  const f = await nodeFixture(t);
  const run = f.start();
  await ready(run);
  assert.match(run.output(), new RegExp(`Watch: ${f.url}/`));
  assert.deepEqual(await (await fetch(`${f.url}/healthz`)).json(), { ok: true });
  const status = await (await fetch(`${f.url}/api/status`)).json();
  assert.equal(status.game, 'Quiplash 2');
  assert.equal(status.menuStatus, 'manual');
  assert.equal(status.streamUrl, 'http://127.0.0.1:8889/game');
  assert.equal(f.events().filter(({event}) => event === 'key').length, 0);
  assert.equal((await fetch(`${f.url}/api/host`)).status, 401);
  const token = run.output().match(/#control=([^\s]+)/)[1];
  const response = await fetch(`${f.url}/api/key`, { method: 'POST', headers: {
    Origin: f.url, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ key: 'Return' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(f.events().find(({event}) => event === 'key').data, ['Return']);
  run.child.kill('SIGINT');
  assert.deepEqual(await run.exited, { code: 0, signal: null });
  assert.equal(f.events().filter(({event}) => event === 'stop-game').length, 1);
  assert.equal(f.events().filter(({event}) => event === 'stop-capture').length, 1);
});

test('port conflict fails before launching or capturing a game', { timeout: 10000 }, async (t) => {
  const f = await nodeFixture(t);
  const occupied = http.createServer();
  await new Promise((resolve) => occupied.listen(f.port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const run = f.start();
  assert.deepEqual(await run.exited, { code: 1, signal: null });
  assert.match(run.errors(), /EADDRINUSE/);
  assert.deepEqual(f.events(), []);
  assert.doesNotMatch(run.output(), /#control=/);
});

test('startup failure stops the partially launched game and closes the server', { timeout: 10000 }, async (t) => {
  const f = await nodeFixture(t, { failLaunch: true });
  const run = f.start();
  assert.deepEqual(await run.exited, { code: 1, signal: null });
  assert.match(run.errors(), /fixture launch failed/);
  assert.deepEqual(f.events().map(({event}) => event), ['launch', 'stop-game', 'stop-capture']);
  await assert.rejects(fetch(`${f.url}/healthz`));
  assert.doesNotMatch(run.output(), /#control=/);
});
