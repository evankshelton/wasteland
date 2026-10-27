// Terrain definitions, loaded from shared/tiles.json so the server, the tile
// art generator and the client all agree on ids.
import { readFileSync } from "node:fs";

export interface TileDef {
  id: number;
  key: string;
  name: string;
  passable: boolean;
  /** Colour of this terrain on the world map. */
  color: string;
}

const tilesPath = new URL("../../shared/tiles.json", import.meta.url);
const raw = JSON.parse(readFileSync(tilesPath, "utf8")) as { tileSize: number; tiles: TileDef[] };

export const TILE_SIZE: number = raw.tileSize;
export const TILE_DEFS: readonly TileDef[] = raw.tiles;

const byKey = new Map(TILE_DEFS.map((t) => [t.key, t.id]));
/** Tile id for a key from shared/tiles.json; throws if there is no such tile. */
export function tileId(key: string): number {
  return id(key);
}
function id(key: string): number {
  const v = byKey.get(key);
  if (v === undefined) throw new Error(`shared/tiles.json is missing tile "${key}"`);
  return v;
}

export const T = {
  VOID: id("void"),
  WASTELAND: id("wasteland"),
  SCRUB: id("scrub"),
  DEAD_FOREST: id("dead_forest"),
  RUBBLE: id("rubble"),
  RUINS: id("ruins"),
  ROAD: id("road"),
  HILLS: id("hills"),
  MOUNTAINS: id("mountains"),
  CRATER: id("crater"),
  RADIATION: id("radiation"),
  WATER: id("water"),
  SWAMP: id("swamp"),
  DUNES: id("dunes"),
  BASE_WALL: id("base_wall"),
  BASE_FLOOR: id("base_floor"),
  BASE_GATE: id("base_gate"),
  BASE_ICON: id("base_icon"),
  CAMP_ICON: id("camp_icon"),
} as const;

const passable = new Uint8Array(256);
for (const t of TILE_DEFS) passable[t.id] = t.passable ? 1 : 0;

export function isPassable(tile: number): boolean {
  return passable[tile] === 1;
}
