import { MatchServiceError } from "../../src/rpg/match-client.mjs";

// This fixture supplies authoritative outcomes for bot integration tests.
// Production simulation, ownership and turn validation belong to the shared service.
export class FixtureMatchService {
  constructor({ now, roster, managers }) {
    this.now = now;
    this.roster = roster;
    this.managers = new Set(managers);
    this.links = new Map();
    this.matches = new Map();
    this.responses = new Map();
    this.calls = [];
    this.sequence = 0;
  }

  perform(action, payload, handler) {
    this.calls.push({ action, payload: structuredClone(payload) });
    const key = `${action}:${payload.interactionId ?? payload.idempotencyKey}`;
    if (this.responses.has(key)) {
      const previous = this.responses.get(key);
      return structuredClone(this.matches.get(previous.id) ?? previous);
    }
    const result = handler();
    this.responses.set(key, structuredClone(result));
    return structuredClone(result);
  }

  linked(guildId, userId) {
    const characterId = this.links.get(`${guildId}:${userId}`);
    if (!characterId) throw new MatchServiceError("NO_LINK", 409);
    return characterId;
  }

  linkCharacter(payload) {
    return this.perform("linkCharacter", payload, () => {
      const character = this.roster.find(c => c.id === payload.characterId);
      if (!character || character.guildId !== payload.guildId || character.userId !== payload.userId) {
        throw new MatchServiceError("INELIGIBLE_CHARACTER", 403);
      }
      this.links.set(`${payload.guildId}:${payload.userId}`, character.id);
      return { guildId: payload.guildId, userId: payload.userId, characterId: character.id };
    });
  }

  challengeDuel(payload) {
    return this.perform("challengeDuel", payload, () => {
      this.linked(payload.guildId, payload.userId);
      this.linked(payload.guildId, payload.opponentUserId);
      const match = { id: `duel-${++this.sequence}`, type: "duel", status: "pending", revision: 1,
        guildId: payload.guildId, challengerUserId: payload.userId, opponentUserId: payload.opponentUserId };
      this.matches.set(match.id, match);
      return match;
    });
  }

  challengeWar(payload) {
    return this.perform("challengeWar", payload, () => {
      if (!this.managers.has(`${payload.guildId}:${payload.userId}`)) throw new MatchServiceError("FORBIDDEN", 403);
      const match = { id: `war-${++this.sequence}`, type: "war", status: "pending", revision: 1,
        guildId: payload.guildId, opponentGuildId: payload.opponentGuildId,
        challengerUserId: payload.userId, minimumPlayers: payload.minimumPlayers,
        teams: [{ guildId: payload.guildId, players: [] }, { guildId: payload.opponentGuildId, players: [] }] };
      this.matches.set(match.id, match);
      return match;
    });
  }

  respondMatch(payload) {
    return this.perform("respondMatch", payload, () => {
      const match = this.matches.get(payload.matchId);
      if (!match || match.status !== "pending") throw new MatchServiceError("FORBIDDEN", 403);
      if (match.type === "duel" && (match.guildId !== payload.guildId || match.opponentUserId !== payload.userId)) throw new MatchServiceError("FORBIDDEN", 403);
      if (match.type === "war" && (match.opponentGuildId !== payload.guildId || !this.managers.has(`${payload.guildId}:${payload.userId}`))) throw new MatchServiceError("FORBIDDEN", 403);
      match.status = payload.accept ? (match.type === "war" ? "signup" : "active") : "declined";
      if (payload.accept && match.type === "war") match.signupDeadline = new Date(this.now() + 120_000).toISOString();
      if (payload.accept && match.type === "duel") match.turnUserId = match.challengerUserId;
      match.revision++;
      return match;
    });
  }

  useAbility(payload) {
    return this.perform("useAbility", payload, () => {
      const match = this.matches.get(payload.matchId);
      if (!match || match.status !== "active" || match.turnUserId !== payload.userId) throw new MatchServiceError("ILLEGAL_TURN", 409);
      this.linked(payload.guildId, payload.userId);
      match.moves = (match.moves ?? 0) + 1;
      match.turnUserId = match.opponentUserId;
      if (match.moves === 2) {
        match.status = "completed";
        match.winnerUserId = match.challengerUserId;
        match.replayUrl = `https://game.example/replays/${match.id}`;
      }
      match.revision++;
      return match;
    });
  }

  joinWar(payload) {
    return this.perform("joinWar", payload, () => {
      const match = this.matches.get(payload.matchId);
      if (!match || match.status !== "signup" || this.now() >= Date.parse(match.signupDeadline)) throw new MatchServiceError("SIGNUP_CLOSED", 409);
      const characterId = this.linked(payload.guildId, payload.userId);
      const team = match.teams.find(t => t.guildId === payload.guildId);
      if (!team) throw new MatchServiceError("FORBIDDEN", 403);
      if (match.teams.some(t => t.players.some(p => p.userId === payload.userId))) return match;
      team.players.push({ userId: payload.userId, characterId });
      match.revision++;
      return match;
    });
  }

  getMatch(payload) {
    this.calls.push({ action: "getMatch", payload: structuredClone(payload) });
    const match = this.matches.get(payload.matchId);
    if (!match || ![match.guildId, match.opponentGuildId].includes(payload.guildId)) throw new MatchServiceError("NOT_FOUND", 404);
    if (match.type === "war" && match.status === "signup" && this.now() >= Date.parse(match.signupDeadline)) {
      return this.finalizeWar({ matchId: match.id, idempotencyKey: `fixture-service-deadline:${match.id}` });
    }
    return structuredClone(match);
  }

  finalizeWar(payload) {
    return this.perform("finalizeWar", payload, () => {
      const match = this.matches.get(payload.matchId);
      if (!match || match.type !== "war") throw new MatchServiceError("NOT_FOUND", 404);
      if (match.status !== "signup" || this.now() < Date.parse(match.signupDeadline)) return match;
      if (match.teams.some(team => team.players.length < match.minimumPlayers)) {
        match.status = "cancelled";
        match.reason = "minimum_not_met";
      } else {
        match.status = "completed";
        match.winnerGuildId = match.guildId;
        match.replayUrl = `https://game.example/replays/${match.id}`;
        match.seed = "fixture-authoritative-result";
      }
      match.revision++;
      return match;
    });
  }
}
