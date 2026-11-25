/**
 * The podcast's public files: RSS feed, website pages and transcripts.
 *
 * Pure functions from settings and episode details to text, so they can be
 * tested without a server, a disk or audio. Everything that came from a person
 * or a model is escaped on the way out.
 */

import type { PodcastQuality } from "./mp3.ts";

export const PODCAST_CATEGORIES = [
  "Arts",
  "Comedy",
  "Education",
  "Fiction",
  "History",
  "Leisure",
  "News",
  "Science",
  "Society & Culture",
  "Technology",
  "TV & Film",
] as const;

export interface PodcastSettings {
  title: string;
  author: string;
  description: string;
  /** Where the folder will be hosted, e.g. https://name.github.io/my-show/. Feed links are built from it. */
  siteUrl: string;
  language: string;
  category: (typeof PODCAST_CATEGORIES)[number];
  explicit: boolean;
  /** Optional. Directories email it to confirm you own the feed, so it is public in the feed. */
  ownerEmail: string;
  quality: PodcastQuality;
  /** Add a line to each episode saying it was made with AI. */
  aiNotice: boolean;
  /** Show ids to publish. Nothing is published unless it is chosen. */
  episodes: string[];
}

export const AI_NOTICE = "Written and voiced by AI, produced with Local Talk Radio.";

export function defaultPodcastSettings(stationName: string): PodcastSettings {
  return {
    title: stationName || "Local Talk Radio",
    author: "",
    description: `Two radio hosts talk it out. ${AI_NOTICE}`,
    siteUrl: "",
    language: "en",
    category: "Comedy",
    explicit: false,
    ownerEmail: "",
    quality: "standard",
    aiNotice: true,
    episodes: [],
  };
}

const clip = (value: unknown, max: number, fallback = "") =>
  (typeof value === "string" ? value : fallback).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);

/** A site address is only kept if it is an http(s) URL; it always ends in "/" so file names can be added. */
export function normalizeSiteUrl(value: unknown): string {
  const raw = clip(value, 300).trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    url.hash = "";
    url.search = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.toString();
  } catch {
    return "";
  }
}

export function normalizePodcastSettings(raw: unknown, stationName: string): PodcastSettings {
  const d = defaultPodcastSettings(stationName);
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const email = clip(r.ownerEmail, 200).trim();
  return {
    title: clip(r.title, 200, d.title).trim() || d.title,
    author: clip(r.author, 200).trim(),
    description: clip(r.description, 4000, d.description).trim() || d.description,
    siteUrl: normalizeSiteUrl(r.siteUrl),
    language: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(r.language ?? "")) ? String(r.language) : d.language,
    category: (PODCAST_CATEGORIES as readonly string[]).includes(String(r.category))
      ? (r.category as PodcastSettings["category"])
      : d.category,
    explicit: r.explicit === true,
    ownerEmail: /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email) ? email : "",
    quality: r.quality === "small" || r.quality === "high" ? r.quality : "standard",
    aiNotice: r.aiNotice !== false,
    episodes: Array.isArray(r.episodes)
      ? [...new Set(r.episodes.filter((id): id is string => typeof id === "string" && /^[a-z0-9-]{1,120}$/.test(id)))]
      : [],
  };
}

export interface EpisodeLine {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

export interface Episode {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  /** Seconds. */
  duration: number;
  hosts: string[];
  /** Size of the MP3 in bytes; the feed's enclosure needs it. */
  bytes: number;
  transcript: EpisodeLine[];
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const escapeHtml = (s: string) => escapeXml(s).replace(/&apos;/g, "&#39;");

function joinNames(names: string[]): string {
  const n = names.filter(Boolean);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

export function episodeDescription(ep: Episode, settings: PodcastSettings): string {
  const parts = [ep.summary.trim() || ep.title];
  if (ep.hosts.length) parts.push(`Hosted by ${joinNames(ep.hosts)}.`);
  if (settings.aiNotice) parts.push(AI_NOTICE);
  return parts.join("\n\n");
}

/** "1:02:03" or "12:34". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function vttTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/** WebVTT with one voiced cue per line, which podcast apps can show as a live transcript. */
export function buildVtt(lines: EpisodeLine[]): string {
  const cues = lines
    .filter((l) => l.text.trim() && l.end > l.start)
    .map((l) => {
      // "-->" and blank lines would end a cue early; < and & are markup in VTT.
      const text = l.text.replace(/-->/g, "->").replace(/\s*\n\s*/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const voice = l.speaker.replace(/[<>&\n]/g, "").trim();
      return `${vttTime(l.start)} --> ${vttTime(l.end)}\n${voice ? `<v ${voice}>` : ""}${text}`;
    });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

const pubDate = (iso: string) => {
  const d = new Date(iso);
  return (Number.isNaN(d.getTime()) ? new Date(0) : d).toUTCString();
};

/** RSS 2.0 with the iTunes and Podcasting 2.0 tags the big directories read. Newest episode first. */
export function buildFeed(settings: PodcastSettings, episodes: Episode[], built = new Date(), coverFile = "cover.png"): string {
  const base = settings.siteUrl;
  const url = (file: string) => base + file.split("/").map(encodeURIComponent).join("/");
  const sorted = [...episodes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const author = settings.author || settings.title;

  const items = sorted
    .map(
      (ep) => `    <item>
      <title>${escapeXml(ep.title)}</title>
      <description>${escapeXml(episodeDescription(ep, settings))}</description>
      <link>${escapeXml(url(`episodes/${ep.id}.html`))}</link>
      <guid isPermaLink="false">${escapeXml(ep.id)}</guid>
      <pubDate>${pubDate(ep.createdAt)}</pubDate>
      <enclosure url="${escapeXml(url(`episodes/${ep.id}.mp3`))}" length="${ep.bytes}" type="audio/mpeg"/>
      <itunes:duration>${Math.round(ep.duration)}</itunes:duration>
      <itunes:episodeType>full</itunes:episodeType>
      <itunes:explicit>${settings.explicit ? "true" : "false"}</itunes:explicit>
      <podcast:transcript url="${escapeXml(url(`episodes/${ep.id}.vtt`))}" type="text/vtt" language="${escapeXml(settings.language)}"/>
    </item>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(settings.title)}</title>
    <link>${escapeXml(base)}</link>
    <atom:link href="${escapeXml(url("feed.xml"))}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(settings.description)}</description>
    <language>${escapeXml(settings.language)}</language>
    <lastBuildDate>${built.toUTCString()}</lastBuildDate>
    <generator>Local Talk Radio</generator>
    <itunes:author>${escapeXml(author)}</itunes:author>
    <itunes:summary>${escapeXml(settings.description)}</itunes:summary>
    <itunes:image href="${escapeXml(url(coverFile))}"/>
    <image>
      <url>${escapeXml(url(coverFile))}</url>
      <title>${escapeXml(settings.title)}</title>
      <link>${escapeXml(base)}</link>
    </image>
    <itunes:category text="${escapeXml(settings.category)}"/>
    <itunes:explicit>${settings.explicit ? "true" : "false"}</itunes:explicit>
    <itunes:type>episodic</itunes:type>${
      settings.ownerEmail
        ? `
    <itunes:owner>
      <itunes:name>${escapeXml(author)}</itunes:name>
      <itunes:email>${escapeXml(settings.ownerEmail)}</itunes:email>
    </itunes:owner>`
        : ""
    }
${items}
  </channel>
</rss>
`;
}

const PAGE_STYLE = `
  :root { color-scheme: dark; --bg:#0b0b0f; --panel:#15151b; --line:#26262f; --text:#ececf1; --dim:#a1a1ad; --accent:#f5a524; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width:760px; margin:0 auto; padding:32px 16px 64px; }
  a { color:var(--accent); }
  header.show { display:flex; gap:20px; align-items:center; flex-wrap:wrap; margin-bottom:28px; }
  header.show img { width:160px; height:160px; border-radius:12px; border:1px solid var(--line); }
  h1 { font-size:1.9rem; line-height:1.2; margin:0 0 6px; }
  h2 { font-size:1.2rem; margin:0 0 4px; }
  p.dim, .dim { color:var(--dim); }
  .subscribe { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin:0 0 28px; font-size:.95rem; }
  .subscribe code { word-break:break-all; color:var(--text); }
  article { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; margin:0 0 14px; }
  audio { width:100%; margin-top:10px; }
  ol.transcript { list-style:none; padding:0; margin:24px 0 0; }
  ol.transcript li { padding:8px 0; border-top:1px solid var(--line); }
  ol.transcript .who { font-weight:600; margin-right:6px; }
  ol.transcript .t { color:var(--dim); font-size:.8rem; font-variant-numeric:tabular-nums; margin-right:8px; }
  footer { margin-top:40px; color:var(--dim); font-size:.85rem; }
`;

function page(title: string, body: string, description: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description.slice(0, 300))}">
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
${body}
<footer>Made with <a href="https://github.com/Wommper1/ai-talk-radio">Local Talk Radio</a>.</footer>
</main>
</body>
</html>
`;
}

const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => `<p class="dim">${escapeHtml(p.trim())}</p>`)
    .join("\n");

/** The podcast's home page: cover, description, how to subscribe, and every episode with a player. */
export function buildIndexHtml(settings: PodcastSettings, episodes: Episode[], coverFile = "cover.png"): string {
  const sorted = [...episodes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const feedUrl = `${settings.siteUrl}feed.xml`;
  const list = sorted
    .map(
      (ep) => `<article>
  <h2><a href="episodes/${encodeURIComponent(ep.id)}.html">${escapeHtml(ep.title)}</a></h2>
  <div class="dim">${escapeHtml(new Date(ep.createdAt).toDateString())} · ${clock(ep.duration)}</div>
  ${paragraphs(ep.summary)}
  <audio controls preload="none" src="episodes/${encodeURIComponent(ep.id)}.mp3"></audio>
</article>`,
    )
    .join("\n");

  return page(
    settings.title,
    `<header class="show">
  <img src="${encodeURIComponent(coverFile)}" alt="">
  <div>
    <h1>${escapeHtml(settings.title)}</h1>
    ${settings.author ? `<div class="dim">${escapeHtml(settings.author)}</div>` : ""}
  </div>
</header>
${paragraphs(settings.description)}
<div class="subscribe">To subscribe, copy this address into your podcast app (look for "Add by URL" or "Follow a show by URL"):<br><code>${escapeHtml(feedUrl)}</code><br><a href="feed.xml">Open the feed</a></div>
${list || '<p class="dim">No episodes yet.</p>'}`,
    settings.description,
  );
}

/** One episode: player, description and the full timed transcript. */
export function buildEpisodeHtml(settings: PodcastSettings, ep: Episode): string {
  const lines = ep.transcript
    .filter((l) => l.text.trim())
    .map(
      (l) =>
        `<li><span class="t">${clock(l.start)}</span><span class="who">${escapeHtml(l.speaker)}</span>${escapeHtml(l.text)}</li>`,
    )
    .join("\n");

  return page(
    `${ep.title} · ${settings.title}`,
    `<p><a href="../index.html">← ${escapeHtml(settings.title)}</a></p>
<h1>${escapeHtml(ep.title)}</h1>
<div class="dim">${escapeHtml(new Date(ep.createdAt).toDateString())} · ${clock(ep.duration)}</div>
<audio controls preload="metadata" src="${encodeURIComponent(ep.id)}.mp3"></audio>
${paragraphs(episodeDescription(ep, settings))}
<h2>Transcript</h2>
<ol class="transcript">
${lines}
</ol>`,
    episodeDescription(ep, settings),
  );
}
