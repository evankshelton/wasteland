class_name BattleScreen
extends Control
## The card battle, drawn in the game's pixel art: the enemy groups (zombie
## packs, raider gangs, hounds, ghouls, rats, crawlers) across the top with
## their health, Block, statuses, the move card they'll play next and how they
## react; you on the left with your health, Block and Energy, and your
## allies under you; the stack in the middle (what's about to happen, the top
## first); your hand along the bottom.
##
## The server runs the battle. This screen shows each snapshot it sends
## ("battle" messages) and sends the moves: play a card (at a pack, for cards
## aimed at one), end the turn, pass (let the zombie move or reaction on top of
## the stack happen without answering it), or run for it.
##
## Mouse: click a card to play it; a card aimed at one pack, with more than
## one standing, then wants a click on the pack (right-click or Esc to put it
## back). Keys: 1-9 play the card in that slot (at the marked group), Tab
## picks the next group (your allies attack it too), C shows the marked
## group's cards (its move deck and its reaction), E ends the turn, Space
## passes, F flees.

const SPRITES := preload("res://assets/sprites.png")
const TILES := preload("res://assets/tiles.png")
const AVATAR := Rect2(0, 0, 16, 16)
const ALLY_SPRITE := {"stray_dog": 7, "auto_turret": 8} ## sprites.png columns; the rest are survivors (the avatar)
const YELLOW := Color(1.0, 1.0, 0.33)
const RED := Color(0.67, 0.0, 0.0)
const BLUE := Color(0.33, 0.33, 1.0)
const GREEN := Color(0.33, 1.0, 0.33)
const PANEL := Color(0.05, 0.04, 0.04, 0.85)
const ALLY_TINT := {"militia": Color(0.55, 0.75, 0.45)}
const PANEL_H := 268.0

var encounter_id := -1
var state: Dictionary = {} ## the latest battle snapshot from the server
var target := -1 ## the pack cards aimed at one enemy go to
var ground_tile := 1 ## tile id of the ground we're fighting on (the backdrop)
var _aiming := -1 ## uid of a card waiting for a target, -1 if none
var _waiting := false ## a move is on its way to the server
var _cards: Array[CardView] = []
var _banner := ""
var _enemy_rects := {} ## enemy id -> Rect2 on screen, for clicks
var _terrain_ids := {} ## terrain key -> tile id, for terrain cards' art
var _buttons := {} ## name -> Rect2 of the End Turn (or Pass) / Flee buttons
var _foe_cards: Array[CardView] = [] ## the marked group's cards, while they're shown (C)


func setup(game: Node, msg: Dictionary) -> void:
	encounter_id = int(msg.id)
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	var id: int = game.tile_at(Vector2i(int(msg.x), int(msg.y)))
	ground_tile = id if id >= 0 else 1
	for t: Dictionary in Net.welcome.tiles:
		_terrain_ids[str(t.key)] = int(t.id)
	update(msg.battle)


## A new snapshot from the server.
func update(view: Dictionary) -> void:
	state = view
	_waiting = false
	_aiming = -1
	var living: Array = state.enemies.filter(func(e: Dictionary) -> bool: return int(e.hp) > 0)
	if not living.any(func(e: Dictionary) -> bool: return int(e.id) == target):
		target = int(living[0].id) if not living.is_empty() else -1
	if state.get("over") != null:
		_banner = {"victory": "VICTORY", "fled": "YOU GOT AWAY", "died": "YOU DIED"}.get(state.over, "")
	_rebuild_hand()
	if not _foe_cards.is_empty():
		show_foe_cards(true)
	queue_redraw()


## Show (or hide) the marked group's cards: every move in its deck, and its reaction.
func show_foe_cards(on: bool) -> void:
	for c in _foe_cards:
		c.queue_free()
	_foe_cards.clear()
	if not on:
		queue_redraw()
		return
	var foe := _enemy(target)
	var cards: Array = foe.get("cards", [])
	var gap := minf(CardView.SIZE.x + 8.0, (size.x - 40.0) / maxf(1.0, cards.size()))
	var x0 := (size.x - gap * (cards.size() - 1) - CardView.SIZE.x) / 2.0
	for i in cards.size():
		var v := CardView.new(cards[i])
		v.position = Vector2(x0 + gap * i, 150)
		v.mouse_filter = Control.MOUSE_FILTER_IGNORE
		add_child(v)
		_foe_cards.append(v)
	queue_redraw()


func _enemy(id: int) -> Dictionary:
	for e: Dictionary in state.get("enemies", []):
		if int(e.id) == id:
			return e
	return {}


func _rebuild_hand() -> void:
	for c in _cards:
		c.queue_free()
	_cards.clear()
	var hand: Array = state.get("hand", [])
	for i in hand.size():
		var v := CardView.new(hand[i])
		v.playable = bool(hand[i].playable) and state.get("over") == null
		v.key_hint = str(i + 1) if i < 9 else ""
		if hand[i].kind == "terrain":
			v.terrain_tile = _terrain_tile_for(str(hand[i].card))
		v.pressed.connect(_on_card_pressed.bind(int(hand[i].uid)))
		add_child(v)
		_cards.append(v)
	_layout_hand()


func _terrain_tile_for(card_id: String) -> int:
	# The art is the ground the card came from; the battle ground if we can't tell.
	var keys := {"take_cover": "ruins", "snapped_branch": "dead_forest", "toxic_splash": "water", "rad_surge": "radiation",
		"wreck_barricade": "road", "hurl_debris": "rubble", "high_ground": "hills", "ash_cloud": "dunes", "dust_kick": "wasteland",
		"cave_in": "cave_wall"}
	return _terrain_ids.get(keys.get(card_id, ""), ground_tile)


func _layout_hand() -> void:
	var n := _cards.size()
	if n == 0:
		return
	var gap := minf(CardView.SIZE.x + 8.0, (size.x - 420.0) / n)
	var start := (size.x - gap * (n - 1) - CardView.SIZE.x) / 2.0
	for i in n:
		var v := _cards[i]
		var lift := -24.0 if v.selected else 0.0
		v.position = Vector2(start + gap * i, size.y - CardView.SIZE.y - 14.0 + lift)


func _notification(what: int) -> void:
	if what == NOTIFICATION_RESIZED:
		_layout_hand()


# ---- moves ----

func _on_card_pressed(uid: int) -> void:
	if _waiting or state.get("over") != null:
		return
	var card := _hand_card(uid)
	if card.is_empty() or not bool(card.playable):
		return
	var living := _living()
	if card.target == "enemy" and living.size() > 1:
		# Wants a pack: pick one (or press the card again to send it at the marked one).
		if _aiming == uid:
			_play(uid, target)
		else:
			_aiming = uid
			for v in _cards:
				v.selected = int(v.card.uid) == uid
			_layout_hand()
			queue_redraw()
		return
	_play(uid, target if card.target == "enemy" else -1)


func _play(uid: int, at: int) -> void:
	var msg := {"t": "battle_play", "id": encounter_id, "uid": uid}
	if at >= 0:
		msg.target = at
	_send(msg)


func _send(msg: Dictionary) -> void:
	_waiting = true
	Net.send(msg)


func end_turn() -> void:
	if responding():
		pass_priority()
	elif not _waiting and state.get("over") == null and state.get("phase") == "you":
		var msg := {"t": "battle_end_turn", "id": encounter_id}
		if target >= 0:
			msg.target = target
		_send(msg)


## Let what the zombies put on the stack happen, without answering it.
func pass_priority() -> void:
	if responding():
		_send({"t": "battle_pass", "id": encounter_id})


## A zombie move or reaction is on top of the stack, waiting for our answer.
func responding() -> bool:
	return bool(state.get("respond", false)) and not _waiting and state.get("over") == null


func flee() -> void:
	if not _waiting and state.get("over") == null and not responding():
		_send({"t": "battle_flee", "id": encounter_id})


## Play the card in hand slot `i` (0-based) at the marked pack: what the number keys do.
func play_slot(i: int) -> void:
	var hand: Array = state.get("hand", [])
	if i < hand.size() and bool(hand[i].playable) and not _waiting and state.get("over") == null:
		_play(int(hand[i].uid), target if hand[i].target == "enemy" else -1)


func _hand_card(uid: int) -> Dictionary:
	for c: Dictionary in state.get("hand", []):
		if int(c.uid) == uid:
			return c
	return {}


func _living() -> Array:
	return state.get("enemies", []).filter(func(e: Dictionary) -> bool: return int(e.hp) > 0)


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo:
		var key: int = event.physical_keycode
		if key >= KEY_1 and key <= KEY_9:
			play_slot(key - KEY_1)
		elif key == KEY_E or key == KEY_ENTER:
			end_turn()
		elif key == KEY_SPACE:
			pass_priority()
		elif key == KEY_F:
			flee()
		elif key == KEY_TAB:
			var living := _living()
			if not living.is_empty():
				var ids := living.map(func(e: Dictionary) -> int: return int(e.id))
				target = ids[(ids.find(target) + 1) % ids.size()]
				if not _foe_cards.is_empty():
					show_foe_cards(true)
				queue_redraw()
		elif key == KEY_C:
			show_foe_cards(_foe_cards.is_empty())
		elif key == KEY_ESCAPE and not _foe_cards.is_empty():
			show_foe_cards(false)
		elif key == KEY_ESCAPE and _aiming >= 0:
			_cancel_aim()
		else:
			return
		get_viewport().set_input_as_handled()


func _gui_input(event: InputEvent) -> void:
	if not (event is InputEventMouseButton and event.pressed):
		return
	if event.button_index == MOUSE_BUTTON_RIGHT:
		_cancel_aim()
		return
	if event.button_index != MOUSE_BUTTON_LEFT:
		return
	for id: int in _enemy_rects:
		if (_enemy_rects[id] as Rect2).has_point(event.position):
			target = id
			if _aiming >= 0:
				_play(_aiming, id)
			queue_redraw()
			return
	if (_buttons.get("end", Rect2()) as Rect2).has_point(event.position):
		end_turn()
	elif (_buttons.get("flee", Rect2()) as Rect2).has_point(event.position):
		flee()


func _cancel_aim() -> void:
	_aiming = -1
	for v in _cards:
		v.selected = false
	_layout_hand()
	queue_redraw()


# ---- drawing ----

func _draw() -> void:
	var font := get_theme_default_font()
	# The ground we're fighting on, tiled and darkened behind everything.
	draw_rect(Rect2(Vector2.ZERO, size), Color.BLACK)
	var tile := 48.0
	for y in int(size.y / tile) + 1:
		for x in int(size.x / tile) + 1:
			draw_texture_rect_region(TILES, Rect2(x * tile, y * tile, tile, tile), Rect2(ground_tile * 16, 0, 16, 16), Color(0.32, 0.32, 0.32))
	if state.is_empty():
		return
	_draw_enemies(font)
	_draw_player(font)
	_draw_allies(font)
	_draw_stack(font)
	_draw_log(font)
	var mine: bool = state.get("phase", "you") == "you"
	draw_string(font, Vector2(0, 46), "YOUR TURN" if mine else "THE ZOMBIES' TURN", HORIZONTAL_ALIGNMENT_CENTER, size.x, 22, YELLOW if mine else Color(1, 0.4, 0.4))
	# Piles and buttons along the bottom corners.
	var p: Dictionary = state.player
	_box(Rect2(14, size.y - 70, 150, 56))
	draw_string(font, Vector2(24, size.y - 46), "Draw pile: %d" % int(state.drawPile), HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color.WHITE)
	draw_string(font, Vector2(24, size.y - 26), "Turn %d" % int(state.turn), HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color(0.7, 0.7, 0.7))
	_box(Rect2(size.x - 164, size.y - 70, 150, 56))
	draw_string(font, Vector2(size.x - 154, size.y - 46), "Discard: %d" % int(state.discardPile), HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color.WHITE)
	draw_string(font, Vector2(size.x - 154, size.y - 26), "Exhausted: %d" % int(state.exhausted), HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color(0.7, 0.7, 0.7))
	_buttons.end = Rect2(size.x - 164, size.y - 150, 150, 36)
	_buttons.flee = Rect2(size.x - 164, size.y - 106, 150, 28)
	if responding():
		_button(font, _buttons.end, "Pass [Space]", Color(0.4, 0.9, 1.0))
	else:
		_button(font, _buttons.end, "End Turn [E]", YELLOW)
	_button(font, _buttons.flee, "Flee [F]", Color(0.8, 0.8, 0.8))
	# Energy: a big number in a yellow ring above the draw pile.
	var orb := Vector2(64, size.y - 120)
	draw_circle(orb, 34, Color.BLACK)
	draw_arc(orb, 34, 0, TAU, 32, YELLOW, 3.0)
	draw_string(font, orb + Vector2(-34, 9), "%d/%d" % [int(p.energy), int(p.maxEnergy)], HORIZONTAL_ALIGNMENT_CENTER, 68, 24, YELLOW)
	draw_string(font, orb + Vector2(-34, 52), "ENERGY", HORIZONTAL_ALIGNMENT_CENTER, 68, 11, YELLOW)
	if _aiming >= 0:
		draw_string(font, Vector2(0, size.y - CardView.SIZE.y - 50), "Pick a pack to play it on (right-click to put it back)", HORIZONTAL_ALIGNMENT_CENTER, size.x, 15, YELLOW)
	if not _foe_cards.is_empty():
		draw_rect(Rect2(Vector2.ZERO, size), Color(0, 0, 0, 0.75))
		draw_string(font, Vector2(0, 130), "%s's cards  [C to close]" % _enemy(target).get("name", ""), HORIZONTAL_ALIGNMENT_CENTER, size.x, 18, YELLOW)
	if not _banner.is_empty():
		draw_rect(Rect2(0, size.y * 0.42 - 40, size.x, 80), Color(0, 0, 0, 0.8))
		draw_string(font, Vector2(0, size.y * 0.42 + 14), _banner, HORIZONTAL_ALIGNMENT_CENTER, size.x, 40, YELLOW if _banner != "YOU DIED" else Color(1, 0.33, 0.33))


func _draw_enemies(font: Font) -> void:
	_enemy_rects.clear()
	var enemies: Array = state.enemies
	var w := 190.0
	var x0 := (size.x - w * enemies.size()) / 2.0 + 120.0
	for i in enemies.size():
		var e: Dictionary = enemies[i]
		var r := Rect2(x0 + i * w, 70, w - 16, PANEL_H)
		var dead := int(e.hp) <= 0
		_enemy_rects[int(e.id)] = r
		_box(r)
		if int(e.id) == target and not dead:
			draw_rect(r.grow(2), YELLOW if _aiming < 0 else Color.WHITE, false, 3.0)
		# The move card it'll play next: in red for attacks, blue for the rest.
		var intent: Dictionary = e.intent
		var hostile: bool = intent.get("damage") != null
		if not dead:
			draw_string(font, Vector2(r.position.x, r.position.y + 18), str(intent.name), HORIZONTAL_ALIGNMENT_CENTER, r.size.x, 12, Color(0.8, 0.8, 0.8))
			draw_string(font, Vector2(r.position.x + 4, r.position.y + 34), str(intent.text), HORIZONTAL_ALIGNMENT_CENTER, r.size.x - 8, 14, Color(1, 0.4, 0.4) if hostile else Color(0.5, 0.6, 1.0))
		# The group: up to three of them, bigger the more there are.
		var n := int(e.count)
		var cx := r.get_center().x
		var art := Rect2(int(e.get("sprite", 1)) * 16, 0, 16, 16)
		var tint := Color(1, 1, 1, 0.25) if dead else Color.WHITE
		if n >= 2: # back left, then back right, then the big one in front
			draw_texture_rect_region(SPRITES, Rect2(cx - 66, r.position.y + 42, 48, 48), art, tint.darkened(0.3))
		if n >= 3:
			draw_texture_rect_region(SPRITES, Rect2(cx + 18, r.position.y + 42, 48, 48), art, tint.darkened(0.3))
		draw_texture_rect_region(SPRITES, Rect2(cx - 34, r.position.y + 62, 68, 68), art, tint)
		var label := "%s: down" % e.name if dead else "%s (%d)" % [e.name, n]
		draw_string(font, Vector2(r.position.x + 4, r.position.y + 150), label, HORIZONTAL_ALIGNMENT_CENTER, r.size.x - 8, 13, Color.WHITE)
		_bar(Rect2(r.position.x + 12, r.position.y + 162, r.size.x - 24, 16), int(e.hp), int(e.maxHp), RED)
		if int(e.block) > 0:
			draw_string(font, Vector2(r.position.x + 12, r.position.y + 198), "Block %d" % int(e.block), HORIZONTAL_ALIGNMENT_LEFT, -1, 13, BLUE.lightened(0.3))
		draw_string(font, Vector2(r.position.x + 12, r.position.y + 216), _statuses(e.status), HORIZONTAL_ALIGNMENT_LEFT, r.size.x - 24, 12, GREEN)
		# Its reaction, and whether it's used it this round.
		var re = e.get("reaction")
		if re != null and not dead:
			var ready: bool = re.ready
			var colour := Color(1.0, 0.6, 0.3) if ready else Color(0.45, 0.45, 0.45)
			draw_string(font, Vector2(r.position.x + 12, r.position.y + 234), "Reacts: %s%s" % [re.name, "" if ready else " (used)"], HORIZONTAL_ALIGNMENT_LEFT, r.size.x - 24, 12, colour)
			draw_multiline_string(font, Vector2(r.position.x + 12, r.position.y + 248), str(re.text), HORIZONTAL_ALIGNMENT_LEFT, r.size.x - 24, 10, 2, colour.darkened(0.15))
		if int(e.id) == target and not dead:
			draw_string(font, Vector2(r.position.x, r.end.y + 14), "[C] its cards", HORIZONTAL_ALIGNMENT_CENTER, r.size.x, 11, Color(0.6, 0.6, 0.6))


func _draw_player(font: Font) -> void:
	var p: Dictionary = state.player
	var r := Rect2(24, 70, 200, PANEL_H)
	_box(r)
	draw_string(font, Vector2(r.position.x, r.position.y + 22), str(Net.welcome.get("name", "You")), HORIZONTAL_ALIGNMENT_CENTER, r.size.x, 16, YELLOW)
	draw_texture_rect_region(SPRITES, Rect2(r.get_center().x - 40, r.position.y + 40, 80, 80), AVATAR)
	_bar(Rect2(r.position.x + 12, r.position.y + 162, r.size.x - 24, 16), int(p.hp), int(p.maxHp), RED)
	if int(p.block) > 0:
		draw_string(font, Vector2(r.position.x + 12, r.position.y + 198), "Block %d" % int(p.block), HORIZONTAL_ALIGNMENT_LEFT, -1, 13, BLUE.lightened(0.3))
	draw_string(font, Vector2(r.position.x + 12, r.position.y + 218), _statuses(p.status), HORIZONTAL_ALIGNMENT_LEFT, r.size.x - 24, 12, GREEN)


## Your allies, in a row under you: who they are, attack/hit points, Guard.
func _draw_allies(font: Font) -> void:
	var allies: Array = state.get("allies", [])
	for i in allies.size():
		var a: Dictionary = allies[i]
		var r := Rect2(24 + i * 68, 70 + PANEL_H + 8, 64, 92)
		_box(r)
		var art := Rect2(int(ALLY_SPRITE.get(str(a.card), 0)) * 16, 0, 16, 16)
		draw_texture_rect_region(SPRITES, Rect2(r.position.x + 12, r.position.y + 4, 40, 40), art, ALLY_TINT.get(str(a.card), Color.WHITE))
		draw_string(font, Vector2(r.position.x, r.position.y + 56), str(a.name).get_slice(" ", 0), HORIZONTAL_ALIGNMENT_CENTER, r.size.x, 11, Color.WHITE)
		draw_string(font, Vector2(r.position.x, r.position.y + 70), "%d/%d" % [int(a.power), int(a.hp)], HORIZONTAL_ALIGNMENT_CENTER, r.size.x, 13, YELLOW)
		if bool(a.guard):
			draw_string(font, Vector2(r.position.x, r.position.y + 85), "Guard", HORIZONTAL_ALIGNMENT_CENTER, r.size.x, 10, BLUE.lightened(0.3))
		elif bool(a.sweep):
			draw_string(font, Vector2(r.position.x, r.position.y + 85), "Sweep", HORIZONTAL_ALIGNMENT_CENTER, r.size.x, 10, GREEN)


## The stack: what's about to happen, the top (first to happen) at the top.
## Yours in white, the zombies' in red; when the top is theirs and you can
## answer it, a prompt to play a Reaction or pass.
func _draw_stack(font: Font) -> void:
	var stack: Array = state.get("stack", [])
	if stack.is_empty():
		return
	var shown := mini(stack.size(), 5)
	var r := Rect2(size.x / 2 - 300, 70 + PANEL_H + 8, 600, 30 + shown * 26)
	_box(r)
	var title := "Answer with a Reaction, or Pass [Space]" if responding() else "The stack"
	draw_string(font, Vector2(r.position.x, r.position.y + 20), title, HORIZONTAL_ALIGNMENT_CENTER, r.size.x, 14, Color(0.4, 0.9, 1.0) if responding() else Color(0.7, 0.7, 0.7))
	for i in shown:
		var item: Dictionary = stack[stack.size() - 1 - i]
		var y := r.position.y + 32 + i * 26
		var mine: bool = item.by == "you"
		var colour := Color.WHITE if mine else Color(1, 0.45, 0.4)
		if i > 0:
			colour = colour.darkened(0.35)
		draw_rect(Rect2(r.position.x + 8, y, r.size.x - 16, 22), Color(0.15, 0.12, 0.08) if i == 0 else Color(0.08, 0.07, 0.05))
		draw_string(font, Vector2(r.position.x + 14, y + 16), str(item.name), HORIZONTAL_ALIGNMENT_LEFT, 200, 13, colour)
		draw_string(font, Vector2(r.position.x + 220, y + 16), str(item.text), HORIZONTAL_ALIGNMENT_LEFT, r.size.x - 236, 12, colour.darkened(0.1))


func _draw_log(font: Font) -> void:
	var lines: Array = state.get("log", [])
	var r := Rect2(size.x - 330, 70 + PANEL_H + 8, 316, 18 * 6 + 12)
	_box(r)
	var shown := lines.slice(maxi(0, lines.size() - 6))
	for i in shown.size():
		draw_string(font, Vector2(r.position.x + 8, r.position.y + 20 + i * 18), str(shown[i]), HORIZONTAL_ALIGNMENT_LEFT, r.size.x - 16, 12, Color(0.85, 0.85, 0.8) if i == shown.size() - 1 else Color(0.6, 0.6, 0.55))


func _statuses(s: Dictionary) -> String:
	var parts := PackedStringArray()
	for key: String in ["strength", "dexterity", "thorns", "weak", "vulnerable", "poison"]:
		if int(s.get(key, 0)) > 0:
			parts.append("%s %d" % [key.capitalize(), int(s[key])])
	return "  ".join(parts)


func _bar(r: Rect2, value: int, most: int, colour: Color) -> void:
	draw_rect(r, Color.BLACK)
	if most > 0:
		draw_rect(Rect2(r.position, Vector2(r.size.x * clampf(float(value) / most, 0, 1), r.size.y)), colour)
	draw_rect(r, Color(0.6, 0.6, 0.6), false, 1.0)
	draw_string(get_theme_default_font(), Vector2(r.position.x, r.position.y + 13), "%d / %d" % [value, most], HORIZONTAL_ALIGNMENT_CENTER, r.size.x, 12, Color.WHITE)


func _box(r: Rect2) -> void:
	draw_rect(r, PANEL)
	draw_rect(r, Color(0.67, 0.33, 0.0), false, 2.0)


func _button(font: Font, r: Rect2, text: String, colour: Color) -> void:
	var live := state.get("over") == null and not _waiting
	draw_rect(r, Color(0.12, 0.1, 0.05) if live else Color(0.06, 0.06, 0.06))
	draw_rect(r, colour if live else Color(0.4, 0.4, 0.4), false, 2.0)
	draw_string(font, Vector2(r.position.x, r.position.y + r.size.y / 2 + 6), text, HORIZONTAL_ALIGNMENT_CENTER, r.size.x, 15, colour if live else Color(0.4, 0.4, 0.4))
