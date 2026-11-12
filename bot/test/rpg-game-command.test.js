import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueuedGameHandler, gameDefinition, jobStatus } from '../src/rpg/queued-game-command.mjs';
import { CODEX_OWNER_ID } from '../src/rpg/codex-runner.mjs';
import { createGameCommandHandler } from '../src/rpg/game-command.mjs';

const GUILD = '123456789012345678';
const REQUESTER = '223456789012345678';
const MEMBER = '323456789012345678';
const CHANNEL = '423456789012345678';
const INTERACTION = '523456789012345678';
const OTHER = '623456789012345678';
const queued = (extra = {}) => ({
  id: 'fixture-job', type: 'create', guildId: GUILD, requesterId: REQUESTER,
  channelId: CHANNEL, status: 'queued', stage: 'queued', payload: { guildName: 'Server Name' },
  artifacts: {}, result: null, error: null, notification: null, ...extra,
});

function interaction(subcommand = 'create', values = {}) {
  const calls = { defers: [], edits: [] };
  const value = {
    id: INTERACTION,
    commandName: 'game',
    guildId: GUILD,
    guild: { name: 'Server Name', members: { fetch: () => assert.fail('Member lookup belongs in the worker') } },
    channelId: CHANNEL,
    user: { id: values.userId || (subcommand === 'create' ? CODEX_OWNER_ID : REQUESTER) },
    memberPermissions: { has: (permission) => { assert.equal(permission, 32n); return values.manager !== false; } },
    deferred: false,
    replied: false,
    deferReply: async (options) => { calls.defers.push(options); value.deferred = true; },
    editReply: async (options) => { calls.edits.push(options); },
    options: {
      getSubcommand: () => subcommand,
      getString: (key) => values[key] ?? null,
      getBoolean: (key) => values[key] ?? null,
      getAttachment: (key) => values[key] ?? null,
      getUser: () => ({ id: MEMBER }),
    },
    calls,
  };
  return value;
}

function handlerFixture(request, { previous, selected, returned, owner = false } = {}) {
  const calls = { lists: [], enqueues: [], resumes: [], registrations: [], matches: [] };
  const assertAck = () => assert.equal(request.deferred, true, 'Discord must be acknowledged before queue, state or service work');
  const queue = {
    list: (options) => { assertAck(); calls.lists.push(options); return previous ? [previous] : []; },
    get: () => { assertAck(); return selected || null; },
    enqueue: (options) => {
      assertAck();
      calls.enqueues.push(options);
      return { job: returned || queued({ type: options.type, payload: options.payload }), existing: Boolean(returned) };
    },
    resume: (id, options) => { assertAck(); calls.resumes.push({ id, options }); return returned || queued({ id, type: previous.type, payload: previous.payload }); },
  };
  const handle = createQueuedGameHandler({ queue,
    state: { registerGuild: (options) => { assertAck(); calls.registrations.push(options); } },
    matches: { handle: async (value) => { assertAck(); calls.matches.push(value); return true; } },
    allowedUserIds: owner ? new Set([REQUESTER]) : new Set(),
  });
  return { handle, calls };
}

test('game command retains generation options and adds server-only status and link commands', () => {
  assert.deepEqual(gameDefinition.options.map((option) => option.name), ['create', 'add', 'status', 'link']);
  assert.equal(gameDefinition.default_member_permissions, null);
  assert.equal(gameDefinition.dm_permission, false);
  assert.deepEqual(gameDefinition.contexts, [0]);
  const add = gameDefinition.options.find((option) => option.name === 'add');
  assert.deepEqual(add.options.map((option) => option.name), ['user', 'name', 'desc', 'use-pfp', 'image']);
});

test('create acknowledges before queue work and immediately returns the persistent job ID', async () => {
  const request = interaction();
  const fixture = handlerFixture(request);
  assert.equal(await fixture.handle(request), true);
  assert.deepEqual(request.calls.defers, [{ flags: 64 }]);
  assert.match(request.calls.edits[0].content, /fixture-job/);
  assert.match(request.calls.edits[0].content, /stage `queued`/);
  assert.equal(fixture.calls.enqueues[0].interactionId, INTERACTION);
  assert.equal(fixture.calls.enqueues[0].payload.guildName, 'Server Name');
  assert.deepEqual(request.calls.edits[0].allowedMentions, { parse: [] });
});

test('add keeps all generation options and leaves member/avatar resolution to the worker', async () => {
  const image = { contentType: 'image/webp', size: 777, url: 'https://cdn.discordapp.com/attachments/sample.webp' };
  const request = interaction('add', { name: 'Custom Nickname', desc: 'Red jacket', 'use-pfp': false, image });
  const fixture = handlerFixture(request);
  await fixture.handle(request);
  assert.deepEqual(fixture.calls.enqueues[0], {
    type: 'add', guildId: GUILD, memberId: MEMBER, requesterId: REQUESTER, channelId: CHANNEL, interactionId: INTERACTION,
    payload: { guildName: 'Server Name', name: 'Custom Nickname', description: 'Red jacket', usePfp: false, image: { url: image.url, size: image.size } },
  });
});

test('failed create resumes with the new interaction and notification recipient metadata', async () => {
  const request = interaction();
  const fixture = handlerFixture(request, { previous: queued({ status: 'failed', stage: 'deploying' }) });
  await fixture.handle(request);
  assert.deepEqual(fixture.calls.resumes, [{ id: 'fixture-job', options: { interactionId: INTERACTION, requesterId: CODEX_OWNER_ID, channelId: CHANNEL } }]);
  assert.equal(fixture.calls.enqueues.length, 0);
  assert.match(request.calls.edits[0].content, /resumed/);
});

test('failed add resumes only when its generation options match and ignores a server rename', async () => {
  const previous = queued({ type: 'add', status: 'failed', payload: { guildName: 'Old Server Name', name: null, description: 'Blue shoes', usePfp: true, image: null } });
  const same = interaction('add', { desc: 'Blue shoes' });
  const fixture = handlerFixture(same, { previous });
  await fixture.handle(same);
  assert.equal(fixture.calls.resumes.length, 1);
  assert.equal(fixture.calls.enqueues.length, 0);
  const changed = interaction('add', { desc: 'Green shoes' });
  const different = handlerFixture(changed, { previous });
  await different.handle(changed);
  assert.equal(different.calls.resumes.length, 0);
  assert.equal(different.calls.enqueues.length, 1);
  assert.equal(different.calls.enqueues[0].payload.description, 'Green shoes');
});

test('existing successful create queues a fresh check for missing building artwork', async () => {
  const request = interaction();
  const previous = queued({ status: 'succeeded', stage: 'ready', result: { url: 'https://game.example/town' } });
  const fixture = handlerFixture(request, { previous });
  await fixture.handle(request);
  assert.equal(fixture.calls.enqueues.length, 1);
  assert.equal(fixture.calls.resumes.length, 0);
  assert.equal(fixture.calls.registrations.length, 0);
  assert.match(request.calls.edits[0].content, /Queued your server/);
});

test('status listings are scoped to the server and ordinary requester', async () => {
  const request = interaction('status', { manager: false });
  const fixture = handlerFixture(request, { previous: queued({ status: 'failed', stage: 'generating-character', error: 'Generation failed.' }) });
  await fixture.handle(request);
  assert.deepEqual(fixture.calls.lists, [{ guildId: GUILD, requesterId: REQUESTER, limit: 5 }]);
  assert.match(request.calls.edits[0].content, /Failed at `generating-character`/);
  assert.match(request.calls.edits[0].content, /fixture-job/);
});

test('status job IDs cannot expose another server or another requester', async () => {
  for (const selected of [queued({ guildId: OTHER }), queued({ requesterId: OTHER }), null]) {
    const request = interaction('status', { job: 'secret-job', manager: false });
    const fixture = handlerFixture(request, { selected });
    await fixture.handle(request);
    assert.match(request.calls.edits[0].content, /No accessible job/);
    assert.equal(fixture.calls.lists.length, 0);
  }
  const manager = interaction('status', { job: 'same-server-job' });
  const permitted = handlerFixture(manager, { selected: queued({ requesterId: OTHER }) });
  await permitted.handle(manager);
  assert.match(manager.calls.edits[0].content, /fixture-job/);
});

test('link is available to ordinary members and is delegated after acknowledgment', async () => {
  const request = interaction('link', { character: `discord-${MEMBER}`, manager: false });
  const fixture = handlerFixture(request);
  await fixture.handle(request);
  assert.deepEqual(fixture.calls.matches, [request]);
  assert.equal(fixture.calls.enqueues.length, 0);
});

test('creation permits only the exact owner ID, including against server managers and configured allowlists', async () => {
  for (const manager of [true, false]) {
    const ordinary = interaction('create', { manager, userId: REQUESTER });
    const denied = handlerFixture(ordinary, { owner: true });
    await denied.handle(ordinary);
    assert.match(ordinary.calls.edits[0].content, /Only the bot owner/);
    assert.equal(ordinary.calls.defers.length, 1);
    assert.equal(denied.calls.enqueues.length, 0);
    assert.equal(denied.calls.lists.length, 0);
  }
  const owner = interaction('create', { manager: false });
  const permitted = handlerFixture(owner);
  await permitted.handle(owner);
  assert.equal(permitted.calls.enqueues.length, 1);
  const dm = interaction();
  dm.guild = null;
  dm.guildId = null;
  await handlerFixture(dm).handle(dm);
  assert.equal(dm.calls.defers.length, 1);
  assert.match(dm.calls.edits[0].content, /Discord server/);
});

test('the legacy command handler also restricts create to the exact owner', async () => {
  const request = interaction('create', { userId: REQUESTER });
  request.isChatInputCommand = () => true;
  request.reply = async (value) => { request.calls.edits.push(value); };
  const handler = createGameCommandHandler({
    service: { create: () => assert.fail('A manager must not reach town generation') },
    allowedUserIds: new Set([REQUESTER]),
  });
  await handler(request);
  assert.match(request.calls.edits[0].content, /Only the bot owner/);
});

test('invalid uploads are rejected after acknowledgment and never reach the queue', async () => {
  const request = interaction('add', { image: { contentType: 'image/gif', size: 100, url: 'https://cdn.discordapp.com/sample.gif' } });
  const fixture = handlerFixture(request);
  await assert.rejects(fixture.handle(request), /PNG, JPEG, or WebP/);
  assert.equal(request.calls.defers.length, 1);
  assert.equal(fixture.calls.enqueues.length, 0);
});

test('unrelated command names pass through and job status includes failed notification delivery', async () => {
  const request = interaction();
  request.commandName = 'unrelated';
  assert.equal(await handlerFixture(request).handle(request), false);
  assert.equal(request.calls.defers.length, 0);
  assert.match(jobStatus(queued({ notification: { error: 'Delivery failed' } })), /another delivery attempt/);
});
