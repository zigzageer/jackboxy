# Jackbox launcher bot

`/jackbox pack:3 game:quiplash` starts Quiplash 2 on the host, posts a public
watch link, and sends the caller a private browser control link. Players watch
the video and game audio in their browsers, then join and answer on
[jackbox.tv](https://jackbox.tv). The bot does not join Discord voice channels.
One game, screen and stream are shared by everyone using this bot instance.

On the [Linux VPS setup](../server/README.md), Wine runs the games on Xvfb and
openbox. ffmpeg captures that screen and a PulseAudio null sink; MediaMTX serves
the WebRTC video and audio. A small HTTP server in the bot serves the host's
browser controls. Node.js **22.12 or newer** is required.

## Setup

Run the bot on the machine that has your licensed game files. The browser
control and capture features require the Linux VPS tools described above.

1. Create an application at https://discord.com/developers/applications, add a
   bot, and obtain its **bot token** and application ID. User account tokens and
   self-bots are unsupported. Keep the token in `.env`; never post it in chat.
2. Invite it with the `bot` and `applications.commands` scopes. Give it
   **View Channels**, **Send Messages** and **Attach Files** in the intended
   channel. Voice permissions are unnecessary.
3. From `bot/`:

   ```bash
   npm ci
   cp -n .env.example .env
   # Edit .env with your bot token, IDs and browser URLs.
   cp -n games.example.json games.json
   # Edit games.json with real installed paths, or use server/jackbox-discover.
   npm run register
   npm start
   ```

Run `npm run register` yourself after changing command definitions. Set
`DISCORD_GUILD_ID` for immediate registration in one server; leave it empty for
global registration. No Discord registration or credential verification happens
as part of the repository's offline tests.

For Linux, use `"runner": ["wine"]` at the top of `games.json`. The supported
[discovery helper](../server/README.md#existing-game-files-and-discovery) reads
actual executables and generates a new config without overwriting existing files.
`JACKBOX_CONFIG` can point to a different config. The bot re-reads it on commands.
Pack and game matching ignores case, spaces and punctuation; `aliases` arrays
add shortcuts. The Linux template maps Pack 3's `quiplash` to `quiplash2`.

## Browser stream and controls

Set both `STREAM_PUBLIC_URL` (MediaMTX's reader, for example
`http://SERVER_IP:8889/game`) and `CONTROL_PUBLIC_URL` (for example
`http://SERVER_IP:3000`). Setting `CONTROL_PUBLIC_URL` enables the control server;
`CONTROL_HOST` defaults to `0.0.0.0`, and `CONTROL_PORT` defaults to `3000`.
Binding a port does not configure routing or a firewall; use the public address
that your browser can actually reach.

The launch reply shares the stream publicly. The host gets the control URL in
an ephemeral reply. Anyone who has that URL can control the current game, so
share it only with people you trust to host. The browser link is deliberately
shareable and grants control separately from slash-command permissions. A new
game uses a new control token. Use HTTPS for both the
control site and MediaMTX on a public deployment, so tokens are encrypted and
the embedded stream avoids mixed-content blocking. The browser may require a
click to enable video/audio playback; the page also links directly to the stream.

The control page's arrows, Enter and Back send menu key presses. They do not
submit player answers. Launch the correct pack/game target, navigate to its
lobby, then click **Save menu steps** to record that sequence and its timings
in the active config's `menuSteps`. The config must be writable by the bot.
Normal launches replay those steps. To replace a saved sequence, launch with
`/jackbox pack:3 game:quiplash calibrate:true`, which skips existing `keys` and
`menuSteps`, navigate to the lobby again, and save. Recalibrate if loading speed
or menus change. Existing `keys` and `menuDelayMs` settings remain supported, but empty
keys mean the host must choose the game; no menu indexes are guessed.

## Commands

| Command | What it does |
| --- | --- |
| `/jackbox pack:3 game:quiplash` | Launches the shared game; both options autocomplete. |
| `/jackbox pack:3 game:quiplash calibrate:true` | Opens the pack without replaying saved steps so you can record a replacement. |
| `/jackbox-stop` | Closes the current game and stream. |
| `/jackbox-key keys:Down Down Return` | Sends menu keys on the Linux host. |
| `/jackbox-screen` | Posts a screenshot. |
| `/jackbox-code` | Reads and posts the room code visible on screen. |

`/jackbox-key` and `/jackbox-stop` require the user who launched the current game
or a member with **Manage Server** permission. The private browser link can be
shared with another trusted host without granting that Discord permission.

The bot also tries to post the room code after launch. OCR may fail on some
screens; use the browser stream to read it directly.

## Validation

```bash
npm test
node --test ../server/test/*.test.cjs
```

These checks run locally without game files or Discord credentials. A live VPS
still needs a real game launch and an external browser check for audio, video,
controls and player joining.
