import { gameDefinition } from './queued-game-command.mjs';
import { fightDefinition, warDefinition } from './match-commands.mjs';

export const serverGameDefinitions = [gameDefinition, fightDefinition, warDefinition];

export async function syncGameCommands(client, guild) {
  const manager = guild ? guild.commands : client.application.commands;
  for (const definition of serverGameDefinitions) {
    if (guild) {
      const { contexts, integration_types, dm_permission, ...guildDefinition } = definition;
      await manager.create(guildDefinition);
    } else await manager.create(definition);
  }
}
