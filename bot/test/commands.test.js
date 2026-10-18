import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { handleCommand, handleAutocomplete } from '../src/commands.js';
import { games } from '../src/game-manager.js';

function environment(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jackbox-commands-'));
  const file = path.join(directory, 'games.json');
  const config = { packs: { 3: { name: 'Pack 3', exe: '/games/pack3.exe', games: {
    quiplash2: { name: 'Quiplash 2', aliases: ['quip', 'witty'], menuSteps: [{ key: 'Return', delayMs: 0 }] },
  } } } };
  fs.writeFileSync(file, JSON.stringify(config));
  const changes = {
    JACKBOX_CONFIG: file,
    CONTROL_PUBLIC_URL: 'https://jackbox.example.com/watch?party=one',
    STREAM_PUBLIC_URL: 'https://stream.example.com/game',
    DISPLAY: undefined,
  };
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { config, file };
}

function interaction(commandName = 'jackbox', values = {}) {
  const calls = { replies: [], defers: [], edits: [], follows: [], responses: [] };
  return {
    commandName, guildId: 'guild-a', user: { id: 'launcher-user' },
    member: { get voice() { assert.fail('Launching must not depend on Discord voice membership'); } },
    memberPermissions: { has: () => false },
    options: {
      getString: (key) => ({ pack: '3', game: 'quip', ...values })[key] ?? null,
      getBoolean: (key) => values[key] ?? null,
      getFocused: () => ({ name: 'game', value: 'quip' }),
    },
    reply: async (message) => { calls.replies.push(message); },
    deferReply: async (options) => { calls.defers.push(options); },
    editReply: async (message) => { calls.edits.push(message); },
    followUp: async (message) => { calls.follows.push(message); },
    respond: async (choices) => { calls.responses.push(choices); },
    calls,
  };
}

test('launch works without Discord voice and shares a public viewer plus private session controls', async (t) => {
  environment(t);
  let current = null;
  const starts = [];
  const navigations = [];
  t.mock.method(games, 'current', () => current);
  t.mock.method(games, 'start', async (resolved, options) => {
    starts.push({ resolved, options });
    current = { id: 'session-a', token: 'private-session-token', phase: 'running', ...options,
      game: resolved.game, pack: resolved.pack };
    return current;
  });
  t.mock.method(games, 'navigate', async (id) => { navigations.push(id); });
  const request = interaction();
  await handleCommand(request);
  await new Promise(setImmediate);

  assert.equal(starts.length, 1);
  assert.equal(starts[0].resolved.game.key, 'quiplash2');
  assert.deepEqual(starts[0].options, { guildId: 'guild-a', ownerId: 'launcher-user' });
  assert.deepEqual(request.calls.defers, [undefined]);
  assert.equal(request.calls.replies.length, 0);
  assert.equal(request.calls.edits.length, 1);
  const publicMessage = request.calls.edits[0];
  assert.match(publicMessage, /Started \*\*Pack 3\*\* for \*\*Quiplash 2\*\*/);
  assert.equal(publicMessage.match(/Watch: (\S+)/)[1], process.env.CONTROL_PUBLIC_URL);
  assert.match(publicMessage, /https:\/\/jackbox.tv/);
  assert.ok(!publicMessage.includes(current.token));
  assert.ok(!publicMessage.includes('#control='));
  assert.equal(request.calls.follows.length, 1);
  const privateMessage = request.calls.follows[0];
  assert.equal(privateMessage.flags, MessageFlags.Ephemeral);
  const controls = new URL(privateMessage.content.match(/controls: (\S+)/)[1]);
  assert.equal(controls.origin, 'https://jackbox.example.com');
  assert.equal(controls.pathname, '/watch');
  assert.equal(controls.search, '?party=one');
  assert.equal(controls.hash, '#control=private-session-token');
  assert.deepEqual(navigations, ['session-a']);
});

test('commands in another server cannot view, control, stop, or replace a running session', async (t) => {
  environment(t);
  const active = { id: 'session-a', guildId: 'guild-a', ownerId: 'launcher-user', token: 'secret' };
  t.mock.method(games, 'current', () => active);
  const start = t.mock.method(games, 'start', async () => assert.fail('Must not launch in another guild'));
  const stop = t.mock.method(games, 'stop', async () => assert.fail('Must not stop another guild'));
  const press = t.mock.method(games, 'pressKey', async () => assert.fail('Must not control another guild'));
  for (const name of ['jackbox', 'jackbox-key', 'jackbox-stop', 'jackbox-screen', 'jackbox-code']) {
    const request = interaction(name, { keys: 'Return' });
    request.guildId = 'guild-b';
    await handleCommand(request);
    assert.deepEqual(request.calls.defers, []);
    assert.deepEqual(request.calls.edits, []);
    assert.deepEqual(request.calls.follows, []);
    assert.equal(request.calls.replies.length, 1);
    assert.match(request.calls.replies[0].content, /another server/);
    assert.equal(request.calls.replies[0].flags, MessageFlags.Ephemeral);
    assert.ok(!request.calls.replies[0].content.includes(active.token));
  }
  assert.equal(start.mock.callCount(), 0);
  assert.equal(stop.mock.callCount(), 0);
  assert.equal(press.mock.callCount(), 0);
});

test('calibration opens the shared pack menu without replaying or erasing its saved sequence', async (t) => {
  const { config, file } = environment(t);
  const starts = [];
  const session = { id: 'calibration-session', token: 'calibration-token', phase: 'running' };
  t.mock.method(games, 'current', () => null);
  t.mock.method(games, 'start', async (resolved) => { starts.push(resolved); return session; });
  t.mock.method(games, 'navigate', async () => {});
  const request = interaction('jackbox', { calibrate: true });
  await handleCommand(request);
  await new Promise(setImmediate);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].exe, '/games/pack3.exe');
  assert.equal(starts[0].game.key, 'quiplash2');
  assert.deepEqual(starts[0].keys, []);
  assert.deepEqual(starts[0].menuSteps, []);
  assert.match(request.calls.edits[0], /select the game, then save its menu steps/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), config);
});

test('only the launcher or a server manager can stop a game or use slash key controls', async (t) => {
  environment(t);
  const active = { id: 'session-a', guildId: 'guild-a', ownerId: 'launcher-user', game: { name: 'Quiplash 2' } };
  t.mock.method(games, 'current', () => active);
  const stop = t.mock.method(games, 'stop', async () => active);
  const press = t.mock.method(games, 'pressKey', async () => {});
  for (const name of ['jackbox-stop', 'jackbox-key']) {
    const request = interaction(name, { keys: 'Return' });
    request.user.id = 'another-user';
    await handleCommand(request);
    assert.match(request.calls.replies[0].content, /person who launched this game or a server manager/);
    assert.equal(request.calls.replies[0].flags, MessageFlags.Ephemeral);
    assert.deepEqual(request.calls.defers, []);
  }
  assert.equal(stop.mock.callCount(), 0);
  assert.equal(press.mock.callCount(), 0);
  for (const role of ['owner', 'manager']) {
    const request = interaction('jackbox-stop');
    if (role === 'manager') {
      request.user.id = 'server-manager';
      request.memberPermissions.has = (permission) => permission === PermissionFlagsBits.ManageGuild;
    }
    await handleCommand(request);
    assert.deepEqual(request.calls.defers, [undefined]);
    assert.deepEqual(request.calls.edits, ['Closed **Quiplash 2** and stopped the stream.']);
    assert.deepEqual(request.calls.replies, []);
  }
  assert.equal(stop.mock.callCount(), 2);
  assert.deepEqual(stop.mock.calls.map(({ arguments: args }) => args), [['session-a'], ['session-a']]);
});

test('launch requires public service URLs and unknown games receive a private error', async (t) => {
  environment(t);
  t.mock.method(games, 'current', () => null);
  const start = t.mock.method(games, 'start', async () => assert.fail('Invalid launches must not start a process'));
  const unknown = interaction('jackbox', { game: 'unknown' });
  await handleCommand(unknown);
  assert.match(unknown.calls.replies[0].content, /I don't know "unknown"/);
  assert.equal(unknown.calls.replies[0].flags, MessageFlags.Ephemeral);
  delete process.env.STREAM_PUBLIC_URL;
  const unconfigured = interaction();
  await handleCommand(unconfigured);
  assert.match(unconfigured.calls.replies[0].content, /CONTROL_PUBLIC_URL and STREAM_PUBLIC_URL/);
  assert.equal(unconfigured.calls.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(start.mock.callCount(), 0);
});

test('autocomplete uses aliases and picks up configuration edits on the next request', async (t) => {
  const { config, file } = environment(t);
  const first = interaction();
  first.options.getFocused = () => ({ name: 'game', value: 'witty' });
  await handleAutocomplete(first);
  assert.deepEqual(first.calls.responses, [[{ name: 'Quiplash 2 (quiplash2)', value: 'quiplash2' }]]);
  config.packs[3].games.quiplash2.aliases = ['new nickname'];
  fs.writeFileSync(file, JSON.stringify(config));
  const staleAlias = interaction();
  staleAlias.options.getFocused = () => ({ name: 'game', value: 'witty' });
  await handleAutocomplete(staleAlias);
  assert.deepEqual(staleAlias.calls.responses, [[]]);
  const newAlias = interaction();
  newAlias.options.getFocused = () => ({ name: 'game', value: 'new nick' });
  await handleAutocomplete(newAlias);
  assert.deepEqual(newAlias.calls.responses, [[{ name: 'Quiplash 2 (quiplash2)', value: 'quiplash2' }]]);
});

test('direct messages receive a private server-only response', async (t) => {
  const current = t.mock.method(games, 'current', () => assert.fail('DM commands cannot inspect a session'));
  const request = interaction();
  request.guildId = null;
  await handleCommand(request);
  assert.deepEqual(request.calls.replies, [{ content: 'Use these commands in a server.', flags: MessageFlags.Ephemeral }]);
  assert.equal(current.mock.callCount(), 0);
});

function screenCommandEnvironment(t) {
  const { file } = environment(t);
  const previousPath = process.env.PATH;
  process.env.DISPLAY = ':987';
  process.env.PATH = path.dirname(file);
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
}

for (const commandName of ['jackbox-screen', 'jackbox-code']) {
  test(`${commandName} requires an active session before deferring`, async (t) => {
    screenCommandEnvironment(t);
    t.mock.method(games, 'current', () => null);
    const request = interaction(commandName);

    await handleCommand(request);

    assert.deepEqual(request.calls.replies, [{
      content: 'Start a game first.', flags: MessageFlags.Ephemeral,
    }]);
    assert.deepEqual(request.calls.defers, []);
    assert.deepEqual(request.calls.edits, []);
    assert.deepEqual(request.calls.follows, []);
  });

  test(`${commandName} aborts before capture when another server replaces the session during defer`, async (t) => {
    screenCommandEnvironment(t);
    let current = {
      id: 'session-a', guildId: 'guild-a', ownerId: 'launcher-user', phase: 'running',
    };
    const replacement = {
      id: 'session-b', guildId: 'guild-b', ownerId: 'other-user', phase: 'running',
      token: 'other-server-token', roomCode: 'SECR',
    };
    t.mock.method(games, 'current', () => current);
    const request = interaction(commandName);
    request.deferReply = async (options) => {
      request.calls.defers.push(options);
      await Promise.resolve();
      current = replacement;
    };

    await handleCommand(request);

    assert.deepEqual(request.calls.defers, [undefined]);
    assert.deepEqual(request.calls.edits, ['The game changed. Run the command again.']);
    assert.deepEqual(request.calls.replies, []);
    assert.deepEqual(request.calls.follows, []);
    assert.equal(current, replacement);
    assert.equal(replacement.roomCode, 'SECR');
  });

  test(`${commandName} aborts before capture when the same session starts stopping during defer`, async (t) => {
    screenCommandEnvironment(t);
    const current = {
      id: 'session-a', guildId: 'guild-a', ownerId: 'launcher-user', phase: 'running',
    };
    t.mock.method(games, 'current', () => current);
    const request = interaction(commandName);
    request.deferReply = async (options) => {
      request.calls.defers.push(options);
      await Promise.resolve();
      current.phase = 'stopping';
    };

    await handleCommand(request);

    assert.deepEqual(request.calls.defers, [undefined]);
    assert.deepEqual(request.calls.edits, ['The game changed. Run the command again.']);
    assert.deepEqual(request.calls.replies, []);
    assert.deepEqual(request.calls.follows, []);
    assert.equal(current.id, 'session-a');
    assert.equal(current.phase, 'stopping');
    assert.equal(current.roomCode, undefined);
  });
}
