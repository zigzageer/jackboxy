import { canStand, type Point, type WalkArea } from "./model.ts";
import type { Footprint } from "./locations.ts";
import { findPath } from "./navigation.ts";

const buildingKinds = ["hall", "shop", "venue", "workshop", "house"] as const;
const landmarkKinds = ["plaza", "garden", "stage"] as const;

export interface ServerBuilding extends Footprint {
  id: string;
  label: string;
  kind: (typeof buildingKinds)[number];
  door: Point;
  art?: string;
}

export interface ServerLandmark extends Point {
  id: string;
  label: string;
  kind: (typeof landmarkKinds)[number];
}

export interface ServerTown {
  version: 1;
  guildId: string;
  name: string;
  width: number;
  height: number;
  spawn: Point;
  palette: { ground: string; road: string; accent: string };
  roads: Footprint[];
  buildings: ServerBuilding[];
  landmarks: ServerLandmark[];
  characterSpawns: Point[];
  walkArea: WalkArea;
}

const invalid = (message: string): never => {
  throw new Error(message);
};
const int = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;
const label = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 48 && Boolean(value.trim());
const id = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 40 &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const color = (value: unknown): value is string =>
  typeof value === "string" && /^#[a-f0-9]{6}$/i.test(value);
const point = (value: Point | undefined): value is Point =>
  !!value && int(value.x, 0) && int(value.y, 0);
const list = (value: unknown, min: number, max: number) =>
  Array.isArray(value) && value.length >= min && value.length <= max;

export function townPath(guildId: string) {
  return `/games/${guildId}/town.json`;
}

export function parseServerTown(input: unknown, guildId: string): ServerTown {
  const town = input as Omit<ServerTown, "walkArea"> | null;
  if (
    !town ||
    town.version !== 1 ||
    !/^\d{17,20}$/.test(guildId) ||
    town.guildId !== guildId ||
    !label(town.name) ||
    !int(town.width, 900, 3600) ||
    !int(town.height, 720, 3000) ||
    !color(town.palette?.ground) ||
    !color(town.palette?.road) ||
    !color(town.palette?.accent) ||
    !list(town.roads, 1, 20) ||
    !list(town.buildings, 2, 20) ||
    !list(town.landmarks, 0, 12) ||
    !list(town.characterSpawns, 1, 24)
  )
    return invalid("This server’s town file has an invalid format.");

  const { width, height } = town;
  const fits = (rect: Footprint) =>
    point(rect) &&
    int(rect.w, 48) &&
    int(rect.h, 48) &&
    rect.x + rect.w <= width &&
    rect.y + rect.h <= height;
  if (town.roads.some((road) => !fits(road)))
    return invalid("A street is outside the town bounds.");

  const ids = new Set<string>();
  const register = (item: { id: string; label: string }) => {
    if (!id(item.id) || ids.has(item.id) || !label(item.label))
      invalid("Town destinations need distinct IDs and a label.");
    ids.add(item.id);
  };
  const artPath = new RegExp(
    `^/games/${guildId}/town/[a-z0-9-]+\\.(png|webp)$`,
  );
  for (const building of town.buildings) {
    if (
      !fits(building) ||
      !buildingKinds.includes(building.kind) ||
      !point(building.door) ||
      building.door.x < building.x ||
      building.door.x > building.x + building.w ||
      !int(building.door.y - building.y - building.h, 12, 120) ||
      (building.art !== undefined &&
        (typeof building.art !== "string" ||
          building.art.length > 160 ||
          !artPath.test(building.art)))
    )
      return invalid(
        "A building has invalid bounds, door placement, or artwork.",
      );
    register(building);
  }
  for (const landmark of town.landmarks) {
    if (!point(landmark) || !landmarkKinds.includes(landmark.kind))
      return invalid("A landmark has an invalid kind or position.");
    register(landmark);
  }
  const walkArea: WalkArea = {
    bounds: { left: 28, right: width - 28, top: 28, bottom: height - 28 },
    obstacles: town.buildings,
  };
  if (!point(town.spawn) || !canStand(town.spawn, walkArea))
    return invalid("The player spawn must be in open space.");
  const destinations = [
    ...town.buildings.map(({ door }) => door),
    ...town.landmarks,
    ...town.characterSpawns,
  ];
  for (const destination of destinations) {
    if (!point(destination) || !canStand(destination, walkArea))
      return invalid("A door, landmark, or character spawn is blocked.");
    const end = findPath(town.spawn, destination, walkArea).at(-1);
    if (!end || end.x !== destination.x || end.y !== destination.y)
      return invalid("Every town destination must be reachable from spawn.");
  }
  return { ...town, walkArea };
}

export function serverDistrictAt(town: ServerTown, player: Point) {
  let nearest = town.name;
  let distance = 160;
  const places = [
    ...town.buildings.map(({ door, label }) => ({ ...door, label })),
    ...town.landmarks,
  ];
  for (const place of places) {
    const next = Math.hypot(place.x - player.x, place.y - player.y);
    if (next < distance) {
      distance = next;
      nearest = place.label;
    }
  }
  return nearest;
}
