import { MatchServiceError, normalizeMatch } from "./match-client.mjs";

const STRING = 3;
const USER = 6;
const FINAL_STATES = new Set(["completed", "cancelled", "declined"]);
const MATCH_STATUSES = new Set(["pending", "signup", "active", ...FINAL_STATES]);
const snowflake = value => typeof value === "string" && /^\d{17,20}$/.test(value);

const matchOption = { type: STRING, name: "match", description: "Match ID from the challenge or result", required: true, max_length: 64 };
const serverCommand = (name, description, options) => ({
  type: 1, name, description, options,
  contexts: [0], integration_types: [0], dm_permission: false, default_member_permissions: null,
});

export const gameLinkDefinition = {
  type: 1, name: "link", description: "Link your eligible character in this server",
  options: [{ type: STRING, name: "character", description: "Roster character ID created for you through /game add", required: true, max_length: 100 }],
};

export const fightDefinition = serverCommand("fight", "Challenge another player or use your linked character’s ability", [
  { type: 1, name: "challenge", description: "Challenge a member to a duel",
    options: [{ type: USER, name: "user", description: "Server member to challenge", required: true }] },
  { type: 1, name: "ability", description: "Use your signature ability on a legal turn",
    options: [matchOption] },
  { type: 1, name: "attack", description: "Make a basic attack on a legal turn", options: [matchOption] },
  { type: 1, name: "status", description: "Check a duel and its replay", options: [matchOption] },
]);

export const warDefinition = serverCommand("war", "Challenge another participating server", [
  { type: 1, name: "challenge", description: "Challenge a server to a two-minute team signup",
    options: [
      { type: STRING, name: "server", description: "Other participating Discord server ID", required: true, min_length: 17, max_length: 20 },
      { type: 4, name: "minimum", description: "Minimum linked players per team", required: true, min_value: 1, max_value: 24 },
    ] },
  { type: 1, name: "status", description: "Check server-war signup or its result", options: [matchOption] },
]);

function reply(content, extra = {}) {
  return { content: String(content).slice(0, 1950), allowedMentions: { parse: [] }, ...extra };
}

function buttons(matchId, actions) {
  return [{ type: 1, components: actions.map(([action, label, style]) => ({
    type: 2, custom_id: `mint:match:${action}:${matchId}`, label, style,
  })) }];
}

function validateMatch(snapshot, expectedId, identity) {
  const match = normalizeMatch(snapshot, identity);
  if (!match || typeof match.id !== "string" || !/^[\w-]{1,64}$/.test(match.id) ||
      !["duel", "war"].includes(match.type) || !MATCH_STATUSES.has(match.status) ||
      !snowflake(match.guildId) || (expectedId && match.id !== expectedId)) {
    throw new MatchServiceError("INVALID_RESPONSE");
  }
  if (match.type === "war" && (!snowflake(match.opponentGuildId) || match.guildId === match.opponentGuildId)) {
    throw new MatchServiceError("INVALID_RESPONSE");
  }
  for (const field of ["type", "guildId", "opponentGuildId", "challengerUserId", "opponentUserId"]) {
    if (identity?.[field] !== undefined && match[field] !== identity[field]) throw new MatchServiceError("INVALID_RESPONSE");
  }
  if (match.type === "duel" && (!snowflake(match.challengerUserId) || !snowflake(match.opponentUserId) || match.challengerUserId === match.opponentUserId)) {
    throw new MatchServiceError("INVALID_RESPONSE");
  }
  return match;
}

function replayLine(match) {
  if (typeof match.replayUrl !== "string") return "";
  try {
    const url = new URL(match.replayUrl);
    return url.protocol === "https:" ? `\nReplay ${url.href}` : "";
  } catch { return ""; }
}

function matchSummary(match) {
  const label = match.type === "war" ? "Server war" : "Duel";
  if (match.status === "completed") {
    const winner = match.type === "war"
      ? (match.winnerGuildId ? `Server ${match.winnerGuildId} won.` : "The match ended in a draw.")
      : (match.winnerUserId ? `<@${match.winnerUserId}> won.` : "The duel ended in a draw.");
    return `${label} ${match.id} finished. ${winner}${replayLine(match)}`;
  }
  if (match.status === "cancelled") return `${label} ${match.id} was cancelled. ${/minimum|enough|underfilled/i.test(match.reason ?? "") ? "A team did not reach the minimum signup." : "The match service closed the match."}${replayLine(match)}`;
  if (match.status === "declined") return `${label} ${match.id} was declined.`;
  if (match.status === "signup") {
    const timestamp = Date.parse(match.signupDeadline);
    const deadline = Number.isFinite(timestamp) ? ` Signup closes <t:${Math.floor(timestamp / 1000)}:R>.` : "";
    return `${label} ${match.id} is accepting players. Minimum ${match.minimumPlayers} per side.${deadline}\nJoin once with your linked character.`;
  }
  if (match.status === "active") return `${label} ${match.id} is active.${match.turnUserId ? ` It is <@${match.turnUserId}>’s turn.` : ""}\nUse /fight attack or /fight ability with this match ID.`;
  return `${label} ${match.id} is waiting for acceptance.`;
}

function resultMentions(match) {
  return { parse: [], users: [match.winnerUserId, match.turnUserId].filter(snowflake) };
}

export function createMatchCommands({ service, state, client, pollMs = 5000, logger = console }) {
  let timer;
  let polling;
  let stopped = false;

  function canManage(interaction) {
    return interaction.memberPermissions?.has(32n) === true;
  }

  function contextsFor(match, interaction) {
    const existing = state.match(match.id);
    if (existing) return existing.channels;
    const source = { guildId: interaction.guildId, channelId: interaction.channelId ?? interaction.channel?.id };
    if (!source.channelId) throw new Error("This command needs a server channel.");
    if (match.type === "duel") return [source];
    const target = state.guild(match.opponentGuildId);
    if (!target) throw new MatchServiceError("NOT_FOUND");
    return [source, { guildId: target.guildId, channelId: target.channelId }];
  }

  function notifications(match, contexts) {
    return contexts.flatMap(context => {
      let event;
      let payload;
      if (match.status === "pending") {
        event = "challenge";
        if (match.type === "duel") {
          payload = reply(`<@${match.opponentUserId}>, <@${match.challengerUserId}> challenged you to duel ${match.id}.`, {
            components: buttons(match.id, [["accept", "Accept duel", 3], ["decline", "Decline", 4]]),
            allowedMentions: { parse: [], users: [match.opponentUserId].filter(snowflake) },
          });
        } else {
          const target = context.guildId === match.opponentGuildId;
          payload = reply(`Server ${match.guildId} challenged server ${match.opponentGuildId} to war ${match.id}. Minimum ${match.minimumPlayers} players per side. A manager in the challenged server can accept.`, {
            components: target ? buttons(match.id, [["accept", "Accept war", 3], ["decline", "Decline", 4]]) : [],
          });
        }
      } else if (match.status === "signup") {
        event = "signup";
        payload = reply(matchSummary(match), { components: buttons(match.id, [["join", "Join war", 1]]) });
      } else if (match.status === "active") {
        event = `turn-${match.revision ?? match.turnUserId ?? "active"}`;
        payload = reply(matchSummary(match), { allowedMentions: resultMentions(match) });
      } else if (FINAL_STATES.has(match.status)) {
        event = "result";
        payload = reply(matchSummary(match), { allowedMentions: resultMentions(match) });
      }
      return payload ? [{ ...context, event, payload }] : [];
    });
  }

  function save(match, contexts) {
    match = validateMatch(match, undefined, state.match(match.id)?.match);
    const channels = contexts ?? state.match(match.id)?.channels;
    if (!channels?.length) throw new MatchServiceError("INVALID_RESPONSE");
    return state.saveMatch(match, channels, notifications(match, channels));
  }

  async function sendNotifications() {
    for (let count = 0; count < 50; count++) {
      const notice = state.claimNotification();
      if (!notice) return;
      try {
        const channel = await client.channels.fetch(notice.channelId);
        if (channel?.guildId !== notice.guildId || typeof channel.send !== "function") throw new Error("Channel unavailable");
        const message = await channel.send({ ...notice.payload, nonce: notice.nonce, enforceNonce: true });
        if (!message?.id) throw new Error("Message receipt unavailable");
        state.notificationSent(notice.id, message.id);
      } catch {
        state.notificationFailed(notice.id, notice.attempts);
        logger.error?.("[rpg match notification] Delivery will be retried.");
      }
    }
  }

  async function getMatch(matchId, guildId) {
    if (typeof matchId !== "string" || !/^[\w-]{1,64}$/.test(matchId)) throw new MatchServiceError("NOT_FOUND");
    const match = validateMatch(await service.getMatch({ matchId, guildId }), matchId, state.match(matchId)?.match);
    if (![match.guildId, match.opponentGuildId].includes(guildId)) throw new MatchServiceError("FORBIDDEN");
    return state.match(match.id) ? save(match) : match;
  }

  async function handle(interaction) {
    const customId = interaction.customId;
    const isMatchButton = typeof customId === "string" && customId.startsWith("mint:match:");
    const subcommand = !isMatchButton && interaction.options?.getSubcommand?.();
    const isLink = interaction.commandName === "game" && subcommand === "link";
    if (!isMatchButton && !isLink && !["fight", "war"].includes(interaction.commandName)) return false;
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: 64 });
    let stage = "identity";
    try {
      if (!snowflake(interaction.guildId) || !snowflake(interaction.user?.id)) throw new MatchServiceError("FORBIDDEN");
      const identity = { interactionId: interaction.id, guildId: interaction.guildId, userId: interaction.user.id };
      let match;
      if (isLink) {
        stage = "character linking";
        const characterId = interaction.options.getString("character", true);
        const linked = await service.linkCharacter({ ...identity, characterId });
        if (linked?.guildId !== identity.guildId || linked?.userId !== identity.userId || linked?.characterId !== characterId) throw new MatchServiceError("INVALID_RESPONSE");
        await interaction.editReply(reply(`Linked your character ${linked.characterId} in this server.`));
        return true;
      }
      if (isMatchButton) {
        const parsed = /^mint:match:(accept|decline|join):([\w-]{1,64})$/.exec(customId);
        if (!parsed) throw new MatchServiceError("NOT_FOUND");
        const [, action, matchId] = parsed;
        stage = "match lookup";
        const current = await getMatch(matchId, identity.guildId);
        if (action === "join") {
          if (current.type !== "war" || current.status !== "signup") throw new MatchServiceError("SIGNUP_CLOSED");
          stage = "war signup";
          match = await service.joinWar({ ...identity, matchId });
        } else {
          if (current.status !== "pending") throw new MatchServiceError("FORBIDDEN");
          if (current.type === "duel" && (current.opponentUserId !== identity.userId || current.guildId !== identity.guildId)) throw new MatchServiceError("FORBIDDEN");
          if (current.type === "war" && (current.opponentGuildId !== identity.guildId || !canManage(interaction))) throw new MatchServiceError("FORBIDDEN");
          stage = "challenge response";
          match = await service.respondMatch({ ...identity, matchId, accept: action === "accept", ...(current.type === "war" ? { manageGuild: canManage(interaction) } : {}) });
        }
        match = validateMatch(match, matchId, current);
        stage = "match persistence";
        match = save(match);
        await interaction.editReply(reply(action === "join" ? `You joined server war ${match.id} with your linked character.` : matchSummary(match), { allowedMentions: resultMentions(match) }));
      } else if (subcommand === "status") {
        stage = "match lookup";
        match = await getMatch(interaction.options.getString("match", true), identity.guildId);
        if (state.match(match.id)) match = save(match);
        await interaction.editReply(reply(matchSummary(match)));
      } else if (interaction.commandName === "fight" && subcommand === "challenge") {
        stage = "opponent lookup";
        const opponent = interaction.options.getUser("user", true);
        if (!snowflake(opponent.id) || opponent.id === identity.userId || opponent.bot) throw new MatchServiceError("FORBIDDEN");
        const member = await interaction.guild.members.fetch(opponent.id).catch(() => null);
        if (!member) throw new MatchServiceError("FORBIDDEN");
        stage = "duel challenge";
        match = validateMatch(await service.challengeDuel({ ...identity, opponentUserId: opponent.id }), undefined, {
          type: "duel", guildId: identity.guildId, challengerUserId: identity.userId, opponentUserId: opponent.id,
        });
        stage = "match persistence";
        match = save(match, contextsFor(match, interaction));
        await interaction.editReply(reply(matchSummary(match)));
      } else if (interaction.commandName === "fight" && ["attack", "ability"].includes(subcommand)) {
        stage = "match lookup";
        const matchId = interaction.options.getString("match", true);
        const current = await getMatch(matchId, identity.guildId);
        if (current.type !== "duel" || current.status !== "active") throw new MatchServiceError("ILLEGAL_TURN");
        if (![current.challengerUserId, current.opponentUserId].includes(identity.userId)) throw new MatchServiceError("FORBIDDEN");
        stage = `${subcommand} action`;
        const action = subcommand === "ability" ? service.useAbility.bind(service) : service.attack.bind(service);
        match = validateMatch(await action({ ...identity, matchId }), matchId, current);
        stage = "match persistence";
        match = save(match, state.match(match.id)?.channels ?? contextsFor(match, interaction));
        await interaction.editReply(reply(matchSummary(match)));
      } else if (interaction.commandName === "war" && subcommand === "challenge") {
        stage = "server permissions";
        if (!canManage(interaction)) throw new MatchServiceError("FORBIDDEN");
        const opponentGuildId = interaction.options.getString("server", true);
        const minimumPlayers = interaction.options.getInteger("minimum", true);
        if (!snowflake(opponentGuildId) || opponentGuildId === identity.guildId || !Number.isInteger(minimumPlayers) || minimumPlayers < 1 || minimumPlayers > 24) throw new MatchServiceError("FORBIDDEN");
        const opponentGuild = state.guild(opponentGuildId);
        if (!opponentGuild) throw new MatchServiceError("NOT_FOUND");
        stage = "server war challenge";
        match = validateMatch(await service.challengeWar({ ...identity, opponentGuildId, minimumPlayers, manageGuild: canManage(interaction) }), undefined, {
          type: "war", guildId: identity.guildId, opponentGuildId, challengerUserId: identity.userId,
        });
        if (match.minimumPlayers !== minimumPlayers) throw new MatchServiceError("INVALID_RESPONSE");
        stage = "match persistence";
        match = save(match, contextsFor(match, interaction));
        await interaction.editReply(reply(match.status === "pending"
          ? `Server war ${match.id} was sent to server ${opponentGuildId}. Signup starts when its manager accepts.`
          : matchSummary(match)));
      } else throw new MatchServiceError("NOT_FOUND");
      await sendNotifications();
    } catch (error) {
      logger.error?.(`[rpg match] Failed during ${stage}.`);
      const detail = error instanceof MatchServiceError ? error.message : "Check the shared game service and try again.";
      await interaction.editReply(reply(`Request ${interaction.id} failed during ${stage}. ${detail}`));
    }
    return true;
  }

  async function runPoll() {
    await Promise.allSettled(state.activeMatches().map(async ({ match, channels }) => {
      try {
        const latest = validateMatch(await service.getMatch({ matchId: match.id, guildId: match.guildId }), match.id, match);
        save(latest, channels);
        state.deferMatch(match.id, pollMs);
      } catch {
        state.deferMatch(match.id, Math.max(pollMs, 10_000));
        logger.error?.("[rpg match polling] Match refresh will be retried.");
      }
    }));
    await sendNotifications();
  }

  function poll() {
    if (stopped) return Promise.resolve();
    if (!polling) polling = runPoll().finally(() => { polling = undefined; });
    return polling;
  }

  function start() {
    if (timer) return;
    stopped = false;
    timer = setInterval(() => { poll().catch(() => logger.error?.("[rpg matches] Background refresh failed.")); }, pollMs);
    timer.unref?.();
    poll().catch(() => logger.error?.("[rpg matches] Background refresh failed."));
  }

  async function stop() {
    stopped = true;
    clearInterval(timer);
    timer = undefined;
    await polling;
  }

  return { handle, start, stop, poll };
}
