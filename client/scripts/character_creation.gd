extends Control
## Rolling a new character: the server rolls strength, dexterity, intelligence
## (6-18, averaging 12) and hit points (6-12). Reroll as often as you like;
## Accept keeps the roll and enters the game. Rolls are final once accepted.

const GAME_SCENE := "res://scenes/game.tscn"
const MENU_SCENE := "res://scenes/main_menu.tscn"

## [key in the character, label, what it does]
const ABILITIES := [
	["str", "Strength", "Damage with every shot."],
	["dex", "Dexterity", "How fast you shoot and run."],
	["int", "Intelligence", "Bonus experience from everything you do."],
	["maxHp", "Hit Points", "How much punishment you can take."],
]

var rolls := 1
var _waiting := false
var _values: Array[Label] = []

@onready var name_label: Label = %NameLabel
@onready var grid: GridContainer = %Abilities
@onready var rolls_label: Label = %RollsLabel
@onready var reroll_button: Button = %RerollButton
@onready var accept_button: Button = %AcceptButton


func _ready() -> void:
	if Net.character.is_empty():
		get_tree().change_scene_to_file.call_deferred(MENU_SCENE)
		return
	name_label.text = str(Net.welcome.get("name", ""))
	for a in ABILITIES:
		var label := Label.new()
		label.text = a[1]
		label.custom_minimum_size.x = 170
		grid.add_child(label)
		var value := Label.new()
		value.custom_minimum_size.x = 60
		value.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
		value.add_theme_font_size_override(&"font_size", 28)
		value.add_theme_color_override(&"font_color", Color(1, 1, 0.33))
		grid.add_child(value)
		_values.append(value)
		var hint := Label.new()
		hint.text = a[2]
		hint.add_theme_color_override(&"font_color", Color(0.6, 0.6, 0.6))
		hint.add_theme_font_size_override(&"font_size", 15)
		grid.add_child(hint)
	reroll_button.pressed.connect(reroll)
	accept_button.pressed.connect(accept)
	%BackButton.pressed.connect(_back)
	Net.character_changed.connect(_on_character_changed)
	Net.disconnected.connect(func(_reason: String) -> void: _back())
	_show(Net.character)
	accept_button.grab_focus()


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.physical_keycode == KEY_R:
		reroll()
		get_viewport().set_input_as_handled()


func reroll() -> void:
	if _waiting:
		return
	_waiting = true
	Net.send({"t": "reroll"})


func accept() -> void:
	if _waiting:
		return
	_waiting = true
	reroll_button.disabled = true
	accept_button.disabled = true
	Net.send({"t": "accept"})


func _on_character_changed(c: Dictionary) -> void:
	_waiting = false
	if c.get("created", false):
		get_tree().change_scene_to_file(GAME_SCENE)
		return
	rolls += 1
	_show(c)


func _show(c: Dictionary) -> void:
	for i in ABILITIES.size():
		_values[i].text = str(int(c[ABILITIES[i][0]]))
		# A quick fade-in so each new roll is noticeable.
		_values[i].modulate = Color(1, 1, 1, 0.2)
		_values[i].create_tween().tween_property(_values[i], ^"modulate:a", 1.0, 0.25)
	var total := int(c.str) + int(c.dex) + int(c.int)
	rolls_label.text = "Roll #%d   (STR + DEX + INT = %d, average 36)" % [rolls, total]


func _back() -> void:
	Net.close()
	get_tree().change_scene_to_file(MENU_SCENE)
