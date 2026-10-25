extends Node
## End-to-end check against a running server: join, hold a movement key, open
## the world map and let it load, then disconnect, rejoin, and confirm the
## server put us back where we stopped.
##
##   godot --headless --path client res://tests/smoke_test.tscn -- --host 127.0.0.1 --port 7777
##
## --expect-zombies also waits for a zombie to show up and approach (needs a
## server with a high spawn chance and a player out in the wasteland).
##
## Without --headless it also saves screenshots (--screenshot <path>; the map
## view goes to <path> with "_map" before the extension).

const GAME_SCENE := preload("res://scenes/game.tscn")

var host := "127.0.0.1"
var port := 7777
var player_name := "SmokeTest"
var screenshot := ""
var expect_zombies := false


func _ready() -> void:
	var args := OS.get_cmdline_user_args()
	expect_zombies = "--expect-zombies" in args
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

	if expect_zombies:
		var deadline := Time.get_ticks_msec() + 20000
		while game.monster_positions.is_empty():
			if Time.get_ticks_msec() > deadline:
				return _finish(false, "no zombie appeared")
			await get_tree().process_frame
		var id: int = game.monster_positions.keys()[0]
		var dist := func() -> int:
			var d: Vector2i = game.monster_positions.get(id, Vector2i(9999, 9999)) - game.pos
			return maxi(absi(d.x), absi(d.y))
		var first: int = dist.call()
		await get_tree().create_timer(4.0).timeout
		print("zombie #%d: %d tiles away, then %d" % [id, first, dist.call()])
		if dist.call() >= first and first > 1:
			return _finish(false, "zombie did not approach")

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

	Net.close()
	game.queue_free()
	await get_tree().create_timer(0.3).timeout

	game = await _join()
	if game == null:
		return
	if game.pos != stopped:
		return _finish(false, "rejoined at %s, expected %s" % [game.pos, stopped])
	_finish(true, "rejoined at %s" % game.pos)


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
