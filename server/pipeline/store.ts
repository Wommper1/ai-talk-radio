/**
 * Show library on disk.
 *
 * Each show is a self-contained folder under ./shows, so the library survives
 * restarts, can be backed up by copying, and needs no database.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWriteJson } from "../lib/atomic-file.ts";
import type { TranscriptLine } from "./produce.ts";

/** Increment when older generated dialogue should no longer seed new shows. */
export const CURRENT_SHOW_FORMAT = 2;

export interface StoredShow {
  id: string;
  title: string;
  summary: string;
  topic: string;
  station: string;
  style: string;
  mood: string;
  createdAt: string;
  duration: number;
  hasAudio: boolean;
  hosts: Array<{ id: string; name: string; voice: string; tone: string; model: string }>;
  outline: string[];
  sources: Array<{ title: string; url: string }>;
  transcript: TranscriptLine[];
  /** Model(s) actually used, for reference when comparing runs. */
  models: string[];
  /** Dialogue-generation format used for cross-show recall eligibility. */
  generationVersion?: number;
  /** URLs the client uses; filled in when the show is listed. */
  audioUrl?: string;
  coverUrl?: string;
}

export const SHOWS_DIR = path.join(process.cwd(), "shows");

export function makeShowId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const stamp = new Date().toISOString().slice(0, 10);
  const rand = crypto.randomBytes(3).toString("hex");
  return `${stamp}-${slug || "show"}-${rand}`;
}

export function showDir(id: string): string {
  return path.join(SHOWS_DIR, id);
}

/** Reject ids that could escape the shows directory. */
export function isSafeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,120}$/i.test(id) && !id.includes("..");
}

export function saveShow(show: StoredShow): void {
  const dir = showDir(show.id);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "show.json");
  atomicWriteJson(target, show, false);
}

function decorate(show: StoredShow): StoredShow {
  return {
    ...show,
    audioUrl: show.hasAudio ? `/media/${show.id}/show.wav` : undefined,
    coverUrl: `/media/${show.id}/cover.svg`,
  };
}

export function readShow(id: string): StoredShow | null {
  if (!isSafeId(id)) return null;
  const file = path.join(showDir(id), "show.json");
  if (!fs.existsSync(file)) return null;

  try {
    return decorate(JSON.parse(fs.readFileSync(file, "utf-8")) as StoredShow);
  } catch {
    return null;
  }
}

export function listShows(): StoredShow[] {
  if (!fs.existsSync(SHOWS_DIR)) return [];

  const shows: StoredShow[] = [];
  for (const entry of fs.readdirSync(SHOWS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const show = readShow(entry.name);
    if (show) shows.push(show);
  }

  return shows.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export interface StoredFile {
  name: string;
  bytes: number;
  modified: string;
  /** Relative to the show folder, so nested segments stay addressable. */
  path: string;
}

export interface ShowFiles {
  id: string;
  title: string;
  totalBytes: number;
  files: StoredFile[];
}

function walk(dir: string, base = ""): StoredFile[] {
  if (!fs.existsSync(dir)) return [];

  const out: StoredFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...walk(full, rel));
    } else {
      const stat = fs.statSync(full);
      out.push({ name: entry.name, bytes: stat.size, modified: stat.mtime.toISOString(), path: rel });
    }
  }
  return out;
}

/** Every file belonging to one show, for the file manager. */
export function showFiles(id: string): ShowFiles | null {
  const show = readShow(id);
  if (!show) return null;

  const files = walk(showDir(id)).sort((a, b) => b.bytes - a.bytes);
  return {
    id,
    title: show.title,
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    files,
  };
}

export interface StorageSummary {
  root: string;
  totalBytes: number;
  showCount: number;
  fileCount: number;
  /** Transient working files that are safe to clear. */
  scratchBytes: number;
  shows: Array<{ id: string; title: string; createdAt: string; bytes: number; hasAudio: boolean }>;
}

function dirBytes(dir: string): number {
  return walk(dir).reduce((n, f) => n + f.bytes, 0);
}

export function storageSummary(): StorageSummary {
  const shows = listShows();
  const perShow = shows.map((s) => {
    const files = walk(showDir(s.id));
    return {
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      hasAudio: s.hasAudio,
      fileCount: files.length,
    };
  });

  return {
    root: SHOWS_DIR,
    totalBytes: perShow.reduce((n, s) => n + s.bytes, 0),
    showCount: perShow.length,
    fileCount: perShow.reduce((n, s) => n + s.fileCount, 0),
    scratchBytes: dirBytes(path.join(process.cwd(), "output")),
    shows: perShow.map(({ fileCount: _ignored, ...rest }) => rest),
  };
}

/**
 * Delete the per-turn clips but keep the finished show. Segments are only
 * needed to re-mix, so this reclaims most of the disk a show uses.
 */
export function pruneSegments(id: string): number {
  if (!isSafeId(id)) return 0;
  const dir = path.join(showDir(id), "segments");
  if (!fs.existsSync(dir)) return 0;

  const freed = dirBytes(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return freed;
}

/** Clear transient working files (live clips, previews, test renders). */
export function clearScratch(): number {
  const dir = path.join(process.cwd(), "output");
  if (!fs.existsSync(dir)) return 0;

  const freed = dirBytes(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return freed;
}

export function deleteShow(id: string): boolean {
  if (!isSafeId(id)) return false;
  const dir = showDir(id);
  // Guard against anything that resolved outside the library.
  if (!path.resolve(dir).startsWith(path.resolve(SHOWS_DIR))) return false;
  if (!fs.existsSync(dir)) return false;

  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
