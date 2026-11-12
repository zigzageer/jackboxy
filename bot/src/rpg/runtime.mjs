import path from 'node:path';
import { readFileSync } from 'node:fs';
import { gameConfig } from './config.mjs';
import { BundlePublisher } from './bundle-publisher.mjs';
import { createImageGenerator } from './image-generator.mjs';
import { createTownGenerator } from './town-generator.mjs';
import { JobQueue } from './job-queue.mjs';
import { MatchClient } from './match-client.mjs';
import { MatchState } from './match-state.mjs';
import { createMatchCommands } from './match-commands.mjs';
import { createGameProcessor, createJobNotifier } from './game-jobs.mjs';
import { createQueuedGameHandler } from './queued-game-command.mjs';

export function createGameRuntime(env = process.env, { client, logger = console } = {}) {
  if (!client) throw new Error('The Discord client is unavailable.');
  const config = gameConfig(env);
  const directory = path.resolve(env.GAME_STATE_DIR || '/var/lib/jackbox-rpg');
  const databasePath = path.join(directory, 'jobs.sqlite');
  const state = new MatchState({ databasePath });
  const service = new MatchClient({
    origin: env.GAME_SERVICE_ORIGIN,
    secret: env.MINT_MATCH_BOT_SECRET,
    ca: env.GAME_SERVICE_CA_FILE ? readFileSync(env.GAME_SERVICE_CA_FILE) : undefined,
  });
  const matches = createMatchCommands({ service, state, client, logger });
  const publisher = new BundlePublisher({ ...config, branch: env.GAME_GITHUB_BRANCH || undefined });
  const processGame = createGameProcessor({
    publisher,
    generateCharacter: createImageGenerator(config),
    generateTown: createTownGenerator(config),
    client,
    state,
    artifactDirectory: path.join(directory, 'artifacts'),
    baseUrl: config.baseUrl,
  });
  const queue = new JobQueue({
    databasePath,
    workers: Number(env.GAME_WORKERS || '2'),
    process: (job, context) => processGame(job, {
      ...context,
      checkpoint: (patch) => {
        const saved = context.checkpoint(patch);
        if (patch.stage) logger.info?.('[rpg job]', JSON.stringify({ id: job.id, stage: patch.stage }));
        return saved;
      },
    }),
    notify: createJobNotifier(client),
    onError: (error) => logger.error?.('[rpg queue]', error.message),
  });
  const games = createQueuedGameHandler({ queue, state, matches, allowedUserIds: config.allowedUserIds });
  let stopped = false;
  return {
    queue,
    state,
    start() {
      if (stopped) throw new Error('Server game workers have stopped.');
      queue.start();
      matches.start();
    },
    async handle(interaction) {
      logger.info?.('[rpg interaction]', JSON.stringify({
        id: interaction.id,
        guildId: interaction.guildId,
        command: interaction.commandName || 'match-button',
      }));
      return interaction.commandName === 'game' ? games(interaction) : matches.handle(interaction);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await Promise.all([queue.stop({ cancel: true }), matches.stop()]);
      queue.close();
      state.close();
    },
  };
}
