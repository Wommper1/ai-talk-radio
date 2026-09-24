/**
 * The opening, rendered in advance.
 *
 * THE PROBLEM
 * -----------
 * Pressing Start used to begin: a TTS round trip for the cold open, an LLM
 * call for the petitioner, two more to write the break, and the warm-up pass
 * that costs 46 seconds from cold. None of it makes a sound until it is all
 * done, so the listener sits in silence for minutes and then gets a first turn
 * that arrives a sentence at a time.
 *
 * Every one of those is work that did not have to happen now. The announcer's
 * open is the same words whoever is listening; a commercial has nothing to do
 * with tonight's subject at all. They were only being made at request time
 * because that is when the code happened to run.
 *
 * THE FIX
 * -------
 * Make them ahead of time, once, and keep the audio on disk. Pressing Start
 * then plays a file — no model, no speech engine, no network — and the show is
 * being written underneath it the whole time. An opener and a sixty-second
 * commercial either side of a four-minute record is five minutes of cover,
 * which is more than the slowest cold start needs.
 *
 * ROTATION
 * --------
 * The same joke three nights running stops being a joke, so a pack is retired
 * after a few shows and the next one comes up. Packs are generated in batches
 * by `npm run openers`, which is the only thing that ever calls a model here.
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../lib/atomic-file.ts";

export const OPENERS_DIR = path.join(process.cwd(), "openers");
const MANIFEST = path.join(OPENERS_DIR, "openers.json");

/** How many shows a pack fronts before the next one comes up. */
export const SHOWS_PER_PACK = 3;

export interface Preroll {
  id: string;
  madeAt: string;
  /** How many shows this pack has opened. */
  plays: number;
  /** Exact station this imaging was made for. Missing on legacy packs. */
  station?: string;
  /** Bumped when the station-imaging format changes. */
  imagingVersion?: number;
  /** Who or what it is about, for the shelf listing. */
  about: string;
  /** The announcer, before the record. */
  openText: string;
  openFile: string;
  openSeconds: number;
  /** The commercial, after the record and before anyone speaks. */
  adText: string;
  adFile: string;
  adSeconds: number;
  /**
   * The breaks for the rest of the show, also rendered in advance.
   *
   * Measured: four breaks of three spots is eleven fresh generations at
   * twenty-five to thirty seconds each — over four minutes of model time spent
   * before a single word of the show exists, which is more than the opening
   * record covers. Radio commercials have nothing to do with tonight's subject
   * anyway, so there was never a reason to write them tonight.
   */
  breaks?: Array<{ text: string; file: string; seconds: number }>;
}

interface Manifest {
  version: 1;
  /** Index into packs. Rotates every SHOWS_PER_PACK shows. */
  current: number;
  showsOnCurrent: number;
  packs: Preroll[];
}

const EMPTY: Manifest = { version: 1, current: 0, showsOnCurrent: 0, packs: [] };

function read(): Manifest {
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as Manifest;
    if (raw && Array.isArray(raw.packs)) {
      return {
        version: 1,
        current: Number(raw.current) || 0,
        showsOnCurrent: Number(raw.showsOnCurrent) || 0,
        packs: raw.packs,
      };
    }
  } catch {
    // No packs yet. The show falls back to rendering its own opener, which is
    // exactly what it did before this existed.
  }
  return { ...EMPTY };
}

function write(manifest: Manifest): void {
  try {
    atomicWriteJson(MANIFEST, manifest);
  } catch {
    // Never fail a show over bookkeeping.
  }
}

/** Everything on the shelf, for the UI and for the generator. */
export function listPrerolls(): Preroll[] {
  return read().packs;
}

/**
 * The pack fronting tonight, or null if the shelf is empty.
 *
 * Read-only: rotation happens in `usePreroll`, so merely looking at what is
 * queued up cannot advance it.
 */
export function currentPreroll(station?: string): Preroll | null {
  const manifest = read();
  const usable = manifest.packs.filter((pack) =>
    playable(pack) && (!station || (
      pack.imagingVersion === 2 &&
      pack.station === station &&
      pack.openText.toLowerCase().includes(station.toLowerCase())
    )),
  );
  if (usable.length === 0) return null;
  return usable[manifest.current % usable.length];
}

/** Both files still on disk. A pack whose audio was deleted is not playable. */
function playable(pack: Preroll): boolean {
  try {
    return fs.existsSync(path.join(OPENERS_DIR, pack.openFile))
      && fs.existsSync(path.join(OPENERS_DIR, pack.adFile));
  } catch {
    return false;
  }
}

/**
 * The shelved break commercials whose audio is actually still there.
 *
 * Returned in order, and a show takes as many as it has breaks. Fewer than it
 * needs is fine — the rest are written the old way.
 */
export function shelvedBreaks(pack: Preroll | null): Array<{ text: string; file: string; seconds: number }> {
  if (!pack?.breaks) return [];
  return pack.breaks.filter((brk) => {
    try {
      return fs.existsSync(path.join(OPENERS_DIR, brk.file));
    } catch {
      return false;
    }
  });
}

/** Note that a pack went out, and move the rotation on when it is worn. */
export function usePreroll(id: string): void {
  const manifest = read();
  const pack = manifest.packs.find((p) => p.id === id);
  if (!pack) return;

  pack.plays += 1;
  manifest.showsOnCurrent += 1;

  if (manifest.showsOnCurrent >= SHOWS_PER_PACK) {
    const usable = manifest.packs.filter(playable);
    manifest.current = usable.length > 0 ? (manifest.current + 1) % usable.length : 0;
    manifest.showsOnCurrent = 0;
  }

  write(manifest);
}

/** Put a freshly rendered pack on the shelf. */
export function addPreroll(pack: Preroll): void {
  const manifest = read();
  manifest.packs = [...manifest.packs.filter((p) => p.id !== pack.id), pack];
  write(manifest);
}

/** Drop one pack, or empty the shelf. Also removes its audio. */
export function forgetPreroll(id?: string): void {
  const manifest = read();
  const going = id ? manifest.packs.filter((p) => p.id === id) : manifest.packs;

  for (const pack of going) {
    for (const file of [pack.openFile, pack.adFile, ...(pack.breaks ?? []).map((b) => b.file)]) {
      try {
        fs.unlinkSync(path.join(OPENERS_DIR, file));
      } catch {
        // Already gone, which is the state we wanted.
      }
    }
  }

  manifest.packs = id ? manifest.packs.filter((p) => p.id !== id) : [];
  manifest.current = 0;
  manifest.showsOnCurrent = 0;
  write(manifest);
}

/** The absolute path of one of a pack's files, or null if it is missing. */
export function prerollFile(pack: Preroll, which: "open" | "ad"): string | null {
  const file = which === "open" ? pack.openFile : pack.adFile;
  const full = path.join(OPENERS_DIR, file);
  return fs.existsSync(full) ? full : null;
}
