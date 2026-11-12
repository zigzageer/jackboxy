import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGameProcessor, createJobNotifier, publicChannelNames } from '../src/rpg/game-jobs.mjs';
import { JobQueue, JobShutdownError } from '../src/rpg/job-queue.mjs';
import { assertTown } from '../src/rpg/town-validation.mjs';
import { createTownAssetReader, createLiveTownVerifier, decodeTownArtwork } from '../src/rpg/town-assets.mjs';
import sharp from 'sharp';
import { validateTownFile } from '../src/rpg/town-contract.mjs';
import { createTownGenerator } from '../src/rpg/town-generator.mjs';

const GUILD = '123456789012345678';
const MEMBER = '223456789012345678';
const OTHER = '323456789012345678';
const REQUESTER = '423456789012345678';
const CHANNEL = '523456789012345678';
const SAMPLE = JSON.parse(await readFile(new URL('../src/rpg/contracts/sample-town.json', import.meta.url), 'utf8'));
const PNG = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#cc554488' } }).png().toBuffer();
const WEBP = await sharp(PNG).webp({ lossless: true }).toBuffer();
const NATIVE_PNG = await sharp(PNG).extend({ top: 2, bottom: 2, left: 2, right: 2, background: '#00000000' }).png().toBuffer();
const game = () => ({ version: 1, guildId: GUILD, slug: `fixture-${GUILD}`, name: 'Fixture Town', characters: [], websiteSettings: { weather: 'rain' } });
const town = () => structuredClone(SAMPLE);
const completeTown = (format = 'webp') => {
  const document = town();
  for (const building of document.buildings) building.art = `/games/${GUILD}/town/${building.id}.${format}`;
  return document;
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for the game worker');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function publisherFixture({ initialGame = null, initialTown = null, beforePublish, deploymentStates = ['READY'] } = {}) {
  const current = { game: initialGame, town: initialTown, files: new Map(), calls: [], statusCalls: [], commits: 0, head: 'a'.repeat(40) };
  let publicationTail = Promise.resolve();
  let deployments = 0;
  const publisher = {
    async snapshot() { return structuredClone({ game: current.game, town: current.town, head: current.head, branch: 'latest-default' }); },
    async publish(guildId, change, options) {
      const previous = publicationTail;
      let release;
      publicationTail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        if (beforePublish) { await beforePublish(current, options); current.head = 'd'.repeat(40); }
        const applied = Boolean(current.game?.botJobs?.[options.jobId]);
        let files = [];
        if (!applied) {
          const changed = await change(structuredClone({ game: current.game, town: current.town, head: current.head, branch: 'latest-default' }));
          files = changed.files ?? options.files ?? [];
          current.game = { ...changed.game, botJobs: { ...changed.game.botJobs, [options.jobId]: true } };
          current.town = changed.town;
          for (const file of files) current.files.set(file.path, Buffer.from(file.bytes));
          current.commits++;
        }
        current.calls.push({ guildId, jobId: options.jobId, applied, files });
        const state = deploymentStates[Math.min(deployments++, deploymentStates.length - 1)];
        const deployment = typeof state === 'string' ? { id: `dpl_fixture${deployments}`, state } : structuredClone(state);
        return { game: structuredClone(current.game), town: structuredClone(current.town), branch: 'latest-default',
          commit: applied ? null : `commit-${current.commits}`, deployment };
      } finally { release(); }
    },
    async deploymentStatus(id, branch) {
      current.statusCalls.push({ id, branch });
      return { id, state: 'READY' };
    },
  };
  return { publisher, current };
}

function guildFixture({ memberName = 'Server Nickname', channelNames = ['music', 'workshop'] } = {}) {
  const everyone = { id: GUILD };
  const guild = {
    id: GUILD, name: 'Server Name',
    roles: { everyone },
    channels: { fetch: async () => new Map(channelNames.map((name, index) => [String(index), {
      name, isThread: () => false, permissionsFor: (role) => {
        assert.equal(role, everyone);
        return { has: (flag) => { assert.equal(flag, 1024n); return true; } };
      },
    }])) },
    members: { fetch: async ({ user, force }) => {
      assert.equal(force, true);
      return { id: user, displayName: memberName, displayAvatarURL: (options) => {
        assert.deepEqual(options, { extension: 'png', size: 1024, forceStatic: true });
        return `https://cdn.discordapp.com/guilds/${GUILD}/users/${user}/avatars/avatar.png`;
      } };
    } },
  };
  return guild;
}

async function processorFixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mint-game-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const generated = { characters: [], towns: [], registered: [] };
  const fixture = options.publisherFixture || publisherFixture(options);
  const guild = options.guild || guildFixture();
  const process = createGameProcessor({
    publisher: fixture.publisher,
    generateCharacter: options.generateCharacter || (async (input) => { generated.characters.push(input); return Buffer.from('generated sprite'); }),
    generateTown: options.generateTown || (async (input) => {
      generated.towns.push(input);
      const document = structuredClone(input.town || town());
      const files = [];
      for (const building of document.buildings) {
        if (building.art) continue;
        building.art = `/games/${GUILD}/town/${building.id}.webp`;
        files.push({ path: `town/${building.id}.webp`, bytes: WEBP });
      }
      return { town: document, files };
    }),
    client: { guilds: { fetch: async (id) => { assert.equal(id, GUILD); return guild; } } },
    state: { registerGuild: (value) => { generated.registered.push(value); } },
    artifactDirectory: directory,
    baseUrl: 'https://game.example/',
    readAsset: options.readAsset || (async ({ assetPath }) => fixture.current.files.get(assetPath.slice(`/games/${GUILD}/`.length)) || null),
    verifyLiveTown: options.verifyLiveTown || (async () => false),
    validateTown: options.validateTown || (async ({ town: document, guildId }) => assertTown(document, guildId)),
    deploymentPollMs: 1,
    deploymentTimeoutMs: 50,
    ...options.processor,
  });
  return { ...fixture, process, generated, directory };
}

function job(type = 'add', extra = {}) {
  return { id: `job-${type}`, type, guildId: GUILD, memberId: type === 'add' ? MEMBER : null,
    requesterId: REQUESTER, channelId: CHANNEL, interactionId: '623456789012345678',
    payload: { guildName: 'Server Name' }, artifacts: {}, result: null, ...extra };
}

function checkpointFor(current, stages = []) {
  return (patch) => {
    if (patch.stage) { current.stage = patch.stage; stages.push(patch.stage); }
    if (patch.artifacts) Object.assign(current.artifacts, patch.artifacts);
    if (patch.result !== undefined) current.result = structuredClone(patch.result);
    return current;
  };
}

test('public channel inspiration checks @everyone only and never reads private names, threads, messages, or topics', async () => {
  const everyone = { id: GUILD };
  const visible = (name, allowed = true) => ({
    get name() { if (!allowed) assert.fail('Private names must not be read'); return name; },
    get topic() { assert.fail('Topics are outside town inspiration'); },
    get messages() { assert.fail('Messages are outside town inspiration'); },
    isThread: () => false,
    permissionsFor: (role) => { assert.equal(role, everyone); return { has: (flag) => { assert.equal(flag, 1024n); return allowed; } }; },
  });
  const thread = { isThread: () => true, permissionsFor: () => assert.fail('Threads are excluded before permission lookup') };
  const guild = {
    id: GUILD,
    roles: { everyone: null, fetch: async (id) => { assert.equal(id, GUILD); return everyone; } },
    channels: { fetch: async () => new Map([
      ['private', visible('secret', false)], ['music', visible(' music ')], ['duplicate', visible('music')],
      ['general', visible('general')], ['thread', thread], ['deleted', null],
    ]) },
  };
  assert.deepEqual(await publicChannelNames(guild), ['general', 'music']);
});

test('create publishes validated town, artwork and an empty roster using the server and public channel names', async (t) => {
  const fixture = await processorFixture(t);
  const current = job('create');
  const stages = [];
  const result = await fixture.process(current, { checkpoint: checkpointFor(current, stages) });
  assert.deepEqual(fixture.current.game.characters, []);
  assert.equal(fixture.current.game.name, 'Server Name');
  assert.equal(fixture.current.game.town.path, `/games/${GUILD}/town.json`);
  assert.equal(fixture.generated.towns[0].guildName, 'Server Name');
  assert.deepEqual(fixture.generated.towns[0].channelNames, ['music', 'workshop']);
  assert.equal(fixture.current.files.size, fixture.current.town.buildings.length);
  for (const building of fixture.current.town.buildings) {
    assert.match(building.art, /\.webp$/);
    assert.deepEqual(fixture.current.files.get(building.art.slice(`/games/${GUILD}/`.length)), WEBP);
  }
  assert.equal(fixture.generated.registered[0].gameUrl, result.url);
  assert.equal(result.deployment.state, 'READY');
  assert.match(result.url, new RegExp(`^https://game.example/server-name-${GUILD}$`));
  assert.equal(stages[0], 'preparing-artifacts');
  assert.ok(stages.indexOf('generating-town') < stages.indexOf('publishing-town'));
});

test('add defaults to the member server name and avatar while keeping description and uploaded reference options', async (t) => {
  const fixture = await processorFixture(t, { initialGame: game(), initialTown: town() });
  const current = job('add', { payload: { guildName: 'Server Name', description: 'A red coat', image: { url: 'https://cdn.discordapp.com/attachments/reference.png', size: 123 } } });
  const result = await fixture.process(current, { checkpoint: checkpointFor(current) });
  const input = fixture.generated.characters[0];
  assert.equal(input.name, 'Server Nickname');
  assert.equal(input.description, 'A red coat');
  assert.equal(input.references.length, 2);
  assert.match(input.references[0].url, new RegExp(`/users/${MEMBER}/`));
  assert.deepEqual(input.references[1], current.payload.image);
  assert.equal(result.characterName, 'Server Nickname');
  assert.equal(fixture.current.game.characters[0].discordUserId, MEMBER);
  assert.equal(fixture.current.game.characters[0].sprite, `/games/${GUILD}/${MEMBER}.png`);
});

test('add uses an explicit name and omits the avatar when use-pfp is false', async (t) => {
  const fixture = await processorFixture(t, { initialGame: game(), initialTown: town() });
  const current = job('add', { payload: { guildName: 'Server Name', name: 'Custom Name', description: 'Blue boots', usePfp: false } });
  await fixture.process(current, { checkpoint: checkpointFor(current) });
  assert.equal(fixture.generated.characters[0].name, 'Custom Name');
  assert.deepEqual(fixture.generated.characters[0].references, []);
});

test('existing characters check actual deployment and keep website-edited identity and sprite', async (t) => {
  const initial = game();
  initial.characters.push({ id: `discord-${MEMBER}`, name: 'Website Name', sprite: `/games/${GUILD}/${MEMBER}.png`, websiteField: 'keep' });
  const fixture = await processorFixture(t, { initialGame: initial, initialTown: town(), deploymentStates: ['PENDING'] });
  fixture.current.files.set(`${MEMBER}.png`, Buffer.from('website sprite'));
  const current = job();
  const result = await fixture.process(current, { checkpoint: checkpointFor(current) });
  assert.equal(fixture.current.calls.length, 1);
  assert.equal(fixture.current.statusCalls.length, 1);
  assert.equal(fixture.generated.characters.length, 0);
  assert.deepEqual(fixture.current.calls[0].files, []);
  assert.equal(fixture.current.files.get(`${MEMBER}.png`).toString(), 'website sprite');
  assert.equal(fixture.current.game.characters[0].websiteField, 'keep');
  assert.equal(result.characterName, 'Website Name');
  assert.equal(result.deployment.state, 'READY');
});

test('saved failed or missing-ID deployments resume through the publisher marker without generating again', async (t) => {
  for (const failedDeployment of [{ id: 'dpl_failed', state: 'FAILED' }, { id: null, state: 'PENDING' }]) {
    const initial = game();
    initial.characters.push({ id: `discord-${MEMBER}`, name: 'Preserved Character' });
    initial.botJobs = { 'job-add': true };
    const fixture = await processorFixture(t, { initialGame: initial, initialTown: town() });
    const current = job('add', { result: { publication: { game: initial, deployment: failedDeployment } } });
    const result = await fixture.process(current, { checkpoint: checkpointFor(current) });
    assert.equal(fixture.current.calls.length, 1);
    assert.equal(fixture.current.calls[0].applied, true);
    assert.equal(fixture.generated.characters.length, 0);
    assert.equal(result.characterName, 'Preserved Character');
    assert.equal(result.deployment.state, 'READY');
  }
});

test('interrupted publishing reloads saved character generation instead of charging another image generation', async (t) => {
  let publishing = 0;
  const fixture = await processorFixture(t, {
    initialGame: game(), initialTown: town(),
    beforePublish: async () => { if (++publishing === 1) throw new Error('Publish connection interrupted'); },
  });
  const current = job();
  await assert.rejects(fixture.process(current, { checkpoint: checkpointFor(current) }), /interrupted/);
  assert.equal(current.stage, 'publishing-character');
  assert.ok(current.artifacts.sprite.sha256);
  const result = await fixture.process(current, { checkpoint: checkpointFor(current) });
  assert.equal(fixture.generated.characters.length, 1);
  assert.equal(result.characterName, 'Server Nickname');
});

test('interrupted town publishing reloads saved town artwork and preserves later website additions', async (t) => {
  let publishing = 0;
  const fixture = await processorFixture(t, {
    beforePublish: async (current) => {
      if (++publishing === 1) throw new Error('Publish interrupted');
      current.game = { ...game(), characters: [{ id: 'website-friend', name: 'Website Friend' }], websiteOnly: 'keep' };
    },
  });
  const current = job('create');
  await assert.rejects(fixture.process(current, { checkpoint: checkpointFor(current) }), /interrupted/);
  const result = await fixture.process(current, { checkpoint: checkpointFor(current) });
  assert.equal(fixture.generated.towns.length, 1);
  assert.equal(fixture.current.game.websiteOnly, 'keep');
  assert.equal(fixture.current.game.characters[0].id, 'website-friend');
  assert.ok(fixture.current.town.buildings[0].art);
  assert.equal(result.deployment.state, 'READY');
});

test('a concurrently published website town suppresses stale generated building art', async (t) => {
  const editedTown = completeTown();
  editedTown.name = 'Website Town';
  const fixture = await processorFixture(t, {
    beforePublish: async (current) => {
      current.game = { ...game(), town: { path: `/games/${GUILD}/town.json` }, websiteOnly: 'preserve' };
      current.town = editedTown;
      for (const building of editedTown.buildings) current.files.set(building.art.slice(`/games/${GUILD}/`.length), WEBP);
    },
  });
  const current = job('create');
  await fixture.process(current, { checkpoint: checkpointFor(current) });
  assert.deepEqual(fixture.current.calls[0].files, []);
  assert.deepEqual(fixture.current.files.get('town/station-hall.webp'), WEBP);
  assert.equal(fixture.current.town.name, 'Website Town');
  assert.equal(fixture.current.game.websiteOnly, 'preserve');
});

test('a concurrently added website character suppresses stale generated sprite bytes', async (t) => {
  const fixture = await processorFixture(t, {
    initialGame: game(), initialTown: town(),
    beforePublish: async (current) => {
      current.game.characters.push({ id: `discord-${MEMBER}`, name: 'Website Edited', sprite: `/games/${GUILD}/${MEMBER}.png`, history: ['saved-version'] });
      current.files.set(`${MEMBER}.png`, Buffer.from('website sprite'));
    },
  });
  const current = job();
  const result = await fixture.process(current, { checkpoint: checkpointFor(current) });
  assert.deepEqual(fixture.current.calls[0].files, []);
  assert.equal(fixture.current.game.characters.length, 1);
  assert.deepEqual(fixture.current.game.characters[0].history, ['saved-version']);
  assert.equal(fixture.current.files.get(`${MEMBER}.png`).toString(), 'website sprite');
  assert.equal(result.characterName, 'Website Edited');
});

test('real queue runs two member generations in parallel and serialized publication preserves both and website fields', async (t) => {
  const gate = deferred();
  const started = [];
  const fixture = await processorFixture(t, {
    initialGame: game(), initialTown: { ...town(), websiteTownField: 'keep' },
    generateCharacter: async (input) => { started.push(input); await gate.promise; return Buffer.from('sprite'); },
    beforePublish: async (current) => {
      current.game.websiteSettings.weather = 'snow';
      if (!current.game.characters.some((item) => item.id === 'website-char')) current.game.characters.push({ id: 'website-char' });
    },
  });
  const queue = new JobQueue({ databasePath: path.join(fixture.directory, 'jobs.sqlite'), process: fixture.process, pollMs: 5, workers: 2 });
  t.after(async () => { gate.resolve(); await queue.stop(); queue.close(); });
  const enqueue = (memberId, interactionId) => queue.enqueue({ type: 'add', guildId: GUILD, memberId, requesterId: REQUESTER, channelId: CHANNEL,
    interactionId, payload: { guildName: 'Server Name' } }).job;
  const first = enqueue(MEMBER, '623456789012345678');
  const second = enqueue(OTHER, '723456789012345678');
  queue.start();
  await until(() => started.length === 2);
  gate.resolve();
  await until(() => [first, second].every((item) => queue.get(item.id).status === 'succeeded'));
  assert.deepEqual(new Set(fixture.current.game.characters.map((item) => item.id)), new Set(['website-char', `discord-${MEMBER}`, `discord-${OTHER}`]));
  assert.equal(fixture.current.game.websiteSettings.weather, 'snow');
  assert.equal(fixture.current.town.websiteTownField, 'keep');
  assert.equal(fixture.current.files.size, 2);
});

test('the 24-character limit is enforced again when concurrent jobs publish', async (t) => {
  const gate = deferred();
  let generated = 0;
  const initial = game();
  initial.characters = Array.from({ length: 23 }, (_, index) => ({ id: `website-${index}` }));
  const fixture = await processorFixture(t, { initialGame: initial, initialTown: town(),
    generateCharacter: async () => { generated++; await gate.promise; return Buffer.from('sprite'); },
  });
  const first = job('add', { id: 'first-add' });
  const second = job('add', { id: 'second-add', memberId: OTHER });
  const completions = [first, second].map((current) => fixture.process(current, { checkpoint: checkpointFor(current) }));
  await until(() => generated === 2);
  gate.resolve();
  const results = await Promise.allSettled(completions);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.match(results.find((item) => item.status === 'rejected').reason.message, /24 characters/);
  assert.equal(fixture.current.game.characters.length, 24);
});

test('cancellation reaches generation and preserves the checkpoint stage', async (t) => {
  const controller = new AbortController();
  let observed;
  const fixture = await processorFixture(t, { initialGame: game(), initialTown: town(),
    generateCharacter: async ({ signal }) => {
      observed = signal;
      controller.abort(new JobShutdownError());
      signal.throwIfAborted();
    },
  });
  const current = job();
  await assert.rejects(fixture.process(current, { checkpoint: checkpointFor(current), signal: controller.signal }), JobShutdownError);
  assert.equal(observed, controller.signal);
  assert.equal(current.stage, 'generating-character');
  assert.equal(fixture.current.calls.length, 0);
});

test('network failures retain the stage recorded before starting the request', async (t) => {
  const publishing = publisherFixture();
  publishing.publisher.snapshot = async () => { throw new Error('GitHub is unavailable'); };
  const fixture = await processorFixture(t, { publisherFixture: publishing });
  const current = job('create');
  await assert.rejects(fixture.process(current, { checkpoint: checkpointFor(current) }), /GitHub is unavailable/);
  assert.equal(current.stage, 'reading-latest-branch');
});

test('completion notices use normal channel messages and mention only the requester', async () => {
  let sent;
  const client = { channels: { fetch: async () => ({ guildId: GUILD, isTextBased: () => true, send: async (value) => { sent = value; return { id: 'message' }; } }) } };
  const notify = createJobNotifier(client);
  await notify({ ...job(), status: 'succeeded', result: { characterName: '@everyone', url: 'https://game.example/town' }, notification: { nonce: 'persistent-notice' } });
  assert.deepEqual(sent.allowedMentions, { parse: [], users: [REQUESTER], roles: [], repliedUser: false });
  assert.equal(sent.nonce, 'persistent-notice');
  assert.equal(sent.enforceNonce, true);
  assert.match(sent.content, new RegExp(`<@${REQUESTER}>`));
});

test('a fully verified live town returns its existing link and preserves every remote PNG without republishing', async (t) => {
  const document = completeTown('png');
  const initial = { ...game(), slug: 'keep-this-url', town: { path: `/games/${GUILD}/town.json` }, characters: [{ id: 'website-friend' }], history: ['keep'] };
  const reads = [];
  const fixture = await processorFixture(t, { initialGame: initial, initialTown: document,
    readAsset: async (input) => { reads.push(input); return PNG; },
    verifyLiveTown: async (input) => { assert.deepEqual(input.game, initial); assert.deepEqual(input.town, document); return true; },
  });
  const current = job('create', { result: { publication: { game: { ...initial, name: 'Obsolete cached name' }, deployment: { state: 'READY', id: 'dpl_old' } } } });
  const result = await fixture.process(current, { checkpoint: checkpointFor(current) });
  assert.equal(result.url, 'https://game.example/keep-this-url');
  assert.equal(result.gameName, initial.name);
  assert.equal(reads.length, document.buildings.length);
  assert.ok(reads.every((input) => input.head === 'a'.repeat(40)));
  assert.equal(fixture.generated.towns.length, 0);
  assert.equal(fixture.current.calls.length, 0);
  assert.deepEqual(fixture.current.game, initial);
  assert.deepEqual(fixture.current.town, document);
});

test('the same failed job with a committed marker and null result completes from fresh live files and notifies its owner', async (t) => {
  const ownerId = '573614648239194186';
  const document = completeTown();
  document.buildings.push({ id: 'archive-house', label: 'Archive House', kind: 'house', x: 80, y: 80, w: 100, h: 100,
    door: { x: 130, y: 220 }, art: `/games/${GUILD}/town/archive-house.webp` });
  const initial = { ...game(), town: { path: `/games/${GUILD}/town.json` }, studioMetadata: { revision: 9, history: ['retained-version'] } };
  const publishing = publisherFixture({ initialGame: initial, initialTown: document });
  const head = 'f'.repeat(40);
  publishing.current.head = head;
  let snapshots = 0;
  const snapshot = publishing.publisher.snapshot;
  publishing.publisher.snapshot = async (...args) => { snapshots++; return snapshot(...args); };
  const pinnedReads = [];
  const liveReads = [];
  const verifyLiveTown = createLiveTownVerifier({ baseUrl: 'https://game.example', fetch: async (url) => {
    liveReads.push(url.pathname);
    if (url.pathname.endsWith('/game.json')) return new Response(JSON.stringify(publishing.current.game));
    if (url.pathname.endsWith('/town.json')) return new Response(JSON.stringify(publishing.current.town));
    return new Response(WEBP);
  } });
  const fixture = await processorFixture(t, { publisherFixture: publishing, verifyLiveTown,
    readAsset: async (input) => { pinnedReads.push(input); return WEBP; },
  });
  const messages = [];
  const notify = createJobNotifier({ channels: { fetch: async (id) => {
    assert.equal(id, CHANNEL);
    return { guildId: GUILD, isTextBased: () => true, send: async (message) => {
      messages.push(message);
      return { id: `notification-${messages.length}` };
    } };
  } } });
  let recover = false;
  const queue = new JobQueue({ databasePath: path.join(fixture.directory, 'recovery.sqlite'), pollMs: 5,
    notify, process: async (current, context) => {
      if (!recover) {
        context.checkpoint({ stage: 'starting-deployment' });
        throw new Error('Vercel request failed (400).');
      }
      assert.equal(current.result, null);
      return fixture.process(current, context);
    },
  });
  t.after(async () => { await queue.stop(); queue.close(); });
  const { job: queuedJob } = queue.enqueue({ type: 'create', guildId: GUILD, requesterId: ownerId, channelId: CHANNEL,
    interactionId: '723456789012345678', payload: { guildName: 'Original Server Name' } });
  publishing.current.game.botJobs = { [queuedJob.id]: true };
  queue.start();
  await until(() => queue.get(queuedJob.id).status === 'failed');
  await queue.stop();
  assert.equal(queue.get(queuedJob.id).result, null);
  assert.equal(queue.get(queuedJob.id).stage, 'starting-deployment');
  recover = true;
  assert.equal(queue.resume(queuedJob.id).id, queuedJob.id);
  queue.start();
  await until(() => queue.get(queuedJob.id).status === 'succeeded' && queue.get(queuedJob.id).notification?.status === 'sent');
  const completed = queue.get(queuedJob.id);
  assert.equal(completed.attempts, 2);
  assert.equal(completed.requesterId, ownerId);
  assert.equal(completed.result.url, `https://game.example/${initial.slug}`);
  assert.equal(snapshots, 1);
  assert.equal(pinnedReads.length, 5);
  assert.ok(pinnedReads.every((input) => input.head === head));
  assert.equal(liveReads.length, 7, 'Live game, town, and all five WebP files are verified');
  assert.equal(fixture.generated.towns.length, 0);
  assert.equal(fixture.generated.characters.length, 0);
  assert.equal(publishing.current.calls.length, 0);
  assert.equal(publishing.current.statusCalls.length, 0);
  assert.equal(publishing.current.game.botJobs[queuedJob.id], true);
  assert.deepEqual(publishing.current.game.studioMetadata, initial.studioMetadata);
  const completion = messages.find((message) => message.content.includes('Your server’s town is ready'));
  assert.ok(completion);
  assert.match(completion.content, new RegExp(`<@${ownerId}>`));
  assert.match(completion.content, new RegExp(queuedJob.id));
  assert.deepEqual(completion.allowedMentions, { parse: [], users: [ownerId], roles: [], repliedUser: false });
  assert.equal(completion.enforceNonce, true);
});

test('a missing PNG asset is filled with its own WebP while other existing art, URL, layout and roster remain exact', async (t) => {
  const document = completeTown('png');
  const initial = { ...game(), slug: 'original-url', town: { path: `/games/${GUILD}/town.json` }, characters: [{ id: 'keep-roster' }] };
  const fixture = await processorFixture(t, { initialGame: initial, initialTown: document });
  for (const building of document.buildings.slice(1)) fixture.current.files.set(building.art.slice(`/games/${GUILD}/`.length), PNG);
  const current = job('create');
  const result = await fixture.process(current, { checkpoint: checkpointFor(current) });
  assert.equal(fixture.generated.towns.length, 1);
  const input = fixture.generated.towns[0].town;
  assert.equal(input.buildings[0].art, undefined);
  assert.equal(input.buildings[1].art, document.buildings[1].art);
  assert.equal(fixture.current.calls[0].files.length, 1);
  assert.equal(fixture.current.town.buildings[0].art, `/games/${GUILD}/town/station-hall.webp`);
  assert.deepEqual(fixture.current.town.buildings.slice(1), document.buildings.slice(1));
  assert.deepEqual(fixture.current.town.roads, document.roads);
  assert.deepEqual(fixture.current.town.characterSpawns, document.characterSpawns);
  assert.deepEqual(fixture.current.game.characters, initial.characters);
  assert.equal(fixture.current.game.slug, 'original-url');
  assert.equal(result.url, 'https://game.example/original-url');
  assert.equal((await decodeTownArtwork(fixture.current.files.get('town/station-hall.webp'))).format, 'webp');
});

test('an invalid existing image fails at art validation without erasing or replacing its art reference', async (t) => {
  const document = completeTown('png');
  const fixture = await processorFixture(t, { initialGame: game(), initialTown: document, readAsset: async () => Buffer.from('invalid image') });
  const current = job('create');
  await assert.rejects(fixture.process(current, { checkpoint: checkpointFor(current) }), /station-hall could not be decoded/);
  assert.equal(current.stage, 'validating-existing-art');
  assert.deepEqual(fixture.current.town, document);
  assert.equal(fixture.current.calls.length, 0);
  assert.equal(fixture.generated.towns.length, 0);
});

test('complete Git town art still checks the actual deployment when live verification fails', async (t) => {
  const document = completeTown('png');
  const fixture = await processorFixture(t, { initialGame: game(), initialTown: document, readAsset: async () => PNG, deploymentStates: ['PENDING'] });
  const current = job('create');
  await fixture.process(current, { checkpoint: checkpointFor(current) });
  assert.equal(fixture.generated.towns.length, 0);
  assert.equal(fixture.current.calls.length, 1);
  assert.deepEqual(fixture.current.calls[0].files, []);
  assert.equal(fixture.current.statusCalls.length, 1);
});

test('a concurrent website upload at the same previously missing URL suppresses obsolete generated bytes', async (t) => {
  const document = completeTown('png');
  const fixture = await processorFixture(t, { initialGame: game(), initialTown: document,
    beforePublish: async (current) => { current.files.set('town/station-hall.png', PNG); current.game.websiteSettings.weather = 'snow'; },
  });
  for (const building of document.buildings.slice(1)) fixture.current.files.set(building.art.slice(`/games/${GUILD}/`.length), PNG);
  const current = job('create');
  await fixture.process(current, { checkpoint: checkpointFor(current) });
  assert.equal(fixture.generated.towns.length, 1);
  assert.deepEqual(fixture.current.calls[0].files, []);
  assert.equal(fixture.current.town.buildings[0].art, document.buildings[0].art);
  assert.equal(fixture.current.files.has('town/station-hall.webp'), false);
  assert.equal(fixture.current.game.websiteSettings.weather, 'snow');
});

test('concurrent layout edits cause a safe retry while preserving all new website state', async (t) => {
  const document = completeTown('png');
  const fixture = await processorFixture(t, { initialGame: game(), initialTown: document,
    beforePublish: async (current) => { current.town.buildings[0].label = 'Website Rename'; current.game.characters.push({ id: 'new-website-character' }); },
  });
  for (const building of document.buildings.slice(1)) fixture.current.files.set(building.art.slice(`/games/${GUILD}/`.length), PNG);
  const current = job('create');
  await assert.rejects(fixture.process(current, { checkpoint: checkpointFor(current) }), /town changed while artwork/);
  assert.equal(fixture.current.town.buildings[0].label, 'Website Rename');
  assert.equal(fixture.current.town.buildings[0].art, document.buildings[0].art);
  assert.equal(fixture.current.game.characters.at(-1).id, 'new-website-character');
  assert.equal(fixture.current.files.has('town/station-hall.webp'), false);
  assert.ok(current.artifacts.files.some((file) => file.name === 'town/station-hall.webp'));
});

test('an unpublished legacy PNG is converted locally and reused while only missing buildings are generated', async (t) => {
  const fixture = await processorFixture(t);
  const current = job('create');
  const document = town();
  document.buildings[0].art = `/games/${GUILD}/town/legacy-hall.png`;
  const directory = path.join(fixture.directory, current.id);
  await mkdir(path.join(directory, 'town'), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(document));
  await writeFile(path.join(directory, 'town.json'), bytes);
  await writeFile(path.join(directory, 'town/legacy-hall.png'), PNG);
  const artifact = (name, content) => ({ name, size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  current.artifacts = { town: artifact('town.json', bytes), files: [artifact('town/legacy-hall.png', PNG)] };
  await fixture.process(current, { checkpoint: checkpointFor(current) });
  assert.equal(fixture.generated.towns[0].town.buildings[0].art, `/games/${GUILD}/town/legacy-hall.webp`);
  assert.equal(fixture.current.calls[0].files.length, document.buildings.length);
  assert.equal(fixture.current.files.has('town/legacy-hall.png'), false);
  assert.equal((await decodeTownArtwork(fixture.current.files.get('town/legacy-hall.webp'))).format, 'webp');
  assert.deepEqual(fixture.current.town.roads, document.roads);
});

test('an old partial-town job marker cannot suppress the new missing-art repair', async (t) => {
  const initial = { ...game(), botJobs: { 'job-create': true } };
  const fixture = await processorFixture(t, { initialGame: initial, initialTown: town() });
  const current = job('create');
  await fixture.process(current, { checkpoint: checkpointFor(current) });
  assert.match(fixture.current.calls[0].jobId, /^job-create-art-[a-f0-9]{12}$/);
  assert.equal(fixture.current.calls[0].applied, false);
  assert.equal(fixture.current.calls[0].files.length, fixture.current.town.buildings.length);
  assert.equal(fixture.current.game.botJobs['job-create'], true);
  assert.ok(fixture.current.town.buildings.every((building) => building.art.endsWith('.webp')));
});

test('converted legacy art stays durable when native generation writes a partial town and fails before publication', async (t) => {
  const nativeCalls = new Map();
  let failOnce = true;
  const generator = createTownGenerator({
    buildingWorkers: 2,
    validate: async ({ town: document, guildId }) => assertTown(document, guildId),
    runnerFactory: ({ workdir }) => ({
      async run() {
        const buildingId = path.basename(workdir);
        nativeCalls.set(buildingId, (nativeCalls.get(buildingId) || 0) + 1);
        if (buildingId === 'vinyl-exchange' && failOnce) { failOnce = false; return { status: 'failed' }; }
        await writeFile(path.join(workdir, 'native-output.png'), NATIVE_PNG);
        return { status: 'completed' };
      },
      async shutdown() {},
    }),
  });
  const fixture = await processorFixture(t, { generateTown: generator });
  const current = job('create');
  const document = town();
  document.buildings[0].art = `/games/${GUILD}/town/legacy-hall.png`;
  const directory = path.join(fixture.directory, current.id);
  await mkdir(path.join(directory, 'town'), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(document));
  await writeFile(path.join(directory, 'town.json'), bytes);
  await writeFile(path.join(directory, 'town/legacy-hall.png'), PNG);
  const artifact = (name, content) => ({ name, size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  current.artifacts = { town: artifact('town.json', bytes), files: [artifact('town/legacy-hall.png', PNG)] };
  await assert.rejects(fixture.process(current, { checkpoint: checkpointFor(current) }), /Codex did not finish/);
  assert.equal(current.artifacts.town.name, 'town-source.json');
  const source = await readFile(path.join(directory, current.artifacts.town.name));
  assert.equal(createHash('sha256').update(source).digest('hex'), current.artifacts.town.sha256);
  const converted = await readFile(path.join(directory, 'town/legacy-hall.webp'));
  assert.equal((await decodeTownArtwork(converted)).format, 'webp');
  assert.ok(current.artifacts.files.some((file) => file.name === 'town/legacy-hall.webp'));
  const partial = JSON.parse(await readFile(path.join(directory, 'town.json'), 'utf8'));
  assert.equal(partial.buildings[0].art, `/games/${GUILD}/town/legacy-hall.webp`);
  assert.notDeepEqual(partial, JSON.parse(source));
  assert.equal(fixture.current.calls.length, 0);
  await fixture.process(current, { checkpoint: checkpointFor(current) });
  assert.equal(nativeCalls.get('station-hall') || 0, 0, 'The original hall is never sent to native generation again');
  assert.equal(nativeCalls.get('vinyl-exchange'), 2, 'Only the failed building is retried');
  assert.equal(nativeCalls.get('cliphouse'), 1);
  assert.equal(nativeCalls.get('maker-depot'), 1);
  assert.equal(fixture.current.files.size, document.buildings.length);
  assert.deepEqual(fixture.current.files.get('town/legacy-hall.webp'), converted);
  assert.deepEqual(fixture.current.town.roads, document.roads);
  assert.equal(fixture.current.town.buildings[0].art, `/games/${GUILD}/town/legacy-hall.webp`);
});

test('town asset reads pin the Git head and reject external, cross-guild, traversal and unpinned requests before fetching', async () => {
  const requests = [];
  const read = createTownAssetReader({ repository: 'owner/game', fetch: async (url, options) => {
    requests.push({ url, options });
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  } });
  const input = { guildId: GUILD, assetPath: `/games/${GUILD}/town/hall.png`, head: 'a'.repeat(40) };
  assert.deepEqual(await read(input), PNG);
  assert.equal(requests[0].url, `https://raw.githubusercontent.com/owner/game/${input.head}/public/games/${GUILD}/town/hall.png`);
  assert.equal(requests[0].options.redirect, 'error');
  for (const assetPath of ['https://other.example/art.webp', `/games/${MEMBER}/town/hall.png`, `/games/${GUILD}/town/../secret.png`]) {
    await assert.rejects(read({ ...input, assetPath }), /artwork/);
  }
  await assert.rejects(read({ ...input, head: 'main' }), /pinned/);
  assert.equal(requests.length, 1);
});

test('town asset reads distinguish a missing file from a failed or oversized fetch', async () => {
  const input = { guildId: GUILD, assetPath: `/games/${GUILD}/town/hall.png`, head: 'a'.repeat(40) };
  const missing = createTownAssetReader({ repository: 'owner/game', fetch: async () => new Response(null, { status: 404 }) });
  assert.equal(await missing(input), null);
  const failed = createTownAssetReader({ repository: 'owner/game', fetch: async () => new Response(null, { status: 403 }) });
  await assert.rejects(failed(input), /failed \(403\)/);
  const oversized = createTownAssetReader({ repository: 'owner/game', fetch: async () => new Response(PNG, { headers: { 'content-length': '2000001' } }) });
  await assert.rejects(oversized(input), /too large/);
});

test('live verification requires matching documents and decodable art at the trusted game origin', async () => {
  const document = completeTown('png');
  const initial = game();
  const requests = [];
  let missing = false;
  const verify = createLiveTownVerifier({ baseUrl: 'https://game.example', fetch: async (url, options) => {
    requests.push(url.href);
    assert.equal(options.redirect, 'error');
    if (url.pathname.endsWith('game.json')) return new Response(JSON.stringify(initial));
    if (url.pathname.endsWith('town.json')) return new Response(JSON.stringify(document));
    return missing ? new Response(null, { status: 404 }) : new Response(PNG);
  } });
  assert.equal(await verify({ guildId: GUILD, game: initial, town: document }), true);
  assert.ok(requests.every((url) => url.startsWith(`https://game.example/games/${GUILD}/`)));
  missing = true;
  assert.equal(await verify({ guildId: GUILD, game: initial, town: document }), false);
});

test('the processor runs the supplied shared town validator before its publish callback can commit', async (t) => {
  let validations = 0;
  const fixture = await processorFixture(t, { validateTown: async (input) => { validations++; return validateTownFile(input); } });
  const current = job('create');
  await fixture.process(current, { checkpoint: checkpointFor(current) });
  assert.equal(validations, 2);
  assert.equal(fixture.current.commits, 1);
});
