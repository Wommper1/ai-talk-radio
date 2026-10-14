extends SceneTree
## Headless checks for the Place tab's logic: who is listed as being here, the request body, and how
## replies and errors are worded. Run with `npm run client-selftest` (once the runner is merged).

var failures := 0


func check(label: String, condition: bool) -> void:
	print("[%s] %s" % ["  ok  " if condition else " FAIL ", label])
	if not condition:
		failures += 1


func _init() -> void:
	var main = load("res://scripts/main.gd").new()

	var lore := {"confidence": "OFFICIAL_SOURCE", "doNotVisit": false}
	var world := {
		"player": {"id": "1", "name": "Wommper", "location": "Culbertson Mansion"},
		"locations": [
			{"name": "Culbertson Mansion", "lore": lore},
			{"name": "The Keep", "lore": null},
			{"name": "The Town Clock Church", "lore": lore},
		],
		"npcs": [
			{"id": "npc_a", "name": "Odalys Marlowe", "location": "Culbertson Mansion", "status": "alive"},
			{"id": "npc_b", "name": "Ephraim Tull", "location": "The Town Clock Church", "status": "alive"},
			{"id": "npc_c", "name": "A Ghost", "location": "Culbertson Mansion", "status": "dead"},
			{"id": "", "name": "No Id", "location": "Culbertson Mansion", "status": "alive"},
			{"id": "npc_d", "name": "Second Person", "location": "culbertson mansion", "status": "alive"},
		],
	}
	var here: Array = main._npcs_here(world)
	var ids: Array = []
	for npc in here:
		ids.append(npc["id"])
	check("only living, identified characters at the player's place are listed", ids == ["npc_a", "npc_d"])

	var at_church := world.duplicate(true)
	at_church["player"]["location"] = "Town Clock Church"
	var church_ids: Array = []
	for npc in main._npcs_here(at_church):
		church_ids.append(npc["id"])
	check("place names match without the leading 'The'", church_ids == ["npc_b"])

	var at_keep := world.duplicate(true)
	at_keep["player"]["location"] = "The Keep"
	at_keep["npcs"].append({"id": "npc_e", "name": "Griselda", "location": "The Keep", "status": "alive"})
	check("a fictional place (no lore) lists no one to talk to", main._npcs_here(at_keep).is_empty())
	check("no player means no one is listed", main._npcs_here({"npcs": world["npcs"], "locations": world["locations"]}).is_empty())
	check("an empty snapshot is safe", main._npcs_here({}).is_empty())
	check("malformed entries are skipped", main._npcs_here({"player": world["player"], "locations": world["locations"], "npcs": [1, "x", null, []]}).is_empty())

	var parsed = JSON.parse_string(main._converse_body("npc_a", "  Who built it?  ", "1"))
	check("the request body carries the character, the actor and the trimmed line", parsed == {"npcId": "npc_a", "actorId": "1", "line": "Who built it?"})
	var long = JSON.parse_string(main._converse_body("npc_a", "x".repeat(900), "1"))
	check("the request line is capped at 400 characters", String(long["line"]).length() == 400)

	var offline := {"npc": {"name": "Odalys Marlowe"}, "text": "Mind the staircase.", "source": "offline"}
	var model := {"npc": {"name": "Odalys Marlowe"}, "text": "Mind the staircase.", "source": "model"}
	check("a reply from the record says so", main._talk_reply_text(offline) == "Odalys Marlowe: Mind the staircase.\n(from the record)")
	check("a model reply carries no label", main._talk_reply_text(model) == "Odalys Marlowe: Mind the staircase.")
	check("a reply with no character name still reads", main._talk_reply_text({"text": "Hello.", "source": "model"}) == "Someone: Hello.")

	check("401 says the key is wrong", String(main._talk_error_text(401, {})).contains("world key"))
	check("429 says to wait", String(main._talk_error_text(429, {})).contains("Try again"))
	check("501 says conversation is not set up", String(main._talk_error_text(501, {})).contains("not set up"))
	check("another error shows the server's own message", main._talk_error_text(409, {"error": "That character is not here."}) == "That character is not here.")
	check("an error with no message has a fallback", String(main._talk_error_text(500, {})).length() > 0)

	main.free()
	print("failures: ", failures)
	quit(1 if failures > 0 else 0)
