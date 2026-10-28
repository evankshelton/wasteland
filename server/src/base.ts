// Sites: small maps entered from an icon on the overworld, like Ultima IV
// cities. The base is defined in shared/base.json; encampments (camps.ts) and
// dungeons (dungeons.ts) are generated in the same format. Walking off any
// edge leaves a site, and so does stepping onto one of its exits (a dungeon's
// ladder up).
import { readFileSync } from "node:fs";
import { isPassable, tileId } from "./tiles.ts";

export interface Npc {
  id: number;
  name: string;
  role: string;
  /** What the NPC will eventually sell or do: weapons, armor, healing, radiation... */
  service: string;
  x: number;
  y: number;
  lines: string[];
}

export interface Room {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BaseFile {
  name: string;
  legend: Record<string, string>;
  map: string[];
  entry: [number, number];
  respawn: [number, number];
  rooms: { name: string; rect: [number, number, number, number] }[];
  npcs: { id: number; name: string; role: string; service: string; pos: [number, number]; lines: string[] }[];
  /** Tiles that lead straight back to the overworld. */
  exits?: [number, number][];
  /** Tiles that lead down to the next level, and up to the one above (a dungeon's stairs). */
  down?: [number, number][];
  up?: [number, number][];
}

export class BaseMap {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly tiles: Uint8Array;
  readonly entry: { x: number; y: number };
  readonly respawn: { x: number; y: number };
  readonly npcs: Npc[];
  readonly rooms: Room[];
  /** Where the site's icon is on the overworld; leaving comes out next to it. */
  readonly icon: { x: number; y: number };
  /** Tiles that lead straight back to the overworld. */
  readonly exits: { x: number; y: number }[];
  /** Tiles that lead down to the next level, and up to the one above. */
  readonly down: { x: number; y: number }[];
  readonly up: { x: number; y: number }[];

  constructor(def: BaseFile, icon = { x: 0, y: 0 }) {
    this.icon = icon;
    this.name = def.name;
    this.height = def.map.length;
    this.width = def.map[0]?.length ?? 0;
    this.tiles = new Uint8Array(this.width * this.height);
    const ids = new Map(Object.entries(def.legend).map(([ch, key]) => [ch, tileId(key)]));
    def.map.forEach((row, y) => {
      if (row.length !== this.width) throw new Error(`base map row ${y} is ${row.length} wide, expected ${this.width}`);
      [...row].forEach((ch, x) => {
        const id = ids.get(ch);
        if (id === undefined) throw new Error(`base map (${x}, ${y}): "${ch}" is not in the legend`);
        this.tiles[y * this.width + x] = id;
      });
    });
    this.entry = { x: def.entry[0], y: def.entry[1] };
    this.respawn = { x: def.respawn[0], y: def.respawn[1] };
    this.npcs = def.npcs.map(({ pos, ...n }) => ({ ...n, x: pos[0], y: pos[1] }));
    this.rooms = def.rooms.map(({ name, rect }) => ({ name, x: rect[0], y: rect[1], w: rect[2], h: rect[3] }));
    this.exits = (def.exits ?? []).map(([x, y]) => ({ x, y }));
    this.down = (def.down ?? []).map(([x, y]) => ({ x, y }));
    this.up = (def.up ?? []).map(([x, y]) => ({ x, y }));
    for (const p of [this.entry, this.respawn]) {
      if (!this.walkable(p.x, p.y)) throw new Error(`base entry/respawn (${p.x}, ${p.y}) is not walkable`);
    }
  }

  /** The base, from shared/base.json. */
  static load(): BaseMap {
    const path = new URL("../../shared/base.json", import.meta.url);
    return new BaseMap(JSON.parse(readFileSync(path, "utf8")) as BaseFile);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  isExit(x: number, y: number): boolean {
    return this.exits.some((e) => e.x === x && e.y === y);
  }

  isDown(x: number, y: number): boolean {
    return this.down.some((e) => e.x === x && e.y === y);
  }

  isUp(x: number, y: number): boolean {
    return this.up.some((e) => e.x === x && e.y === y);
  }

  /** A walkable tile next to `p` that isn't itself a way off this map: where you stand on arriving by it. */
  beside(p: { x: number; y: number }): { x: number; y: number } {
    for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]] as const) {
      const x = p.x + dx;
      const y = p.y + dy;
      if (this.walkable(x, y) && !this.isExit(x, y) && !this.isDown(x, y) && !this.isUp(x, y)) return { x, y };
    }
    return this.entry;
  }

  /** Inside the map, on a passable tile, and not where an NPC stands. */
  walkable(x: number, y: number): boolean {
    return (
      this.inBounds(x, y) &&
      isPassable(this.tiles[y * this.width + x]!) &&
      !this.npcs.some((n) => n.x === x && n.y === y)
    );
  }
}
