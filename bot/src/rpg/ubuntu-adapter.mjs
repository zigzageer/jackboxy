import { createGameRuntime } from './runtime.mjs';
import { sanitizeCodexText } from './codex-runner.mjs';
export { gameDefinition } from './queued-game-command.mjs';
export { fightDefinition, warDefinition } from './match-commands.mjs';

// Initialize on first use and reuse the bot's configured owner across servers.
export function createUbuntuGameHandler({
  ownerId,
  env = process.env,
  configure = createGameRuntime,
  logger = console,
} = {}) {
  let handler;
  let client;
  const initialize = (discordClient) => {
    if (!handler) {
      handler = configure({
        ...env,
        GAME_ALLOWED_USER_IDS: [env.GAME_ALLOWED_USER_IDS, ownerId]
          .filter(Boolean)
          .join(','),
      }, { client: discordClient || client, logger });
    }
    return handler;
  };
  const handle = async (interaction) => {
    // This acknowledgment precedes configuration, SQLite, HTTP, and generation.
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: 64 });
    let stage = 'setup';
    try {
      const runtime = initialize(interaction.client);
      runtime.start?.();
      stage = 'command validation';
      return await (typeof runtime === 'function' ? runtime(interaction) : runtime.handle(interaction));
    } catch (error) {
      const message = sanitizeCodexText(error?.message || 'Could not process the command.', env);
      logger.error?.('[rpg command]', JSON.stringify({ id: interaction.id, error: message }));
      await interaction.editReply({
        content: `Request \`${interaction.id}\` failed at ${stage}. ${message}`.slice(0, 1950),
        allowedMentions: { parse: [] },
      });
      return true;
    }
  };
  handle.start = (discordClient) => {
    client = discordClient;
    initialize(client).start?.();
  };
  handle.stop = async () => { await handler?.stop?.(); };
  return handle;
}
