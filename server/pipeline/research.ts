/**
 * Optional grounding pass.
 *
 * Everything here is opt-in and best-effort: a show must still be generable
 * with no network at all. Sources are fetched, reduced to plain text, and
 * summarised by the local model so the hosts have real specifics to work from.
 */

import type { Config } from "../config.ts";
import { generate } from "../providers/llm.ts";

export interface Source {
  title: string;
  url: string;
  summary: string;
}

export interface ResearchResult {
  sources: Source[];
  notes: string[];
}

const FETCH_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 12_000;

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "local-talk-radio/1.0 (+local)", Accept: "text/html,application/json,text/plain" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Crude HTML-to-text. Good enough to feed a summariser; not a parser. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleFromHtml(html: string, fallback: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title || fallback;
}

/** Summarise fetched text down to something a host can actually use on air. */
async function summarise(config: Config, title: string, text: string, signal?: AbortSignal): Promise<string> {
  if (text.length < 200) return text;

  try {
    return await generate(config.llm, {
      messages: [
        {
          role: "system",
          content:
            "You are a radio researcher. You reduce source material to the facts a host needs on air: " +
            "what happened, the concrete numbers and names, and why it is interesting. Plain prose, no markdown.",
        },
        {
          role: "user",
          content: `Source: ${title}\n\n${text.slice(0, MAX_TEXT_CHARS)}\n\nSummarise the above in at most six sentences.`,
        },
      ],
      temperature: 0.3,
      maxTokens: 400,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    // Fall back to a raw excerpt rather than dropping the source entirely.
    return text.slice(0, 900);
  }
}

/** Top stories from Hacker News, via the public Firebase API. */
async function fetchHackerNews(config: Config, limit: number, signal?: AbortSignal): Promise<Source[]> {
  const idsRaw = await fetchText("https://hacker-news.firebaseio.com/v0/topstories.json");
  const ids = (JSON.parse(idsRaw) as number[]).slice(0, limit);

  const stories = await Promise.all(
    ids.map(async (id) => {
      try {
        const raw = await fetchText(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        return JSON.parse(raw) as { title?: string; url?: string; score?: number; descendants?: number; text?: string };
      } catch {
        return null;
      }
    }),
  );

  const out: Source[] = [];
  for (const story of stories) {
    if (!story?.title) continue;
    out.push({
      title: story.title,
      url: story.url ?? `https://news.ycombinator.com/item?id=${ids[out.length]}`,
      summary: [
        story.text ? htmlToText(story.text).slice(0, 600) : "",
        `${story.score ?? 0} points, ${story.descendants ?? 0} comments on Hacker News.`,
      ]
        .filter(Boolean)
        .join(" "),
    });
  }

  void config;
  void signal;
  return out;
}

export interface ResearchRequest {
  /** Raw URLs, one per line, plus the bare keyword "hackernews". */
  sources: string[];
  topic: string;
}

export async function runResearch(
  config: Config,
  request: ResearchRequest,
  onInfo: (message: string) => void,
  signal?: AbortSignal,
): Promise<ResearchResult> {
  const sources: Source[] = [];
  const notes: string[] = [];

  for (const entry of request.sources) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    try {
      if (/^hacker\s*news$|^hn$/i.test(trimmed)) {
        onInfo("Fetching top stories from Hacker News...");
        const stories = await fetchHackerNews(config, 5, signal);
        sources.push(...stories);
        notes.push(`Hacker News: ${stories.length} stories`);
        continue;
      }

      const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      onInfo(`Fetching ${url}...`);

      const body = await fetchText(url);
      const isJson = body.trimStart().startsWith("{") || body.trimStart().startsWith("[");
      const text = isJson ? body : htmlToText(body);
      const title = isJson ? url : titleFromHtml(body, url);

      onInfo(`Summarising ${title}...`);
      const summary = await summarise(config, title, text, signal);

      sources.push({ title, url, summary });
      notes.push(`${title} (${text.length} chars)`);
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      const message = `Could not use ${trimmed}: ${(err as Error).message}`;
      onInfo(message);
      notes.push(message);
    }
  }

  return { sources, notes };
}
