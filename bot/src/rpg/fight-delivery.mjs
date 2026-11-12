import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PermissionFlagsBits } from "discord.js";
import { MatchServiceError } from "./match-client.mjs";

const LEASE_MS = 30_000;
const GIF_WAIT_MS = 45_000;
const CONCURRENCY = 4;
const GIF_POLL_MS = 1_500;

const messagePayload = content => ({ content, allowedMentions: { parse: [] } });
const deliveryLabel = result => `Fight \`${result.matchId}\``;

export const formatFighterName = name => name.replace(/\s+/g, " ").trim().slice(0, 48).replace(/[\\`*_~|<>\[\]()]/g, "\\$&");

export function fightResultText(result) {
  const winner = result.winnerSide === null
    ? "The fight ended in a draw."
    : `**${formatFighterName(result.names[result.winnerSide])}** (<@${result.winnerUserId}>) defeated **${formatFighterName(result.names[1 - result.winnerSide])}**.`;
  const score = `${result.awarded} leaderboard point${result.awarded === 1 ? "" : "s"} awarded.`;
  return `${winner} ${score}\nReplay <${result.replayUrl}>\n${deliveryLabel(result)}`;
}

function fightResult({ match, score }) {
  return {
    matchId: match.id, replayUrl: match.replayUrl, winnerSide: match.winnerSide,
    names: match.sides.map(side => side.players[0].name),
    awarded: score.awarded, winnerUserId: score.winnerUserId,
  };
}

function canShowValidation(error) {
  return error instanceof MatchServiceError && (error.code === "NOT_CONFIGURED" ||
    (error.code !== "INVALID_RESPONSE" && [400, 401, 403, 404, 409, 422].includes(error.status)));
}

function attachmentRejected(error) {
  return [40005, 50013, 50035, 50045].includes(Number(error?.code)) || error?.status === 413;
}

export class FightDelivery {
  constructor({ databasePath, service, client, now = Date.now, logger = console }) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rpg_fight_deliveries (
        interaction_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL, opponent_id TEXT NOT NULL, attachment_limit INTEGER NOT NULL,
        result_json TEXT, message_id TEXT, send_started_at INTEGER, gif_deadline INTEGER,
        finished INTEGER NOT NULL DEFAULT 0, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS rpg_fight_delivery_due ON rpg_fight_deliveries
        (next_attempt_at, lease_until) WHERE finished=0;
    `);
    this.service = service;
    this.client = client;
    this.now = now;
    this.logger = logger;
    this.owner = randomUUID();
    this.active = new Map();
    this.stopped = false;
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM rpg_fight_deliveries WHERE interaction_id=?").get(id);
    return row && {
      messageId: row.message_id, error: row.error, finished: Boolean(row.finished),
      result: row.result_json ? JSON.parse(row.result_json) : null,
    };
  }

  async submit({ interactionId, guildId, channelId, userId, opponentUserId, attachmentLimit }) {
    if (this.stopped) throw new Error("The fight worker has stopped.");
    this.db.prepare(`INSERT OR IGNORE INTO rpg_fight_deliveries
      (interaction_id, guild_id, channel_id, user_id, opponent_id, attachment_limit, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(interactionId, guildId, channelId, userId, opponentUserId, attachmentLimit, this.now());
    const row = this.db.prepare("SELECT * FROM rpg_fight_deliveries WHERE interaction_id=?").get(interactionId);
    if (row.guild_id !== guildId || row.channel_id !== channelId || row.user_id !== userId || row.opponent_id !== opponentUserId) {
      throw new MatchServiceError("RETRY_CONFLICT");
    }
    if (!row.finished && !row.message_id) await this.launch(interactionId);
    return this.get(interactionId);
  }

  claim(id = null) {
    const now = this.now();
    return this.db.prepare(`UPDATE rpg_fight_deliveries SET lease_owner=?, lease_until=? WHERE interaction_id=(
      SELECT interaction_id FROM rpg_fight_deliveries
      WHERE finished=0 AND next_attempt_at<=? AND lease_until<=? AND (? IS NULL OR interaction_id=?)
      ORDER BY next_attempt_at, interaction_id LIMIT 1
    ) RETURNING *`).get(this.owner, now + LEASE_MS, now, now, id, id);
  }

  update(row, assignments, ...values) {
    const changes = this.db.prepare(`UPDATE rpg_fight_deliveries SET ${assignments} WHERE interaction_id=? AND lease_owner=?`)
      .run(...values, row.interaction_id, this.owner).changes;
    if (!changes) throw new Error("The fight worker lost its lease.");
  }

  async findStatus(channel, row, content) {
    // Nonce deduplication covers short retries. Check history if the send could have happened longer ago.
    if (row.send_started_at === null || this.now() - row.send_started_at < 60_000 ||
        !this.client.user?.id || typeof channel.messages.fetch !== "function") return null;
    let before;
    try {
      for (let page = 0; page < 5; page++) {
        const recent = await channel.messages.fetch({ limit: 100, before, cache: false });
        const known = recent.find(message => message.author?.id === this.client.user.id && message.content === content);
        if (known) return known;
        const oldest = recent.last();
        if (!oldest || recent.size < 100 || oldest.createdTimestamp < row.send_started_at - 5_000) return null;
        before = oldest.id;
      }
    } catch {
      // The bot can still send in channels where it cannot read history.
    }
    return null;
  }

  async postStatus(channel, row, result) {
    const content = `Preparing the fight result for <@${row.user_id}> vs. <@${row.opponent_id}>…\n${deliveryLabel(result)}`;
    let message = await this.findStatus(channel, row, content);
    if (!message) {
      if (row.send_started_at === null) this.update(row, "send_started_at=?", this.now());
      message = await channel.send({ ...messagePayload(content), nonce: row.interaction_id, enforceNonce: true });
    }
    if (!message?.id) throw new Error("Discord did not return a fight message ID.");
    this.update(row, "message_id=?, gif_deadline=?, next_attempt_at=?, attempts=0", message.id, this.now() + GIF_WAIT_MS, this.now());
  }

  async finishMessage(channel, row, result) {
    let gif;
    const canAttach = channel.permissionsFor?.(this.client.user)?.has(PermissionFlagsBits.AttachFiles) !== false;
    if (row.attachment_limit > 0 && canAttach) {
      try {
        gif = await this.service.getFightGif({ matchId: result.matchId, maxBytes: row.attachment_limit,
          timeoutMs: Math.max(1_500, Math.min(5_000, row.gif_deadline - this.now())) });
      } catch {
        // The saved result and replay can still be delivered if the GIF request fails.
      }
    }
    if (gif?.status === "queued" && this.now() < row.gif_deadline) {
      this.update(row, "next_attempt_at=?", Math.min(this.now() + GIF_POLL_MS, row.gif_deadline));
      return;
    }
    const payload = messagePayload(fightResultText(result));
    if (gif?.status === "ready" && gif.bytes.length <= row.attachment_limit) {
      try {
        await channel.messages.edit(row.message_id, { ...payload, attachments: [],
          files: [{ attachment: gif.bytes, name: `fight-${result.matchId}.gif` }] });
        this.update(row, "finished=1");
        return;
      } catch (error) {
        if (!attachmentRejected(error)) throw error;
      }
    }
    await channel.messages.edit(row.message_id, payload);
    this.update(row, "finished=1");
  }

  async work(row) {
    const heartbeat = setInterval(() => {
      try { this.update(row, "lease_until=?", this.now() + LEASE_MS); }
      catch { this.logger.error?.("[rpg fight] Could not renew delivery lease.", row.interaction_id); }
    }, LEASE_MS / 3);
    heartbeat.unref();
    try {
      let result = row.result_json ? JSON.parse(row.result_json) : null;
      if (!result) {
        try {
          result = fightResult(await this.service.startFight({
            interactionId: row.interaction_id, guildId: row.guild_id, userId: row.user_id, opponentUserId: row.opponent_id,
          }));
        } catch (error) {
          if (!canShowValidation(error)) throw error;
          this.update(row, "finished=1, error=?", error.message);
          return;
        }
        this.update(row, "result_json=?, attempts=0", JSON.stringify(result));
        row.attempts = 0;
      }
      const channel = await this.client.channels.fetch(row.channel_id);
      if (channel?.guildId !== row.guild_id || typeof channel.send !== "function" || typeof channel.messages?.edit !== "function") {
        throw new Error("The fight channel is unavailable.");
      }
      if (row.message_id) await this.finishMessage(channel, row, result);
      else await this.postStatus(channel, row, result);
    } catch (error) {
      if ([10003, 10008].includes(Number(error?.code))) {
        this.update(row, "finished=1, error=?", "The fight channel or message is no longer available.");
      } else {
        const delay = Math.min(300_000, 1000 * 2 ** Math.min(row.attempts, 8));
        this.update(row, "attempts=attempts+1, next_attempt_at=?", this.now() + delay);
        this.logger.error?.("[rpg fight] Delivery will be retried.", row.interaction_id);
      }
    } finally {
      clearInterval(heartbeat);
      this.db.prepare("UPDATE rpg_fight_deliveries SET lease_owner=NULL, lease_until=0 WHERE interaction_id=? AND lease_owner=?")
        .run(row.interaction_id, this.owner);
    }
  }

  launch(id) {
    if (this.stopped) return;
    if (this.active.has(id)) return this.active.get(id);
    if (this.active.size >= CONCURRENCY) return;
    const row = this.claim(id);
    if (!row) return;
    const work = this.work(row).finally(() => this.active.delete(row.interaction_id));
    this.active.set(row.interaction_id, work);
    return work;
  }

  async poll() {
    const tasks = [];
    for (let work = this.launch(); work; work = this.launch()) tasks.push(work);
    await Promise.all(tasks);
  }

  start() {
    if (this.timer || this.stopped) return;
    const poll = () => this.poll().catch(() => this.logger.error?.("[rpg fight] Delivery worker failed."));
    this.timer = setInterval(poll, 1000);
    this.timer.unref();
    poll();
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.active.values());
    this.db.close();
  }
}
