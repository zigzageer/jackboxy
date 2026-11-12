import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const FINAL_STATES = new Set(["completed", "cancelled", "declined"]);
const PHASE_ORDER = { pending: 0, signup: 1, active: 2, completed: 3, cancelled: 3, declined: 3 };

function notificationNonce(id) {
  return createHash("sha256").update(id).digest("hex").slice(0, 24);
}

export class MatchState {
  constructor({ databasePath, now = Date.now }) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.now = now;
    this.owner = randomUUID();
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS rpg_guild_channels (
        guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL,
        name TEXT, game_url TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rpg_tracked_matches (
        id TEXT PRIMARY KEY, value TEXT NOT NULL, channels TEXT NOT NULL,
        terminal INTEGER NOT NULL DEFAULT 0, next_poll_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rpg_match_notifications (
        id TEXT PRIMARY KEY, match_id TEXT NOT NULL, guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL,
        nonce TEXT NOT NULL, sent_message_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
  }

  registerGuild({ guildId, channelId, name, gameUrl }) {
    this.db.prepare(`INSERT INTO rpg_guild_channels (guild_id, channel_id, name, game_url, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET
      channel_id=excluded.channel_id, name=COALESCE(excluded.name, name),
      game_url=COALESCE(excluded.game_url, game_url), updated_at=excluded.updated_at`)
      .run(guildId, channelId, name ?? null, gameUrl ?? null, this.now());
  }

  guild(guildId) {
    const row = this.db.prepare("SELECT * FROM rpg_guild_channels WHERE guild_id=?").get(guildId);
    return row ? { guildId: row.guild_id, channelId: row.channel_id, name: row.name, gameUrl: row.game_url } : null;
  }

  match(id) {
    const row = this.db.prepare("SELECT value, channels FROM rpg_tracked_matches WHERE id=?").get(id);
    return row ? { match: JSON.parse(row.value), channels: JSON.parse(row.channels) } : null;
  }

  saveMatch(match, channels, notifications = []) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.match(match.id);
      const currentRevision = existing?.match.revision ?? existing?.match.version;
      const nextRevision = match.revision ?? match.version;
      const phaseDowngrade = existing && PHASE_ORDER[existing.match.status] > PHASE_ORDER[match.status];
      const terminalChanged = existing && FINAL_STATES.has(existing.match.status) && existing.match.status !== match.status;
      const staleRevision = typeof currentRevision === "number" && typeof nextRevision === "number" && currentRevision > nextRevision;
      if (phaseDowngrade || terminalChanged || staleRevision) {
        this.db.exec("COMMIT");
        return existing.match;
      }
      const storedChannels = channels ?? existing?.channels ?? [];
      this.db.prepare(`INSERT INTO rpg_tracked_matches (id, value, channels, terminal, next_poll_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET
        value=excluded.value, channels=excluded.channels, terminal=excluded.terminal,
        next_poll_at=0, updated_at=excluded.updated_at`)
        .run(match.id, JSON.stringify(match), JSON.stringify(storedChannels), Number(FINAL_STATES.has(match.status)), this.now());
      if (match.status !== "pending") {
        this.db.prepare(`DELETE FROM rpg_match_notifications WHERE match_id=? AND sent_message_id IS NULL
          AND lease_until<=? AND event='challenge'`).run(match.id, this.now());
      }
      if (FINAL_STATES.has(match.status)) {
        this.db.prepare(`DELETE FROM rpg_match_notifications WHERE match_id=? AND sent_message_id IS NULL
          AND lease_until<=? AND event NOT IN ('result')`).run(match.id, this.now());
      }
      const insert = this.db.prepare(`INSERT OR IGNORE INTO rpg_match_notifications
        (id, match_id, guild_id, channel_id, event, payload, nonce, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const notice of notifications) {
        const id = `${match.id}:${notice.guildId}:${notice.channelId}:${notice.event}`;
        insert.run(id, match.id, notice.guildId, notice.channelId, notice.event,
          JSON.stringify(notice.payload), notificationNonce(id), this.now());
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return match;
  }

  activeMatches(limit = 100) {
    return this.db.prepare(`SELECT value, channels FROM rpg_tracked_matches
      WHERE terminal=0 AND next_poll_at<=? ORDER BY updated_at LIMIT ?`).all(this.now(), limit)
      .map(row => ({ match: JSON.parse(row.value), channels: JSON.parse(row.channels) }));
  }

  deferMatch(id, delayMs = 10_000) {
    this.db.prepare("UPDATE rpg_tracked_matches SET next_poll_at=? WHERE id=?").run(this.now() + delayMs, id);
  }

  claimNotification(leaseMs = 60_000) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT * FROM rpg_match_notifications WHERE sent_message_id IS NULL
        AND next_attempt_at<=? AND lease_until<=? ORDER BY created_at, id LIMIT 1`).get(this.now(), this.now());
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db.prepare("UPDATE rpg_match_notifications SET lease_owner=?, lease_until=? WHERE id=?")
        .run(this.owner, this.now() + leaseMs, row.id);
      this.db.exec("COMMIT");
      return { id: row.id, matchId: row.match_id, guildId: row.guild_id, channelId: row.channel_id,
        event: row.event, payload: JSON.parse(row.payload), nonce: row.nonce, attempts: row.attempts };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  notificationSent(id, messageId) {
    this.db.prepare(`UPDATE rpg_match_notifications SET sent_message_id=?, lease_owner=NULL, lease_until=0
      WHERE id=? AND lease_owner=?`).run(messageId, id, this.owner);
  }

  notificationFailed(id, attempts) {
    const delayMs = Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8));
    this.db.prepare(`UPDATE rpg_match_notifications SET attempts=attempts+1,
      next_attempt_at=?, lease_owner=NULL, lease_until=0 WHERE id=? AND lease_owner=?`)
      .run(this.now() + delayMs, id, this.owner);
  }

  close() {
    this.db.prepare("UPDATE rpg_match_notifications SET lease_owner=NULL, lease_until=0 WHERE lease_owner=?").run(this.owner);
    this.db.close();
  }
}
