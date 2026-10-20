import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationCommandOptionType, ChannelType, MessageFlags } from 'discord.js';
import { definitions, handleCommand } from '../src/commands.js';
import { games } from '../src/game-manager.js';
import { voice } from '../src/voice.js';

function channel(overrides = {}) {
  return {
    id: 'voice-choice', name: 'Selected voice channel', guildId: 'guild-a', type: ChannelType.GuildVoice,
    guild: { id: 'guild-a', members: { me: { voice: { channelId: null } } } },
    toString() { return `<#${this.id}>`; },
    ...overrides,
  };
}

function interaction(subcommand = 'join', selected = channel()) {
  const calls = { replies: [], defers: [], edits: [], follows: [], events: [] };
  return {
    commandName: 'vc', guildId: 'guild-a', guild: { id: 'guild-a' }, user: { id: 'caller' },
    member: { get voice() { assert.fail('The caller need not be in a voice channel'); } },
    client: { user: { id: 'bot' } },
    options: {
      getSubcommand: () => subcommand,
      getChannel: (name) => { assert.equal(name, 'channel'); return selected; },
      getString: () => assert.fail('The channel must come from the native Discord channel picker'),
    },
    reply: async (message) => { calls.events.push('reply'); calls.replies.push(message); },
    deferReply: async (options) => { calls.events.push('defer'); calls.defers.push(options); },
    editReply: async (message) => { calls.events.push('edit'); calls.edits.push(message); },
    followUp: async (message) => { calls.follows.push(message); },
    calls,
  };
}

function isolateGameHost(t) {
  const spies = [];
  for (const name of Object.keys(games)) {
    if (typeof games[name] !== 'function') continue;
    spies.push(t.mock.method(games, name, () => {
      if (name === 'current') return { id: 'other-game', guildId: 'another-guild', phase: 'running' };
      assert.fail(`/vc must not call games.${name}`);
    }));
  }
  return () => {
    for (const spy of spies) assert.equal(spy.mock.callCount(), 0, '/vc must be independent of the game host');
  };
}

const content = (message) => typeof message === 'string' ? message : message.content;
const responses = (request) => [...request.calls.replies, ...request.calls.edits].map(content).join('\n');

function assertPrivateResponse(request) {
  assert.ok(request.calls.replies.length || request.calls.defers.length, 'The command must acknowledge the interaction');
  for (const acknowledgement of [...request.calls.replies, ...request.calls.defers]) {
    assert.equal(acknowledgement.flags, MessageFlags.Ephemeral);
  }
  assert.deepEqual(request.calls.follows, []);
}

test('/vc exposes join and leave with a required native guild voice channel picker', () => {
  const definition = definitions.find(({ name }) => name === 'vc');
  assert.ok(definition, 'The vc slash command must be registered');
  assert.equal(definition.dm_permission, false);
  assert.deepEqual(definition.options.map(({ name }) => name).sort(), ['join', 'leave']);
  const join = definition.options.find(({ name }) => name === 'join');
  const leave = definition.options.find(({ name }) => name === 'leave');
  assert.equal(join.type, ApplicationCommandOptionType.Subcommand);
  assert.equal(leave.type, ApplicationCommandOptionType.Subcommand);
  assert.equal(join.options.length, 1);
  const picker = join.options[0];
  assert.equal(picker.name, 'channel');
  assert.equal(picker.type, ApplicationCommandOptionType.Channel);
  assert.equal(picker.required, true);
  assert.deepEqual(picker.channel_types, [ChannelType.GuildVoice]);
  assert.equal(picker.choices, undefined);
  assert.equal(picker.autocomplete, undefined);
  assert.deepEqual(leave.options ?? [], []);
});

test('/vc join acknowledges privately before connecting to the explicitly selected channel', async (t) => {
  const assertNoGameCalls = isolateGameHost(t);
  const selected = channel();
  const request = interaction('join', selected);
  let finishJoin;
  const ready = new Promise((resolve) => { finishJoin = resolve; });
  t.after(() => finishJoin(selected));
  const join = t.mock.method(voice, 'join', async (target) => {
    request.calls.events.push('join');
    assert.equal(target, selected);
    return ready;
  });
  const leave = t.mock.method(voice, 'leave', () => assert.fail('Joining must not invoke the leave command'));

  const pending = handleCommand(request);
  await new Promise(setImmediate);
  assert.deepEqual(request.calls.events, ['defer', 'join']);
  assert.deepEqual(request.calls.defers, [{ flags: MessageFlags.Ephemeral }]);
  assert.deepEqual(request.calls.edits, []);
  assert.deepEqual(request.calls.replies, []);
  finishJoin(selected);
  await pending;

  assert.equal(join.mock.callCount(), 1);
  assert.equal(leave.mock.callCount(), 0);
  assert.match(responses(request), /joined|connected/i);
  assert.ok(responses(request).includes(selected.id) || responses(request).includes(selected.name));
  assertPrivateResponse(request);
  assertNoGameCalls();
});

test('/vc commands are server-only and never inspect a game or make a voice connection in DMs', async (t) => {
  const assertNoGameCalls = isolateGameHost(t);
  const join = t.mock.method(voice, 'join', () => assert.fail('DMs cannot join voice channels'));
  const leave = t.mock.method(voice, 'leave', () => assert.fail('DMs cannot leave voice channels'));
  for (const subcommand of ['join', 'leave']) {
    const request = interaction(subcommand);
    request.guildId = null;
    request.guild = null;
    await handleCommand(request);
    assert.match(responses(request), /server/i);
    assertPrivateResponse(request);
    assert.deepEqual(request.calls.defers, []);
  }
  assert.equal(join.mock.callCount(), 0);
  assert.equal(leave.mock.callCount(), 0);
  assertNoGameCalls();
});

for (const [name, selected] of [
  ['a voice channel from another server', channel({ guildId: 'guild-b', guild: { id: 'guild-b' } })],
  ['a stage channel', channel({ type: ChannelType.GuildStageVoice })],
  ['a text channel', channel({ type: ChannelType.GuildText })],
  ['no channel', null],
]) {
  test(`/vc join rejects ${name} with a private explanation`, async (t) => {
    const assertNoGameCalls = isolateGameHost(t);
    const join = t.mock.method(voice, 'join', () => assert.fail('Invalid channel choices cannot join voice'));
    const request = interaction('join', selected);
    await handleCommand(request);
    assert.match(responses(request), /voice|channel|server/i);
    assertPrivateResponse(request);
    assert.equal(join.mock.callCount(), 0);
    assertNoGameCalls();
  });
}

test('/vc join returns a friendly private error when connection setup fails', async (t) => {
  const assertNoGameCalls = isolateGameHost(t);
  const request = interaction();
  const join = t.mock.method(voice, 'join', async () => { throw new Error('I need View Channel and Connect permissions in that voice channel.'); });
  await handleCommand(request);
  assert.equal(join.mock.callCount(), 1);
  assert.deepEqual(request.calls.defers, [{ flags: MessageFlags.Ephemeral }]);
  assert.match(responses(request), /could|unable|cannot|permission|failed|try again/i);
  assert.ok(!responses(request).includes('Error:'));
  assertPrivateResponse(request);
  assertNoGameCalls();
});

test('/vc join fetches an uncached native channel choice by its explicit ID before connecting', async (t) => {
  const assertNoGameCalls = isolateGameHost(t);
  const selected = channel();
  const request = interaction('join', { id: selected.id, type: ChannelType.GuildVoice });
  const fetches = [];
  request.guild.channels = { fetch: async (id) => {
    request.calls.events.push('fetch');
    fetches.push(id);
    return selected;
  } };
  const join = t.mock.method(voice, 'join', async (target) => {
    request.calls.events.push('join');
    assert.equal(target, selected);
  });
  await handleCommand(request);
  assert.deepEqual(fetches, [selected.id]);
  assert.deepEqual(request.calls.events, ['defer', 'fetch', 'join', 'edit']);
  assert.equal(join.mock.callCount(), 1);
  assert.match(responses(request), /joined|connected/i);
  assert.ok(responses(request).includes(selected.id));
  assertPrivateResponse(request);
  assertNoGameCalls();
});

for (const [name, fetched] of [
  ['a different server channel', channel({ guildId: 'guild-b', guild: { id: 'guild-b' } })],
  ['a stage channel', channel({ type: ChannelType.GuildStageVoice })],
  ['a deleted channel', null],
]) {
  test(`/vc join rejects an uncached choice that resolves to ${name}`, async (t) => {
    const assertNoGameCalls = isolateGameHost(t);
    const request = interaction('join', { id: 'partial-choice', type: ChannelType.GuildVoice });
    request.guild.channels = { fetch: async () => fetched };
    const join = t.mock.method(voice, 'join', () => assert.fail('The fetched channel must be validated before joining'));
    await handleCommand(request);
    assert.equal(join.mock.callCount(), 0);
    assert.match(responses(request), /voice|channel|server/i);
    assertPrivateResponse(request);
    assertNoGameCalls();
  });
}

test('/vc join handles an inaccessible uncached channel privately without attempting a connection', async (t) => {
  const assertNoGameCalls = isolateGameHost(t);
  const request = interaction('join', { id: 'inaccessible-choice', type: ChannelType.GuildVoice });
  request.guild.channels = { fetch: async () => { throw new Error('I cannot access that channel. Check my channel permissions.'); } };
  const join = t.mock.method(voice, 'join', () => assert.fail('An inaccessible channel cannot be joined'));
  await handleCommand(request);
  assert.deepEqual(request.calls.defers, [{ flags: MessageFlags.Ephemeral }]);
  assert.equal(join.mock.callCount(), 0);
  assert.match(responses(request), /cannot access|permission/i);
  assertPrivateResponse(request);
  assertNoGameCalls();
});

test('/vc leave disconnects only this server and remains independent of another server game', async (t) => {
  const assertNoGameCalls = isolateGameHost(t);
  const request = interaction('leave');
  const join = t.mock.method(voice, 'join', () => assert.fail('Leaving must not join any channel'));
  const leave = t.mock.method(voice, 'leave', async (guildId) => {
    assert.equal(guildId, request.guildId);
    return true;
  });
  await handleCommand(request);
  assert.equal(leave.mock.callCount(), 1);
  assert.equal(join.mock.callCount(), 0);
  assert.match(responses(request), /left|disconnected/i);
  assertPrivateResponse(request);
  assertNoGameCalls();
});

test('/vc leave explains privately when this server has no voice connection', async (t) => {
  const assertNoGameCalls = isolateGameHost(t);
  const leave = t.mock.method(voice, 'leave', async () => false);
  const request = interaction('leave');
  await handleCommand(request);
  assert.equal(leave.mock.callCount(), 1);
  assert.match(responses(request), /not (?:currently )?connected|not in|no (?:active )?voice|already disconnected/i);
  assertPrivateResponse(request);
  assertNoGameCalls();
});

test('/vc leave returns a friendly private error if disconnection fails', async (t) => {
  const assertNoGameCalls = isolateGameHost(t);
  t.mock.method(voice, 'leave', async () => { throw new Error('Could not disconnect. Try again.'); });
  const request = interaction('leave');
  await handleCommand(request);
  assert.match(responses(request), /could|unable|cannot|failed|try again/i);
  assert.ok(!responses(request).includes('Error:'));
  assertPrivateResponse(request);
  assertNoGameCalls();
});
