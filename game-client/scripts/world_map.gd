extends Control

signal location_selected(location: Dictionary)

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

var locations: Array = []
var points: Dictionary = {}
var selected_id := ""
var player_location := ""


func _ready() -> void:
	mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	resized.connect(queue_redraw)


func set_world(next_locations: Array, next_player_location: String) -> void:
	locations = next_locations
	player_location = next_player_location
	points.clear()

	for index in range(locations.size()):
		var location: Dictionary = locations[index]
		var location_id := String(location.get("id", index))
		points[location_id] = _point_for(location, index)

	if selected_id.is_empty() and not locations.is_empty():
		selected_id = String(locations[0].get("id", ""))
	queue_redraw()


func _draw() -> void:
	var inner := Rect2(Vector2(34, 30), size - Vector2(68, 62))
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
				draw_dashed_line(_to_canvas(points[start_id], inner), _to_canvas(points[end_id], inner), ROAD, 2.0, 8.0)

	for location_value in locations:
		var location: Dictionary = location_value
		var location_id := String(location.get("id", ""))
		if not points.has(location_id):
			continue
		var point := _to_canvas(points[location_id], inner)
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

		var label := String(location.get("name", "Unknown"))
		var label_position := point + Vector2(13, 5)
		draw_string(ThemeDB.fallback_font, label_position, label, HORIZONTAL_ALIGNMENT_LEFT, -1, 14, INK)

	if locations.is_empty():
		draw_string(ThemeDB.fallback_font, inner.get_center(), "Waiting for realm data", HORIZONTAL_ALIGNMENT_CENTER, 260, 16, MUTED)


func _gui_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
		var nearest := _nearest_location(event.position)
		if not nearest.is_empty():
			selected_id = String(nearest.get("id", ""))
			location_selected.emit(nearest)
			queue_redraw()


func _nearest_location(mouse_position: Vector2) -> Dictionary:
	var inner := Rect2(Vector2(34, 30), size - Vector2(68, 62))
	var best: Dictionary = {}
	var best_distance := 24.0
	for location_value in locations:
		var location: Dictionary = location_value
		var location_id := String(location.get("id", ""))
		if not points.has(location_id):
			continue
		var distance := mouse_position.distance_to(_to_canvas(points[location_id], inner))
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
