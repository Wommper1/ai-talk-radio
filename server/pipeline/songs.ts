/**
 * The record at the top of the show.
 *
 * A song is the oldest trick in radio and it happens to solve this app's
 * hardest problem. The station opens, the announcer throws to a record, and
 * the record plays — three or four minutes in which the listener is hearing a
 * station rather than waiting, and the model is writing the whole first half
 * of the show. Nothing here goes near the language model: the throw is built
 * from templates and the record is a file on disk, so both exist within a
 * second of the show being requested.
 */

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { decodeMp3 } from "../audio/mp3.ts";
import { decodeWav, resample, SAMPLE_RATE, durationOf, type AudioBuffer } from "../audio/wav.ts";
import { hashSeed, renderAnnouncement, renderCourtImaging, renderRockImaging } from "./coldopen.ts";
import type { Mood } from "../audio/music.ts";

/* ── The drop folder ─────────────────────────────────────────────── */

/** Where your music lives. Deliberately not the ads folder — a song is not a spot. */
export const MUSIC_DIR = path.join(process.cwd(), "music");

const AUDIO_EXTENSIONS = [".mp3", ".wav"];

export interface SongFile {
  name: string;
  bytes: number;
  modified: string;
}

export function listSongFiles(): SongFile[] {
  try {
    fs.mkdirSync(MUSIC_DIR, { recursive: true });
    return fs
      .readdirSync(MUSIC_DIR)
      .filter((name) => AUDIO_EXTENSIONS.includes(path.extname(name).toLowerCase()))
      .map((name) => {
        const stat = fs.statSync(path.join(MUSIC_DIR, name));
        return { name, bytes: stat.size, modified: stat.mtime.toISOString() };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Turn a configured filename into a path inside the music folder, or null.
 * Only a bare filename is ever accepted, so config cannot reach outside it.
 */
export function resolveSongFile(name: string): string | null {
  const base = path.basename(String(name ?? "").trim());
  if (!base || !AUDIO_EXTENSIONS.includes(path.extname(base).toLowerCase())) return null;

  const full = path.join(MUSIC_DIR, base);
  if (!path.resolve(full).startsWith(path.resolve(MUSIC_DIR))) return null;
  return fs.existsSync(full) ? full : null;
}

/* ── What the announcer calls it ─────────────────────────────────── */

/**
 * A readable title from a filename, for when you have not typed one.
 *
 * Covers the shape music files actually arrive in — "04 - Artist - Title.mp3",
 * "artist_title.mp3" — without pretending to be a tag reader.
 */
export function titleFromFilename(name: string): { title: string; artist: string } {
  const stem = path
    .basename(String(name ?? ""), path.extname(String(name ?? "")))
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // A leading track number is a filing detail, not part of the name.
    .replace(/^\d{1,3}\s*[-.)]?\s*/, "");

  const parts = stem.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean);

  // "Artist - Title" is the overwhelmingly common convention; anything else is
  // treated as a bare title rather than guessed at.
  if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(" - ") };
  return { artist: "", title: stem };
}

/** What the announcer says, given the config and the file actually playing. */
export function songDetails(config: Config, file: string): { title: string; artist: string } {
  const song = config.show.openingSong;
  const fallback = titleFromFilename(file);

  return {
    title: song.title.trim() || fallback.title,
    artist: song.artist.trim() || fallback.artist,
  };
}

/**
 * The throw to the record: what the station is, what is coming up, and what is
 * playing next. Templates, so it is ready before the model has been asked for
 * anything.
 */
/**
 * The herald's throw to the record.
 *
 * A court gets music too — it is the same four minutes of cover the radio show
 * gets, and a hall that opens on a piece of music is if anything more natural
 * than one that opens on a man talking. What it does not get is a DJ: no
 * station, no "coming up", no "stay with us".
 */
export function courtSongIntroScript(config: Config, topic: string, file: string): string {
  const { title, artist } = songDetails(config, file);
  const subject = topic.trim().replace(/\s+/g, " ").slice(0, 90);

  const lines = ["The hall is closed."];
  if (subject) lines.push(`Tonight the matter is ${subject}.`);
  lines.push(`${config.orion.king.name} will hear it when the music is done.`);
  lines.push(artist ? `${title}. ${artist}.` : `${title}.`);

  return lines.join(" ");
}

export function songIntroScript(config: Config, topic: string, file: string): string {
  const [a, b] = config.hosts;
  const { title, artist } = songDetails(config, file);
  const subject = topic.trim().replace(/\s+/g, " ").slice(0, 90);

  const lines = [`This is ${config.show.station}.`, `${a.name} and ${b.name} are in.`];

  if (subject) lines.push(`Coming up — ${subject}.`);

  lines.push("Stay with us. We'll be right back.");
  lines.push(artist ? `But first, here's ${title}, by ${artist}.` : `But first, here's ${title}.`);

  return lines.join(" ");
}

/** How the record is labelled in the feed and the transcript. */
export function songLabel(config: Config, file: string): string {
  const { title, artist } = songDetails(config, file);
  return artist ? `${title} — ${artist}` : title;
}

/* ── Rendering ───────────────────────────────────────────────────── */

/**
 * Render the announcer throwing to the record.
 *
 * Same band as the cold open, so the top of the show reads as one continuous
 * piece rather than two unrelated stings — but no riser and no crash coming
 * in, because the opener has just played both and two in fifteen seconds is
 * how a station sounds when nobody is watching the desk. The button on the
 * end is what hands over to the record.
 */
export function renderSongIntro(
  config: Config,
  topic: string,
  file: string,
  outPath: string,
  signal?: AbortSignal,
  court = false,
): Promise<AudioBuffer | null> {
  const text = court ? courtSongIntroScript(config, topic, file) : songIntroScript(config, topic, file);

  if (court) {
    // Bells, not a band. The court's own imaging, one beat shorter than the
    // entrance so the two do not sound like the same cue played twice.
    return renderCourtImaging(config, text, outPath, signal);
  }


  if ((config.show.mood as Mood) === "none") {
    return renderAnnouncement(
      config,
      text,
      outPath,
      { ident: false, whoosh: true, lead: 0.4, tail: 0.9, seedOffset: 17 },
      signal,
    );
  }

  return renderRockImaging(
    config,
    text,
    outPath,
    {
      seed: hashSeed(`${config.show.station}|song|${file}`),
      // Straight in: the opener's button has only just stopped ringing.
      intro: 1.1,
      outro: 1.6,
      crashIn: false,
      riser: false,
      rateBoost: 1,
    },
    signal,
  );
}

/** Decode a song to the pipeline's mono format, ready to sit on the timeline. */
export async function loadSong(fullPath: string): Promise<AudioBuffer> {
  const bytes = fs.readFileSync(fullPath);
  const decoded = fullPath.toLowerCase().endsWith(".mp3") ? await decodeMp3(bytes) : decodeWav(bytes);
  const song = resample(decoded, SAMPLE_RATE);

  if (durationOf(song) < 0.5) throw new Error("That file has no audio in it.");
  return song;
}
