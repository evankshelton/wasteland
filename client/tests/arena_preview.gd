extends Node
## Builds a first-person arena of one terrain without a server, to look at it
## and check performance:
##
##   godot --path client res://tests/arena_preview.tscn -- --terrain dead_forest --screenshot out.png
##
## --terrain mixed lays out patches of several terrains, to see how they blend.
## --near-edge stands 20 m inside the arena's edge, looking out through it.
##
## Prints fps and draw calls after a few seconds, saves a screenshot if asked,
## then quits. --check-trees also shoots the nearest tree and walks into it,
## failing (exit code 1) if either goes through. Tile definitions are read
## from ../shared/tiles.json, so run it from a checkout of the repository.

const ENCOUNTER_SCENE := preload("res://scenes/encounter.tscn")

var terrain_key := "dead_forest"
var screenshot := ""
var check_trees := false
var near_edge := false
var _tile_id := 1
var _ids_by_key := {}
var _patches := FastNoiseLite.new()
const MIXED := ["wasteland", "scrub", "dead_forest", "hills", "water", "swamp", "rubble", "dunes", "radiation", "scrub"]


func _ready() -> void:
	var args := OS.get_cmdline_user_args()
	check_trees = "--check-trees" in args
	near_edge = "--near-edge" in args
	for i in args.size() - 1:
		match args[i]:
			"--terrain": terrain_key = args[i + 1]
			"--screenshot": screenshot = args[i + 1]
	var tiles_path := ProjectSettings.globalize_path("res://").path_join("../shared/tiles.json")
	var defs: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(tiles_path))
	Net.welcome = {"tiles": defs.tiles}
	for t: Dictionary in defs.tiles:
		_ids_by_key[t.key] = int(t.id)
		if t.key == terrain_key:
			_tile_id = int(t.id)
	_patches.noise_type = FastNoiseLite.TYPE_CELLULAR
	_patches.cellular_return_type = FastNoiseLite.RETURN_CELL_VALUE
	_patches.frequency = 0.28
	_run.call_deferred()


## Stands in for game.gd: every tile is the chosen terrain, except the player's.
func tile_at(p: Vector2i) -> int:
	if p == Vector2i.ZERO:
		return 1
	if terrain_key == "mixed":
		var v := (_patches.get_noise_2d(p.x, p.y) + 1.0) / 2.0
		return _ids_by_key[MIXED[clampi(int(v * MIXED.size()), 0, MIXED.size() - 1)]]
	return _tile_id


func _run() -> void:
	var enc: Node3D = ENCOUNTER_SCENE.instantiate()
	add_child(enc)
	enc.setup(self, {"x": 0, "y": 0, "radius": 8, "seed": 1234, "enemies": [
		{"id": 1, "kind": "zombie", "count": 15, "dx": 0, "dy": -2},
		{"id": 2, "kind": "zombie", "count": 12, "dx": 2, "dy": -3},
		{"id": 3, "kind": "zombie", "count": 15, "dx": -3, "dy": -4},
		{"id": 4, "kind": "zombie", "count": 10, "dx": 4, "dy": 1},
	]})
	enc.player.rotation.y = 0.0 # Look north, towards the zombies.
	if near_edge:
		var z: float = -(enc.half_extent - 20.0)
		enc.player.global_position = Vector3(0, enc.height_at(0, z) + 0.05, z)
		for zombie: Zombie3D in enc.enemies.values():
			zombie.target = null
	await get_tree().create_timer(3.0).timeout
	print("%s arena: %d fps, %d draw calls, %d objects in frame" % [
		terrain_key, Engine.get_frames_per_second(),
		Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
		Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME)])
	if not screenshot.is_empty():
		await RenderingServer.frame_post_draw
		get_viewport().get_texture().get_image().save_png(screenshot)
		print("screenshot saved to %s" % screenshot)
	var ok := true
	if check_trees:
		ok = await _check_trees(enc)
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	get_tree().quit(0 if ok else 1)


## Shoots the nearest tree and walks into it: both must be stopped by its mesh collider.
func _check_trees(enc: Node3D) -> bool:
	if enc._trees.is_empty():
		print("FAIL: no trees")
		return false
	for z: Zombie3D in enc.enemies.values():
		z.target = null # Hold still: this is about trees.
	var tree: Vector3 = enc._trees[0]
	for t: Vector3 in enc._trees:
		if t.length() < tree.length():
			tree = t
	# Stand 12 m from the trunk, on the side towards the arena centre, facing it.
	var away := (Vector3.ZERO - tree).normalized() if tree.length() > 0.1 else Vector3.BACK
	var start := tree + away * 12.0
	start.y = enc.height_at(start.x, start.z) + 0.05
	enc.player.global_position = start
	enc.player.rotation.y = atan2(away.x, away.z) # Facing -away, towards the tree.
	enc.camera.rotation.x = 0.0
	await get_tree().physics_frame
	await get_tree().physics_frame

	var from: Vector3 = enc.camera.global_position
	var query := PhysicsRayQueryParameters3D.create(from, from - enc.camera.global_basis.z * 30.0, 1)
	var hit := enc.get_world_3d().direct_space_state.intersect_ray(query)
	var shot_ok := not hit.is_empty() and Vector2(hit.position.x - tree.x, hit.position.z - tree.z).length() < 3.0
	print("%s: a shot at the trunk %s" % ["PASS" if shot_ok else "FAIL", "hit it %.1f m away" % from.distance_to(hit.position) if not hit.is_empty() else "hit nothing"])

	Input.action_press(&"move_up")
	await get_tree().create_timer(4.0).timeout # 5 m/s for 4 s: 20 m, well past the tree if nothing stops us.
	Input.action_release(&"move_up")
	var travelled: float = (enc.player.global_position - start).dot(-away)
	var walk_ok: bool = travelled < 12.0
	print("%s: walking into the tree stopped after %.1f m (trunk at 12 m)" % ["PASS" if walk_ok else "FAIL", travelled])
	return shot_ok and walk_ok
