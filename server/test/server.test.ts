import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { GameServer } from "../src/server.ts";
import { Storage } from "../src/storage.ts";
import { isPassable, T } from "../src/tiles.ts";
import { World } from "../src/world.ts";
import { generateChunk, terrainAt } from "../src/worldgen.ts";

const dir = mkdtempSync(join(tmpdir(), "wasteland-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let nextPort = 17777 + Math.floor(Math.random() * 1000);

async function boot(dbPath: string) {
  const storage = new Storage(dbPath);
  const world = new World(storage, 4242);
  const port = nextPort++;
  const server = new GameServer(world, storage, {
    host: "127.0.0.1", port, motd: "test", viewChunks: 1, viewTiles: 40, moveIntervalMs: 0, saveIntervalMs: 60_000,
  });
  await server.start();
  return {
    port,
    async stop() {
      await server.stop();
      storage.close();
    },
  };
}

/** A tiny client that queues incoming messages so tests can await them in order. */
async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    const w = waiters.shift();
    w ? w(m) : inbox.push(m);
  });
  await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
  const next = () => new Promise<any>((res) => (inbox.length ? res(inbox.shift()) : waiters.push(res)));
  return {
    send: (m: object) => ws.send(JSON.stringify(m)),
    async until(t: string) {
      for (;;) {
        const m = await next();
        if (m.t === t) return m;
      }
    },
    close: () => new Promise<void>((res) => (ws.once("close", () => res()), ws.close())),
  };
}

test("generation is deterministic and the base is walled with open gates", () => {
  assert.deepEqual(generateChunk(7, 3, -2), generateChunk(7, 3, -2));
  assert.equal(terrainAt(7, 0, 0), T.BASE_FLOOR);
  assert.equal(terrainAt(7, 8, 8), T.BASE_WALL);
  assert.equal(terrainAt(7, 0, 8), T.BASE_GATE);
  assert.ok(isPassable(terrainAt(7, 0, 9)), "south gate opens onto walkable land");
});

test("a player's position survives reconnecting and a server restart", async () => {
  const db = join(dir, "world.db");
  let srv = await boot(db);

  let c = await connect(srv.port);
  c.send({ t: "hello", v: 1, name: "Tester" });
  const welcome = await c.until("welcome");
  assert.equal(welcome.x, 0);
  assert.equal(welcome.y, 0);
  const chunk = await c.until("chunk");
  assert.equal(Buffer.from(chunk.tiles, "base64").length, 32 * 32);

  // Walk south through the gate (base floor and highway are always passable).
  let pos: any;
  for (let i = 0; i < 12; i++) {
    c.send({ t: "move", dir: "down", seq: i });
    pos = await c.until("you");
    assert.ok(pos.ok, `move ${i} accepted`);
  }
  assert.deepEqual([pos.x, pos.y], [0, 12]);
  await c.close();

  // Wrong token for an existing name is refused.
  c = await connect(srv.port);
  c.send({ t: "hello", v: 1, name: "tester", token: "nope" });
  assert.equal((await c.until("error")).code, "name_taken");

  await srv.stop();
  srv = await boot(db);

  c = await connect(srv.port);
  c.send({ t: "hello", v: 1, name: "Tester", token: welcome.token });
  const again = await c.until("welcome");
  assert.deepEqual([again.x, again.y], [0, 12]);
  await c.close();
  await srv.stop();
});

test("nearby players see each other arrive, move and leave", async () => {
  const srv = await boot(":memory:");
  const a = await connect(srv.port);
  a.send({ t: "hello", v: 1, name: "Alpha" });
  const wa = await a.until("welcome");
  const b = await connect(srv.port);
  b.send({ t: "hello", v: 1, name: "Bravo" });
  const wb = await b.until("welcome");

  assert.equal((await b.until("player")).id, wa.id, "Bravo is told about Alpha");
  assert.equal((await a.until("player")).id, wb.id, "Alpha is told about Bravo");

  b.send({ t: "move", dir: "left", seq: 1 });
  const moved = await a.until("player");
  assert.deepEqual([moved.id, moved.x, moved.y], [wb.id, -1, 0]);

  await b.close();
  assert.equal((await a.until("player_left")).id, wb.id);
  await a.close();
  await srv.stop();
});

test("walls block movement", async () => {
  const srv = await boot(":memory:");
  const c = await connect(srv.port);
  c.send({ t: "hello", v: 1, name: "Bumper" });
  await c.until("welcome");
  // Step off the y=0 row first: the east gate is at (8, 0).
  c.send({ t: "move", dir: "down", seq: 0 });
  let pos: any = await c.until("you");
  for (let i = 1; i < 10; i++) {
    c.send({ t: "move", dir: "right", seq: i });
    pos = await c.until("you");
  }
  assert.equal(pos.x, 7, "stopped just inside the east wall");
  assert.equal(pos.ok, false);
  await c.close();
  await srv.stop();
});
