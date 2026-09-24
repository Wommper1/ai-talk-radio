/**
 * Generate the desktop icon: a 256x256 PNG wrapped in an ICO container.
 *
 * Written by hand with Node's zlib so the project needs no image library.
 * The mark matches the app header: an amber transmitter dot inside a ring,
 * with broadcast arcs radiating from it.
 */

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const SIZE = 256;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const INK: Rgba = { r: 10, g: 10, b: 12, a: 255 };
const AMBER: Rgba = { r: 245, g: 165, b: 36, a: 255 };

/** Blend `src` over `dst` using src's alpha. */
function over(dst: Rgba, src: Rgba, alpha: number): Rgba {
  const a = Math.max(0, Math.min(1, alpha));
  return {
    r: Math.round(dst.r * (1 - a) + src.r * a),
    g: Math.round(dst.g * (1 - a) + src.g * a),
    b: Math.round(dst.b * (1 - a) + src.b * a),
    a: Math.max(dst.a, Math.round(255 * a)),
  };
}

/** Coverage of a ring edge at distance `d`, antialiased over ~1.5px. */
function ringAlpha(d: number, radius: number, halfWidth: number): number {
  const edge = Math.abs(d - radius);
  return 1 - smoothstep(halfWidth - 0.75, halfWidth + 0.75, edge);
}

function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function render(): Buffer {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const cx = SIZE / 2 - 0.5;
  const cy = SIZE / 2 - 0.5;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);

      let px: Rgba = { r: 0, g: 0, b: 0, a: 0 };

      // Dark disc body, antialiased at the rim.
      const bodyAlpha = 1 - smoothstep(122, 124.5, d);
      if (bodyAlpha > 0) px = over(px, INK, bodyAlpha);

      // Outer amber rim.
      px = over(px, AMBER, ringAlpha(d, 121, 3.5) * 0.95);

      // Broadcast arcs, brighter towards the centre.
      for (const [radius, strength] of [
        [92, 0.5],
        [70, 0.62],
        [48, 0.76],
      ] as const) {
        // Leave a gap at the bottom so it reads as a signal, not a target.
        const angle = Math.atan2(dy, dx);
        const inGap = angle > 0.55 && angle < 2.59;
        if (inGap) continue;
        px = over(px, AMBER, ringAlpha(d, radius, 3.2) * strength);
      }

      // Centre transmitter dot.
      px = over(px, AMBER, 1 - smoothstep(24, 26.5, d));

      const i = (y * SIZE + x) * 4;
      pixels[i] = px.r;
      pixels[i + 1] = px.g;
      pixels[i + 2] = px.b;
      pixels[i + 3] = px.a;
    }
  }

  return pixels;
}

/* ── PNG encoding ────────────────────────────────────────────────── */

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 means "none".
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Wrap a PNG in a single-image ICO. Windows Vista and later read PNG icons. */
function encodeIco(png: Buffer): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256 is encoded as 0
  entry[1] = 0; // height 256
  entry[2] = 0; // palette size
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset to image data

  return Buffer.concat([header, entry, png]);
}

const outDir = path.join(process.cwd(), "launcher");
fs.mkdirSync(outDir, { recursive: true });

const png = encodePng(render());
const ico = encodeIco(png);

fs.writeFileSync(path.join(outDir, "icon.png"), png);
fs.writeFileSync(path.join(outDir, "icon.ico"), ico);

console.log(`wrote launcher/icon.png (${png.length} bytes)`);
console.log(`wrote launcher/icon.ico (${ico.length} bytes)`);
