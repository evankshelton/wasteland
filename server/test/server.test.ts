import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { DEFAULT_MONSTER_OPTIONS, Monsters, inSafeZone, type MonsterOptions } from "../src/monsters.ts";
import { GameServer } from "../src/server.ts";
import { Storage } from "../src/storage.ts";
import { isPassable, T } from "../src/tiles.ts";
import { World } from "../src/world.ts";
import { generateChunk, terrainAt } from "../src/worldgen.ts";

const dir = mkdtempSync(join(tmpdir(), "wasteland-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let nextPort = 17777 + Math.floor(Math.random() * 1000);

async function boot(dbPath: string, monsters: Partial<MonsterOptions> = {}) {
  const storage = new Storage(dbPath);
  const world = new World(storage, 4242);
  const port = nextPort++;
  const server = new GameServer(world, storage, {
    host: "127.0.0.1", port, motd: "test", viewChunks: 1, viewTiles: 40, moveIntervalMs: 0, saveIntervalMs: 60_000,
    tickMs: 20, monsters: { ...DEFAULT_MONSTER_OPTIONS, spawnChance: 0, ...monsters },
    encounterRadius: 8, encounterGraceMs: 300,
  });
  await server.start();
  return {
    port,
    server,
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
    close: () =>
      new Promise<void>((res) => {
        if (ws.readyState === ws.CLOSED) return res();
        ws.once("close", () => res());
        ws.close();
      }),
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
  c.send({ t: "hello", v: 4, name: "Tester" });
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
  c.send({ t: "hello", v: 4, name: "tester", token: "nope" });
  assert.equal((await c.until("error")).code, "name_taken");

  await srv.stop();
  srv = await boot(db);

  c = await connect(srv.port);
  c.send({ t: "hello", v: 4, name: "Tester", token: welcome.token });
  const again = await c.until("welcome");
  assert.deepEqual([again.x, again.y], [0, 12]);
  await c.close();
  await srv.stop();
});

test("nearby players see each other arrive, move and leave", async () => {
  const srv = await boot(":memory:");
  const a = await connect(srv.port);
  a.send({ t: "hello", v: 4, name: "Alpha" });
  const wa = await a.until("welcome");
  const b = await connect(srv.port);
  b.send({ t: "hello", v: 4, name: "Bravo" });
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

test("the world map lists generated chunks and never generates new ones", async () => {
  const srv = await boot(":memory:");
  const c = await connect(srv.port);
  c.send({ t: "hello", v: 4, name: "Mapper" });
  const welcome = await c.until("welcome");
  assert.equal(welcome.tiles[1].color, "#5c3f24", "map colours come with the tile list");

  c.send({ t: "map" });
  const index = await c.until("map_index");
  assert.equal(index.chunks.length, 9, "viewChunks=1 streams a 3x3 block around spawn");

  // Ask for one generated chunk and one far away that nobody has visited.
  c.send({ t: "map_chunks", coords: [index.chunks[0], [500, 500]] });
  const got = await c.until("map_chunk");
  assert.deepEqual([got.cx, got.cy], index.chunks[0]);
  assert.equal(Buffer.from(got.tiles, "base64").length, 32 * 32);
  await c.until("map_batch_done");

  c.send({ t: "map" });
  assert.equal((await c.until("map_index")).chunks.length, 9, "asking about (500,500) did not generate it");

  c.send({ t: "map_chunks", coords: Array.from({ length: 257 }, () => [0, 0]) });
  assert.equal((await c.until("error")).code, "bad_message", "oversized batches are refused");
  await c.close();
  await srv.stop();
});

test("walls block movement", async () => {
  const srv = await boot(":memory:");
  const c = await connect(srv.port);
  c.send({ t: "hello", v: 4, name: "Bumper" });
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

// ---- zombies ----

function zombieWorld(opts: Partial<MonsterOptions> = {}) {
  const storage = new Storage(":memory:");
  const world = new World(storage, 4242);
  return new Monsters(world, { ...DEFAULT_MONSTER_OPTIONS, ...opts });
}

function addZombie(monsters: Monsters, id: number, x: number, y: number, nextStepAt = 0) {
  monsters.all.set(id, { id, kind: "zombie", x, y, nextStepAt, lastNearPlayerAt: 0 });
}

const hunter = (x: number, y: number, targetable = true) => ({ id: 1, x, y, targetable });

test("zombies spawn just off screen out in the wasteland, never near the base", () => {
  const monsters = zombieWorld({ spawnChance: 1 });
  monsters.tick(0, [hunter(0, 0)]);
  assert.equal(monsters.all.size, 0, "nothing spawns around a player at the base");

  const player = hunter(0, 60);
  for (let t = 0; t < 20; t++) monsters.tick(t, [player]);
  assert.equal(monsters.all.size, DEFAULT_MONSTER_OPTIONS.maxNearPlayer, "spawns stop at the cap");
  for (const m of monsters.all.values()) {
    const d = Math.max(Math.abs(m.x - player.x), Math.abs(m.y - player.y));
    assert.ok(d >= 12 && d <= 18, `zombie at (${m.x}, ${m.y}) spawned 12-18 tiles away`);
  }

  const busy = zombieWorld({ spawnChance: 1 });
  busy.tick(0, [hunter(0, 60, false)]);
  assert.equal(busy.all.size, 0, "nothing spawns around a player who is mid-encounter");
});

test("zombies shamble slowly onto players but never into the base", () => {
  // The highway south of the gate (x = 0, y = 9..32) is always walkable.
  const monsters = zombieWorld({ stepMs: 900 });
  addZombie(monsters, 1, 0, 30);
  const z = monsters.all.get(1)!;
  const player = hunter(0, 12);

  monsters.tick(0, [player]);
  assert.equal(z.y, 29, "first step");
  monsters.tick(500, [player]);
  assert.equal(z.y, 29, "no second step before stepMs has passed");
  let contact;
  for (let t = 900; t < 900 * 40 && !contact; t += 900) contact = monsters.tick(t, [player]).contacts[0];
  assert.deepEqual(contact, { playerId: 1, monsterId: 1 }, "reaching the player is a contact");
  assert.equal(z.y, 12, "on the player's tile");

  const safe = zombieWorld();
  addZombie(safe, 1, 0, 14);
  const atGate = hunter(0, 9);
  for (let t = 0; t < 900 * 20; t += 900) assert.equal(safe.tick(t, [atGate]).contacts.length, 0);
  assert.equal(safe.all.get(1)!.y, 11, "won't step into the ring around the base");
  assert.ok(inSafeZone(0, 10) && !inSafeZone(0, 11));

  const ignored = zombieWorld();
  addZombie(ignored, 1, 0, 14);
  for (let t = 0; t < 900 * 20; t += 900) ignored.tick(t, [hunter(0, 12, false)]);
  assert.notEqual(ignored.all.get(1)!.y, 12, "untargetable players aren't chased onto");
});

test("zombies with nobody around eventually despawn", () => {
  const monsters = zombieWorld({ despawnAfterMs: 1000 });
  addZombie(monsters, 1, 0, 30);
  monsters.tick(0, [hunter(0, 25)]);
  assert.equal(monsters.tick(500, []).removed.length, 0);
  assert.deepEqual(monsters.tick(1500, []).removed, [1]);
  assert.equal(monsters.all.size, 0);
});

/** Joins and walks down the highway to (0, 12), where nothing can block the way. */
async function walkOut(port: number, name: string) {
  const c = await connect(port);
  c.send({ t: "hello", v: 4, name });
  await c.until("welcome");
  for (let i = 0; i < 12; i++) {
    c.send({ t: "move", dir: "down", seq: i });
    await c.until("you");
  }
  return c;
}

test("clients see zombies approach, and a zombie reaching the player starts an encounter", async () => {
  const srv = await boot(":memory:", { stepMs: 50 });
  const c = await walkOut(srv.port, "Bait");
  addZombie(srv.server.monsters, 1000, 0, 16, Date.now() + 60_000);
  addZombie(srv.server.monsters, 1001, 3, 19, Date.now() + 60_000); // within 8 tiles: joins the fight
  addZombie(srv.server.monsters, 1002, 0, 30, Date.now() + 60_000); // too far: stays on the map
  c.send({ t: "move", dir: "up", seq: 99 }); // (0, 11): moving re-syncs nearby monsters
  await c.until("you");
  assert.equal((await c.until("monster")).id, 1000);

  srv.server.monsters.all.get(1000)!.nextStepAt = 0; // Let it walk (tickMs is 20 in tests).
  const start = await c.until("encounter_start");
  assert.deepEqual([start.x, start.y, start.radius], [0, 11, 8]);
  assert.deepEqual(
    start.enemies.map((e: any) => [e.id, e.dx, e.dy]).sort(),
    [[1000, 0, 0], [1001, 3, 8]],
  );
  assert.ok(!srv.server.monsters.all.has(1000) && srv.server.monsters.all.has(1002));

  c.send({ t: "move", dir: "down", seq: 100 });
  assert.equal((await c.until("you")).ok, false, "no overworld moves mid-fight");
  await c.close();
  await srv.stop();
});

test("encounters end in victory, flight or death", async () => {
  const srv = await boot(":memory:");
  const c = await walkOut(srv.port, "Hero");
  const mons = srv.server.monsters;

  // Walking onto a zombie starts a fight. (Zombies here never step: nextStepAt is far off.)
  addZombie(mons, 1, 0, 13, Date.now() + 60_000);
  addZombie(mons, 2, 2, 16, Date.now() + 60_000);
  c.send({ t: "move", dir: "down", seq: 1 });
  let start = await c.until("encounter_start");
  assert.equal(start.enemies.length, 2);

  c.send({ t: "encounter_end", id: start.id, result: "victory", killed: [1, 2] });
  let over = await c.until("encounter_over");
  assert.deepEqual([over.result, over.x, over.y], ["victory", 0, 13]);
  assert.equal(mons.all.size, 0, "the dead stay dead");

  // Flee south: we come out 3 tiles that way and the survivor goes back to the map.
  await new Promise((r) => setTimeout(r, 350)); // grace period
  addZombie(mons, 3, 0, 14, Date.now() + 60_000);
  addZombie(mons, 4, 0, 19, Date.now() + 60_000);
  c.send({ t: "move", dir: "down", seq: 2 });
  start = await c.until("encounter_start");
  c.send({ t: "encounter_end", id: start.id, result: "fled", killed: [3], dir: "down" });
  over = await c.until("encounter_over");
  assert.deepEqual([over.result, over.x, over.y], ["fled", 0, 17]);
  assert.deepEqual([...mons.all.keys()], [4], "survivor returned to the overworld");
  const back = mons.all.get(4)!;
  assert.deepEqual([back.x, back.y], [0, 19]);

  // Claiming victory with zombies still standing is refused.
  await new Promise((r) => setTimeout(r, 350));
  mons.all.clear();
  addZombie(mons, 5, 0, 18, Date.now() + 60_000);
  c.send({ t: "move", dir: "down", seq: 3 });
  start = await c.until("encounter_start");
  c.send({ t: "encounter_end", id: start.id, result: "victory", killed: [] });
  assert.equal((await c.until("error")).code, "bad_message", "can't claim victory with zombies standing");
  await c.close();

  // Die: back to the base.
  const d = await walkOut(srv.port, "Doomed");
  mons.all.clear();
  addZombie(mons, 6, 0, 13, Date.now() + 60_000);
  d.send({ t: "move", dir: "down", seq: 1 });
  start = await d.until("encounter_start");
  d.send({ t: "encounter_end", id: start.id, result: "died", killed: [] });
  over = await d.until("encounter_over");
  assert.deepEqual([over.result, over.x, over.y], ["died", 0, 0]);
  await d.close();
  await srv.stop();
});
