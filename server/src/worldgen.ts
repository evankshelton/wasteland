// Procedural overworld. The world is an unbounded grid of tiles split into
// CHUNK_SIZE x CHUNK_SIZE chunks. Generation is deterministic for a given seed;
// the World persists each chunk the first time it is generated so later
// generator changes never rewrite land that players have already seen.
import { fbm, hash2, rand2 } from "./noise.ts";
import { T } from "./tiles.ts";

export const CHUNK_SIZE = 32;

/** The base: a walled compound centred on the world origin. */
export const BASE = {
  half: 8, // walls run from -half..half on both axes
  clearRadius: 16, // terrain inside this radius is kept walkable
  calmRadius: 70, // hazards fade in between clearRadius and this
  spawn: { x: 0, y: 0 },
} as const;

// Independent noise channels derived from the world seed.
const CH = { elev: 11, moist: 23, rad: 37, urban: 41, roadA: 53, roadB: 67, speck: 79, crater: 83, city: 97 } as const;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function baseTile(x: number, y: number): number | undefined {
  const h = BASE.half;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax > h || ay > h) {
    // A short stretch of highway leading south out of the gate.
    if (x === 0 && y > h && y <= h + 24) return T.ROAD;
    return undefined;
  }
  const onWall = ax === h || ay === h;
  if (onWall) {
    if (x === 0 && (y === h || y === -h)) return T.BASE_GATE;
    if (y === 0 && (x === h || x === -h)) return T.BASE_GATE;
    return T.BASE_WALL;
  }
  return T.BASE_FLOOR;
}

/**
 * Old highways follow the zero contour of a noise field. A tile is road when it
 * is on the positive side and any of its 8 neighbours is on the negative side,
 * which yields lines 1-2 tiles wide that are walkable with 4-way movement.
 */
function onContour(seed: number, scale: number, x: number, y: number): boolean {
  if (fbm(seed, x / scale, y / scale, 2) < 0) return false;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if ((ox || oy) && fbm(seed, (x + ox) / scale, (y + oy) / scale, 2) < 0) return true;
    }
  }
  return false;
}

function isRoad(seed: number, x: number, y: number): boolean {
  return onContour(seed + CH.roadA, 220, x, y) || onContour(seed + CH.roadB, 260, x, y);
}

function cityTile(seed: number, x: number, y: number): number {
  // Streets on a coarse grid, blocks of collapsed buildings between them.
  const block = 7;
  const mx = ((x % block) + block) % block;
  const my = ((y % block) + block) % block;
  if (mx === 0 || my === 0) return rand2(seed + CH.city, x, y) < 0.8 ? T.ROAD : T.RUBBLE;
  const bx = Math.floor(x / block);
  const by = Math.floor(y / block);
  const lot = rand2(seed + CH.city, bx, by);
  const r = rand2(seed + CH.speck, x, y);
  if (lot < 0.6) return r < 0.75 ? T.RUINS : T.RUBBLE; // standing ruin
  if (lot < 0.85) return r < 0.7 ? T.RUBBLE : T.WASTELAND; // flattened block
  return r < 0.2 ? T.RUBBLE : T.SCRUB; // empty lot
}

/** Bomb craters on a sparse jittered grid; returns a tile if (x,y) is inside one. */
function craterTile(seed: number, x: number, y: number, hazard: number): number | undefined {
  const cell = 28;
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox;
      const gy = cy + oy;
      const h = hash2(seed + CH.crater, gx, gy);
      if ((h & 0xff) / 256 > 0.35 * hazard) continue;
      const px = gx * cell + ((h >>> 8) % cell);
      const py = gy * cell + ((h >>> 16) % cell);
      const radius = 1.5 + ((h >>> 24) % 4);
      const d = Math.hypot(x - px, y - py);
      if (d <= radius - 0.8) return T.CRATER;
      if (d <= radius + 0.4) return T.RUBBLE;
    }
  }
  return undefined;
}

export function terrainAt(seed: number, x: number, y: number): number {
  const b = baseTile(x, y);
  if (b !== undefined) return b;

  const dist = Math.hypot(x, y);
  // 0 at the base, 1 out in the deep wasteland.
  const hazard = clamp((dist - BASE.clearRadius) / (BASE.calmRadius - BASE.clearRadius), 0, 1);

  let elev = fbm(seed + CH.elev, x / 90, y / 90, 5);
  const moist = fbm(seed + CH.moist, x / 70, y / 70, 4);
  const rad = fbm(seed + CH.rad, x / 45, y / 45, 3);
  const urban = fbm(seed + CH.urban, x / 140, y / 140, 3);
  const speck = rand2(seed + CH.speck, x, y);

  // Flatten the land around the base so the gates never open onto a lake or cliff.
  elev *= 0.25 + 0.75 * hazard;

  if (elev < -0.36) return T.WATER;
  if (elev > 0.5) return T.MOUNTAINS;

  if (isRoad(seed, x, y)) return T.ROAD;

  if (elev < -0.29) return moist > -0.1 ? T.SWAMP : T.WASTELAND;
  if (elev > 0.37) return T.HILLS;

  if (urban > 0.28 && hazard > 0.3) return cityTile(seed, x, y);

  const crater = hazard > 0 ? craterTile(seed, x, y, hazard) : undefined;
  if (crater !== undefined) return crater;

  if (rad > 0.62 - 0.22 * hazard && hazard > 0.2) return T.RADIATION;

  if (moist > 0.32) return speck < 0.85 ? T.DEAD_FOREST : T.SCRUB;
  if (moist > 0.1) return speck < 0.7 ? T.SCRUB : T.WASTELAND;
  if (moist < -0.38) return T.DUNES;
  if (speck < 0.04) return T.RUBBLE;
  return speck < 0.15 ? T.SCRUB : T.WASTELAND;
}

/** Tiles for one chunk, row-major (index = ly * CHUNK_SIZE + lx). */
export function generateChunk(seed: number, cx: number, cy: number): Uint8Array {
  const out = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  const ox = cx * CHUNK_SIZE;
  const oy = cy * CHUNK_SIZE;
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      out[ly * CHUNK_SIZE + lx] = terrainAt(seed, ox + lx, oy + ly);
    }
  }
  return out;
}
