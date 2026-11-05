class_name CardView
extends Control
## One card, framed like a Magic: the Gathering card in the game's EGA colours:
## a black border; a frame coloured by where the card comes from (weapons red,
## armor white, abilities blue, allies green, supplies gold, terrain brown, the
## basics grey, the enemies' own cards a bruised purple); the name with its
## Energy cost in pips (enemy cards cost nothing); the art; a type line
## (Action, Reaction, Power, Ally or an enemy's Move, and the card's origin)
## with a rarity gem;
## the rules text (written by the server, with the numbers as they stand right
## now) and a line of flavour on a pale text box; and for allies, their attack
## and hit points in the corner. Used by the battle screen, the inventory,
## shops and card offers.
##
## Click it (or press its key, on the battle screen) and it emits `pressed`.

signal pressed

const SIZE := Vector2(140, 196)
const TILES_ART := preload("res://assets/tiles.png")
const SPRITES_ART := preload("res://assets/sprites.png")
const FRAME_COLOR := {
	"weapon": Color(0.62, 0.12, 0.08), "armor": Color(0.78, 0.76, 0.68), "ability": Color(0.1, 0.3, 0.62),
	"ally": Color(0.1, 0.45, 0.16), "supply": Color(0.72, 0.56, 0.12), "terrain": Color(0.45, 0.32, 0.18),
	"basic": Color(0.45, 0.45, 0.45), "enemy": Color(0.35, 0.12, 0.4),
}
const RARITY_COLOR := {"starter": Color(0.35, 0.35, 0.35), "common": Color(0.1, 0.1, 0.1), "uncommon": Color(0.75, 0.8, 0.85), "rare": Color(1.0, 0.8, 0.2)}
const ORIGIN := {"basic": "Basic", "ability": "Ability", "supply": "Supply", "terrain": "Terrain", "ally": "Survivor"}
const ALLY_ART := {"stray_dog": 7, "auto_turret": 8} ## sprites.png columns; the rest are survivors (the avatar, tinted)
const SURVIVOR_TINT := Color(0.55, 0.75, 0.45)
const PIP := Color(1.0, 1.0, 0.33)
const PARCHMENT := Color(0.86, 0.82, 0.7)
const INK := Color(0.08, 0.07, 0.06)

var card: Dictionary = {} ## the server's card view: name, type, kind, speed, cost, text, level...
var playable := true: ## dimmed when false (can't play it now)
	set(v):
		playable = v
		modulate = Color.WHITE if v else Color(0.5, 0.5, 0.5)
var selected := false ## outlined: picked, waiting for a target
var key_hint := "" ## shown in the corner, e.g. "1"
var terrain_tile := -1 ## for terrain cards: the tile id whose art goes on the card
var _hover := false


func _init(view: Dictionary = {}) -> void:
	card = view
	custom_minimum_size = SIZE
	size = SIZE
	mouse_filter = Control.MOUSE_FILTER_STOP
	mouse_entered.connect(func() -> void: _hover = true; queue_redraw())
	mouse_exited.connect(func() -> void: _hover = false; queue_redraw())


func set_card(view: Dictionary) -> void:
	card = view
	queue_redraw()


func _gui_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		pressed.emit()
		accept_event()


## The frame colour: the kind of card, or for equipment, its slot.
func _frame() -> Color:
	var kind := str(card.get("kind", "basic"))
	if kind == "equipment":
		return FRAME_COLOR.get(str(card.get("slot", "weapon")), Color.GRAY)
	return FRAME_COLOR.get(kind, Color.GRAY)


## "Reaction - Weapon", "Power - Armor", "Ally - Survivor"...
func _type_line() -> String:
	var kind := str(card.get("kind", ""))
	var main := "Reaction" if card.get("speed", "action") == "reaction" else "Action"
	if kind == "enemy":
		return "%s - %s" % ["Reaction" if main == "Reaction" else "Move", str(card.get("slot", ""))]
	if card.get("type", "") == "power":
		main = "Power"
	elif card.get("type", "") == "ally":
		main = "Ally"
	var origin: String = str(card.get("slot", "gear")).capitalize() if kind == "equipment" else ORIGIN.get(kind, "")
	return "%s - %s" % [main, origin]


func _draw() -> void:
	if card.is_empty():
		return
	var font := get_theme_default_font()
	var w := size.x
	var h := size.y
	var frame := _frame()
	var light := frame.get_luminance() > 0.5
	var reaction: bool = card.get("speed", "action") == "reaction"
	# Black border, rounded, and the coloured frame inside it.
	_round_rect(Rect2(0, 0, w, h), Color.BLACK, 9)
	_round_rect(Rect2(4, 4, w - 8, h - 8), frame, 6)
	if (_hover or selected) and playable:
		_round_rect(Rect2(0, 0, w, h), Color.WHITE, 9, false, 3.0 if selected else 2.0)
	# Name bar, with the cost in Energy pips on the right.
	var bar := Rect2(8, 8, w - 16, 20)
	draw_rect(bar, frame.lightened(0.45))
	draw_rect(bar, INK, false, 1.0)
	var cost := int(card.get("cost", 0))
	var pips := 0 if cost < 0 else clampi(cost, 1, 3) if cost <= 3 else 1
	var pip_x := bar.end.x - 9.0
	for i in pips:
		var c := Vector2(pip_x - i * 13.0, bar.get_center().y)
		draw_circle(c, 6.0, PIP if cost > 0 else Color(0.75, 0.75, 0.75))
		draw_arc(c, 6.0, 0, TAU, 16, INK, 1.0)
		if cost == 0 or cost > 3:
			draw_string(font, c + Vector2(-6, 4), str(cost), HORIZONTAL_ALIGNMENT_CENTER, 12, 10, INK)
	draw_string(font, Vector2(bar.position.x + 4, bar.position.y + 15), str(card.get("name", "?")), HORIZONTAL_ALIGNMENT_LEFT, bar.size.x - 12 - pips * 13, 12, INK)
	# Art.
	var art := Rect2(12, 31, w - 24, 62)
	draw_rect(art, Color(0.03, 0.03, 0.04))
	_draw_art(art, font, frame)
	draw_rect(art, INK, false, 1.0)
	if reaction: # A Reaction's art has a lightning-blue edge, like a flash.
		draw_rect(art.grow(-2), Color(0.4, 0.9, 1.0), false, 1.0)
	# Type line, with the rarity gem.
	var type_bar := Rect2(8, 96, w - 16, 17)
	draw_rect(type_bar, frame.lightened(0.45))
	draw_rect(type_bar, INK, false, 1.0)
	draw_string(font, Vector2(type_bar.position.x + 4, type_bar.position.y + 13), _type_line(), HORIZONTAL_ALIGNMENT_LEFT, type_bar.size.x - 20, 10, INK)
	var gem := Vector2(type_bar.end.x - 8, type_bar.get_center().y)
	draw_colored_polygon(PackedVector2Array([gem + Vector2(0, -5), gem + Vector2(5, 0), gem + Vector2(0, 5), gem + Vector2(-5, 0)]), RARITY_COLOR.get(card.get("rarity", "common"), Color.WHITE))
	draw_polyline(PackedVector2Array([gem + Vector2(0, -5), gem + Vector2(5, 0), gem + Vector2(0, 5), gem + Vector2(-5, 0), gem + Vector2(0, -5)]), INK, 1.0)
	# Text box: the rules, then the flavour if there's room.
	var box := Rect2(11, 116, w - 22, h - 124)
	draw_rect(box, PARCHMENT)
	draw_rect(box, INK, false, 1.0)
	var text := str(card.get("text", ""))
	var text_size := 11
	while text_size > 8 and font.get_multiline_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, box.size.x - 8, text_size).y > box.size.y - 6:
		text_size -= 1
	draw_multiline_string(font, Vector2(box.position.x + 4, box.position.y + text_size + 2), text, HORIZONTAL_ALIGNMENT_LEFT, box.size.x - 8, text_size, -1, INK)
	var used := font.get_multiline_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, box.size.x - 8, text_size).y
	var flavor := str(card.get("flavor", ""))
	var pt := card.get("power") != null
	var flavor_room := box.size.y - used - 10 - (14 if pt else 0)
	if not flavor.is_empty() and font.get_multiline_string_size(flavor, HORIZONTAL_ALIGNMENT_LEFT, box.size.x - 8, 9).y <= flavor_room:
		var fy := box.position.y + used + 8
		draw_line(Vector2(box.position.x + 14, fy - 2), Vector2(box.end.x - 14, fy - 2), Color(0.5, 0.45, 0.35), 1.0)
		draw_multiline_string(font, Vector2(box.position.x + 4, fy + 9), flavor, HORIZONTAL_ALIGNMENT_LEFT, box.size.x - 8, 9, -1, Color(0.38, 0.33, 0.25))
	# An ally's attack / hit points, in a box over the bottom-right corner.
	if pt:
		var ptr := Rect2(w - 46, h - 22, 38, 17)
		draw_rect(ptr, frame.lightened(0.45))
		draw_rect(ptr, INK, false, 1.0)
		draw_string(font, Vector2(ptr.position.x, ptr.position.y + 13), "%d/%d" % [int(card.power), int(card.toughness)], HORIZONTAL_ALIGNMENT_CENTER, ptr.size.x, 12, INK)
	if not key_hint.is_empty():
		draw_string(font, Vector2(14, h - 7), key_hint, HORIZONTAL_ALIGNMENT_LEFT, -1, 10, Color(0.38, 0.33, 0.25) if not light else INK)


func _draw_art(art: Rect2, font: Font, frame: Color) -> void:
	var kind := str(card.get("kind", ""))
	if kind == "terrain" and terrain_tile >= 0:
		for i in 3:
			draw_texture_rect_region(TILES_ART, Rect2(art.position.x + 3 + i * 38, art.position.y + 12, 36, 36), Rect2(terrain_tile * 16, 0, 16, 16))
	elif kind == "enemy":
		# The creature that plays it.
		draw_texture_rect_region(SPRITES_ART, Rect2(art.get_center().x - 26, art.position.y + 6, 52, 52), Rect2(int(card.get("sprite", 1)) * 16, 0, 16, 16))
	elif kind == "ally":
		# A dog, a turret, or a survivor (the player sprite, tinted).
		var column: int = ALLY_ART.get(str(card.get("card", "")), 0)
		draw_texture_rect_region(SPRITES_ART, Rect2(art.get_center().x - 26, art.position.y + 6, 52, 52), Rect2(column * 16, 0, 16, 16), SURVIVOR_TINT if column == 0 else Color.WHITE)
	else:
		var glyph := {"attack": "/", "skill": "#", "power": "*"}.get(card.get("type", ""), "?") as String
		draw_string(font, Vector2(art.position.x, art.position.y + 46), glyph, HORIZONTAL_ALIGNMENT_CENTER, art.size.x, 40, frame.lightened(0.35))


func _round_rect(r: Rect2, colour: Color, radius: int, filled := true, width := 1.0) -> void:
	var sb := StyleBoxFlat.new()
	sb.bg_color = colour if filled else Color(0, 0, 0, 0)
	sb.set_corner_radius_all(radius)
	if not filled:
		sb.border_color = colour
		sb.set_border_width_all(int(width))
	draw_style_box(sb, r)
