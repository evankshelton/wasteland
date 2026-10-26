# Wasteland

A multiplayer post-apocalyptic overworld in the spirit of *Operation Overkill II*
with *Ultima IV*-style tiles. Players start inside a walled **base**; everything
outside is wasteland that the server generates as players explore it.

```
client/   Godot 4.7 game client (GDScript)
server/   Node.js 24 world server (TypeScript, SQLite, WebSocket)
shared/   tiles.json — terrain ids/names/passability shared by both
docs/     PROTOCOL.md — the client/server message format
```

## Running

**Server** (needs Node.js 24+):

```bash
cd server
npm install
npm start
```

It listens on `0.0.0.0:7777` and stores the world in `server/data/world.db`.
Options: `npm start -- --port 7777 --host 0.0.0.0 --db data/world.db --seed 12345`
(`--seed` only matters when creating a new world). Ctrl+C saves and exits.

**Client**: open `client/` in Godot 4.7 and press Play, or run
`godot --path client`. Enter the server address, port and a name, then Connect.
Move with the arrow keys or WASD. Esc opens the menu.

Press **M** for the world map: every part of the world any player has explored,
one pixel per tile. Scroll by dragging or with the movement keys, zoom with
the mouse wheel or `+`/`-`, press **C** to jump back to yourself, and M or Esc
to close it.

All keys are input actions you can rebind in *Project Settings → Input Map*:
`move_up`, `move_down`, `move_left`, `move_right`, `open_map`, `map_zoom_in`,
`map_zoom_out`, `map_center`, `shoot`.

Dev shortcut: `godot --path client -- --host 127.0.0.1 --port 7777 --name Ash --autoconnect`

## How the world works

- The world is an unbounded grid split into 32×32 **chunks**. When a player
  comes within 2 chunks of land nobody has seen, the server generates it from
  the world seed and saves it to SQLite. Saved chunks never change, even if
  the generator does.
- Terrain: wasteland, dead scrub, dead forest, rubble, ruined buildings, old
  highways, hills, mountains, blast craters, hot (radioactive) zones, toxic
  water, sludge marsh and ash dunes. Hazards fade in with distance from the
  base, so the land around it is always walkable.
- The server is authoritative: it checks every step against the terrain, and
  saves player positions every 5 seconds, on disconnect and on shutdown.
  Reconnecting with the same name puts you back where you were.
- Other players within 40 tiles are shown (tinted orange).
- **Radioactive zombies** spawn out in the wasteland, 12–18 tiles from a player
  (just off screen), more readily in hot zones. They shamble one tile every
  0.9s (players are about 7× faster) towards the nearest player within 20
  tiles, and can't enter the base or the ring just outside its walls. Nothing
  spawns within 16 tiles of the base. At most 4 gather around a player, and
  they despawn after 20s with nobody nearby. They are not saved across server
  restarts. Tuning lives in `DEFAULT_MONSTER_OPTIONS` in `server/src/monsters.ts`.
- **Encounters.** When a zombie and a player end up on the same tile (either
  one walks onto the other), the game switches to first person. Every zombie
  within 8 tiles joins the fight. The 3D arena is built from the real
  overworld tiles around the encounter: 17×17 tiles, each a 4 m square
  showing that tile's pixel art. Mountains, ruined buildings, base walls and
  toxic water are solid; dead forests have trees; rubble and craters have
  debris; hot zones glow and burn (4 HP/s); sludge marsh slows you down.
  Zombies start where they stood on the overworld. Kill them all, or run past
  the rusty posts at the arena's edge to flee: you come out up to 3 tiles that
  way on the overworld and the survivors go back to their tiles. Die and you
  wake up at the base. Afterwards you get 3 seconds' grace before anything can
  catch you again.

  Controls: WASD/arrows move, mouse aims, left click or Space shoots
  (`shoot` action), Esc frees the mouse (click to recapture). The client runs
  the fight and reports the outcome; the server checks it against the
  encounter (only that fight's zombies can be killed, and victory needs all of
  them), but doesn't simulate the combat itself.
- The world map asks the server for the list of generated chunks and fetches
  the ones the client doesn't have in batches. It only shows land that exists;
  looking at the map never generates anything.

## Development

```bash
cd server
npm test            # server unit + integration tests
npm run typecheck   # tsc --noEmit
npm run map -- 12345 160 60 2   # ASCII preview of the generator: seed, width, height, step
npm run tiles       # rebuild client/assets/tiles.png + sprites.png from server/tools/make_tiles.ts
```

Client end-to-end test (with a server running):

```bash
godot --headless --path client res://tests/smoke_test.tscn -- --host 127.0.0.1 --port 7777
```

It joins, walks out of the base, opens and loads the world map, reconnects and
checks the server kept its position. Add `--expect-encounter` to also wait for
zombies to catch the player, check the 3D arena, shoot a zombie, win that
fight, then flee the next one (needs a player far enough from the base and a
server with a generous `spawnChance`).

### Zombie model

The first-person zombies use a rigged, animated 3D model when one is present,
and fall back to simple block figures otherwise. The model files live in
`client/models/`, which is git-ignored, so each developer adds their own:

```
client/models/zombie/
  mesh/zombie.obj, zombie.mtl, zombie_basecolor.jpg   unrigged model (unzip zombie.zip here)
  animations/*.fbx                                    Mixamo animations for that model,
                                                      exported "without skin"
```

Mixamo's "without skin" FBX carries the skeleton fitted to the model but no
mesh, so a bake step skins the OBJ to that skeleton and saves everything as
`client/models/zombie/zombie_rigged.scn`:

```bash
godot --headless --path client --import
```

```bash
godot --headless --path client -s res://tools/rig_zombie.gd
```

The bake also measures how fast the walk animation carries the zombie forward
and stores it on the scene, so in the game the walk is sped up to match each
zombie's pace (0.7–1.0 m/s, about 2.2–3× the animation's speed) and the feet
don't skate.

Re-run it after changing the model or adding animations. Animations are named
after their FBX files and matched by name: one with "walk" in it is the
shamble (required), "attack"/"punch"/"bite" plays when a zombie claws you, and
"death"/"dying" when it dies. Without those two, the zombie lunges and topples
instead.

### Adding a terrain type

1. Add it to `shared/tiles.json` (next free id, plus its world-map `color`).
2. Draw it in `server/tools/make_tiles.ts` and run `npm run tiles`.
3. Place it in `server/src/worldgen.ts` (and add an ASCII glyph in `tools/ascii_map.ts`).
