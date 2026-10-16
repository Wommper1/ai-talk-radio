extends Control

const API_ORIGIN := "http://127.0.0.1:3000"
const SNAPSHOT_URL := API_ORIGIN + "/api/world/v1/snapshot"
const COMMAND_URL := API_ORIGIN + "/api/world/v1/commands"
const GOLD := Color("#e2b84f")
const INK := Color("#dce5dc")
const MUTED := Color("#93a198")
const PANEL := Color("#111d17")
const PANEL_ALT := Color("#16231c")
const BORDER := Color("#324238")
const SUCCESS := Color("#65b987")
const FAILURE := Color("#d16b65")
const LORE_TIER_LABELS := {
	"OFFICIAL_SOURCE": "Official Source",
	"VERIFIED": "Verified",
	"PROBABLE": "Probable",
	"ORAL_HISTORY": "Oral History",
	"LEGEND": "Legend",
	"UNVERIFIED": "Unverified",
}

@onready var campaign_label: Label = %CampaignLabel
@onready var connection_label: Label = %ConnectionLabel
@onready var refresh_button: Button = %RefreshButton
@onready var world_map: Control = %WorldMap
@onready var location_name: Label = %LocationName
@onready var location_details: Label = %LocationDetails
@onready var travel_button: Button = %TravelButton
@onready var inspect_button: Button = %InspectButton
@onready var location_action_state: Label = %LocationActionState
@onready var player_name: Label = %PlayerName
@onready var player_details: Label = %PlayerDetails
@onready var party_list: VBoxContainer = %PartyList
@onready var quest_list: VBoxContainer = %QuestList
@onready var show_title: Label = %ShowTitle
@onready var show_meta: Label = %ShowMeta
@onready var play_button: Button = %PlayButton
@onready var play_state: Label = %PlayState
@onready var enemy_label: Label = %EnemyLabel
@onready var attack_button: Button = %AttackButton
@onready var defend_button: Button = %DefendButton
@onready var flee_button: Button = %FleeButton
@onready var hunt_button: Button = %HuntButton
@onready var rest_button: Button = %RestButton
@onready var revive_button: Button = %ReviveButton
@onready var target_input: LineEdit = %TargetInput
@onready var talk_button: Button = %TalkButton
@onready var help_button: Button = %HelpButton
@onready var crime_button: Button = %CrimeButton
@onready var action_log: RichTextLabel = %ActionLog
@onready var item_picker: OptionButton = %ItemPicker
@onready var use_button: Button = %UseButton
@onready var equip_button: Button = %EquipButton
@onready var sell_button: Button = %SellButton
@onready var buy_potion_button: Button = %BuyPotionButton
@onready var inventory_state: Label = %InventoryState
@onready var action_tabs: TabContainer = $Page/Stack/Body/Right/ActionTabs
@onready var status_label: Label = %Status
@onready var snapshot_request: HTTPRequest = %SnapshotRequest
@onready var audio_request: HTTPRequest = %AudioRequest
@onready var command_request: HTTPRequest = %CommandRequest
@onready var audio_player: AudioStreamPlayer = %AudioPlayer
@onready var refresh_timer: Timer = %RefreshTimer

var snapshot: Dictionary = {}
var latest_audio_url := ""
var snapshot_etag := ""
var request_in_flight := false
var command_in_flight := false
var world_key := ""
var selected_location: Dictionary = {}


func _ready() -> void:
	_apply_style()
	_load_world_key()
	refresh_button.pressed.connect(_request_snapshot)
	play_button.pressed.connect(_play_latest_show)
	travel_button.pressed.connect(func(): _send_command("travel", {"destination": selected_location.get("name", "")}))
	inspect_button.pressed.connect(func(): _send_command("investigate", {"target": selected_location.get("name", "the surroundings")}))
	attack_button.pressed.connect(func(): _send_command("attack"))
	defend_button.pressed.connect(func(): _send_command("defend"))
	flee_button.pressed.connect(func(): _send_command("flee"))
	hunt_button.pressed.connect(func(): _send_command("hunt"))
	rest_button.pressed.connect(func(): _send_command("rest"))
	revive_button.pressed.connect(func(): _send_command("revive"))
	talk_button.pressed.connect(func(): _send_command("talk", {"target": _target_text()}))
	help_button.pressed.connect(func(): _send_command("help", {"target": _target_text()}))
	crime_button.pressed.connect(func(): _send_command("crime", {"target": _target_text()}))
	use_button.pressed.connect(func(): _send_item_command("use"))
	equip_button.pressed.connect(func(): _send_item_command("equip"))
	sell_button.pressed.connect(func(): _send_item_command("sell"))
	buy_potion_button.pressed.connect(func(): _send_command("buy", {"item": "Health Potion"}))
	refresh_timer.timeout.connect(_request_snapshot)
	snapshot_request.request_completed.connect(_on_snapshot_completed)
	audio_request.request_completed.connect(_on_audio_completed)
	command_request.request_completed.connect(_on_command_completed)
	audio_player.finished.connect(_on_audio_finished)
	world_map.location_selected.connect(_on_location_selected)
	_request_snapshot()
	_capture_for_qa_if_requested()


func _request_snapshot() -> void:
	if request_in_flight:
		return
	request_in_flight = true
	refresh_button.disabled = true
	connection_label.text = "SYNCING"
	connection_label.modulate = GOLD
	var headers := PackedStringArray(["Accept: application/json"])
	if not snapshot_etag.is_empty():
		headers.append("If-None-Match: " + snapshot_etag)
	var error := snapshot_request.request(SNAPSHOT_URL, headers)
	if error != OK:
		_set_connection_error("REQUEST ERROR %s" % error)


func _on_snapshot_completed(result: int, response_code: int, headers: PackedStringArray, body: PackedByteArray) -> void:
	request_in_flight = false
	refresh_button.disabled = false

	if result != HTTPRequest.RESULT_SUCCESS:
		_set_connection_error("RADIO LINK DOWN")
		return
	if response_code == 304:
		_set_connected()
		return
	if response_code != 200:
		_set_connection_error("API %s" % response_code)
		return

	var parsed = JSON.parse_string(body.get_string_from_utf8())
	if typeof(parsed) != TYPE_DICTIONARY or String(parsed.get("contract", "")) != "world.v1":
		_set_connection_error("BAD WORLD CONTRACT")
		return

	for header in headers:
		if header.to_lower().begins_with("etag:"):
			snapshot_etag = header.substr(5).strip_edges()
	snapshot = parsed
	_render_snapshot()
	_set_connected()


func _render_snapshot() -> void:
	var campaign: Dictionary = snapshot.get("campaign", {})
	campaign_label.text = "%s  |  REV %s" % [String(campaign.get("name", "UNKNOWN CAMPAIGN")).to_upper(), _display_number(campaign.get("revision", 0))]

	var player_value = snapshot.get("player", null)
	var player: Dictionary = player_value if typeof(player_value) == TYPE_DICTIONARY else {}
	player_name.text = String(player.get("name", "No player linked"))
	var hp_value = player.get("hp", {})
	var hp: Dictionary = hp_value if typeof(hp_value) == TYPE_DICTIONARY else {}
	player_details.text = "%s  |  LV %s  |  HP %s/%s\nGold %s  |  XP %s" % [
		String(player.get("location", "Unknown")),
		_display_number(player.get("level", "-")),
		_display_number(hp.get("current", "-")),
		_display_number(hp.get("max", "-")),
		_display_number(player.get("gold", "-")),
		_display_number(player.get("xp", "-")),
	]

	_clear_children(party_list)
	var party: Array = snapshot.get("party", [])
	if party.is_empty():
		party_list.add_child(_muted_label("No companions are currently recorded."))
	else:
		for member_value in party:
			var member: Dictionary = member_value
			party_list.add_child(_party_row(member))

	_clear_children(quest_list)
	quest_list.add_child(_small_heading("OPEN MATTERS"))
	var quests: Array = snapshot.get("quests", [])
	for quest_value in quests.slice(0, 3):
		var quest: Dictionary = quest_value
		quest_list.add_child(_quest_row(quest))

	var events: Array = snapshot.get("events", [])
	if not events.is_empty():
		var event: Dictionary = events[events.size() - 1]
		quest_list.add_child(_section_rule())
		quest_list.add_child(_small_heading("LATEST CANONICAL EVENT"))
		quest_list.add_child(_body_label(String(event.get("description", "No summary"))))

	var claims: Array = snapshot.get("claims", [])
	if not claims.is_empty():
		quest_list.add_child(_section_rule())
		quest_list.add_child(_small_heading("UNVERIFIED RADIO CLAIMS"))
		var claim: Dictionary = claims[claims.size() - 1]
		quest_list.add_child(_muted_label(String(claim.get("description", "No claim text"))))

	if quests.is_empty() and events.is_empty() and claims.is_empty():
		quest_list.add_child(_muted_label("No active quests or recent events."))

	var locations: Array = snapshot.get("locations", [])
	world_map.set_world(locations, String(player.get("location", "")))
	var selected := _location_by_name(locations, String(selected_location.get("name", "")))
	if selected.is_empty():
		selected = _location_for_player(locations, String(player.get("location", "")))
	if selected.is_empty() and not locations.is_empty():
		selected = locations[0]
	_on_location_selected(selected)
	_render_combat(player, party, quests)
	_render_inventory(player)

	var radio: Dictionary = snapshot.get("radio", {})
	var latest_value = radio.get("latestShow", null)
	var latest: Dictionary = latest_value if typeof(latest_value) == TYPE_DICTIONARY else {}
	if latest.is_empty():
		show_title.text = "No broadcast archived yet"
		show_meta.text = "The station will appear here after its next show."
		latest_audio_url = ""
		play_button.disabled = true
	else:
		show_title.text = String(latest.get("title", "Untitled broadcast"))
		show_meta.text = "%s  |  %s" % [String(latest.get("createdAt", "")).left(10), _format_duration(float(latest.get("duration", 0.0)))]
		latest_audio_url = String(latest.get("audioUrl", ""))
		play_button.disabled = latest_audio_url.is_empty()


func _on_location_selected(location: Dictionary) -> void:
	selected_location = location
	if location.is_empty():
		location_name.text = "No mapped locations"
		location_details.text = "Waiting for the realm database."
		_refresh_action_controls()
		return
	location_name.text = String(location.get("name", "Unknown location"))
	var links := PackedStringArray()
	for linked in location.get("connectedTo", []):
		links.append(String(linked))
	var route_text := ", ".join(links) if not links.is_empty() else "No mapped routes"
	var details := "%s\nRoutes: %s" % [String(location.get("description", "No description recorded.")), route_text]
	var lore_text := _lore_text(location)
	if not lore_text.is_empty():
		details += "\n\n" + lore_text
	location_details.text = _visit_warning(location) + details
	location_action_state.text = "Selected destination"
	_refresh_action_controls()


func _lore_dictionary(location: Dictionary) -> Dictionary:
	var lore_value = location.get("lore", null)
	return lore_value if typeof(lore_value) == TYPE_DICTIONARY else {}


# Real places only. In-game travel is unaffected; this is a warning about the real site.
func _visit_warning(location: Dictionary) -> String:
	var lore := _lore_dictionary(location)
	if lore.is_empty() or not bool(lore.get("doNotVisit", false)):
		return ""
	var access := String(lore.get("accessStatus", "")).strip_edges()
	var reason := access if not access.is_empty() else "restricted access"
	return "DO NOT VISIT IN PERSON: %s\n\n" % reason


func _lore_text(location: Dictionary) -> String:
	var lore := _lore_dictionary(location)
	if lore.is_empty():
		return ""
	# An unknown tier is shown as Unverified, never as something better.
	var tier := String(lore.get("confidence", "UNVERIFIED"))
	var record := String(LORE_TIER_LABELS.get(tier, "Unverified"))
	var grade := String(lore.get("verificationGrade", "")).strip_edges()
	var lines := PackedStringArray()
	lines.append("Record: %s%s" % [record, " (%s)" % grade if not grade.is_empty() else ""])
	var era := String(lore.get("era", "")).strip_edges()
	var county := String(lore.get("county", "")).strip_edges()
	var where_when := PackedStringArray()
	if not era.is_empty():
		where_when.append(era)
	if not county.is_empty():
		where_when.append(county)
	if not where_when.is_empty():
		lines.append(" | ".join(where_when))
	var sources := String(lore.get("sources", "")).strip_edges()
	lines.append("Sources: %s" % (sources if not sources.is_empty() else "none recorded"))
	var access := String(lore.get("accessStatus", "")).strip_edges()
	if not access.is_empty():
		lines.append("Access: %s" % access)
	return "\n".join(lines)


func _render_combat(player: Dictionary, party: Array, quests: Array) -> void:
	var combat_value = snapshot.get("combat", {})
	var combat: Dictionary = combat_value if typeof(combat_value) == TYPE_DICTIONARY else {}
	var enemy_value = combat.get("enemy", null)
	var enemy: Dictionary = enemy_value if typeof(enemy_value) == TYPE_DICTIONARY else {}
	if bool(combat.get("active", false)) and not enemy.is_empty():
		enemy_label.text = "%s  |  HP %s/%s%s" % [
			String(enemy.get("name", "Unknown enemy")),
			_display_number(enemy.get("hp", 0)),
			_display_number(enemy.get("maxHp", 0)),
			"  |  BOSS" if bool(enemy.get("boss", false)) else "",
		]
	else:
		enemy_label.text = "Roads quiet. Attack to risk an encounter, or hunt the active quarry."
	var actor_id := String(player.get("id", ""))
	var fallen := false
	for member_value in party:
		var member: Dictionary = member_value
		if String(member.get("id", "")) == actor_id:
			fallen = bool(member.get("fallen", false))
			break
	revive_button.set_meta("actor_fallen", fallen)
	hunt_button.set_meta("has_quest", quests.any(func(quest): return String(quest.get("status", "")) == "active"))
	_refresh_action_controls()


func _render_inventory(player: Dictionary) -> void:
	var previous := item_picker.get_item_text(item_picker.selected) if item_picker.item_count > 0 else ""
	item_picker.clear()
	var inventory: Array = player.get("inventory", [])
	for item in inventory:
		item_picker.add_item(String(item))
		if String(item) == previous:
			item_picker.select(item_picker.item_count - 1)
	var weapon := String(player.get("equippedWeapon", "None")) if player.get("equippedWeapon") else "None"
	var armor := String(player.get("equippedArmor", "None")) if player.get("equippedArmor") else "None"
	var reputation_value = player.get("reputation", {})
	var reputation: Dictionary = reputation_value if typeof(reputation_value) == TYPE_DICTIONARY else {}
	inventory_state.text = "Weapon: %s\nArmor: %s\nReputation: %s heroic / %s criminal" % [
		weapon, armor,
		_display_number(reputation.get("hero", 0)),
		_display_number(reputation.get("crime", 0)),
	]
	_refresh_action_controls()


func _load_world_key() -> void:
	var token_path := ProjectSettings.globalize_path("res://../data/world_api_token.txt")
	if not FileAccess.file_exists(token_path):
		status_label.text = "World key missing; actions are locked"
		return
	var token_file := FileAccess.open(token_path, FileAccess.READ)
	if token_file:
		world_key = token_file.get_as_text().strip_edges()
	if world_key.length() < 32:
		world_key = ""
		status_label.text = "World key is invalid; actions are locked"


func _send_command(type: String, payload: Dictionary = {}) -> void:
	if command_in_flight or world_key.is_empty():
		if world_key.is_empty():
			_append_action("The local world key is unavailable.", FAILURE)
		return
	var player_value = snapshot.get("player", null)
	var player: Dictionary = player_value if typeof(player_value) == TYPE_DICTIONARY else {}
	var campaign: Dictionary = snapshot.get("campaign", {})
	if player.is_empty():
		_append_action("No controllable player is linked.", FAILURE)
		return
	var command_id := "godot-%s-%s" % [Time.get_ticks_msec(), randi()]
	var body := JSON.stringify({
		"id": command_id,
		"actorId": String(player.get("id", "")),
		"type": type,
		"expectedRevision": int(campaign.get("revision", 0)),
		"payload": payload,
	})
	var headers := PackedStringArray([
		"Accept: application/json",
		"Content-Type: application/json",
		"Idempotency-Key: " + command_id,
		"X-World-Key: " + world_key,
	])
	command_in_flight = true
	status_label.text = "Committing %s..." % type
	_append_action("%s..." % type.capitalize(), GOLD)
	_refresh_action_controls()
	var error := command_request.request(COMMAND_URL, headers, HTTPClient.METHOD_POST, body)
	if error != OK:
		command_in_flight = false
		_append_action("Command request failed: %s" % error, FAILURE)
		_refresh_action_controls()


func _on_command_completed(result: int, response_code: int, _headers: PackedStringArray, body: PackedByteArray) -> void:
	command_in_flight = false
	var parsed_value = JSON.parse_string(body.get_string_from_utf8())
	var parsed: Dictionary = parsed_value if typeof(parsed_value) == TYPE_DICTIONARY else {}
	if result != HTTPRequest.RESULT_SUCCESS:
		_append_action("The world engine did not answer.", FAILURE)
		_set_connection_error("ENGINE LINK DOWN")
		_refresh_action_controls()
		return
	if response_code != 200:
		_append_action(String(parsed.get("error", "Command rejected by the world rules.")), FAILURE)
		if response_code == 409:
			snapshot_etag = ""
			_request_snapshot()
		else:
			status_label.text = "Command rejected"
		_refresh_action_controls()
		return
	var next_snapshot_value = parsed.get("snapshot", null)
	if typeof(next_snapshot_value) == TYPE_DICTIONARY:
		snapshot = next_snapshot_value
		snapshot_etag = ""
		_render_snapshot()
	_append_action(String(parsed.get("message", "Action committed.")), SUCCESS)
	status_label.text = "Saved as canonical realm history"
	_refresh_action_controls()


func _send_item_command(type: String) -> void:
	if item_picker.item_count <= 0:
		_append_action("The pack is empty.", FAILURE)
		return
	_send_command(type, {"item": item_picker.get_item_text(item_picker.selected)})


func _target_text() -> String:
	var target := target_input.text.strip_edges()
	if target.is_empty():
		target = String(selected_location.get("name", "the surroundings"))
	return target


func _append_action(message: String, color: Color) -> void:
	action_log.append_text("\n")
	action_log.push_color(color)
	action_log.add_text(message)
	action_log.pop()


func _refresh_action_controls() -> void:
	if not is_node_ready():
		return
	var player_value = snapshot.get("player", null)
	var player: Dictionary = player_value if typeof(player_value) == TYPE_DICTIONARY else {}
	var combat_value = snapshot.get("combat", {})
	var combat: Dictionary = combat_value if typeof(combat_value) == TYPE_DICTIONARY else {}
	var active := bool(combat.get("active", false))
	var fallen := bool(revive_button.get_meta("actor_fallen", false))
	var locked := command_in_flight or world_key.is_empty() or player.is_empty()
	attack_button.disabled = locked or fallen
	defend_button.disabled = locked or fallen or not active
	flee_button.disabled = locked or fallen or not active
	hunt_button.disabled = locked or fallen or active or not bool(hunt_button.get_meta("has_quest", false))
	rest_button.disabled = locked or fallen or active
	revive_button.disabled = locked or not fallen
	talk_button.disabled = locked or fallen
	help_button.disabled = locked or fallen
	crime_button.disabled = locked or fallen
	inspect_button.disabled = locked or fallen
	var current_location := String(player.get("location", ""))
	travel_button.disabled = locked or fallen or active or selected_location.is_empty() or (
		_location_key(String(selected_location.get("name", ""))) == _location_key(current_location)
	)
	var no_item := item_picker.item_count <= 0
	use_button.disabled = locked or fallen or no_item
	equip_button.disabled = locked or fallen or no_item
	sell_button.disabled = locked or fallen or active or no_item
	buy_potion_button.disabled = locked or fallen or active


func _location_by_name(locations: Array, name: String) -> Dictionary:
	if name.is_empty():
		return {}
	return _location_for_player(locations, name)


func _play_latest_show() -> void:
	if latest_audio_url.is_empty():
		return
	play_button.disabled = true
	play_state.text = "Loading broadcast..."
	var url := latest_audio_url if latest_audio_url.begins_with("http") else API_ORIGIN + latest_audio_url
	var error := audio_request.request(url)
	if error != OK:
		play_button.disabled = false
		play_state.text = "Audio request failed."


func _on_audio_completed(result: int, response_code: int, _headers: PackedStringArray, body: PackedByteArray) -> void:
	if result != HTTPRequest.RESULT_SUCCESS or response_code != 200:
		play_button.disabled = false
		play_state.text = "Broadcast unavailable."
		return
	var stream := AudioStreamWAV.load_from_buffer(body)
	if stream == null:
		play_button.disabled = false
		play_state.text = "Audio format was not recognized."
		return
	audio_player.stream = stream
	audio_player.play()
	play_state.text = "On air now"


func _on_audio_finished() -> void:
	play_button.disabled = latest_audio_url.is_empty()
	play_state.text = "Broadcast finished"


func _set_connected() -> void:
	connection_label.text = "LIVE"
	connection_label.modulate = SUCCESS
	status_label.text = "Synchronized with Discord authority"


func _set_connection_error(message: String) -> void:
	request_in_flight = false
	refresh_button.disabled = false
	connection_label.text = message
	connection_label.modulate = FAILURE
	status_label.text = "Showing the last received world state"


func _location_for_player(locations: Array, player_location_name: String) -> Dictionary:
	for value in locations:
		var location: Dictionary = value
		if _location_key(String(location.get("name", ""))) == _location_key(player_location_name):
			return location
	return {}


func _clear_children(container: Node) -> void:
	for child in container.get_children():
		child.queue_free()


func _party_row(member: Dictionary) -> Control:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	var name := _body_label("%s  @  %s" % [String(member.get("name", "Unknown NPC")), String(member.get("location", "Unknown"))])
	name.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_child(name)
	var is_fallen := bool(member.get("fallen", false))
	var state := _small_heading("FALLEN" if is_fallen else "LV %s %s" % [
		_display_number(member.get("level", 1)),
		String(member.get("class", "unknown")).capitalize(),
	])
	state.modulate = FAILURE if is_fallen else SUCCESS
	row.add_child(state)
	return row


func _quest_row(quest: Dictionary) -> Control:
	var row := VBoxContainer.new()
	row.add_theme_constant_override("separation", 3)
	row.add_child(_body_label(String(quest.get("name", "Unnamed quest"))))
	row.add_child(_muted_label("%s  |  %s" % [String(quest.get("status", "unknown")).to_upper(), String(quest.get("description", "No description"))]))
	return row


func _small_heading(text: String) -> Label:
	var label := Label.new()
	label.text = text
	label.add_theme_font_size_override("font_size", 11)
	label.add_theme_color_override("font_color", GOLD)
	return label


func _body_label(text: String) -> Label:
	var label := Label.new()
	label.text = text
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.add_theme_font_size_override("font_size", 14)
	label.add_theme_color_override("font_color", INK)
	return label


func _muted_label(text: String) -> Label:
	var label := _body_label(text)
	label.add_theme_font_size_override("font_size", 12)
	label.add_theme_color_override("font_color", MUTED)
	return label


func _section_rule() -> HSeparator:
	var separator := HSeparator.new()
	separator.add_theme_constant_override("separation", 4)
	return separator


func _format_duration(seconds: float) -> String:
	var total := int(seconds)
	return "%02d:%02d" % [total / 60, total % 60]


func _display_number(value: Variant) -> String:
	if typeof(value) == TYPE_FLOAT and is_equal_approx(value, round(value)):
		return str(int(value))
	return str(value)


func _location_key(name: String) -> String:
	var key := name.to_lower().strip_edges()
	return key.trim_prefix("the ") if key.begins_with("the ") else key


func _apply_style() -> void:
	for panel in get_tree().get_nodes_in_group("panel"):
		if panel is PanelContainer:
			var style := StyleBoxFlat.new()
			style.bg_color = PANEL_ALT if panel.name == "LocationBand" else PANEL
			style.border_color = BORDER
			style.set_border_width_all(1)
			style.set_corner_radius_all(6)
			style.set_content_margin_all(12)
			panel.add_theme_stylebox_override("panel", style)
	var button_style := StyleBoxFlat.new()
	button_style.bg_color = Color("#26382e")
	button_style.border_color = BORDER
	button_style.set_border_width_all(1)
	button_style.set_corner_radius_all(5)
	button_style.set_content_margin_all(8)
	for button in [
		refresh_button, play_button, travel_button, inspect_button,
		attack_button, defend_button, flee_button, hunt_button, rest_button, revive_button,
		talk_button, help_button, crime_button, use_button, equip_button, sell_button, buy_potion_button,
	]:
		button.add_theme_stylebox_override("normal", button_style)
		var hover_style: StyleBoxFlat = button_style.duplicate()
		hover_style.bg_color = Color("#31483a")
		button.add_theme_stylebox_override("hover", hover_style)
		button.add_theme_color_override("font_color", INK)


func _capture_for_qa_if_requested() -> void:
	var path := OS.get_environment("REALM_CAPTURE_PATH")
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--capture="):
			path = argument.trim_prefix("--capture=")
		elif argument.begins_with("--tab="):
			action_tabs.current_tab = clampi(int(argument.trim_prefix("--tab=")), 0, action_tabs.get_tab_count() - 1)
	if path.is_empty():
		return
	await get_tree().create_timer(2.5).timeout
	get_viewport().get_texture().get_image().save_png(path)
	get_tree().quit()
