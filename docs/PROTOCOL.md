# Wasteland wire protocol (v13)

One WebSocket per player (`ws://<host>:<port>`). Every message is a UTF-8 text
frame holding one JSON object with a `t` field naming its type.

Source of truth: `server/src/protocol.ts` (server) and `client/scripts/net.gd` (client).

## Coordinates

- Tile coordinates are integers; `+x` is east, `+y` is south. The base is centred on `(0, 0)`.
- The world is split into chunks of `chunkSize` × `chunkSize` tiles (32). Chunk `(cx, cy)` covers
  tiles `cx*32 .. cx*32+31` and `cy*32 .. cy*32+31`.
- Tile ids are defined in `shared/tiles.json`.
- A player is on the overworld or inside a site: the base (a small fixed map
  from `shared/base.json`), an encampment, or a dungeon (both maps generated
  from a saved seed). `location` says which; positions in `you`, `player` and
  `monster` messages, and in `encounter_start`/`encounter_over`, are in the
  current map's coordinates.

## Client → server

| `t`     | Fields                                 | Notes |
|---------|----------------------------------------|-------|
| `hello` | `v` (protocol version), `name`, `token`? | First message. `name` is 2–16 of `A-Z a-z 0-9 space - _`. Omit or send `""` for `token` on a new character. |
| `move`  | `dir` (`up`/`down`/`left`/`right`), `seq` | One step. The server always answers with `you` echoing `seq`. In the base or a camp, stepping off the edge leaves it, and in a dungeon so does stepping onto the ladder (level 1) or the stairs to the surface (the bottom level): `you` (with the new overworld position) then `location`. Stepping onto a dungeon's stairs down (or up) answers `you` (with the position on the next level down, or the one above, beside its stairs down) then `location` for that level. Walking into a dungeon zombie starts an encounter, as on the overworld. |
| `reroll` | — | Roll new abilities. Only before the character is accepted; answered with `character`. |
| `accept` | — | Keep the current roll. Answered with `character` (now `created`), then `location` and the rest of the world. |
| `raise` | `ability` (`str`/`dex`/`int`/`hp`) | Spend a level-up point: +2 to that ability. Answered with `character`; ignored with no points or at 100. |
| `service` | `npc` (NPC id) | Ask an NPC in the base or a camp, in reach (next to you or across a counter) for their service. Shopkeepers answer with `shop`; the medic also heals to full. Clients send it whenever the player talks to an NPC. |
| `shop_buy` | `npc`, `index` | Buy (or learn) card `index` of that shop's `stock`, for its price in scrap. The NPC must be in reach. Answered with `cards`, `shop` and a `notice`. |
| `shop_sell` | `npc`, `uid` | Sell one of your cards to that shop for the price its `sell` list gives. Refused if it would leave the deck below its minimum. |
| `shop_upgrade` | `npc`, `uid` | Upgrade one of your cards a level, for the price in the shop's `upgrade` list (mechanics upgrade equipment, trainers abilities and basics). |
| `deck_set` | `uid`, `deck` (bool) | Move a card into your deck or out to your pack. Answered with `cards` (and a `notice` if the deck would go past its minimum or maximum size). |
| `offer_pick` | `index` | Take card `index` of the `offer` on screen, or `-1` for none. The next waiting offer, if any, follows. |
| `battle_play` | `id`, `uid`, `target`? | Play a card from your hand in battle `id`: on your turn with the stack empty, or (a Reaction) in answer to the top of the stack while `respond` is set. `target` is an enemy's id, for cards aimed at one pack (optional when only one is standing). The card goes on the stack; a pack may react to it; if nothing waits on you, the stack resolves. Answered with `battle` (and a `notice` if it can't be played: not in hand, not enough energy, not now, nothing to counter, no target). |
| `battle_pass` | `id` | While `respond` is set: let the stack happen without answering. Answered with `battle`. |
| `battle_end_turn` | `id`, `target`? | End your turn: your allies attack (`target`, else the last pack you aimed at), then the packs act one by one, each move going on the stack, then your next turn starts. The battle stops on the way whenever you can answer a pack's move or reaction (`respond`). Answered with `battle`. |
| `battle_flee` | `id` | Run (on your turn, not while answering): each pack gets one half-strength parting hit, then the battle ends `fled` (unless that killed you). Answered with `battle`. |
| `enter` | — | Go into the base, an encampment or a dungeon while standing on its icon on the overworld. Answered with `location` (or a `notice` if there's nothing to enter). |
| `map`   | — | Asks for the world map index; answered with `map_index`. |
| `map_chunks` | `coords` (array of `[cx, cy]`, at most 256) | Fetch chunks for the world map. Answered with a `map_chunk` per chunk that has been generated (others are skipped, never generated), then `map_batch_done`. |

## Server → client

| `t`           | Fields | Notes |
|---------------|--------|-------|
| `welcome`     | `id`, `name`, `token`, `x`, `y`, `chunkSize`, `tiles[]`, `monsters[]`, `motd`, `character` | Reply to `hello`. Store `token`: it is required to reclaim this name later. `monsters[]` is `{kind, name, one, many, sprite}` for every kind of monster (`sprite` is its column in `sprites.png`). `tiles[]` is `{id, key, name, passable, color}`; `color` is the terrain's world-map colour. If `character.created` is false the player is rolling a new character: nothing else is sent, and only `reroll`/`accept` are answered, until they accept. |
| `character`   | `character`: `{created, level, xp, str, dex, int, maxHp, hp, points}` | The player's character after any change: a roll, accepting it, XP, a level (`points` to spend), raising an ability, healing or damage. (Scrap and cards come in `cards`.) |
| `location`    | `kind` (`overworld`/`base`/`camp`/`dungeon`), `x`, `y`, and for a site: `site` (`base`, `camp:<id>` or `dungeon:<id>:<level>`), `name`, `icon`, `width`, `height`, `tiles`, `npcs[]`, `rooms[]` | Which map the player is on. Sent right after `welcome` and whenever it changes (entering, leaving, dying). For a site, `icon` is `{x, y}`, its tile on the overworld, and `tiles` is base64 of `width × height` tile ids, row-major; `npcs[]` is `{id, name, role, service, x, y, lines[]}` (NPCs block their tile; `lines` are what they say); `rooms[]` is `{name, x, y, w, h}`. |
| `notice`      | `text` | Something for the message log. |
| `chunk`       | `cx`, `cy`, `tiles` | `tiles` is base64 of `chunkSize²` bytes, row-major (`index = ly*chunkSize + lx`). Sent for every chunk within 2 chunks of the player that this connection hasn't received yet. |
| `you`         | `x`, `y`, `seq`, `ok` | Authoritative position after a `move`. `ok: false` means the step was refused (blocked or too fast). |
| `player`      | `id`, `name`, `x`, `y` | Another player on the same map is within view (40 tiles) or moved. |
| `player_left` | `id` | That player left view, changed map or disconnected. |
| `camp`        | `id`, `name`, `x`, `y` | An encampment whose icon is at `x`, `y`, sent right after the `chunk` holding it. Names are unique. |
| `map_index`   | `chunks` (array of `[cx, cy]`), `camps` (array of `{id, name, x, y}`) | Every chunk anyone has generated so far, and every encampment this player has been inside (the world map shows only those). |
| `map_chunk`   | `cx`, `cy`, `tiles` | Same encoding as `chunk`, for the world map. It doesn't count as streamed: walking there later still sends a `chunk`. |
| `map_batch_done` | — | Ends the reply to one `map_chunks` request; the client sends the next batch. |
| `monster`     | `id`, `kind`, `count`, `x`, `y` | A monster came within view (40 tiles) or moved. `kind` is one of `welcome`'s `monsters[]` (`zombie`, `raider`, `hound`, `ghoul`, `rats`, `crawler`); `count` is how many it stands for in a fight. |
| `monster_left`| `id` | That monster left view, despawned, or was pulled into an encounter. |
| `encounter_start` | `id`, `x`, `y`, `battle` | A monster and the player share a tile (either one stepped onto the other): a card battle starts. Every zombie pack within the encounter radius (3 tiles) leaves the map and joins it. `battle` is the first snapshot (see `battle`). `move`s are refused until the encounter ends. |
| `battle`      | `id`, `battle`: `{turn, phase, respond, stack[], mark, player, allies[], enemies[], hand[], drawPile, discardPile, exhausted, terrain[], log[], over?}` | The battle after every move. `phase` is whose turn it is (`you`/`zombies`); `respond` is true when a pack's move or reaction is on top of the stack and you can answer it (play a Reaction, or `battle_pass`); `stack[]` is `{by: "you"/"foe", name, text}`, bottom to top; `mark` is the pack your allies attack. `player` is `{hp, maxHp, block, energy, maxEnergy, status}`; `allies[]` is `{uid, card, name, power, hp, maxHp, guard, sweep}`; `enemies[]` is `{id, kind, sprite, name, one, many, count, hp, maxHp, block, status, intent, reaction?, cards[]}` (one per group: `count` members, each worth its kind's HP; `intent` is the move card it will play on its turn: `{card, name, damage?, hits?, all?, block?, weak?, vulnerable?, poison?, discard?, strength?, heal?, summon?, at?, text}`, `at` an ally's uid if it means to go for one; `reaction` is `{name, text, ready}`; `cards[]` is its move deck and reaction as cards, `kind` `enemy`, with `cost` -1 and `sprite`); `hand[]` is cards (as in `cards`, with `uid`, the numbers in `text` as they stand, and `playable`); `status` is `{weak, vulnerable, poison, strength, dexterity, thorns}`; `terrain[]` is the card ids the ground added for this fight; `log[]` is the last few things that happened. Once `over` is set (`victory`/`fled`/`died`), `encounter_over` follows. |
| `cards`       | `scrap`, `deckMin`, `deckMax`, `cards[]` | Everything the player owns. Each card is `{uid, card, name, kind, slot?, type, rarity, speed, target, level, cost, text, flavor?, power?, toughness?, deck}`: `card` is its id in `shared/cards.json`, `kind` is `basic`/`equipment`/`ability`/`ally`/`supply`/`terrain`, `type` is `attack`/`skill`/`power`/`ally`, `speed` is `action`/`reaction`, `target` is `enemy`/`all`/`self`/`source` (the pack being answered), `power`/`toughness` are an ally's attack and hit points, `level` is 0-2 (shown as `+` marks on the name), `deck` says whether it's in the deck or the pack. Sent on joining and after any change. |
| `offer`       | `reason` (`level`/`loot`), `cards[]` | A choice of cards (as in `cards`, without `uid`): a new ability on levelling up, or loot after a win. Answer with `offer_pick`. Offers wait (even across reconnects) until answered, one at a time. |
| `shop`        | `npc`, `name`, `title`, `buyLabel`, `upgradeLabel`, `stock[]`, `sell[]`, `upgrade[]` | An NPC's shop. `stock[]` is cards for sale with a `price`; `sell[]` is `{uid, price}` for each of your cards; `upgrade[]` is `{uid, price, next}` for each card they'd upgrade, `next` being the card a level up. `buyLabel`/`upgradeLabel` are what buying and upgrading are called there (a trainer teaches and trains). Sent on talking to them and after every purchase, sale or upgrade. |
| `encounter_over` | `id`, `result`, `x`, `y` | The battle is over. `x`, `y` is where the player is now: unchanged after a victory, up to 3 tiles away from the packs after fleeing, or the encounter tile after dying, followed by a `location` putting the player in the base's infirmary. Surviving monsters are back on their tiles, and for a few seconds the player can't be caught or walk into a fight. |
| `error`       | `code`, `message` | Sent before the server closes the socket. Codes: `version`, `bad_name`, `name_taken`, `replaced`, `bad_message`, `not_joined`, `timeout`, `server_error`. |

## Identity

There are no passwords yet. The first `hello` with an unused name creates the
character and returns a random `token`; later `hello`s for that name must
present the same token. The client keeps tokens in `user://settings.cfg`,
keyed by host, port and name. A second login for the same character replaces
the first connection.
