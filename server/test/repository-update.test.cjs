'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Exercise the installer's real Git block against local repositories, without
// running its privileged package installation or service configuration.
const installer = fs.readFileSync(path.resolve(__dirname, '..', 'install.sh'), 'utf8');
const blockStart = installer.indexOf('log "Fetching the bot ($BRANCH)"');
const blockEnd = installer.indexOf('sudo -u $APP_USER bash -c "cd $BOT_DIR && npm ci', blockStart);
assert.ok(blockStart >= 0 && blockEnd > blockStart, 'installer repository block exists');
const repositoryBlock = installer.slice(blockStart, blockEnd);
const branch = 'codex/browser-game-controls';
const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: 'file',
};

function git(directory, ...args) {
  const result = spawnSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    env: gitEnvironment,
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jackbox-repository-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const upstream = path.join(directory, 'upstream');
  const remote = path.join(directory, 'origin.git');
  const checkout = path.join(directory, 'installed');
  fs.mkdirSync(upstream);
  git(upstream, 'init', '-q', '--initial-branch=main');
  git(upstream, 'config', 'user.email', 'installer-test@example.invalid');
  git(upstream, 'config', 'user.name', 'Installer test');
  fs.mkdirSync(path.join(upstream, 'bot'));
  fs.writeFileSync(path.join(upstream, 'bot', '.gitignore'), '.env\ngames.json\n');
  fs.writeFileSync(path.join(upstream, 'version.txt'), 'main\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-qm', 'Initial main');
  git(upstream, 'clone', '-q', '--bare', upstream, remote);
  git(upstream, 'remote', 'add', 'origin', remote);
  git(upstream, 'checkout', '-qb', branch);
  fs.writeFileSync(path.join(upstream, 'version.txt'), 'browser controls\n');
  git(upstream, 'commit', '-qam', 'Browser controls');
  git(upstream, 'push', '-q', 'origin', branch);

  // This is the layout produced by the installer's original main install.
  git(upstream, 'clone', '-q', '--branch', 'main', '--single-branch', remote, checkout);
  const fetchRefspec = '+refs/heads/main:refs/remotes/origin/main';
  assert.equal(git(checkout, 'config', '--get', 'remote.origin.fetch'), fetchRefspec);
  assert.equal(git(checkout, 'branch', '--remotes', '--list', `origin/${branch}`), '');
  // Reproduce the old command: it downloads the commit into FETCH_HEAD but
  // leaves checkout's origin/<branch> target missing in a main-only clone.
  git(checkout, 'fetch', '-q', 'origin', branch);
  assert.equal(git(checkout, 'rev-parse', 'FETCH_HEAD'), git(upstream, 'rev-parse', 'HEAD'));
  assert.equal(git(checkout, 'branch', '--remotes', '--list', `origin/${branch}`), '');
  const settings = {
    '.env': 'DISCORD_TOKEN=local-test-placeholder\n',
    'games.json': '{"custom-game":{"path":"/local/games/custom.exe"}}\n',
  };
  for (const [name, contents] of Object.entries(settings)) {
    fs.writeFileSync(path.join(checkout, 'bot', name), contents);
  }
  assert.equal(git(checkout, 'status', '--porcelain'), '');

  return {
    upstream,
    checkout,
    run() {
      const result = spawnSync('bash', ['-c', `
set -euo pipefail
APP_USER=installer-test
log() { :; }
sudo() {
  [[ "$1" == -u && "$2" == "$APP_USER" ]]
  shift 2
  "$@"
}
${repositoryBlock}
`], {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...gitEnvironment, REPO_URL: remote, REPO_DIR: checkout, BRANCH: branch },
      });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
    },
    assertInstalled(expectedCommit, expectedContents) {
      assert.equal(git(checkout, 'branch', '--show-current'), branch);
      assert.equal(git(checkout, 'rev-parse', 'HEAD'), expectedCommit);
      assert.equal(git(checkout, 'rev-parse', `refs/remotes/origin/${branch}`), expectedCommit);
      assert.equal(fs.readFileSync(path.join(checkout, 'version.txt'), 'utf8'), expectedContents);
      for (const [name, contents] of Object.entries(settings)) {
        assert.equal(fs.readFileSync(path.join(checkout, 'bot', name), 'utf8'), contents);
        assert.equal(git(checkout, 'check-ignore', `bot/${name}`), `bot/${name}`);
      }
      assert.equal(git(checkout, 'status', '--porcelain'), '');
      assert.equal(git(checkout, 'config', '--get', 'remote.origin.fetch'), fetchRefspec);
    },
  };
}

test('switches a single-branch main installation to the requested branch and preserves local settings', (t) => {
  const f = fixture(t);
  const expectedCommit = git(f.upstream, 'rev-parse', 'HEAD');
  f.run();
  f.assertInstalled(expectedCommit, 'browser controls\n');
});

test('updates the requested branch on a rerun after its upstream advances', (t) => {
  const f = fixture(t);
  const initialCommit = git(f.upstream, 'rev-parse', 'HEAD');
  f.run();
  f.assertInstalled(initialCommit, 'browser controls\n');

  fs.writeFileSync(path.join(f.upstream, 'version.txt'), 'updated browser controls\n');
  git(f.upstream, 'commit', '-qam', 'Advance browser controls');
  git(f.upstream, 'push', '-q', 'origin', branch);
  const updatedCommit = git(f.upstream, 'rev-parse', 'HEAD');
  assert.notEqual(updatedCommit, initialCommit);
  f.run();
  f.assertInstalled(updatedCommit, 'updated browser controls\n');
});
