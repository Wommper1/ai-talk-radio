/**
 * Long-term memory across shows.
 *
 * This is what lets a host say "like we said a couple of weeks back" and be
 * right about it. Past shows are chunked, indexed, and the most relevant
 * passages are retrieved for tonight's topic.
 *
 * Two backends:
 *   lexical    — BM25 over the words. No model, no VRAM, instant, offline.
 *   embeddings — vectors from an OpenAI-compatible /v1/embeddings endpoint.
 *
 * Lexical is the default deliberately. On a 6 GB card an embedding model is
 * competing with the model actually writing the show, and for "did we discuss
 * this before" over a few dozen transcripts BM25 is genuinely competitive.
 * Embeddings are there when the topic wording differs from the wording used
 * on air, which is exactly where keyword search falls down.
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../lib/atomic-file.ts";
import type { Config, MemoryConfig } from "../config.ts";
import { resolveBaseUrl } from "../providers/llm.ts";
import { CURRENT_SHOW_FORMAT, listShows, type StoredShow } from "../pipeline/store.ts";

export interface Passage {
  showId: string;
  showTitle: string;
  date: string;
  speaker: string;
  text: string;
}

export interface Recollection extends Passage {
  score: number;
}

const INDEX_PATH = path.join(process.cwd(), "memory", "index.json");

interface IndexEntry extends Passage {
  /** Lower-cased tokens, kept so scoring does not re-tokenise every query. */
  tokens: string[];
  /** Present only when the embeddings backend built this entry. */
  vector?: number[];
}

interface MemoryIndex {
  formatVersion: number;
  backend: "lexical" | "embeddings";
  model: string;
  entries: IndexEntry[];
  /** Show ids already indexed, so rebuilding is incremental. */
  indexed: string[];
}

export function isRecallEligible(show: Pick<StoredShow, "generationVersion">): boolean {
  return show.generationVersion === CURRENT_SHOW_FORMAT;
}

/* ── Tokenising ──────────────────────────────────────────────────── */

const STOPWORDS = new Set(
  ("a an the and or but if then than that this these those is are was were be been being do does did " +
    "i you he she it we they me him her them my your his its our their of to in on at for with about " +
    "from by as so just really very quite even not no yes what which who whom when where why how all " +
    "any some most more much many because while during before after here there now well like get got " +
    "know think say said going gonna want need let make made take taken thing things right okay yeah")
    .split(" "),
);

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter((w) => w.length > 2 && w.length < 30 && !STOPWORDS.has(w));
}

/* ── BM25 ────────────────────────────────────────────────────────── */

const K1 = 1.4;
const B = 0.72;

function bm25(query: string[], entries: IndexEntry[]): number[] {
  const total = entries.length;
  if (total === 0) return [];

  const avgLength = entries.reduce((n, e) => n + e.tokens.length, 0) / total;

  // Document frequency for each query term.
  const df = new Map<string, number>();
  for (const term of new Set(query)) {
    let count = 0;
    for (const entry of entries) {
      if (entry.tokens.includes(term)) count++;
    }
    df.set(term, count);
  }

  return entries.map((entry) => {
    const length = entry.tokens.length || 1;
    let score = 0;

    for (const term of new Set(query)) {
      const n = df.get(term) ?? 0;
      if (n === 0) continue;

      let tf = 0;
      for (const t of entry.tokens) if (t === term) tf++;
      if (tf === 0) continue;

      const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (length / avgLength))));
    }

    return score;
  });
}

/* ── Embeddings ──────────────────────────────────────────────────── */

async function embed(config: Config, texts: string[]): Promise<number[][]> {
  const base = resolveBaseUrl(config.llm);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.llm.apiKey) headers["Authorization"] = `Bearer ${config.llm.apiKey}`;

  const res = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: config.memory.embeddingModel, input: texts }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Embeddings request failed (HTTP ${res.status}). ` +
        `Load "${config.memory.embeddingModel}" in your server, or switch memory back to lexical. ${body.slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const vectors = (body.data ?? []).map((d) => d.embedding ?? []);
  if (vectors.length !== texts.length) throw new Error("Embeddings response did not match the input count");

  return vectors;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/* ── Index ───────────────────────────────────────────────────────── */

/** Turn a show into passages. Adjacent turns are paired so context survives. */
function passagesFor(show: StoredShow): Passage[] {
  const lines = show.transcript ?? [];
  const out: Passage[] = [];

  for (let i = 0; i < lines.length; i += 2) {
    const chunk = lines.slice(i, i + 2);
    const text = chunk.map((l) => `${l.speaker}: ${l.text}`).join(" ");
    if (text.trim().length < 40) continue;

    out.push({
      showId: show.id,
      showTitle: show.title,
      date: (show.createdAt ?? "").slice(0, 10),
      speaker: chunk.map((l) => l.speaker).join(" & "),
      text: text.slice(0, 900),
    });
  }

  return out;
}

function loadIndex(): MemoryIndex | null {
  try {
    if (!fs.existsSync(INDEX_PATH)) return null;
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8")) as MemoryIndex;
  } catch {
    return null;
  }
}

function saveIndex(index: MemoryIndex): void {
  atomicWriteJson(INDEX_PATH, index, false);
}

export interface BuildResult {
  backend: string;
  shows: number;
  passages: number;
  added: number;
  error?: string;
}

/**
 * Bring the index up to date. Only shows that are not already in it are
 * processed, so this is cheap to call before every generation.
 */
export async function buildIndex(config: Config, force = false): Promise<BuildResult> {
  const backend = config.memory.backend === "embeddings" ? "embeddings" : "lexical";
  const model = backend === "embeddings" ? config.memory.embeddingModel : "";

  let index = loadIndex();

  // A generation-format, backend or model change invalidates derived recall.
  if (
    force ||
    !index ||
    index.formatVersion !== CURRENT_SHOW_FORMAT ||
    index.backend !== backend ||
    index.model !== model
  ) {
    index = { formatVersion: CURRENT_SHOW_FORMAT, backend, model, entries: [], indexed: [] };
  }

  // Old episodes remain in the library, but their pre-upgrade dialogue must
  // not teach a freshly upgraded DJ to fall back into those habits.
  const shows = listShows().filter(isRecallEligible);
  const known = new Set(index.indexed);
  const fresh = shows.filter((s) => !known.has(s.id));

  // Shows deleted from disk should not linger in memory.
  const live = new Set(shows.map((s) => s.id));
  index.entries = index.entries.filter((e) => live.has(e.showId));
  index.indexed = index.indexed.filter((id) => live.has(id));

  let added = 0;

  for (const show of fresh) {
    const passages = passagesFor(show);
    if (passages.length === 0) {
      index.indexed.push(show.id);
      continue;
    }

    if (backend === "embeddings") {
      try {
        const vectors = await embed(config, passages.map((p) => p.text));
        passages.forEach((p, i) => {
          index!.entries.push({ ...p, tokens: tokenise(p.text), vector: vectors[i] });
        });
      } catch (err) {
        saveIndex(index);
        return {
          backend,
          shows: index.indexed.length,
          passages: index.entries.length,
          added,
          error: (err as Error).message,
        };
      }
    } else {
      for (const p of passages) index.entries.push({ ...p, tokens: tokenise(p.text) });
    }

    index.indexed.push(show.id);
    added += passages.length;
  }

  saveIndex(index);
  return { backend, shows: index.indexed.length, passages: index.entries.length, added };
}

/** Find passages from past shows relevant to a topic. */
export async function recall(
  config: Config,
  query: string,
  limit = 4,
  excludeShowId?: string,
): Promise<Recollection[]> {
  const index = loadIndex();
  if (!index || index.formatVersion !== CURRENT_SHOW_FORMAT || index.entries.length === 0) return [];

  const pool = excludeShowId ? index.entries.filter((e) => e.showId !== excludeShowId) : index.entries;
  if (pool.length === 0) return [];

  let scores: number[];

  if (index.backend === "embeddings") {
    try {
      const [vector] = await embed(config, [query]);
      scores = pool.map((e) => (e.vector ? cosine(vector, e.vector) : 0));
    } catch {
      // Fall back to keywords rather than losing memory entirely.
      scores = bm25(tokenise(query), pool);
    }
  } else {
    scores = bm25(tokenise(query), pool);
  }

  const ranked = pool
    .map((entry, i) => ({ ...entry, score: scores[i] ?? 0 }))
    .filter((r) => r.score > (index.backend === "embeddings" ? 0.35 : 1.5))
    .sort((a, b) => b.score - a.score);

  // At most one passage per past show, so recall is varied rather than
  // four quotes from the same episode.
  const seen = new Set<string>();
  const picked: Recollection[] = [];

  for (const r of ranked) {
    if (seen.has(r.showId)) continue;
    seen.add(r.showId);
    picked.push(r);
    if (picked.length >= limit) break;
  }

  return picked;
}

export function memoryStats(): { backend: string; shows: number; passages: number; path: string; eligibleShows: number; excludedLegacyShows: number } {
  const index = loadIndex();
  const current = index?.formatVersion === CURRENT_SHOW_FORMAT ? index : null;
  const library = listShows();
  const eligibleShows = library.filter(isRecallEligible).length;
  return {
    backend: current?.backend ?? "none",
    shows: current?.indexed.length ?? 0,
    passages: current?.entries.length ?? 0,
    path: INDEX_PATH,
    eligibleShows,
    excludedLegacyShows: library.length - eligibleShows,
  };
}

export function clearIndex(): void {
  fs.rmSync(INDEX_PATH, { force: true });
}

/** Render recalled passages as a prompt block. */
/**
 * Strip a recalled passage back to its substance.
 *
 * Raw transcript carries the speaker labels, the station name and the host
 * names as they were on the night — and a small model shown
 * "Alex: Welcome to Wommper1, folks..." will open tonight's show with exactly
 * that: wrong station, greeting a co-host who does not work here any more.
 * Measured on a real show, and it is the worst thing recall does.
 *
 * So the labels come off, the top-of-show furniture comes off, and what is
 * left is offered as a note about the subject rather than a line to reuse.
 */
function gistOf(text: string): string {
  let out = String(text ?? "").replace(/\s+/g, " ").trim();

  // "Name: " labels, wherever they fall in the passage.
  out = out.replace(/(?:^|(?<=[.!?] ))[A-Z][\w'’-]{1,20}(?: [A-Z][\w'’-]{1,20})?:\s*/g, "");

  // Top-of-show furniture: never the interesting part of a recollection, and
  // the part most likely to come back word for word.
  out = out.replace(
    /^(?:welcome (?:back )?to|you(?:'re| are) listening to|this is|good (?:evening|morning|afternoon))\b[^.!?]*[.!?]\s*/i,
    "",
  );
  out = out.replace(/^(?:hi|hey|hello|so|right|okay|well|folks)\b[,.!]?\s*/i, "");

  return out.slice(0, 200).trim();
}

export function recallBlock(items: Recollection[]): string {
  const lines = items
    .map((r) => ({ date: r.date, gist: gistOf(r.text) }))
    .filter((r) => r.gist.length > 30)
    .map((r) => `- ${r.date}: ${r.gist}`);

  if (lines.length === 0) return "";

  return (
    "WHAT THIS SHOW HAS COVERED BEFORE — subject matter only, from older episodes.\n" +
    "These are notes, not lines. Refer to one in your own words if it genuinely fits tonight " +
    '("we went round on this a few weeks back"), and never reuse the wording, the names, or the ' +
    "station name inside them — those are from a different show. Never invent a past episode that " +
    "is not listed here:\n" +
    lines.join("\n")
  );
}

export type { MemoryConfig };
