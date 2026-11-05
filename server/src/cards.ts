// Cards: everything a player fights with. Definitions live in
// shared/cards.json; this module turns them into text, keeps each player's
// collection (their "kit": scrap, every card they own, which are in their
// deck, and card choices waiting for them), prices cards for the shops, and
// picks the cards on offer from shops, level-ups, loot and the terrain.
//
// Cards have a speed, as in Magic: the Gathering. An Action can only be played
// on your own turn, with nothing waiting to happen. A Reaction can also be
// played in answer to something: a zombie pack's move on its turn, or a pack
// reacting to one of your cards (see battle.ts).
import { readFileSync } from "node:fs";

export type CardKind = "basic" | "equipment" | "ability" | "ally" | "supply" | "terrain" | "enemy";
export type CardType = "attack" | "skill" | "power" | "ally";
export type Speed = "action" | "reaction";
export type Rarity = "starter" | "common" | "uncommon" | "rare";

/** What a card does at one level. */
export interface Effects {
  cost: number;
  damage?: number;
  hits?: number;
  damage_all?: number;
  block?: number;
  heal?: number;
  draw?: number;
  energy?: number;
  poison?: number;
  poison_all?: number;
  weak?: number;
  weak_all?: number;
  vulnerable?: number;
  strength?: number;
  dexterity?: number;
  thorns?: number;
  self_damage?: number;
  cleanse?: boolean;
  exhaust?: boolean;
  /** Cancel what this answers: a pack's reaction, its attack, or either. */
  counter?: "reaction" | "attack" | "any";
  /** An ally card: it joins the fight and stays until it's killed. */
  ally?: AllyStats;
}

export interface AllyStats {
  /** Damage it does when it attacks, at the end of each of your turns. */
  power: number;
  /** Its hit points. */
  toughness: number;
  /** Zombies must attack it before anyone else. */
  guard?: boolean;
  /** It hits every pack instead of the marked one. */
  sweep?: boolean;
}

export interface CardDef {
  id: string;
  name: string;
  kind: CardKind;
  slot?: "weapon" | "armor";
  type: CardType;
  rarity: Rarity;
  /** Action (your turn only) or Reaction (any time you can respond). Actions if left out. */
  speed?: Speed;
  /**
   * Who it's aimed at: one enemy (you pick), every enemy, yourself, or the
   * pack whose move or reaction you're answering.
   */
  target: "enemy" | "all" | "self" | "source";
  /** A line of colour under the rules text. */
  flavor?: string;
  /** For terrain cards: the tiles that put this card in your deck. */
  terrain?: string[];
  /** Level 0, 1 (+) and 2 (++). */
  levels: Effects[];
}

const raw = JSON.parse(readFileSync(new URL("../../shared/cards.json", import.meta.url), "utf8")) as { cards: CardDef[] };
export const CARDS: ReadonlyMap<string, CardDef> = new Map(raw.cards.map((c) => [c.id, c]));
export const MAX_LEVEL = 2;
export const DECK_MIN = 8;
export const DECK_MAX = 30;
export const STARTING_SCRAP = 40;

export function card(id: string): CardDef {
  const def = CARDS.get(id);
  if (!def) throw new Error(`no card "${id}" in shared/cards.json`);
  return def;
}

// ---- the player's kit ----

export interface OwnedCard {
  uid: number;
  card: string;
  level: number;
  /** In the deck you fight with, or set aside in your pack. */
  deck: boolean;
}

/** A choice of cards waiting for the player: one may be taken (or none). */
export interface Offer {
  reason: "level" | "loot";
  cards: { card: string; level: number }[];
}

export interface Kit {
  scrap: number;
  nextUid: number;
  cards: OwnedCard[];
  offers: Offer[];
}

/** What every survivor starts with: a pipe, a vest, and the basics. */
export function starterKit(): Kit {
  const kit: Kit = { scrap: STARTING_SCRAP, nextUid: 1, cards: [], offers: [] };
  for (let i = 0; i < 5; i++) addCard(kit, "swing", 0);
  for (let i = 0; i < 3; i++) addCard(kit, "brace", 0);
  addCard(kit, "duck", 0);
  addCard(kit, "pipe_swing", 0);
  addCard(kit, "scrap_vest", 0);
  return kit;
}

export const speed = (id: string): Speed => card(id).speed ?? "action";

/** Bring a kit from before Reactions up to date: everyone gets a Duck!. Returns whether it changed. */
export function updateKit(kit: Kit): boolean {
  if (kit.cards.some((c) => CARDS.has(c.card) && speed(c.card) === "reaction")) return false;
  addCard(kit, "duck", 0);
  return true;
}

export const deckSize = (kit: Kit) => kit.cards.filter((c) => c.deck).length;

/** A new card goes into the deck if there's room, otherwise into the pack. */
export function addCard(kit: Kit, id: string, level: number): OwnedCard {
  const owned: OwnedCard = { uid: kit.nextUid++, card: id, level, deck: deckSize(kit) < DECK_MAX };
  kit.cards.push(owned);
  return owned;
}

// ---- text ----

/** Battle modifiers that change the numbers a card shows. */
export interface Mods {
  strength?: number;
  dexterity?: number;
  weak?: boolean;
}

/** Damage one hit of `base` does with these modifiers (before the target's Vulnerable and Block). */
export function attackDamage(base: number, mods: Mods = {}): number {
  const d = Math.max(0, base + (mods.strength ?? 0));
  return mods.weak ? Math.floor(d * 0.75) : d;
}

export function blockAmount(base: number, mods: Mods = {}): number {
  return Math.max(0, base + (mods.dexterity ?? 0));
}

/** A card's rules text, written from its effects (with the numbers as they'd be right now, given `mods`). */
export function describe(e: Effects, mods: Mods = {}, target?: CardDef["target"]): string {
  const parts: string[] = [];
  if (e.counter) parts.push({ reaction: "Counter a zombie reaction.", attack: "Counter a zombie attack.", any: "Counter a zombie's move or reaction." }[e.counter]);
  if (e.ally) {
    parts.push(e.ally.sweep ? "Ally. At the end of your turn it hits every pack." : "Ally. At the end of your turn it attacks the marked pack.");
    if (e.ally.guard) parts.push("Guard: zombies must attack it first.");
  }
  if (e.self_damage) parts.push(`Lose ${e.self_damage} HP.`);
  if (e.damage !== undefined) {
    const d = attackDamage(e.damage, mods);
    const at = target === "source" ? " to the pack you answer" : "";
    parts.push(e.hits && e.hits > 1 ? `Deal ${d} damage${at} ${e.hits} times.` : `Deal ${d} damage${at}.`);
  }
  if (e.damage_all !== undefined) parts.push(`Deal ${attackDamage(e.damage_all, mods)} damage to ALL enemies.`);
  if (e.poison) parts.push(`Apply ${e.poison} Poison.`);
  if (e.poison_all) parts.push(`Apply ${e.poison_all} Poison to ALL enemies.`);
  if (e.weak) parts.push(`Apply ${e.weak} Weak.`);
  if (e.weak_all) parts.push(`Apply ${e.weak_all} Weak to ALL enemies.`);
  if (e.vulnerable) parts.push(`Apply ${e.vulnerable} Vulnerable.`);
  if (e.block !== undefined) parts.push(`Gain ${blockAmount(e.block, mods)} Block.`);
  if (e.heal) parts.push(`Heal ${e.heal} HP.`);
  if (e.draw) parts.push(`Draw ${e.draw} card${e.draw === 1 ? "" : "s"}.`);
  if (e.energy) parts.push(`Gain ${e.energy} Energy.`);
  if (e.strength) parts.push(`Gain ${e.strength} Strength.`);
  if (e.dexterity) parts.push(`Gain ${e.dexterity} Dexterity.`);
  if (e.thorns) parts.push(`Gain ${e.thorns} Thorns.`);
  if (e.cleanse) parts.push("Remove your Weak, Vulnerable and Poison.");
  if (e.exhaust) parts.push("Exhaust.");
  return parts.join(" ");
}

/** A card as the client shows it. */
export interface CardView {
  uid?: number;
  card: string;
  name: string;
  kind: CardKind;
  slot?: string;
  type: CardType;
  rarity: Rarity;
  speed: Speed;
  target: CardDef["target"];
  level: number;
  cost: number;
  text: string;
  flavor?: string;
  /** For allies: attack and hit points, shown in the corner like a creature's. */
  power?: number;
  toughness?: number;
  /** Enemy cards: the sprites.png column of the enemy that plays it (its art). */
  sprite?: number;
  deck?: boolean;
}

export function view(id: string, level: number, mods?: Mods): CardView {
  const def = card(id);
  const e = def.levels[Math.min(level, def.levels.length - 1)]!;
  const name = def.kind === "terrain" ? def.name : `${def.name}${"+".repeat(level)}`;
  return {
    card: id, name, kind: def.kind, slot: def.slot, type: def.type, rarity: def.rarity, speed: def.speed ?? "action", target: def.target,
    level, cost: e.cost, text: describe(e, mods, def.target), flavor: def.flavor, power: e.ally?.power, toughness: e.ally?.toughness,
  };
}

// ---- prices ----

const RARITY_PRICE: Record<Rarity, number> = { starter: 10, common: 40, uncommon: 75, rare: 130 };
const RARITY_UPGRADE: Record<Rarity, number> = { starter: 0.8, common: 1, uncommon: 1.5, rare: 2 };

export function price(id: string, level: number): number {
  return Math.round(RARITY_PRICE[card(id).rarity] * (1 + 0.5 * level));
}

/** What a shop pays for a card: a trader pays better than the rest. */
export function sellPrice(id: string, level: number, trader: boolean): number {
  return Math.max(1, Math.floor(price(id, level) * (trader ? 0.5 : 0.3)));
}

/** What it costs to take a card from `level` to the next. */
export function upgradeCost(id: string, level: number): number {
  return Math.round(25 * (level + 1) * RARITY_UPGRADE[card(id).rarity]);
}

// ---- shops ----

/** What a shop NPC does with cards, by their service. */
export interface ShopKind {
  title: string;
  /** Cards it sells. */
  sells: (def: CardDef) => boolean;
  /** Cards it upgrades (for a price). */
  upgrades: (def: CardDef) => boolean;
  /** Pays the better price for cards. */
  trader: boolean;
  /** What buying and upgrading are called here. */
  buyLabel: string;
  upgradeLabel: string;
}

const supplies = (d: CardDef) => d.kind === "supply";
const SHOPS: Record<string, ShopKind> = {
  weapons: { title: "Weapons", sells: (d) => d.slot === "weapon", upgrades: () => false, trader: false, buyLabel: "Buy", upgradeLabel: "Upgrade" },
  armor: { title: "Armor", sells: (d) => d.slot === "armor", upgrades: () => false, trader: false, buyLabel: "Buy", upgradeLabel: "Upgrade" },
  repair: { title: "Repairs", sells: () => false, upgrades: (d) => d.kind === "equipment", trader: false, buyLabel: "Buy", upgradeLabel: "Upgrade" },
  training: {
    title: "Training", sells: (d) => d.kind === "ability", upgrades: (d) => d.kind === "ability" || d.kind === "basic" || d.kind === "ally",
    trader: false, buyLabel: "Learn", upgradeLabel: "Train",
  },
  trade: { title: "Trade", sells: (d) => d.kind === "equipment" || d.kind === "supply" || d.kind === "ally", upgrades: () => false, trader: true, buyLabel: "Buy", upgradeLabel: "Upgrade" },
  healing: { title: "Medical Supplies", sells: supplies, upgrades: () => false, trader: false, buyLabel: "Buy", upgradeLabel: "Upgrade" },
  radiation: { title: "Rad Supplies", sells: supplies, upgrades: () => false, trader: false, buyLabel: "Buy", upgradeLabel: "Upgrade" },
  water: { title: "Supplies", sells: supplies, upgrades: () => false, trader: false, buyLabel: "Buy", upgradeLabel: "Upgrade" },
  food: { title: "Supplies", sells: supplies, upgrades: () => false, trader: false, buyLabel: "Buy", upgradeLabel: "Upgrade" },
  drink: { title: "Supplies", sells: supplies, upgrades: () => false, trader: false, buyLabel: "Buy", upgradeLabel: "Upgrade" },
};

export function shopKind(service: string): ShopKind | undefined {
  return SHOPS[service];
}

const RARITY_WEIGHT: Record<Rarity, number> = { starter: 0, common: 6, uncommon: 3, rare: 1 };

/** Up to `n` different cards from `pool`, weighted towards the common ones. */
function pickCards(pool: CardDef[], n: number, rng: () => number): CardDef[] {
  const left = [...pool];
  const out: CardDef[] = [];
  while (out.length < n && left.length) {
    const total = left.reduce((s, d) => s + RARITY_WEIGHT[d.rarity], 0);
    let r = rng() * total;
    const i = left.findIndex((d) => (r -= RARITY_WEIGHT[d.rarity]) < 0);
    out.push(...left.splice(i < 0 ? left.length - 1 : i, 1));
  }
  return out;
}

/** What a shop has on its shelves: fixed for a given shop (`rng` is seeded from it). */
export function shopStock(service: string, rng: () => number): { card: string; level: number }[] {
  const shop = SHOPS[service];
  if (!shop) return [];
  const pool = [...CARDS.values()].filter((d) => d.kind !== "terrain" && d.kind !== "basic" && shop.sells(d));
  return pickCards(pool, 4 + Math.floor(rng() * 2), rng).map((d) => ({ card: d.id, level: rng() < 0.15 ? 1 : 0 }));
}

/** Three new ability cards to choose from on reaching a level. */
export function levelOffer(rng: () => number): Offer {
  const pool = [...CARDS.values()].filter((d) => d.kind === "ability");
  return { reason: "level", cards: pickCards(pool, 3, rng).map((d) => ({ card: d.id, level: 0 })) };
}

/** Three cards found after a fight: gear, abilities, allies and supplies. */
export function lootOffer(rng: () => number): Offer {
  const pool = [...CARDS.values()].filter((d) => d.kind === "equipment" || d.kind === "ability" || d.kind === "ally" || d.kind === "supply");
  return { reason: "loot", cards: pickCards(pool, 3, rng).map((d) => ({ card: d.id, level: 0 })) };
}

/**
 * The cards the ground gives you for one fight: for each terrain card, how
 * many of the surrounding tiles it fits; the two best fits (at least 3 tiles
 * each) join the deck, twice over if they cover a good stretch of ground.
 */
export function terrainCards(tileKeys: string[]): string[] {
  const score = new Map<string, number>();
  for (const key of tileKeys) {
    for (const def of CARDS.values()) if (def.terrain?.includes(key)) score.set(def.id, (score.get(def.id) ?? 0) + 1);
  }
  const best = [...score.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 2);
  const out: string[] = [];
  for (const [id, n] of best) {
    out.push(id);
    if (n >= tileKeys.length / 3) out.push(id);
  }
  return out;
}
