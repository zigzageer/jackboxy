import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { definitions } from './commands.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('Set DISCORD_TOKEN and DISCORD_CLIENT_ID in .env first.');
  process.exit(1);
}

const rest = new REST().setToken(DISCORD_TOKEN);
const route = DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  : Routes.applicationCommands(DISCORD_CLIENT_ID);

try {
  // POST upserts each name/type while preserving the application's other commands.
  for (const definition of definitions) await rest.post(route, { body: definition });
  console.log(`Registered ${definitions.length} command(s) ${DISCORD_GUILD_ID ? `to guild ${DISCORD_GUILD_ID}` : 'globally'}.`);
} catch (error) {
  // REST errors can contain request details; log only a token-redacted message.
  console.error('Command registration failed:', String(error.message || 'Discord API request failed.').replaceAll(DISCORD_TOKEN, '[redacted]'));
  process.exitCode = 1;
}
