extends Control
## Full-screen world map: every chunk the server has generated so far, drawn in
## the game's own 16x16 EGA tiles (shaders/pixel_map.gdshader). Each tile on the
## map stands for a cell of the world - a few tiles across close up, dozens zoomed
## out - and is drawn at a whole number of screen pixels per art pixel, so the
## map is crisp pixel art at every zoom. The player, other players and zombies
## are the game's sprites; the base and every encampment the player has been
## inside are their icons, named.
##
## Every known tile id goes into one texture the shader reads, grown as more of
## the world is charted. Opening the map asks the server for the chunk index,
## then fetches the chunks this client doesn't have yet in batches. Chunk data
## never changes, so each chunk is only fetched once per session.
##
## Pan: drag, or the movement keys. Zoom: mouse wheel or map_zoom_in/out.
## map_center jumps back to the player; open_map or Esc closes.

const BATCH := 128
const ZOOMS: Array[float] = [3.0, 4.0] ## screen px per tile
const DEFAULT_ZOOM := 1 ## 4 px per tile: a map tile for every 8x8 of the world, at 2x
const ROADS_FROM_ZOOM := 4.0 ## zoomed out further than this, the map shows no roads at all
const PAN_SPEED := 700.0 ## screen px per second
const BACKGROUND := Color.BLACK
const LABEL_COLOR := Color(1.0, 1.0, 0.33) ## EGA yellow
const OTHER_TINT := Color(1.0, 0.6, 0.3) ## as other players are tinted in the game
const AVATAR_REGION := Rect2(0, 0, 16, 16) ## sprites.png column 0
const ZOMBIE_REGION := Rect2(16, 0, 16, 16) ## sprites.png column 1
const PIXEL_MAP := preload("res://shaders/pixel_map.gdshader")
const TILES_ART := preload("res://assets/tiles.png")
const SPRITES_ART := preload("res://assets/sprites.png")
const ART := 16 ## art pixels per tile
const UNCHARTED := 255 ## tile id the shader reads as unknown land
const TILES_MARGIN := 4 ## spare chunks around the charted area, so the tile texture rarely regrows
## Tiles the map shows as something else: camps are only marked once visited
## (by _draw_overlay), and the base is drawn there too, so neither is lost to a big cell.
const SHOW_AS := {"camp_icon": "wasteland", "base_icon": "wasteland"}
## A cell with a road through it shows road, unless it's one of these.
const KEEP_OVER_ROAD: Array[String] = ["ruins", "water", "mountains", "rubble"]

var game: Node ## the game.gd scene that owns the chunk data
var _center := Vector2.ZERO ## world tile position at the middle of the screen
var _zoom_index := DEFAULT_ZOOM
var _pixels: ColorRect ## the map itself, drawn by the shader
var _overlay: Control ## icons, sprites and names, drawn over the map
var _tiles_image: Image ## every known tile id, R8; UNCHARTED where unknown
var _tiles_texture: ImageTexture
var _tiles_origin := Vector2i.ZERO ## chunk at the image's top-left
var _tiles_chunks := Vector2i.ZERO ## the image's size, in chunks
var _charted := {} ## Vector2i chunks already written into the image
var _icon_of := {} ## tile key -> tile id, for the icons drawn over the map
var _road_tiles := {} ## Vector2i -> true, every road tile charted
var _road_masks := {} ## cell size -> ImageTexture counting the road tiles in each cell
var _queue: Array[Vector2i] = []
var _total := 0
var _received := 0
var _awaiting_batch := false
var _blink := 0.0

@onready var info_label: Label = %MapInfo
@onready var status_label: Label = %MapStatus


func setup(owner_game: Node, tiles: Array) -> void:
	game = owner_game
	for t: Dictionary in tiles:
		_icon_of[str(t.key)] = int(t.id)
	var remap := PackedInt32Array()
	for id in 64:
		remap.append(id)
	for key: String in SHOW_AS:
		if _icon_of.has(key) and _icon_of.has(SHOW_AS[key]):
			remap[_icon_of[key]] = _icon_of[SHOW_AS[key]]
	var material := ShaderMaterial.new()
	material.shader = PIXEL_MAP
	material.set_shader_parameter("art", TILES_ART)
	material.set_shader_parameter("remap", remap)
	material.set_shader_parameter("road_id", _icon_of.get("road", -1))
	material.set_shader_parameter("plain_id", _icon_of.get("wasteland", 1))
	var keep := PackedInt32Array()
	for key in KEEP_OVER_ROAD:
		keep.append(_icon_of.get(key, -1))
	material.set_shader_parameter("keep_over_road", keep)
	_pixels = ColorRect.new()
	_pixels.material = material
	_overlay = Control.new()
	_overlay.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	for layer: Control in [_pixels, _overlay]:
		layer.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
		layer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_pixels)
	move_child(_pixels, 0)
	add_child(_overlay)
	move_child(_overlay, 1)
	_overlay.draw.connect(_draw_overlay)


func open() -> void:
	_center = Vector2(game.overworld_pos()) + Vector2(0.5, 0.5)
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
	_chart_new_chunks()
	var material: ShaderMaterial = _pixels.material
	material.set_shader_parameter("view_origin", _screen_to_world(Vector2.ZERO))
	material.set_shader_parameter("rect_size", size)
	material.set_shader_parameter("zoom", _zoom())
	material.set_shader_parameter("cell", float(_cell()))
	material.set_shader_parameter("roads", _road_mask(_cell()))
	material.set_shader_parameter("show_roads", _zoom() >= ROADS_FROM_ZOOM)
	_overlay.queue_redraw()


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
		_center = Vector2(game.overworld_pos()) + Vector2(0.5, 0.5)
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
	var here: Vector2i = game.chunk_of(game.overworld_pos())
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


## Tiles per map cell at this zoom: a power of two that makes each art pixel a
## whole number of screen pixels - 2 if it can (chunky, like the game), else 3, else 1.
func _cell() -> int:
	for want in [2, 3, 1]:
		var cell := 1
		while cell <= 256:
			if is_equal_approx(_zoom() * cell / ART, want):
				return cell
			cell *= 2
	return maxi(1, int(ART / _zoom()))


func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), BACKGROUND)


## The base, visited camps, players and zombies, each drawn into the map cell
## it's in at the map's own scale, like a piece on the game board.
func _draw_overlay() -> void:
	if game == null:
		return
	var cell := _cell()
	var font := get_theme_default_font()
	var screen := Rect2(Vector2.ZERO, size).grow(64)
	var placed := {} # cell -> true, so only one thing is drawn in each

	_draw_in_cell(TILES_ART, Rect2(_icon_of.get("base_icon", 0) * ART, 0, ART, ART), Vector2i.ZERO, Color.WHITE)
	_label(font, Vector2i.ZERO, "BASE")
	for at: Vector2i in game.visited_camps:
		if screen.has_point(_world_to_screen(Vector2(at))):
			_draw_in_cell(TILES_ART, Rect2(_icon_of.get("camp_icon", 0) * ART, 0, ART, ART), at, Color.WHITE)
			_label(font, at, game.visited_camps[at])
			placed[_cell_of(at)] = true

	for id: int in game.monster_positions:
		var at: Vector2i = game.monster_positions[id]
		if not placed.has(_cell_of(at)):
			_draw_in_cell(SPRITES_ART, ZOMBIE_REGION, at, Color.WHITE)
	for id: int in game.other_positions:
		_draw_in_cell(SPRITES_ART, AVATAR_REGION, game.other_positions[id], OTHER_TINT)
	# The player blinks, as the cursor did on old maps, so they're easy to find.
	if _blink < 0.65:
		_draw_in_cell(SPRITES_ART, AVATAR_REGION, game.overworld_pos(), Color.WHITE)
	else:
		var r := _cell_rect(game.overworld_pos())
		_overlay.draw_rect(r, LABEL_COLOR, false, maxf(2.0, r.size.x / ART))


func _cell_of(at: Vector2i) -> Vector2i:
	var cell := _cell()
	return Vector2i(floori(at.x / float(cell)), floori(at.y / float(cell)))


## The screen rect of the map cell holding world tile `at`.
func _cell_rect(at: Vector2i) -> Rect2:
	var cell := _cell()
	var top_left := _world_to_screen(Vector2(_cell_of(at) * cell))
	return Rect2(top_left, Vector2.ONE * cell * _zoom())


func _draw_in_cell(texture: Texture2D, region: Rect2, at: Vector2i, tint: Color) -> void:
	var r := _cell_rect(at)
	if Rect2(Vector2.ZERO, size).intersects(r):
		_overlay.draw_texture_rect_region(texture, r, region, tint)


## A name over a map cell, in EGA yellow with a black outline.
func _label(font: Font, at: Vector2i, text: String) -> void:
	var r := _cell_rect(at)
	var p := Vector2(r.get_center().x - 150, r.position.y - 4)
	_overlay.draw_string_outline(font, p, text, HORIZONTAL_ALIGNMENT_CENTER, 300, 14, 4, Color.BLACK)
	_overlay.draw_string(font, p, text, HORIZONTAL_ALIGNMENT_CENTER, 300, 14, LABEL_COLOR)


## How many road tiles each cell of this size holds, as a texture over the same area as the tiles.
func _road_mask(cell: int) -> ImageTexture:
	if _road_masks.has(cell) or _tiles_image == null:
		return _road_masks.get(cell)
	var origin := Vector2i((Vector2(_tiles_origin * int(game.chunk_size)) / cell).floor()) # the cell holding the tiles' corner
	var size_cells := Vector2i((Vector2(_tiles_image.get_size()) / cell).ceil()) + Vector2i.ONE
	var image := Image.create_empty(size_cells.x, size_cells.y, false, Image.FORMAT_R8)
	for t: Vector2i in _road_tiles:
		var px := Vector2i((Vector2(t) / cell).floor()) - origin
		image.set_pixelv(px, Color8(mini(255, image.get_pixelv(px).r8 + 1), 0, 0))
	_road_masks[cell] = ImageTexture.create_from_image(image)
	return _road_masks[cell]


## Write any chunks that arrived since last frame into the tile texture,
## regrowing it (with a margin) when the charted area outgrows it.
func _chart_new_chunks() -> void:
	if _charted.size() == game.chunks.size():
		return
	var lo := Vector2i(1 << 30, 1 << 30)
	var hi := -lo
	for key: Vector2i in game.chunks:
		lo = Vector2i(mini(lo.x, key.x), mini(lo.y, key.y))
		hi = Vector2i(maxi(hi.x, key.x), maxi(hi.y, key.y))
	var cs: int = game.chunk_size
	var fits := _tiles_image != null and Rect2i(_tiles_origin, _tiles_chunks).encloses(Rect2i(lo, hi - lo + Vector2i.ONE))
	if not fits:
		_tiles_origin = lo - Vector2i(TILES_MARGIN, TILES_MARGIN)
		_tiles_chunks = hi - lo + Vector2i.ONE * (1 + TILES_MARGIN * 2)
		_tiles_image = Image.create_empty(_tiles_chunks.x * cs, _tiles_chunks.y * cs, false, Image.FORMAT_R8)
		_tiles_image.fill(Color8(UNCHARTED, 0, 0))
		_charted.clear()
		_road_masks.clear()
	for key: Vector2i in game.chunks:
		if _charted.has(key):
			continue
		var data: PackedByteArray = game.chunks[key]
		var chunk := Image.create_from_data(cs, cs, false, Image.FORMAT_R8, data)
		_tiles_image.blit_rect(chunk, Rect2i(0, 0, cs, cs), (key - _tiles_origin) * cs)
		_charted[key] = true
		var road: int = _icon_of.get("road", -1)
		if data.count(road) > 0:
			for i in data.size():
				if data[i] == road:
					@warning_ignore("integer_division")
					_road_tiles[key * cs + Vector2i(i % cs, i / cs)] = true
			_road_masks.clear()
	if fits:
		_tiles_texture.update(_tiles_image)
	else:
		_tiles_texture = ImageTexture.create_from_image(_tiles_image)
		var material: ShaderMaterial = _pixels.material
		material.set_shader_parameter("tiles", _tiles_texture)
		material.set_shader_parameter("tiles_origin", Vector2(_tiles_origin * cs))
		material.set_shader_parameter("tiles_size", Vector2(_tiles_image.get_size()))


func _update_info() -> void:
	var mouse := get_local_mouse_position()
	var tile := Vector2i(_screen_to_world(mouse).floor())
	var id: int = game.overworld_tile_at(tile)
	var terrain: String = game.visited_camps.get(tile, game.tile_names[id] if id >= 0 else "Uncharted")
	var z := _zoom()
	var zoom_text := "%dx" % int(z) if z >= 1.0 else "1/%dx" % int(1.0 / z)
	info_label.text = "(%d, %d)  %s    zoom %s" % [tile.x, tile.y, terrain, zoom_text]
