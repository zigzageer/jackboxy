import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { handleAutocomplete, handleCommand } from './commands.js';
import { loadConfig, configPath } from './config.js';
import { stop } from './launcher.js';

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Fail fast on a broken games.json rather than on the first command.
const cfg = loadConfig();
console.log(`Loaded ${Object.keys(cfg.packs).length} pack(s) from ${configPath()}`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (c) => console.log(`Logged in as ${c.user.tag}`));

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
  } catch (err) {
    console.error('[interaction]', err);
    if (interaction.isRepliable() && !interaction.replied) {
      const send = interaction.deferred ? interaction.editReply.bind(interaction) : interaction.reply.bind(interaction);
      await send({ content: 'Something went wrong. Check the bot logs.' }).catch(() => {});
    }
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop();
    client.destroy();
    process.exit(0);
  });
}

client.login(process.env.DISCORD_TOKEN);
