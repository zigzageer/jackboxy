'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const helper = path.resolve(__dirname, '..', 'jackbox-discover');

function fixture(t, config = { packs: {} }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jackbox-discover-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'games');
  fs.mkdirSync(root);
  const configPath = path.join(directory, 'existing.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return {
    root, directory, configPath,
    exe(relative) {
      const filename = path.join(root, relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, 'fixture, never executed');
      return filename;
    },
    run(...args) {
      return spawnSync(process.execPath, [helper, '--root', root, '--config', configPath, ...args], { encoding: 'utf8' });
    },
  };
}

test('discovers real nested executables with spaces and omits missing packs', (t) => {
  const f = fixture(t);
  const pack3 = f.exe('The Jackbox Party Pack 3 - ENG/The Jackbox Party Pack 3 - ENG/The Jackbox Party Pack 3.exe');
  const pack1 = f.exe('First Pack/THE JACKBOX PARTY PACK.EXE');
  f.exe('Pack3-looking-folder/uninstall.exe');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const generated = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(generated.packs), ['1', '3']);
  assert.equal(generated.packs['3'].exe, pack3);
  assert.equal(generated.packs['1'].exe, pack1);
  assert.deepEqual(generated.runner, ['wine']);
  assert.deepEqual(generated.packs['3'].games.quiplash2.aliases, ['quiplash']);
});

test('preserves custom game keys, aliases, menu steps and config settings without editing input', (t) => {
  const saved = {
    runner: ['custom-wine', '--flag'],
    customSetting: true,
    packs: {
      three: {
        name: 'The Jackbox Party Pack 3', menuDelayMs: 31000, args: ['saved'],
        games: {
          myQuiplash: {
            name: 'Quiplash 2', aliases: ['quip'], keys: ['Down', 'Return'],
            menuSteps: [{ key: 'Down', delayMs: 18000 }, { key: 'Return', delayMs: 200 }],
          },
          customGame: { name: 'Custom game', keys: ['Return'] },
        },
      },
      absent: { name: 'Pack absent from disk', games: {} },
    },
  };
  const f = fixture(t, saved);
  f.exe('Nested/The Jackbox Party Pack 3.exe');
  const original = fs.readFileSync(f.configPath, 'utf8');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const generated = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(generated.packs), ['three']);
  assert.deepEqual(generated.runner, saved.runner);
  assert.equal(generated.customSetting, true);
  assert.equal(generated.packs.three.menuDelayMs, 31000);
  assert.deepEqual(generated.packs.three.args, ['saved']);
  const game = generated.packs.three.games.myQuiplash;
  assert.deepEqual(game.keys, saved.packs.three.games.myQuiplash.keys);
  assert.deepEqual(game.menuSteps, saved.packs.three.games.myQuiplash.menuSteps);
  assert.deepEqual(game.aliases, ['quiplash', 'quip', 'quiplash2']);
  assert.equal(generated.packs.three.games.quiplash2, undefined);
  assert.deepEqual(generated.packs.three.games.customGame, saved.packs.three.games.customGame);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
});

test('writes a new output file and refuses to overwrite it or the source config', (t) => {
  const f = fixture(t);
  f.exe('The Jackbox Party Pack 3.exe');
  const output = path.join(f.directory, 'new.json');
  const first = f.run('--output', output);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, '');
  const saved = fs.readFileSync(output, 'utf8');
  assert.equal(JSON.parse(saved).packs['3'].name, 'The Jackbox Party Pack 3');
  const second = f.run('--output', output);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /EEXIST/);
  assert.equal(fs.readFileSync(output, 'utf8'), saved);
  assert.equal(f.run('--output', f.configPath).status, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, 'utf8')), { packs: {} });
});

test('fails on ambiguous duplicates and preserves an existing choice when available', (t) => {
  const f = fixture(t);
  f.exe('One/The Jackbox Party Pack 3.exe');
  const selected = f.exe('Two/The Jackbox Party Pack 3.exe');
  const ambiguous = f.run();
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /Multiple executables/);
  assert.equal(ambiguous.stdout, '');
  fs.writeFileSync(f.configPath, JSON.stringify({ packs: { 3: { exe: selected, games: {} } } }));
  const selectedResult = f.run();
  assert.equal(selectedResult.status, 0, selectedResult.stderr);
  assert.equal(JSON.parse(selectedResult.stdout).packs['3'].exe, selected);
});

test('never claims unsupported or absent packs are installed', (t) => {
  const f = fixture(t);
  f.exe('The Jackbox Party Pack 10.exe');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).packs, {});
  assert.match(result.stderr, /Skipping pack 10/);
  assert.match(result.stderr, /Found 0/);
});

test('accepts a positional root and rejects missing config or root paths', (t) => {
  const f = fixture(t);
  f.exe('The Jackbox Party Pack 7.exe');
  const positional = spawnSync(process.execPath, [helper, f.root, '--config', f.configPath], { encoding: 'utf8' });
  assert.equal(positional.status, 0, positional.stderr);
  assert.deepEqual(Object.keys(JSON.parse(positional.stdout).packs), ['7']);
  const missing = f.run('--config', path.join(f.directory, 'missing.json'));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Config does not exist/);
  assert.equal(f.run('--root', path.join(f.directory, 'absent')).status, 1);
});

test('ignores directory symlinks instead of traversing outside the selected root', (t) => {
  const f = fixture(t);
  const outside = path.join(f.directory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'The Jackbox Party Pack 3.exe'), 'fixture');
  fs.symlinkSync(outside, path.join(f.root, 'linked-folder'), 'dir');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).packs, {});
});
