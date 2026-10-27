// Game server: accepts WebSocket connections, authenticates players, applies
// movement authoritatively and streams nearby chunks and players.
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { DIR_DELTA, PROTOCOL_VERSION, parseClientMsg, validName, type ClientMsg, type ServerMsg } from "./protocol.ts";
import { BaseMap } from "./base.ts";
import { campLayout } from "./camps.ts";
import { XP, gainXp, raise, rollCharacter, type Character } from "./character.ts";
import { Monsters, inSafeZone, type Monster, type MonsterOptions } from "./monsters.ts";
import type { Location, Storage } from "./storage.ts";
import { T, TILE_DEFS, isPassable } from "./tiles.ts";
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
  /** Enemies within this many tiles of a contact join the encounter; the 3D arena spans it. */
  encounterRadius: number;
  /** After an encounter, zombies leave the player alone for this long. */
  encounterGraceMs: number;
}

interface Encounter {
  id: number;
  x: number;
  y: number;
  enemies: Monster[];
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
  /** Position on the site's map (the base or a camp) while loc isn't "overworld". */
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
      case "encounter_end":
        return this.onEncounterEnd(s, msg);
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
      motd: this.opts.motd,
      character: char,
    });
    if (char.created) this.enterWorld(s);
  }

  /** Put a player with a finished character into the world they left. */
  private enterWorld(s: Session): void {
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

  /** Talking to an NPC: the ones with a working service do it. */
  private onService(s: Session, npcId: number): void {
    const p = s.player;
    if (!p || p.loc === "overworld") return;
    const npc = this.siteOf(p.loc)?.npcs.find((n) => n.id === npcId);
    // In reach: next to them, or across a counter.
    if (!npc || Math.abs(npc.x - p.bx) + Math.abs(npc.y - p.by) > 2) return;
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
      this.send(s, { t: "notice", text: `You reached level ${p.char.level}! Choose an ability to raise.` });
    }
    this.sendCharacter(s);
  }

  private sendCharacter(s: Session): void {
    this.send(s, { t: "character", character: s.player!.char });
  }

  /** The map for a site location: the base, or a camp (built from its seed the first time). */
  private siteOf(loc: Location): BaseMap | undefined {
    if (loc === "base") return this.base;
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
      kind: p.loc === "base" ? "base" : "camp",
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

  /** Step through the base's (or an encampment's) icon into it. */
  private onEnter(s: Session): void {
    const p = s.player;
    if (!p) return this.fail(s, "not_joined", "Say hello first.");
    if (p.loc !== "overworld" || s.encounter) return;
    const tile = this.world.tileAt(p.x, p.y);
    const camp = tile === T.CAMP_ICON ? this.storage.campAt(p.x, p.y) : undefined;
    const loc: Location | undefined = tile === T.BASE_ICON ? "base" : camp ? `camp:${camp.id}` : undefined;
    const site = loc && this.siteOf(loc);
    if (!loc || !site) {
      this.send(s, { t: "notice", text: "There's nothing here to enter." });
      return;
    }
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
    const ok = site.walkable(nx, ny);
    if (ok) {
      p.bx = nx;
      p.by = ny;
      s.lastMoveAt = now;
      s.dirty = true;
    }
    this.send(s, { t: "you", x: p.bx, y: p.by, seq: msg.seq, ok });
    if (ok) this.updateVisibility(s);
  }

  /** Pull every zombie near the player into a first-person fight. */
  private startEncounter(s: Session): void {
    const p = s.player!;
    const enemies = this.monsters.take(p, this.opts.encounterRadius);
    const enc: Encounter = { id: this.nextEncounterId++, x: p.x, y: p.y, enemies };
    s.encounter = enc;
    const removed = enemies.map((m) => m.id);
    for (const other of this.sessions) if (other.player) this.syncMonsters(other, undefined, removed);
    const total = enemies.reduce((n, m) => n + m.count, 0);
    log(`[encounter] "${p.name}" vs ${total} zombie(s) in ${enemies.length} pack(s) at (${p.x}, ${p.y})`);
    this.send(s, {
      t: "encounter_start",
      id: enc.id,
      x: enc.x,
      y: enc.y,
      radius: this.opts.encounterRadius,
      seed: randomInt(1, 2 ** 31 - 1),
      enemies: enemies.map((m) => ({ id: m.id, kind: m.kind, count: m.count, dx: m.x - enc.x, dy: m.y - enc.y })),
    });
  }

  private onEncounterEnd(s: Session, msg: Extract<ClientMsg, { t: "encounter_end" }>): void {
    const p = s.player;
    const enc = s.encounter;
    if (!p || !enc || msg.id !== enc.id) return; // Stale or duplicate: nothing to do.
    const killed = new Set(msg.killed);
    const survivors = enc.enemies.filter((m) => !killed.has(m.id));
    if (msg.result === "victory" && survivors.length > 0) {
      return this.fail(s, "bad_message", "Claimed victory with enemies still standing.");
    }
    // Every zombie in a killed pack counts, plus those taken from packs that survived.
    let kills = 0;
    for (const m of enc.enemies) if (killed.has(m.id)) kills += m.count;
    for (const m of survivors) {
      const left = msg.remaining?.[String(m.id)];
      if (left === undefined) continue;
      const standing = Math.max(1, Math.min(m.count, left)); // Packs only shrink, and a survivor is at least one.
      kills += m.count - standing;
      m.count = standing;
    }

    if (msg.result === "fled" && msg.dir) {
      // Come out of the fight a few tiles away in the direction we ran.
      const [dx, dy] = DIR_DELTA[msg.dir];
      for (let d = 3; d >= 1; d--) {
        const nx = enc.x + dx * d;
        const ny = enc.y + dy * d;
        if (isPassable(this.world.tileAt(nx, ny)) && !survivors.some((m) => m.x === nx && m.y === ny) && !this.monsters.at(nx, ny)) {
          p.x = nx;
          p.y = ny;
          break;
        }
      }
    }

    this.endEncounter(s, survivors);
    s.dirty = true;
    log(`[encounter] "${p.name}" ${msg.result} (${kills} killed) -> (${p.x}, ${p.y})`);
    // Health only goes down in a fight; dying means waking up healed in the infirmary.
    const c = p.char;
    if (msg.result === "died") c.hp = c.maxHp;
    else if (msg.hp !== undefined) c.hp = Math.max(1, Math.min(c.hp, Math.ceil(msg.hp)));
    this.storage.saveCharacter(p.id, c);
    this.send(s, { t: "encounter_over", id: enc.id, result: msg.result, x: p.x, y: p.y });
    const xp = kills * XP.kill + (msg.result === "victory" ? XP.victory : 0);
    if (xp > 0) this.award(s, xp, `${kills} zombie${kills === 1 ? "" : "s"} put down${msg.result === "victory" ? ", area cleared" : ""}`);
    else this.sendCharacter(s);
    if (msg.result === "died") {
      // Carried back to the base and patched up in the infirmary.
      this.changeLocation(s, "base", this.base.respawn);
      return;
    }
    this.streamChunks(s);
    this.updateVisibility(s);
    this.syncMonsters(s);
  }

  /** Close the encounter and put surviving zombies back where they stood. */
  private endEncounter(s: Session, survivors: Monster[]): void {
    s.encounter = undefined;
    const now = Date.now();
    s.graceUntil = now + this.opts.encounterGraceMs;
    const players = [...this.sessions].filter((o) => o.player?.loc === "overworld").map((o) => o.player!);
    if (s.player && !this.sessions.has(s)) players.push(s.player);
    const back = new Set<number>();
    for (const m of survivors) {
      if (!inSafeZone(m.x, m.y) && this.monsters.restore(m, now, players)) back.add(m.id);
    }
    for (const other of this.sessions) if (other.player && other !== s) this.syncMonsters(other, back);
  }

  /** The world map starts with the list of every generated chunk... */
  private onMap(s: Session): void {
    if (!s.player) return this.fail(s, "not_joined", "Say hello first.");
    const camps = this.storage.allCamps().map(({ id, name, x, y }) => ({ id, name, x, y }));
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
    let discovered = 0;
    for (const [cx, cy] of wanted) {
      if (!this.world.existingChunk(cx, cy)) discovered++; // First to see this land.
      const tiles = this.world.chunk(cx, cy);
      s.sentChunks.add(`${cx},${cy}`);
      this.send(s, { t: "chunk", cx, cy, tiles: Buffer.from(tiles).toString("base64") });
      for (const camp of this.storage.campsIn(cx * CHUNK_SIZE, cy * CHUNK_SIZE, (cx + 1) * CHUNK_SIZE, (cy + 1) * CHUNK_SIZE)) {
        this.send(s, { t: "camp", id: camp.id, name: camp.name, x: camp.x, y: camp.y });
      }
    }
    if (discovered > 0) this.award(s, discovered * XP.explore, "");
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
    // Zombies only know about the overworld; the base is safe.
    const sessions = [...this.sessions].filter((s) => s.player?.loc === "overworld" && s.player.char.created);
    const { changed, removed, contacts } = this.monsters.tick(
      now,
      sessions.map((s) => ({ ...s.player!, targetable: !s.encounter && now >= s.graceUntil })),
    );
    if (changed.size > 0 || removed.length > 0) {
      for (const s of sessions) this.syncMonsters(s, changed, removed);
    }
    for (const c of contacts) {
      const s = this.byPlayerId.get(c.playerId);
      if (s && !s.encounter) this.startEncounter(s);
    }
  }

  /**
   * Send monsters in view that this client hasn't seen or that changed, and
   * forget ones that left view or were removed.
   */
  private syncMonsters(s: Session, changed?: Set<number>, removed: number[] = []): void {
    const p = s.player!;
    for (const id of removed) {
      if (s.seenMonsters.delete(id)) this.send(s, { t: "monster_left", id });
    }
    for (const m of this.monsters.all.values()) {
      const near = p.loc === "overworld" && Math.max(Math.abs(m.x - p.x), Math.abs(m.y - p.y)) <= this.opts.viewTiles;
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

function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
