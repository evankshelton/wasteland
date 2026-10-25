extends Node
## Client side of the Wasteland protocol: one WebSocket carrying JSON objects
## tagged by "t". See docs/PROTOCOL.md and server/src/protocol.ts.
##
## The handshake (hello -> welcome) and errors are handled here; every other
## message is queued until the game scene calls drain(), so nothing is lost
## while scenes are switching.

signal joined(welcome: Dictionary)
signal disconnected(reason: String)

const PROTOCOL_VERSION := 2
const CONNECT_TIMEOUT_MS := 8000

## The server's welcome message while joined, otherwise empty.
var welcome: Dictionary = {}
var last_disconnect_reason := ""

var _ws: WebSocketPeer
var _was_open := false
var _connect_started_ms := 0
var _host := ""
var _port := 0
var _player_name := ""
var _server_error := ""
var _inbox: Array[Dictionary] = []


func connect_to(host: String, port: int, player_name: String) -> Error:
	close()
	last_disconnect_reason = ""
	_host = host
	_port = port
	_player_name = player_name
	_ws = WebSocketPeer.new()
	_ws.inbound_buffer_size = 4 * 1024 * 1024
	_ws.max_queued_packets = 8192
	var err := _ws.connect_to_url("ws://%s:%d" % [host, port])
	if err != OK:
		_ws = null
		return err
	_connect_started_ms = Time.get_ticks_msec()
	return OK


## Leave the server without emitting `disconnected`.
func close() -> void:
	if _ws:
		_ws.close()
	_ws = null
	_was_open = false
	_server_error = ""
	welcome = {}
	_inbox.clear()


func is_joined() -> bool:
	return _ws != null and not welcome.is_empty()


func send(msg: Dictionary) -> void:
	if _ws and _ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_ws.send_text(JSON.stringify(msg))


## Returns and clears the queued game messages, oldest first.
func drain() -> Array[Dictionary]:
	var out := _inbox
	_inbox = []
	return out


func _process(_delta: float) -> void:
	if _ws == null:
		return
	_ws.poll()
	var state := _ws.get_ready_state()

	if state == WebSocketPeer.STATE_CONNECTING:
		if Time.get_ticks_msec() - _connect_started_ms > CONNECT_TIMEOUT_MS:
			_drop("Timed out connecting to %s:%d." % [_host, _port])
		return

	if state == WebSocketPeer.STATE_OPEN and not _was_open:
		_was_open = true
		send({
			"t": "hello",
			"v": PROTOCOL_VERSION,
			"name": _player_name,
			"token": Prefs.token_for(_host, _port, _player_name),
		})

	while _ws and _ws.get_available_packet_count() > 0:
		var packet := _ws.get_packet()
		if not _ws.was_string_packet():
			continue
		var msg: Variant = JSON.parse_string(packet.get_string_from_utf8())
		if msg is Dictionary and msg.has("t"):
			_receive(msg)

	if _ws and _ws.get_ready_state() == WebSocketPeer.STATE_CLOSED:
		var reason := _server_error
		if reason.is_empty():
			reason = "Connection to the server was lost." if _was_open else "Could not reach %s:%d." % [_host, _port]
		_drop(reason)


func _receive(msg: Dictionary) -> void:
	match msg.t:
		"welcome":
			welcome = msg
			Prefs.save_token(_host, _port, _player_name, str(msg.token))
			joined.emit(msg)
		"error":
			_server_error = str(msg.get("message", "The server reported an error."))
		_:
			_inbox.append(msg)


func _drop(reason: String) -> void:
	close()
	last_disconnect_reason = reason
	disconnected.emit(reason)
