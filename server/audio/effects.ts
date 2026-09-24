/**
 * Voice colouring effects. All hand-rolled biquads so the pipeline stays
 * dependency-free — these are the standard RBJ cookbook forms.
 */

import type { AudioBuffer } from "./wav.ts";

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function applyBiquad(data: Float32Array, c: BiquadCoeffs): Float32Array {
  const out = new Float32Array(data.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  for (let i = 0; i < data.length; i++) {
    const x0 = data[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }

  return out;
}

function highpassCoeffs(freq: number, sampleRate: number, q = 0.707): BiquadCoeffs {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cos) / 2) / a0,
    b1: (-(1 + cos)) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function lowpassCoeffs(freq: number, sampleRate: number, q = 0.707): BiquadCoeffs {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cos) / 2) / a0,
    b1: (1 - cos) / a0,
    b2: ((1 - cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function peakingCoeffs(freq: number, sampleRate: number, gainDb: number, q = 1): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cos) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

export function highpass(audio: AudioBuffer, freq: number): AudioBuffer {
  return { sampleRate: audio.sampleRate, data: applyBiquad(audio.data, highpassCoeffs(freq, audio.sampleRate)) };
}

export function lowpass(audio: AudioBuffer, freq: number): AudioBuffer {
  return { sampleRate: audio.sampleRate, data: applyBiquad(audio.data, lowpassCoeffs(freq, audio.sampleRate)) };
}

export function peaking(audio: AudioBuffer, freq: number, gainDb: number, q = 1): AudioBuffer {
  return {
    sampleRate: audio.sampleRate,
    data: applyBiquad(audio.data, peakingCoeffs(freq, audio.sampleRate, gainDb, q)),
  };
}

/** Soft saturation. `drive` of 1 is clean; higher values add odd harmonics. */
export function saturate(audio: AudioBuffer, drive: number): AudioBuffer {
  if (drive <= 1) return audio;
  const out = new Float32Array(audio.data.length);
  const norm = Math.tanh(drive);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.tanh(audio.data[i] * drive) / norm;
  }
  return { sampleRate: audio.sampleRate, data: out };
}

/**
 * Narrow-band "on the phone" sound: band-limit to roughly 300-3400 Hz,
 * push the presence peak, and add a touch of grit.
 */
export function telephone(audio: AudioBuffer): AudioBuffer {
  let out = highpass(audio, 320);
  out = highpass(out, 320); // 4th-order roll-off, otherwise it still sounds full-band
  out = lowpass(out, 3200);
  out = lowpass(out, 3200);
  out = peaking(out, 1800, 6, 1.2);
  return saturate(out, 1.6);
}

/** Slightly boxy, close-mic'd sound for the in-studio host. */
export function studio(audio: AudioBuffer): AudioBuffer {
  let out = highpass(audio, 90);
  out = peaking(out, 220, 2.5, 0.9); // chest warmth
  out = peaking(out, 5200, 2, 1.1); // air
  return out;
}

/** Distant / room sound for a remote guest without going full telephone. */
export function roomy(audio: AudioBuffer): AudioBuffer {
  let out = highpass(audio, 140);
  out = lowpass(out, 7000);
  out = peaking(out, 500, -2.5, 1); // scoop the mud
  return out;
}

/** Close, weighty royal-broadcast sound without artificial pitch shifting. */
export function throne(audio: AudioBuffer): AudioBuffer {
  let out = highpass(audio, 65);
  out = lowpass(out, 6200);
  out = peaking(out, 135, 4, 0.8);
  out = peaking(out, 320, 1.5, 1);
  out = peaking(out, 3200, 1.5, 1.1);
  return saturate(out, 1.18);
}

export type VoiceTone = "studio" | "phone" | "room" | "throne" | "raw";

export function applyTone(audio: AudioBuffer, tone: VoiceTone): AudioBuffer {
  switch (tone) {
    case "phone":
      return telephone(audio);
    case "studio":
      return studio(audio);
    case "room":
      return roomy(audio);
    case "throne":
      return throne(audio);
    default:
      return audio;
  }
}

/**
 * Soft-knee compressor.
 *
 * Speech synthesis has a wide dynamic range, which is why a show can feel
 * quiet then suddenly loud. Levelling it is what makes the result sound
 * "broadcast" rather than "a file someone rendered" — far more audible than
 * any change in sample rate or bit depth.
 *
 * `thresholdDb` is where gain reduction begins, `ratio` how hard it clamps
 * above that, and `makeupDb` lifts the whole result back up afterwards.
 */
export function compress(
  audio: AudioBuffer,
  { thresholdDb = -20, ratio = 3, attackMs = 5, releaseMs = 120, kneeDb = 6, makeupDb = 0 } = {},
): AudioBuffer {
  const { data, sampleRate } = audio;
  const out = new Float32Array(data.length);

  const attack = Math.exp(-1 / ((attackMs / 1000) * sampleRate));
  const release = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  const makeup = Math.pow(10, makeupDb / 20);

  let envelopeDb = -100; // running level estimate, in dB

  for (let i = 0; i < data.length; i++) {
    const magnitude = Math.abs(data[i]);
    // -100 dB floor keeps log() finite through digital silence.
    const inputDb = magnitude < 1e-5 ? -100 : 20 * Math.log10(magnitude);

    const coeff = inputDb > envelopeDb ? attack : release;
    envelopeDb = inputDb + coeff * (envelopeDb - inputDb);

    // Soft knee: ease into the ratio across kneeDb centred on the threshold.
    const over = envelopeDb - thresholdDb;
    let reductionDb = 0;

    if (over >= kneeDb / 2) {
      reductionDb = over - over / ratio;
    } else if (over > -kneeDb / 2) {
      const x = over + kneeDb / 2;
      reductionDb = ((1 - 1 / ratio) * x * x) / (2 * kneeDb);
    }

    out[i] = data[i] * Math.pow(10, -reductionDb / 20) * makeup;
  }

  return { sampleRate, data: out };
}

/**
 * Catch the few samples a compressor lets through, so nothing ever clips.
 * A short lookahead means the limiter is already turned down when a peak
 * arrives, rather than reacting a moment too late.
 */
export function limit(audio: AudioBuffer, ceiling = 0.97, lookaheadMs = 2): AudioBuffer {
  const { data, sampleRate } = audio;
  const lookahead = Math.max(1, Math.round((lookaheadMs / 1000) * sampleRate));
  const out = new Float32Array(data.length);

  let gain = 1;
  const recovery = Math.exp(-1 / (0.05 * sampleRate)); // 50 ms release

  for (let i = 0; i < data.length; i++) {
    // Peak within the lookahead window decides the gain applied right now.
    let peak = 0;
    const end = Math.min(data.length, i + lookahead);
    for (let j = i; j < end; j++) peak = Math.max(peak, Math.abs(data[j]));

    const target = peak > ceiling ? ceiling / peak : 1;
    gain = target < gain ? target : target + recovery * (gain - target);

    out[i] = data[i] * gain;
  }

  return { sampleRate, data: out };
}

/**
 * Duck `bed` wherever `speech` is loud, so music sits under dialogue.
 * Envelope follower with asymmetric attack/release, as a real sidechain would.
 */
export function duck(
  bed: Float32Array,
  speech: Float32Array,
  sampleRate: number,
  depth = 0.72,
): Float32Array {
  const attack = Math.exp(-1 / (0.02 * sampleRate)); // 20 ms
  const release = Math.exp(-1 / (0.45 * sampleRate)); // 450 ms
  const out = new Float32Array(bed.length);
  let env = 0;

  for (let i = 0; i < bed.length; i++) {
    const level = Math.abs(speech[i] ?? 0);
    const coeff = level > env ? attack : release;
    env = level + coeff * (env - level);
    // Map the envelope to a gain reduction, clamped so the bed never fully vanishes.
    const reduction = Math.min(1, env * 6) * depth;
    out[i] = bed[i] * (1 - reduction);
  }

  return out;
}
