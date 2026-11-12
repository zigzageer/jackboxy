import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { assertTown } from '../src/rpg/town-validation.mjs';
import { createTownGenerator } from '../src/rpg/town-generator.mjs';
import { createUbuntuGameHandler } from '../src/rpg/ubuntu-adapter.mjs';
import { syncGameCommands, serverGameDefinitions } from '../src/rpg/registration.mjs';
import { publicChannelNames } from '../src/rpg/game-jobs.mjs';

const GUILD = '123456789012345678';
const OTHER_GUILD = '223456789012345678';
const sample = JSON.parse(await readFile(new URL('../src/rpg/contracts/sample-town.json', import.meta.url), 'utf8'));
const freshTown = () => structuredClone(sample);

test('the published town sample passes schema, geometry and walking connectivity checks', () => {
  const town = freshTown();
  assert.equal(assertTown(town, GUILD), town);
  assert.equal(town.name, 'Signal Yard');
  assert.ok(town.buildings.length >= 2);
  assert.ok(town.characterSpawns.length > 0);
});

test('town validation rejects private asset paths, cross-guild art and extra fields', () => {
  for (const asset of ['/etc/private.png', 'file:///private.png', `/games/${GUILD}/town/../private.png`, `/games/${OTHER_GUILD}/town/hall.png`]) {
    const town = freshTown();
    town.buildings[0].art = asset;
    assert.throws(() => assertTown(town, GUILD), /asset path|artwork/);
  }
  const extraRoot = freshTown();
  extraRoot.privateChannelNames = ['private-planning'];
  assert.throws(() => assertTown(extraRoot, GUILD), /Unexpected field/);
  const extraPoint = freshTown();
  extraPoint.spawn.secret = 'private metadata';
  assert.throws(() => assertTown(extraPoint, GUILD), /Unexpected field/);
  assert.throws(() => assertTown(freshTown(), OTHER_GUILD), /different server/);
});

test('town validation rejects fractional coordinates, overlapping buildings and out-of-bounds geometry', () => {
  const fractional = freshTown();
  fractional.spawn.x += 0.5;
  assert.throws(() => assertTown(fractional, GUILD), /integer/);
  const overlapping = freshTown();
  overlapping.buildings[1] = { ...overlapping.buildings[1], ...overlapping.buildings[0], id: 'different-id' };
  assert.throws(() => assertTown(overlapping, GUILD), /separate footprints/);
  const outside = freshTown();
  outside.roads[0].w = outside.width + 1;
  assert.throws(() => assertTown(outside, GUILD), /inside the world/);
});

test('town validation rejects disconnected doors and landmarks behind a world-spanning building', () => {
  const town = freshTown();
  town.spawn = { x: 800, y: 300 };
  town.buildings = [
    { id: 'wall-hall', label: 'Wall Hall', kind: 'hall', x: 0, y: 500, w: town.width, h: 48, door: { x: 800, y: 580 } },
    { id: 'upper-shop', label: 'Upper Shop', kind: 'shop', x: 100, y: 100, w: 100, h: 100, door: { x: 150, y: 232 } },
  ];
  town.landmarks = [{ id: 'lower-plaza', label: 'Lower Plaza', kind: 'plaza', x: 800, y: 800 }];
  town.characterSpawns = [{ x: 800, y: 300 }];
  assert.throws(() => assertTown(town, GUILD), /reachable/);
});

test('town inspiration reads only channel names visible to @everyone and excludes threads and messages', async () => {
  const everyone = { id: GUILD };
  const channel = (name, visible, thread = false) => ({
    name,
    isThread: () => thread,
    permissionsFor: (role) => ({ has: (permission) => { assert.equal(role, everyone); assert.equal(permission, 1024n); return visible; } }),
    get messages() { assert.fail('Message contents must not be read for town inspiration'); },
  });
  const guild = {
    id: GUILD,
    roles: { everyone },
    channels: { fetch: async () => new Map([
      ['public', channel('music', true)],
      ['private', channel('private-planning', false)],
      ['thread', channel('private-thread', true, true)],
      ['duplicate', channel('music', true)],
      ['second', channel('art', true)],
      ['missing', null],
    ]) },
  };
  assert.deepEqual(await publicChannelNames(guild), ['art', 'music']);
});

async function generationFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mint-rpg-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) {
    if (x < 8 && y < 8) continue;
    const offset = (y * 16 + x) * 4;
    pixels.set([70, 130, 180, 255], offset);
  }
  const png = await sharp(pixels, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
  const town = freshTown();
  town.buildings[0].art = `/games/${GUILD}/town/signature-hall.png`;
  return { root, directory: path.join(root, 'generated'), png, town };
}

test('native town generation passes only the saved login environment and validates generated transparent PNG assets', async (t) => {
  const fixture = await generationFixture(t);
  let calls = 0;
  const generate = createTownGenerator({
    codexEnv: { CODEX_HOME: '/saved/codex', CODEX_ENABLED: 'true', OPENAI_API_KEY: 'unused-provider-key', CODEX_API_KEY: 'unused-codex-key' },
    runnerFactory: (options) => {
      assert.equal(options.env.CODEX_HOME, '/saved/codex');
      assert.equal(options.env.OPENAI_API_KEY, undefined);
      assert.equal(options.env.CODEX_API_KEY, undefined);
      assert.equal(options.workdir, fixture.directory);
      assert.match(options.promptForTask(), /image_gen__imagegen/);
      assert.match(options.promptForTask(), /transparent_background:true/);
      assert.match(options.promptForTask(), /"channelNames":\["music","art"\]/);
      assert.doesNotMatch(options.promptForTask(), /private-planning/);
      return {
        run: async (_task, { userId }) => {
          calls++;
          assert.match(userId, /^\d{17,20}$/);
          const schema = JSON.parse(await readFile(path.join(options.workdir, 'town-v1.schema.json'), 'utf8'));
          assert.equal(schema.title, 'Grapevine server town v1');
          await mkdir(path.join(options.workdir, 'town'));
          await writeFile(path.join(options.workdir, 'town/signature-hall.png'), fixture.png);
          await writeFile(path.join(options.workdir, 'town.json'), JSON.stringify(fixture.town));
          return { status: 'completed' };
        },
        shutdown: async () => {},
      };
    },
  });
  const output = await generate({ guildId: GUILD, guildName: 'Signal Crew', channelNames: ['music', 'art'], directory: fixture.directory });
  assert.equal(calls, 1);
  assert.equal(output.files.length, 1);
  assert.equal(output.files[0].path, 'town/signature-hall.png');
  assert.equal((await sharp(output.files[0].bytes).metadata()).format, 'png');
  assert.equal((await sharp(output.files[0].bytes).stats()).isOpaque, false);
  assertTown(output.town, GUILD);
});

test('town generation rejects opaque artwork and a failed native generation result', async (t) => {
  for (const mode of ['opaque', 'failed']) {
    const fixture = await generationFixture(t);
    const generate = createTownGenerator({ runnerFactory: (options) => ({
      run: async () => {
        if (mode === 'failed') return { status: 'failed' };
        await mkdir(path.join(options.workdir, 'town'));
        const opaque = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } }).png().toBuffer();
        await writeFile(path.join(options.workdir, 'town/signature-hall.png'), opaque);
        await writeFile(path.join(options.workdir, 'town.json'), JSON.stringify(fixture.town));
        return { status: 'completed' };
      },
      shutdown: async () => {},
    }) });
    await assert.rejects(generate({ guildId: GUILD, guildName: 'Signal Crew', channelNames: [], directory: fixture.directory }), mode === 'opaque' ? /transparent/ : /could not finish/);
  }
});

test('town generation refuses PNGs reached through a symlinked artifact directory', async (t) => {
  const fixture = await generationFixture(t);
  const outside = path.join(fixture.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'signature-hall.png'), fixture.png);
  const generate = createTownGenerator({ runnerFactory: (options) => ({
    run: async () => {
      await symlink(outside, path.join(options.workdir, 'town'), 'dir');
      await writeFile(path.join(options.workdir, 'town.json'), JSON.stringify(fixture.town));
      return { status: 'completed' };
    },
    shutdown: async () => {},
  }) });
  await assert.rejects(generate({ guildId: GUILD, guildName: 'Signal Crew', channelNames: [], directory: fixture.directory }), /image|artifact|directory|outside|symlink/i);
});

function interaction(events, overrides = {}) {
  const request = {
    id: '323456789012345678', guildId: GUILD, commandName: 'game', deferred: false, replied: false,
    client: { fixture: true },
    async deferReply(payload) { events.push('defer'); assert.equal(payload.flags, 64); request.deferred = true; },
    async editReply(payload) { events.push('edit'); request.lastReply = payload; },
    ...overrides,
  };
  return request;
}

test('the Ubuntu adapter acknowledges before configuration and catches asynchronous command errors', async () => {
  const events = [];
  const errors = [];
  const request = interaction(events);
  const handler = createUbuntuGameHandler({
    ownerId: '423456789012345678', env: { GAME_ALLOWED_USER_IDS: '523456789012345678', PRIVATE_SECRET: 'fixture-secret-value' },
    logger: { error: (...values) => errors.push(values) },
    configure: (env, { client }) => {
      events.push('configure');
      assert.equal(client, request.client);
      assert.equal(env.GAME_ALLOWED_USER_IDS, '523456789012345678,423456789012345678');
      return {
        start() { events.push('start'); },
        async handle() { events.push('handle'); throw new Error('fixture-secret-value command failed'); },
      };
    },
  });
  assert.equal(await handler(request), true);
  assert.deepEqual(events, ['defer', 'configure', 'start', 'handle', 'edit']);
  assert.match(request.lastReply.content, /323456789012345678.*failed at command validation/);
  assert.doesNotMatch(JSON.stringify({ reply: request.lastReply, errors }), /fixture-secret-value/);
  assert.deepEqual(request.lastReply.allowedMentions, { parse: [] });
});

test('the Ubuntu adapter reports setup failures after acknowledging and resumes workers with the startup client', async () => {
  const setupEvents = [];
  const setupRequest = interaction(setupEvents);
  const broken = createUbuntuGameHandler({ configure: () => { setupEvents.push('configure'); throw new Error('SQLite unavailable'); }, logger: { error() {} } });
  await broken(setupRequest);
  assert.deepEqual(setupEvents, ['defer', 'configure', 'edit']);
  assert.match(setupRequest.lastReply.content, /SQLite unavailable/);

  const client = { ready: true };
  let initialized = 0;
  let started = 0;
  let stopped = 0;
  const handler = createUbuntuGameHandler({ configure: (_env, options) => {
    initialized++;
    assert.equal(options.client, client);
    return { start() { started++; }, async stop() { stopped++; }, async handle() { return true; } };
  } });
  handler.start(client);
  await handler(interaction([], { client }));
  await handler.stop();
  assert.equal(initialized, 1);
  assert.equal(started, 2);
  assert.equal(stopped, 1);
});

test('command registration additively upserts global and newly joined guild definitions', async () => {
  assert.deepEqual(serverGameDefinitions.map((definition) => definition.name), ['game', 'fight', 'war']);
  const game = serverGameDefinitions.find((definition) => definition.name === 'game');
  const fight = serverGameDefinitions.find((definition) => definition.name === 'fight');
  assert.deepEqual(game.options.map((option) => option.name), ['create', 'add', 'status', 'link']);
  assert.deepEqual(fight.options.map((option) => option.name), ['challenge', 'ability', 'attack', 'status']);
  const global = new Map([['unrelated', { name: 'unrelated', description: 'Keep me' }]]);
  const guild = new Map([['unrelated', { name: 'unrelated', description: 'Keep me too' }]]);
  const globalCalls = [];
  const guildCalls = [];
  const client = { application: { commands: { create: async (definition) => { globalCalls.push(definition); global.set(definition.name, definition); } } } };
  const joinedGuild = { commands: { create: async (definition) => { guildCalls.push(definition); guild.set(definition.name, definition); } } };
  await syncGameCommands(client);
  await syncGameCommands(client, joinedGuild);
  assert.equal(global.has('unrelated'), true);
  assert.equal(guild.has('unrelated'), true);
  assert.deepEqual(globalCalls.map((definition) => definition.name), ['game', 'fight', 'war']);
  assert.deepEqual(guildCalls.map((definition) => definition.name), ['game', 'fight', 'war']);
  for (const definition of globalCalls) {
    assert.deepEqual(definition.contexts, [0]);
    assert.deepEqual(definition.integration_types, [0]);
    assert.equal(definition.dm_permission, false);
  }
  for (const definition of guildCalls) {
    assert.equal('contexts' in definition, false);
    assert.equal('integration_types' in definition, false);
    assert.equal('dm_permission' in definition, false);
    assert.equal(definition.default_member_permissions, null);
  }
});
