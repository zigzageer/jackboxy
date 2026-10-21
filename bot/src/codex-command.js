import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { codex, CODEX_OWNER_ID, CodexRunnerError, sanitizeCodexText } from './codex-runner.js';

export const codexDefinition = new SlashCommandBuilder()
  .setName('codex')
  .setDescription('Ask Codex to diagnose and fix this Jackbox host (owner only)')
  .setDMPermission(false)
  .addStringOption((option) => option
    .setName('prompt')
    .setDescription('What should Codex investigate or fix?')
    .setMinLength(1)
    .setMaxLength(4000))
  .addStringOption((option) => option
    .setName('action')
    .setDescription('Start a repair, check its status, or cancel it')
    .addChoices(
      { name: 'Run a repair', value: 'run' },
      { name: 'Check status', value: 'status' },
      { name: 'Cancel the repair', value: 'cancel' },
    ))
  .addBooleanOption((option) => option
    .setName('restart')
    .setDescription('Restart the bot after success; stops the active game and voice connection'));

function message(content, ephemeral = false) {
  return {
    content: sanitizeCodexText(String(content)).slice(0, 2000),
    flags: MessageFlags.SuppressEmbeds | (ephemeral ? MessageFlags.Ephemeral : 0),
    allowedMentions: { parse: [] },
  };
}

function failureMessage(error) {
  return error instanceof CodexRunnerError
    ? error.message
    : 'Could not complete the Codex request. Check the local Codex setup and try again.';
}

export async function handleCodexCommand(interaction, { requestRestart } = {}) {
  // Never use server permissions, nicknames, or a configurable ID as a fallback.
  // This check must run before reading any request or touching the subprocess.
  if (interaction.user?.id !== CODEX_OWNER_ID) {
    return interaction.reply(message('Only the configured owner can use /codex.', true));
  }
  if (!interaction.guildId) return interaction.reply(message('Use /codex in a server.', true));

  const action = interaction.options.getString('action') ?? 'run';
  if (!['run', 'status', 'cancel'].includes(action)) {
    return interaction.reply(message('Choose action:run, action:status, or action:cancel.', true));
  }
  if (action === 'status') {
    const job = codex.current();
    return interaction.reply(message(job
      ? `Codex is ${['cancelling', 'stopping'].includes(job.status) ? 'stopping the repair' : 'working on a repair'}. Only one repair can run at a time.`
      : 'Codex is idle. Start a repair with /codex prompt:describe the problem.', true));
  }
  if (action === 'cancel') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const cancelled = await codex.cancel({ userId: interaction.user.id });
      return interaction.editReply(message(cancelled
        ? 'Codex stopped. Any changes it already made remain on disk; review them before retrying.'
        : 'There is no running Codex repair to cancel.'));
    } catch (error) {
      return interaction.editReply(message(failureMessage(error)));
    }
  }

  const prompt = interaction.options.getString('prompt')?.trim();
  if (!prompt || prompt.length > 4000) {
    return interaction.reply(message('Use /codex prompt:describe what to fix (1–4000 characters).', true));
  }
  const restart = interaction.options.getBoolean?.('restart') ?? false;
  if (restart && typeof requestRestart !== 'function') {
    return interaction.reply(message('Automatic restart is not enabled. Run the VPS Codex setup helper first, or omit restart:true.', true));
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let result;
  let finalMessage;
  try {
    await interaction.editReply(message('Starting Codex on the game host. Use /codex action:status to check progress or action:cancel to stop it.'));
    result = await codex.run(prompt, { userId: interaction.user.id });
    const heading = {
      completed: 'Codex finished.',
      failed: 'Codex could not complete the repair.',
      timed_out: 'Codex reached its time limit.',
      cancelled: 'Codex was cancelled.',
    }[result.status];
    if (!heading) throw new Error('Unexpected Codex result.');
    const note = result.status === 'completed'
      ? (restart ? '\n\nThe bot will restart now; this stops the active game and voice connection.' : '\n\nChanges to bot code take effect after a bot restart.')
      : '\n\nAny changes already made remain on disk. Review them before retrying.';
    finalMessage = `${heading}\n\n${sanitizeCodexText(result.summary ?? '').slice(0, 1600)}${note}`;
    // Complete the private Discord response before a restart drops this process.
    await interaction.editReply(message(finalMessage));
  } catch (error) {
    return interaction.editReply(message(failureMessage(error)));
  }
  if (restart && result.status === 'completed') {
    try { await requestRestart(); }
    catch {
      return interaction.editReply(message(`${finalMessage}\n\nThe restart could not be requested. Check the bot service.`));
    }
  }
}
