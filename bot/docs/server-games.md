# Discord server games

The Ubuntu bot owns commands, generation workers, publishing jobs, and Discord notifications. The `zigzageer/grapevinerpg` service owns the town renderer, character links, match legality, deadlines, seeded simulation, and replay records.

## Commands

- `/game create` queues an empty server town or resumes a failed publication.
- `/game add user:@member` queues a character. Optional `name`, `desc`, `use-pfp`, and uploaded `image` inputs retain their existing meanings.
- `/game status job:<id>` checks a saved job. Omit `job` for recent jobs. Members see their own requests, and managers see their server's requests.
- `/game link character:discord-<your-user-id>` asks the shared service to link an eligible owned roster character.
- `/fighter set [character]` opts you into automatic fights with an owned character. Choose a character from autocomplete or omit it to use your default. Characters from `/game add` belong to the member automatically.
- `/fighter assign user:@member character:<character>` lets a member with Manage Server assign an available roster character. The recipient opts in with `/fighter set`.
- `/fighter pause` opts you out of automatic fights in this server.
- `/fight user:@member` runs an automatic fight between two opted-in members. The bot edits its message with the winner, replay, leaderboard points awarded, and a GIF when available.
- `/leaderboard scope:server` and `/leaderboard scope:global` show the top ten automatic fighters by points.
- `/duel challenge user:@member` offers a turn-based duel.
- `/duel attack match:<id>` makes a basic attack on a legal turn.
- `/duel ability match:<id>` uses the linked character's once-per-duel signature move on a legal turn.
- `/duel status match:<id>` checks a duel and its replay.
- `/war challenge server:<guild-id> minimum:<1-24>` offers a server war. The opposing manager accepts using the button in that server.
- `/war status match:<id>` checks a war and its replay.

Creating towns is restricted to Discord user ID `573614648239194186`. Adding characters requires Manage Server or the existing configured bot owner. War management uses the invoking member's Manage Server permission. Character linking, duel acceptance, signup eligibility, and turn validity are checked by the shared service using verified Discord identities.

## Worker configuration

Use Node 22.12 or later. The existing saved ChatGPT/Codex login remains the generation and connected-app publishing path. Image workers remove provider API keys from child environments.

Set `GAME_STATE_DIR` to a persistent directory writable by the bot user. Its default is `/var/lib/jackbox-rpg`. SQLite stores jobs, interaction retry mappings, generation checkpoints, guild posting channels, matches, and notification outboxes. Artwork checkpoints are stored in its `artifacts` directory.

`GAME_WORKERS` defaults to `2` and accepts `1` through `8`. Independent character and town jobs can overlap. `GAME_BUILDING_WORKERS` defaults to `2` and bounds simultaneous native ImageGen building calls across active town jobs. Publishing is serialized and each attempt reads the latest GitHub revision. Leave `GAME_GITHUB_BRANCH` unset to discover the repository's default branch for every snapshot. `GAME_GITHUB_REPOSITORY` defaults to `zigzageer/grapevinerpg`.

Commands acknowledge before configuration or network requests. Queued work gets a persistent job ID. A repeated active guild/member request returns the existing job. Failed matching requests resume saved generation files. A changed generation request can start a new job when the preceding request failed before adding the character.

Town inspiration reads only the guild name and channel names visible to the `@everyone` role. Threads, private channel names, topics, and message contents are excluded. The worker plans a unique town and generates a separate original South Park-style WebP for every building, using the pinned Grapevine examples as style references. Each completed building is saved with its own hash and generation checkpoint. The worker runs the exact website `scripts/validate-town.mjs` and checks every image decodes, then commits `game.json`, `town.json`, and referenced art in a single transaction under `public/games/<guildId>/`. New games start with zero characters. Repeating create freshly checks the published town and fills genuinely missing artwork. Existing valid artwork, layout, URL, and roster are preserved. A complete live town returns its existing link. Existing roster and website edits are merged from the latest snapshot. `game.botJobs` stores idempotency markers. Per-attempt artifact selection preserves newer artwork when an existing town or member wins a concurrent update.

Completion and failure notices are normal channel messages. Job notices mention only the requester. Delivery retries use a durable outbox and a stable Discord nonce. `/game status` remains available if the original channel becomes unavailable. Discord's nonce deduplication covers recent sends, so a very long outage after an ambiguous successful send can still cause a repeated notice.

## Shared service connection

Set `GAME_SERVICE_ORIGIN` to the HTTPS service origin and `GAME_SERVICE_CA_FILE` to its CA file when using the VPS certificate. Supply `MINT_MATCH_BOT_SECRET` through a private service environment file. Credentials are supplied by the host and remain outside Git.

The match adapter implements `docs/server-wars-api.md`. Town validation and building-art style references are pinned to `zigzageer/grapevinerpg` commit `d9df0e5092c854620dcd90ea99a594090630e997`. The bundled `tsx` dependency runs the website's TypeScript validator with the VPS Node runtime. Each POST sends the real Discord interaction ID as `requestId`. The HMAC covers method, full path, loopback client IP, timestamp, and exact UTF-8 body bytes. The bot polls the authoritative match GET endpoint, which advances deadlines and returns stored results. Accepting a war starts the service's 120-second signup. The bot forwards Join buttons and terminal results to both recorded guild channels.

The bot persists challenged-user identities alongside the service snapshot so duel acceptance remains tied to Discord IDs after a restart. The service remains authoritative for each action. Participating servers obtain their posting channel when a town job succeeds or an existing town is requested again.

Automatic fight delivery records the Discord interaction, match result, and channel message ID in SQLite. The bot retries the original interaction ID if the service response is lost. It edits the saved message after a restart, using the replay and text result if a GIF is unavailable or exceeds Discord's attachment limit.

## Verification

The focused tests exercise queue recovery, concurrent same-server characters, active-job deduplication, latest-branch publishing conflicts, saved generation reuse, website-edit preservation, public-channel filtering, startup registration, command acknowledgment, and scoped notifications.

Two-server fixtures exercise challenge acceptance, Join buttons in both guilds, one signup per player, the 120-second deadline, minimum-player cancellation, and forwarding authoritative winners and replay links after a bot restart. Fixture simulation results are supplied by the fixture service. HTTPS integration tests validate real local transport, exact-body HMAC signatures, identical-request retries, and conflicting request IDs.

Production verification is recorded separately from fixture coverage. A live second-server war requires the bot and linked eligible players in both participating servers.
