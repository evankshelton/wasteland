// Encampments: small settlements scattered through the wasteland. Each is an
// icon on the overworld, entered like the base, with its own generated name,
// layout and set of trader booths. A camp's layout is a pure function of its
// seed, so only the seed, position and name need saving.
import type { BaseFile } from "./base.ts";
import { hash2 } from "./noise.ts";
import { T, isPassable, tileId } from "./tiles.ts";
import { BASE, CHUNK_SIZE } from "./worldgen.ts";

/** Chance that a newly generated chunk holds an encampment. */
export const CAMP_CHANCE = 0.06;
/** No camps this close (tiles) to the base. */
export const CAMP_MIN_BASE_DISTANCE = 40;

const SALT = { place: 101, spot: 103, name: 107, seed: 109 } as const;

/** Small, fast, seedable random numbers (mulberry32). */
export function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;
const between = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

// Overworld terrain a camp can sit on.
const CAMP_GROUND = new Set<number>([T.WASTELAND, T.SCRUB, T.RUBBLE, T.ROAD, T.DUNES, T.HILLS, T.DEAD_FOREST]);

/**
 * Where (local x, y) to put an encampment in a freshly generated chunk, if
 * this chunk gets one: a walkable spot, well away from the base.
 */
export function campSpot(seed: number, cx: number, cy: number, tiles: Uint8Array): { lx: number; ly: number } | undefined {
  if (hash2(seed + SALT.place, cx, cy) / 4294967296 >= CAMP_CHANCE) return undefined;
  const rng = rngFrom(hash2(seed + SALT.spot, cx, cy));
  for (let attempt = 0; attempt < 20; attempt++) {
    const lx = between(rng, 2, CHUNK_SIZE - 3);
    const ly = between(rng, 2, CHUNK_SIZE - 3);
    const x = cx * CHUNK_SIZE + lx;
    const y = cy * CHUNK_SIZE + ly;
    if (Math.hypot(x - BASE.icon.x, y - BASE.icon.y) < CAMP_MIN_BASE_DISTANCE) return undefined;
    if (CAMP_GROUND.has(tiles[ly * CHUNK_SIZE + lx]!)) return { lx, ly };
  }
  return undefined;
}

/** The seed a camp's layout grows from. */
export function campSeed(worldSeed: number, x: number, y: number): number {
  return hash2(worldSeed + SALT.seed, x, y);
}

const NAME_FIRST = [
  "Rust", "Ash", "Bone", "Dust", "Scrap", "Cinder", "Glow", "Salt", "Iron", "Rot", "Grit", "Slag", "Tin", "Rad",
  "Hollow", "Crow", "Burnt", "Dead", "Copper", "Lead", "Sludge", "Static", "Ember", "Blight",
];
const NAME_SECOND = [
  "water", "gate", "wick", "ford", "hold", "pit", "fall", "ridge", "haven", "crossing", "well", "yard", "mire",
  "stead", "rest", "end", "hollow", "fields",
];
const NAME_KIND = ["", "", "", " Post", " Camp", " Market", " Stop", " Outpost", " Den", " Refuge"];

/** A camp name; `attempt` gives a different one when the first is already taken. */
export function campName(worldSeed: number, x: number, y: number, attempt: number): string {
  const rng = rngFrom(hash2(worldSeed + SALT.name + attempt * 7919, x, y));
  const first = pick(rng, NAME_FIRST);
  let second = pick(rng, NAME_SECOND);
  if (second.toLowerCase() === first.toLowerCase()) second = "stead";
  const name = `${first}${second}${pick(rng, NAME_KIND)}`;
  return attempt < 50 ? name : `${name} ${attempt}`; // Name space exhausted: number them.
}

// ---- booths ----

interface BoothType {
  role: string;
  service: string;
  lines: string[][]; // alternatives: one set is chosen per NPC
}

/** The kinds of trader a camp can have; each camp picks a few. */
export const BOOTH_TYPES: readonly BoothType[] = [
  { role: "Gunsmith", service: "weapons", lines: [
    ["Everything here fires. Mostly in the direction you point it.", "Trading opens when the caps start flowing."],
    ["Pipe guns, zip guns, the odd rifle with most of its parts.", "Come back with caps."]] },
  { role: "Armorer", service: "armor", lines: [
    ["Tire rubber, road signs, a fridge door. All armor if you're brave.", "Nothing for sale until there's money in this wasteland."],
    ["I patch plates and sell them twice.", "Not today, though."]] },
  { role: "Medic", service: "healing", lines: [
    ["Bleeding? Sit. Don't touch anything.", "There. You'll scar, but you'll live."],
    ["I've sewn up worse with less.", "Done. Try to keep your blood on the inside."]] },
  { role: "Rad Doc", service: "radiation", lines: [
    ["Your counter's clicking. That's never good.", "Once we can measure the rads in you, I can scrub them out."],
    ["Glow's pretty, isn't it? It'll kill you.", "Come back when the scrubbers are running."]] },
  { role: "Scrap Trader", service: "trade", lines: [
    ["Wire, bolts, half a radio. One day it'll all be worth something.", "No deals yet."],
    ["I buy junk and sell treasure. Same stuff.", "Nothing changing hands just now."]] },
  { role: "Water Seller", service: "water", lines: [
    ["Boiled twice, filtered once. Mostly clear.", "Water's for regulars only, for now."],
    ["Don't drink the green puddles. Drink mine.", "When there's caps to pay with."]] },
  { role: "Cook", service: "food", lines: [
    ["Don't ask what's in it. It's warm.", "Kitchen's not serving strangers yet."],
    ["Rat on a stick. Two-headed rat, extra stick.", "Come back hungry later."]] },
  { role: "Barkeep", service: "drink", lines: [
    ["Rotgut, fresh from the radiator.", "Heard the zombies get thicker out in the hot zones."],
    ["Sit, drink, don't start trouble.", "Folk say the base is southwest of most camps. Most."]] },
  { role: "Mechanic", service: "repair", lines: [
    ["If it's broke, I can make it differently broke.", "Bring me something to fix, someday."],
    ["Engine grease in my blood by now.", "No repairs till the parts trade picks up."]] },
  { role: "Rumormonger", service: "rumors", lines: [
    ["Packs out east come fifteen strong, they say.", "Don't fight in the fog if you can help it. Run for the dark ring."],
    ["Every camp has a medic or wishes it did.", "The dead don't sleep, but they're slow. Use that."]] },
];

const NPC_NAMES = [
  "Mags", "Rook", "Tess", "Jory", "Vin", "Ada", "Cutter", "Lark", "Bram", "Nell", "Quill", "Sable", "Dex", "Wren",
  "Hob", "Ivy", "Gus", "Pell", "Juno", "Ox", "Flint", "Mara", "Tock", "Rue", "Sully", "Kit", "Bones", "Dot",
];

// ---- layouts ----

/** Characters of the camp map, as in shared/base.json. */
const LEGEND: Record<string, string> = {
  ".": "wasteland", ",": "scrub", "=": "road", ":": "concrete", "_": "base_floor", ";": "rubble",
  "#": "base_wall", "+": "door", "C": "counter", "X": "crate", "T": "tent", "F": "campfire", "B": "barricade",
};
const WALKABLE = new Set(Object.entries(LEGEND).filter(([, key]) => isPassable(tileId(key))).map(([ch]) => ch));

export type CampStyle = "market" | "stockade" | "tents" | "ruin";
export const CAMP_STYLES: readonly CampStyle[] = ["market", "stockade", "tents", "ruin"];

interface Booth {
  type: BoothType;
  /** NPC position; the counter is the row below it and the customer stands below that. */
  x: number;
  y: number;
}

class Grid {
  readonly w: number;
  readonly h: number;
  private cells: string[][];
  constructor(w: number, h: number, fill: string) {
    this.w = w;
    this.h = h;
    this.cells = Array.from({ length: h }, () => Array<string>(w).fill(fill));
  }
  get(x: number, y: number): string {
    return this.cells[y]?.[x] ?? "";
  }
  set(x: number, y: number, ch: string): void {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.cells[y]![x] = ch;
  }
  fill(x0: number, y0: number, x1: number, y1: number, ch: string): void {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, ch);
  }
  rows(): string[] {
    return this.cells.map((r) => r.join(""));
  }
}

/** Generate a camp's map, booths and NPCs from its seed. Always returns a layout that passes `checkLayout`. */
export function campLayout(seed: number, name: string): BaseFile & { style: CampStyle } {
  for (let attempt = 0; attempt < 40; attempt++) {
    const rng = rngFrom(seed + attempt * 9973);
    const style = pick(rng, CAMP_STYLES);
    const built = style === "ruin" ? buildRuin(rng) : buildOutdoor(rng, style);
    if (!built) continue;
    const def = finish(rng, name, style, built.grid, built.booths, built.entry, built.rooms);
    if (checkLayout(def)) return def;
  }
  throw new Error(`could not lay out camp ${name} (${seed})`);
}

interface Built {
  grid: Grid;
  booths: Booth[];
  entry: [number, number];
  rooms: { name: string; rect: [number, number, number, number] }[];
}

/** A booth: counter (3 wide) with the NPC behind it and supplies behind them. Needs a clear 5x4 patch. */
function placeBooth(grid: Grid, x: number, y: number, floor: string, rng: () => number): void {
  grid.fill(x - 2, y - 1, x + 2, y + 2, floor);
  grid.set(x - 1, y - 1, rng() < 0.6 ? "X" : floor);
  grid.set(x + 1, y - 1, rng() < 0.6 ? "X" : floor);
  for (let dx = -1; dx <= 1; dx++) grid.set(x + dx, y + 1, "C");
}

function boothCount(rng: () => number): number {
  return between(rng, 2, 5);
}

function buildOutdoor(rng: () => number, style: CampStyle): Built | undefined {
  const w = between(rng, 24, 32);
  const h = between(rng, 22, 30);
  const grid = new Grid(w, h, ".");
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (rng() < 0.18) grid.set(x, y, ",");
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const rooms: Built["rooms"] = [];

  if (style === "stockade") {
    // A ring of scrap barricades with a few gaps, around a campfire.
    const x0 = 3, y0 = 3, x1 = w - 4, y1 = h - 4;
    for (let x = x0; x <= x1; x++) { grid.set(x, y0, "B"); grid.set(x, y1, "B"); }
    for (let y = y0; y <= y1; y++) { grid.set(x0, y, "B"); grid.set(x1, y, "B"); }
    const gaps: [number, number][] = [[cx, y1], [cx + 1, y1]]; // always a south gate
    if (rng() < 0.7) gaps.push([cx, y0], [cx + 1, y0]);
    if (rng() < 0.5) gaps.push([x0, cy], [x0, cy + 1]);
    if (rng() < 0.5) gaps.push([x1, cy], [x1, cy + 1]);
    for (const [x, y] of gaps) grid.set(x, y, ";");
    for (let y = y1; y < h; y++) grid.set(cx, y, "=");
    rooms.push({ name: "Inside the stockade", rect: [x0 + 1, y0 + 1, x1 - x0 - 1, y1 - y0 - 1] });
  } else if (style === "market") {
    // An open plaza on a crossroads.
    for (let x = 0; x < w; x++) grid.set(x, cy + 3, "=");
    for (let y = 0; y < h; y++) grid.set(cx, y, "=");
    grid.fill(cx - 5, cy - 4, cx + 5, cy + 6, ":");
    rooms.push({ name: "Market square", rect: [cx - 5, cy - 4, 11, 11] });
  } else {
    // Tents scattered around a fire.
    rooms.push({ name: "Among the tents", rect: [2, 2, w - 4, h - 4] });
  }
  grid.set(cx, cy, "F");

  // Booths on free ground, apart from each other and clear of the fire and gates.
  const booths: Booth[] = [];
  const want = boothCount(rng);
  const floor = style === "market" ? ":" : ".";
  for (let tries = 0; tries < 200 && booths.length < want; tries++) {
    const x = between(rng, 5, w - 6);
    const y = between(rng, 5, h - 8);
    if (Math.abs(x - cx) < 4 && Math.abs(y - cy) < 4) continue;
    if (booths.some((b) => Math.abs(b.x - x) < 7 && Math.abs(b.y - y) < 6)) continue;
    let clear = true;
    for (let yy = y - 1; yy <= y + 3 && clear; yy++) {
      for (let xx = x - 2; xx <= x + 2; xx++) if ("BFT".includes(grid.get(xx, yy))) clear = false;
    }
    if (!clear) continue;
    placeBooth(grid, x, y, floor, rng);
    booths.push({ type: BOOTH_TYPES[0]!, x, y }); // type filled in by finish()
  }

  if (style === "tents") {
    for (let tries = 0; tries < 40; tries++) {
      const x = between(rng, 3, w - 5);
      const y = between(rng, 3, h - 5);
      if (Math.abs(x - cx) < 3 && Math.abs(y - cy) < 3) continue;
      if (booths.some((b) => x >= b.x - 4 && x <= b.x + 3 && y >= b.y - 3 && y <= b.y + 4)) continue;
      // Keep a walkable gap around each 2x2 tent.
      let free = true;
      for (let yy = y - 1; yy <= y + 2 && free; yy++) for (let xx = x - 1; xx <= x + 2; xx++) if (grid.get(xx, yy) === "T") free = false;
      if (!free) continue;
      grid.fill(x, y, x + 1, y + 1, "T");
    }
  }
  return { grid, booths, entry: [cx, h - 2], rooms };
}

/** An old building split into rooms, with booths inside and a door on the south side. */
function buildRuin(rng: () => number): Built | undefined {
  const w = between(rng, 24, 32);
  const h = between(rng, 22, 28);
  const grid = new Grid(w, h, ".");
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (rng() < 0.2) grid.set(x, y, rng() < 0.5 ? "," : ";");
  const x0 = 2, y0 = 2, x1 = w - 3, y1 = h - 4;
  grid.fill(x0, y0, x1, y1, "#");
  const floor = rng() < 0.5 ? "_" : ":";
  grid.fill(x0 + 1, y0 + 1, x1 - 1, y1 - 1, floor);

  // Split into rooms (a binary space partition), with a door in every dividing wall.
  type Rect = { x0: number; y0: number; x1: number; y1: number }; // interior, inclusive
  let rooms: Rect[] = [{ x0: x0 + 1, y0: y0 + 1, x1: x1 - 1, y1: y1 - 1 }];
  for (let round = 0; round < 3; round++) {
    const next: Rect[] = [];
    for (const r of rooms) {
      const rw = r.x1 - r.x0 + 1;
      const rh = r.y1 - r.y0 + 1;
      if (rw >= 12 && (rw >= rh || rh < 10) && rng() < 0.85) {
        const sx = between(rng, r.x0 + 5, r.x1 - 5);
        for (let y = r.y0; y <= r.y1; y++) grid.set(sx, y, "#");
        grid.set(sx, between(rng, r.y0 + 3, r.y1), "+");
        next.push({ ...r, x1: sx - 1 }, { ...r, x0: sx + 1 });
      } else if (rh >= 10 && rng() < 0.85) {
        const sy = between(rng, r.y0 + 5, r.y1 - 4);
        for (let x = r.x0; x <= r.x1; x++) grid.set(x, sy, "#");
        grid.set(between(rng, r.x0, r.x1), sy, "+");
        next.push({ ...r, y1: sy - 1 }, { ...r, y0: sy + 1 });
      } else {
        next.push(r);
      }
    }
    rooms = next;
  }
  // Front door in the south wall, into whichever room is there, with a path out.
  const door = between(rng, x0 + 3, x1 - 3);
  grid.set(door, y1, "+");
  for (let y = y1 + 1; y < h; y++) grid.set(door, y, "=");

  // A booth against the north wall of some rooms (5 wide, 4 deep to fit).
  const booths: Booth[] = [];
  const want = boothCount(rng);
  const roomNames: Built["rooms"] = [];
  const shuffled = rooms.slice().sort(() => rng() - 0.5);
  for (const r of shuffled) {
    if (booths.length >= want) break;
    if (r.x1 - r.x0 + 1 < 5 || r.y1 - r.y0 + 1 < 4) continue;
    const x = between(rng, r.x0 + 2, r.x1 - 2);
    const y = r.y0;
    // Don't wall off a door: keep the counter row and the row below free of doors beside it.
    if (grid.get(x - 2, y + 1) === "+" || grid.get(x + 2, y + 1) === "+") continue;
    grid.set(x - 1, y, rng() < 0.6 ? "X" : floor);
    grid.set(x + 1, y, rng() < 0.6 ? "X" : floor);
    for (let dx = -1; dx <= 1; dx++) grid.set(x + dx, y + 1, "C");
    booths.push({ type: BOOTH_TYPES[0]!, x, y });
  }
  for (const r of rooms) roomNames.push({ name: "", rect: [r.x0, r.y0, r.x1 - r.x0 + 1, r.y1 - r.y0 + 1] });
  return { grid, booths, entry: [door, y1 - 1], rooms: roomNames };
}

/** Pick trader types and names for the booths, and turn the grid into a site definition. */
function finish(
  rng: () => number, name: string, style: CampStyle, grid: Grid, booths: Booth[], entry: [number, number],
  rooms: Built["rooms"],
): BaseFile & { style: CampStyle } {
  if (booths.length < 2) return { name, style, legend: LEGEND, map: [], entry, respawn: entry, rooms: [], npcs: [] };
  const types = BOOTH_TYPES.slice().sort(() => rng() - 0.5).slice(0, booths.length);
  const names = NPC_NAMES.slice().sort(() => rng() - 0.5);
  const npcs = booths.map((b, i) => ({
    id: i + 1,
    name: names[i]!,
    role: types[i]!.role,
    service: types[i]!.service,
    pos: [b.x, b.y] as [number, number],
    lines: pick(rng, types[i]!.lines),
  }));
  // Name the room each booth is in after its trader; other rooms get plain names.
  const named = rooms.map((r) => {
    const inside = npcs.find((n) => n.pos[0] >= r.rect[0] && n.pos[0] < r.rect[0] + r.rect[2] && n.pos[1] >= r.rect[1] && n.pos[1] < r.rect[1] + r.rect[3]);
    return { name: r.name || (inside ? `${inside.role}'s room` : pick(rng, ["Back room", "Store room", "Hall", "Bunk room"])), rect: r.rect };
  });
  const stalls = style === "ruin" ? [] : npcs.map((n) => ({ name: `${n.role}'s stall`, rect: [n.pos[0] - 2, n.pos[1] - 1, 5, 4] as [number, number, number, number] }));
  return { name, style, legend: LEGEND, map: grid.rows(), entry, respawn: entry, rooms: [...stalls, ...named], npcs };
}

/**
 * A playable layout: rectangular, the entry is walkable, an edge can be
 * reached from it (to leave), and every NPC can be talked to (the tile in
 * front of their counter is reachable).
 */
export function checkLayout(def: BaseFile): boolean {
  const h = def.map.length;
  if (h === 0 || def.npcs.length < 2) return false;
  const w = def.map[0]!.length;
  if (!def.map.every((r) => r.length === w)) return false;
  const npcAt = new Set(def.npcs.map((n) => `${n.pos[0]},${n.pos[1]}`));
  const walk = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && WALKABLE.has(def.map[y]![x]!) && !npcAt.has(`${x},${y}`);
  const [ex, ey] = def.entry;
  if (!walk(ex, ey)) return false;
  const seen = new Set<string>([`${ex},${ey}`]);
  const queue: [number, number][] = [[ex, ey]];
  let edge = false;
  while (queue.length) {
    const [x, y] = queue.shift()!;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const k = `${x + dx},${y + dy}`;
      if (!seen.has(k) && walk(x + dx, y + dy)) {
        seen.add(k);
        queue.push([x + dx, y + dy]);
      }
    }
  }
  return edge && def.npcs.every((n) => seen.has(`${n.pos[0]},${n.pos[1] + 2}`));
}
