import { gameCommand } from './game-command.mjs';
import { assertSnowflake } from './github-store.mjs';
import { isDeepStrictEqual } from 'node:util';

export const gameDefinition = {
  ...gameCommand,
  default_member_permissions: null,
  dm_permission: false,
  options: [
    ...gameCommand.options,
    {
      type: 1,
      name: 'status',
      description: 'Check queued game jobs, including jobs from before a restart',
      options: [{ type: 3, name: 'job', description: 'Job ID from your command reply', max_length: 64 }],
    },
    {
      type: 1,
      name: 'link',
      description: 'Link your own eligible character for duels and server wars',
      options: [{ type: 3, name: 'character', description: 'Your roster character ID', required: true, max_length: 100 }],
    },
  ],
};

const reply = (content) => ({ content, allowedMentions: { parse: [] } });

function generationOptions(value) {
  return {
    name: value.name ?? null,
    description: value.description || '',
    usePfp: value.usePfp !== false,
    image: value.image ?? null,
  };
}

export function canManageGame(interaction, allowedUserIds = new Set()) {
  return allowedUserIds.has(interaction.user?.id) || Boolean(interaction.memberPermissions?.has(32n));
}

export function jobStatus(job) {
  const lines = [`Job \`${job.id}\` — ${job.status}, stage \`${job.stage}\`.`];
  if (job.error) lines.push(`Failed at \`${job.stage}\`. ${job.error}`);
  if (job.result?.url) lines.push(job.result.url);
  if (job.notification?.error) lines.push('The completion message is awaiting another delivery attempt.');
  return lines.join('\n');
}

export function createQueuedGameHandler({ queue, state, matches, allowedUserIds = new Set() }) {
  return async (interaction) => {
    if (interaction.commandName !== 'game') return false;
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: 64 });
    if (!interaction.guildId || !interaction.guild) {
      await interaction.editReply(reply('Use /game in a Discord server.'));
      return true;
    }
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'link') return matches.handle(interaction);
    const manager = canManageGame(interaction, allowedUserIds);
    if (subcommand === 'status') {
      const id = interaction.options.getString('job');
      const selected = id ? queue.get(id) : null;
      if (id && (!selected || selected.guildId !== interaction.guildId || (!manager && selected.requesterId !== interaction.user.id))) {
        await interaction.editReply(reply('No accessible job with that ID exists in this server.'));
        return true;
      }
      const jobs = selected ? [selected] : queue.list({
        guildId: interaction.guildId,
        ...(manager ? {} : { requesterId: interaction.user.id }),
        limit: 5,
      });
      await interaction.editReply(reply(jobs.length ? jobs.map(jobStatus).join('\n\n').slice(0, 1950) : 'There are no game jobs to show in this server.'));
      return true;
    }
    if (!manager) {
      await interaction.editReply(reply('You need Manage Server permission to create a town or add a character.'));
      return true;
    }
    assertSnowflake(interaction.guildId);
    assertSnowflake(interaction.user.id);
    assertSnowflake(interaction.channelId);
    assertSnowflake(interaction.id);
    if (!['create', 'add'].includes(subcommand)) throw new Error('Unknown /game command.');
    const payload = { guildName: interaction.guild.name.slice(0, 100) };
    let memberId = null;
    if (subcommand === 'add') {
      const user = interaction.options.getUser('user', true);
      assertSnowflake(user.id);
      memberId = user.id;
      const image = interaction.options.getAttachment('image');
      if (image && (!/^image\/(png|jpeg|webp)$/.test(image.contentType || '') || image.size > 10_000_000)) {
        throw new Error('Upload a PNG, JPEG, or WebP reference smaller than 10 MB.');
      }
      Object.assign(payload, {
        name: interaction.options.getString('name'),
        description: interaction.options.getString('desc') || '',
        usePfp: interaction.options.getBoolean('use-pfp') ?? true,
        image: image ? { url: image.url, size: image.size } : null,
      });
    }
    const previous = queue.list({ guildId: interaction.guildId, type: subcommand, ...(memberId ? { memberId } : {}), limit: 1 })[0];
    if (subcommand === 'create' && previous?.status === 'succeeded' && previous.result?.url) {
      state.registerGuild({ guildId: interaction.guildId, channelId: interaction.channelId, name: interaction.guild.name, gameUrl: previous.result.url });
      await interaction.editReply(reply(`This server already has a game.\n${jobStatus(previous)}`));
      return true;
    }
    let job;
    let existing = false;
    if (previous?.status === 'failed' && (subcommand === 'create' || isDeepStrictEqual(generationOptions(previous.payload), generationOptions(payload)))) {
      job = queue.resume(previous.id, {
        interactionId: interaction.id,
        requesterId: interaction.user.id,
        channelId: interaction.channelId,
      });
      existing = true;
    } else {
      ({ job, existing } = queue.enqueue({
        type: subcommand,
        guildId: interaction.guildId,
        memberId,
        requesterId: interaction.user.id,
        channelId: interaction.channelId,
        interactionId: interaction.id,
        payload,
      }));
    }
    await interaction.editReply(reply([
      existing ? 'This game job is already queued or has been resumed.' : `Queued ${subcommand === 'create' ? 'your server’s town' : 'the character'}.`,
      jobStatus(job),
      'I’ll post the result here when it finishes. Check it anytime with /game status.',
    ].join('\n')));
    return true;
  };
}
