// Wire protocol: one JSON object per WebSocket text message, discriminated by `t`.
// Keep in sync with client/scripts/net.gd and docs/PROTOCOL.md.

import type { BattleView } from "./battle.ts";
import type { CardView } from "./cards.ts";
import { ABILITIES, type Ability, type Character } from "./character.ts";

export const PROTOCOL_VERSION = 13;

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
  | { t: "map_chunks"; coords: [number, number][] }
  | { t: "battle_play"; id: number; uid: number; target?: number } // play a card (target: an enemy's id)
  | { t: "battle_end_turn"; id: number; target?: number } // end your turn (target: the pack your allies attack)
  | { t: "battle_pass"; id: number } // let the zombie move or reaction on top of the stack happen without answering
  | { t: "battle_flee"; id: number }
  | { t: "offer_pick"; index: number } // take card `index` of the offer shown, or -1 for none
  | { t: "deck_set"; uid: number; deck: boolean } // move a card into the deck or out to the pack
  | { t: "shop_buy"; npc: number; index: number }
  | { t: "shop_sell"; npc: number; uid: number }
  | { t: "shop_upgrade"; npc: number; uid: number }
  | { t: "enter" } // go into the base while standing on its icon
  | { t: "reroll" } // roll new abilities (only before accepting a character)
  | { t: "accept" } // keep the current roll and start playing
  | { t: "raise"; ability: Ability } // spend a level-up point
  | { t: "service"; npc: number }; // ask an NPC in the base for their service (talking to them does this)

export type EncounterResult = "victory" | "fled" | "died";

/** A player's character as sent to them (their kit goes in "cards"). */
export type PublicCharacter = Omit<Character, "kit">;

// ---- server -> client ----
export type ServerMsg =
  | { t: "character"; character: PublicCharacter }
  // Everything the player owns: scrap and every card, each in the deck or the pack.
  | { t: "cards"; scrap: number; deckMin: number; deckMax: number; cards: CardView[] }
  // A choice of cards (after levelling up, or loot after a fight): take one with offer_pick.
  | { t: "offer"; reason: "level" | "loot"; cards: CardView[] }
  // An NPC's shop: what they sell, what they'd pay for each of your cards, and what they'd charge to upgrade them.
  | {
      t: "shop";
      npc: number;
      name: string;
      title: string;
      buyLabel: string;
      upgradeLabel: string;
      stock: (CardView & { price: number })[];
      sell: { uid: number; price: number }[];
      upgrade: { uid: number; price: number; next: CardView }[];
    }
  // The state of the player's card battle, after every move.
  | { t: "battle"; id: number; battle: BattleView }
  | {
      t: "welcome";
      id: number;
      name: string;
      token: string;
      x: number;
      y: number;
      chunkSize: number;
      tiles: { id: number; key: string; name: string; passable: boolean; color: string }[];
      /** Every kind of monster: what it's called and its column in the client's sprites.png. */
      monsters: { kind: string; name: string; one: string; many: string; sprite: number }[];
      motd: string;
      /** If not yet created, the client shows the rolling screen; nothing else is sent until "accept". */
      character: PublicCharacter;
    }
  | { t: "chunk"; cx: number; cy: number; tiles: string } // base64, row-major bytes
  | { t: "you"; x: number; y: number; seq: number; ok: boolean }
  | { t: "player"; id: number; name: string; x: number; y: number }
  | { t: "player_left"; id: number }
  | { t: "map_index"; chunks: [number, number][]; camps: { id: number; name: string; x: number; y: number }[] } // every chunk generated so far, and the camps this player has been inside
  | { t: "camp"; id: number; name: string; x: number; y: number } // an encampment in a chunk just sent
  | { t: "map_chunk"; cx: number; cy: number; tiles: string } // like chunk, but for the world map only
  | { t: "map_batch_done" }
  | { t: "monster"; id: number; kind: string; count: number; x: number; y: number } // appeared in view or moved
  | { t: "monster_left"; id: number }
  // A zombie reached the player: a card battle against every pack within the encounter radius.
  | { t: "encounter_start"; id: number; x: number; y: number; battle: BattleView }
  | { t: "encounter_over"; id: number; result: EncounterResult; x: number; y: number }
  // Which map the player is on. Sent after welcome and whenever it changes;
  // x/y (and later "you" and "player" messages) are in that map's coordinates.
  | { t: "location"; kind: "overworld"; x: number; y: number }
  | {
      t: "location";
      kind: "base" | "camp" | "dungeon";
      /** Which site: "base", "camp:<id>" or "dungeon:<id>:<level>". */
      site: string;
      name: string;
      /** The site's icon on the overworld. */
      icon: { x: number; y: number };
      width: number;
      height: number;
      tiles: string; // base64, row-major tile ids
      x: number;
      y: number;
      npcs: { id: number; name: string; role: string; service: string; x: number; y: number; lines: string[] }[];
      rooms: { name: string; x: number; y: number; w: number; h: number }[];
    }
  | { t: "notice"; text: string }
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
    case "enter":
      return { t: "enter" };
    case "map_chunks": {
      if (!Array.isArray(o.coords) || o.coords.length > MAP_BATCH_MAX) return undefined;
      const coords: [number, number][] = [];
      for (const c of o.coords) {
        if (!Array.isArray(c) || c.length !== 2 || !Number.isSafeInteger(c[0]) || !Number.isSafeInteger(c[1])) return undefined;
        coords.push([c[0], c[1]]);
      }
      return { t: "map_chunks", coords };
    }
    case "battle_play":
      if (!Number.isSafeInteger(o.id) || !Number.isSafeInteger(o.uid)) return undefined;
      if (o.target !== undefined && !Number.isSafeInteger(o.target)) return undefined;
      return { t: "battle_play", id: o.id as number, uid: o.uid as number, target: o.target as number | undefined };
    case "battle_end_turn":
      if (!Number.isSafeInteger(o.id)) return undefined;
      if (o.target !== undefined && !Number.isSafeInteger(o.target)) return undefined;
      return { t: "battle_end_turn", id: o.id as number, target: o.target as number | undefined };
    case "battle_pass":
    case "battle_flee":
      if (!Number.isSafeInteger(o.id)) return undefined;
      return { t: o.t, id: o.id as number };
    case "offer_pick":
      if (!Number.isSafeInteger(o.index)) return undefined;
      return { t: "offer_pick", index: o.index as number };
    case "deck_set":
      if (!Number.isSafeInteger(o.uid) || typeof o.deck !== "boolean") return undefined;
      return { t: "deck_set", uid: o.uid as number, deck: o.deck };
    case "shop_buy":
      if (!Number.isSafeInteger(o.npc) || !Number.isSafeInteger(o.index)) return undefined;
      return { t: "shop_buy", npc: o.npc as number, index: o.index as number };
    case "shop_sell":
    case "shop_upgrade":
      if (!Number.isSafeInteger(o.npc) || !Number.isSafeInteger(o.uid)) return undefined;
      return { t: o.t, npc: o.npc as number, uid: o.uid as number };
    case "reroll":
    case "accept":
      return { t: o.t };
    case "raise":
      if (typeof o.ability !== "string" || !ABILITIES.includes(o.ability as Ability)) return undefined;
      return { t: "raise", ability: o.ability as Ability };
    case "service":
      if (typeof o.npc !== "number") return undefined;
      return { t: "service", npc: o.npc };
    default:
      return undefined;
  }
}

export function validName(name: string): boolean {
  return NAME_RE.test(name);
}
