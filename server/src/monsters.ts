// Radioactive zombies: spawned out in the wasteland around players, they
// shamble one tile at a time towards the nearest player. Stepping onto a
// player's tile is a "contact", which the game server turns into an
// encounter. They never enter the base. Zombies are transient: they despawn
// when nobody is around and are not persisted across server restarts.
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

export interface PlayerPos extends Pos {
  id: number;
  /** False while the player is in an encounter or just left one: no chasing, no spawns. */
  targetable: boolean;
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

export interface Contact {
  playerId: number;
  monsterId: number;
}

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

  /** Remove and return every monster within `radius` tiles of `center` (for an encounter). */
  take(center: Pos, radius: number): Monster[] {
    const taken = [...this.all.values()].filter((m) => cheb(m, center) <= radius);
    for (const m of taken) this.all.delete(m.id);
    return taken;
  }

  /** Put a monster back on the map if its tile is still free. Returns false if it was dropped. */
  restore(m: Monster, now: number, players: Pos[]): boolean {
    if (!this.canEnter(m.x, m.y, players)) return false;
    m.nextStepAt = now + this.opts.stepMs * 2; // A moment to regroup before chasing again.
    m.lastNearPlayerAt = now;
    this.all.set(m.id, m);
    return true;
  }

  /** Advance the zombies. Returns ids that spawned or moved, ids removed, and zombies that reached a player. */
  tick(now: number, players: PlayerPos[]): { changed: Set<number>; removed: number[]; contacts: Contact[] } {
    const changed = new Set<number>();
    const removed: number[] = [];
    const contacts: Contact[] = [];
    const o = this.opts;
    const targets = players.filter((p) => p.targetable);

    for (const m of this.all.values()) {
      if (players.some((p) => cheb(p, m) <= o.despawnTiles)) {
        m.lastNearPlayerAt = now;
      } else if (now - m.lastNearPlayerAt > o.despawnAfterMs) {
        this.all.delete(m.id);
        removed.push(m.id);
      }
    }

    for (const p of targets) {
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

    const contacted = new Set<number>();
    for (const m of this.all.values()) {
      if (now < m.nextStepAt) continue;
      m.nextStepAt = now + o.stepMs;
      let target: PlayerPos | undefined;
      for (const p of targets) {
        if (contacted.has(p.id)) continue;
        if (cheb(p, m) <= o.aggroTiles && (!target || cheb(p, m) < cheb(target, m))) target = p;
      }
      const step = target ? this.stepToward(m, target, players) : this.rng() < 0.3 ? this.wander(m, players) : undefined;
      if (!step) continue;
      m.x = step.x;
      m.y = step.y;
      changed.add(m.id);
      if (target && m.x === target.x && m.y === target.y) {
        contacts.push({ playerId: target.id, monsterId: m.id });
        contacted.add(target.id);
      }
    }
    return { changed, removed, contacts };
  }

  /** Free for a zombie to stand on; `prey` (the player being chased) is allowed. */
  private canEnter(x: number, y: number, players: Pos[], prey?: Pos): boolean {
    return (
      !inSafeZone(x, y) &&
      isPassable(this.world.tileAt(x, y)) &&
      !this.at(x, y) &&
      !players.some((p) => p !== prey && p.x === x && p.y === y)
    );
  }

  /** Greedy shamble: close the larger gap first, sometimes the other one to slide round obstacles. */
  private stepToward(m: Monster, t: PlayerPos, players: Pos[]): Pos | undefined {
    const dx = t.x - m.x;
    const dy = t.y - m.y;
    if (dx === 0 && dy === 0) return undefined;
    const horizontal = { x: m.x + Math.sign(dx), y: m.y };
    const vertical = { x: m.x, y: m.y + Math.sign(dy) };
    let options: Pos[] = [];
    if (dx !== 0) options.push(horizontal);
    if (dy !== 0) options.push(vertical);
    const preferVertical = Math.abs(dy) > Math.abs(dx) || (Math.abs(dy) === Math.abs(dx) && this.rng() < 0.5);
    if (options.length === 2 && preferVertical !== this.rng() < 0.2) options = [vertical, horizontal];
    return options.find((s) => this.canEnter(s.x, s.y, players, t));
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
