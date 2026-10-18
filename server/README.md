# Jackbox server setup (Linux VPS)

Turns a fresh Ubuntu VPS (24.04 or newer, e.g. OVHcloud VPS-1) into a
host where `/jackbox 3 quiplash2` launches the game, streams it, and posts the room code.

What runs on the server, all as systemd services under a `jackbox` user:

| Service | Does |
| --- | --- |
| `jackbox-screen` | Xvfb virtual screen `:99` at 1280x720 |
| `jackbox-wm` | openbox, so game windows get focus and key presses |
| `jackbox-audio` | PulseAudio with a `game` null sink the stream records from |
| `jackbox-stream` | MediaMTX: players watch at `http://<server ip>:8889/game` over WebRTC |
| `jackbox-bot` | The Discord bot in `bot/`; runs games with Wine and ffmpeg for the stream |

## Install

SSH into the server as a user with sudo and run:

```bash
curl -fsSL https://raw.githubusercontent.com/zigzageer/jackboxy/main/server/install.sh | sudo bash
```

Then:

1. Run `sudo jackbox-steam` to download the packs you own from your Steam account
   (it asks for your Steam login and Steam Guard code once). `sudo jackbox-steam 3 7`
   downloads only some packs.
2. `games.json` already lists packs 1 and 3 to 8 at the paths `jackbox-steam` uses;
   edit `/opt/jackbox/repo/bot/games.json` only to add menu `keys`.
3. Run `sudo jackbox-config` and paste your Discord bot token, application ID and server ID.

Re-running `install.sh` updates everything and keeps `games.json` and the token.

## Picking a game inside a pack

Packs open on their own menu. Use `/jackbox-screen` to see the screen and
`/jackbox-key keys:Down Down Return` to move through it. Once you know the presses
for a game, put them in its `keys` in `games.json` (and adjust `menuDelayMs`, the wait
before pressing) so the bot does it on its own next time.

## Commands

| Command | Does |
| --- | --- |
| `/jackbox pack:3 game:quiplash2` | Launches the game, posts the stream link, then the room code when it appears |
| `/jackbox-stop` | Closes the game and the stream |
| `/jackbox-key keys:...` | Presses keys on the game screen (xdotool names: Up, Down, Return, Escape, space) |
| `/jackbox-screen` | Posts a screenshot of the game screen |
| `/jackbox-code` | Reads the room code off the screen now |

## Troubleshooting

- Logs: `sudo journalctl -u jackbox-bot -f` (and `jackbox-stream`, `jackbox-audio`).
- Stream link loads but stays black: the provider's firewall must allow TCP 8889 and UDP 8189.
- A browser that can't play H.264: set `Environment=STREAM_CODEC=vp8` in
  `/etc/systemd/system/jackbox-bot.service`, then `sudo systemctl daemon-reload && sudo systemctl restart jackbox-bot`.
- Game won't start under Wine: check `sudo journalctl -u jackbox-bot` for the Wine error. Some Steam
  copies need Steam running; tell Claude which pack and what the log says.
