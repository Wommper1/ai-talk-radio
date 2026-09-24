"""Focused proof for Discord/Godot optimistic concurrency."""

import os
import shutil
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
REALM = Path(os.environ.get("REALM_ROOT", "C:/Wommper1/AlexAIHub/projects/king_orions_realm"))
sys.path.insert(0, str(ROOT / "integrations" / "discord-sync"))
sys.path.insert(1, str(REALM))

import party_manager as pm
import world_db


def main():
    scratch = tempfile.mkdtemp(prefix="discord-sync-")
    world_db.DB_FILE = str(Path(scratch) / "world.db")
    world_db._INITIALIZED.clear()
    try:
        world_db.init_db()
        roster = {}
        pm.add_member(roster, "1", "Ashra")
        state = dict(pm.PARTY_DEFAULT_STATE)
        state, roster, revision = world_db.load_discord_runtime(
            state, roster, include_revision=True
        )
        assert revision == 0

        accepted, _ = world_db.begin_discord_turn(
            "sync-turn-1", "1", "Ashra", "look", "investigate"
        )
        assert accepted
        revision = world_db.commit_discord_turn(
            "sync-turn-1", state, roster, "Ashra looks around.", {},
            "1", "Ashra", "look", "investigate", [],
            expected_revision=revision,
        )
        assert revision == 1

        revision = world_db.save_discord_runtime(
            state, roster, expected_revision=revision
        )
        assert revision == 2

        try:
            world_db.save_discord_runtime(state, roster, expected_revision=1)
            raise AssertionError("stale save was accepted")
        except world_db.RevisionConflictError:
            pass

        world_db.begin_discord_turn(
            "sync-turn-2", "1", "Ashra", "attack", "attack"
        )
        revision = world_db.save_discord_runtime(
            state, roster, expected_revision=revision
        )
        try:
            world_db.commit_discord_turn(
                "sync-turn-2", state, roster, "stale result", {},
                "1", "Ashra", "attack", "attack", [],
                expected_revision=revision - 1,
            )
            raise AssertionError("stale Discord turn was accepted")
        except world_db.RevisionConflictError:
            world_db.fail_discord_turn("sync-turn-2", "world changed")

        _, _, final_revision = world_db.load_discord_runtime(
            {}, {}, include_revision=True
        )
        with world_db.get_db() as conn:
            failed = conn.execute(
                "SELECT status FROM discord_turns WHERE message_id='sync-turn-2'"
            ).fetchone()[0]
        assert final_revision == revision
        assert failed == "failed"
        print({
            "ok": True,
            "final_revision": final_revision,
            "stale_save_rejected": True,
            "stale_turn_rejected": True,
        })
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    main()
