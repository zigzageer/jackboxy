import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { serverSlug } from './game-service.mjs';
import { validateTownFile } from './town-contract.mjs';
import { createTownAssetReader, createLiveTownVerifier, inspectTownArtwork, normalizeUnpublishedTown, townArtPath, decodeTownArtwork } from './town-assets.mjs';

export async function publicChannelNames(guild) {
  const everyone = guild.roles.everyone || await guild.roles.fetch(guild.id);
  if (!everyone) throw new Error('Could not check which channels are public.');
  const channels = await guild.channels.fetch();
  const names = [];
  for (const channel of channels.values()) {
    if (!channel || channel.isThread?.() || !channel.permissionsFor(everyone)?.has(1024n)) continue;
    if (typeof channel.name === 'string' && channel.name.trim()) names.push(channel.name.trim().slice(0, 100));
  }
  return [...new Set(names)].sort().slice(0, 60);
}

const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function saveFile(directory, name, bytes) {
  const target = path.join(directory, name);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.pending`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, target);
  return { name, sha256: checksum(bytes), size: bytes.length };
}

async function loadFile(directory, artifact) {
  if (!artifact || !/^(?:town\/[a-z0-9-]+\.(?:png|webp)|town(?:-source)?\.json|sprite\.png)$/.test(artifact.name)) return null;
  const file = path.join(directory, artifact.name);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size !== artifact.size || info.size > 2_000_000) return null;
  const bytes = await readFile(file);
  return checksum(bytes) === artifact.sha256 ? bytes : null;
}

function characterFor(memberId, name) {
  return {
    id: `discord-${memberId}`,
    discordUserId: memberId,
    name,
    kind: 'human',
    skin: '#f2cfaa',
    hair: 'short',
    hairColor: '#352a28',
    shirt: '#6a9183',
    pants: '#454957',
    hat: 'none',
    hatColor: '#ddba65',
    glasses: false,
  };
}

function buildingDefinition(building) {
  const { art: _art, ...definition } = building;
  return definition;
}

function townLayout(town) {
  return { ...town, buildings: town.buildings.map(buildingDefinition) };
}

export function createGameProcessor({
  publisher,
  generateCharacter,
  generateTown,
  client,
  state,
  artifactDirectory,
  baseUrl,
  readAsset,
  verifyLiveTown,
  validateTown = validateTownFile,
  now = () => new Date().toISOString(),
  deploymentPollMs = 5000,
  deploymentTimeoutMs = 5 * 60_000,
}) {
  const urlFor = (game) => `${baseUrl.replace(/\/$/, '')}/${game.slug}`;
  const readTownAsset = readAsset || createTownAssetReader({ repository: publisher.repository || 'zigzageer/grapevinerpg' });
  const verifyLive = verifyLiveTown || createLiveTownVerifier({ baseUrl });
  const complete = (job, publication) => {
    const url = urlFor(publication.game);
    state.registerGuild({ guildId: job.guildId, channelId: job.channelId, name: publication.game.name, gameUrl: url });
    return { url, gameName: publication.game.name, characterName: publication.characterName, commit: publication.commit, deployment: publication.deployment };
  };

  async function createTown(job, snapshot, directory, { checkpoint, signal }) {
    const remote = new Map();
    const readPinned = (input) => {
      const key = `${input.head}:${input.assetPath}`;
      if (!remote.has(key)) remote.set(key, readTownAsset(input));
      return remote.get(key);
    };
    let sourceTown = snapshot.town;
    let town = sourceTown;
    let files = [];
    let missing;
    const protectedFiles = new Set();
    if (sourceTown) {
      checkpoint({ stage: 'validating-existing-art' });
      const inspected = await inspectTownArtwork({ town: sourceTown, guildId: job.guildId, head: snapshot.head,
        readAsset: readPinned, allowMissing: true, signal });
      town = inspected.town;
      missing = inspected.missing;
      for (const file of inspected.verified) protectedFiles.add(file);
      checkpoint({ stage: 'validating-existing-town' });
      await validateTown({ town, guildId: job.guildId, directory, signal });
      if (!missing.length) {
        checkpoint({ stage: 'verifying-live-town' });
        if (await verifyLive({ guildId: job.guildId, game: snapshot.game, town: sourceTown, signal })) {
          return { ...snapshot, commit: null, deployment: { id: null, state: 'READY' }, liveVerified: true };
        }
      }
    } else if (job.artifacts.town) {
      checkpoint({ stage: 'loading-generated-town' });
      const bytes = await loadFile(directory, job.artifacts.town);
      if (bytes) {
        const recovered = [];
        for (const artifact of job.artifacts.files || []) {
          const image = await loadFile(directory, artifact);
          if (image) recovered.push({ path: artifact.name, bytes: image });
        }
        const normalized = await normalizeUnpublishedTown({ town: JSON.parse(bytes.toString('utf8')), files: recovered, guildId: job.guildId });
        sourceTown = normalized.town;
        town = sourceTown;
        files = normalized.files;
        const inspected = await inspectTownArtwork({ town, guildId: job.guildId, files, readAsset: async () => null, allowMissing: true, signal });
        town = inspected.town;
        missing = inspected.missing;
        checkpoint({ stage: 'saving-recovered-art' });
        const recoveredFiles = [];
        for (const file of files) recoveredFiles.push(await saveFile(directory, file.path, file.bytes));
        // The generator updates town.json as buildings finish. Keep its input
        // separate so partial progress cannot invalidate this recovery checkpoint.
        const recoveredTown = await saveFile(directory, 'town-source.json', Buffer.from(JSON.stringify(town)));
        checkpoint({ stage: 'recovered-art-ready', artifacts: { town: recoveredTown, files: recoveredFiles } });
      }
    }
    if (!town || missing?.length) {
      checkpoint({ stage: 'reading-public-channels' });
      const guild = await client.guilds.fetch(job.guildId);
      const channelNames = await publicChannelNames(guild);
      signal?.throwIfAborted();
      checkpoint({ stage: 'generating-town' });
      const retainedArt = new Map((town?.buildings || []).filter((building) => building.art).map((building) => [building.id, building.art]));
      const generated = await generateTown({ guildId: job.guildId, guildName: job.payload.guildName,
        channelNames, directory, signal, ...(town ? { town } : {}),
        onProgress: (progress) => checkpoint({ stage: progress.buildingId ? `${progress.stage}:${progress.buildingId}` : progress.stage }),
      });
      checkpoint({ stage: 'validating-generated-art' });
      if (sourceTown && !isDeepStrictEqual(townLayout(sourceTown), townLayout(generated.town))) {
        throw new Error('Town generation changed an existing layout. Retry with its saved layout preserved.');
      }
      if (generated.town.buildings.some((building) => retainedArt.has(building.id) && building.art !== retainedArt.get(building.id))) {
        throw new Error('Town generation changed existing artwork. Retry with its original artwork preserved.');
      }
      town = generated.town;
      if (!Array.isArray(generated.files)) throw new Error('The town artwork bundle is invalid.');
      files = [...files, ...generated.files];
    }
    checkpoint({ stage: 'validating-generated-art' });
    if (!town || !Array.isArray(files) || files.length > 64) throw new Error('The town artwork bundle is invalid.');
    const byPath = new Map();
    for (const file of files) {
      townArtPath(job.guildId, `/games/${job.guildId}/${file.path}`);
      if (byPath.has(file.path) || protectedFiles.has(file.path)) throw new Error('Generated artwork would overwrite an existing town image.');
      byPath.set(file.path, file);
    }
    const newOwners = new Set();
    for (const building of town.buildings) {
      const relative = townArtPath(job.guildId, building.art);
      if (byPath.has(relative) && newOwners.has(relative)) throw new Error('Each new town building needs its own original artwork.');
      if (byPath.has(relative)) newOwners.add(relative);
    }
    files = files.filter((file) => newOwners.has(file.path));
    checkpoint({ stage: 'validating-generated-art' });
    await inspectTownArtwork({ town, guildId: job.guildId, head: snapshot.head, files, readAsset: readPinned, signal });
    const townArtifact = await saveFile(directory, 'town.json', Buffer.from(JSON.stringify(town)));
    const fileArtifacts = [];
    for (const file of files) fileArtifacts.push(await saveFile(directory, file.path, file.bytes));
    checkpoint({ stage: 'validating-town', artifacts: { town: townArtifact, files: fileArtifacts } });
    await validateTown({ town, guildId: job.guildId, directory, signal });
    const baseline = new Map((sourceTown || town).buildings.map((building) => [building.id, building]));
    const initialArt = new Map((snapshot.town?.buildings || []).map((building) => [building.id, building.art]));
    const generatedBuildings = new Map(town.buildings.map((building) => [building.id, building]));
    const artRevision = files.map((file) => `${file.path}:${checksum(file.bytes)}`).sort().join('\n');
    const publishingJobId = snapshot.game?.botJobs?.[job.id] && files.length
      ? `${job.id}-art-${checksum(Buffer.from(artRevision)).slice(0, 12)}`
      : job.id;
    signal?.throwIfAborted();
    checkpoint({ stage: 'publishing-town' });
    return publisher.publish(job.guildId, async (latest) => {
      const document = structuredClone(latest.town || town);
      const selected = new Set();
      if (latest.town) {
        checkpoint({ stage: 'validating-latest-art' });
        for (const building of document.buildings) {
          if (building.art) {
            const bytes = await readPinned({ guildId: job.guildId, assetPath: building.art, head: latest.head, signal });
            if (bytes) {
              try { await decodeTownArtwork(bytes); }
              catch { throw new Error(`Town artwork for building ${building.id} could not be decoded.`); }
              continue;
            }
          }
          const original = baseline.get(building.id);
          const generated = generatedBuildings.get(building.id);
          if (!original || !generated || !isDeepStrictEqual(buildingDefinition(original), buildingDefinition(building))
            || building.art !== initialArt.get(building.id)) {
            throw new Error('The town changed while artwork was being generated. Retry /game create to finish its latest layout.');
          }
          const relative = townArtPath(job.guildId, generated.art);
          if (!byPath.has(relative)) throw new Error(`Town building ${building.id} still needs artwork. Retry /game create.`);
          building.art = generated.art;
          selected.add(relative);
        }
      } else {
        for (const building of document.buildings) {
          const relative = townArtPath(job.guildId, building.art);
          if (byPath.has(relative)) selected.add(relative);
        }
      }
      const selectedFiles = files.filter((file) => selected.has(file.path));
      checkpoint({ stage: 'validating-latest-town' });
      await inspectTownArtwork({ town: document, guildId: job.guildId, head: latest.head, files: selectedFiles, readAsset: readPinned, signal });
      await validateTown({ town: document, guildId: job.guildId, directory, signal });
      checkpoint({ stage: 'publishing-town' });
      return {
        game: { ...(latest.game || { version: 1, guildId: job.guildId, name: job.payload.guildName,
          slug: serverSlug(job.payload.guildName, job.guildId), characters: [] }),
        updatedAt: now(), town: latest.game?.town || { path: `/games/${job.guildId}/town.json` } },
        town: document,
        files: selectedFiles,
      };
    }, { jobId: publishingJobId, message: `Complete server town artwork ${job.guildId}`, files, signal });
  }

  return async (job, { checkpoint, signal }) => {
    signal?.throwIfAborted();
    checkpoint({ stage: 'preparing-artifacts' });
    const directory = path.join(artifactDirectory, job.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    signal?.throwIfAborted();
    let publication = job.type === 'create' ? null : job.result?.publication;
    if (publication && (publication.deployment?.state === 'FAILED' || !publication.deployment?.id)) {
      checkpoint({ stage: 'resuming-publication' });
      publication = await publisher.publish(job.guildId, ({ game, town }) => {
        if (!game) throw new Error('The saved game was removed before publishing.');
        return { game, town, files: [] };
      }, { jobId: job.id, message: `Resume server game publication ${job.guildId}`, files: [], signal });
      if (job.type === 'add') {
        publication.characterName = publication.game.characters.find((item) => item.id === `discord-${job.memberId}`)?.name;
      }
      checkpoint({ stage: 'deploying', result: { publication } });
    }
    if (!publication) {
      checkpoint({ stage: 'reading-latest-branch' });
      const snapshot = await publisher.snapshot(job.guildId, { signal });
      signal?.throwIfAborted();
      if (job.type === 'create') {
        publication = await createTown(job, snapshot, directory, { checkpoint, signal });
      } else if (job.type === 'add') {
        if (!snapshot.game) throw new Error('Create this server’s game first with /game create.');
        const existing = snapshot.game.characters.find((character) => character.id === `discord-${job.memberId}`);
        if (!existing && snapshot.game.characters.length >= 24) throw new Error('This town already has 24 characters.');
        checkpoint({ stage: 'loading-generated-character' });
        let bytes = existing ? null : await loadFile(directory, job.artifacts.sprite);
        let character = existing || job.artifacts.character;
        if (!existing && (!bytes || !character)) {
          checkpoint({ stage: 'resolving-member' });
          const guild = await client.guilds.fetch(job.guildId);
          const member = await guild.members.fetch({ user: job.memberId, force: true }).catch(() => null);
          if (!member) throw new Error('Choose someone who is a member of this server.');
          const name = (job.payload.name || member.displayName).trim().slice(0, 28);
          if (!name) throw new Error('Give this character a name.');
          const references = [];
          if (job.payload.usePfp !== false) references.push({ url: member.displayAvatarURL({ extension: 'png', size: 1024, forceStatic: true }) });
          if (job.payload.image) references.push(job.payload.image);
          checkpoint({ stage: 'generating-character' });
          bytes = await generateCharacter({ name, description: job.payload.description, references, signal });
          character = { ...characterFor(job.memberId, name), sprite: `/games/${job.guildId}/${job.memberId}.png` };
          const sprite = await saveFile(directory, 'sprite.png', bytes);
          checkpoint({ stage: 'character-generated', artifacts: { sprite, character } });
        }
        signal?.throwIfAborted();
        checkpoint({ stage: 'publishing-character' });
        publication = await publisher.publish(job.guildId, ({ game, town }) => {
          if (!game) throw new Error('This server’s game was removed before publishing.');
          if (game.characters.some((item) => item.id === character.id)) return { game, town, files: [] };
          if (existing) throw new Error('This character was removed before publishing. Retry /game add.');
          if (game.characters.length >= 24) throw new Error('This town already has 24 characters.');
          return { game: { ...game, updatedAt: now(), characters: [...game.characters, character] }, town };
        }, { jobId: job.id, message: `Add server character ${job.guildId}/${job.memberId}`, files: existing ? [] : [{ path: `${job.memberId}.png`, bytes }], signal });
        publication.characterName = publication.game.characters.find((item) => item.id === character.id)?.name;
      } else throw new Error('Unsupported game job.');
      checkpoint({ stage: 'deploying', result: { publication } });
    }
    signal?.throwIfAborted();
    if (!publication.liveVerified && (publication.deployment?.state !== 'READY' || !publication.deployment?.id)) {
      checkpoint({ stage: 'deploying' });
      const started = Date.now();
      while (publication.deployment?.id && publication.deployment.state === 'PENDING' && Date.now() - started < deploymentTimeoutMs) {
        await delay(deploymentPollMs, undefined, { signal });
        const deploymentId = publication.deployment.id;
        publication.deployment = await publisher.deploymentStatus(deploymentId, publication.branch, { signal });
        publication.deployment.id ||= deploymentId;
        checkpoint({ result: { publication } });
      }
      if (!publication.liveVerified && (publication.deployment?.state !== 'READY' || !publication.deployment?.id)) {
        throw new Error(publication.deployment?.state === 'FAILED'
          ? 'Vercel deployment failed. Retry the command to resume publishing the saved generation.'
          : 'Vercel publishing has not finished. Check /game status or retry the command to resume.');
      }
    }
    checkpoint({ stage: 'registering-server' });
    const result = complete(job, publication);
    checkpoint({ stage: 'ready' });
    return result;
  };
}

export function createJobNotifier(client) {
  return async (job) => {
    const channel = await client.channels.fetch(job.channelId);
    if (!channel?.isTextBased?.() || channel.guildId !== job.guildId || typeof channel.send !== 'function') {
      throw new Error('The game notification channel is unavailable.');
    }
    const result = job.status === 'succeeded'
      ? `${job.type === 'create' ? 'Your server’s town is ready' : `Your character ${job.result.characterName || ''} is ready`}.\n${job.result.url}`
      : `Job failed at \`${job.stage}\`. ${job.error}\nUse /game status job:${job.id} to check it.`;
    return channel.send({
      content: `<@${job.requesterId}> ${result}\nJob \`${job.id}\`.`,
      allowedMentions: { parse: [], users: [job.requesterId], roles: [], repliedUser: false },
      nonce: job.notification.nonce,
      enforceNonce: true,
    });
  };
}
