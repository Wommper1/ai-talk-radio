/**
 * WAV → MP3 for the podcast feed.
 *
 * Finished shows are up to 48 kHz / 24-bit stereo WAV, around 400 MB for a long
 * one, which no podcast host or listener wants. This streams the file through
 * LAME (the pure-JavaScript port, LGPL-3.0, kept as its own module) a block at
 * a time, so a 30-minute show never has to sit in memory as floats.
 */

import fs from "node:fs";
import { Mp3Encoder } from "@breezystack/lamejs";

export type PodcastQuality = "small" | "standard" | "high";

/** Bitrate and channel count per quality. "small" folds stereo down to mono. */
export const QUALITY: Record<PodcastQuality, { kbps: number; mono: boolean; label: string }> = {
  small: { kbps: 64, mono: true, label: "Small: 64 kbps mono" },
  standard: { kbps: 96, mono: false, label: "Standard: 96 kbps stereo" },
  high: { kbps: 128, mono: false, label: "High: 128 kbps stereo" },
};

interface WavLayout {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataStart: number;
  dataBytes: number;
}

/** Find the fmt and data chunks without reading the whole file. */
function readLayout(fd: number): WavLayout {
  const head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }

  const size = fs.fstatSync(fd).size;
  let pos = 12;
  let fmt: Omit<WavLayout, "dataStart" | "dataBytes"> | null = null;
  const chunk = Buffer.alloc(8);

  while (pos + 8 <= size) {
    fs.readSync(fd, chunk, 0, 8, pos);
    const id = chunk.toString("ascii", 0, 4);
    const length = chunk.readUInt32LE(4);
    const body = pos + 8;

    if (id === "fmt ") {
      const f = Buffer.alloc(16);
      fs.readSync(fd, f, 0, 16, body);
      let audioFormat = f.readUInt16LE(0);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in the sub-format GUID.
      if (audioFormat === 0xfffe && length >= 26) {
        const ext = Buffer.alloc(2);
        fs.readSync(fd, ext, 0, 2, body + 24);
        audioFormat = ext.readUInt16LE(0);
      }
      fmt = { audioFormat, channels: f.readUInt16LE(2), sampleRate: f.readUInt32LE(4), bitsPerSample: f.readUInt16LE(14) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before format");
      return { ...fmt, dataStart: body, dataBytes: Math.min(length, size - body) };
    }
    pos = body + length + (length % 2);
  }
  throw new Error("WAV has no audio data");
}

function sampleReader(layout: WavLayout): (buf: Buffer, offset: number) => number {
  const { audioFormat, bitsPerSample } = layout;
  if (audioFormat === 3) return bitsPerSample === 64 ? (b, o) => b.readDoubleLE(o) : (b, o) => b.readFloatLE(o);
  switch (bitsPerSample) {
    case 8:
      return (b, o) => (b.readUInt8(o) - 128) / 128;
    case 16:
      return (b, o) => b.readInt16LE(o) / 32768;
    case 24:
      return (b, o) => {
        const v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
        return (v & 0x800000 ? v - 0x1000000 : v) / 8388608;
      };
    case 32:
      return (b, o) => b.readInt32LE(o) / 2147483648;
    default:
      throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);
  }
}

const toInt16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));

/** ID3v2.3 text frame: id, size, flags, then ISO-8859-1 or UTF-16 text. */
function textFrame(id: string, text: string): Buffer {
  const latin1 = /^[\x00-\xff]*$/.test(text);
  const body = latin1
    ? Buffer.concat([Buffer.from([0]), Buffer.from(text, "latin1")])
    : Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  const header = Buffer.alloc(10);
  header.write(id, 0, "ascii");
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** A small ID3v2.3 tag so players show the episode's title, show and year. */
export function id3Tag(tags: { title: string; artist: string; album: string; year?: string; genre?: string }): Buffer {
  const frames = [
    textFrame("TIT2", tags.title),
    textFrame("TPE1", tags.artist),
    textFrame("TALB", tags.album),
    ...(tags.year ? [textFrame("TYER", tags.year)] : []),
    textFrame("TCON", tags.genre ?? "Podcast"),
  ];
  const body = Buffer.concat(frames);
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
  // Tag size is four 7-bit bytes ("synchsafe").
  const n = body.length;
  header[6] = (n >> 21) & 0x7f;
  header[7] = (n >> 14) & 0x7f;
  header[8] = (n >> 7) & 0x7f;
  header[9] = n & 0x7f;
  return Buffer.concat([header, body]);
}

/**
 * Encode a WAV file to MP3 at `outPath`. Written to a temporary name and renamed
 * at the end, so an interrupted encode never leaves a short file that looks done.
 */
export async function wavToMp3(
  wavPath: string,
  outPath: string,
  options: {
    quality: PodcastQuality;
    tags: Parameters<typeof id3Tag>[0];
    onProgress?: (fraction: number) => void;
  },
): Promise<{ bytes: number; seconds: number }> {
  const fd = fs.openSync(wavPath, "r");
  const partial = `${outPath}.part`;
  const out = fs.openSync(partial, "w");

  try {
    const layout = readLayout(fd);
    const { kbps, mono: wantMono } = QUALITY[options.quality];
    // LAME takes at most two channels; anything wider is folded down.
    const mono = wantMono || layout.channels === 1;
    const supported = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
    if (!supported.includes(layout.sampleRate)) throw new Error(`Unsupported sample rate for MP3: ${layout.sampleRate} Hz`);

    const encoder = new Mp3Encoder(mono ? 1 : 2, layout.sampleRate, kbps);
    const read = sampleReader(layout);
    const bytesPerSample = layout.bitsPerSample / 8;
    const frameBytes = bytesPerSample * layout.channels;
    const totalFrames = Math.floor(layout.dataBytes / frameBytes);

    fs.writeSync(out, id3Tag(options.tags));

    const block = 1152 * 32; // whole MP3 frames per read keeps LAME's buffering simple
    const raw = Buffer.alloc(block * frameBytes);
    const left = new Int16Array(block);
    const right = new Int16Array(block);
    let done = 0;
    let lastReport = 0;

    while (done < totalFrames) {
      const frames = Math.min(block, totalFrames - done);
      fs.readSync(fd, raw, 0, frames * frameBytes, layout.dataStart + done * frameBytes);

      for (let i = 0; i < frames; i++) {
        const base = i * frameBytes;
        if (layout.channels === 1) {
          left[i] = toInt16(read(raw, base));
        } else if (mono) {
          let sum = 0;
          for (let c = 0; c < layout.channels; c++) sum += read(raw, base + c * bytesPerSample);
          left[i] = toInt16(sum / layout.channels);
        } else {
          left[i] = toInt16(read(raw, base));
          right[i] = toInt16(read(raw, base + bytesPerSample));
        }
      }

      const mp3 = mono
        ? encoder.encodeBuffer(left.subarray(0, frames))
        : encoder.encodeBuffer(left.subarray(0, frames), right.subarray(0, frames));
      if (mp3.length) fs.writeSync(out, mp3);
      done += frames;

      if (options.onProgress && (done - lastReport > layout.sampleRate * 20 || done === totalFrames)) {
        lastReport = done;
        options.onProgress(done / totalFrames);
        // Let the server answer requests (progress polls, the live feed) between blocks.
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    const tail = encoder.flush();
    if (tail.length) fs.writeSync(out, tail);
    fs.closeSync(out);
    fs.renameSync(partial, outPath);

    return { bytes: fs.statSync(outPath).size, seconds: totalFrames / layout.sampleRate };
  } catch (err) {
    try {
      fs.closeSync(out);
    } catch {
      /* already closed */
    }
    fs.rmSync(partial, { force: true });
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}
