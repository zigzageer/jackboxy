import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gameChoices, loadConfig, resolveGame } from '../src/config.js';

function loadFixture(t, game = {}, pack = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jackbox-config-menu-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'games.json');
  fs.writeFileSync(file, JSON.stringify({
    runner: ['wine'],
    packs: {
      3: {
        name: 'The Jackbox Party Pack 3',
        exe: '/games/pack3.exe',
        args: ['--windowed'],
        menuDelayMs: 12_345,
        ...pack,
        games: {
          quiplash2: { name: 'Quiplash 2', ...game },
        },
      },
    },
  }));
  return loadConfig(file);
}

test('aliases resolve punctuation and case variants to the canonical game', (t) => {
  const config = loadFixture(t, {
    aliases: ['The Quipster', 'Q.L. II', 'QUIPSTER'],
  });

  for (const query of ['THE---qUiPsTeR!!', 'q l-ii', 'Quip.StEr']) {
    const resolved = resolveGame(config, '3', query);
    assert.deepEqual(resolved.game, { key: 'quiplash2', name: 'Quiplash 2' });
    assert.equal(resolved.exe, '/games/pack3.exe');
  }
  assert.equal(resolveGame(config, '3', 'not an alias'), null);
});

test('alias autocomplete returns the canonical choice once even when several names match', (t) => {
  const config = loadFixture(t, {
    aliases: ['Q.L. II', 'Q.L. II edition', 'Quipster', 'QUIP-STER'],
  });
  const canonical = [{ name: 'Quiplash 2 (quiplash2)', value: 'quiplash2' }];

  assert.deepEqual(gameChoices(config, '3', 'q.L.'), canonical);
  assert.deepEqual(gameChoices(config, '3', 'QUIP'), canonical);
  assert.deepEqual(gameChoices(config, '3', ''), canonical);
  assert.deepEqual(gameChoices(config, '3', 'unmatched'), []);
  assert.deepEqual(gameChoices(config, 'missing pack', 'q.L.'), []);
});

test('menu steps resolve alongside inherited pack launch settings', (t) => {
  const menuSteps = [
    { key: 'Down', delayMs: 0 },
    { key: 'Return', delayMs: 300_000 },
  ];
  const config = loadFixture(t, { menuSteps, keys: ['Down', 'Return'] });

  assert.deepEqual(resolveGame(config, '3', 'quiplash2'), {
    pack: { key: '3', name: 'The Jackbox Party Pack 3' },
    game: { key: 'quiplash2', name: 'Quiplash 2' },
    exe: '/games/pack3.exe',
    args: ['--windowed'],
    runner: ['wine'],
    keys: ['Down', 'Return'],
    menuSteps,
    menuDelayMs: 12_345,
    viaPackMenu: true,
  });
});

test('game launch settings override inherited values without losing menu steps', (t) => {
  const menuSteps = [{ key: 'Return', delayMs: 100 }];
  const config = loadFixture(t, {
    exe: '/games/quiplash2.exe',
    args: [],
    menuDelayMs: 0,
    menuSteps,
  });
  const resolved = resolveGame(config, '3', 'quiplash2');

  assert.equal(resolved.exe, '/games/quiplash2.exe');
  assert.deepEqual(resolved.args, []);
  assert.equal(resolved.menuDelayMs, 0);
  assert.equal(resolved.viaPackMenu, false);
  assert.deepEqual(resolved.menuSteps, menuSteps);
});

test('legacy games retain keys and default delay when menu steps are omitted', (t) => {
  const config = loadFixture(t, { keys: ['Down', 'Return'] }, { menuDelayMs: undefined });
  const resolved = resolveGame(config, '3', 'quiplash2');

  assert.equal(resolved.menuSteps, undefined);
  assert.deepEqual(resolved.keys, ['Down', 'Return']);
  assert.equal(resolved.menuDelayMs, 20_000);
});

test('menu steps accept an empty array and all supported keys at the limits', (t) => {
  const supportedKeys = ['Up', 'Down', 'Left', 'Right', 'Return', 'Escape', 'space', 'Tab'];
  const boundarySteps = Array.from({ length: 60 }, (_, index) => ({
    key: supportedKeys[index % supportedKeys.length],
    delayMs: index % 2 === 0 ? 0 : 300_000,
  }));

  for (const menuSteps of [[], boundarySteps]) {
    const config = loadFixture(t, { menuSteps });
    assert.deepEqual(resolveGame(config, '3', 'quiplash2').menuSteps, menuSteps);
  }
});

test('invalid menu steps are rejected with the affected game in the error', async (t) => {
  const cases = [
    ['null', null],
    ['an object', { key: 'Return', delayMs: 0 }],
    ['a string', 'Return'],
    ['more than 60 steps', Array.from({ length: 61 }, () => ({ key: 'Return', delayMs: 0 }))],
    ['a null step', [null]],
    ['a missing key', [{ delayMs: 0 }]],
    ['an unsupported key', [{ key: 'Enter', delayMs: 0 }]],
    ['an incorrectly cased key', [{ key: 'return', delayMs: 0 }]],
    ['a negative delay', [{ key: 'Return', delayMs: -1 }]],
    ['a fractional delay', [{ key: 'Return', delayMs: 0.5 }]],
    ['a delay above the maximum', [{ key: 'Return', delayMs: 300_001 }]],
    ['a missing delay', [{ key: 'Return' }]],
    ['a string delay', [{ key: 'Return', delayMs: '0' }]],
    ['a null delay', [{ key: 'Return', delayMs: null }]],
  ];

  for (const [name, menuSteps] of cases) {
    await t.test(name, (t) => {
      assert.throws(() => loadFixture(t, { menuSteps }), /"3\/quiplash2" has invalid menuSteps/);
    });
  }
});

test('aliases reject invalid names but allow an empty alias list', async (t) => {
  for (const aliases of ['Quipster', null, [''], ['?!'], [42], [null]]) {
    await t.test(JSON.stringify(aliases), (t) => {
      assert.throws(() => loadFixture(t, { aliases }), /"3\/quiplash2" aliases must be non-empty names/);
    });
  }
  assert.equal(resolveGame(loadFixture(t, { aliases: [] }), '3', 'quiplash2').game.key, 'quiplash2');
});
