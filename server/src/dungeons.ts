// Dungeons: old tunnels, vaults and sewers under the wasteland. Each is a
// single entrance tile on the overworld; below are 2-4 levels, each a
// labyrinth of rooms, doors and winding passageways, generated from the
// dungeon's seed and the level (so only the seed, position and name need
// saving). On every level but the last, stairs down wait in the room farthest
// from where you arrive; on the bottom level that room holds a staircase back
// out to the surface. Below the first level you arrive at the foot of stairs
// up, which climb back to the level above, so you can always retrace your
// steps; the ladder you came down by on the first level leads back out.
// Zombies roam the passages (see dungeonGround in monsters.ts).
//
// Layouts use the "rooms and mazes" method: scatter rooms, fill the rock
// between them with a maze of passages, knock doors through to join every
// region into one (plus a few extra doors, so there's more than one way
// round), then fill in most of the passages' dead ends.
import type { BaseFile } from "./base.ts";
import { rngFrom } from "./camps.ts";
import { hash2 } from "./noise.ts";
import { T } from "./tiles.ts";
import { BASE, CHUNK_SIZE } from "./worldgen.ts";

/** Chance that a newly generated chunk holds a dungeon entrance. */
export const DUNGEON_CHANCE = 0.05;
/** No entrances this close (tiles) to the base. */
export const DUNGEON_MIN_BASE_DISTANCE = 30;
/** Chance a door between two already-joined regions is opened anyway, making loops. */
const EXTRA_DOOR_CHANCE = 0.04;
/** Chance a dead end is left alone rather than filled in. */
const KEEP_DEAD_END_CHANCE = 0.25;

const SALT = { place: 201, spot: 203, name: 207, seed: 209 } as const;

const pick = <V>(rng: () => number, list: readonly V[]): V => list[Math.floor(rng() * list.length)]!;
const between = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const odd = (n: number) => (n % 2 === 0 ? n + 1 : n);

// Overworld terrain an entrance can sit on.
const DUNGEON_GROUND = new Set<number>([T.WASTELAND, T.SCRUB, T.RUBBLE, T.HILLS, T.DUNES, T.DEAD_FOREST, T.CRATER]);

/**
 * Where (local x, y) to put a dungeon entrance in a freshly generated chunk,
 * if it gets one: a walkable spot away from the base, and not `taken` (the
 * chunk's encampment, if any).
 */
export function dungeonSpot(
  seed: number, cx: number, cy: number, tiles: Uint8Array, taken?: { lx: number; ly: number },
): { lx: number; ly: number } | undefined {
  if (hash2(seed + SALT.place, cx, cy) / 4294967296 >= DUNGEON_CHANCE) return undefined;
  const rng = rngFrom(hash2(seed + SALT.spot, cx, cy));
  for (let attempt = 0; attempt < 20; attempt++) {
    const lx = between(rng, 2, CHUNK_SIZE - 3);
    const ly = between(rng, 2, CHUNK_SIZE - 3);
    if (taken && Math.max(Math.abs(lx - taken.lx), Math.abs(ly - taken.ly)) < 3) continue;
    const x = cx * CHUNK_SIZE + lx;
    const y = cy * CHUNK_SIZE + ly;
    if (Math.hypot(x - BASE.icon.x, y - BASE.icon.y) < DUNGEON_MIN_BASE_DISTANCE) return undefined;
    if (DUNGEON_GROUND.has(tiles[ly * CHUNK_SIZE + lx]!)) return { lx, ly };
  }
  return undefined;
}

/** The seed a dungeon's layout grows from. */
export function dungeonSeed(worldSeed: number, x: number, y: number): number {
  return hash2(worldSeed + SALT.seed, x, y);
}

const NAME_ADJ = ["Flooded", "Sunken", "Collapsed", "Buried", "Rusted", "Forgotten", "Silent", "Glowing", "Choked", "Black"];
const NAME_PLACE = ["Metro Tunnels", "Bunker", "Vault", "Sewers", "Mine", "Fallout Shelter", "Catacombs", "Pump Works", "Cellars", "Pipeworks"];

export function dungeonName(worldSeed: number, x: number, y: number): string {
  const rng = rngFrom(hash2(worldSeed + SALT.name, x, y));
  return `The ${pick(rng, NAME_ADJ)} ${pick(rng, NAME_PLACE)}`;
}

/** Characters of a dungeon map, as in shared/base.json. */
export const DUNGEON_LEGEND: Record<string, string> = {
  "#": "cave_wall", ".": "cave_floor", "+": "door", "L": "ladder", "D": "stairs_down", "U": "stairs_out", "A": "stairs_up",
};
const ROOM_NAMES = [
  "Pump Room", "Storeroom", "Flooded Hall", "Guard Post", "Boiler Room", "Ossuary", "Generator Room", "Dormitory",
  "Platform", "Armory Ruins", "Collapsed Hall", "Cistern", "Control Room", "Mess Hall", "Cold Store",
];

export interface DungeonFile extends BaseFile {
  /** Tiles that lead back up to the overworld. */
  exits: [number, number][];
  /** Tiles that lead down to the next level. */
  down: [number, number][];
  /** Tiles that lead up to the level above. */
  up: [number, number][];
}

/** How many levels a dungeon has: 2 to 4. */
export function dungeonDepth(seed: number): number {
  return 2 + ((seed >>> 0) % 3);
}

type Rect = { x: number; y: number; w: number; h: number };

/** Generate one level (1 = the top) of a dungeon from its seed. Always returns a layout that passes `checkDungeon`. */
export function dungeonLayout(seed: number, name: string, level = 1, depth = dungeonDepth(seed)): DungeonFile {
  for (let attempt = 0; attempt < 20; attempt++) {
    const def = buildDungeon(rngFrom(seed + level * 104729 + attempt * 7919), name, level, depth);
    if (def && checkDungeon(def)) return def;
  }
  throw new Error(`could not lay out level ${level} of dungeon ${name} (${seed})`);
}

function buildDungeon(rng: () => number, name: string, level: number, depth: number): DungeonFile | undefined {
  const w = odd(between(rng, 45, 61));
  const h = odd(between(rng, 35, 45));
  const grid = Array.from({ length: h }, () => Array<string>(w).fill("#"));
  const region = Array.from({ length: h }, () => Array<number>(w).fill(-1));
  let regions = 0;
  const carve = (x: number, y: number, r: number, ch = ".") => {
    grid[y]![x] = ch;
    region[y]![x] = r;
  };

  // Rooms, on odd coordinates with odd sizes so they line up with the maze.
  const rooms: Rect[] = [];
  for (let tries = 0; tries < 300 && rooms.length < 14; tries++) {
    const rw = odd(between(rng, 3, 9));
    const rh = odd(between(rng, 3, 7));
    const x = odd(between(rng, 1, w - rw - 1));
    const y = odd(between(rng, 1, h - rh - 1));
    if (x + rw >= w || y + rh >= h) continue;
    if (rooms.some((r) => x < r.x + r.w + 1 && r.x < x + rw + 1 && y < r.y + r.h + 1 && r.y < y + rh + 1)) continue;
    rooms.push({ x, y, w: rw, h: rh });
    const r = regions++;
    for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) carve(xx, yy, r);
  }
  if (rooms.length < 5) return undefined;

  // A maze of passages through the rest of the rock (growing tree, mostly winding).
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (let sy = 1; sy < h; sy += 2) {
    for (let sx = 1; sx < w; sx += 2) {
      if (grid[sy]![sx] !== "#") continue;
      const r = regions++;
      carve(sx, sy, r);
      const cells: [number, number][] = [[sx, sy]];
      let last: readonly [number, number] | undefined;
      while (cells.length) {
        const [cx, cy] = cells[cells.length - 1]!;
        const open = dirs.filter(([dx, dy]) => {
          const nx = cx + dx * 2;
          const ny = cy + dy * 2;
          return nx > 0 && ny > 0 && nx < w - 1 && ny < h - 1 && grid[ny]![nx] === "#";
        });
        if (!open.length) {
          cells.pop();
          last = undefined;
          continue;
        }
        const d = last && open.includes(last as (typeof open)[number]) && rng() < 0.6 ? last : pick(rng, open);
        carve(cx + d[0], cy + d[1], r);
        carve(cx + d[0] * 2, cy + d[1] * 2, r);
        cells.push([cx + d[0] * 2, cy + d[1] * 2]);
        last = d;
      }
    }
  }

  // Doors: rock between two different regions. Join every region into one,
  // plus the odd extra door so the labyrinth has loops.
  const parent = Array.from({ length: regions }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const connectors: { x: number; y: number; a: number; b: number }[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (grid[y]![x] !== "#") continue;
      const near = new Set<number>();
      for (const [dx, dy] of dirs) if (region[y + dy]![x + dx]! >= 0) near.add(region[y + dy]![x + dx]!);
      if (near.size >= 2) {
        const [a, b] = [...near];
        connectors.push({ x, y, a: a!, b: b! });
      }
    }
  }
  for (let i = connectors.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [connectors[i], connectors[j]] = [connectors[j]!, connectors[i]!];
  }
  const isRoom = (r: number) => r < rooms.length;
  const doorAt = (x: number, y: number) => dirs.some(([dx, dy]) => grid[y + dy]![x + dx] === "+");
  for (const c of connectors) {
    const joined = find(c.a) === find(c.b);
    if (joined && rng() >= EXTRA_DOOR_CHANCE) continue;
    if (doorAt(c.x, c.y)) continue;
    // A door where a room meets anything; passages just run on into each other.
    carve(c.x, c.y, c.a, isRoom(c.a) || isRoom(c.b) ? "+" : ".");
    parent[find(c.a)] = find(c.b);
  }

  // Fill in dead ends (most of them), so passages lead somewhere.
  for (let changed = true; changed; ) {
    changed = false;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (grid[y]![x] === "#" || isRoom(region[y]![x]!)) continue;
        const exits = dirs.filter(([dx, dy]) => grid[y + dy]![x + dx] !== "#").length;
        if (exits > 1 || (grid[y]![x] === "." && exits === 1 && rng() < KEEP_DEAD_END_CHANCE / 8)) continue;
        grid[y]![x] = "#";
        region[y]![x] = -1;
        changed = true;
      }
    }
  }

  // You arrive in the middle of the first room: beside the ladder out on the
  // first level, at the foot of the stairs up (the ones you came down) below that.
  const middle = (r: Rect): [number, number] => [r.x + (r.w >> 1), r.y + (r.h >> 1)];
  const start = rooms[0]!;
  const [lx, ly] = middle(start);
  const exits: [number, number][] = [];
  const up: [number, number][] = [];
  if (level === 1) {
    grid[ly]![lx] = "L";
    exits.push([lx, ly]);
  } else {
    grid[ly]![lx] = "A";
    up.push([lx, ly]);
  }
  const entry: [number, number] = ly + 1 < start.y + start.h ? [lx, ly + 1] : [lx + 1, ly];
  // The way on (down, or out from the bottom) is in the room farthest from there.
  const far = new Map<string, number>([[`${entry[0]},${entry[1]}`, 0]]);
  const queue: [number, number][] = [entry];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    for (const [dx, dy] of dirs) {
      const k = `${x + dx},${y + dy}`;
      if (!far.has(k) && grid[y + dy]![x + dx] !== "#") {
        far.set(k, far.get(`${x},${y}`)! + 1);
        queue.push([x + dx, y + dy]);
      }
    }
  }
  let goal = 1;
  for (let i = 2; i < rooms.length; i++) {
    const [gx, gy] = middle(rooms[i]!);
    if ((far.get(`${gx},${gy}`) ?? -1) > (far.get(middle(rooms[goal]!).join(",")) ?? -1)) goal = i;
  }
  const [sx, sy] = middle(rooms[goal]!);
  const down: [number, number][] = [];
  if (level < depth) {
    grid[sy]![sx] = "D";
    down.push([sx, sy]);
  } else {
    grid[sy]![sx] = "U";
    exits.push([sx, sy]);
  }
  const names = [...ROOM_NAMES];
  const roomList = rooms.map((r, i) => {
    let nm = names.splice(Math.floor(rng() * names.length), 1)[0] ?? "Chamber";
    if (i === 0) nm = level === 1 ? "Entrance Hall" : "Landing";
    if (i === goal) nm = level < depth ? "Stairwell" : "Way Out";
    return { name: nm, rect: [r.x, r.y, r.w, r.h] as [number, number, number, number] };
  });
  return {
    name, legend: DUNGEON_LEGEND, map: grid.map((r) => r.join("")), entry, respawn: entry, rooms: roomList, npcs: [],
    exits, down, up,
  };
}

/** A playable level: walled in, and every open tile reachable from the entry, every way up, out or down included. */
export function checkDungeon(def: DungeonFile): boolean {
  const h = def.map.length;
  const w = def.map[0]?.length ?? 0;
  if (h === 0 || !def.map.every((r) => r.length === w)) return false;
  for (let x = 0; x < w; x++) if (def.map[0]![x] !== "#" || def.map[h - 1]![x] !== "#") return false;
  for (let y = 0; y < h; y++) if (def.map[y]![0] !== "#" || def.map[y]![w - 1] !== "#") return false;
  let open = 0;
  for (const row of def.map) for (const ch of row) if (ch !== "#") open++;
  const [ex, ey] = def.entry;
  if (def.map[ey]?.[ex] !== ".") return false;
  const seen = new Set<string>([`${ex},${ey}`]);
  const queue: [number, number][] = [[ex, ey]];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const k = `${x + dx},${y + dy}`;
      if (!seen.has(k) && def.map[y + dy]?.[x + dx] !== undefined && def.map[y + dy]![x + dx] !== "#") {
        seen.add(k);
        queue.push([x + dx, y + dy]);
      }
    }
  }
  const reached = ([x, y]: [number, number]) => seen.has(`${x},${y}`);
  return seen.size === open && [...def.exits, ...def.down, ...def.up].every(reached) && def.exits.length + def.down.length >= 1 && def.rooms.length >= 5;
}
