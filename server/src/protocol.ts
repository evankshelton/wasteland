// Wire protocol: one JSON object per WebSocket text message, discriminated by `t`.
// Keep in sync with client/scripts/net.gd and docs/PROTOCOL.md.

export const PROTOCOL_VERSION = 2;

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
  | { t: "map_chunks"; coords: [number, number][] };

// ---- server -> client ----
export type ServerMsg =
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
    }
  | { t: "chunk"; cx: number; cy: number; tiles: string } // base64, row-major bytes
  | { t: "you"; x: number; y: number; seq: number; ok: boolean }
  | { t: "player"; id: number; name: string; x: number; y: number }
  | { t: "player_left"; id: number }
  | { t: "map_index"; chunks: [number, number][] } // every chunk generated so far
  | { t: "map_chunk"; cx: number; cy: number; tiles: string } // like chunk, but for the world map only
  | { t: "map_batch_done" }
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
    case "map_chunks": {
      if (!Array.isArray(o.coords) || o.coords.length > MAP_BATCH_MAX) return undefined;
      const coords: [number, number][] = [];
      for (const c of o.coords) {
        if (!Array.isArray(c) || c.length !== 2 || !Number.isSafeInteger(c[0]) || !Number.isSafeInteger(c[1])) return undefined;
        coords.push([c[0], c[1]]);
      }
      return { t: "map_chunks", coords };
    }
    default:
      return undefined;
  }
}

export function validName(name: string): boolean {
  return NAME_RE.test(name);
}
