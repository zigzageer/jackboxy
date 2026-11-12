import { assertSnowflake } from "./github-store.mjs";

export function serverSlug(name, guildId) {
  assertSnowflake(guildId);
  const label =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48)
      .replace(/-$/, "") || "server";
  return `${label}-${guildId}`;
}

const cleanName = (value) =>
  typeof value === "string" ? value.trim().slice(0, 28) : "";

export class GameService {
  constructor({
    store,
    generate,
    baseUrl,
    now = () => new Date().toISOString(),
  }) {
    this.store = store;
    this.generate = generate;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.now = now;
    this.pending = new Map();
  }

  link(game) {
    return `${this.baseUrl}/${game.slug}`;
  }

  async exclusive(guildId, task) {
    if (this.pending.has(guildId))
      throw new Error(
        "A game update is already running for this server. Try again when it finishes.",
      );
    this.pending.set(guildId, true);
    try {
      return await task();
    } finally {
      this.pending.delete(guildId);
    }
  }

  async create({ guildId, guildName }) {
    assertSnowflake(guildId);
    return this.exclusive(guildId, async () => {
      const result = await this.store.update(
        guildId,
        (current) =>
          current || {
            version: 1,
            guildId,
            name: guildName.slice(0, 100),
            slug: serverSlug(guildName, guildId),
            updatedAt: this.now(),
            characters: [],
          },
        { message: `Create server game ${guildId}` },
      );
      return {
        ...result,
        url: this.link(result.game),
        existing: result.commit === null,
      };
    });
  }

  async add({
    guildId,
    userId,
    displayName,
    name,
    description = "",
    usePfp = true,
    avatar,
    image,
  }) {
    assertSnowflake(guildId);
    assertSnowflake(userId);
    const characterName = cleanName(name) || cleanName(displayName);
    if (!characterName) throw new Error("Give this character a name.");
    if (description.length > 1000)
      throw new Error("Keep the description under 1,000 characters.");
    return this.exclusive(guildId, async () => {
      const validate = (game) => {
        if (!game)
          throw new Error("Create this server’s game first with /game create.");
        if (game.characters.some((c) => c.id === `discord-${userId}`))
          throw new Error(
            "This member already has a character in this server’s game.",
          );
        if (game.characters.length >= 24)
          throw new Error("This town already has 24 characters.");
      };
      validate(await this.store.read(guildId));
      const references = [];
      if (usePfp && avatar) references.push({ url: avatar });
      if (image) references.push(image);
      const bytes = await this.generate({
        name: characterName,
        description,
        references,
      });
      const character = {
        id: `discord-${userId}`,
        name: characterName,
        kind: "human",
        skin: "#f2cfaa",
        hair: "short",
        hairColor: "#352a28",
        shirt: "#6a9183",
        pants: "#454957",
        hat: "none",
        hatColor: "#ddba65",
        glasses: false,
        sprite: `/games/${guildId}/${userId}.png`,
      };
      const result = await this.store.update(
        guildId,
        (current) => {
          validate(current);
          return {
            ...current,
            updatedAt: this.now(),
            characters: [...current.characters, character],
          };
        },
        {
          message: `Add character to server game ${guildId}`,
          sprite: { userId, bytes },
        },
      );
      return { ...result, character, url: this.link(result.game) };
    });
  }
}
