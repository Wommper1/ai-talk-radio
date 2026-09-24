/**
 * Procedural cover art.
 *
 * The hosted version called an image model for this. Locally we draw an SVG
 * instead: instant, free, offline, and deterministic from the show id — so a
 * given show always has the same cover, and the library looks varied.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Break a title into lines that fit the cover, by rough character width. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = candidate;
    }
  }

  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = `${last.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }

  return lines;
}

const PALETTES: Array<[string, string, string]> = [
  ["#0b1026", "#1f3a8a", "#f97316"], // deep blue / ember
  ["#0a0f0d", "#134e4a", "#f0abfc"], // teal / orchid
  ["#170a1f", "#4c1d95", "#22d3ee"], // violet / cyan
  ["#1a0b0b", "#7f1d1d", "#fbbf24"], // oxblood / amber
  ["#08120c", "#166534", "#a3e635"], // forest / lime
  ["#101014", "#3f3f46", "#e5e7eb"], // monochrome
  ["#0c1220", "#1e40af", "#38bdf8"], // night / sky
  ["#1c1108", "#92400e", "#fde68a"], // umber / gold
];

export function renderCoverSvg(show: {
  id: string;
  title: string;
  station: string;
  hosts: Array<{ name: string }>;
  createdAt: string;
}): string {
  const seed = hash(show.id);
  const rand = mulberry32(seed);
  const [bg, mid, accent] = PALETTES[seed % PALETTES.length];

  const size = 1024;
  const titleLines = wrap(show.title || "Untitled Show", 20, 3);
  const titleSize = titleLines.length >= 3 ? 78 : titleLines.length === 2 ? 92 : 104;
  const titleTop = 470 - (titleLines.length - 1) * (titleSize * 0.55);

  // ── Backdrop: concentric broadcast rings from a transmitter point.
  const originX = 190 + rand() * 120;
  const originY = 250 + rand() * 100;
  const rings = Array.from({ length: 9 }, (_, i) => {
    const r = 90 + i * (95 + rand() * 40);
    const opacity = (0.34 - i * 0.032).toFixed(3);
    const width = (3.2 - i * 0.22).toFixed(2);
    return `<circle cx="${originX.toFixed(0)}" cy="${originY.toFixed(0)}" r="${r.toFixed(0)}" fill="none" stroke="${accent}" stroke-opacity="${opacity}" stroke-width="${width}"/>`;
  }).join("");

  // ── A waveform strip across the lower third.
  const bars = 74;
  const barWidth = size / bars;
  const waveform = Array.from({ length: bars }, (_, i) => {
    // Two overlaid sines plus jitter reads as speech rather than noise.
    const envelope = Math.sin((i / bars) * Math.PI);
    const h = (0.35 + 0.65 * rand()) * envelope * 150 + Math.sin(i * 0.7) * 14 + 10;
    const height = Math.max(4, h);
    const x = i * barWidth + barWidth * 0.22;
    const y = 760 - height / 2;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barWidth * 0.56).toFixed(1)}" height="${height.toFixed(1)}" rx="${(barWidth * 0.28).toFixed(1)}" fill="${accent}" fill-opacity="${(0.28 + rand() * 0.5).toFixed(2)}"/>`;
  }).join("");

  const hostLine = show.hosts.map((h) => h.name).filter(Boolean).join("  ·  ");
  const dateLine = (show.createdAt || "").slice(0, 10);

  const titleTspans = titleLines
    .map((line, i) => `<tspan x="72" dy="${i === 0 ? 0 : titleSize * 1.12}">${escapeXml(line)}</tspan>`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${escapeXml(show.title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0%" stop-color="${mid}"/>
      <stop offset="60%" stop-color="${bg}"/>
      <stop offset="100%" stop-color="${bg}"/>
    </linearGradient>
    <radialGradient id="glow" cx="${((originX / size) * 100).toFixed(0)}%" cy="${((originY / size) * 100).toFixed(0)}%" r="60%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="frame"><rect width="${size}" height="${size}"/></clipPath>
  </defs>

  <g clip-path="url(#frame)">
    <rect width="${size}" height="${size}" fill="url(#bg)"/>
    ${rings}
    <rect width="${size}" height="${size}" fill="url(#glow)"/>

    <text x="72" y="120" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26" letter-spacing="7" fill="${accent}" fill-opacity="0.95">${escapeXml(show.station.toUpperCase())}</text>
    <line x1="72" y1="150" x2="${size - 72}" y2="150" stroke="${accent}" stroke-opacity="0.28" stroke-width="2"/>

    <text x="72" y="${titleTop}" font-family="Georgia, 'Times New Roman', serif" font-size="${titleSize}" font-weight="700" fill="#ffffff" letter-spacing="-1">${titleTspans}</text>

    ${waveform}

    <text x="72" y="890" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="27" fill="#ffffff" fill-opacity="0.82" letter-spacing="2">${escapeXml(hostLine)}</text>
    <text x="72" y="936" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="21" fill="#ffffff" fill-opacity="0.45" letter-spacing="3">${escapeXml(dateLine)}</text>

    <rect x="0" y="0" width="${size}" height="${size}" fill="none" stroke="${accent}" stroke-opacity="0.22" stroke-width="10"/>
  </g>
</svg>`;
}
