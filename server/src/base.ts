// The base interior: a small town map entered from the base icon on the
// overworld, defined in shared/base.json. Walking off any edge leaves it.
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

interface BaseFile {
  name: string;
  legend: Record<string, string>;
  map: string[];
  entry: [number, number];
  respawn: [number, number];
  rooms: { name: string; rect: [number, number, number, number] }[];
  npcs: { id: number; name: string; role: string; service: string; pos: [number, number]; lines: string[] }[];
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

  constructor(def: BaseFile) {
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
    for (const p of [this.entry, this.respawn]) {
      if (!this.walkable(p.x, p.y)) throw new Error(`base entry/respawn (${p.x}, ${p.y}) is not walkable`);
    }
  }

  static load(): BaseMap {
    const path = new URL("../../shared/base.json", import.meta.url);
    return new BaseMap(JSON.parse(readFileSync(path, "utf8")) as BaseFile);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
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
