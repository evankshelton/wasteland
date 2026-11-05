// Card battles: Slay the Spire's turns, with Magic: the Gathering's stack. The
// server runs every battle; clients only see snapshots and send their moves.
//
// Each turn you get your Energy back, discard what's left of your hand, draw
// a new one, and play cards that cost Energy: attacks, Block, powers that last
// the fight, and allies that fight beside you. Then you end your turn: your
// allies attack, and every enemy group plays the move its intent showed.
//
// The enemies are groups of one kind (shared/enemies.json, enemies.ts): a pack
// of zombies, a gang of raiders, feral hounds, ghouls, a rat swarm, cave
// crawlers. Each group is one enemy with its kind's health per member, so as
// you wear it down members fall and it hits more softly. Each fights with its
// kind's cards: a shuffled deck of moves, one played a turn, and one reaction.
//
// Nothing happens straight away. A card you play, an ally's attack and a
// group's move all go on the stack, and the other side can answer before it
// lands:
//   - Groups react to your cards (each has one reaction it can use once a
//     round, when its trigger comes up: you attack it, you play a Block card,
//     a Reaction, an Ally...). Its reaction goes on top and lands first.
//   - You can answer anything a group puts on the stack with a Reaction card
//     (Actions only on your own turn, with the stack empty). Energy you didn't
//     spend stays until your next turn starts, and so does your hand, so
//     leaving some up for the enemies' turn is a choice.
// When you pass (or can't answer), the stack lands from the top down. Cards
// whose target is gone by then miss; countered ones do nothing at all.
//
// Statuses: Weak (deal 25% less), Vulnerable (take 50% more), Poison (lose that
// much HP each turn, then one less), Strength / Dexterity (more damage / Block
// per card), Thorns (attackers take that much damage per hit).
import { CARDS, attackDamage, blockAmount, view, type CardDef, type CardView, type Effects } from "./cards.ts";
import type { Character } from "./character.ts";
import { ENEMY_CARDS, enemy, enemyCardView, intentText, play, type EnemyType, type Played } from "./enemies.ts";

/** A zombie's health: each one in a pack is worth this much. */
export const HP_PER_ZOMBIE = enemy("zombie").hp;
export const BASE_ENERGY = 3;
export const BASE_DRAW = 5;
export const HAND_MAX = 10;
export const MAX_ALLIES = 3;
/** Groups never grow past this many members (rats breed). */
export const MAX_MEMBERS = 20;

export interface CardRef {
  uid: number;
  card: string;
  level: number;
}

export interface Status {
  weak: number;
  vulnerable: number;
  poison: number;
  strength: number;
  dexterity: number;
  thorns: number;
}

const noStatus = (): Status => ({ weak: 0, vulnerable: 0, poison: 0, strength: 0, dexterity: 0, thorns: 0 });

/** What a group will do on its turn: one of its move cards, with the numbers for its size. */
export type Intent = Played;

const hostile = (it: Intent) => it.damage !== undefined;

export interface Foe {
  /** The overworld (or dungeon) monster this group came from. */
  id: number;
  kind: string;
  type: EnemyType;
  name: string;
  hp: number;
  maxHp: number;
  block: number;
  status: Status;
  intent: Intent;
  /** Its moves still to come (card ids), the next one last; reshuffled when it runs out. */
  deck: string[];
  reaction?: Played;
  /** Used its reaction this round. */
  reacted: boolean;
}

export interface Ally {
  /** The card that brought it (it goes to the discard pile when the ally falls). */
  ref: CardRef;
  name: string;
  power: number;
  hp: number;
  maxHp: number;
  guard: boolean;
  sweep: boolean;
}

/** Something waiting to happen. The top of the stack happens first. */
interface StackItem {
  id: number;
  /** Whose it is: yours (a card, or an ally's attack) or a group's. */
  by: "you" | "foe";
  kind: "card" | "ally" | "move" | "reaction";
  name: string;
  /** The group it's aimed at (cards, ally attacks), or whose move or reaction it is. */
  foe?: number;
  /** An ally: the one attacking (ally attacks), or the one a group's move is aimed at. */
  ally?: number;
  ref?: CardRef;
  e?: Effects;
  def?: CardDef;
  /** A counter: the stack item it cancels. */
  counters?: number;
  /** A group's reaction: what it was in answer to (whose attacker gets hit, whose card gets countered). */
  answers?: number;
  countered?: boolean;
}

/** What the client sees of a battle. */
export interface BattleView {
  turn: number;
  /** Whose turn it is. */
  phase: "you" | "zombies";
  /** A group's move or reaction is on top of the stack: play a Reaction or pass. */
  respond: boolean;
  /** Bottom to top. */
  stack: { by: "you" | "foe"; name: string; text: string }[];
  /** The group your allies attack (the last one you aimed at). */
  mark: number;
  player: { hp: number; maxHp: number; block: number; energy: number; maxEnergy: number; status: Status };
  allies: { uid: number; card: string; name: string; power: number; hp: number; maxHp: number; guard: boolean; sweep: boolean }[];
  enemies: {
    id: number; kind: string; sprite: number; name: string; one: string; many: string; count: number; hp: number; maxHp: number;
    block: number; status: Status; intent: Intent & { text: string };
    reaction?: { name: string; text: string; ready: boolean };
    /** Its cards: every move in its deck, then its reaction. */
    cards: CardView[];
  }[];
  hand: (CardView & { uid: number; playable: boolean })[];
  drawPile: number;
  discardPile: number;
  exhausted: number;
  /** Cards the ground around you added for this fight. */
  terrain: string[];
  log: string[];
  over?: "victory" | "fled" | "died";
}

/** Members still standing in a group. */
export const membersLeft = (f: Foe) => Math.max(0, Math.ceil(f.hp / f.type.hp));

/** Seedable random numbers (mulberry32), so a battle can be replayed in tests. */
function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BattleSetup {
  seed: number;
  character: Character;
  /** The cards in the player's deck. */
  deck: CardRef[];
  /** Card ids the terrain adds for this fight only. */
  terrain: string[];
  /** Enemy groups: monster id, kind (zombie if left out) and how many members. */
  packs: { id: number; kind?: string; count: number }[];
}

export class Battle {
  turn = 0;
  hp: number;
  maxHp: number;
  block = 0;
  energy = 0;
  maxEnergy = BASE_ENERGY;
  status: Status = noStatus();
  foes: Foe[];
  allies: Ally[] = [];
  drawPile: CardRef[];
  hand: CardRef[] = [];
  discard: CardRef[] = [];
  exhausted: CardRef[] = [];
  terrain: string[];
  log: string[] = [];
  over?: "victory" | "fled" | "died";
  /** Whose turn it is. */
  side: "you" | "zombies" = "you";
  stack: StackItem[] = [];
  /** Waiting for you to answer the top of the stack (or pass). */
  respond = false;
  /** The group your allies go for. */
  mark: number;
  private rng: () => number;
  private draws: number;
  private nextItem = 1;
  /** Who's still to act this enemy turn: your allies first, then the groups. */
  private queue: ({ ally: number } | { foe: number })[] = [];
  /** Running away: parting hits do half damage. */
  private fleeing = false;

  constructor(setup: BattleSetup) {
    const c = setup.character;
    this.rng = rngFrom(setup.seed);
    this.hp = c.hp;
    this.maxHp = c.maxHp;
    // Abilities give a head start: strength hits harder, dexterity blocks better, intelligence draws more.
    this.status.strength = Math.floor(Math.max(0, c.str - 9) / 6);
    this.status.dexterity = Math.floor(Math.max(0, c.dex - 9) / 6);
    this.draws = BASE_DRAW + (c.int >= 16 ? 1 : 0);
    this.terrain = setup.terrain;
    const temp = setup.terrain.map((id, i) => ({ uid: 1_000_000 + i, card: id, level: 0 }));
    this.drawPile = this.shuffle([...setup.deck, ...temp]);
    this.foes = setup.packs.map((p, i) => {
      const type = enemy(p.kind ?? "zombie");
      const hp = Math.max(1, p.count) * type.hp;
      const foe: Foe = {
        id: p.id, kind: type.kind, type, name: `${type.name} ${String.fromCharCode(65 + (i % 26))}`, hp, maxHp: hp, block: 0,
        status: noStatus(), intent: { card: "", name: "" }, deck: [], reacted: false,
      };
      foe.reaction = this.chooseReaction(foe);
      return foe;
    });
    this.mark = this.foes[0]?.id ?? 0;
    for (const f of this.foes) f.intent = this.chooseIntent(f);
    if (setup.terrain.length) this.say(`The ground gives you: ${[...new Set(setup.terrain.map((t) => CARDS.get(t)!.name))].join(", ")}.`);
    this.startTurn();
  }

  // ---- your moves ----

  /** Play a card from your hand. Returns why not, if it can't be played. */
  play(uid: number, target?: number): string | undefined {
    const i = this.hand.findIndex((c) => c.uid === uid);
    if (i < 0) return this.over ? "The fight is over." : "That card isn't in your hand.";
    const ref = this.hand[i]!;
    const why = this.cantPlay(ref);
    if (why) return why;
    const def = CARDS.get(ref.card)!;
    const e = def.levels[ref.level]!;
    const top = this.stack.at(-1);
    let foe: number | undefined;
    if (def.target === "enemy") {
      const living = this.living();
      foe = (target === undefined && living.length === 1 ? living[0] : living.find((f) => f.id === target))?.id;
      if (foe === undefined) return "Pick a target.";
      this.mark = foe;
    } else if (def.target === "source") {
      foe = top!.foe;
    }
    this.hand.splice(i, 1);
    this.energy -= e.cost;
    const name = view(ref.card, ref.level).name;
    const item: StackItem = { id: this.nextItem++, by: "you", kind: "card", name, foe, ref, e, def, counters: e.counter ? top!.id : undefined };
    this.stack.push(item);
    this.say(this.respond ? `You answer with ${name}.` : `You play ${name}.`);
    this.respond = false;
    this.foesAnswer(item);
    this.advance();
    return undefined;
  }

  /** Let the top of the stack happen without answering it. */
  pass(): string | undefined {
    if (this.over) return "The fight is over.";
    if (!this.respond) return "There's nothing to answer.";
    this.respond = false;
    this.resolveStack();
    this.advance();
    return undefined;
  }

  /** End your turn: your allies attack (the marked group, or `target`), then the enemies act, then your next turn starts. */
  endTurn(target?: number): string | undefined {
    if (this.over) return "The fight is over.";
    if (this.respond) return "Answer them first (or pass).";
    if (this.side !== "you") return "It's not your turn.";
    if (target !== undefined && this.living().some((f) => f.id === target)) this.mark = target;
    this.side = "zombies";
    this.queue = [...this.allies.map((a) => ({ ally: a.ref.uid })), ...this.living().map((f) => ({ foe: f.id }))];
    this.advance();
    return undefined;
  }

  /** Run for it: every group gets one last go at you as you turn your back, though it's only a glancing one. */
  flee(): string | undefined {
    if (this.over) return "The fight is over.";
    if (this.respond || this.side !== "you") return "Not now: wait for your turn.";
    this.say("You run for it!");
    this.fleeing = true;
    for (const f of this.living()) {
      if (this.over) break;
      if (hostile(f.intent)) this.resolveMove(f);
    }
    if (!this.over) this.over = "fled";
    return undefined;
  }

  /** Why a card can't be played right now (undefined: it can). */
  private cantPlay(ref: CardRef): string | undefined {
    if (this.over) return "The fight is over.";
    const def = CARDS.get(ref.card)!;
    const e = def.levels[ref.level]!;
    if (e.cost > this.energy) return "Not enough energy.";
    if (this.respond) {
      if (def.speed !== "reaction") return "Only a Reaction can answer that.";
    } else if (this.side !== "you" || this.stack.length) {
      return "It's not your turn.";
    }
    const top = this.stack.at(-1);
    if (e.counter || def.target === "source") {
      if (!this.respond || !top) return "There's nothing to answer.";
      if (e.counter === "reaction" && top.kind !== "reaction") return "That only counters a reaction.";
      if (e.counter === "attack" && !(top.kind === "move" && hostile(this.foe(top.foe)!.intent))) return "That only counters an attack.";
    }
    if (e.ally && this.allies.length >= MAX_ALLIES) return `You can't lead more than ${MAX_ALLIES} allies.`;
    return undefined;
  }

  /** Can you answer what's on top of the stack? (If not, it just happens.) */
  private canAnswer(): boolean {
    this.respond = true;
    const can = this.hand.some((r) => !this.cantPlay(r));
    this.respond = false;
    return can;
  }

  // ---- the stack ----

  /** Keep the battle moving until it needs you: an answer, or your next move. */
  private advance(): void {
    while (!this.over) {
      if (this.stack.length) {
        if (this.stack.at(-1)!.by === "foe" && this.canAnswer()) {
          this.respond = true;
          return;
        }
        this.resolveStack();
        continue;
      }
      if (this.side === "you") return;
      const next = this.queue.shift();
      if (!next) {
        this.endRound();
        continue;
      }
      if ("ally" in next) {
        const a = this.allies.find((x) => x.ref.uid === next.ally);
        const at = this.foe(this.mark)?.hp ? this.mark : this.living()[0]?.id;
        if (!a || at === undefined) continue;
        const item: StackItem = { id: this.nextItem++, by: "you", kind: "ally", name: `${a.name} attacks`, ally: a.ref.uid, foe: a.sweep ? undefined : at };
        this.stack.push(item);
        this.foesAnswer(item);
      } else {
        const f = this.foe(next.foe);
        if (!f || f.hp <= 0) continue;
        f.block = 0;
        // Guards draw the attack; an ally it meant to go for that's gone means it comes for you.
        const guard = this.allies.find((a) => a.guard);
        const it = f.intent;
        const ally = !hostile(it) || it.all ? undefined : guard ? guard.ref.uid : this.allies.some((a) => a.ref.uid === it.at) ? it.at : undefined;
        this.stack.push({ id: this.nextItem++, by: "foe", kind: "move", name: `${f.name}: ${it.name}`, foe: f.id, ally });
      }
    }
    this.stack = [];
    this.respond = false;
  }

  /** Everything on the stack happens, top first. */
  private resolveStack(): void {
    while (this.stack.length && !this.over) {
      this.resolve(this.stack.pop()!);
      this.checkOver();
    }
  }

  private resolve(item: StackItem): void {
    if (item.countered) {
      this.say(`${item.name}: countered.`);
      if (item.ref) this.discard.push(item.ref);
      return;
    }
    switch (item.kind) {
      case "card": {
        const def = item.def!;
        const e = item.e!;
        const foe = item.foe === undefined ? undefined : this.foe(item.foe);
        const gone = foe !== undefined && foe.hp <= 0;
        if (gone && (e.damage !== undefined || e.poison || e.weak || e.vulnerable)) this.say(`${item.name} misses: ${foe.name} is down.`);
        if (e.counter) {
          const target = this.stack.find((s) => s.id === item.counters);
          if (target) target.countered = true;
        }
        this.apply(e, gone ? undefined : foe);
        if (e.ally) {
          this.allies.push({ ref: item.ref!, name: def.name, power: e.ally.power, hp: e.ally.toughness, maxHp: e.ally.toughness, guard: !!e.ally.guard, sweep: !!e.ally.sweep });
          this.say(`${def.name} joins the fight.`);
        } else {
          // Powers and exhausting cards are gone for the rest of the fight.
          (def.type === "power" || e.exhaust ? this.exhausted : this.discard).push(item.ref!);
        }
        break;
      }
      case "ally": {
        const a = this.allies.find((x) => x.ref.uid === item.ally);
        if (!a) return;
        for (const f of a.sweep ? this.living() : [this.foe(item.foe!)!]) {
          if (f.hp > 0) this.hurtFoe(f, a.power);
        }
        break;
      }
      case "move": {
        const f = this.foe(item.foe!)!;
        if (f.hp <= 0) return;
        this.resolveMove(f, item.ally);
        break;
      }
      case "reaction": {
        const f = this.foe(item.foe!)!;
        if (f.hp <= 0) return;
        this.resolveReaction(f, f.reaction!, this.stack.find((s) => s.id === item.answers));
        break;
      }
    }
  }

  /** A group may answer what you just put on the stack, with its reaction: the first group it fits answers. */
  private foesAnswer(item: StackItem): void {
    for (const f of this.living()) {
      const r = f.reaction;
      if (!r || f.reacted || !this.triggers(r, item, f)) continue;
      f.reacted = true;
      this.stack.push({ id: this.nextItem++, by: "foe", kind: "reaction", name: `${f.name}: ${r.name}`, foe: f.id, answers: item.id });
      this.say(`${f.name} reacts: ${r.name}!`);
      return;
    }
  }

  /** Does stack item `item` set off group `f`'s reaction `r`? */
  private triggers(r: Played, item: StackItem, f: Foe): boolean {
    const e = item.kind === "card" ? item.e! : undefined;
    switch (r.trigger) {
      case "attacked":
        return this.attacks(item, f);
      case "attacked_all":
        return item.kind === "ally" ? item.foe === undefined : e?.damage_all !== undefined;
      case "other_attacked":
        return !this.attacks(item, f) && this.living().some((o) => o !== f && this.attacks(item, o));
      case "block_card":
        return e?.block !== undefined;
      case "heal_card":
        return !!e?.heal;
      case "reaction_card":
        return item.kind === "card" && item.def!.speed === "reaction";
      case "ally_card":
        return !!e?.ally;
      default:
        return false;
    }
  }

  /** Whether a stack item hits group `f`. */
  private attacks(item: StackItem, f: Foe): boolean {
    if (item.kind === "ally") return item.foe === undefined || item.foe === f.id;
    if (item.kind !== "card") return false;
    const e = item.e!;
    return e.damage_all !== undefined || (e.damage !== undefined && item.foe === f.id);
  }

  /** A group's reaction lands, on whoever played what it answers (you, or an attacking ally). */
  private resolveReaction(f: Foe, r: Played, answered?: StackItem): void {
    const ally = answered?.kind === "ally" ? this.allies.find((a) => a.ref.uid === answered.ally) : undefined;
    const who = ally ? ally.name : "you";
    if (r.counter && answered) {
      answered.countered = true;
      this.say(`${f.name}: ${r.name} stops ${answered.name}.`);
    }
    if (r.block) {
      f.block += r.block;
      this.say(`${f.name} gains ${r.block} Block.`);
    }
    if (r.strike) {
      this.say(`${f.name} hits ${who}.`);
      this.foeHits(f, r.strike, ally);
    }
    if (r.poison && !this.over) {
      if (ally) this.hurtAlly(ally, r.poison);
      else {
        this.status.poison += r.poison;
        this.say(`${f.name} Poisons you (${r.poison}).`);
      }
    }
    if (r.strength) {
      f.status.strength += r.strength;
      this.say(`${f.name} gains ${r.strength} Strength.`);
    }
    if (r.heal) this.healFoe(f, r.heal);
    if (r.summon) this.summon(f, r.summon);
  }

  private apply(e: Effects, foe?: Foe): void {
    const s = this.status;
    const mods = { strength: s.strength, weak: s.weak > 0 };
    if (e.self_damage) this.hurtPlayer(e.self_damage, false);
    if (e.damage !== undefined && foe) {
      for (let h = 0; h < (e.hits ?? 1) && foe.hp > 0; h++) this.hurtFoe(foe, attackDamage(e.damage, mods));
    }
    if (e.damage_all !== undefined) for (const f of this.foes) if (f.hp > 0) this.hurtFoe(f, attackDamage(e.damage_all, mods));
    if (e.poison && foe) foe.status.poison += e.poison;
    if (e.weak && foe) foe.status.weak += e.weak;
    if (e.vulnerable && foe) foe.status.vulnerable += e.vulnerable;
    for (const f of this.foes) {
      if (f.hp <= 0) continue;
      f.status.poison += e.poison_all ?? 0;
      f.status.weak += e.weak_all ?? 0;
    }
    if (e.block !== undefined) this.block += blockAmount(e.block, { dexterity: s.dexterity });
    if (e.heal) this.hp = Math.min(this.maxHp, this.hp + e.heal);
    if (e.energy) this.energy += e.energy;
    if (e.strength) s.strength += e.strength;
    if (e.dexterity) s.dexterity += e.dexterity;
    if (e.thorns) s.thorns += e.thorns;
    if (e.cleanse) s.weak = s.vulnerable = s.poison = 0;
    if (e.draw) this.draw(e.draw);
  }

  // ---- turns ----

  private startTurn(): void {
    this.turn++;
    this.side = "you";
    // What you held through the enemies' turn goes now.
    this.discard.push(...this.hand);
    this.hand = [];
    if (this.status.poison > 0) {
      this.say(`Poison: you lose ${this.status.poison} HP.`);
      this.hurtPlayer(this.status.poison, false);
      this.status.poison--;
      if (this.over) return;
    }
    this.block = 0;
    this.energy = this.maxEnergy;
    for (const f of this.foes) f.reacted = false;
    this.draw(this.draws);
  }

  private draw(n: number): void {
    for (let i = 0; i < n && this.hand.length < HAND_MAX; i++) {
      if (this.drawPile.length === 0) {
        if (this.discard.length === 0) return;
        this.drawPile = this.shuffle(this.discard);
        this.discard = [];
      }
      this.hand.push(this.drawPile.pop()!);
    }
  }

  /** Every group has acted: poison ticks, statuses wear off, the groups pick their next moves, and your turn starts. */
  private endRound(): void {
    for (const f of this.foes) {
      if (f.hp <= 0) continue;
      if (f.status.poison > 0) {
        this.hurtFoe(f, f.status.poison, true);
        f.status.poison--;
      }
      f.status.weak = Math.max(0, f.status.weak - 1);
      f.status.vulnerable = Math.max(0, f.status.vulnerable - 1);
    }
    this.status.weak = Math.max(0, this.status.weak - 1);
    this.status.vulnerable = Math.max(0, this.status.vulnerable - 1);
    this.checkOver();
    if (this.over) return;
    for (const f of this.living()) f.intent = this.chooseIntent(f);
    this.startTurn();
  }

  // ---- the enemies ----

  /** A group plays the move its intent showed: at you (and every ally, for moves that hit all), or at the ally `allyUid`. */
  private resolveMove(f: Foe, allyUid?: number): void {
    const it = f.intent;
    const ally = this.allies.find((a) => a.ref.uid === allyUid);
    if (it.damage !== undefined) {
      const victims: (Ally | undefined)[] = it.all ? [undefined, ...this.allies] : [ally];
      for (let h = 0; h < (it.hits ?? 1) && !this.over; h++) {
        for (const v of victims) if (!this.over && f.hp > 0) this.foeHits(f, it.damage, v);
      }
    }
    if (this.over) return;
    if (!ally) {
      if (it.weak) {
        this.status.weak += it.weak;
        this.say(`${f.name}: ${it.name}. You're Weak.`);
      }
      if (it.vulnerable) {
        this.status.vulnerable += it.vulnerable;
        this.say(`${f.name}: ${it.name}. You're Vulnerable.`);
      }
      if (it.poison) {
        this.status.poison += it.poison;
        this.say(`${f.name}: ${it.name}. You're Poisoned.`);
      }
      for (let i = 0; i < (it.discard ?? 0) && this.hand.length; i++) {
        const lost = this.hand.splice(Math.floor(this.rng() * this.hand.length), 1)[0]!;
        this.discard.push(lost);
        this.say(`${f.name}: ${it.name}. You drop ${view(lost.card, lost.level).name}.`);
      }
    }
    if (it.block) {
      f.block += it.block;
      this.say(`${f.name}: ${it.name} (${it.block} Block).`);
    }
    if (it.strength) {
      f.status.strength += it.strength;
      this.say(`${f.name}: ${it.name} (+${it.strength} Strength).`);
    }
    if (it.heal) this.healFoe(f, it.heal);
    if (it.summon) this.summon(f, it.summon);
  }

  private foeHits(f: Foe, base: number, ally?: Ally): void {
    let d = base + f.status.strength;
    if (f.status.weak > 0) d = Math.floor(d * 0.75);
    if (this.fleeing) d = Math.ceil(d / 2);
    d = Math.max(0, d);
    if (ally) {
      this.hurtAlly(ally, d);
      return;
    }
    this.hurtPlayer(d, true);
    if (this.status.thorns > 0 && f.hp > 0) this.hurtFoe(f, this.status.thorns, true);
  }

  private hurtAlly(ally: Ally, d: number): void {
    if (!this.allies.includes(ally)) return;
    ally.hp -= d;
    this.say(`${ally.name} takes ${d} damage.`);
    if (ally.hp <= 0) {
      this.say(`${ally.name} goes down.`);
      this.allies.splice(this.allies.indexOf(ally), 1);
      this.discard.push(ally.ref);
    }
  }

  private healFoe(f: Foe, amount: number): void {
    const before = membersLeft(f);
    f.hp = Math.min(f.maxHp, f.hp + amount);
    const back = membersLeft(f) - before;
    this.say(`${f.name} heals ${amount}${back > 0 ? ` (${back} ${back === 1 ? f.type.one : f.type.many} back up)` : ""}.`);
  }

  /** More members join a group (it can grow past the size it started at, up to MAX_MEMBERS). */
  private summon(f: Foe, n: number): void {
    const room = MAX_MEMBERS - membersLeft(f);
    const k = Math.max(0, Math.min(n, room));
    if (!k) return;
    // Topped up to whole members, then k more.
    f.hp = membersLeft(f) * f.type.hp + k * f.type.hp;
    f.maxHp = Math.max(f.maxHp, f.hp);
    this.say(`${k} more ${k === 1 ? f.type.one : f.type.many} join ${f.name}.`);
  }

  /**
   * What a group will do next turn: the next card of its move deck it can
   * play (big enough, wounded for a heal, not the same as last time where
   * that's not allowed). Its numbers grow with the group.
   */
  private chooseIntent(f: Foe): Intent {
    const n = membersLeft(f);
    const ok = (id: string) => {
      const c = ENEMY_CARDS.get(id)!;
      return (c.min ?? 0) <= n && (!c.hurt || f.hp < f.maxHp) && !(c.noRepeat && f.intent.card === id);
    };
    for (let pass = 0; pass < 2; pass++) {
      if (!f.deck.some(ok)) f.deck = this.shuffle(f.type.moves.flatMap((c) => Array(c.weight ?? 1).fill(c.id) as string[]));
      const i = f.deck.findLastIndex(ok);
      if (i < 0) continue;
      const id = f.deck.splice(i, 1)[0]!;
      const intent = play(ENEMY_CARDS.get(id)!, n);
      // Allies draw attention: a guard always, the rest now and then.
      if (hostile(intent) && !intent.all && this.allies.length) {
        const guard = this.allies.find((a) => a.guard);
        if (guard) intent.at = guard.ref.uid;
        else if (this.rng() < 0.35) intent.at = this.allies[Math.floor(this.rng() * this.allies.length)]!.ref.uid;
      }
      return intent;
    }
    return play(f.type.moves[0]!, n);
  }

  /** The reaction a group has, from its kind's reactions (big enough groups only, and not always). */
  private chooseReaction(f: Foe): Played | undefined {
    const n = membersLeft(f);
    if (n < f.type.reactMin || this.rng() >= f.type.reactChance) return undefined;
    const options = f.type.reactions.filter((r) => (r.min ?? 0) <= n);
    const total = options.reduce((s, r) => s + (r.weight ?? 1), 0);
    let roll = this.rng() * total;
    for (const r of options) if ((roll -= r.weight ?? 1) < 0) return play(r, n);
    return undefined;
  }

  // ---- damage ----

  private hurtFoe(f: Foe, amount: number, ignoreBlock = false): void {
    let d = f.status.vulnerable > 0 && !ignoreBlock ? Math.floor(amount * 1.5) : amount;
    if (!ignoreBlock) {
      const soaked = Math.min(f.block, d);
      f.block -= soaked;
      d -= soaked;
    }
    const before = membersLeft(f);
    f.hp = Math.max(0, f.hp - d);
    const fell = before - membersLeft(f);
    if (fell > 0) this.say(f.hp === 0 ? `The last of ${f.name} goes down.` : `${fell} ${fell === 1 ? f.type.one : f.type.many} fall${fell === 1 ? "s" : ""}.`);
  }

  private hurtPlayer(amount: number, blockable: boolean): void {
    let d = this.status.vulnerable > 0 && blockable ? Math.floor(amount * 1.5) : amount;
    if (blockable) {
      const soaked = Math.min(this.block, d);
      this.block -= soaked;
      d -= soaked;
    }
    if (d > 0) {
      this.hp = Math.max(0, this.hp - d);
      if (blockable) this.say(`You take ${d} damage.`);
    } else if (blockable) {
      this.say("Your Block holds.");
    }
    if (this.hp <= 0) this.over = "died";
  }

  private checkOver(): void {
    if (this.over) return;
    if (this.hp <= 0) this.over = "died";
    else if (this.foes.every((f) => f.hp <= 0)) this.over = "victory";
  }

  // ---- bookkeeping ----

  private foe(id: number | undefined): Foe | undefined {
    return this.foes.find((f) => f.id === id);
  }

  private living(): Foe[] {
    return this.foes.filter((f) => f.hp > 0);
  }

  private shuffle<T>(list: T[]): T[] {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }

  private say(line: string): void {
    this.log.push(line);
    if (this.log.length > 40) this.log.shift();
  }

  /** An intent in a few words, with the group's Strength and Weak counted, and who it's aimed at. */
  private intentText(f: Foe, at?: number): string {
    const text = intentText(f.intent, { strength: f.status.strength, weak: f.status.weak > 0 });
    const ally = this.allies.find((a) => a.ref.uid === at);
    return ally ? `${text} at ${ally.name}` : text;
  }

  /** What a stack item will do, in words. */
  private itemText(item: StackItem): string {
    const at = (id?: number) => this.foe(id)?.name ?? "?";
    switch (item.kind) {
      case "card": {
        const v = view(item.ref!.card, item.ref!.level, { strength: this.status.strength, dexterity: this.status.dexterity, weak: this.status.weak > 0 });
        if (item.e!.counter) return `Counters ${this.stack.find((s) => s.id === item.counters)?.name ?? "it"}.`;
        return item.foe === undefined ? v.text : `${v.text} (at ${at(item.foe)})`;
      }
      case "ally": {
        const a = this.allies.find((x) => x.ref.uid === item.ally);
        return a ? `${a.power} damage to ${a.sweep ? "every group" : at(item.foe)}.` : "";
      }
      case "move": {
        const f = this.foe(item.foe)!;
        if (!hostile(f.intent)) return this.intentText(f);
        const victim = f.intent.all ? "you and your allies" : this.allies.find((a) => a.ref.uid === item.ally)?.name ?? "you";
        return `${this.intentText(f)} at ${victim}.`;
      }
      case "reaction": {
        const f = this.foe(item.foe)!;
        return enemyCardView(ENEMY_CARDS.get(f.reaction!.card)!, membersLeft(f), f.type).text;
      }
    }
  }

  view(): BattleView {
    const s = this.status;
    const mods = { strength: s.strength, dexterity: s.dexterity, weak: s.weak > 0 };
    return {
      turn: this.turn,
      phase: this.side,
      respond: this.respond,
      stack: this.stack.map((i) => ({ by: i.by, name: i.name + (i.countered ? " (countered)" : ""), text: this.itemText(i) })),
      mark: this.mark,
      player: { hp: this.hp, maxHp: this.maxHp, block: this.block, energy: this.energy, maxEnergy: this.maxEnergy, status: { ...s } },
      allies: this.allies.map((a) => ({ uid: a.ref.uid, card: a.ref.card, name: a.name, power: a.power, hp: a.hp, maxHp: a.maxHp, guard: a.guard, sweep: a.sweep })),
      enemies: this.foes.map((f) => {
        const n = Math.max(1, membersLeft(f));
        const reaction = f.reaction && enemyCardView(ENEMY_CARDS.get(f.reaction.card)!, n, f.type);
        return {
          id: f.id, kind: f.kind, sprite: f.type.sprite, name: f.name, one: f.type.one, many: f.type.many, count: membersLeft(f),
          hp: f.hp, maxHp: f.maxHp, block: f.block, status: { ...f.status },
          intent: { ...f.intent, text: this.intentText(f, f.intent.at) },
          reaction: reaction && { name: reaction.name, text: reaction.text, ready: !f.reacted },
          cards: [...f.type.moves.map((c) => enemyCardView(c, n, f.type)), ...(reaction ? [reaction] : [])],
        };
      }),
      hand: this.hand.map((c) => {
        const v = view(c.card, c.level, mods);
        return { ...v, uid: c.uid, playable: !this.cantPlay(c) };
      }),
      drawPile: this.drawPile.length,
      discardPile: this.discard.length,
      exhausted: this.exhausted.length,
      terrain: this.terrain,
      log: this.log.slice(-8),
      over: this.over,
    };
  }
}
