import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sanitizeCodexText } from './codex-runner.mjs';

function encode(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > 2_000_000) {
    throw new Error('Job metadata must be JSON smaller than 2 MB.');
  }
  return encoded;
}

function object(value, name) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function safeError(error) {
  return sanitizeCodexText(error instanceof Error ? error.message : 'The job failed.').slice(0, 1000);
}

export class JobLeaseError extends Error {
  constructor() {
    super('This job is now owned by another worker.');
    this.name = 'JobLeaseError';
  }
}

export class JobShutdownError extends Error {
  constructor() {
    super('The worker is stopping. This job will resume after restart.');
    this.name = 'JobShutdownError';
  }
}

/** A durable queue. Image workers may run together while publishing uses its own lock. */
export class JobQueue {
  constructor({
    databasePath,
    workers = 2,
    process: processor,
    notify,
    now = Date.now,
    pollMs = 1000,
    leaseMs = 60_000,
    notifyRetryMs = 5000,
    onError = () => {},
  } = {}) {
    required(databasePath, 'Database path');
    if (!Number.isInteger(workers) || workers < 1 || workers > 8) {
      throw new Error('Game workers must be an integer between 1 and 8.');
    }
    if (!Number.isFinite(leaseMs) || leaseMs < 100) {
      throw new Error('Job leases must last at least 100 milliseconds.');
    }
    if (!Number.isFinite(pollMs) || pollMs < 1 || !Number.isFinite(notifyRetryMs) || notifyRetryMs < 1) {
      throw new Error('Queue polling and notification retry intervals must be positive.');
    }
    if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rpg_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        member_id TEXT,
        requester_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        interaction_id TEXT NOT NULL UNIQUE,
        dedup_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        artifacts_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT,
        stage TEXT NOT NULL DEFAULT 'queued',
        status TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        owner_id TEXT,
        lease_until INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS rpg_active_jobs
        ON rpg_jobs(dedup_key) WHERE status IN ('queued', 'running');
      CREATE INDEX IF NOT EXISTS rpg_job_claims ON rpg_jobs(status, lease_until, created_at);
      CREATE INDEX IF NOT EXISTS rpg_job_guilds ON rpg_jobs(guild_id, created_at);
      CREATE INDEX IF NOT EXISTS rpg_job_members ON rpg_jobs(guild_id, type, member_id, created_at);
      CREATE TABLE IF NOT EXISTS rpg_job_interactions (
        interaction_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES rpg_jobs(id)
      );
      CREATE TABLE IF NOT EXISTS rpg_job_notifications (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES rpg_jobs(id),
        job_attempt INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        owner_id TEXT,
        lease_until INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        error TEXT,
        message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        sent_at INTEGER,
        UNIQUE(job_id, job_attempt)
      );
      CREATE INDEX IF NOT EXISTS rpg_notification_claims
        ON rpg_job_notifications(status, next_attempt_at, lease_until);
    `);
    this.workers = workers;
    this.processor = processor;
    this.notify = notify;
    this.now = now;
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
    this.notifyRetryMs = notifyRetryMs;
    this.onError = onError;
    this.ownerId = randomUUID();
    this.activeJobs = new Map();
    this.activeNotification = null;
    this.started = false;
    this.stopping = false;
    this.closed = false;
    this.timer = null;
    this.wakeScheduled = false;
  }

  transaction(task) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = task();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  decode(row) {
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      guildId: row.guild_id,
      memberId: row.member_id,
      requesterId: row.requester_id,
      channelId: row.channel_id,
      interactionId: row.interaction_id,
      payload: JSON.parse(row.payload_json),
      artifacts: JSON.parse(row.artifacts_json),
      result: row.result_json === null ? null : JSON.parse(row.result_json),
      stage: row.stage,
      status: row.status,
      error: row.error,
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  notification(row) {
    return row ? {
      id: row.id,
      nonce: row.id,
      enforceNonce: true,
      status: row.status,
      attempts: row.attempts,
      error: row.error,
      messageId: row.message_id,
      sentAt: row.sent_at,
    } : null;
  }

  get(id) {
    const job = this.decode(this.db.prepare('SELECT * FROM rpg_jobs WHERE id = ?').get(id));
    if (!job) return null;
    const notice = this.db.prepare('SELECT * FROM rpg_job_notifications WHERE job_id = ? ORDER BY rowid DESC LIMIT 1').get(id);
    return { ...job, notification: this.notification(notice) };
  }

  list({ guildId, requesterId, type, memberId, limit = 10 } = {}) {
    const conditions = [];
    const parameters = [];
    if (guildId) { conditions.push('guild_id = ?'); parameters.push(guildId); }
    if (requesterId) { conditions.push('requester_id = ?'); parameters.push(requesterId); }
    if (type) { conditions.push('type = ?'); parameters.push(type); }
    if (memberId === null) conditions.push('member_id IS NULL');
    else if (memberId !== undefined) { conditions.push('member_id = ?'); parameters.push(memberId); }
    const count = Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.trunc(limit) : 10));
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db.prepare(`SELECT id FROM rpg_jobs ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...parameters, count).map(({ id }) => this.get(id));
  }

  enqueue({ type, guildId, memberId = null, requesterId, channelId, interactionId, payload = {} }) {
    for (const [name, value] of Object.entries({ type, guildId, requesterId, channelId, interactionId })) required(value, name);
    if (!/^[a-z][a-z0-9_-]{0,40}$/.test(type)) throw new Error('Invalid job type.');
    if (type === 'add') required(memberId, 'Member ID');
    const encoded = encode(object(payload, 'Payload'));
    const dedupKey = `${type}:${guildId}:${memberId || ''}`;
    const result = this.transaction(() => {
      const retried = this.db.prepare('SELECT job_id FROM rpg_job_interactions WHERE interaction_id = ?').get(interactionId);
      if (retried) return { job: this.get(retried.job_id), existing: true };
      const active = this.db.prepare("SELECT id FROM rpg_jobs WHERE dedup_key = ? AND status IN ('queued', 'running')").get(dedupKey);
      const id = active?.id || randomBytes(12).toString('hex');
      const timestamp = this.now();
      if (!active) {
        this.db.prepare(`INSERT INTO rpg_jobs
          (id, type, guild_id, member_id, requester_id, channel_id, interaction_id, dedup_key, payload_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, type, guildId, memberId, requesterId, channelId, interactionId, dedupKey, encoded, timestamp, timestamp);
      }
      this.db.prepare('INSERT INTO rpg_job_interactions (interaction_id, job_id) VALUES (?, ?)').run(interactionId, id);
      return { job: this.get(id), existing: Boolean(active) };
    });
    this.wake();
    return result;
  }

  resume(id, { interactionId, requesterId, channelId } = {}) {
    for (const [name, value] of Object.entries({ interactionId, requesterId, channelId })) {
      if (value !== undefined) required(value, name);
    }
    const result = this.transaction(() => {
      if (interactionId) {
        const retried = this.db.prepare('SELECT job_id FROM rpg_job_interactions WHERE interaction_id = ?').get(interactionId);
        if (retried) return this.get(retried.job_id);
      }
      const row = this.db.prepare('SELECT * FROM rpg_jobs WHERE id = ?').get(id);
      if (!row) throw new Error('Job not found.');
      const active = row.status === 'failed'
        ? this.db.prepare("SELECT id FROM rpg_jobs WHERE dedup_key = ? AND status IN ('queued', 'running')").get(row.dedup_key)
        : row;
      const destinationId = active?.id || id;
      if (interactionId) {
        this.db.prepare('INSERT INTO rpg_job_interactions (interaction_id, job_id) VALUES (?, ?)').run(interactionId, destinationId);
      }
      if (active) return this.get(active.id);
      const timestamp = this.now();
      this.db.prepare(`UPDATE rpg_jobs SET status = 'queued', error = NULL, completed_at = NULL,
        owner_id = NULL, lease_until = NULL, requester_id = ?, channel_id = ?, updated_at = ? WHERE id = ?`)
        .run(requesterId ?? row.requester_id, channelId ?? row.channel_id, timestamp, id);
      this.db.prepare("UPDATE rpg_job_notifications SET status = 'superseded', updated_at = ? WHERE job_id = ? AND status = 'pending'")
        .run(timestamp, id);
      return this.get(id);
    });
    this.wake();
    return result;
  }

  checkpoint(id, patch) {
    object(patch, 'Checkpoint');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM rpg_jobs WHERE id = ?').get(id);
      if (!row || row.status !== 'running' || row.owner_id !== this.ownerId) throw new JobLeaseError();
      const current = this.decode(row);
      const stage = patch.stage === undefined ? current.stage : required(patch.stage, 'Stage');
      const payload = patch.payload === undefined ? current.payload : { ...current.payload, ...object(patch.payload, 'Payload') };
      const artifacts = patch.artifacts === undefined ? current.artifacts : { ...current.artifacts, ...object(patch.artifacts, 'Artifacts') };
      const result = patch.result === undefined ? row.result_json : encode(patch.result);
      const timestamp = this.now();
      this.db.prepare(`UPDATE rpg_jobs SET stage = ?, payload_json = ?, artifacts_json = ?, result_json = ?,
        updated_at = ?, lease_until = ? WHERE id = ? AND owner_id = ?`)
        .run(stage, encode(payload), encode(artifacts), result, timestamp, timestamp + this.leaseMs, id, this.ownerId);
      return this.get(id);
    });
  }

  start() {
    if (this.closed) throw new Error('The job queue is closed.');
    if (this.stopping) throw new Error('The job queue is still stopping.');
    if (typeof this.processor !== 'function') throw new Error('A job processor is required to start workers.');
    if (this.started) return this;
    this.started = true;
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref();
    this.wake();
    return this;
  }

  wake() {
    if (!this.started || this.wakeScheduled) return;
    this.wakeScheduled = true;
    queueMicrotask(() => {
      this.wakeScheduled = false;
      this.tick();
    });
  }

  claimJob() {
    const active = [...this.activeJobs.keys()];
    const exclusion = active.length ? `AND id NOT IN (${active.map(() => '?').join(', ')})` : '';
    return this.transaction(() => {
      const timestamp = this.now();
      const row = this.db.prepare(`SELECT * FROM rpg_jobs
        WHERE (status = 'queued' OR (status = 'running' AND lease_until <= ?)) ${exclusion}
        ORDER BY created_at, rowid LIMIT 1`).get(timestamp, ...active);
      if (!row) return null;
      this.db.prepare(`UPDATE rpg_jobs SET status = 'running', owner_id = ?, lease_until = ?,
        attempts = attempts + 1, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`)
        .run(this.ownerId, timestamp + this.leaseMs, timestamp, timestamp, row.id);
      return this.get(row.id);
    });
  }

  claimNotification() {
    return this.transaction(() => {
      const timestamp = this.now();
      const row = this.db.prepare(`SELECT * FROM rpg_job_notifications
        WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'sending' AND lease_until <= ?)
        ORDER BY created_at, rowid LIMIT 1`).get(timestamp, timestamp);
      if (!row) return null;
      this.db.prepare(`UPDATE rpg_job_notifications SET status = 'sending', owner_id = ?, lease_until = ?,
        attempts = attempts + 1, updated_at = ? WHERE id = ?`)
        .run(this.ownerId, timestamp + this.leaseMs, timestamp, row.id);
      return this.db.prepare('SELECT * FROM rpg_job_notifications WHERE id = ?').get(row.id);
    });
  }

  finishJob(id, result, error) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM rpg_jobs WHERE id = ?').get(id);
      if (!row || row.status !== 'running' || row.owner_id !== this.ownerId) return false;
      const timestamp = this.now();
      this.db.prepare(`UPDATE rpg_jobs SET status = ?, result_json = ?, error = ?,
        owner_id = NULL, lease_until = NULL, completed_at = ?, updated_at = ? WHERE id = ?`)
        .run(error ? 'failed' : 'succeeded', result === undefined ? row.result_json : encode(result),
          error ? safeError(error) : null, timestamp, timestamp, id);
      const snapshot = this.decode(this.db.prepare('SELECT * FROM rpg_jobs WHERE id = ?').get(id));
      this.db.prepare(`INSERT OR IGNORE INTO rpg_job_notifications
        (id, job_id, job_attempt, snapshot_json, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(randomBytes(12).toString('hex'), id, row.attempts, JSON.stringify(snapshot), timestamp, timestamp, timestamp);
      return true;
    });
  }

  requeueJob(id) {
    return this.db.prepare(`UPDATE rpg_jobs SET status = 'queued', owner_id = NULL, lease_until = NULL,
      error = NULL, completed_at = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND owner_id = ?`)
      .run(this.now(), id, this.ownerId).changes > 0;
  }

  heartbeat(table, id, controller) {
    return setInterval(() => {
      try {
        const result = this.db.prepare(`UPDATE ${table} SET lease_until = ? WHERE id = ? AND owner_id = ?`)
          .run(this.now() + this.leaseMs, id, this.ownerId);
        if (!result.changes) controller?.abort(new JobLeaseError());
      } catch (error) { this.report(error); }
    }, Math.max(25, Math.floor(this.leaseMs / 3)));
  }

  async processJob(job, controller) {
    if (controller.signal.reason instanceof JobShutdownError) {
      this.requeueJob(job.id);
      return;
    }
    const timer = this.heartbeat('rpg_jobs', job.id, controller);
    timer.unref();
    try {
      const result = await this.processor(job, {
        checkpoint: (patch) => this.checkpoint(job.id, patch),
        signal: controller.signal,
      });
      if (controller.signal.reason instanceof JobShutdownError) this.requeueJob(job.id);
      else this.finishJob(job.id, result);
    } catch (error) {
      try {
        if (controller.signal.reason instanceof JobShutdownError) this.requeueJob(job.id);
        else this.finishJob(job.id, undefined, error instanceof Error ? error : new Error('The job failed.'));
      }
      catch (storageError) { this.report(storageError); }
    } finally { clearInterval(timer); }
  }

  async sendNotification(row) {
    const timer = this.heartbeat('rpg_job_notifications', row.id);
    timer.unref();
    try {
      const job = { ...JSON.parse(row.snapshot_json), notification: this.notification(row) };
      const response = await this.notify(job);
      const messageId = typeof response === 'string' ? response : response?.id;
      if (!messageId) throw new Error('Discord did not return a notification message ID.');
      const timestamp = this.now();
      this.db.prepare(`UPDATE rpg_job_notifications SET status = 'sent', message_id = ?, error = NULL,
        sent_at = ?, updated_at = ?, owner_id = NULL, lease_until = NULL WHERE id = ? AND owner_id = ?`)
        .run(messageId, timestamp, timestamp, row.id, this.ownerId);
    } catch (error) {
      const timestamp = this.now();
      const delay = Math.min(3_600_000, this.notifyRetryMs * 2 ** Math.min(row.attempts - 1, 12));
      try {
        this.db.prepare(`UPDATE rpg_job_notifications SET status = 'pending', error = ?, next_attempt_at = ?,
          updated_at = ?, owner_id = NULL, lease_until = NULL WHERE id = ? AND owner_id = ?`)
          .run(safeError(error), timestamp + delay, timestamp, row.id, this.ownerId);
      } catch (storageError) { this.report(storageError); }
    } finally { clearInterval(timer); }
  }

  tick() {
    if (!this.started || this.closed) return;
    try {
      while (this.activeJobs.size < this.workers) {
        const job = this.claimJob();
        if (!job) break;
        const controller = new AbortController();
        const promise = Promise.resolve().then(() => this.processJob(job, controller));
        this.activeJobs.set(job.id, { promise, controller });
        promise.finally(() => {
          this.activeJobs.delete(job.id);
          this.wake();
        }).catch((error) => this.report(error));
      }
      if (typeof this.notify === 'function' && !this.activeNotification) {
        const notice = this.claimNotification();
        if (notice) {
          const promise = Promise.resolve().then(() => this.sendNotification(notice));
          this.activeNotification = promise;
          promise.finally(() => {
            this.activeNotification = null;
            this.wake();
          }).catch((error) => this.report(error));
        }
      }
    } catch (error) { this.report(error); }
  }

  report(error) {
    try { this.onError(new Error(safeError(error))); }
    catch { /* A logging callback must not stop queue recovery. */ }
  }

  async stop({ cancel = false } = {}) {
    this.stopping = true;
    this.started = false;
    clearInterval(this.timer);
    this.timer = null;
    if (cancel) {
      for (const { controller } of this.activeJobs.values()) controller.abort(new JobShutdownError());
    }
    try {
      await Promise.allSettled([
        ...[...this.activeJobs.values()].map(({ promise }) => promise),
        ...(this.activeNotification ? [this.activeNotification] : []),
      ]);
    } finally { this.stopping = false; }
  }

  close() {
    if (this.closed) return;
    if (this.activeJobs.size || this.activeNotification) throw new Error('Stop and drain the workers before closing the queue.');
    this.started = false;
    clearInterval(this.timer);
    this.closed = true;
    this.db.close();
  }
}
