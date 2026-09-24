import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { executeWorldCommand, WorldCommandError, type WorldCommandType } from "../server/orion/world-command.ts";

const SOURCE = process.env.REALM_ROOT || "C:/Wommper1/AlexAIHub/projects/king_orions_realm";
const MODULES = ["combat_engine.py", "items.py", "party_manager.py", "quest_log.py", "world_rules.py", "world_db.py"];

function readRuntime(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT state_json, roster_json, revision FROM discord_runtime LIMIT 1").get() as Record<string, unknown>;
    return {
      state: JSON.parse(String(row.state_json)) as Record<string, unknown>,
      roster: JSON.parse(String(row.roster_json)) as Record<string, Record<string, unknown>>,
      revision: Number(row.revision),
    };
  } finally {
    db.close();
  }
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "orion-engine-"));
  const sourceDb = new DatabaseSync(path.join(SOURCE, "world.db"), { readOnly: true });
  try {
    for (const file of MODULES) fs.copyFileSync(path.join(SOURCE, file), path.join(scratch, file));
    await backup(sourceDb, path.join(scratch, "world.db"));
  } finally {
    sourceDb.close();
  }

  let runtime = readRuntime(path.join(scratch, "world.db"));
  const actorId = Object.keys(runtime.roster)[0];
  if (!actorId) throw new Error("Smoke world has no player.");
  let sequence = 0;

  const command = async (type: WorldCommandType, payload: Record<string, unknown> = {}, id?: string) => {
    const commandId = id ?? `engine-smoke-${String(++sequence).padStart(4, "0")}`;
    const result = await executeWorldCommand(scratch, {
      id: commandId,
      actorId,
      type,
      expectedRevision: runtime.revision,
      payload,
    });
    runtime = readRuntime(path.join(scratch, "world.db"));
    if (runtime.revision !== result.revision) throw new Error(`Revision mismatch after ${type}.`);
    return result;
  };

  let conflict = false;
  let conflictDetail = "no error";
  try {
    await executeWorldCommand(scratch, {
      id: "engine-smoke-stale",
      actorId,
      type: "rest",
      expectedRevision: runtime.revision + 99,
      payload: {},
    });
  } catch (error) {
    conflict = error instanceof WorldCommandError && error.code === "revision_conflict";
    conflictDetail = error instanceof Error ? `${error.name}: ${error.message} ${(error as WorldCommandError).code ?? ""}` : String(error);
  }
  if (!conflict) throw new Error(`A stale command was not rejected: ${conflictDetail}`);

  const travelId = "engine-smoke-travel";
  const travelRevision = runtime.revision;
  const travel = await command("travel", { destination: "Brindlemark" }, travelId);
  const duplicate = await executeWorldCommand(scratch, {
    id: travelId,
    actorId,
    type: "travel",
    expectedRevision: travelRevision,
    payload: { destination: "Brindlemark" },
  });
  const afterDuplicate = readRuntime(path.join(scratch, "world.db"));
  if (!duplicate.duplicate || afterDuplicate.revision !== travel.revision) {
    throw new Error("Duplicate command changed the world twice.");
  }

  await command("investigate", { target: "Brindlemark forge" });
  await command("talk", { target: "Griselda" });
  await command("help", { target: "a stranded cart" });
  await command("crime", { target: "the toll box" });
  await command("buy", { item: "Health Potion" });
  await command("hunt");

  let attacks = 0;
  let revives = 0;
  while (attacks < 80) {
    runtime = readRuntime(path.join(scratch, "world.db"));
    const member = runtime.roster[actorId];
    if (member.is_fallen) {
      await command("revive");
      revives++;
      continue;
    }
    const result = await command(attacks === 1 ? "defend" : "attack");
    attacks++;
    if ((result.combat as Record<string, unknown>).enemy_defeated) break;
    const hp = Number((runtime.roster[actorId].stats as Record<string, unknown>).current_hp ?? 0);
    if (hp > 0 && hp < 18 && ((runtime.roster[actorId].stats as Record<string, unknown>).inventory as unknown[]).some(
      (item) => String(item).toLowerCase().includes("health potion"),
    )) {
      await command("use", { item: "Health Potion" });
    }
  }

  const db = new DatabaseSync(path.join(scratch, "world.db"), { readOnly: true });
  try {
    const completed = db.prepare("SELECT status FROM quests WHERE quest_id='bandit_king_bounty'").get() as
      | Record<string, unknown>
      | undefined;
    const turns = db.prepare("SELECT COUNT(*) AS count FROM discord_turns WHERE message_id LIKE 'engine-smoke-%' AND status='saved'").get() as Record<string, unknown>;
    const canonical = db.prepare("SELECT COUNT(*) AS count FROM events WHERE message_id LIKE 'engine-smoke-%' AND canonical=1").get() as Record<string, unknown>;
    if (completed?.status !== "completed") throw new Error("Boss quest did not complete.");
    console.log(JSON.stringify({
      ok: true,
      scratch,
      finalRevision: runtime.revision,
      attacks,
      revives,
      savedCommands: Number(turns.count),
      canonicalEvents: Number(canonical.count),
      quest: completed.status,
    }, null, 2));
  } finally {
    db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
