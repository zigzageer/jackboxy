# Jackbox server setup (Linux VPS)

Hosts a single shared Jackbox game on Ubuntu 24.04 or newer. Use
`/jackbox pack:3 game:quiplash` in Discord to launch Pack 3's Quiplash 2. The bot
posts a public browser stream and privately gives the caller a host control
link. Players watch the game's video and audio in a browser and submit their
answers on [jackbox.tv](https://jackbox.tv), using the room code. Joining a
Discord voice channel is unnecessary.

Everything runs as the `jackbox` service user:

| Service | Purpose |
| --- | --- |
| `jackbox-screen` | Xvfb virtual screen `:99`, 1280x720. |
| `jackbox-wm` | openbox window focus for the Wine game and menu controls. |
| `jackbox-audio` | PulseAudio `game` null sink; ffmpeg records `game.monitor`. |
| `jackbox-stream` | MediaMTX WebRTC reader at `http://SERVER_IP:8889/game`. |
| `jackbox-bot` | Discord commands, Wine games, ffmpeg capture and browser host controls on TCP 3000. |

## Install

SSH into the VPS as a user with sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/zigzageer/jackboxy/main/server/install.sh | sudo bash
```

The installer provides Node.js **22.12 or newer**, Wine, Xvfb, openbox, PulseAudio,
ffmpeg, OCR tools and MediaMTX. It preserves existing `bot/games.json` and `.env`.
MediaMTX archives are checked against the release's official `checksums.sha256`
before extraction and installation.
On a fresh install it creates a game config containing only supported packs it
actually finds in `/opt/jackbox/games`; an empty folder produces an empty pack
list. Re-running the installer updates the checkout and systemd service files.
Put custom service settings in systemd drop-ins to keep them across updates.

Then:

1. Install games you own with `sudo jackbox-steam` (defaults: packs 1 and 3–8),
   or `sudo jackbox-steam 3 7` for selected packs. SteamCMD asks for your Steam
   login and Steam Guard code locally. You can also copy existing complete pack
   folders as described below.
2. Discover the actual installed paths, review the generated config, and install
   it using the commands below. Saved menu settings are retained when matched.
3. Run `sudo jackbox-config` and enter an official Discord **bot token**,
   application ID and optional server ID. The helper registers the slash
   commands and starts the bot when you invoke it. It preserves other `.env`
   settings. Invite the application with `bot` and `applications.commands`, plus
   View Channels, Send Messages and Attach Files. No voice permissions are needed.

Never use a Discord user account token. Keep bot and Steam credentials out of
chat, repository files, logs and shell command arguments.

## Test in a browser without Discord

With the installer and game configuration already in place, run this in your
SSH terminal. It uses the existing files and services; no Discord token is needed:

```bash
sudo env PUBLIC_IP=YOUR_SERVER_IP bash /opt/jackbox/repo/server/jackbox-web-test 3 quiplash
```

Open the printed **Watch** URL or the **Private host** URL, which includes menu
controls. Keep the private link private. The pack's opening menu appears first;
select the game manually with the host controls. Saved menu steps are skipped
for this test; optionally save a new route once you reach the game's lobby.
Ctrl+C stops the test's game, capture and web server. The Discord bot is stopped
before the test and stays stopped afterward; the screen, audio and stream
services stay running. The host page's Stop button stops the game and capture;
press Ctrl+C to exit the helper. The same firewall ports listed below apply.
`CONTROL_PUBLIC_URL` and `STREAM_PUBLIC_URL` can override the generated URLs.

If the game window stays black, press Ctrl+C and retry with Wine errors enabled
and software rendering for diagnosis:

```bash
sudo env PUBLIC_IP=YOUR_SERVER_IP WINEDEBUG='-all,err+all' LIBGL_ALWAYS_SOFTWARE=1 bash /opt/jackbox/repo/server/jackbox-web-test 3 quiplash
```

This does not establish the cause or guarantee a fix. `LIBGL_DEBUG=verbose` adds
OpenGL loader diagnostics if needed. These settings apply only to that run.
Keep the private host link out of any diagnostic output you share.

## Existing game files and discovery

`jackbox-discover` searches recursively for actual Jackbox pack `.exe` files;
folder names and spaces do not matter. For example, it handles:

```text
/home/ubuntu/The Jackbox Party Pack 3 - ENG/
  The Jackbox Party Pack 3 - ENG/The Jackbox Party Pack 3.exe
```

The preferred game location is `/opt/jackbox/games`. Copy the **entire pack
folder**, including its assets, rather than copying only the executable:

```bash
sudo cp -a -- "/home/ubuntu/The Jackbox Party Pack 3 - ENG" /opt/jackbox/games/
sudo chown -R jackbox:jackbox -- "/opt/jackbox/games/The Jackbox Party Pack 3 - ENG"
sudo -u jackbox jackbox-discover --root /opt/jackbox/games --output /tmp/jackbox-games.discovered.json
```

Review `/tmp/jackbox-games.discovered.json`. When it contains the intended packs
and paths, back up the active configuration and explicitly install the result:

```bash
sudo cp -- /opt/jackbox/repo/bot/games.json "/opt/jackbox/repo/bot/games.json.backup.$(date +%Y%m%d-%H%M%S)"
sudo install -o jackbox -g jackbox -m 0644 /tmp/jackbox-games.discovered.json /opt/jackbox/repo/bot/games.json
```

The helper refuses an existing output file; choose a new output name for the
next run. Without `--output`, JSON goes to stdout and diagnostics to stderr.
The default scan root is `/opt/jackbox/games`; a positional directory also works.
`--config PATH` chooses the existing config whose settings should be merged.
It defaults to `/opt/jackbox/repo/bot/games.json` when installed, or the sibling
`bot/games.json` when run from a checkout. For example, to inspect the original
home-directory layout without changing anything:

```bash
sudo jackbox-discover --root /home/ubuntu --output /tmp/jackbox-home.discovered.json
```

Discovery as root does **not** establish that the `jackbox` service can run those
paths: it must traverse every parent directory and read every asset. A private
`/home/ubuntu` often blocks that. Prefer copying the complete packs as above;
the helper never changes home-directory permissions, moves games or deletes files.
Running discovery as `jackbox` checks traversal of the selected tree.

Only discovered packs with templates in `server/games.linux.json` are included
(currently packs 1 and 3–8). Missing packs are omitted; unsupported pack numbers
are reported. Ambiguous duplicate executables cause an error unless the current
config already selects one of them. Choose a narrower `--root` to resolve that.
Existing game keys, aliases, `keys`, `menuSteps`, delays and other settings are
preserved when possible; the Pack 3 template also adds the `quiplash` alias.
The helper writes only a new output file and never edits the active configuration.

## Host controls and menu calibration

Open the private link from the bot's ephemeral reply. Its stream includes video
and audio; browser autoplay rules may require a click or unmuting. Use the
arrows, Enter and Back to navigate the pack's game menu. Player answers and
join/ready buttons belong on each player's [jackbox.tv](https://jackbox.tv) page.

For automatic game selection, launch the correct pack/game target, navigate
from its opening menu to that game's lobby, then click **Save menu steps**.
The bot saves the keys and their timing since launch into that game's
`menuSteps` in the active config. It needs write access to the config. Normal
launches replay the sequence. To replace an existing sequence, run
`/jackbox pack:3 game:quiplash calibrate:true`, which skips saved `keys` and
`menuSteps`, navigate again and save. Recalibrate if loading speed or menus change.
Do not record phone interactions or gameplay answers as menu steps.

No menu positions are guessed. An empty `keys`/`menuSteps` configuration leaves
selection to the host. Existing manually configured `keys` arrays and
`menuDelayMs` remain available; use `/jackbox-screen` and
`/jackbox-key keys:Down Down Return` to inspect and navigate while calibrating.

## URLs and firewall

The installer sets these in `jackbox-bot.service`:

```text
STREAM_PUBLIC_URL=http://SERVER_IP:8889/game
CONTROL_PUBLIC_URL=http://SERVER_IP:3000
CONTROL_HOST=0.0.0.0
CONTROL_PORT=3000
```

The control server starts with the bot when `CONTROL_PUBLIC_URL` is set. The
stream link is public; the private control link is a bearer credential that
lets its holder press keys for the current game. You can deliberately share it
with another trusted host; avoid posting it publicly. A new game gets a new
token. Use HTTPS for both the control URL and the MediaMTX reader on
public deployments, with a reverse proxy and certificates. HTTPS control pages
also need HTTPS media URLs to avoid browser mixed-content blocking.

Allow **TCP 3000** (host controls), **TCP 8889** (WebRTC reader/signaling),
**UDP 8189** (WebRTC media) and **TCP 8189** (WebRTC media fallback) in both the
OS firewall and the VPS provider firewall. MediaMTX listens on both protocols
so viewers on networks that block UDP can connect over TCP instead.
The installer adds those rules when UFW is already active. RTSP publication on
TCP 8554 remains bound to loopback. With an HTTPS proxy, expose its TCP 443
endpoint and restrict direct HTTP ports to the intended network; keep WebRTC
media reachable. Browsers must reach the public IP advertised in
`/etc/jackbox-mediamtx.yml`.

To customize service values, run `sudo systemctl edit jackbox-bot`, add a
`[Service]` section with `Environment=NAME=value` lines, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl restart jackbox-bot
```

## Commands and checks

| Command | Purpose |
| --- | --- |
| `/jackbox pack:3 game:quiplash` | Starts the game and posts watch/control links, then the room code when detected. |
| `/jackbox pack:3 game:quiplash calibrate:true` | Skips saved menu steps so the host can record a replacement. |
| `/jackbox-stop` | Closes the game and stream. |
| `/jackbox-key keys:...` | Sends menu keys such as Up, Down, Return, Escape or space. |
| `/jackbox-screen` | Posts a screenshot. |
| `/jackbox-code` | Reads the current room code. |

`/jackbox-key` and `/jackbox-stop` require the current game's launcher or a member
with **Manage Server** permission. A private browser link intentionally grants
control to its holder, so it can be shared with another trusted host independently.

Check services and logs:

```bash
sudo systemctl --no-pager status jackbox-screen jackbox-wm jackbox-audio jackbox-stream jackbox-bot
sudo journalctl -u jackbox-bot -f
```

After a launch, open the watch URL from an external browser, enable audio, and
verify that host controls change the visible menu. Join the displayed room on
jackbox.tv. This checks browser playback, WebRTC media routing, game assets and
input together; a running service alone does not establish those work.

Snapshots retain installed files and configuration, but running processes and
network connections do not survive restoration. Start the systemd services
again and repeat the browser check. From the cloud development checkout,
`cd bot && npm ci && npm test` validates the bot, and
`node --test server/test/*.test.cjs` from the repository root checks discovery
and archive verification using temporary fixtures; neither needs live credentials.

## Troubleshooting

- Stream page loads but stays black: check TCP 8889, UDP 8189 and TCP 8189 in both
  firewalls, MediaMTX's advertised public IP, and `journalctl -u jackbox-stream`.
- No audio: click the player's audio control; check `jackbox-audio` logs and
  that ffmpeg is recording the `game.monitor` source.
- Browser lacks H.264: set `Environment=STREAM_CODEC=vp8` in a bot service
  drop-in and restart the bot.
- Private page is unreachable: check `CONTROL_PUBLIC_URL`, the listening host
  and port, and TCP 3000/provider firewall or HTTPS proxy routing.
- Executable missing or permission denied: rediscover the actual path, copy
  complete assets into `/opt/jackbox/games`, and check access as `jackbox`.
- Save fails: the active `JACKBOX_CONFIG` (or default `bot/games.json`) must be
  writable by `jackbox`. Use service logs to find the precise path/error.
- Wine fails: inspect `sudo journalctl -u jackbox-bot` for the game error.
  Some Steam builds also require Steam running; discovery does not remove DRM.
