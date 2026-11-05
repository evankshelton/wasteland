// Every kind of enemy, from shared/enemies.json: zombies, raiders, feral hounds,
// ghouls, rat swarms and cave crawlers. Each is a group (a pack, a gang, a
// swarm) that fights as one enemy with its own cards: a deck of moves it plays
// one a turn (shown as its intent), and a reaction it can answer your cards
// with once a round. Card numbers grow with the group: a value is fixed, or
// {base, per}, base plus one for every `per` members.
//
// This module picks which kind turns up where and how many, works a card's
// numbers out for a group's size, and writes the cards' text.
import { readFileSync } from "node:fs";
import type { CardView } from "./cards.ts";

export type Scaled = number | { base: number; per: number };

export type Trigger = "attacked" | "attacked_all" | "other_attacked" | "block_card" | "heal_card" | "reaction_card" | "ally_card";

export interface EnemyCard {
  id: string;
  name: string;
  weight?: number;
  /** The fewest members that can play it. */
  min?: number;
  /** Only when wounded. */
  hurt?: boolean;
  /** Never twice running. */
  noRepeat?: boolean;
  /** Reactions: what sets it off. */
  trigger?: Trigger;
  flavor?: string;
  damage?: Scaled;
  hits?: Scaled;
  /** The hits land on you and on every ally. */
  all?: boolean;
  block?: Scaled;
  weak?: number;
  vulnerable?: number;
  poison?: number;
  discard?: number;
  strength?: number;
  heal?: Scaled;
  summon?: Scaled;
  strike?: Scaled;
  counter?: boolean;
}

export interface EnemyType {
  kind: string;
  /** What the group's called: "Zombies", "Feral Hounds". */
  name: string;
  one: string;
  many: string;
  sprite: number;
  /** Health per member. */
  hp: number;
  /** Time per step on the map, times the server's step time. */
  speed: number;
  /** XP and scrap per member killed, as a share of a zombie's. */
  value: number;
  /** Fewest and most members (zombies roll their pack size instead). */
  size?: [number, number];
  spawn: { overworld: number; dungeon: number; favour: string[] };
  reactMin: number;
  reactChance: number;
  moves: EnemyCard[];
  reactions: EnemyCard[];
}

const raw = JSON.parse(readFileSync(new URL("../../shared/enemies.json", import.meta.url), "utf8")) as { enemies: EnemyType[] };
export const ENEMIES: ReadonlyMap<string, EnemyType> = new Map(raw.enemies.map((e) => [e.kind, e]));

export function enemy(kind: string): EnemyType {
  return ENEMIES.get(kind) ?? ENEMIES.get("zombie")!;
}

/** Every enemy card, by id (move and reaction ids are unique across all kinds). */
export const ENEMY_CARDS: ReadonlyMap<string, EnemyCard> = new Map(
  raw.enemies.flatMap((e) => [...e.moves, ...e.reactions]).map((c) => [c.id, c]),
);

export function scaled(v: Scaled | undefined, members: number): number | undefined {
  if (v === undefined) return undefined;
  return typeof v === "number" ? v : v.base + Math.floor(members / v.per);
}

/** An enemy card with its numbers worked out for a group's size. */
export interface Played {
  card: string;
  name: string;
  damage?: number;
  hits?: number;
  all?: boolean;
  block?: number;
  weak?: number;
  vulnerable?: number;
  poison?: number;
  discard?: number;
  strength?: number;
  heal?: number;
  summon?: number;
  strike?: number;
  counter?: boolean;
  trigger?: Trigger;
  /** A move aimed at one of your allies (its uid), rather than you. */
  at?: number;
}

export function play(c: EnemyCard, members: number): Played {
  const n = members;
  const atLeast1 = (v: Scaled | undefined) => (v === undefined ? undefined : Math.max(1, scaled(v, n)!));
  const out: Played = {
    card: c.id, name: c.name, damage: atLeast1(c.damage), hits: atLeast1(c.hits), all: c.all, block: atLeast1(c.block),
    weak: c.weak, vulnerable: c.vulnerable, poison: c.poison, discard: c.discard, strength: c.strength,
    heal: atLeast1(c.heal), summon: atLeast1(c.summon), strike: atLeast1(c.strike), counter: c.counter, trigger: c.trigger,
  };
  for (const k of Object.keys(out) as (keyof Played)[]) if (out[k] === undefined) delete out[k];
  return out;
}

// ---- where they turn up ----

/** Which kind of enemy appears on a tile (its terrain key), overworld or dungeon. */
export function pickKind(dungeon: boolean, tileKey: string, rng: () => number): string {
  const options = [...ENEMIES.values()].map((e) => {
    const w = dungeon ? e.spawn.dungeon : e.spawn.overworld;
    return [e.kind, w * (w > 0 && e.spawn.favour.includes(tileKey) ? 4 : 1)] as const;
  });
  const total = options.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [kind, w] of options) if ((r -= w) < 0) return kind;
  return "zombie";
}

// ---- text ----

const TRIGGER_TEXT: Record<Trigger, string> = {
  attacked: "When attacked",
  attacked_all: "When you hit every group",
  other_attacked: "When another group is attacked",
  block_card: "When you play a Block card",
  heal_card: "When you heal",
  reaction_card: "When you play a Reaction",
  ally_card: "When you play an Ally",
};

/** What a move does, briefly, as an intent ("Attack 3x2, Poison 1"). Damage counts the group's Strength and Weak. */
export function intentText(p: Played, mods: { strength?: number; weak?: boolean } = {}): string {
  const parts: string[] = [];
  if (p.damage !== undefined) {
    let d = Math.max(0, p.damage + (mods.strength ?? 0));
    if (mods.weak) d = Math.floor(d * 0.75);
    parts.push(`Attack ${d}${p.hits && p.hits > 1 ? `x${p.hits}` : ""}${p.all ? " (all)" : ""}`);
  }
  if (p.weak) parts.push(`Weak ${p.weak}`);
  if (p.vulnerable) parts.push(`Vulnerable ${p.vulnerable}`);
  if (p.poison) parts.push(`Poison ${p.poison}`);
  if (p.discard) parts.push(`Discard ${p.discard}`);
  if (p.block) parts.push(`Block ${p.block}`);
  if (p.strength) parts.push(`+${p.strength} Strength`);
  if (p.heal) parts.push(`Heal ${p.heal}`);
  if (p.summon) parts.push(`+${p.summon} more`);
  return parts.join(", ");
}

/** A card's rules text, for a group of `members`. */
export function cardText(c: EnemyCard, members: number, type: EnemyType): string {
  const p = play(c, members);
  if (p.trigger) {
    const answers = p.trigger === "attacked" || p.trigger === "attacked_all" ? "the attacker" : "you";
    const fx: string[] = [];
    if (p.counter) fx.push("counters it");
    if (p.block) fx.push(`gains ${p.block} Block first`);
    if (p.strike) fx.push(`hits ${answers} for ${p.strike} first`);
    if (p.poison) fx.push(`Poisons ${answers} ${p.poison}`);
    if (p.strength) fx.push(`gains ${p.strength} Strength`);
    if (p.heal) fx.push(`heals ${p.heal}`);
    if (p.summon) fx.push(`${p.summon} more ${p.summon === 1 ? type.one : type.many} join`);
    return `${TRIGGER_TEXT[p.trigger]}, it ${fx.join(" and ")}.`;
  }
  const parts: string[] = [];
  if (p.damage !== undefined) {
    const times = p.hits && p.hits > 1 ? ` ${p.hits} times` : "";
    parts.push(p.all ? `Deal ${p.damage} damage${times} to you and each ally.` : `Deal ${p.damage} damage${times}.`);
  }
  if (p.weak) parts.push(`Apply ${p.weak} Weak.`);
  if (p.vulnerable) parts.push(`Apply ${p.vulnerable} Vulnerable.`);
  if (p.poison) parts.push(`Apply ${p.poison} Poison.`);
  if (p.discard) parts.push(`You discard ${p.discard} card${p.discard === 1 ? "" : "s"} at random.`);
  if (p.block) parts.push(`Gain ${p.block} Block.`);
  if (p.strength) parts.push(`Gain ${p.strength} Strength.`);
  if (p.heal) parts.push(`Heal ${p.heal}.`);
  if (p.summon) parts.push(`${p.summon} more ${p.summon === 1 ? type.one : type.many} join.`);
  if (c.min) parts.push(`(${c.min}+ ${type.many})`);
  return parts.join(" ");
}

/** An enemy card, framed like the player's (the client draws them the same way). */
export function enemyCardView(c: EnemyCard, members: number, type: EnemyType): CardView {
  return {
    card: c.id, name: c.name, kind: "enemy", slot: type.one[0]!.toUpperCase() + type.one.slice(1), type: c.trigger ? "skill" : "attack",
    rarity: "common", speed: c.trigger ? "reaction" : "action", target: "self", level: 0, cost: -1, text: cardText(c, members, type),
    flavor: c.flavor, sprite: type.sprite,
  };
}
