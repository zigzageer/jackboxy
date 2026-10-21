import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CODEX_OWNER_ID, CodexRunnerError, createCodexRunner, sanitizeCodexText } from '../src/codex-runner.js';

const owner = { userId: CODEX_OWNER_ID };
const other = { userId: 'someone-else' };
const event = (type, item) => `${JSON.stringify({ type, ...(item ? { item } : {}) })}\n`;

function harness(options = {}) {
  const children = [];
  const calls = [];
  const signals = [];
  const logs = [];
  const env = {
    CODEX_ENABLED: 'true', PATH: process.env.PATH, HOME: '/home/jackbox',
    CODEX_HOME: '/home/jackbox/.codex', CODEX_BIN: '/usr/local/bin/codex',
    DISCORD_TOKEN: 'discord-secret-token-value', OPENAI_API_KEY: 'sk-test-api-key-value-long-enough',
    STEAM_PASSWORD: 'steam-secret-password-value', CONTROL_PUBLIC_URL: 'http://public:3000',
    ...options.env,
  };
  const runner = createCodexRunner({
    env, getUid: () => 1000, timeoutMs: 1000, killGraceMs: 10, killConfirmMs: 10,
    logger: { error: (message) => logs.push(message) },
    spawnFn: (command, args, spawnOptions) => {
      calls.push({ command, args, options: spawnOptions });
      const child = Object.assign(new EventEmitter(), {
        pid: 123000 + children.length,
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        kill(signal) { signals.push({ child: this, signal, direct: true }); },
      });
      children.push(child);
      return child;
    },
    killFn: (pid, signal) => {
      signals.push({ pid, signal });
      options.onSignal?.(pid, signal, children);
    },
    ...options,
    env,
  });
  return { runner, calls, children, signals, logs, env };
}

function finish(child, { text = 'Fixed capture timing and tested the stream.', code = 0, completed = true } = {}) {
  if (text !== null) child.stdout.write(event('item.completed', { type: 'agent_message', text }));
  if (completed) child.stdout.write(event('turn.completed'));
  child.emit('close', code, null);
}

test('only the exact owner can start or cancel, even when disabled', async () => {
  const h = harness({ env: { CODEX_ENABLED: 'false' } });
  for (const user of [other, {}, { userId: Number(CODEX_OWNER_ID) }]) {
    await assert.rejects(h.runner.run('fix this', user), { name: 'CodexRunnerError', message: 'Only the configured owner can use /codex.' });
    await assert.rejects(h.runner.cancel(user), /Only the configured owner/);
  }
  await assert.rejects(h.runner.run('fix this', owner), /CODEX_ENABLED=true/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.runner.current(), null);
});

test('invalid tasks and unsafe runtime configuration fail before spawning', async () => {
  const h = harness();
  for (const prompt of [null, '', '   ', 'x'.repeat(4001)]) {
    await assert.rejects(h.runner.run(prompt, owner), CodexRunnerError);
  }
  for (const options of [
    { getUid: () => 0 },
    { env: { CODEX_BIN: 'codex\n--bad' } },
    { env: { CODEX_HOME: 'relative/auth' } },
    { workdir: '/nonexistent-jackbox-test-directory' },
  ]) {
    const invalid = harness(options);
    await assert.rejects(invalid.runner.run('fix this', owner), CodexRunnerError);
    assert.equal(invalid.calls.length, 0);
  }
  assert.equal(h.calls.length, 0);
});

test('uses a fixed workspace sandbox, stdin prompt and a secret-filtered environment', async () => {
  const h = harness({ env: {
    CODEX_UNSAFE_FLAGS: '--dangerously-bypass-approvals-and-sandbox',
    LC_ALL: 'C.UTF-8', DISPLAY: ':99', PULSE_SERVER: 'unix:/tmp/pulse', WINEPREFIX: '/opt/jackbox/wine',
    CODEX_API_KEY: 'another-api-key-value',
  } });
  const prompt = 'fix lag; $(touch /tmp/do-not-run) `echo hello`';
  const pending = h.runner.run(prompt, owner);
  const child = h.children[0];
  assert.equal(h.calls[0].command, '/usr/local/bin/codex');
  const { args, options } = h.calls[0];
  assert.equal(options.shell, false);
  assert.equal(options.detached, process.platform !== 'win32');
  assert.equal(path.resolve(options.cwd), path.resolve(import.meta.dirname, '../..'));
  assert.deepEqual(args.slice(0, 4), ['--no-daemon', 'exec', '--sandbox', 'workspace-write']);
  assert.ok(args.indexOf('--no-daemon') < args.indexOf('exec'), 'daemon opt-out is a global CLI option');
  assert.equal(args.at(-1), '-');
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(args.includes('--ephemeral'));
  assert.equal(args.some((value) => value.includes(prompt)), false);
  const stdin = child.stdin.read().toString();
  assert.ok(stdin.includes(JSON.stringify(prompt)));
  assert.match(stdin, /Do not restart or stop jackbox-bot/);
  assert.match(stdin, /Do not reset, stash, delete, commit, push, or deploy/);
  for (const key of ['DISCORD_TOKEN', 'STEAM_PASSWORD', 'CONTROL_PUBLIC_URL', 'CODEX_UNSAFE_FLAGS', 'CODEX_ENABLED', 'CODEX_BIN']) {
    assert.equal(key in options.env, false, key);
  }
  for (const key of ['HOME', 'PATH', 'CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'LC_ALL', 'DISPLAY', 'PULSE_SERVER', 'WINEPREFIX']) {
    assert.equal(options.env[key], h.env[key], key);
  }
  finish(child);
  assert.equal((await pending).status, 'completed');
});

test('reads documented JSON events across chunks and reports only the final assistant message', async () => {
  const h = harness();
  const pending = h.runner.run('fix timing', owner);
  const child = h.children[0];
  child.emit('spawn');
  const stdout = event('item.completed', { type: 'command_execution', aggregated_output: 'secret tool output' })
    + event('item.completed', { type: 'agent_message', text: 'Working on it.' })
    + event('item.completed', { type: 'agent_message', text: 'Fixed café timing; 4 tests passed.' })
    + event('turn.completed');
  const bytes = Buffer.from(stdout);
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  child.stdout.write(bytes.subarray(0, split));
  child.stdout.write(bytes.subarray(split));
  child.emit('close', 0, null);
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.summary, 'Fixed café timing; 4 tests passed.');
  assert.ok(result.id);
  assert.ok(Date.parse(result.startedAt));
  assert.ok(Date.parse(result.finishedAt));
  assert.equal(h.runner.current(), null);
});

test('successful output is redacted and capped before leaving the runner', async () => {
  const h = harness();
  const pending = h.runner.run('fix timing', owner);
  finish(h.children[0], {
    text: `Done. ${h.env.DISCORD_TOKEN} ${h.env.OPENAI_API_KEY} ${h.env.STEAM_PASSWORD} http://135.148.27.81:3000/#control=private-token Authorization: Bearer bearer-secret-token ${'z'.repeat(3000)}`,
  });
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.ok(result.summary.length <= 1800);
  for (const secret of [h.env.DISCORD_TOKEN, h.env.OPENAI_API_KEY, h.env.STEAM_PASSWORD, 'private-token', 'bearer-secret-token']) {
    assert.equal(result.summary.includes(secret), false);
  }
  assert.match(result.summary, /redacted/);
  assert.equal(sanitizeCodexText('watch http://135.148.27.81:3000/'), 'watch http://135.148.27.81:3000/');
  assert.match(sanitizeCodexText('prefix #control=capability-here end'), /#control=\[redacted\]/);
});

test('nonzero, missing completion and turn.failed outcomes never claim success or expose tool errors', async () => {
  for (const scenario of ['nonzero', 'incomplete', 'failed']) {
    const h = harness();
    const pending = h.runner.run('fix timing', owner);
    const child = h.children[0];
    child.stderr.write(`private raw command error ${h.env.DISCORD_TOKEN}`);
    if (scenario === 'failed') child.stdout.write(event('turn.failed', { message: 'private payload' }));
    finish(child, { code: scenario === 'nonzero' ? 1 : 0, completed: scenario !== 'incomplete' });
    const result = await pending;
    assert.equal(result.status, 'failed');
    assert.equal(result.summary.includes('private'), false);
    assert.equal(result.summary.includes('Fixed capture'), false);
    assert.deepEqual(h.logs, ['[codex] Maintenance job failed.']);
  }
});

test('authentication failures return a useful private-safe explanation', async () => {
  const h = harness();
  const pending = h.runner.run('fix timing', owner);
  h.children[0].stderr.write(`401 Unauthorized API key ${h.env.OPENAI_API_KEY}`);
  finish(h.children[0], { code: 1, text: null, completed: false });
  const result = await pending;
  assert.match(result.summary, /Sign in as the jackbox user/);
  assert.equal(result.summary.includes(h.env.OPENAI_API_KEY), false);
});

test('JSON authentication errors are recognized without forwarding their payload', async () => {
  const h = harness();
  const pending = h.runner.run('fix timing', owner);
  h.children[0].stdout.write(`${JSON.stringify({ type: 'turn.failed', error: { message: `401 Unauthorized ${h.env.OPENAI_API_KEY}` } })}\n`);
  finish(h.children[0], { code: 1, text: null, completed: false });
  const result = await pending;
  assert.match(result.summary, /Sign in as the jackbox user/);
  assert.equal(result.summary.includes(h.env.OPENAI_API_KEY), false);
});

test('ignores malformed and oversized event lines without growing a partial line indefinitely', async () => {
  const h = harness({ maxLineBytes: 160 });
  const pending = h.runner.run('fix timing', owner);
  const child = h.children[0];
  child.stdout.write('not-json\n');
  child.stdout.write('x'.repeat(100));
  child.stdout.write('x'.repeat(100));
  child.stdout.write('x'.repeat(100));
  child.stdout.write('\n');
  finish(child, { text: 'Small fix completed.' });
  assert.equal((await pending).summary, 'Small fix completed.');
});

test('rejects a concurrent job and current status contains no task or credentials', async () => {
  const h = harness();
  const pending = h.runner.run('private task that must not appear in status', owner);
  const starting = h.runner.current();
  assert.equal(starting.status, 'starting');
  h.children[0].emit('spawn');
  assert.equal(h.runner.current().status, 'running');
  assert.deepEqual(Object.keys(starting).sort(), ['id', 'startedAt', 'status']);
  await assert.rejects(h.runner.run('second', owner), /already running/);
  assert.equal(h.calls.length, 1);
  finish(h.children[0]);
  await pending;
  assert.equal(h.runner.current(), null);
  assert.equal(await h.runner.cancel(owner), false);
});

test('owner cancellation signals the process group and waits for actual close', async () => {
  const h = harness();
  const pending = h.runner.run('fix timing', owner);
  await assert.rejects(h.runner.cancel(other), /Only the configured owner/);
  assert.equal(h.signals.length, 0);
  let cancelled = false;
  const cancel = h.runner.cancel(owner).then((result) => { cancelled = true; return result; });
  assert.equal(h.runner.current().status, 'stopping');
  await new Promise(setImmediate);
  assert.equal(cancelled, false);
  assert.deepEqual(h.signals, [{ pid: -h.children[0].pid, signal: 'SIGTERM' }]);
  h.children[0].emit('close', null, 'SIGTERM');
  assert.equal(await cancel, true);
  assert.equal((await pending).status, 'cancelled');
  assert.equal(h.runner.current(), null);
});

test('a timeout escalates from SIGTERM to SIGKILL and never reports a fix', async () => {
  const h = harness({ timeoutMs: 10, killGraceMs: 10, onSignal: (_pid, signal, children) => {
    if (signal === 'SIGKILL') children[0].emit('close', null, signal);
  } });
  const result = await h.runner.run('fix timing', owner);
  assert.equal(result.status, 'timed_out');
  assert.match(result.summary, /time limit/);
  assert.match(result.summary, /Some edits may already be saved/);
  assert.deepEqual(h.signals.map((call) => call.signal), ['SIGTERM', 'SIGKILL']);
  assert.equal(h.runner.current(), null);
});

test('an unconfirmed stop blocks further work until the original process finally closes', async () => {
  const h = harness({ timeoutMs: 5, killGraceMs: 5, killConfirmMs: 5 });
  const result = await h.runner.run('fix timing', owner);
  assert.equal(result.status, 'timed_out');
  assert.match(result.summary, /termination could not be confirmed/);
  assert.equal(h.runner.current().status, 'stopping');
  await assert.rejects(h.runner.run('second', owner), /already running/);
  await assert.rejects(h.runner.shutdown(), /Could not confirm/);
  h.children[0].emit('close', null, 'SIGKILL');
  assert.equal(h.runner.current(), null);
});

test('missing CLI errors are sanitized and a later invocation can recover', async () => {
  const h = harness();
  const pending = h.runner.run('fix timing', owner);
  h.children[0].pid = undefined;
  h.children[0].emit('error', Object.assign(new Error('secret spawn data'), { code: 'ENOENT' }));
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /CLI was not found/);
  assert.equal(result.summary.includes('secret'), false);
  const retry = h.runner.run('retry', owner);
  finish(h.children[1]);
  assert.equal((await retry).status, 'completed');
});

test('a synchronous spawn failure does not leak its message or leave the runner busy', async () => {
  const h = harness({ spawnFn: () => { throw new Error('private runtime data'); } });
  const result = await h.runner.run('fix timing', owner);
  assert.equal(result.status, 'failed');
  assert.equal(result.summary.includes('private'), false);
  assert.equal(h.runner.current(), null);
});

test('excessive stdout is stopped with a bounded explanation instead of forwarding tool output', async () => {
  const h = harness({ maxOutputBytes: 40, onSignal: (_pid, signal, children) => children[0].emit('close', null, signal) });
  const pending = h.runner.run('fix timing', owner);
  h.children[0].stdout.write('private tool output '.repeat(10));
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /too much output/);
  assert.equal(result.summary.includes('private tool output'), false);
  assert.equal(h.runner.current(), null);
});

test('subprocess stream errors are handled and do not crash the Discord bot', async () => {
  for (const stream of ['stdin', 'stdout', 'stderr']) {
    const h = harness({ onSignal: (_pid, signal, children) => children[0].emit('close', null, signal) });
    const pending = h.runner.run('fix timing', owner);
    assert.doesNotThrow(() => h.children[0][stream].emit('error', new Error('private stream payload')));
    const result = await pending;
    assert.equal(result.status, 'failed');
    assert.equal(result.summary.includes('private'), false);
    assert.equal(h.runner.current(), null);
  }
});

test('shutdown waits for a running worker and permanently rejects new work', async () => {
  const h = harness();
  const pending = h.runner.run('fix timing', owner);
  let stopped = false;
  const shutdown = h.runner.shutdown().then(() => { stopped = true; });
  await new Promise(setImmediate);
  assert.equal(stopped, false);
  await assert.rejects(h.runner.run('later', owner), /shutting down/);
  h.children[0].emit('close', null, 'SIGTERM');
  await shutdown;
  assert.equal((await pending).status, 'cancelled');
  assert.equal(h.runner.current(), null);
});

test('real subprocess cancellation reaches a worker descendant without any model or API call', { skip: process.platform === 'win32' }, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jackbox-codex-runner-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const executable = path.join(temporary, 'fake-codex');
  const ready = path.join(temporary, 'ready');
  const stopped = path.join(temporary, 'stopped');
  const descendant = `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
  fs.writeFileSync(executable, `#!/usr/bin/env node\nif(process.argv[2]!=='--no-daemon'||process.argv[3]!=='exec')process.exit(1);const {spawn}=require('node:child_process');process.stdin.resume();process.stdin.on('end',()=>{spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)});\n`, { mode: 0o700 });
  const runner = createCodexRunner({
    env: { CODEX_ENABLED: 'true', CODEX_BIN: executable, PATH: process.env.PATH, HOME: temporary },
    getUid: () => 1000, workdir: temporary, timeoutMs: 5000, killGraceMs: 200, logger: { error() {} },
  });
  t.after(() => runner.shutdown());
  const pending = runner.run('local fake process only', owner);
  for (let attempt = 0; attempt < 100 && !fs.existsSync(ready); attempt++) await delay(10);
  assert.equal(fs.existsSync(ready), true, 'fake worker and descendant started');
  assert.equal(await runner.cancel(owner), true);
  assert.equal((await pending).status, 'cancelled');
  for (let attempt = 0; attempt < 100 && !fs.existsSync(stopped); attempt++) await delay(10);
  assert.equal(fs.readFileSync(stopped, 'utf8'), 'stopped');
  assert.equal(runner.current(), null);
});
