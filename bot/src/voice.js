import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
  joinVoiceChannel as defaultJoinVoiceChannel,
  getVoiceConnection as defaultGetVoiceConnection,
  entersState as defaultEntersState,
  VoiceConnectionStatus,
} from '@discordjs/voice';

const CONNECTION_FAILURE = 'Could not connect to that voice channel. Check my voice permissions and try again.';
const CONNECTION_TIMEOUT = 'Timed out connecting to that voice channel. Check my voice permissions and try again.';

/** A silent voice presence, independent of game capture and browser streaming. */
export function createVoiceManager({
  joinVoiceChannel = defaultJoinVoiceChannel,
  getVoiceConnection = defaultGetVoiceConnection,
  entersState = defaultEntersState,
  timeoutMs = 15000,
  logger = console,
} = {}) {
  const connections = new Map();
  const pending = new Map();
  const observed = new WeakSet();
  let closing = false;

  // Discord keeps one default-group connection per guild. Serialize moves and
  // disconnects so a failed handshake cannot destroy a subsequent connection.
  function enqueue(guildId, operation) {
    const previous = pending.get(guildId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    pending.set(guildId, next);
    const clear = () => { if (pending.get(guildId) === next) pending.delete(guildId); };
    next.then(clear, clear);
    return next;
  }

  function currentConnection(guildId) {
    const connection = getVoiceConnection(guildId) ?? connections.get(guildId);
    return connection?.state?.status === VoiceConnectionStatus.Destroyed ? null : connection;
  }

  function observe(connection) {
    if (observed.has(connection)) return;
    observed.add(connection);
    // Keep this listener after leaving: late transport errors must not become
    // unhandled EventEmitter errors, and raw errors can contain connection data.
    connection.on('error', () => logger.error?.('[voice] Discord voice connection error.'));
  }

  function waitForReady(connection) {
    return new Promise((resolve, reject) => {
      let done = false;
      let timer;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        connection.off('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onError = () => finish(new Error(CONNECTION_FAILURE));
      connection.on('error', onError);
      timer = setTimeout(() => finish(new Error(CONNECTION_TIMEOUT)), timeoutMs);
      try {
        Promise.resolve(entersState(connection, VoiceConnectionStatus.Ready, timeoutMs)).then(
          () => finish(),
          (error) => finish(new Error(error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
            ? CONNECTION_TIMEOUT : CONNECTION_FAILURE)),
        );
      } catch {
        finish(new Error(CONNECTION_FAILURE));
      }
    });
  }

  async function join(channel) {
    if (closing) throw new Error('Voice connections are shutting down.');
    if (!channel?.id || channel.type !== ChannelType.GuildVoice || !channel.guild?.id) {
      throw new Error('Choose a regular server voice channel.');
    }
    const guild = channel.guild;
    return enqueue(guild.id, async () => {
      if (closing) throw new Error('Voice connections are shutting down.');
      let member;
      try { member = guild.members.me ?? await guild.members.fetchMe(); }
      catch { throw new Error('Could not check my server membership. Try again.'); }
      let permissions;
      try { permissions = channel.permissionsFor(member); }
      catch { throw new Error('Could not check my permissions in that voice channel. Try again.'); }
      const missing = [
        [PermissionFlagsBits.ViewChannel, 'View Channel'],
        [PermissionFlagsBits.Connect, 'Connect'],
      ].filter(([permission]) => !permissions?.has(permission)).map(([, name]) => name);
      if (missing.length) throw new Error(`I need ${missing.join(' and ')} permission in that voice channel.`);

      const previous = currentConnection(guild.id);
      const alreadyJoined = previous?.joinConfig?.channelId === channel.id;
      const alreadyInChannel = alreadyJoined || member?.voice?.channelId === channel.id;
      if (!alreadyInChannel) {
        if (channel.full && !permissions.has(PermissionFlagsBits.MoveMembers)) {
          throw new Error('That voice channel is full. Choose another channel or free a place.');
        }
        if (channel.joinable === false) throw new Error('I cannot join that voice channel. Check my permissions and server timeout.');
      }

      let connection;
      try {
        connection = joinVoiceChannel({
          channelId: channel.id,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator,
          selfMute: true,
          selfDeaf: true,
        });
        connections.set(guild.id, connection);
        observe(connection);
        await waitForReady(connection);
      } catch (error) {
        // The registry may have changed outside this manager while awaiting
        // Discord. Never destroy a replacement connection during cleanup.
        if (connection && currentConnection(guild.id) === connection) {
          try { connection.destroy(); }
          catch { logger.error?.('[voice] Could not clean up a failed voice connection.'); }
        }
        if (connection && connections.get(guild.id) === connection) connections.delete(guild.id);
        if ([CONNECTION_FAILURE, CONNECTION_TIMEOUT].includes(error?.message)) throw error;
        throw new Error(CONNECTION_FAILURE);
      }
      return { channelId: channel.id, channelName: channel.name, alreadyJoined };
    });
  }

  function leaveGuild(guildId) {
    const connection = currentConnection(guildId);
    if (!connection) { connections.delete(guildId); return false; }
    observe(connection);
    try { connection.destroy(); }
    catch { throw new Error('Could not leave the voice channel. Try again.'); }
    if (connections.get(guildId) === connection) connections.delete(guildId);
    return true;
  }

  function leave(guildId) {
    return enqueue(guildId, () => leaveGuild(guildId));
  }

  async function destroyAll() {
    closing = true;
    const guildIds = new Set([...connections.keys(), ...pending.keys()]);
    const results = await Promise.allSettled([...guildIds].map((guildId) => leave(guildId)));
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('Could not disconnect every voice connection.');
    }
  }

  return { join, leave, destroyAll };
}

export const voice = createVoiceManager();
