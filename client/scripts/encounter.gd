extends Node3D
## First-person fight, started when a zombie and the player share an overworld
## tile. The arena is the patch of overworld around the encounter, (2r+1)^2
## tiles with each tile a CELL x CELL metre square, built from that tile's
## terrain: mountains, ruins, walls and water block, dead forests have trees,
## hot zones glow and burn, sludge slows you down. Zombies start where they
## stood on the overworld relative to the player.
##
## Kill every zombie, or cross the edge of the arena to flee; `finished` then
## reports the result for game.gd to send to the server.

signal finished(result: String, killed: Array, dir: String)

const TILES_TEXTURE := preload("res://assets/tiles.png")
const TERRAIN_SHADER := preload("res://shaders/terrain.gdshader")

const CELL := 12.0 ## metres per overworld tile
const GROUND_QUAD := 2.0 ## metres per repeat of a tile's pixel art on the ground
const BLOCK_TEXTURE_SIZE := 4.0 ## metres per repeat of a tile's pixel art on blocks
const CLEAR_RADIUS := 3.0 ## metres kept free of trees and debris around where anyone starts
## Tree models (any .glb here, git-ignored like the zombie) replace the stick
## trees when present; each tree picks one at random.
const TREE_MODEL_DIR := "res://models/trees/"
const TREE_HEIGHT := Vector2(8.0, 16.0) ## metres, min and max
## Heights snap to this many sizes so each model needs only a few mesh colliders
## (one per size, shared by every tree of that model and size).
const TREE_SIZES := 5
const TREE_SPACING := 7.0 ## minimum metres between tree trunks
const TREE_BATCH_CELLS := 3 ## trees are batched per 3x3-cell block so distant blocks can cull and use LODs
const PLAYER_SPEED := 5.0
const SWAMP_SPEED_FACTOR := 0.55
const MOUSE_SENSITIVITY := 0.0025
const FIRE_INTERVAL := 0.2
const SHOT_DAMAGE := 34.0
const SHOT_RANGE := 250.0
const MAX_HEALTH := 100.0
const RADIATION_DPS := 4.0
const GRAVITY := 20.0
const MAX_GLOW_LIGHTS := 8
const END_DELAY := 1.6 ## seconds the outcome banner shows before returning to the overworld

const LAYER_WORLD := 1
const LAYER_PLAYER := 2
const LAYER_ENEMIES := 4

## Terrain keys whose cells get a solid block.
const SOLID := ["mountains", "ruins", "base_wall", "water"]

var radius := 8
var half_extent := 34.0
var health := MAX_HEALTH
var enemies := {} ## monster id -> Zombie3D
var killed: Array[int] = []

var _cells := {} ## Vector2i offset from the encounter tile -> terrain key
var _keys := {} ## tile id -> key
var _colors := {} ## tile id -> map colour
var _rng := RandomNumberGenerator.new()
var _materials := {}
var _fire_cooldown := 0.0
var _ended := false
var _hurt := 0.0
var _clearings: Array[Vector3] = [] ## where the player and zombies start
## Repeated decoration (trees, debris, tufts, posts) is drawn as one MultiMesh per
## kind: thousands of separate meshes would be thousands of draw calls.
## kind -> {mesh, material, transforms: Array[Transform3D], colors: Array[Color]}
var _batches := {}
var _trees: Array[Vector3] = [] ## trunk positions placed so far

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
	radius = int(msg.radius)
	half_extent = (radius + 0.5) * CELL
	_rng.seed = int(msg.seed)
	for t: Dictionary in Net.welcome.tiles:
		_keys[int(t.id)] = str(t.key)
		_colors[int(t.id)] = Color.html(str(t.color))
	var center := Vector2i(int(msg.x), int(msg.y))
	var ids := {}
	for dy in range(-radius, radius + 1):
		for dx in range(-radius, radius + 1):
			var id: int = game.tile_at(center + Vector2i(dx, dy))
			if id < 0:
				id = 1 # Not streamed to us yet: call it wasteland.
			ids[Vector2i(dx, dy)] = id
			_cells[Vector2i(dx, dy)] = _keys.get(id, "wasteland")

	# Where everyone starts; trees and debris keep clear of these spots.
	_clearings.append(Vector3.ZERO)
	var spawns := []
	var jitter := CELL / 2.0 - 2.0
	for e: Dictionary in msg.enemies:
		var cell := Vector2i(int(e.dx), int(e.dy))
		if cell == Vector2i.ZERO:
			cell = _open_cell_near_player() # It caught us: give it some room.
		var at := _cell_center(cell) + Vector3(_rng.randf_range(-jitter, jitter), 0, _rng.randf_range(-jitter, jitter))
		_clearings.append(at)
		spawns.append([int(e.id), at])

	_build_ground(ids)
	_build_cells()
	_build_boundary()
	_flush_batches()
	_build_gun()

	for s in spawns:
		_spawn_zombie(s[0], s[1])
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


## A point in a cell, `margin` metres from its edges, away from anyone's starting spot.
## Returns Vector3.INF if a few tries all land in a clearing.
func _scatter(c: Vector3, margin: float) -> Vector3:
	var reach := CELL / 2.0 - margin
	for attempt in 4:
		var p := c + Vector3(_rng.randf_range(-reach, reach), 0, _rng.randf_range(-reach, reach))
		if _clearings.all(func(q: Vector3) -> bool: return p.distance_to(q) > CLEAR_RADIUS):
			return p
	return Vector3.INF


func _build_ground(ids: Dictionary) -> void:
	var count := float(_keys.size())
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var half := CELL / 2.0
	var quads := int(CELL / GROUND_QUAD)
	for cell: Vector2i in ids:
		var id: int = ids[cell]
		var color: Color = _colors.get(id, Color(0.3, 0.2, 0.1))
		color.a = 1.0 if _cells[cell] == "radiation" else 0.0
		var u0 := id / count
		var u1 := (id + 1) / count
		var c := _cell_center(cell)
		# The tile's pixel art repeats every GROUND_QUAD metres so it reads at a human scale.
		for qy in quads:
			for qx in quads:
				var x0 := c.x - half + qx * GROUND_QUAD
				var z0 := c.z - half + qy * GROUND_QUAD
				var corners := [
					[Vector3(x0, 0, z0), Vector2(u0, 0)],
					[Vector3(x0 + GROUND_QUAD, 0, z0), Vector2(u1, 0)],
					[Vector3(x0 + GROUND_QUAD, 0, z0 + GROUND_QUAD), Vector2(u1, 1)],
					[Vector3(x0, 0, z0 + GROUND_QUAD), Vector2(u0, 1)],
				]
				for i in [0, 1, 2, 0, 2, 3]:
					st.set_color(color)
					st.set_normal(Vector3.UP)
					st.set_uv(corners[i][1])
					st.add_vertex(corners[i][0])
	var ground := MeshInstance3D.new()
	ground.mesh = st.commit()
	var mat := ShaderMaterial.new()
	mat.shader = TERRAIN_SHADER
	mat.set_shader_parameter(&"atlas", TILES_TEXTURE)
	ground.material_override = mat
	arena.add_child(ground)

	# Scorched earth beyond the arena, and one floor collider under everything.
	var outside := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size = Vector2(2000, 2000)
	outside.mesh = plane
	outside.position.y = -0.02
	outside.material_override = _plain(Color(0.16, 0.11, 0.07))
	arena.add_child(outside)
	var floor_body := StaticBody3D.new()
	floor_body.collision_layer = LAYER_WORLD
	var floor_shape := CollisionShape3D.new()
	floor_shape.shape = WorldBoundaryShape3D.new()
	floor_body.add_child(floor_shape)
	arena.add_child(floor_body)


func _build_cells() -> void:
	var solids := StaticBody3D.new()
	solids.collision_layer = LAYER_WORLD
	arena.add_child(solids)
	var glow_cells: Array[Vector2i] = []
	for cell: Vector2i in _cells:
		var key: String = _cells[cell]
		var c := _cell_center(cell)
		if key in SOLID:
			_add_collider(solids, c + Vector3(0, 2.5, 0), Vector3(CELL, 5, CELL))
		match key:
			"mountains":
				var h := _rng.randf_range(16.0, 28.0)
				_add_box(c + Vector3(0, h / 2, 0), Vector3(CELL, h, CELL), _tile_material("mountains", Color(0.5, 0.48, 0.46)))
				var cap := h * 0.25
				var drift := CELL * 0.15
				_add_box(c + Vector3(_rng.randf_range(-drift, drift), h + cap / 2, _rng.randf_range(-drift, drift)), Vector3(CELL * 0.55, cap, CELL * 0.55), _plain(Color(0.9, 0.9, 0.92)))
			"ruins":
				var h := _rng.randf_range(9.0, 18.0)
				_add_box(c + Vector3(0, h / 2, 0), Vector3(CELL * 0.92, h, CELL * 0.92), _tile_material("ruins", Color(0.6, 0.6, 0.6)))
				for i in _rng.randi_range(1, 3): # Jagged, half-collapsed top.
					var stub := _rng.randf_range(1.5, 5.0)
					var reach := CELL * 0.3
					_add_box(c + Vector3(_rng.randf_range(-reach, reach), h + stub / 2, _rng.randf_range(-reach, reach)), Vector3(CELL * 0.3, stub, CELL * 0.3), _tile_material("ruins", Color(0.6, 0.6, 0.6)))
			"base_wall":
				_add_box(c + Vector3(0, 2.5, 0), Vector3(CELL, 5, CELL), _tile_material("base_wall", Color.WHITE))
			"base_icon":
				# The base itself, seen from outside: a concrete bunker.
				_add_box(c + Vector3(0, 3, 0), Vector3(CELL * 0.7, 6, CELL * 0.7), _tile_material("base_wall", Color.WHITE))
				_add_collider(solids, c + Vector3(0, 3, 0), Vector3(CELL * 0.7, 6, CELL * 0.7))
			"water":
				var water := _plain(Color(0.1, 0.35, 0.3, 0.75), Color(0.1, 0.6, 0.3), 0.4)
				water.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
				_add_box(c + Vector3(0, 0.03, 0), Vector3(CELL, 0.06, CELL), water)
			"dead_forest":
				for i in _rng.randi_range(1, 3):
					for attempt in 4: # A few tries to find room among the trees already there.
						var reach := CELL / 2.0 - 1.0
						if _add_tree(solids, c + Vector3(_rng.randf_range(-reach, reach), 0, _rng.randf_range(-reach, reach))):
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
			"hills", "dunes":
				var mound := MeshInstance3D.new()
				var sphere := SphereMesh.new()
				sphere.radius = CELL * 0.55
				sphere.height = 1.2
				mound.mesh = sphere
				mound.position = c
				mound.material_override = _plain(_colors_for(key).darkened(0.2))
				arena.add_child(mound)
			"radiation":
				glow_cells.append(cell)
	# A few green lights over the hot zones nearest the fight.
	glow_cells.sort_custom(func(a: Vector2i, b: Vector2i) -> bool: return a.length_squared() < b.length_squared())
	for cell in glow_cells.slice(0, MAX_GLOW_LIGHTS):
		var light := OmniLight3D.new()
		light.light_color = Color(0.3, 1.0, 0.3)
		light.light_energy = 2.0
		light.omni_range = CELL * 0.9
		light.position = _cell_center(cell) + Vector3(0, 2.0, 0)
		arena.add_child(light)


func _build_boundary() -> void:
	# Rusty posts mark the edge; crossing it means fleeing.
	var spacing := 4.0
	var steps := int(2.0 * half_extent / spacing) + 1
	for i in steps:
		var t := -half_extent + i * spacing
		for p in [Vector3(t, 0, -half_extent), Vector3(t, 0, half_extent), Vector3(-half_extent, 0, t), Vector3(half_extent, 0, t)]:
			_instance(&"post", Transform3D(Basis.IDENTITY, p + Vector3(0, 0.9, 0)))


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
			&"post":
				mesh = _unit_box(Vector3(0.18, 1.8, 0.18))
				material = _plain(Color(0.5, 0.2, 0.08), Color(0.6, 0.15, 0.0), 0.3)
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


## A material that wraps the overworld tile's pixel art round a block, repeating every BLOCK_TEXTURE_SIZE metres.
func _tile_material(key: String, tint: Color) -> StandardMaterial3D:
	if _materials.has(key):
		return _materials[key]
	var id := _keys.find_key(key) as int
	var img := TILES_TEXTURE.get_image().get_region(Rect2i(id * 16, 0, 16, 16))
	var m := StandardMaterial3D.new()
	m.albedo_texture = ImageTexture.create_from_image(img)
	m.albedo_color = tint
	m.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
	m.uv1_triplanar = true
	m.uv1_world_triplanar = true
	m.uv1_scale = Vector3.ONE / BLOCK_TEXTURE_SIZE
	m.roughness = 0.95
	_materials[key] = m
	return m


func _colors_for(key: String) -> Color:
	return _colors.get(_keys.find_key(key), Color(0.4, 0.3, 0.2))


func _spawn_zombie(id: int, at: Vector3) -> void:
	var z := Zombie3D.new()
	z.monster_id = id
	z.target = player
	# Position before entering the tree: a body that appears at the origin for
	# even one physics step overlaps the player there and launches them.
	z.position = at
	enemies_root.add_child(z)
	z.died.connect(_on_zombie_died)
	z.attacked.connect(_on_player_hit)
	enemies[id] = z


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
	var speed := PLAYER_SPEED * (SWAMP_SPEED_FACTOR if key == "swamp" else 1.0)
	var horizontal := dir.normalized() * speed if dir.length() > 0.01 else Vector3.ZERO
	player.velocity.x = horizontal.x
	player.velocity.z = horizontal.z
	player.velocity.y = 0.0 if player.is_on_floor() else player.velocity.y - GRAVITY * delta
	player.move_and_slide()

	if key == "radiation":
		_damage(RADIATION_DPS * delta, false)

	var p := player.global_position
	if absf(p.x) > half_extent or absf(p.z) > half_extent:
		var dir_name := ("right" if p.x > 0 else "left") if absf(p.x) > absf(p.z) else ("down" if p.z > 0 else "up")
		_end("fled", dir_name)


## Hitscan shot from the centre of the screen.
func fire() -> void:
	_fire_cooldown = FIRE_INTERVAL
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
		hit.collider.hit(SHOT_DAMAGE)


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
	killed.append(z.monster_id)
	_update_hud()
	if enemies.values().all(func(e: Zombie3D) -> bool: return e.is_dead()):
		_end("victory", "")


func _update_hud() -> void:
	health_bar.value = health
	var left := enemies.size() - killed.size()
	enemies_label.text = "ZOMBIES: %d   HEALTH: %d" % [left, ceili(health)]


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
