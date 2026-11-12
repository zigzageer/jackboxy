import { isDeepStrictEqual } from 'node:util';
import sharp from 'sharp';
import { assertSnowflake } from './github-store.mjs';

const MAX_IMAGE_BYTES = 2_000_000;

export function townArtPath(guildId, assetPath) {
  assertSnowflake(guildId);
  const prefix = `/games/${guildId}/`;
  if (typeof assetPath !== 'string' || !assetPath.startsWith(prefix)) throw new Error('Town artwork must belong to this server.');
  const relative = assetPath.slice(prefix.length);
  if (!/^town\/[a-z0-9-]+\.(png|webp)$/.test(relative)) throw new Error('Town artwork has an unsupported asset path.');
  return relative;
}

async function bodyBytes(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error('The town asset is too large.');
  }
  if (!response.body) throw new Error('The town asset response was empty.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('The town asset is too large.');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

function requestSignal(signal, timeoutMs) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

export function createTownAssetReader({ repository, fetch: request = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || repository.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('A valid game repository is required to read town artwork.');
  }
  return async ({ guildId, assetPath, head, signal }) => {
    const relative = townArtPath(guildId, assetPath);
    if (!/^[a-f0-9]{40}$/.test(head || '')) throw new Error('Town artwork must be read at a pinned GitHub revision.');
    signal?.throwIfAborted();
    let response;
    try {
      response = await request(`https://raw.githubusercontent.com/${repository}/${head}/public/games/${guildId}/${relative}`, {
        redirect: 'error', signal: requestSignal(signal, timeoutMs),
      });
    } catch {
      signal?.throwIfAborted();
      throw new Error('Could not read town artwork from the latest GitHub revision.');
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`GitHub town artwork request failed (${response.status}).`);
    }
    return bodyBytes(response, MAX_IMAGE_BYTES);
  };
}

export async function decodeTownArtwork(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Town artwork is empty or too large.');
  const source = sharp(bytes, { limitInputPixels: 25_000_000 });
  const metadata = await source.metadata();
  if (!['png', 'webp'].includes(metadata.format)) throw new Error('Town artwork must be PNG or WebP.');
  // Reading metadata alone accepts some truncated files. Decode every pixel.
  await source.raw().toBuffer();
  return metadata;
}

export async function normalizeUnpublishedTown({ town, files, guildId }) {
  const document = structuredClone(town);
  const normalized = [];
  const used = new Set();
  for (const file of files) {
    townArtPath(guildId, `/games/${guildId}/${file.path}`);
    await decodeTownArtwork(file.bytes);
    let relative = file.path;
    let bytes = Buffer.from(file.bytes);
    if (relative.endsWith('.png')) {
      relative = relative.replace(/\.png$/, '.webp');
      bytes = await sharp(bytes).webp({ lossless: true, effort: 4 }).toBuffer();
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Converted town artwork is too large.');
      for (const building of document.buildings) {
        if (building.art === `/games/${guildId}/${file.path}`) building.art = `/games/${guildId}/${relative}`;
      }
    }
    if (used.has(relative)) throw new Error('Town artwork filenames must be unique.');
    used.add(relative);
    normalized.push({ path: relative, bytes });
  }
  for (const building of document.buildings) {
    if (building.art && !used.has(townArtPath(guildId, building.art))) delete building.art;
  }
  return { town: document, files: normalized };
}

export async function inspectTownArtwork({ town, guildId, head, readAsset, files = [], allowMissing = false, signal }) {
  const document = structuredClone(town);
  const local = new Map();
  for (const file of files) {
    townArtPath(guildId, `/games/${guildId}/${file.path}`);
    if (local.has(file.path)) throw new Error('Town artwork filenames must be unique.');
    const metadata = await decodeTownArtwork(file.bytes);
    if (!file.path.endsWith('.webp') || metadata.format !== 'webp') throw new Error('New town artwork must use WebP.');
    local.set(file.path, Buffer.from(file.bytes));
  }
  const missing = [];
  const verified = new Set();
  for (const building of document.buildings) {
    signal?.throwIfAborted();
    let bytes = null;
    let relative;
    if (building.art) {
      relative = townArtPath(guildId, building.art);
      bytes = local.get(relative) || await readAsset({ guildId, assetPath: building.art, head, signal });
    }
    if (!bytes) {
      missing.push(building.id);
      if (allowMissing) delete building.art;
      else throw new Error(`Town building ${building.id} is missing its artwork. Retry /game create to complete the town.`);
      continue;
    }
    try { await decodeTownArtwork(bytes); }
    catch { throw new Error(`Town artwork for building ${building.id} could not be decoded.`); }
    verified.add(relative);
  }
  return { town: document, missing, verified };
}

export function createLiveTownVerifier({ baseUrl, fetch: request = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password) throw new Error('A trusted HTTPS game origin is required.');
  return async ({ guildId, game, town, signal }) => {
    assertSnowflake(guildId);
    const get = async (relative, limit) => {
      const response = await request(new URL(relative, origin), { redirect: 'error', signal: requestSignal(signal, timeoutMs) });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
      return bodyBytes(response, limit);
    };
    try {
      const gameBytes = await get(`/games/${guildId}/game.json`, 300_000);
      const townBytes = await get(`/games/${guildId}/town.json`, 300_000);
      if (!gameBytes || !townBytes || !isDeepStrictEqual(JSON.parse(gameBytes), game) || !isDeepStrictEqual(JSON.parse(townBytes), town)) return false;
      for (const building of town.buildings) {
        townArtPath(guildId, building.art);
        const bytes = await get(building.art, MAX_IMAGE_BYTES);
        if (!bytes) return false;
        await decodeTownArtwork(bytes);
      }
      return true;
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  };
}
