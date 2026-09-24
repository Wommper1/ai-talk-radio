/**
 * The station's shelf of finished commercials.
 *
 * Every spot in a show costs a share of one model call to write and a full
 * round of speech synthesis to record, and that work is thrown away the moment
 * the show ends — so the next show pays for it again, for adverts a listener
 * has already heard produced perfectly well.
 *
 * A real station does not do that. It cuts a spot once and plays it for a
 * month. So finished spots are kept here, and each new show takes a share of
 * its commercial load off the shelf and writes the rest fresh. The share is a
 * setting: at forty percent, two adverts in a five-spot show are repeats and
 * three are new, which is roughly how a real log sounds anyway.
 *
 * What is stored is the *produced* block — copy, voice, bed and all — so a
 * reused spot costs one file read and no model, no synthesis and no mixing.
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../lib/atomic-file.ts";

/**
 * Inside the ads folder, but its own room — the drop folder is listed
 * non-recursively, so shelved spots never show up as files you added.
 *
 * Built here rather than imported from ads.ts on purpose: ads.ts imports this
 * module, and taking the constant back off it would close the circle and leave
 * one of the two uninitialised at load time.
 */
export const LIBRARY_DIR = path.join(process.cwd(), "ads", "library");
const INDEX_PATH = path.join(LIBRARY_DIR, "index.json");
export const CURRENT_AD_LIBRARY_FORMAT = 3;

export interface LibrarySpot {
  id: string;
  sponsor: string;
  /** The format it was written to, so a reused spot still varies. */
  angle: string;
  kind: string;
  /** The copy, for the transcript and the commercial log. */
  text: string;
  seconds: number;
  created: string;
  lastPlayed: string;
  plays: number;
  /** Only current-format spots are eligible for automatic reuse. */
  formatVersion?: number;
}

interface LibraryFile {
  version: 1;
  spots: LibrarySpot[];
}

/** Past this the shelf is trimmed, oldest and least played first. */
const MAX_SPOTS = 120;

function read(): LibraryFile {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")) as LibraryFile;
    if (raw && Array.isArray(raw.spots)) return { version: 1, spots: raw.spots };
  } catch {
    // No shelf yet, or an unreadable index. Everything gets written fresh.
  }
  return { version: 1, spots: [] };
}

function write(file: LibraryFile): void {
  try {
    atomicWriteJson(INDEX_PATH, file);
  } catch {
    // Never fail a show over the shelf.
  }
}

export function audioPathFor(id: string): string {
  // Ids are generated here and never come from config, but a path that is
  // built from a string still gets pinned inside the folder it belongs to.
  return path.join(LIBRARY_DIR, `${path.basename(id)}.wav`);
}

/** Everything on the shelf, most recently played first. */
export function listLibrary(): LibrarySpot[] {
  return read()
    .spots.filter((s) => fs.existsSync(audioPathFor(s.id)))
    .sort((a, b) => b.lastPlayed.localeCompare(a.lastPlayed));
}

/**
 * Choose spots to repeat tonight.
 *
 * Least recently played first, so the shelf rotates rather than playing the
 * same two adverts every night, and never the same spot twice in one show.
 * `wanted` is a target, not a promise — a young shelf simply returns fewer.
 */
export function pickForReuse(wanted: number, sponsors: string[]): LibrarySpot[] {
  if (wanted <= 0) return [];

  const allowed = new Set(sponsors.map((s) => s.trim().toLowerCase()));
  const available = listLibrary()
    .filter((s) => s.formatVersion === CURRENT_AD_LIBRARY_FORMAT)
    .filter((s) => allowed.size === 0 || allowed.has(s.sponsor.trim().toLowerCase()))
    .sort((a, b) => a.lastPlayed.localeCompare(b.lastPlayed) || a.plays - b.plays);

  return available.slice(0, wanted);
}

/** Put a finished spot on the shelf. Returns its id, or null if it could not be kept. */
export function save(spot: {
  sponsor: string;
  angle: string;
  kind: string;
  text: string;
  seconds: number;
  wav: Buffer;
}): string | null {
  // Nothing worth keeping: an empty render, or a spot with no copy behind it.
  if (spot.seconds < 2 || !spot.text.trim()) return null;

  try {
    fs.mkdirSync(LIBRARY_DIR, { recursive: true });

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(audioPathFor(id), spot.wav);

    const now = new Date().toISOString();
    const file = read();
    file.spots.push({
      id,
      sponsor: spot.sponsor,
      angle: spot.angle,
      kind: spot.kind,
      text: spot.text.slice(0, 900),
      seconds: Number(spot.seconds.toFixed(2)),
      created: now,
      // Written as played, because it is about to be: it was cut for tonight.
      lastPlayed: now,
      plays: 1,
      formatVersion: CURRENT_AD_LIBRARY_FORMAT,
    });

    write(trim(file));
    return id;
  } catch {
    return null;
  }
}

/** Note that a shelved spot went out again, so the rotation moves on. */
export function markPlayed(ids: string[]): void {
  if (ids.length === 0) return;

  const file = read();
  const now = new Date().toISOString();
  let touched = false;

  for (const spot of file.spots) {
    if (!ids.includes(spot.id)) continue;
    spot.lastPlayed = now;
    spot.plays += 1;
    touched = true;
  }

  if (touched) write(file);
}

/** Drop one spot, or empty the shelf. */
export function forget(id?: string): void {
  const file = read();

  if (!id) {
    for (const spot of file.spots) fs.rmSync(audioPathFor(spot.id), { force: true });
    write({ version: 1, spots: [] });
    return;
  }

  fs.rmSync(audioPathFor(id), { force: true });
  write({ version: 1, spots: file.spots.filter((s) => s.id !== id) });
}

/** Keep the shelf from growing without limit. Least played, oldest, goes first. */
function trim(file: LibraryFile): LibraryFile {
  if (file.spots.length <= MAX_SPOTS) return file;

  const ranked = [...file.spots].sort((a, b) => b.plays - a.plays || b.created.localeCompare(a.created));
  const keep = ranked.slice(0, MAX_SPOTS);
  const drop = ranked.slice(MAX_SPOTS);

  for (const spot of drop) fs.rmSync(audioPathFor(spot.id), { force: true });
  return { version: 1, spots: keep };
}
