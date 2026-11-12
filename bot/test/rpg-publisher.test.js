import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { BundlePublisher } from "../src/rpg/bundle-publisher.mjs";
import { CodexGameStore, createConnectedGameTask, GamePublishError } from "../src/rpg/codex-store.mjs";
import { createCodexRunner, CODEX_OWNER_ID } from "../src/rpg/codex-runner.mjs";

const exec = promisify(execFile);
const GUILD = "123456789012345678";
const OTHER_GUILD = "223456789012345678";
const HEAD = "a".repeat(40);
const TREE = "b".repeat(40);
const COMMIT = "c".repeat(40);
const game = (guildId = GUILD) => ({ version: 1, guildId, name: "Town", slug: `town-${guildId}`, characters: [] });
const town = () => ({ version: 1, guildId: GUILD, landmarks: [] });
const object = (value) => ({ structuredContent: value });
const raw = (value) => object({ content: JSON.stringify(value) });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture({ initialGame = null, initialTown = null, beforePublish, deploymentState = "READY" } = {}) {
  const state = { game: initialGame, town: initialTown, head: HEAD, tree: TREE, calls: [], commits: 0 };
  const task = async (job, binaryInput) => {
    state.calls.push({ job: structuredClone(job), binaryInput });
    if (job.task === "snapshot") return {
      status: "snapshot", head: state.head, tree: state.tree, branch: "latest-default",
      gameJson: state.game === null ? null : JSON.stringify(state.game),
      townJson: state.town === null ? null : JSON.stringify(state.town),
    };
    if (job.task === "publish") {
      if (beforePublish) {
        const response = await beforePublish(job, state);
        if (response) return response;
      }
      assert.equal(job.expectedHead, state.head);
      assert.equal(job.baseTree, state.tree);
      state.game = structuredClone(job.game);
      state.town = structuredClone(job.town);
      state.head = COMMIT;
      state.commits++;
    }
    return { status: "published", commit: COMMIT, deploymentId: "dpl_fixture", deploymentState };
  };
  const publisher = new BundlePublisher({ repository: "owner/game", task });
  return { publisher, state, task };
}

test("town, empty roster and artwork share one latest-default transaction", async () => {
  const { publisher, state } = fixture();
  const art = Buffer.from("fixture PNG bytes");
  const result = await publisher.publish(GUILD, () => ({ game: game(), town: town() }), {
    jobId: "job-create",
    files: [{ path: "art/landmark.png", bytes: art }],
  });
  assert.deepEqual(result.game.characters, []);
  assert.equal(result.game.botJobs["job-create"], true);
  assert.equal(result.deployment.state, "READY");
  const publish = state.calls.find(({ job }) => job.task === "publish");
  assert.equal(publish.job.branch, "latest-default");
  assert.equal(publish.job.manifestPath, `public/games/${GUILD}/game.json`);
  assert.equal(publish.job.townPath, `public/games/${GUILD}/town.json`);
  assert.equal(publish.job.binaryFiles[0].path, `public/games/${GUILD}/art/landmark.png`);
  assert.deepEqual(publish.binaryInput[0].bytes, art);
  assert.equal(state.commits, 1);
});

test("CAS conflict re-runs the update against website changes and completed characters", async () => {
  let conflicted = false;
  const { publisher, state } = fixture({
    initialGame: { ...game(), websiteSetting: { weather: "rain" } }, initialTown: town(),
    beforePublish: async (_job, current) => {
      if (conflicted) return;
      conflicted = true;
      current.game.characters.push({ id: "website-member", name: "Website edit" });
      current.game.websiteSetting.weather = "snow";
      current.town.landmarks.push({ id: "website-landmark" });
      current.head = "d".repeat(40);
      current.tree = "e".repeat(40);
      return { status: "conflict" };
    },
  });
  await publisher.publish(GUILD, ({ game: current, town: currentTown }) => ({
    game: { ...current, characters: [...current.characters, { id: "discord-member" }] },
    town: currentTown,
  }), { jobId: "job-add" });
  assert.deepEqual(state.game.characters.map((character) => character.id), ["website-member", "discord-member"]);
  assert.equal(state.game.websiteSetting.weather, "snow");
  assert.equal(state.town.landmarks[0].id, "website-landmark");
  assert.equal(state.calls.filter(({ job }) => job.task === "snapshot").length, 2);
});

test("a deployment retry preserves newer edits and skips the applied mutation and assets", async () => {
  const { publisher, state } = fixture({ deploymentState: "FAILED" });
  const first = await publisher.publish(GUILD, () => ({ game: game(), town: town() }), { jobId: "job-resume" });
  assert.equal(first.deployment.state, "FAILED");
  state.game.characters.push({ id: "website-newer" });
  const resumed = await publisher.publish(GUILD, () => assert.fail("Applied update must not run twice"), {
    jobId: "job-resume", files: [{ path: "unused.png", bytes: Buffer.from("unused") }],
  });
  assert.equal(resumed.alreadyApplied, true);
  assert.equal(resumed.game.characters[0].id, "website-newer");
  assert.equal(state.commits, 1);
  assert.equal(state.calls.at(-1).job.task, "deploy");
  assert.deepEqual(state.calls.at(-1).binaryInput, []);
});

test("a character added through the website keeps its edited sprite when the callback suppresses generated files", async () => {
  const memberId = "discord-323456789012345678";
  const existing = {
    ...game(),
    characters: [{ id: memberId, name: "Website-edited member", sprite: `/games/${GUILD}/323456789012345678.png` }],
  };
  const { publisher, state } = fixture({ initialGame: existing, initialTown: town() });
  await publisher.publish(GUILD, ({ game: current, town: currentTown }) => {
    assert.equal(current.characters[0].id, memberId);
    return { game: current, town: currentTown, files: [] };
  }, {
    jobId: "job-same-member",
    files: [{ path: "323456789012345678.png", bytes: Buffer.from("obsolete generated sprite") }],
  });
  const published = state.calls.find(({ job }) => job.task === "publish");
  assert.deepEqual(published.job.binaryFiles, []);
  assert.deepEqual(published.binaryInput, []);
  assert.deepEqual(state.game.characters, existing.characters);
});

test("callback files are re-evaluated after a CAS conflict to preserve concurrently published town artwork", async () => {
  const websiteTown = { ...town(), landmarks: [{ id: "market", sprite: `/games/${GUILD}/town/market.png` }] };
  let conflicted = false;
  const { publisher, state } = fixture({
    initialGame: game(),
    beforePublish: async (_job, current) => {
      if (conflicted) return;
      conflicted = true;
      current.town = structuredClone(websiteTown);
      current.head = "d".repeat(40);
      current.tree = "e".repeat(40);
      return { status: "conflict" };
    },
  });
  await publisher.publish(GUILD, ({ game: current, town: currentTown }) => currentTown
    ? { game: current, town: currentTown, files: [] }
    : { game: current, town: town() }, {
    jobId: "job-concurrent-town",
    files: [{ path: "town/market.png", bytes: Buffer.from("obsolete generated landmark") }],
  });
  const publications = state.calls.filter(({ job }) => job.task === "publish");
  assert.equal(publications.length, 2);
  assert.equal(publications[0].job.binaryFiles.length, 1);
  assert.deepEqual(publications[1].job.binaryFiles, []);
  assert.deepEqual(publications[1].binaryInput, []);
  assert.deepEqual(state.town, websiteTown);
});

test("a lost result reconciles an acknowledged remote commit before retrying deployment", async () => {
  const { state, task } = fixture();
  let lost = false;
  const publisher = new BundlePublisher({
    repository: "owner/game",
    task: async (job, bytes) => {
      const result = await task(job, bytes);
      if (job.task === "publish" && !lost) {
        lost = true;
        state.game.characters.push({ id: "concurrent-website-edit" });
        throw new Error("Worker connection lost after ref update");
      }
      return result;
    },
  });
  const result = await publisher.publish(GUILD, () => ({ game: game(), town: town() }), { jobId: "job-lost" });
  assert.equal(state.commits, 1);
  assert.equal(result.game.characters[0].id, "concurrent-website-edit");
  assert.equal(result.commit, COMMIT);
  assert.equal(state.calls.at(-1).job.task, "deploy");
});

test("publishing is serialized across publisher instances and guilds", async () => {
  let active = 0;
  let maxActive = 0;
  const create = (guildId) => {
    const { task } = fixture();
    return new BundlePublisher({ repository: "owner/game", task: async (job, bytes) => {
      if (job.task !== "publish") return task(job, bytes);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const result = await task(job, bytes);
      active--;
      return result;
    } });
  };
  await Promise.all([GUILD, OTHER_GUILD].map((guildId) => create(guildId).publish(
    guildId, () => ({ game: game(guildId), town: null }), { jobId: `job-${guildId}` },
  )));
  assert.equal(maxActive, 1);
});

test("deployment polling inspects the existing build and preserves pending state", async () => {
  const { publisher, state } = fixture({ deploymentState: "PENDING" });
  assert.deepEqual(await publisher.deploymentStatus("dpl_fixture"), { id: "dpl_fixture", state: "PENDING" });
  assert.equal(state.calls[0].job.task, "deployment-status");
  assert.equal(state.calls[0].job.deploymentId, "dpl_fixture");
});

test("cross-directory paths, duplicate files, invalid branches and cross-guild manifests are rejected", async () => {
  const { publisher, state } = fixture();
  for (const filePath of ["../index.js", "/absolute.png", "art/../outside.png", "art//image.png", "game.json", "town.json"])
    await assert.rejects(publisher.publish(GUILD, () => ({ game: game(), town: town() }), {
      jobId: "job-invalid", files: [{ path: filePath, content: "invalid" }],
    }), /paths/);
  assert.equal(state.calls.length, 0);
  assert.throws(() => new BundlePublisher({ repository: "owner/game", branch: "../main" }), /branch/);
  await assert.rejects(publisher.publish(GUILD, () => ({ game: game(OTHER_GUILD), town: null }), { jobId: "job-wrong-guild" }), /manifest/);
});

function scriptRunner(toolsForJob, inspect = () => {}) {
  return (options) => ({ run: async () => {
    inspect(options);
    const job = JSON.parse(await readFile(path.join(options.workdir, "job.json"), "utf8"));
    const script = await readFile(path.join(options.workdir, "task.js"), "utf8");
    const tools = {
      exec_command: async ({ cmd, workdir }) => {
        const { stdout } = await exec("/bin/sh", ["-c", cmd], { cwd: workdir, maxBuffer: 400_000 });
        return { output: stdout, exit_code: 0 };
      },
      ...toolsForJob(job),
    };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction("tools", "text", script)(tools, () => {});
    return { status: "completed" };
  } });
}

test("connected snapshot resolves the default branch and pins town and roster reads to one head", async () => {
  const paths = [];
  const task = createConnectedGameTask({
    codexEnv: { OPENAI_API_KEY: "fixture", CODEX_API_KEY: "fixture" },
    runnerFactory: scriptRunner(() => ({
      mcp__codex_apps__github_fetch: async ({ url }) => raw(
        url.endsWith("/owner/game") ? { default_branch: "latest-default" }
          : url.includes("/git/commits/") ? { tree: { sha: TREE } } : { object: { sha: HEAD } },
      ),
      mcp__codex_apps__github_fetch_file: async ({ path: filePath, ref }) => {
        assert.equal(ref, HEAD);
        paths.push(filePath);
        return object({ content: JSON.stringify(filePath.endsWith("town.json") ? town() : game()) });
      },
    }), (options) => {
      assert.equal(options.autoReview, false);
      assert.equal(options.env.OPENAI_API_KEY, undefined);
      assert.equal(options.env.CODEX_API_KEY, undefined);
    }),
  });
  const result = await task({ task: "snapshot", repository: "owner/game", manifestPath: `public/games/${GUILD}/game.json`, townPath: `public/games/${GUILD}/town.json` });
  assert.equal(result.branch, "latest-default");
  assert.deepEqual(JSON.parse(result.townJson), town());
  assert.deepEqual(paths, [`public/games/${GUILD}/game.json`, `public/games/${GUILD}/town.json`]);
});

test("connected publishing writes roster, town and exact binary artwork in one CAS commit", async () => {
  const artwork = Buffer.from(Array.from({ length: 90_001 }, (_, index) => index % 256));
  let treeRequest;
  let blobRequest;
  let commits = 0;
  const task = createConnectedGameTask({ runnerFactory: scriptRunner(() => ({
    mcp__codex_apps__github_create_blob: async (request) => { blobRequest = request; return object({ sha: "image-blob" }); },
    mcp__codex_apps__github_create_tree: async (request) => { treeRequest = request; return object({ sha: TREE }); },
    mcp__codex_apps__github_create_commit: async (request) => { commits++; assert.equal(request.parent_sha, HEAD); return object({ sha: COMMIT }); },
    mcp__codex_apps__github_update_ref: async (request) => { assert.equal(request.expected_sha, HEAD); assert.equal(request.force, false); return object({}); },
    mcp__codex_apps__vercel_create_deployment: async ({ requestBody }) => {
      assert.equal(Object.hasOwn(requestBody, "withLatestCommit"), false);
      assert.deepEqual(requestBody.gitSource, { type: "github", repoId: 1, ref: "main" });
      return object({ id: "dpl_fixture", readyState: "READY" });
    },
  })) });
  const result = await task({
    task: "publish", repository: "owner/game", branch: "main", expectedHead: HEAD, baseTree: TREE,
    manifestPath: `public/games/${GUILD}/game.json`, townPath: `public/games/${GUILD}/town.json`,
    game: game(), town: town(), vercel: { repositoryId: 1 },
    binaryFiles: [{ path: `public/games/${GUILD}/art/building.png`, localName: "asset-0.bin", size: artwork.length }],
  }, [{ localName: "asset-0.bin", bytes: artwork }]);
  assert.equal(commits, 1);
  assert.equal(treeRequest.base_tree_sha, TREE);
  assert.deepEqual(treeRequest.tree_elements.map((file) => file.path), [
    `public/games/${GUILD}/game.json`, `public/games/${GUILD}/town.json`, `public/games/${GUILD}/art/building.png`,
  ]);
  assert.deepEqual(Buffer.from(blobRequest.content, "base64"), artwork);
  assert.equal(result.deploymentState, "READY");
});

test("deployment-only retries create a new build from gitSource without redeployment-only flags", async () => {
  let deploymentCalls = 0;
  const task = createConnectedGameTask({ runnerFactory: scriptRunner(() => ({
    mcp__codex_apps__vercel_create_deployment: async ({ requestBody }) => {
      deploymentCalls++;
      assert.equal(Object.hasOwn(requestBody, "withLatestCommit"), false);
      assert.equal(Object.hasOwn(requestBody, "deploymentId"), false);
      assert.deepEqual(requestBody.gitSource, { type: "github", repoId: 1, ref: "main" });
      assert.equal(requestBody.target, "production");
      return object({ id: "dpl_fixture", readyState: "READY" });
    },
  })) });
  const result = await task({ task: "deploy", repository: "owner/game", branch: "main", vercel: { repositoryId: 1 } });
  assert.equal(deploymentCalls, 1);
  assert.equal(result.status, "published");
  assert.equal(result.deploymentState, "READY");
  assert.equal(result.commit, null);
});

test("connected snapshots and conflict reconciliation preserve branch slashes in GitHub ref paths", async () => {
  const refs = [];
  const branch = "codex/browser-game-controls";
  const task = createConnectedGameTask({ runnerFactory: scriptRunner(() => ({
    mcp__codex_apps__github_fetch: async ({ url }) => {
      if (url.includes("/git/commits/")) return raw({ tree: { sha: TREE } });
      refs.push(url);
      assert.equal(url, "https://api.github.com/repos/owner/game/git/ref/heads/codex/browser-game-controls");
      return raw({ object: { sha: refs.length === 1 ? HEAD : "d".repeat(40) } });
    },
    mcp__codex_apps__github_fetch_file: async () => object({ content: JSON.stringify(game()) }),
    mcp__codex_apps__github_create_tree: async () => object({ sha: TREE }),
    mcp__codex_apps__github_create_commit: async () => object({ sha: COMMIT }),
    mcp__codex_apps__github_update_ref: async () => { throw new Error("Concurrent branch update"); },
  })) });
  const snapshot = await task({ task: "snapshot", repository: "owner/game", branch, manifestPath: `public/games/${GUILD}/game.json` });
  assert.equal(snapshot.status, "snapshot");
  assert.equal(snapshot.branch, branch);
  const publication = await task({
    task: "publish", repository: "owner/game", branch,
    manifestPath: `public/games/${GUILD}/game.json`, game: game(), expectedHead: HEAD, baseTree: TREE,
  });
  assert.equal(publication.status, "conflict");
  assert.equal(refs.length, 2);
});

test("legacy roster store still accepts its original task response and sprite API", async () => {
  const original = { ...game(), characters: [{ id: "existing" }] };
  const store = new CodexGameStore({ repository: "owner/game", task: async (job, sprite) => {
    if (job.task === "snapshot") return { status: "snapshot", head: HEAD, tree: TREE, gameJson: JSON.stringify(original) };
    assert.deepEqual(sprite, Buffer.from("legacy"));
    assert.equal(job.sprite.path, `public/games/${GUILD}/323456789012345678.png`);
    return { status: "published", commit: COMMIT, deploymentId: "dpl_fixture", deploymentState: "READY" };
  } });
  const result = await store.update(GUILD, (current) => ({ ...current, characters: [...current.characters, { id: "new" }] }), {
    sprite: { userId: "323456789012345678", bytes: Buffer.from("legacy") },
  });
  assert.deepEqual(result.game.characters.map((character) => character.id), ["existing", "new"]);
});

test("connected-task cancellation stops Codex before cleaning its workspace and returns the original reason", async () => {
  const controller = new AbortController();
  const reason = new Error("Worker shutdown requested");
  const running = deferred();
  const finish = deferred();
  const stopGate = deferred();
  let directory;
  let shutdownCalls = 0;
  let settled = false;
  const task = createConnectedGameTask({ runnerFactory: (options) => {
    directory = options.workdir;
    return {
      run: async () => { running.resolve(); return finish.promise; },
      shutdown: async () => {
        shutdownCalls++;
        await stopGate.promise;
        await access(directory);
        finish.resolve({ status: "cancelled" });
      },
    };
  } });
  const pending = task({ task: "publish", repository: "owner/game" }, undefined, { signal: controller.signal });
  pending.then(() => { settled = true; }, () => { settled = true; });
  await running.promise;
  controller.abort(reason);
  const rejected = assert.rejects(pending, (error) => error === reason);
  await new Promise(setImmediate);
  assert.equal(shutdownCalls, 1);
  assert.equal(settled, false);
  await access(directory);
  stopGate.resolve();
  await rejected;
  await assert.rejects(access(directory), { code: "ENOENT" });
  assert.equal(shutdownCalls, 1);
});

test("an already aborted connected task never creates a runner", async () => {
  const controller = new AbortController();
  const reason = new Error("Already stopping");
  controller.abort(reason);
  const task = createConnectedGameTask({ runnerFactory: () => assert.fail("An aborted task must not start Codex") });
  await assert.rejects(task({}, undefined, { signal: controller.signal }), (error) => error === reason);
});

test("an unconfirmed Codex shutdown retains its workspace and preserves the abort reason", async (t) => {
  const controller = new AbortController();
  const reason = new Error("Worker stopping");
  const running = deferred();
  const finish = deferred();
  let directory;
  const task = createConnectedGameTask({ runnerFactory: (options) => {
    directory = options.workdir;
    t.after(() => rm(directory, { recursive: true, force: true }));
    return {
      run: async () => { running.resolve(); return finish.promise; },
      shutdown: async () => {
        finish.resolve({ status: "cancelled" });
        throw new Error("Could not confirm Codex stopped");
      },
    };
  } });
  const pending = task({}, undefined, { signal: controller.signal });
  await running.promise;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  await access(directory);
});

test("an aborted mutex waiter cannot release the active publisher or let later jobs bypass it", async () => {
  const firstGate = deferred();
  const firstStarted = deferred();
  const first = fixture();
  const third = fixture();
  let thirdEntered = false;
  const firstPublisher = new BundlePublisher({ repository: "owner/game", task: async (job, bytes, options) => {
    if (job.task === "publish") { firstStarted.resolve(); await firstGate.promise; }
    return first.task(job, bytes, options);
  } });
  const secondPublisher = new BundlePublisher({ repository: "owner/game", task: () => assert.fail("Aborted mutex waiter must never reach remote operations") });
  const thirdPublisher = new BundlePublisher({ repository: "owner/game", task: (...args) => {
    thirdEntered = true;
    return third.task(...args);
  } });
  const firstJob = firstPublisher.publish(GUILD, () => ({ game: game(), town: town() }), { jobId: "job-mutex-first" });
  await firstStarted.promise;
  const controller = new AbortController();
  const reason = new Error("Waiting publisher cancelled");
  const secondJob = secondPublisher.publish(OTHER_GUILD, () => assert.fail("Aborted callback"), { jobId: "job-mutex-aborted", signal: controller.signal });
  const rejected = assert.rejects(secondJob, (error) => error === reason);
  controller.abort(reason);
  await rejected;
  const thirdJob = thirdPublisher.publish(OTHER_GUILD, () => ({ game: game(OTHER_GUILD), town: null }), { jobId: "job-mutex-third" });
  await new Promise(setImmediate);
  assert.equal(thirdEntered, false);
  firstGate.resolve();
  await Promise.all([firstJob, thirdJob]);
  assert.equal(thirdEntered, true);
});

test("signals reach snapshots, publishing, reconciliation and existing-deployment polling", async () => {
  const controller = new AbortController();
  const base = fixture();
  const calls = [];
  let lost = false;
  const publisher = new BundlePublisher({ repository: "owner/game", task: async (job, bytes, { signal } = {}) => {
    assert.equal(signal, controller.signal);
    calls.push(job.task);
    const result = await base.task(job, bytes);
    if (job.task === "publish" && !lost) { lost = true; throw new Error("Lost remote result"); }
    return result;
  } });
  await publisher.snapshot(GUILD, { signal: controller.signal });
  await publisher.publish(GUILD, () => ({ game: game(), town: town() }), { jobId: "job-signals", signal: controller.signal });
  await publisher.deploymentStatus("dpl_fixture", undefined, { signal: controller.signal });
  assert.deepEqual(calls, ["snapshot", "snapshot", "publish", "snapshot", "deploy", "deployment-status"]);
});

test("cancelling active publication does not start reconciliation or deployment work", async () => {
  const controller = new AbortController();
  const reason = new Error("Active publication cancelled");
  const started = deferred();
  const base = fixture();
  const calls = [];
  const publisher = new BundlePublisher({ repository: "owner/game", task: async (job, bytes, { signal } = {}) => {
    calls.push(job.task);
    if (job.task !== "publish") return base.task(job, bytes);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started.resolve();
    });
  } });
  const pending = publisher.publish(GUILD, () => ({ game: game(), town: town() }), { jobId: "job-active-abort", signal: controller.signal });
  await started.promise;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.deepEqual(calls, ["snapshot", "publish"]);
});

test("auto-review publishing selects the built-in workspace policy without conflicting sandbox flags", async () => {
  let args;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const runner = createCodexRunner({
    env: { CODEX_ENABLED: "true", PATH: process.env.PATH }, getUid: () => 1000, autoReview: true,
    spawnFn: (_command, flags) => { args = flags; return child; }, logger: { error() {} },
  });
  const pending = runner.run("A publishing startup fixture", { userId: CODEX_OWNER_ID });
  assert.equal(args.filter((arg) => arg === "--approve-for-me").length, 1);
  assert.equal(args.includes("--sandbox"), false);
  assert.equal(args.includes('approval_policy="never"'), false);
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  child.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Startup fixture passed." } })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
  child.emit("close", 0);
  assert.equal((await pending).status, "completed");
});

test("runner startup diagnostics retain a sanitized CLI error while private-safe summaries stay generic", async () => {
  const secret = "fixture-discord-token-value";
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const runner = createCodexRunner({
    env: { CODEX_ENABLED: "true", PATH: process.env.PATH, DISCORD_TOKEN: secret }, getUid: () => 1000,
    spawnFn: () => child, logger: { error() {} },
  });
  const pending = runner.run("A startup error fixture", { userId: CODEX_OWNER_ID });
  child.stderr.write(`error: conflicting command options ${secret}\n\nUsage: codex exec [OPTIONS]\n`);
  child.emit("close", 2);
  const result = await pending;
  assert.equal(result.diagnostic.stage, "codex-startup");
  assert.equal(result.diagnostic.exitCode, 2);
  assert.match(result.diagnostic.message, /conflicting command options \[redacted\]/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.doesNotMatch(result.summary, /conflicting command options/);
});

test("a missing transaction checkpoint exposes the safe runner failure and concrete startup stage", async () => {
  const secret = "fixture-provider-token-value";
  const task = createConnectedGameTask({
    codexEnv: { OPENAI_API_KEY: secret },
    runnerFactory: () => ({ run: async () => ({
      id: "fixture-runner-id", status: "failed", summary: "The runner failed.",
      diagnostic: { stage: "codex-startup", code: "CODEX_EXEC_FAILED", message: `error: incompatible CLI options ${secret}` },
    }) }),
  });
  await assert.rejects(task({ task: "publish", repository: "owner/game" }), (error) => {
    assert.ok(error instanceof GamePublishError);
    assert.equal(error.stage, "codex-startup");
    assert.equal(error.runnerId, "fixture-runner-id");
    assert.equal(error.code, "CODEX_EXEC_FAILED");
    assert.match(error.message, /incompatible CLI options \[redacted\]/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

test("a completed runner without a saved transaction never forwards its unsupported success claim", async () => {
  const task = createConnectedGameTask({ runnerFactory: () => ({ run: async () => ({ status: "completed", summary: "private unsupported success claim" }) }) });
  await assert.rejects(task({ task: "publish", repository: "owner/game" }), (error) => {
    assert.equal(error.stage, "codex-result");
    assert.match(error.message, /without saving a valid game transaction result/);
    assert.doesNotMatch(error.message, /private|unsupported success claim/);
    return true;
  });
});

test("connected tool failures record the precise transaction stage and a safe error code", async () => {
  const task = createConnectedGameTask({ runnerFactory: scriptRunner(() => ({
    mcp__codex_apps__github_create_blob: async () => ({ isError: true, structuredContent: { error_code: "APPROVAL_REJECTED" } }),
  })) });
  const result = await task({
    task: "publish", repository: "owner/game", branch: "main", expectedHead: HEAD, baseTree: TREE,
    manifestPath: `public/games/${GUILD}/game.json`, game: game(),
    binaryFiles: [{ path: `public/games/${GUILD}/town/hall.png`, localName: "asset-0.bin", size: 3 }],
  }, [{ localName: "asset-0.bin", bytes: Buffer.from("png") }]);
  assert.equal(result.status, "failed");
  assert.equal(result.stage, "uploading-artwork");
  assert.equal(result.errorCode, "APPROVAL_REJECTED");
  assert.match(result.error, /generated artwork.*APPROVAL_REJECTED/);
  const base = fixture();
  const publisher = new BundlePublisher({ repository: "owner/game", task: async (job, ...args) => job.task === "publish" ? result : base.task(job, ...args) });
  await assert.rejects(publisher.publish(GUILD, () => ({ game: game(), town: town() }), { jobId: "job-safe-failure" }), (error) => {
    assert.equal(error.stage, "uploading-artwork");
    assert.equal(error.code, "APPROVAL_REJECTED");
    return true;
  });
});

test("mutation callbacks receive each snapshot's pinned head and branch for concurrent artwork checks", async () => {
  let conflict = false;
  const seen = [];
  const { publisher } = fixture({ beforePublish: async (_job, state) => {
    if (conflict) return;
    conflict = true;
    state.head = "d".repeat(40);
    state.tree = "e".repeat(40);
    return { status: "conflict" };
  } });
  await publisher.publish(GUILD, ({ head, branch }) => {
    seen.push({ head, branch });
    return { game: game(), town: town() };
  }, { jobId: "job-pinned-assets" });
  assert.deepEqual(seen, [{ head: HEAD, branch: "latest-default" }, { head: "d".repeat(40), branch: "latest-default" }]);
});
