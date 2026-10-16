# King Orion's Realm Client

This Godot project is a playable client for the Discord realm. It reads and acts on the same authoritative world state through the versioned `world.v1` HTTP contract.

## Run

Run `powershell -ExecutionPolicy Bypass -File game-client/run.ps1` from the repository root. The launcher starts the local world service when it is offline and leaves an existing server running.

Godot 4.7.2 is installed locally under `tools/godot-4.7.2`, so no system-wide installation is required.

## Current boundary

- Discord and the realm database remain authoritative for player actions and canonical events.
- Godot supports map travel, random and quest combat, defend/flee/revive, rest, investigation, conversation records, reputation choices, item use/equipment/trading, quest progression, and archived radio playback.
- Radio claims remain visibly separate from canonical game events.
- Places taken from a real-world lore pack show their record tier, era, sources and access status, and a do-not-visit warning where the real site is unsafe or closed (`world.v1` schemaVersion 2, see `docs/WORLD_API_V1.md`). Fictional places show nothing extra.
- A **Place** tab shows the selected place's record and lists the characters standing where the player stands, at places that come from a lore pack. Choose one, type a line and press Speak (or Enter) to talk. The reply says when it came from the place's record and not from the model, and the conversation is recorded with the ordinary `talk` command. Needs `orion.converse.projectPath` set on the server (see `docs/WORLD_API_V1.md`); without it the panel says conversation is not set up.
- The client automatically refreshes every five seconds and also supports manual refresh.
- Every mutation carries an expected world revision and an idempotency key. Conflicts refresh instead of overwriting another player's turn.
- When every place on the map has real coordinates (places from a lore pack do), the map draws them where they really are: north up, true proportions, places that crowd together nudged apart so each stays clickable, labels placed so they do not overlap (with a thin leader line when a label has to sit away from its dot), a red ring on places that are unsafe to visit in person, and a tooltip with every place's name. A world without coordinates, or with a mix, keeps the original layout and painted backdrop.
- `npm run client-selftest` runs the client's headless checks (`game-client/tests/*_check.gd`) with the bundled Godot.

The Adventure, Journal, Pack, and Radio tabs separate the main play loops. LM Studio is optional: deterministic mechanics continue working when narration is offline.
