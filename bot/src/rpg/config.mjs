export function gameConfig(env = process.env) {
  const repository = env.GAME_GITHUB_REPOSITORY || "zigzageer/grapevinerpg";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("Invalid GAME_GITHUB_REPOSITORY.");
  const origin = new URL(
    env.GAME_BASE_URL || "https://adventures-of-mint.vercel.app",
  );
  if (origin.protocol !== "https:" || origin.pathname !== "/")
    throw new Error("GAME_BASE_URL must be an HTTPS origin.");
  return {
    repository,
    branch: env.GAME_GITHUB_BRANCH || "main",
    baseUrl: origin.origin,
    codexEnv: env,
    vercel: {
      teamId: env.GAME_VERCEL_TEAM_ID || "team_YMxRg3j0ixQCGCc8wjrgWSZz",
      projectId:
        env.GAME_VERCEL_PROJECT_ID || "prj_0VQ70aDKzQcB17HfOjJ8UG1U6BL5",
      projectName: env.GAME_VERCEL_PROJECT_NAME || "adventures-of-mint",
      repositoryId: Number(env.GAME_GITHUB_REPOSITORY_ID || "1453541021"),
    },
    allowedUserIds: new Set(
      (env.GAME_ALLOWED_USER_IDS || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  };
}
