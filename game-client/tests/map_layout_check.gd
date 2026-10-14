extends SceneTree
## Headless checks for the real-coordinate map: projection, fitting, spreading, labels, and
## the map control's use of them. Run with `npm run client-selftest`.

const MapLayout := preload("res://scripts/map_layout.gd")

var failures := 0


func check(label: String, condition: bool) -> void:
	print("[%s] %s" % ["  ok  " if condition else " FAIL ", label])
	if not condition:
		failures += 1


func place(id: String, latitude: float, longitude: float) -> Dictionary:
	return {"id": id, "name": id.capitalize(), "connectedTo": [], "lore": {"latitude": latitude, "longitude": longitude, "doNotVisit": false}}


func min_pair_distance(positions: Dictionary) -> float:
	var best := INF
	var ids := positions.keys()
	for i in range(ids.size()):
		for j in range(i + 1, ids.size()):
			best = minf(best, (positions[ids[i]] as Vector2).distance_to(positions[ids[j]]))
	return best


func _init() -> void:
	# ---- coordinates_of
	check("coordinates are read from lore as (longitude, latitude)", MapLayout.coordinates_of(place("a", 38.5, -85.5)) == Vector2(-85.5, 38.5))
	check("no lore means no coordinates", MapLayout.coordinates_of({"id": "a", "lore": null}) == null and MapLayout.coordinates_of({}) == null)
	check("null or text coordinates are refused", MapLayout.coordinates_of({"lore": {"latitude": null, "longitude": -85.0}}) == null and MapLayout.coordinates_of({"lore": {"latitude": "38", "longitude": -85.0}}) == null)
	check("out-of-range coordinates are refused", MapLayout.coordinates_of(place("a", 91.0, 0.0)) == null and MapLayout.coordinates_of(place("a", 0.0, 181.0)) == null)

	# ---- project
	var pair := MapLayout.project([place("south_west", 38.0, -86.0), place("north_east", 39.0, -85.0)])
	var south_west: Vector2 = pair["south_west"]
	var north_east: Vector2 = pair["north_east"]
	check("north is positive and east is positive", north_east.y > south_west.y and north_east.x > south_west.x)
	check("one degree of latitude is about 110.6 km", absf((north_east.y - south_west.y) - 110.57) < 0.05)
	check("one degree of longitude is shorter at this latitude (about 87 km)", absf((north_east.x - south_west.x) - 111.32 * cos(deg_to_rad(38.5))) < 0.05)
	check("the centre of the group is the origin", ((south_west + north_east) * 0.5).length() < 0.001)
	check("a single place is not a map", MapLayout.project([place("a", 38.0, -85.0)]).is_empty())
	check("one place without coordinates keeps the old layout", MapLayout.project([place("a", 38.0, -85.0), place("b", 38.1, -85.1), {"id": "c", "lore": null}]).is_empty())
	check("duplicate ids keep the old layout", MapLayout.project([place("a", 38.0, -85.0), place("a", 38.1, -85.1)]).is_empty())
	check("a malformed entry keeps the old layout", MapLayout.project([place("a", 38.0, -85.0), 7]).is_empty())
	check("no places is safe", MapLayout.project([]).is_empty())

	# ---- fit
	var inner := Rect2(Vector2(34, 30), Vector2(740, 288))
	var km := {"w": Vector2(-8.0, 0.0), "e": Vector2(8.0, 2.0), "n": Vector2(0.0, 5.0), "s": Vector2(1.0, -5.0)}
	var fitted := MapLayout.fit(km, inner, 16.0)
	var inside := true
	for id in fitted:
		var p: Vector2 = fitted[id]
		inside = inside and inner.grow(-16.0 + 0.01).has_point(p)
	check("every place lands inside the area, clear of the margin", inside)
	var px_per_km_x: float = ((fitted["e"] as Vector2).x - (fitted["w"] as Vector2).x) / 16.0
	var px_per_km_y: float = ((fitted["n"] as Vector2).y - (fitted["s"] as Vector2).y) / -10.0
	check("both axes share one scale, so proportions are true", absf(px_per_km_x - px_per_km_y) < 0.0001)
	check("north is up on the canvas", (fitted["n"] as Vector2).y < (fitted["s"] as Vector2).y)
	var tall := MapLayout.fit({"a": Vector2(0, 0), "b": Vector2(0, 10)}, inner, 16.0)
	check("a narrow arrangement is centred", absf((tall["a"] as Vector2).x - inner.get_center().x) < 0.01)
	var same := MapLayout.fit({"a": Vector2(3, 3), "b": Vector2(3, 3)}, inner, 16.0)
	check("two places on one spot do not break fitting", (same["a"] as Vector2) == (same["b"] as Vector2) and inner.has_point(same["a"]))
	check("fitting nothing is safe", MapLayout.fit({}, inner, 16.0).is_empty())
	check("an area smaller than its margins still fits", not MapLayout.fit(km, Rect2(Vector2.ZERO, Vector2(20, 20)), 16.0).is_empty())

	# ---- spread: a downtown-like cluster of five within a couple of hundred metres, plus far places
	var bounds := inner
	var cluster := MapLayout.project([
		place("a", 38.2850, -85.8200), place("b", 38.2851, -85.8203), place("c", 38.2855, -85.8199),
		place("d", 38.2848, -85.8195), place("e", 38.2852, -85.8201),
		place("far_ne", 38.3600, -85.7000), place("far_sw", 38.2200, -85.9000), place("far_nw", 38.3315, -85.8755),
	])
	var crowded := MapLayout.fit(cluster, bounds, 16.0)
	check("the cluster really is crowded before spreading", min_pair_distance(crowded) < 6.0)
	var spread := MapLayout.spread(crowded, 24.0, bounds)
	check("after spreading, no two places are closer than the minimum", min_pair_distance(spread) >= 23.9)
	var within := true
	var drift := 0.0
	for id in spread:
		within = within and bounds.has_point(spread[id])
		drift = maxf(drift, (spread[id] as Vector2).distance_to(crowded[id]))
	check("spread places stay inside the area", within)
	check("no place is moved far from its true position (%.0f px)" % drift, drift < 70.0)
	check("spreading is deterministic", MapLayout.spread(crowded, 24.0, bounds) == spread)
	check("places already apart are not moved", MapLayout.spread({"x": Vector2(100, 100), "y": Vector2(300, 200)}, 24.0, bounds) == {"x": Vector2(100, 100), "y": Vector2(300, 200)})
	var stacked := MapLayout.spread({"x": Vector2(200, 100), "y": Vector2(200, 100), "z": Vector2(200, 100)}, 24.0, bounds)
	check("places on the very same spot are separated", min_pair_distance(stacked) >= 23.9)
	var corner := MapLayout.spread({"x": bounds.position, "y": bounds.position + Vector2(1, 1)}, 24.0, bounds)
	check("places crowded into a corner are separated and kept inside", min_pair_distance(corner) >= 23.9 and bounds.has_point(corner["x"]) and bounds.has_point(corner["y"]))

	# ---- labels
	var font := ThemeDB.fallback_font
	var label_bounds := Rect2(Vector2(4, 4), Vector2(800, 330))
	var items: Array = []
	for id in spread:
		items.append({"id": id, "point": spread[id], "text": "Place " + String(id), "force": false})
	var rects := MapLayout.place_labels(items, font, 14, label_bounds)
	var clean := true
	var all_in := true
	var ids := rects.keys()
	for i in range(ids.size()):
		all_in = all_in and label_bounds.encloses(rects[ids[i]])
		for j in range(i + 1, ids.size()):
			clean = clean and not (rects[ids[i]] as Rect2).intersects(rects[ids[j]])
		for item in items:
			if item["id"] != ids[i]:
				clean = clean and not (rects[ids[i]] as Rect2).intersects(Rect2((item["point"] as Vector2) - Vector2(9, 9), Vector2(18, 18)))
	check("no label overlaps another label or another place's dot", clean)
	check("every label is inside the map", all_in)
	check("most places in the cluster still get a label (%d of %d)" % [rects.size(), items.size()], rects.size() >= 6)
	var alone := MapLayout.place_labels([{"id": "solo", "point": Vector2(200, 100), "text": "Alone", "force": false}], font, 14, label_bounds)
	check("a place with room puts its label to the right of the dot", alone.has("solo") and (alone["solo"] as Rect2).position.x > 200.0)
	var jam: Array = []
	for index in range(40):
		jam.append({"id": "j%d" % index, "point": Vector2(300, 150) + Vector2(index, index) * 0.2, "text": "Jam number %d" % index, "force": index == 5})
	var jammed := MapLayout.place_labels(jam, font, 14, label_bounds)
	check("a forced place always gets a label, even in a jam", jammed.has("j5"))
	check("unforced places in a jam may go unlabelled rather than overlap", jammed.size() < jam.size())
	var unforced_overlap := false
	var jam_ids := jammed.keys()
	for i in range(jam_ids.size()):
		for j in range(i + 1, jam_ids.size()):
			if jam_ids[i] != "j5" and jam_ids[j] != "j5" and (jammed[jam_ids[i]] as Rect2).intersects(jammed[jam_ids[j]]):
				unforced_overlap = true
	check("the labels that are placed in a jam still do not overlap each other", not unforced_overlap)
	var edge := MapLayout.place_labels([{"id": "edge", "point": Vector2(796, 150), "text": "Right at the edge", "force": false}], font, 14, label_bounds)
	check("a label near the edge flips to the other side", edge.has("edge") and label_bounds.encloses(edge["edge"]) and (edge["edge"] as Rect2).position.x < 796.0)

	# ---- the map control
	var map = load("res://scripts/world_map.gd").new()
	map.size = Vector2(805, 350)
	var geo_places: Array = []
	for id in cluster:
		var base := place(String(id), 0.0, 0.0)
		var source: Array = {"a": [38.2850, -85.8200], "b": [38.2851, -85.8203], "c": [38.2855, -85.8199], "d": [38.2848, -85.8195],
			"e": [38.2852, -85.8201], "far_ne": [38.3600, -85.7000], "far_sw": [38.2200, -85.9000], "far_nw": [38.3315, -85.8755]}[id]
		base["lore"] = {"latitude": source[0], "longitude": source[1], "doNotVisit": id == "far_sw"}
		geo_places.append(base)
	map.set_world(geo_places, "A")
	var map_inner: Rect2 = map._inner_rect()
	var map_points := {}
	for entry in geo_places:
		map_points[entry["id"]] = map._canvas_point(entry["id"], map_inner)
	check("a world of real places uses the real-coordinate layout", map.is_geographic())
	check("on the control, every place is inside the drawing area", map_points.values().all(func(p): return map_inner.has_point(p)))
	check("on the control, no two places are closer than the spacing", min_pair_distance(map_points) >= 23.9)
	check("clicking a dot picks that place, even in the cluster", geo_places.all(func(entry): return map._nearest_location(map_points[entry["id"]])["id"] == entry["id"]))
	check("hovering a dot names the place", map._tooltip_for(geo_places[0]) == "A")
	check("a do-not-visit place says so in its tooltip", String(map._tooltip_for(geo_places[6])).ends_with("(do not visit in person)"))
	check("hovering empty ground names nothing", map._tooltip_for({}) == "" and map._nearest_location(Vector2(2, 2)).is_empty())
	map.size = Vector2(600, 300)
	map._ensure_layout(map._inner_rect())
	var resized_ok := true
	for entry in geo_places:
		resized_ok = resized_ok and map._inner_rect().has_point(map._canvas_point(entry["id"], map._inner_rect()))
	check("after the control is resized the layout is recomputed to fit", resized_ok)

	var legacy_places := [
		{"id": "g", "name": "Brindlemark", "connectedTo": [], "lore": null},
		{"id": "h", "name": "The Wildlands", "connectedTo": [], "lore": null},
	]
	map.set_world(legacy_places, "Brindlemark")
	check("a world without coordinates keeps the old layout", not map.is_geographic())
	check("the old layout still uses the known points", map._canvas_point("g", map._inner_rect()) == map._to_canvas(Vector2(0.28, 0.35), map._inner_rect()))
	var mixed := geo_places.duplicate()
	mixed.append({"id": "keep", "name": "The Keep", "connectedTo": [], "lore": null})
	map.set_world(mixed, "A")
	check("a mix of real and invented places keeps the old layout", not map.is_geographic())

	var holder := Control.new()
	var art := Control.new()
	art.name = "Texture"
	holder.add_child(art)
	var framed = load("res://scripts/world_map.gd").new()
	holder.add_child(framed)
	framed.set_world(geo_places, "A")
	check("the painted fantasy backdrop is hidden behind real places", not art.visible)
	framed.set_world(legacy_places, "Brindlemark")
	check("and comes back for an invented world", art.visible)
	holder.free()

	# ---- label placement, second pass: reserved space, least-overlap fallback, who is always named
	var caption := Rect2(Vector2(410, 140), Vector2(120, 22))
	var beside := MapLayout.place_labels([{"id": "p", "point": Vector2(400, 150), "text": "Beside", "force": false}], font, 14, label_bounds, 14.0, [caption])
	check("a label keeps clear of reserved space", beside.has("p") and not (beside["p"] as Rect2).intersects(caption))
	var near_blocked := Rect2(Vector2(340, 110), Vector2(120, 80))
	var farther := MapLayout.place_labels([{"id": "f", "point": Vector2(400, 150), "text": "Farther", "force": false}], font, 14, label_bounds, 14.0, [near_blocked])
	check("when the near spots are taken a label goes farther out", farther.has("f") and not (farther["f"] as Rect2).intersects(near_blocked) and Vector2(400, 150).distance_to(MapLayout.nearest_point_on(farther["f"], Vector2(400, 150))) > 30.0)
	check("a leader line would end on the label's edge nearest the dot", MapLayout.nearest_point_on(Rect2(Vector2(10, 10), Vector2(20, 10)), Vector2(0, 0)) == Vector2(10, 10) and MapLayout.nearest_point_on(Rect2(Vector2(10, 10), Vector2(20, 10)), Vector2(15, 50)) == Vector2(15, 20))
	var smothered := Rect2(Vector2.ZERO, Vector2(810, 340))
	var starved := MapLayout.place_labels([{"id": "q", "point": Vector2(400, 150), "text": "Starved", "force": false}], font, 14, label_bounds, 14.0, [smothered])
	check("an unforced place with no free spot goes unlabelled", starved.is_empty())
	var forced := MapLayout.place_labels([{"id": "r", "point": Vector2(400, 150), "text": "Forced", "force": true}], font, 14, label_bounds, 14.0, [smothered])
	check("a forced place with no free spot still gets a label, inside the map", forced.has("r") and label_bounds.encloses(forced["r"]))
	var half_covered := Rect2(Vector2(380, 100), Vector2(300, 110))
	var partly := MapLayout.place_labels([{"id": "s", "point": Vector2(400, 150), "text": "Partly", "force": true}], font, 14, label_bounds, 14.0, [half_covered])
	check("with a free spot farther out, a forced place takes it rather than overlapping", partly.has("s") and (partly["s"] as Rect2).intersection(half_covered).get_area() == 0.0)

	var geo_check_map = load("res://scripts/world_map.gd").new()
	geo_check_map.size = Vector2(805, 350)
	geo_check_map.set_world(geo_places, "A")
	var label_inner: Rect2 = geo_check_map._inner_rect()
	var entries: Array = geo_check_map._label_items(label_inner)
	var forced_by_id := {}
	for entry in entries:
		forced_by_id[entry["id"]] = entry["force"]
	check("the player's place is always named", forced_by_id["a"] == true)
	check("a place that is unsafe to visit is always named", forced_by_id["far_sw"] == true)
	check("an ordinary place is not forced", forced_by_id["b"] == false and forced_by_id["far_ne"] == false)
	var drawn := MapLayout.place_labels(entries, font, 14, Rect2(Vector2(4, 4), Vector2(797, 342)), 14.0, [])
	check("the unsafe place gets a label in the real layout", drawn.has("far_sw"))
	geo_check_map.free()
	map.free()

	print("failures: ", failures)
	quit(1 if failures > 0 else 0)
