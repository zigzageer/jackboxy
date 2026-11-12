import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { validateTownFile } from '../src/rpg/town-contract.mjs';

const sample = JSON.parse(await readFile(new URL('../src/rpg/contracts/sample-town.json', import.meta.url), 'utf8'));

test('the exact pinned website script validates the shared town without adding runtime fields', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mint-town-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = structuredClone(sample);
  const result = await validateTownFile({ town: original, guildId: original.guildId, directory });
  assert.equal(result, original);
  assert.deepEqual(original, sample);
  assert.deepEqual(await readdir(directory), []);
});

test('the website validator rejects blocked destinations and cleans its temporary input', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mint-town-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const town = structuredClone(sample);
  town.spawn = { x: town.buildings[0].x + 50, y: town.buildings[0].y + 50 };
  await assert.rejects(validateTownFile({ town, guildId: town.guildId, directory }), /Town map validation failed/);
  assert.deepEqual(await readdir(directory), []);
});

test('town validation preserves an already-aborted request reason', async () => {
  const controller = new AbortController();
  const reason = new Error('Fixture job stopped');
  controller.abort(reason);
  await assert.rejects(validateTownFile({ town: sample, guildId: sample.guildId, directory: tmpdir(), signal: controller.signal }), (error) => error === reason);
});
