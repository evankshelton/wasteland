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
          cards.json — every card: kind, rarity, cost and effects at each level
          enemies.json — every kind of enemy: where it turns up, its size, health and cards
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
highways drawn unbroken) and 3x (a map tile per 16x16, with no roads at all). The base, camps you've been inside, every dungeon entrance on charted
land, players and monsters are the game's own icons and sprites; the
places always show, at both zooms, however small they are next to the
land around them (`client/shaders/pixel_map.gdshader`). Scroll by dragging or with the movement keys, zoom with
the mouse wheel or `+`/`-`, press **C** to jump back to yourself, and M or Esc
to close it.

Press **I** for your cards: everything you own, in your deck or set aside in
your pack (click a card to move it across). Talking to a shopkeeper opens
their shop.

All keys are input actions you can rebind in *Project Settings → Input Map*:
`move_up`, `move_down`, `move_left`, `move_right`, `enter`, `open_map`,
`inventory`, `map_zoom_in`, `map_zoom_out`, `map_center`.

Dev shortcut: `godot --path client -- --host 127.0.0.1 --port 7777 --name Ash --autoconnect`

## How the world works

- The world is an unbounded grid split into 32×32 **chunks**. When a player
  comes within 2 chunks of land nobody has seen, the server generates it from
  the world seed and saves it to SQLite. Saved chunks never change, even if
  the generator does.
- **Continents and geology.** The land is shaped by plate tectonics,
  roughly (`CONTINENTS` in `server/src/worldgen.ts`). The world is a
  jittered grid of plates about 1,150 tiles across, continental or oceanic,
  each drifting its own way; their levels blend at the edges like a
  continental shelf, and warped fractal noise turns the edges into capes,
  bays, inlets and offshore islands. About half the world is sea. Where
  plates meet:
  - two continents colliding push up a great mountain range along the seam;
  - a continent meeting an ocean plate gets a coastal range a little inland;
  - two ocean plates colliding throw up a thin arc of islands;
  - two continents pulling apart open a rift valley, often flooded into a
    long narrow sea.

  Old, worn ridges wander across the interiors too. Ranges are crests with
  passes between the peaks and foothills around them. Coasts are wet (dead
  forest, marsh), deep interiors dry (scrub, ash dunes). The base stands well
  inland on its own continent. Toxic shallows line the coasts, the Dead Sea
  beyond is deep, and ash beaches and marsh fringe the shore. Water can't be
  walked, but a few old highways run on across it as **causeways** (and
  inland lakes are crossed the same way).
- **Towns and highways.** Ruined towns (from hamlets to sprawling ruins
  about 90 tiles across) are rare: at most one to each cell of a jittered
  grid about 430 tiles wide. Where a cell has a coast on open sea (not just
  an inlet or a lake), its town is usually built on the shore as a **port**.
  The base is a ruined town like the rest, with a clear square round its
  icon. About two in three towns, nearly every port and always the base, are
  on the old highways; the rest stand off on their own. Each town on the
  network is linked to its two or three nearest neighbours on it by a gently
  bending highway that meets the others in the town's middle, goes overland
  over hills and through mountain passes, crosses lakes on causeways, and
  now and then runs out over the sea from a port to the nearest town on
  another shore. Follow a road and it takes you somewhere. Tuning is `ROADS`
  in `server/src/worldgen.ts`.
- Terrain: wasteland, dead scrub, dead forest, rubble, ruined buildings, old
  highways and causeways, hills, mountains, blast craters, hot (radioactive)
  zones, toxic water and the deep sea, sludge marsh and ash dunes. Hazards
  fade in with distance from the base, so the land around it is always
  walkable.
- The server is authoritative: it checks every step against the terrain, and
  saves player positions every 5 seconds, on disconnect and on shutdown.
  Reconnecting with the same name puts you back where you were.
- Other players within 40 tiles on the same map are shown (tinted orange).
- **Characters.** A new character is level 1 with four abilities, rolled by
  the server: strength, dexterity and intelligence are 6–18 (6 plus two rolls
  of 0–6, averaging 12) and hit points are 6–12. Players can reroll as often
  as they like before accepting; after that the roll is final. Abilities top
  out at 100.
  - **Experience:** 25 XP per zombie killed (enemies are worth more or
    less: see *Enemies*), and +10 for clearing an area;
    walking about earns nothing. Intelligence adds +1%
    XP per point above 12.
  - **Levels:** reaching level *n* takes 50·*n*·(*n*−1) XP in total (100,
    300, 600, 1000...). Each level gives a point to spend raising the ability
    of your choice by 2, from a panel in the HUD (click it, or press 1–4).
  - **In a fight:** hit points are your health. Strength starts every battle
    with +1 Strength for each 6 points above 9 (so 15 gives +1, 21 gives +2),
    dexterity likewise gives Dexterity (more Block per card), and intelligence
    16+ draws a sixth card each turn. Each level also offers a new ability
    card (see *Cards*).
  - **Healing:** health carries over between fights. Doc Ellis in the base's
    infirmary heals you to full when you talk to him, and dying wakes you
    there at full health.

  Rules live in `server/src/character.ts`. Characters created before this
  existed roll a new one the next time they join.
- **The base** sits at the origin of the overworld as one icon tile, with an
  old highway running south. Its interior (`shared/base.json`) is a 32×32 map
  inside a perimeter wall with four gates, and has rooms with an NPC each:
  - armory: Rourke sells weapon cards
  - armor shop: Mags sells armor cards
  - infirmary: Doc Ellis heals you, and sells medical supplies
  - decontamination: Sievert sells rad supplies
  - barracks: Sgt. Okafor teaches ability cards and trains your cards up
  - supply depot: Tully trades, and pays the best price for your cards
  - command center

  New characters start inside it, and dying in a fight wakes you in the
  infirmary. The server sends the map when you enter, saves which map you're
  on, and zombies can't come within 4 tiles of the icon. Edit `shared/base.json` to change the layout (one character per tile,
  see its `legend`), rooms, NPCs or their lines; restart the server to apply.
- **Encampments** turn up in about 5% of newly generated land (never within
  40 tiles of the base), on open ground, and most often right beside a
  highway: three times likelier where one passes. Each has a unique name, shown over its
  icon on the overworld (and on your world map once you've been inside), and its own layout grown from a
  saved seed (`server/src/camps.ts`) in one of four styles: an open-air market
  of stalls, a stockade behind scrap barricades, a tent village around a
  campfire, or a ruined building divided into rooms. Each camp has 2–5 booths
  drawn from eleven trades: gunsmith, armorer, medic, rad doc, scrap trader,
  water seller, cook, barkeep, mechanic, drill instructor and rumormonger.
  They're shops (see *Cards*); camp medics also heal like Doc Ellis. Zombies
  don't step onto camp icons.
- **Dungeons** are dug only into the mountain ranges: about 1 in 8 chunks of
  a range (60+ mountain tiles; lone peaks don't count) has one, roughly 1% of
  all land, so they're rare and you go looking for them in the mountains.
  The entrance is a single rock-arch tile at the foot of the mountainside
  (never within 30 tiles of the base). Stand on it and press **E** to climb
  down. Each dungeon has a name ("The Flooded Mineshafts") and 5–9 levels, each its own labyrinth grown from
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
  and is remembered between visits; monsters only show while in sight. Monsters
  roam every level, in groups of up to 4 on level 1 and one bigger for each
  level down (up to 12): they appear 7–13 tiles from you and find their way through the passages
  to you, but leave you alone right where you arrive and by the ways out. In
  a dungeon fight the tunnels give you Cave-in cards; fleeing comes out a few
  tiles away in the dungeon, as far as the walls allow.
- **Monsters** spawn out in the wasteland, 12–18 tiles from a player (just
  off screen), more readily in hot zones. They head one tile at a time towards
  the nearest player within 20 tiles (a zombie every 0.9s; players are about
  7× faster), and can't come within 4 tiles of the base icon. Nothing spawns
  within 16 tiles of the base. At most 4 gather around a player, and they
  despawn after 20s with nobody nearby. They are not saved across server
  restarts. Tuning lives in `DEFAULT_MONSTER_OPTIONS` in `server/src/monsters.ts`.
- **Enemies.** Each monster on the map is a group of one kind, and which kind
  depends on where you are (`shared/enemies.json`, with each kind's cards):

  | Enemy | Group | HP each | Where | Fights with |
  |---|---|---|---|---|
  | Zombies | 1–15 | 2 | everywhere, more in ruins and dead forest | claws, mauls, retching, infected bites; lurch, swarm, howl, grab |
  | Raiders | 2–5 | 5 | roads, ruins, concrete | gunfire, burst fire, firebombs, digging in, stims, disarming you; return fire, take cover, suppressing fire (counters your Reactions), warning shots (counter your Allies) |
  | Feral Hounds | 2–6 | 3 | scrub, wasteland, dead forest, hills (fast) | lunges, pack hunts, hamstrings (Vulnerable), circling, baying; pounce on your Block, snap, scatter |
  | Ghouls | 1–4 | 6 | hot zones and craters, and dungeons (slow) | rad pulses that hit you and every ally, searing touches, feeding (heal), glowing; rad flare (Poison), absorb your heals, feed on fear |
  | Rat Swarm | 4–15 | 1 | dungeons, rubble, marsh, ruins (quick) | gnawing (many small bites), swarming over, breeding, plague bites; scurry, multiply, nibble at your Block |
  | Cave Crawlers | 1–3 | 7 | dungeons only | venom fangs, webs (Weak, and you drop a card), lurking, dropping from above; ensnare (counters your Reactions), skitter, spit venom |

  Raiders, ghouls and crawlers are worth 3–4 zombies' XP and scrap each, a
  rat a quarter of one. Press **C** in a fight to see the marked group's
  cards, framed in purple.
- **Battles.** When a monster and a player end up on the same tile (either
  one walks onto the other), a card battle starts: Slay the Spire's turns
  with Magic: the Gathering's stack.
  Every monster within 3 tiles joins in. Each one on the map is a group
  (fixed when it spawns, not shown on the map; zombie packs of 1–15 lean big,
  about 8 on average: `PACK_SIZE_WEIGHTS` in `server/src/monsters.ts`), and in
  battle each group is one enemy with its kind's HP per member, so members
  fall as you wear it down and it hits more softly.
  - **Your turn:** your hand from last turn goes to the discard pile, then
    3 Energy and a fresh hand of 5. Cards cost Energy: attacks, Block (soaks
    damage until your next turn), powers that last the fight, and allies. A
    card aimed at one group goes at the marked one (click a group to mark
    it, or Tab). End the turn: your allies attack the marked group, then
    every group plays the move card its intent above it shows. Each group
    plays from its own shuffled deck of moves, one a turn, so you can count
    what's still to come.
  - **The stack:** nothing happens the moment it's played. Your card goes on
    the stack, and the other side can answer it; answers go on top and happen
    first. When nobody answers, the stack happens from the top down. A card
    whose pack is down by then misses, and a countered one does nothing.
    - **Groups react** to your cards, each with one reaction card a round
      (shown under it): zombies *Lurch* (gain Block before your attack lands)
      or *Swarm* the attacker, raiders *Return Fire*, hounds *Pounce* before
      your Block lands, crawlers *Ensnare* your Reactions...
    - **You answer with Reactions.** Cards are *Actions* (your turn only,
      with the stack empty) or *Reactions* (also in answer to a pack's move on
      its turn, or to a pack's reaction). Energy you don't spend and the cards
      left in your hand stay until your next turn, so you can hold some back:
      when a pack's move or reaction is on top and you can answer it, the
      battle waits for you to play a Reaction or pass (Space). Counters cancel
      what they answer: Trip Up a pack's reaction, Sidestep an attack.
  - **Allies** (Stray Dog, Militia Recruit, Auto-Turret) are cards that stay
    in the fight, up to 3 at a time, with attack/hit points like a creature:
    they attack at the end of your turn, packs sometimes go for them instead
    of you (always for one with *Guard*), and one that falls goes to the
    discard pile.
  - **Statuses:** Weak (deal 25% less), Vulnerable (take 50% more), Poison
    (lose that much HP each turn, one less each time), Strength and Dexterity
    (+damage per hit, +Block per card), Thorns (attackers take that much per
    hit). Card text shows the numbers as they stand.
  - **The ground fights with you:** the terrain around you adds cards to
    your deck for that battle only: Take Cover in ruins, Snapped Branch in
    dead forest, Toxic Splash by water and marsh, Rad Surge in hot zones, a
    Burnt-out Car on the road, Hurl Debris on rubble, High Ground on hills,
    Ash Cloud on dunes, Dust Kick in open wasteland, Cave-in underground.
  - **Ending it:** kill every pack to win, or Flee (each pack gets one
    half-strength parting hit, then you're out up to 3 tiles away from them,
    whichever way is open if ruins or walls block the way away, and they go
    back on the map). Die and you wake up in the base's
    infirmary. Wounds carry over; afterwards you get 3 seconds' grace.
  - **Spoils:** 1–3 scrap per zombie's worth killed, 5 more for a win, XP
    by what you killed, and after a win a choice of three cards to keep (or
    skip).

  Controls: click a card (and then a group, for cards aimed at one), or 1–9
  to play the card in that slot; Tab marks the next group; C shows its cards;
  E ends the turn;
  Space passes (lets what's on top of the stack happen); F flees (on your
  turn). The server runs the battle (`server/src/battle.ts`) and the client
  only shows it (`client/scripts/battle.gd`), so it can't be cheated.
- **Cards.** Every survivor starts with a deck of 11: five Swings, three
  Braces, a Duck! (a Reaction), a Lead Pipe and a Scrap Vest, plus 40 scrap
  (decks from before Reactions get a Duck!). All the cards are in
  `shared/cards.json`; their text is written from their effects. They're
  framed like Magic cards: Energy cost in pips by the name, a type line
  (Action, Reaction, Power or Ally, and where it's from) with a rarity gem,
  rules and flavour text, and an ally's attack/hit points in the corner. The
  frame's colour says where the card comes from: weapons red, armor white,
  abilities blue, allies green, supplies gold, terrain brown, basics grey.
  - **Kinds:** equipment (weapons and armor), abilities, allies, supplies
    (heals and cures, mostly used up when played), basics, and the terrain
    cards above (never owned).
  - **Levels:** each card has three, *Card*, *Card+* and *Card++*, with
    better numbers or a lower cost.
  - **Getting them:** shops sell them (weapons from gunsmiths, armor from
    armorers, abilities from trainers, supplies from medics, rad docs and
    food and water sellers, gear and allies from traders), every level-up
    offers a new ability card, and every win offers loot.
  - **Upgrading:** mechanics upgrade equipment, and trainers train abilities,
    allies and the basics, for scrap.
  - **Selling:** any shopkeeper buys your cards (traders pay best).
  - **Your deck** is the cards you fight with: 8 to 30 of them. Cards you
    don't want to fight with go in your pack (press I to sort them).
- Causeways show on the world map as highways (at 4x; at 3x, with the
  rest of the roads, they're hidden).
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
open the quartermaster's shop (buying a card if it can afford one) and the
inventory, walk out, step onto the icon and press E to go back in. `--expect-camp` does
the same for an encampment, against a server that drops the player on a camp's
icon the first time they leave the base. `--expect-dungeon` goes down a
dungeon the same way (against a server that drops the player on an entrance and
spawns dungeon zombies eagerly): it walks away from the ladder, wins a card
battle underground, goes down the stairs level by level (and back up once),
and leaves by the stairs out of the bottom.

```bash
godot --headless --path client res://tests/smoke_test.tscn -- --host 127.0.0.1 --port 7777
```

It joins, walks out of the base, opens and loads the world map, reconnects and
checks the server kept its position. Add `--expect-encounter` to also wait for
zombies to catch the player, play the card battle out to a win, take a loot
card, open the inventory, then flee the next battle (needs a player far
enough from the base, a server with a generous `spawnChance`, and characters
with enough hit points to win reliably).

### Adding a terrain type

1. Add it to `shared/tiles.json` (next free id, plus its world-map `color`).
2. Draw it in `server/tools/make_tiles.ts` and run `npm run tiles`.
3. Place it in `server/src/worldgen.ts` (and add an ASCII glyph in `tools/ascii_map.ts`).
4. If it should help in a fight, list it in a terrain card's `terrain` in
   `shared/cards.json` (or add a terrain card for it).
