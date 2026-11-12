import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serverSlug } from './game-service.mjs';
import { assertTown } from './town-validation.mjs';

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
  if (!artifact || !/^(?:town\/[a-z0-9-]+\.(?:png|webp)|town\.json|sprite\.png)$/.test(artifact.name)) return null;
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

export function createGameProcessor({
  publisher,
  generateCharacter,
  generateTown,
  client,
  state,
  artifactDirectory,
  baseUrl,
  now = () => new Date().toISOString(),
  deploymentPollMs = 5000,
  deploymentTimeoutMs = 5 * 60_000,
}) {
  const urlFor = (game) => `${baseUrl.replace(/\/$/, '')}/${game.slug}`;
  const complete = (job, publication) => {
    const url = urlFor(publication.game);
    state.registerGuild({ guildId: job.guildId, channelId: job.channelId, name: publication.game.name, gameUrl: url });
    return { url, gameName: publication.game.name, characterName: publication.characterName, commit: publication.commit, deployment: publication.deployment };
  };
  return async (job, { checkpoint, signal }) => {
    signal?.throwIfAborted();
    checkpoint({ stage: 'preparing-artifacts' });
    const directory = path.join(artifactDirectory, job.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    signal?.throwIfAborted();
    let publication = job.result?.publication;
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
      if (job.type === 'create' && snapshot.town) {
        checkpoint({ stage: 'publishing-town' });
        publication = await publisher.publish(job.guildId, ({ game, town }) => ({ game, town, files: [] }), {
          jobId: job.id,
          message: `Resume town publication for ${job.guildId}`,
          files: [],
          signal,
        });
      } else if (job.type === 'create') {
        let town = null;
        let files = [];
        if (job.artifacts.town) {
          checkpoint({ stage: 'loading-generated-town' });
          const townBytes = await loadFile(directory, job.artifacts.town);
          const assets = await Promise.all((job.artifacts.files || []).map((item) => loadFile(directory, item)));
          if (townBytes && assets.every(Boolean)) {
            town = assertTown(JSON.parse(townBytes.toString('utf8')), job.guildId);
            files = job.artifacts.files.map((item, index) => ({ path: item.name, bytes: assets[index] }));
          }
        }
        if (!town) {
          checkpoint({ stage: 'reading-public-channels' });
          const guild = await client.guilds.fetch(job.guildId);
          const channelNames = await publicChannelNames(guild);
          checkpoint({ stage: 'generating-town' });
          const generated = await generateTown({ guildId: job.guildId, guildName: job.payload.guildName, channelNames, directory, signal });
          town = assertTown(generated.town, job.guildId);
          files = generated.files;
          if (!Array.isArray(files) || files.length > 64) throw new Error('The town artwork bundle is invalid.');
          const townArtifact = await saveFile(directory, 'town.json', Buffer.from(JSON.stringify(town)));
          const fileArtifacts = [];
          const savedPaths = new Set();
          for (const file of files) {
            if (!/^town\/[a-z0-9-]+\.(png|webp)$/.test(file.path) || savedPaths.has(file.path)
              || !(file.bytes instanceof Uint8Array) || file.bytes.length > 2_000_000) throw new Error('Invalid generated town artifact.');
            savedPaths.add(file.path);
            fileArtifacts.push(await saveFile(directory, file.path, file.bytes));
          }
          if (town.buildings.some((building) => building.art && !savedPaths.has(building.art.slice(`/games/${job.guildId}/`.length)))) {
            throw new Error('A town building is missing its generated artwork.');
          }
          checkpoint({ stage: 'validating-town', artifacts: { town: townArtifact, files: fileArtifacts } });
        }
        signal?.throwIfAborted();
        checkpoint({ stage: 'publishing-town' });
        publication = await publisher.publish(job.guildId, (latest) => ({
          game: {
            ...(latest.game || {
              version: 1,
              guildId: job.guildId,
              name: job.payload.guildName,
              slug: serverSlug(job.payload.guildName, job.guildId),
              characters: [],
            }),
            updatedAt: now(),
            town: latest.game?.town || { path: `/games/${job.guildId}/town.json` },
          },
          town: latest.town || town,
          ...(latest.town ? { files: [] } : {}),
        }), { jobId: job.id, message: `Create server town ${job.guildId}`, files, signal });
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
    if (publication.deployment?.state !== 'READY' || !publication.deployment?.id) {
      checkpoint({ stage: 'deploying' });
      const started = Date.now();
      while (publication.deployment?.id && publication.deployment.state === 'PENDING' && Date.now() - started < deploymentTimeoutMs) {
        await delay(deploymentPollMs, undefined, { signal });
        const deploymentId = publication.deployment.id;
        publication.deployment = await publisher.deploymentStatus(deploymentId, publication.branch, { signal });
        publication.deployment.id ||= deploymentId;
        checkpoint({ result: { publication } });
      }
      if (publication.deployment?.state !== 'READY' || !publication.deployment?.id) {
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
