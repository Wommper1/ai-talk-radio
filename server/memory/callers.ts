/**
 * The station's phone book.
 *
 * Every show until now started with the hosts having never heard of anyone.
 * You could call in three nights running and be a stranger every time, which
 * is the one thing a real drive-time show would never do — the whole appeal of
 * a phone-in is that the desk knows the regulars.
 *
 * So every call is written down: who rang, what show it was, and roughly what
 * they said. The next show's hosts get a short briefing on the regulars, and
 * when one of them rings in they are greeted as someone the station knows.
 *
 * Deliberately tiny. One JSON file, a handful of names, no model involved.
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../lib/atomic-file.ts";

const CALLERS_PATH = path.join(process.cwd(), "memory", "callers.json");

/** How much is kept per caller, and how many make it into a prompt. */
const KEEP_TOPICS = 6;
const KEEP_LINES = 4;
const BRIEF_CALLERS = 4;

export interface CallerRecord {
  /** As they typed it, so the hosts say it back the way they wrote it. */
  name: string;
  calls: number;
  firstHeard: string;
  lastHeard: string;
  /** Show subjects they have rung about, newest last. */
  topics: string[];
  /** The gist of their recent calls, newest last. */
  lines: string[];
}

interface CallersFile {
  version: 1;
  callers: Record<string, CallerRecord>;
}

function keyFor(name: string): string {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40);
}

function read(): CallersFile {
  try {
    const raw = JSON.parse(fs.readFileSync(CALLERS_PATH, "utf8")) as CallersFile;
    if (raw && typeof raw === "object" && raw.callers) return { version: 1, callers: raw.callers };
  } catch {
    // No phone book yet, or an unreadable one. Tonight everyone is new.
  }
  return { version: 1, callers: {} };
}

function write(file: CallersFile): void {
  try {
    atomicWriteJson(CALLERS_PATH, file);
  } catch {
    // Never fail a show over the phone book.
  }
}

/** One sentence of what somebody said, short enough to sit in a prompt. */
function gistOf(text: string): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= 110) return clean;
  const cut = clean.slice(0, 110);
  const stop = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"), cut.lastIndexOf(","));
  return `${(stop > 55 ? cut.slice(0, stop) : cut).trim()}...`;
}

/**
 * Write a call into the phone book.
 *
 * Anonymous calls are not recorded: "Caller" is not a person, and filling the
 * book with it would push the actual regulars out of the briefing.
 */
export function rememberCall(input: { name: string; text: string; topic?: string; anonymous?: string }): void {
  const name = String(input.name ?? "").trim().slice(0, 40);
  const key = keyFor(name);
  if (!key) return;
  if (input.anonymous && key === keyFor(input.anonymous)) return;

  const file = read();
  const now = new Date().toISOString();
  const existing = file.callers[key];

  const topic = String(input.topic ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
  const gist = gistOf(input.text);

  file.callers[key] = {
    name,
    calls: (existing?.calls ?? 0) + 1,
    firstHeard: existing?.firstHeard ?? now,
    lastHeard: now,
    topics: [...(existing?.topics ?? []), topic].filter(Boolean).slice(-KEEP_TOPICS),
    lines: [...(existing?.lines ?? []), gist].filter(Boolean).slice(-KEEP_LINES),
  };

  write(file);
}

/** Everyone in the book, the most recent callers first. */
export function listCallers(): CallerRecord[] {
  return Object.values(read().callers).sort((a, b) => b.lastHeard.localeCompare(a.lastHeard));
}

/** Whether this name is already known, for greeting somebody by name. */
export function findCaller(name: string): CallerRecord | null {
  return read().callers[keyFor(name)] ?? null;
}

/**
 * The regulars, written for a host to read.
 *
 * Kept to a few lines on purpose: this goes into the system prompt of a model
 * that is also holding a persona, a topic and the last few turns, and a long
 * list of strangers' names is the fastest way to make a small model start
 * inventing callers who are not on the line.
 */
export function callerBriefing(limit = BRIEF_CALLERS): string {
  const known = listCallers()
    .filter((c) => c.calls > 0)
    // Most frequent first, then most recent — the people the hosts would
    // actually recognise, not whoever happened to ring last.
    .sort((a, b) => b.calls - a.calls || b.lastHeard.localeCompare(a.lastHeard))
    .slice(0, limit);

  if (known.length === 0) return "";

  const lines = known.map((c) => {
    const times = c.calls === 1 ? "called once before" : `has called ${c.calls} times`;
    const about = c.topics.length > 0 ? `, last time about ${c.topics[c.topics.length - 1]}` : "";
    const said = c.lines.length > 0 ? ` — "${c.lines[c.lines.length - 1]}"` : "";
    return `- ${c.name}: ${times}${about}${said}`;
  });

  return (
    "Regulars who ring this station:\n" +
    `${lines.join("\n")}\n` +
    "If one of them is put on air tonight, you already know them — greet them by name and refer to what " +
    "they said last time. Never claim someone is on the line unless they actually are."
  );
}

/** Forget one caller, or clear the book. */
export function forgetCaller(name?: string): void {
  if (!name) {
    write({ version: 1, callers: {} });
    return;
  }
  const file = read();
  delete file.callers[keyFor(name)];
  write(file);
}
