// Wire protocol: one JSON object per WebSocket text message, discriminated by `t`.
// Keep in sync with client/scripts/net.gd and docs/PROTOCOL.md.

import { ABILITIES, type Ability, type Character } from "./character.ts";

export const PROTOCOL_VERSION = 6;

/** Most chunk coordinates a client may ask for in one map_chunks request. */
export const MAP_BATCH_MAX = 256;

export type Dir = "up" | "down" | "left" | "right";

export const DIR_DELTA: Record<Dir, readonly [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

// ---- client -> server ----
export type ClientMsg =
  | { t: "hello"; v: number; name: string; token?: string }
  | { t: "move"; dir: Dir; seq: number }
  | { t: "map" }
  | { t: "map_chunks"; coords: [number, number][] }
  | { t: "encounter_end"; id: number; result: EncounterResult; killed: number[]; dir?: Dir; hp?: number }
  | { t: "enter" } // go into the base while standing on its icon
  | { t: "reroll" } // roll new abilities (only before accepting a character)
  | { t: "accept" } // keep the current roll and start playing
  | { t: "raise"; ability: Ability } // spend a level-up point
  | { t: "service"; npc: number }; // ask an NPC in the base for their service (talking to them does this)

export type EncounterResult = "victory" | "fled" | "died";
const RESULTS: readonly string[] = ["victory", "fled", "died"];

// ---- server -> client ----
export type ServerMsg =
  | { t: "character"; character: Character }
  | {
      t: "welcome";
      id: number;
      name: string;
      token: string;
      x: number;
      y: number;
      chunkSize: number;
      tiles: { id: number; key: string; name: string; passable: boolean; color: string }[];
      motd: string;
      /** If not yet created, the client shows the rolling screen; nothing else is sent until "accept". */
      character: Character;
    }
  | { t: "chunk"; cx: number; cy: number; tiles: string } // base64, row-major bytes
  | { t: "you"; x: number; y: number; seq: number; ok: boolean }
  | { t: "player"; id: number; name: string; x: number; y: number }
  | { t: "player_left"; id: number }
  | { t: "map_index"; chunks: [number, number][] } // every chunk generated so far
  | { t: "map_chunk"; cx: number; cy: number; tiles: string } // like chunk, but for the world map only
  | { t: "map_batch_done" }
  | { t: "monster"; id: number; kind: string; x: number; y: number } // appeared in view or moved
  | { t: "monster_left"; id: number }
  // A zombie reached the player: fight every enemy within `radius` tiles in first person.
  // Enemy dx/dy are tile offsets from the player at (x, y).
  | {
      t: "encounter_start";
      id: number;
      x: number;
      y: number;
      radius: number;
      seed: number;
      enemies: { id: number; kind: string; dx: number; dy: number }[];
    }
  | { t: "encounter_over"; id: number; result: EncounterResult; x: number; y: number }
  // Which map the player is on. Sent after welcome and whenever it changes;
  // x/y (and later "you" and "player" messages) are in that map's coordinates.
  | { t: "location"; kind: "overworld"; x: number; y: number }
  | {
      t: "location";
      kind: "base";
      name: string;
      width: number;
      height: number;
      tiles: string; // base64, row-major tile ids
      x: number;
      y: number;
      npcs: { id: number; name: string; role: string; service: string; x: number; y: number; lines: string[] }[];
      rooms: { name: string; x: number; y: number; w: number; h: number }[];
    }
  | { t: "notice"; text: string }
  | { t: "error"; code: string; message: string };

const NAME_RE = /^[A-Za-z0-9 _-]{2,16}$/;

/** Validates untrusted input; returns undefined for anything malformed. */
export function parseClientMsg(raw: string): ClientMsg | undefined {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof m !== "object" || m === null) return undefined;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case "hello":
      if (typeof o.v !== "number" || typeof o.name !== "string") return undefined;
      if (o.token !== undefined && typeof o.token !== "string") return undefined;
      return { t: "hello", v: o.v, name: o.name.trim(), token: o.token as string | undefined };
    case "move":
      if (typeof o.dir !== "string" || !(o.dir in DIR_DELTA)) return undefined;
      return { t: "move", dir: o.dir as Dir, seq: typeof o.seq === "number" ? o.seq : 0 };
    case "map":
      return { t: "map" };
    case "enter":
      return { t: "enter" };
    case "map_chunks": {
      if (!Array.isArray(o.coords) || o.coords.length > MAP_BATCH_MAX) return undefined;
      const coords: [number, number][] = [];
      for (const c of o.coords) {
        if (!Array.isArray(c) || c.length !== 2 || !Number.isSafeInteger(c[0]) || !Number.isSafeInteger(c[1])) return undefined;
        coords.push([c[0], c[1]]);
      }
      return { t: "map_chunks", coords };
    }
    case "encounter_end": {
      if (typeof o.id !== "number" || typeof o.result !== "string" || !RESULTS.includes(o.result)) return undefined;
      if (!Array.isArray(o.killed) || o.killed.length > 256 || !o.killed.every(Number.isSafeInteger)) return undefined;
      if (o.dir !== undefined && (typeof o.dir !== "string" || !(o.dir in DIR_DELTA))) return undefined;
      if (o.hp !== undefined && (typeof o.hp !== "number" || !Number.isFinite(o.hp))) return undefined;
      return {
        t: "encounter_end", id: o.id, result: o.result as EncounterResult, killed: o.killed as number[],
        dir: o.dir as Dir | undefined, hp: o.hp as number | undefined,
      };
    }
    case "reroll":
    case "accept":
      return { t: o.t };
    case "raise":
      if (typeof o.ability !== "string" || !ABILITIES.includes(o.ability as Ability)) return undefined;
      return { t: "raise", ability: o.ability as Ability };
    case "service":
      if (typeof o.npc !== "number") return undefined;
      return { t: "service", npc: o.npc };
    default:
      return undefined;
  }
}

export function validName(name: string): boolean {
  return NAME_RE.test(name);
}
