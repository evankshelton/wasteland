extends Control
## Title screen: choose a server and a character name, then connect.
##
## Command-line shortcut for development:
##   godot --path client -- --host 127.0.0.1 --port 7777 --name Ash --autoconnect

const GAME_SCENE := "res://scenes/game.tscn"
const DEFAULT_PORT := 7777

var _name_re := RegEx.create_from_string("^[A-Za-z0-9 _-]{2,16}$")
var _busy := false

@onready var host_edit: LineEdit = %Host
@onready var port_edit: LineEdit = %Port
@onready var name_edit: LineEdit = %PlayerName
@onready var connect_button: Button = %ConnectButton
@onready var quit_button: Button = %QuitButton
@onready var status_label: Label = %Status


func _ready() -> void:
	host_edit.text = Prefs.last("host", "127.0.0.1")
	port_edit.text = str(Prefs.last("port", DEFAULT_PORT))
	name_edit.text = Prefs.last("name", "")

	connect_button.pressed.connect(_on_connect_pressed)
	quit_button.pressed.connect(get_tree().quit)
	for edit: LineEdit in [host_edit, port_edit, name_edit]:
		edit.text_submitted.connect(func(_text: String) -> void: _on_connect_pressed())
	Net.joined.connect(_on_joined)
	Net.disconnected.connect(_on_disconnected)

	_show_status(Net.last_disconnect_reason, true)
	if name_edit.text.is_empty():
		name_edit.grab_focus()
	else:
		connect_button.grab_focus()

	if _apply_cmdline_args():
		_on_connect_pressed()


func _on_connect_pressed() -> void:
	if _busy:
		Net.close()
		_set_busy(false)
		_show_status("Cancelled.")
		return

	var host := host_edit.text.strip_edges()
	var port := port_edit.text.strip_edges().to_int()
	var player_name := name_edit.text.strip_edges()
	if host.is_empty():
		_show_status("Enter a server address.", true)
		return
	if port < 1 or port > 65535:
		_show_status("Port must be between 1 and 65535.", true)
		return
	if not _name_re.search(player_name):
		_show_status("Names are 2-16 letters, digits, spaces, '-' or '_'.", true)
		return

	Prefs.save_last(host, port, player_name)
	var err := Net.connect_to(host, port, player_name)
	if err != OK:
		_show_status("Could not connect: %s" % error_string(err), true)
		return
	_set_busy(true)
	_show_status("Connecting to %s:%d ..." % [host, port])


func _on_joined(_welcome: Dictionary) -> void:
	get_tree().change_scene_to_file(GAME_SCENE)


func _on_disconnected(reason: String) -> void:
	_set_busy(false)
	_show_status(reason, true)


func _set_busy(busy: bool) -> void:
	_busy = busy
	connect_button.text = "Cancel" if busy else "Connect"
	for edit: LineEdit in [host_edit, port_edit, name_edit]:
		edit.editable = not busy


func _show_status(text: String, is_error := false) -> void:
	status_label.text = text
	status_label.modulate = Color(1, 0.4, 0.3) if is_error else Color(0.6, 1, 0.6)


## Returns true when --autoconnect was passed.
func _apply_cmdline_args() -> bool:
	var args := OS.get_cmdline_user_args()
	var auto := false
	var i := 0
	while i < args.size():
		var arg := args[i]
		var value := args[i + 1] if i + 1 < args.size() else ""
		match arg:
			"--host":
				host_edit.text = value
				i += 1
			"--port":
				port_edit.text = value
				i += 1
			"--name":
				name_edit.text = value
				i += 1
			"--autoconnect":
				auto = true
		i += 1
	return auto
