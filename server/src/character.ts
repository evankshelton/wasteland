// Character abilities, experience and levels. All rolls happen on the server.

export type Ability = "str" | "dex" | "int" | "hp";
export const ABILITIES: readonly Ability[] = ["str", "dex", "int", "hp"];

export interface Character {
  /** False until the player accepts a roll; until then they can reroll and can't play. */
  created: boolean;
  level: number;
  xp: number;
  str: number;
  dex: number;
  int: number;
  /** The hit points ability: maximum health. */
  maxHp: number;
  /** Current health, carried between fights. */
  hp: number;
  /** Level-up points not yet spent on an ability. */
  points: number;
}

export const ABILITY_MIN = 6;
export const ABILITY_MAX = 100;
/** How much one level-up point adds to the chosen ability. */
export const RAISE_BY = 2;

/** Experience for things players do. */
export const XP = { kill: 25, victory: 10, explore: 2 } as const;

/**
 * A fresh level 1 character. Strength, dexterity and intelligence are
 * 6 + two rolls of 0-6 (6-18, averaging 12); hit points are 6-12.
 */
export function rollCharacter(rng: () => number = Math.random): Character {
  const d7 = () => Math.floor(rng() * 7); // 0..6
  const maxHp = ABILITY_MIN + d7();
  return {
    created: false,
    level: 1,
    xp: 0,
    str: ABILITY_MIN + d7() + d7(),
    dex: ABILITY_MIN + d7() + d7(),
    int: ABILITY_MIN + d7() + d7(),
    maxHp,
    hp: maxHp,
    points: 0,
  };
}

/** Total experience needed to reach `level`: 0, 100, 300, 600, 1000... */
export function xpForLevel(level: number): number {
  return 50 * level * (level - 1);
}

/**
 * Award experience, boosted by intelligence (+1% per point above 12), and
 * level up as many times as it reaches. Returns the XP actually gained and
 * the number of levels gained (each grants one point to spend).
 */
export function gainXp(c: Character, base: number): { gained: number; levels: number } {
  const gained = Math.round(base * (1 + Math.max(0, c.int - 12) / 100));
  c.xp += gained;
  let levels = 0;
  while (c.xp >= xpForLevel(c.level + 1)) {
    c.level++;
    c.points++;
    levels++;
  }
  return { gained, levels };
}

/** Spend a level-up point on an ability. Returns false if there's no point to spend or it's maxed. */
export function raise(c: Character, ability: Ability): boolean {
  if (c.points <= 0) return false;
  if (ability === "hp") {
    if (c.maxHp >= ABILITY_MAX) return false;
    const before = c.maxHp;
    c.maxHp = Math.min(ABILITY_MAX, c.maxHp + RAISE_BY);
    c.hp += c.maxHp - before; // New hit points arrive healed.
  } else {
    if (c[ability] >= ABILITY_MAX) return false;
    c[ability] = Math.min(ABILITY_MAX, c[ability] + RAISE_BY);
  }
  c.points--;
  return true;
}
