export class ServiceError extends Error {
  constructor(service, status) {
    super(`${service} request failed (${status}).`);
    this.status = status;
  }
}

export function assertSnowflake(value) {
  if (typeof value !== "string" || !/^\d{17,20}$/.test(value))
    throw new Error("Invalid Discord ID.");
  return value;
}

export const manifestPath = (guildId) =>
  `public/games/${assertSnowflake(guildId)}/game.json`;

// A character PNG and its manifest publish in one commit. A rejected branch
// update is retried against the new head, preserving concurrent bot/code changes.
export class GitHubGameStore {
  constructor({
    repository,
    branch = "main",
    token,
    fetch: request = globalThis.fetch,
  }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
      throw new Error("Invalid repository.");
    if (!token) throw new Error("Set GAME_GITHUB_TOKEN on the bot host.");
    this.repository = repository;
    this.branch = branch;
    this.token = token;
    this.fetch = request;
  }

  async request(path, method = "GET", body, allowMissing = false) {
    const response = await this.fetch(
      `https://api.github.com/repos/${this.repository}${path}`,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "Adventures-of-Mint-Discord",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new ServiceError("GitHub", response.status);
    return response.status === 204 ? null : response.json();
  }

  async read(guildId, ref = this.branch) {
    const file = await this.request(
      `/contents/${manifestPath(guildId)}?ref=${encodeURIComponent(ref)}`,
      "GET",
      undefined,
      true,
    );
    if (!file) return null;
    if (file.encoding !== "base64" || typeof file.content !== "string")
      throw new Error("Unsupported game manifest.");
    const game = JSON.parse(
      Buffer.from(file.content, "base64").toString("utf8"),
    );
    if (
      game.version !== 1 ||
      game.guildId !== guildId ||
      !Array.isArray(game.characters)
    )
      throw new Error("Invalid server game manifest.");
    return game;
  }

  async update(guildId, change, { message, sprite } = {}) {
    assertSnowflake(guildId);
    let spriteSha;
    for (let attempt = 0; attempt < 4; attempt++) {
      const head = await this.request(
        `/git/ref/heads/${encodeURIComponent(this.branch)}`,
      );
      const current = await this.read(guildId, head.object.sha);
      const next = change(current);
      if (next === current) return { game: current, commit: null };
      if (next.guildId !== guildId) throw new Error("Server ID cannot change.");
      const parent = await this.request(`/git/commits/${head.object.sha}`);
      const files = [
        {
          path: manifestPath(guildId),
          mode: "100644",
          type: "blob",
          content: `${JSON.stringify(next, null, 2)}\n`,
        },
      ];
      if (sprite) {
        assertSnowflake(sprite.userId);
        if (!spriteSha)
          spriteSha = (
            await this.request("/git/blobs", "POST", {
              content: sprite.bytes.toString("base64"),
              encoding: "base64",
            })
          ).sha;
        files.push({
          path: `public/games/${guildId}/${sprite.userId}.png`,
          mode: "100644",
          type: "blob",
          sha: spriteSha,
        });
      }
      const tree = await this.request("/git/trees", "POST", {
        base_tree: parent.tree.sha,
        tree: files,
      });
      const commit = await this.request("/git/commits", "POST", {
        message: message || "Update Discord server game",
        tree: tree.sha,
        parents: [head.object.sha],
      });
      try {
        await this.request(
          `/git/refs/heads/${encodeURIComponent(this.branch)}`,
          "PATCH",
          { sha: commit.sha, force: false },
        );
        return { game: next, commit: commit.sha };
      } catch (error) {
        if (![409, 422].includes(error.status) || attempt === 3) throw error;
      }
    }
  }
}
