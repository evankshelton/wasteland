// The persistent world: chunks are loaded from storage, or generated and
// stored the first time anyone comes near them.
import { randomInt } from "node:crypto";
import type { Storage } from "./storage.ts";
import { CHUNK_SIZE, WORLD_VERSION, generateChunk } from "./worldgen.ts";

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
      storage.setMeta("world_version", String(WORLD_VERSION));
    }
    this.migrate();
  }

  /** Bring land saved by older versions of the generator up to date. */
  private migrate(): void {
    const version = Number(this.storage.getMeta("world_version") ?? 1);
    if (version < 2) {
      // The walled compound (-8..8) and its highway (to y = 32) became a base
      // icon and a shorter road. Regenerate the chunks they touched; the
      // generator is unchanged elsewhere, so the surrounding land stays the same.
      let n = 0;
      for (let cy = -1; cy <= 1; cy++) {
        for (let cx = -1; cx <= 0; cx++) {
          if (this.storage.getChunk(cx, cy)) {
            this.storage.putChunk(cx, cy, generateChunk(this.seed, cx, cy));
            n++;
          }
        }
      }
      console.log(`[world] migrated to v2: replaced the old compound with the base icon (${n} chunks)`);
    }
    if (version < WORLD_VERSION) this.storage.setMeta("world_version", String(WORLD_VERSION));
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
