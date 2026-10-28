extends Node2D
## The 2D game view: the overworld (chunks the server streams in) or the base
## interior (a small town map, like an Ultima IV city), the avatar, other
## players, zombies and the base's NPCs.
##
## The enter action (E) goes into the base from its icon on the overworld, and
## inside talks to the NPC next to you or across a counter. Walking off any
## edge of the base map leaves it on that side of the icon.
##
## Movement is server-authoritative. A step onto a known walkable tile is shown
## immediately; only one step is in flight at a time and the server's reply
## ("you") always wins.

const MENU_SCENE := "res://scenes/main_menu.tscn"
const ENCOUNTER_SCENE := preload("res://scenes/encounter.tscn")
const TILES_TEXTURE := preload("res://assets/tiles.png")
const SPRITES_TEXTURE := preload("res://assets/sprites.png")
const TILE := 16
const MOVE_REPEAT := 0.13 ## seconds between steps while a key is held
const MOVE_TIMEOUT_MS := 2000
const OTHER_TINT := Color(1.0, 0.6, 0.3)
const ZOMBIE_REGION := Rect2(16, 0, 16, 16) ## sprites.png column 1
const ZOMBIE_STEP_TIME := 0.35 ## seconds to animate one shambling step
const NPC_TINT := Color(0.55, 0.85, 1.0)
const SIGHT := 7 ## tiles you can see in a dungeon, along a clear line (a room you're in is seen whole)
const FOG_DIM := Color(0, 0, 0, 0.55) ## over dungeon tiles you've seen before but can't see now
## Level-up choices: [character key, ability for the server, label].
const RAISE_CHOICES := [["str", "str", "Strength"], ["dex", "dex", "Dexterity"], ["int", "int", "Intelligence"], ["maxHp", "hp", "Hit Points"]]
const RAISE_BY := 2
const LOG_LINES := 6

## Input action -> [protocol direction, tile delta]. Rebind keys in Project Settings > Input Map.
const DIRS := {
	&"move_up": ["up", Vector2i.UP],
	&"move_down": ["down", Vector2i.DOWN],
	&"move_left": ["left", Vector2i.LEFT],
	&"move_right": ["right", Vector2i.RIGHT],
}

var pos := Vector2i.ZERO
var chunk_size := 32
var tile_names: Array[String] = []
var tile_passable: Array[bool] = []
var chunks := {} ## Vector2i chunk coord -> PackedByteArray of tile ids
var others := {} ## player id -> Node2D
var other_positions := {} ## player id -> Vector2i, for the world map
var monsters := {} ## monster id -> Sprite2D
var monster_positions := {} ## monster id -> Vector2i
var encounter: Node3D ## the first-person fight, while one is running
var last_encounter_result := ""
## "overworld", "base", "camp" or "dungeon": which map pos (and every position from the server) refers to.
var location := "overworld"
var site_info := {} ## the server's "location" message for the base, camp or dungeon we're in: name, rooms, npcs...
var site_icon := Vector2i.ZERO ## that site's icon on the overworld
var npcs := {} ## Vector2i -> NPC dictionary, while in a site
var camps := {} ## Vector2i icon position -> encampment name, for every camp we've heard of
var visited_camps := {} ## Vector2i icon position -> name, for the camps we've been inside (the world map shows only these)

var _site_tiles := PackedByteArray()
var _site_size := Vector2i.ZERO
var _base_icon_id := -1
var _camp_icon_id := -1
var _dungeon_icon_id := -1
var _door_id := -1
## Fog of war in dungeons: only tiles you've seen are drawn, dimmed unless in sight right now.
var _explored := {} ## Vector2i -> true: tiles seen on this dungeon level (remembered between visits)
var _in_sight := {} ## Vector2i -> true: tiles in sight right now
var _explored_path := "" ## where this level's explored tiles are saved
var _fog_shade: Node2D ## dims explored tiles out of sight
var _site := "" ## the server's id for the site we're in ("dungeon:<id>:<level>"...), to tell up from down
var _camp_labels: Node2D ## camp names floating over their icons on the overworld
var _counter_id := -1
var _arrived := false
var _dialog_npc := {}
var _dialog_line := 0

var _seq := 0
var _pending_seq := -1 ## seq of the step awaiting a reply, -1 if none
var _pending_since_ms := 0
var _repeat := 0.0
var _log_lines: Array[String] = []
var _lost := false

@onready var terrain: TileMapLayer = %Terrain
@onready var base_terrain: TileMapLayer = %BaseTerrain
@onready var npcs_root: Node2D = %Npcs
@onready var dialog: Control = %Dialog
@onready var dialog_name: Label = %DialogName
@onready var dialog_text: Label = %DialogText
@onready var dialog_hint: Label = %DialogHint
@onready var level_up: Control = %LevelUp
@onready var level_up_box: VBoxContainer = %LevelUpBox
@onready var sheet_label: Label = %SheetLabel
@onready var players_root: Node2D = %Players
@onready var monsters_root: Node2D = %Monsters
@onready var avatar: Sprite2D = %Avatar
@onready var camera: Camera2D = %Camera
@onready var status_label: Label = %StatusLabel
@onready var log_label: Label = %LogLabel
@onready var pause_menu: Control = %PauseMenu
@onready var lost_overlay: Control = %LostOverlay
@onready var lost_label: Label = %LostLabel
@onready var map_view: Control = %MapView
@onready var hud: CanvasLayer = $HUD


func _ready() -> void:
	var welcome := Net.welcome
	if welcome.is_empty():
		get_tree().change_scene_to_file.call_deferred(MENU_SCENE)
		return

	chunk_size = int(welcome.chunkSize)
	for t: Dictionary in welcome.tiles:
		var id := int(t.id)
		if id >= tile_names.size():
			tile_names.resize(id + 1)
			tile_passable.resize(id + 1)
		tile_names[id] = str(t.name)
		tile_passable[id] = bool(t.passable)
		match str(t.key):
			"base_icon": _base_icon_id = id
			"camp_icon": _camp_icon_id = id
			"dungeon_icon": _dungeon_icon_id = id
			"door": _door_id = id
			"counter": _counter_id = id
	terrain.tile_set = _build_tileset(tile_names.size())
	base_terrain.tile_set = terrain.tile_set
	_fog_shade = Node2D.new()
	_fog_shade.visible = false
	_fog_shade.draw.connect(_draw_fog_shade)
	add_child(_fog_shade)
	move_child(_fog_shade, base_terrain.get_index() + 1)
	_camp_labels = Node2D.new()
	add_child(_camp_labels)
	move_child(_camp_labels, base_terrain.get_index() + 1)
	map_view.setup(self, welcome.tiles)

	%ResumeButton.pressed.connect(_set_paused.bind(false))
	%DisconnectButton.pressed.connect(_leave)
	%QuitButton.pressed.connect(get_tree().quit)
	%BackButton.pressed.connect(_leave)
	Net.disconnected.connect(_on_disconnected)
	Net.character_changed.connect(_on_character_changed)
	_on_character_changed(Net.character)

	_set_pos(Vector2i(int(welcome.x), int(welcome.y)), true)
	_log("Welcome, %s." % welcome.name)
	if str(welcome.get("motd", "")) != "":
		_log(str(welcome.motd))


func _process(delta: float) -> void:
	for msg in Net.drain():
		_handle(msg)
	_update_movement(delta)
	# Radioactive glow: pulse the zombies' brightness.
	var glow := 0.8 + 0.2 * sin(Time.get_ticks_msec() / 220.0)
	monsters_root.modulate = Color(glow, 1.0, glow)


func _unhandled_input(event: InputEvent) -> void:
	# The map, when open, sees input first and closes itself on open_map / Esc.
	if _lost or encounter:
		return
	if event.is_action_pressed(&"ui_cancel"):
		if dialog.visible:
			_close_dialog()
		else:
			_set_paused(not pause_menu.visible)
		get_viewport().set_input_as_handled()
	elif pause_menu.visible:
		return
	elif level_up.visible and event is InputEventKey and event.pressed and not event.echo \
			and event.physical_keycode >= KEY_1 and event.physical_keycode <= KEY_4:
		_raise(int(event.physical_keycode - KEY_1))
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed(&"enter"):
		use()
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed(&"open_map"):
		_close_dialog()
		map_view.open()
		get_viewport().set_input_as_handled()


# ---- network ----

func _handle(msg: Dictionary) -> void:
	match msg.t:
		"chunk":
			_apply_chunk(Vector2i(int(msg.cx), int(msg.cy)), Marshalls.base64_to_raw(msg.tiles))
		"you":
			if int(msg.seq) == _pending_seq:
				_pending_seq = -1
			var server_pos := Vector2i(int(msg.x), int(msg.y))
			if server_pos != pos:
				# More than a step away means we're changing maps (stairs, a ladder, an
				# edge): the position is on the next map, whose "location" comes next, so
				# don't look around this one from there.
				var stepped := maxi(absi(server_pos.x - pos.x), absi(server_pos.y - pos.y)) <= 1
				_set_pos(server_pos, true, stepped)
			if not msg.ok:
				_log("Blocked!")
		"player":
			_upsert_player(int(msg.id), str(msg.name), Vector2i(int(msg.x), int(msg.y)))
		"player_left":
			var id := int(msg.id)
			if others.has(id):
				others[id].queue_free()
				others.erase(id)
			other_positions.erase(id)
		"monster":
			_upsert_monster(int(msg.id), Vector2i(int(msg.x), int(msg.y)))
		"monster_left":
			var id := int(msg.id)
			if monsters.has(id):
				monsters[id].queue_free()
				monsters.erase(id)
			monster_positions.erase(id)
		"location":
			_arrive(msg)
		"notice":
			_log(str(msg.text))
		"encounter_start":
			_start_encounter(msg)
		"encounter_over":
			last_encounter_result = str(msg.result)
			_set_pos(Vector2i(int(msg.x), int(msg.y)), true)
			match msg.result:
				"victory": _log("The dead lie still. You survived.")
				"fled": _log("You got away... for now.")
				"died": _log("You died. You wake up in the base's infirmary.")
		"camp":
			_add_camp(Vector2i(int(msg.x), int(msg.y)), str(msg.name))
		"map_index":
			for c: Dictionary in msg.get("camps", []):
				_add_camp(Vector2i(int(c.x), int(c.y)), str(c.name))
				visited_camps[Vector2i(int(c.x), int(c.y))] = str(c.name)
			map_view.on_index(msg.chunks)
		"map_chunk":
			var coord := Vector2i(int(msg.cx), int(msg.cy))
			var data := Marshalls.base64_to_raw(msg.tiles)
			if data.size() == chunk_size * chunk_size and not chunks.has(coord):
				chunks[coord] = data # Map only; the server streams it as a "chunk" if we walk there.
			map_view.on_chunk()
		"map_batch_done":
			map_view.on_batch_done()


func _apply_chunk(coord: Vector2i, data: PackedByteArray) -> void:
	if data.size() != chunk_size * chunk_size:
		push_warning("Ignoring malformed chunk %s" % coord)
		return
	chunks[coord] = data
	var origin := coord * chunk_size
	for i in data.size():
		@warning_ignore("integer_division")
		terrain.set_cell(origin + Vector2i(i % chunk_size, i / chunk_size), 0, Vector2i(data[i], 0))
	if coord == chunk_of(pos):
		_update_status()


## An encampment's name over its icon on the overworld (and on the world map).
func _add_camp(at: Vector2i, camp_name: String) -> void:
	if camps.has(at):
		return
	camps[at] = camp_name
	var label := Label.new()
	label.text = camp_name
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.add_theme_font_size_override("font_size", 9)
	label.add_theme_color_override("font_color", Color(1.0, 0.85, 0.45))
	label.add_theme_color_override("font_outline_color", Color.BLACK)
	label.add_theme_constant_override("outline_size", 4)
	label.size = Vector2(160, 12)
	label.position = _tile_center(at) + Vector2(-80, -TILE * 1.25)
	_camp_labels.add_child(label)
	if location == "overworld" and at == pos:
		_update_status()


## Switch to the map in a server "location" message: the overworld, or a site
## (the base or an encampment), whose whole map comes in the message.
func _arrive(msg: Dictionary) -> void:
	_close_dialog()
	map_view.close()
	_pending_seq = -1
	location = str(msg.kind)
	var in_site := location != "overworld"
	terrain.visible = not in_site
	_camp_labels.visible = not in_site
	base_terrain.visible = in_site
	for n in npcs_root.get_children():
		n.queue_free()
	npcs.clear()
	if in_site:
		site_info = msg
		site_icon = Vector2i(int(msg.icon.x), int(msg.icon.y)) if msg.has("icon") else Vector2i.ZERO
		if location == "camp":
			visited_camps[site_icon] = str(msg.name)
		_site_size = Vector2i(int(msg.width), int(msg.height))
		_site_tiles = Marshalls.base64_to_raw(msg.tiles)
		base_terrain.clear()
		_explored.clear()
		_in_sight.clear()
		if location == "dungeon":
			# Fog of war: only what you've seen on this level before; the rest is revealed as you go.
			var key := "_".join([Net.server_key(), str(Net.welcome.get("name", "")), str(msg.get("site", msg.name))]).validate_filename()
			_explored_path = "user://dungeon_maps/%s.bin" % key
			_load_explored()
		for i in _site_tiles.size():
			@warning_ignore("integer_division")
			var cell := Vector2i(i % _site_size.x, i / _site_size.x)
			if location != "dungeon" or _explored.has(cell):
				base_terrain.set_cell(cell, 0, Vector2i(_site_tiles[i], 0))
		for n: Dictionary in msg.npcs:
			var at := Vector2i(int(n.x), int(n.y))
			npcs[at] = n
			npcs_root.add_child(_figure(str(n.name), NPC_TINT, at))
		var site := str(msg.get("site", ""))
		if location == "dungeon" and not _site.begins_with("dungeon:"):
			_log("You climb down into %s. The ladder leads back up." % msg.name)
		elif location == "dungeon" and _site.get_slice(":", 1) == site.get_slice(":", 1) \
				and _site.get_slice(":", 2).to_int() > site.get_slice(":", 2).to_int():
			_log("You climb the stairs up to %s." % msg.name)
		elif location == "dungeon":
			_log("You go down the stairs to %s." % msg.name)
		else:
			_log("You are in %s. Walk off any edge to leave." % msg.name if not _arrived else "You enter %s." % msg.name)
	elif _arrived:
		_log("You head back out into the wasteland.")
	_arrived = true
	_site = str(msg.get("site", "")) if location != "overworld" else ""
	_fog_shade.visible = location == "dungeon"
	_set_pos(Vector2i(int(msg.x), int(msg.y)), true)


func _on_disconnected(reason: String) -> void:
	_lost = true
	if encounter:
		encounter.queue_free()
		encounter = null
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		_show_overworld(true)
	pause_menu.hide()
	map_view.close()
	lost_label.text = reason
	lost_overlay.show()
	%BackButton.grab_focus()


func _leave() -> void:
	Net.close()
	get_tree().change_scene_to_file(MENU_SCENE)


# ---- movement ----

func _update_movement(delta: float) -> void:
	_repeat = maxf(0.0, _repeat - delta)
	if _pending_seq >= 0:
		if Time.get_ticks_msec() - _pending_since_ms < MOVE_TIMEOUT_MS:
			return
		_pending_seq = -1 # The reply got lost; don't stall forever.
	if _lost or pause_menu.visible or map_view.visible or encounter:
		return
	var action := _held_direction()
	if action != &"" and dialog.visible:
		_close_dialog() # Walking away ends the conversation.
	if action == &"":
		_repeat = 0.0 # Releasing and re-pressing a key steps immediately.
		return
	if _repeat > 0.0:
		return
	_repeat = MOVE_REPEAT
	_step(action)


func _held_direction() -> StringName:
	for action: StringName in DIRS:
		if Input.is_action_pressed(action):
			return action
	return &""


func _step(action: StringName) -> void:
	var dir: String = DIRS[action][0]
	var target: Vector2i = pos + DIRS[action][1]
	if npcs.has(target):
		_talk(npcs[target]) # Bump into someone to talk, Ultima-style.
		return
	var tile := tile_at(target)
	if tile >= 0 and not tile_passable[tile]:
		_log("Blocked by %s." % tile_names[tile].to_lower())
		return
	_seq += 1
	_pending_seq = _seq
	_pending_since_ms = Time.get_ticks_msec()
	Net.send({"t": "move", "dir": dir, "seq": _seq})
	if tile >= 0:
		_set_pos(target) # Optimistic; corrected by the server's reply if wrong.


func _set_pos(p: Vector2i, snap := false, look := true) -> void:
	pos = p
	avatar.position = _tile_center(p)
	if snap:
		camera.reset_smoothing()
	if location == "dungeon" and look:
		_look_around()
	_update_status()


# ---- fog of war (dungeons) ----

## See what's in sight from here: tiles within SIGHT along a clear line
## (walls and closed doors block it, though you see the wall or door itself),
## and the whole of any room you're standing in. Newly seen tiles join the map.
func _look_around() -> void:
	var seen := {}
	for dy in range(-SIGHT, SIGHT + 1):
		for dx in range(-SIGHT, SIGHT + 1):
			var t := pos + Vector2i(dx, dy)
			if dx * dx + dy * dy <= SIGHT * SIGHT + SIGHT and _in_site(t) and _clear_line(pos, t):
				seen[t] = true
	for room: Dictionary in site_info.get("rooms", []):
		var rect := Rect2i(int(room.x), int(room.y), int(room.w), int(room.h))
		if rect.has_point(pos):
			var walls := rect.grow(1)
			for y in range(walls.position.y, walls.end.y):
				for x in range(walls.position.x, walls.end.x):
					if _in_site(Vector2i(x, y)):
						seen[Vector2i(x, y)] = true
	_in_sight = seen
	var found := false
	for t: Vector2i in seen:
		if not _explored.has(t):
			_explored[t] = true
			base_terrain.set_cell(t, 0, Vector2i(_site_tiles[t.y * _site_size.x + t.x], 0))
			found = true
	if found:
		_save_explored()
	_fog_shade.queue_redraw()
	_fog_monsters()


func _in_site(t: Vector2i) -> bool:
	return t.x >= 0 and t.y >= 0 and t.x < _site_size.x and t.y < _site_size.y


## True if nothing between a and b (exclusive) blocks sight.
func _clear_line(a: Vector2i, b: Vector2i) -> bool:
	var d := (b - a).abs()
	var step := Vector2i(signi(b.x - a.x), signi(b.y - a.y))
	var err := d.x - d.y
	var at := a
	while at != b:
		var e2 := err * 2
		if e2 > -d.y:
			err -= d.y
			at.x += step.x
		if e2 < d.x:
			err += d.x
			at.y += step.y
		if at == b:
			return true
		var id := tile_at(at)
		if id < 0 or not tile_passable[id] or id == _door_id:
			return false
	return true


func _draw_fog_shade() -> void:
	for t: Vector2i in _explored:
		if not _in_sight.has(t):
			_fog_shade.draw_rect(Rect2(Vector2(t * TILE), Vector2(TILE, TILE)), FOG_DIM)


## In a dungeon you only see the zombies in sight.
func _fog_monsters() -> void:
	for id: int in monsters:
		monsters[id].visible = location != "dungeon" or _in_sight.has(monster_positions.get(id, Vector2i(-1, -1)))


func _load_explored() -> void:
	var file := FileAccess.open(_explored_path, FileAccess.READ)
	if file == null:
		return
	var bits := file.get_buffer(file.get_length())
	if bits.size() != _site_size.x * _site_size.y:
		return # A different map (the world was reset): start afresh.
	for i in bits.size():
		if bits[i] == 1:
			@warning_ignore("integer_division")
			_explored[Vector2i(i % _site_size.x, i / _site_size.x)] = true


func _save_explored() -> void:
	DirAccess.make_dir_recursive_absolute(_explored_path.get_base_dir())
	var bits := PackedByteArray()
	bits.resize(_site_size.x * _site_size.y)
	for t: Vector2i in _explored:
		bits[t.y * _site_size.x + t.x] = 1
	var file := FileAccess.open(_explored_path, FileAccess.WRITE)
	if file:
		file.store_buffer(bits)


# ---- the enter / use key ----

## Enter the base, an encampment or a dungeon from its icon; inside, talk to whoever is next to you or across a counter.
func use() -> void:
	if dialog.visible:
		_next_line()
	elif location == "overworld":
		if tile_at(pos) in [_base_icon_id, _camp_icon_id, _dungeon_icon_id]:
			Net.send({"t": "enter"})
		else:
			_log("There's nothing here to enter.")
	else:
		var npc := _npc_in_reach()
		if npc.is_empty():
			_log("There's nobody here to talk to.")
		else:
			_talk(npc)


func _npc_in_reach() -> Dictionary:
	for d: Vector2i in [Vector2i.UP, Vector2i.DOWN, Vector2i.LEFT, Vector2i.RIGHT]:
		if npcs.has(pos + d):
			return npcs[pos + d]
		if tile_at(pos + d) == _counter_id and npcs.has(pos + d * 2):
			return npcs[pos + d * 2]
	return {}


func _talk(npc: Dictionary) -> void:
	# Ask for their service too; the server does it if they have a working one (the medic heals).
	Net.send({"t": "service", "npc": int(npc.id)})
	_dialog_npc = npc
	_dialog_line = 0
	dialog_name.text = "%s, %s" % [npc.name, npc.role]
	dialog.show()
	_show_line()


func _next_line() -> void:
	_dialog_line += 1
	if _dialog_line >= _dialog_npc.lines.size():
		_close_dialog()
	else:
		_show_line()


func _show_line() -> void:
	var lines: Array = _dialog_npc.lines
	dialog_text.text = "\"%s\"" % lines[_dialog_line]
	dialog_hint.text = "[E] more" if _dialog_line < lines.size() - 1 else "[E] close"


func _close_dialog() -> void:
	dialog.hide()
	_dialog_npc = {}


# ---- encounters ----

func _start_encounter(msg: Dictionary) -> void:
	map_view.close()
	_set_paused(false)
	_pending_seq = -1
	_show_overworld(false)
	encounter = ENCOUNTER_SCENE.instantiate()
	add_child(encounter)
	encounter.setup(self, msg)
	encounter.finished.connect(_on_encounter_finished.bind(int(msg.id)))
	_log("Zombies! %d of them." % msg.enemies.size() if msg.enemies.size() != 1 else "A zombie is on you!")


func _on_encounter_finished(result: String, killed: Array, dir: String, id: int) -> void:
	var msg := {"t": "encounter_end", "id": id, "result": result, "killed": killed, "hp": encounter.health}
	var remaining: Dictionary = encounter.remaining()
	if not remaining.is_empty():
		msg.remaining = remaining
	if not dir.is_empty():
		msg.dir = dir
	Net.send(msg)
	encounter.queue_free()
	encounter = null
	_show_overworld(true)


## The 2D view and the 3D fight never show at once.
func _show_overworld(on: bool) -> void:
	for node: CanvasItem in [players_root, monsters_root, npcs_root, avatar]:
		node.visible = on
	terrain.visible = on and location == "overworld"
	_camp_labels.visible = terrain.visible
	base_terrain.visible = on and location != "overworld"
	_fog_shade.visible = on and location == "dungeon"
	hud.visible = on
	camera.enabled = on


# ---- world queries ----

func chunk_of(p: Vector2i) -> Vector2i:
	return Vector2i(floori(float(p.x) / chunk_size), floori(float(p.y) / chunk_size))


## Where the player is on the overworld: their position, or the icon of the site they're inside.
func overworld_pos() -> Vector2i:
	return pos if location == "overworld" else site_icon


## Tile id at a position on the current map, or -1 if unknown (a chunk that
## hasn't arrived, or off the edge of the base or camp).
func tile_at(p: Vector2i) -> int:
	if location != "overworld":
		if p.x < 0 or p.y < 0 or p.x >= _site_size.x or p.y >= _site_size.y:
			return -1
		return _site_tiles[p.y * _site_size.x + p.x]
	return overworld_tile_at(p)


## Tile id at an overworld position, or -1 if that chunk hasn't arrived yet.
func overworld_tile_at(p: Vector2i) -> int:
	var c := chunk_of(p)
	var data: PackedByteArray = chunks.get(c, PackedByteArray())
	if data.is_empty():
		return -1
	var local := p - c * chunk_size
	return data[local.y * chunk_size + local.x]


func _tile_center(p: Vector2i) -> Vector2:
	return Vector2(p * TILE) + Vector2(TILE, TILE) * 0.5


# ---- presentation ----

func _build_tileset(count: int) -> TileSet:
	var ts := TileSet.new()
	ts.tile_size = Vector2i(TILE, TILE)
	var src := TileSetAtlasSource.new()
	src.texture = TILES_TEXTURE
	src.texture_region_size = Vector2i(TILE, TILE)
	for id in count:
		src.create_tile(Vector2i(id, 0))
	ts.add_source(src, 0)
	return ts


## A tinted person sprite with a name tag above it (other players, NPCs).
func _figure(label_text: String, tint: Color, at: Vector2i) -> Node2D:
	var node := Node2D.new()
	var sprite := Sprite2D.new()
	sprite.texture = SPRITES_TEXTURE
	sprite.region_enabled = true
	sprite.region_rect = Rect2(0, 0, TILE, TILE)
	sprite.modulate = tint
	node.add_child(sprite)
	var label := Label.new()
	label.text = label_text
	label.add_theme_font_size_override(&"font_size", 6)
	label.add_theme_constant_override(&"outline_size", 2)
	label.add_theme_color_override(&"font_outline_color", Color.BLACK)
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.size = Vector2(64, 8)
	label.position = Vector2(-32, -17)
	node.add_child(label)
	node.position = _tile_center(at)
	return node


func _upsert_player(id: int, player_name: String, p: Vector2i) -> void:
	var node: Node2D = others.get(id)
	if node == null:
		node = _figure(player_name, OTHER_TINT, p)
		players_root.add_child(node)
		others[id] = node
	node.position = _tile_center(p)
	other_positions[id] = p


func _upsert_monster(id: int, p: Vector2i) -> void:
	var sprite: Sprite2D = monsters.get(id)
	if sprite == null:
		if monsters.is_empty():
			_log("A radioactive zombie shambles out of the waste...")
		sprite = Sprite2D.new()
		sprite.texture = SPRITES_TEXTURE
		sprite.region_enabled = true
		sprite.region_rect = ZOMBIE_REGION
		sprite.position = _tile_center(p)
		sprite.flip_h = p.x > pos.x # The art reaches right; face the player.
		monsters_root.add_child(sprite)
		monsters[id] = sprite
	else:
		var old: Vector2i = monster_positions.get(id, p)
		if p.x != old.x:
			sprite.flip_h = p.x < old.x
		if sprite.has_meta(&"tween"):
			(sprite.get_meta(&"tween") as Tween).kill()
		var tween := sprite.create_tween()
		tween.tween_property(sprite, ^"position", _tile_center(p), ZOMBIE_STEP_TIME)
		sprite.set_meta(&"tween", tween)
	monster_positions[id] = p
	sprite.visible = location != "dungeon" or _in_sight.has(p)


# ---- character ----

func _on_character_changed(c: Dictionary) -> void:
	_update_status()
	sheet_label.text = _sheet(c)
	level_up.visible = int(c.get("points", 0)) > 0
	if not level_up.visible:
		return
	for child in level_up_box.get_children():
		child.queue_free()
	var title := Label.new()
	title.text = "LEVEL %d!  Raise an ability (%d point%s)" % [c.level, c.points, "" if int(c.points) == 1 else "s"]
	title.add_theme_color_override(&"font_color", Color(1, 1, 0.33))
	level_up_box.add_child(title)
	for i in RAISE_CHOICES.size():
		var choice: Array = RAISE_CHOICES[i]
		var value := int(c[choice[0]])
		var button := Button.new()
		button.text = "%d. %s  %d -> %d" % [i + 1, choice[2], value, mini(value + RAISE_BY, 100)]
		button.alignment = HORIZONTAL_ALIGNMENT_LEFT
		button.focus_mode = Control.FOCUS_NONE # Arrow keys stay for walking.
		button.disabled = value >= 100
		button.pressed.connect(_raise.bind(i))
		level_up_box.add_child(button)


func _raise(choice: int) -> void:
	Net.send({"t": "raise", "ability": RAISE_CHOICES[choice][1]})


## "Lv 3  HP 9/12  XP 340/600"
func _vitals(c: Dictionary) -> String:
	if c.is_empty():
		return ""
	var level := int(c.level)
	return "Lv %d  HP %d/%d  XP %d/%d" % [level, c.hp, c.maxHp, c.xp, 50 * (level + 1) * level]


func _sheet(c: Dictionary) -> String:
	if c.is_empty():
		return ""
	return "%s\nSTR %d   DEX %d   INT %d" % [_vitals(c), c.str, c.dex, c.int]


func _update_status() -> void:
	var vitals := "   " + _vitals(Net.character)
	if location != "overworld":
		status_label.text = "%s   %s: %s%s" % [Net.welcome.get("name", ""), site_info.get("name", "Base"), _room_at(pos), vitals]
		return
	var tile := tile_at(pos)
	var where: String = camps.get(pos, tile_names[tile] if tile >= 0 else "...")
	# Directions back to the base at the origin (+y is south).
	var to_base := PackedStringArray()
	if pos.y != 0:
		to_base.append("%d%s" % [absi(pos.y), "N" if pos.y > 0 else "S"])
	if pos.x != 0:
		to_base.append("%d%s" % [absi(pos.x), "W" if pos.x > 0 else "E"])
	var base_text := "   Base: %s" % " ".join(to_base) if not to_base.is_empty() else ""
	status_label.text = "%s   (%d, %d)   %s%s%s" % [Net.welcome.get("name", ""), pos.x, pos.y, where, base_text, vitals]


func _room_at(p: Vector2i) -> String:
	for room: Dictionary in site_info.get("rooms", []):
		if Rect2i(int(room.x), int(room.y), int(room.w), int(room.h)).has_point(p):
			return str(room.name)
	match location:
		"base": return "Outside the walls"
		"dungeon": return "The passages"
	return "The camp grounds"


func _log(line: String) -> void:
	_log_lines.append(line)
	while _log_lines.size() > LOG_LINES:
		_log_lines.pop_front()
	log_label.text = "\n".join(_log_lines)


func _set_paused(paused: bool) -> void:
	pause_menu.visible = paused
	if paused:
		%ResumeButton.grab_focus()
