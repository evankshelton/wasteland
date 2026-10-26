extends Node
## Builds a first-person arena of one terrain without a server, to look at it
## and check performance:
##
##   godot --path client res://tests/arena_preview.tscn -- --terrain dead_forest --screenshot out.png
##
## Prints fps and draw calls after a few seconds, saves a screenshot if asked,
## then quits. Tile definitions are read from ../shared/tiles.json, so run it
## from a checkout of the repository.

const ENCOUNTER_SCENE := preload("res://scenes/encounter.tscn")

var terrain_key := "dead_forest"
var screenshot := ""
var _tile_id := 1


func _ready() -> void:
	var args := OS.get_cmdline_user_args()
	for i in args.size() - 1:
		match args[i]:
			"--terrain": terrain_key = args[i + 1]
			"--screenshot": screenshot = args[i + 1]
	var tiles_path := ProjectSettings.globalize_path("res://").path_join("../shared/tiles.json")
	var defs: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(tiles_path))
	Net.welcome = {"tiles": defs.tiles}
	for t: Dictionary in defs.tiles:
		if t.key == terrain_key:
			_tile_id = int(t.id)
	_run.call_deferred()


## Stands in for game.gd: every tile is the chosen terrain, except the player's.
func tile_at(p: Vector2i) -> int:
	return 1 if p == Vector2i.ZERO else _tile_id


func _run() -> void:
	var enc: Node3D = ENCOUNTER_SCENE.instantiate()
	add_child(enc)
	enc.setup(self, {"x": 0, "y": 0, "radius": 8, "seed": 1234, "enemies": [
		{"id": 1, "kind": "zombie", "dx": 0, "dy": -2},
		{"id": 2, "kind": "zombie", "dx": 2, "dy": -3},
	]})
	enc.player.rotation.y = 0.0 # Look north, towards the zombies.
	await get_tree().create_timer(3.0).timeout
	print("%s arena: %d fps, %d draw calls, %d objects in frame" % [
		terrain_key, Engine.get_frames_per_second(),
		Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
		Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME)])
	if not screenshot.is_empty():
		await RenderingServer.frame_post_draw
		get_viewport().get_texture().get_image().save_png(screenshot)
		print("screenshot saved to %s" % screenshot)
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	get_tree().quit()
