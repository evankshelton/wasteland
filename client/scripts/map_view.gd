extends Control
## Full-screen world map: every chunk the server has generated so far, drawn at
## one coloured pixel per tile (scaled by zoom), with the player, other players
## in view and the base marked.
##
## Opening it asks the server for the chunk index, then fetches the chunks this
## client doesn't have yet in batches. Chunk data never changes, so each chunk
## is only fetched and turned into a texture once per session.
##
## Pan: drag, or the movement keys. Zoom: mouse wheel or map_zoom_in/out.
## map_center jumps back to the player; open_map or Esc closes.

const BATCH := 128
const ZOOMS: Array[float] = [0.25, 0.5, 1.0, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0] ## screen px per tile
const DEFAULT_ZOOM := 4
const PAN_SPEED := 700.0 ## screen px per second
const BACKGROUND := Color(0.02, 0.02, 0.02)
const GRID_COLOR := Color(1, 1, 1, 0.05)
const PLAYER_COLOR := Color(1, 1, 0.33)
const OTHER_COLOR := Color(1.0, 0.6, 0.3)

var game: Node ## the game.gd scene that owns the chunk data
var _center := Vector2.ZERO ## world tile position at the middle of the screen
var _zoom_index := DEFAULT_ZOOM
var _textures := {} ## Vector2i chunk -> ImageTexture
var _palette := PackedByteArray() ## tile id * 3 -> r, g, b
var _queue: Array[Vector2i] = []
var _total := 0
var _received := 0
var _awaiting_batch := false
var _blink := 0.0

@onready var info_label: Label = %MapInfo
@onready var status_label: Label = %MapStatus


func setup(owner_game: Node, tiles: Array) -> void:
	game = owner_game
	_palette.resize(tiles.size() * 3)
	for t: Dictionary in tiles:
		var c := Color.html(str(t.get("color", "#ff00ff")))
		var o := int(t.id) * 3
		if o + 2 < _palette.size():
			_palette[o] = c.r8
			_palette[o + 1] = c.g8
			_palette[o + 2] = c.b8


func open() -> void:
	_center = Vector2(game.pos) + Vector2(0.5, 0.5)
	show()
	_update_info()
	Net.send({"t": "map"})
	status_label.text = "Surveying..."


func close() -> void:
	hide()


func _process(delta: float) -> void:
	if not visible:
		return
	_blink = fmod(_blink + delta, 1.0)
	var pan := Input.get_vector(&"move_left", &"move_right", &"move_up", &"move_down")
	if pan != Vector2.ZERO:
		_center += pan * PAN_SPEED * delta / _zoom()
		_update_info()
	queue_redraw()


func _unhandled_input(event: InputEvent) -> void:
	if not visible:
		return
	if event.is_action_pressed(&"open_map") or event.is_action_pressed(&"ui_cancel"):
		close()
	elif event.is_action_pressed(&"map_zoom_in", true):
		_set_zoom(_zoom_index + 1, size / 2)
	elif event.is_action_pressed(&"map_zoom_out", true):
		_set_zoom(_zoom_index - 1, size / 2)
	elif event.is_action_pressed(&"map_center"):
		_center = Vector2(game.pos) + Vector2(0.5, 0.5)
	else:
		return
	get_viewport().set_input_as_handled()


func _gui_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed:
		if event.button_index == MOUSE_BUTTON_WHEEL_UP:
			_set_zoom(_zoom_index + 1, event.position)
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			_set_zoom(_zoom_index - 1, event.position)
		accept_event()
	elif event is InputEventMouseMotion:
		if event.button_mask & (MOUSE_BUTTON_MASK_LEFT | MOUSE_BUTTON_MASK_RIGHT):
			_center -= event.relative / _zoom()
		_update_info()
		accept_event()


# ---- loading, driven by game.gd ----

func on_index(coords: Array) -> void:
	_queue.clear()
	for c: Array in coords:
		var key := Vector2i(int(c[0]), int(c[1]))
		if not game.chunks.has(key):
			_queue.append(key)
	# Nearest first, so the area around the player fills in before the far reaches.
	var here: Vector2i = game.chunk_of(game.pos)
	_queue.sort_custom(func(a: Vector2i, b: Vector2i) -> bool:
		return (a - here).length_squared() < (b - here).length_squared())
	_total = _queue.size()
	_received = 0
	if not _awaiting_batch:
		_request_batch()


func on_chunk() -> void:
	_received += 1
	if _total > 0:
		status_label.text = "Charting %d / %d chunks" % [_received, _total]


func on_batch_done() -> void:
	_awaiting_batch = false
	_request_batch()


func _request_batch() -> void:
	if _queue.is_empty():
		status_label.text = "%d chunks charted" % game.chunks.size()
		return
	var coords := []
	for c in _queue.slice(0, BATCH):
		coords.append([c.x, c.y])
	_queue = _queue.slice(BATCH)
	_awaiting_batch = true
	Net.send({"t": "map_chunks", "coords": coords})


# ---- drawing ----

func _zoom() -> float:
	return ZOOMS[_zoom_index]


func _set_zoom(index: int, anchor: Vector2) -> void:
	index = clampi(index, 0, ZOOMS.size() - 1)
	if index == _zoom_index:
		return
	# Keep the tile under the anchor (usually the mouse) where it is on screen.
	var world_at_anchor := _screen_to_world(anchor)
	_zoom_index = index
	_center = world_at_anchor - (anchor - size / 2) / _zoom()
	_update_info()


func _screen_to_world(p: Vector2) -> Vector2:
	return _center + (p - size / 2) / _zoom()


func _world_to_screen(p: Vector2) -> Vector2:
	return (p - _center) * _zoom() + size / 2


func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), BACKGROUND)
	if game == null:
		return
	var cs: int = game.chunk_size
	var z := _zoom()
	var top_left: Vector2i = game.chunk_of(Vector2i(_screen_to_world(Vector2.ZERO).floor()))
	var bottom_right: Vector2i = game.chunk_of(Vector2i(_screen_to_world(size).floor()))
	var chunk_px := Vector2(cs, cs) * z

	for cy in range(top_left.y, bottom_right.y + 1):
		for cx in range(top_left.x, bottom_right.x + 1):
			var key := Vector2i(cx, cy)
			var screen_pos := _world_to_screen(Vector2(key * cs))
			if game.chunks.has(key):
				draw_texture_rect(_texture_for(key), Rect2(screen_pos, chunk_px), false)
			elif z >= 1.0:
				draw_rect(Rect2(screen_pos, chunk_px), GRID_COLOR, false)

	var font := get_theme_default_font()
	var base_pos := _world_to_screen(Vector2(0.5, -9.5))
	draw_string(font, base_pos + Vector2(-20, -4), "BASE", HORIZONTAL_ALIGNMENT_CENTER, 40, 14, Color.WHITE)

	var marker := maxf(z, 7.0)
	for id: int in game.other_positions:
		var p := _world_to_screen(Vector2(game.other_positions[id]) + Vector2(0.5, 0.5))
		draw_circle(p, marker * 0.5 + 1.0, Color.BLACK)
		draw_circle(p, marker * 0.5, OTHER_COLOR)

	# The player: a blinking square with crosshairs so it's findable when zoomed out.
	var me := _world_to_screen(Vector2(game.pos) + Vector2(0.5, 0.5))
	var color := PLAYER_COLOR if _blink < 0.6 else Color.WHITE
	for arm: Vector2 in [Vector2.LEFT, Vector2.RIGHT, Vector2.UP, Vector2.DOWN]:
		draw_line(me + arm * marker, me + arm * marker * 2.5, Color.BLACK, 4.0)
		draw_line(me + arm * marker, me + arm * marker * 2.5, color, 2.0)
	var box := Rect2(me - Vector2(marker, marker) * 0.5, Vector2(marker, marker))
	draw_rect(box.grow(1.0), Color.BLACK)
	draw_rect(box, color)


func _texture_for(key: Vector2i) -> ImageTexture:
	var tex: ImageTexture = _textures.get(key)
	if tex:
		return tex
	var data: PackedByteArray = game.chunks[key]
	var rgb := PackedByteArray()
	rgb.resize(data.size() * 3)
	for i in data.size():
		var o := data[i] * 3
		if o + 2 >= _palette.size():
			continue # Unknown tile id: leave black.
		rgb[i * 3] = _palette[o]
		rgb[i * 3 + 1] = _palette[o + 1]
		rgb[i * 3 + 2] = _palette[o + 2]
	var cs: int = game.chunk_size
	tex = ImageTexture.create_from_image(Image.create_from_data(cs, cs, false, Image.FORMAT_RGB8, rgb))
	_textures[key] = tex
	return tex


func _update_info() -> void:
	var mouse := get_local_mouse_position()
	var tile := Vector2i(_screen_to_world(mouse).floor())
	var id: int = game.tile_at(tile)
	var terrain: String = game.tile_names[id] if id >= 0 else "Uncharted"
	var z := _zoom()
	var zoom_text := "%dx" % int(z) if z >= 1.0 else "1/%dx" % int(1.0 / z)
	info_label.text = "(%d, %d)  %s    zoom %s" % [tile.x, tile.y, terrain, zoom_text]
