import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { BaseMap } from "../src/base.ts";
import { BOOTH_TYPES, CAMP_MIN_BASE_DISTANCE, CAMP_STYLES, campLayout, checkLayout } from "../src/camps.ts";
import { XP, gainXp, raise, rollCharacter, xpForLevel } from "../src/character.ts";
import { DEFAULT_MONSTER_OPTIONS, Monsters, inSafeZone, rollPackSize, type MonsterOptions } from "../src/monsters.ts";
import { GameServer } from "../src/server.ts";
import { Storage } from "../src/storage.ts";
import { isPassable, T } from "../src/tiles.ts";
import { World } from "../src/world.ts";
import { CHUNK_SIZE, generateChunk, terrainAt } from "../src/worldgen.ts";

const dir = mkdtempSync(join(tmpdir(), "wasteland-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const BASE_MAP = BaseMap.load();
const V = 8; // protocol version
let nextPort = 17777 + Math.floor(Math.random() * 1000);

async function boot(dbPath: string, monsters: Partial<MonsterOptions> = {}) {
  const storage = new Storage(dbPath);
  const world = new World(storage, 4242);
  const port = nextPort++;
  const server = new GameServer(world, storage, BASE_MAP, {
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

type Client = Awaited<ReturnType<typeof connect>>;

/** The live state of the one player on a test server, for setting up situations directly. */
function onlyPlayer(server: GameServer): any {
  return (server as any).byPlayerId.values().next().value.player;
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
  let seq = 0;
  const client = {
    next,
    send: (m: object) => ws.send(JSON.stringify(m)),
    async until(t: string) {
      for (;;) {
        const m = await next();
        if (m.t === t) return m;
      }
    },
    /** One step; resolves with the server's "you" reply. */
    async move(dir: string) {
      client.send({ t: "move", dir, seq: ++seq });
      return client.until("you");
    },
    close: () =>
      new Promise<void>((res) => {
        if (ws.readyState === ws.CLOSED) return res();
        ws.once("close", () => res());
        ws.close();
      }),
  };
  return client;
}

/**
 * Joins (accepting the first roll if the character is new) and returns the
 * welcome, the character and the first location (new characters start inside the base).
 */
async function enterGame(port: number, name: string, token?: string) {
  const c = await connect(port);
  c.send({ t: "hello", v: V, name, token });
  const welcome = await c.until("welcome");
  let character = welcome.character;
  if (!character.created) {
    c.send({ t: "accept" });
    character = (await c.until("character")).character;
  }
  const location = await c.until("location");
  return { c, welcome, location, character };
}

/** A new character leaves the base by the south gate (onto the highway at (0, 1)) and walks down it to (0, 12). */
async function walkOut(port: number, name: string): Promise<{ c: Client; token: string }> {
  const { c, welcome, location } = await enterGame(port, name);
  assert.equal(location.kind, "base");
  for (let i = 0; i < 4; i++) await c.move("down"); // gate, road, road, off the edge
  const out = await c.until("location");
  assert.deepEqual([out.kind, out.x, out.y], ["overworld", 0, 1]);
  for (let i = 0; i < 11; i++) assert.ok((await c.move("down")).ok, `highway step ${i}`);
  return { c, token: welcome.token };
}

// ---- the world and the base ----

test("the overworld has a base icon at the origin with a highway south", () => {
  assert.deepEqual(generateChunk(7, 3, -2), generateChunk(7, 3, -2));
  assert.equal(terrainAt(7, 0, 0), T.BASE_ICON);
  for (let y = 1; y <= 24; y++) assert.equal(terrainAt(7, 0, y), T.ROAD);
  for (const [x, y] of [[1, 0], [-1, 0], [0, -1], [8, 8]]) {
    assert.ok(isPassable(terrainAt(7, x!, y!)), `(${x}, ${y}) near the base is walkable`);
  }
});

test("the base map loads with a walkable entry, respawn and gate roads", () => {
  assert.equal(BASE_MAP.width, 32);
  assert.equal(BASE_MAP.height, 32);
  assert.ok(BASE_MAP.walkable(BASE_MAP.entry.x, BASE_MAP.entry.y));
  assert.ok(BASE_MAP.walkable(BASE_MAP.respawn.x, BASE_MAP.respawn.y));
  for (const [x, y] of [[15, 0], [15, 31], [0, 15], [31, 15]]) assert.ok(BASE_MAP.walkable(x!, y!), `road at (${x}, ${y})`);
  for (const n of BASE_MAP.npcs) assert.ok(!BASE_MAP.walkable(n.x, n.y), `${n.name} blocks their tile`);
});

test("old worlds lose the walled compound and old player tables gain a location", () => {
  const storage = new Storage(join(dir, "old.db"));
  storage.setMeta("seed", "4242"); // An existing world from before world_version existed...
  storage.putChunk(0, 0, new Uint8Array(CHUNK_SIZE * CHUNK_SIZE).fill(T.BASE_WALL)); // ...walls at the origin.
  const world = new World(storage);
  assert.equal(world.tileAt(0, 0), T.BASE_ICON, "regenerated with the base icon");
  assert.equal(storage.getMeta("world_version"), "2");
  storage.close();

  // A v1 players table, without the location columns.
  const legacy = join(dir, "legacy.db");
  const raw = new DatabaseSync(legacy);
  raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '1');
    CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, token TEXT NOT NULL,
      x INTEGER NOT NULL, y INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
    INSERT INTO players (name, token, x, y, created_at, last_seen) VALUES ('Old', 'tok', 5, 7, 0, 0);`);
  raw.close();
  const upgraded = new Storage(legacy);
  const rec = upgraded.findPlayer("old")!;
  assert.deepEqual([rec.loc, rec.x, rec.y], ["overworld", 5, 7]);
  upgraded.close();
});

test("new players start in the base; walking off an edge comes out on that side of the icon", async () => {
  const srv = await boot(":memory:");
  const { c, location } = await enterGame(srv.port, "Walker");
  assert.deepEqual([location.kind, location.x, location.y], ["base", BASE_MAP.entry.x, BASE_MAP.entry.y]);
  assert.equal(Buffer.from(location.tiles, "base64").length, 32 * 32);
  assert.ok(location.npcs.some((n: any) => n.service === "weapons"), "the base has a weapons trader");

  // South gate: out onto (0, 1). Then back onto the icon and in again.
  for (let i = 0; i < 4; i++) await c.move("down");
  let loc = await c.until("location");
  assert.deepEqual([loc.kind, loc.x, loc.y], ["overworld", 0, 1]);
  assert.ok((await c.move("up")).ok, "onto the base icon");
  c.send({ t: "enter" });
  loc = await c.until("location");
  assert.deepEqual([loc.kind, loc.x, loc.y], ["base", BASE_MAP.entry.x, BASE_MAP.entry.y]);

  // West gate: up the courtyard, along it, then out through the gate in row 16.
  for (let i = 0; i < 8; i++) await c.move("up"); // (15, 20)
  for (let i = 0; i < 12; i++) await c.move("left"); // (3, 20)
  for (let i = 0; i < 4; i++) await c.move("up"); // (3, 16)
  for (let i = 0; i < 4; i++) await c.move("left"); // gate, road, road, off the edge
  loc = await c.until("location");
  assert.deepEqual([loc.kind, loc.x, loc.y], ["overworld", -1, 0], "came out west of the base");

  c.send({ t: "enter" });
  assert.match((await c.until("notice")).text, /nothing here/i, "only the icon can be entered");
  await c.close();
  await srv.stop();
});

test("walls and NPCs block movement inside the base", async () => {
  const srv = await boot(":memory:");
  const { c } = await enterGame(srv.port, "Bumper");
  assert.equal((await c.move("left")).ok, false, "Pike the gate guard is in the way");
  let pos: any;
  for (let i = 0; i < 20; i++) pos = await c.move("right");
  assert.deepEqual([pos.x, pos.y, pos.ok], [28, 28, false], "stopped by the east wall");
  await c.close();
  await srv.stop();
});

test("a player's position survives reconnecting and a server restart, inside the base and out", async () => {
  const db = join(dir, "world.db");
  let srv = await boot(db);

  const home = await enterGame(srv.port, "Homebody");
  await home.c.move("up");
  await home.c.close();

  const out = await walkOut(srv.port, "Tester");
  await out.c.close();

  const imposter = await connect(srv.port);
  imposter.send({ t: "hello", v: V, name: "tester", token: "nope" });
  assert.equal((await imposter.until("error")).code, "name_taken", "wrong token for an existing name");

  await srv.stop();
  srv = await boot(db);

  const back = await enterGame(srv.port, "Tester", out.token);
  assert.deepEqual([back.location.kind, back.location.x, back.location.y], ["overworld", 0, 12]);
  await back.c.close();
  const again = await enterGame(srv.port, "Homebody", home.welcome.token);
  assert.deepEqual(
    [again.location.kind, again.location.x, again.location.y],
    ["base", BASE_MAP.entry.x, BASE_MAP.entry.y - 1],
  );
  await again.c.close();
  await srv.stop();
});

test("players see each other only on the same map", async () => {
  const srv = await boot(":memory:");
  const a = await enterGame(srv.port, "Alpha");
  const b = await enterGame(srv.port, "Bravo");
  assert.equal((await b.c.until("player")).id, a.welcome.id, "Bravo sees Alpha in the base");
  assert.equal((await a.c.until("player")).id, b.welcome.id, "Alpha sees Bravo in the base");

  await b.c.move("right");
  const moved = await a.c.until("player");
  assert.deepEqual([moved.id, moved.x, moved.y], [b.welcome.id, BASE_MAP.entry.x + 1, BASE_MAP.entry.y], "base coordinates");

  // Bravo leaves the base: Alpha, still inside, loses sight of them.
  await b.c.move("left");
  for (let i = 0; i < 4; i++) await b.c.move("down");
  await b.c.until("location");
  assert.equal((await a.c.until("player_left")).id, b.welcome.id);

  await b.c.close();
  await a.c.close();
  await srv.stop();
});

test("the world map lists generated chunks and never generates new ones", async () => {
  const srv = await boot(":memory:");
  const { c } = await walkOut(srv.port, "Mapper");

  c.send({ t: "map" });
  const index = await c.until("map_index");
  assert.equal(index.chunks.length, 9, "viewChunks=1 streams a 3x3 block around the player");

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

// ---- characters ----

test("abilities roll 6-18 averaging 12, hit points 6-12", () => {
  let sum = 0;
  const n = 10_000;
  for (let i = 0; i < n; i++) {
    const c = rollCharacter();
    for (const v of [c.str, c.dex, c.int]) {
      assert.ok(v >= 6 && v <= 18, `ability ${v} in 6..18`);
      sum += v;
    }
    assert.ok(c.maxHp >= 6 && c.maxHp <= 12 && c.hp === c.maxHp, `hit points ${c.maxHp} in 6..12`);
    assert.deepEqual([c.level, c.xp, c.points, c.created], [1, 0, 0, false]);
  }
  const avg = sum / (3 * n);
  assert.ok(Math.abs(avg - 12) < 0.15, `average ${avg.toFixed(2)} is about 12`);
});

test("experience levels you up, and each level raises an ability of your choice", () => {
  const c = { ...rollCharacter(), int: 12 }; // No intelligence bonus.
  assert.deepEqual([xpForLevel(2), xpForLevel(3), xpForLevel(4)], [100, 300, 600]);
  assert.equal(raise(c, "str"), false, "no points to spend at level 1");
  assert.deepEqual(gainXp(c, 99), { gained: 99, levels: 0 });
  assert.deepEqual(gainXp(c, 210), { gained: 210, levels: 2 }, "309 XP: straight through level 2 to 3");
  assert.deepEqual([c.level, c.points], [3, 2]);
  const str = c.str;
  const hp = c.maxHp;
  assert.ok(raise(c, "str"));
  assert.ok(raise(c, "hp"));
  assert.deepEqual([c.str, c.maxHp, c.hp, c.points], [str + 2, hp + 2, hp + 2, 0]);
  assert.equal(raise(c, "dex"), false, "points spent");

  const smart = { ...rollCharacter(), int: 32 };
  assert.equal(gainXp(smart, 100).gained, 120, "+1% XP per intelligence above 12");
  const maxed = { ...rollCharacter(), str: 99, points: 2 };
  assert.ok(raise(maxed, "str"));
  assert.equal(maxed.str, 100, "abilities cap at 100");
  assert.equal(raise(maxed, "str"), false);
});

test("a new player rolls, can reroll as often as they like, and enters the world only on accepting", async () => {
  const srv = await boot(":memory:");
  const c = await connect(srv.port);
  c.send({ t: "hello", v: V, name: "Roller" });
  const welcome = await c.until("welcome");
  assert.equal(welcome.character.created, false);
  assert.equal(welcome.character.level, 1);

  c.send({ t: "move", dir: "down", seq: 1 }); // Ignored: not in the world yet.
  for (let i = 0; i < 5; i++) {
    c.send({ t: "reroll" });
    const m = await c.next();
    assert.equal(m.t, "character", "only rolls come back while creating (no location, no move reply)");
    const ch = m.character;
    assert.ok([ch.str, ch.dex, ch.int].every((v: number) => v >= 6 && v <= 18) && ch.maxHp >= 6 && ch.maxHp <= 12);
  }
  c.send({ t: "accept" });
  const accepted = (await c.until("character")).character;
  assert.equal(accepted.created, true);
  const loc = await c.until("location");
  assert.equal(loc.kind, "base");

  c.send({ t: "reroll" }); // Too late: ignored.
  c.send({ t: "map" });
  assert.equal((await c.next()).t, "map_index", "no reroll after accepting");
  await c.close();

  // Reconnecting keeps the accepted character.
  const again = await enterGame(srv.port, "Roller", welcome.token);
  assert.deepEqual(again.welcome.character, accepted);
  await again.c.close();
  await srv.stop();
});

test("exploring new land earns experience", async () => {
  const srv = await boot(":memory:");
  const { c } = await enterGame(srv.port, "Scout");
  for (let i = 0; i < 4; i++) await c.move("down"); // Out of the base: the first chunks anyone has seen.
  const ch = (await c.until("character")).character;
  assert.ok(ch.xp >= XP.explore, `earned ${ch.xp} XP exploring`);
  await c.close();
  await srv.stop();
});

// ---- zombies ----

function zombieWorld(opts: Partial<MonsterOptions> = {}) {
  const storage = new Storage(":memory:");
  const world = new World(storage, 4242);
  return new Monsters(world, { ...DEFAULT_MONSTER_OPTIONS, ...opts });
}

function addZombie(monsters: Monsters, id: number, x: number, y: number, nextStepAt = 0, count = 1) {
  monsters.all.set(id, { id, kind: "zombie", count, x, y, nextStepAt, lastNearPlayerAt: 0 });
}

const hunter = (x: number, y: number, targetable = true) => ({ id: 1, x, y, targetable });

test("zombies spawn just off screen out in the wasteland, never near the base", () => {
  const monsters = zombieWorld({ spawnChance: 1 });
  monsters.tick(0, [hunter(0, 1)]);
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

test("zombies shamble slowly onto players but never next to the base", () => {
  // The highway south of the base (x = 0, y = 1..24) is always walkable.
  const monsters = zombieWorld({ stepMs: 900 });
  addZombie(monsters, 1, 0, 24);
  const z = monsters.all.get(1)!;
  const player = hunter(0, 12);

  monsters.tick(0, [player]);
  assert.equal(z.y, 23, "first step");
  monsters.tick(500, [player]);
  assert.equal(z.y, 23, "no second step before stepMs has passed");
  let contact;
  for (let t = 900; t < 900 * 40 && !contact; t += 900) contact = monsters.tick(t, [player]).contacts[0];
  assert.deepEqual(contact, { playerId: 1, monsterId: 1 }, "reaching the player is a contact");
  assert.equal(z.y, 12, "on the player's tile");

  const safe = zombieWorld();
  addZombie(safe, 1, 0, 9);
  const nearBase = hunter(0, 2);
  for (let t = 0; t < 900 * 20; t += 900) assert.equal(safe.tick(t, [nearBase]).contacts.length, 0);
  assert.equal(safe.all.get(1)!.y, 5, "won't step within 4 tiles of the base");
  assert.ok(inSafeZone(0, 4) && !inSafeZone(0, 5));

  const ignored = zombieWorld();
  addZombie(ignored, 1, 0, 14);
  for (let t = 0; t < 900 * 20; t += 900) ignored.tick(t, [hunter(0, 12, false)]);
  assert.notEqual(ignored.all.get(1)!.y, 12, "untargetable players aren't chased onto");
});

test("each zombie is a pack of 1-15, mostly big", () => {
  const sizes = new Array(17).fill(0);
  let sum = 0;
  for (let i = 0; i < 10_000; i++) {
    const n = rollPackSize();
    sizes[n]++;
    sum += n;
  }
  assert.equal(sizes[0] + sizes[16], 0);
  assert.equal(sizes.slice(1, 16).reduce((a: number, b: number) => a + b, 0), 10_000, "always 1-15");
  const mean = sum / 10_000;
  assert.ok(mean > 7.5 && mean < 9, `average pack ${mean.toFixed(1)} is about 8`);
  assert.ok(sizes[15] > sizes[1] && sizes[8] > sizes[2], "big packs are more likely than small ones");

  const monsters = zombieWorld({ spawnChance: 1 });
  for (let t = 0; t < 20; t++) monsters.tick(t, [hunter(0, 60)]);
  for (const m of monsters.all.values()) assert.ok(m.count >= 1 && m.count <= 15);
});

test("zombies with nobody around eventually despawn", () => {
  const monsters = zombieWorld({ despawnAfterMs: 1000 });
  addZombie(monsters, 1, 0, 20);
  monsters.tick(0, [hunter(0, 15)]);
  assert.equal(monsters.tick(500, []).removed.length, 0);
  assert.deepEqual(monsters.tick(1500, []).removed, [1]);
  assert.equal(monsters.all.size, 0);
});

test("clients see zombies approach, and a zombie reaching the player starts an encounter", async () => {
  const srv = await boot(":memory:", { stepMs: 50 });
  const { c } = await walkOut(srv.port, "Bait");
  addZombie(srv.server.monsters, 1000, 0, 16, Date.now() + 60_000);
  addZombie(srv.server.monsters, 1001, 3, 19, Date.now() + 60_000); // within 8 tiles: joins the fight
  addZombie(srv.server.monsters, 1002, 0, 30, Date.now() + 60_000); // too far: stays on the map
  await c.move("up"); // (0, 11): moving re-syncs nearby monsters
  const seen = await c.until("monster");
  assert.deepEqual([seen.id, seen.count], [1000, 1], "the overworld sees the pack size");

  srv.server.monsters.all.get(1000)!.nextStepAt = 0; // Let it walk (tickMs is 20 in tests).
  const start = await c.until("encounter_start");
  assert.deepEqual([start.x, start.y, start.radius], [0, 11, 8]);
  assert.deepEqual(start.enemies.map((e: any) => [e.id, e.count, e.dx, e.dy]).sort(), [[1000, 1, 0, 0], [1001, 1, 3, 8]]);
  assert.ok(!srv.server.monsters.all.has(1000) && srv.server.monsters.all.has(1002));

  assert.equal((await c.move("down")).ok, false, "no overworld moves mid-fight");
  c.send({ t: "enter" }); // Not on the icon, and mid-fight anyway: ignored.
  await c.close();
  await srv.stop();
});

test("encounters end in victory, flight or death", async () => {
  const srv = await boot(":memory:");
  const { c } = await walkOut(srv.port, "Hero");
  const mons = srv.server.monsters;

  // Walking onto a zombie starts a fight. (Zombies here never step: nextStepAt is far off.)
  addZombie(mons, 1, 0, 13, Date.now() + 60_000);
  addZombie(mons, 2, 2, 16, Date.now() + 60_000);
  await c.move("down");
  let start = await c.until("encounter_start");
  assert.equal(start.enemies.length, 2);

  const before = onlyPlayer(srv.server).char;
  const xpBefore = before.xp;
  const hpBefore = before.hp;
  c.send({ t: "encounter_end", id: start.id, result: "victory", killed: [1, 2], hp: hpBefore - 1 });
  let over = await c.until("encounter_over");
  assert.deepEqual([over.result, over.x, over.y], ["victory", 0, 13]);
  assert.equal(mons.all.size, 0, "the dead stay dead");
  assert.match((await c.until("notice")).text, /XP/);
  let ch = (await c.until("character")).character;
  const bonus = 1 + Math.max(0, ch.int - 12) / 100;
  assert.equal(ch.xp - xpBefore, Math.round((2 * XP.kill + XP.victory) * bonus), "XP for 2 kills and a victory");
  assert.equal(ch.hp, hpBefore - 1, "wounds carry over");

  // Flee south: we come out 3 tiles that way and the survivor goes back to the map.
  await new Promise((r) => setTimeout(r, 350)); // grace period
  addZombie(mons, 3, 0, 14, Date.now() + 60_000);
  addZombie(mons, 4, 0, 19, Date.now() + 60_000);
  await c.move("down");
  start = await c.until("encounter_start");
  c.send({ t: "encounter_end", id: start.id, result: "fled", killed: [3], dir: "down", hp: 999 });
  over = await c.until("encounter_over");
  ch = (await c.until("character")).character;
  assert.equal(ch.hp, hpBefore - 1, "a client can't heal itself by reporting more health");
  assert.deepEqual([over.result, over.x, over.y], ["fled", 0, 17]);
  assert.deepEqual([...mons.all.keys()], [4], "survivor returned to the overworld");
  const back = mons.all.get(4)!;
  assert.deepEqual([back.x, back.y], [0, 19]);

  // Claiming victory with zombies still standing is refused.
  await new Promise((r) => setTimeout(r, 350));
  mons.all.clear();
  addZombie(mons, 5, 0, 18, Date.now() + 60_000);
  await c.move("down");
  start = await c.until("encounter_start");
  c.send({ t: "encounter_end", id: start.id, result: "victory", killed: [] });
  assert.equal((await c.until("error")).code, "bad_message", "can't claim victory with zombies standing");
  await c.close();

  // Die: carried back to the base's infirmary.
  const d = (await walkOut(srv.port, "Doomed")).c;
  mons.all.clear();
  addZombie(mons, 6, 0, 13, Date.now() + 60_000);
  await d.move("down");
  start = await d.until("encounter_start");
  d.send({ t: "encounter_end", id: start.id, result: "died", killed: [], hp: 0 });
  over = await d.until("encounter_over");
  assert.equal(over.result, "died");
  ch = (await d.until("character")).character;
  assert.equal(ch.hp, ch.maxHp, "wake up healed");
  const loc = await d.until("location");
  assert.deepEqual([loc.kind, loc.x, loc.y], ["base", BASE_MAP.respawn.x, BASE_MAP.respawn.y]);
  await d.close();
  await srv.stop();
});

test("packs: every zombie killed earns XP, and partly killed packs come back smaller", async () => {
  const srv = await boot(":memory:");
  const { c } = await walkOut(srv.port, "Hunter");
  const mons = srv.server.monsters;
  addZombie(mons, 1, 0, 13, Date.now() + 60_000, 3); // a pack of 3 (survives, down to 1)
  addZombie(mons, 2, 0, 19, Date.now() + 60_000, 2); // a pack of 2 (wiped out)
  await c.move("down");
  const start = await c.until("encounter_start");
  assert.deepEqual(start.enemies.map((e: any) => [e.id, e.count]).sort(), [[1, 3], [2, 2]]);

  const xpBefore = onlyPlayer(srv.server).char.xp;
  c.send({ t: "encounter_end", id: start.id, result: "fled", killed: [2], remaining: { 1: 1 }, dir: "up" });
  await c.until("encounter_over");
  const ch = (await c.until("character")).character;
  const bonus = 1 + Math.max(0, ch.int - 12) / 100;
  assert.equal(ch.xp - xpBefore, Math.round(4 * XP.kill * bonus), "2 + 2 zombies killed");
  assert.deepEqual([...mons.all.values()].map((m) => [m.id, m.count]), [[1, 1]], "one zombie left of the pack of 3");

  // A pack can't grow back through a report.
  await new Promise((r) => setTimeout(r, 350));
  await c.move("down");
  const again = await c.until("encounter_start");
  c.send({ t: "encounter_end", id: again.id, result: "fled", killed: [], remaining: { 1: 15 }, dir: "up" });
  await c.until("encounter_over");
  assert.equal(mons.all.get(1)!.count, 1);
  await c.close();
  await srv.stop();
});

test("Doc Ellis heals you in the infirmary", async () => {
  const srv = await boot(":memory:");
  const { c } = await enterGame(srv.port, "Patient");
  const p = onlyPlayer(srv.server);
  p.char.hp = 1; // Took a beating out there.
  const doc = BASE_MAP.npcs.find((n) => n.service === "healing")!;
  c.send({ t: "service", npc: doc.id });
  c.send({ t: "map" });
  assert.equal((await c.next()).t, "map_index", "too far away: nothing happens");

  // Respawn point is the cot side of the infirmary, across the counter from the medic.
  p.bx = doc.x - 2;
  p.by = doc.y;
  c.send({ t: "service", npc: doc.id });
  const healed = (await c.until("character")).character;
  assert.equal(healed.hp, healed.maxHp);
  assert.match((await c.until("notice")).text, /patches you up/);
  await c.close();
  await srv.stop();
});

// ---- encampments ----

test("every encampment layout is playable, and the styles and booths vary", () => {
  const styles = new Set<string>();
  const services = new Set<string>();
  const shapes = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const def = campLayout(1000 + i * 37, `Camp ${i}`);
    assert.ok(checkLayout(def), `layout ${i} (${def.style}) is playable`);
    const site = new BaseMap(def, { x: 0, y: 0 }); // throws on a bad entry
    assert.ok(site.npcs.length >= 2 && site.npcs.length <= BOOTH_TYPES.length);
    assert.equal(new Set(site.npcs.map((n) => n.role)).size, site.npcs.length, "no booth type twice in one camp");
    styles.add(def.style);
    shapes.add(def.map.join("\n"));
    for (const n of site.npcs) services.add(n.service);
  }
  assert.deepEqual([...styles].sort(), [...CAMP_STYLES].sort(), "indoor and outdoor styles all turn up");
  assert.equal(services.size, BOOTH_TYPES.length, "every booth type turns up somewhere");
  assert.ok(shapes.size > 290, "layouts differ from camp to camp");
  assert.deepEqual(campLayout(77, "Same"), campLayout(77, "Same"), "a camp's layout comes from its seed");
});

/** Generate the chunks within r of the origin and return the camps founded there. */
function foundCamps(world: World, storage: Storage, r = 5) {
  for (let cy = -r; cy <= r; cy++) for (let cx = -r; cx <= r; cx++) world.chunk(cx, cy);
  return storage.allCamps();
}

test("encampments are founded in new land, away from the base, each with its own name", () => {
  const a = new Storage(join(dir, "camps-a.db"));
  const camps = foundCamps(new World(a, 4242), a);
  assert.ok(camps.length >= 2, `found ${camps.length} camps`);
  const w = new World(a, 4242);
  for (const c of camps) {
    assert.equal(w.tileAt(c.x, c.y), T.CAMP_ICON, `${c.name} has its icon`);
    assert.ok(Math.max(Math.abs(c.x), Math.abs(c.y)) >= CAMP_MIN_BASE_DISTANCE, `${c.name} is clear of the base`);
  }
  assert.equal(new Set(camps.map((c) => c.name.toLowerCase())).size, camps.length, "names are unique");
  assert.equal(a.campsIn(-1000, -1000, 1000, 1000).length, camps.length);
  const b = new Storage(join(dir, "camps-b.db"));
  const again = foundCamps(new World(b, 4242), b);
  assert.deepEqual(again.map((c) => [c.x, c.y, c.name]), camps.map((c) => [c.x, c.y, c.name]), "same seed, same camps");
  a.close();
  b.close();
});

test("players enter an encampment from its icon and leave by walking off its edge", { timeout: 20_000 }, async () => {
  const { port, server, stop } = await boot(join(dir, "camp-walk.db"));
  const { c } = await walkOut(port, "Drifter");
  // One beyond the land already sent on the walk out, so its news arrives when we leave it.
  const far = (v: number) => Math.abs(Math.floor(v / CHUNK_SIZE)) > 1;
  const camp = foundCamps((server as any).world, (server as any).storage).find((k) => far(k.x) || far(k.y))!;
  const p = onlyPlayer(server);
  [p.x, p.y] = [camp.x, camp.y]; // Arrive on the icon.
  c.send({ t: "map" });
  assert.deepEqual((await c.until("map_index")).camps, [], "camps are off the world map until you've been inside");
  c.send({ t: "enter" });
  const loc = await c.until("location");
  assert.deepEqual([loc.kind, loc.name, loc.icon], ["camp", camp.name, { x: camp.x, y: camp.y }]);
  assert.equal(p.loc, `camp:${camp.id}`);

  // Walk the shortest way to an edge, then off it.
  const site = new BaseMap(campLayout(camp.seed, camp.name), camp);
  const dirs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] } as const;
  const prev = new Map<string, [string, string]>();
  const queue: [number, number][] = [[site.entry.x, site.entry.y]];
  const start = `${site.entry.x},${site.entry.y}`;
  let exit: [number, number, string] | undefined;
  while (queue.length && !exit) {
    const [x, y] = queue.shift()!;
    for (const [d, [dx, dy]] of Object.entries(dirs)) {
      const [nx, ny] = [x + dx, y + dy];
      if (!site.inBounds(nx, ny)) { exit = [x, y, d]; break; }
      const k = `${nx},${ny}`;
      if (site.walkable(nx, ny) && !prev.has(k) && k !== start) (prev.set(k, [`${x},${y}`, d]), queue.push([nx, ny]));
    }
  }
  const path: string[] = [exit![2]];
  for (let k = `${exit![0]},${exit![1]}`; prev.has(k); k = prev.get(k)![0]) path.unshift(prev.get(k)![1]);
  for (const d of path.slice(0, -1)) assert.ok((await c.move(d)).ok, `step ${d}`);
  await c.move(path.at(-1)!);
  const out = await c.until("location");
  const [dx, dy] = dirs[path.at(-1) as keyof typeof dirs];
  assert.equal(out.kind, "overworld");
  assert.ok([`${camp.x + dx},${camp.y + dy}`, `${camp.x},${camp.y}`].includes(`${out.x},${out.y}`), "out beside the icon");

  // The client hears about camps in the land it's sent, and the world map now lists this one.
  for (;;) if ((await c.until("camp")).id === camp.id) break;
  c.send({ t: "map" });
  const index = await c.until("map_index");
  assert.ok(index.camps.some((k: any) => k.id === camp.id && k.name === camp.name));
  await c.close();
  await stop();
});
