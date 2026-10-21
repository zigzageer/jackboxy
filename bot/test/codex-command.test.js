import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationCommandOptionType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { definitions, handleCommand } from '../src/commands.js';
import { games } from '../src/game-manager.js';
import { codex, CODEX_OWNER_ID, CodexRunnerError } from '../src/codex-runner.js';

const OWNER_ID = '573614648239194186';

function interaction({ action = null, prompt = 'The stream skipped five seconds. Diagnose and fix it.', restart = false, userId = OWNER_ID, guildId = 'guild-a' } = {}) {
  const calls = { replies: [], defers: [], edits: [], events: [], options: [] };
  return {
    commandName: 'codex', guildId, user: { id: userId },
    // Server administrators do not gain access to this owner-only command.
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.Administrator || permission === PermissionFlagsBits.ManageGuild },
    options: {
      getString(name) {
        calls.options.push(name);
        if (name === 'action') return action;
        if (name === 'prompt') return prompt;
        assert.fail(`Unexpected string option: ${name}`);
      },
      getBoolean(name) {
        calls.options.push(name);
        assert.equal(name, 'restart');
        return restart;
      },
    },
    reply: async (message) => { calls.events.push('reply'); calls.replies.push(message); },
    deferReply: async (options) => { calls.events.push('defer'); calls.defers.push(options); },
    editReply: async (message) => { calls.events.push('edit'); calls.edits.push(message); },
    followUp: async () => assert.fail('/codex must not post public follow-ups'),
    calls,
  };
}

const content = (message) => typeof message === 'string' ? message : message.content;
const responses = (request) => [...request.calls.replies, ...request.calls.edits].map(content).join('\n');

function assertPrivate(request) {
  const acknowledgements = [...request.calls.replies, ...request.calls.defers];
  assert.ok(acknowledgements.length, 'The interaction must be acknowledged');
  for (const acknowledgement of acknowledgements) {
    assert.ok((acknowledgement.flags & MessageFlags.Ephemeral) !== 0, 'Every acknowledgement must be private');
  }
}

function assertSafeContent(request) {
  for (const message of [...request.calls.replies, ...request.calls.edits]) {
    assert.equal(typeof message, 'object', 'Use Discord message options to disable mentions and embeds');
    assert.deepEqual(message.allowedMentions, { parse: [] });
    assert.ok((message.flags & MessageFlags.SuppressEmbeds) !== 0, 'Content must not generate URL previews');
    assert.ok(message.content.length <= 2000, 'Discord content must fit its message limit');
  }
}

function isolate(t, overrides = {}) {
  const noGameCalls = [];
  for (const name of Object.keys(games)) {
    if (typeof games[name] !== 'function') continue;
    noGameCalls.push(t.mock.method(games, name, () => assert.fail(`/codex must not inspect or control games.${name}`)));
  }
  const defaults = {
    run: async () => ({ status: 'completed', summary: 'Fixed the encoder timing and verified the relevant tests.', startedAt: Date.now() - 1000, finishedAt: Date.now() }),
    current: () => null,
    cancel: async () => false,
  };
  const spies = {};
  for (const [name, implementation] of Object.entries({ ...defaults, ...overrides })) {
    spies[name] = t.mock.method(codex, name, implementation);
  }
  return {
    ...spies,
    assertNoGameCalls: () => noGameCalls.forEach((spy) => assert.equal(spy.mock.callCount(), 0)),
    assertNoRunnerCalls: () => Object.values(spies).forEach((spy) => assert.equal(spy.mock.callCount(), 0)),
  };
}

test('/codex registers a server-only request with run/status/cancel and optional restart', () => {
  assert.equal(CODEX_OWNER_ID, OWNER_ID);
  const definition = definitions.find(({ name }) => name === 'codex');
  assert.ok(definition, 'The command must be included in slash registration');
  assert.equal(definition.dm_permission, false);
  const prompt = definition.options.find(({ name }) => name === 'prompt');
  assert.equal(prompt.type, ApplicationCommandOptionType.String);
  assert.notEqual(prompt.required, true, 'Status and cancel must not require a repair prompt');
  assert.equal(prompt.max_length, 4000);
  const action = definition.options.find(({ name }) => name === 'action');
  assert.equal(action.type, ApplicationCommandOptionType.String);
  assert.notEqual(action.required, true);
  assert.deepEqual(action.choices.map(({ value }) => value).sort(), ['cancel', 'run', 'status']);
  const restart = definition.options.find(({ name }) => name === 'restart');
  assert.equal(restart.type, ApplicationCommandOptionType.Boolean);
  assert.notEqual(restart.required, true);
});

for (const action of ['run', 'status', 'cancel']) {
  test(`/codex ${action} rejects every other user before reading options, even an administrator`, async (t) => {
    const spies = isolate(t);
    const request = interaction({ action, userId: 'untrusted-administrator' });
    Object.defineProperty(request, 'options', { get() { assert.fail('Unauthorized users must not reach command options'); } });
    await handleCommand(request);
    assert.match(responses(request), /only|owner|allowed|authorized/i);
    assertPrivate(request);
    assertSafeContent(request);
    spies.assertNoRunnerCalls();
    spies.assertNoGameCalls();
  });
}

test('/codex requires an exact owner ID and rejects a missing user', async (t) => {
  const spies = isolate(t);
  for (const user of [{ id: `${OWNER_ID}0` }, {}, undefined]) {
    const request = interaction();
    request.user = user;
    await handleCommand(request);
    assert.match(responses(request), /only|owner|allowed|authorized/i);
    assertPrivate(request);
  }
  spies.assertNoRunnerCalls();
  spies.assertNoGameCalls();
});

test('/codex rejects direct messages without starting or inspecting a repair job', async (t) => {
  const spies = isolate(t);
  const request = interaction({ guildId: null });
  await handleCommand(request);
  assert.match(responses(request), /server/i);
  assertPrivate(request);
  spies.assertNoRunnerCalls();
  spies.assertNoGameCalls();
});

test('/codex without a prompt gives private usage without starting a job', async (t) => {
  const spies = isolate(t);
  for (const prompt of [null, '', '   ']) {
    const request = interaction({ prompt });
    await handleCommand(request);
    assert.match(responses(request), /prompt|request|describe|usage/i);
    assertPrivate(request);
    assertSafeContent(request);
  }
  assert.equal(spies.run.mock.callCount(), 0);
  assert.equal(spies.cancel.mock.callCount(), 0);
  spies.assertNoGameCalls();
});

test('/codex rejects an unsupported action without invoking the runner', async (t) => {
  const spies = isolate(t);
  const request = interaction({ action: 'arbitrary-shell-command' });
  await handleCommand(request);
  assert.match(responses(request), /run|status|cancel|action|invalid/i);
  assertPrivate(request);
  assertSafeContent(request);
  spies.assertNoRunnerCalls();
  spies.assertNoGameCalls();
});

test('/codex rejects an oversized prompt before starting a worker', async (t) => {
  const spies = isolate(t);
  const request = interaction({ prompt: 'A'.repeat(4001) });
  await handleCommand(request);
  assert.match(responses(request), /4000|prompt|request/i);
  assertPrivate(request);
  assertSafeContent(request);
  spies.assertNoRunnerCalls();
  spies.assertNoGameCalls();
});

test('/codex defaults to run and acknowledges privately before the worker starts', async (t) => {
  const request = interaction();
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  t.after(() => complete({ status: 'cancelled', summary: 'Cancelled.' }));
  const spies = isolate(t, { run: async (prompt, options) => {
    request.calls.events.push('run');
    assert.ok(request.calls.defers.length, 'Long-running work must be deferred first');
    assert.equal(prompt, 'The stream skipped five seconds. Diagnose and fix it.');
    assert.deepEqual(options, { userId: OWNER_ID });
    return pending;
  } });
  const task = handleCommand(request);
  await new Promise(setImmediate);
  assert.equal(spies.run.mock.callCount(), 1);
  assert.ok(request.calls.events.indexOf('defer') < request.calls.events.indexOf('run'));
  assertPrivate(request);
  complete({ status: 'completed', summary: 'Repaired the stream and tested the fix.' });
  await task;
  assert.match(responses(request), /repaired the stream/i);
  assertSafeContent(request);
  assert.equal(spies.cancel.mock.callCount(), 0);
  spies.assertNoGameCalls();
});

test('/codex reports a sanitized busy/disabled/failure response privately', async (t) => {
  const raw = 'raw-secret-token should never be sent to Discord';
  const spies = isolate(t, { run: async () => { throw new Error(raw); } });
  const request = interaction();
  await handleCommand(request);
  assert.equal(spies.run.mock.callCount(), 1);
  assert.ok(!responses(request).includes(raw));
  assert.match(responses(request), /failed|could|error|unable|check|start/i);
  assertPrivate(request);
  assertSafeContent(request);
  spies.assertNoGameCalls();
});

test('/codex preserves actionable setup errors while redacting credential-shaped output', async (t) => {
  const secret = 'sk-proj-abcdefghijk1234567890';
  const spies = isolate(t, { run: async () => { throw new CodexRunnerError(`Codex is disabled. Sign in as jackbox first. ${secret}`); } });
  const request = interaction();
  await handleCommand(request);
  assert.match(responses(request), /disabled.*sign in as jackbox/i);
  assert.ok(!responses(request).includes(secret));
  assertPrivate(request);
  assertSafeContent(request);
  spies.assertNoGameCalls();
});

test('/codex status reports an active job without starting a new one', async (t) => {
  const spies = isolate(t, { current: () => ({ status: 'running', startedAt: Date.now() - 65_000 }) });
  const request = interaction({ action: 'status', prompt: null });
  await handleCommand(request);
  assert.match(responses(request), /running|working|active|progress/i);
  assert.equal(spies.run.mock.callCount(), 0);
  assert.equal(spies.cancel.mock.callCount(), 0);
  assert.ok(spies.current.mock.callCount() > 0);
  assertPrivate(request);
  assertSafeContent(request);
  spies.assertNoGameCalls();
});

test('/codex status reports when there is no active repair', async (t) => {
  const spies = isolate(t);
  const request = interaction({ action: 'status', prompt: null });
  await handleCommand(request);
  assert.match(responses(request), /no|not|idle/i);
  assert.equal(spies.run.mock.callCount(), 0);
  assert.equal(spies.cancel.mock.callCount(), 0);
  assertPrivate(request);
  assertSafeContent(request);
  spies.assertNoGameCalls();
});

for (const cancelled of [true, false]) {
  test(`/codex cancel privately handles ${cancelled ? 'an active job' : 'no active job'} without starting another`, async (t) => {
    const spies = isolate(t, { cancel: async (options) => {
      assert.deepEqual(options, { userId: OWNER_ID });
      return cancelled;
    } });
    const request = interaction({ action: 'cancel', prompt: null });
    await handleCommand(request);
    assert.equal(spies.cancel.mock.callCount(), 1);
    assert.equal(spies.run.mock.callCount(), 0);
    assert.match(responses(request), cancelled ? /cancel|stop/i : /no|not|idle/i);
    assertPrivate(request);
    assertSafeContent(request);
    spies.assertNoGameCalls();
  });
}

test('/codex cancellation errors stay private and do not expose raw worker errors', async (t) => {
  const raw = 'secret cancellation backend details';
  const spies = isolate(t, { cancel: async () => { throw new Error(raw); } });
  const request = interaction({ action: 'cancel' });
  await handleCommand(request);
  assert.equal(spies.run.mock.callCount(), 0);
  assert.ok(!responses(request).includes(raw));
  assertPrivate(request);
  assertSafeContent(request);
  spies.assertNoGameCalls();
});

test('/codex bounds repair summaries and disables mentions and link previews', async (t) => {
  const spies = isolate(t, { run: async () => ({ status: 'completed', summary: '@everyone <@123> https://example.test/private\n' + 'A'.repeat(5000) }) });
  const request = interaction();
  await handleCommand(request);
  assertPrivate(request);
  assertSafeContent(request);
  assert.ok(request.calls.edits.length);
  spies.assertNoGameCalls();
});

test('/codex redacts private browser control links from its completion reply', async (t) => {
  const token = 'sensitiveControlToken_123456789';
  const spies = isolate(t, { run: async () => ({ status: 'completed', summary: `Checked https://example.test/#control=${token} and fixed playback.` }) });
  const request = interaction();
  await handleCommand(request);
  assert.ok(!responses(request).includes(token));
  assert.match(responses(request), /fixed playback/i);
  assertSafeContent(request);
  spies.assertNoGameCalls();
});

test('/codex restart requires a configured restart callback before starting the repair', async (t) => {
  const spies = isolate(t);
  const request = interaction({ restart: true });
  await handleCommand(request);
  assert.match(responses(request), /restart|supervis|systemd|configured|enabled/i);
  assert.equal(spies.run.mock.callCount(), 0);
  assertPrivate(request);
  assertSafeContent(request);
  spies.assertNoGameCalls();
});

test('/codex restarts only after a successful final reply has finished sending', async (t) => {
  const spies = isolate(t);
  const request = interaction({ restart: true });
  let sendFinal;
  let completedReplySeen = false;
  const finalSent = new Promise((resolve) => { sendFinal = resolve; });
  t.after(sendFinal);
  request.editReply = async (message) => {
    request.calls.events.push('edit');
    request.calls.edits.push(message);
    if (content(message).includes('Fixed the encoder timing')) {
      completedReplySeen = true;
      await finalSent;
      request.calls.events.push('final-sent');
    }
  };
  const restart = t.mock.fn(async () => {
    request.calls.events.push('restart');
    assert.ok(request.calls.events.includes('final-sent'));
  });
  const task = handleCommand(request, { requestRestart: restart });
  await new Promise(setImmediate);
  assert.ok(completedReplySeen);
  assert.equal(restart.mock.callCount(), 0);
  sendFinal();
  await task;
  assert.equal(spies.run.mock.callCount(), 1);
  assert.equal(restart.mock.callCount(), 1);
  assertPrivate(request);
  assertSafeContent(request);
  spies.assertNoGameCalls();
});

for (const status of ['failed', 'timed_out', 'cancelled']) {
  test(`/codex does not restart after a ${status} repair`, async (t) => {
    const spies = isolate(t, { run: async () => ({ status, summary: 'The repair did not complete.' }) });
    const request = interaction({ restart: true });
    const restart = t.mock.fn(async () => {});
    await handleCommand(request, { requestRestart: restart });
    assert.equal(spies.run.mock.callCount(), 1);
    assert.equal(restart.mock.callCount(), 0);
    assertPrivate(request);
    assertSafeContent(request);
    spies.assertNoGameCalls();
  });
}

test('/codex does not restart unless explicitly requested', async (t) => {
  const spies = isolate(t);
  const request = interaction();
  const restart = t.mock.fn(async () => {});
  await handleCommand(request, { requestRestart: restart });
  assert.equal(spies.run.mock.callCount(), 1);
  assert.equal(restart.mock.callCount(), 0);
  spies.assertNoGameCalls();
});

for (const action of ['status', 'cancel']) {
  test(`/codex ${action} cannot trigger a restart even when restart:true is supplied`, async (t) => {
    const spies = isolate(t);
    const request = interaction({ action, restart: true, prompt: null });
    const restart = t.mock.fn(async () => {});
    await handleCommand(request, { requestRestart: restart });
    assert.equal(spies.run.mock.callCount(), 0);
    assert.equal(restart.mock.callCount(), 0);
    assertPrivate(request);
    spies.assertNoGameCalls();
  });
}

test('/codex does not restart when Discord cannot deliver the completion reply', async (t) => {
  const spies = isolate(t);
  const request = interaction({ restart: true });
  request.editReply = async (message) => {
    if (content(message).includes('Fixed the encoder timing')) throw new Error('Discord response delivery failed');
    request.calls.edits.push(message);
  };
  const restart = t.mock.fn(async () => {});
  await handleCommand(request, { requestRestart: restart }).catch(() => {});
  assert.equal(spies.run.mock.callCount(), 1);
  assert.equal(restart.mock.callCount(), 0);
  spies.assertNoGameCalls();
});
