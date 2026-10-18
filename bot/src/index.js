import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { handleAutocomplete, handleCommand } from './commands.js';
import { loadConfig, configPath } from './config.js';
import { games } from './game-manager.js';
import { createControlServer } from './control-server.js';

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Fail fast on a broken games.json rather than on the first command.
const cfg = loadConfig();
console.log(`Loaded ${Object.keys(cfg.packs).length} pack(s) from ${configPath()}`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

let controls;
if (process.env.CONTROL_PUBLIC_URL) {
  controls = createControlServer({
    getSession: games.current,
    pressKey: games.pressKey,
    stopGame: games.stop,
    saveMenu: games.saveMenu,
  });
  const port = Number(process.env.CONTROL_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CONTROL_PORT must be between 1 and 65535.');
  await new Promise((resolve, reject) => {
    controls.once('error', reject);
    controls.listen(port, process.env.CONTROL_HOST || '0.0.0.0', resolve);
  });
  console.log(`Browser player and controls listening on port ${port}`);
}

client.once(Events.ClientReady, (c) => console.log(`Logged in as ${c.user.tag}`));

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
  } catch (err) {
    // Discord API errors may include the failed message body (a private link).
    let message = String(err.message || 'Command failed');
    for (const value of [process.env.DISCORD_TOKEN, games.current()?.token]) {
      if (value) message = message.replaceAll(value, '[redacted]');
    }
    console.error('[interaction]', message);
    if (interaction.isRepliable() && (!interaction.replied || interaction.deferred)) {
      const send = interaction.deferred ? interaction.editReply.bind(interaction) : interaction.reply.bind(interaction);
      await send({ content: 'Something went wrong. Check the bot logs.' }).catch(() => {});
    }
  }
});

let shuttingDown = false;
async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  client.destroy();
  controls?.close();
  controls?.closeAllConnections();
  try { await games.stop(); }
  catch (error) { console.error('[shutdown]', error.message); exitCode = 1; }
  process.exit(exitCode);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { shutdown(0); });

try { await client.login(process.env.DISCORD_TOKEN); }
catch {
  console.error('Discord login failed. Check the bot token and network access.');
  await shutdown(1);
}
