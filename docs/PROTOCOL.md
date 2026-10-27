# Wasteland wire protocol (v8)

One WebSocket per player (`ws://<host>:<port>`). Every message is a UTF-8 text
frame holding one JSON object with a `t` field naming its type.

Source of truth: `server/src/protocol.ts` (server) and `client/scripts/net.gd` (client).

## Coordinates

- Tile coordinates are integers; `+x` is east, `+y` is south. The base is centred on `(0, 0)`.
- The world is split into chunks of `chunkSize` × `chunkSize` tiles (32). Chunk `(cx, cy)` covers
  tiles `cx*32 .. cx*32+31` and `cy*32 .. cy*32+31`.
- Tile ids are defined in `shared/tiles.json`.
- A player is on the overworld or inside a site: the base (a small fixed map
  from `shared/base.json`) or an encampment (a map generated from the camp's
  seed). `location` says which; positions in `you` and `player` messages are in
  the current map's coordinates.

## Client → server

| `t`     | Fields                                 | Notes |
|---------|----------------------------------------|-------|
| `hello` | `v` (protocol version), `name`, `token`? | First message. `name` is 2–16 of `A-Z a-z 0-9 space - _`. Omit or send `""` for `token` on a new character. |
| `move`  | `dir` (`up`/`down`/`left`/`right`), `seq` | One step. The server always answers with `you` echoing `seq`. In the base or a camp, stepping off the edge leaves it: `you` (with the new overworld position) then `location`. |
| `reroll` | — | Roll new abilities. Only before the character is accepted; answered with `character`. |
| `accept` | — | Keep the current roll. Answered with `character` (now `created`), then `location` and the rest of the world. |
| `raise` | `ability` (`str`/`dex`/`int`/`hp`) | Spend a level-up point: +2 to that ability. Answered with `character`; ignored with no points or at 100. |
| `service` | `npc` (NPC id) | Ask an NPC in the base or a camp, in reach (next to you or across a counter) for their service. The medic heals to full; others do nothing yet. Clients send it whenever the player talks to an NPC. |
| `enter` | — | Go into the base or an encampment while standing on its icon on the overworld. Answered with `location` (or a `notice` if there's nothing to enter). |
| `map`   | — | Asks for the world map index; answered with `map_index`. |
| `map_chunks` | `coords` (array of `[cx, cy]`, at most 256) | Fetch chunks for the world map. Answered with a `map_chunk` per chunk that has been generated (others are skipped, never generated), then `map_batch_done`. |
| `encounter_end` | `id`, `result` (`victory`/`fled`/`died`), `killed` (monster ids), `remaining`?, `dir`?, `hp`? | How the first-person fight ended. `killed` lists monsters whose whole pack died; `remaining` maps a monster id to how many of its pack are still standing, for packs only partly killed (they come back that size; packs can only shrink). `dir` (`up`/`down`/`left`/`right`) is the arena edge the player fled across; `hp` is the health they finished with (it can only go down; dying restores it). `victory` is refused unless every enemy is in `killed`. Kills and victories award XP. |

## Server → client

| `t`           | Fields | Notes |
|---------------|--------|-------|
| `welcome`     | `id`, `name`, `token`, `x`, `y`, `chunkSize`, `tiles[]`, `motd`, `character` | Reply to `hello`. Store `token`: it is required to reclaim this name later. `tiles[]` is `{id, key, name, passable, color}`; `color` is the terrain's world-map colour. If `character.created` is false the player is rolling a new character: nothing else is sent, and only `reroll`/`accept` are answered, until they accept. |
| `character`   | `character`: `{created, level, xp, str, dex, int, maxHp, hp, points}` | The player's character after any change: a roll, accepting it, XP, a level (`points` to spend), raising an ability, healing or damage. |
| `location`    | `kind` (`overworld`/`base`/`camp`), `x`, `y`, and for the base or a camp: `name`, `icon`, `width`, `height`, `tiles`, `npcs[]`, `rooms[]` | Which map the player is on. Sent right after `welcome` and whenever it changes (entering, leaving, dying). For a site, `icon` is `{x, y}`, its tile on the overworld, and `tiles` is base64 of `width × height` tile ids, row-major; `npcs[]` is `{id, name, role, service, x, y, lines[]}` (NPCs block their tile; `lines` are what they say); `rooms[]` is `{name, x, y, w, h}`. |
| `notice`      | `text` | Something for the message log. |
| `chunk`       | `cx`, `cy`, `tiles` | `tiles` is base64 of `chunkSize²` bytes, row-major (`index = ly*chunkSize + lx`). Sent for every chunk within 2 chunks of the player that this connection hasn't received yet. |
| `you`         | `x`, `y`, `seq`, `ok` | Authoritative position after a `move`. `ok: false` means the step was refused (blocked or too fast). |
| `player`      | `id`, `name`, `x`, `y` | Another player on the same map is within view (40 tiles) or moved. |
| `player_left` | `id` | That player left view, changed map or disconnected. |
| `camp`        | `id`, `name`, `x`, `y` | An encampment whose icon is at `x`, `y`, sent right after the `chunk` holding it. Names are unique. |
| `map_index`   | `chunks` (array of `[cx, cy]`), `camps` (array of `{id, name, x, y}`) | Every chunk anyone has generated so far, and every encampment in them. |
| `map_chunk`   | `cx`, `cy`, `tiles` | Same encoding as `chunk`, for the world map. It doesn't count as streamed: walking there later still sends a `chunk`. |
| `map_batch_done` | — | Ends the reply to one `map_chunks` request; the client sends the next batch. |
| `monster`     | `id`, `kind` (`zombie`), `count`, `x`, `y` | A monster came within view (40 tiles) or moved. `count` is how many it stands for in a fight (a pack of 1–15). |
| `monster_left`| `id` | That monster left view, despawned, or was pulled into an encounter. |
| `encounter_start` | `id`, `x`, `y`, `radius`, `seed`, `enemies[]` | A monster and the player share a tile (either one stepped onto the other). Every monster within `radius` tiles leaves the overworld and joins the fight; `enemies[]` is `{id, kind, count, dx, dy}` with tile offsets from `(x, y)`; each is a pack of `count` zombies in the fight. The client builds a 3D arena from the overworld tiles within `radius` of `(x, y)`, decorated using `seed`. Overworld `move`s are refused until the encounter ends. |
| `encounter_over` | `id`, `result`, `x`, `y` | The server accepted the result. `x`, `y` is where the player is now: unchanged after a victory, up to 3 tiles in the fled direction, or the encounter tile after dying, followed by a `location` putting the player in the base's infirmary. Surviving monsters are back on their tiles, and for a few seconds the player can't be caught or walk into a fight. |
| `error`       | `code`, `message` | Sent before the server closes the socket. Codes: `version`, `bad_name`, `name_taken`, `replaced`, `bad_message`, `not_joined`, `timeout`, `server_error`. |

## Identity

There are no passwords yet. The first `hello` with an unused name creates the
character and returns a random `token`; later `hello`s for that name must
present the same token. The client keeps tokens in `user://settings.cfg`,
keyed by host, port and name. A second login for the same character replaces
the first connection.
