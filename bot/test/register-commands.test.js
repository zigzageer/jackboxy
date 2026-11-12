import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const registrationSource = fs.readFileSync(new URL('../src/register-commands.js', import.meta.url), 'utf8');
const definitions = ['jackbox', 'jackbox-stop', 'jackbox-key', 'jackbox-screen', 'jackbox-code']
  .map((name) => ({ name, type: 1, description: `${name} description`, dm_permission: false,
    ...(name === 'jackbox' ? { options: [{ name: 'pack', type: 3, required: true, autocomplete: true }] } : {}) }));
const globalRoute = '/applications/application-a/commands';
const guildRoute = `${globalRoute.replace('/commands', '')}/guilds/guild-a/commands`;
const otherGuildRoute = `${globalRoute.replace('/commands', '')}/guilds/guild-b/commands`;
const existing = [
  { id: 'weather-id', name: 'weather', type: 1, description: 'Keep this command' },
  { id: 'user-id', name: 'jackbox', type: 2 },
  { id: 'message-id', name: 'Quote', type: 3 },
  { id: 'jackbox-id', name: 'jackbox', type: 1, description: 'Old definition' },
];

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jackbox-registration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(directory, 'register-commands.js'), registrationSource);
  fs.writeFileSync(path.join(directory, 'commands.js'), `export const definitions = ${JSON.stringify(definitions)};`);
  for (const [name, entry, source] of [
    ['dotenv', './config', ''],
    ['discord.js', '.', `
      import fs from 'node:fs';
      const record = (method, route, body) => fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({method, route, body})+'\\n');
      export const Routes = {
        applicationCommands: (app) => '/applications/'+app+'/commands',
        applicationGuildCommands: (app, guild) => '/applications/'+app+'/guilds/'+guild+'/commands',
      };
      export class REST {
        setToken() { return this; }
        async post(route, {body}) {
          record('POST', route, body);
          if (body.name === process.env.TEST_FAIL_COMMAND) {
            const error = new Error('Fixture API failure with '+process.env.DISCORD_TOKEN);
            error.requestBody = {privateToken: process.env.DISCORD_TOKEN};
            throw error;
          }
          const state = JSON.parse(fs.readFileSync(process.env.TEST_STATE, 'utf8'));
          const commands = state[route] ||= [];
          const previous = commands.findIndex((command) => command.name === body.name && command.type === (body.type ?? 1));
          if (previous < 0) commands.push({...body, id: body.name+'-id'});
          else commands[previous] = {...body, id: commands[previous].id};
          fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(state));
        }
        async put(route, {body}) {
          record('PUT', route, body);
          const state = JSON.parse(fs.readFileSync(process.env.TEST_STATE, 'utf8'));
          state[route] = body;
          fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(state));
        }
        async delete(route) { record('DELETE', route); throw new Error('Unexpected command deletion'); }
      }
    `],
  ]) {
    const moduleDirectory = path.join(directory, 'node_modules', name);
    fs.mkdirSync(moduleDirectory, { recursive: true });
    fs.writeFileSync(path.join(moduleDirectory, 'package.json'), JSON.stringify({ type: 'module', exports: { [entry]: './index.js' } }));
    fs.writeFileSync(path.join(moduleDirectory, 'index.js'), source);
  }
  const log = path.join(directory, 'calls.jsonl');
  const stateFile = path.join(directory, 'state.json');
  const initial = { [globalRoute]: existing, [guildRoute]: existing, [otherGuildRoute]: existing };
  fs.writeFileSync(stateFile, JSON.stringify(initial));
  return {
    initial,
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
    state: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    run(env = {}) {
      const stdoutFile = path.join(directory, 'stdout.txt');
      const stderrFile = path.join(directory, 'stderr.txt');
      const stdout = fs.openSync(stdoutFile, 'w');
      const stderr = fs.openSync(stderrFile, 'w');
      let result;
      try {
        result = spawnSync(process.execPath, ['register-commands.js'], {
          cwd: directory, timeout: 5000, stdio: ['ignore', stdout, stderr],
          // Explicit fixture environment: never load real credentials or make API calls.
          env: { DISCORD_TOKEN: 'fixture-private-token', DISCORD_CLIENT_ID: 'application-a',
            TEST_LOG: log, TEST_STATE: stateFile, ...env },
        });
      } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
      assert.ifError(result.error);
      return { ...result, stdout: fs.readFileSync(stdoutFile, 'utf8'), stderr: fs.readFileSync(stderrFile, 'utf8') };
    },
  };
}

for (const guild of ['', 'guild-a']) {
  test(`registration upserts its definitions ${guild ? 'in the selected guild' : 'globally'} and preserves other commands`, (t) => {
    const f = fixture(t);
    const route = guild ? guildRoute : globalRoute;
    const run = f.run({ DISCORD_GUILD_ID: guild });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(f.calls(), definitions.map((body) => ({ method: 'POST', route, body })));
    const state = f.state();
    assert.deepEqual(state[route].slice(0, 3), existing.slice(0, 3), 'unrelated slash, user and message commands survive');
    assert.deepEqual(state[route].find((command) => command.id === 'jackbox-id'), { ...definitions[0], id: 'jackbox-id' });
    assert.equal(state[route].length, existing.length + definitions.length - 1);
    for (const other of [globalRoute, guildRoute, otherGuildRoute].filter((value) => value !== route)) {
      assert.deepEqual(state[other], f.initial[other], 'other registration scopes are untouched');
    }
    assert.match(run.stdout, /Registered 5 command\(s\)/);
  });
}

test('missing bot token or application ID fails before any command request', (t) => {
  for (const missing of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID']) {
    const f = fixture(t);
    const run = f.run({ [missing]: '' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Set DISCORD_TOKEN and DISCORD_CLIENT_ID/);
    assert.deepEqual(f.calls(), []);
    assert.deepEqual(f.state(), f.initial);
  }
});

test('a failed upsert stops registration, preserves other commands and does not print request credentials', (t) => {
  const f = fixture(t);
  const run = f.run({ TEST_FAIL_COMMAND: definitions[1].name });
  assert.equal(run.status, 1);
  assert.deepEqual(f.calls(), definitions.slice(0, 2).map((body) => ({ method: 'POST', route: globalRoute, body })));
  assert.deepEqual(f.state()[globalRoute].slice(0, 3), existing.slice(0, 3));
  assert.match(run.stderr, /Command registration failed: Fixture API failure with \[redacted\]/);
  assert.doesNotMatch(run.stderr, /fixture-private-token|privateToken|requestBody/);
  assert.doesNotMatch(run.stdout, /Registered/);
});
