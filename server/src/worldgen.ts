// Procedural overworld. The world is an unbounded grid of tiles split into
// CHUNK_SIZE x CHUNK_SIZE chunks. Generation is deterministic for a given seed;
// the World persists each chunk the first time it is generated so later
// generator changes never rewrite land that players have already seen.
//
// The land is continents, shaped by plate tectonics (see CONTINENTS):
// continental plates make the land, ocean plates the seas, and where they meet
// rise mountain ranges, coastal ranges and island arcs, or sink rift valleys.
// The base stands well inland on the continent at the origin. Toxic shallows line the coasts, the open sea beyond is deep, and ash
// beaches and marsh fringe the shore.
//
// The ruined towns sit on a wide jittered grid, one to a cell where there's
// land, and the old highways run between them: every town (and the base) is
// linked to its nearest neighbours, along a gently bending line, so roads lead
// somewhere. A highway carries on over hills and through mountain passes, and
// over lakes and the sea as a causeway, though only a few links across the
// sea were ever built: that's how you reach the other continents.
import { fbm, hash2, rand2 } from "./noise.ts";
import { T } from "./tiles.ts";

export const CHUNK_SIZE = 32;

/**
 * The base: one icon tile at the world origin (like an Ultima IV town), entered
 * with the enter key. Its interior is a separate map (see base.ts).
 */
export const BASE = {
  icon: { x: 0, y: 0 },
  safeRadius: 4, // zombies keep at least this far (Chebyshev) from the icon
  clearRadius: 16, // terrain inside this radius is kept walkable
  calmRadius: 70, // hazards fade in between clearRadius and this
} as const;

/**
 * Bump when generation changes for land that may already be saved, and add a
 * migration in World. v2: the walled compound became a single base icon.
 */
export const WORLD_VERSION = 2; // (v3's continents only shape land nobody has seen yet: no migration)

// Independent noise channels derived from the world seed.
const CH = {
  elev: 11, moist: 23, rad: 37, speck: 79, crater: 83, city: 97,
  continent: 101, warpX: 103, warpY: 107, coast: 109, town: 113, townEdge: 127, link: 131,
  drift: 137, ridge: 139, oldRidge: 149, upland: 151,
} as const;

/**
 * The shape of the land, by plate tectonics, roughly. The world is a jittered
 * grid of plates, each continental or oceanic and drifting its own way. Their
 * levels blend into one another (the continental shelf), and everything is
 * warped and roughened with fractal noise, so coasts are capes, bays, inlets
 * and offshore islands rather than plate edges. Where plates meet:
 *   - two continents colliding push up a great mountain range along the seam;
 *   - a continent riding over an ocean plate gets a coastal range inland;
 *   - two ocean plates colliding throw up an arc of volcanic islands;
 *   - two continents pulling apart open a rift: a long sunken valley, often
 *     flooded into a narrow sea.
 * Old, worn ridges run across continent interiors too. Interiors far from
 * the sea are dry; coasts are wet. `sea`: below it, it's water; shallows run
 * `deepBelow` under that before the open sea; `beach` above it is shore.
 */
export const CONTINENTS = {
  plate: 1150, // tiles per tectonic plate (a cell of the jittered grid)
  jitter: 0.42, // how far from its cell's middle a plate's centre may sit (x plate)
  continental: 0.55, // share of plates that carry land
  softness: 230, // how gradually one plate's level gives way to the next
  warp: 450, // how far everything is pushed about (tiles)...
  warpScale: 1100, // ...over this distance
  detail: 0.3, // fractal noise on the land's level: peninsulas, bays, islands
  landLevel: 0.34,
  oceanLevel: -0.5,
  range: 1.0, // a collision range's height
  rangeWidth: 85, // ...and how wide it spreads either side of its crest
  coastRange: 0.75, // a coastal range's height...
  coastInland: 190, // ...this far inland from the plate edge
  arc: 0.5, // island arcs where ocean plates collide
  rift: 0.5, // how deep a rift sinks
  oldRidges: 0.55, // worn ranges across continent interiors
  homeRadius: 430, // land is raised within this of the base, so it stands well inland
  homeLift: 0.35,
  sea: 0,
  deepBelow: 0.1,
  beach: 0.012,
} as const;

interface Plate {
  x: number;
  y: number;
  continental: boolean;
  /** Which way it drifts (a unit vector). */
  dx: number;
  dy: number;
}

/** The plate in grid cell (gx, gy). The base's plate always carries a continent. */
function plateIn(seed: number, gx: number, gy: number): Plate {
  const c = CONTINENTS;
  const h = hash2(seed + CH.continent, gx, gy);
  const j = (bits: number) => ((bits & 0xff) / 255 - 0.5) * 2 * c.jitter * c.plate;
  const angle = (hash2(seed + CH.drift, gx, gy) / 4294967296) * 2 * Math.PI;
  return {
    x: gx * c.plate + j(h >>> 8),
    y: gy * c.plate + j(h >>> 16),
    continental: (gx === 0 && gy === 0) || (h >>> 24) / 256 < c.continental,
    dx: Math.cos(angle),
    dy: Math.sin(angle),
  };
}

const bell = (v: number, at: number, width: number) => Math.exp(-(((v - at) / width) ** 2));
const smoothstep = (lo: number, hi: number, v: number) => {
  const t = clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};

/** The lie of the land at (x, y). */
export interface Geology {
  /** Above 0 land (higher further inland), below it sea (lower further out). */
  land: number;
  /** Mountain-building: 0 on the plains, about 1 on a range's crest. */
  relief: number;
  /** 0 by the sea, up to about 0.6 deep in a continent's interior. */
  dry: number;
}

export function geology(seed: number, x: number, y: number): Geology {
  const c = CONTINENTS;
  const wx = x + fbm(seed + CH.warpX, x / c.warpScale, y / c.warpScale, 4) * c.warp;
  const wy = y + fbm(seed + CH.warpY, x / c.warpScale, y / c.warpScale, 4) * c.warp;
  const gx = Math.round(wx / c.plate);
  const gy = Math.round(wy / c.plate);
  const near: { p: Plate; d: number }[] = [];
  for (let oy = -2; oy <= 2; oy++) {
    for (let ox = -2; ox <= 2; ox++) {
      const p = plateIn(seed, gx + ox, gy + oy);
      near.push({ p, d: Math.hypot(wx - p.x, wy - p.y) });
    }
  }
  near.sort((a, b) => a.d - b.d);
  const a = near[0]!;
  // Each plate's level, blended by how close it is: sharp in the middle of a plate, soft at its edges.
  let wsum = 0;
  let level = 0;
  for (const n of near.slice(0, 5)) {
    const w = Math.exp(-(n.d - a.d) / c.softness);
    wsum += w;
    level += w * (n.p.continental ? c.landLevel : c.oceanLevel);
  }
  let land = level / wsum;
  // What happens at the edges with the plates around this one.
  let relief = 0;
  const ridged = 1 - Math.abs(fbm(seed + CH.ridge, x / 75, y / 75, 4)); // crests and passes
  for (const n of near.slice(1, 5)) {
    const len = Math.hypot(n.p.x - a.p.x, n.p.y - a.p.y) || 1;
    const nx = (n.p.x - a.p.x) / len;
    const ny = (n.p.y - a.p.y) / len;
    // Distance to the edge between the two plates (the perpendicular bisector).
    const edge = Math.max(0, ((n.d * n.d - a.d * a.d) / (2 * len)));
    const closing = (a.p.dx - n.p.dx) * nx + (a.p.dy - n.p.dy) * ny; // -2..2: positive, they're colliding
    const push = smoothstep(0.25, 1.1, closing);
    const pull = smoothstep(0.25, 1.1, -closing);
    if (a.p.continental && n.p.continental) {
      relief += c.range * push * bell(edge, 0, c.rangeWidth);
      land -= c.rift * pull * bell(edge, 0, c.rangeWidth * 0.7);
    } else if (a.p.continental) {
      relief += c.coastRange * push * bell(edge, c.coastInland, c.rangeWidth);
    } else if (!n.p.continental) {
      land += c.arc * push * bell(edge, 0, c.rangeWidth * 0.5) * (ridged > 0.75 ? 1 : 0.3);
    }
  }
  // Old ranges, worn down, wandering across the interiors.
  const old = 1 - Math.abs(fbm(seed + CH.oldRidge, wx / 520, wy / 520, 3));
  relief += c.oldRidges * smoothstep(0.86, 0.99, old) * clamp(land / 0.3, 0, 1);
  relief *= 0.3 + 1.0 * ridged * ridged * ridged; // peaks along the crests, passes between
  // Coasts that wander at every scale, and the base kept well inland.
  land += c.detail * fbm(seed + CH.coast, x / 430, y / 430, 6) + 0.12 * relief;
  const fromBase = Math.hypot(x - BASE.icon.x, y - BASE.icon.y);
  land += c.homeLift * smoothstep(c.homeRadius, c.homeRadius * 0.4, fromBase);
  return { land, relief, dry: 0.6 * smoothstep(0.05, 0.55, level / wsum + 0.15 * fbm(seed + CH.coast + 2, x / 600, y / 600, 3)) };
}

/** How far inland (above 0) or out to sea (below) the point (x, y) is. */
export function continentAt(seed: number, x: number, y: number): number {
  return geology(seed, x, y).land;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function baseTile(x: number, y: number): number | undefined {
  if (x === BASE.icon.x && y === BASE.icon.y) return T.BASE_ICON;
  // A stretch of old highway leading south from the base.
  if (x === BASE.icon.x && y > BASE.icon.y && y <= BASE.icon.y + 24) return T.ROAD;
  return undefined;
}

// ---- towns and the highways between them ----

export const ROADS = {
  cell: 260, // one town (at most) per cell of this many tiles
  jitter: 0.32, // how far from its cell's middle a town may sit (x cell)
  townChance: 0.8, // a cell with land in the middle has a town this often
  inland: 0.05, // ...if its spot is at least this far inland (continent units)
  radius: [9, 44], // a town's size, centre to edge (big ones are rarer)
  links: 2, // every town is linked to its nearest neighbours...
  extraLink: 0.3, // ...and now and then one more, so the network has loops
  bend: 0.22, // how far a highway bows away from the straight line (x its length)
  seaCrossing: 0.3, // chance a link to a neighbour with sea in the way was built anyway, as a causeway
  causeway: 0.45, // chance a town by the sea has a causeway out to the nearest town across it (up to 2 cells off)
  width: 0.8, // tiles within this distance of a highway's line are road (4-way walkable)
} as const;

/** A town (or the base) on the road network. */
export interface Town {
  gx: number;
  gy: number;
  x: number;
  y: number;
  /** Its ruins reach this far (0 for the base, which has none). */
  r: number;
}

interface Highway {
  /** The bending line it follows, as points. */
  pts: [number, number][];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Memos: towns, links and highways are worked out once per world seed and cell.
const townMemo = new Map<string, Town | null>();
const linkMemo = new Map<string, { to: Town; causeway: boolean }[]>();
const roadMemo = new Map<string, Highway | null>();
const nearMemo = new Map<string, Highway[]>();

/** The town in road cell (gx, gy), if there is one. Cell (0, 0)'s is the base. */
export function townIn(seed: number, gx: number, gy: number): Town | undefined {
  const key = `${seed}:${gx}:${gy}`;
  const memo = townMemo.get(key);
  if (memo !== undefined) return memo ?? undefined;
  let town: Town | null = null;
  const R = ROADS;
  if (gx === 0 && gy === 0) {
    town = { gx, gy, x: BASE.icon.x, y: BASE.icon.y, r: 0 };
  } else {
    const h = hash2(seed + CH.town, gx, gy);
    const j = (bits: number) => ((bits & 0xff) / 255 - 0.5) * 2 * R.jitter * R.cell;
    const x = Math.round(gx * R.cell + j(h >>> 8));
    const y = Math.round(gy * R.cell + j(h >>> 16));
    const size = (h >>> 24) / 255;
    const far = Math.hypot(x - BASE.icon.x, y - BASE.icon.y) > BASE.calmRadius + 30;
    if ((h & 0xff) / 256 < R.townChance && far && continentAt(seed, x, y) - CONTINENTS.sea > R.inland) {
      town = { gx, gy, x, y, r: Math.round(R.radius[0] + size * size * (R.radius[1] - R.radius[0])) };
    }
  }
  townMemo.set(key, town);
  return town ?? undefined;
}

/**
 * The towns a town's highways go to: its nearest few in the cells around it,
 * and now and then, for a town by the sea, a causeway out to the nearest town
 * across the water.
 */
function linksOf(seed: number, t: Town): { to: Town; causeway: boolean }[] {
  const key = `${seed}:${t.gx}:${t.gy}`;
  let links = linkMemo.get(key);
  if (links) return links;
  const near: Town[] = [];
  const far: Town[] = [];
  for (let oy = -2; oy <= 2; oy++) {
    for (let ox = -2; ox <= 2; ox++) {
      const o = (ox || oy) ? townIn(seed, t.gx + ox, t.gy + oy) : undefined;
      if (o) (Math.max(Math.abs(ox), Math.abs(oy)) === 1 ? near : far).push(o);
    }
  }
  const dist = (o: Town) => Math.hypot(o.x - t.x, o.y - t.y);
  near.sort((a, b) => dist(a) - dist(b));
  far.sort((a, b) => dist(a) - dist(b));
  const n = ROADS.links + (rand2(seed + CH.link, t.gx, t.gy) < ROADS.extraLink ? 1 : 0);
  links = near.slice(0, n).map((to) => ({ to, causeway: false }));
  if (rand2(seed + CH.link + 1, t.gx, t.gy) < ROADS.causeway) {
    const across = [...near, ...far].find((o) => continentAt(seed, (o.x + t.x) / 2, (o.y + t.y) / 2) < CONTINENTS.sea);
    if (across) links.push({ to: across, causeway: true });
  }
  linkMemo.set(key, links);
  return links;
}

/** The highway between two towns, or none if it would cross the sea and never got built (causeways always were). */
function highway(seed: number, a: Town, b: Town, causeway: boolean): Highway | undefined {
  if (a.gx > b.gx || (a.gx === b.gx && a.gy > b.gy)) [a, b] = [b, a];
  const key = `${seed}:${a.gx}:${a.gy}:${b.gx}:${b.gy}:${causeway}`;
  const memo = roadMemo.get(key);
  if (memo !== undefined) return memo ?? undefined;
  const h = hash2(seed + CH.link, a.gx * 7919 + b.gx, a.gy * 7919 + b.gy);
  // A gentle bow: a quadratic curve through a point pushed off the middle of the straight line.
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const off = ((h & 0xffff) / 65535 - 0.5) * 2 * ROADS.bend * len;
  const cx = (a.x + b.x) / 2 + ((a.y - b.y) / len) * off;
  const cy = (a.y + b.y) / 2 + ((b.x - a.x) / len) * off;
  const steps = Math.max(4, Math.ceil(len / 24));
  const pts: [number, number][] = [];
  let wet = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * cx + t * t * b.x;
    const y = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * cy + t * t * b.y;
    pts.push([x, y]);
    if (continentAt(seed, x, y) < CONTINENTS.sea) wet++;
  }
  let road: Highway | null = null;
  if (wet === 0 || causeway || (h >>> 16) / 65536 < ROADS.seaCrossing) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    road = { pts, minX: Math.min(...xs) - 2, minY: Math.min(...ys) - 2, maxX: Math.max(...xs) + 2, maxY: Math.max(...ys) + 2 };
  }
  roadMemo.set(key, road);
  return road ?? undefined;
}

/** Every highway that could pass through road cell (gx, gy). */
function highwaysNear(seed: number, gx: number, gy: number): Highway[] {
  const key = `${seed}:${gx}:${gy}`;
  let roads = nearMemo.get(key);
  if (roads) return roads;
  const found = new Set<Highway>();
  for (let oy = -3; oy <= 3; oy++) {
    for (let ox = -3; ox <= 3; ox++) {
      const t = townIn(seed, gx + ox, gy + oy);
      if (!t) continue;
      for (const { to, causeway } of linksOf(seed, t)) {
        const road = highway(seed, t, to, causeway);
        if (road) found.add(road);
      }
    }
  }
  roads = [...found];
  nearMemo.set(key, roads);
  return roads;
}

const cellOf = (v: number) => Math.round(v / ROADS.cell);

/** Is (x, y) on one of the old highways? */
export function isRoad(seed: number, x: number, y: number): boolean {
  for (const road of highwaysNear(seed, cellOf(x), cellOf(y))) {
    if (x < road.minX || x > road.maxX || y < road.minY || y > road.maxY) continue;
    const p = road.pts;
    for (let i = 1; i < p.length; i++) {
      if (distToSegment(x, y, p[i - 1]![0], p[i - 1]![1], p[i]![0], p[i]![1]) <= ROADS.width) return true;
    }
  }
  return false;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The town whose ruins cover (x, y), if any: within its radius, give or take a ragged edge. */
export function townAt(seed: number, x: number, y: number): Town | undefined {
  const gx = cellOf(x);
  const gy = cellOf(y);
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const t = townIn(seed, gx + ox, gy + oy);
      if (!t || !t.r) continue;
      const edge = t.r * (0.8 + 0.35 * fbm(seed + CH.townEdge, x / 14, y / 14, 2));
      if (Math.hypot(x - t.x, y - t.y) < edge) return t;
    }
  }
  return undefined;
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

  // Seas between the continents, crossed only where an old highway runs on as a causeway.
  const geo = geology(seed, x, y);
  const land = geo.land - CONTINENTS.sea;
  if (land < 0) {
    if (isRoad(seed, x, y)) return T.BRIDGE;
    return land < -CONTINENTS.deepBelow ? T.DEEP_WATER : T.WATER;
  }

  const dist = Math.hypot(x, y);
  // 0 at the base, 1 out in the deep wasteland.
  const hazard = clamp((dist - BASE.clearRadius) / (BASE.calmRadius - BASE.clearRadius), 0, 1);

  let elev = fbm(seed + CH.elev, x / 90, y / 90, 5);
  // Wet by the sea, dry deep inland.
  const moist = fbm(seed + CH.moist, x / 70, y / 70, 4) + 0.22 - geo.dry;
  const rad = fbm(seed + CH.rad, x / 45, y / 45, 3);
  const speck = rand2(seed + CH.speck, x, y);

  // How high it stands: the mountain ranges, rolling uplands, and local bumps.
  const upland = Math.max(0, fbm(seed + CH.upland, x / 230, y / 230, 3));
  let height = geo.relief + 0.35 * upland + 0.22 * elev;
  // Flatten the land around the base so the gates never open onto a lake or cliff.
  elev *= 0.25 + 0.75 * hazard;
  height *= 0.25 + 0.75 * hazard;

  // Highways go where they're going: over lakes on causeways, and through the mountains.
  const road = isRoad(seed, x, y);
  if (elev < -0.36 && geo.relief < 0.3) return road ? T.BRIDGE : T.WATER; // lakes, down in the lowlands
  if (road) return T.ROAD;
  if (height > 0.78) return T.MOUNTAINS;

  // The shore: ash beaches, and marsh where it's wet.
  if (land < CONTINENTS.beach) return moist > 0.15 ? T.SWAMP : speck < 0.85 ? T.DUNES : T.RUBBLE;

  if (elev < -0.29 && geo.relief < 0.3) return moist > -0.1 ? T.SWAMP : T.WASTELAND;
  if (height > 0.46) return T.HILLS;

  if (townAt(seed, x, y)) return cityTile(seed, x, y);

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
