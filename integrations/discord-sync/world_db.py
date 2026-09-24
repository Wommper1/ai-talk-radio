"""
world_db.py  --  SQLite persistent world database
====================================================
The game engine source of truth. The AI only narrates.
This controls all facts.

Tables:
  players       -- Discord users and their character state
  npcs          -- All named NPCs and their persistent memory
  locations     -- World locations, populations, factions
  quests        -- Active, completed, and failed quests
  events        -- Full event log (everything that ever happened)
  factions      -- Political groups, guilds, cults
  relationships -- Scores between any two entities
"""

import sqlite3
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Anchored to this file's own directory (2026-08-28, Codex audit finding 3).
# These used to be bare relative filenames, which meant every read/write
# depended on the process's CURRENT WORKING DIRECTORY rather than on which
# copy of the game was actually running. Neither play.bat set its own
# directory before invoking main.py, so launching from an unrelated CWD (a
# different shortcut "Start in" folder, a task runner, a different terminal)
# could read or write into a completely wrong location, or silently create a
# stray file next to whatever else happened to be running. Anchoring to
# __file__ makes each copy of the game fully self-contained regardless of how
# or from where it is launched.
_HERE = Path(__file__).resolve().parent
DB_FILE = str(_HERE / "world.db")
SCHEMA_VERSION = 2
_INITIALIZED = set()


class RevisionConflictError(RuntimeError):
    """Raised when another client committed after a caller loaded state."""

PLAYER_COLUMNS = {
    "character_name", "class", "race", "level", "xp", "hp_current", "hp_max",
    "gold", "location", "reputation_hero", "reputation_crime", "kills",
    "deaths", "turns_taken", "inventory", "known_lore", "active_quest",
}
NPC_COLUMNS = {
    "occupation", "faction", "home_location", "current_location", "personality",
    "current_mood", "is_alive", "relationships", "memories", "secrets",
}
LOCATION_COLUMNS = {
    "type", "kingdom", "population", "leader", "faction", "description",
    "connected_to", "resources", "threats",
}
QUEST_COLUMNS = {"status", "participants", "objectives", "rewards", "location", "completed_at"}


def _now():
    return datetime.now(timezone.utc).isoformat()


def get_db():
    """Return a connection. Call close() when done. Use context manager for safety."""
    conn = sqlite3.connect(DB_FILE, timeout=8.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")   # safe for concurrent reads
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=8000")
    return conn


def _ensure_column(conn, table, name, declaration):
    have = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if name not in have:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")


def _validated_fields(kwargs, allowed, kind):
    unknown = set(kwargs) - allowed
    if unknown:
        raise ValueError(f"Unknown {kind} fields: {', '.join(sorted(unknown))}")
    return kwargs


def _seed_realm(conn):
    """Fill the known map without overwriting richer live descriptions."""
    places = [
        ("wildlands", "The Wildlands", "wilderness", "Roads and open country contested by bandits and worse.", ["Brindlemark", "The Dark Forest", "Greyditch"]),
        ("brindlemark", "Brindlemark", "village", "A working village whose forge is kept by Griselda.", ["The Wildlands", "The Sunken Ford"]),
        ("great_hall", "The Great Hall", "castle", "King Orion's hall of judgment, petitions, and broadcasts.", ["The Wildlands"]),
        ("dark_forest", "The Dark Forest", "forest", "An old forest where the roads narrow and ordinary rules weaken.", ["The Wildlands", "Greyditch"]),
        ("greyditch", "Greyditch", "ruins", "A scarred settlement remembered for ash and empty granaries.", ["The Wildlands", "The Dark Forest"]),
        ("sunken_ford", "The Sunken Ford", "crossing", "A dangerous river crossing on the road beyond Brindlemark.", ["Brindlemark"]),
    ]
    for location_id, name, kind, description, connected in places:
        conn.execute(
            """INSERT INTO locations
               (location_id, name, type, kingdom, description, connected_to, created_at)
               VALUES (?, ?, ?, 'King Orion''s Realm', ?, ?, ?)
               ON CONFLICT(location_id) DO UPDATE SET
                 description=CASE WHEN COALESCE(locations.description, '')='' THEN excluded.description ELSE locations.description END,
                 connected_to=CASE WHEN COALESCE(locations.connected_to, '[]')='[]' THEN excluded.connected_to ELSE locations.connected_to END""",
            (location_id, name, kind, description, json.dumps(connected), _now()),
        )


def init_db():
    """Create all tables if they don't exist. Safe to call on every startup."""
    if DB_FILE in _INITIALIZED and os.path.exists(DB_FILE):
        return
    with get_db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS players (
            discord_id      TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            character_name  TEXT,
            class           TEXT DEFAULT 'warrior',
            race            TEXT DEFAULT 'Human',
            level           INTEGER DEFAULT 1,
            xp              INTEGER DEFAULT 0,
            hp_current      INTEGER DEFAULT 30,
            hp_max          INTEGER DEFAULT 30,
            gold            INTEGER DEFAULT 10,
            location        TEXT DEFAULT 'the Wildlands',
            reputation_hero INTEGER DEFAULT 0,
            reputation_crime INTEGER DEFAULT 0,
            kills           INTEGER DEFAULT 0,
            deaths          INTEGER DEFAULT 0,
            turns_taken     INTEGER DEFAULT 0,
            inventory       TEXT DEFAULT '[]',
            known_lore      TEXT DEFAULT '[]',
            active_quest    TEXT,
            created_at      TEXT,
            last_seen       TEXT
        );

        CREATE TABLE IF NOT EXISTS npcs (
            npc_id          TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            occupation      TEXT,
            faction         TEXT,
            home_location   TEXT,
            current_location TEXT,
            personality     TEXT,
            current_mood    TEXT DEFAULT 'neutral',
            is_alive        INTEGER DEFAULT 1,
            relationships   TEXT DEFAULT '{}',
            memories        TEXT DEFAULT '[]',
            secrets         TEXT DEFAULT '[]',
            created_at      TEXT
        );

        CREATE TABLE IF NOT EXISTS locations (
            location_id     TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            type            TEXT DEFAULT 'wilderness',
            kingdom         TEXT,
            population      INTEGER DEFAULT 0,
            leader          TEXT,
            faction         TEXT,
            description     TEXT,
            connected_to    TEXT DEFAULT '[]',
            resources       TEXT DEFAULT '{}',
            threats         TEXT DEFAULT '[]',
            created_at      TEXT
        );

        CREATE TABLE IF NOT EXISTS quests (
            quest_id        TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            description     TEXT,
            quest_giver     TEXT,
            status          TEXT DEFAULT 'active',
            participants    TEXT DEFAULT '[]',
            objectives      TEXT DEFAULT '[]',
            rewards         TEXT DEFAULT '{}',
            location        TEXT,
            created_at      TEXT,
            completed_at    TEXT
        );

        CREATE TABLE IF NOT EXISTS events (
            event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type      TEXT,
            participants    TEXT DEFAULT '[]',
            description     TEXT NOT NULL,
            location        TEXT,
            importance      INTEGER DEFAULT 1,
            timestamp       TEXT,
            is_embedded     INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS factions (
            faction_id      TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            type            TEXT,
            territory       TEXT DEFAULT '[]',
            military        INTEGER DEFAULT 50,
            influence       INTEGER DEFAULT 50,
            resources       INTEGER DEFAULT 50,
            allies          TEXT DEFAULT '[]',
            enemies         TEXT DEFAULT '[]',
            leader          TEXT,
            description     TEXT
        );

        CREATE TABLE IF NOT EXISTS relationships (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_a        TEXT NOT NULL,
            entity_b        TEXT NOT NULL,
            rel_type        TEXT,
            score           INTEGER DEFAULT 0,
            notes           TEXT,
            last_updated    TEXT,
            UNIQUE(entity_a, entity_b)
        );

        CREATE TABLE IF NOT EXISTS realm_meta (
            key             TEXT PRIMARY KEY,
            value           TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS campaigns (
            campaign_id     TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'active',
            started_at      TEXT NOT NULL,
            ended_at        TEXT
        );

        CREATE TABLE IF NOT EXISTS discord_runtime (
            campaign_id     TEXT PRIMARY KEY,
            state_json      TEXT NOT NULL,
            roster_json     TEXT NOT NULL,
            revision        INTEGER NOT NULL DEFAULT 0,
            updated_at      TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS discord_turns (
            message_id      TEXT PRIMARY KEY,
            campaign_id     TEXT NOT NULL,
            discord_id      TEXT NOT NULL,
            actor_name      TEXT NOT NULL,
            action          TEXT NOT NULL,
            intent          TEXT NOT NULL,
            status          TEXT NOT NULL,
            response        TEXT,
            event_json      TEXT,
            error           TEXT,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL,
            sent_at         TEXT
        );

        CREATE TABLE IF NOT EXISTS claims (
            claim_id        INTEGER PRIMARY KEY AUTOINCREMENT,
            campaign_id     TEXT NOT NULL,
            source          TEXT NOT NULL,
            claim_type      TEXT NOT NULL DEFAULT 'statement',
            participants    TEXT NOT NULL DEFAULT '[]',
            description     TEXT NOT NULL,
            location        TEXT,
            confidence      REAL NOT NULL DEFAULT 0.5,
            status          TEXT NOT NULL DEFAULT 'unverified',
            timestamp       TEXT NOT NULL
        );
        """)
        _ensure_column(conn, "events", "campaign_id", "TEXT NOT NULL DEFAULT 'legacy'")
        _ensure_column(conn, "events", "source", "TEXT NOT NULL DEFAULT 'game'")
        _ensure_column(conn, "events", "canonical", "INTEGER NOT NULL DEFAULT 1")
        _ensure_column(conn, "events", "message_id", "TEXT")
        _ensure_column(conn, "quests", "campaign_id", "TEXT NOT NULL DEFAULT 'legacy'")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_message_type "
            "ON events(message_id, event_type) WHERE message_id IS NOT NULL"
        )
        conn.execute(
            "INSERT OR IGNORE INTO realm_meta(key, value) VALUES('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
        conn.execute(
            "UPDATE realm_meta SET value=? WHERE key='schema_version'",
            (str(SCHEMA_VERSION),),
        )
        conn.execute(
            "INSERT OR IGNORE INTO realm_meta(key, value) VALUES('current_campaign_id', 'legacy')"
        )
        conn.execute(
            "INSERT OR IGNORE INTO campaigns(campaign_id, name, status, started_at) "
            "VALUES('legacy', 'Original Chronicle', 'active', ?)",
            (_now(),),
        )
    # sqlite3's context manager commits the transaction but does NOT close the
    # connection, so every call to init_db() leaked one open handle until the
    # object was garbage collected. Harmless in a long-lived bot, not harmless
    # on Windows, where the open handle stops the containing folder being
    # removed -- which is how it was found, as test scratch directories that
    # would not delete.
    conn.close()
    _INITIALIZED.add(DB_FILE)
    print(f"[WorldDB] Database initialised at {DB_FILE}")


def seed_realm():
    """Seed the established map for a live game; tests can keep empty worlds."""
    with get_db() as conn:
        _seed_realm(conn)
        conn.commit()


# ===========================================================================
# CAMPAIGN + DISCORD TURN AUTHORITY
# ===========================================================================

def current_campaign_id(conn=None):
    owns = conn is None
    conn = conn or get_db()
    try:
        row = conn.execute(
            "SELECT value FROM realm_meta WHERE key='current_campaign_id'"
        ).fetchone()
        return str(row[0]) if row else "legacy"
    finally:
        if owns:
            conn.close()


def load_discord_runtime(fallback_state, fallback_roster, include_revision=False):
    """Load the current campaign snapshot, migrating legacy JSON once."""
    init_db()
    with get_db() as conn:
        campaign_id = current_campaign_id(conn)
        row = conn.execute(
            "SELECT state_json, roster_json, revision FROM discord_runtime WHERE campaign_id=?",
            (campaign_id,),
        ).fetchone()
        if row:
            state = json.loads(row["state_json"])
            roster = json.loads(row["roster_json"])
            revision = int(row["revision"])
        else:
            state = dict(fallback_state)
            roster = dict(fallback_roster)
            roster_turns = sum(int(member.get("turns_taken", 0) or 0) for member in roster.values())
            state["total_turns"] = max(int(state.get("total_turns", 0) or 0), roster_turns)
            state["turn_count"] = state["total_turns"]
            state["campaign_id"] = campaign_id
            conn.execute(
                "INSERT INTO discord_runtime(campaign_id, state_json, roster_json, revision, updated_at) "
                "VALUES(?, ?, ?, 0, ?)",
                (campaign_id, json.dumps(state), json.dumps(roster), _now()),
            )
            revision = 0
        conn.commit()
    return (state, roster, revision) if include_revision else (state, roster)


def save_discord_runtime(state, roster, expected_revision=None):
    """Persist a non-turn mutation such as join, revive, or memory compaction."""
    campaign_id = state.get("campaign_id") or current_campaign_id()
    state["campaign_id"] = campaign_id
    with get_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT revision FROM discord_runtime WHERE campaign_id=?", (campaign_id,)
        ).fetchone()
        current_revision = int(row["revision"]) if row else 0
        if expected_revision is not None and current_revision != int(expected_revision):
            conn.rollback()
            raise RevisionConflictError(
                f"World revision changed from {expected_revision} to {current_revision}"
            )
        next_revision = current_revision + 1
        conn.execute(
            """INSERT INTO discord_runtime(campaign_id, state_json, roster_json, revision, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(campaign_id) DO UPDATE SET
                 state_json=excluded.state_json, roster_json=excluded.roster_json,
                 revision=excluded.revision, updated_at=excluded.updated_at""",
            (campaign_id, json.dumps(state), json.dumps(roster), next_revision, _now()),
        )
        conn.commit()
    return next_revision


def begin_discord_turn(message_id, discord_id, actor_name, action, intent):
    """Reserve a Discord message exactly once before any mechanics run."""
    init_db()
    now = _now()
    with get_db() as conn:
        existing = conn.execute(
            "SELECT * FROM discord_turns WHERE message_id=?", (str(message_id),)
        ).fetchone()
        if existing:
            return False, dict(existing)
        conn.execute(
            """INSERT INTO discord_turns
               (message_id, campaign_id, discord_id, actor_name, action, intent,
                status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?)""",
            (
                str(message_id), current_campaign_id(conn), str(discord_id),
                actor_name, action, intent, now, now,
            ),
        )
        conn.commit()
    return True, None


def fail_discord_turn(message_id, error):
    with get_db() as conn:
        conn.execute(
            "UPDATE discord_turns SET status='failed', error=?, updated_at=? "
            "WHERE message_id=? AND status='processing'",
            (str(error)[:1000], _now(), str(message_id)),
        )
        conn.commit()


def _insert_event(conn, campaign_id, message_id, event_type, description,
                  participants, location, importance):
    conn.execute(
        """INSERT OR IGNORE INTO events
           (event_type, participants, description, location, importance, timestamp,
            is_embedded, campaign_id, source, canonical, message_id)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'discord', 1, ?)""",
        (
            event_type, json.dumps(participants or []), description,
            location, max(1, min(10, int(importance))), _now(),
            campaign_id, str(message_id),
        ),
    )


def commit_discord_turn(message_id, state, roster, response, combat_event,
                        actor_id, actor_name, action, intent, extra_events=None,
                        expected_revision=None):
    """Atomically save mechanics, roster, player sheet, and canonical events."""
    campaign_id = state.get("campaign_id") or current_campaign_id()
    state["campaign_id"] = campaign_id
    location = state.get("location", "The Wildlands")
    now = _now()
    with get_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        turn = conn.execute(
            "SELECT status FROM discord_turns WHERE message_id=?", (str(message_id),)
        ).fetchone()
        if not turn:
            raise RuntimeError("Discord turn was not reserved")
        if turn["status"] in ("saved", "sent"):
            conn.rollback()
            return False

        runtime = conn.execute(
            "SELECT revision FROM discord_runtime WHERE campaign_id=?", (campaign_id,)
        ).fetchone()
        current_revision = int(runtime["revision"]) if runtime else 0
        if expected_revision is not None and current_revision != int(expected_revision):
            conn.rollback()
            raise RevisionConflictError(
                f"World revision changed from {expected_revision} to {current_revision}"
            )
        next_revision = current_revision + 1

        conn.execute(
            """INSERT INTO discord_runtime(campaign_id, state_json, roster_json, revision, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(campaign_id) DO UPDATE SET
                 state_json=excluded.state_json,
                 roster_json=excluded.roster_json,
                 revision=excluded.revision,
                 updated_at=excluded.updated_at""",
            (campaign_id, json.dumps(state), json.dumps(roster), next_revision, now),
        )

        for uid, member in roster.items():
            stats = member.get("stats", {})
            conn.execute(
                """INSERT INTO players
                   (discord_id, name, character_name, class, level, xp, hp_current,
                    hp_max, gold, location, reputation_hero, reputation_crime,
                    kills, deaths, turns_taken, inventory, known_lore, created_at, last_seen)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
                   ON CONFLICT(discord_id) DO UPDATE SET
                    name=excluded.name, character_name=excluded.character_name,
                    class=excluded.class, level=excluded.level, xp=excluded.xp,
                    hp_current=excluded.hp_current, hp_max=excluded.hp_max,
                    gold=excluded.gold, location=excluded.location,
                    reputation_hero=excluded.reputation_hero,
                    reputation_crime=excluded.reputation_crime,
                    kills=excluded.kills, deaths=excluded.deaths,
                    turns_taken=excluded.turns_taken, inventory=excluded.inventory,
                    last_seen=excluded.last_seen""",
                (
                    str(uid), member.get("name", "Adventurer"),
                    stats.get("character_name") or member.get("name", "Adventurer"),
                    stats.get("player_class", "warrior"), stats.get("level", 1),
                    stats.get("xp", 0), stats.get("current_hp", 30),
                    stats.get("max_hp", 30), stats.get("gold", 10),
                    stats.get("location", location), stats.get("reputation_hero", 0),
                    stats.get("reputation_crime", 0), member.get("kills", 0),
                    member.get("deaths", 0), member.get("turns_taken", 0),
                    json.dumps(stats.get("inventory", [])), now, now,
                ),
            )

        importance = 5 if combat_event.get("combat_started") else 2
        if combat_event.get("enemy_defeated"):
            importance = 7
        if combat_event.get("player_died"):
            importance = 8
        _insert_event(
            conn, campaign_id, message_id, "player_action",
            f"{actor_name}: {action[:240]}", [actor_name], location, importance,
        )
        if combat_event.get("enemy_defeated"):
            _insert_event(
                conn, campaign_id, message_id, "battle",
                f"{actor_name} defeated {combat_event.get('enemy_name', 'an enemy')} at {location}.",
                [actor_name], location, 7,
            )
        if combat_event.get("player_died"):
            _insert_event(
                conn, campaign_id, message_id, "death",
                f"{actor_name} fell in combat at {location}.", [actor_name], location, 8,
            )
        for item in extra_events or []:
            _insert_event(
                conn, campaign_id, message_id, item.get("type", "world_action"),
                item["description"], item.get("participants", [actor_name]),
                item.get("location", location), item.get("importance", 3),
            )

        conn.execute(
            """UPDATE discord_turns SET status='saved', response=?, event_json=?,
               updated_at=? WHERE message_id=?""",
            (response, json.dumps(combat_event), now, str(message_id)),
        )
        conn.commit()
    return next_revision


def mark_discord_turn_sent(message_id):
    with get_db() as conn:
        now = _now()
        conn.execute(
            "UPDATE discord_turns SET status='sent', sent_at=?, updated_at=? WHERE message_id=?",
            (now, now, str(message_id)),
        )
        conn.commit()


def start_new_campaign(name="A New Age", state=None, roster=None):
    """Archive the current campaign and switch to a fresh, isolated one."""
    init_db()
    campaign_id = uuid.uuid4().hex
    now = _now()
    with get_db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        old = current_campaign_id(conn)
        conn.execute(
            "UPDATE campaigns SET status='archived', ended_at=? WHERE campaign_id=?",
            (now, old),
        )
        conn.execute(
            "INSERT INTO campaigns(campaign_id, name, status, started_at) VALUES(?, ?, 'active', ?)",
            (campaign_id, name, now),
        )
        conn.execute(
            "UPDATE realm_meta SET value=? WHERE key='current_campaign_id'",
            (campaign_id,),
        )
        if state is not None and roster is not None:
            state["campaign_id"] = campaign_id
            conn.execute(
                "INSERT INTO discord_runtime(campaign_id, state_json, roster_json, revision, updated_at) "
                "VALUES(?, ?, ?, 1, ?)",
                (campaign_id, json.dumps(state), json.dumps(roster), now),
            )
        conn.commit()
    return campaign_id


def get_claims(limit=20, campaign_id=None):
    campaign_id = campaign_id or current_campaign_id()
    with get_db() as conn:
        return [dict(row) for row in conn.execute(
            "SELECT * FROM claims WHERE campaign_id=? ORDER BY claim_id DESC LIMIT ?",
            (campaign_id, limit),
        ).fetchall()]


def record_claim(source, description, participants=None, location="",
                 claim_type="statement", confidence=0.5):
    """Record something said or model-extracted without declaring it fact."""
    text = str(description or "").strip()
    if not text:
        return None
    with get_db() as conn:
        cursor = conn.execute(
            """INSERT INTO claims
               (campaign_id, source, claim_type, participants, description,
                location, confidence, status, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'unverified', ?)""",
            (
                current_campaign_id(conn), str(source)[:40], str(claim_type)[:40],
                json.dumps(participants or []), text[:1000], str(location)[:120],
                max(0.0, min(1.0, float(confidence))), _now(),
            ),
        )
        conn.commit()
        return cursor.lastrowid


# ===========================================================================
# PLAYER OPERATIONS
# ===========================================================================

def get_player(discord_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM players WHERE discord_id = ?", (str(discord_id),)
        ).fetchone()
        return dict(row) if row else None


def upsert_player(discord_id, name, **kwargs):
    """Create or update a player record. Only passed kwargs are updated."""
    _validated_fields(kwargs, PLAYER_COLUMNS, "player")
    with get_db() as conn:
        existing = conn.execute(
            "SELECT discord_id FROM players WHERE discord_id = ?", (str(discord_id),)
        ).fetchone()
        if existing:
            if kwargs:
                sets = ", ".join(f"{k}=?" for k in kwargs)
                vals = list(kwargs.values()) + [str(discord_id)]
                conn.execute(f"UPDATE players SET {sets} WHERE discord_id=?", vals)
                conn.execute(
                    "UPDATE players SET last_seen=? WHERE discord_id=?",
                    (_now(), str(discord_id))
                )
        else:
            defaults = {
                "name": name, "character_name": name, "class": "warrior",
                "race": "Human", "level": 1, "xp": 0,
                "hp_current": 30, "hp_max": 30, "gold": 10,
                "location": "the Wildlands", "inventory": "[]",
                "known_lore": "[]", "created_at": _now(), "last_seen": _now()
            }
            defaults.update(kwargs)
            cols = ", ".join(defaults.keys())
            placeholders = ", ".join("?" * len(defaults))
            conn.execute(
                f"INSERT INTO players (discord_id, {cols}) VALUES (?, {placeholders})",
                [str(discord_id)] + list(defaults.values())
            )
    conn.commit()


def get_all_players():
    with get_db() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM players").fetchall()]


def add_inventory_item(discord_id, item):
    p = get_player(discord_id)
    if not p:
        return
    inv = json.loads(p.get("inventory", "[]"))
    inv.append(item)
    upsert_player(discord_id, p["name"], inventory=json.dumps(inv))


def remove_inventory_item(discord_id, item):
    p = get_player(discord_id)
    if not p:
        return False
    inv = json.loads(p.get("inventory", "[]"))
    if item in inv:
        inv.remove(item)
        upsert_player(discord_id, p["name"], inventory=json.dumps(inv))
        return True
    return False


# ===========================================================================
# NPC OPERATIONS
# ===========================================================================

def get_npc(name_or_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM npcs WHERE npc_id=? OR name=?",
            (name_or_id, name_or_id)
        ).fetchone()
        return dict(row) if row else None


def upsert_npc(npc_id, name, **kwargs):
    _validated_fields(kwargs, NPC_COLUMNS, "NPC")
    with get_db() as conn:
        existing = conn.execute(
            "SELECT npc_id FROM npcs WHERE npc_id=?", (npc_id,)
        ).fetchone()
        if existing:
            if kwargs:
                sets = ", ".join(f"{k}=?" for k in kwargs)
                vals = list(kwargs.values()) + [npc_id]
                conn.execute(f"UPDATE npcs SET {sets} WHERE npc_id=?", vals)
        else:
            defaults = {
                "name": name, "occupation": "unknown", "faction": "",
                "home_location": "unknown", "current_location": "unknown",
                "personality": "neutral", "current_mood": "neutral",
                "is_alive": 1, "relationships": "{}", "memories": "[]",
                "secrets": "[]", "created_at": _now()
            }
            defaults.update(kwargs)
            cols = ", ".join(defaults.keys())
            phs  = ", ".join("?" * len(defaults))
            conn.execute(
                f"INSERT INTO npcs (npc_id, {cols}) VALUES (?, {phs})",
                [npc_id] + list(defaults.values())
            )
    conn.commit()


def add_npc_memory(npc_id, memory_text, max_memories=20):
    npc = get_npc(npc_id)
    if not npc:
        return
    memories = json.loads(npc.get("memories", "[]"))
    memories.append({"text": memory_text, "timestamp": _now()})
    memories = memories[-max_memories:]
    upsert_npc(npc_id, npc["name"], memories=json.dumps(memories))


def update_npc_relationship(npc_id, player_name, delta):
    npc = get_npc(npc_id)
    if not npc:
        return
    rels = json.loads(npc.get("relationships", "{}"))
    current = rels.get(player_name, 0)
    rels[player_name] = max(-100, min(100, current + delta))
    upsert_npc(npc_id, npc["name"], relationships=json.dumps(rels))


def get_all_npcs():
    with get_db() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM npcs").fetchall()]


# ===========================================================================
# LOCATION OPERATIONS
# ===========================================================================

def get_location(location_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM locations WHERE location_id=? OR name=?",
            (location_id, location_id)
        ).fetchone()
        return dict(row) if row else None


def upsert_location(location_id, name, **kwargs):
    _validated_fields(kwargs, LOCATION_COLUMNS, "location")
    with get_db() as conn:
        existing = conn.execute(
            "SELECT location_id FROM locations WHERE location_id=?", (location_id,)
        ).fetchone()
        if existing:
            if kwargs:
                sets = ", ".join(f"{k}=?" for k in kwargs)
                vals = list(kwargs.values()) + [location_id]
                conn.execute(f"UPDATE locations SET {sets} WHERE location_id=?", vals)
        else:
            defaults = {
                "name": name, "type": "wilderness", "kingdom": "Unknown",
                "population": 0, "leader": "", "faction": "",
                "description": "", "connected_to": "[]",
                "resources": "{}", "threats": "[]",
                "created_at": _now()
            }
            defaults.update(kwargs)
            cols = ", ".join(defaults.keys())
            phs  = ", ".join("?" * len(defaults))
            conn.execute(
                f"INSERT INTO locations (location_id, {cols}) VALUES (?, {phs})",
                [location_id] + list(defaults.values())
            )
    conn.commit()


# ===========================================================================
# QUEST OPERATIONS
# ===========================================================================

def create_quest(quest_id, name, description, quest_giver="", location="", **kwargs):
    _validated_fields(kwargs, QUEST_COLUMNS, "quest")
    with get_db() as conn:
        campaign_id = current_campaign_id(conn)
        storage_id = quest_id if campaign_id == "legacy" else f"{campaign_id}:{quest_id}"
        conn.execute(
            """INSERT OR IGNORE INTO quests
               (quest_id, name, description, quest_giver, location,
                status, participants, objectives, rewards, created_at, campaign_id)
               VALUES (?, ?, ?, ?, ?, 'active', '[]', '[]', '{}', ?, ?)""",
            (storage_id, name, description, quest_giver, location, _now(), campaign_id)
        )
        if kwargs:
            sets = ", ".join(f"{k}=?" for k in kwargs)
            vals = list(kwargs.values()) + [storage_id]
            conn.execute(f"UPDATE quests SET {sets} WHERE quest_id=?", vals)
        conn.commit()


def get_quest(quest_id):
    with get_db() as conn:
        campaign_id = current_campaign_id(conn)
        storage_id = quest_id if campaign_id == "legacy" else f"{campaign_id}:{quest_id}"
        row = conn.execute(
            "SELECT * FROM quests WHERE campaign_id=? AND (quest_id=? OR name=?)",
            (campaign_id, storage_id, quest_id)
        ).fetchone()
        return dict(row) if row else None


def complete_quest(quest_id):
    with get_db() as conn:
        campaign_id = current_campaign_id(conn)
        storage_id = quest_id if campaign_id == "legacy" else f"{campaign_id}:{quest_id}"
        conn.execute(
            "UPDATE quests SET status='completed', completed_at=? WHERE quest_id=? AND campaign_id=?",
            (_now(), storage_id, campaign_id)
        )
        conn.commit()


def get_active_quests():
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM quests WHERE status='active' AND campaign_id=?",
            (current_campaign_id(conn),)
        ).fetchall()]


# ===========================================================================
# EVENT LOG
# ===========================================================================

def log_event(event_type, description, participants=None, location="", importance=1):
    """
    Log any meaningful game event.
    importance 1-3 = minor, 4-6 = notable, 7-9 = major, 10 = legendary
    Events with importance >= 5 get embedded in the vector database automatically.
    """
    with get_db() as conn:
        cursor = conn.execute(
            """INSERT INTO events
               (event_type, participants, description, location, importance, timestamp,
                is_embedded, campaign_id, source, canonical)
               VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'game', 1)""",
            (
                event_type,
                json.dumps(participants or []),
                description,
                location,
                max(1, min(10, importance)),
                _now(),
                current_campaign_id(conn),
            )
        )
        event_id = cursor.lastrowid
        conn.commit()
    return event_id


def get_recent_events(limit=20, min_importance=1):
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM events WHERE importance >= ? AND canonical=1 AND campaign_id=? "
            "ORDER BY event_id DESC LIMIT ?",
            (min_importance, current_campaign_id(conn), limit)
        ).fetchall()]


def get_unembedded_events():
    """Events that haven't been put into the vector database yet."""
    with get_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM events WHERE is_embedded=0 AND importance >= 4 "
            "AND canonical=1 AND campaign_id=?",
            (current_campaign_id(conn),)
        ).fetchall()]


def mark_event_embedded(event_id):
    with get_db() as conn:
        conn.execute(
            "UPDATE events SET is_embedded=1 WHERE event_id=?", (event_id,)
        )
        conn.commit()


# ===========================================================================
# RELATIONSHIPS
# ===========================================================================

def get_relationship(entity_a, entity_b):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM relationships WHERE (entity_a=? AND entity_b=?) OR (entity_a=? AND entity_b=?)",
            (entity_a, entity_b, entity_b, entity_a)
        ).fetchone()
        return dict(row) if row else None


def set_relationship(entity_a, entity_b, rel_type, score_delta=0, note=""):
    existing = get_relationship(entity_a, entity_b)
    with get_db() as conn:
        if existing:
            new_score = max(-100, min(100, existing["score"] + score_delta))
            conn.execute(
                """UPDATE relationships SET score=?, notes=?, last_updated=?
                   WHERE (entity_a=? AND entity_b=?) OR (entity_a=? AND entity_b=?)""",
                (new_score, note, _now(), entity_a, entity_b, entity_b, entity_a)
            )
        else:
            conn.execute(
                """INSERT INTO relationships
                   (entity_a, entity_b, rel_type, score, notes, last_updated)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (entity_a, entity_b, rel_type, max(-100, min(100, score_delta)),
                 note, _now())
            )
        conn.commit()


# ===========================================================================
# CONTEXT BUILDER
# ===========================================================================

def build_world_context(player_names, location=""):
    """
    Builds a compact world-state summary for injection into the AI prompt.
    This is what the game engine knows for certain -- facts, not guesses.
    """
    lines = []

    # Active players
    players_data = []
    for name in player_names:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT * FROM players WHERE name=? OR character_name=?",
                (name, name)
            ).fetchall()
        for r in rows:
            p = dict(r)
            inv = json.loads(p.get("inventory", "[]"))
            players_data.append(
                f"  {p['name']} ({p.get('class','?')} Lv{p['level']}) "
                f"HP:{p['hp_current']}/{p['hp_max']} "
                f"Gold:{p.get('gold',0)} "
                f"Loc:{p.get('location','?')}"
            )
    if players_data:
        lines.append("PARTY:\n" + "\n".join(players_data))

    # Current location
    if location:
        loc = get_location(location)
        if loc:
            lines.append(
                f"LOCATION: {loc['name']} ({loc.get('type','?')}) "
                f"Pop:{loc.get('population',0)} Leader:{loc.get('leader','?')} "
                f"Faction:{loc.get('faction','none')}"
            )

    # Active quests
    quests = get_active_quests()
    if quests:
        q_lines = [f"  - {q['name']}: {q.get('description','')[:60]}" for q in quests[:3]]
        lines.append("ACTIVE QUESTS:\n" + "\n".join(q_lines))

    # Recent notable events
    events = get_recent_events(limit=5, min_importance=5)
    if events:
        e_lines = [f"  - {e['description'][:80]}" for e in events]
        lines.append("RECENT EVENTS:\n" + "\n".join(e_lines))

    return "\n\n".join(lines)


if __name__ == "__main__":
    init_db()
    print("[WorldDB] Schema ready.")
