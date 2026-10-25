extends Node
## End-to-end check against a running server: join, hold a movement key,
## disconnect, rejoin, and confirm the server put us back where we stopped.
##
##   godot --headless --path client res://tests/smoke_test.tscn -- --host 127.0.0.1 --port 7777
##
## Without --headless it also saves a screenshot (--screenshot <path>).

const GAME_SCENE := preload("res://scenes/game.tscn")

var host := "127.0.0.1"
var port := 7777
var player_name := "SmokeTest"
var screenshot := ""


func _ready() -> void:
	var args := OS.get_cmdline_user_args()
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

	if not screenshot.is_empty() and DisplayServer.get_name() != "headless":
		await RenderingServer.frame_post_draw
		get_viewport().get_texture().get_image().save_png(screenshot)
		print("screenshot saved to %s" % screenshot)

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
