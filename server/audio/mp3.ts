/**
 * MP3 decoding.
 *
 * Edge TTS only returns MP3, and the rest of the pipeline works in mono
 * Float32 PCM. This wraps a WASM build of mpg123 so no system ffmpeg is
 * needed — the decoder is a normal npm dependency and behaves the same on
 * every machine.
 */

import { MPEGDecoder } from "mpg123-decoder";
import type { AudioBuffer } from "./wav.ts";

/** Refuse anything longer than this; a decode error can report a garbage length. */
const MAX_SECONDS = 60 * 30;

/** Skip an ID3v2 tag if present, so the first frame really is a frame header. */
function stripId3(buffer: Buffer): Buffer {
  if (buffer.length < 10 || buffer.toString("ascii", 0, 3) !== "ID3") return buffer;

  // Size is four 7-bit big-endian bytes ("synchsafe"), excluding the 10-byte header.
  const size =
    ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);

  const start = 10 + size;
  return start < buffer.length ? buffer.subarray(start) : buffer;
}

export async function decodeMp3(buffer: Buffer): Promise<AudioBuffer> {
  // A decoder is created per file rather than shared: mpg123 keeps per-stream
  // state, and reset() is asynchronous, which makes reuse easy to get wrong.
  const decoder = new MPEGDecoder();
  await decoder.ready;

  try {
    const result = decoder.decode(new Uint8Array(stripId3(buffer)));

    const channels = result.channelData ?? [];
    const frames = result.samplesDecoded;

    if (!Number.isFinite(frames) || frames <= 0 || channels.length === 0) {
      throw new Error("MP3 decoding produced no audio");
    }
    if (!Number.isFinite(result.sampleRate) || result.sampleRate <= 0) {
      throw new Error("MP3 decoding returned an invalid sample rate");
    }
    if (frames > result.sampleRate * MAX_SECONDS) {
      throw new Error("MP3 decoding returned an implausible length");
    }
    // The reported count must actually exist in the returned buffers.
    const available = Math.min(...channels.map((c) => c.length));
    const usable = Math.min(frames, available);
    if (usable <= 0) throw new Error("MP3 decoding returned empty channel data");

    const mono = new Float32Array(usable);

    if (channels.length === 1) {
      mono.set(channels[0].subarray(0, usable));
    } else {
      // Downmix; Edge returns dual-mono, so averaging is lossless in practice.
      for (let i = 0; i < usable; i++) {
        let sum = 0;
        for (let ch = 0; ch < channels.length; ch++) sum += channels[ch][i] ?? 0;
        mono[i] = sum / channels.length;
      }
    }

    return { sampleRate: result.sampleRate, data: mono };
  } finally {
    decoder.free();
  }
}
