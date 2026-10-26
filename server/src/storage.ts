// SQLite persistence (Node's built-in node:sqlite, no native addons needed).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Character } from "./character.ts";

export type Location = "overworld" | "base";

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
