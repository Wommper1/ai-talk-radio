/**
 * Pure-Node WAV codec + DSP. No ffmpeg, no native dependencies.
 * Everything inside the pipeline is mono Float32 at a single sample rate;
 * we only convert to 16-bit PCM at the very end.
 */

export interface AudioBuffer {
  sampleRate: number;
  /** Mono samples in the range [-1, 1]. */
  data: Float32Array;
}

export const SAMPLE_RATE = 44100;

/** Read a RIFF/WAVE file. Handles 8/16/24/32-bit PCM and 32/64-bit float, any channel count. */
export function decodeWav(buf: Buffer): AudioBuffer {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }

  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
      // WAVE_FORMAT_EXTENSIBLE stores the real format in the GUID's first two bytes.
      if (fmt.audioFormat === 0xfffe && size >= 40) {
        fmt.audioFormat = buf.readUInt16LE(body + 24);
      }
    } else if (id === "data") {
      dataStart = body;
      // Some encoders write 0 or a bogus size for streamed data; fall back to "rest of file".
      dataLength = size === 0 || body + size > buf.length ? buf.length - body : size;
    }

    offset = body + size + (size % 2); // chunks are word-aligned
    if (fmt && dataStart >= 0) break;
  }

  if (!fmt) throw new Error("WAV is missing a fmt chunk");
  if (dataStart < 0) throw new Error("WAV is missing a data chunk");

  const { channels, bitsPerSample, audioFormat } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
  const out = new Float32Array(frameCount);

  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      const p = dataStart + (frame * channels + ch) * bytesPerSample;
      sum += readSample(buf, p, bitsPerSample, audioFormat);
    }
    out[frame] = sum / channels; // downmix to mono
  }

  return { sampleRate: fmt.sampleRate, data: out };
}

function readSample(buf: Buffer, p: number, bits: number, format: number): number {
  if (format === 3) {
    return bits === 64 ? buf.readDoubleLE(p) : buf.readFloatLE(p);
  }
  switch (bits) {
    case 8:
      return (buf.readUInt8(p) - 128) / 128; // 8-bit PCM is unsigned
    case 16:
      return buf.readInt16LE(p) / 32768;
    case 24: {
      const v = buf.readUInt8(p) | (buf.readUInt8(p + 1) << 8) | (buf.readInt8(p + 2) << 16);
      return v / 8388608;
    }
    case 32:
      return buf.readInt32LE(p) / 2147483648;
    default:
      throw new Error(`Unsupported WAV bit depth: ${bits}`);
  }
}

export type BitDepth = 16 | 24;

/** A stereo pair. Mono sources are widened by the caller when needed. */
export interface StereoBuffer {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
}

function writeWavHeader(sampleRate: number, channels: number, bitDepth: BitDepth, dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);

  return header;
}

function writeSample(buf: Buffer, offset: number, value: number, bitDepth: BitDepth): void {
  const s = Math.max(-1, Math.min(1, value));
  if (bitDepth === 24) {
    // 24-bit PCM is three little-endian bytes. Masking each byte of the signed
    // value yields the correct two's-complement representation for negatives.
    const v = Math.round(s * 8388607);
    buf.writeUInt8(v & 0xff, offset);
    buf.writeUInt8((v >> 8) & 0xff, offset + 1);
    buf.writeUInt8((v >> 16) & 0xff, offset + 2);
  } else {
    buf.writeInt16LE(Math.round(s * 32767), offset);
  }
}

/** Write mono Float32 as a PCM WAV file, clipping guarded. */
export function encodeWav(audio: AudioBuffer, bitDepth: BitDepth = 16): Buffer {
  const { data, sampleRate } = audio;
  const bytesPerSample = bitDepth / 8;
  const dataBytes = data.length * bytesPerSample;

  const body = Buffer.alloc(dataBytes);
  for (let i = 0; i < data.length; i++) {
    writeSample(body, i * bytesPerSample, data[i], bitDepth);
  }

  return Buffer.concat([writeWavHeader(sampleRate, 1, bitDepth, dataBytes), body]);
}

/** Write an interleaved stereo PCM WAV file. */
export function encodeWavStereo(audio: StereoBuffer, bitDepth: BitDepth = 16): Buffer {
  const { left, right, sampleRate } = audio;
  const frames = Math.min(left.length, right.length);
  const bytesPerSample = bitDepth / 8;
  const dataBytes = frames * 2 * bytesPerSample;

  const body = Buffer.alloc(dataBytes);
  for (let i = 0; i < frames; i++) {
    writeSample(body, i * 2 * bytesPerSample, left[i], bitDepth);
    writeSample(body, (i * 2 + 1) * bytesPerSample, right[i], bitDepth);
  }

  return Buffer.concat([writeWavHeader(sampleRate, 2, bitDepth, dataBytes), body]);
}

/**
 * Place a mono source in the stereo field. `pan` runs -1 (hard left) to
 * 1 (hard right), using a constant-power law so centre is not louder.
 */
export function pan(data: Float32Array, position: number): { left: Float32Array; right: Float32Array } {
  const p = Math.max(-1, Math.min(1, position));
  const angle = ((p + 1) / 2) * (Math.PI / 2);
  const gainL = Math.cos(angle);
  const gainR = Math.sin(angle);

  const left = new Float32Array(data.length);
  const right = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    left[i] = data[i] * gainL;
    right[i] = data[i] * gainR;
  }

  return { left, right };
}

/** Linear-interpolation resampler. Good enough for speech; avoids a DSP dependency. */
export function resample(audio: AudioBuffer, targetRate: number): AudioBuffer {
  if (audio.sampleRate === targetRate) return audio;

  const ratio = audio.sampleRate / targetRate;
  const outLength = Math.max(1, Math.floor(audio.data.length / ratio));
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = audio.data[idx] ?? 0;
    const b = audio.data[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }

  return { sampleRate: targetRate, data: out };
}

export function silence(seconds: number, sampleRate = SAMPLE_RATE): AudioBuffer {
  return { sampleRate, data: new Float32Array(Math.max(0, Math.round(seconds * sampleRate))) };
}

export function concat(parts: AudioBuffer[], sampleRate = SAMPLE_RATE): AudioBuffer {
  const normalized = parts.map((p) => resample(p, sampleRate));
  const total = normalized.reduce((n, p) => n + p.data.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of normalized) {
    out.set(p.data, at);
    at += p.data.length;
  }
  return { sampleRate, data: out };
}

export function durationOf(audio: AudioBuffer): number {
  return audio.data.length / audio.sampleRate;
}

export function gain(audio: AudioBuffer, amount: number): AudioBuffer {
  const out = new Float32Array(audio.data.length);
  for (let i = 0; i < out.length; i++) out[i] = audio.data[i] * amount;
  return { sampleRate: audio.sampleRate, data: out };
}

/** Mix `layer` onto `base` starting at `startSeconds`. Returns a new buffer. */
export function mixInto(base: AudioBuffer, layer: AudioBuffer, startSeconds = 0): AudioBuffer {
  const l = resample(layer, base.sampleRate);
  const offset = Math.round(startSeconds * base.sampleRate);
  const out = new Float32Array(Math.max(base.data.length, offset + l.data.length));
  out.set(base.data, 0);
  for (let i = 0; i < l.data.length; i++) {
    out[offset + i] += l.data[i];
  }
  return { sampleRate: base.sampleRate, data: out };
}

export function fade(audio: AudioBuffer, inSeconds: number, outSeconds: number): AudioBuffer {
  const out = Float32Array.from(audio.data);
  const inN = Math.min(out.length, Math.round(inSeconds * audio.sampleRate));
  const outN = Math.min(out.length, Math.round(outSeconds * audio.sampleRate));

  for (let i = 0; i < inN; i++) out[i] *= i / inN;
  for (let i = 0; i < outN; i++) out[out.length - 1 - i] *= i / outN;

  return { sampleRate: audio.sampleRate, data: out };
}

/** Peak-normalize, leaving silence untouched. */
export function normalize(audio: AudioBuffer, peak = 0.89): AudioBuffer {
  let max = 0;
  for (let i = 0; i < audio.data.length; i++) {
    const v = Math.abs(audio.data[i]);
    if (v > max) max = v;
  }
  if (max < 1e-6) return audio;
  return gain(audio, peak / max);
}

/** Trim near-silence from both ends so TTS lead-in pauses do not stack up. */
export function trimSilence(audio: AudioBuffer, threshold = 0.006, keepSeconds = 0.06): AudioBuffer {
  const { data, sampleRate } = audio;
  let start = 0;
  let end = data.length - 1;

  while (start < data.length && Math.abs(data[start]) < threshold) start++;
  while (end > start && Math.abs(data[end]) < threshold) end--;

  if (start >= end) return audio;

  const keep = Math.round(keepSeconds * sampleRate);
  start = Math.max(0, start - keep);
  end = Math.min(data.length - 1, end + keep);

  return { sampleRate, data: data.slice(start, end + 1) };
}
