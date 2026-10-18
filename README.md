# jackboxy

A Discord bot that runs Jackbox games on a Linux VPS. `/jackbox pack:3 game:quiplash2`
launches the game, streams it live to a web page players open, and posts the room code.

- [`server/`](server/README.md): one-command VPS setup (Wine, virtual screen and audio,
  MediaMTX WebRTC stream, systemd services) and how to use it.
- [`bot/`](bot/README.md): the discord.js bot.

Quick start on a fresh Ubuntu VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/zigzageer/jackboxy/main/server/install.sh | sudo bash
sudo jackbox-config
```
