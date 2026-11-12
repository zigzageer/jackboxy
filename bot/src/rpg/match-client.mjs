import https from "node:https";
import { createHmac } from "node:crypto";

export class MatchServiceError extends Error {
  constructor(code, status) {
    const messages = {
      NO_LINK: "Link your eligible character first with /game link.",
      ILLEGAL_TURN: "Your character cannot use that ability on this turn.",
      INELIGIBLE_CHARACTER: "That character belongs to another member or server.",
      NOT_FOUND: "That match or participating server could not be found.",
      FORBIDDEN: "You are not eligible to perform that match action.",
      SIGNUP_CLOSED: "This war’s signup has closed.",
      NOT_CONFIGURED: "The shared game service is waiting for configuration.",
      RETRY_CONFLICT: "This interaction ID was already used for a different match action.",
    };
    super(messages[code] ?? "The shared game service could not complete this action.");
    this.name = "MatchServiceError";
    this.code = code;
    this.status = status;
  }
}

export function normalizeMatch(snapshot, identity = {}) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  if (!snapshot.kind || snapshot.type) return {
    ...snapshot,
    challengerUserId: snapshot.challengerUserId ?? identity.challengerUserId,
    opponentUserId: snapshot.opponentUserId ?? identity.opponentUserId,
  };
  const sides = snapshot.sides ?? [];
  const challengerUserId = snapshot.challengerUserId ?? identity.challengerUserId;
  const opponentUserId = snapshot.opponentUserId ?? identity.opponentUserId;
  const users = [challengerUserId, opponentUserId];
  const turnSide = sides.findIndex(side => side.players?.some(player => player.id === snapshot.turnFighterId));
  const status = { offered: "pending", signup: "signup", running: "active", finished: "completed", cancelled: "cancelled" }[snapshot.status];
  return {
    ...snapshot,
    type: snapshot.kind,
    status: snapshot.status === "cancelled" && /declin/i.test(snapshot.reason ?? "") ? "declined" : status,
    guildId: sides[0]?.guildId,
    opponentGuildId: snapshot.kind === "war" ? sides[1]?.guildId : undefined,
    challengerUserId,
    opponentUserId,
    minimumPlayers: snapshot.minPlayersPerSide,
    signupDeadline: Number.isFinite(snapshot.joinUntil) ? new Date(snapshot.joinUntil).toISOString() : undefined,
    winnerGuildId: snapshot.kind === "war" && snapshot.winnerSide !== null ? sides[snapshot.winnerSide]?.guildId : undefined,
    winnerUserId: snapshot.kind === "duel" && snapshot.winnerSide !== null ? users[snapshot.winnerSide] : undefined,
    turnUserId: snapshot.kind === "duel" && turnSide >= 0 ? users[turnSide] : undefined,
    revision: snapshot.events?.at(-1)?.seq ?? 0,
  };
}

function serviceErrorCode(data, status) {
  if (typeof data?.error?.code === "string") return data.error.code;
  const message = typeof data?.error === "string" ? data.error : "";
  if (status === 404) return "NOT_FOUND";
  if (/request|idempot|reus/i.test(message) && status === 409) return "RETRY_CONFLICT";
  if (/turn|ability|signature/i.test(message)) return "ILLEGAL_TURN";
  if (/link/i.test(message)) return "NO_LINK";
  if (/signup|deadline/i.test(message)) return "SIGNUP_CLOSED";
  if (status === 403) return "FORBIDDEN";
  return "SERVICE_ERROR";
}

function matchResponse(snapshot, expected = {}) {
  const validId = value => typeof value === "string" && /^\d{17,20}$/.test(value);
  if (!snapshot || typeof snapshot.id !== "string" || !/^[\w-]{1,64}$/.test(snapshot.id) ||
      !["duel", "war"].includes(snapshot.kind) ||
      !["offered", "signup", "running", "finished", "cancelled"].includes(snapshot.status) ||
      !Array.isArray(snapshot.sides) || snapshot.sides.length !== 2 ||
      !snapshot.sides.every(side => validId(side.guildId) && Array.isArray(side.players))) {
    throw new MatchServiceError("INVALID_RESPONSE");
  }
  if ((expected.matchId && snapshot.id !== expected.matchId) ||
      (expected.kind && snapshot.kind !== expected.kind) ||
      (expected.guildId && snapshot.sides[0].guildId !== expected.guildId) ||
      (expected.opponentGuildId && snapshot.sides[1].guildId !== expected.opponentGuildId)) {
    throw new MatchServiceError("INVALID_RESPONSE");
  }
  if ((snapshot.kind === "duel" && snapshot.sides[0].guildId !== snapshot.sides[1].guildId) ||
      (snapshot.kind === "war" && snapshot.sides[0].guildId === snapshot.sides[1].guildId)) {
    throw new MatchServiceError("INVALID_RESPONSE");
  }
  for (const field of ["challengerUserId", "opponentUserId"]) {
    if (snapshot[field] !== undefined && expected[field] !== undefined && snapshot[field] !== expected[field]) throw new MatchServiceError("INVALID_RESPONSE");
  }
  return snapshot;
}

function linkResponse(link, expected) {
  if (!link || link.guildId !== expected.guildId || link.userId !== expected.userId ||
      typeof link.characterId !== "string" || (expected.characterId && link.characterId !== expected.characterId)) {
    throw new MatchServiceError("INVALID_RESPONSE");
  }
  return link;
}

export class MatchClient {
  constructor({ origin, baseUrl, secret, ca, request = https.request, timeoutMs = 15_000, now = Date.now } = {}) {
    const configuredOrigin = origin ?? baseUrl;
    this.origin = configuredOrigin ? new URL(configuredOrigin) : null;
    if (this.origin && (this.origin.protocol !== "https:" || this.origin.username || this.origin.password || this.origin.search || this.origin.hash)) {
      throw new Error("The shared game service must use an HTTPS origin.");
    }
    this.secret = secret;
    this.ca = ca;
    this.requestTransport = request;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  async request(method, pathname, payload) {
    if (!this.origin || !this.secret) throw new MatchServiceError("NOT_CONFIGURED");
    const url = new URL(pathname, this.origin);
    if (url.origin !== this.origin.origin) throw new MatchServiceError("INVALID_REQUEST");
    const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
    const ip = "127.0.0.1";
    const timestamp = String(this.now());
    const signature = createHmac("sha256", this.secret)
      .update([method, `${url.pathname}${url.search}`, ip, timestamp].join("\n") + "\n")
      .update(body).digest("hex");
    const response = await new Promise((resolve, reject) => {
      const request = this.requestTransport(url, {
        method, ca: this.ca, timeout: this.timeoutMs,
        headers: { "content-type": "application/json", "content-length": body.length,
          "x-mint-ip": ip, "x-mint-time": timestamp, "x-mint-signature": signature },
      }, stream => {
        const chunks = [];
        let bytes = 0;
        stream.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > 1_000_000) {
            stream.destroy(new MatchServiceError("INVALID_RESPONSE", stream.statusCode));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", reject);
        stream.on("end", () => resolve({ status: stream.statusCode, bytes: Buffer.concat(chunks) }));
      });
      request.on("timeout", () => request.destroy(new Error("Match service request timed out.")));
      request.on("error", reject);
      request.end(body);
    });
    let data;
    try { data = JSON.parse(response.bytes.toString("utf8")); }
    catch { throw new MatchServiceError("INVALID_RESPONSE", response.status); }
    if (response.status < 200 || response.status >= 300) throw new MatchServiceError(serviceErrorCode(data, response.status), response.status);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new MatchServiceError("INVALID_RESPONSE", response.status);
    return data.match ?? data.link ?? data;
  }

  identity({ interactionId, guildId, userId }) { return { requestId: interactionId, guildId, userId }; }
  async linkCharacter(payload) {
    const linked = await this.request("POST", "/internal/v1/links", { ...this.identity(payload), characterId: payload.characterId });
    return linkResponse(linked, payload);
  }
  async getLink({ guildId, userId }) {
    return linkResponse(await this.request("GET", `/internal/v1/links/${encodeURIComponent(guildId)}/${encodeURIComponent(userId)}`), { guildId, userId });
  }
  async challengeDuel(payload) {
    const match = await this.request("POST", "/internal/v1/matches", { ...this.identity(payload), kind: "duel", opponentUserId: payload.opponentUserId });
    return matchResponse(match, { kind: "duel", guildId: payload.guildId, challengerUserId: payload.userId, opponentUserId: payload.opponentUserId });
  }
  async challengeWar(payload) {
    const match = await this.request("POST", "/internal/v1/matches", { ...this.identity(payload), kind: "war", opponentGuildId: payload.opponentGuildId, minPlayersPerSide: payload.minimumPlayers, manageGuild: payload.manageGuild === true });
    return matchResponse(match, { kind: "war", guildId: payload.guildId, opponentGuildId: payload.opponentGuildId, challengerUserId: payload.userId });
  }
  async action(payload, action) {
    const match = await this.request("POST", `/internal/v1/matches/${encodeURIComponent(payload.matchId)}/actions`, { ...this.identity(payload), action, ...(payload.manageGuild === undefined ? {} : { manageGuild: payload.manageGuild === true }) });
    return matchResponse(match, { matchId: payload.matchId });
  }
  respondMatch(payload) { return this.action(payload, payload.accept ? "accept" : "decline"); }
  useAbility(payload) { return this.action(payload, "ability"); }
  attack(payload) { return this.action(payload, "attack"); }
  joinWar(payload) { return this.action(payload, "join"); }
  async getMatch({ matchId }) {
    return matchResponse(await this.request("GET", `/internal/v1/matches/${encodeURIComponent(matchId)}`), { matchId });
  }
}
