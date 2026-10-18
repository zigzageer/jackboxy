import { SlashCommandBuilder, MessageFlags, AttachmentBuilder } from 'discord.js';
import { loadConfig, resolveGame, packChoices, gameChoices } from './config.js';
import { launch, stop, currentGame } from './launcher.js';
import { joinChannel, leaveChannel } from './voice.js';
import { startStream, stopStream } from './streaming.js';
import { screenAvailable, screenshot, sendKeys, readRoomCodeOnce, waitForRoomCode } from './screen.js';

export const definitions = [
  new SlashCommandBuilder()
    .setName('jackbox')
    .setDescription('Launch a Jackbox game on the host and join your voice channel')
    .addStringOption((o) =>
      o.setName('pack').setDescription('Party pack, e.g. 3').setRequired(true).setAutocomplete(true))
    .addStringOption((o) =>
      o.setName('game').setDescription('Game, e.g. quiplash2').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('jackbox-stop')
    .setDescription('Close the running Jackbox game and leave voice'),
  new SlashCommandBuilder()
    .setName('jackbox-key')
    .setDescription('Press keys on the game screen, e.g. "Down Down Return" to pick a game in a pack menu')
    .addStringOption((o) =>
      o.setName('keys').setDescription('Key names separated by spaces: Up Down Left Right Return Escape space').setRequired(true)),
  new SlashCommandBuilder()
    .setName('jackbox-screen')
    .setDescription('Post a screenshot of the game screen'),
  new SlashCommandBuilder()
    .setName('jackbox-code')
    .setDescription('Read the room code off the game screen'),
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
  if (interaction.commandName === 'jackbox') return jackbox(interaction);
  if (interaction.commandName === 'jackbox-stop') return jackboxStop(interaction);
  if (interaction.commandName === 'jackbox-key') return jackboxKey(interaction);
  if (interaction.commandName === 'jackbox-screen') return jackboxScreen(interaction);
  if (interaction.commandName === 'jackbox-code') return jackboxCode(interaction);
}

async function jackbox(interaction) {
  const packQuery = interaction.options.getString('pack', true);
  const gameQuery = interaction.options.getString('game', true);

  const channel = interaction.member?.voice?.channel;
  if (!channel) {
    return interaction.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
  }

  const resolved = resolveGame(config(), packQuery, gameQuery);
  if (!resolved) {
    return interaction.reply({
      content: `I don't know "${gameQuery}" in pack "${packQuery}". Check games.json.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply();
  try {
    launch(resolved);
  } catch (err) {
    return interaction.editReply(err.message);
  }

  try {
    await joinChannel(channel);
  } catch (err) {
    stop();
    return interaction.editReply(err.message);
  }

  const stream = await startStream({ game: resolved.game });
  const picking = resolved.viaPackMenu
    ? (resolved.keys.length
      ? ` Picking ${resolved.game.name} in the ${resolved.pack.name} menu.`
      : ` Pick ${resolved.game.name} in the ${resolved.pack.name} menu with \`/jackbox-key\`.`)
    : '';
  const watch = stream ? ` Watch it here: ${stream.url}` : '';
  const codeNote = screenAvailable() ? ' I\'ll post the room code when it shows up.' : '';
  await interaction.editReply(
    `Launched **${resolved.game.name}** (${resolved.pack.name}) and joined **${channel.name}**.${picking}${watch}${codeNote}`,
  );

  if (screenAvailable()) followGame(interaction, resolved).catch((err) => console.error('[jackbox]', err));
}

// After launch: press the menu keys, then watch the screen for the room code and post it.
async function followGame(interaction, resolved) {
  const startedAt = currentGame()?.startedAt;
  const cancelled = () => currentGame()?.startedAt !== startedAt;
  if (resolved.viaPackMenu && resolved.keys.length) {
    await new Promise((r) => setTimeout(r, resolved.menuDelayMs));
    if (cancelled()) return;
    await sendKeys(resolved.keys);
  }
  const code = await waitForRoomCode({ timeoutMs: 5 * 60_000, isCancelled: cancelled });
  if (code && !cancelled()) {
    await interaction.followUp(`Room code **${code}**. Join on your phone at https://jackbox.tv`);
  }
}

function notOnServer(interaction) {
  return interaction.reply({ content: 'This only works on the Linux server setup.', flags: MessageFlags.Ephemeral });
}

async function jackboxKey(interaction) {
  if (!screenAvailable()) return notOnServer(interaction);
  const keys = interaction.options.getString('keys', true).split(/\s+/).filter(Boolean);
  if (!keys.every((k) => /^[A-Za-z0-9_+]+$/.test(k))) {
    return interaction.reply({ content: 'Use key names like Up, Down, Return, Escape or space.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await sendKeys(keys);
  return interaction.editReply(`Pressed ${keys.join(' ')}.`);
}

async function jackboxScreen(interaction) {
  if (!screenAvailable()) return notOnServer(interaction);
  await interaction.deferReply();
  const png = await screenshot();
  return interaction.editReply({ files: [new AttachmentBuilder(png, { name: 'screen.png' })] });
}

async function jackboxCode(interaction) {
  if (!screenAvailable()) return notOnServer(interaction);
  await interaction.deferReply();
  const code = await readRoomCodeOnce();
  return interaction.editReply(code
    ? `Room code **${code}**. Join on your phone at https://jackbox.tv`
    : 'I can\'t see a room code on screen yet. Try `/jackbox-screen` to check.');
}

async function jackboxStop(interaction) {
  const running = currentGame();
  const stopped = stop();
  await stopStream();
  const left = leaveChannel(interaction.guildId);
  if (!stopped && !left) {
    return interaction.reply({ content: 'Nothing is running.', flags: MessageFlags.Ephemeral });
  }
  return interaction.reply(
    stopped ? `Closed **${running.game.name}** and left voice.` : 'Left voice.',
  );
}
