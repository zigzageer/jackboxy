'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

// Run the installer's real download/verify/extract block with local downloads
// and an isolated install destination. Never run the privileged VPS installer.
const installer = fs.readFileSync(path.resolve(__dirname, '..', 'install.sh'), 'utf8');
const mediaBlock = installer.slice(
  installer.indexOf('log "Installing MediaMTX $MEDIAMTX_VERSION"'),
  installer.indexOf('# Small servers'),
);
assert.ok(mediaBlock.includes('sha256sum --strict --check'));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jackbox-install-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const release = path.join(directory, 'release');
  const destination = path.join(directory, 'installed');
  const runtime = path.join(directory, 'runtime');
  for (const target of [source, release, destination, runtime]) fs.mkdirSync(target);
  const contents = 'MediaMTX binary fixture; never executed\n';
  fs.writeFileSync(path.join(source, 'mediamtx'), contents);
  const archiveName = 'mediamtx_vfixture_linux_amd64.tar.gz';
  const archive = path.join(release, archiveName);
  const packed = spawnSync('tar', ['-czf', archive, '-C', source, 'mediamtx'], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const checksum = `${digest}  ${archiveName}\n`;
  const checksums = path.join(release, 'checksums.sha256');
  fs.writeFileSync(checksums, `${'0'.repeat(64)}  another-platform.tar.gz\n${checksum}`);
  return {
    archive, source, checksum, checksums, runtime,
    installed: path.join(destination, 'mediamtx'),
    contents,
    run() {
      return spawnSync('bash', ['-c', `
set -euo pipefail
MEDIAMTX_VERSION=vfixture
log() { :; }
curl() {
  [[ "$1" == -fsSL && "$3" == -o ]]
  case "$2" in https://github.com/bluenviron/mediamtx/releases/download/vfixture/*) ;; *) return 42;; esac
  cp -- "$FIXTURE_RELEASE_DIR/\${2##*/}" "$4"
}
install() {
  [[ "$1" == -m && "$2" == 0755 && "$4" == /usr/local/bin/mediamtx ]]
  cp -- "$3" "$FIXTURE_INSTALL_DIR/mediamtx"
}
${mediaBlock}
`], {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: runtime, FIXTURE_RELEASE_DIR: release, FIXTURE_INSTALL_DIR: destination },
      });
    },
  };
}

test('verifies the selected official checksum before extracting and installing', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mediamtx_vfixture_linux_amd64.tar.gz: OK/);
  assert.equal(fs.readFileSync(f.installed, 'utf8'), f.contents);
  assert.deepEqual(fs.readdirSync(f.runtime), []);
});

test('rejects a modified but valid archive without installing it and cleans up', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, 'mediamtx'), 'modified binary fixture');
  const packed = spawnSync('tar', ['-czf', f.archive, '-C', f.source, 'mediamtx'], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /FAILED/);
  assert.equal(fs.existsSync(f.installed), false);
  assert.deepEqual(fs.readdirSync(f.runtime), []);
});

test('rejects a checksum list that omits the selected archive', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.checksums, `${'0'.repeat(64)}  another-platform.tar.gz\n`);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected exactly one checksum/);
  assert.equal(fs.existsSync(f.installed), false);
  assert.deepEqual(fs.readdirSync(f.runtime), []);
});

test('rejects duplicate selected-archive checksum entries', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.checksums, f.checksum.repeat(2));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected exactly one checksum/);
  assert.equal(fs.existsSync(f.installed), false);
  assert.deepEqual(fs.readdirSync(f.runtime), []);
});
