/**
 * Writing unverified show claims back into the game.
 *
 * This is the half that matters: a broadcast the game never hears about is
 * just a podcast about a save file. When King Orion holds court and speaks of
 * a deed, that telling is saved as a claim the game can inspect without
 * silently turning something improvised on air into canonical history.
 *
 * It writes only to the schema-owned `claims` table. Nothing here creates or
 * migrates the game's database, and deleting this module leaves canonical
 * events untouched.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveRealm } from "./realm.ts";

/** One thing said on air that is worth the game knowing about. */
export interface Tale {
  /** The only part that is genuinely required: without it there is no tale. */
  description: string;
  /** Matches the game's own vocabulary: battle, death, milestone, and so on. */
  type?: string;
  participants?: string[];
  location?: string;
  /** 1-3 minor, 4-6 notable, 7-9 major, 10 legendary — the game's own scale. */
  importance?: number;
}

export interface ChronicleResult {
  written: number;
  /** Claim ids, so a write can be reviewed or removed afterwards. */
  ids: number[];
  error?: string;
}

/** The timestamp format the game writes: ISO 8601, UTC, with an offset. */
function now(): string {
  return new Date().toISOString().replace("Z", "+00:00");
}

/**
 * Write tales into the realm's chronicle.
 *
 * Refuses rather than guesses: no realm, no world.db, nothing to say, or the
 * switch turned off, and it does nothing at all and says so. A show is never
 * failed over this — the episode is already recorded either way.
 */
export function recordTales(configured: string, tales: Tale[]): ChronicleResult {
  if (tales.length === 0) return { written: 0, ids: [] };

  const root = resolveRealm(configured);
  if (!root) return { written: 0, ids: [], error: "The realm was not found, so nothing was written." };

  const dbPath = path.join(root, "world.db");
  if (!fs.existsSync(dbPath)) {
    return { written: 0, ids: [], error: "There is no world.db to write to." };
  }

  let db: DatabaseSync | null = null;

  try {
    db = new DatabaseSync(dbPath);

    // The game may be mid-turn. Wait for it rather than failing, and never
    // hold the database for longer than the inserts take.
    db.exec("PRAGMA busy_timeout = 4000");

    const claimsTable = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='claims'",
    ).get() as Record<string, unknown> | undefined;
    if (!claimsTable) {
      return {
        written: 0,
        ids: [],
        error: "The realm database needs the current game migration before radio claims can be saved.",
      };
    }

    const campaign = db.prepare("SELECT value FROM realm_meta WHERE key='current_campaign_id'").get() as
      | Record<string, unknown>
      | undefined;
    const campaignId = String(campaign?.value ?? "legacy");
    const insert = db.prepare(
      `INSERT INTO claims
         (campaign_id, source, claim_type, participants, description, location,
          confidence, status, timestamp)
       VALUES (?, 'radio', ?, ?, ?, ?, 0.5, 'unverified', ?)`,
    );

    const ids: number[] = [];

    // All of it or none of it: one broadcast should create one reviewable batch.
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const tale of tales) {
        // Every field is read defensively. This writes into somebody's save
        // and the whole batch is one transaction, so a single tale missing a
        // field used to throw, roll the lot back, and lose an entire show's
        // chronicle — over a missing `type`. The description is the only part
        // that is actually required; everything else has a sane default.
        const description = String(tale?.description ?? "").replace(/\s+/g, " ").trim().slice(0, 1000);
        if (!description) continue;

        const participants = Array.isArray(tale.participants) ? tale.participants : [];
        const result = insert.run(
          campaignId,
          String(tale.type ?? "").trim().slice(0, 40) || "statement",
          JSON.stringify(participants.slice(0, 12).map((p) => String(p).slice(0, 60))),
          description,
          String(tale.location ?? "").trim().slice(0, 120),
          now(),
        );
        ids.push(Number(result.lastInsertRowid));
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    return { written: ids.length, ids };
  } catch (err) {
    return { written: 0, ids: [], error: (err as Error).message };
  } finally {
    try {
      db?.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Remove tales this app wrote, by id.
 *
 * Here because a one-way write into somebody else's save is not a fair thing
 * to offer. Every broadcast reports the ids it added, and this takes them
 * straight back out.
 */
export function forgetTales(configured: string, ids: number[]): ChronicleResult {
  if (ids.length === 0) return { written: 0, ids: [] };

  const root = resolveRealm(configured);
  if (!root) return { written: 0, ids: [], error: "The realm was not found." };

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path.join(root, "world.db"));
    db.exec("PRAGMA busy_timeout = 4000");

    const remove = db.prepare("DELETE FROM claims WHERE claim_id = ? AND source = 'radio'");
    let removed = 0;
    for (const id of ids) {
      if (!Number.isInteger(id)) continue;
      removed += Number(remove.run(id).changes ?? 0);
    }

    return { written: removed, ids };
  } catch (err) {
    return { written: 0, ids: [], error: (err as Error).message };
  } finally {
    try {
      db?.close();
    } catch {
      /* already gone */
    }
  }
}
