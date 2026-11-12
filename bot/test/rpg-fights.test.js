import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Collection, MessageFlags, PermissionFlagsBits } from "discord.js";
import { MatchClient, MatchServiceError } from "../src/rpg/match-client.mjs";
import { createFightCommands } from "../src/rpg/fight-commands.mjs";
import { FightDelivery } from "../src/rpg/fight-delivery.mjs";

const guildId = "111111111111111111";
const userId = "222222222222222222";
const opponentUserId = "333333333333333333";
const channelId = "444444444444444444";
const interactionId = "555555555555555555";
const messageId = "666666666666666666";
const botId = "777777777777777777";
const matchId = "b27322c0-9486-4d3c-bfa3-af700332a6f2";
const characterId = `discord-${userId}`;
const identity = { interactionId, guildId, userId, opponentUserId };
const replayUrl = `https://mint.example/wars/${matchId}`;
const bytes = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const result = {
  match: { id: matchId, kind: "duel", mode: "auto", status: "finished", winnerSide: 1, replayUrl,
    sides: [{ guildId, players: [{ name: "Fennel" }] }, { guildId, players: [{ name: "Mint" }] }], events: [] },
  score: { awarded: 1, winnerUserId: opponentUserId },
};
const rankings = [{ rank: 1, userId: opponentUserId, name: "Mint", wins: 3, losses: 2, points: 2 }];

function interaction({ action = null, character = null, scope = null, target = { id: opponentUserId },
  member = target, manager = false, attach = true, send = true, limit = 128, focused = "", ...overrides } = {}) {
  const request = {
    commandName: "fight", id: interactionId, guildId, channelId, user: { id: userId },
    attachmentSizeLimit: limit,
    memberPermissions: { has: bit => bit === PermissionFlagsBits.ManageGuild && manager },
    appPermissions: { has: bit => bit === PermissionFlagsBits.AttachFiles ? attach : send },
    options: {
      getSubcommand: () => action,
      getUser: () => target,
      getMember: () => member,
      getString: name => name === "scope" ? scope : character,
      getFocused: () => ({ name: "character", value: focused }),
    },
    async deferReply(payload) {
      assert.equal(payload.flags, MessageFlags.Ephemeral);
      request.deferred = true;
    },
    async editReply(payload) {
      assert.equal(request.deferred, true);
      assert.deepEqual(payload.allowedMentions, { parse: [] });
      request.response = payload.content;
    },
    ...overrides,
  };
  return request;
}

function fixture(t, { persistent = false } = {}) {
  const directory = persistent ? mkdtempSync(path.join(tmpdir(), "mint-fight-delivery-")) : null;
  const databasePath = persistent ? path.join(directory, "jobs.sqlite") : ":memory:";
  let time = 100_000;
  const now = () => time;
  const posts = new Collection();
  const edits = [];
  const calls = [];
  const gifRequests = [];
  const service = {
    async startFight(payload) { calls.push(payload); return result; },
    async getFightGif(options) { gifRequests.push(options); return { status: "ready", bytes }; },
  };
  const channel = {
    guildId,
    messages: {
      async fetch() { return posts; },
      async edit(id, payload) { assert.ok(posts.has(id)); edits.push({ id, ...payload }); },
    },
    async send(payload) {
      assert.equal(payload.nonce, interactionId);
      assert.equal(payload.enforceNonce, true);
      assert.deepEqual(payload.allowedMentions, { parse: [] });
      const message = { id: messageId, content: payload.content, author: { id: botId }, createdTimestamp: now() };
      posts.set(messageId, message);
      return message;
    },
  };
  const client = { user: { id: botId }, channels: { fetch: async id => {
    assert.equal(id, channelId);
    return channel;
  } } };
  const open = () => new FightDelivery({ databasePath, service, client, now, logger: { error() {} } });
  let delivery = open();
  t.after(async () => {
    await delivery.stop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  return {
    channel, service, posts, edits, calls, gifRequests,
    get delivery() { return delivery; },
    advance(ms) { time += ms; },
    async restart() { await delivery.stop(); delivery = open(); },
    async command(overrides) {
      const request = interaction(overrides);
      const commands = createFightCommands({ service, delivery });
      await commands.handle(request);
      return request;
    },
  };
}

test("automatic fight acknowledges privately, posts once, then edits that message with a GIF", async t => {
  const f = fixture(t);
  const request = interaction();
  const start = f.service.startFight;
  f.service.startFight = payload => {
    assert.equal(request.deferred, true);
    return start(payload);
  };
  const ready = f.service.getFightGif;
  f.service.getFightGif = async options => {
    f.service.getFightGif = ready;
    assert.equal(options.maxBytes, 128);
    return { status: "queued" };
  };
  const commands = createFightCommands({ service: f.service, delivery: f.delivery });
  await commands.handle(request);
  assert.deepEqual(f.calls, [identity]);
  assert.match(request.response, new RegExp(messageId));
  assert.match(f.posts.first().content, new RegExp(matchId));
  await f.delivery.poll();
  assert.equal(f.edits.length, 0);
  f.advance(1_500);
  await f.delivery.poll();
  assert.equal(f.edits.length, 1);
  const edit = f.edits[0];
  assert.equal(edit.id, messageId);
  assert.match(edit.content, /Mint.*defeated.*Fennel.*1 leaderboard point/);
  assert.ok(edit.content.includes(replayUrl));
  assert.deepEqual(edit.allowedMentions, { parse: [] });
  assert.deepEqual(edit.attachments, []);
  assert.deepEqual(edit.files, [{ attachment: bytes, name: `fight-${matchId}.gif` }]);
  await commands.handle(request);
  assert.equal(f.calls.length, 1);
  assert.equal(f.posts.size, 1);
});

test("fight replays the signed request after losing the service reply and recovers an unrecorded Discord message", async t => {
  const f = fixture(t, { persistent: true });
  let simulations = 0;
  const cache = new Map();
  f.service.startFight = async payload => {
    f.calls.push(payload);
    if (!cache.has(payload.interactionId)) {
      simulations++;
      cache.set(payload.interactionId, result);
      throw new Error("Service closed after committing the fight.");
    }
    return cache.get(payload.interactionId);
  };
  const send = f.channel.send;
  let sends = 0;
  f.channel.send = async payload => {
    sends++;
    await send(payload);
    throw new Error("Discord closed after creating the status message.");
  };
  assert.match((await f.command()).response, /Fight queued/);
  assert.equal(f.posts.size, 0);
  await f.restart();
  f.advance(1_000);
  await f.delivery.poll();
  assert.equal(simulations, 1);
  assert.deepEqual(f.calls, [identity, identity]);
  assert.equal(f.posts.size, 1);
  assert.equal(f.delivery.get(interactionId).messageId, null);
  assert.equal(f.delivery.get(interactionId).result.matchId, matchId);

  await f.restart();
  f.advance(65_000);
  await f.delivery.poll();
  assert.equal(sends, 1);
  assert.equal(f.delivery.get(interactionId).messageId, messageId);
  await f.restart();
  await f.delivery.poll();
  assert.equal(f.edits[0].id, messageId);
  assert.equal(f.edits[0].files[0].attachment, bytes);
  assert.equal(f.delivery.get(interactionId).finished, true);
  assert.equal(simulations, 1);
});

test("guild, opponent, eligibility and channel failures stay in the private response", async t => {
  const f = fixture(t);
  for (const [options, pattern] of [
    [{ guildId: null }, /in a server/],
    [{ target: { id: "invalid" } }, /another person/],
    [{ target: { id: userId } }, /another person/],
    [{ target: { id: opponentUserId, bot: true } }, /another person/],
    [{ member: null }, /not a member/],
    [{ send: false }, /can send messages/],
  ]) assert.match((await f.command(options)).response, pattern);
  assert.equal(f.calls.length, 0);
  f.service.startFight = async () => { throw new MatchServiceError("SERVICE_ERROR", 409, "Enable your fighter with /fighter set first."); };
  assert.match((await f.command()).response, /\/fighter set/);
  assert.equal(f.posts.size, 0);
  assert.equal(f.delivery.get(interactionId).finished, true);
});

for (const failure of ["missing permission", "too large", "unavailable", "render deadline", "upload rejected"]) {
  test(`fight edits the saved message with winner and replay when GIF delivery hits ${failure}`, async t => {
    const f = fixture(t);
    if (failure === "unavailable") f.service.getFightGif = async () => ({ status: "unavailable" });
    if (failure === "render deadline") f.service.getFightGif = async () => ({ status: "queued" });
    if (failure === "upload rejected") {
      const edit = f.channel.messages.edit;
      f.channel.messages.edit = async (id, payload) => {
        if (payload.files) throw Object.assign(new Error("File exceeds the upload limit"), { code: 40005 });
        return edit(id, payload);
      };
    }
    await f.command({ attach: failure !== "missing permission", limit: failure === "too large" ? bytes.length - 1 : 128 });
    await f.delivery.poll();
    if (failure === "render deadline") {
      assert.equal(f.edits.length, 0);
      f.advance(45_000);
      await f.delivery.poll();
    }
    assert.equal(f.edits.length, 1);
    assert.equal(f.edits[0].id, messageId);
    assert.match(f.edits[0].content, /Mint.*1 leaderboard point/);
    assert.ok(f.edits[0].content.includes(replayUrl));
    assert.equal(f.edits[0].files, undefined);
    assert.equal(f.delivery.get(interactionId).finished, true);
    if (failure === "missing permission") assert.equal(f.gifRequests.length, 0);
  });
}

test("fighter commands manage permissions, default selection and autocomplete without pinging", async t => {
  const f = fixture(t);
  const changes = [];
  f.service.changeFighter = async input => {
    changes.push(input);
    return { userId: input.memberId ?? userId, name: "Fennel", characterId, enabled: input.action === "set" };
  };
  f.service.getFighter = async input => {
    assert.equal(input.userId, userId);
    return { choices: [{ id: characterId, name: "Fennel" }] };
  };
  f.service.listFighters = async input => {
    assert.equal(input.guildId, guildId);
    return [{ id: characterId, name: "Fennel" }, { id: "mage", name: "Mage" }];
  };
  f.service.getLeaderboard = async ({ guildId: guild, scope }) => {
    assert.equal(guild, guildId);
    return scope === "global" ? rankings : [];
  };
  const commands = createFightCommands({ service: f.service, delivery: f.delivery });
  const fighter = { commandName: "fighter" };
  assert.match((await f.command({ ...fighter, action: "assign", character: characterId })).response, /Manage Server/);
  assert.equal(changes.length, 0);
  assert.match((await f.command({ ...fighter, action: "set" })).response, /opted in.*Fennel/);
  assert.equal(changes[0].characterId, undefined);
  assert.match((await f.command({ ...fighter, action: "assign", manager: true, character: characterId })).response, /Assigned.*Fennel.*fighter set/);
  assert.equal(changes[1].manageGuild, true);
  assert.equal(changes[1].memberId, opponentUserId);
  assert.match((await f.command({ ...fighter, action: "pause" })).response, /paused/);
  assert.deepEqual(await commands.autocomplete(interaction({ ...fighter, action: "assign" })), []);
  assert.deepEqual(await commands.autocomplete(interaction({ ...fighter, action: "assign", manager: true, focused: "mag" })),
    [{ name: "Mage", value: "mage" }]);
  assert.deepEqual(await commands.autocomplete(interaction({ ...fighter, action: "set", focused: "fen" })),
    [{ name: "Fennel", value: characterId }]);
  assert.match((await f.command({ commandName: "leaderboard", scope: "global" })).response, /Global leaderboard.*\n.*1\..*Mint.*3 W \/ 2 L.*2 pts/);
  assert.match((await f.command({ commandName: "leaderboard", scope: "server" })).response, /No fights recorded/);
  assert.equal(f.posts.size, 0);
});

test("signed client preserves fight scores and validates GIF size and content on the new routes", async () => {
  const secret = "fixture-secret";
  const signed = [];
  let gifResponse = [202, { status: "queued" }];
  let fightResponse = [201, result];
  const selection = { userId, characterId, name: "Fennel", enabled: true };
  const choices = [{ id: characterId, name: "Fennel" }];
  const routes = new Map([
    ["/internal/v1/fighters", () => [200, selection]],
    [`/internal/v1/fighters/${guildId}`, () => [200, { characters: choices }]],
    [`/internal/v1/fighters/${guildId}/${userId}`, () => [200, { ...selection, choices }]],
    ["/internal/v1/fights", () => fightResponse],
    [`/internal/v1/fights/${matchId}/gif`, () => gifResponse],
    ["/internal/v1/leaderboards/global", () => [200, { entries: rankings }]],
    [`/internal/v1/leaderboards/guild/${guildId}`, () => [200, { entries: [] }]],
  ]);
  const request = (url, options, callback) => {
    const outgoing = new EventEmitter();
    outgoing.end = body => {
      const expected = createHmac("sha256", secret).update(`${options.method}\n${url.pathname}\n127.0.0.1\n1000\n`).update(body).digest("hex");
      assert.equal(options.headers["x-mint-signature"], expected);
      signed.push({ pathname: url.pathname, body: body.length ? JSON.parse(body) : null, timeout: options.timeout });
      const [statusCode, data, contentType = "application/json"] = routes.get(url.pathname)();
      const stream = Readable.from([Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data))]);
      Object.assign(stream, { statusCode, headers: { "content-type": contentType } });
      callback(stream);
    };
    return outgoing;
  };
  const service = new MatchClient({ origin: "https://service.example", secret, request, now: () => 1000 });
  assert.deepEqual(await service.startFight(identity), result);
  assert.deepEqual(signed[0].body, { requestId: interactionId, guildId, userId, opponentUserId });
  assert.deepEqual(await service.changeFighter({ ...identity, action: "set" }), selection);
  assert.deepEqual(signed[1].body, { requestId: interactionId, guildId, userId, action: "set" });
  assert.deepEqual((await service.getFighter({ guildId, userId, timeoutMs: 1_750 })).choices, choices);
  assert.equal(signed[2].timeout, 1_750);
  assert.deepEqual(await service.listFighters({ guildId }), choices);
  assert.deepEqual(await service.getLeaderboard({ guildId, scope: "global" }), rankings);
  assert.deepEqual(await service.getLeaderboard({ guildId, scope: "server" }), []);
  assert.deepEqual(await service.getFightGif({ matchId }), { status: "queued" });
  gifResponse = [503, { error: "Busy" }];
  assert.deepEqual(await service.getFightGif({ matchId }), { status: "unavailable" });
  gifResponse = [200, bytes, "image/gif"];
  assert.deepEqual(await service.getFightGif({ matchId }), { status: "ready", bytes });
  await assert.rejects(() => service.getFightGif({ matchId, maxBytes: bytes.length - 1 }), { code: "INVALID_RESPONSE" });
  gifResponse = [200, bytes, "application/octet-stream"];
  await assert.rejects(() => service.getFightGif({ matchId }), { code: "INVALID_RESPONSE" });
  fightResponse = [409, { error: "Enable your fighter with /fighter set first." }];
  await assert.rejects(() => service.startFight(identity), /\/fighter set/);
  fightResponse = [201, { ...result, score: { awarded: 1, winnerUserId: userId } }];
  await assert.rejects(() => service.startFight(identity), { code: "INVALID_RESPONSE" });
});
