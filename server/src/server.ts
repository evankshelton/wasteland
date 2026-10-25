// Game server: accepts WebSocket connections, authenticates players, applies
// movement authoritatively and streams nearby chunks and players.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { DIR_DELTA, PROTOCOL_VERSION, parseClientMsg, validName, type ClientMsg, type ServerMsg } from "./protocol.ts";
import type { Storage } from "./storage.ts";
import { TILE_DEFS, isPassable } from "./tiles.ts";
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
}

interface Session {
  ws: WebSocket;
  addr: string;
  player?: { id: number; name: string; x: number; y: number };
  sentChunks: Set<string>;
  seenPlayers: Set<number>;
  lastMoveAt: number;
  dirty: boolean;
}

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

export class GameServer {
  private wss?: WebSocketServer;
  private sessions = new Set<Session>();
  private byPlayerId = new Map<number, Session>();
  private saveTimer?: NodeJS.Timeout;
  private world: World;
  private storage: Storage;
  private opts: ServerOptions;

  constructor(world: World, storage: Storage, opts: ServerOptions) {
    this.world = world;
    this.storage = storage;
    this.opts = opts;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: this.opts.host, port: this.opts.port, maxPayload: 4096 });
      this.wss = wss;
      wss.once("listening", () => {
        log(`[server] listening on ws://${this.opts.host}:${this.opts.port} (seed ${this.world.seed}, ${this.storage.chunkCount()} chunks stored)`);
        resolve();
      });
      wss.once("error", reject);
      wss.on("connection", (ws, req) => this.onConnection(ws, req.socket.remoteAddress ?? "?"));
      this.saveTimer = setInterval(() => this.flush(), this.opts.saveIntervalMs);
    });
  }

  async stop(): Promise<void> {
    clearInterval(this.saveTimer);
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
    const s: Session = { ws, addr, sentChunks: new Set(), seenPlayers: new Set(), lastMoveAt: 0, dirty: false };
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
    switch (msg.t) {
      case "hello":
        return this.onHello(s, msg);
      case "move":
        return this.onMove(s, msg);
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
      rec = this.storage.createPlayer(msg.name, randomBytes(24).toString("base64url"), BASE.spawn.x, BASE.spawn.y);
      log(`[player] created "${rec.name}" (#${rec.id})`);
    }

    // One live session per character: the newest connection wins and takes
    // over the live position (the stored one may be a few seconds stale).
    let { x, y } = rec;
    const existing = this.byPlayerId.get(rec.id);
    if (existing?.player) {
      ({ x, y } = existing.player);
      this.send(existing, { t: "error", code: "replaced", message: "Logged in from another client." });
      existing.ws.close(4000, "replaced");
      this.onClose(existing);
    }

    s.player = { id: rec.id, name: rec.name, x, y };
    this.byPlayerId.set(rec.id, s);
    log(`[player] "${rec.name}" joined from ${s.addr} at (${x}, ${y})`);

    this.send(s, {
      t: "welcome",
      id: rec.id,
      name: rec.name,
      token: rec.token,
      x,
      y,
      chunkSize: CHUNK_SIZE,
      tiles: TILE_DEFS.map(({ id, key, name, passable }) => ({ id, key, name, passable })),
      motd: this.opts.motd,
    });
    this.streamChunks(s);
    this.updateVisibility(s);
  }

  private onMove(s: Session, msg: Extract<ClientMsg, { t: "move" }>): void {
    const p = s.player;
    if (!p) return this.fail(s, "not_joined", "Say hello first.");

    const now = Date.now();
    let ok = false;
    if (now - s.lastMoveAt >= this.opts.moveIntervalMs) {
      const [dx, dy] = DIR_DELTA[msg.dir];
      const nx = p.x + dx;
      const ny = p.y + dy;
      if (isPassable(this.world.tileAt(nx, ny))) {
        p.x = nx;
        p.y = ny;
        s.lastMoveAt = now;
        s.dirty = true;
        ok = true;
      }
    }
    this.send(s, { t: "you", x: p.x, y: p.y, seq: msg.seq, ok });
    if (ok) {
      this.streamChunks(s);
      this.updateVisibility(s);
    }
  }

  private onClose(s: Session): void {
    if (!this.sessions.delete(s)) return;
    const p = s.player;
    if (p) {
      this.storage.savePlayers([p]);
      if (this.byPlayerId.get(p.id) === s) this.byPlayerId.delete(p.id);
      for (const other of this.sessions) {
        if (other.seenPlayers.delete(p.id)) this.send(other, { t: "player_left", id: p.id });
      }
      log(`[player] "${p.name}" left at (${p.x}, ${p.y})`);
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
    }
  }

  /** After `s` moved or joined, update who can see whom. */
  private updateVisibility(s: Session): void {
    const p = s.player!;
    for (const other of this.sessions) {
      const q = other.player;
      if (other === s || !q) continue;
      const near = Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)) <= this.opts.viewTiles;
      if (near) {
        this.send(other, { t: "player", id: p.id, name: p.name, x: p.x, y: p.y });
        other.seenPlayers.add(p.id);
        if (!s.seenPlayers.has(q.id)) {
          this.send(s, { t: "player", id: q.id, name: q.name, x: q.x, y: q.y });
          s.seenPlayers.add(q.id);
        }
      } else {
        if (other.seenPlayers.delete(p.id)) this.send(other, { t: "player_left", id: p.id });
        if (s.seenPlayers.delete(q.id)) this.send(s, { t: "player_left", id: q.id });
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
