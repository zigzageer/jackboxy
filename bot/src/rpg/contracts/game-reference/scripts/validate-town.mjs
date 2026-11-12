import { readFile } from "node:fs/promises";
import { parseServerTown } from "../src/game/server-town.ts";

const [, , path, expectedGuildId] = process.argv;
if (!path) {
  console.error(
    "Usage: node --experimental-strip-types scripts/validate-town.mjs <town.json> [guild-id]",
  );
  process.exitCode = 1;
} else {
  try {
    const input = JSON.parse(await readFile(path, "utf8"));
    const town = parseServerTown(input, expectedGuildId ?? input.guildId);
    console.log(`Validated ${town.name} for guild ${town.guildId}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
