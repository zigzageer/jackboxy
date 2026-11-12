import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createMatchCommands, duelDefinition, warDefinition, gameLinkDefinition } from "../src/rpg/match-commands.mjs";
import { MatchState } from "../src/rpg/match-state.mjs";
import { MatchClient, MatchServiceError, normalizeMatch } from "../src/rpg/match-client.mjs";
import { FixtureMatchService } from "./fixtures/rpg-match-service.mjs";

const guildA = "111111111111111111";
const guildB = "222222222222222222";
const userA = "333333333333333333";
const userB = "444444444444444444";
const userC = "555555555555555555";
const userD = "666666666666666666";
const channelA = "777777777777777777";
const channelB = "888888888888888888";
let interactionSequence = 1000n;

function interaction({ commandName = "war", subcommand = "challenge", guildId = guildA, userId = userA, manager = false, values = {}, customId } = {}) {
  const edits = [];
  const result = {
    id: String(900000000000000000n + interactionSequence++), commandName, guildId,
    channelId: guildId === guildA ? channelA : channelB, customId, user: { id: userId },
    memberPermissions: { has: () => manager },
    guild: { members: { fetch: async id => ({ id }) } },
    options: { getSubcommand: () => subcommand, getString: name => values[name] ?? null,
      getInteger: name => values[name] ?? null, getUser: name => values[name] ?? null },
    deferred: false,
    async deferReply(options) { result.deferred = true; assert.equal(options.flags, 64); },
    async editReply(payload) { assert.equal(result.deferred, true); edits.push(payload); },
    edits,
  };
  return result;
}

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rpg-matches-"));
  let time = Date.parse("2026-11-12T12:00:00Z");
  const now = () => time;
  const databasePath = path.join(directory, "matches.sqlite");
  const roster = [
    { id: `discord-${userA}`, userId: userA, guildId: guildA },
    { id: `discord-${userB}`, userId: userB, guildId: guildA },
    { id: `discord-${userC}`, userId: userC, guildId: guildB },
    { id: `discord-${userD}`, userId: userD, guildId: guildB },
  ];
  const service = new FixtureMatchService({ now, roster, managers: [`${guildA}:${userA}`, `${guildB}:${userC}`] });
  for (const c of roster) service.linkCharacter({ ...c, characterId: c.id, interactionId: `fixture-link-${c.id}` });
  service.calls.length = 0;
  let state = new MatchState({ databasePath, now });
  state.registerGuild({ guildId: guildA, channelId: channelA });
  state.registerGuild({ guildId: guildB, channelId: channelB });
  const messages = [];
  const nonces = new Map();
  let failDelivery = false;
  const client = { channels: { fetch: async channelId => ({
    guildId: channelId === channelA ? guildA : guildB,
    async send(payload) {
      if (failDelivery) { failDelivery = false; throw new Error("fixture temporary Discord outage"); }
      assert.equal(payload.enforceNonce, true);
      if (nonces.has(payload.nonce)) return nonces.get(payload.nonce);
      const message = { id: String(messages.length + 1), channelId, payload };
      nonces.set(payload.nonce, message);
      messages.push(message);
      return message;
    },
  }) } };
  const logger = { error() {} };
  let controller = createMatchCommands({ service, state, client, now, pollMs: 1000, logger });
  t.after(async () => {
    await controller.stop();
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    service, messages, client, now,
    get state() { return state; }, get controller() { return controller; },
    advance(ms) { time += ms; },
    failNextDelivery() { failDelivery = true; },
    async restart() {
      await controller.stop();
      state.close();
      state = new MatchState({ databasePath, now });
      controller = createMatchCommands({ service, state, client, now, pollMs: 1000, logger });
    },
    async command(options) {
      const request = interaction(options);
      const before = service.calls.length;
      const originalPerform = service.perform;
      service.perform = function (...args) {
        assert.equal(request.deferred, true, "acknowledge before service mutation");
        return originalPerform.apply(this, args);
      };
      await controller.handle(request);
      service.perform = originalPerform;
      return { request, calls: service.calls.slice(before), text: request.edits.at(-1)?.content };
    },
  };
}

function useRawDuelResponses(f) {
  const rawSnapshot = match => ({
    id: match.id, kind: match.type,
    status: { pending: "offered", active: "running", completed: "finished", declined: "cancelled" }[match.status],
    createdAt: f.now(), joinUntil: null, minPlayersPerSide: 2,
    sides: [
      { guildId: guildA, name: "A", players: [{ id: "fighter-a", name: "A", hp: 20 }] },
      { guildId: guildA, name: "B", players: [{ id: "fighter-b", name: "B", hp: 20 }] },
    ],
    turnFighterId: match.turnUserId === userA ? "fighter-a" : "fighter-b",
    winnerSide: match.winnerUserId ? 0 : null,
    reason: null, replayUrl: match.replayUrl, events: [{ seq: match.revision, kind: "fixture" }],
  });
  for (const name of ["challengeDuel", "respondMatch", "useAbility", "getMatch"]) {
    const original = f.service[name].bind(f.service);
    f.service[name] = async payload => rawSnapshot(await original(payload));
  }
}

test("match slash definitions expose linking, duels, abilities and server wars", () => {
  assert.equal(gameLinkDefinition.name, "link");
  assert.deepEqual(duelDefinition.options.map(o => o.name), ["challenge", "ability", "attack", "status"]);
  assert.deepEqual(warDefinition.options.map(o => o.name), ["challenge", "status"]);
  assert.deepEqual(warDefinition.contexts, [0]);
});

test("linking uses requester identity and rejects another member’s roster character", async t => {
  const f = fixture(t);
  const denied = await f.command({ commandName: "game", subcommand: "link", values: { character: `discord-${userB}` } });
  assert.match(denied.text, /failed during character linking/);
  assert.match(denied.text, /another member or server/);
  assert.equal(denied.calls[0].payload.userId, userA);
  const linked = await f.command({ commandName: "game", subcommand: "link", values: { character: `discord-${userA}` } });
  assert.match(linked.text, /Linked your character/);
  assert.equal(linked.calls[0].payload.interactionId, linked.request.id);
});

test("duel target accepts, legal ability reaches shared result, and other identities are rejected", async t => {
  const f = fixture(t);
  const challenged = await f.command({ commandName: "duel", values: { user: { id: userB } } });
  const matchId = challenged.calls.find(c => c.action === "challengeDuel") && [...f.service.matches.keys()][0];
  assert.match(challenged.text, /waiting for acceptance/);
  assert.deepEqual(f.messages[0].payload.allowedMentions, { parse: [], users: [userB] });
  const wrong = await f.command({ customId: `mint:match:accept:${matchId}`, userId: userA });
  assert.match(wrong.text, /not eligible/);
  assert.equal(wrong.calls.some(c => c.action === "respondMatch"), false);
  const accepted = await f.command({ customId: `mint:match:accept:${matchId}`, userId: userB });
  assert.match(accepted.text, /active/);
  const illegal = await f.command({ commandName: "duel", subcommand: "ability", userId: userB, values: { match: matchId } });
  assert.match(illegal.text, /cannot use that ability on this turn/);
  assert.match(illegal.text, /ability action/);
  await f.command({ commandName: "duel", subcommand: "ability", values: { match: matchId } });
  await f.command({ commandName: "fight", subcommand: "ability", userId: userB, values: { match: matchId } });
  assert.match(f.messages.at(-1).payload.content, /Replay https:\/\/game.example\/replays\//);
  const crossGuild = await f.command({ commandName: "duel", subcommand: "status", guildId: guildB, userId: userC, values: { match: matchId } });
  assert.match(crossGuild.text, /could not be found/);
});

test("two-server war posts Join buttons, deduplicates joins and resumes its deadline after restart", async t => {
  const f = fixture(t);
  const challenged = await f.command({ manager: true, values: { server: guildB, minimum: 1 } });
  const matchId = [...f.service.matches.keys()][0];
  assert.match(challenged.text, /Signup starts when/);
  assert.equal(f.messages.length, 2);
  assert.equal(f.messages.find(m => m.channelId === channelA).payload.components.length, 0);
  assert.equal(f.messages.find(m => m.channelId === channelB).payload.components[0].components[0].label, "Accept war");
  const denied = await f.command({ customId: `mint:match:accept:${matchId}`, guildId: guildB, userId: userD });
  assert.match(denied.text, /not eligible/);
  await f.command({ customId: `mint:match:accept:${matchId}`, guildId: guildB, userId: userC, manager: true });
  const match = f.service.matches.get(matchId);
  assert.equal(Date.parse(match.signupDeadline) - f.now(), 120_000);
  assert.equal(f.messages.filter(m => m.payload.components?.[0]?.components[0]?.label === "Join war").length, 2);
  const join = await f.command({ customId: `mint:match:join:${matchId}` });
  await f.controller.handle(join.request);
  await f.command({ customId: `mint:match:join:${matchId}` });
  await f.command({ customId: `mint:match:join:${matchId}`, guildId: guildB, userId: userC });
  assert.deepEqual(match.teams.map(team => team.players.length), [1, 1]);
  f.advance(121_000);
  await f.restart();
  await f.controller.poll();
  assert.equal(f.service.matches.get(matchId).status, "completed");
  const results = f.messages.filter(m => m.payload.content.includes("Replay https://game.example/replays/"));
  assert.deepEqual(results.map(m => m.channelId).sort(), [channelA, channelB]);
  const count = f.messages.length;
  await f.controller.poll();
  assert.equal(f.messages.length, count);
  assert.equal(f.service.calls.filter(c => c.action === "finalizeWar").length, 1);
  for (const message of f.messages) assert.deepEqual(message.payload.allowedMentions.parse, []);
});

test("two-server war cancels below the minimum and reports cancellation in both channels", async t => {
  const f = fixture(t);
  await f.command({ manager: true, values: { server: guildB, minimum: 2 } });
  const matchId = [...f.service.matches.keys()][0];
  await f.command({ customId: `mint:match:accept:${matchId}`, guildId: guildB, userId: userC, manager: true });
  await f.command({ customId: `mint:match:join:${matchId}` });
  f.advance(120_000);
  await f.controller.poll();
  assert.equal(f.service.matches.get(matchId).status, "cancelled");
  assert.deepEqual(f.messages.filter(m => m.payload.content.includes("did not reach the minimum")).map(m => m.channelId).sort(), [channelA, channelB]);
});

test("persistent match notification retries delivery and recovers a sent-but-unrecorded message with its nonce", async t => {
  const f = fixture(t);
  f.failNextDelivery();
  await f.command({ commandName: "fight", values: { user: { id: userB } } });
  assert.equal(f.messages.length, 0);
  f.advance(1100);
  const originalSent = f.state.notificationSent.bind(f.state);
  f.state.notificationSent = () => { throw new Error("fixture crash before receipt checkpoint"); };
  await f.controller.poll();
  assert.equal(f.messages.length, 1);
  f.state.notificationSent = originalSent;
  f.advance(2100);
  await f.restart();
  await f.controller.poll();
  assert.equal(f.messages.length, 1);
  assert.equal(f.state.claimNotification(), null);
});

test("authoritative snapshots map phases, fighter turns and winners with persisted Discord identity", () => {
  const identity = { challengerUserId: userA, opponentUserId: userB };
  const raw = {
    id: "fixture-authoritative-duel", kind: "duel", status: "running", joinUntil: null, minPlayersPerSide: 2,
    sides: [
      { guildId: guildA, name: "First", players: [{ id: "fighter-a", name: "A", hp: 10 }] },
      { guildId: guildA, name: "Second", players: [{ id: "fighter-b", name: "B", hp: 10 }] },
    ],
    turnFighterId: "fighter-b", winnerSide: null, events: [{ seq: 3, kind: "attack" }],
  };
  const active = normalizeMatch(raw, identity);
  assert.equal(active.status, "active");
  assert.equal(active.turnUserId, userB);
  assert.equal(active.revision, 3);
  assert.equal(normalizeMatch(active).status, "active");
  const completed = normalizeMatch({ ...raw, status: "finished", winnerSide: 0 }, identity);
  assert.equal(completed.winnerUserId, userA);
  assert.equal(completed.status, "completed");
});

test("raw service snapshots retain duel acceptance identities and winner mapping across a bot restart", async t => {
  const f = fixture(t);
  useRawDuelResponses(f);
  await f.command({ commandName: "fight", values: { user: { id: userB } } });
  const matchId = [...f.service.matches.keys()][0];
  await f.restart();
  const accepted = await f.command({ customId: `mint:match:accept:${matchId}`, userId: userB });
  assert.match(accepted.text, new RegExp(userA));
  assert.equal(f.state.match(matchId).match.opponentUserId, userB);
  await f.command({ commandName: "fight", subcommand: "ability", values: { match: matchId } });
  const completed = await f.command({ commandName: "fight", subcommand: "ability", userId: userB, values: { match: matchId } });
  assert.match(completed.text, new RegExp(`${userA}> won`));
  assert.equal(f.messages.at(-1).payload.allowedMentions.users[0], userA);
});

test("equal-revision stale phases preserve advanced state and its notification outbox", t => {
  const f = fixture(t);
  const contexts = [{ guildId: guildA, channelId: channelA }];
  const pending = { id: "fixture-phase-race", type: "war", guildId: guildA, opponentGuildId: guildB, status: "pending", revision: 0 };
  const notice = event => [{ guildId: guildA, channelId: channelA, event, payload: { content: event } }];
  f.state.saveMatch(pending, contexts, notice("challenge"));
  f.state.saveMatch({ ...pending, status: "signup" }, contexts, notice("signup"));
  assert.equal(f.state.saveMatch(pending, contexts, notice("challenge")).status, "signup");
  assert.equal(f.state.match(pending.id).match.status, "signup");
  const signup = f.state.claimNotification();
  assert.equal(signup.event, "signup");
  f.state.notificationSent(signup.id, "signup-message");
  f.state.saveMatch({ ...pending, status: "active" }, contexts, notice("turn-0"));
  assert.equal(f.state.saveMatch({ ...pending, status: "signup" }, contexts, notice("signup")).status, "active");
  assert.equal(f.state.claimNotification().event, "turn-0");
  assert.equal(f.state.claimNotification(), null);
});

test("same interaction resumes a service-created challenge after bot persistence fails without duplicate posts", async t => {
  const f = fixture(t);
  useRawDuelResponses(f);
  const originalSave = f.state.saveMatch.bind(f.state);
  f.state.saveMatch = () => { throw new Error("fixture disk checkpoint failure"); };
  const challenged = await f.command({ commandName: "fight", values: { user: { id: userB } } });
  assert.match(challenged.text, /failed during match persistence/);
  assert.equal(f.messages.length, 0);
  assert.equal(f.service.matches.size, 1);
  f.state.saveMatch = originalSave;
  const matchId = [...f.service.matches.keys()][0];
  await f.service.respondMatch({ interactionId: "123456789012345679", guildId: guildA, userId: userB, matchId, accept: true });
  await f.restart();
  await f.controller.handle(challenged.request);
  const stored = f.state.match(matchId).match;
  assert.equal(stored.status, "active");
  assert.equal(stored.challengerUserId, userA);
  assert.equal(stored.opponentUserId, userB);
  assert.match(challenged.request.edits.at(-1).content, /active/);
  assert.equal(f.messages.length, 1);
  await f.controller.handle(challenged.request);
  assert.equal(f.service.matches.size, 1);
  assert.equal(f.messages.length, 1);
});

test("a challenge retry preserves one delayed notification after Discord delivery fails", async t => {
  const f = fixture(t);
  f.failNextDelivery();
  const challenged = await f.command({ commandName: "fight", values: { user: { id: userB } } });
  await f.controller.handle(challenged.request);
  assert.equal(f.messages.length, 0);
  f.advance(1100);
  await f.controller.poll();
  await f.controller.handle(challenged.request);
  assert.equal(f.service.matches.size, 1);
  assert.equal(f.messages.length, 1);
});

test("mismatched challenge responses never create a tracked match or public notification", async t => {
  const f = fixture(t);
  const original = f.service.challengeDuel.bind(f.service);
  for (const change of [
    { type: "war", opponentGuildId: guildB },
    { guildId: guildB },
    { opponentUserId: userD },
  ]) {
    f.service.challengeDuel = payload => ({ ...original(payload), ...change });
    const response = await f.command({ commandName: "fight", values: { user: { id: userB } } });
    assert.match(response.text, /failed during duel challenge/);
  }
  assert.equal(f.state.activeMatches().length, 0);
  assert.equal(f.messages.length, 0);
});

test("HTTPS match adapter signs exact request bytes, preserves request IDs and surfaces retry conflicts", async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rpg-match-https-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keyPath = path.join(directory, "key.pem");
  const certPath = path.join(directory, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
    "-out", certPath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  const secret = "fixture-match-signing-secret";
  const calls = [];
  const seen = new Map();
  const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const expected = createHmac("sha256", secret)
      .update([request.method, request.url, request.headers["x-mint-ip"], request.headers["x-mint-time"]].join("\n") + "\n")
      .update(body).digest("hex");
    assert.equal(request.headers["x-mint-signature"], expected);
    assert.equal(request.headers["x-mint-ip"], "127.0.0.1");
    calls.push({ method: request.method, path: request.url, body: body.toString("utf8") });
    const payload = body.length ? JSON.parse(body.toString("utf8")) : {};
    response.setHeader("content-type", "application/json");
    if (payload.action === "ability") {
      response.statusCode = 409;
      response.end(JSON.stringify({ error: "This fighter is acting out of turn." }));
      return;
    }
    if (payload.requestId && seen.has(payload.requestId) && seen.get(payload.requestId) !== body.toString("utf8")) {
      response.statusCode = 409;
      response.end(JSON.stringify({ error: "Request ID already used for another action." }));
      return;
    }
    if (payload.requestId) seen.set(payload.requestId, body.toString("utf8"));
    if (payload.kind === "duel") {
      response.end(JSON.stringify({ id: "unexpected-war", kind: "war", status: "offered",
        sides: [{ guildId: guildA, players: [] }, { guildId: guildB, players: [] }] }));
      return;
    }
    response.end(JSON.stringify({ guildId: guildA, userId: userA, characterId: `discord-${userA}` }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new MatchClient({ origin: `https://127.0.0.1:${server.address().port}`, secret, ca: readFileSync(certPath) });
  const payload = { interactionId: "123456789012345678", guildId: guildA, userId: userA, characterId: `discord-${userA}` };
  assert.equal((await client.linkCharacter(payload)).characterId, `discord-${userA}`);
  await client.linkCharacter(payload);
  await client.getLink({ guildId: guildA, userId: userA });
  assert.equal(calls[0].path, "/internal/v1/links");
  assert.deepEqual(JSON.parse(calls[0].body), { requestId: payload.interactionId, guildId: guildA, userId: userA, characterId: payload.characterId });
  assert.equal(calls[2].body, "");
  await assert.rejects(() => client.linkCharacter({ ...payload, characterId: "changed" }), error => error.code === "RETRY_CONFLICT");
  await assert.rejects(() => client.useAbility({ ...payload, interactionId: "987654321098765432", matchId: "fixture-duel" }), error => /cannot use/.test(error.message));
  await assert.rejects(() => client.challengeDuel({ ...payload, interactionId: "987654321098765433", opponentUserId: userB }), error => error.code === "INVALID_RESPONSE");
  await assert.rejects(() => client.getMatch({ matchId: "fixture-duel" }), error => error.code === "INVALID_RESPONSE");
  await assert.rejects(() => client.linkCharacter({ ...payload, userId: userB, characterId: `discord-${userB}`, interactionId: "987654321098765434" }), error => error.code === "INVALID_RESPONSE");
  assert.throws(() => new MatchClient({ origin: "http://outside.example" }), /HTTPS/);
  await assert.rejects(() => new MatchClient().linkCharacter(payload), MatchServiceError);
});
