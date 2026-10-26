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
## "overworld" or "base": which map pos (and every position from the server) refers to.
var location := "overworld"
var base_info := {} ## the server's base "location" message: name, rooms, npcs...
var npcs := {} ## Vector2i -> NPC dictionary, while in the base

var _base_tiles := PackedByteArray()
var _base_size := Vector2i.ZERO
var _base_icon_id := -1
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
			"counter": _counter_id = id
	terrain.tile_set = _build_tileset(tile_names.size())
	base_terrain.tile_set = terrain.tile_set
	map_view.setup(self, welcome.tiles)

	%ResumeButton.pressed.connect(_set_paused.bind(false))
	%DisconnectButton.pressed.connect(_leave)
	%QuitButton.pressed.connect(get_tree().quit)
	%BackButton.pressed.connect(_leave)
	Net.disconnected.connect(_on_disconnected)

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
				_set_pos(server_pos, true)
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
		"map_index":
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


## Switch to the map in a server "location" message: the overworld, or the base.
func _arrive(msg: Dictionary) -> void:
	_close_dialog()
	map_view.close()
	_pending_seq = -1
	location = str(msg.kind)
	var in_base := location == "base"
	terrain.visible = not in_base
	base_terrain.visible = in_base
	for n in npcs_root.get_children():
		n.queue_free()
	npcs.clear()
	if in_base:
		base_info = msg
		_base_size = Vector2i(int(msg.width), int(msg.height))
		_base_tiles = Marshalls.base64_to_raw(msg.tiles)
		base_terrain.clear()
		for i in _base_tiles.size():
			@warning_ignore("integer_division")
			base_terrain.set_cell(Vector2i(i % _base_size.x, i / _base_size.x), 0, Vector2i(_base_tiles[i], 0))
		for n: Dictionary in msg.npcs:
			var at := Vector2i(int(n.x), int(n.y))
			npcs[at] = n
			npcs_root.add_child(_figure(str(n.name), NPC_TINT, at))
		_log("You are in %s. Walk off any edge to leave." % msg.name if not _arrived else "You enter %s." % msg.name)
	elif _arrived:
		_log("You head back out into the wasteland.")
	_arrived = true
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


func _set_pos(p: Vector2i, snap := false) -> void:
	pos = p
	avatar.position = _tile_center(p)
	if snap:
		camera.reset_smoothing()
	_update_status()


# ---- the enter / use key ----

## Enter the base from its icon; inside, talk to whoever is next to you or across a counter.
func use() -> void:
	if dialog.visible:
		_next_line()
	elif location == "overworld":
		if tile_at(pos) == _base_icon_id:
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
	var msg := {"t": "encounter_end", "id": id, "result": result, "killed": killed}
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
	base_terrain.visible = on and location == "base"
	hud.visible = on
	camera.enabled = on


# ---- world queries ----

func chunk_of(p: Vector2i) -> Vector2i:
	return Vector2i(floori(float(p.x) / chunk_size), floori(float(p.y) / chunk_size))


## Where the player is on the overworld: their position, or the base icon while inside.
func overworld_pos() -> Vector2i:
	return pos if location == "overworld" else Vector2i.ZERO


## Tile id at a position on the current map, or -1 if unknown (a chunk that
## hasn't arrived, or off the edge of the base).
func tile_at(p: Vector2i) -> int:
	if location == "base":
		if p.x < 0 or p.y < 0 or p.x >= _base_size.x or p.y >= _base_size.y:
			return -1
		return _base_tiles[p.y * _base_size.x + p.x]
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


func _update_status() -> void:
	if location == "base":
		status_label.text = "%s   %s: %s" % [Net.welcome.get("name", ""), base_info.get("name", "Base"), _room_at(pos)]
		return
	var tile := tile_at(pos)
	var where := tile_names[tile] if tile >= 0 else "..."
	# Directions back to the base at the origin (+y is south).
	var to_base := PackedStringArray()
	if pos.y != 0:
		to_base.append("%d%s" % [absi(pos.y), "N" if pos.y > 0 else "S"])
	if pos.x != 0:
		to_base.append("%d%s" % [absi(pos.x), "W" if pos.x > 0 else "E"])
	var base_text := "   Base: %s" % " ".join(to_base) if not to_base.is_empty() else ""
	status_label.text = "%s   (%d, %d)   %s%s" % [Net.welcome.get("name", ""), pos.x, pos.y, where, base_text]


func _room_at(p: Vector2i) -> String:
	for room: Dictionary in base_info.get("rooms", []):
		if Rect2i(int(room.x), int(room.y), int(room.w), int(room.h)).has_point(p):
			return str(room.name)
	return "Outside the walls"


func _log(line: String) -> void:
	_log_lines.append(line)
	while _log_lines.size() > LOG_LINES:
		_log_lines.pop_front()
	log_label.text = "\n".join(_log_lines)


func _set_paused(paused: bool) -> void:
	pause_menu.visible = paused
	if paused:
		%ResumeButton.grab_focus()
