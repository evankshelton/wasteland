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
Move with the arrow keys or WASD (rebind them in *Project Settings → Input Map*:
`move_up`, `move_down`, `move_left`, `move_right`). Esc opens the menu.

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

It joins, walks out of the base, reconnects and checks the server kept its position.

### Adding a terrain type

1. Add it to `shared/tiles.json` (next free id).
2. Draw it in `server/tools/make_tiles.ts` and run `npm run tiles`.
3. Place it in `server/src/worldgen.ts` (and add an ASCII glyph in `tools/ascii_map.ts`).
