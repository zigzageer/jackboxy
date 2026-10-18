# Jackbox launcher bot (prototype)

A Discord bot with a `/jackbox <pack> <game>` slash command. It looks the game up in
`games.json`, launches its `.exe` on the machine the bot runs on, and joins the
caller's voice channel. On the Linux server setup in [`../server`](../server/README.md)
it also streams the game to a WebRTC page (`src/streaming.js`), presses menu keys and
posts the room code read off the screen (`src/screen.js`).

Built with **discord.js** (v14) and **@discordjs/voice**: the rest of this repo is
Node, discord.js has the most complete slash-command/autocomplete support, and
`@discordjs/voice` is the maintained voice library any later audio/stream work
would build on.

## Commands

| Command | What it does |
| --- | --- |
| `/jackbox pack:3 game:quiplash2` | Launches the game and joins your voice channel. Both options autocomplete from `games.json`. |
| `/jackbox-stop` | Closes the running game and leaves voice. |

Only one game runs at a time. Most Jackbox packs are a single executable, so
the bot starts the pack and tells players which game to pick in its menu; a game
with its own `exe` (like Quiplash 3) is launched directly.

## Setup

Run it on the PC or VPS that has the games installed (Windows, or Linux with Wine/Proton).

1. Create an application at https://discord.com/developers/applications, add a
   bot, and copy its token and the application ID.
2. Invite it with the `bot` and `applications.commands` scopes and the
   **Connect** and **Speak** voice permissions.
3. In this folder:
   ```bash
   npm install
   cp .env.example .env              # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID
   cp games.example.json games.json  # point the exe paths at your installs
   npm run register                  # once, and again whenever commands change
   npm start
   ```

On a Linux host, add `"runner": ["wine"]` (or your Proton command) at the top
of `games.json` and use Linux paths for `exe`; every launch is prefixed with it.

`games.json` is re-read on every command, so path edits apply without a restart.
Matching ignores case, spaces and punctuation, so `Quiplash 2` and `quiplash2`
both work, and a pack can be named by key (`3`) or full name.

## Tests

```bash
npm test
```
