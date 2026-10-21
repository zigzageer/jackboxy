'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const setup = path.resolve(__dirname, '..', 'jackbox-codex-setup');

// Exercise the actual helper with a temporary installation and executable
// stand-ins. No sudo, package download, API request, login or service is real.
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jackbox-codex-setup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = path.join(directory, 'installed app');
  const bot = path.join(app, 'repo', 'bot');
  const commands = path.join(directory, 'commands');
  const log = path.join(directory, 'commands.jsonl');
  const auth = path.join(directory, 'authenticated');
  const cliTemplate = path.join(directory, 'codex-template');
  fs.mkdirSync(bot, { recursive: true });
  fs.mkdirSync(commands);
  fs.writeFileSync(log, '');
  const originalEnv = 'DISCORD_TOKEN=private-test-bot-token\nDISCORD_CLIENT_ID=123\nJACKBOX_CONFIG=/games/custom.json\nSTREAM_FPS=24\nCODEX_ENABLED=false\nCODEX_BIN=/old/codex\nCODEX_HOME=/old/auth\nCODEX_ALLOW_RESTART=false\n';
  const envFile = path.join(bot, '.env');
  const gamesFile = path.join(bot, 'games.json');
  fs.writeFileSync(envFile, originalEnv, { mode: 0o600 });
  fs.writeFileSync(gamesFile, '{"custom":"unchanged game settings"}\n');
  const prelude = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const name = path.basename(process.argv[1]);
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({ name, args }) + '\\n');
`;
  function command(name, body) {
    const filename = path.join(commands, name);
    fs.writeFileSync(filename, prelude + body, { mode: 0o755 });
  }
  command('id', `process.stdout.write((args.length === 1 ? process.env.TEST_UID || '0' : '991') + '\\n');`);
  command('install', `
if (args[0] !== '-d') process.exit(99);
const mode = parseInt(args[args.indexOf('-m') + 1], 8);
const target = args.at(-1);
fs.mkdirSync(target, { recursive: true, mode });
fs.chmodSync(target, mode);
`);
  command('sudo', `
if (args[0] !== '-H' || args[1] !== '-u' || args[2] !== 'jackbox') process.exit(99);
if (process.env.TEST_NODE_UNSUPPORTED && args[3] === 'node') process.exit(1);
const child = spawnSync(args[3], args.slice(4), { stdio: 'inherit', env: process.env });
process.exit(child.status ?? 98);
`);
  command('npm', `
if (args[0] !== 'install' || !args.includes('@openai/codex@0.163.0')) process.exit(99);
if (process.env.TEST_NPM_FAIL) process.exit(1);
const prefix = args[args.indexOf('--prefix') + 1];
fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
fs.copyFileSync(process.env.TEST_CLI_TEMPLATE, path.join(prefix, 'bin', 'codex'));
fs.chmodSync(path.join(prefix, 'bin', 'codex'), 0o755);
`);
  command('chown', `if (args[0] !== 'jackbox:jackbox') process.exit(99);`);
  command('systemctl', `
if (JSON.stringify(args) !== JSON.stringify(['restart', 'jackbox-bot'])) process.exit(99);
if (process.env.TEST_RESTART_FAIL) process.exit(1);
`);
  fs.writeFileSync(cliTemplate, prelude + `
if (args[0] === '--version') {
  console.log(process.env.TEST_CLI_VERSION || 'codex-cli 0.163.0');
} else if (args[0] === 'login' && args[1] === 'status') {
  console.log('private-test-auth-status-secret');
  process.exit(fs.existsSync(process.env.TEST_AUTH) ? 0 : 1);
} else if (args[0] === 'login' && args[1] === '--device-auth') {
  if (process.env.TEST_LOGIN_FAIL) process.exit(1);
  if (!process.env.TEST_LOGIN_INCOMPLETE) fs.writeFileSync(process.env.TEST_AUTH, 'ready');
  console.log('Complete the device login in your browser.');
} else process.exit(99);
`, { mode: 0o755 });
  const environment = {
    ...process.env,
    PATH: `${commands}${path.delimiter}${process.env.PATH}`,
    JACKBOX_APP_DIR: app,
    JACKBOX_APP_USER: 'jackbox',
    TEST_LOG: log,
    TEST_AUTH: auth,
    TEST_CLI_TEMPLATE: cliTemplate,
    ...overrides,
  };
  return {
    app, bot, envFile, gamesFile, originalEnv, auth,
    run(extra = {}) {
      return spawnSync('bash', [setup], {
        encoding: 'utf8',
        env: { ...environment, ...extra },
        timeout: 10000,
      });
    },
    calls() { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); },
    assertUntouched() {
      assert.equal(fs.readFileSync(envFile, 'utf8'), originalEnv);
      assert.equal(fs.readFileSync(gamesFile, 'utf8'), '{"custom":"unchanged game settings"}\n');
      assert.equal(this.calls().some((call) => call.name === 'systemctl'), false);
      assert.equal(fs.readdirSync(bot).some((name) => name.startsWith('.env.codex.')), false);
    },
  };
}

test('installs and authenticates as jackbox before atomically enabling the owner-only command', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const settings = fs.readFileSync(f.envFile, 'utf8');
  for (const line of ['DISCORD_TOKEN=private-test-bot-token', 'DISCORD_CLIENT_ID=123', 'JACKBOX_CONFIG=/games/custom.json', 'STREAM_FPS=24']) {
    assert.ok(settings.includes(`${line}\n`));
  }
  assert.equal(settings.match(/^CODEX_ENABLED=/gm).length, 1);
  assert.ok(settings.includes('CODEX_ENABLED=true\n'));
  assert.ok(settings.includes(`CODEX_BIN=${f.app}/codex-cli/bin/codex\n`));
  assert.ok(settings.includes(`CODEX_HOME=${f.app}/home/.codex\n`));
  assert.ok(settings.includes('CODEX_ALLOW_RESTART=true\n'));
  assert.equal(fs.statSync(f.envFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(f.app, 'home', '.codex')).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(f.gamesFile, 'utf8'), '{"custom":"unchanged game settings"}\n');
  assert.equal(fs.readdirSync(f.bot).some((name) => name.startsWith('.env.codex.')), false);
  assert.ok(!result.stdout.includes('private-test-bot-token'));
  assert.ok(!result.stdout.includes('private-test-auth-status-secret'));
  assert.ok(!result.stderr.includes('private-test-auth-status-secret'));
  const calls = f.calls();
  const install = calls.find((call) => call.name === 'npm');
  assert.deepEqual(install.args, ['install', '--global', '--prefix', path.join(f.app, 'codex-cli'), '@openai/codex@0.163.0', '--no-audit', '--no-fund']);
  const sudoCalls = calls.filter((call) => call.name === 'sudo');
  assert.ok(sudoCalls.length >= 5);
  for (const call of sudoCalls) assert.deepEqual(call.args.slice(0, 3), ['-H', '-u', 'jackbox']);
  assert.ok(sudoCalls.some((call) => call.args.includes('--device-auth')));
  assert.deepEqual(calls.at(-1), { name: 'systemctl', args: ['restart', 'jackbox-bot'] });
  assert.ok(result.stdout.includes('573614648239194186'));
});

test('rerunning setup reuses the pinned CLI and the service account login', (t) => {
  const f = fixture(t);
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  const settings = fs.readFileSync(f.envFile, 'utf8');
  const second = f.run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(f.envFile, 'utf8'), settings);
  assert.equal(f.calls().filter((call) => call.name === 'npm').length, 1);
  assert.equal(f.calls().filter((call) => call.name === 'codex' && call.args.includes('--device-auth')).length, 1);
  assert.equal(f.calls().filter((call) => call.name === 'systemctl').length, 2);
});

for (const [name, overrides] of [
  ['package installation fails', { TEST_NPM_FAIL: '1' }],
  ['the installed version is unexpected', { TEST_CLI_VERSION: 'codex-cli 0.162.0' }],
  ['device login fails', { TEST_LOGIN_FAIL: '1' }],
  ['device login returns without authentication', { TEST_LOGIN_INCOMPLETE: '1' }],
  ['Node is too old', { TEST_NODE_UNSUPPORTED: '1' }],
]) {
  test(`does not enable Codex or restart the bot when ${name}`, (t) => {
    const f = fixture(t, overrides);
    const result = f.run();
    assert.notEqual(result.status, 0);
    f.assertUntouched();
    assert.ok(!result.stdout.includes('private-test-bot-token'));
    assert.ok(!result.stderr.includes('private-test-auth-status-secret'));
  });
}

test('requires sudo and an existing configured installation', (t) => {
  const f = fixture(t);
  const noSudo = f.run({ TEST_UID: '1000' });
  assert.notEqual(noSudo.status, 0);
  assert.ok(noSudo.stderr.includes('sudo'));
  f.assertUntouched();
  fs.unlinkSync(f.envFile);
  const noEnv = f.run();
  assert.notEqual(noEnv.status, 0);
  assert.ok(noEnv.stderr.includes('jackbox-config'));
  assert.equal(f.calls().some((call) => call.name === 'npm'), false);
  assert.equal(f.calls().some((call) => call.name === 'systemctl'), false);
});
