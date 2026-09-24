"""Atomic command bridge for the shared King Orion realm.

The HTTP server owns authentication and request limits. This process owns one
short SQLite write transaction and delegates mechanics to the Discord game's
existing deterministic Python modules. It never calls an LLM.
"""

from __future__ import annotations

import json
import random
import re
import sqlite3
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat()


def empty_combat_event():
    return {
        "combat_started": False,
        "combat_ended": False,
        "enemy_defeated": False,
        "player_fled": False,
        "player_died": False,
        "player_damage_taken": 0,
        "player_damage_dealt": 0,
        "player_crit": False,
        "enemy_key": None,
        "enemy_name": None,
        "gold_gained": 0,
        "loot": [],
        "boss_defeated": False,
        "boss_title": None,
    }


def result_error(command, code, message, revision=0):
    return {
        "ok": False,
        "duplicate": False,
        "commandId": str(command.get("id", "")),
        "campaignId": "",
        "revision": int(revision),
        "action": str(command.get("type", "travel")),
        "message": message,
        "combat": {},
        "events": [],
        "error": message,
        "code": code,
    }


def clean_text(value, maximum=160):
    return str(value or "").strip()[:maximum]


def insert_event(conn, campaign_id, command_id, event_type, description,
                 participants, location, importance):
    conn.execute(
        """INSERT OR IGNORE INTO events
           (event_type, participants, description, location, importance,
            timestamp, is_embedded, campaign_id, source, canonical, message_id)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'engine', 1, ?)""",
        (
            event_type,
            json.dumps(participants or []),
            clean_text(description, 1000),
            clean_text(location, 120),
            max(1, min(10, int(importance))),
            now(),
            campaign_id,
            command_id,
        ),
    )


def upsert_players(conn, roster, location, timestamp):
    for uid, member in roster.items():
        stats = member.get("stats", {})
        conn.execute(
            """INSERT INTO players
               (discord_id, name, character_name, class, level, xp, hp_current,
                hp_max, gold, location, reputation_hero, reputation_crime,
                kills, deaths, turns_taken, inventory, known_lore, created_at,
                last_seen)
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
                json.dumps(stats.get("inventory", [])), timestamp, timestamp,
            ),
        )


def sync_legacy_state(state, roster):
    if not roster:
        return
    lead = next(iter(roster.values())).get("stats", {})
    for key in (
        "level", "xp", "max_hp", "current_hp", "player_class", "attack_bonus",
        "gold", "inventory", "equipped_weapon", "equipped_armor", "known_spells",
    ):
        if key in lead:
            state[key] = lead[key]
    state["turn_count"] = state.get("total_turns", 0)


def level_up(actor):
    levels = []
    while actor.get("xp", 0) >= actor.get("level", 1) * 50:
        needed = actor.get("level", 1) * 50
        actor["xp"] -= needed
        actor["level"] = actor.get("level", 1) + 1
        actor["max_hp"] = actor.get("max_hp", 30) + 5
        actor["current_hp"] = actor["max_hp"]
        levels.append(actor["level"])
    return levels


def expand_inventory_stacks(actor, catalog):
    expanded = []
    for owned in actor.get("inventory", []):
        match = re.match(r"^\s*(\d+)x\s+(.+?)\s*$", str(owned), re.IGNORECASE)
        if match and match.group(2) in catalog:
            expanded.extend([match.group(2)] * max(1, min(99, int(match.group(1)))))
        else:
            expanded.append(owned)
    actor["inventory"] = expanded


def active_boss_quest(conn, campaign_id):
    rows = conn.execute(
        "SELECT * FROM quests WHERE campaign_id=? AND status='active' ORDER BY rowid",
        (campaign_id,),
    ).fetchall()
    for row in rows:
        try:
            objective = json.loads(row["objectives"] or "{}")
        except (TypeError, ValueError):
            objective = {}
        if objective.get("boss_key"):
            return dict(row), str(objective["boss_key"])
    return None, None


def complete_boss_quest(conn, campaign_id, enemy_key, chain):
    quest, boss_key = active_boss_quest(conn, campaign_id)
    if not quest or boss_key != enemy_key:
        return []
    timestamp = now()
    conn.execute(
        "UPDATE quests SET status='completed', completed_at=? WHERE quest_id=? AND campaign_id=?",
        (timestamp, quest["quest_id"], campaign_id),
    )
    events = [{
        "type": "quest",
        "description": f"Quest complete: {quest['name']}.",
        "importance": 8,
    }]
    ids = [entry[0] for entry in chain]
    if quest["quest_id"] in ids:
        index = ids.index(quest["quest_id"])
        if index + 1 < len(chain):
            quest_id, name, description, next_boss = chain[index + 1]
            conn.execute(
                """INSERT OR IGNORE INTO quests
                   (quest_id, name, description, status, objectives, campaign_id, created_at)
                   VALUES (?, ?, ?, 'active', ?, ?, ?)""",
                (quest_id, name, description, json.dumps({"boss_key": next_boss}), campaign_id, timestamp),
            )
            events.append({
                "type": "quest",
                "description": f"New quest: {name}.",
                "importance": 6,
            })
    return events


def run_engine(request):
    realm_root = Path(request["realmRoot"]).resolve()
    db_path = Path(request["dbPath"]).resolve()
    if db_path.parent != realm_root and realm_root not in db_path.parents:
        return result_error(request.get("command", {}), "invalid_database", "Database path is outside the realm.")

    sys.path.insert(0, str(realm_root))
    import combat_engine
    import items
    import party_manager
    import quest_log
    import world_rules

    command = request["command"]
    command_id = command["id"]
    actor_id = str(command["actorId"])
    action_type = command["type"]
    expected_revision = int(command["expectedRevision"])
    payload = command.get("payload") or {}
    random.seed(f"{command_id}:{expected_revision}")

    conn = sqlite3.connect(str(db_path), timeout=8.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=8000")
    try:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            "SELECT * FROM discord_turns WHERE message_id=?", (command_id,)
        ).fetchone()
        if existing:
            if existing["status"] in ("saved", "sent"):
                saved = json.loads(existing["response"] or "{}")
                saved["duplicate"] = True
                conn.rollback()
                return saved
            conn.rollback()
            return result_error(command, "command_busy", "This command is already being processed.")

        campaign_row = conn.execute(
            "SELECT value FROM realm_meta WHERE key='current_campaign_id'"
        ).fetchone()
        campaign_id = str(campaign_row[0] if campaign_row else "legacy")
        runtime = conn.execute(
            "SELECT * FROM discord_runtime WHERE campaign_id=?", (campaign_id,)
        ).fetchone()
        if not runtime:
            conn.rollback()
            return result_error(command, "realm_unavailable", "No Discord runtime snapshot exists.")
        revision = int(runtime["revision"])
        if revision != expected_revision:
            conn.rollback()
            return result_error(
                command, "revision_conflict",
                f"World revision changed from {expected_revision} to {revision}.", revision,
            )

        state = json.loads(runtime["state_json"])
        roster = json.loads(runtime["roster_json"])
        if actor_id not in roster:
            conn.rollback()
            return result_error(command, "actor_not_found", "That player is not in the active party.", revision)

        member = roster[actor_id]
        actor = party_manager.player_state(roster, actor_id)
        actor_name = clean_text(member.get("name") or actor.get("character_name") or "Adventurer", 80)
        if member.get("is_fallen") and action_type != "revive":
            conn.rollback()
            return result_error(command, "actor_fallen", f"{actor_name} must revive before acting.", revision)

        combat = empty_combat_event()
        events = []
        message = ""
        location = state.get("location", actor.get("location", "The Wildlands"))

        if action_type == "travel":
            destination = clean_text(payload.get("destination"), 120)
            if not destination:
                raise ValueError("A travel destination is required.")
            _, facts, events = world_rules.apply_world_action(
                actor_name, f"travel to {destination}", actor, state, "travel"
            )
            message = facts.replace("[SYSTEM: ", "").replace("]", "") or "The party does not move."
            if state.get("location") != location:
                party_manager.set_party_location(roster, state["location"])

        elif action_type in ("attack", "defend", "flee"):
            text, combat = combat_engine.resolve_combat_turn(
                action_type, state, actor_state=actor, actor_name=actor_name, intent=action_type
            )
            message = combat_engine.describe_event(combat) or text.replace("[SYSTEM: ", "").replace("]", "")

        elif action_type == "hunt":
            if state.get("in_combat"):
                raise ValueError("Finish the current fight before hunting another enemy.")
            quest, boss_key = active_boss_quest(conn, campaign_id)
            if not boss_key:
                raise ValueError("No active quest has a hunt target.")
            message = combat_engine.start_boss_fight(
                state, boss_key, actor_state=actor, actor_name=actor_name
            ).replace("[SYSTEM: ", "").replace("]", "")
            combat["combat_started"] = True
            combat["enemy_key"] = boss_key
            combat["enemy_name"] = state.get("enemy", {}).get("name")
            events.append({
                "type": "quest",
                "description": f"{actor_name} set out to hunt {combat['enemy_name']}.",
                "location": location,
                "importance": 6,
            })

        elif action_type in ("use", "equip", "buy", "sell"):
            item_name = clean_text(payload.get("item"), 120)
            if not item_name:
                raise ValueError("An item name is required.")
            if action_type in ("buy", "sell") and state.get("in_combat"):
                raise ValueError("Trading is unavailable during combat.")
            expand_inventory_stacks(actor, items.ITEMS)
            operation = {
                "use": items.use_item,
                "equip": items.equip_item,
                "buy": items.buy_item,
                "sell": items.sell_item,
            }[action_type]
            ok, message = operation(actor, item_name)
            if not ok:
                raise ValueError(message)
            events.append({
                "type": "item",
                "description": f"{actor_name}: {message}",
                "location": location,
                "importance": 2,
            })
            if action_type == "use" and state.get("in_combat"):
                before = actor.get("current_hp", 0)
                retaliation = combat_engine.enemy_retaliate(state, actor, actor_name)
                combat["enemy_name"] = state.get("enemy", {}).get("name")
                combat["player_damage_taken"] = max(0, before - actor.get("current_hp", 0))
                combat["player_died"] = actor.get("current_hp", 0) <= 0
                if retaliation:
                    message += " " + retaliation.replace("[SYSTEM: ", "").replace("]", "")

        elif action_type in ("talk", "investigate", "help", "crime"):
            target = clean_text(payload.get("target"), 120) or "the surroundings"
            verbs = {"talk": "spoke with", "investigate": "investigated", "help": "aided", "crime": "wronged"}
            if action_type in ("help", "crime"):
                _, facts, world_events = world_rules.apply_world_action(
                    actor_name, f"{action_type} {target}", actor, state, action_type
                )
                events.extend(world_events)
                message = facts.replace("[SYSTEM: ", "").replace("]", "")
            else:
                message = f"{actor_name} {verbs[action_type]} {target} at {location}."
                events.append({
                    "type": action_type,
                    "description": message,
                    "location": location,
                    "importance": 2 if action_type == "talk" else 3,
                })
            if state.get("in_combat"):
                before = actor.get("current_hp", 0)
                text, combat = combat_engine.resolve_combat_turn(
                    action_type, state, actor_state=actor, actor_name=actor_name, intent="world"
                )
                combat_message = combat_engine.describe_event(combat) or text
                if combat_message:
                    message += " " + combat_message.replace("[SYSTEM: ", "").replace("]", "")
                combat["player_damage_taken"] = max(
                    combat.get("player_damage_taken", 0), before - actor.get("current_hp", 0)
                )

        elif action_type == "rest":
            if state.get("in_combat"):
                raise ValueError("The party cannot rest during combat.")
            before = actor.get("current_hp", 0)
            actor["current_hp"] = min(actor.get("max_hp", 30), before + 8)
            healed = actor["current_hp"] - before
            message = f"{actor_name} rests and recovers {healed} HP."
            events.append({"type": "rest", "description": message, "location": location, "importance": 1})

        elif action_type == "revive":
            if not member.get("is_fallen"):
                raise ValueError(f"{actor_name} is already standing.")
            party_manager.revive_member(roster, actor_id)
            actor = party_manager.player_state(roster, actor_id)
            actor["location"] = "The Great Hall"
            message = f"{actor_name} returns at The Great Hall with {actor['current_hp']} HP."
            events.append({"type": "revival", "description": message, "location": "The Great Hall", "importance": 5})

        if combat.get("enemy_defeated"):
            party_manager.record_kill(roster, actor_id)
            events.extend(complete_boss_quest(conn, campaign_id, combat.get("enemy_key"), quest_log.BOSS_CHAIN))
        if combat.get("player_died"):
            party_manager.mark_fallen(roster, actor_id)
            if all(entry.get("is_fallen") for entry in roster.values()):
                state["in_combat"] = False
                state["enemy"] = None

        levels = level_up(actor)
        for level in levels:
            events.append({
                "type": "level",
                "description": f"{actor_name} reached level {level}.",
                "location": state.get("location", location),
                "importance": 6,
            })
            message += f" Level up: {level}."

        party_manager.record_turn(roster, actor_id)
        state["total_turns"] = int(state.get("total_turns", 0) or 0) + 1
        state["turn_count"] = state["total_turns"]
        sync_legacy_state(state, roster)
        timestamp = now()
        next_revision = revision + 1

        conn.execute(
            """INSERT INTO discord_turns
               (message_id, campaign_id, discord_id, actor_name, action, intent,
                status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?)""",
            (command_id, campaign_id, actor_id, actor_name, json.dumps(payload), action_type, timestamp, timestamp),
        )
        conn.execute(
            """UPDATE discord_runtime SET state_json=?, roster_json=?, revision=?, updated_at=?
               WHERE campaign_id=? AND revision=?""",
            (json.dumps(state), json.dumps(roster), next_revision, timestamp, campaign_id, revision),
        )
        if conn.total_changes < 2:
            raise RuntimeError("World revision changed during commit.")

        action_importance = 5 if combat.get("combat_started") else 2
        if combat.get("enemy_defeated"):
            action_importance = 7
        if combat.get("player_died"):
            action_importance = 8
        insert_event(
            conn, campaign_id, command_id, "player_action",
            f"{actor_name}: {action_type}", [actor_name], state.get("location", location), action_importance,
        )
        if combat.get("enemy_defeated"):
            insert_event(
                conn, campaign_id, command_id, "battle",
                f"{actor_name} defeated {combat.get('enemy_name', 'an enemy')} at {state.get('location', location)}.",
                [actor_name], state.get("location", location), 7,
            )
        if combat.get("player_died"):
            insert_event(
                conn, campaign_id, command_id, "death",
                f"{actor_name} fell in combat at {state.get('location', location)}.",
                [actor_name], state.get("location", location), 8,
            )
        for event in events:
            insert_event(
                conn, campaign_id, command_id, event.get("type", "world_action"),
                event.get("description", message), event.get("participants", [actor_name]),
                event.get("location", state.get("location", location)), event.get("importance", 3),
            )

        response = {
            "ok": True,
            "duplicate": False,
            "commandId": command_id,
            "campaignId": campaign_id,
            "revision": next_revision,
            "action": action_type,
            "message": message or f"{actor_name} completes the action.",
            "combat": combat,
            "events": events,
        }
        conn.execute(
            """UPDATE discord_turns SET status='saved', response=?, event_json=?, updated_at=?
               WHERE message_id=?""",
            (json.dumps(response), json.dumps(combat), timestamp, command_id),
        )
        conn.commit()
        return response
    except ValueError as error:
        conn.rollback()
        return result_error(command, "rule_rejected", str(error), locals().get("revision", 0))
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def main():
    try:
        request = json.load(sys.stdin)
        print(json.dumps(run_engine(request), separators=(",", ":")))
    except Exception as error:
        command = locals().get("request", {}).get("command", {})
        response = result_error(command, "engine_failed", str(error))
        response["trace"] = traceback.format_exc(limit=4)
        print(json.dumps(response, separators=(",", ":")))


if __name__ == "__main__":
    main()
