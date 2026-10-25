// SQLite persistence (Node's built-in node:sqlite, no native addons needed).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface PlayerRecord {
  id: number;
  name: string;
  token: string;
  x: number;
  y: number;
}

const SCHEMA_VERSION = 1;

export class Storage {
  private db: DatabaseSync;
  private q: {
    getMeta: StatementSync;
    setMeta: StatementSync;
    getChunk: StatementSync;
    putChunk: StatementSync;
    countChunks: StatementSync;
    playerByName: StatementSync;
    insertPlayer: StatementSync;
    savePlayer: StatementSync;
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
    this.q = {
      getMeta: this.db.prepare("SELECT value FROM meta WHERE key = ?"),
      setMeta: this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
      getChunk: this.db.prepare("SELECT tiles FROM chunks WHERE cx = ? AND cy = ?"),
      putChunk: this.db.prepare("INSERT OR REPLACE INTO chunks (cx, cy, tiles, generated_at) VALUES (?, ?, ?, ?)"),
      countChunks: this.db.prepare("SELECT COUNT(*) AS n FROM chunks"),
      playerByName: this.db.prepare("SELECT id, name, token, x, y FROM players WHERE name = ?"),
      insertPlayer: this.db.prepare("INSERT INTO players (name, token, x, y, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)"),
      savePlayer: this.db.prepare("UPDATE players SET x = ?, y = ?, last_seen = ? WHERE id = ?"),
    };
    if (this.getMeta("schema_version") === undefined) this.setMeta("schema_version", String(SCHEMA_VERSION));
  }

  getMeta(key: string): string | undefined {
    const row = this.q.getMeta.get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.q.setMeta.run(key, value);
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

  findPlayer(name: string): PlayerRecord | undefined {
    return this.q.playerByName.get(name) as PlayerRecord | undefined;
  }

  createPlayer(name: string, token: string, x: number, y: number): PlayerRecord {
    const now = Date.now();
    const res = this.q.insertPlayer.run(name, token, x, y, now, now);
    return { id: Number(res.lastInsertRowid), name, token, x, y };
  }

  savePlayers(players: Iterable<{ id: number; x: number; y: number }>): void {
    const now = Date.now();
    this.transaction(() => {
      for (const p of players) this.q.savePlayer.run(p.x, p.y, now, p.id);
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
