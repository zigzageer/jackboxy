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
  return { root, directory: path.join(root, 'generated'), png, town: freshTown() };
}

function nativeFixtureRunner(fixture, calls, { image = fixture.png, failImage = false, inspect = () => {} } = {}) {
  return (options) => {
    const planning = options.workdir === fixture.directory;
    calls.push({ options, planning });
    inspect(options, planning);
    return {
      run: async (_task, { userId }) => {
        assert.match(userId, /^\d{17,20}$/);
        if (planning) {
          const schema = JSON.parse(await readFile(path.join(options.workdir, 'town-v1.schema.json'), 'utf8'));
          assert.equal(schema.title, 'Grapevine server town v1');
          const plan = {
            version: 1,
            town: structuredClone(fixture.town),
            buildings: fixture.town.buildings.map((building) => ({ id: building.id, description: `A distinct ${building.kind} for ${building.id} with purpose-specific props.` })),
          };
          await writeFile(path.join(options.workdir, 'town-plan.output.json'), JSON.stringify(plan));
        } else {
          if (failImage) return { status: 'failed' };
          await writeFile(path.join(options.workdir, 'native-output.png'), image);
        }
        return { status: 'completed' };
      },
      shutdown: async () => {},
    };
  };
}

const validateFixture = async ({ town, guildId }) => assertTown(town, guildId);

test('native town generation plans once and produces transparent WebP artwork for each building using only the saved login', async (t) => {
  const fixture = await generationFixture(t);
  const calls = [];
  const progress = [];
  const generate = createTownGenerator({
    codexEnv: { CODEX_HOME: '/saved/codex', CODEX_ENABLED: 'true', OPENAI_API_KEY: 'unused-provider-key', CODEX_API_KEY: 'unused-codex-key' },
    validate: validateFixture,
    runnerFactory: nativeFixtureRunner(fixture, calls, { inspect: (options, planning) => {
      assert.equal(options.env.CODEX_HOME, '/saved/codex');
      assert.equal(options.env.OPENAI_API_KEY, undefined);
      assert.equal(options.env.CODEX_API_KEY, undefined);
      const prompt = options.promptForTask();
      assert.doesNotMatch(prompt, /private-planning/);
      if (planning) {
        assert.match(prompt, /planning phase only/);
        assert.match(prompt, /"channelNames":\["music","art"\]/);
        assert.doesNotMatch(prompt, /image_gen__imagegen/);
      } else {
        assert.equal(path.dirname(options.workdir), path.join(fixture.directory, '.building-jobs'));
        const buildingId = path.basename(options.workdir);
        assert.ok(fixture.town.buildings.some((building) => building.id === buildingId));
        assert.match(prompt, /image_gen__imagegen/);
        assert.match(prompt, /transparent_background:true/);
        assert.match(prompt, /straight-on orthographic/);
        assert.match(prompt, /no photorealism, 3D render/);
        assert.ok(prompt.includes(`purpose-specific props.`));
        assert.ok(prompt.includes(JSON.stringify(buildingId)));
      }
    } }),
  });
  const output = await generate({ guildId: GUILD, guildName: 'Signal Crew', channelNames: ['music', 'art'], directory: fixture.directory, onProgress: async (event) => progress.push(event) });
  assert.equal(calls.filter((call) => call.planning).length, 1);
  assert.equal(calls.filter((call) => !call.planning).length, fixture.town.buildings.length);
  assert.equal(output.files.length, fixture.town.buildings.length);
  assert.deepEqual(output.files.map((file) => file.path), fixture.town.buildings.map((building) => `town/${building.id}.webp`));
  for (const file of output.files) {
    assert.equal((await sharp(file.bytes).metadata()).format, 'webp');
    assert.equal((await sharp(file.bytes).stats()).isOpaque, false);
  }
  assert.equal(progress.filter((event) => event.stage === 'building-ready').length, fixture.town.buildings.length);
  assert.equal(progress.at(-1).stage, 'town-ready');
  assertTown(output.town, GUILD);
});

test('town generation reuses complete building caches and repairs a damaged WebP from the saved native image', async (t) => {
  const fixture = await generationFixture(t);
  const calls = [];
  const generate = createTownGenerator({ validate: validateFixture, runnerFactory: nativeFixtureRunner(fixture, calls) });
  const request = { guildId: GUILD, guildName: 'Signal Crew', channelNames: ['music'], directory: fixture.directory };
  const first = await generate(request);
  const nativeCalls = calls.length;
  const repeated = await generate(request);
  assert.equal(calls.length, nativeCalls);
  assert.deepEqual(repeated.town, first.town);
  const damaged = first.files[0].path;
  await writeFile(path.join(fixture.directory, damaged), Buffer.from('damaged WebP'));
  const repaired = await generate(request);
  assert.equal(calls.length, nativeCalls);
  const repairedFile = repaired.files.find((file) => file.path === damaged);
  assert.equal((await sharp(repairedFile.bytes).metadata()).format, 'webp');
  assert.equal((await sharp(repairedFile.bytes).stats()).isOpaque, false);
});

test('a rejected planning output containing artwork is replanned on retry', async (t) => {
  const fixture = await generationFixture(t);
  await mkdir(path.join(fixture.directory, 'town'), { recursive: true });
  const rejectedTown = structuredClone(fixture.town);
  rejectedTown.buildings[0].art = `/games/${GUILD}/town/station-hall.png`;
  await writeFile(path.join(fixture.directory, 'town/station-hall.png'), fixture.png);
  await writeFile(path.join(fixture.directory, 'town-plan.output.json'), JSON.stringify({
    version: 1,
    town: rejectedTown,
    buildings: rejectedTown.buildings.map((building) => ({ id: building.id, description: 'A prior rejected planning entry.' })),
  }));
  const calls = [];
  const generate = createTownGenerator({ validate: validateFixture, runnerFactory: nativeFixtureRunner(fixture, calls) });
  await generate({ guildId: GUILD, guildName: 'Signal Crew', channelNames: [], directory: fixture.directory });
  assert.equal(calls.filter((call) => call.planning).length, 1);
  assert.equal(calls.filter((call) => !call.planning).length, fixture.town.buildings.length);
});

test('per-building town generation rejects opaque artwork and a failed native image result', async (t) => {
  for (const mode of ['opaque', 'failed']) {
    const fixture = await generationFixture(t);
    const opaque = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const generate = createTownGenerator({
      validate: validateFixture,
      runnerFactory: nativeFixtureRunner(fixture, [], { image: opaque, failImage: mode === 'failed' }),
    });
    await assert.rejects(generate({ guildId: GUILD, guildName: 'Signal Crew', channelNames: [], directory: fixture.directory }), mode === 'opaque' ? /transparent/ : /did not finish/);
  }
});

test('cached town generation refuses images reached through a symlinked artifact directory', async (t) => {
  const fixture = await generationFixture(t);
  const outside = path.join(fixture.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'signature-hall.png'), fixture.png);
  await mkdir(fixture.directory);
  await symlink(outside, path.join(fixture.directory, 'town'), 'dir');
  const town = structuredClone(fixture.town);
  town.buildings[0].art = `/games/${GUILD}/town/signature-hall.png`;
  await writeFile(path.join(fixture.directory, 'town.json'), JSON.stringify(town));
  const generate = createTownGenerator({ validate: validateFixture, runnerFactory: nativeFixtureRunner(fixture, []) });
  await assert.rejects(generate({ guildId: GUILD, guildName: 'Signal Crew', channelNames: [], directory: fixture.directory }), /image|artifact|directory|symbolic|symlink/i);
  assert.deepEqual(await readFile(path.join(outside, 'signature-hall.png')), fixture.png);
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
