import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { createVoiceManager } from '../src/voice.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function channel(id = 'channel-1', guildId = 'guild-1', extra = {}) {
  const member = { id: 'bot' };
  return {
    id, name: id, type: ChannelType.GuildVoice, full: false, joinable: true,
    guild: { id: guildId, members: { me: member }, voiceAdapterCreator() {} },
    permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]),
    ...extra,
  };
}

function harness({ ready, timeoutMs = 1000 } = {}) {
  const registry = new Map();
  const calls = [];
  const errors = [];
  const waits = [];
  const manager = createVoiceManager({
    getVoiceConnection: (guildId) => registry.get(guildId),
    joinVoiceChannel: (options) => {
      calls.push(options);
      let connection = registry.get(options.guildId);
      if (!connection) {
        connection = Object.assign(new EventEmitter(), {
          state: { status: VoiceConnectionStatus.Connecting }, destroyed: 0,
          destroy() {
            this.destroyed++;
            this.state = { status: VoiceConnectionStatus.Destroyed };
            if (registry.get(options.guildId) === this) registry.delete(options.guildId);
          },
        });
        registry.set(options.guildId, connection);
      }
      connection.joinConfig = options;
      return connection;
    },
    entersState: async (connection, status, timeout) => {
      waits.push({ connection, status, timeout });
      await ready?.(connection);
      connection.state = { status };
      return connection;
    },
    logger: { error: (message) => errors.push(message) },
    timeoutMs,
  });
  return { manager, registry, calls, errors, waits };
}

test('joins muted and deafened without needing Speak, and waits for Ready', async () => {
  const gate = deferred();
  const h = harness({ ready: () => gate.promise });
  const target = channel();
  let joined = false;
  const pending = h.manager.join(target).then((result) => { joined = true; return result; });
  await new Promise(setImmediate);
  assert.equal(joined, false);
  assert.deepEqual(h.calls, [{ channelId: target.id, guildId: target.guild.id,
    adapterCreator: target.guild.voiceAdapterCreator, selfMute: true, selfDeaf: true }]);
  assert.equal(h.waits[0].status, VoiceConnectionStatus.Ready);
  assert.equal(h.waits[0].timeout, 1000);
  gate.resolve();
  assert.deepEqual(await pending, { channelId: target.id, channelName: target.name, alreadyJoined: false });
  await h.manager.destroyAll();
});

test('rejects missing, text, and stage channels before creating a connection', async () => {
  const h = harness();
  for (const target of [null, {}, channel('text', 'guild-1', { type: ChannelType.GuildText }),
    channel('stage', 'guild-1', { type: ChannelType.GuildStageVoice })]) {
    await assert.rejects(h.manager.join(target), /regular server voice channel/);
  }
  assert.equal(h.calls.length, 0);
});

test('requires View Channel and Connect and names the missing permissions', async () => {
  const h = harness();
  for (const [available, message] of [
    [[PermissionFlagsBits.Connect], /need View Channel permission/],
    [[PermissionFlagsBits.ViewChannel], /need Connect permission/],
    [[], /need View Channel and Connect permission/],
  ]) {
    await assert.rejects(h.manager.join(channel('restricted', 'guild-1', {
      permissionsFor: () => new PermissionsBitField(available),
    })), message);
  }
  assert.equal(h.calls.length, 0);
});

test('fetches the bot member when absent from the guild cache', async () => {
  const h = harness();
  const target = channel();
  let fetched = 0;
  const member = { id: 'fetched-bot' };
  target.guild.members = { me: null, fetchMe: async () => { fetched++; return member; } };
  target.permissionsFor = (candidate) => {
    assert.equal(candidate, member);
    return new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]);
  };
  await h.manager.join(target);
  assert.equal(fetched, 1);
  await h.manager.destroyAll();
});

test('membership fetch failures do not expose Discord errors', async () => {
  const h = harness();
  const target = channel();
  target.guild.members = { me: null, fetchMe: async () => { throw new Error('secret transport payload'); } };
  await assert.rejects(h.manager.join(target), { message: 'Could not check my server membership. Try again.' });
  assert.equal(h.calls.length, 0);
});

test('rejects full and unjoinable channels without disturbing the current connection', async () => {
  const h = harness();
  await h.manager.join(channel());
  const connection = h.registry.get('guild-1');
  await assert.rejects(h.manager.join(channel('full', 'guild-1', { full: true, joinable: false })), /channel is full/);
  await assert.rejects(h.manager.join(channel('blocked', 'guild-1', { joinable: false })), /cannot join/);
  assert.equal(connection.destroyed, 0);
  assert.equal(connection.joinConfig.channelId, 'channel-1');
  assert.equal(h.calls.length, 1);
  await h.manager.destroyAll();
});

test('allows a full channel when the bot has Move Members', async () => {
  const h = harness();
  await h.manager.join(channel('full', 'guild-1', { full: true,
    permissionsFor: () => new PermissionsBitField([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers,
    ]),
  }));
  assert.equal(h.calls.length, 1);
  await h.manager.destroyAll();
});

test('joining the current full channel succeeds and keeps mute/deafen enabled', async () => {
  const h = harness();
  await h.manager.join(channel());
  const connection = h.registry.get('guild-1');
  const result = await h.manager.join(channel('channel-1', 'guild-1', { full: true, joinable: false }));
  assert.equal(result.alreadyJoined, true);
  assert.equal(h.registry.get('guild-1'), connection);
  assert.equal(connection.destroyed, 0);
  assert.equal(connection.joinConfig.selfMute, true);
  assert.equal(connection.joinConfig.selfDeaf, true);
  await h.manager.destroyAll();
});

test('moves within a guild and leaves only the requested guild', async () => {
  const h = harness();
  await h.manager.join(channel());
  await h.manager.join(channel('other', 'guild-2'));
  const first = h.registry.get('guild-1');
  const second = h.registry.get('guild-2');
  const result = await h.manager.join(channel('moved'));
  assert.equal(result.alreadyJoined, false);
  assert.equal(h.registry.get('guild-1'), first);
  assert.equal(first.joinConfig.channelId, 'moved');
  assert.equal(first.destroyed, 0);
  assert.equal(await h.manager.leave('guild-1'), true);
  assert.equal(first.destroyed, 1);
  assert.equal(second.destroyed, 0);
  assert.equal(await h.manager.leave('guild-1'), false);
  assert.equal(await h.manager.leave('unknown-guild'), false);
  await h.manager.destroyAll();
  assert.equal(second.destroyed, 1);
});

test('a stalled handshake times out, cleans up, and allows a later join', async () => {
  let stall = true;
  const h = harness({ timeoutMs: 20, ready: () => stall ? new Promise(() => {}) : undefined });
  const pending = h.manager.join(channel());
  await new Promise(setImmediate);
  const failed = h.registry.get('guild-1');
  await assert.rejects(pending, /Timed out connecting/);
  assert.equal(failed.destroyed, 1);
  assert.equal(h.registry.has('guild-1'), false);
  stall = false;
  await h.manager.join(channel('retry'));
  assert.notEqual(h.registry.get('guild-1'), failed);
  await h.manager.destroyAll();
});

test('handshake errors and late connection errors stay sanitized and handled', async () => {
  const h = harness({ ready: () => new Promise(() => {}) });
  const pending = h.manager.join(channel());
  await new Promise(setImmediate);
  const connection = h.registry.get('guild-1');
  connection.emit('error', new Error('token=secret voice transport payload'));
  await assert.rejects(pending, { message: 'Could not connect to that voice channel. Check my voice permissions and try again.' });
  assert.equal(connection.destroyed, 1);
  assert.doesNotThrow(() => connection.emit('error', new Error('late secret')));
  assert.deepEqual(h.errors, ['[voice] Discord voice connection error.', '[voice] Discord voice connection error.']);
});

test('a rejected handshake cannot clean up a replacement registered elsewhere', async () => {
  const gate = deferred();
  const h = harness({ ready: () => gate.promise });
  const pending = h.manager.join(channel());
  await new Promise(setImmediate);
  const first = h.registry.get('guild-1');
  const replacement = Object.assign(new EventEmitter(), {
    state: { status: VoiceConnectionStatus.Ready }, destroyed: 0,
    destroy() { this.destroyed++; h.registry.delete('guild-1'); },
  });
  h.registry.set('guild-1', replacement);
  gate.reject(new Error('stale handshake'));
  await assert.rejects(pending, /Could not connect/);
  assert.equal(first.destroyed, 0);
  assert.equal(replacement.destroyed, 0);
  assert.equal(h.registry.get('guild-1'), replacement);
  await h.manager.leave('guild-1');
});

test('overlapping moves wait for failed handshake cleanup before joining', async () => {
  const gate = deferred();
  let attempts = 0;
  const h = harness({ ready: () => ++attempts === 1 ? gate.promise : undefined });
  const firstPending = h.manager.join(channel());
  const firstRejected = assert.rejects(firstPending, /Could not connect/);
  const secondPending = h.manager.join(channel('new-channel'));
  await new Promise(setImmediate);
  const failed = h.registry.get('guild-1');
  assert.equal(h.calls.length, 1);
  gate.reject(new Error('old error'));
  await firstRejected;
  await secondPending;
  const current = h.registry.get('guild-1');
  assert.equal(failed.destroyed, 1);
  assert.notEqual(current, failed);
  assert.equal(current.joinConfig.channelId, 'new-channel');
  failed.emit('error', new Error('late old error'));
  assert.equal(current.destroyed, 0);
  await h.manager.destroyAll();
});

test('leave waits behind an in-flight join so it cannot reconnect after leaving', async () => {
  const gate = deferred();
  const h = harness({ ready: () => gate.promise });
  const joining = h.manager.join(channel());
  const leaving = h.manager.leave('guild-1');
  await new Promise(setImmediate);
  const connection = h.registry.get('guild-1');
  assert.equal(connection.destroyed, 0);
  gate.resolve();
  await joining;
  assert.equal(await leaving, true);
  assert.equal(connection.destroyed, 1);
  assert.equal(h.registry.size, 0);
});

test('a blocked handshake in one guild does not block another guild', async () => {
  const gate = deferred();
  const h = harness({ ready: (connection) => connection.joinConfig.guildId === 'guild-1' ? gate.promise : undefined });
  const first = h.manager.join(channel());
  await h.manager.join(channel('second', 'guild-2'));
  assert.equal(h.registry.get('guild-1').state.status, VoiceConnectionStatus.Connecting);
  assert.equal(h.registry.get('guild-2').state.status, VoiceConnectionStatus.Ready);
  assert.equal(await h.manager.leave('guild-2'), true);
  gate.resolve();
  await first;
  await h.manager.destroyAll();
});

test('shutdown waits for pending joins, disconnects each guild, and rejects new joins', async () => {
  const gate = deferred();
  const h = harness({ ready: () => gate.promise });
  const first = h.manager.join(channel());
  await new Promise(setImmediate);
  const connection = h.registry.get('guild-1');
  const shutdown = h.manager.destroyAll();
  await assert.rejects(h.manager.join(channel('late')), /shutting down/);
  gate.resolve();
  await first;
  await shutdown;
  assert.equal(connection.destroyed, 1);
  assert.equal(h.registry.size, 0);
  await h.manager.destroyAll();
});
