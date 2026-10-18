import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function configPath() {
  return process.env.JACKBOX_CONFIG
    ? path.resolve(process.env.JACKBOX_CONFIG)
    : path.join(BOT_ROOT, 'games.json');
}

// Lowercases and strips spaces/punctuation so "Quiplash 2", "quiplash-2" and
// "quiplash2" all match the same entry.
export function normalize(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Reads the games config. Shape:
 *   { runner?: [cmd, ...args], packs: { <packKey>: { name, exe?, args?, menuDelayMs?, games: { <gameKey>: { name, exe?, args?, keys?, menuDelayMs? } } } } }
 * `runner` prefixes every launch, e.g. ["wine"] or ["proton", "run"] on a Linux host.
 * A game inherits the pack's exe/args when it has none of its own, since most
 * Jackbox packs ship as one executable with the game picked in its menu.
 */
export function loadConfig(file = configPath()) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw.packs !== 'object') {
    throw new Error(`${file}: expected a top-level "packs" object`);
  }
  if (raw.runner !== undefined && (!Array.isArray(raw.runner) || raw.runner.length === 0)) {
    throw new Error(`${file}: "runner" must be a non-empty array like ["wine"]`);
  }
  for (const [packKey, pack] of Object.entries(raw.packs)) {
    if (!pack.games || typeof pack.games !== 'object') {
      throw new Error(`${file}: pack "${packKey}" has no "games" object`);
    }
    for (const [gameKey, game] of Object.entries(pack.games)) {
      if (!game.exe && !pack.exe) {
        throw new Error(`${file}: "${packKey}/${gameKey}" has no exe and its pack has none either`);
      }
    }
  }
  return raw;
}

export function findPack(config, query) {
  const q = normalize(query);
  for (const [key, pack] of Object.entries(config.packs)) {
    if (normalize(key) === q || normalize(pack.name ?? '') === q) return { key, ...pack };
  }
  return null;
}

/** Returns { pack, game, exe, args, runner, keys, menuDelayMs, viaPackMenu } or null when either name is unknown. */
export function resolveGame(config, packQuery, gameQuery) {
  const pack = findPack(config, packQuery);
  if (!pack) return null;
  const q = normalize(gameQuery);
  for (const [key, game] of Object.entries(pack.games)) {
    if (normalize(key) === q || normalize(game.name ?? '') === q) {
      return {
        pack: { key: pack.key, name: pack.name ?? pack.key },
        game: { key, name: game.name ?? key },
        exe: game.exe ?? pack.exe,
        args: game.args ?? pack.args ?? [],
        runner: config.runner ?? [],
        // xdotool key names pressed after launch to pick the game in the pack's menu.
        keys: game.keys ?? [],
        menuDelayMs: game.menuDelayMs ?? pack.menuDelayMs ?? 20_000,
        // True when the pack's shared exe is launched, so players still pick the game in its menu.
        viaPackMenu: !game.exe,
      };
    }
  }
  return null;
}

/** Autocomplete choices (max 25, Discord's limit) whose key or name contains the typed text. */
export function packChoices(config, typed) {
  return choices(Object.entries(config.packs), typed);
}

export function gameChoices(config, packQuery, typed) {
  const pack = findPack(config, packQuery);
  return pack ? choices(Object.entries(pack.games), typed) : [];
}

function choices(entries, typed) {
  const q = normalize(typed ?? '');
  return entries
    .filter(([key, item]) => normalize(key).includes(q) || normalize(item.name ?? '').includes(q))
    .slice(0, 25)
    .map(([key, item]) => ({ name: item.name ? `${item.name} (${key})` : key, value: key }));
}
