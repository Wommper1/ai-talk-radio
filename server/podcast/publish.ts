/**
 * Publishing the podcast: settings on disk, cover art, and the job that turns
 * chosen shows into a folder ready to upload anywhere that serves static files.
 *
 *   podcast/podcast.json     settings (which shows, title, site address…)
 *   podcast/cover.png|jpg    the listener's own artwork, if they added some
 *   podcast/encoded.json     which MP3s are current, so nothing is encoded twice
 *   podcast/site/            the finished website: upload this folder
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, atomicWriteText } from "../lib/atomic-file.ts";
import { listShows, readShow, showDir, type StoredShow } from "../pipeline/store.ts";
import { podcastCoverPng } from "./cover-png.ts";
import {
  buildEpisodeHtml,
  buildFeed,
  buildIndexHtml,
  buildVtt,
  normalizePodcastSettings,
  type Episode,
  type PodcastSettings,
} from "./feed.ts";
import { wavToMp3, type PodcastQuality } from "./mp3.ts";

export const podcastDir = () => path.join(process.cwd(), "podcast");
export const podcastSiteDir = () => path.join(podcastDir(), "site");
const settingsFile = () => path.join(podcastDir(), "podcast.json");
const encodedFile = () => path.join(podcastDir(), "encoded.json");

/* ── Settings ─────────────────────────────────────────────────── */

export function loadPodcastSettings(stationName: string): PodcastSettings {
  try {
    return normalizePodcastSettings(JSON.parse(fs.readFileSync(settingsFile(), "utf8")), stationName);
  } catch {
    return normalizePodcastSettings({}, stationName);
  }
}

export function savePodcastSettings(raw: unknown, stationName: string): PodcastSettings {
  const settings = normalizePodcastSettings(raw, stationName);
  fs.mkdirSync(podcastDir(), { recursive: true });
  atomicWriteJson(settingsFile(), settings);
  return settings;
}

/* ── Cover art ────────────────────────────────────────────────── */

const COVER_TYPES = { png: "image/png", jpg: "image/jpeg" } as const;
type CoverExt = keyof typeof COVER_TYPES;

/** The listener's own cover, if any. */
export function customCover(): { file: string; ext: CoverExt } | null {
  for (const ext of Object.keys(COVER_TYPES) as CoverExt[]) {
    const file = path.join(podcastDir(), `cover.${ext}`);
    if (fs.existsSync(file)) return { file, ext };
  }
  return null;
}

/** Width and height of a PNG or JPEG, read from its header; null if it is neither. */
export function imageSize(buf: Buffer): { type: CoverExt; width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { type: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) return null;
      const marker = buf[p + 1];
      const length = buf.readUInt16BE(p + 2);
      // Any start-of-frame marker carries the dimensions (not DHT, JPG or DAC, which share the range).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "jpg", height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
      }
      p += 2 + length;
    }
  }
  return null;
}

/** Store an uploaded cover. Returns a note when directories are likely to reject it. */
export function saveCustomCover(buf: Buffer): { warning?: string } {
  const size = imageSize(buf);
  if (!size) throw new Error("The cover must be a PNG or JPEG image.");
  removeCustomCover();
  fs.mkdirSync(podcastDir(), { recursive: true });
  fs.writeFileSync(path.join(podcastDir(), `cover.${size.type}`), buf);
  if (size.width !== size.height || size.width < 1400 || size.width > 3000) {
    return {
      warning: `This image is ${size.width}×${size.height}. Apple Podcasts and Spotify want a square between 1400×1400 and 3000×3000.`,
    };
  }
  return {};
}

export function removeCustomCover(): void {
  for (const ext of Object.keys(COVER_TYPES) as CoverExt[]) fs.rmSync(path.join(podcastDir(), `cover.${ext}`), { force: true });
}

/** The cover the podcast will use: the listener's own, or one drawn from the title. */
export function coverImage(settings: PodcastSettings): { data: Buffer; type: string; ext: CoverExt } {
  const custom = customCover();
  if (custom) return { data: fs.readFileSync(custom.file), type: COVER_TYPES[custom.ext], ext: custom.ext };
  return { data: podcastCoverPng(settings.title), type: "image/png", ext: "png" };
}

/* ── What can be published ────────────────────────────────────── */

type EncodedIndex = Record<string, { quality: PodcastQuality; wavMtimeMs: number; bytes: number }>;

function readEncoded(): EncodedIndex {
  try {
    return JSON.parse(fs.readFileSync(encodedFile(), "utf8")) as EncodedIndex;
  } catch {
    return {};
  }
}

const wavPath = (id: string) => path.join(showDir(id), "show.wav");
const mp3Path = (id: string) => path.join(podcastSiteDir(), "episodes", `${id}.mp3`);

function isEncoded(id: string, quality: PodcastQuality, index: EncodedIndex): boolean {
  const entry = index[id];
  if (!entry || entry.quality !== quality || !fs.existsSync(mp3Path(id))) return false;
  try {
    return fs.statSync(wavPath(id)).mtimeMs === entry.wavMtimeMs;
  } catch {
    return false;
  }
}

/** A record from the music folder plays inside the episode, and its rights belong to someone else. */
const hasRecord = (show: StoredShow) => show.transcript.some((l) => l.hostId === "song");

export interface PodcastShowRow {
  id: string;
  title: string;
  createdAt: string;
  duration: number;
  /** Has a finished audio file to publish. */
  publishable: boolean;
  included: boolean;
  /** An up-to-date MP3 already exists, so publishing it is quick. */
  encoded: boolean;
  /** Contains a song from the music folder. */
  hasRecord: boolean;
}

export function podcastShows(settings: PodcastSettings): PodcastShowRow[] {
  const index = readEncoded();
  return listShows()
    .map((show) => ({
      id: show.id,
      title: show.title,
      createdAt: show.createdAt,
      duration: show.duration,
      publishable: show.hasAudio && fs.existsSync(wavPath(show.id)),
      included: settings.episodes.includes(show.id),
      encoded: isEncoded(show.id, settings.quality, index),
      hasRecord: hasRecord(show),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ── The publish job ──────────────────────────────────────────── */

export interface PodcastJob {
  state: "idle" | "running" | "done" | "failed";
  message: string;
  /** Episodes finished so far, of `total`. */
  done: number;
  total: number;
  /** Fraction of the episode currently being encoded. */
  fraction: number;
  error?: string;
  finishedAt?: string;
  /** Episodes in the last successful publish. */
  published?: number;
}

let job: PodcastJob = { state: "idle", message: "", done: 0, total: 0, fraction: 0 };

export const podcastJob = (): PodcastJob => ({ ...job });

/** Start publishing in the background. Throws a readable error when the settings are not ready. */
export function startPublish(stationName: string): PodcastJob {
  if (job.state === "running") return podcastJob();

  const settings = loadPodcastSettings(stationName);
  if (!settings.siteUrl) {
    throw new Error("Add the web address the podcast will live at first. The feed needs it for every link.");
  }
  const shows = settings.episodes.map((id) => readShow(id)).filter((s): s is StoredShow => Boolean(s));
  const ready = shows.filter((s) => s.hasAudio && fs.existsSync(wavPath(s.id)));
  if (ready.length === 0) throw new Error("Choose at least one show with audio to publish.");

  job = { state: "running", message: "Starting", done: 0, total: ready.length, fraction: 0 };
  const current = job;

  publish(settings, ready, (update) => Object.assign(current, update))
    .then(() => {
      Object.assign(current, {
        state: "done",
        message: "Published",
        fraction: 1,
        finishedAt: new Date().toISOString(),
        published: ready.length,
      });
    })
    .catch((err: Error) => {
      Object.assign(current, { state: "failed", message: "Failed", error: err.message });
    });

  return podcastJob();
}

async function publish(
  settings: PodcastSettings,
  shows: StoredShow[],
  report: (update: Partial<PodcastJob>) => void,
): Promise<void> {
  const site = podcastSiteDir();
  const episodesDir = path.join(site, "episodes");
  fs.mkdirSync(episodesDir, { recursive: true });

  const index = readEncoded();
  const episodes: Episode[] = [];

  for (const [i, show] of shows.entries()) {
    report({ done: i, fraction: 0, message: `Preparing "${show.title}"` });

    if (!isEncoded(show.id, settings.quality, index)) {
      report({ message: `Encoding "${show.title}"` });
      const result = await wavToMp3(wavPath(show.id), mp3Path(show.id), {
        quality: settings.quality,
        tags: {
          title: show.title,
          artist: settings.author || settings.title,
          album: settings.title,
          year: show.createdAt.slice(0, 4),
        },
        onProgress: (fraction) => report({ fraction }),
      });
      index[show.id] = { quality: settings.quality, wavMtimeMs: fs.statSync(wavPath(show.id)).mtimeMs, bytes: result.bytes };
      fs.mkdirSync(podcastDir(), { recursive: true });
      atomicWriteJson(encodedFile(), index);
    }

    const episode: Episode = {
      id: show.id,
      title: show.title,
      summary: show.summary,
      createdAt: show.createdAt,
      duration: show.duration,
      hosts: show.hosts.map((h) => h.name),
      bytes: fs.statSync(mp3Path(show.id)).size,
      transcript: show.transcript.map((l) => ({ start: l.start, end: l.end, speaker: l.speaker, text: l.text })),
    };
    episodes.push(episode);

    atomicWriteText(path.join(episodesDir, `${show.id}.vtt`), buildVtt(episode.transcript));
    atomicWriteText(path.join(episodesDir, `${show.id}.html`), buildEpisodeHtml(settings, episode));
    report({ done: i + 1, fraction: 1 });
  }

  report({ message: "Writing the feed and website" });

  // Episodes taken out of the podcast must disappear from the folder too, or they stay online.
  const keep = new Set(shows.map((s) => s.id));
  for (const file of fs.readdirSync(episodesDir)) {
    const match = file.match(/^([a-z0-9-]+)\.(mp3|html|vtt|mp3\.part)$/);
    if (match && !keep.has(match[1])) fs.rmSync(path.join(episodesDir, file), { force: true });
  }

  const cover = coverImage(settings);
  for (const ext of ["png", "jpg"]) if (ext !== cover.ext) fs.rmSync(path.join(site, `cover.${ext}`), { force: true });
  fs.writeFileSync(path.join(site, `cover.${cover.ext}`), cover.data);

  atomicWriteText(path.join(site, "feed.xml"), buildFeed(settings, episodes, new Date(), `cover.${cover.ext}`));
  atomicWriteText(path.join(site, "index.html"), buildIndexHtml(settings, episodes, `cover.${cover.ext}`));
  // GitHub Pages otherwise runs the folder through Jekyll, which is slower and can skip files.
  fs.writeFileSync(path.join(site, ".nojekyll"), "");
}
