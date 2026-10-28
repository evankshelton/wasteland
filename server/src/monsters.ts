// Radioactive zombies: spawned around players out in the wasteland or down in
// a dungeon, they shamble one tile at a time towards the nearest player.
// Stepping onto a player's tile is a "contact", which the game server turns
// into an encounter. They never enter the base. Zombies are transient: they
// despawn when nobody is around and are not persisted across server restarts.
//
// A Monsters is one map's zombies; what they can walk on, where they may
// appear, and how they find their way comes from its Ground (the overworld's,
// or a dungeon's, where they path through the passages rather than shamble).
import type { BaseMap } from "./base.ts";
import { T, isPassable } from "./tiles.ts";
import type { World } from "./world.ts";
import { BASE } from "./worldgen.ts";

/** A map zombies can roam. */
export interface Ground {
  /** A zombie may stand here (other zombies and players aside). */
  open(x: number, y: number): boolean;
  /** No zombies appear here, or around a player standing here. */
  quiet(x: number, y: number): boolean;
  /** Zombies would rather appear here. */
  favoured(x: number, y: number): boolean;
  /** Find a real path to the player through the walls, rather than shambling straight at them. */
  pathfind: boolean;
}

/** The wasteland: anything passable, but not by the base or onto a camp or dungeon entrance. */
export function overworldGround(world: World): Ground {
  return {
    open(x, y) {
      const tile = world.tileAt(x, y);
      return !inSafeZone(x, y) && isPassable(tile) && tile !== T.CAMP_ICON && tile !== T.DUNGEON_ICON;
    },
    quiet: (x, y) => Math.hypot(x, y) < BASE.clearRadius,
    favoured: (x, y) => world.tileAt(x, y) === T.RADIATION,
    pathfind: false,
  };
}

/**
 * A dungeon level's passages and rooms, except right where you arrive and by
 * the stairs and ways out (somewhere to catch your breath).
 */
export function dungeonGround(site: BaseMap): Ground {
  const havens = [site.entry, ...site.exits, ...site.down, ...site.up];
  const nearHaven = (x: number, y: number, r: number) => havens.some((e) => cheb(e, { x, y }) <= r);
  return {
    open: (x, y) => site.walkable(x, y) && !site.isExit(x, y) && !site.isDown(x, y) && !site.isUp(x, y) && !nearHaven(x, y, 2),
    quiet: (x, y) => nearHaven(x, y, 5),
    favoured: () => false,
    pathfind: true,
  };
}

export type MonsterKind = "zombie";

export interface Monster {
  id: number;
  kind: MonsterKind;
  /** How many zombies this one stands for in a first-person fight (a pack of 1-15). */
  count: number;
  x: number;
  y: number;
  nextStepAt: number;
  lastNearPlayerAt: number;
}

/**
 * Relative chance of each pack size, 1 to 15: rising to a peak around 7-9 and
 * staying high, so most packs are big (about 8 on average) and small ones are rare.
 */
export const PACK_SIZE_WEIGHTS = [3, 4, 5, 6, 7, 8, 8, 8, 8, 7, 7, 6, 6, 5, 5] as const;

export function rollPackSize(rng: () => number = Math.random): number {
  const total = PACK_SIZE_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < PACK_SIZE_WEIGHTS.length; i++) {
    r -= PACK_SIZE_WEIGHTS[i]!;
    if (r < 0) return i + 1;
  }
  return PACK_SIZE_WEIGHTS.length;
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
  /** Packs are never bigger than this. */
  maxPack: number;
}

/** Dungeon zombies: they appear closer (it's dark and the passages are short) and in smaller packs. */
export const DUNGEON_MONSTER_OPTIONS: Partial<MonsterOptions> = {
  spawnChance: 0.05, maxNearPlayer: 3, spawnMinTiles: 7, spawnMaxTiles: 13, aggroTiles: 14, maxPack: 6,
};

export const DEFAULT_MONSTER_OPTIONS: MonsterOptions = {
  stepMs: 900,
  aggroTiles: 20,
  spawnChance: 0.03,
  maxNearPlayer: 4,
  spawnMinTiles: 12,
  spawnMaxTiles: 18,
  despawnTiles: 48,
  despawnAfterMs: 20_000,
  maxPack: 15,
};

export interface Contact {
  playerId: number;
  monsterId: number;
}

const cheb = (a: Pos, b: Pos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** The tiles around the base icon are off limits to zombies. */
export function inSafeZone(x: number, y: number): boolean {
  return Math.max(Math.abs(x - BASE.icon.x), Math.abs(y - BASE.icon.y)) <= BASE.safeRadius;
}

export class Monsters {
  readonly all = new Map<number, Monster>();
  /** Ids are unique across every map, so clients never confuse two zombies. */
  private static nextId = 1;
  private ground: Ground;
  private opts: MonsterOptions;
  private rng: () => number;

  /** `ground` is a map's Ground, or the overworld's World. */
  constructor(ground: Ground | World, opts: MonsterOptions, rng: () => number = Math.random) {
    this.ground = "tileAt" in ground ? overworldGround(ground) : ground;
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
      if (this.ground.quiet(p.x, p.y) || this.rng() >= o.spawnChance) continue;
      let near = 0;
      for (const m of this.all.values()) if (cheb(m, p) <= o.spawnMaxTiles) near++;
      if (near >= o.maxNearPlayer) continue;
      const spot = this.findSpawn(p, players);
      if (!spot) continue;
      const m: Monster = {
        id: Monsters.nextId++, kind: "zombie", count: Math.min(o.maxPack, rollPackSize(this.rng)), ...spot,
        nextStepAt: now + o.stepMs, lastNearPlayerAt: now,
      };
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
      const step = target
        ? this.ground.pathfind ? this.pathToward(m, target, players) : this.stepToward(m, target, players)
        : this.rng() < 0.3 ? this.wander(m, players) : undefined;
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
      this.ground.open(x, y) &&
      !this.at(x, y) &&
      !players.some((p) => p !== prey && p.x === x && p.y === y)
    );
  }

  /** The first step of a shortest path to the player (within aggro range), round walls and through doors. */
  private pathToward(m: Monster, t: PlayerPos, players: Pos[]): Pos | undefined {
    const limit = this.opts.aggroTiles * 2;
    const key = (x: number, y: number) => `${x},${y}`;
    const first = new Map<string, Pos | null>([[key(m.x, m.y), null]]);
    const queue: Pos[] = [{ x: m.x, y: m.y }];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    while (queue.length) {
      const c = queue.shift()!;
      for (const [dx, dy] of dirs) {
        const n = { x: c.x + dx, y: c.y + dy };
        const k = key(n.x, n.y);
        if (first.has(k) || cheb(n, m) > limit) continue;
        const via = first.get(key(c.x, c.y)) ?? n;
        if (n.x === t.x && n.y === t.y) return this.canEnter(via.x, via.y, players, t) ? via : undefined;
        if (!this.canEnter(n.x, n.y, players)) continue;
        first.set(k, via);
        queue.push(n);
      }
    }
    return undefined;
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
      if (d < min || d > max || this.ground.quiet(x, y)) continue;
      if (players.some((q) => cheb(q, { x, y }) < min) || !this.canEnter(x, y, players)) continue;
      if (this.ground.favoured(x, y)) return { x, y };
      fallback ??= { x, y };
    }
    return fallback;
  }
}
