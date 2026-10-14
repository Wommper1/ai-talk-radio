extends SceneTree
## Headless checks for how the client words a place's record (tier, sources, access) and its
## do-not-visit warning. Run with `npm run client-selftest`.

var failures := 0


func check(label: String, condition: bool) -> void:
	print("[%s] %s" % ["  ok  " if condition else " FAIL ", label])
	if not condition:
		failures += 1


func _init() -> void:
	var main = load("res://scripts/main.gd").new()

	var depot := {
		"name": "Testville Depot",
		"description": "Built in 1850.",
		"connectedTo": ["Alder Bridge"],
		"lore": {
			"confidence": "OFFICIAL_SOURCE", "verificationGrade": "Archival", "era": "1850s",
			"county": "Testford County", "sources": "Deed book 1", "accessStatus": "Public park",
			"doNotVisit": false,
		},
	}
	var bridge := {
		"name": "Alder Bridge",
		"lore": {"confidence": "wibble", "sources": "", "accessStatus": "Active Freight Rail Bridge", "doNotVisit": true},
	}
	var keep := {"name": "The Keep", "description": "Fiction.", "lore": null}
	var no_key := {"name": "Old Place"}

	var text: String = main._lore_text(depot)
	check("tier label is shown", text.contains("Record: Official Source (Archival)"))
	check("era and county are shown", text.contains("1850s | Testford County"))
	check("sources are shown", text.contains("Sources: Deed book 1"))
	check("access is shown", text.contains("Access: Public park"))
	check("a safe place has no warning", main._visit_warning(depot) == "")
	check("a flagged place leads with a warning", main._visit_warning(bridge).begins_with("DO NOT VISIT IN PERSON: Active Freight Rail Bridge"))
	check("an unknown tier is shown as Unverified", main._lore_text(bridge).contains("Record: Unverified"))
	check("missing sources are said to be missing", main._lore_text(bridge).contains("Sources: none recorded"))
	check("a place with null lore shows nothing extra", main._lore_text(keep) == "" and main._visit_warning(keep) == "")
	check("a place with no lore key shows nothing extra", main._lore_text(no_key) == "" and main._visit_warning(no_key) == "")

	main.free()
	print("failures: ", failures)
	quit(1 if failures > 0 else 0)
