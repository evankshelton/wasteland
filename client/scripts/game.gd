extends Node2D
## The overworld: draws the chunks the server streams in, moves the avatar one
## tile per step, and shows other players nearby.
##
## Movement is server-authoritative. A step onto a known walkable tile is shown
## immediately; only one step is in flight at a time and the server's reply
## ("you") always wins.

const MENU_SCENE := "res://scenes/main_menu.tscn"
const TILES_TEXTURE := preload("res://assets/tiles.png")
const SPRITES_TEXTURE := preload("res://assets/sprites.png")
const TILE := 16
const MOVE_REPEAT := 0.13 ## seconds between steps while a key is held
const MOVE_TIMEOUT_MS := 2000
const OTHER_TINT := Color(1.0, 0.6, 0.3)
const ZOMBIE_REGION := Rect2(16, 0, 16, 16) ## sprites.png column 1
const ZOMBIE_STEP_TIME := 0.35 ## seconds to animate one shambling step
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

var _seq := 0
var _pending_seq := -1 ## seq of the step awaiting a reply, -1 if none
var _pending_since_ms := 0
var _repeat := 0.0
var _log_lines: Array[String] = []
var _lost := false

@onready var terrain: TileMapLayer = %Terrain
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
	terrain.tile_set = _build_tileset(tile_names.size())
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
	if _lost:
		return
	if event.is_action_pressed(&"ui_cancel"):
		_set_paused(not pause_menu.visible)
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed(&"open_map") and not pause_menu.visible:
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


func _on_disconnected(reason: String) -> void:
	_lost = true
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
	if _lost or pause_menu.visible or map_view.visible:
		return
	var action := _held_direction()
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
	var tile := tile_at(target)
	if tile >= 0 and not tile_passable[tile]:
		_log("Blocked by %s." % tile_names[tile].to_lower())
		return
	if target in monster_positions.values():
		_log("A zombie blocks your way!")
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


# ---- world queries ----

func chunk_of(p: Vector2i) -> Vector2i:
	return Vector2i(floori(float(p.x) / chunk_size), floori(float(p.y) / chunk_size))


## Tile id at a world position, or -1 if that chunk hasn't arrived yet.
func tile_at(p: Vector2i) -> int:
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


func _upsert_player(id: int, player_name: String, p: Vector2i) -> void:
	var node: Node2D = others.get(id)
	if node == null:
		node = Node2D.new()
		var sprite := Sprite2D.new()
		sprite.texture = SPRITES_TEXTURE
		sprite.region_enabled = true
		sprite.region_rect = Rect2(0, 0, TILE, TILE)
		sprite.modulate = OTHER_TINT
		node.add_child(sprite)
		var label := Label.new()
		label.text = player_name
		label.add_theme_font_size_override(&"font_size", 6)
		label.add_theme_constant_override(&"outline_size", 2)
		label.add_theme_color_override(&"font_outline_color", Color.BLACK)
		label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		label.size = Vector2(64, 8)
		label.position = Vector2(-32, -17)
		node.add_child(label)
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


func _log(line: String) -> void:
	_log_lines.append(line)
	while _log_lines.size() > LOG_LINES:
		_log_lines.pop_front()
	log_label.text = "\n".join(_log_lines)


func _set_paused(paused: bool) -> void:
	pause_menu.visible = paused
	if paused:
		%ResumeButton.grab_focus()
