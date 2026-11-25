/**
 * A podcast cover drawn as a PNG, with no image library.
 *
 * Podcast directories require square JPEG or PNG art of at least 1400 px; the
 * station's own covers are SVG. This draws a gradient, radio-wave rings and the
 * title in a chunky pixel font, deterministic from the title, and encodes it
 * with Node's own zlib. Anyone who wants real artwork uploads their own.
 */

import zlib from "node:zlib";

const SIZE = 1400;

/* 5×7 pixel font. Lower case is drawn as upper case; anything unknown is a space. */
const GLYPHS: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  "&": [".##..", "#..#.", "#.#..", ".#...", "#.#.#", "#..#.", ".##.#"],
  "'": ["..#..", "..#..", ".#...", ".....", ".....", ".....", "....."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", "..#..", ".#..."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** Break the title into lines of at most `max` characters, on word boundaries. */
function wrap(text: string, max: number, maxLines: number): string[] {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const w = word.length > max ? word.slice(0, max) : word;
    if (!line) line = w;
    else if (line.length + 1 + w.length <= max) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, max - 1)}.`;
  }
  return lines;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A 1400×1400 PNG cover for `title`, with `subtitle` in smaller type underneath. */
export function podcastCoverPng(title: string, subtitle = "AI TALK RADIO"): Buffer {
  const seed = hash(title);
  const hue = seed % 360;
  const top = hsl(hue, 0.55, 0.16);
  const bottom = hsl((hue + 40) % 360, 0.6, 0.07);
  const ring = hsl((hue + 200) % 360, 0.85, 0.6);
  const ink: [number, number, number] = [255, 248, 235];
  const accent = hsl((hue + 200) % 360, 0.9, 0.65);

  // One row = filter byte + RGB pixels.
  const stride = SIZE * 3 + 1;
  const px = Buffer.alloc(stride * SIZE);

  // Radio waves radiate from a point near the bottom-left.
  const cx = SIZE * 0.18;
  const cy = SIZE * 0.86;
  const spacing = 70;

  for (let y = 0; y < SIZE; y++) {
    const row = y * stride;
    px[row] = 0;
    const t = y / (SIZE - 1);
    for (let x = 0; x < SIZE; x++) {
      let r = top[0] + (bottom[0] - top[0]) * t;
      let g = top[1] + (bottom[1] - top[1]) * t;
      let b = top[2] + (bottom[2] - top[2]) * t;

      const d = Math.hypot(x - cx, y - cy);
      const band = d % spacing;
      if (d > 60 && d < SIZE * 1.1 && band < 10) {
        const fade = Math.max(0, 1 - d / (SIZE * 1.1)) * 0.55;
        r += (ring[0] - r) * fade;
        g += (ring[1] - g) * fade;
        b += (ring[2] - b) * fade;
      }
      if (d < 34) [r, g, b] = accent;

      const o = row + 1 + x * 3;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
    }
  }

  const drawText = (lines: string[], scale: number, startY: number, color: [number, number, number]) => {
    const advance = 6 * scale; // 5 px glyph + 1 px gap
    const lineHeight = 10 * scale;
    lines.forEach((line, li) => {
      const width = line.length * advance - scale;
      const left = Math.round((SIZE - width) / 2);
      const top = startY + li * lineHeight;
      [...line].forEach((ch, ci) => {
        const glyph = GLYPHS[ch] ?? GLYPHS[" "];
        for (let gy = 0; gy < 7; gy++) {
          for (let gx = 0; gx < 5; gx++) {
            if (glyph[gy][gx] !== "#") continue;
            for (let sy = 0; sy < scale; sy++) {
              const y = top + gy * scale + sy;
              if (y < 0 || y >= SIZE) continue;
              for (let sx = 0; sx < scale; sx++) {
                const x = left + ci * advance + gx * scale + sx;
                if (x < 0 || x >= SIZE) continue;
                const o = y * stride + 1 + x * 3;
                px[o] = color[0];
                px[o + 1] = color[1];
                px[o + 2] = color[2];
              }
            }
          }
        }
      });
    });
  };

  // Big title: as large as fits, up to four lines.
  // Narrow lines make bigger type, so use the narrowest wrap that keeps the whole title within four lines.
  const text = title.trim() || "Local Talk Radio";
  let lines: string[] = [];
  for (const width of [8, 10, 12, 14, 16, 20]) {
    lines = wrap(text, width, 99);
    if (lines.length <= 4) break;
  }
  if (lines.length > 4) lines = wrap(text, 20, 4);
  const longest = Math.max(...lines.map((l) => l.length));
  const scale = Math.max(6, Math.min(24, Math.floor((SIZE * 0.86) / (longest * 6)), Math.floor((SIZE * 0.6) / (lines.length * 10))));

  const titleHeight = lines.length * 10 * scale - 3 * scale;
  const titleTop = Math.round(SIZE * 0.42 - titleHeight / 2);
  drawText(lines, scale, titleTop, ink);
  drawText(wrap(subtitle, 22, 1), 7, titleTop + titleHeight + 6 * scale, accent);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(px, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
