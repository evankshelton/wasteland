import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { BaseMap } from "../src/base.ts";
import { Battle, HP_PER_ZOMBIE, type CardRef } from "../src/battle.ts";
import { ENEMIES, ENEMY_CARDS, enemyCardView, pickKind } from "../src/enemies.ts";
import { CARDS, DECK_MIN, describe, price, sellPrice, starterKit, terrainCards, updateKit, upgradeCost, view } from "../src/cards.ts";
import { BOOTH_TYPES, CAMP_MIN_BASE_DISTANCE, CAMP_STYLES, campLayout, checkLayout } from "../src/camps.ts";
import { DUNGEON_LEGEND, DUNGEON_MIN_BASE_DISTANCE, checkDungeon, dungeonDepth, dungeonLayout } from "../src/dungeons.ts";
import { XP, gainXp, raise, rollCharacter, xpForLevel } from "../src/character.ts";
import { DEFAULT_MONSTER_OPTIONS, DUNGEON_MONSTER_OPTIONS, Monsters, dungeonGround, inSafeZone, rollGroupSize, rollPackSize, type MonsterOptions } from "../src/monsters.ts";
import { GameServer } from "../src/server.ts";
import { Storage } from "../src/storage.ts";
import { isPassable, T } from "../src/tiles.ts";
import { World } from "../src/world.ts";
import { CHUNK_SIZE, CONTINENTS, continentAt, generateChunk, geology, terrainAt, townIn } from "../src/worldgen.ts";

const dir = mkdtempSync(join(tmpdir(), "wasteland-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const BASE_MAP = BaseMap.load();
const V = 13; // protocol version
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
  // Cards and any card choice come just before the location.
  let cards: any;
  let location: any;
  while (!location) {
    const m = await c.next();
    if (m.t === "cards") cards = m;
    if (m.t === "location") location = m;
  }
  return { c, welcome, location, character, cards };
}

/** Play a battle out: "win" attacks the first standing pack with whatever it can afford; "lose" just ends turns; "flee" runs. Zombie moves go unanswered. */
async function battleOut(c: Client, start: any, mode: "win" | "lose" | "flee"): Promise<any> {
  let b = start.battle;
  for (let i = 0; i < 500 && !b.over; i++) {
    const card = b.hand.find((h: any) => h.playable && h.type === "attack") ?? b.hand.find((h: any) => h.playable && h.cost > 0);
    if (b.respond) c.send({ t: "battle_pass", id: start.id });
    else if (mode === "flee") c.send({ t: "battle_flee", id: start.id });
    else if (mode === "win" && card) c.send({ t: "battle_play", id: start.id, uid: card.uid, target: b.enemies.find((e: any) => e.hp > 0)?.id });
    else c.send({ t: "battle_end_turn", id: start.id });
    b = (await c.until("battle")).battle;
  }
  return b;
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

test("walking about, even onto land nobody has seen, earns no experience", async () => {
  const srv = await boot(":memory:");
  const { c } = await enterGame(srv.port, "Scout");
  // Out of the base and down the highway, through the first chunks anyone has seen: no XP on the way.
  let seq = 1000;
  for (let i = 0; i < 16; i++) {
    c.send({ t: "move", dir: "down", seq: ++seq });
    for (let m = await c.next(); m.t !== "you"; m = await c.next()) {
      assert.ok(!(m.t === "character" && m.character.xp > 0), `earned ${m.character?.xp} XP just walking`);
    }
  }
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
  for (let t = 0; t < 900 * 20; t += 900) {
    ignored.tick(t, [hunter(0, 12, false)]);
    const z = ignored.all.get(1)!;
    assert.ok(z.x !== 0 || z.y !== 12, "untargetable players aren't chased onto (it may wander by)");
  }
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
  assert.deepEqual([start.x, start.y], [0, 11]);
  assert.deepEqual(start.battle.enemies.map((e: any) => [e.id, e.count, e.hp]).sort(), [[1000, 1, HP_PER_ZOMBIE], [1001, 1, HP_PER_ZOMBIE]]);
  assert.equal(start.battle.hand.length >= 5, true, "a hand of cards to start");
  assert.equal(start.battle.player.energy, 3);
  assert.ok(!srv.server.monsters.all.has(1000) && srv.server.monsters.all.has(1002));

  assert.equal((await c.move("down")).ok, false, "no overworld moves mid-fight");
  c.send({ t: "enter" }); // Not on the icon, and mid-fight anyway: ignored.
  await c.close();
  await srv.stop();
});

test("battles end in victory, flight or death, and pay out scrap and loot", async () => {
  const srv = await boot(":memory:");
  const { c } = await walkOut(srv.port, "Hero");
  const mons = srv.server.monsters;
  const p = onlyPlayer(srv.server);
  p.char.maxHp = p.char.hp = 60; // Tough enough to win any fight here.

  // Walking onto a zombie starts a fight. (Zombies here never step: nextStepAt is far off.)
  addZombie(mons, 1, 0, 13, Date.now() + 60_000);
  addZombie(mons, 2, 2, 16, Date.now() + 60_000);
  await c.move("down");
  let start = await c.until("encounter_start");
  assert.equal(start.battle.enemies.length, 2);
  c.send({ t: "battle_play", id: start.id, uid: 999_999 });
  assert.match((await c.until("notice")).text, /isn't in your hand/, "only cards in hand can be played");
  const scrapBefore = p.char.kit.scrap;
  const xpBefore = p.char.xp;
  let b = await battleOut(c, start, "win");
  assert.equal(b.over, "victory");
  let over = await c.until("encounter_over");
  assert.deepEqual([over.result, over.x, over.y], ["victory", 0, 13]);
  assert.equal(mons.all.size, 0, "the dead stay dead");
  assert.match((await c.until("notice")).text, /scrap/);
  assert.ok(p.char.kit.scrap >= scrapBefore + 5 + 2, "scrap for the kills and the win");
  const offer = await c.until("offer");
  assert.equal(offer.reason, "loot");
  assert.equal(offer.cards.length, 3, "three cards to choose from");
  const bonus = 1 + Math.max(0, p.char.int - 12) / 100;
  assert.equal(p.char.xp - xpBefore, Math.round((2 * XP.kill + XP.victory) * bonus), "XP for 2 kills and a victory");
  assert.equal(p.char.hp, b.player.hp, "wounds carry over");
  const owned = p.char.kit.cards.length;
  c.send({ t: "offer_pick", index: 1 });
  const cards = await c.until("cards");
  assert.equal(cards.cards.length, owned + 1, "took the loot");
  assert.ok(cards.cards.some((k: any) => k.card === offer.cards[1].card));

  // Run for it: out a few tiles away from where the packs were (they're south: north it is), and they go back on the map.
  await new Promise((r) => setTimeout(r, 350)); // grace period
  addZombie(mons, 3, 0, 14, Date.now() + 60_000);
  addZombie(mons, 4, 0, 19, Date.now() + 60_000);
  await c.move("down");
  start = await c.until("encounter_start");
  b = await battleOut(c, start, "flee");
  assert.equal(b.over, "fled");
  over = await c.until("encounter_over");
  assert.deepEqual([over.result, over.x, over.y], ["fled", 0, 11]);
  assert.deepEqual([...mons.all.keys()].sort(), [3, 4], "both packs back on the overworld");
  await c.close();

  // Die: carried back to the base's infirmary.
  const d = (await walkOut(srv.port, "Doomed")).c;
  const q = [...(srv.server as any).byPlayerId.values()].find((x: any) => x.player.name === "Doomed").player;
  q.char.hp = 1;
  mons.all.clear();
  addZombie(mons, 6, 0, 13, Date.now() + 60_000, 15);
  await d.move("down");
  start = await d.until("encounter_start");
  b = await battleOut(d, start, "lose");
  assert.equal(b.over, "died");
  over = await d.until("encounter_over");
  assert.equal(over.result, "died");
  assert.equal(q.char.hp, q.char.maxHp, "wake up healed");
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
  assert.deepEqual(start.battle.enemies.map((e: any) => [e.id, e.count]).sort(), [[1, 3], [2, 2]]);

  const p = onlyPlayer(srv.server);
  const xpBefore = p.char.xp;
  const battle: Battle = (srv.server as any).byPlayerId.get(p.id).encounter.battle;
  battle.foes.find((f) => f.id === 1)!.hp = HP_PER_ZOMBIE; // one zombie left
  battle.foes.find((f) => f.id === 2)!.hp = 0;
  battle.flee(); // (straight on the engine: the next message settles it)
  c.send({ t: "battle_flee", id: start.id });
  await c.until("encounter_over");
  const bonus = 1 + Math.max(0, p.char.int - 12) / 100;
  assert.equal(p.char.xp - xpBefore, Math.round(4 * XP.kill * bonus), "2 + 2 zombies killed");
  assert.deepEqual([...mons.all.values()].map((m) => [m.id, m.count]), [[1, 1]], "one zombie left of the pack of 3");
  await c.close();
  await srv.stop();
});

// ---- the card battle engine ----

const fighter = { created: true, level: 1, xp: 0, str: 12, dex: 12, int: 12, maxHp: 10, hp: 10, points: 0 };
const deckOf = (...ids: string[]): CardRef[] => ids.map((card, i) => ({ uid: i + 1, card, level: 0 }));

test("battles: energy pays for cards, attacks wear packs down zombie by zombie, Block soaks hits", () => {
  const b = new Battle({ seed: 1, character: fighter, deck: deckOf("swing", "swing", "swing", "brace", "brace", "hunting_rifle"), terrain: [], packs: [{ id: 7, count: 4 }] });
  b.foes[0]!.reaction = undefined;
  const v = b.view();
  assert.deepEqual([v.player.energy, v.hand.length, v.enemies[0]!.hp, v.enemies[0]!.count], [3, 5, 4 * HP_PER_ZOMBIE, 4]);
  // Spend energy until a card can't be afforded.
  let spent = 0;
  for (const card of [...b.hand]) {
    const cost = CARDS.get(card.card)!.levels[0]!.cost;
    const why = b.play(card.uid, 7);
    if (spent + cost > 3) assert.equal(why, "Not enough energy.");
    else spent += cost;
  }
  assert.equal(b.energy, 3 - spent);
  // Damage takes zombies off the pack.
  const foe = b.foes[0]!;
  foe.hp = 4 * HP_PER_ZOMBIE;
  foe.block = 0;
  (b as any).hurtFoe(foe, HP_PER_ZOMBIE);
  assert.equal(b.view().enemies[0]!.count, 3, "one zombie's worth of damage on a pack of 4 kills one");
  // Block soaks an attack, the rest gets through.
  b.block = 2;
  foe.intent = { card: "claw", name: "Claw", damage: 3 };
  foe.status.weak = 0;
  b.endTurn();
  assert.equal(b.hp, 9, "3 damage, 2 blocked");
  assert.equal(b.block, 0, "Block is gone by the next turn");
  assert.equal(b.energy, 3, "energy back for the next turn");
});

test("battles: Weak, Vulnerable, Poison, Strength and Thorns", () => {
  const b = new Battle({ seed: 2, character: { ...fighter, str: 21 }, deck: deckOf(...Array(10).fill("swing")), terrain: [], packs: [{ id: 1, count: 10 }] });
  assert.equal(b.status.strength, 2, "strength 21 gives 2 Strength");
  const foe = b.foes[0]!;
  const hit = (dmg: number) => {
    const before = foe.hp;
    (b as any).hurtFoe(foe, dmg);
    return before - foe.hp;
  };
  foe.status.vulnerable = 1;
  assert.equal(hit(4), 6, "Vulnerable takes 50% more");
  foe.status.vulnerable = 0;
  // Poison ticks at the end of the zombies' turn, one less each time.
  foe.status.poison = 3;
  foe.intent = { card: "close_ranks", name: "Close Ranks", block: 0 };
  const before = foe.hp;
  b.endTurn();
  assert.equal(before - foe.hp, 3);
  assert.equal(foe.status.poison, 2);
  // Weak zombies hit for 25% less; Thorns hurt them back.
  foe.status.weak = 2;
  foe.intent = { card: "claw", name: "Claw", damage: 4 };
  b.status.thorns = 1;
  b.block = 0;
  const hp = b.hp;
  const fhp = foe.hp;
  b.endTurn();
  assert.equal(hp - b.hp, 3, "4 damage, weakened to 3");
  assert.equal(fhp - foe.hp, 1 + 2, "1 from Thorns, then 2 Poison");
  assert.match(describe(CARDS.get("swing")!.levels[0]!, { strength: 2 }), /Deal 4 damage/, "card text shows Strength");
});

test("battles are decided: victory when every pack is down, death at 0 HP, and they replay exactly from the seed", () => {
  const setup = { seed: 42, character: fighter, deck: deckOf("swing", "swing", "brace", "pipe_swing", "brace", "swing", "swing", "brace"), terrain: ["take_cover"], packs: [{ id: 1, count: 2 }, { id: 2, count: 3 }] };
  assert.deepEqual(new Battle(setup).view(), new Battle(setup).view(), "same seed, same battle");
  const b = new Battle({ ...setup, deck: deckOf(...Array(8).fill("swing")) });
  for (const f of b.foes) {
    f.hp = 1;
    f.reaction = undefined;
  }
  b.energy = 10;
  b.play(b.hand[0]!.uid, 1);
  assert.equal(b.view().over, undefined, "one pack still standing");
  b.play(b.hand[0]!.uid, 2);
  assert.equal(b.view().over, "victory");
  const d = new Battle({ ...setup, character: { ...fighter, hp: 1 } });
  for (const f of d.foes) f.intent = { card: "claw", name: "Claw", damage: 5 };
  d.endTurn();
  while (d.respond) d.pass(); // (a Take Cover in hand is a Reaction: don't answer)
  assert.equal(d.view().over, "died");
  assert.equal(new Battle(setup).view().drawPile + 5, 9, "the terrain card joins the draw pile");
});

test("the ground gives cards: ruins give cover, the woods a branch, the dungeon a cave-in", () => {
  assert.deepEqual(terrainCards([...Array(30).fill("ruins"), ...Array(19).fill("road")]), ["take_cover", "take_cover", "wreck_barricade", "wreck_barricade"]);
  assert.deepEqual(terrainCards([...Array(40).fill("wasteland"), ...Array(4).fill("dead_forest"), "water"]), ["dust_kick", "dust_kick", "snapped_branch"]);
  assert.deepEqual(terrainCards(Array(49).fill("cave_floor")), ["cave_in", "cave_in"]);
  assert.deepEqual(terrainCards(["water", "water"]), [], "not enough of anything");
});

// ---- cards: the kit, shops and offers ----

test("every survivor starts with a deck, and keeps at least the minimum in it", async () => {
  const srv = await boot(":memory:");
  const { c, cards } = await enterGame(srv.port, "Rookie");
  assert.equal(cards.scrap, 40);
  assert.deepEqual(cards.cards.map((k: any) => k.card).sort(), [...Array(3).fill("brace"), "duck", "pipe_swing", "scrap_vest", ...Array(5).fill("swing")].sort());
  assert.ok(cards.cards.every((k: any) => k.deck && k.text.length > 0));
  // Take cards out until only the minimum is left: the next one is refused.
  let last: any;
  const spare = cards.cards.length - DECK_MIN;
  for (const k of cards.cards.slice(0, spare)) {
    c.send({ t: "deck_set", uid: k.uid, deck: false });
    last = await c.until("cards");
  }
  assert.equal(last.cards.filter((k: any) => k.deck).length, DECK_MIN);
  c.send({ t: "deck_set", uid: cards.cards[spare].uid, deck: false });
  assert.match((await c.until("notice")).text, /at least/);
  assert.equal((await c.until("cards")).cards.filter((k: any) => k.deck).length, DECK_MIN, "still the minimum");
  // And back in again.
  c.send({ t: "deck_set", uid: cards.cards[0].uid, deck: true });
  assert.equal((await c.until("cards")).cards.filter((k: any) => k.deck).length, DECK_MIN + 1);
  await c.close();
  await srv.stop();
});

test("shops: buy from the quartermaster, sell anywhere, train abilities with the sergeant", async () => {
  const srv = await boot(":memory:");
  const { c } = await enterGame(srv.port, "Shopper");
  const p = onlyPlayer(srv.server);
  p.char.kit.scrap = 1000;
  const standBy = (service: string) => {
    const npc = BASE_MAP.npcs.find((n) => n.service === service)!;
    const spot = [[0, 1], [0, -1], [1, 0], [-1, 0], [0, 2], [0, -2], [2, 0], [-2, 0]].find(([dx, dy]) => BASE_MAP.walkable(npc.x + dx!, npc.y + dy!))!;
    [p.bx, p.by] = [npc.x + spot[0]!, npc.y + spot[1]!];
    return npc;
  };
  const rourke = standBy("weapons");
  c.send({ t: "service", npc: rourke.id });
  let shop = await c.until("shop");
  assert.equal(shop.title, "Weapons");
  assert.ok(shop.stock.length >= 4 && shop.stock.every((k: any) => CARDS.get(k.card)!.slot === "weapon"), "weapons on the shelves");
  const item = shop.stock[0];
  c.send({ t: "shop_buy", npc: rourke.id, index: 0 });
  let cards = await c.until("cards");
  assert.equal(cards.scrap, 1000 - item.price);
  assert.equal(item.price, price(item.card, item.level));
  const bought = cards.cards.find((k: any) => k.card === item.card && k.level === item.level);
  assert.ok(bought, "it's yours");
  shop = await c.until("shop");
  // Sell it back (for less).
  const offer = shop.sell.find((x: any) => x.uid === bought.uid);
  assert.equal(offer.price, sellPrice(item.card, item.level, false));
  c.send({ t: "shop_sell", npc: rourke.id, uid: bought.uid });
  cards = await c.until("cards");
  assert.equal(cards.scrap, 1000 - item.price + offer.price);
  assert.ok(!cards.cards.some((k: any) => k.uid === bought.uid));
  await c.until("shop"); // the quartermaster's shelves again

  // The sergeant teaches abilities and trains cards up: Swing becomes Swing+.
  const sarge = standBy("training");
  c.send({ t: "service", npc: sarge.id });
  shop = await c.until("shop");
  assert.equal(shop.buyLabel, "Learn");
  assert.ok(shop.stock.every((k: any) => CARDS.get(k.card)!.kind === "ability"));
  const swing = cards.cards.find((k: any) => k.card === "swing");
  const up = shop.upgrade.find((x: any) => x.uid === swing.uid);
  assert.equal(up.price, upgradeCost("swing", 0));
  assert.equal(up.next.name, "Swing+");
  c.send({ t: "shop_upgrade", npc: sarge.id, uid: swing.uid });
  cards = await c.until("cards");
  const trained = cards.cards.find((k: any) => k.uid === swing.uid);
  assert.deepEqual([trained.name, trained.level, trained.text], ["Swing+", 1, view("swing", 1).text]);

  // Out of reach: nothing doing.
  p.bx = BASE_MAP.entry.x;
  p.by = BASE_MAP.entry.y;
  c.send({ t: "shop_buy", npc: rourke.id, index: 0 });
  c.send({ t: "map" });
  assert.equal((await c.until("map_index")).t, "map_index");
  assert.equal(p.char.kit.cards.length, starterKit().cards.length, "no sale from across the base");
  await c.close();
  await srv.stop();
});

test("levelling up offers a new ability card to learn", async () => {
  const srv = await boot(":memory:");
  const { c } = await enterGame(srv.port, "Learner");
  (srv.server as any).award((srv.server as any).byPlayerId.get(onlyPlayer(srv.server).id), 100, "test");
  const offer = await c.until("offer");
  assert.equal(offer.reason, "level");
  assert.ok(offer.cards.every((k: any) => CARDS.get(k.card)!.kind === "ability"));
  c.send({ t: "offer_pick", index: -1 }); // No thanks.
  const cards = await c.until("cards");
  assert.equal(cards.cards.length, starterKit().cards.length);
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

// ---- dungeons ----

test("every dungeon level is a walled-in labyrinth of rooms, doors and passages, all reachable", () => {
  const shapes = new Set<string>();
  const depths = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const seed = 5000 + i * 41;
    const depth = dungeonDepth(seed);
    depths.add(depth);
    const level = 1 + (i % depth);
    const def = dungeonLayout(seed, `Dungeon ${i}`, level, depth);
    assert.ok(checkDungeon(def), `layout ${i} is playable`);
    const site = new BaseMap(def, { x: 0, y: 0 }); // throws on a bad entry
    const text = def.map.join("\n");
    assert.ok(def.rooms.length >= 5, "several rooms");
    assert.ok((text.match(/\+/g) ?? []).length >= def.rooms.length, "doors into every room");
    const at = (q: { x: number; y: number }) => site.tiles[q.y * site.width + q.x]!;
    // The first level has the ladder you came down, the others stairs back up; every level but the last has
    // stairs down; the last has stairs out.
    const ways = [...site.exits.map(at), ...site.down.map(at), ...site.up.map(at)].sort();
    const want = [level === 1 ? T.LADDER : T.STAIRS_UP, level < depth ? T.STAIRS_DOWN : T.STAIRS_OUT].sort();
    assert.deepEqual(ways, want, `level ${level} of ${depth} has the right ways up, down and out`);
    // Passages: open tiles outside every room.
    const inRoom = (x: number, y: number) => site.rooms.some((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
    let passage = 0;
    for (let y = 0; y < site.height; y++) for (let x = 0; x < site.width; x++) if (site.walkable(x, y) && !inRoom(x, y)) passage++;
    assert.ok(passage > 40, `winding passages between the rooms (${passage} tiles)`);
    shapes.add(text);
  }
  assert.equal(shapes.size, 200, "every dungeon is different");
  assert.deepEqual([...depths].sort(), [5, 6, 7, 8, 9], "dungeons are 5 to 9 levels deep");
  assert.deepEqual(dungeonLayout(9, "Same", 2), dungeonLayout(9, "Same", 2), "a level's layout comes from the seed and level");
  assert.notDeepEqual(dungeonLayout(9, "Same", 1).map, dungeonLayout(9, "Same", 2).map, "each level is different");
});

test("dungeon entrances are dug into mountainsides in new land, away from the base", () => {
  const storage = new Storage(join(dir, "dungeons.db"));
  const world = new World(storage, 4242);
  let found = 0;
  for (let cy = -6; cy <= 6; cy++) {
    for (let cx = -6; cx <= 6; cx++) {
      const tiles = world.chunk(cx, cy);
      tiles.forEach((t, i) => {
        if (t !== T.DUNGEON_ICON) return;
        const x = cx * CHUNK_SIZE + (i % CHUNK_SIZE);
        const y = cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        const d = storage.dungeonAt(x, y);
        assert.ok(d, `the entrance at (${x}, ${y}) is on record`);
        assert.ok(Math.hypot(x, y) >= DUNGEON_MIN_BASE_DISTANCE, "clear of the base");
        const around = [world.tileAt(x + 1, y), world.tileAt(x - 1, y), world.tileAt(x, y + 1), world.tileAt(x, y - 1)];
        assert.ok(around.includes(T.MOUNTAINS), `the entrance at (${x}, ${y}) is dug into a mountainside`);
        found++;
      });
    }
  }
  assert.ok(found >= 2, `found ${found} dungeons`);
  storage.close();
});

test("dungeon zombies find their way through the passages to you", () => {
  // Passages looping round: straight at the player is a wall, so they have to go round.
  const site = new BaseMap({
    name: "U", legend: DUNGEON_LEGEND, entry: [13, 5], respawn: [13, 5], rooms: [], npcs: [], exits: [[12, 5]], down: [], up: [],
    map: [
      "###############",
      "#.........#####",
      "#.#######.#####",
      "#.#.....#.#####",
      "#.#.###.#.#####",
      "#...#.#...##L.#",
      "###############",
    ],
  });
  const mobs = new Monsters(dungeonGround(site), { ...DEFAULT_MONSTER_OPTIONS, ...DUNGEON_MONSTER_OPTIONS, spawnChance: 0 });
  addZombie(mobs, 1, 9, 5);
  const player = { id: 1, x: 3, y: 5, targetable: true }; // just the other side of the wall at (4, 5)
  let contact = false;
  for (let t = 1; t < 60 && !contact; t++) contact = mobs.tick(t * 1000, [player]).contacts.length > 0;
  assert.ok(contact, "the zombie came round the long way and reached the player");
});

test("players go down into a dungeon, fight what's there, and climb back out", { timeout: 20_000 }, async () => {
  const { port, server, stop } = await boot(join(dir, "dungeon-walk.db"));
  const { c } = await walkOut(port, "Delver");
  const srv = server as any;
  for (let cy = -6; cy <= 6; cy++) for (let cx = -6; cx <= 6; cx++) srv.world.chunk(cx, cy);
  let hole: { x: number; y: number } | undefined;
  for (let cy = -6; cy <= 6 && !hole; cy++) {
    for (let cx = -6; cx <= 6 && !hole; cx++) {
      const i = srv.world.chunk(cx, cy).indexOf(T.DUNGEON_ICON);
      if (i >= 0) hole = { x: cx * CHUNK_SIZE + (i % CHUNK_SIZE), y: cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE) };
    }
  }
  const d = srv.storage.dungeonAt(hole!.x, hole!.y);
  const p = onlyPlayer(server);
  [p.x, p.y] = [d.x, d.y];
  c.send({ t: "enter" });
  const loc = await c.until("location");
  const depth = dungeonDepth(d.seed);
  assert.deepEqual([loc.kind, loc.site, loc.name, loc.icon], ["dungeon", `dungeon:${d.id}:1`, `${d.name}, Level 1 of ${depth}`, { x: d.x, y: d.y }]);
  const site = new BaseMap(dungeonLayout(d.seed, d.name, 1, depth), d);
  assert.deepEqual([loc.x, loc.y], [site.entry.x, site.entry.y], "arrived by the ladder");

  // A zombie in the next tile along: walking into it starts a fight down here.
  const mobs: Monsters = srv.mobsFor(`dungeon:${d.id}:1`);
  const dirs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] } as const;
  const [way, [dx, dy]] = Object.entries(dirs).find(([, [x, y]]) => site.walkable(site.entry.x + x, site.entry.y + y) && !site.isExit(site.entry.x + x, site.entry.y + y))!;
  addZombie(mobs, 9001, site.entry.x + dx, site.entry.y + dy, Date.now() + 60_000, 3);
  await c.move(way);
  p.char.maxHp = p.char.hp = 60;
  const start = await c.until("encounter_start");
  assert.deepEqual([start.x, start.y], [site.entry.x + dx, site.entry.y + dy], "the fight is where we stand in the dungeon");
  assert.equal(start.battle.enemies[0].count, 3);
  assert.ok(start.battle.terrain.includes("cave_in"), "the tunnels give you a cave-in");
  assert.equal((await battleOut(c, start, "win")).over, "victory");
  const over = await c.until("encounter_over");
  assert.equal(p.loc, `dungeon:${d.id}:1`, "still down in the dungeon after the fight");
  assert.deepEqual([over.x, over.y], [p.bx, p.by]);

  // Back to the ladder and up it.
  await new Promise((r) => setTimeout(r, 350));
  const back = Object.entries(dirs).find(([, [x, y]]) => x === -dx && y === -dy)![0];
  await c.move(back);
  const ladder = site.exits[0]!;
  const toLadder = Object.entries(dirs).find(([, [x, y]]) => p.bx + x === ladder.x && p.by + y === ladder.y)![0];
  await c.move(toLadder);
  const out = await c.until("location");
  assert.equal(out.kind, "overworld");
  assert.ok(Math.abs(out.x - d.x) + Math.abs(out.y - d.y) <= 1, "out beside the entrance");

  // Back down, then stairs after stairs to the bottom, and out of the far end.
  [p.x, p.y] = [d.x, d.y];
  c.send({ t: "enter" });
  await c.until("location");
  for (let level = 1; level <= depth; level++) {
    const here = srv.siteOf(p.loc) as BaseMap;
    const way = level < depth ? here.down[0]! : here.exits[here.exits.length - 1]!;
    const [step, [sx, sy]] = Object.entries(dirs).find(([, [x, y]]) => here.walkable(way.x - x, way.y - y))!;
    [p.bx, p.by] = [way.x - sx, way.y - sy]; // stand next to the stairs
    await c.move(step);
    const next = await c.until("location");
    if (level < depth) {
      assert.deepEqual([next.kind, next.site, next.name], ["dungeon", `dungeon:${d.id}:${level + 1}`, `${d.name}, Level ${level + 1} of ${depth}`]);
      const below = srv.siteOf(next.site) as BaseMap;
      assert.deepEqual([next.x, next.y], [below.entry.x, below.entry.y], "down the stairs to the landing below");
    } else {
      assert.equal(next.kind, "overworld", "the stairs at the bottom lead out of the dungeon");
      assert.ok(Math.abs(next.x - d.x) + Math.abs(next.y - d.y) <= 1, "out beside the entrance");
    }
  }

  // Down a level, back up the stairs, and out by the ladder: the way you came.
  [p.x, p.y] = [d.x, d.y];
  c.send({ t: "enter" });
  await c.until("location");
  const stepOnto = async (way: { x: number; y: number }) => {
    const here = srv.siteOf(p.loc) as BaseMap;
    const [step, [sx, sy]] = Object.entries(dirs).find(([, [x, y]]) => here.walkable(way.x - x, way.y - y))!;
    [p.bx, p.by] = [way.x - sx, way.y - sy];
    await c.move(step);
    return c.until("location");
  };
  const top = srv.siteOf(p.loc) as BaseMap;
  await stepOnto(top.down[0]!);
  const second = srv.siteOf(p.loc) as BaseMap;
  assert.equal(second.up.length, 1, "stairs back up on level 2");
  const up = await stepOnto(second.up[0]!);
  assert.equal(up.site, `dungeon:${d.id}:1`, "up the stairs to level 1");
  assert.ok(Math.abs(up.x - top.down[0]!.x) + Math.abs(up.y - top.down[0]!.y) === 1, "arrived beside the stairs down");
  const out2 = await stepOnto(top.exits[0]!);
  assert.equal(out2.kind, "overworld", "and out by the ladder");
  await c.close();
  await stop();
});

test("fleeing a battle costs only a glancing blow from each pack", () => {
  const b = new Battle({ seed: 3, character: fighter, deck: deckOf(...Array(8).fill("swing")), terrain: [], packs: [{ id: 1, count: 15 }, { id: 2, count: 15 }] });
  for (const f of b.foes) f.intent = { card: "claw", name: "Claw", damage: 5 };
  b.flee();
  assert.equal(b.view().over, "fled");
  assert.equal(b.hp, 10 - 3 - 3, "two packs hitting for 5, halved (rounded up) as you run");
});

// ---- the stack: reactions, answers, counters and allies ----

/** A battle against one pack with a known hand (and plenty of cards behind it). */
function stackBattle(hand: string[], count = 6, reaction?: Battle["foes"][number]["reaction"]): Battle {
  const b = new Battle({ seed: 5, character: fighter, deck: deckOf(...Array(12).fill("swing")), terrain: [], packs: [{ id: 1, count }] });
  b.discard.push(...b.hand);
  b.hand = hand.map((card, i) => ({ uid: 100 + i, card, level: 0 }));
  b.foes[0]!.reaction = reaction;
  b.foes[0]!.intent = { card: "claw", name: "Claw", damage: 4 };
  return b;
}

test("packs react to your cards before they land, once a round", () => {
  const b = stackBattle(["swing", "swing"], 6, { card: "lurch", name: "Lurch", trigger: "attacked", block: 2 });
  const foe = b.foes[0]!;
  b.play(100, 1);
  assert.equal(foe.hp, 12, "the pack lurched first: 2 Block soaked the 2 damage");
  assert.match(b.log.join(" "), /gains 2 Block/);
  b.play(101, 1);
  assert.equal(foe.hp, 10, "no reaction left this round");
  assert.equal(b.view().enemies[0]!.reaction!.ready, false);

  const s = stackBattle(["swing"], 6, { card: "swarm", name: "Swarm", trigger: "attacked", strike: 3 });
  s.play(100, 1);
  assert.equal(s.hp, 7, "the pack clawed back before the swing landed");
  assert.equal(s.foes[0]!.hp, 10);
});

test("Reactions answer the zombies' moves on their turn; Actions can't", () => {
  const b = stackBattle(["duck", "swing"]);
  b.energy = 2;
  b.endTurn();
  let v = b.view();
  assert.equal(v.phase, "zombies");
  assert.equal(v.respond, true, "the attack waits on the stack for an answer");
  assert.deepEqual(v.stack.map((i) => i.name), ["Zombies A: Claw"]);
  assert.equal(v.hand.find((c) => c.card === "swing")!.playable, false, "an Action can't answer");
  assert.equal(b.play(101, 1), "Only a Reaction can answer that.");
  assert.equal(b.play(100), undefined);
  v = b.view();
  assert.equal(v.phase, "you", "the stack landed and your next turn began");
  assert.equal(b.hp, 9, "4 damage, 3 ducked");
  assert.equal(b.energy, 3);

  // Pass instead and it lands in full.
  const p = stackBattle(["duck"]);
  p.endTurn();
  assert.equal(p.respond, true);
  assert.equal(p.pass(), undefined);
  assert.equal(p.hp, 6);

  // With no energy left (or no Reactions) the zombies just get on with it.
  const q = stackBattle(["duck"]);
  q.energy = 0;
  q.endTurn();
  assert.equal(q.respond, false);
  assert.equal(q.hp, 6);
});

test("counters: Sidestep cancels an attack, Trip Up cancels a pack's reaction", () => {
  const b = stackBattle(["sidestep"]);
  b.endTurn();
  b.play(100);
  assert.equal(b.hp, 10, "the attack was countered");
  assert.match(b.log.join(" "), /countered/);

  // Duck!, the pack grabs it, Trip Up answers the grab: the Block lands after all.
  const g = stackBattle(["duck", "trip_up"], 6, { card: "grab", name: "Grab", trigger: "block_card", counter: true });
  g.endTurn();
  g.play(100);
  assert.equal(g.respond, true, "the grab is on top of the stack, waiting for an answer");
  assert.deepEqual(g.view().stack.map((i) => i.name), ["Zombies A: Claw", "Duck!", "Zombies A: Grab"]);
  g.play(101);
  assert.equal(g.hp, 9, "Duck! landed: 4 damage, 3 blocked");

  // Counters only answer the right thing.
  const t = stackBattle(["trip_up"]);
  t.endTurn();
  assert.equal(t.respond, false, "Trip Up can't answer an attack, so nothing waits");
});

test("allies join the fight, attack the marked pack, draw attacks with Guard, and go down", () => {
  const b = stackBattle(["stray_dog", "militia"], 10);
  b.play(100);
  b.play(101);
  assert.deepEqual(b.allies.map((a) => a.name), ["Stray Dog", "Militia Recruit"]);
  assert.equal(b.energy, 0);
  const foe = b.foes[0]!;
  foe.intent = { card: "claw", name: "Claw", damage: 5 };
  b.endTurn();
  assert.equal(foe.hp, 20 - 2 - 2, "both allies attacked");
  assert.equal(b.hp, 10, "the guard took the hit");
  assert.deepEqual(b.allies.map((a) => a.name), ["Stray Dog"], "5 damage was too much for the recruit");
  assert.ok(b.discard.some((c) => c.uid === 101), "a fallen ally's card goes to the discard pile");
});

test("decks from before Reactions get a Duck!, once", () => {
  const kit = starterKit();
  kit.cards = kit.cards.filter((c) => c.card !== "duck");
  assert.equal(updateKit(kit), true);
  assert.equal(kit.cards.filter((c) => c.card === "duck").length, 1);
  assert.equal(updateKit(kit), false);
  assert.equal(view("trip_up", 0).speed, "reaction");
  assert.equal(view("stray_dog", 1).power, 3);
  assert.match(view("riposte", 0).text, /to the pack you answer/);
});

// ---- other enemies ----

/** A battle against one group of `kind`, playing `move` next, with a known hand. */
function enemyBattle(kind: string, count: number, move: string, hand: string[] = []): Battle {
  const b = new Battle({ seed: 9, character: { ...fighter, hp: 20, maxHp: 20 }, deck: deckOf(...Array(12).fill("swing")), terrain: [], packs: [{ id: 1, kind, count }] });
  b.discard.push(...b.hand);
  b.hand = hand.map((card, i) => ({ uid: 100 + i, card, level: 0 }));
  const f = b.foes[0]!;
  f.reaction = undefined;
  f.intent = { card: move, name: ENEMY_CARDS.get(move)!.name };
  Object.assign(f.intent, Object.fromEntries(Object.entries(ENEMY_CARDS.get(move)!).filter(([k]) => ["damage", "hits", "all", "block", "weak", "vulnerable", "poison", "discard", "strength", "heal", "summon"].includes(k)).map(([k, v]) => [k, typeof v === "object" ? (v as any).base + Math.floor(count / (v as any).per) : v])));
  return b;
}

test("every kind of enemy has a deck of moves that fits it, and sizes and health of its own", () => {
  for (const e of ENEMIES.values()) {
    assert.ok(e.moves.length >= 4 && e.reactions.length >= 3, `${e.kind} has moves and reactions`);
    for (let i = 0; i < 50; i++) {
      const n = rollGroupSize(e.kind);
      if (e.size) assert.ok(n >= e.size[0] && n <= e.size[1], `${e.kind} group of ${n}`);
    }
    const b = new Battle({ seed: 3, character: fighter, deck: deckOf(...Array(8).fill("swing")), terrain: [], packs: [{ id: 1, kind: e.kind, count: 4 }] });
    const v = b.view().enemies[0]!;
    assert.equal(v.hp, 4 * e.hp);
    assert.equal(v.sprite, e.sprite);
    assert.ok(e.moves.some((m) => m.id === v.intent.card), `${e.kind} shows one of its own moves`);
    assert.ok(v.cards.length >= e.moves.length && v.cards.every((c) => c.kind === "enemy" && c.text.length > 0));
  }
  assert.match(enemyCardView(ENEMY_CARDS.get("return_fire")!, 4, ENEMIES.get("raider")!).text, /When attacked, it hits the attacker for 3 first/);
  assert.match(enemyCardView(ENEMY_CARDS.get("breed")!, 8, ENEMIES.get("rats")!).text, /3 more rats join/);
});

test("they turn up where they belong: crawlers and rats underground, hounds in the scrub, ghouls in the hot zones", () => {
  let seed = 1;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tally = (dungeon: boolean, key: string) => {
    const n = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const k = pickKind(dungeon, key, rng);
      n.set(k, (n.get(k) ?? 0) + 1);
    }
    return n;
  };
  const under = tally(true, "cave_floor");
  assert.equal(under.get("hound") ?? 0, 0, "no hounds underground");
  assert.ok((under.get("crawler") ?? 0) > 100 && (under.get("rats") ?? 0) > 200);
  const scrub = tally(false, "scrub");
  assert.equal(scrub.get("crawler") ?? 0, 0, "no crawlers in the open");
  assert.ok((scrub.get("hound") ?? 0) > (tally(false, "road").get("hound") ?? 0), "hounds favour the scrub");
  assert.ok((tally(false, "radiation").get("ghoul") ?? 0) > 3 * (tally(false, "water").get("ghoul") ?? 0), "ghouls favour the hot zones");
});

test("enemy moves: ghouls pulse everyone, rats breed, ghouls feed only when hurt, raiders disarm you", () => {
  const g = enemyBattle("ghoul", 2, "rad_pulse", ["stray_dog"]);
  g.play(100);
  g.endTurn();
  assert.equal(g.hp, 20 - 2, "the pulse hit you");
  assert.equal(g.allies.length, 0, "and the dog, which went down");

  const r = enemyBattle("rats", 4, "breed");
  r.endTurn();
  assert.equal(r.view().enemies[0]!.count, 6, "4 rats bred 2 more");

  const f = enemyBattle("ghoul", 2, "feed");
  f.foes[0]!.hp = 7;
  f.endTurn();
  assert.equal(f.foes[0]!.hp, 11, "fed for 4");
  for (let i = 0; i < 20; i++) {
    f.foes[0]!.hp = f.foes[0]!.maxHp;
    f.foes[0]!.intent = (f as any).chooseIntent(f.foes[0]!);
    assert.notEqual(f.foes[0]!.intent.card, "feed", "no feeding at full health");
  }

  const d = enemyBattle("raider", 2, "disarm", ["duck", "pistol"]);
  d.energy = 0;
  d.endTurn();
  assert.equal(d.respond, true, "a Pistol costs nothing, so it could still answer");
  d.pass();
  assert.match(d.log.join(" "), /You drop (Duck!|Pistol)/);
});

test("enemy reactions: raiders pin down your Reactions, crawlers spit venom at whoever hits them", () => {
  const b = enemyBattle("raider", 3, "gunfire", ["duck"]);
  b.foes[0]!.reaction = { card: "suppressing_fire", name: "Suppressing Fire", trigger: "reaction_card", counter: true };
  b.endTurn();
  assert.equal(b.respond, true);
  b.play(100);
  assert.equal(b.hp, 20 - 2, "Duck! was countered, so all of the Gunfire landed");
  assert.match(b.log.join(" "), /Suppressing Fire stops Duck!/);

  const c = enemyBattle("crawler", 1, "lurk", ["swing"]);
  c.foes[0]!.reaction = { card: "spit_venom", name: "Spit Venom", trigger: "attacked", poison: 2 };
  c.play(100, 1);
  assert.equal(c.status.poison, 2);
});

// ---- continents ----

test("the world is continents with open sea between them, and the base stands well inland", () => {
  for (const seed of [12345, 777, 4242]) {
    // Inland: no sea anywhere near the base.
    for (let a = 0; a < 64; a++) {
      for (const r of [0, 100, 250]) {
        const x = Math.round(Math.cos((a / 64) * 2 * Math.PI) * r);
        const y = Math.round(Math.sin((a / 64) * 2 * Math.PI) * r);
        assert.ok(continentAt(seed, x, y) > CONTINENTS.sea + CONTINENTS.beach, `seed ${seed}: land at (${x}, ${y})`);
      }
    }
    // Far and wide: lots of sea, much of it deep, and other continents across it.
    let sea = 0, deep = 0, n = 0, farLand = 0;
    for (let y = -4000; y <= 4000; y += 40) {
      for (let x = -4000; x <= 4000; x += 40) {
        const t = terrainAt(seed, x, y);
        n++;
        if (t === T.WATER || t === T.DEEP_WATER) sea++;
        if (t === T.DEEP_WATER) deep++;
        if (Math.hypot(x, y) > 2200 && t !== T.WATER && t !== T.DEEP_WATER && t !== T.BRIDGE) farLand++;
      }
    }
    assert.ok(sea / n > 0.3 && sea / n < 0.75, `seed ${seed}: ${Math.round((100 * sea) / n)}% sea`);
    assert.ok(deep / sea > 0.5, `seed ${seed}: most of the sea is open, deep water`);
    assert.ok(farLand / n > 0.1, `seed ${seed}: other continents beyond the sea`);
  }
});

test("old highways cross the sea as causeways, and nothing else stands in the water", () => {
  const seed = 777;
  let bridges = 0;
  for (let y = -3000; y <= 3000; y += 3) {
    for (let x = -3000; x <= 3000; x += 97) {
      if (terrainAt(seed, x, y) !== T.BRIDGE) continue;
      bridges++;
      assert.ok(isPassable(T.BRIDGE));
    }
  }
  assert.ok(bridges >= 5, `${bridges} causeway tiles sampled`);
  assert.ok(!isPassable(T.DEEP_WATER) && !isPassable(T.WATER));
});

// ---- towns and highways ----

test("highways lead somewhere: from the base you can follow the road to ruined towns", () => {
  for (const seed of [777, 4242]) {
    // Towns stand where their highways meet: a town's middle is road.
    let towns = 0;
    for (let gy = -3; gy <= 3; gy++) {
      for (let gx = -3; gx <= 3; gx++) {
        const t = townIn(seed, gx, gy);
        if (!t || !t.r) continue;
        towns++;
        assert.ok([T.ROAD, T.BRIDGE].includes(terrainAt(seed, t.x, t.y)), `seed ${seed}: a highway runs into the town at (${t.x}, ${t.y})`);
      }
    }
    assert.ok(towns >= 10, `seed ${seed}: ${towns} towns near the base`);
    // Walk the roads out of the base (4-way, as players move): they reach towns.
    const onRoad = (x: number, y: number) => [T.ROAD, T.BRIDGE, T.BASE_ICON].includes(terrainAt(seed, x, y));
    const seen = new Set<string>(["0,0"]);
    const queue: [number, number][] = [[0, 0]];
    let reached = 0;
    while (queue.length && seen.size < 20000) {
      const [x, y] = queue.shift()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        const k = `${nx},${ny}`;
        if (seen.has(k) || !onRoad(nx, ny)) continue;
        seen.add(k);
        queue.push([nx, ny]);
      }
    }
    for (let gy = -3; gy <= 3; gy++) {
      for (let gx = -3; gx <= 3; gx++) {
        const t = townIn(seed, gx, gy);
        if (t && t.r && seen.has(`${t.x},${t.y}`)) reached++;
      }
    }
    assert.ok(reached >= 3, `seed ${seed}: the roads from the base reach ${reached} towns`);
  }
});

test("the land has geology: mountain ranges, foothills around them, and wet coasts and dry interiors", () => {
  for (const seed of [777, 12345]) {
    let mountains = 0, hills = 0, land = 0, coastWet = 0, coastN = 0, inlandWet = 0, inlandN = 0;
    for (let y = -3000; y <= 3000; y += 25) {
      for (let x = -3000; x <= 3000; x += 25) {
        const t = terrainAt(seed, x, y);
        if (t === T.WATER || t === T.DEEP_WATER || t === T.BRIDGE) continue;
        land++;
        if (t === T.MOUNTAINS) mountains++;
        if (t === T.HILLS) hills++;
        const g = geology(seed, x, y);
        const wet = t === T.DEAD_FOREST || t === T.SWAMP ? 1 : 0;
        if (g.dry < 0.1) (coastWet += wet, coastN++);
        else if (g.dry > 0.45) (inlandWet += wet, inlandN++);
      }
    }
    assert.ok(mountains / land > 0.02 && mountains / land < 0.15, `seed ${seed}: ${Math.round((100 * mountains) / land)}% mountains`);
    assert.ok(hills > mountains, `seed ${seed}: more foothills than peaks`);
    assert.ok(coastWet / coastN > 1.5 * (inlandWet / inlandN), `seed ${seed}: the coasts are wetter than the interior`);
  }
});
