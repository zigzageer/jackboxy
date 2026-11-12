import type { Point } from "./model";

export const TOWN_NAME = "South Park";
export const WORLD = { width: 2400, height: 2100 };
export const WALK_BOUNDS = { left: 40, right: 2360, top: 515, bottom: 2050 };
export const STREET_ROWS = [530, 1200, 1930] as const;
export const STREET_WIDTH = 130;
export type Footprint = { x: number; y: number; w: number; h: number };
export interface TownLocation {
  id: string;
  name: string;
  shortName?: string;
  footprint: Footprint;
  entrance: Point;
}

/** Names stay separate from generated artwork. Rename here without regenerating a facade. */
export const LOCATIONS: TownLocation[] = [
  {
    id: "coffee",
    name: "Tweek Bros. Coffee",
    shortName: "Tweek Bros.",
    footprint: { x: 230, y: 265, w: 350, h: 255 },
    entrance: { x: 440, y: 550 },
  },
  {
    id: "city-wok",
    name: "City Wok",
    footprint: { x: 590, y: 255, w: 370, h: 265 },
    entrance: { x: 800, y: 550 },
  },
  {
    id: "toms",
    name: "Tom’s Rhinoplasty",
    footprint: { x: 1000, y: 265, w: 310, h: 255 },
    entrance: { x: 1170, y: 550 },
  },
  {
    id: "school",
    name: "South Park Elementary",
    footprint: { x: 155, y: 750, w: 810, h: 365 },
    entrance: { x: 560, y: 1160 },
  },
  {
    id: "police",
    name: "Park County Police",
    footprint: { x: 1260, y: 770, w: 770, h: 380 },
    entrance: { x: 1640, y: 1190 },
  },
  {
    id: "cartman",
    name: "Cartman Residence",
    shortName: "Cartman’s house",
    footprint: { x: 150, y: 1430, w: 440, h: 400 },
    entrance: { x: 290, y: 1870 },
  },
  {
    id: "marsh",
    name: "Marsh Residence",
    shortName: "Stan’s house",
    footprint: { x: 610, y: 1430, w: 440, h: 400 },
    entrance: { x: 760, y: 1870 },
  },
  {
    id: "broflovski",
    name: "Broflovski Residence",
    shortName: "Kyle’s house",
    footprint: { x: 1080, y: 1430, w: 440, h: 400 },
    entrance: { x: 1230, y: 1870 },
  },
  {
    id: "mccormick",
    name: "McCormick Residence",
    shortName: "Kenny’s house",
    footprint: { x: 1550, y: 1580, w: 500, h: 250 },
    entrance: { x: 1700, y: 1870 },
  },
  {
    id: "bus-stop",
    name: "Bus Stop",
    footprint: { x: 2265, y: 430, w: 50, h: 70 },
    entrance: { x: 2280, y: 550 },
  },
];

export const location = (id: string) => LOCATIONS.find((l) => l.id === id)!;
export function districtAt(p: Point) {
  return p.y < 720
    ? "Downtown"
    : p.y < 1330
      ? "School & civic center"
      : "The neighborhood";
}

export const TOWN_OBSTACLES: Footprint[] = [
  ...LOCATIONS.map((l) => l.footprint),
  { x: 1060, y: 980, w: 90, h: 28 },
  { x: 2255, y: 1010, w: 35, h: 30 },
];
