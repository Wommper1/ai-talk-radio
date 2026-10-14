extends RefCounted
## Real-coordinate layout for the world map.
##
## Places that come from a lore pack carry a latitude and longitude. This turns them
## into canvas positions: projected with true proportions and north up, fitted to the
## map's area, nudged apart only where they crowd (so each stays clickable), and given
## labels that do not overlap. Pure functions: nothing here touches the scene tree.

const KM_PER_DEGREE_LATITUDE := 110.57
const KM_PER_DEGREE_LONGITUDE_AT_EQUATOR := 111.32

# Label placement tries this many rings of spots around a dot, each RING_STEP pixels farther out.
const RINGS := 3
const RING_STEP := 34.0


## (longitude, latitude) of a location from a snapshot, or null if it has no usable coordinates.
static func coordinates_of(location: Dictionary) -> Variant:
	var lore_value = location.get("lore", null)
	if typeof(lore_value) != TYPE_DICTIONARY:
		return null
	var lat_value = lore_value.get("latitude", null)
	var lon_value = lore_value.get("longitude", null)
	if not (lat_value is float or lat_value is int) or not (lon_value is float or lon_value is int):
		return null
	var latitude := float(lat_value)
	var longitude := float(lon_value)
	if absf(latitude) > 90.0 or absf(longitude) > 180.0:
		return null
	return Vector2(longitude, latitude)


## Kilometres east and north of the group's centre, by location id.
## Empty unless there are at least two places and every one has coordinates and a distinct id,
## so a world that mixes real and invented places keeps its old layout.
static func project(locations: Array) -> Dictionary:
	var coordinates := {}
	for value in locations:
		if typeof(value) != TYPE_DICTIONARY:
			return {}
		var location: Dictionary = value
		var id := String(location.get("id", ""))
		var point = coordinates_of(location)
		if id.is_empty() or point == null:
			return {}
		coordinates[id] = point
	if coordinates.size() < 2 or coordinates.size() != locations.size():
		return {}
	var latitude_sum := 0.0
	var longitude_sum := 0.0
	for point in coordinates.values():
		longitude_sum += point.x
		latitude_sum += point.y
	var centre_latitude := latitude_sum / coordinates.size()
	var centre_longitude := longitude_sum / coordinates.size()
	var km_per_degree_longitude := KM_PER_DEGREE_LONGITUDE_AT_EQUATOR * cos(deg_to_rad(centre_latitude))
	var result := {}
	for id in coordinates:
		var point: Vector2 = coordinates[id]
		result[id] = Vector2(
			(point.x - centre_longitude) * km_per_degree_longitude,
			(point.y - centre_latitude) * KM_PER_DEGREE_LATITUDE,
		)
	return result


## Canvas positions for kilometre offsets: one scale on both axes (so distances keep their
## proportions), north up, centred in `inner` with `margin` pixels kept clear.
static func fit(points_km: Dictionary, inner: Rect2, margin: float) -> Dictionary:
	if points_km.is_empty():
		return {}
	var low := Vector2(INF, INF)
	var high := Vector2(-INF, -INF)
	for point in points_km.values():
		low = Vector2(minf(low.x, point.x), minf(low.y, point.y))
		high = Vector2(maxf(high.x, point.x), maxf(high.y, point.y))
	var span := high - low
	var area := Rect2(inner.position + Vector2(margin, margin), inner.size - Vector2(margin, margin) * 2.0)
	if area.size.x <= 0.0 or area.size.y <= 0.0:
		area = inner
	var scale := INF
	if span.x > 0.0001:
		scale = minf(scale, area.size.x / span.x)
	if span.y > 0.0001:
		scale = minf(scale, area.size.y / span.y)
	if scale == INF:
		scale = 1.0
	var used := span * scale
	var origin := area.position + (area.size - used) * 0.5
	var result := {}
	for id in points_km:
		var point: Vector2 = points_km[id]
		result[id] = Vector2(origin.x + (point.x - low.x) * scale, origin.y + (high.y - point.y) * scale)
	return result


## Push apart any places closer than `min_distance`, keeping each near its true position and
## inside `bounds`. Deterministic: the same input always gives the same layout.
##
## Two phases. The first drifts places back toward their true positions as it pushes, which
## keeps the map recognisable but settles a little short of the minimum in tight spots. The
## second pushes with no pull-back until the minimum holds, so it is a guarantee, not a target.
static func spread(positions: Dictionary, min_distance: float, bounds: Rect2, iterations: int = 200) -> Dictionary:
	var ids: Array = positions.keys()
	ids.sort()
	var current := _relax(positions, positions, ids, min_distance, bounds, iterations, 0.03)
	return _relax(current, positions, ids, min_distance, bounds, 400, 0.0)


static func _relax(start: Dictionary, anchor: Dictionary, ids: Array, min_distance: float, bounds: Rect2, iterations: int, pull: float) -> Dictionary:
	var current := start.duplicate()
	for step in range(iterations):
		var push := {}
		for id in ids:
			push[id] = Vector2.ZERO
		var crowded := false
		for i in range(ids.size()):
			for j in range(i + 1, ids.size()):
				var a: Vector2 = current[ids[i]]
				var b: Vector2 = current[ids[j]]
				var delta := b - a
				var distance := delta.length()
				if distance >= min_distance:
					continue
				crowded = true
				# Two places on the very same spot are separated along a fixed, pair-specific direction.
				var direction := delta / distance if distance > 0.001 else Vector2.from_angle(float(i * 31 + j * 17))
				var shove := (min_distance - distance) * 0.5 + 0.01
				push[ids[i]] -= direction * shove
				push[ids[j]] += direction * shove
		if not crowded:
			break
		for id in ids:
			var moved: Vector2 = current[id] + push[id]
			moved += (anchor[id] - moved) * pull
			current[id] = Vector2(
				clampf(moved.x, bounds.position.x, bounds.end.x),
				clampf(moved.y, bounds.position.y, bounds.end.y),
			)
	return current


## A label rectangle for each place so labels overlap neither each other nor other places'
## dots. `items` is in priority order: [{"id", "point", "text", "force"}]. `dot_radius` is how much
## room a dot and its ring need; `reserved` lists rectangles (a caption, say) labels must avoid.
## A place with no free spot gets no entry, unless it is marked "force": that place takes the
## candidate that overlaps least, so it is always named.
static func place_labels(items: Array, font: Font, font_size: int, bounds: Rect2, dot_radius: float = 9.0, reserved: Array = []) -> Dictionary:
	var result := {}
	var taken: Array = reserved.duplicate()
	var gap := dot_radius + 4.0
	for index in range(items.size()):
		var item: Dictionary = items[index]
		var point: Vector2 = item["point"]
		var measured := font.get_string_size(String(item["text"]), HORIZONTAL_ALIGNMENT_LEFT, -1, font_size)
		var size := Vector2(measured.x, float(font_size) * 1.3)
		# Eight spots around the dot, then the same eight farther out, twice. A label that has to
		# go farther out is joined to its dot by a leader line when it is drawn.
		var candidates: Array = []
		for ring in range(RINGS):
			var reach := gap + float(ring) * RING_STEP
			candidates.append_array([
				Rect2(point + Vector2(reach, -size.y * 0.5), size),
				Rect2(point + Vector2(-reach - size.x, -size.y * 0.5), size),
				Rect2(point + Vector2(-size.x * 0.5, -reach - size.y), size),
				Rect2(point + Vector2(-size.x * 0.5, reach), size),
				Rect2(point + Vector2(reach, -reach - size.y), size),
				Rect2(point + Vector2(reach, reach), size),
				Rect2(point + Vector2(-reach - size.x, -reach - size.y), size),
				Rect2(point + Vector2(-reach - size.x, reach), size),
			])
		var chosen = null
		var fallback = null
		var least_overlap := INF
		for candidate in candidates:
			var rect: Rect2 = candidate
			if not bounds.encloses(rect):
				continue
			var padded := rect.grow(2.0)
			var overlap := 0.0
			for other in taken:
				overlap += padded.intersection(other).get_area()
			for other_index in range(items.size()):
				if other_index == index:
					continue
				var other_point: Vector2 = items[other_index]["point"]
				overlap += padded.intersection(Rect2(other_point - Vector2(dot_radius, dot_radius), Vector2(dot_radius, dot_radius) * 2.0)).get_area()
			if overlap <= 0.0:
				chosen = rect
				break
			if overlap < least_overlap:
				least_overlap = overlap
				fallback = rect
		if chosen == null and bool(item.get("force", false)):
			chosen = fallback if fallback != null else candidates[0]
		if chosen != null:
			result[item["id"]] = chosen
			taken.append(chosen)
	return result


## The point on `rect` nearest to `point`: where a leader line from a dot should end.
static func nearest_point_on(rect: Rect2, point: Vector2) -> Vector2:
	return Vector2(clampf(point.x, rect.position.x, rect.end.x), clampf(point.y, rect.position.y, rect.end.y))
