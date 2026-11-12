import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { fightResultText, formatFighterName } from "./fight-delivery.mjs";
import { MatchServiceError, MAX_FIGHT_GIF_BYTES } from "./match-client.mjs";

const snowflake = value => typeof value === "string" && /^\d{17,20}$/.test(value);
const canManage = interaction => interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true;
const reply = content => ({ content: content.slice(0, 1950), allowedMentions: { parse: [] } });

class FightCommandError extends Error {}

async function selectedMember(interaction, { opponent = false } = {}) {
  const user = interaction.options.getUser("user");
  if (!snowflake(user?.id) || user.bot || (opponent && user.id === interaction.user.id)) {
    throw new FightCommandError(opponent ? "Choose another person in this server to fight." : "Choose a person in this server.");
  }
  const member = interaction.options.getMember?.("user") ??
    await interaction.guild?.members?.fetch({ user: user.id, force: true }).catch(error => {
      if ([10007, 10013].includes(Number(error?.code))) return null;
      throw error;
    });
  if (!member || member.user?.bot || (member.guild && member.guild.id !== interaction.guildId) ||
      (member.id && member.id !== user.id)) {
    throw new FightCommandError("That person is not a member of this server.");
  }
  return user.id;
}

function checkFightChannel(interaction) {
  const channel = interaction.channel;
  const channelId = interaction.channelId ?? channel?.id;
  const thread = [ChannelType.AnnouncementThread, ChannelType.PublicThread, ChannelType.PrivateThread].includes(channel?.type);
  const sendPermission = thread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  if (!snowflake(channelId) || channel?.isSendable?.() === false || interaction.appPermissions?.has(sendPermission) === false) {
    throw new FightCommandError("Use /fight in a server channel where I can send messages.");
  }
  return channelId;
}

function attachmentLimit(interaction) {
  const limit = interaction.attachmentSizeLimit;
  if (interaction.appPermissions?.has(PermissionFlagsBits.AttachFiles) === false || !Number.isSafeInteger(limit) || limit < 1) return 0;
  return Math.min(limit, MAX_FIGHT_GIF_BYTES);
}

export function createFightCommands({ service, delivery }) {
  async function autocomplete(interaction) {
    if (!snowflake(interaction.guildId) || !snowflake(interaction.user?.id)) return [];
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "character") return [];
    const action = interaction.options.getSubcommand(false);
    const query = { guildId: interaction.guildId, userId: interaction.user.id, timeoutMs: 1_750 };
    let choices;
    if (action === "set") ({ choices } = await service.getFighter(query));
    else if (action === "assign" && canManage(interaction)) choices = await service.listFighters(query);
    else return [];
    const filter = focused.value.trim().toLowerCase();
    return choices.filter(({ id, name }) => id.toLowerCase().includes(filter) || name.toLowerCase().includes(filter))
      .slice(0, 25).map(({ id, name }) => ({ name: name.trim().slice(0, 100), value: id }));
  }

  async function fighter(interaction, identity) {
    const action = interaction.options.getSubcommand();
    if (!["set", "assign", "pause"].includes(action)) throw new FightCommandError("Choose a fighter action.");
    const assign = action === "assign";
    if (assign && !canManage(interaction)) throw new FightCommandError("Manage Server is required to assign fighters.");
    const characterId = interaction.options.getString("character") ?? undefined;
    if ((assign && !characterId) || (characterId !== undefined && (characterId.length > 100 || !characterId.trim()))) {
      throw new FightCommandError("Choose a roster character from the suggestions.");
    }
    const memberId = assign ? await selectedMember(interaction) : undefined;
    const updated = await service.changeFighter({ ...identity, action, memberId, characterId, manageGuild: assign || undefined });
    if (action === "pause") return "Automatic fights are paused for you in this server. Use `/fighter set` to opt in again.";
    const name = formatFighterName(updated.name);
    if (assign) {
      const optIn = updated.enabled ? "They are opted in with this character." : "They can opt in with `/fighter set`.";
      return `Assigned **${name}** to <@${memberId}>. ${optIn}`;
    }
    return `You opted in to automatic fights in this server with **${name}**.`;
  }

  async function fight(interaction, identity) {
    const channelId = checkFightChannel(interaction);
    const opponentUserId = await selectedMember(interaction, { opponent: true });
    const job = await delivery.submit({ ...identity, channelId, opponentUserId, attachmentLimit: attachmentLimit(interaction) });
    if (job.error) return job.result ? `${job.error}\n${fightResultText(job.result)}` : job.error;
    if (job.messageId) return `[See the fight message](https://discord.com/channels/${identity.guildId}/${channelId}/${job.messageId}).`;
    if (job.result) return `${fightResultText(job.result)}\nI’ll retry posting the result in this channel.`;
    return "Fight queued. The result will appear in this channel.";
  }

  async function leaderboard(interaction) {
    const scope = interaction.options.getString("scope", true);
    if (!["server", "global"].includes(scope)) throw new FightCommandError("Choose the server or global leaderboard.");
    const entries = await service.getLeaderboard({ guildId: interaction.guildId, scope });
    const title = scope === "global" ? "Global leaderboard" : "Server leaderboard";
    const rows = entries.map(({ rank, name, wins, losses, points }) =>
      `**${rank}.** ${formatFighterName(name)} · ${wins} W / ${losses} L · ${points} pts`);
    return `**${title}**\n${rows.length ? rows.join("\n") : "No fights recorded yet."}`;
  }

  async function handle(interaction) {
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let content;
    try {
      if (!snowflake(interaction.guildId)) throw new FightCommandError("Use this command in a server.");
      if (!snowflake(interaction.id) || !snowflake(interaction.user?.id) || interaction.user.bot) {
        throw new FightCommandError("This command requires a verified server member.");
      }
      const identity = { interactionId: interaction.id, guildId: interaction.guildId, userId: interaction.user.id };
      if (interaction.commandName === "fight") content = await fight(interaction, identity);
      else if (interaction.commandName === "fighter") content = await fighter(interaction, identity);
      else content = await leaderboard(interaction);
    } catch (error) {
      content = error instanceof MatchServiceError || error instanceof FightCommandError
        ? error.message
        : "Could not complete this request. Try again.";
    }
    await interaction.editReply(reply(content));
    return true;
  }

  return { handle, autocomplete };
}
