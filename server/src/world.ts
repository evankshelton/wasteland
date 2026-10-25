// The persistent world: chunks are loaded from storage, or generated and
// stored the first time anyone comes near them.
import { randomInt } from "node:crypto";
import type { Storage } from "./storage.ts";
import { CHUNK_SIZE, generateChunk } from "./worldgen.ts";

export const chunkOf = (v: number) => Math.floor(v / CHUNK_SIZE);
const keyOf = (cx: number, cy: number) => `${cx},${cy}`;

export class World {
  readonly seed: number;
  private cache = new Map<string, Uint8Array>();
  private storage: Storage;

  constructor(storage: Storage, seedOverride?: number) {
    this.storage = storage;
    const stored = storage.getMeta("seed");
    if (stored !== undefined) {
      this.seed = Number(stored);
      if (seedOverride !== undefined && seedOverride !== this.seed) {
        console.warn(`[world] ignoring --seed ${seedOverride}: this world was created with seed ${this.seed}`);
      }
    } else {
      this.seed = seedOverride ?? randomInt(1, 2 ** 31 - 1);
      storage.setMeta("seed", String(this.seed));
      storage.setMeta("created_at", new Date().toISOString());
    }
  }

  /** Returns the chunk, generating and persisting it if this is the first visit. */
  chunk(cx: number, cy: number): Uint8Array {
    const key = keyOf(cx, cy);
    let tiles = this.cache.get(key);
    if (tiles) return tiles;
    tiles = this.storage.getChunk(cx, cy);
    if (!tiles) {
      tiles = generateChunk(this.seed, cx, cy);
      this.storage.putChunk(cx, cy, tiles);
    }
    this.cache.set(key, tiles);
    return tiles;
  }

  /** Like chunk(), but never generates: undefined if nobody has been near it yet. */
  existingChunk(cx: number, cy: number): Uint8Array | undefined {
    const key = keyOf(cx, cy);
    let tiles = this.cache.get(key);
    if (tiles) return tiles;
    tiles = this.storage.getChunk(cx, cy);
    if (tiles) this.cache.set(key, tiles);
    return tiles;
  }

  tileAt(x: number, y: number): number {
    const cx = chunkOf(x);
    const cy = chunkOf(y);
    const tiles = this.chunk(cx, cy);
    return tiles[(y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE)]!;
  }
}
