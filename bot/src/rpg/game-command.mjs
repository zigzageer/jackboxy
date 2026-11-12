import { gameConfig } from "./config.mjs";
import { CodexGameStore } from "./codex-store.mjs";
import { createImageGenerator } from "./image-generator.mjs";
import { GameService } from "./game-service.mjs";
import { CODEX_OWNER_ID } from "./codex-runner.mjs";

function publishingMessage(result) {
  if (result.deployment?.state === "READY") return "The game is live.";
  if (result.deployment?.state === "FAILED")
    return "The game is saved in GitHub, but Vercel publishing failed. Run /game create to retry publishing.";
  return "Vercel is publishing the update. The game refreshes automatically when it is ready.";
}

// Raw Discord command JSON can be registered alongside an existing bot's commands.
export const gameCommand = {
  name: "game",
  description: "Create a paper-cutout RPG for this server",
  type: 1,
  integration_types: [0],
  contexts: [0],
  options: [
    {
      type: 1,
      name: "create",
      description: "Create or complete this server's town (owner only)",
    },
    {
      type: 1,
      name: "add",
      description:
        "Generate a character for a member and add them to this town",
      options: [
        {
          type: 6,
          name: "user",
          description: "Server member to turn into a character",
          required: true,
        },
        {
          type: 3,
          name: "name",
          description: "Character name (defaults to their name in this server)",
          max_length: 28,
        },
        {
          type: 3,
          name: "desc",
          description: "Appearance details to guide the generation",
          max_length: 1000,
        },
        {
          type: 5,
          name: "use-pfp",
          description:
            "Use their server profile picture as a reference (default: true)",
        },
        {
          type: 11,
          name: "image",
          description:
            "Optional PNG, JPEG, or WebP reference image (up to 10 MB)",
        },
      ],
    },
  ],
};

export function createGameCommandHandler({
  service,
  allowedUserIds = new Set(),
}) {
  return async function handleGameCommand(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "game")
      return false;
    const reply = (content) => ({ content, allowedMentions: { parse: [] } });
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({
        ...reply("Use /game in a Discord server."),
        flags: 64,
      });
      return true;
    }
    const owner = interaction.user?.id === CODEX_OWNER_ID;
    if (interaction.options.getSubcommand() === "create" && !owner) {
      await interaction.reply({
        ...reply("Only the bot owner can use /game create."),
        flags: 64,
      });
      return true;
    }
    if (
      !owner &&
      !interaction.memberPermissions?.has(32n) &&
      !allowedUserIds.has(interaction.user.id)
    ) {
      await interaction.reply({
        ...reply(
          "You need Manage Server permission to change the town’s cast.",
        ),
        flags: 64,
      });
      return true;
    }
    // Acknowledge before any network or image work; Discord requires a prompt response.
    await interaction.deferReply({ flags: 64 });
    try {
      const command = interaction.options.getSubcommand();
      if (command === "create") {
        const result = await service.create({
          guildId: interaction.guildId,
          guildName: interaction.guild.name,
        });
        await interaction.editReply(
          reply(
            `${result.existing ? "This server already has a game" : "Created this server’s town with 0 characters"}:\n${result.url}\n${publishingMessage(result)}\nAdd a friend with /game add user:@friend.`,
          ),
        );
      } else if (command === "add") {
        const user = interaction.options.getUser("user", true);
        // Resolve in this guild so nicknames and guild avatars take precedence.
        const member = await interaction.guild.members
          .fetch({ user: user.id, force: true })
          .catch(() => null);
        if (!member)
          throw new Error("Choose someone who is a member of this server.");
        const image = interaction.options.getAttachment("image");
        if (
          image &&
          (!/^image\/(png|jpeg|webp)$/.test(image.contentType || "") ||
            image.size > 10_000_000)
        )
          throw new Error(
            "Upload a PNG, JPEG, or WebP reference smaller than 10 MB.",
          );
        const result = await service.add({
          guildId: interaction.guildId,
          userId: user.id,
          displayName: member.displayName,
          name: interaction.options.getString("name"),
          description: interaction.options.getString("desc") || "",
          usePfp: interaction.options.getBoolean("use-pfp") ?? true,
          avatar: member.displayAvatarURL({
            extension: "png",
            size: 1024,
            forceStatic: true,
          }),
          image: image ? { url: image.url, size: image.size } : undefined,
        });
        await interaction.editReply(
          reply(
            `Added **${result.character.name.replace(/([*_~`\\])/g, "\\$1")}** to this server’s game.\n${result.url}\n${publishingMessage(result)}`,
          ),
        );
      } else throw new Error("Unknown /game command.");
    } catch (error) {
      // Never include raw provider responses, URLs containing credentials, or stack traces.
      const safe =
        error instanceof Error &&
        !/https?:|Bearer|sk-|gh[pousr]_/.test(error.message)
          ? error.message
          : "The game update failed. Check the bot’s service configuration and try again.";
      await interaction.editReply(reply(safe));
    }
    return true;
  };
}

export function configuredGameHandler(env = process.env) {
  const config = gameConfig(env);
  return createGameCommandHandler({
    service: new GameService({
      store: new CodexGameStore(config),
      generate: createImageGenerator(config),
      baseUrl: config.baseUrl,
    }),
    allowedUserIds: config.allowedUserIds,
  });
}
