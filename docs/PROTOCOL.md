# Wasteland wire protocol (v3)

One WebSocket per player (`ws://<host>:<port>`). Every message is a UTF-8 text
frame holding one JSON object with a `t` field naming its type.

Source of truth: `server/src/protocol.ts` (server) and `client/scripts/net.gd` (client).

## Coordinates

- Tile coordinates are integers; `+x` is east, `+y` is south. The base is centred on `(0, 0)`.
- The world is split into chunks of `chunkSize` × `chunkSize` tiles (32). Chunk `(cx, cy)` covers
  tiles `cx*32 .. cx*32+31` and `cy*32 .. cy*32+31`.
- Tile ids are defined in `shared/tiles.json`.

## Client → server

| `t`     | Fields                                 | Notes |
|---------|----------------------------------------|-------|
| `hello` | `v` (protocol version), `name`, `token`? | First message. `name` is 2–16 of `A-Z a-z 0-9 space - _`. Omit or send `""` for `token` on a new character. |
| `move`  | `dir` (`up`/`down`/`left`/`right`), `seq` | One step. The server always answers with `you` echoing `seq`. |
| `map`   | — | Asks for the world map index; answered with `map_index`. |
| `map_chunks` | `coords` (array of `[cx, cy]`, at most 256) | Fetch chunks for the world map. Answered with a `map_chunk` per chunk that has been generated (others are skipped, never generated), then `map_batch_done`. |

## Server → client

| `t`           | Fields | Notes |
|---------------|--------|-------|
| `welcome`     | `id`, `name`, `token`, `x`, `y`, `chunkSize`, `tiles[]`, `motd` | Reply to `hello`. Store `token`: it is required to reclaim this name later. `tiles[]` is `{id, key, name, passable, color}`; `color` is the terrain's world-map colour. |
| `chunk`       | `cx`, `cy`, `tiles` | `tiles` is base64 of `chunkSize²` bytes, row-major (`index = ly*chunkSize + lx`). Sent for every chunk within 2 chunks of the player that this connection hasn't received yet. |
| `you`         | `x`, `y`, `seq`, `ok` | Authoritative position after a `move`. `ok: false` means the step was refused (blocked or too fast). |
| `player`      | `id`, `name`, `x`, `y` | Another player is within view (40 tiles) or moved. |
| `player_left` | `id` | That player left view or disconnected. |
| `map_index`   | `chunks` (array of `[cx, cy]`) | Every chunk anyone has generated so far. |
| `map_chunk`   | `cx`, `cy`, `tiles` | Same encoding as `chunk`, for the world map. It doesn't count as streamed: walking there later still sends a `chunk`. |
| `map_batch_done` | — | Ends the reply to one `map_chunks` request; the client sends the next batch. |
| `monster`     | `id`, `kind` (`zombie`), `x`, `y` | A monster came within view (40 tiles) or moved. Monsters block movement: a `move` onto one is refused. |
| `monster_left`| `id` | That monster left view or despawned. |
| `error`       | `code`, `message` | Sent before the server closes the socket. Codes: `version`, `bad_name`, `name_taken`, `replaced`, `bad_message`, `not_joined`, `timeout`, `server_error`. |

## Identity

There are no passwords yet. The first `hello` with an unused name creates the
character and returns a random `token`; later `hello`s for that name must
present the same token. The client keeps tokens in `user://settings.cfg`,
keyed by host, port and name. A second login for the same character replaces
the first connection.
