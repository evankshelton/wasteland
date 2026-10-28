extends Control
## Full-screen world map: every chunk the server has generated so far, drawn as
## a black-and-white, hand-inked chart (shaders/ink_map.gdshader: peaks, trees,
## smooth shorelines, and dashed roads as straight strokes between points along
## them), illustrated towns for clusters of ruins, with the player, other players and zombies
## in view, and the base and every encampment the player has been inside marked
## by name.
##
## Every known tile id goes into one texture the shader reads, grown as more of
## the world is charted. Opening the map asks the server for the chunk index,
## then fetches the chunks this client doesn't have yet in batches. Chunk data
## never changes, so each chunk is only fetched once per session.
##
## Pan: drag, or the movement keys. Zoom: mouse wheel or map_zoom_in/out.
## map_center jumps back to the player; open_map or Esc closes.

const BATCH := 128
const ZOOMS: Array[float] = [0.25, 0.5, 1.0, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0, 24.0, 32.0] ## screen px per tile
const DEFAULT_ZOOM := 7 ## 8 px per tile: close enough for the map symbols
const PAN_SPEED := 700.0 ## screen px per second
const BACKGROUND := Color(0.02, 0.02, 0.02)
const PAPER := Color(0.94, 0.93, 0.89)
const INK := Color(0.07, 0.07, 0.07)
const PLAYER_COLOR := Color(0.75, 0.1, 0.08) ## the one splash of colour: red ink, "you are here"
const INK_MAP := preload("res://shaders/ink_map.gdshader")
const UNCHARTED := 255 ## tile id the shader reads as unknown land
const TILES_MARGIN := 4 ## spare chunks around the charted area, so the tile texture rarely regrows
## Which symbol each terrain gets on the map (the C_ constants in ink_map.gdshader).
## The base and camp icons are blank ground there: _draw_overlay draws them, and
## only the camps this player has been inside.
const SYMBOL_CLASS := {
	"wasteland": 0, "scrub": 1, "dead_forest": 2, "rubble": 3, "ruins": 4, "road": 5, "hills": 6,
	"mountains": 7, "crater": 8, "radiation": 9, "water": 10, "swamp": 11, "dunes": 12,
	"base_icon": 0, "camp_icon": 0,
}
const BUILT_CLASS := 13 ## anything else: walls and floors
const ROAD_CELL := 8 ## tiles per road-network cell: roads are drawn as straight strokes between cells
## Road-network link bits, in the order ink_map.gdshader's ROAD_DIRS expects.
const ROAD_DIRS: Array[Vector2i] = [Vector2i(1, 0), Vector2i(1, 1), Vector2i(0, 1), Vector2i(-1, 1), Vector2i(-1, 0), Vector2i(-1, -1), Vector2i(0, -1), Vector2i(1, -1)]
const CITY_GAP := 2 ## ruins within this many 2x2 blocks of each other are one town
const CITY_MAX_BUILDINGS := 18
const CITY_WALL_AT := 9 ## towns with this many buildings drawn get a wall
const ORTHOGONAL: Array[Vector2i] = [Vector2i.RIGHT, Vector2i.LEFT, Vector2i.DOWN, Vector2i.UP]
const DIAGONAL: Array[Vector2i] = [Vector2i(1, 1), Vector2i(1, -1), Vector2i(-1, 1), Vector2i(-1, -1)]
const SYMBOL_PX := 56.0 ## roughly how big a map symbol is on screen, down to...
const MAX_CELL := 16.0 ## ...one symbol per 16x16 tiles: zoomed out further, symbols shrink instead

var game: Node ## the game.gd scene that owns the chunk data
var _center := Vector2.ZERO ## world tile position at the middle of the screen
var _zoom_index := DEFAULT_ZOOM
var _ink: ColorRect ## the map itself, drawn by the shader
var _overlay: Control ## markers and names, drawn over the map
var _tiles_image: Image ## every known tile id, R8; UNCHARTED where unknown
var _tiles_texture: ImageTexture
var _tiles_origin := Vector2i.ZERO ## chunk at the image's top-left
var _tiles_chunks := Vector2i.ZERO ## the image's size, in chunks
var _charted := {} ## Vector2i chunks already written into the image
var _road_id := -1
var _ruins_id := -1
var _road_tiles := {} ## Vector2i -> true, every road tile charted
var _ruins_tiles := {} ## Vector2i -> true, every ruined building tile charted
var _features_dirty := false ## roads or towns need working out again
var _features_at := 0
## Towns: {center: Vector2 (world tiles), radius: float (tiles), seed: int, layouts: {zoom index: buildings}}
var _cities: Array[Dictionary] = []
var _queue: Array[Vector2i] = []
var _total := 0
var _received := 0
var _awaiting_batch := false
var _blink := 0.0

@onready var info_label: Label = %MapInfo
@onready var status_label: Label = %MapStatus


func setup(owner_game: Node, tiles: Array) -> void:
	game = owner_game
	var classes := PackedInt32Array()
	classes.resize(64)
	classes.fill(BUILT_CLASS)
	for t: Dictionary in tiles:
		if int(t.id) < classes.size():
			classes[int(t.id)] = SYMBOL_CLASS.get(str(t.key), BUILT_CLASS)
		match str(t.key):
			"road": _road_id = int(t.id)
			"ruins": _ruins_id = int(t.id)
	var material := ShaderMaterial.new()
	material.shader = INK_MAP
	material.set_shader_parameter("class_of", classes)
	material.set_shader_parameter("paper", PAPER)
	material.set_shader_parameter("ink", INK)
	material.set_shader_parameter("uncharted", BACKGROUND)
	_ink = ColorRect.new()
	_ink.material = material
	_overlay = Control.new()
	for layer: Control in [_ink, _overlay]:
		layer.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
		layer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_ink)
	move_child(_ink, 0)
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
	# Work out roads and towns again once the chunks stop pouring in (or every second while they do).
	var loading := _awaiting_batch or not _queue.is_empty()
	if _features_dirty and (not loading or Time.get_ticks_msec() - _features_at > 1000):
		_features_dirty = false
		_features_at = Time.get_ticks_msec()
		_trace_roads()
		_find_cities()
	var material: ShaderMaterial = _ink.material
	material.set_shader_parameter("view_origin", _screen_to_world(Vector2.ZERO))
	material.set_shader_parameter("rect_size", size)
	material.set_shader_parameter("zoom", _zoom())
	# Tiles per symbol: a power of two, so symbols only rearrange when the zoom changes.
	material.set_shader_parameter("cell", clampf(pow(2.0, roundf(log(SYMBOL_PX / _zoom()) / log(2.0))), 1.0, MAX_CELL))
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


func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), BACKGROUND)


## Names and markers, in the same pen as the map.
func _draw_overlay() -> void:
	if game == null:
		return
	var z := _zoom()
	var font := get_theme_default_font()
	_draw_cities()
	var icon := clampf(z * 3.0, 28.0, 48.0) # symbol size, px
	var base := _world_to_screen(Vector2(0.5, 0.5))
	_draw_castle(base, icon)
	_label(font, base + Vector2(0, -icon * 1.3), "BASE", 15)
	for at: Vector2i in game.visited_camps:
		var p := _world_to_screen(Vector2(at) + Vector2(0.5, 0.5))
		if not Rect2(Vector2.ZERO, size).grow(200).has_point(p):
			continue
		_draw_tent(p, icon * 0.8)
		_label(font, p + Vector2(0, -icon * 0.95), game.visited_camps[at], 13)

	var marker := maxf(z * 0.8, 7.0)
	for id: int in game.other_positions:
		var p := _world_to_screen(Vector2(game.other_positions[id]) + Vector2(0.5, 0.5))
		_overlay.draw_circle(p, marker * 0.45, PAPER)
		_overlay.draw_arc(p, marker * 0.45, 0.0, TAU, 20, INK, 2.0, true)

	for id: int in game.monster_positions: # Zombies: an inked cross.
		var p := _world_to_screen(Vector2(game.monster_positions[id]) + Vector2(0.5, 0.5))
		var r := marker * 0.35
		_overlay.draw_line(p - Vector2(r, r), p + Vector2(r, r), INK, 2.0, true)
		_overlay.draw_line(p + Vector2(-r, r), p + Vector2(r, -r), INK, 2.0, true)

	# The player: a blinking red mark with crosshairs so it's findable when zoomed out.
	var me := _world_to_screen(Vector2(game.overworld_pos()) + Vector2(0.5, 0.5))
	var color := PLAYER_COLOR if _blink < 0.6 else INK
	for arm: Vector2 in [Vector2.LEFT, Vector2.RIGHT, Vector2.UP, Vector2.DOWN]:
		_overlay.draw_line(me + arm * marker * 0.7, me + arm * marker * 2.2, PAPER, 5.0, true)
		_overlay.draw_line(me + arm * marker * 0.7, me + arm * marker * 2.2, color, 2.0, true)
	_overlay.draw_circle(me, marker * 0.5, PAPER)
	_overlay.draw_circle(me, marker * 0.38, color)


## Trace the road tiles into chains (from end or junction to end), then reduce
## them to a coarse network: a point per ROAD_CELL x ROAD_CELL cell a road
## passes through (where its tiles there average out) and links to the cells it
## runs on to. The shader inks straight dashes along those links, so a road on
## the map shows where it goes rather than every bend. Town streets (road tiles
## beside ruins) are left out; the towns are drawn whole.
func _trace_roads() -> void:
	var nodes := {}
	for t: Vector2i in _road_tiles:
		var town := false
		for d in ORTHOGONAL:
			if game.overworld_tile_at(t + d) == _ruins_id:
				town = true
		if not town:
			nodes[t] = true
	_thin(nodes)
	var links := {}
	for t: Vector2i in nodes:
		var out: Array[Vector2i] = []
		for d in ORTHOGONAL:
			if nodes.has(t + d):
				out.append(t + d)
		for d in DIAGONAL: # Only where the step isn't already joined through a shared neighbour.
			if nodes.has(t + d) and not nodes.has(t + Vector2i(d.x, 0)) and not nodes.has(t + Vector2i(0, d.y)):
				out.append(t + d)
		links[t] = out
	# Ends and junctions first, so chains run between them; then what's left is loops.
	var starts: Array = links.keys().filter(func(t: Vector2i) -> bool: return links[t].size() != 2)
	starts.append_array(links.keys().filter(func(t: Vector2i) -> bool: return links[t].size() == 2))
	var used := {}
	var net := {} # cell -> [sum of tile centres, tile count, link bits]
	for start: Vector2i in starts:
		for first: Vector2i in links[start]:
			if used.has(_edge(start, first)):
				continue
			used[_edge(start, first)] = true
			var path: Array[Vector2i] = [start, first]
			var prev := start
			var cur := first
			while links[cur].size() == 2:
				var nxt: Vector2i = links[cur][0] if links[cur][1] == prev else links[cur][1]
				if used.has(_edge(cur, nxt)):
					break
				used[_edge(cur, nxt)] = true
				path.append(nxt)
				prev = cur
				cur = nxt
			# Thinning leaves the odd stub off the side of a road, and towns leave scraps of street: drop those.
			if path.size() < 5 and (links[path[0]].size() == 1 or links[path[-1]].size() == 1):
				continue
			var last := Vector2i(1 << 30, 0)
			for t in path:
				var c := Vector2i(floori(t.x / float(ROAD_CELL)), floori(t.y / float(ROAD_CELL)))
				if not net.has(c):
					net[c] = [Vector2.ZERO, 0, 0]
				net[c][0] += Vector2(t) + Vector2(0.5, 0.5)
				net[c][1] += 1
				if last.x != 1 << 30 and c != last:
					net[c][2] |= 1 << ROAD_DIRS.find(last - c)
					net[last][2] |= 1 << ROAD_DIRS.find(c - last)
				last = c
	# One RGBA8 texel per cell: where its point sits (RG), its links (B), and whether it has one (A).
	var size_cells := _tiles_image.get_size() / ROAD_CELL
	var origin_cell: Vector2i = _tiles_origin * int(game.chunk_size) / ROAD_CELL
	var image := Image.create_empty(size_cells.x, size_cells.y, false, Image.FORMAT_RGBA8)
	for c: Vector2i in net:
		var at: Vector2 = net[c][0] / net[c][1] / ROAD_CELL - Vector2(c)
		at = at.clamp(Vector2(0.15, 0.15), Vector2(0.85, 0.85))
		var px := c - origin_cell
		if px.x >= 0 and px.y >= 0 and px.x < size_cells.x and px.y < size_cells.y:
			image.set_pixelv(px, Color8(int(at.x * 255), int(at.y * 255), net[c][2], 255))
	var material: ShaderMaterial = _ink.material
	material.set_shader_parameter("roads", ImageTexture.create_from_image(image))
	material.set_shader_parameter("road_cell", float(ROAD_CELL))


## Group the ruins into towns: ruins (in 2x2 blocks) within CITY_GAP blocks of
## each other are one town, drawn at their middle with a size to match.
func _find_cities() -> void:
	var blocks := {}
	for t: Vector2i in _ruins_tiles:
		var b := Vector2i(floori(t.x / 2.0), floori(t.y / 2.0))
		blocks[b] = blocks.get(b, 0) + 1
	var seen := {}
	var old := {}
	for city in _cities: # keep layouts already worked out for towns that haven't changed
		old[city.seed] = city
	_cities.clear()
	for b0: Vector2i in blocks:
		if seen.has(b0):
			continue
		seen[b0] = true
		var stack: Array[Vector2i] = [b0]
		var sum := Vector2.ZERO
		var count := 0
		while not stack.is_empty():
			var b: Vector2i = stack.pop_back()
			sum += (Vector2(b) * 2.0 + Vector2.ONE) * blocks[b]
			count += blocks[b]
			for dy in range(-CITY_GAP, CITY_GAP + 1):
				for dx in range(-CITY_GAP, CITY_GAP + 1):
					var n := b + Vector2i(dx, dy)
					if blocks.has(n) and not seen.has(n):
						seen[n] = true
						stack.append(n)
		var center := sum / count
		var key := hash(Vector2i(center.round()))
		var city: Dictionary = old.get(key, {})
		if city.is_empty() or city.tiles != count:
			city = {"center": center, "radius": maxf(1.5, sqrt(count / PI) * 1.1), "seed": key, "tiles": count, "layouts": {}}
		_cities.append(city)


func _draw_cities() -> void:
	var z := _zoom()
	var screen := Rect2(Vector2.ZERO, size)
	for city in _cities:
		var c := _world_to_screen(city.center)
		var s := clampf(z * 2.6, 11.0, 22.0) # building size, px
		var r := maxf(city.radius * z, s * 0.6)
		if screen.grow(r + s * 2.0).has_point(c):
			_draw_city(city, c, r, s)


## A town in the style of an old map: a loose huddle of houses and towers
## round a keep, and for the bigger ones a rough wall with turrets. The layout
## depends only on the town and the zoom, so it holds still as the map pans.
func _draw_city(city: Dictionary, c: Vector2, r: float, s: float) -> void:
	if not city.layouts.has(_zoom_index):
		city.layouts[_zoom_index] = _lay_out_city(city.seed, r, s)
	var layout: Dictionary = city.layouts[_zoom_index]
	var wall: PackedVector2Array = layout.wall
	if not wall.is_empty():
		var ring := PackedVector2Array()
		for p in wall:
			ring.append(c + p)
		_overlay.draw_colored_polygon(ring, PAPER)
		for i in ring.size(): # the far side of the wall, behind the town
			var a := ring[i]
			var b := ring[(i + 1) % ring.size()]
			if a.y <= c.y or b.y <= c.y:
				_draw_wall(a, b, s)
	for b: Array in layout.buildings:
		var p: Vector2 = c + b[0]
		match b[1]:
			"house": _draw_house(p, s, b[2])
			"tower": _draw_tower(p, s, false)
			"broken": _draw_tower(p, s, true)
			"keep": _draw_keep(p, s)
	if not wall.is_empty():
		var ring := PackedVector2Array()
		for p in wall:
			ring.append(c + p)
		for i in ring.size(): # the near side, in front
			var a := ring[i]
			var b := ring[(i + 1) % ring.size()]
			if a.y > c.y and b.y > c.y:
				_draw_wall(a, b, s)
		for p in ring:
			_draw_tower(p + Vector2(0, s * 0.2), s * 0.7, false)


func _lay_out_city(seed: int, r: float, s: float) -> Dictionary:
	var rng := RandomNumberGenerator.new()
	rng.seed = seed
	var want := clampi(int(PI * r * r * 0.7 / (s * s * 2.2)), 1, CITY_MAX_BUILDINGS)
	var spots: Array[Vector2] = [Vector2.ZERO]
	for attempt in want * 12:
		if spots.size() >= want:
			break
		var at := Vector2(rng.randf_range(-1, 1), rng.randf_range(-1, 1))
		if at.length() > 1.0:
			continue
		at *= Vector2(r, r * 0.7)
		if spots.all(func(o: Vector2) -> bool: return absf(o.x - at.x) > s * 1.15 or absf(o.y - at.y) > s * 0.9):
			spots.append(at)
	var buildings: Array = []
	var big := spots.size() >= 6
	for i in spots.size():
		var kind: String = "keep" if i == 0 and big else ["house", "house", "house", "house", "tower", "broken"][rng.randi() % 6]
		buildings.append([spots[i], kind, rng.randf()])
	buildings.sort_custom(func(a: Array, b: Array) -> bool: return a[0].y < b[0].y)
	var wall := PackedVector2Array()
	if spots.size() >= CITY_WALL_AT: # a rough polygon round the town
		var corners := rng.randi_range(5, 7)
		var turn := rng.randf() * TAU
		for i in corners:
			var angle := turn + TAU * i / corners + rng.randf_range(-0.25, 0.25)
			wall.append(Vector2(cos(angle), sin(angle) * 0.7) * (r + s) * rng.randf_range(0.95, 1.15))
	return {"buildings": buildings, "wall": wall}


## A stretch of town wall from a to b: a low band with a coping line along the top.
func _draw_wall(a: Vector2, b: Vector2, s: float) -> void:
	var up := Vector2(0, -s * 0.35)
	_ink_shape([a, b, b + up, a + up])
	var n := int(a.distance_to(b) / (s * 0.3))
	for i in range(1, n): # crenellations
		var p := a.lerp(b, float(i) / n) + up
		if i % 2 == 0:
			_overlay.draw_line(p, p + Vector2(0, -s * 0.1), INK, 1.0, true)


## A house standing on p: walls, a pitched roof with a little hatching, a door.
func _draw_house(p: Vector2, s: float, v: float) -> void:
	var w := s * (0.8 + v * 0.3)
	var h := s * 0.5
	var body := Rect2(p.x - w / 2, p.y - h, w, h)
	_ink_shape([body.position, Vector2(body.end.x, body.position.y), body.end, Vector2(body.position.x, body.end.y)])
	var peak := Vector2(p.x, body.position.y - s * 0.45)
	_ink_shape([Vector2(body.position.x - s * 0.08, body.position.y), peak, Vector2(body.end.x + s * 0.08, body.position.y)])
	for i in 2: # shade the right slope of the roof
		var f := 0.35 + i * 0.25
		var top := peak.lerp(Vector2(body.end.x + s * 0.08, body.position.y), f)
		_overlay.draw_line(top, top + Vector2(-s * 0.1, s * 0.4 * (1.0 - f) + s * 0.02), INK, 0.8, true)
	var door := Rect2(p.x - s * 0.07 + (v - 0.5) * w * 0.4, p.y - s * 0.22, s * 0.14, s * 0.22)
	_overlay.draw_rect(door, INK, false, 1.0)


## A tower standing on p: battlements, or a broken jagged top if it's a ruin.
func _draw_tower(p: Vector2, s: float, broken: bool) -> void:
	var w := s * 0.55
	var h := s * 1.15
	var x0 := p.x - w / 2
	var x1 := p.x + w / 2
	var y := p.y - h
	if broken:
		_ink_shape([Vector2(x0, p.y), Vector2(x0, y + s * 0.25), Vector2(x0 + w * 0.3, y + s * 0.05), Vector2(x0 + w * 0.5, y + s * 0.3),
				Vector2(x0 + w * 0.75, y), Vector2(x1, y + s * 0.2), Vector2(x1, p.y)])
	else:
		var m := w / 5.0
		_ink_shape([Vector2(x0, p.y), Vector2(x0, y - m), Vector2(x0 + m, y - m), Vector2(x0 + m, y), Vector2(x0 + 2 * m, y),
				Vector2(x0 + 2 * m, y - m), Vector2(x0 + 3 * m, y - m), Vector2(x0 + 3 * m, y), Vector2(x0 + 4 * m, y),
				Vector2(x0 + 4 * m, y - m), Vector2(x1, y - m), Vector2(x1, p.y)])
	_overlay.draw_line(Vector2(p.x, y + s * 0.35), Vector2(p.x, y + s * 0.5), INK, 1.2, true) # window slit
	for i in 3: # shade the right side
		var x := x1 - w * 0.12 - i * w * 0.1
		_overlay.draw_line(Vector2(x, y + s * 0.15 + i * s * 0.1), Vector2(x, p.y - s * 0.05), INK, 0.7, true)


## The town's keep: a broad square tower with a flag.
func _draw_keep(p: Vector2, s: float) -> void:
	var w := s * 1.0
	var h := s * 0.95
	var x0 := p.x - w / 2
	var y := p.y - h
	var m := w / 7.0
	var outline := [Vector2(x0, p.y), Vector2(x0, y - m)]
	for i in range(1, 7):
		outline.append(Vector2(x0 + i * m, y - (m if i % 2 == 0 else 0.0)))
		outline.append(Vector2(x0 + i * m, y - (0.0 if i % 2 == 0 else m)))
	outline.append_array([Vector2(x0 + w, y - m), Vector2(x0 + w, p.y)])
	_ink_shape(outline)
	_draw_tower(Vector2(x0 + w * 0.8, p.y - h * 0.4), s * 0.75, false)
	var arch := [Vector2(p.x - s * 0.1, p.y), Vector2(p.x - s * 0.1, p.y - s * 0.2), Vector2(p.x, p.y - s * 0.28), Vector2(p.x + s * 0.1, p.y - s * 0.2), Vector2(p.x + s * 0.1, p.y)]
	_overlay.draw_polyline(PackedVector2Array(arch), INK, 1.0, true)
	var pole := Vector2(x0 + w * 0.25, y - m)
	_overlay.draw_line(pole, pole + Vector2(0, -s * 0.45), INK, 1.0, true)
	_overlay.draw_colored_polygon(PackedVector2Array([pole + Vector2(0, -s * 0.45), pole + Vector2(s * 0.3, -s * 0.37), pole + Vector2(0, -s * 0.29)]), INK)


## Zhang-Suen thinning: wear wide stretches of road down to a one-tile
## centreline, so tracing finds one long chain rather than a tangle.
func _thin(nodes: Dictionary) -> void:
	# P2..P9: N, NE, E, SE, S, SW, W, NW
	var ring: Array[Vector2i] = [Vector2i(0, -1), Vector2i(1, -1), Vector2i(1, 0), Vector2i(1, 1), Vector2i(0, 1), Vector2i(-1, 1), Vector2i(-1, 0), Vector2i(-1, -1)]
	for round in 20:
		var changed := false
		for step in 2:
			var drop: Array[Vector2i] = []
			for t: Vector2i in nodes:
				var p: Array[bool] = []
				var b := 0
				for d in ring:
					p.append(nodes.has(t + d))
					b += int(p[-1])
				if b < 2 or b > 6:
					continue
				var a := 0
				for i in 8:
					if not p[i] and p[(i + 1) % 8]:
						a += 1
				if a != 1:
					continue
				if step == 0 and not (p[0] and p[2] and p[4]) and not (p[2] and p[4] and p[6]):
					drop.append(t)
				elif step == 1 and not (p[0] and p[2] and p[6]) and not (p[0] and p[4] and p[6]):
					drop.append(t)
			for t in drop:
				nodes.erase(t)
			changed = changed or not drop.is_empty()
		if not changed:
			return


func _edge(a: Vector2i, b: Vector2i) -> Vector4i:
	return Vector4i(a.x, a.y, b.x, b.y) if a < b else Vector4i(b.x, b.y, a.x, a.y)


## The base: a little castle, two pointed towers and a flag, standing on p.
func _draw_castle(p: Vector2, s: float) -> void:
	p += Vector2(0, s * 0.35)
	var keep := Rect2(p + Vector2(-0.3, -0.62) * s, Vector2(0.6, 0.62) * s)
	for tower_x: float in [-0.36, 0.36]:
		var tower := Rect2(p + Vector2(tower_x - 0.12, -0.85) * s, Vector2(0.24, 0.85) * s)
		_ink_shape([tower.position, tower.position + Vector2(tower.size.x, 0), tower.end, tower.position + Vector2(0, tower.size.y)])
		var roof := [p + Vector2(tower_x - 0.16, -0.85) * s, p + Vector2(tower_x + 0.16, -0.85) * s, p + Vector2(tower_x, -1.15) * s]
		_ink_shape(roof)
	_ink_shape([keep.position, keep.position + Vector2(keep.size.x, 0), keep.end, keep.position + Vector2(0, keep.size.y)])
	for i in 4: # battlements
		var m := p + Vector2(-0.21 + i * 0.14, -0.62) * s
		_ink_shape([m + Vector2(-0.035, 0) * s, m + Vector2(-0.035, -0.07) * s, m + Vector2(0.035, -0.07) * s, m + Vector2(0.035, 0) * s])
	var door := [p + Vector2(-0.08, 0) * s, p + Vector2(-0.08, -0.2) * s, p + Vector2(0, -0.26) * s, p + Vector2(0.08, -0.2) * s, p + Vector2(0.08, 0) * s]
	_overlay.draw_polyline(PackedVector2Array(door), INK, 1.5, true)
	var pole := p + Vector2(0.36, -1.15) * s
	_overlay.draw_line(pole, pole + Vector2(0, -0.25) * s, INK, 1.5, true)
	_overlay.draw_colored_polygon(PackedVector2Array([pole + Vector2(0, -0.25) * s, pole + Vector2(0.22, -0.19) * s, pole + Vector2(0, -0.13) * s]), INK)


## An encampment: a tent with a pennant, standing on p.
func _draw_tent(p: Vector2, s: float) -> void:
	p += Vector2(0, s * 0.3)
	var apex := p + Vector2(0, -0.65) * s
	_ink_shape([p + Vector2(-0.45, 0) * s, apex, p + Vector2(0.45, 0) * s])
	_overlay.draw_line(apex, p + Vector2(0, 0) * s, INK, 1.5, true)
	_overlay.draw_line(apex + Vector2(0, 0.3) * s, p + Vector2(0.14, 0) * s, INK, 1.2, true)
	_overlay.draw_line(p + Vector2(-0.6, 0) * s, p + Vector2(0.6, 0) * s, INK, 1.5, true)
	_overlay.draw_line(apex, apex + Vector2(0, -0.22) * s, INK, 1.5, true)
	_overlay.draw_colored_polygon(PackedVector2Array([apex + Vector2(0, -0.22) * s, apex + Vector2(0.2, -0.17) * s, apex + Vector2(0, -0.12) * s]), INK)


## A closed shape: filled with paper (hiding the map behind it), outlined in ink.
func _ink_shape(points: Array) -> void:
	var poly := PackedVector2Array(points)
	_overlay.draw_colored_polygon(poly, PAPER)
	poly.append(poly[0])
	_overlay.draw_polyline(poly, INK, 1.5, true)


## Hand-lettered-ish: ink on a halo of paper, centred over p.
func _label(font: Font, p: Vector2, text: String, font_size: int) -> void:
	var at := p + Vector2(-150, -4)
	_overlay.draw_string_outline(font, at, text, HORIZONTAL_ALIGNMENT_CENTER, 300, font_size, 5, PAPER)
	_overlay.draw_string(font, at, text, HORIZONTAL_ALIGNMENT_CENTER, 300, font_size, INK)


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
		_features_dirty = true # the road network texture has to match the new size
	for key: Vector2i in game.chunks:
		if _charted.has(key):
			continue
		var data: PackedByteArray = game.chunks[key]
		var chunk := Image.create_from_data(cs, cs, false, Image.FORMAT_R8, data)
		_tiles_image.blit_rect(chunk, Rect2i(0, 0, cs, cs), (key - _tiles_origin) * cs)
		_charted[key] = true
		if data.count(_road_id) > 0 or data.count(_ruins_id) > 0:
			for i in data.size():
				if data[i] == _road_id or data[i] == _ruins_id:
					@warning_ignore("integer_division")
					var at := key * cs + Vector2i(i % cs, i / cs)
					if data[i] == _road_id:
						_road_tiles[at] = true
					else:
						_ruins_tiles[at] = true
			_features_dirty = true
	if fits:
		_tiles_texture.update(_tiles_image)
	else:
		_tiles_texture = ImageTexture.create_from_image(_tiles_image)
		var material: ShaderMaterial = _ink.material
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
