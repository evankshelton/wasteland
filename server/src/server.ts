// Game server: accepts WebSocket connections, authenticates players, applies
// movement authoritatively and streams nearby chunks and players.
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { DIR_DELTA, PROTOCOL_VERSION, parseClientMsg, validName, type ClientMsg, type Dir, type EncounterResult, type ServerMsg } from "./protocol.ts";
import { BaseMap, type Npc } from "./base.ts";
import { Battle, membersLeft } from "./battle.ts";
import { ENEMIES, enemy } from "./enemies.ts";
import {
  DECK_MAX, DECK_MIN, MAX_LEVEL, addCard, card, deckSize, levelOffer, lootOffer, price, sellPrice, shopKind, shopStock,
  starterKit, terrainCards, updateKit, upgradeCost, view, type Kit,
} from "./cards.ts";
import { hash2 } from "./noise.ts";
import { campLayout } from "./camps.ts";
import { dungeonDepth, dungeonLayout } from "./dungeons.ts";
import { XP, gainXp, raise, rollCharacter, type Character } from "./character.ts";
import { DUNGEON_MONSTER_OPTIONS, Monsters, dungeonGround, type Monster, type MonsterOptions } from "./monsters.ts";
import type { Location, Storage } from "./storage.ts";
import { T, TILE_DEFS, isPassable } from "./tiles.ts";
import { rngFrom } from "./camps.ts";
import { chunkOf, type World } from "./world.ts";
import { BASE, CHUNK_SIZE } from "./worldgen.ts";

export interface ServerOptions {
  host: string;
  port: number;
  motd: string;
  /** Chunks streamed in every direction around a player (2 => 5x5 chunks). */
  viewChunks: number;
  /** Other players within this many tiles (Chebyshev distance) are visible. */
  viewTiles: number;
  /** Minimum milliseconds between accepted moves for one player. */
  moveIntervalMs: number;
  saveIntervalMs: number;
  /** Milliseconds between monster updates. */
  tickMs: number;
  monsters: MonsterOptions;
  /** Zombie packs within this many tiles of a contact join the battle. */
  encounterRadius: number;
  /** After an encounter, zombies leave the player alone for this long. */
  encounterGraceMs: number;
}

interface Encounter {
  id: number;
  /** The map the fight is on; x, y are in its coordinates. */
  loc: Location;
  x: number;
  y: number;
  enemies: Monster[];
  battle: Battle;
}

interface Session {
  ws: WebSocket;
  addr: string;
  player?: Player;
  sentChunks: Set<string>;
  seenPlayers: Set<number>;
  seenMonsters: Set<number>;
  lastMoveAt: number;
  dirty: boolean;
  /** Set while the player is fighting in first person; overworld moves are refused. */
  encounter?: Encounter;
  graceUntil: number;
}

interface Player {
  id: number;
  name: string;
  /** Overworld position: where the player is, or the base icon while inside. */
  x: number;
  y: number;
  loc: Location;
  /** Position on the site's map (the base, a camp or a dungeon) while loc isn't "overworld". */
  bx: number;
  by: number;
  char: Character;
}

/** Which map a player is on and where, in that map's coordinates. */
function whereIs(p: Player): { loc: Location; x: number; y: number } {
  return p.loc !== "overworld" ? { loc: p.loc, x: p.bx, y: p.by } : { loc: "overworld", x: p.x, y: p.y };
}

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

export class GameServer {
  private wss?: WebSocketServer;
  private sessions = new Set<Session>();
  private byPlayerId = new Map<number, Session>();
  private saveTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
  private nextEncounterId = 1;
  readonly monsters: Monsters;
  private world: World;
  private storage: Storage;
  private base: BaseMap;
  private camps = new Map<number, BaseMap>(); // camp maps built so far, by camp id
  private dungeons = new Map<string, BaseMap>(); // dungeon levels built so far, by location
  private dungeonMobs = new Map<string, Monsters>(); // each dungeon level's zombies, while anyone's been down there
  private opts: ServerOptions;

  constructor(world: World, storage: Storage, base: BaseMap, opts: ServerOptions) {
    this.world = world;
    this.storage = storage;
    this.base = base;
    this.opts = opts;
    this.monsters = new Monsters(world, opts.monsters);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: this.opts.host, port: this.opts.port, maxPayload: 16 * 1024 });
      this.wss = wss;
      wss.once("listening", () => {
        log(`[server] listening on ws://${this.opts.host}:${this.opts.port} (seed ${this.world.seed}, ${this.storage.chunkCount()} chunks stored)`);
        resolve();
      });
      wss.once("error", reject);
      wss.on("connection", (ws, req) => this.onConnection(ws, req.socket.remoteAddress ?? "?"));
      this.saveTimer = setInterval(() => this.flush(), this.opts.saveIntervalMs);
      this.tickTimer = setInterval(() => this.tick(), this.opts.tickMs);
    });
  }

  async stop(): Promise<void> {
    clearInterval(this.saveTimer);
    clearInterval(this.tickTimer);
    this.flush(true);
    // Detach sessions before closing sockets: their close events arrive after
    // storage may already be closed, and must not try to save again.
    const sessions = [...this.sessions];
    this.sessions.clear();
    this.byPlayerId.clear();
    for (const s of sessions) s.ws.close(1001, "server shutting down");
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
  }

  /** Write dirty player positions to storage. */
  private flush(all = false): void {
    const dirty = [...this.sessions].filter((s) => s.player && (all || s.dirty));
    if (dirty.length === 0) return;
    this.storage.savePlayers(dirty.map((s) => s.player!));
    for (const s of dirty) s.dirty = false;
  }

  private onConnection(ws: WebSocket, addr: string): void {
    const s: Session = {
      ws, addr, sentChunks: new Set(), seenPlayers: new Set(), seenMonsters: new Set(), lastMoveAt: 0, dirty: false, graceUntil: 0,
    };
    this.sessions.add(s);
    log(`[conn] ${addr} connected`);

    // Clients must say hello promptly.
    const helloTimeout = setTimeout(() => {
      if (!s.player) this.fail(s, "timeout", "No hello received.");
    }, 10_000);

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const msg = parseClientMsg(data.toString());
      if (!msg) return this.fail(s, "bad_message", "Malformed message.");
      try {
        this.onMessage(s, msg);
      } catch (err) {
        log(`[error] handling ${msg.t} from ${addr}:`, err);
        this.fail(s, "server_error", "Internal server error.");
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimeout);
      this.onClose(s);
    });
    ws.on("error", (err) => log(`[conn] ${addr} error: ${err.message}`));
  }

  private onMessage(s: Session, msg: ClientMsg): void {
    const creating = s.player !== undefined && !s.player.char.created;
    if (creating && msg.t !== "reroll" && msg.t !== "accept") return; // Still rolling: not in the world yet.
    switch (msg.t) {
      case "hello":
        return this.onHello(s, msg);
      case "move":
        return this.onMove(s, msg);
      case "map":
        return this.onMap(s);
      case "map_chunks":
        return this.onMapChunks(s, msg);
      case "battle_play":
      case "battle_end_turn":
      case "battle_pass":
      case "battle_flee":
        return this.onBattle(s, msg);
      case "offer_pick":
        return this.onOfferPick(s, msg.index);
      case "deck_set":
        return this.onDeckSet(s, msg.uid, msg.deck);
      case "shop_buy":
      case "shop_sell":
      case "shop_upgrade":
        return this.onShop(s, msg);
      case "enter":
        return this.onEnter(s);
      case "reroll":
        return this.onReroll(s);
      case "accept":
        return this.onAccept(s);
      case "raise":
        return this.onRaise(s, msg.ability);
      case "service":
        return this.onService(s, msg.npc);
    }
  }

  private onHello(s: Session, msg: Extract<ClientMsg, { t: "hello" }>): void {
    if (s.player) return;
    if (msg.v !== PROTOCOL_VERSION) {
      return this.fail(s, "version", `Server speaks protocol v${PROTOCOL_VERSION}, client sent v${msg.v}.`);
    }
    if (!validName(msg.name)) {
      return this.fail(s, "bad_name", "Names are 2-16 letters, digits, spaces, '-' or '_'.");
    }

    let rec = this.storage.findPlayer(msg.name);
    if (rec) {
      if (!msg.token || !tokensEqual(msg.token, rec.token)) {
        return this.fail(s, "name_taken", `"${rec.name}" belongs to someone else on this server.`);
      }
    } else {
      // New arrivals start inside the base, at its entrance.
      rec = this.storage.createPlayer(msg.name, randomBytes(24).toString("base64url"), {
        ...BASE.icon, loc: "base", bx: this.base.entry.x, by: this.base.entry.y,
      });
      log(`[player] created "${rec.name}" (#${rec.id})`);
    }

    // One live session per character: the newest connection wins and takes
    // over the live position (the stored one may be a few seconds stale).
    let pos: Omit<Player, "id" | "name" | "char"> = { x: rec.x, y: rec.y, loc: rec.loc, bx: rec.bx, by: rec.by };
    if (pos.loc !== "overworld") {
      const site = this.siteOf(pos.loc);
      if (!site) pos.loc = "overworld"; // That camp is gone: back outside.
      else if (!site.walkable(pos.bx, pos.by)) ({ x: pos.bx, y: pos.by } = site.entry); // Its layout changed under them.
    }
    const existing = this.byPlayerId.get(rec.id);
    if (existing?.player) {
      const { x, y, loc, bx, by } = existing.player;
      pos = { x, y, loc, bx, by };
      this.send(existing, { t: "error", code: "replaced", message: "Logged in from another client." });
      existing.ws.close(4000, "replaced");
      this.onClose(existing);
    }

    // First time (or first since characters existed): roll one to accept or reroll.
    let char = existing?.player?.char ?? rec.char;
    if (!char) {
      char = rollCharacter();
      this.storage.saveCharacter(rec.id, char);
    }
    if (char.created && !char.kit) {
      char.kit = starterKit(); // From before cards existed: everyone gets the starting deck.
      this.storage.saveCharacter(rec.id, char);
    } else if (char.kit && updateKit(char.kit)) {
      this.storage.saveCharacter(rec.id, char);
    }
    s.player = { id: rec.id, name: rec.name, ...pos, char };
    this.byPlayerId.set(rec.id, s);
    const { x, y } = s.player;
    const here = whereIs(s.player);
    log(`[player] "${rec.name}" joined from ${s.addr} in the ${here.loc} at (${here.x}, ${here.y})`);

    this.send(s, {
      t: "welcome",
      id: rec.id,
      name: rec.name,
      token: rec.token,
      x,
      y,
      chunkSize: CHUNK_SIZE,
      tiles: TILE_DEFS.map(({ id, key, name, passable, color }) => ({ id, key, name, passable, color })),
      monsters: [...ENEMIES.values()].map(({ kind, name, one, many, sprite }) => ({ kind, name, one, many, sprite })),
      motd: this.opts.motd,
      character: publicCharacter(char),
    });
    if (char.created) this.enterWorld(s);
  }

  /** Put a player with a finished character into the world they left. */
  private enterWorld(s: Session): void {
    this.sendCards(s);
    this.sendOffer(s);
    this.sendLocation(s);
    if (s.player!.loc === "overworld") this.streamChunks(s);
    this.updateVisibility(s);
    this.syncMonsters(s);
  }

  private onReroll(s: Session): void {
    const p = s.player;
    if (!p || p.char.created) return; // Rolls are final once accepted.
    p.char = rollCharacter();
    this.storage.saveCharacter(p.id, p.char);
    this.sendCharacter(s);
  }

  private onAccept(s: Session): void {
    const p = s.player;
    if (!p || p.char.created) return;
    p.char.created = true;
    p.char.kit = starterKit();
    this.storage.saveCharacter(p.id, p.char);
    const c = p.char;
    log(`[player] "${p.name}" accepted STR ${c.str} DEX ${c.dex} INT ${c.int} HP ${c.maxHp}`);
    this.sendCharacter(s);
    this.enterWorld(s);
  }

  private onRaise(s: Session, ability: Parameters<typeof raise>[1]): void {
    const p = s.player;
    if (!p || !raise(p.char, ability)) return;
    this.storage.saveCharacter(p.id, p.char);
    this.sendCharacter(s);
  }

  /** The NPC with this id in the player's site, if they're in reach (next to them, or across a counter). */
  private npcInReach(s: Session, npcId: number): Npc | undefined {
    const p = s.player;
    if (!p || p.loc === "overworld" || s.encounter) return undefined;
    const npc = this.siteOf(p.loc)?.npcs.find((n) => n.id === npcId);
    return npc && Math.abs(npc.x - p.bx) + Math.abs(npc.y - p.by) <= 2 ? npc : undefined;
  }

  /** Talking to an NPC: the ones with a working service do it, and shopkeepers open their shop. */
  private onService(s: Session, npcId: number): void {
    const p = s.player!;
    const npc = this.npcInReach(s, npcId);
    if (!npc) return;
    if (shopKind(npc.service)) this.sendShop(s, npc);
    if (npc.service === "healing") {
      if (p.char.hp >= p.char.maxHp) {
        this.send(s, { t: "notice", text: `${npc.name}: "You're in one piece. Go on."` });
        return;
      }
      p.char.hp = p.char.maxHp;
      this.storage.saveCharacter(p.id, p.char);
      this.sendCharacter(s);
      this.send(s, { t: "notice", text: `${npc.name} patches you up. Hit points restored to ${p.char.maxHp}.` });
    }
  }

  /** Award experience and announce it (and any level gained). */
  private award(s: Session, base: number, why: string): void {
    const p = s.player!;
    if (base <= 0) return;
    const { gained, levels } = gainXp(p.char, base);
    this.storage.saveCharacter(p.id, p.char);
    if (why) this.send(s, { t: "notice", text: `+${gained} XP (${why}).` });
    if (levels > 0) {
      log(`[player] "${p.name}" reached level ${p.char.level}`);
      this.send(s, { t: "notice", text: `You reached level ${p.char.level}! Choose an ability to raise, and a new ability card.` });
      for (let i = 0; i < levels; i++) this.kit(s).offers.push(levelOffer(Math.random));
      this.storage.saveCharacter(p.id, p.char);
      this.sendOffer(s);
    }
    this.sendCharacter(s);
  }

  private sendCharacter(s: Session): void {
    this.send(s, { t: "character", character: publicCharacter(s.player!.char) });
  }

  // ---- cards: the kit, offers, shops ----

  private kit(s: Session): Kit {
    const c = s.player!.char;
    return (c.kit ??= starterKit());
  }

  private saveKit(s: Session): void {
    this.storage.saveCharacter(s.player!.id, s.player!.char);
  }

  private sendCards(s: Session): void {
    const kit = this.kit(s);
    this.send(s, {
      t: "cards", scrap: kit.scrap, deckMin: DECK_MIN, deckMax: DECK_MAX,
      cards: kit.cards.map((c) => ({ ...view(c.card, c.level), uid: c.uid, deck: c.deck })),
    });
  }

  /** Show the first card choice waiting for the player, if any. */
  private sendOffer(s: Session): void {
    const offer = this.kit(s).offers[0];
    if (offer) this.send(s, { t: "offer", reason: offer.reason, cards: offer.cards.map((c) => view(c.card, c.level)) });
  }

  private onOfferPick(s: Session, index: number): void {
    const kit = this.kit(s);
    const offer = kit.offers.shift();
    if (!offer) return;
    const pick = offer.cards[index];
    if (pick) {
      const owned = addCard(kit, pick.card, pick.level);
      this.send(s, { t: "notice", text: `${view(pick.card, pick.level).name} added to your ${owned.deck ? "deck" : "pack"}.` });
    }
    this.saveKit(s);
    this.sendCards(s);
    this.sendOffer(s);
  }

  private onDeckSet(s: Session, uid: number, deck: boolean): void {
    const kit = this.kit(s);
    const c = kit.cards.find((k) => k.uid === uid);
    if (!c || c.deck === deck || s.encounter) return;
    const size = deckSize(kit);
    if (deck && size >= DECK_MAX) {
      this.send(s, { t: "notice", text: `Your deck is full (${DECK_MAX} cards).` });
    } else if (!deck && size <= DECK_MIN) {
      this.send(s, { t: "notice", text: `Your deck needs at least ${DECK_MIN} cards.` });
    } else {
      c.deck = deck;
      this.saveKit(s);
    }
    this.sendCards(s);
  }

  /** What this NPC has on the shelves: fixed for each shopkeeper. */
  private stockOf(s: Session, npc: Npc): { card: string; level: number }[] {
    let h = 7;
    for (const ch of `${s.player!.loc}:${npc.id}`) h = hash2(h, ch.charCodeAt(0), 31);
    return shopStock(npc.service, rngFrom(h));
  }

  private sendShop(s: Session, npc: Npc): void {
    const shop = shopKind(npc.service)!;
    const kit = this.kit(s);
    this.send(s, {
      t: "shop", npc: npc.id, name: npc.name, title: shop.title, buyLabel: shop.buyLabel, upgradeLabel: shop.upgradeLabel,
      stock: this.stockOf(s, npc).map((c) => ({ ...view(c.card, c.level), price: price(c.card, c.level) })),
      sell: kit.cards.map((c) => ({ uid: c.uid, price: sellPrice(c.card, c.level, shop.trader) })),
      upgrade: kit.cards
        .filter((c) => c.level < MAX_LEVEL && shop.upgrades(card(c.card)))
        .map((c) => ({ uid: c.uid, price: upgradeCost(c.card, c.level), next: view(c.card, c.level + 1) })),
    });
  }

  private onShop(s: Session, msg: Extract<ClientMsg, { t: "shop_buy" | "shop_sell" | "shop_upgrade" }>): void {
    const npc = this.npcInReach(s, msg.npc);
    const shop = npc && shopKind(npc.service);
    if (!npc || !shop) return;
    const kit = this.kit(s);
    const say = (text: string) => this.send(s, { t: "notice", text });
    if (msg.t === "shop_buy") {
      const item = this.stockOf(s, npc)[msg.index];
      if (!item) return;
      const cost = price(item.card, item.level);
      if (kit.scrap < cost) {
        say(`${npc.name}: "That's ${cost} scrap. Come back when you've got it."`);
      } else {
        kit.scrap -= cost;
        const owned = addCard(kit, item.card, item.level);
        say(`You ${shop.buyLabel === "Learn" ? "learn" : "buy"} ${view(item.card, item.level).name} for ${cost} scrap (into your ${owned.deck ? "deck" : "pack"}).`);
      }
    } else {
      const i = kit.cards.findIndex((c) => c.uid === msg.uid);
      const c = kit.cards[i];
      if (!c) return;
      if (msg.t === "shop_sell") {
        if (c.deck && deckSize(kit) <= DECK_MIN) {
          say(`Your deck needs at least ${DECK_MIN} cards: take one out of it some other way first.`);
        } else {
          const got = sellPrice(c.card, c.level, shop.trader);
          kit.cards.splice(i, 1);
          kit.scrap += got;
          say(`You sell ${view(c.card, c.level).name} for ${got} scrap.`);
        }
      } else {
        if (c.level >= MAX_LEVEL || !shop.upgrades(card(c.card))) return;
        const cost = upgradeCost(c.card, c.level);
        if (kit.scrap < cost) {
          say(`${npc.name}: "${cost} scrap for that. You're short."`);
        } else {
          kit.scrap -= cost;
          c.level++;
          say(`${npc.name} works on it: ${view(c.card, c.level).name} (${cost} scrap).`);
        }
      }
    }
    this.saveKit(s);
    this.sendCards(s);
    this.sendShop(s, npc);
  }

  /** The map for a site location: the base, or a camp (built from its seed the first time). */
  private siteOf(loc: Location): BaseMap | undefined {
    if (loc === "base") return this.base;
    const down = dungeonLevel(loc);
    if (down) {
      let site = this.dungeons.get(loc);
      if (!site) {
        const d = this.storage.dungeonById(down.id);
        const depth = d ? dungeonDepth(d.seed) : 0;
        if (!d || down.level < 1 || down.level > depth) return undefined;
        const name = `${d.name}, Level ${down.level} of ${depth}`;
        site = new BaseMap(dungeonLayout(d.seed, name, down.level, depth), { x: d.x, y: d.y });
        this.dungeons.set(loc, site);
      }
      return site;
    }
    if (!loc.startsWith("camp:")) return undefined;
    const id = Number(loc.slice(5));
    let site = this.camps.get(id);
    if (!site) {
      const camp = this.storage.campById(id);
      if (!camp) return undefined;
      site = new BaseMap(campLayout(camp.seed, camp.name), { x: camp.x, y: camp.y });
      this.camps.set(id, site);
    }
    return site;
  }

  /** Tell the client which map it's on (the whole map, for the base or a camp). */
  private sendLocation(s: Session): void {
    const p = s.player!;
    const b = p.loc === "overworld" ? undefined : this.siteOf(p.loc);
    if (!b) {
      this.send(s, { t: "location", kind: "overworld", x: p.x, y: p.y });
      return;
    }
    this.send(s, {
      t: "location",
      kind: p.loc === "base" ? "base" : dungeonLevel(p.loc) ? "dungeon" : "camp",
      site: p.loc,
      name: b.name,
      icon: b.icon,
      width: b.width,
      height: b.height,
      tiles: Buffer.from(b.tiles).toString("base64"),
      x: p.bx,
      y: p.by,
      npcs: b.npcs,
      rooms: b.rooms,
    });
  }

  /** Step through the base's (or an encampment's, or a dungeon's) icon into it. */
  private onEnter(s: Session): void {
    const p = s.player;
    if (!p) return this.fail(s, "not_joined", "Say hello first.");
    if (p.loc !== "overworld" || s.encounter) return;
    const tile = this.world.tileAt(p.x, p.y);
    const camp = tile === T.CAMP_ICON ? this.storage.campAt(p.x, p.y) : undefined;
    const dungeon = tile === T.DUNGEON_ICON ? this.storage.dungeonAt(p.x, p.y) : undefined;
    const loc: Location | undefined =
      tile === T.BASE_ICON ? "base" : camp ? `camp:${camp.id}` : dungeon ? `dungeon:${dungeon.id}:1` : undefined;
    const site = loc && this.siteOf(loc);
    if (!loc || !site) {
      this.send(s, { t: "notice", text: "There's nothing here to enter." });
      return;
    }
    if (camp) this.storage.visitCamp(p.id, camp.id);
    this.changeLocation(s, loc, site.entry);
  }

  /** Move a player between the overworld and a site, and re-sync everything they can see. */
  private changeLocation(s: Session, loc: Location, at: { x: number; y: number }): void {
    const p = s.player!;
    p.loc = loc;
    if (loc !== "overworld") {
      p.bx = at.x;
      p.by = at.y;
    } else {
      p.x = at.x;
      p.y = at.y;
    }
    s.dirty = true;
    log(`[player] "${p.name}" is now in the ${loc} at (${at.x}, ${at.y})`);
    this.sendLocation(s);
    if (loc === "overworld") this.streamChunks(s);
    this.updateVisibility(s);
    this.syncMonsters(s);
  }

  /**
   * Walking off a site map's edge: come out on the overworld tile on that
   * side of its icon (or on the icon itself if that tile is blocked).
   */
  private exitTile(site: BaseMap, dx: number, dy: number): { x: number; y: number } {
    const out = { x: site.icon.x + dx, y: site.icon.y + dy };
    const clear = isPassable(this.world.tileAt(out.x, out.y)) && !this.monsters.at(out.x, out.y);
    return clear ? out : { ...site.icon };
  }

  private onMove(s: Session, msg: Extract<ClientMsg, { t: "move" }>): void {
    const p = s.player;
    if (!p) return this.fail(s, "not_joined", "Say hello first.");

    const now = Date.now();
    if (p.loc !== "overworld") return this.onMoveInSite(s, p, msg, now);
    let ok = false;
    let contact = false;
    if (!s.encounter && now - s.lastMoveAt >= this.opts.moveIntervalMs) {
      const [dx, dy] = DIR_DELTA[msg.dir];
      const nx = p.x + dx;
      const ny = p.y + dy;
      const zombie = this.monsters.at(nx, ny);
      // Walking into a zombie starts a fight, unless we only just got away from one.
      if (isPassable(this.world.tileAt(nx, ny)) && (!zombie || now >= s.graceUntil)) {
        p.x = nx;
        p.y = ny;
        s.lastMoveAt = now;
        s.dirty = true;
        ok = true;
        contact = zombie !== undefined;
      }
    }
    this.send(s, { t: "you", x: p.x, y: p.y, seq: msg.seq, ok });
    if (ok) {
      this.streamChunks(s);
      this.updateVisibility(s);
    }
    if (contact) this.startEncounter(s);
    else if (ok) this.syncMonsters(s);
  }

  private onMoveInSite(s: Session, p: Player, msg: Extract<ClientMsg, { t: "move" }>, now: number): void {
    const site = this.siteOf(p.loc)!;
    if (now - s.lastMoveAt < this.opts.moveIntervalMs) {
      this.send(s, { t: "you", x: p.bx, y: p.by, seq: msg.seq, ok: false });
      return;
    }
    const [dx, dy] = DIR_DELTA[msg.dir];
    const nx = p.bx + dx;
    const ny = p.by + dy;
    if (!site.inBounds(nx, ny)) {
      // Answer the step first, then switch maps: "you" carries the overworld
      // position the following "location" message confirms.
      s.lastMoveAt = now;
      const out = this.exitTile(site, dx, dy);
      this.send(s, { t: "you", x: out.x, y: out.y, seq: msg.seq, ok: true });
      this.changeLocation(s, "overworld", out);
      return;
    }
    if (s.encounter) {
      this.send(s, { t: "you", x: p.bx, y: p.by, seq: msg.seq, ok: false });
      return;
    }
    const down = dungeonLevel(p.loc);
    if (down && (site.isDown(nx, ny) || site.isUp(nx, ny))) {
      // Down the stairs to the foot of the stairs up on the next level, or up
      // them to beside the stairs down on the level above.
      const goingUp = site.isUp(nx, ny);
      const next: Location = `dungeon:${down.id}:${down.level + (goingUp ? -1 : 1)}`;
      const there = this.siteOf(next);
      if (there) {
        const at = goingUp ? there.beside(there.down[0] ?? there.entry) : there.entry;
        s.lastMoveAt = now;
        this.send(s, { t: "you", x: at.x, y: at.y, seq: msg.seq, ok: true });
        this.changeLocation(s, next, at);
        return;
      }
    }
    if (site.isExit(nx, ny)) {
      // Up the ladder, or the stairs out of the bottom level: out beside the entrance.
      s.lastMoveAt = now;
      const out = this.exitTile(site, 0, 1);
      this.send(s, { t: "you", x: out.x, y: out.y, seq: msg.seq, ok: true });
      this.changeLocation(s, "overworld", out);
      return;
    }
    const mobs = this.mobsFor(p.loc);
    const zombie = mobs?.at(nx, ny);
    // Walking into a zombie starts a fight, unless we only just got away from one.
    const ok = site.walkable(nx, ny) && (!zombie || now >= s.graceUntil);
    if (ok) {
      p.bx = nx;
      p.by = ny;
      s.lastMoveAt = now;
      s.dirty = true;
    }
    this.send(s, { t: "you", x: p.bx, y: p.by, seq: msg.seq, ok });
    if (ok) this.updateVisibility(s);
    if (ok && zombie) this.startEncounter(s);
    else if (ok && mobs) this.syncMonsters(s);
  }

  /** The zombies roaming a map: the overworld's, or a dungeon level's (made on first need). Sites have none. */
  private mobsFor(loc: Location): Monsters | undefined {
    if (loc === "overworld") return this.monsters;
    const down = dungeonLevel(loc);
    if (!down) return undefined;
    let mobs = this.dungeonMobs.get(loc);
    const site = this.siteOf(loc);
    if (!mobs && site) {
      // The deeper you go, the bigger the packs.
      const opts = { ...this.opts.monsters, ...DUNGEON_MONSTER_OPTIONS, maxPack: Math.min(12, 3 + down.level) };
      if (this.opts.monsters.spawnChance === 0) opts.spawnChance = 0; // Spawning switched off (as in tests) is off down here too.
      mobs = new Monsters(dungeonGround(site), opts);
      this.dungeonMobs.set(loc, mobs);
    }
    return mobs;
  }

  /** Can a player stand at (x, y) on this map? */
  private standable(loc: Location, x: number, y: number): boolean {
    if (loc === "overworld") return isPassable(this.world.tileAt(x, y));
    const site = this.siteOf(loc);
    return site !== undefined && site.walkable(x, y) && !site.isExit(x, y);
  }

  /** Pull every zombie pack near the player into a card battle. */
  private startEncounter(s: Session): void {
    const p = s.player!;
    const here = whereIs(p);
    const enemies = this.mobsFor(here.loc)?.take(here, this.opts.encounterRadius) ?? [];
    const kit = this.kit(s);
    const battle = new Battle({
      seed: randomInt(1, 2 ** 31 - 1),
      character: p.char,
      deck: kit.cards.filter((c) => c.deck).map(({ uid, card, level }) => ({ uid, card, level })),
      terrain: terrainCards(this.groundAround(here.loc, here.x, here.y, 3)),
      packs: enemies.map((m) => ({ id: m.id, kind: m.kind, count: m.count })),
    });
    const enc: Encounter = { id: this.nextEncounterId++, loc: here.loc, x: here.x, y: here.y, enemies, battle };
    s.encounter = enc;
    const removed = enemies.map((m) => m.id);
    for (const other of this.sessions) if (other.player) this.syncMonsters(other, undefined, removed);
    const groups = enemies.map((m) => `${m.count} ${m.count === 1 ? enemy(m.kind).one : enemy(m.kind).many}`).join(", ");
    log(`[encounter] "${p.name}" vs ${groups || "nothing"} in the ${here.loc} at (${here.x}, ${here.y})`);
    this.send(s, { t: "encounter_start", id: enc.id, x: enc.x, y: enc.y, battle: battle.view() });
  }

  /** The terrain keys of the tiles within r of (x, y) on a map: what the ground can give you in a fight. */
  private groundAround(loc: Location, x: number, y: number, r: number): string[] {
    const site = loc === "overworld" ? undefined : this.siteOf(loc);
    const keys: string[] = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (site && !site.inBounds(x + dx, y + dy)) continue;
        const id = site ? site.tiles[(y + dy) * site.width + x + dx]! : this.world.tileAt(x + dx, y + dy);
        const def = TILE_DEFS.find((t) => t.id === id);
        if (def) keys.push(def.key);
      }
    }
    return keys;
  }

  /** A card played, a turn ended, a pass on answering the zombies, or a run for it. */
  private onBattle(s: Session, msg: Extract<ClientMsg, { t: "battle_play" | "battle_end_turn" | "battle_pass" | "battle_flee" }>): void {
    const enc = s.encounter;
    if (!enc || msg.id !== enc.id) return; // Stale or duplicate: nothing to do.
    const b = enc.battle;
    const why =
      msg.t === "battle_play" ? b.play(msg.uid, msg.target)
      : msg.t === "battle_end_turn" ? b.endTurn(msg.target)
      : msg.t === "battle_pass" ? b.pass()
      : b.flee();
    if (why) this.send(s, { t: "notice", text: why });
    this.send(s, { t: "battle", id: enc.id, battle: b.view() });
    if (b.over) this.finishEncounter(s, b.over);
  }

  /** The battle is decided: settle kills, scrap, loot, XP and where the player ends up. */
  private finishEncounter(s: Session, result: EncounterResult): void {
    const p = s.player!;
    const enc = s.encounter!;
    const b = enc.battle;
    // Every enemy that fell counts, from groups wiped out and groups that survived smaller: by
    // what it's worth (a raider three zombies, a rat a quarter of one). Bred rats count too.
    let kills = 0;
    let worth = 0;
    const survivors: Monster[] = [];
    for (const m of enc.enemies) {
      const foe = b.foes.find((f) => f.id === m.id)!;
      const standing = membersLeft(foe);
      const fell = Math.max(0, Math.ceil(foe.maxHp / foe.type.hp) - standing);
      kills += fell;
      worth += fell * foe.type.value;
      if (standing > 0) {
        m.count = standing;
        survivors.push(m);
      }
    }

    if (result === "fled") {
      // Come out of the fight a few tiles away, running from where the packs were.
      let ax = 0;
      let ay = 0;
      for (const m of survivors) [ax, ay] = [ax + m.x - enc.x, ay + m.y - enc.y];
      const away: Dir = Math.abs(ax) >= Math.abs(ay) ? (ax > 0 ? "left" : "right") : ay > 0 ? "up" : "down";
      const mobs = this.mobsFor(enc.loc);
      // Away from them if the way is open, otherwise whichever way is (ruins and walls block some).
      const ways: Dir[] = [away, ...(["up", "down", "left", "right"] as Dir[]).filter((d) => d !== away)];
      fled: for (const way of ways) {
        const [dx, dy] = DIR_DELTA[way];
        for (let d = 3; d >= 1; d--) {
          const nx = enc.x + dx * d;
          const ny = enc.y + dy * d;
          // Only as far as the way is clear (a dungeon wall stops you short).
          let clear = true;
          for (let i = 1; i <= d; i++) clear &&= this.standable(enc.loc, enc.x + dx * i, enc.y + dy * i);
          if (clear && !survivors.some((m) => m.x === nx && m.y === ny) && !mobs?.at(nx, ny)) {
            if (enc.loc === "overworld") [p.x, p.y] = [nx, ny];
            else [p.bx, p.by] = [nx, ny];
            break fled;
          }
        }
      }
    }

    this.endEncounter(s, survivors);
    s.dirty = true;
    const after = whereIs(p);
    log(`[encounter] "${p.name}" ${result} (${kills} killed) -> (${after.x}, ${after.y})`);
    // Wounds carry over; dying means waking up healed in the infirmary.
    const c = p.char;
    c.hp = result === "died" ? c.maxHp : Math.max(1, b.hp);
    // Scrap from the fallen, and something worth taking after a win.
    const kit = this.kit(s);
    let scrap = 0;
    for (let i = 0; i < Math.round(worth); i++) scrap += 1 + Math.floor(Math.random() * 3);
    if (result === "victory") {
      scrap += 5;
      kit.offers.push(lootOffer(Math.random));
    }
    kit.scrap += scrap;
    this.storage.saveCharacter(p.id, c);
    this.send(s, { t: "encounter_over", id: enc.id, result, x: after.x, y: after.y });
    if (scrap > 0) this.send(s, { t: "notice", text: `+${scrap} scrap.` });
    this.sendCards(s);
    const xp = Math.round(worth * XP.kill) + (result === "victory" ? XP.victory : 0);
    if (xp > 0) this.award(s, xp, `${kills} ${kills === 1 ? "enemy" : "enemies"} put down${result === "victory" ? ", area cleared" : ""}`);
    else this.sendCharacter(s);
    this.sendOffer(s);
    if (result === "died") {
      // Carried back to the base and patched up in the infirmary.
      this.changeLocation(s, "base", this.base.respawn);
      return;
    }
    if (p.loc === "overworld") this.streamChunks(s);
    this.updateVisibility(s);
    this.syncMonsters(s);
  }

  /** Close the encounter and put surviving zombies back where they stood. */
  private endEncounter(s: Session, survivors: Monster[]): void {
    const enc = s.encounter!;
    s.encounter = undefined;
    const now = Date.now();
    s.graceUntil = now + this.opts.encounterGraceMs;
    const players = [...this.sessions].filter((o) => o.player && o.player.loc === enc.loc).map((o) => whereIs(o.player!));
    if (s.player && !this.sessions.has(s)) players.push(whereIs(s.player));
    const mobs = this.mobsFor(enc.loc);
    const back = new Set<number>();
    for (const m of survivors) {
      if (mobs?.restore(m, now, players)) back.add(m.id);
    }
    for (const other of this.sessions) if (other.player && other !== s) this.syncMonsters(other, back);
  }

  /** The world map starts with the list of every generated chunk... */
  private onMap(s: Session): void {
    if (!s.player) return this.fail(s, "not_joined", "Say hello first.");
    // Only the camps this player has been inside are charted.
    const camps = this.storage.visitedCamps(s.player!.id).map(({ id, name, x, y }) => ({ id, name, x, y }));
    this.send(s, { t: "map_index", chunks: this.storage.chunkCoords(), camps });
  }

  /** ...then fetches the ones it lacks in batches. Never generates new land. */
  private onMapChunks(s: Session, msg: Extract<ClientMsg, { t: "map_chunks" }>): void {
    if (!s.player) return this.fail(s, "not_joined", "Say hello first.");
    for (const [cx, cy] of msg.coords) {
      const tiles = this.world.existingChunk(cx, cy);
      if (tiles) this.send(s, { t: "map_chunk", cx, cy, tiles: Buffer.from(tiles).toString("base64") });
    }
    this.send(s, { t: "map_batch_done" });
  }

  private onClose(s: Session): void {
    if (!this.sessions.delete(s)) return;
    if (s.encounter) this.endEncounter(s, s.encounter.enemies);
    const p = s.player;
    if (p) {
      this.storage.savePlayers([p]);
      this.storage.saveCharacter(p.id, p.char);
      if (this.byPlayerId.get(p.id) === s) this.byPlayerId.delete(p.id);
      for (const other of this.sessions) {
        if (other.seenPlayers.delete(p.id)) this.send(other, { t: "player_left", id: p.id });
      }
      const here = whereIs(p);
      log(`[player] "${p.name}" left from the ${here.loc} at (${here.x}, ${here.y})`);
    } else {
      log(`[conn] ${s.addr} disconnected`);
    }
  }

  /** Send every chunk within view that this client has not received yet. */
  private streamChunks(s: Session): void {
    const p = s.player!;
    const pcx = chunkOf(p.x);
    const pcy = chunkOf(p.y);
    const r = this.opts.viewChunks;
    // Nearest chunks first so the screen fills in from the player outwards.
    const wanted: [number, number][] = [];
    for (let cy = pcy - r; cy <= pcy + r; cy++) {
      for (let cx = pcx - r; cx <= pcx + r; cx++) {
        if (!s.sentChunks.has(`${cx},${cy}`)) wanted.push([cx, cy]);
      }
    }
    wanted.sort((a, b) => Math.hypot(a[0] - pcx, a[1] - pcy) - Math.hypot(b[0] - pcx, b[1] - pcy));
    for (const [cx, cy] of wanted) {
      const tiles = this.world.chunk(cx, cy);
      s.sentChunks.add(`${cx},${cy}`);
      this.send(s, { t: "chunk", cx, cy, tiles: Buffer.from(tiles).toString("base64") });
      for (const camp of this.storage.campsIn(cx * CHUNK_SIZE, cy * CHUNK_SIZE, (cx + 1) * CHUNK_SIZE, (cy + 1) * CHUNK_SIZE)) {
        this.send(s, { t: "camp", id: camp.id, name: camp.name, x: camp.x, y: camp.y });
      }
    }
  }

  /** After `s` moved, joined or changed map, update who can see whom (same map, within view). */
  private updateVisibility(s: Session): void {
    const p = whereIs(s.player!);
    const { id, name } = s.player!;
    if (!s.player!.char.created) return; // Not in the world yet.
    for (const other of this.sessions) {
      if (other === s || !other.player?.char.created) continue;
      const q = { ...whereIs(other.player), id: other.player.id, name: other.player.name };
      const near = p.loc === q.loc && Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)) <= this.opts.viewTiles;
      if (near) {
        this.send(other, { t: "player", id, name, x: p.x, y: p.y });
        other.seenPlayers.add(id);
        if (!s.seenPlayers.has(q.id)) {
          this.send(s, { t: "player", id: q.id, name: q.name, x: q.x, y: q.y });
          s.seenPlayers.add(q.id);
        }
      } else {
        if (other.seenPlayers.delete(id)) this.send(other, { t: "player_left", id });
        if (s.seenPlayers.delete(q.id)) this.send(s, { t: "player_left", id: q.id });
      }
    }
  }

  /** Advance the monsters and tell each player about changes within view. */
  private tick(): void {
    const now = Date.now();
    // Zombies roam the overworld and the dungeons; the base and the camps are safe.
    const maps: [Location, Monsters][] = [["overworld", this.monsters]];
    const occupied = new Set<Location>();
    for (const s of this.sessions) if (s.player && dungeonLevel(s.player.loc)) occupied.add(s.player.loc);
    for (const loc of occupied) {
      const mobs = this.mobsFor(loc);
      if (mobs) maps.push([loc, mobs]);
    }
    for (const [loc, mobs] of this.dungeonMobs) {
      if (!occupied.has(loc as Location)) {
        if (mobs.all.size === 0) this.dungeonMobs.delete(loc); // Nobody down there and nothing left: forget it.
        else maps.push([loc as Location, mobs]);
      }
    }
    for (const [loc, mobs] of maps) {
      const sessions = [...this.sessions].filter((s) => s.player?.loc === loc && s.player.char.created);
      const { changed, removed, contacts } = mobs.tick(
        now,
        sessions.map((s) => ({ ...whereIs(s.player!), id: s.player!.id, targetable: !s.encounter && now >= s.graceUntil })),
      );
      if (changed.size > 0 || removed.length > 0) {
        for (const s of sessions) this.syncMonsters(s, changed, removed);
      }
      for (const c of contacts) {
        const s = this.byPlayerId.get(c.playerId);
        if (s && !s.encounter) this.startEncounter(s);
      }
    }
  }

  /**
   * Send monsters in view that this client hasn't seen or that changed, and
   * forget ones that left view or were removed.
   */
  private syncMonsters(s: Session, changed?: Set<number>, removed: number[] = []): void {
    const p = whereIs(s.player!);
    const mobs = this.mobsFor(p.loc);
    for (const id of removed) {
      if (s.seenMonsters.delete(id)) this.send(s, { t: "monster_left", id });
    }
    for (const id of s.seenMonsters) {
      // Zombies on a map the player has left.
      if (!mobs?.all.has(id)) {
        s.seenMonsters.delete(id);
        this.send(s, { t: "monster_left", id });
      }
    }
    for (const m of mobs?.all.values() ?? []) {
      const near = Math.max(Math.abs(m.x - p.x), Math.abs(m.y - p.y)) <= this.opts.viewTiles;
      if (near) {
        if (!s.seenMonsters.has(m.id) || changed?.has(m.id)) {
          this.send(s, { t: "monster", id: m.id, kind: m.kind, count: m.count, x: m.x, y: m.y });
          s.seenMonsters.add(m.id);
        }
      } else if (s.seenMonsters.delete(m.id)) {
        this.send(s, { t: "monster_left", id: m.id });
      }
    }
  }

  private send(s: Session, msg: ServerMsg): void {
    if (s.ws.readyState === s.ws.OPEN) s.ws.send(JSON.stringify(msg));
  }

  private fail(s: Session, code: string, message: string): void {
    log(`[conn] ${s.addr} rejected: ${code} - ${message}`);
    this.send(s, { t: "error", code, message });
    s.ws.close(4001, code);
  }
}

/** A character as its player sees it: everything but the kit (sent as "cards"). */
function publicCharacter(c: Character): Omit<Character, "kit"> {
  const { kit: _kit, ...rest } = c;
  return rest;
}

/** The dungeon and level of a dungeon location ("dungeon:<id>:<level>"; older saves have no level: the first). */
function dungeonLevel(loc: string): { id: number; level: number } | undefined {
  const m = /^dungeon:(\d+)(?::(\d+))?$/.exec(loc);
  return m ? { id: Number(m[1]), level: m[2] ? Number(m[2]) : 1 } : undefined;
}

function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
