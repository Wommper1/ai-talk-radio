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
- The client automatically refreshes every five seconds and also supports manual refresh.
- Every mutation carries an expected world revision and an idempotency key. Conflicts refresh instead of overwriting another player's turn.

The Adventure, Journal, Pack, and Radio tabs separate the main play loops. LM Studio is optional: deterministic mechanics continue working when narration is offline.
