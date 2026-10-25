// Radioactive zombies: spawned out in the wasteland around players, they
// shamble one tile at a time towards the nearest player. They never enter the
// base. Zombies are transient: they despawn when nobody is around and are not
// persisted across server restarts.
import { T, isPassable } from "./tiles.ts";
import type { World } from "./world.ts";
import { BASE } from "./worldgen.ts";

export type MonsterKind = "zombie";

export interface Monster {
  id: number;
  kind: MonsterKind;
  x: number;
  y: number;
  nextStepAt: number;
  lastNearPlayerAt: number;
}

export interface Pos {
  x: number;
  y: number;
}

export interface MonsterOptions {
  /** Milliseconds between a zombie's steps (players step about every 130ms). */
  stepMs: number;
  /** Zombies chase the nearest player within this many tiles. */
  aggroTiles: number;
  /** Chance per tick, per player out in the wasteland, of a spawn attempt. */
  spawnChance: number;
  /** No new spawns near a player who already has this many zombies within spawnMaxTiles. */
  maxNearPlayer: number;
  /** Zombies appear between these distances from a player: just off screen. */
  spawnMinTiles: number;
  spawnMaxTiles: number;
  /** A zombie with no player within despawnTiles for despawnAfterMs is removed. */
  despawnTiles: number;
  despawnAfterMs: number;
}

export const DEFAULT_MONSTER_OPTIONS: MonsterOptions = {
  stepMs: 900,
  aggroTiles: 20,
  spawnChance: 0.03,
  maxNearPlayer: 4,
  spawnMinTiles: 12,
  spawnMaxTiles: 18,
  despawnTiles: 48,
  despawnAfterMs: 20_000,
};

const cheb = (a: Pos, b: Pos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** The base and the ring just outside its walls are off limits to zombies. */
export function inSafeZone(x: number, y: number): boolean {
  return Math.max(Math.abs(x), Math.abs(y)) <= BASE.half + 2;
}

export class Monsters {
  readonly all = new Map<number, Monster>();
  private nextId = 1;
  private world: World;
  private opts: MonsterOptions;
  private rng: () => number;

  constructor(world: World, opts: MonsterOptions, rng: () => number = Math.random) {
    this.world = world;
    this.opts = opts;
    this.rng = rng;
  }

  at(x: number, y: number): Monster | undefined {
    for (const m of this.all.values()) if (m.x === x && m.y === y) return m;
    return undefined;
  }

  /** Advance the zombies. Returns ids that spawned or moved, and ids removed. */
  tick(now: number, players: Pos[]): { changed: Set<number>; removed: number[] } {
    const changed = new Set<number>();
    const removed: number[] = [];
    const o = this.opts;

    for (const m of this.all.values()) {
      if (players.some((p) => cheb(p, m) <= o.despawnTiles)) {
        m.lastNearPlayerAt = now;
      } else if (now - m.lastNearPlayerAt > o.despawnAfterMs) {
        this.all.delete(m.id);
        removed.push(m.id);
      }
    }

    for (const p of players) {
      if (Math.hypot(p.x, p.y) < BASE.clearRadius || this.rng() >= o.spawnChance) continue;
      let near = 0;
      for (const m of this.all.values()) if (cheb(m, p) <= o.spawnMaxTiles) near++;
      if (near >= o.maxNearPlayer) continue;
      const spot = this.findSpawn(p, players);
      if (!spot) continue;
      const m: Monster = { id: this.nextId++, kind: "zombie", ...spot, nextStepAt: now + o.stepMs, lastNearPlayerAt: now };
      this.all.set(m.id, m);
      changed.add(m.id);
    }

    for (const m of this.all.values()) {
      if (now < m.nextStepAt) continue;
      m.nextStepAt = now + o.stepMs;
      let target: Pos | undefined;
      for (const p of players) {
        if (cheb(p, m) <= o.aggroTiles && (!target || cheb(p, m) < cheb(target, m))) target = p;
      }
      const step = target ? this.stepToward(m, target, players) : this.rng() < 0.3 ? this.wander(m, players) : undefined;
      if (step) {
        m.x = step.x;
        m.y = step.y;
        changed.add(m.id);
      }
    }
    return { changed, removed };
  }

  private canEnter(x: number, y: number, players: Pos[]): boolean {
    return (
      !inSafeZone(x, y) &&
      isPassable(this.world.tileAt(x, y)) &&
      !this.at(x, y) &&
      !players.some((p) => p.x === x && p.y === y)
    );
  }

  /** Greedy shamble: close the larger gap first, sometimes the other one to slide round obstacles. */
  private stepToward(m: Monster, t: Pos, players: Pos[]): Pos | undefined {
    const dx = t.x - m.x;
    const dy = t.y - m.y;
    if (Math.abs(dx) + Math.abs(dy) <= 1) return undefined; // Adjacent: loom.
    const horizontal = { x: m.x + Math.sign(dx), y: m.y };
    const vertical = { x: m.x, y: m.y + Math.sign(dy) };
    let options: Pos[] = [];
    if (dx !== 0) options.push(horizontal);
    if (dy !== 0) options.push(vertical);
    const preferVertical = Math.abs(dy) > Math.abs(dx) || (Math.abs(dy) === Math.abs(dx) && this.rng() < 0.5);
    if (options.length === 2 && preferVertical !== this.rng() < 0.2) options = [vertical, horizontal];
    return options.find((s) => this.canEnter(s.x, s.y, players));
  }

  private wander(m: Monster, players: Pos[]): Pos | undefined {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    const [dx, dy] = dirs[Math.floor(this.rng() * 4)]!;
    return this.canEnter(m.x + dx, m.y + dy, players) ? { x: m.x + dx, y: m.y + dy } : undefined;
  }

  /** A walkable spot just off a player's screen; hot zones are favoured. */
  private findSpawn(p: Pos, players: Pos[]): Pos | undefined {
    const { spawnMinTiles: min, spawnMaxTiles: max } = this.opts;
    let fallback: Pos | undefined;
    for (let i = 0; i < 10; i++) {
      const x = p.x + Math.floor(this.rng() * (2 * max + 1)) - max;
      const y = p.y + Math.floor(this.rng() * (2 * max + 1)) - max;
      const d = cheb({ x, y }, p);
      if (d < min || d > max || Math.hypot(x, y) < BASE.clearRadius) continue;
      if (players.some((q) => cheb(q, { x, y }) < min) || !this.canEnter(x, y, players)) continue;
      if (this.world.tileAt(x, y) === T.RADIATION) return { x, y };
      fallback ??= { x, y };
    }
    return fallback;
  }
}
