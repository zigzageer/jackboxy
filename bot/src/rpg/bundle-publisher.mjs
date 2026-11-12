import { isDeepStrictEqual } from "node:util";
import { assertSnowflake, manifestPath } from "./github-store.mjs";
import { createConnectedGameTask } from "./codex-store.mjs";

const SHA = /^[a-f0-9]{40}$/;
const MAX_FILES = 64;
const MAX_ART_BYTES = 32 * 1024 * 1024;
let publishing = Promise.resolve();

function validBranch(branch) {
  if (branch === undefined || branch === null || branch === "") return undefined;
  if (
    typeof branch !== "string" || branch.length > 255 ||
    /[\x00-\x20~^:?*\[\]\\]/.test(branch) ||
    branch.includes("..") || branch.includes("@{") ||
    branch.endsWith(".") ||
    branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) throw new Error("Invalid game repository branch.");
  return branch;
}

function gameDirectory(guildId) {
  return `public/games/${assertSnowflake(guildId)}/`;
}

function prepareFiles(guildId, files) {
  if (!Array.isArray(files) || files.length > MAX_FILES)
    throw new Error("The game artwork bundle has too many files.");
  const textFiles = [];
  const binaryFiles = [];
  const binaryInput = [];
  const seen = new Set(["game.json", "town.json"]);
  let bytes = 0;
  for (const file of files) {
    if (
      typeof file.path !== "string" || file.path.length > 200 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(file.path) ||
      file.path.split("/").some((part) => !part || part === "." || part === "..") ||
      seen.has(file.path)
    ) throw new Error("Artwork paths must be unique files inside this server’s game directory.");
    seen.add(file.path);
    const target = gameDirectory(guildId) + file.path;
    if (typeof file.content === "string" && file.bytes === undefined) {
      bytes += Buffer.byteLength(file.content);
      textFiles.push({ path: target, content: file.content });
    } else if (Buffer.isBuffer(file.bytes) || file.bytes instanceof Uint8Array) {
      if (file.content !== undefined) throw new Error("Each artwork file must have one content source.");
      const content = Buffer.from(file.bytes);
      bytes += content.length;
      const localName = `asset-${binaryFiles.length}.bin`;
      binaryFiles.push({ path: target, localName, size: content.length });
      binaryInput.push({ localName, bytes: content });
    } else throw new Error("Each artwork file needs text content or image bytes.");
    if (bytes > MAX_ART_BYTES) throw new Error("The game artwork bundle is too large.");
  }
  return { textFiles, binaryFiles, binaryInput };
}

function validateGame(guildId, game, town) {
  if (!game || game.version !== 1 || game.guildId !== guildId || !Array.isArray(game.characters))
    throw new Error("Invalid server game manifest.");
  if (town !== null && (!town || typeof town !== "object" || Array.isArray(town)))
    throw new Error("Invalid server town document.");
  if (town?.guildId !== undefined && town.guildId !== guildId)
    throw new Error("The town belongs to another server.");
}

function appliedJob(game, jobId) {
  return Boolean(game?.botJobs && Object.hasOwn(game.botJobs, jobId) && game.botJobs[jobId] === true);
}

function waitForTurn(previous, signal) {
  if (!signal) return previous;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    previous.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class BundlePublisher {
  constructor({ repository, branch, vercel, codexEnv, task, attempts = 5 } = {}) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository || ""))
      throw new Error("Invalid game repository.");
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10)
      throw new Error("Publishing attempts must be between 1 and 10.");
    this.repository = repository;
    this.branch = validBranch(branch);
    this.vercel = vercel;
    this.task = task ?? createConnectedGameTask({ codexEnv });
    this.attempts = attempts;
  }

  async snapshot(guildId, { signal } = {}) {
    signal?.throwIfAborted();
    const directory = gameDirectory(guildId);
    const result = await this.task({
      task: "snapshot",
      repository: this.repository,
      branch: this.branch,
      manifestPath: manifestPath(guildId),
      townPath: directory + "town.json",
    }, undefined, { signal });
    signal?.throwIfAborted();
    if (result.status !== "snapshot" || !SHA.test(result.head) || !SHA.test(result.tree))
      throw new Error("Could not read the latest game revision from GitHub.");
    const branch = validBranch(result.branch || this.branch);
    if (!branch) throw new Error("Could not resolve the game repository’s default branch.");
    const game = result.gameJson == null ? null : JSON.parse(result.gameJson);
    const town = result.townJson == null ? null : JSON.parse(result.townJson);
    if (game) validateGame(guildId, game, town);
    else if (town !== null) throw new Error("The published town has no game manifest.");
    return { game, town, head: result.head, tree: result.tree, branch };
  }

  async read(guildId, options) {
    return (await this.snapshot(guildId, options)).game;
  }

  async deploymentStatus(deploymentId, branch = this.branch, { signal } = {}) {
    signal?.throwIfAborted();
    if (typeof deploymentId !== "string" || !/^dpl_[a-zA-Z0-9_-]{1,100}$/.test(deploymentId))
      throw new Error("Invalid game deployment ID.");
    const result = await this.task({
      task: "deployment-status",
      repository: this.repository,
      branch: validBranch(branch),
      deploymentId,
      vercel: this.vercel,
    }, undefined, { signal });
    signal?.throwIfAborted();
    return this.deployment(result);
  }

  deployment(result) {
    if (result.status !== "published") throw new Error("Could not check game publishing.");
    if (!["READY", "PENDING", "FAILED"].includes(result.deploymentState))
      throw new Error("The game deployment returned an invalid state.");
    return { id: result.deploymentId || null, state: result.deploymentState };
  }

  async publish(guildId, change, { jobId, message, files = [], signal } = {}) {
    signal?.throwIfAborted();
    const directory = gameDirectory(guildId);
    if (typeof change !== "function") throw new Error("A roster update is required.");
    if (typeof jobId !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(jobId))
      throw new Error("A valid publishing job ID is required.");
    const bundle = prepareFiles(guildId, files);
    const previous = publishing;
    let release;
    publishing = new Promise((resolve) => { release = resolve; });
    try {
      await waitForTurn(previous, signal);
      for (let attempt = 0; attempt < this.attempts; attempt++) {
        const current = await this.snapshot(guildId, { signal });
        const alreadyApplied = appliedJob(current.game, jobId);
        let game = current.game;
        let town = current.town;
        let attemptBundle = bundle;
        if (!alreadyApplied) {
          const changed = await change(structuredClone({ game, town }));
          signal?.throwIfAborted();
          game = changed?.game;
          town = changed?.town ?? null;
          if (changed?.files !== undefined)
            attemptBundle = prepareFiles(guildId, changed.files);
          validateGame(guildId, game, town);
          game = { ...game, botJobs: { ...current.game?.botJobs, ...game.botJobs, [jobId]: true } };
        }
        const transaction = {
          task: alreadyApplied ? "deploy" : "publish",
          repository: this.repository,
          branch: current.branch,
          expectedHead: current.head,
          baseTree: current.tree,
          manifestPath: manifestPath(guildId),
          townPath: directory + "town.json",
          game,
          town,
          message: String(message || `Publish server game ${guildId}`).slice(0, 240),
          vercel: this.vercel,
          textFiles: alreadyApplied ? [] : attemptBundle.textFiles,
          binaryFiles: alreadyApplied ? [] : attemptBundle.binaryFiles,
        };
        if (Buffer.byteLength(JSON.stringify(transaction)) > 120_000)
          throw new Error("The town and roster document is too large to publish.");
        let result;
        try {
          result = await this.task(transaction, alreadyApplied ? [] : attemptBundle.binaryInput, { signal });
          signal?.throwIfAborted();
        } catch (error) {
          signal?.throwIfAborted();
          // The remote commit may have succeeded before the worker lost its result.
          const latest = await this.snapshot(guildId, { signal });
          if (!appliedJob(latest.game, jobId)) throw error;
          if (!isDeepStrictEqual(latest.game, game) && !alreadyApplied) {
            game = latest.game;
            town = latest.town;
          }
          result = await this.task({
            task: "deploy", repository: this.repository, branch: latest.branch, vercel: this.vercel,
          }, undefined, { signal });
          signal?.throwIfAborted();
          result.commit = latest.head;
        }
        if (result.status === "conflict") continue;
        if (result.status !== "published" || (!alreadyApplied && !SHA.test(result.commit)))
          throw new Error("Could not commit this game update to GitHub.");
        return {
          game,
          town,
          commit: alreadyApplied ? null : result.commit,
          branch: current.branch,
          alreadyApplied,
          deployment: this.deployment(result),
        };
      }
      throw new Error("The game branch kept changing during publishing. Retry this job.");
    } finally {
      // An aborted waiter keeps its place until the active predecessor finishes.
      previous.then(release, release);
    }
  }
}
