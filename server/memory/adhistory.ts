/**
 * What each advertiser has already said on this station.
 *
 * A sponsor booked into four breaks a night, night after night, is the one
 * place this app will repeat itself fastest: the brief never changes, so the
 * model writes the same advert every time and a listener hears the same forty
 * words four times in one show. That is the single thing that makes a station
 * sound fake.
 *
 * So the station keeps a log. Every spot that goes out records the angle it
 * was written from and the words it opened on, and the next brief is told to
 * avoid both. It is small, it is a plain JSON file, and losing it costs
 * nothing beyond one repetitive show.
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../lib/atomic-file.ts";

const HISTORY_PATH = path.join(process.cwd(), "memory", "ads.json");

/** How far back the station remembers, per advertiser. */
const KEEP_ANGLES = 10;
const KEEP_OPENINGS = 8;

interface SponsorHistory {
  /** Angle ids, newest last. */
  angles: string[];
  /** First few words of each recent spot, newest last. */
  openings: string[];
  /** Total spots aired, purely so the log is readable by a human. */
  aired: number;
}

interface AdHistoryFile {
  version: 2;
  sponsors: Record<string, SponsorHistory>;
}

const EMPTY: SponsorHistory = { angles: [], openings: [], aired: 0 };

function keyFor(sponsor: string): string {
  return String(sponsor ?? "").trim().toLowerCase().slice(0, 80);
}

function read(): AdHistoryFile {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")) as AdHistoryFile;
    if (raw && raw.version === 2 && typeof raw === "object" && raw.sponsors) return { version: 2, sponsors: raw.sponsors };
  } catch {
    // No log yet, or an unreadable one. Either way the show goes on.
  }
  return { version: 2, sponsors: {} };
}

function write(file: AdHistoryFile): void {
  try {
    atomicWriteJson(HISTORY_PATH, file);
  } catch {
    // Never fail a show over a log file.
  }
}

/** What this advertiser has done recently. */
export function recentFor(sponsor: string): SponsorHistory {
  const entry = read().sponsors[keyFor(sponsor)];
  return entry ? { ...EMPTY, ...entry } : { ...EMPTY };
}

/** Every advertiser's recent history in one read, for planning a whole show. */
export function recentForAll(sponsors: string[]): Map<string, SponsorHistory> {
  const file = read();
  const out = new Map<string, SponsorHistory>();
  for (const name of sponsors) {
    const entry = file.sponsors[keyFor(name)];
    out.set(name, entry ? { ...EMPTY, ...entry } : { ...EMPTY });
  }
  return out;
}

/** The opening of a spot, in the form the next brief will be told to avoid. */
export function openingOf(text: string): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 7)
    .join(" ");
}

/** Record what went out, so it does not go out again next time. */
export function remember(entries: Array<{ sponsor: string; angle: string; opening: string }>): void {
  if (entries.length === 0) return;

  const file = read();

  for (const entry of entries) {
    const key = keyFor(entry.sponsor);
    if (!key) continue;

    const current: SponsorHistory = { ...EMPTY, ...(file.sponsors[key] ?? {}) };

    if (entry.angle) current.angles = [...current.angles, entry.angle].slice(-KEEP_ANGLES);
    const opening = openingOf(entry.opening);
    if (opening) current.openings = [...current.openings, opening].slice(-KEEP_OPENINGS);
    current.aired += 1;

    file.sponsors[key] = current;
  }

  write(file);
}

/** Wipe the log, so an advertiser can start again from a clean sheet. */
export function forget(sponsor?: string): void {
  if (!sponsor) {
    write({ version: 2, sponsors: {} });
    return;
  }
  const file = read();
  delete file.sponsors[keyFor(sponsor)];
  write(file);
}
