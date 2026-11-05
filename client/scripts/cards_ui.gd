class_name CardsUI
extends Control
## Card screens over the map: your inventory (I), a shopkeeper's shop (talk
## to them), and a choice of cards (a level-up or loot after a fight).
##
## Inventory: every card you own, in your deck or set aside in your pack;
## click one to move it between the two (the server keeps the deck between
## its minimum and maximum size). Shop: tabs to buy (or learn), sell, and
## upgrade (or train). Offer: pick one of the cards, or skip. Every change
## goes to the server, which answers with fresh "cards" and "shop" messages.

const PANEL_SIZE := Vector2(1120, 640)
const ORANGE := Color(0.67, 0.33, 0.0)
const YELLOW := Color(1.0, 1.0, 0.33)
const COLUMNS := 7

var mode := "" ## "inventory", "shop", "offer", or "" when closed
var cards_info: Dictionary = {} ## the latest "cards" message
var shop: Dictionary = {} ## the shop being browsed
var offer: Dictionary = {} ## the card choice on screen
var shop_tab := "buy"

var _panel: PanelContainer
var _title: Label
var _sub: Label
var _tabs: HBoxContainer
var _body: VBoxContainer
var _hint: Label


func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	visible = false
	var shade := ColorRect.new()
	shade.color = Color(0, 0, 0, 0.6)
	shade.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(shade)
	_panel = PanelContainer.new()
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.04, 0.03, 0.03, 0.97)
	style.border_color = ORANGE
	style.set_border_width_all(2)
	style.set_content_margin_all(14)
	_panel.add_theme_stylebox_override("panel", style)
	_panel.custom_minimum_size = PANEL_SIZE
	_panel.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	_panel.position = -PANEL_SIZE / 2
	add_child(_panel)
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 8)
	_panel.add_child(v)
	_title = Label.new()
	_title.add_theme_font_size_override("font_size", 22)
	_title.add_theme_color_override("font_color", YELLOW)
	v.add_child(_title)
	_sub = Label.new()
	v.add_child(_sub)
	_tabs = HBoxContainer.new()
	v.add_child(_tabs)
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	v.add_child(scroll)
	_body = VBoxContainer.new()
	_body.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(_body)
	_hint = Label.new()
	_hint.add_theme_color_override("font_color", Color(0.6, 0.6, 0.6))
	v.add_child(_hint)


func is_open() -> bool:
	return visible


func close() -> void:
	if mode == "offer":
		return # A choice has to be made (or skipped).
	mode = ""
	visible = false


func open_inventory() -> void:
	mode = "inventory"
	_render()


func open_shop(msg: Dictionary) -> void:
	if mode != "shop" or int(shop.get("npc", -1)) != int(msg.npc):
		shop_tab = "buy" if not msg.stock.is_empty() else "upgrade"
	shop = msg
	mode = "shop"
	_render()


func show_offer(msg: Dictionary) -> void:
	offer = msg
	mode = "offer"
	_render()


## Fresh card data from the server: redraw whatever's open.
func on_cards(msg: Dictionary) -> void:
	cards_info = msg
	if mode == "inventory":
		_render()


func on_shop(msg: Dictionary) -> void:
	if mode == "shop":
		open_shop(msg)


func _unhandled_input(event: InputEvent) -> void:
	if visible and event.is_action_pressed(&"ui_cancel"):
		close()
		get_viewport().set_input_as_handled()


# ---- drawing the screens ----

func _render() -> void:
	visible = mode != ""
	for c in _tabs.get_children():
		c.queue_free()
	for c in _body.get_children():
		c.queue_free()
	match mode:
		"inventory": _render_inventory()
		"shop": _render_shop()
		"offer": _render_offer()


func _render_inventory() -> void:
	var cards: Array = cards_info.get("cards", [])
	var deck := cards.filter(func(c: Dictionary) -> bool: return bool(c.deck))
	var pack := cards.filter(func(c: Dictionary) -> bool: return not bool(c.deck))
	_title.text = "Your Cards"
	_sub.text = "Scrap: %d      Deck: %d cards (%d-%d)      Pack: %d" % [int(cards_info.get("scrap", 0)), deck.size(), int(cards_info.get("deckMin", 8)), int(cards_info.get("deckMax", 30)), pack.size()]
	_hint.text = "Click a card to move it between your deck and your pack.   [I] or [Esc] close"
	_section("In your deck", deck, func(c: Dictionary) -> void: Net.send({"t": "deck_set", "uid": int(c.uid), "deck": false}), func(_c: Dictionary) -> String: return "")
	_section("In your pack (not fought with)", pack, func(c: Dictionary) -> void: Net.send({"t": "deck_set", "uid": int(c.uid), "deck": true}), func(_c: Dictionary) -> String: return "")


func _render_shop() -> void:
	var scrap := int(cards_info.get("scrap", 0))
	_title.text = "%s - %s" % [shop.name, shop.title]
	_sub.text = "Scrap: %d" % scrap
	_hint.text = "[Esc] close"
	var tabs := []
	if not shop.stock.is_empty():
		tabs.append(["buy", str(shop.buyLabel)])
	tabs.append(["sell", "Sell"])
	if not shop.upgrade.is_empty() or shop.stock.is_empty():
		tabs.append(["upgrade", str(shop.upgradeLabel)])
	for t: Array in tabs:
		var b := Button.new()
		b.text = t[1]
		b.toggle_mode = true
		b.button_pressed = shop_tab == t[0]
		b.custom_minimum_size = Vector2(120, 30)
		b.pressed.connect(func() -> void: shop_tab = t[0]; _render())
		_tabs.add_child(b)
	var npc := int(shop.npc)
	match shop_tab:
		"buy":
			var stock: Array = shop.stock
			var grid := _grid()
			for i in stock.size():
				var c: Dictionary = stock[i]
				var price := int(c.price)
				_cell(grid, c, "%s - %d scrap" % [shop.buyLabel, price], price <= scrap, func() -> void: Net.send({"t": "shop_buy", "npc": npc, "index": i}))
		"sell":
			var prices := {}
			for s: Dictionary in shop.sell:
				prices[int(s.uid)] = int(s.price)
			var grid := _grid()
			for c: Dictionary in cards_info.get("cards", []):
				var price: int = prices.get(int(c.uid), 0)
				_cell(grid, c, "Sell - %d scrap%s" % [price, " (deck)" if bool(c.deck) else ""], true, func() -> void: Net.send({"t": "shop_sell", "npc": npc, "uid": int(c.uid)}))
		"upgrade":
			if shop.upgrade.is_empty():
				_body.add_child(_label("Nothing of yours they can work on."))
			var grid := _grid()
			for u: Dictionary in shop.upgrade:
				var price := int(u.price)
				_cell(grid, u.next, "%s - %d scrap" % [shop.upgradeLabel, price], price <= scrap, func() -> void: Net.send({"t": "shop_upgrade", "npc": npc, "uid": int(u.uid)}))


func _render_offer() -> void:
	_title.text = "Level up! Learn an ability" if offer.reason == "level" else "Spoils of the fight"
	_sub.text = "Take one card for your collection, or skip."
	_hint.text = ""
	var grid := _grid()
	var cards: Array = offer.cards
	for i in cards.size():
		_cell(grid, cards[i], "Take it", true, func() -> void: _pick(i))
	var skip := Button.new()
	skip.text = "Skip"
	skip.custom_minimum_size = Vector2(140, 32)
	skip.pressed.connect(func() -> void: _pick(-1))
	_body.add_child(skip)


## Take card `i` of the offer (-1: none). The server sends the next offer, if there is one.
func pick(i: int) -> void:
	_pick(i)


func _pick(i: int) -> void:
	Net.send({"t": "offer_pick", "index": i})
	offer = {}
	mode = ""
	visible = false


# ---- pieces ----

func _section(heading: String, cards: Array, on_click: Callable, _note: Callable) -> void:
	_body.add_child(_label("%s (%d)" % [heading, cards.size()]))
	var grid := _grid()
	for c: Dictionary in cards:
		var view := CardView.new(c)
		view.pressed.connect(on_click.bind(c))
		grid.add_child(view)


func _grid() -> GridContainer:
	var grid := GridContainer.new()
	grid.columns = COLUMNS
	grid.add_theme_constant_override("h_separation", 12)
	grid.add_theme_constant_override("v_separation", 12)
	_body.add_child(grid)
	return grid


## A card with a button under it.
func _cell(grid: GridContainer, card: Dictionary, label: String, enabled: bool, action: Callable) -> void:
	var box := VBoxContainer.new()
	var view := CardView.new(card)
	view.playable = enabled
	view.pressed.connect(func() -> void: if enabled: action.call())
	box.add_child(view)
	var b := Button.new()
	b.text = label
	b.disabled = not enabled
	b.custom_minimum_size = Vector2(CardView.SIZE.x, 28)
	b.add_theme_font_size_override("font_size", 11)
	b.pressed.connect(action)
	box.add_child(b)
	grid.add_child(box)


func _label(text: String) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_color_override("font_color", YELLOW)
	return l
