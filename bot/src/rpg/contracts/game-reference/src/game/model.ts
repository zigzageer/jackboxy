import { WORLD, WALK_BOUNDS, TOWN_OBSTACLES, type Footprint } from "./locations.ts";
export { WORLD };
export type Point = { x: number; y: number };
export type Hair = "short" | "messy" | "long" | "curly" | "bald";
export type Hat = "none" | "beanie" | "cap";
export interface GeneratedAbility {
  name: string;
  description: string;
  style: "burst" | "projectile" | "rush";
  art: string;
}
export interface Character {
  id: string;
  name: string;
  kind?: "mint" | "human";
  skin: string;
  hair: Hair;
  hairColor: string;
  shirt: string;
  pants: string;
  hat: Hat;
  hatColor: string;
  glasses: boolean;
  heightScale?: number;
  sprite?: string;
  ability?: GeneratedAbility;
  preset?:
    | "baguette-guy"
    | "flag-girl"
    | "david"
    | "ghost"
    | "rocky"
    | "miel"
    | "zippy"
    | "jat"
    | "loralei"
    | "samira"
    | "genesis"
    | "kain"
    | "footjobofsteel"
    | "steakbutterfan"
    | "blindian"
    | "grace"
    | "tommy"
    | "red-light"
    | "peaches"
    | "lin"
    | "bashu"
    | "orrow"
    | "potato"
    | "kawaiikitty"
    | "babashark";
}
export interface SaveGame {
  version: 1;
  castVersion: 11;
  activeCharacter?: string;
  tvLook?: boolean;
  player: Point;
  crew: Character[];
  greeted: boolean;
  inspected: boolean;
  complete: boolean;
  sound: boolean;
}
export const SAVE_KEY = "grapevine.save.v1";
export const MINT_CREW_LIMIT = 40;
export const START: Point = { x: 680, y: 560 };
export const BAGUETTE_GUY: Character = {
  id: "friend-3",
  name: "Baguette",
  kind: "human",
  preset: "baguette-guy",
  skin: "#f4d4b5",
  hair: "messy",
  hairColor: "#202024",
  shirt: "#36353b",
  pants: "#344969",
  hat: "none",
  hatColor: "#36353b",
  glasses: false,
};
export const FLAG_GIRL: Character = {
  id: "friend-4",
  name: "Sarina",
  kind: "human",
  preset: "flag-girl",
  skin: "#edbc91",
  hair: "long",
  hairColor: "#64402f",
  shirt: "#293c70",
  pants: "#29292d",
  hat: "none",
  hatColor: "#293c70",
  glasses: false,
};
export const DAVID: Character = {
  id: "friend-5",
  name: "David",
  kind: "human",
  preset: "david",
  skin: "#f1c49d",
  hair: "curly",
  hairColor: "#402c24",
  shirt: "#711e37",
  pants: "#35415a",
  hat: "none",
  hatColor: "#274694",
  glasses: false,
};
export const GHOST: Character = {
  id: "friend-6",
  name: "Ghost",
  kind: "human",
  preset: "ghost",
  skin: "#895332",
  hair: "long",
  hairColor: "#241b1c",
  shirt: "#85936a",
  pants: "#34323a",
  hat: "none",
  hatColor: "#61234c",
  glasses: false,
};
export const ROCKY: Character = {
  id: "friend-7",
  name: "Rocky",
  kind: "human",
  preset: "rocky",
  skin: "#efccaa",
  hair: "short",
  hairColor: "#3c2b24",
  shirt: "#555b39",
  pants: "#28282c",
  hat: "none",
  hatColor: "#252529",
  glasses: false,
};
export const MIEL: Character = {
  id: "friend-8",
  name: "Miel",
  kind: "human",
  preset: "miel",
  skin: "#f1ccab",
  hair: "long",
  hairColor: "#704c33",
  shirt: "#b49acb",
  pants: "#34476b",
  hat: "none",
  hatColor: "#f6e9e3",
  glasses: false,
};
export const ZIPPY: Character = {
  id: "friend-9",
  name: "Zippy",
  kind: "human",
  preset: "zippy",
  skin: "#f2c497",
  hair: "short",
  hairColor: "#b2773c",
  shirt: "#38b5b2",
  pants: "#484452",
  hat: "none",
  hatColor: "#38b5b2",
  glasses: false,
};
export const JAT: Character = {
  id: "friend-10",
  name: "Jat",
  kind: "human",
  preset: "jat",
  skin: "#89502e",
  hair: "short",
  hairColor: "#232126",
  shirt: "#9c2942",
  pants: "#303b64",
  hat: "none",
  hatColor: "#9c2942",
  glasses: false,
};
export const LATEST_CAST = [ROCKY, MIEL, ZIPPY, JAT];
export const DEMO_ADDITIONS: Character[] = [
  {
    id: "friend-11",
    name: "Loralei",
    kind: "human",
    preset: "loralei",
    skin: "#efccad",
    hair: "long",
    hairColor: "#694532",
    shirt: "#27272a",
    pants: "#29282a",
    hat: "cap",
    hatColor: "#242426",
    glasses: false,
  },
  {
    id: "friend-12",
    name: "Samira",
    kind: "human",
    preset: "samira",
    skin: "#bb7d4f",
    hair: "long",
    hairColor: "#432b23",
    shirt: "#30777c",
    pants: "#51304e",
    hat: "none",
    hatColor: "#30777c",
    glasses: false,
  },
  {
    id: "friend-13",
    name: "Genesis",
    kind: "human",
    preset: "genesis",
    skin: "#a2653b",
    hair: "curly",
    hairColor: "#2b2527",
    shirt: "#cb9f3a",
    pants: "#314b3a",
    hat: "none",
    hatColor: "#cb9f3a",
    glasses: true,
  },
  {
    id: "friend-14",
    name: "Kain",
    kind: "human",
    preset: "kain",
    skin: "#77a943",
    hair: "bald",
    hairColor: "#26382b",
    shirt: "#313136",
    pants: "#313136",
    hat: "none",
    hatColor: "#313136",
    glasses: true,
  },
  {
    id: "friend-15",
    name: "Footjobofsteel",
    kind: "human",
    preset: "footjobofsteel",
    skin: "#efc02d",
    hair: "bald",
    hairColor: "#b87721",
    shirt: "#d54135",
    pants: "#714934",
    hat: "none",
    hatColor: "#d54135",
    glasses: false,
  },
];
export const CAST_ADDITIONS: Character[] = [
  {
    id: "cast-steakbutterfan",
    name: "steakbutterfan",
    kind: "human",
    preset: "steakbutterfan",
    skin: "#754d36",
    hair: "bald",
    hairColor: "#251f1b",
    shirt: "#f4f1ee",
    pants: "#36313b",
    hat: "none",
    hatColor: "#71436f",
    glasses: false,
  },
  {
    id: "cast-blindian",
    name: "blindian",
    kind: "human",
    preset: "blindian",
    heightScale: 1.45,
    skin: "#9b6945",
    hair: "short",
    hairColor: "#242127",
    shirt: "#e4d2ac",
    pants: "#363139",
    hat: "none",
    hatColor: "#363139",
    glasses: false,
  },
];
export const GRACE: Character = {
  id: "cast-grace",
  name: "Grace",
  kind: "human",
  preset: "grace",
  skin: "#f3c9a9",
  hair: "long",
  hairColor: "#e8c25f",
  shirt: "#a8242e",
  pants: "#333748",
  hat: "none",
  hatColor: "#c04b71",
  glasses: false,
};
export const TOMMY: Character = {
  id: "cast-tommy",
  name: "Tommy",
  kind: "human",
  preset: "tommy",
  skin: "#efc3a1",
  hair: "short",
  hairColor: "#a06d43",
  shirt: "#651b2e",
  pants: "#293249",
  hat: "cap",
  hatColor: "#c91c2f",
  glasses: false,
};
export const CAST_VERSION_10_ADDITIONS: Character[] = [
  {
    id: "cast-red-light",
    name: "Red Light",
    kind: "human",
    preset: "red-light",
    skin: "#9d6c48",
    hair: "messy",
    hairColor: "#66432d",
    shirt: "#9d6c48",
    pants: "#66432d",
    hat: "none",
    hatColor: "#8d4b3a",
    glasses: false,
  },
  {
    id: "cast-peaches",
    name: "Peaches",
    kind: "human",
    preset: "peaches",
    skin: "#dda680",
    hair: "short",
    hairColor: "#503a2a",
    shirt: "#c3a04b",
    pants: "#734c31",
    hat: "none",
    hatColor: "#8e2e31",
    glasses: false,
  },
  {
    id: "cast-lin",
    name: "Lin",
    kind: "human",
    preset: "lin",
    skin: "#e5b699",
    hair: "long",
    hairColor: "#302721",
    shirt: "#c5656b",
    pants: "#394557",
    hat: "none",
    hatColor: "#c5656b",
    glasses: false,
  },
  {
    id: "cast-bashu",
    name: "Bashu",
    kind: "human",
    preset: "bashu",
    skin: "#a86547",
    hair: "long",
    hairColor: "#25201e",
    shirt: "#a23351",
    pants: "#553748",
    hat: "none",
    hatColor: "#a23351",
    glasses: false,
  },
  {
    id: "cast-orrow",
    name: "Orrow",
    kind: "human",
    preset: "orrow",
    skin: "#edc7aa",
    hair: "curly",
    hairColor: "#594239",
    shirt: "#6b5043",
    pants: "#494748",
    hat: "none",
    hatColor: "#6b5043",
    glasses: false,
  },
  {
    id: "cast-potato",
    name: "Potato",
    kind: "human",
    preset: "potato",
    skin: "#a47749",
    hair: "bald",
    hairColor: "#805837",
    shirt: "#a47749",
    pants: "#805837",
    hat: "none",
    hatColor: "#805837",
    glasses: false,
  },
  {
    id: "cast-kawaiikitty",
    name: "kawaiikitty",
    kind: "human",
    preset: "kawaiikitty",
    skin: "#785039",
    hair: "long",
    hairColor: "#241d24",
    shirt: "#e38bb1",
    pants: "#463743",
    hat: "none",
    hatColor: "#e38bb1",
    glasses: false,
  },
];
export const BABASHARK: Character = {
  id: "cast-babashark",
  name: "babashark",
  kind: "human",
  preset: "babashark",
  skin: "#a6704d",
  hair: "messy",
  hairColor: "#242126",
  shirt: "#53573e",
  pants: "#303036",
  hat: "cap",
  hatColor: "#53573e",
  glasses: false,
};
export const characterKey = (c: Character) => c.id;
export const characterScale = (c: Character) =>
  c.heightScale ?? (c.preset === "blindian" ? 1.45 : 1);
export const DEFAULT_CREW: Character[] = [
  {
    id: "you",
    name: "Mint",
    kind: "mint",
    skin: "#f2cfaa",
    hair: "messy",
    hairColor: "#653c2c",
    shirt: "#c66c45",
    pants: "#344958",
    hat: "none",
    hatColor: "#638e9f",
    glasses: false,
  },
  {
    id: "friend-1",
    name: "Friend 01",
    skin: "#d9aa80",
    hair: "short",
    hairColor: "#352a28",
    shirt: "#6a9183",
    pants: "#454957",
    hat: "beanie",
    hatColor: "#ddba65",
    glasses: false,
  },
  {
    id: "friend-2",
    name: "Friend 02",
    skin: "#f2cfaa",
    hair: "long",
    hairColor: "#a0593e",
    shirt: "#8e86a6",
    pants: "#474c67",
    hat: "none",
    hatColor: "#8e86a6",
    glasses: true,
  },
  BAGUETTE_GUY,
  FLAG_GIRL,
  DAVID,
  GHOST,
  ...LATEST_CAST,
  ...DEMO_ADDITIONS,
  ...CAST_ADDITIONS,
  GRACE,
  TOMMY,
  ...CAST_VERSION_10_ADDITIONS,
  BABASHARK,
];
const castPresets = new Set<string>(
  DEFAULT_CREW.flatMap(({ preset }) => (preset ? [preset] : [])),
);

export const initialSave = (): SaveGame => ({
  version: 1,
  castVersion: 11,
  tvLook: true,
  player: { ...START },
  crew: DEFAULT_CREW.map((c) => ({ ...c })),
  greeted: false,
  inspected: false,
  complete: false,
  sound: false,
});
export function createCrewMember(index: number): Character {
  return {
    ...DEFAULT_CREW[index % 3],
    kind: "human",
    sprite: undefined,
    preset: undefined,
    id: `custom-${crypto.randomUUID()}`,
    name: `Friend ${String(index).padStart(2, "0")}`,
  };
}
export const hex = (value: unknown, fallback: string) =>
  typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : fallback;

export function normalizeGeneratedAbility(
  input: unknown,
): GeneratedAbility | undefined {
  if (!input || typeof input !== "object") return;
  const { name, description, style, art } = input as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 28 ||
    typeof description !== "string" ||
    !description.trim() ||
    description.trim().length > 120 ||
    (style !== "burst" && style !== "projectile" && style !== "rush") ||
    typeof art !== "string" ||
    !/^\/api\/studio\/assets\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.png$/.test(
      art,
    )
  )
    return;
  return { name: name.trim(), description: description.trim(), style, art };
}

export function normalizeCharacter(
  raw: unknown,
  fallback = DEFAULT_CREW[0],
): Character {
  const c =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    id:
      typeof c.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(c.id)
        ? c.id
        : fallback.id,
    preset:
      typeof c.preset === "string" && castPresets.has(c.preset)
        ? (c.preset as Character["preset"])
        : undefined,
    kind: c.kind === "mint" || c.kind === "human" ? c.kind : fallback.kind,
    name:
      typeof c.name === "string" && c.name.trim()
        ? c.name.trim().slice(0, 28)
        : fallback.name,
    skin: hex(c.skin, fallback.skin),
    hairColor: hex(c.hairColor, fallback.hairColor),
    shirt: hex(c.shirt ?? c.topColor, fallback.shirt),
    pants: hex(c.pants ?? c.bottomColor, fallback.pants),
    hatColor: hex(c.hatColor, fallback.hatColor),
    hair: ["short", "messy", "long", "curly", "bald"].includes(String(c.hair))
      ? (c.hair as Hair)
      : fallback.hair,
    hat: ["none", "beanie", "cap"].includes(String(c.hat))
      ? (c.hat as Hat)
      : fallback.hat,
    glasses:
      typeof c.glasses === "boolean"
        ? c.glasses
        : typeof c.glasses === "string"
          ? c.glasses !== "none"
          : fallback.glasses,
    heightScale:
      typeof c.heightScale === "number" && Number.isFinite(c.heightScale)
        ? Math.max(0.75, Math.min(1.6, c.heightScale))
        : fallback.heightScale,
    sprite:
      typeof c.sprite === "string" &&
      (/^data:image\/(png|webp);base64,/.test(c.sprite) ||
        /^\/api\/studio\/assets\/[a-f0-9-]{36}\.png$/.test(c.sprite)) &&
      c.sprite.length < 1_500_000
        ? c.sprite
        : undefined,
    ability: normalizeGeneratedAbility(c.ability),
  };
}
export function parseCrew(input: unknown): Character[] {
  const data = input as { crew?: unknown };
  const list = Array.isArray(input)
    ? input
    : data && Array.isArray(data.crew)
      ? data.crew
      : [];
  if (
    !list.length ||
    list.some(
      (c) =>
        !c ||
        typeof c !== "object" ||
        typeof (c as Character).name !== "string",
    )
  )
    throw new Error(
      "Choose a crew JSON exported from Grapevine or Paper Town.",
    );
  const ids = new Set<string>();
  return list.slice(0, MINT_CREW_LIMIT).map((c, i) => {
    const character = normalizeCharacter(c, {
      ...DEFAULT_CREW[i % 3],
      kind: "human",
      id: i === 0 ? "you" : `friend-${i}`,
    });
    if (ids.has(character.id)) character.id = `import-${i}`;
    while (ids.has(character.id)) character.id += "-copy";
    ids.add(character.id);
    return character;
  });
}
// Tree trunks and building footprints; movement uses the feet, not the sprite bounds.
export const OBSTACLES = TOWN_OBSTACLES;
export interface WalkArea {
  bounds: typeof WALK_BOUNDS;
  obstacles: readonly Footprint[];
}
export const MINT_WALK_AREA: WalkArea = {
  bounds: WALK_BOUNDS,
  obstacles: OBSTACLES,
};
export function canStand(p: Point, area = MINT_WALK_AREA): boolean {
  const { left, right, top, bottom } = area.bounds;
  return (
    p.x >= left &&
    p.x <= right &&
    p.y >= top &&
    p.y <= bottom &&
    !area.obstacles.some(
      (r) =>
        p.x > r.x - 15 &&
        p.x < r.x + r.w + 15 &&
        p.y > r.y - 8 &&
        p.y < r.y + r.h + 8,
    )
  );
}
export function movePlayer(p: Point, dx: number, dy: number, area = MINT_WALK_AREA): Point {
  const x = canStand({ x: p.x + dx, y: p.y }, area) ? p.x + dx : p.x;
  const y = canStand({ x, y: p.y + dy }, area) ? p.y + dy : p.y;
  return { x, y };
}
/** Consume movement in short steps so slower frames cannot skip over obstacles. */
export function movePlayerInSteps(p: Point, dx: number, dy: number, area = MINT_WALK_AREA): Point {
  const count = Math.max(
    1,
    Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 8),
  );
  let next = p;
  for (let i = 0; i < count; i++)
    next = movePlayer(next, dx / count, dy / count, area);
  return next;
}

export function loadSave(
  saveKey = SAVE_KEY,
  area = MINT_WALK_AREA,
  spawn = START,
  fallbackKey?: string,
): SaveGame {
  const fresh = () => ({ ...initialSave(), player: { ...spawn } });
  try {
    const saved = localStorage.getItem(saveKey);
    const fallback = !saved && fallbackKey ? localStorage.getItem(fallbackKey) : null;
    const raw = JSON.parse(saved || fallback || "null");
    if (raw?.version !== 1) return fresh();
    const crew = parseCrew(raw.crew);
    const previousCastVersion = raw.castVersion ?? 0;
    while (crew.length < 3) crew.push({ ...DEFAULT_CREW[crew.length] });
    // Add the newly designed cast member once without replacing customized friends or progress.
    if (
      previousCastVersion < 1 &&
      !crew.some((c) => c.preset === "baguette-guy") &&
      crew.length < MINT_CREW_LIMIT
    ) {
      crew.push({ ...BAGUETTE_GUY, id: `friend-${crew.length}` });
    }
    if (
      previousCastVersion < 2 &&
      !crew.some((c) => c.preset === "flag-girl") &&
      crew.length < MINT_CREW_LIMIT
    ) {
      crew.push({ ...FLAG_GIRL, id: `friend-${crew.length}` });
    }
    if (previousCastVersion < 3) {
      for (const character of crew) {
        if (
          character.preset === "baguette-guy" &&
          character.name === "Baguette Guy"
        )
          character.name = "Baguette";
        if (character.preset === "flag-girl" && character.name === "Flag Girl")
          character.name = "Sarina";
      }
    }
    if (
      previousCastVersion < 4 &&
      !crew.some((c) => c.preset === "david") &&
      crew.length < MINT_CREW_LIMIT
    ) {
      crew.push({ ...DAVID, id: `friend-${crew.length}` });
    }
    if (
      previousCastVersion < 5 &&
      !crew.some((c) => c.preset === "ghost") &&
      crew.length < MINT_CREW_LIMIT
    ) {
      crew.push({ ...GHOST, id: `friend-${crew.length}` });
    }
    if (previousCastVersion < 6) {
      for (const character of LATEST_CAST) {
        if (
          crew.length < MINT_CREW_LIMIT &&
          !crew.some((c) => c.preset === character.preset)
        ) {
          crew.push({ ...character, id: `friend-${crew.length}` });
        }
      }
    }
    if (previousCastVersion < 7) {
      for (const character of DEMO_ADDITIONS) {
        if (
          crew.length < MINT_CREW_LIMIT &&
          !crew.some((c) => c.preset === character.preset)
        )
          crew.push({ ...character, id: `friend-${crew.length}` });
      }
    }
    if (previousCastVersion < 11) {
      const additions = [
        ...(previousCastVersion < 8 ? CAST_ADDITIONS : []),
        ...(previousCastVersion < 9 ? [GRACE, TOMMY] : []),
        ...(previousCastVersion < 10 ? CAST_VERSION_10_ADDITIONS : []),
        BABASHARK,
      ];
      for (const character of additions) {
        if (
          crew.length >= MINT_CREW_LIMIT ||
          crew.some((c) => c.preset === character.preset)
        )
          continue;
        let id = character.id;
        let suffix = 1;
        while (crew.some((c) => c.id === id))
          id = `${character.id}-${suffix++}`;
        crew.push({ ...character, id });
      }
    }
    const player =
      saved &&
      raw.player &&
      Number.isFinite(raw.player.x) &&
      Number.isFinite(raw.player.y) &&
      canStand(raw.player, area)
        ? raw.player
        : { ...spawn };
    return {
      version: 1,
      castVersion: 11,
      tvLook: raw.tvLook !== false,
      activeCharacter:
        typeof raw.activeCharacter === "string"
          ? (
              crew.find((c) => c.id === raw.activeCharacter) ??
              crew.find((c) => c.preset === raw.activeCharacter)
            )?.id
          : undefined,
      player,
      crew,
      greeted: raw.greeted === true,
      inspected: raw.inspected === true,
      complete:
        raw.complete === true && raw.greeted === true && raw.inspected === true,
      sound: raw.sound === true,
    };
  } catch {
    return fresh();
  }
}
export const spots = [
  {
    id: "friend",
    x: 470,
    y: 575,
    label: "Talk to your friend",
    destination: { x: 510, y: 582 },
  },
  {
    id: "board",
    x: 946,
    y: 779,
    label: "Read the noticeboard",
    destination: { x: 936, y: 812 },
  },
  {
    id: "bus",
    x: 1196,
    y: 538,
    label: "Meet at the bus stop",
    destination: { x: 1154, y: 551 },
  },
  {
    id: "cafe",
    x: 540,
    y: 470,
    label: "Read the café menu",
    destination: { x: 541, y: 499 },
  },
  {
    id: "store",
    x: 228,
    y: 470,
    label: "Visit the corner store",
    destination: { x: 234, y: 500 },
  },
] as const;
export type SpotId = (typeof spots)[number]["id"];
export function closestSpot(p: Point) {
  return spots
    .map((s) => ({ ...s, distance: Math.hypot(s.x - p.x, s.y - p.y) }))
    .filter((s) => s.distance < 90)
    .sort((a, b) => a.distance - b.distance)[0];
}
