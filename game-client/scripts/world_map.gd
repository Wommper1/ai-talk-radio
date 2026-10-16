extends Control

signal location_selected(location: Dictionary)

const MapLayout := preload("res://scripts/map_layout.gd")

const GOLD := Color("#e2b84f")
const INK := Color("#dce5dc")
const MUTED := Color("#8f9d92")
const ROAD := Color("#73806f")
const DANGER := Color("#b84c48")
const SAFE := Color("#4f9b72")

const KNOWN_POINTS := {
	"great hall": Vector2(0.50, 0.16),
	"brindlemark": Vector2(0.28, 0.35),
	"wildlands": Vector2(0.48, 0.49),
	"dark forest": Vector2(0.72, 0.34),
	"greyditch": Vector2(0.79, 0.68),
	"sunken ford": Vector2(0.20, 0.66),
}

# Real-coordinate layout: how close two places may sit before they are nudged apart.
const MIN_DOT_SPACING := 24.0
const LABEL_FONT_SIZE := 14
const LEADER_DISTANCE := 20.0
const CAPTION := "North is up. Positions are real; crowded places are nudged apart."

var locations: Array = []
var points: Dictionary = {}
var selected_id := ""
var player_location := ""

# Set when every place has real coordinates: kilometres from the group's centre, by id.
var geo_km: Dictionary = {}
# Canvas positions for geo_km at the current size, spread where places crowd.
var canvas_points: Dictionary = {}
var layout_inner_size := Vector2.ZERO


func _ready() -> void:
	mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	resized.connect(_on_resized)


func _on_resized() -> void:
	layout_inner_size = Vector2.ZERO
	queue_redraw()


func set_world(next_locations: Array, next_player_location: String) -> void:
	locations = next_locations
	player_location = next_player_location
	points.clear()

	for index in range(locations.size()):
		var location: Dictionary = locations[index]
		var location_id := String(location.get("id", index))
		points[location_id] = _point_for(location, index)

	geo_km = MapLayout.project(locations)
	layout_inner_size = Vector2.ZERO
	_set_art_visible(geo_km.is_empty())

	if selected_id.is_empty() and not locations.is_empty():
		selected_id = String(locations[0].get("id", ""))
	queue_redraw()


func is_geographic() -> bool:
	return not geo_km.is_empty()


# The painted fantasy backdrop would sit behind real places and mislead; hide it for them.
func _set_art_visible(is_visible: bool) -> void:
	var parent := get_parent()
	if parent == null:
		return
	var art := parent.get_node_or_null("Texture")
	if art != null:
		art.visible = is_visible


func _inner_rect() -> Rect2:
	return Rect2(Vector2(34, 30), size - Vector2(68, 62))


func _ensure_layout(inner: Rect2) -> void:
	if geo_km.is_empty() or inner.size == layout_inner_size:
		return
	layout_inner_size = inner.size
	var fitted := MapLayout.fit(geo_km, inner, 16.0)
	canvas_points = MapLayout.spread(fitted, MIN_DOT_SPACING, inner)


func _canvas_point(location_id: String, inner: Rect2) -> Vector2:
	if not geo_km.is_empty():
		_ensure_layout(inner)
		return canvas_points.get(location_id, inner.get_center())
	return _to_canvas(points[location_id], inner)


func _lore_of(location: Dictionary) -> Dictionary:
	var lore_value = location.get("lore", null)
	return lore_value if typeof(lore_value) == TYPE_DICTIONARY else {}


func _do_not_visit(location: Dictionary) -> bool:
	return bool(_lore_of(location).get("doNotVisit", false))


func _draw() -> void:
	var inner := _inner_rect()
	if inner.size.x <= 0 or inner.size.y <= 0:
		return

	for location_value in locations:
		var location: Dictionary = location_value
		var start_id := String(location.get("id", ""))
		if not points.has(start_id):
			continue
		for linked_name_value in location.get("connectedTo", []):
			var linked := _find_by_name(String(linked_name_value))
			if linked.is_empty():
				continue
			var end_id := String(linked.get("id", ""))
			if points.has(end_id):
				draw_dashed_line(_canvas_point(start_id, inner), _canvas_point(end_id, inner), ROAD, 2.0, 8.0)

	var geographic := is_geographic()
	for location_value in locations:
		var location: Dictionary = location_value
		var location_id := String(location.get("id", ""))
		if not points.has(location_id):
			continue
		var point := _canvas_point(location_id, inner)
		var is_selected := location_id == selected_id
		var is_player_here := _name_key(String(location.get("name", ""))) == _name_key(player_location)
		var color := SAFE if not _looks_dangerous(location) else DANGER

		if is_selected:
			var glow := GOLD
			glow.a = 0.24
			draw_circle(point, 19.0, glow)
		draw_circle(point, 9.0 if is_player_here else 7.0, GOLD if is_player_here else color)
		draw_circle(point, 9.0 if is_player_here else 7.0, INK, false, 1.5)
		if is_player_here:
			draw_arc(point, 14.0, 0.0, TAU, 28, GOLD, 2.0)
		if _do_not_visit(location):
			# The real site is unsafe or closed to visitors; the ring says so before anyone reads a word.
			draw_arc(point, 11.5, 0.0, TAU, 28, DANGER, 2.0)

		if not geographic:
			draw_string(ThemeDB.fallback_font, point + Vector2(13, 5), String(location.get("name", "Unknown")), HORIZONTAL_ALIGNMENT_LEFT, -1, LABEL_FONT_SIZE, INK)

	if geographic:
		_draw_geographic_labels(_label_items(inner))

	if locations.is_empty():
		draw_string(ThemeDB.fallback_font, inner.get_center(), "Waiting for realm data", HORIZONTAL_ALIGNMENT_CENTER, 260, 16, MUTED)


# One entry per place for the label placer. The player's place, the selected place and any place
# that is unsafe to visit are always named, so they are first in line for a good spot.
func _label_items(inner: Rect2) -> Array:
	var items: Array = []
	for location_value in locations:
		var location: Dictionary = location_value
		var location_id := String(location.get("id", ""))
		if not points.has(location_id):
			continue
		var is_player_here := _name_key(String(location.get("name", ""))) == _name_key(player_location)
		items.append({
			"id": location_id,
			"point": _canvas_point(location_id, inner),
			"text": String(location.get("name", "Unknown")),
			"force": is_player_here or location_id == selected_id or _do_not_visit(location),
		})
	return items


func _draw_geographic_labels(label_items: Array) -> void:
	# The player's place and the selected place are labelled first, so they get the best spots.
	var ordered: Array = []
	for item in label_items:
		if bool(item["force"]):
			ordered.append(item)
	for item in label_items:
		if not bool(item["force"]):
			ordered.append(item)
	var bounds := Rect2(Vector2(4, 4), size - Vector2(8, 8))
	var font := ThemeDB.fallback_font
	var caption_rect := Rect2(Vector2(10, size.y - 24), Vector2(font.get_string_size(CAPTION, HORIZONTAL_ALIGNMENT_LEFT, -1, 11).x + 8, 18))
	# Dots wear rings of up to 14 px, so labels keep that far clear.
	var rects := MapLayout.place_labels(ordered, font, LABEL_FONT_SIZE, bounds, 14.0, [caption_rect])
	for item in ordered:
		var rect = rects.get(item["id"], null)
		if rect == null:
			continue
		var dot: Vector2 = item["point"]
		var anchor := MapLayout.nearest_point_on(rect, dot)
		if dot.distance_to(anchor) > LEADER_DISTANCE:
			# The label had to go some way off; a thin line says which dot it belongs to.
			draw_line(dot + (anchor - dot).normalized() * 12.0, anchor, Color(INK, 0.45), 1.0)
		draw_string(font, Vector2(rect.position.x, rect.position.y + font.get_ascent(LABEL_FONT_SIZE)), String(item["text"]),
			HORIZONTAL_ALIGNMENT_LEFT, -1, LABEL_FONT_SIZE, INK)
	draw_string(font, Vector2(14, size.y - 10), CAPTION, HORIZONTAL_ALIGNMENT_LEFT, -1, 11, MUTED)


func _gui_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
		var nearest := _nearest_location(event.position)
		if not nearest.is_empty():
			selected_id = String(nearest.get("id", ""))
			location_selected.emit(nearest)
			queue_redraw()
	elif event is InputEventMouseMotion:
		# Crowded places may have no room for a label, so every place can be named by hovering.
		tooltip_text = _tooltip_for(_nearest_location(event.position))


func _tooltip_for(location: Dictionary) -> String:
	if location.is_empty():
		return ""
	var text := String(location.get("name", ""))
	if _do_not_visit(location):
		text += " (do not visit in person)"
	return text


func _nearest_location(mouse_position: Vector2) -> Dictionary:
	var inner := _inner_rect()
	var best: Dictionary = {}
	var best_distance := 24.0
	for location_value in locations:
		var location: Dictionary = location_value
		var location_id := String(location.get("id", ""))
		if not points.has(location_id):
			continue
		var distance := mouse_position.distance_to(_canvas_point(location_id, inner))
		if distance < best_distance:
			best_distance = distance
			best = location
	return best


func _point_for(location: Dictionary, index: int) -> Vector2:
	var name_key := _name_key(String(location.get("name", "")))
	if KNOWN_POINTS.has(name_key):
		return KNOWN_POINTS[name_key]

	var count: int = maxi(locations.size(), 1)
	var angle := -PI / 2.0 + TAU * float(index) / float(count)
	return Vector2(0.5, 0.5) + Vector2(cos(angle), sin(angle)) * 0.33


func _to_canvas(normalized: Vector2, inner: Rect2) -> Vector2:
	return inner.position + normalized * inner.size


func _find_by_name(name: String) -> Dictionary:
	for location_value in locations:
		var location: Dictionary = location_value
		if _name_key(String(location.get("name", ""))) == _name_key(name):
			return location
	return {}


func _name_key(name: String) -> String:
	var key := name.to_lower().strip_edges()
	if key.begins_with("the "):
		key = key.trim_prefix("the ")
	return key


func _looks_dangerous(location: Dictionary) -> bool:
	var text := (String(location.get("type", "")) + " " + String(location.get("description", ""))).to_lower()
	return "danger" in text or "dark" in text or "wild" in text or "hostile" in text
