# World API v1

`world.v1` is the engine-neutral contract shared by AI Talk Radio, Godot, and the King Orion Discord realm. Godot consumes this contract instead of opening the Discord game's SQLite database directly.

## Endpoints

### GET /api/world/v1/health

Returns contract identity, realm connectivity, campaign identity, runtime revision, and current data-source status.

### GET /api/world/v1/snapshot

Returns a normalized snapshot containing:

- campaign identity and revision
- active player and party
- locations and routes, each with an optional `lore` object (see below)
- active quests
- canonical events
- noncanonical radio claims
- event and claim cursors
- latest archived radio show
- source health problems

The endpoint sends an ETag and honors `If-None-Match`. Responses use `Cache-Control: no-store` so a game client cannot silently remain on an obsolete world state.

### GET /api/world/v1/events?after=CURSOR&limit=50

Returns canonical events after a numeric cursor. The limit is bounded by the server.

### GET /api/world/v1/claims?after=CURSOR

Returns unverified radio claims after a numeric cursor. Claims are never promoted to canonical events by this read API.

### GET /api/world/v1/capabilities

Lists supported command types and the concurrency and idempotency rules clients must follow.

### POST /api/world/v1/commands

Commits one authenticated world action. Required headers are `Content-Type: application/json`, `X-World-Key`, and an `Idempotency-Key` matching the command id. The local key is generated in `data/world_api_token.txt` and must not be published or embedded in an exported game.

The JSON body contains `id`, `actorId`, `type`, `expectedRevision`, and `payload`. Supported actions are travel, attack, defend, flee, hunt, use, equip, buy, sell, talk, investigate, help, crime, rest, and revive.

Successful responses contain the deterministic outcome and the newly committed snapshot. A stale expected revision returns HTTP 409 without changing the world. Repeating a successful command id returns the original result without applying it twice.

## Schema versions

`schemaVersion` counts additive changes inside `world.v1`. A client that ignores fields it does not know keeps working across versions. Breaking changes need a new route.

| schemaVersion | Change |
| --- | --- |
| 1 | Original snapshot. |
| 2 | Each location has a `lore` field: an object, or `null` for a fictional place or a database without lore columns. |

## Location lore (schemaVersion 2)

A place taken from a real-world lore pack, such as the Southern Indiana Lore pack, carries its provenance in `lore`:

| Field | Meaning |
| --- | --- |
| `siteId` | The pack's id for the site. |
| `confidence` | One of `OFFICIAL_SOURCE`, `VERIFIED`, `PROBABLE`, `ORAL_HISTORY`, `LEGEND`, `UNVERIFIED`. A missing or unrecognised value is `UNVERIFIED`; it is never read as a better tier. |
| `verificationGrade`, `county`, `era`, `category` | Descriptive text from the pack. |
| `sources`, `sourceNotes` | Citations for the location's `description`. |
| `accessStatus` | Who can visit the real site, and how. |
| `doNotVisit` | `true` when visiting the real site is unsafe or not allowed. Clients must show this warning. Unreadable values read as `true`. |
| `latitude`, `longitude` | Real-world coordinates, or `null`. |

Rules for clients:

1. A location's `description` is verified history only. Do not append folklore to it.
2. Folklore is deliberately not part of this contract. A client that needs to show the legend layer needs a labelled field added in a later `schemaVersion`.
3. Show the tier next to anything presented as history, so a `LEGEND` or `UNVERIFIED` place is never read as established fact.

## Ownership rules

1. The Discord realm database remains the source of truth while the game is Discord-first.
2. Radio may read canonical state and submit claims through the existing chronicle boundary.
3. A rendering engine must not write directly to SQLite.
4. Actions go through the authenticated command service with validation, idempotency keys, optimistic revisions, and canonical event results.
5. Discord reloads the latest database revision before resolving a queued turn and rejects a narrated result if another client committed while the model was answering.
6. Contract-breaking changes require a new versioned route rather than silently changing `world.v1`.

## Transaction behavior

The command bridge opens one short `BEGIN IMMEDIATE` transaction, checks the expected runtime revision, applies the Discord project's deterministic Python mechanics, updates player sheets and the runtime snapshot, records canonical events, stores the replayable command result, and commits. Any failed rule or exception rolls the entire operation back.
