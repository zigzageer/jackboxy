import { SlashCommandBuilder, MessageFlags, AttachmentBuilder, PermissionFlagsBits } from 'discord.js';
import { loadConfig, resolveGame, packChoices, gameChoices, MENU_KEYS } from './config.js';
import { games } from './game-manager.js';
import { screenAvailable, screenshot, readRoomCodeOnce, waitForRoomCode } from './screen.js';

export const definitions = [
  new SlashCommandBuilder()
    .setName('jackbox')
    .setDescription('Launch a Jackbox game and share its stream and browser controls')
    .setDMPermission(false)
    .addStringOption((o) =>
      o.setName('pack').setDescription('Party pack, e.g. 3').setRequired(true).setAutocomplete(true))
    .addStringOption((o) =>
      o.setName('game').setDescription('Game, e.g. quiplash').setRequired(true).setAutocomplete(true))
    .addBooleanOption((o) =>
      o.setName('calibrate').setDescription('Open the pack menu to record a new game-selection sequence')),
  new SlashCommandBuilder()
    .setName('jackbox-stop')
    .setDescription('Close the running Jackbox game and stream').setDMPermission(false),
  new SlashCommandBuilder()
    .setName('jackbox-key')
    .setDescription('Press menu keys on the game screen, e.g. Down Down Return').setDMPermission(false)
    .addStringOption((o) =>
      o.setName('keys').setDescription('Key names separated by spaces: Up Down Left Right Return Escape space').setRequired(true)),
  new SlashCommandBuilder()
    .setName('jackbox-screen')
    .setDescription('Post a screenshot of the game screen').setDMPermission(false),
  new SlashCommandBuilder()
    .setName('jackbox-code')
    .setDescription('Read the room code off the game screen').setDMPermission(false),
].map((c) => c.toJSON());

// Re-read on every interaction so edits to games.json apply without a restart.
function config() {
  return loadConfig();
}

export async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  let result = [];
  try {
    const cfg = config();
    result = focused.name === 'pack'
      ? packChoices(cfg, focused.value)
      : gameChoices(cfg, interaction.options.getString('pack') ?? '', focused.value);
  } catch (err) {
    console.error('[autocomplete]', err.message);
  }
  await interaction.respond(result);
}

export async function handleCommand(interaction) {
  if (!interaction.guildId) return interaction.reply({ content: 'Use these commands in a server.', flags: MessageFlags.Ephemeral });
  const current = games.current();
  if (current && current.guildId !== interaction.guildId) {
    return interaction.reply({ content: 'The game host is being used by another server. Try again later.', flags: MessageFlags.Ephemeral });
  }
  if (current && ['jackbox-key', 'jackbox-stop'].includes(interaction.commandName) &&
    current.ownerId !== interaction.user?.id && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: 'Only the person who launched this game or a server manager can control or stop it.', flags: MessageFlags.Ephemeral });
  }
  if (interaction.commandName === 'jackbox') return jackbox(interaction);
  if (interaction.commandName === 'jackbox-stop') return jackboxStop(interaction);
  if (interaction.commandName === 'jackbox-key') return jackboxKey(interaction);
  if (interaction.commandName === 'jackbox-screen') return jackboxScreen(interaction);
  if (interaction.commandName === 'jackbox-code') return jackboxCode(interaction);
}

async function jackbox(interaction) {
  const packQuery = interaction.options.getString('pack', true);
  const gameQuery = interaction.options.getString('game', true);

  if (!process.env.CONTROL_PUBLIC_URL || !process.env.STREAM_PUBLIC_URL) {
    return interaction.reply({ content: 'Set CONTROL_PUBLIC_URL and STREAM_PUBLIC_URL on the game host first.', flags: MessageFlags.Ephemeral });
  }

  const resolved = resolveGame(config(), packQuery, gameQuery);
  if (!resolved) {
    return interaction.reply({
      content: `I don't know "${gameQuery}" in pack "${packQuery}". Check games.json.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (interaction.options.getBoolean?.('calibrate')) {
    resolved.keys = [];
    resolved.menuSteps = [];
  }

  await interaction.deferReply();
  let session;
  try {
    session = await games.start(resolved, { guildId: interaction.guildId, ownerId: interaction.user.id });
  } catch (err) {
    return interaction.editReply(err.message);
  }
  const watch = new URL(process.env.CONTROL_PUBLIC_URL);
  const host = new URL(watch);
  host.hash = `control=${session.token}`;
  const picking = resolved.viaPackMenu
    ? (resolved.keys.length || resolved.menuSteps?.length
      ? ` Picking ${resolved.game.name} in the ${resolved.pack.name} menu.`
      : ' Use your private controls to select the game, then save its menu steps for next time.')
    : '';
  const codeNote = screenAvailable() ? ' I\'ll post the room code when it shows up.' : '';
  await interaction.editReply(
    `Started **${resolved.pack.name}** for **${resolved.game.name}**.${picking}\nWatch: ${watch.href}\nPlayers join at https://jackbox.tv.${codeNote}`,
  );
  await interaction.followUp({
    content: `Your private menu controls: ${host.href}\nAnyone with this link can control this game. It expires when the game stops.`,
    flags: MessageFlags.Ephemeral,
  });
  followGame(interaction, session).catch((err) => console.error('[jackbox]', err.message));
}

// After launch: press the menu keys, then watch the screen for the room code and post it.
async function followGame(interaction, session) {
  const cancelled = () => games.current()?.id !== session.id || session.phase !== 'running';
  await games.navigate(session.id);
  if (!screenAvailable() || cancelled()) return;
  const code = await waitForRoomCode({ timeoutMs: 5 * 60_000, isCancelled: cancelled });
  if (code && !cancelled()) {
    session.roomCode = code;
    await interaction.followUp(`Room code **${code}**. Join on your phone at https://jackbox.tv`);
  }
}

function notOnServer(interaction) {
  return interaction.reply({ content: 'This only works on the Linux server setup.', flags: MessageFlags.Ephemeral });
}

async function jackboxKey(interaction) {
  if (!screenAvailable()) return notOnServer(interaction);
  const keys = interaction.options.getString('keys', true).split(/\s+/).filter(Boolean);
  if (!keys.length || keys.length > 30 || !keys.every((k) => MENU_KEYS.has(k))) {
    return interaction.reply({ content: 'Use key names like Up, Down, Return, Escape or space.', flags: MessageFlags.Ephemeral });
  }
  const session = games.current();
  if (!session) return interaction.reply({ content: 'Start a game first.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  for (const key of keys) await games.pressKey(key, session.id);
  return interaction.editReply(`Pressed ${keys.join(' ')}.`);
}

async function jackboxScreen(interaction) {
  if (!screenAvailable()) return notOnServer(interaction);
  const session = games.current();
  if (!session) return interaction.reply({ content: 'Start a game first.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply();
  if (games.current()?.id !== session.id || session.phase !== 'running') return interaction.editReply('The game changed. Run the command again.');
  const png = await screenshot();
  if (games.current()?.id !== session.id || session.phase !== 'running') return interaction.editReply('The game changed. Run the command again.');
  return interaction.editReply({ files: [new AttachmentBuilder(png, { name: 'screen.png' })] });
}

async function jackboxCode(interaction) {
  if (!screenAvailable()) return notOnServer(interaction);
  const session = games.current();
  if (!session) return interaction.reply({ content: 'Start a game first.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply();
  if (games.current()?.id !== session.id || session.phase !== 'running') return interaction.editReply('The game changed. Run the command again.');
  const code = await readRoomCodeOnce();
  if (games.current()?.id !== session.id || session.phase !== 'running') return interaction.editReply('The game changed. Run the command again.');
  if (code) session.roomCode = code;
  return interaction.editReply(code
    ? `Room code **${code}**. Join on your phone at https://jackbox.tv`
    : 'I can\'t see a room code on screen yet. Try `/jackbox-screen` to check.');
}

async function jackboxStop(interaction) {
  const running = games.current();
  if (!running) {
    return interaction.reply({ content: 'Nothing is running.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply();
  await games.stop(running.id);
  return interaction.editReply(`Closed **${running.game.name}** and stopped the stream.`);
}
