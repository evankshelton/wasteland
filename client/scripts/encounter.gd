extends Node3D
## First-person fight, started when a zombie and the player share an overworld
## tile. The arena is the patch of overworld around the encounter, (2r+1)^2
## tiles with each tile a CELL x CELL metre area, built from that tile's
## terrain: mountains, ruins, walls and water block, dead forests have trees,
## hot zones glow and burn, sludge slows you down. The ground rolls gently
## (hills rise, water and marsh sit in hollows) and neighbouring terrain types
## blend into each other along meandering borders rather than meeting in
## squares (see shaders/terrain.gdshader).
##
## Fog closes in a few metres out and fades everything to black by 18 m, with
## no horizon (encounter.tscn's environment), plus sooty fog banks and dust
## drifting around the player (_build_atmosphere). Each zombie on the overworld
## is a pack of 1-15 here, scattered around where it stood.
##
## Kill every zombie, or cross the edge of the arena to flee; `finished` then
## reports the result for game.gd to send to the server.

signal finished(result: String, killed: Array, dir: String)

const TERRAIN_SHADER := preload("res://shaders/terrain.gdshader")
const WATER_SHADER := preload("res://shaders/water.gdshader")
const BOUNDARY_SHADER := preload("res://shaders/boundary.gdshader")

const CELL := 12.0 ## metres per overworld tile
## The realistic ground textures (tools/make_ground_textures.gd), in layer order.
const GROUND_TEXTURES := ["dirt", "scrub", "forest", "gravel", "asphalt", "rock", "ash", "char", "irradiated", "mud", "concrete"]
## Which ground texture each terrain uses, and how rough it is (wet mud shines).
const GROUND_FOR := {
	"wasteland": ["dirt", 0.95], "scrub": ["scrub", 0.95], "dead_forest": ["forest", 0.9],
	"rubble": ["gravel", 0.9], "ruins": ["gravel", 0.9], "road": ["asphalt", 0.85], "hills": ["rock", 0.9],
	"mountains": ["rock", 0.9], "crater": ["char", 0.95], "radiation": ["irradiated", 0.8],
	"water": ["mud", 0.35], "swamp": ["mud", 0.4], "dunes": ["ash", 0.95], "base_wall": ["concrete", 0.85],
	"base_floor": ["concrete", 0.85], "base_gate": ["concrete", 0.85], "base_icon": ["concrete", 0.85],
	"concrete": ["concrete", 0.85], "camp_icon": ["dirt", 0.95],
}
const GROUND_TEXTURE_METRES := 4.0 ## one repeat of a ground texture
const GROUND_MARGIN := 48.0 ## metres of terrain beyond the arena's edge, towards the horizon
const MESH_STEP := 2.0 ## metres between ground mesh vertices (the collider uses 1 m)
const SINK := 3.0 ## metres blocks extend below the ground so they never float on a slope
## Per terrain type: [height offset in metres, roughness multiplier].
const RELIEF := {
	"hills": [2.5, 1.7], "mountains": [3.0, 1.3], "dunes": [0.6, 1.2], "scrub": [0.2, 1.0],
	"dead_forest": [0.4, 1.1], "water": [-1.8, 0.3], "swamp": [-0.6, 0.4], "crater": [-1.0, 1.4],
	"road": [0.0, 0.25], "ruins": [0.0, 0.35], "rubble": [0.0, 0.7], "base_icon": [0.0, 0.2],
	"base_wall": [0.0, 0.2], "base_floor": [0.0, 0.2], "base_gate": [0.0, 0.2], "concrete": [0.0, 0.2],
	"camp_icon": [0.0, 0.3],
}
const BLOCK_TEXTURE_SIZE := 6.0 ## metres per repeat of the rock and concrete textures on blocks
const CLEAR_RADIUS := 3.0 ## metres kept free of trees and debris around where anyone starts
const PACK_SPACING := 3.5 ## metres between zombies of a pack when they appear
const PACK_CLEARANCE := 10.0 ## no zombie starts closer than this to the player
## Tree models (any .glb here, git-ignored like the zombie) replace the stick
## trees when present; each tree picks one at random.
const TREE_MODEL_DIR := "res://models/trees/"
const TREE_HEIGHT := Vector2(8.0, 16.0) ## metres, min and max
## Heights snap to this many sizes so each model needs only a few mesh colliders
## (one per size, shared by every tree of that model and size).
const TREE_SIZES := 5
const TREE_SPACING := 7.0 ## minimum metres between tree trunks
const TREE_BATCH_CELLS := 3 ## trees are batched per 3x3-cell block so distant blocks can cull and use LODs
## Running speed and fire rate come from dexterity, damage from strength and
## health from the hit points ability (see setup()).
const SWAMP_SPEED_FACTOR := 0.55
const MOUSE_SENSITIVITY := 0.0025

const SHOT_RANGE := 250.0
const RADIATION_DPS := 0.5
const GRAVITY := 20.0
const MAX_GLOW_LIGHTS := 8
const END_DELAY := 1.6 ## seconds the outcome banner shows before returning to the overworld

const LAYER_WORLD := 1
const LAYER_PLAYER := 2
const LAYER_ENEMIES := 4

## Terrain keys whose cells get a solid block.
const SOLID := ["mountains", "ruins", "base_wall", "water"]

var radius := 8
var half_extent := 34.0 ## radius of the ring at the arena's edge; crossing it means fleeing
var max_health := 10.0
var health := 10.0
var shot_damage := 42.0
var fire_interval := 0.28
var run_speed := 4.7
var enemies := {} ## monster id -> Zombie3D
var killed: Array[int] = [] ## overworld zombies whose whole pack is dead
var _pack_size := {} ## overworld zombie id -> zombies in its pack
var _pack_left := {} ## overworld zombie id -> still standing
var _dead := 0

var _cells := {} ## Vector2i offset from the encounter tile -> terrain key
var _keys := {} ## tile id -> key
var _rng := RandomNumberGenerator.new()
var _materials := {}
var _fire_cooldown := 0.0
var _ended := false
var _hurt := 0.0
var _clearings: Array[Vector3] = [] ## where the player and zombies start
## Repeated decoration (trees, debris, tufts) is drawn as one MultiMesh per
## kind: thousands of separate meshes would be thousands of draw calls.
## kind -> {mesh, material, transforms: Array[Transform3D], colors: Array[Color]}
var _batches := {}
var _trees: Array[Vector3] = [] ## trunk positions placed so far
var _ids := {} ## Vector2i cell -> tile id
var _relief := {} ## Vector2i cell -> [offset, roughness]
var _hills := FastNoiseLite.new()
var _bumps := FastNoiseLite.new()

var _cells_texture: ImageTexture
static var _breakup: ImageTexture
static var _wisp: ImageTexture
const WIND := Vector3(0.6, 0.0, 0.25) ## metres per second the dust and fog drift
static var _ground_arrays: Array[Texture2DArray] = [] ## [albedo, normal], built once

## Loaded once: [{mesh, transform (model space -> tree root), height, footprint,
## colliders: [ConcavePolygonShape3D per size]}] per tree model.
static var _tree_models: Array = []
static var _tree_models_loaded := false

@onready var arena: Node3D = %Arena
@onready var enemies_root: Node3D = %Enemies
@onready var player: CharacterBody3D = %Player
@onready var camera: Camera3D = %Camera
@onready var gun: Node3D = %Gun
@onready var muzzle_flash: OmniLight3D = %MuzzleFlash
@onready var sun: DirectionalLight3D = %Sun
@onready var health_bar: ProgressBar = %HealthBar
@onready var enemies_label: Label = %EnemiesLabel
@onready var hint_label: Label = %Hint
@onready var banner: Label = %Banner
@onready var damage_flash: ColorRect = %DamageFlash


## `game` supplies the overworld tiles (tile_at); `msg` is the server's encounter_start.
func setup(game: Node, msg: Dictionary) -> void:
	var c := Net.character
	max_health = float(c.get("maxHp", 10))
	health = clampf(float(c.get("hp", max_health)), 1.0, max_health)
	shot_damage = 30.0 + float(c.get("str", 12)) # 3 shots per zombie at 12, 2 from 21, 1 from 70.
	fire_interval = clampf(0.3 - float(c.get("dex", 12)) * 0.002, 0.1, 0.3)
	run_speed = 4.5 + float(c.get("dex", 12)) * 0.02
	health_bar.max_value = max_health
	radius = int(msg.radius)
	half_extent = (radius + 0.5) * CELL
	_rng.seed = int(msg.seed)
	for t: Dictionary in Net.welcome.tiles:
		_keys[int(t.id)] = str(t.key)
	var center := Vector2i(int(msg.x), int(msg.y))
	for dy in range(-radius, radius + 1):
		for dx in range(-radius, radius + 1):
			var id: int = game.tile_at(center + Vector2i(dx, dy))
			if id < 0:
				id = 1 # Not streamed to us yet: call it wasteland.
			_ids[Vector2i(dx, dy)] = id
			_cells[Vector2i(dx, dy)] = _keys.get(id, "wasteland")
			_relief[Vector2i(dx, dy)] = RELIEF.get(_cells[Vector2i(dx, dy)], [0.0, 1.0])
	_hills.seed = int(msg.seed)
	_hills.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	_hills.frequency = 1.0 / 70.0
	_hills.fractal_octaves = 3
	_bumps.seed = int(msg.seed) + 1
	_bumps.frequency = 1.0 / 9.0

	# Where everyone starts; trees and debris keep clear of these spots.
	_clearings.append(Vector3.ZERO)
	var spawns := []
	var jitter := CELL / 2.0 - 2.0
	for e: Dictionary in msg.enemies:
		var cell := Vector2i(int(e.dx), int(e.dy))
		if cell == Vector2i.ZERO:
			cell = _open_cell_near_player() # It caught us: give it some room.
		var at := _cell_center(cell) + Vector3(_rng.randf_range(-jitter, jitter), 0, _rng.randf_range(-jitter, jitter))
		var inside := half_extent - 6.0 # Corner cells reach past the ring: start those zombies just inside it.
		if Vector2(at.x, at.z).length() > inside:
			var flat := Vector2(at.x, at.z).normalized() * inside
			at = Vector3(flat.x, 0, flat.y)
		at.y = height_at(at.x, at.z)
		# One overworld zombie is a pack: the rest gather a few metres around the first.
		var id := int(e.id)
		var size := clampi(int(e.get("count", 1)), 1, 15)
		_pack_size[id] = size
		_pack_left[id] = size
		# The pack scatters around that spot, wider the bigger it is (about 28 m
		# across for 15), each zombie keeping its distance from the rest and
		# none starting right on top of the player.
		var reach := 5.0 + size * 1.5
		var members: Array[Vector2] = []
		for member in size:
			var flat := Vector2(at.x, at.z)
			if member > 0:
				for attempt in 12:
					flat = Vector2(at.x, at.z) + Vector2.from_angle(_rng.randf() * TAU) * sqrt(_rng.randf()) * reach
					if members.all(func(m: Vector2) -> bool: return m.distance_to(flat) >= PACK_SPACING):
						break
			if flat.length() > inside:
				flat = flat.normalized() * inside
			if flat.length() < PACK_CLEARANCE:
				flat = flat.normalized() * PACK_CLEARANCE if flat.length() > 0.1 else Vector2(0, -PACK_CLEARANCE)
			members.append(flat)
			var spot := Vector3(flat.x, height_at(flat.x, flat.y), flat.y)
			_clearings.append(spot)
			spawns.append([id, member, spot])

	_build_ground()
	_build_cells()
	_build_boundary()
	_flush_batches()
	_build_gun()
	_build_atmosphere()

	for s in spawns:
		_spawn_zombie(s[0], s[1], s[2])
	player.global_position = Vector3(0, height_at(0, 0) + 0.05, 0)
	_face_nearest_enemy()
	_update_hud()
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED


func _ready() -> void:
	sun.rotation_degrees = Vector3(-38, 35, 0)
	banner.hide()


# ---- arena construction ----

func _cell_center(cell: Vector2i) -> Vector3:
	return Vector3(cell.x * CELL, 0, cell.y * CELL)


func _cell_at(p: Vector3) -> Vector2i:
	return Vector2i(roundi(p.x / CELL), roundi(p.z / CELL))


func _open_cell_near_player() -> Vector2i:
	var options: Array[Vector2i] = []
	for cell: Vector2i in _cells:
		var d := maxi(absi(cell.x), absi(cell.y))
		if d == 1 and _cells[cell] not in SOLID:
			options.append(cell)
	if options.is_empty():
		return Vector2i(0, -1)
	return options[_rng.randi_range(0, options.size() - 1)]


## A point on the ground in a cell, `margin` metres from its edges, away from
## anyone's starting spot. Returns Vector3.INF if a few tries all land in a clearing.
func _scatter(c: Vector3, margin: float) -> Vector3:
	var reach := CELL / 2.0 - margin
	for attempt in 4:
		var p := c + Vector3(_rng.randf_range(-reach, reach), 0, _rng.randf_range(-reach, reach))
		if _clearings.all(func(q: Vector3) -> bool: return Vector2(p.x - q.x, p.z - q.z).length() > CLEAR_RADIUS):
			p.y = height_at(p.x, p.z)
			return p
	return Vector3.INF


## Ground height in metres at a point: gentle rolling noise, shaped by the
## terrain of the nearby cells (hills higher and rougher, water and marsh in
## hollows, roads and ruins flattened), blended with the same weights the
## ground shader uses so heights change as smoothly as the textures.
func height_at(x: float, z: float) -> float:
	var g := Vector2(x, z) / CELL
	var c0 := g.floor()
	var f := g - c0
	f = Vector2(smoothstep(0.2, 0.8, f.x), smoothstep(0.2, 0.8, f.y))
	var offset := 0.0
	var rough := 0.0
	for corner: Vector2i in [Vector2i(0, 0), Vector2i(1, 0), Vector2i(0, 1), Vector2i(1, 1)]:
		var cell := Vector2i(c0) + corner
		cell = cell.clamp(Vector2i(-radius, -radius), Vector2i(radius, radius))
		var w := (f.x if corner.x == 1 else 1.0 - f.x) * (f.y if corner.y == 1 else 1.0 - f.y)
		var r: Array = _relief.get(cell, [0.0, 1.0])
		offset += r[0] * w
		rough += r[1] * w
	var base := _hills.get_noise_2d(x, z) * 1.6 + _bumps.get_noise_2d(x, z) * 0.25
	return base * rough + offset


## The rolling ground: a heightmap 1 m apart for the collider and every
## MESH_STEP metres for the mesh, covering the arena plus a margin beyond it.
func _build_ground() -> void:
	var half := int(half_extent + GROUND_MARGIN)
	var n := half * 2 + 1
	var heights := PackedFloat32Array()
	heights.resize(n * n)
	for iz in n:
		for ix in n:
			heights[iz * n + ix] = height_at(ix - half, iz - half)

	# Mesh: every MESH_STEP-th sample, with normals from the slope for lighting.
	var step := int(MESH_STEP)
	@warning_ignore("integer_division")
	var m := (n - 1) / step + 1
	var verts := PackedVector3Array()
	var normals := PackedVector3Array()
	verts.resize(m * m)
	normals.resize(m * m)
	for j in m:
		for i in m:
			var ix := i * step
			var iz := j * step
			var h := heights[iz * n + ix]
			verts[j * m + i] = Vector3(ix - half, h, iz - half)
			var hl := heights[iz * n + maxi(ix - 1, 0)]
			var hr := heights[iz * n + mini(ix + 1, n - 1)]
			var hd := heights[maxi(iz - 1, 0) * n + ix]
			var hu := heights[mini(iz + 1, n - 1) * n + ix]
			normals[j * m + i] = Vector3(hl - hr, 2.0, hd - hu).normalized()
	var indices := PackedInt32Array()
	for j in m - 1:
		for i in m - 1:
			var a := j * m + i
			indices.append_array([a, a + 1, a + m, a + 1, a + m + 1, a + m])
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_INDEX] = indices
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	var ground := MeshInstance3D.new()
	ground.mesh = mesh
	ground.material_override = _ground_material()
	arena.add_child(ground)

	var floor_body := StaticBody3D.new()
	floor_body.collision_layer = LAYER_WORLD
	var floor_shape := CollisionShape3D.new()
	var map := HeightMapShape3D.new()
	map.map_width = n
	map.map_depth = n
	map.map_data = heights
	floor_shape.shape = map
	floor_body.add_child(floor_shape)
	arena.add_child(floor_body)

	# Scorched earth out to the horizon, below the lowest ground.
	var outside := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size = Vector2(2000, 2000)
	outside.mesh = plane
	var lowest := INF
	for h in heights:
		lowest = minf(lowest, h)
	outside.position.y = lowest - 0.5
	outside.material_override = _plain(Color(0.16, 0.11, 0.07))
	arena.add_child(outside)


func _ground_material() -> ShaderMaterial:
	var n := 2 * radius + 1
	var cells := Image.create(n, n, false, Image.FORMAT_R8)
	for cell: Vector2i in _ids:
		cells.set_pixel(cell.x + radius, cell.y + radius, Color8(_ids[cell], 0, 0))
	# Tile id -> ground texture layer (R) and roughness (G).
	var count := _keys.size()
	var ground_for := Image.create(count, 1, false, Image.FORMAT_RG8)
	for id: int in _keys:
		var g: Array = GROUND_FOR.get(_keys[id], ["dirt", 0.95])
		ground_for.set_pixel(id, 0, Color8(GROUND_TEXTURES.find(g[0]), int(g[1] * 255.0), 0))
	_cells_texture = ImageTexture.create_from_image(cells)
	var arrays := _ground_texture_arrays()
	var mat := ShaderMaterial.new()
	mat.shader = TERRAIN_SHADER
	_share_cell_lookup(mat)
	mat.set_shader_parameter(&"ground_albedo", arrays[0])
	mat.set_shader_parameter(&"ground_normal", arrays[1])
	mat.set_shader_parameter(&"ground_for", ImageTexture.create_from_image(ground_for))
	mat.set_shader_parameter(&"tile_count", float(count))
	mat.set_shader_parameter(&"texture_metres", GROUND_TEXTURE_METRES)
	mat.set_shader_parameter(&"glow_id", float(_keys.find_key("radiation")))
	return mat


## The ground textures as two texture arrays (colour, normal map), one layer
## per entry of GROUND_TEXTURES, with mipmaps. Built once.
static func _ground_texture_arrays() -> Array[Texture2DArray]:
	if not _ground_arrays.is_empty():
		return _ground_arrays
	for suffix in ["_albedo", "_normal"]:
		var images: Array[Image] = []
		for name: String in GROUND_TEXTURES:
			var img := (load("res://assets/ground/%s%s.jpg" % [name, suffix]) as Texture2D).get_image()
			if img.is_compressed():
				img.decompress()
			img.convert(Image.FORMAT_RGBA8)
			img.generate_mipmaps()
			images.append(img)
		var array := Texture2DArray.new()
		array.create_from_images(images)
		_ground_arrays.append(array)
	return _ground_arrays


## The uniforms from arena_cells.gdshaderinc, so the ground and water agree on borders.
func _share_cell_lookup(mat: ShaderMaterial) -> void:
	mat.set_shader_parameter(&"cells", _cells_texture)
	mat.set_shader_parameter(&"breakup", _breakup_texture())
	mat.set_shader_parameter(&"cell_size", CELL)
	mat.set_shader_parameter(&"radius", float(radius))


## Seamless noise in three independent channels: two to wobble terrain
## borders, one for broad light and dark patches. Built once.
static func _breakup_texture() -> ImageTexture:
	if _breakup:
		return _breakup
	var size := 256
	var layers: Array[Image] = []
	for i in 3:
		var noise := FastNoiseLite.new()
		noise.seed = 1000 + i
		noise.frequency = 0.02
		noise.fractal_octaves = 3
		layers.append(noise.get_seamless_image(size, size))
	var img := Image.create(size, size, false, Image.FORMAT_RGB8)
	for y in size:
		for x in size:
			img.set_pixel(x, y, Color(layers[0].get_pixel(x, y).r, layers[1].get_pixel(x, y).r, layers[2].get_pixel(x, y).r))
	_breakup = ImageTexture.create_from_image(img)
	return _breakup


func _build_cells() -> void:
	var solids := StaticBody3D.new()
	solids.collision_layer = LAYER_WORLD
	arena.add_child(solids)
	var glow_cells: Array[Vector2i] = []
	var water_cells: Array[Vector2i] = []
	for cell: Vector2i in _cells:
		var key: String = _cells[cell]
		var c := _cell_center(cell)
		# Blocks start SINK metres below the lowest ground under them, so they never float.
		var ground := minf(minf(height_at(c.x - CELL / 2, c.z - CELL / 2), height_at(c.x + CELL / 2, c.z - CELL / 2)),
			minf(height_at(c.x - CELL / 2, c.z + CELL / 2), height_at(c.x + CELL / 2, c.z + CELL / 2)))
		ground = minf(ground, height_at(c.x, c.z)) - SINK
		var top := height_at(c.x, c.z)
		if key in SOLID:
			# Water's wall stops short of the blended shore, which is still walkable.
			var w := CELL * 0.75 if key == "water" else CELL
			_add_collider(solids, Vector3(c.x, (ground + top + 5) / 2, c.z), Vector3(w, top + 5 - ground, w))
		match key:
			"mountains":
				var h := _rng.randf_range(16.0, 28.0) + top - ground
				_add_box(Vector3(c.x, ground + h / 2, c.z), Vector3(CELL, h, CELL), _block_material("rock", Color.WHITE))
				var cap := (h - (top - ground)) * 0.25
				var drift := CELL * 0.15
				_add_box(Vector3(c.x + _rng.randf_range(-drift, drift), ground + h + cap / 2, c.z + _rng.randf_range(-drift, drift)), Vector3(CELL * 0.55, cap, CELL * 0.55), _plain(Color(0.9, 0.9, 0.92)))
			"ruins":
				var h := _rng.randf_range(9.0, 18.0) + top - ground
				_add_box(Vector3(c.x, ground + h / 2, c.z), Vector3(CELL * 0.92, h, CELL * 0.92), _block_material("concrete", Color(0.75, 0.73, 0.7)))
				for i in _rng.randi_range(1, 3): # Jagged, half-collapsed top.
					var stub := _rng.randf_range(1.5, 5.0)
					var reach := CELL * 0.3
					_add_box(Vector3(c.x + _rng.randf_range(-reach, reach), ground + h + stub / 2, c.z + _rng.randf_range(-reach, reach)), Vector3(CELL * 0.3, stub, CELL * 0.3), _block_material("concrete", Color(0.75, 0.73, 0.7)))
			"base_wall":
				var h := 5.0 + top - ground
				_add_box(Vector3(c.x, ground + h / 2, c.z), Vector3(CELL, h, CELL), _block_material("concrete", Color.WHITE))
			"base_icon":
				# The base itself, seen from outside: a concrete bunker.
				var h := 6.0 + top - ground
				_add_box(Vector3(c.x, ground + h / 2, c.z), Vector3(CELL * 0.7, h, CELL * 0.7), _block_material("concrete", Color.WHITE))
				_add_collider(solids, Vector3(c.x, ground + h / 2, c.z), Vector3(CELL * 0.7, h, CELL * 0.7))
			"camp_icon":
				# An encampment from outside: a scrap shack behind a ring of barricades.
				var h := 3.5 + top - ground
				_add_box(Vector3(c.x, ground + h / 2, c.z), Vector3(CELL * 0.4, h, CELL * 0.35), _block_material("concrete", Color(0.55, 0.42, 0.3)))
				_add_collider(solids, Vector3(c.x, ground + h / 2, c.z), Vector3(CELL * 0.4, h, CELL * 0.35))
				for side: Vector3 in [Vector3(-1, 0, 0), Vector3(1, 0, 0), Vector3(0, 0, -1)]:
					var at := c + side * CELL * 0.38
					var extent := Vector3(1.0, 1.6, CELL * 0.5) if side.x != 0.0 else Vector3(CELL * 0.5, 1.6, 1.0)
					at.y = height_at(at.x, at.z) + 0.6
					_add_box(at, extent, _block_material("rock", Color(0.5, 0.45, 0.4)))
					_add_collider(solids, at, extent)
			"water":
				water_cells.append(cell)
			"dead_forest":
				for i in _rng.randi_range(1, 3):
					for attempt in 4: # A few tries to find room among the trees already there.
						var reach := CELL / 2.0 - 1.0
						var at := c + Vector3(_rng.randf_range(-reach, reach), 0, _rng.randf_range(-reach, reach))
						at.y = height_at(at.x, at.z)
						if _add_tree(solids, at):
							break
			"rubble", "crater":
				for i in _rng.randi_range(8, 14):
					var at := _scatter(c, 0.4)
					if not at.is_finite():
						continue
					var s := _rng.randf_range(0.25, 0.9)
					var turn := Basis.from_euler(Vector3(_rng.randf() * 0.5, _rng.randf() * TAU, _rng.randf() * 0.5))
					_instance(&"debris", Transform3D(turn * Basis.from_scale(Vector3(s, s * 0.7, s * 1.3)), at + Vector3(0, s * 0.3, 0)),
						Color(0.42, 0.4, 0.38).darkened(_rng.randf() * 0.4))
			"scrub":
				for i in _rng.randi_range(10, 16):
					var at := _scatter(c, 0.2)
					if not at.is_finite():
						continue
					var lean := Basis.from_euler(Vector3(_rng.randf_range(-0.4, 0.4), 0, _rng.randf_range(-0.4, 0.4)))
					_instance(&"tuft", Transform3D(lean, at + Vector3(0, 0.2, 0)))
			"radiation":
				glow_cells.append(cell)
	_build_water(water_cells)
	# A few green lights over the hot zones nearest the fight.
	glow_cells.sort_custom(func(a: Vector2i, b: Vector2i) -> bool: return a.length_squared() < b.length_squared())
	for cell in glow_cells.slice(0, MAX_GLOW_LIGHTS):
		var light := OmniLight3D.new()
		light.light_color = Color(0.3, 1.0, 0.3)
		light.light_energy = 2.0
		light.omni_range = CELL * 0.9
		var c := _cell_center(cell)
		light.position = Vector3(c.x, height_at(c.x, c.z) + 2.0, c.z)
		arena.add_child(light)


## Toxic water fills the hollows its cells sit in: one surface at one level,
## about halfway down the hollow, drawn by a shader only where the terrain is
## water, so its shoreline meanders with the blended ground.
func _build_water(cells: Array[Vector2i]) -> void:
	if cells.is_empty():
		return
	var rim := 0.0
	for cell in cells:
		var c := _cell_center(cell)
		rim += height_at(c.x, c.z) - RELIEF.water[0] # The ground there without the hollow.
	var level: float = rim / cells.size() + RELIEF.water[0] * 0.5
	var surface := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size = Vector2.ONE * (half_extent * 2.0 + CELL * 2.0)
	surface.mesh = plane
	surface.position.y = level
	surface.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	var mat := ShaderMaterial.new()
	mat.shader = WATER_SHADER
	_share_cell_lookup(mat)
	mat.set_shader_parameter(&"water_id", float(_keys.find_key("water")))
	surface.material_override = mat
	arena.add_child(surface)


## The edge of the fight: a tall, see-through ring that darkens everything
## beyond it. Crossing it means fleeing.
func _build_boundary() -> void:
	var lowest := INF
	var highest := -INF
	for i in 72:
		var a := TAU * i / 72.0
		var h := height_at(cos(a) * half_extent, sin(a) * half_extent)
		lowest = minf(lowest, h)
		highest = maxf(highest, h)
	var ring := MeshInstance3D.new()
	var tube := CylinderMesh.new()
	tube.top_radius = half_extent
	tube.bottom_radius = half_extent
	tube.height = highest - lowest + 50.0
	tube.cap_top = false
	tube.cap_bottom = false
	tube.radial_segments = 128
	tube.rings = 1
	ring.mesh = tube
	ring.position.y = lowest - 2.0 + tube.height / 2.0
	ring.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	var mat := ShaderMaterial.new()
	mat.shader = BOUNDARY_SHADER
	mat.set_shader_parameter(&"fade_top", highest + 30.0)
	mat.set_shader_parameter(&"fade_length", 28.0)
	ring.material_override = mat
	arena.add_child(ring)


## Atmosphere around the player, on top of the environment's distance fog:
## big soft fog banks drifting through 4-22 m away, and fine dust and ash
## floating in the air close by. Both emitters ride along with the player, but
## their particles stay where they were blown, so you walk through the haze.
func _build_atmosphere() -> void:
	var fog_colour := Color(0.04, 0.035, 0.03) # Sooty: the distance fades to black.

	var banks := CPUParticles3D.new()
	banks.amount = 45
	banks.lifetime = 24.0
	banks.preprocess = 24.0 # Already hazy when the fight starts.
	banks.local_coords = false
	banks.emission_shape = CPUParticles3D.EMISSION_SHAPE_RING
	banks.emission_ring_axis = Vector3.UP
	banks.emission_ring_radius = 22.0
	banks.emission_ring_inner_radius = 4.0
	banks.emission_ring_height = 3.0
	banks.position = Vector3(0, 2.5, 0)
	banks.direction = WIND.normalized()
	banks.spread = 25.0
	banks.initial_velocity_min = WIND.length() * 0.6
	banks.initial_velocity_max = WIND.length() * 1.4
	banks.gravity = Vector3.ZERO
	banks.scale_amount_min = 0.7
	banks.scale_amount_max = 1.5
	banks.angle_min = -180.0
	banks.angle_max = 180.0
	var fade := Gradient.new() # Fade in, linger, fade out.
	fade.offsets = PackedFloat32Array([0.0, 0.25, 0.75, 1.0])
	fade.colors = PackedColorArray([Color(fog_colour, 0.0), Color(fog_colour, 0.5), Color(fog_colour, 0.5), Color(fog_colour, 0.0)])
	banks.color_ramp = fade
	var card := QuadMesh.new()
	card.size = Vector2(14, 7)
	banks.mesh = card
	var haze := StandardMaterial3D.new()
	haze.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	haze.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	haze.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
	haze.billboard_keep_scale = true
	haze.vertex_color_use_as_albedo = true
	haze.albedo_texture = _wisp_texture()
	haze.depth_draw_mode = BaseMaterial3D.DEPTH_DRAW_DISABLED
	haze.cull_mode = BaseMaterial3D.CULL_DISABLED
	banks.material_override = haze
	player.add_child(banks)

	var dust := CPUParticles3D.new()
	dust.amount = 700
	dust.lifetime = 8.0
	dust.preprocess = 8.0
	dust.local_coords = false
	dust.emission_shape = CPUParticles3D.EMISSION_SHAPE_BOX
	dust.emission_box_extents = Vector3(16, 5, 16)
	dust.position = Vector3(0, 2.0, 0)
	dust.direction = WIND.normalized()
	dust.spread = 40.0
	dust.initial_velocity_min = WIND.length() * 0.5
	dust.initial_velocity_max = WIND.length() * 2.0
	dust.gravity = Vector3(0, -0.05, 0) # Ash settles, slowly.
	dust.scale_amount_min = 0.03
	dust.scale_amount_max = 0.09
	var speck_fade := Gradient.new()
	speck_fade.offsets = PackedFloat32Array([0.0, 0.15, 0.85, 1.0])
	speck_fade.colors = PackedColorArray([Color(0.35, 0.32, 0.28, 0.0), Color(0.35, 0.32, 0.28, 0.6), Color(0.35, 0.32, 0.28, 0.6), Color(0.35, 0.32, 0.28, 0.0)])
	dust.color_ramp = speck_fade
	var speck := QuadMesh.new()
	speck.size = Vector2.ONE
	dust.mesh = speck
	var speck_mat := StandardMaterial3D.new()
	speck_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	speck_mat.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
	speck_mat.billboard_keep_scale = true # Otherwise every speck is drawn a metre wide.
	speck_mat.vertex_color_use_as_albedo = true
	speck_mat.albedo_texture = _wisp_texture()
	speck_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	dust.material_override = speck_mat
	player.add_child(dust)


## A soft, ragged puff (white, alpha from a radial falloff broken up by
## noise), for fog banks and dust. Built once.
static func _wisp_texture() -> ImageTexture:
	if _wisp:
		return _wisp
	var size := 128
	var noise := FastNoiseLite.new()
	noise.seed = 77
	noise.frequency = 0.035
	noise.fractal_octaves = 4
	var img := Image.create(size, size, false, Image.FORMAT_RGBA8)
	for y in size:
		for x in size:
			var d := Vector2(x - size / 2.0, y - size / 2.0).length() / (size / 2.0)
			var falloff := clampf(1.0 - d, 0.0, 1.0)
			falloff = falloff * falloff * (3.0 - 2.0 * falloff)
			var n := noise.get_noise_2d(x, y) * 0.5 + 0.5
			img.set_pixel(x, y, Color(1, 1, 1, clampf(falloff * (0.35 + 0.9 * n), 0.0, 1.0)))
	_wisp = ImageTexture.create_from_image(img)
	return _wisp


func _build_gun() -> void:
	var metal := _plain(Color(0.18, 0.18, 0.2))
	var wood := _plain(Color(0.4, 0.22, 0.1))
	for part in [
		[Vector3(0, 0, -0.1), Vector3(0.08, 0.1, 0.45), metal],
		[Vector3(0, 0.02, -0.4), Vector3(0.04, 0.04, 0.35), metal],
		[Vector3(0, -0.1, 0.02), Vector3(0.06, 0.16, 0.08), wood],
		[Vector3(0, -0.02, 0.2), Vector3(0.07, 0.09, 0.22), wood],
	]:
		var mi := MeshInstance3D.new()
		var mesh := BoxMesh.new()
		mesh.size = part[1]
		mi.mesh = mesh
		mi.position = part[0]
		mi.material_override = part[2]
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		gun.add_child(mi)


static func _load_tree_models() -> Array:
	if _tree_models_loaded:
		return _tree_models
	_tree_models_loaded = true
	var dir := DirAccess.open(TREE_MODEL_DIR)
	if dir == null:
		return _tree_models
	var files := Array(dir.get_files()).filter(func(f: String) -> bool: return f.get_extension().to_lower() == "glb")
	files.sort()
	for f: String in files:
		var scene: Node3D = (load(TREE_MODEL_DIR + f) as PackedScene).instantiate()
		var mi: MeshInstance3D = scene.find_children("*", "MeshInstance3D", true, false).front()
		if mi and mi.mesh:
			# Bake the model's own node transforms in, and note its height so it can be sized in metres.
			var xform := _relative_to(mi, scene)
			var height := maxf((xform * mi.mesh.get_aabb()).size.y, 0.01)
			# How far the trunk and roots spread at ground level, to keep trees off people.
			var footprint := 0.0
			for s in mi.mesh.get_surface_count():
				for v: Vector3 in mi.mesh.surface_get_arrays(s)[Mesh.ARRAY_VERTEX]:
					var w := xform * v
					if w.y < height * 0.05:
						footprint = maxf(footprint, Vector2(w.x, w.z).length())
			# Mesh colliders, pre-scaled to each size (scaling a shared shape per tree isn't reliable in every physics engine).
			var faces: PackedVector3Array = mi.mesh.get_faces()
			for i in faces.size():
				faces[i] = xform * faces[i]
			var colliders: Array[ConcavePolygonShape3D] = []
			for size in TREE_SIZES:
				var scaled := faces.duplicate()
				var k := _tree_height(size) / height
				for i in scaled.size():
					scaled[i] *= k
				var shape := ConcavePolygonShape3D.new()
				shape.set_faces(scaled)
				colliders.append(shape)
			_tree_models.append({"mesh": mi.mesh, "transform": xform, "height": height, "footprint": footprint, "colliders": colliders})
		scene.free()
	return _tree_models


## Transform of `n` relative to its ancestor `root`, for scenes that aren't in the tree.
static func _relative_to(n: Node3D, root: Node) -> Transform3D:
	var xf := n.transform
	var p := n.get_parent()
	while p != root and p is Node3D:
		xf = (p as Node3D).transform * xf
		p = p.get_parent()
	return xf


static func _tree_height(size: int) -> float:
	return lerpf(TREE_HEIGHT.x, TREE_HEIGHT.y, float(size) / (TREE_SIZES - 1))


## Places a tree at `base` unless it would crowd another tree or someone's
## starting spot. Returns whether it was placed.
func _add_tree(body: StaticBody3D, base: Vector3) -> bool:
	if _trees.any(func(t: Vector3) -> bool: return t.distance_to(base) < TREE_SPACING):
		return false
	var models := _load_tree_models()
	if models.is_empty():
		if _clearings.any(func(q: Vector3) -> bool: return q.distance_to(base) < CLEAR_RADIUS):
			return false
		_trees.append(base)
		_add_stick_tree(body, base)
		return true
	# A random model and size, turned and leaning a little.
	var pick := _rng.randi_range(0, models.size() - 1)
	var model: Dictionary = models[pick]
	var size := _rng.randi_range(0, TREE_SIZES - 1)
	var s: float = _tree_height(size) / model.height
	var room: float = CLEAR_RADIUS + model.footprint * s
	if _clearings.any(func(q: Vector3) -> bool: return q.distance_to(base) < room):
		return false
	_trees.append(base)
	var turn := Basis.from_euler(Vector3(_rng.randf_range(-0.06, 0.06), _rng.randf() * TAU, _rng.randf_range(-0.06, 0.06)))
	var block := Vector2i(floori(base.x / (CELL * TREE_BATCH_CELLS)), floori(base.z / (CELL * TREE_BATCH_CELLS)))
	var kind := StringName("tree%d@%d,%d" % [pick, block.x, block.y])
	if not _batches.has(kind):
		_batches[kind] = {"mesh": model.mesh, "material": null, "transforms": [], "colors": []}
	_instance(kind, Transform3D(turn * Basis.from_scale(Vector3.ONE * s), base) * model.transform)
	# The collider is the tree's own mesh, already at this size: only turn and place it.
	var collider := CollisionShape3D.new()
	collider.shape = model.colliders[size]
	collider.transform = Transform3D(turn, base)
	body.add_child(collider)
	return true


## The fallback without tree models: a trunk and a few bare branches.
func _add_stick_tree(body: StaticBody3D, base: Vector3) -> void:
	var h := _rng.randf_range(3.5, 5.5)
	_instance(&"trunk", Transform3D(Basis.from_scale(Vector3(1, h, 1)), base + Vector3(0, h / 2, 0)))
	for i in _rng.randi_range(2, 4):
		var turn := Basis.from_euler(Vector3(_rng.randf_range(-0.9, -0.3), _rng.randf() * TAU, 0))
		var length := _rng.randf_range(0.8, 1.6)
		var start := base + Vector3(0, h * _rng.randf_range(0.5, 0.9), 0)
		_instance(&"branch", Transform3D(turn * Basis.from_scale(Vector3(1, 1, length)), start + turn * Vector3(0, 0, 0.4)))
	_add_collider(body, base + Vector3(0, h / 2, 0), Vector3(0.45, h, 0.45))


## Queue one copy of a kind of decoration; _flush_batches draws each kind in one go.
func _instance(kind: StringName, xform: Transform3D, color := Color.WHITE) -> void:
	if not _batches.has(kind):
		var mesh: Mesh
		var material: StandardMaterial3D
		match kind:
			&"trunk":
				var cyl := CylinderMesh.new()
				cyl.top_radius = 0.07
				cyl.bottom_radius = 0.2
				cyl.height = 1.0 # Stretched to each tree's height.
				mesh = cyl
				material = _plain(Color(0.3, 0.2, 0.12))
			&"branch":
				mesh = _unit_box(Vector3(0.06, 0.06, 1.0)) # Stretched to each branch's length.
				material = _plain(Color(0.3, 0.2, 0.12))
			&"debris":
				mesh = _unit_box(Vector3.ONE)
				material = _plain(Color.WHITE).duplicate()
				material.vertex_color_use_as_albedo = true # Each chunk gets its own shade.
			&"tuft":
				mesh = _unit_box(Vector3(0.06, 0.4, 0.06))
				material = _plain(Color(0.42, 0.4, 0.17))
		_batches[kind] = {"mesh": mesh, "material": material, "transforms": [], "colors": []}
	_batches[kind].transforms.append(xform)
	_batches[kind].colors.append(color)


func _flush_batches() -> void:
	for kind: StringName in _batches:
		var batch: Dictionary = _batches[kind]
		var mm := MultiMesh.new()
		mm.transform_format = MultiMesh.TRANSFORM_3D
		mm.use_colors = true
		mm.mesh = batch.mesh
		mm.instance_count = batch.transforms.size()
		for i in mm.instance_count:
			mm.set_instance_transform(i, batch.transforms[i])
			mm.set_instance_color(i, batch.colors[i])
		var mmi := MultiMeshInstance3D.new()
		mmi.multimesh = mm
		if batch.material:
			mmi.material_override = batch.material # Otherwise the mesh's own materials (tree models).
		arena.add_child(mmi)
	_batches.clear()


func _unit_box(size: Vector3) -> BoxMesh:
	var box := BoxMesh.new()
	box.size = size
	return box


func _add_box(pos: Vector3, size: Vector3, material: Material) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var mesh := BoxMesh.new()
	mesh.size = size
	mi.mesh = mesh
	mi.position = pos
	mi.material_override = material
	arena.add_child(mi)
	return mi


func _add_collider(body: StaticBody3D, pos: Vector3, size: Vector3) -> void:
	var shape := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = size
	shape.shape = box
	shape.position = pos
	body.add_child(shape)


func _plain(color: Color, emission := Color.BLACK, glow := 0.0) -> StandardMaterial3D:
	var key := "%s|%s|%s" % [color, emission, glow]
	if _materials.has(key):
		return _materials[key]
	var m := StandardMaterial3D.new()
	m.albedo_color = color
	m.roughness = 0.95
	if glow > 0.0:
		m.emission_enabled = true
		m.emission = emission
		m.emission_energy_multiplier = glow
	_materials[key] = m
	return m


## A ground texture ("rock", "concrete"...) wrapped round a block in world
## space, repeating every BLOCK_TEXTURE_SIZE metres, with its normal map.
func _block_material(name: String, tint: Color) -> StandardMaterial3D:
	var key := "block:%s:%s" % [name, tint]
	if _materials.has(key):
		return _materials[key]
	var m := StandardMaterial3D.new()
	m.albedo_texture = load("res://assets/ground/%s_albedo.jpg" % name)
	m.albedo_color = tint
	m.normal_enabled = true
	m.normal_texture = load("res://assets/ground/%s_normal.jpg" % name)
	m.uv1_triplanar = true
	m.uv1_world_triplanar = true
	m.uv1_scale = Vector3.ONE / BLOCK_TEXTURE_SIZE
	m.roughness = 0.9
	_materials[key] = m
	return m


func _spawn_zombie(id: int, member: int, at: Vector3) -> void:
	var z := Zombie3D.new()
	z.monster_id = id
	z.target = player
	z.wake_delay = _rng.randf_range(0.0, 2.5)
	# Position before entering the tree: a body that appears at the origin for
	# even one physics step overlaps the player there and launches them.
	z.position = at + Vector3(0, 0.1, 0)
	enemies_root.add_child(z)
	z.died.connect(_on_zombie_died)
	z.attacked.connect(_on_player_hit)
	enemies["%d/%d" % [id, member]] = z


func _face_nearest_enemy() -> void:
	var best: Zombie3D = null
	for z: Zombie3D in enemies.values():
		if best == null or z.global_position.length() < best.global_position.length():
			best = z
	if best:
		var to := best.global_position - player.global_position
		player.rotation.y = atan2(-to.x, -to.z)


# ---- play ----

func _unhandled_input(event: InputEvent) -> void:
	if _ended:
		return
	if event.is_action_pressed(&"ui_cancel"):
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		get_viewport().set_input_as_handled()
	elif event is InputEventMouseButton and event.pressed and Input.mouse_mode != Input.MOUSE_MODE_CAPTURED:
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
		get_viewport().set_input_as_handled()
	elif event is InputEventMouseMotion and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		player.rotate_y(-event.relative.x * MOUSE_SENSITIVITY)
		camera.rotation.x = clampf(camera.rotation.x - event.relative.y * MOUSE_SENSITIVITY, -1.4, 1.4)


func _process(delta: float) -> void:
	_fire_cooldown = maxf(0.0, _fire_cooldown - delta)
	muzzle_flash.light_energy = maxf(0.0, muzzle_flash.light_energy - delta * 40.0)
	gun.position.z = lerpf(gun.position.z, -0.75, delta * 12.0)
	_hurt = maxf(0.0, _hurt - delta * 2.5)
	damage_flash.color.a = _hurt * 0.45
	if _ended:
		return
	var can_shoot := Input.mouse_mode == Input.MOUSE_MODE_CAPTURED or DisplayServer.get_name() == "headless"
	if can_shoot and Input.is_action_pressed(&"shoot") and _fire_cooldown <= 0.0:
		fire()


func _physics_process(delta: float) -> void:
	if _ended:
		return
	var input := Input.get_vector(&"move_left", &"move_right", &"move_up", &"move_down")
	var basis := player.global_transform.basis
	var dir := basis.x * input.x + basis.z * input.y
	dir.y = 0.0
	var key: String = _cells.get(_cell_at(player.global_position), "")
	var speed := run_speed * (SWAMP_SPEED_FACTOR if key == "swamp" else 1.0)
	var horizontal := dir.normalized() * speed if dir.length() > 0.01 else Vector3.ZERO
	player.velocity.x = horizontal.x
	player.velocity.z = horizontal.z
	player.velocity.y = 0.0 if player.is_on_floor() else player.velocity.y - GRAVITY * delta
	player.move_and_slide()

	if key == "radiation":
		_damage(RADIATION_DPS * delta, false)

	var p := player.global_position
	if Vector2(p.x, p.z).length() > half_extent:
		var dir_name := ("right" if p.x > 0 else "left") if absf(p.x) > absf(p.z) else ("down" if p.z > 0 else "up")
		_end("fled", dir_name)


## Hitscan shot from the centre of the screen.
func fire() -> void:
	_fire_cooldown = fire_interval
	muzzle_flash.light_energy = 4.0
	gun.position.z = -0.68 # Recoil kick; eases back in _process.
	var from := camera.global_position
	var to := from - camera.global_basis.z * SHOT_RANGE
	var query := PhysicsRayQueryParameters3D.create(from, to, LAYER_WORLD | LAYER_ENEMIES, [player.get_rid()])
	var hit := get_world_3d().direct_space_state.intersect_ray(query)
	if hit.is_empty():
		return
	_spark(hit.position)
	if hit.collider is Zombie3D:
		hit.collider.hit(shot_damage)


func _spark(at: Vector3) -> void:
	var spark := MeshInstance3D.new()
	var mesh := SphereMesh.new()
	mesh.radius = 0.08
	mesh.height = 0.16
	spark.mesh = mesh
	spark.material_override = _plain(Color(1, 0.9, 0.5), Color(1, 0.8, 0.3), 4.0)
	arena.add_child(spark)
	spark.global_position = at
	var tween := spark.create_tween()
	tween.tween_property(spark, ^"scale", Vector3.ONE * 0.1, 0.15)
	tween.tween_callback(spark.queue_free)


func _on_player_hit(damage: float) -> void:
	_damage(damage, true)


func _damage(amount: float, flash: bool) -> void:
	if _ended:
		return
	health = maxf(0.0, health - amount)
	if flash:
		_hurt = 1.0
	_update_hud()
	if health <= 0.0:
		_end("died", "")


func _on_zombie_died(z: Zombie3D) -> void:
	_dead += 1
	_pack_left[z.monster_id] -= 1
	if _pack_left[z.monster_id] == 0:
		killed.append(z.monster_id)
	_update_hud()
	if enemies.values().all(func(e: Zombie3D) -> bool: return e.is_dead()):
		_end("victory", "")


func _update_hud() -> void:
	health_bar.value = health
	var left := enemies.size() - _dead
	enemies_label.text = "ZOMBIES: %d   HEALTH: %d/%d" % [left, ceili(health), int(max_health)]


## Packs that lost some but not all of their zombies: id -> still standing.
func remaining() -> Dictionary:
	var out := {}
	for id: int in _pack_left:
		if _pack_left[id] > 0 and _pack_left[id] < _pack_size[id]:
			out[str(id)] = _pack_left[id]
	return out


func _end(result: String, dir: String) -> void:
	if _ended:
		return
	_ended = true
	player.velocity = Vector3.ZERO
	for z: Zombie3D in enemies.values():
		z.target = null
	banner.text = {"victory": "AREA CLEARED", "fled": "YOU ESCAPED", "died": "YOU DIED"}[result]
	banner.modulate = {"victory": Color(0.4, 1, 0.4), "fled": Color(1, 1, 0.4), "died": Color(1, 0.3, 0.3)}[result]
	banner.show()
	hint_label.hide()
	await get_tree().create_timer(END_DELAY).timeout
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	finished.emit(result, killed, dir)
