import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGameProcessor, createJobNotifier, publicChannelNames } from '../src/rpg/game-jobs.mjs';
import { JobQueue, JobShutdownError } from '../src/rpg/job-queue.mjs';

const GUILD = '123456789012345678';
const MEMBER = '223456789012345678';
const OTHER = '323456789012345678';
const REQUESTER = '423456789012345678';
const CHANNEL = '523456789012345678';
const SAMPLE = JSON.parse(await readFile(new URL('../src/rpg/contracts/sample-town.json', import.meta.url), 'utf8'));
const game = () => ({ version: 1, guildId: GUILD, slug: `fixture-${GUILD}`, name: 'Fixture Town', characters: [], websiteSettings: { weather: 'rain' } });
const town = () => structuredClone(SAMPLE);

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
  const current = { game: initialGame, town: initialTown, files: new Map(), calls: [], statusCalls: [], commits: 0 };
  let publicationTail = Promise.resolve();
  let deployments = 0;
  const publisher = {
    async snapshot() { return structuredClone({ game: current.game, town: current.town, branch: 'latest-default' }); },
    async publish(guildId, change, options) {
      const previous = publicationTail;
      let release;
      publicationTail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        if (beforePublish) await beforePublish(current, options);
        const applied = Boolean(current.game?.botJobs?.[options.jobId]);
        let files = [];
        if (!applied) {
          const changed = await change(structuredClone({ game: current.game, town: current.town }));
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
      const document = town();
      document.buildings[0].art = `/games/${GUILD}/town/hall.png`;
      return { town: document, files: [{ path: 'town/hall.png', bytes: Buffer.from('generated town art') }] };
    }),
    client: { guilds: { fetch: async (id) => { assert.equal(id, GUILD); return guild; } } },
    state: { registerGuild: (value) => { generated.registered.push(value); } },
    artifactDirectory: directory,
    baseUrl: 'https://game.example/',
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
  assert.equal(fixture.current.files.get('town/hall.png').toString(), 'generated town art');
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
  const editedTown = town();
  editedTown.name = 'Website Town';
  const fixture = await processorFixture(t, {
    beforePublish: async (current) => {
      current.game = { ...game(), town: { path: `/games/${GUILD}/town.json` }, websiteOnly: 'preserve' };
      current.town = editedTown;
      current.files.set('town/hall.png', Buffer.from('website artwork'));
    },
  });
  const current = job('create');
  await fixture.process(current, { checkpoint: checkpointFor(current) });
  assert.deepEqual(fixture.current.calls[0].files, []);
  assert.equal(fixture.current.files.get('town/hall.png').toString(), 'website artwork');
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
