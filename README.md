# Wasteland

A multiplayer post-apocalyptic overworld in the spirit of *Operation Overkill II*
with *Ultima IV*-style tiles. Players start inside the **base**, a small walled
town shown on the overworld as a single icon; everything outside is wasteland
that the server generates as players explore it.

```
client/   Godot 4.7 game client (GDScript)
server/   Node.js 24 world server (TypeScript, SQLite, WebSocket)
shared/   tiles.json — terrain ids/names/passability/map colours shared by both
          base.json  — the base interior: map, rooms and NPCs
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
The first time you join with a name you roll a character (see *Characters*
below): reroll as often as you like, then accept. Move with the arrow keys or
WASD. Esc opens the menu, which shows your character sheet.

Stand on the base icon (or an encampment's) and press **E** to go inside. Each
is its own small map, like an Ultima IV city: walk off any edge to leave, and you come out on
the overworld tile on that side of the icon. Inside, press E (or walk into
someone) to talk to the NPC next to you or across a counter.

Press **M** for the world map: every part of the world any player has explored,
drawn in the game's own 16x16 EGA tiles at a crisp 2x or 3x. Each map tile
stands for a block of the world, showing its most common terrain. There are
two zooms: 4x (the default; a map tile per 8x8 of the world, with the
highways drawn unbroken) and 3x (a map tile per 16x16, with no roads at all). The base, camps you've been inside, players and zombies are the
game's own icons and sprites (`client/shaders/pixel_map.gdshader`). Scroll by dragging or with the movement keys, zoom with
the mouse wheel or `+`/`-`, press **C** to jump back to yourself, and M or Esc
to close it.

All keys are input actions you can rebind in *Project Settings → Input Map*:
`move_up`, `move_down`, `move_left`, `move_right`, `enter`, `open_map`,
`map_zoom_in`, `map_zoom_out`, `map_center`, `shoot`.

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
- Other players within 40 tiles on the same map are shown (tinted orange).
- **Characters.** A new character is level 1 with four abilities, rolled by
  the server: strength, dexterity and intelligence are 6–18 (6 plus two rolls
  of 0–6, averaging 12) and hit points are 6–12. Players can reroll as often
  as they like before accepting; after that the roll is final. Abilities top
  out at 100.
  - **Experience:** 25 XP per zombie killed, +10 for clearing an area, and +2
    for each new piece of land you're the first to see. Intelligence adds +1%
    XP per point above 12.
  - **Levels:** reaching level *n* takes 50·*n*·(*n*−1) XP in total (100,
    300, 600, 1000...). Each level gives a point to spend raising the ability
    of your choice by 2, from a panel in the HUD (click it, or press 1–4).
  - **In a fight:** strength is damage per shot (30 + STR, so a zombie takes
    3 shots at 12 and 1 from 70), dexterity is fire rate and run speed, and
    hit points are your health. Zombies claw for 3 and hot zones burn
    0.5 HP/s.
  - **Healing:** health carries over between fights. Doc Ellis in the base's
    infirmary heals you to full when you talk to him, and dying wakes you
    there at full health.

  Rules live in `server/src/character.ts`. Characters created before this
  existed roll a new one the next time they join.
- **The base** sits at the origin of the overworld as one icon tile, with an
  old highway running south. Its interior (`shared/base.json`) is a 32×32 map
  inside a perimeter wall with four gates, and has rooms with an NPC each:
  - armory (weapons)
  - armor shop
  - infirmary (healing)
  - decontamination (radiation)
  - barracks
  - supply depot
  - command center

  New characters start inside it, and dying in a fight wakes you in the
  infirmary. The server sends the map when you enter, saves which map you're
  on, and zombies can't come within 4 tiles of the icon. Doc Ellis heals; the
  other NPCs talk about their trade, but there's no money, inventory or
  radiation to trade in yet. Edit `shared/base.json` to change the layout (one character per tile,
  see its `legend`), rooms, NPCs or their lines; restart the server to apply.
- **Encampments** turn up in about 6% of newly generated chunks (never within
  40 tiles of the base), on open ground. Each has a unique name, shown over its
  icon on the overworld (and on your world map once you've been inside), and its own layout grown from a
  saved seed (`server/src/camps.ts`) in one of four styles: an open-air market
  of stalls, a stockade behind scrap barricades, a tent village around a
  campfire, or a ruined building divided into rooms. Each camp has 2–5 booths
  drawn from ten trades: gunsmith, armorer, medic, rad doc, scrap trader, water
  seller, cook, barkeep, mechanic and rumormonger. Camp medics heal like Doc
  Ellis; the rest only talk for now. Zombies don't step onto camp icons.
- **Dungeons**: about 5% of newly generated chunks hold a dungeon entrance
  (never within 30 tiles of the base): a single rock-arch tile on the
  overworld. Stand on it and press **E** to climb down. Each dungeon has a name
  ("The Flooded Catacombs") and 2–4 levels, each its own labyrinth grown from
  the dungeon's saved seed (`server/src/dungeons.ts`): 5–14 named rooms behind
  doors, joined by winding passages with a few loops and dead ends, all walled
  in rock. You arrive by the ladder in the Entrance Hall of level 1 (step onto
  it to climb straight back out). On every level but the last, stairs down
  wait in the room farthest from where you arrive; on the bottom level that
  room holds the stairs to the surface, which bring you out beside the
  entrance. Below level 1 you arrive at the foot of stairs up, which take you
  back to the level above (beside its stairs down), so you can also leave the
  way you came: up level by level and out by the ladder. Dungeons have a fog of war: you only see the rooms and passages in
  your line of sight (7 tiles, walls and doors block it; a room you're in is
  seen whole). What you've seen stays on the map, dimmed when out of sight,
  and is remembered between visits; zombies only show while in sight. Zombies
  roam every level, in packs of up to 6 on level 1 and bigger the deeper you
  go: they appear 7–13 tiles from you and find their way through the passages
  to you, but leave you alone right where you arrive and by the ways out. A dungeon fight takes place
  underground, in the rock passages around you, under a stone ceiling, by the
  light of the torch you carry. Fleeing comes out a few tiles away in the
  dungeon, as far as the walls allow.
- **Radioactive zombies** spawn out in the wasteland, 12–18 tiles from a player
  (just off screen), more readily in hot zones. They shamble one tile every
  0.9s (players are about 7× faster) towards the nearest player within 20
  tiles, and can't come within 4 tiles of the base icon. Nothing spawns within
  16 tiles of the base. At most 4 gather around a player, and
  they despawn after 20s with nobody nearby. They are not saved across server
  restarts. Tuning lives in `DEFAULT_MONSTER_OPTIONS` in `server/src/monsters.ts`.
- **Encounters.** When a zombie and a player end up on the same tile (either
  one walks onto the other), the game switches to first person. Every zombie
  within 8 tiles joins the fight. The 3D arena is built from the real
  overworld tiles around the encounter: 17×17 tiles, each a 12 m area (about
  200 m across). Instead of the overworld's pixel art, the ground uses
  realistic textures with normal maps (cracked earth, dry grass, forest
  litter, gravel, asphalt, rock, ash, charred ground, irradiated soil, mud and
  concrete; see *Ground textures* below). The ground
  rolls gently, and terrain shapes it: hills rise, toxic water and marsh sit
  in hollows, and roads and ruins are flattened. Neighbouring terrain types
  blend into each other along meandering borders instead of meeting in
  squares (`client/shaders/`). A dusty daytime haze thickens with
  distance until there's nothing but haze by about 40 m, with no horizon, with fog banks
  drifting by and dust and ash hanging in the air, so zombies loom out of the haze only
  once they're near. Mountains,
  ruined buildings, base walls and toxic water are solid; dead forests are
  stands of trees; rubble and craters are strewn with debris; hot zones glow
  and burn (4 HP/s); sludge marsh slows you down.
  Zombies start where they stood on the overworld. Kill them all, or run past
  the dark ring at the arena's edge to flee: you come out up to 3 tiles that
  way on the overworld and the survivors go back to their tiles. Die and you
  wake up in the base's infirmary. Afterwards you get 3 seconds' grace before anything can
  catch you again.

  Each zombie on the overworld stands for a **pack of 1–15** in a fight,
  fixed when it spawns and not shown on the overworld. Big packs are the
  likelier ones (about 8 on average; the odds are `PACK_SIZE_WEIGHTS` in
  `server/src/monsters.ts`). The pack appears clustered where its zombie
  stood, each one starting to move after a random moment so they don't march
  in step. XP is per zombie killed, and a pack you leave partly dead comes
  back smaller.

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

Client end-to-end test (with a server running). Add `--expect-base` to play a
brand-new character through the base: start inside, talk to the gate guard,
walk out, step onto the icon and press E to go back in. `--expect-camp` does
the same for an encampment, against a server that drops the player on a camp's
icon the first time they leave the base. `--expect-dungeon` goes down a
dungeon the same way (against a server that drops the player on an entrance and
spawns dungeon zombies eagerly): it walks away from the ladder, wins a fight
underground, and climbs back out.

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

### Tree models

Dead forests in the first-person arena use tree models when there are any in
`client/models/trees/` (git-ignored): every `.glb` there is a candidate, and
each tree picks one at random, turned, leaning slightly and 8–16 m tall
(snapped to five sizes). Trees stand at least 7 m apart and keep clear of where
anyone starts. Each one collides using its own mesh, so trunks, roots and
branches stop players, zombies and bullets. Models can be any size; they're
scaled by their height. Without any, the arena falls back to simple stick trees.

To look at an arena of one terrain (or `--terrain mixed` for patches of
several, to see how they blend; add `--near-edge` to look out through the
ring at the edge) without running a server:

```bash
godot --path client res://tests/arena_preview.tscn -- --terrain dead_forest --screenshot out.png
```

It prints fps and draw calls after a few seconds, saves the screenshot, and
quits. Add `--check-trees` to also shoot the nearest tree and walk into it; it
exits with code 1 if either passes through.

### Ground textures

The first-person arena's ground textures are generated, not drawn:
`client/tools/make_ground_textures.gd` layers seamless noise into eleven
512×512 colour and normal maps in `client/assets/ground/`. Edit a recipe
there and regenerate:

```bash
godot --headless --path client -s res://tools/make_ground_textures.gd
```

```bash
godot --headless --path client --import
```

Which terrain uses which texture (and how glossy it is) is `GROUND_FOR` in
`client/scripts/encounter.gd`. Mountains are wrapped in the rock texture and
ruins and base walls in concrete.

### Adding a terrain type

1. Add it to `shared/tiles.json` (next free id, plus its world-map `color`).
2. Draw it in `server/tools/make_tiles.ts` and run `npm run tiles`.
3. Place it in `server/src/worldgen.ts` (and add an ASCII glyph in `tools/ascii_map.ts`).
4. For the first-person arena, give it a ground texture in `GROUND_FOR` (and a
   height in `RELIEF`) in `client/scripts/encounter.gd`.
