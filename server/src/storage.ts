// SQLite persistence (Node's built-in node:sqlite, no native addons needed).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Character } from "./character.ts";

/** Which map a player is on: the overworld, the base, an encampment by id, or a dungeon by id and level. */
export type Location = "overworld" | "base" | `camp:${number}` | `dungeon:${number}:${number}`;

export interface DungeonRecord {
  id: number;
  x: number;
  y: number;
  name: string;
  /** The dungeon's layout grows from this (dungeons.ts dungeonLayout). */
  seed: number;
}

export interface CampRecord {
  id: number;
  x: number;
  y: number;
  name: string;
  /** The camp's layout grows from this (camps.ts campLayout). */
  seed: number;
}

export interface PlayerRecord {
  id: number;
  name: string;
  token: string;
  /** Overworld position (where the player is, or where they'll be on leaving the base). */
  x: number;
  y: number;
  loc: Location;
  /** Position inside the base map, while loc is "base". */
  bx: number;
  by: number;
  /** Undefined until the server first rolls one (new players, and players from before characters existed). */
  char?: Character;
}

export type SavedPosition = Pick<PlayerRecord, "id" | "x" | "y" | "loc" | "bx" | "by">;

const SCHEMA_VERSION = 3;

export class Storage {
  private db: DatabaseSync;
  private q: {
    getChunk: StatementSync;
    putChunk: StatementSync;
    countChunks: StatementSync;
    chunkCoords: StatementSync;
    playerByName: StatementSync;
    insertPlayer: StatementSync;
    savePlayer: StatementSync;
    saveCharacter: StatementSync;
    insertCamp: StatementSync;
    campAt: StatementSync;
    campById: StatementSync;
    campByName: StatementSync;
    campsIn: StatementSync;
    allCamps: StatementSync;
    visitCamp: StatementSync;
    visitedCamps: StatementSync;
    insertDungeon: StatementSync;
    dungeonAt: StatementSync;
    dungeonById: StatementSync;
  };

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        cx           INTEGER NOT NULL,
        cy           INTEGER NOT NULL,
        tiles        BLOB    NOT NULL,
        generated_at INTEGER NOT NULL,
        PRIMARY KEY (cx, cy)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS players (
        id         INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        token      TEXT    NOT NULL,
        x          INTEGER NOT NULL,
        y          INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS camps (
        id         INTEGER PRIMARY KEY,
        x          INTEGER NOT NULL,
        y          INTEGER NOT NULL,
        name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        seed       INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS camps_at ON camps (x, y);
      CREATE TABLE IF NOT EXISTS camp_visits (
        player_id  INTEGER NOT NULL,
        camp_id    INTEGER NOT NULL,
        visited_at INTEGER NOT NULL,
        PRIMARY KEY (player_id, camp_id)
      );
      CREATE TABLE IF NOT EXISTS dungeons (
        id         INTEGER PRIMARY KEY,
        x          INTEGER NOT NULL,
        y          INTEGER NOT NULL,
        name       TEXT    NOT NULL,
        seed       INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS dungeons_at ON dungeons (x, y);
    `);
    this.upgradeSchema();
    this.q = {
      getChunk: this.db.prepare("SELECT tiles FROM chunks WHERE cx = ? AND cy = ?"),
      putChunk: this.db.prepare("INSERT OR REPLACE INTO chunks (cx, cy, tiles, generated_at) VALUES (?, ?, ?, ?)"),
      countChunks: this.db.prepare("SELECT COUNT(*) AS n FROM chunks"),
      chunkCoords: this.db.prepare("SELECT cx, cy FROM chunks"),
      playerByName: this.db.prepare(
        `SELECT id, name, token, x, y, location AS loc, base_x AS bx, base_y AS "by", character FROM players WHERE name = ?`,
      ),
      insertPlayer: this.db.prepare(
        "INSERT INTO players (name, token, x, y, location, base_x, base_y, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      savePlayer: this.db.prepare("UPDATE players SET x = ?, y = ?, location = ?, base_x = ?, base_y = ?, last_seen = ? WHERE id = ?"),
      saveCharacter: this.db.prepare("UPDATE players SET character = ? WHERE id = ?"),
      insertCamp: this.db.prepare("INSERT INTO camps (x, y, name, seed, created_at) VALUES (?, ?, ?, ?, ?)"),
      campAt: this.db.prepare("SELECT id, x, y, name, seed FROM camps WHERE x = ? AND y = ?"),
      campById: this.db.prepare("SELECT id, x, y, name, seed FROM camps WHERE id = ?"),
      campByName: this.db.prepare("SELECT id FROM camps WHERE name = ?"),
      campsIn: this.db.prepare("SELECT id, x, y, name, seed FROM camps WHERE x >= ? AND x < ? AND y >= ? AND y < ?"),
      allCamps: this.db.prepare("SELECT id, x, y, name, seed FROM camps"),
      insertDungeon: this.db.prepare("INSERT INTO dungeons (x, y, name, seed, created_at) VALUES (?, ?, ?, ?, ?)"),
      dungeonAt: this.db.prepare("SELECT id, x, y, name, seed FROM dungeons WHERE x = ? AND y = ?"),
      dungeonById: this.db.prepare("SELECT id, x, y, name, seed FROM dungeons WHERE id = ?"),
      visitCamp: this.db.prepare("INSERT OR IGNORE INTO camp_visits (player_id, camp_id, visited_at) VALUES (?, ?, ?)"),
      visitedCamps: this.db.prepare(
        "SELECT c.id, c.x, c.y, c.name, c.seed FROM camps c JOIN camp_visits v ON v.camp_id = c.id WHERE v.player_id = ?",
      ),
    };
  }

  /** Add columns introduced after a database was created. */
  private upgradeSchema(): void {
    const version = Number(this.getMeta("schema_version") ?? 1);
    if (version < 2) {
      const cols = new Set((this.db.prepare("PRAGMA table_info(players)").all() as { name: string }[]).map((c) => c.name));
      if (!cols.has("location")) this.db.exec("ALTER TABLE players ADD COLUMN location TEXT NOT NULL DEFAULT 'overworld'");
      if (!cols.has("base_x")) this.db.exec("ALTER TABLE players ADD COLUMN base_x INTEGER NOT NULL DEFAULT 0");
      if (!cols.has("base_y")) this.db.exec("ALTER TABLE players ADD COLUMN base_y INTEGER NOT NULL DEFAULT 0");
    }
    if (version < 3) {
      // The character (abilities, level, XP, health) as JSON; NULL until first rolled.
      const cols = new Set((this.db.prepare("PRAGMA table_info(players)").all() as { name: string }[]).map((c) => c.name));
      if (!cols.has("character")) this.db.exec("ALTER TABLE players ADD COLUMN character TEXT");
    }
    if (version < SCHEMA_VERSION) this.setMeta("schema_version", String(SCHEMA_VERSION));
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getChunk(cx: number, cy: number): Uint8Array | undefined {
    const row = this.q.getChunk.get(cx, cy) as { tiles: Uint8Array } | undefined;
    return row?.tiles;
  }

  putChunk(cx: number, cy: number, tiles: Uint8Array): void {
    this.q.putChunk.run(cx, cy, tiles, Date.now());
  }

  chunkCount(): number {
    return (this.q.countChunks.get() as { n: number }).n;
  }

  /** Coordinates of every chunk generated so far. */
  chunkCoords(): [number, number][] {
    return (this.q.chunkCoords.all() as { cx: number; cy: number }[]).map((r) => [r.cx, r.cy]);
  }

  findPlayer(name: string): PlayerRecord | undefined {
    const row = this.q.playerByName.get(name) as (Omit<PlayerRecord, "char"> & { character: string | null }) | undefined;
    if (!row) return undefined;
    const { character, ...rec } = row;
    return { ...rec, char: character ? (JSON.parse(character) as Character) : undefined };
  }

  createDungeon(x: number, y: number, name: string, seed: number): DungeonRecord {
    const res = this.q.insertDungeon.run(x, y, name, seed, Date.now());
    return { id: Number(res.lastInsertRowid), x, y, name, seed };
  }

  dungeonAt(x: number, y: number): DungeonRecord | undefined {
    return this.q.dungeonAt.get(x, y) as DungeonRecord | undefined;
  }

  dungeonById(id: number): DungeonRecord | undefined {
    return this.q.dungeonById.get(id) as DungeonRecord | undefined;
  }

  createCamp(x: number, y: number, name: string, seed: number): CampRecord {
    const res = this.q.insertCamp.run(x, y, name, seed, Date.now());
    return { id: Number(res.lastInsertRowid), x, y, name, seed };
  }

  campAt(x: number, y: number): CampRecord | undefined {
    return this.q.campAt.get(x, y) as CampRecord | undefined;
  }

  campById(id: number): CampRecord | undefined {
    return this.q.campById.get(id) as CampRecord | undefined;
  }

  campNameTaken(name: string): boolean {
    return this.q.campByName.get(name) !== undefined;
  }

  /** Camps with x0 <= x < x1 and y0 <= y < y1. */
  campsIn(x0: number, y0: number, x1: number, y1: number): CampRecord[] {
    return this.q.campsIn.all(x0, x1, y0, y1) as unknown as CampRecord[];
  }

  allCamps(): CampRecord[] {
    return this.q.allCamps.all() as unknown as CampRecord[];
  }

  /** Remember that a player has been inside a camp (it then shows on their world map). */
  visitCamp(playerId: number, campId: number): void {
    this.q.visitCamp.run(playerId, campId, Date.now());
  }

  /** The camps a player has been inside. */
  visitedCamps(playerId: number): CampRecord[] {
    return this.q.visitedCamps.all(playerId) as unknown as CampRecord[];
  }

  saveCharacter(id: number, char: Character): void {
    this.q.saveCharacter.run(JSON.stringify(char), id);
  }

  createPlayer(name: string, token: string, start: Omit<SavedPosition, "id">): PlayerRecord {
    const now = Date.now();
    const res = this.q.insertPlayer.run(name, token, start.x, start.y, start.loc, start.bx, start.by, now, now);
    return { id: Number(res.lastInsertRowid), name, token, ...start };
  }

  savePlayers(players: Iterable<SavedPosition>): void {
    const now = Date.now();
    this.transaction(() => {
      for (const p of players) this.q.savePlayer.run(p.x, p.y, p.loc, p.bx, p.by, now, p.id);
    });
  }

  transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
