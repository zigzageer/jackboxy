# Discord server games

The Ubuntu bot owns commands, generation workers, publishing jobs, and Discord notifications. The `zigzageer/grapevinerpg` service owns the town renderer, character links, match legality, deadlines, seeded simulation, and replay records.

## Commands

- `/game create` queues an empty server town or resumes a failed publication.
- `/game add user:@member` queues a character. Optional `name`, `desc`, `use-pfp`, and uploaded `image` inputs retain their existing meanings.
- `/game status job:<id>` checks a saved job. Omit `job` for recent jobs. Members see their own requests, and managers see their server's requests.
- `/game link character:discord-<your-user-id>` asks the shared service to link an eligible owned roster character.
- `/fight challenge user:@member` offers an accepted duel.
- `/fight attack match:<id>` makes a basic attack on a legal turn.
- `/fight ability match:<id>` uses the linked character's once-per-duel signature move on a legal turn.
- `/fight status match:<id>` checks a duel and its replay.
- `/war challenge server:<guild-id> minimum:<1-24>` offers a server war. The opposing manager accepts using the button in that server.
- `/war status match:<id>` checks a war and its replay.

Creating towns and adding characters require Manage Server or the existing configured bot owner. War management uses the invoking member's Manage Server permission. Character linking, duel acceptance, signup eligibility, and turn validity are checked by the shared service using verified Discord identities.

## Worker configuration

Use Node 22.12 or later. The existing saved ChatGPT/Codex login remains the generation and connected-app publishing path. Image workers remove provider API keys from child environments.

Set `GAME_STATE_DIR` to a persistent directory writable by the bot user. Its default is `/var/lib/jackbox-rpg`. SQLite stores jobs, interaction retry mappings, generation checkpoints, guild posting channels, matches, and notification outboxes. Artwork checkpoints are stored in its `artifacts` directory.

`GAME_WORKERS` defaults to `2` and accepts `1` through `8`. Independent image generation jobs can overlap. Publishing is serialized and each attempt reads the latest GitHub revision. Leave `GAME_GITHUB_BRANCH` unset to discover the repository's default branch for every snapshot. `GAME_GITHUB_REPOSITORY` defaults to `zigzageer/grapevinerpg`.

Commands acknowledge before configuration or network requests. Queued work gets a persistent job ID. A repeated active guild/member request returns the existing job. Failed matching requests resume saved generation files. A changed generation request can start a new job when the preceding request failed before adding the character.

Town inspiration reads only the guild name and channel names visible to the `@everyone` role. Threads, private channel names, topics, and message contents are excluded. The worker validates the shared v1 schema and walking connectivity, then commits `game.json`, `town.json`, and referenced art in a single transaction under `public/games/<guildId>/`. New games start with zero characters. Existing roster and website edits are merged from the latest snapshot. `game.botJobs` stores idempotency markers. Per-attempt artifact selection preserves newer artwork when an existing town or member wins a concurrent update.

Completion and failure notices are normal channel messages. Job notices mention only the requester. Delivery retries use a durable outbox and a stable Discord nonce. `/game status` remains available if the original channel becomes unavailable. Discord's nonce deduplication covers recent sends, so a very long outage after an ambiguous successful send can still cause a repeated notice.

## Shared service connection

Set `GAME_SERVICE_ORIGIN` to the HTTPS service origin and `GAME_SERVICE_CA_FILE` to its CA file when using the VPS certificate. Supply `MINT_MATCH_BOT_SECRET` through a private service environment file. Credentials are supplied by the host and remain outside Git.

The adapter implements the contract published at `zigzageer/grapevinerpg` commit `57379a8`, in `docs/server-wars-api.md`. Each POST sends the real Discord interaction ID as `requestId`. The HMAC covers method, full path, loopback client IP, timestamp, and exact UTF-8 body bytes. The bot polls the authoritative match GET endpoint, which advances deadlines and returns stored results. Accepting a war starts the service's 120-second signup. The bot forwards Join buttons and terminal results to both recorded guild channels.

The bot persists challenged-user identities alongside the service snapshot so duel acceptance remains tied to Discord IDs after a restart. The service remains authoritative for each action. Participating servers obtain their posting channel when a town job succeeds or an existing town is requested again.

## Verification

The focused tests exercise queue recovery, concurrent same-server characters, active-job deduplication, latest-branch publishing conflicts, saved generation reuse, website-edit preservation, public-channel filtering, startup registration, command acknowledgment, and scoped notifications.

Two-server fixtures exercise challenge acceptance, Join buttons in both guilds, one signup per player, the 120-second deadline, minimum-player cancellation, and forwarding authoritative winners and replay links after a bot restart. Fixture simulation results are supplied by the fixture service. HTTPS integration tests validate real local transport, exact-body HMAC signatures, identical-request retries, and conflicting request IDs.

Production verification is recorded separately from fixture coverage. A live second-server war requires the bot and linked eligible players in both participating servers.
