/**
 * The commercial bucket.
 *
 * The adverts turned out to be the funniest thing the station makes, so they
 * get to be their own thing rather than a by-product of a show: a bucket you
 * fill in batches, listen through, and keep.
 *
 * NOTHING IS EVER DELETED AUTOMATICALLY
 * ------------------------------------
 * This is the whole reason it is a separate store from ads/library. The
 * library is the show's reuse shelf and it trims itself — oldest and least
 * played go once it passes 120 spots, which is correct for a shelf whose job
 * is to keep a rotation fresh. It is exactly wrong for a collection.
 *
 * So: no cap, no trim, no eviction, no expiry. The only thing that removes a
 * spot from this bucket is somebody asking for that specific spot to go, by
 * id, on purpose. A spot can also be starred, and a starred spot refuses to be
 * deleted at all until it is unstarred first — one confirm dialog is not much
 * protection for something you cannot get back.
 *
 * WHERE THEY COME FROM
 * --------------------
 * Three sources, mixed:
 *
 *   station     your own sponsors, Wommper1 and Bootleg Spoon
 *   realm       the traders who exist inside King Orion's world
 *   multiverse  the Rick-and-Morty businesses that should not exist
 *
 * They are generated in batches by `npm run commercials`, which is the only
 * thing that calls a model. Playing them costs nothing.
 */

import fs from "node:fs";
import path from "node:path";
import { preferDistinctCopy } from "../../shared/commercial-rotation.ts";

export const BUCKET_DIR = path.join(process.cwd(), "commercials");
const INDEX_PATH = path.join(BUCKET_DIR, "bucket.json");

export type SpotSource = "station" | "realm" | "multiverse";

export interface BucketSpot {
  id: string;
  /** Who is advertising. */
  sponsor: string;
  source: SpotSource;
  /** The copy, in full. */
  text: string;
  /** Audio filename inside the bucket folder. */
  file: string;
  seconds: number;
  created: string;
  plays: number;
  lastPlayed: string;
  /** Starred spots cannot be deleted until they are unstarred. */
  keep: boolean;
  /** Included in automatic show/channel rotation unless explicitly false. */
  rotation?: boolean;
  /** Operator notes such as keeper, too-normal, or quarantine. */
  tags?: string[];
  /** Commercial brain version used when this spot was created. */
  brainVersion?: string;
}

interface BucketFile {
  version: 1;
  spots: BucketSpot[];
}

export interface BucketIssue {
  id: string;
  sponsor: string;
  severity: "error" | "warning";
  kind: "missing_audio" | "duplicate_id" | "bad_source" | "bad_text" | "bad_seconds" | "bad_file";
  message: string;
  repairable: boolean;
}

function read(): BucketFile {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")) as BucketFile;
    if (raw && Array.isArray(raw.spots)) return { version: 1, spots: raw.spots };
  } catch {
    // No bucket yet. An empty one is a perfectly good starting point.
  }
  return { version: 1, spots: [] };
}

/**
 * Write the index.
 *
 * Written to a temporary file and renamed, because this is the only record of
 * what is in the bucket and a half-written index during a crash would lose the
 * lot. Rename is atomic on every filesystem this runs on.
 */
function write(file: BucketFile): void {
  fs.mkdirSync(BUCKET_DIR, { recursive: true });
  const temporary = `${INDEX_PATH}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
  fs.renameSync(temporary, INDEX_PATH);
}

/** Everything in the bucket, newest first. */
export function listBucket(): BucketSpot[] {
  return read().spots.slice().sort((a, b) => b.created.localeCompare(a.created));
}

export function getSpot(id: string): BucketSpot | null {
  return read().spots.find((s) => s.id === id) ?? null;
}

/** The audio path for one spot, or null when the file has gone missing. */
export function audioFor(id: string): string | null {
  const spot = getSpot(id);
  if (!spot) return null;
  const full = path.join(BUCKET_DIR, spot.file);
  return fs.existsSync(full) ? full : null;
}

function hasUsableAudio(spot: BucketSpot): boolean {
  return (
    Number.isFinite(spot.seconds) &&
    spot.seconds >= 2 &&
    path.basename(spot.file) === spot.file &&
    fs.existsSync(path.join(BUCKET_DIR, spot.file))
  );
}

/** Put a freshly rendered spot in. Never replaces anything. */
export function addSpot(
  spot: Omit<BucketSpot, "plays" | "lastPlayed" | "keep" | "created"> & { created?: string },
): BucketSpot {
  const file = read();
  const record: BucketSpot = {
    ...spot,
    created: spot.created ?? new Date().toISOString(),
    plays: 0,
    lastPlayed: "",
    keep: false,
    rotation: spot.rotation ?? true,
    tags: Array.isArray(spot.tags) ? spot.tags : [],
  };
  file.spots.push(record);
  write(file);
  return record;
}

/**
 * Correct a spot in place.
 *
 * Used when the copy has been re-cleaned and re-recorded. Deliberately narrow:
 * it can change what a spot says and how long it is, and nothing else. It
 * cannot remove one, and it cannot touch the star.
 */
export function updateSpot(id: string, patch: { text?: string; seconds?: number }): BucketSpot | null {
  const file = read();
  const spot = file.spots.find((s) => s.id === id);
  if (!spot) return null;

  if (typeof patch.text === "string" && patch.text.trim()) spot.text = patch.text.trim();
  if (Number.isFinite(patch.seconds)) spot.seconds = Number(patch.seconds);

  write(file);
  return spot;
}

export function markPlayed(id: string): void {
  markPlayedMany([id]);
}

/** Advance a completed break's spots in one atomic bucket update. */
export function markPlayedMany(ids: string[]): void {
  const wanted = new Set(ids.filter(Boolean));
  if (wanted.size === 0) return;

  const file = read();
  const playedAt = new Date().toISOString();
  const changed = advancePlayedRecords(file.spots, wanted, playedAt);
  if (!changed) return;
  write(file);
}

/** Pure accounting core, exported so cancellation semantics stay regression-tested. */
export function advancePlayedRecords(
  spots: Array<{ id: string; plays: number; lastPlayed: string }>,
  ids: ReadonlySet<string>,
  playedAt: string,
): boolean {
  let changed = false;
  for (const spot of spots) {
    if (!ids.has(spot.id)) continue;
    spot.plays += 1;
    spot.lastPlayed = playedAt;
    changed = true;
  }
  return changed;
}

/** Star or unstar. A starred spot cannot be deleted. */
export function setKeep(id: string, keep: boolean): BucketSpot | null {
  const file = read();
  const spot = file.spots.find((s) => s.id === id);
  if (!spot) return null;
  spot.keep = Boolean(keep);
  write(file);
  return spot;
}

export function setRotation(id: string, rotation: boolean): BucketSpot | null {
  const file = read();
  const spot = file.spots.find((s) => s.id === id);
  if (!spot) return null;
  spot.rotation = Boolean(rotation);
  write(file);
  return spot;
}

export function setTags(id: string, tags: string[]): BucketSpot | null {
  const file = read();
  const spot = file.spots.find((s) => s.id === id);
  if (!spot) return null;
  spot.tags = Array.from(
    new Set(
      tags
        .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-"))
        .filter((tag) => /^[a-z0-9-]{2,32}$/.test(tag)),
    ),
  ).slice(0, 8);
  write(file);
  return spot;
}

export interface RemoveResult {
  removed: boolean;
  reason?: string;
}

/**
 * Delete one spot, by id, deliberately.
 *
 * There is no "delete all", no "clear", and no age or size limit anywhere in
 * this file. That is the point of the bucket. A starred spot refuses outright.
 */
export function removeSpot(id: string): RemoveResult {
  const file = read();
  const spot = file.spots.find((s) => s.id === id);
  if (!spot) return { removed: false, reason: "That spot is not in the bucket." };
  if (spot.keep) {
    return { removed: false, reason: `"${spot.sponsor}" is starred. Unstar it first if you really want it gone.` };
  }

  try {
    fs.unlinkSync(path.join(BUCKET_DIR, spot.file));
  } catch {
    // The audio was already gone; the entry still needs removing.
  }

  file.spots = file.spots.filter((s) => s.id !== id);
  write(file);
  return { removed: true };
}

/** Look for entries the UI can report or repair without deleting anything. */
export function auditBucket(): { ok: boolean; issues: BucketIssue[] } {
  const file = read();
  const ids = new Map<string, number>();
  const issues: BucketIssue[] = [];
  const allowed: SpotSource[] = ["station", "realm", "multiverse"];

  for (const spot of file.spots) {
    ids.set(spot.id, (ids.get(spot.id) ?? 0) + 1);
  }

  for (const spot of file.spots) {
    const label = spot.sponsor || spot.id || "Commercial";
    const add = (
      kind: BucketIssue["kind"],
      severity: BucketIssue["severity"],
      message: string,
      repairable: boolean,
    ) => {
      issues.push({ id: spot.id, sponsor: label, kind, severity, message, repairable });
    };

    if (!spot.id || (ids.get(spot.id) ?? 0) > 1) {
      add("duplicate_id", "error", "This bucket entry does not have a unique id.", false);
    }
    if (!allowed.includes(spot.source)) {
      add("bad_source", "error", "This spot has an unknown source.", false);
    }
    if (!spot.text || spot.text.trim().length < 60) {
      add("bad_text", "warning", "This spot's copy is missing or very short.", false);
    }
    if (!Number.isFinite(spot.seconds) || spot.seconds <= 0) {
      add("bad_seconds", "warning", "This spot has no usable duration recorded.", true);
    }
    if (!spot.file || path.basename(spot.file) !== spot.file || path.extname(spot.file).toLowerCase() !== ".wav") {
      add("bad_file", "error", "This spot points at an invalid audio filename.", false);
    } else if (!fs.existsSync(path.join(BUCKET_DIR, spot.file))) {
      add("missing_audio", "error", "This spot's audio file is missing.", true);
    }
  }

  return { ok: issues.filter((i) => i.severity === "error").length === 0, issues };
}

/**
 * Spots for one show's breaks, taken from the bucket.
 *
 * This is what makes the bucket worth filling: both shows draw their
 * commercial load from the same pool, so a break costs a file copy instead of
 * three model round trips. Measured on this machine, writing a break live was
 * twenty-five to thirty seconds a spot.
 *
 * Two rules keep it from going stale. A court gets the realm's own traders and
 * the multiverse ones, never a tyre barn in a hall; the station gets its
 * sponsors and the multiverse ones. And within whatever qualifies, the
 * least-recently-played go first, so a freshly generated batch is always what
 * you hear next and nothing repeats until the whole bucket has been round.
 */
export function pickForShow(
  wanted: number,
  kind: "station" | "court",
  activeBrainVersion?: string,
  rules?: {
    minReplayHours?: number;
    separateSponsors?: boolean;
    sourceWeights?: Partial<Record<SpotSource, number>>;
  },
): BucketSpot[] {
  if (wanted <= 0) return [];

  const allowed: SpotSource[] = kind === "court" ? ["realm", "multiverse"] : ["station", "multiverse"];
  let eligible = read().spots.filter(
    (s) =>
      allowed.includes(s.source) &&
      s.rotation !== false &&
      !(s.tags ?? []).includes("quarantine") &&
      (!activeBrainVersion || s.brainVersion === activeBrainVersion) &&
      hasUsableAudio(s),
  );

  const cutoff = Date.now() - Math.max(0, rules?.minReplayHours ?? 0) * 60 * 60 * 1000;
  if (cutoff < Date.now()) {
    const rested = eligible.filter((spot) => !spot.lastPlayed || Date.parse(spot.lastPlayed) <= cutoff);
    if (rested.length >= wanted) eligible = rested;
    else eligible = [...rested, ...eligible.filter((spot) => !rested.includes(spot))];
  }

  // Never played sorts before played; after that, longest since last play.
  eligible.sort((a, b) => {
    if (a.keep !== b.keep) return a.keep ? -1 : 1;
    if (a.plays !== b.plays) return a.plays - b.plays;
    const aw = rules?.sourceWeights?.[a.source] ?? 1;
    const bw = rules?.sourceWeights?.[b.source] ?? 1;
    if (aw !== bw) return bw - aw;
    return (a.lastPlayed || "").localeCompare(b.lastPlayed || "");
  });

  const candidates = preferDistinctCopy(eligible, eligible.length);
  if (!rules?.separateSponsors) return candidates.slice(0, wanted);

  const picked: BucketSpot[] = [];
  const remaining = [...candidates];
  while (picked.length < wanted && remaining.length > 0) {
    const previous = picked[picked.length - 1]?.sponsor.trim().toLowerCase();
    let index = remaining.findIndex((spot) => !previous || spot.sponsor.trim().toLowerCase() !== previous);
    if (index < 0) index = 0;
    picked.push(remaining.splice(index, 1)[0]);
  }
  return picked;
}

/** What is in there, for the tab header. */
export function bucketStats(activeBrainVersion?: string): {
  total: number;
  kept: number;
  seconds: number;
  rotation: number;
  quarantine: number;
  legacy: number;
  bySource: Record<SpotSource, number>;
} {
  const spots = read().spots;
  const bySource: Record<SpotSource, number> = { station: 0, realm: 0, multiverse: 0 };
  for (const spot of spots) {
    if (bySource[spot.source] !== undefined) bySource[spot.source] += 1;
  }
  return {
    total: spots.length,
    kept: spots.filter((s) => s.keep).length,
    rotation: spots.filter(
      (s) =>
        s.rotation !== false &&
        !(s.tags ?? []).includes("quarantine") &&
        (!activeBrainVersion || s.brainVersion === activeBrainVersion) &&
        hasUsableAudio(s),
    ).length,
    quarantine: spots.filter((s) => (s.tags ?? []).includes("quarantine")).length,
    legacy: activeBrainVersion ? spots.filter((s) => s.brainVersion !== activeBrainVersion).length : 0,
    seconds: Math.round(spots.reduce((sum, s) => sum + (s.seconds || 0), 0)),
    bySource,
  };
}
