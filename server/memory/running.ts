/**
 * The bits that survive the night.
 *
 * A show already notices its own running gags — the mixer keeps a rolling
 * digest with a `gags` list, and hosts are told about them so a joke set up in
 * turn four can be called back in turn twenty. Then the show ends and all of
 * it is thrown away. The next night the same two people meet for the first
 * time again, with no history and nothing to call back to, which is why every
 * episode reads like a pilot.
 *
 * This keeps them. Each lane — the radio station, or a particular king's court
 * — accumulates the gags and the established facts from its own shows, and the
 * next one opens knowing them.
 *
 * Two things it is deliberately not:
 *
 *   It is not the transcript. Long-term recall over past episodes already
 *   exists and works differently (retrieval.ts, BM25 over what was said). This
 *   is a short standing list of things that are *true between you*, which is a
 *   different thing and belongs in the prompt every turn rather than being
 *   searched for.
 *
 *   It is not the game's record. A court's lane holds what was said at court,
 *   never what happened in the realm — the chronicle owns that, and a running
 *   joke must never be able to contradict a deed.
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../lib/atomic-file.ts";

const RUNNING_PATH = path.join(process.cwd(), "memory", "running.json");

/** How much is kept, and how much of it a show is actually told about. */
const KEEP_GAGS = 14;
const KEEP_FACTS = 14;
const BRIEF_GAGS = 5;
const BRIEF_FACTS = 4;

interface Lane {
  /** Newest last. A gag that keeps recurring drifts to the end and survives. */
  gags: string[];
  facts: string[];
  shows: number;
  updated: string;
}

interface RunningFile {
  version: 2;
  lanes: Record<string, Lane>;
}

const EMPTY_LANE: Lane = { gags: [], facts: [], shows: 0, updated: "" };

/**
 * Which set of running bits a show belongs to.
 *
 * The station and a court are separate worlds and must never share: a joke
 * about self-checkout has no business in a king's hall, and a grudge about the
 * Wildlands has none on drive-time.
 */
export function laneFor(station: string, king?: string): string {
  const name = (king ? `court:${king}` : `station:${station}`).trim().toLowerCase();
  return name.replace(/\s+/g, " ").slice(0, 80);
}

function read(): RunningFile {
  try {
    const raw = JSON.parse(fs.readFileSync(RUNNING_PATH, "utf8")) as RunningFile;
    if (raw && raw.version === 2 && typeof raw === "object" && raw.lanes) return { version: 2, lanes: raw.lanes };
  } catch {
    // Nothing kept yet. Tonight everything is new, which is survivable.
  }
  return { version: 2, lanes: {} };
}

function write(file: RunningFile): void {
  try {
    atomicWriteJson(RUNNING_PATH, file);
  } catch {
    // Never fail a show over this.
  }
}

/** Trim, drop the useless, and keep the order stable. */
function tidy(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of items) {
    const clean = String(item ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    // Single words are not running gags, they are nouns.
    if (clean.length < 6 || !clean.includes(" ")) continue;

    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }

  return out;
}

export function get(lane: string): Lane {
  const found = read().lanes[lane];
  return found ? { ...EMPTY_LANE, ...found } : { ...EMPTY_LANE };
}

/**
 * Fold tonight's gags and facts into the lane.
 *
 * New material goes on the end, so a bit that recurs night after night keeps
 * being re-added and stays near the front of the queue, while a one-off from
 * eight shows ago quietly falls off. That is the behaviour wanted: the things
 * that actually stuck should be the things that survive.
 */
export function remember(lane: string, memory: { gags?: string[]; facts?: string[] }): void {
  const gags = tidy(memory.gags ?? []);
  const facts = tidy(memory.facts ?? []);
  if (gags.length === 0 && facts.length === 0) return;

  const file = read();
  const current: Lane = { ...EMPTY_LANE, ...(file.lanes[lane] ?? {}) };

  // Re-adding an existing item moves it to the end, which is what keeps a
  // recurring bit alive and lets a dead one age out.
  const merge = (existing: string[], fresh: string[], cap: number) => {
    const incoming = new Set(fresh.map((f) => f.toLowerCase()));
    return tidy([...existing.filter((e) => !incoming.has(e.toLowerCase())), ...fresh]).slice(-cap);
  };

  file.lanes[lane] = {
    gags: merge(current.gags, gags, KEEP_GAGS),
    facts: merge(current.facts, facts, KEEP_FACTS),
    shows: current.shows + 1,
    updated: new Date().toISOString(),
  };

  write(file);
}

/**
 * What the show is told at the start.
 *
 * Short on purpose, and framed hard. These are things the pair have between
 * them, not a script and not the record — a small model handed a list will
 * otherwise work through it like an agenda, which is worse than having no
 * history at all.
 */
export function briefing(lane: string, court = false): string {
  const bits = get(lane);
  if (bits.shows === 0) return "";

  const gags = bits.gags.slice(-BRIEF_GAGS);
  const facts = bits.facts.slice(-BRIEF_FACTS);
  if (gags.length === 0 && facts.length === 0) return "";

  const lines: string[] = [
    court
      ? "FROM EARLIER NIGHTS IN THIS HALL — things that are already between you:"
      : "STILL RUNNING — things this show has going, from previous episodes:",
  ];

  if (facts.length > 0) lines.push(...facts.map((f) => `- ${f}`));
  if (gags.length > 0) {
    lines.push(gags.length === 1 ? "A bit that keeps coming back:" : "Bits that keep coming back:");
    lines.push(...gags.map((g) => `- ${g}`));
  }

  lines.push(
    "",
    "These are yours and they are already true — never introduce one as if it were new, and never",
    "explain it. Use one only if it genuinely fits what is being said. Working through them is worse",
    "than not having them: one landed callback is the whole point, four is a routine.",
  );

  if (court) {
    lines.push(
      "None of this is the chronicle. It is what has been said in this hall, not what was done in the",
      "realm — if it ever contradicts the record, the record is right.",
    );
  }

  return lines.join("\n");
}

/** Forget one lane, or all of them. */
export function forget(lane?: string): void {
  if (!lane) {
    write({ version: 2, lanes: {} });
    return;
  }
  const file = read();
  delete file.lanes[lane];
  write(file);
}

/** Every lane, for the UI. */
export function listLanes(): Array<{ lane: string } & Lane> {
  const file = read();
  return Object.entries(file.lanes)
    .map(([lane, value]) => ({ lane, ...EMPTY_LANE, ...value }))
    .sort((a, b) => b.updated.localeCompare(a.updated));
}
