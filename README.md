# jackboxy

A Discord bot that hosts one shared Jackbox game on a Linux VPS.
`/jackbox pack:3 game:quiplash` launches Pack 3's Quiplash 2, posts a public
browser stream with video and audio, and privately gives the caller a browser
control link. No Discord voice channel is required.

Use `/vc join channel:...` to select a server voice channel or paste its ID.
The bot joins self-muted and self-deafened; `/vc leave` disconnects it.

The host uses arrow, Enter and Back buttons to navigate the game menu. Everyone
plays and submits answers on [jackbox.tv](https://jackbox.tv) with the room code.
Use **Save menu steps** after reaching the lobby to automate that selection on
later launches; menu paths are learned from your installed pack. Use
`/jackbox pack:3 game:quiplash calibrate:true` to skip saved steps and record a
replacement path.

- [`server/`](server/README.md): Ubuntu VPS installation, existing game discovery,
  Wine, virtual screen and audio, MediaMTX, systemd and firewall setup.
- [`bot/`](bot/README.md): bot configuration, commands and local development.

Start on a fresh Ubuntu VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/zigzageer/jackboxy/main/server/install.sh | sudo bash
```

Then follow the [server setup](server/README.md) to install or copy your games,
discover their actual executable paths, and run `sudo jackbox-config` with an
official Discord **bot** token. The installer keeps existing game configuration
and credentials. Configure HTTPS before sharing control links over the Internet.
