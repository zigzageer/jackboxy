# Jackbox launcher bot

`/jackbox pack:3 game:quiplash` starts Quiplash 2 on the host, posts a public
watch link, and sends the caller a private browser control link. Players watch
the video and game audio in their browsers, then join and answer on
[jackbox.tv](https://jackbox.tv). Jackbox streaming does not require a voice connection.
The separate `/vc join` and `/vc leave` commands manage an optional voice connection.
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
   channel. For `/vc join`, also grant **View Channel** and **Connect** in each
   target voice channel. Speak, Mute Members and Deafen Members are unnecessary:
   the bot joins self-muted and self-deafened.
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
| `/codex prompt:...` | Owner only: asks Codex to investigate and repair the host repository. |
| `/codex action:status` | Owner only: checks whether a repair is running. |
| `/codex action:cancel` | Owner only: stops the current repair; edits already saved remain on disk. |
| `/vc join channel:...` | Opens Discord's server voice-channel picker; accepts a channel ID and joins self-muted and self-deafened. |
| `/vc leave` | Leaves the bot's voice channel in the current server. |
| `/jackbox pack:3 game:quiplash` | Launches the shared game; both options autocomplete. |
| `/jackbox pack:3 game:quiplash calibrate:true` | Opens the pack without replaying saved steps so you can record a replacement. |
| `/jackbox-stop` | Closes the current game and stream. |
| `/jackbox-key keys:Down Down Return` | Sends menu keys on the Linux host. |
| `/jackbox-screen` | Posts a screenshot. |
| `/jackbox-code` | Reads and posts the room code visible on screen. |

`/jackbox-key` and `/jackbox-stop` require the user who launched the current game
or a member with **Manage Server** permission. The private browser link can be
shared with another trusted host without granting that Discord permission.

`/vc` commands work independently of the running game, including in another
server. A new join moves the bot's existing voice connection in that server.
The caller does not need to be in voice. No game audio or video is sent to
Discord through this connection. Re-run `npm run register` after updating to
make the new command available, then restart the bot.

The bot also tries to post the room code after launch. OCR may fail on some
screens; use the browser stream to read it directly.

## Codex maintenance

`/codex` accepts requests only from Discord user **573614648239194186**.
Server administrator permissions do not bypass this check. Replies are private;
requests, tool output and credentials are not posted to the channel. Each job
runs the Codex CLI locally on the bot's machine, using that Linux account's
Codex login or API credentials and the associated plan or API billing.

On an installed VPS, update the repository and dependencies, run
`npm run register` in `bot/`, then run:

```bash
sudo bash /opt/jackbox/repo/server/jackbox-codex-setup
```

The helper installs Codex CLI 0.163.0 for the `jackbox` account, starts device
login if needed, saves the maintenance settings in the existing `.env`, and
restarts the bot. It preserves the game configuration and other `.env` settings.
Finish the device login in your browser; pairing a remote device or signing
in as `ubuntu` does not authenticate the separate `jackbox` account.

For example:

```text
/codex prompt:The stream sometimes jumps forward five seconds. Diagnose the cause, fix it, and test the change. restart:true
/codex action:status
/codex action:cancel
```

`prompt` starts a repair; `action` defaults to `run`. Only one repair runs at a
time, with a ten-minute deadline. Cancelled, failed or timed-out repairs may
have saved partial edits, so review those edits before retrying. The final
private reply reports the result; only the final assistant summary is returned,
with credential redaction and Discord mentions and link previews disabled.

Codex runs as the unprivileged bot account with its repository as the working
directory, the `workspace-write` sandbox and noninteractive approvals. It can
inspect runtime information available to that account and edit repository
files. It cannot make root-only system changes; it must report any remaining
privileged steps. Requests to reset, commit, push, change authentication or
restart the bot directly are excluded from the maintenance instructions.

Changes to bot code require a restart. With `restart:true`, a successful job
delivers its private result and then exits cleanly with a failure status so the
VPS service's `Restart=on-failure` starts the new code. This stops any active
game and voice connection. Without that option, the bot keeps running until
you restart it. Automatic restart requires `CODEX_ALLOW_RESTART=true` and a
systemd invocation, both supplied by the VPS setup.

For a custom deployment, explicitly set `CODEX_ENABLED=true`, `CODEX_BIN` to
the CLI executable and `CODEX_HOME` to the authenticated service account's
absolute state directory. An API key can instead be provided securely through
the service account's Codex authentication setup or its `OPENAI_API_KEY`
environment variable. The CLI ignores user configuration and execpolicy rules
for these jobs; this integration uses the standard OpenAI Codex provider.
Never put API keys in the slash-command prompt or Discord messages.

## Validation

```bash
npm test
node --test ../server/test/*.test.cjs
```

These checks run locally without game files or Discord credentials. A live VPS
still needs a real game launch and an external browser check for audio, video,
controls and player joining.
