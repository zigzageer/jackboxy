import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobQueue, JobLeaseError, JobShutdownError } from '../src/rpg/job-queue.mjs';

const request = (memberId = 'member-a', overrides = {}) => ({
  type: 'add', guildId: 'guild-a', memberId,
  requesterId: 'requester-a', channelId: 'channel-a', interactionId: `interaction-${memberId}`,
  payload: { name: memberId }, ...overrides,
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(condition, message = 'queue condition', timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'mint-rpg-queue-'));
  const databasePath = path.join(directory, 'jobs.sqlite');
  const queues = [];
  t.after(async () => {
    for (const queue of queues) { await queue.stop(); queue.close(); }
    rmSync(directory, { recursive: true, force: true });
  });
  return (options) => {
    const queue = new JobQueue({ databasePath, pollMs: 5, ...options });
    queues.push(queue);
    return queue;
  };
}

test('same-server character jobs run in parallel, active duplicates share a job, and interaction retries stay deduplicated', async (t) => {
  const make = fixture(t);
  const gate = deferred();
  const running = new Set();
  const notices = [];
  let peak = 0;
  const queue = make({
    workers: 2,
    process: async (job, { checkpoint }) => {
      running.add(job.id);
      peak = Math.max(peak, running.size);
      checkpoint({ stage: 'generating', artifacts: { sprite: `/fixtures/${job.memberId}.png` } });
      await gate.promise;
      running.delete(job.id);
      checkpoint({ stage: 'publishing' });
      return { url: 'https://game.example/guild-a', characterId: `discord-${job.memberId}` };
    },
    notify: async (job) => {
      notices.push(job);
      return `message-${job.id}`;
    },
  });
  t.after(() => gate.resolve());
  const first = queue.enqueue(request());
  const duplicate = queue.enqueue(request('member-a', { interactionId: 'another-interaction' }));
  const second = queue.enqueue(request('member-b'));
  const third = queue.enqueue(request('member-c'));
  assert.equal(first.existing, false);
  assert.equal(duplicate.existing, true);
  assert.equal(duplicate.job.id, first.job.id);
  queue.start();
  await until(() => running.size === 2, 'two simultaneous image workers');
  assert.equal(queue.get(third.job.id).status, 'queued');
  gate.resolve();
  await until(() => notices.length === 3, 'three completion messages');
  assert.equal(peak, 2);
  for (const queued of [first, second, third]) {
    const job = queue.get(queued.job.id);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.attempts, 1);
    assert.equal(job.notification.status, 'sent');
    assert.equal(job.requesterId, 'requester-a');
  }
  const replay = queue.enqueue(request('member-a', { interactionId: 'another-interaction' }));
  assert.equal(replay.job.id, first.job.id);
  assert.equal(replay.existing, true);
  assert.equal(queue.list({ guildId: 'guild-b' }).length, 0);
  assert.equal(queue.list({ guildId: 'guild-a', requesterId: 'requester-a' }).length, 3);
});

test('town-create jobs deduplicate by guild and another guild receives an independent job', (t) => {
  const queue = fixture(t)({});
  const first = queue.enqueue(request(null, { type: 'create' }));
  const second = queue.enqueue(request(null, { type: 'create', interactionId: 'create-retry' }));
  const other = queue.enqueue(request(null, { type: 'create', guildId: 'guild-b', interactionId: 'create-other-guild' }));
  assert.equal(first.job.id, second.job.id);
  assert.equal(second.existing, true);
  assert.notEqual(first.job.id, other.job.id);
});

test('job-type and member filters are applied before the list limit', (t) => {
  const queue = fixture(t)({});
  const town = queue.enqueue(request(null, { type: 'create', interactionId: 'town' })).job;
  const member = queue.enqueue(request('wanted-member')).job;
  for (let index = 0; index < 105; index++) queue.enqueue(request(`unrelated-${index}`));
  queue.enqueue(request('wanted-member', { guildId: 'guild-b', interactionId: 'other-guild-member' }));
  assert.equal(queue.list({ guildId: 'guild-a', type: 'create', limit: 1 })[0].id, town.id);
  assert.equal(queue.list({ guildId: 'guild-a', type: 'add', memberId: 'wanted-member', limit: 1 })[0].id, member.id);
  assert.equal(queue.list({ guildId: 'guild-a', memberId: null, limit: 1 })[0].id, town.id);
  assert.deepEqual(queue.list({ guildId: 'guild-a', type: 'create', memberId: 'wanted-member' }), []);
});

test('failed publishing resumes after restart with generated artifacts and stage preserved', async (t) => {
  const make = fixture(t);
  const queue = make({
    process: async (_job, { checkpoint }) => {
      checkpoint({ stage: 'publishing', artifacts: { sprite: '/persisted/sprite.png', town: '/persisted/town.json' } });
      throw new Error('GitHub publishing failed.');
    },
  });
  const { job } = queue.enqueue(request(null, { type: 'create' }));
  queue.start();
  await until(() => queue.get(job.id).status === 'failed');
  assert.equal(queue.get(job.id).stage, 'publishing');
  await queue.stop();
  queue.close();
  let recovered;
  const replacement = make({
    process: async (current, { checkpoint }) => {
      recovered = current;
      checkpoint({ artifacts: { commit: 'published-commit' }, result: { url: 'https://game.example/town' } });
      return { url: 'https://game.example/town' };
    },
    notify: async () => 'resumed-message',
  });
  assert.equal(replacement.resume(job.id).status, 'queued');
  replacement.start();
  await until(() => replacement.get(job.id).notification?.status === 'sent');
  assert.equal(recovered.stage, 'publishing');
  assert.deepEqual(recovered.artifacts, { sprite: '/persisted/sprite.png', town: '/persisted/town.json' });
  assert.equal(replacement.get(job.id).attempts, 2);
  assert.equal(replacement.get(job.id).artifacts.commit, 'published-commit');
  assert.equal(replacement.get(job.id).error, null);
  assert.equal(replacement.enqueue(request(null, { type: 'create' })).job.id, job.id);
});

test('expired leases recover interrupted jobs and stale workers cannot overwrite the new result', async (t) => {
  const make = fixture(t);
  const gate = deferred();
  let timestamp = 1000;
  let staleCheckpoint;
  const original = make({
    now: () => timestamp,
    leaseMs: 500,
    process: async (_job, { checkpoint }) => {
      checkpoint({ stage: 'generated', artifacts: { sprite: '/persisted/already-generated.png' } });
      staleCheckpoint = checkpoint;
      await gate.promise;
      return { commit: 'stale-result' };
    },
  });
  t.after(() => gate.resolve());
  const { job } = original.enqueue(request());
  original.start();
  await until(() => Boolean(staleCheckpoint));
  timestamp += 1000;
  let recovered;
  const replacement = make({
    now: () => timestamp,
    leaseMs: 500,
    process: async (current) => {
      recovered = current;
      return { commit: 'new-result' };
    },
  });
  replacement.start();
  await until(() => replacement.get(job.id).status === 'succeeded');
  assert.equal(recovered.artifacts.sprite, '/persisted/already-generated.png');
  assert.equal(recovered.stage, 'generated');
  assert.equal(recovered.attempts, 2);
  assert.throws(() => staleCheckpoint({ stage: 'overwrite' }), JobLeaseError);
  gate.resolve();
  await original.stop();
  assert.deepEqual(replacement.get(job.id).result, { commit: 'new-result' });
});

test('resuming a failed job records the retry interaction and the current requester without changing an active requester', async (t) => {
  let attempts = 0;
  const notices = [];
  const queue = fixture(t)({
    process: async () => {
      attempts++;
      if (attempts === 1) throw new Error('Publishing failed.');
      return { url: 'https://game.example/town' };
    },
    notify: async (job) => { notices.push(job); return `notice-${notices.length}`; },
  });
  const { job } = queue.enqueue(request());
  queue.start();
  await until(() => queue.get(job.id).status === 'failed');
  await queue.stop();
  const resumed = queue.resume(job.id, { interactionId: 'resume-interaction', requesterId: 'requester-b', channelId: 'channel-b' });
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.requesterId, 'requester-b');
  assert.equal(resumed.channelId, 'channel-b');
  const duplicate = queue.enqueue(request('member-a', {
    interactionId: 'resume-interaction', requesterId: 'requester-c', channelId: 'channel-c',
  }));
  assert.equal(duplicate.job.id, job.id);
  assert.equal(duplicate.existing, true);
  const active = queue.resume(job.id, { interactionId: 'another-resume-interaction', requesterId: 'requester-c', channelId: 'channel-c' });
  assert.equal(active.requesterId, 'requester-b');
  assert.equal(active.channelId, 'channel-b');
  queue.start();
  await until(() => notices.some((notice) => notice.status === 'succeeded'));
  const completion = notices.find((notice) => notice.status === 'succeeded');
  assert.equal(completion.requesterId, 'requester-b');
  assert.equal(completion.channelId, 'channel-b');
  assert.equal(queue.enqueue(request('member-a', { interactionId: 'another-resume-interaction' })).job.id, job.id);
});

test('two queue processes claim each job once while active-member dedup remains atomic', async (t) => {
  const make = fixture(t);
  const gate = deferred();
  const seen = [];
  const processor = async (job) => { seen.push(job.id); await gate.promise; return { ok: true }; };
  const first = make({ workers: 1, process: processor });
  const second = make({ workers: 1, process: processor });
  t.after(() => gate.resolve());
  const jobA = first.enqueue(request()).job;
  assert.equal(second.enqueue(request('member-a', { interactionId: 'cross-process-retry' })).job.id, jobA.id);
  const jobB = second.enqueue(request('member-b')).job;
  first.start();
  second.start();
  await until(() => seen.length === 2);
  assert.deepEqual(new Set(seen), new Set([jobA.id, jobB.id]));
  gate.resolve();
  await until(() => first.get(jobA.id).status === 'succeeded' && second.get(jobB.id).status === 'succeeded');
  assert.equal(first.get(jobA.id).attempts, 1);
  assert.equal(second.get(jobB.id).attempts, 1);
});

test('completion notifications survive restart and retry with one stable Discord nonce', async (t) => {
  const make = fixture(t);
  let timestamp = 10_000;
  const attempted = [];
  const first = make({
    now: () => timestamp,
    notifyRetryMs: 100,
    process: async () => ({ url: 'https://game.example/town' }),
    notify: async (job) => {
      attempted.push(job);
      throw new Error('Discord rejected Bearer abcdefghijklmnopqrstuvwxyz');
    },
  });
  const { job } = first.enqueue(request());
  first.start();
  await until(() => first.get(job.id).notification?.status === 'pending' && attempted.length === 1);
  const failedNotice = first.get(job.id).notification;
  assert.doesNotMatch(failedNotice.error, /abcdefghijklmnopqrstuvwxyz/);
  await first.stop();
  first.close();
  timestamp += 200;
  const second = make({
    now: () => timestamp,
    process: async () => assert.fail('Completed generation must not run again'),
    notify: async (current) => { attempted.push(current); return { id: 'discord-message-123' }; },
  });
  second.start();
  await until(() => second.get(job.id).notification.status === 'sent');
  const completed = second.get(job.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.attempts, 1);
  assert.equal(completed.notification.attempts, 2);
  assert.equal(completed.notification.messageId, 'discord-message-123');
  assert.equal(attempted[0].notification.nonce, attempted[1].notification.nonce);
  assert.ok(attempted[0].notification.nonce.length <= 25);
  assert.equal(attempted[1].notification.enforceNonce, true);
  assert.equal(attempted[1].requesterId, 'requester-a');
});

test('failed jobs retain the failed stage and redact credential-like errors', async (t) => {
  const queue = fixture(t)({
    process: async (_job, { checkpoint }) => {
      checkpoint({ stage: 'generating' });
      throw new Error('Provider failed with Bearer abcdefghijklmnop');
    },
  });
  const { job } = queue.enqueue(request());
  queue.start();
  await until(() => queue.get(job.id).status === 'failed');
  const failed = queue.get(job.id);
  assert.equal(failed.stage, 'generating');
  assert.doesNotMatch(failed.error, /abcdefghijklmnop/);
  assert.match(failed.error, /redacted/);
  assert.equal(queue.resume(job.id).artifacts.constructor, Object);
  await queue.stop();
});

test('canceling shutdown aborts processors and requeues checkpointed work without a failure notification', async (t) => {
  const make = fixture(t);
  let workerStarted = false;
  let signalReason;
  const original = make({
    process: async (_job, { checkpoint, signal }) => {
      checkpoint({ stage: 'generated', artifacts: { sprite: '/persisted/generated.png' } });
      workerStarted = true;
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          signalReason = signal.reason;
          reject(signal.reason);
        }, { once: true });
      });
    },
    notify: async () => assert.fail('Canceled jobs must resume before a completion message'),
  });
  const { job } = original.enqueue(request());
  original.start();
  await until(() => workerStarted);
  await original.stop({ cancel: true });
  const interrupted = original.get(job.id);
  assert.ok(signalReason instanceof JobShutdownError);
  assert.equal(interrupted.status, 'queued');
  assert.equal(interrupted.stage, 'generated');
  assert.equal(interrupted.artifacts.sprite, '/persisted/generated.png');
  assert.equal(interrupted.error, null);
  assert.equal(interrupted.notification, null);
  original.close();
  const replacement = make({
    process: async (current) => {
      assert.equal(current.stage, 'generated');
      assert.equal(current.artifacts.sprite, '/persisted/generated.png');
      return { published: true };
    },
  });
  replacement.start();
  await until(() => replacement.get(job.id).status === 'succeeded');
  assert.equal(replacement.get(job.id).attempts, 2);
});

test('canceling shutdown retains the lease until an aborted processor has actually stopped', async (t) => {
  const make = fixture(t);
  const cleanup = deferred();
  let stopping = false;
  const original = make({
    process: async (_job, { checkpoint, signal }) => {
      checkpoint({ stage: 'generating' });
      await new Promise((_resolve, reject) => signal.addEventListener('abort', async () => {
        stopping = true;
        await cleanup.promise;
        reject(signal.reason);
      }, { once: true }));
    },
  });
  t.after(() => cleanup.resolve());
  const { job } = original.enqueue(request());
  original.start();
  await until(() => original.get(job.id).stage === 'generating');
  const shutdown = original.stop({ cancel: true });
  await until(() => stopping);
  assert.equal(original.get(job.id).status, 'running');
  const replacement = make({ process: async () => ({ published: true }) });
  assert.equal(replacement.claimJob(), null, 'An operation still cleaning up keeps its ownership');
  assert.throws(() => original.start(), /still stopping/);
  cleanup.resolve();
  await shutdown;
  assert.equal(original.get(job.id).status, 'queued');
  replacement.start();
  await until(() => replacement.get(job.id).status === 'succeeded');
});

test('shutdown skips a claimed processor whose callback has not started', async (t) => {
  const queue = fixture(t)({ process: async () => assert.fail('Generation must not start during shutdown') });
  const { job } = queue.enqueue(request());
  queue.start();
  queue.tick();
  await queue.stop({ cancel: true });
  assert.equal(queue.get(job.id).status, 'queued');
  assert.equal(queue.get(job.id).stage, 'queued');
});
