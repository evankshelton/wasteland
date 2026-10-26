extends Node
## End-to-end check against a running server: join, hold a movement key, open
## the world map and let it load, then disconnect, rejoin, and confirm the
## server put us back where we stopped.
##
##   godot --headless --path client res://tests/smoke_test.tscn -- --host 127.0.0.1 --port 7777
##
## --expect-base plays a brand-new character (random name unless --name is
## given): it must start inside the base, talk to the gate guard with the enter
## key, walk out of the south gate, step back onto the base icon, enter again
## with the enter key, and leave once more before the usual checks.
##
## --expect-encounter also waits for zombies to catch the player, checks the
## first-person arena, shoots a zombie, wins that fight, then waits for another
## and flees across the arena's edge. Needs a server with a high zombie spawn
## chance and the player far enough from the base for zombies to spawn.
##
## Without --headless it also saves screenshots (--screenshot <path>; the map
## view goes to <path> with "_map" before the extension, the fight to "_fps",
## the base to "_base").

const GAME_SCENE := preload("res://scenes/game.tscn")

var host := "127.0.0.1"
var port := 7777
var player_name := "SmokeTest"
var screenshot := ""
var expect_encounter := false
var expect_base := false


func _ready() -> void:
	var args := OS.get_cmdline_user_args()
	expect_encounter = "--expect-encounter" in args
	expect_base = "--expect-base" in args
	if expect_base and "--name" not in args:
		player_name = "Recruit%d" % (randi() % 100000)
	for i in args.size() - 1:
		match args[i]:
			"--host": host = args[i + 1]
			"--port": port = args[i + 1].to_int()
			"--name": player_name = args[i + 1]
			"--screenshot": screenshot = args[i + 1]
	_run.call_deferred()


func _run() -> void:
	var game := await _join()
	if game == null:
		return
	if expect_base:
		var problem: String = await _test_base(game)
		if not problem.is_empty():
			return _finish(false, problem)
	var start: Vector2i = game.pos
	print("joined at %s" % start)

	# Walk out of the base's south gate, then a little east.
	await _hold(game, &"move_down", 1.6)
	await _hold(game, &"move_right", 0.6)
	await get_tree().create_timer(0.5).timeout
	var stopped: Vector2i = game.pos
	print("walked to %s, %d chunks loaded" % [stopped, game.chunks.size()])
	if stopped == start:
		return _finish(false, "avatar did not move")

	if expect_encounter:
		var problem: String = await _test_encounters(game)
		if not problem.is_empty():
			return _finish(false, problem)
	else:
		await _screenshot(screenshot)

	_send_action(&"open_map")
	var map: Control = game.map_view
	var deadline := Time.get_ticks_msec() + 10000
	await get_tree().process_frame
	while map._awaiting_batch or not map._queue.is_empty() or map.status_label.text == "Surveying...":
		if Time.get_ticks_msec() > deadline:
			return _finish(false, "world map did not finish loading")
		await get_tree().process_frame
	if not map.visible:
		return _finish(false, "open_map did not open the map")
	print("map: %s" % map.status_label.text)
	_send_action(&"map_zoom_out")
	await get_tree().create_timer(0.2).timeout
	if not screenshot.is_empty():
		await _screenshot(screenshot.get_basename() + "_map." + screenshot.get_extension())
	_send_action(&"open_map")
	await get_tree().process_frame
	if map.visible:
		return _finish(false, "open_map did not close the map")

	while game.encounter: # Don't leave mid-fight.
		await get_tree().process_frame
	var left_at: Vector2i = game.pos
	Net.close()
	game.queue_free()
	await get_tree().create_timer(0.3).timeout

	game = await _join()
	if game == null:
		return
	if game.pos != left_at:
		return _finish(false, "rejoined at %s, expected %s" % [game.pos, left_at])
	_finish(true, "rejoined at %s" % game.pos)


## Returns "" on success, otherwise what went wrong.
func _test_base(game: Node) -> String:
	if game.location != "base":
		return "a new character started in the %s, not the base" % game.location
	if not game.base_terrain.visible or game.terrain.visible:
		return "the base map isn't the one showing"
	if game.npcs.size() < 5:
		return "only %d NPCs in the base" % game.npcs.size()
	var entry: Vector2i = game.pos
	print("in %s at %s (%s) with %d NPCs" % [game.base_info.name, entry, game._room_at(entry), game.npcs.size()])

	# The gate guard stands next to the entrance: the enter key talks to him.
	_send_action(&"enter")
	await get_tree().process_frame
	if not game.dialog.visible:
		return "the enter key didn't start a conversation next to the gate guard"
	print("%s: %s" % [game.dialog_name.text, game.dialog_text.text])
	if not screenshot.is_empty():
		await _screenshot(screenshot.get_basename() + "_base." + screenshot.get_extension())
	while game.dialog.visible:
		_send_action(&"enter")
		await get_tree().process_frame

	# Out through the south gate: gate, road, road, off the edge.
	await _steps(game, &"move_down", 4)
	if game.location != "overworld" or game.pos != Vector2i(0, 1):
		return "walking off the south edge left us in the %s at %s, expected the overworld at (0, 1)" % [game.location, game.pos]
	await _steps(game, &"move_up", 1)
	if game.tile_at(game.pos) != game._base_icon_id:
		return "(0, 0) isn't the base icon"
	if not screenshot.is_empty():
		await _screenshot(screenshot.get_basename() + "_icon." + screenshot.get_extension())
	_send_action(&"enter")
	if not await _wait_until(func() -> bool: return game.location == "base"):
		return "the enter key on the base icon didn't go inside"
	if game.pos != entry:
		return "entered at %s, expected the entrance %s" % [game.pos, entry]
	print("re-entered the base at %s" % game.pos)
	await _steps(game, &"move_down", 4)
	if game.location != "overworld":
		return "couldn't leave the base again"
	return ""


## Steps one tile at a time at the pace of a held key, waiting for each reply
## (and any map switch it causes). The server refuses steps closer than 60 ms.
func _steps(game: Node, action: StringName, count: int) -> void:
	for i in count:
		game._step(action)
		while game._pending_seq >= 0:
			await get_tree().process_frame
		await get_tree().create_timer(game.MOVE_REPEAT).timeout


func _wait_until(condition: Callable, timeout_ms := 5000) -> bool:
	var deadline := Time.get_ticks_msec() + timeout_ms
	while not condition.call():
		if Time.get_ticks_msec() > deadline:
			return false
		await get_tree().process_frame
	return true


func _test_encounters(game: Node) -> String:
	# 1. Stand still until a zombie catches us.
	var enc: Node3D = await _wait_for_encounter(game)
	if enc == null:
		return "no zombie reached the player"
	var center: Vector2i = game.pos
	var terrain := {}
	for key: String in enc._cells.values():
		terrain[key] = terrain.get(key, 0) + 1
	print("encounter at %s: %d zombie(s), %d arena nodes, terrain %s" % [center, enc.enemies.size(), enc.arena.get_child_count(), terrain])
	if enc.player.global_position.y > 0.5:
		return "player is standing on something at %s" % enc.player.global_position
	if enc.enemies.is_empty() or enc.arena.get_child_count() < 3:
		return "arena not built"
	if game.terrain.visible:
		return "overworld still showing during the fight"
	await get_tree().create_timer(1.0).timeout
	if not screenshot.is_empty():
		await _screenshot(screenshot.get_basename() + "_fps." + screenshot.get_extension())
		enc.player.rotate_y(PI) # ...and the view behind.
		await get_tree().create_timer(0.2).timeout
		await _screenshot(screenshot.get_basename() + "_fps2." + screenshot.get_extension())

	# 2. Step up to a zombie and shoot it for real (hitscan through the physics world).
	var z: Zombie3D = enc.enemies.values()[0]
	var away := -z.global_position.normalized() if z.global_position.length() > 0.1 else Vector3.BACK
	enc.player.global_position = z.global_position + away * 3.0
	await get_tree().physics_frame
	await get_tree().physics_frame
	_aim(enc, z)
	enc.fire()
	if z.health >= Zombie3D.MAX_HEALTH:
		return "shot at point blank did not hit the zombie"
	print("shot zombie #%d: health %d" % [z.monster_id, z.health])

	# 3. Finish them all: victory.
	for e: Zombie3D in enc.enemies.values():
		e.hit(1000.0)
	if not await _wait_for_result(game, "victory"):
		return "victory was not confirmed by the server (got '%s')" % game.last_encounter_result
	if not game.terrain.visible:
		return "overworld not restored after the fight"
	print("victory at %s" % game.pos)

	# 4. Next fight: run for it, east.
	enc = await _wait_for_encounter(game)
	if enc == null:
		return "no second encounter"
	center = game.pos
	enc.player.global_position = Vector3(enc.half_extent + 1.0, 1.0, 0.0)
	if not await _wait_for_result(game, "fled"):
		return "fleeing was not confirmed by the server (got '%s')" % game.last_encounter_result
	print("fled from %s to %s" % [center, game.pos])
	if game.pos.y != center.y or game.pos.x < center.x:
		return "fled east but came out at %s" % game.pos
	return ""


func _wait_for_encounter(game: Node) -> Node3D:
	var deadline := Time.get_ticks_msec() + 45000
	while game.encounter == null:
		if Time.get_ticks_msec() > deadline:
			return null
		await get_tree().process_frame
	await get_tree().process_frame
	return game.encounter


func _wait_for_result(game: Node, want: String) -> bool:
	game.last_encounter_result = ""
	var deadline := Time.get_ticks_msec() + 8000
	while game.last_encounter_result.is_empty():
		if Time.get_ticks_msec() > deadline:
			return false
		await get_tree().process_frame
	return game.last_encounter_result == want


## Point the player's camera at a zombie's chest.
func _aim(enc: Node3D, z: Zombie3D) -> void:
	var eye: Vector3 = enc.camera.global_position
	var chest := z.global_position + Vector3(0, 1.1, 0)
	var to := chest - eye
	enc.player.rotation.y = atan2(-to.x, -to.z)
	enc.camera.rotation.x = atan2(to.y, Vector2(to.x, to.z).length())


func _join() -> Node:
	var err := Net.connect_to(host, port, player_name)
	if err != OK:
		_finish(false, "connect_to failed: %s" % error_string(err))
		return null
	var result: Array = await _first_of([Net.joined, Net.disconnected])
	if result[0] == Net.disconnected:
		_finish(false, "could not join: %s" % result[1])
		return null
	var game := GAME_SCENE.instantiate()
	add_child(game)
	await get_tree().create_timer(0.3).timeout
	return game


func _hold(game: Node, action: StringName, seconds: float) -> void:
	Input.action_press(action)
	await get_tree().create_timer(seconds).timeout
	Input.action_release(action)
	# Let the in-flight step settle.
	while game._pending_seq >= 0:
		await get_tree().process_frame


func _send_action(action: StringName) -> void:
	var ev := InputEventAction.new()
	ev.action = action
	ev.pressed = true
	Input.parse_input_event(ev)
	var up := InputEventAction.new()
	up.action = action
	Input.parse_input_event(up)


func _screenshot(path: String) -> void:
	if path.is_empty() or DisplayServer.get_name() == "headless":
		return
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png(path)
	print("screenshot saved to %s" % path)


## Awaits whichever signal fires first; returns [signal, first_arg].
func _first_of(signals: Array) -> Array:
	var state := {"result": []}
	for s: Signal in signals:
		s.connect(func(arg: Variant) -> void:
			if state.result.is_empty():
				state.result = [s, arg], CONNECT_ONE_SHOT)
	while state.result.is_empty():
		await get_tree().process_frame
	return state.result


func _finish(ok: bool, detail: String) -> void:
	print("%s: %s" % ["PASS" if ok else "FAIL", detail])
	Net.close()
	get_tree().quit(0 if ok else 1)
