import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { createTownGenerator } from "../src/rpg/town-generator.mjs";
import { assertTown } from "../src/rpg/town-validation.mjs";
import { prepareBuildingImage, runNativeTask } from "../src/rpg/building-artwork.mjs";

const guildA = "111111111111111111";
const guildB = "222222222222222222";
const template = JSON.parse(await readFile(new URL("../src/rpg/contracts/sample-town.json", import.meta.url), "utf8"));

function townFor(guildId) {
  return { ...structuredClone(template), guildId, name: `Fixture ${guildId.slice(0, 4)}` };
}

function withoutArt(town) {
  return { ...town, buildings: town.buildings.map(({ art, ...building }) => building) };
}

async function image(kind = "visible") {
  const bytes = Buffer.alloc(64 * 48 * 4);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    const offset = (y * 64 + x) * 4;
    bytes[offset] = 90;
    bytes[offset + 1] = 145;
    bytes[offset + 2] = 180;
    bytes[offset + 3] = kind === "opaque" || (kind === "visible" && x >= 8 && x < 56 && y >= 8 && y < 40) ? 255 : 0;
  }
  return sharp(bytes, { raw: { width: 64, height: 48, channels: 4 } }).png().toBuffer();
}

async function fixture(t, { failBuilding, failAfterWrite = false, invalidImage, buildingWorkers = 2 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rpg-building-art-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reference = path.join(directory, "style-reference.webp");
  await writeFile(reference, await sharp(await image()).webp().toBuffer());
  const calls = [];
  const counts = new Map();
  const validations = [];
  let active = 0;
  let maximum = 0;
  const runnerFactory = options => {
    const prompt = options.promptForTask();
    const building = options.workdir.includes(`${path.sep}.building-jobs${path.sep}`);
    const id = building ? path.basename(options.workdir) : null;
    return {
      async run() {
        calls.push({ id, options, prompt });
        if (!building) {
          const guildId = /"guildId":"(\d{17,20})"/.exec(prompt)[1];
          const town = townFor(guildId);
          await writeFile(path.join(options.workdir, "town-plan.output.json"), JSON.stringify({
            version: 1, town,
            buildings: town.buildings.map(item => ({ id: item.id, description: `A purpose-specific ${item.label} facade with a distinct roof and three bold props.` })),
          }));
          return { status: "completed" };
        }
        counts.set(id, (counts.get(id) ?? 0) + 1);
        active++;
        maximum = Math.max(maximum, active);
        try {
          await delay(12);
          if (id === failBuilding && counts.get(id) === 1 && !failAfterWrite) return { status: "failed" };
          await writeFile(path.join(options.workdir, "native-output.png"), await image(id === invalidImage ? "transparent" : "visible"));
          if (id === failBuilding && counts.get(id) === 1 && failAfterWrite) return { status: "failed" };
          return { status: "completed" };
        } finally { active--; }
      },
      async shutdown() {},
    };
  };
  const validate = async options => {
    validations.push(options);
    return assertTown(options.town, options.guildId);
  };
  const generator = createTownGenerator({
    runnerFactory, buildingWorkers, referencePaths: [reference], validate,
    codexEnv: { CODEX_HOME: "/fixture/saved-chatgpt-login", OPENAI_API_KEY: "fixture-provider-key", CODEX_API_KEY: "fixture-codex-key" },
  });
  return {
    directory, calls, counts, validations, reference, runnerFactory, validate, generator,
    get maximum() { return maximum; },
    input(guildId = guildA) { return { guildId, guildName: "Fixture town", channelNames: ["music", "makers"], directory: path.join(directory, guildId) }; },
  };
}

test("town planning is separate and every building gets an individual native artwork task", async t => {
  const f = await fixture(t);
  const progress = [];
  const input = f.input();
  const result = await f.generator({ ...input, onProgress: entry => progress.push(entry) });
  assert.equal(f.calls.filter(call => call.id === null).length, 1);
  assert.equal(f.calls.filter(call => call.id !== null).length, result.town.buildings.length);
  assert.equal(result.files.length, result.town.buildings.length);
  assert.deepEqual(withoutArt(result.town), townFor(guildA));
  assert.ok(result.town.buildings.every(building => building.art === `/games/${guildA}/town/${building.id}.webp`));
  assert.equal(new Set(result.files.map(file => file.path)).size, result.files.length);
  for (const file of result.files) {
    const metadata = await sharp(file.bytes).metadata();
    const stats = await sharp(file.bytes).stats();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.hasAlpha, true);
    assert.equal(stats.channels.at(-1).min, 0);
    assert.ok(stats.channels.at(-1).max > 0);
    assert.deepEqual(await readFile(path.join(input.directory, file.path)), file.bytes);
  }
  assert.ok(progress.some(entry => entry.stage === "planning-town"));
  assert.equal(progress.filter(entry => entry.stage === "building-ready").length, result.files.length);
  assert.deepEqual(progress.at(-1), { stage: "town-ready", completed: result.files.length, total: result.files.length });
  const manifest = JSON.parse(await readFile(path.join(input.directory, ".building-art.json"), "utf8"));
  assert.equal(Object.keys(manifest.entries).length, result.files.length);
  assert.ok(Object.values(manifest.entries).every(entry => /^[a-f0-9]{64}$/.test(entry.signature) && /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.ok(f.validations.every(options => options.guildId === guildA && options.directory === input.directory));
});

test("building worker limit applies across two simultaneously generated towns", async t => {
  const f = await fixture(t, { buildingWorkers: 2 });
  const [first, second] = await Promise.all([f.generator(f.input()), f.generator(f.input(guildB))]);
  assert.equal(f.maximum, 2);
  assert.equal(first.files.length, first.town.buildings.length);
  assert.equal(second.files.length, second.town.buildings.length);
});

test("cached planning output containing art is replanned using the same layout-only rule", async t => {
  const f = await fixture(t);
  const input = f.input();
  const invalid = townFor(guildA);
  invalid.buildings[0].art = `/games/${guildA}/town/incorrect-planning-art.png`;
  await mkdir(input.directory, { recursive: true });
  await writeFile(path.join(input.directory, "town-plan.output.json"), JSON.stringify({
    version: 1, town: invalid,
    buildings: invalid.buildings.map(building => ({ id: building.id, description: "Fixture description" })),
  }));
  const result = await f.generator(input);
  assert.equal(f.calls.filter(call => call.id === null).length, 1);
  assert.equal(result.files.length, invalid.buildings.length);
  assert.ok([...f.counts.values()].every(count => count === 1));
});

test("style references, matte paper constraints and no-lettering instructions reach every native building runner", async t => {
  const f = await fixture(t);
  await f.generator(f.input());
  for (const call of f.calls.filter(call => call.id !== null)) {
    assert.match(call.prompt, /one call.*image_gen__imagegen.*transparent_background:true/);
    assert.match(call.prompt, /STYLE references only/);
    assert.match(call.prompt, /South Park-style paper-cutout/);
    assert.match(call.prompt, /matte flat colors/);
    assert.match(call.prompt, /faint paper texture/);
    assert.match(call.prompt, /No sky.*text, numbers, lettering/);
    assert.match(call.prompt, /no photorealism, 3D render/);
    assert.match(call.prompt, /purpose.*distinctive roof/);
    assert.ok(call.options.extraArgs.includes("--image"));
    assert.equal(call.options.env.OPENAI_API_KEY, undefined);
    assert.equal(call.options.env.CODEX_API_KEY, undefined);
    assert.equal(call.options.env.CODEX_HOME, "/fixture/saved-chatgpt-login");
    assert.equal((await sharp(await readFile(path.join(call.options.workdir, "style-1.webp"))).metadata()).format, "webp");
  }
  assert.match(f.calls.find(call => call.id === null).prompt, /Do not call image generation in this planning phase/);
});

test("a failed building retries independently while finished artifacts and the layout are reused after restart", async t => {
  const failedId = template.buildings[1].id;
  const f = await fixture(t, { failBuilding: failedId });
  const input = f.input();
  await assert.rejects(() => f.generator(input), /Codex did not finish/);
  const restart = createTownGenerator({ runnerFactory: f.runnerFactory, referencePaths: [f.reference], validate: f.validate });
  const progress = [];
  const result = await restart({ ...input, onProgress: entry => progress.push(entry) });
  assert.equal(f.calls.filter(call => call.id === null).length, 1);
  for (const building of result.town.buildings) assert.equal(f.counts.get(building.id), building.id === failedId ? 2 : 1);
  assert.equal(progress.filter(entry => entry.stage === "building-ready").length, result.files.length);
  assert.deepEqual(withoutArt(result.town), townFor(guildA));
});

test("native output saved before a failed runner response is recovered without another image call", async t => {
  const f = await fixture(t, { failBuilding: template.buildings[0].id, failAfterWrite: true });
  const input = f.input();
  await assert.rejects(() => f.generator(input));
  const result = await f.generator(input);
  assert.equal(result.files.length, result.town.buildings.length);
  assert.ok([...f.counts.values()].every(count => count === 1));
});

test("existing remote PNG and WebP art and every layout field are preserved", async t => {
  const f = await fixture(t);
  const town = townFor(guildA);
  town.buildings[0].art = `/games/${guildA}/town/existing-hall.png`;
  town.buildings[1].art = `/games/${guildA}/town/existing-vinyl.webp`;
  const before = structuredClone(town);
  const result = await f.generator({ ...f.input(), town });
  assert.deepEqual(town, before);
  assert.deepEqual(withoutArt(result.town), withoutArt(before));
  assert.equal(result.town.buildings[0].art, before.buildings[0].art);
  assert.equal(result.town.buildings[1].art, before.buildings[1].art);
  assert.equal(f.calls.filter(call => call.id === null).length, 0);
  assert.deepEqual(result.files.map(file => file.path), town.buildings.slice(2).map(building => `town/${building.id}.webp`));
  assert.equal(f.counts.has(town.buildings[0].id), false);
  assert.equal(f.counts.has(town.buildings[1].id), false);
});

test("legacy cached local PNG art is converted and resumed without replanning or regenerating it", async t => {
  const f = await fixture(t);
  const input = f.input();
  const town = townFor(guildA);
  town.buildings[0].art = `/games/${guildA}/town/legacy-hall.png`;
  await mkdir(path.join(input.directory, "town"), { recursive: true });
  await writeFile(path.join(input.directory, "town.json"), JSON.stringify(town));
  await writeFile(path.join(input.directory, "town", "legacy-hall.png"), await image());
  const result = await f.generator(input);
  assert.equal(f.calls.filter(call => call.id === null).length, 0);
  assert.equal(f.counts.has(town.buildings[0].id), false);
  assert.equal(result.town.buildings[0].art, `/games/${guildA}/town/${town.buildings[0].id}.webp`);
  assert.deepEqual(withoutArt(result.town), withoutArt(town));
  assert.equal(result.files.length, town.buildings.length);
});

test("a damaged generated WebP can be restored from its saved native PNG without another image call", async t => {
  const f = await fixture(t);
  const input = f.input();
  const result = await f.generator(input);
  await writeFile(path.join(input.directory, result.files[0].path), Buffer.from("corrupt fixture"));
  const repaired = await f.generator(input);
  assert.ok([...f.counts.values()].every(count => count === 1));
  assert.equal((await sharp(repaired.files[0].bytes).metadata()).format, "webp");
});

test("opaque, invisible and undecodable building images are rejected", async () => {
  await assert.rejects(async () => prepareBuildingImage(await image("opaque")), /transparent background/);
  await assert.rejects(async () => prepareBuildingImage(await image("transparent")), /visible facade/);
  await assert.rejects(() => prepareBuildingImage(Buffer.from("invalid fixture image")));
});

test("symlinked job parents are rejected before any native runner is started", async t => {
  const f = await fixture(t);
  const outside = path.join(f.directory, "outside");
  await mkdir(outside);
  const linked = path.join(f.directory, "linked");
  await symlink(outside, linked, "dir");
  await assert.rejects(() => f.generator({ ...f.input(), directory: path.join(linked, "job") }), /symbolic links/);
  assert.equal(f.calls.length, 0);
});

test("aborting a building task removes queued work and awaits native runner shutdown", async t => {
  const f = await fixture(t);
  let started;
  const buildingStarted = new Promise(resolve => { started = resolve; });
  let shutdownFinished = false;
  let buildingCalls = 0;
  const generator = createTownGenerator({
    validate: f.validate, buildingWorkers: 1,
    runnerFactory: options => {
      if (!options.workdir.includes(`${path.sep}.building-jobs${path.sep}`)) return f.runnerFactory(options);
      let finish;
      return {
        run() {
          buildingCalls++;
          started();
          return new Promise(resolve => { finish = resolve; });
        },
        async shutdown() {
          await delay(25);
          shutdownFinished = true;
          finish({ status: "cancelled" });
        },
      };
    },
  });
  const controller = new AbortController();
  const generation = generator({ ...f.input(), signal: controller.signal });
  await buildingStarted;
  controller.abort();
  await assert.rejects(() => generation, error => error.name === "AbortError");
  assert.equal(buildingCalls, 1);
  assert.equal(shutdownFinished, true);
});

test("a failed native runner is shut down before its error returns", async () => {
  let stopped = false;
  await assert.rejects(() => runNativeTask({
    run: async () => ({ status: "failed" }),
    shutdown: async () => { await delay(15); stopped = true; },
  }, "Fixture native failure"), /Codex did not finish/);
  assert.equal(stopped, true);
});

test("cancellation preserves the original abort reason when native shutdown rejects", async () => {
  const controller = new AbortController();
  const reason = new Error("Fixture lease was lost");
  let finish;
  let shutdownCalls = 0;
  const task = runNativeTask({
    run: () => new Promise(resolve => { finish = resolve; }),
    shutdown: async () => {
      shutdownCalls++;
      finish({ status: "cancelled" });
      throw new Error("Fixture could not confirm shutdown");
    },
  }, "Fixture cancellation", controller.signal);
  controller.abort(reason);
  await assert.rejects(() => task, error => error === reason);
  assert.equal(shutdownCalls, 1);
});
