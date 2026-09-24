/**
 * Station imaging: the stings, sweeps and impacts that make a recording sound
 * like a broadcast rather than two people talking.
 *
 * All synthesised, like the music beds — nothing to download and no sample
 * library to license. Each is seeded so a given station always sounds like
 * itself.
 */

import { SAMPLE_RATE, type AudioBuffer } from "./wav.ts";
import { lowpass, highpass, peaking } from "./effects.ts";

export type StingKind = "ident" | "riser" | "whoosh" | "impact" | "beep" | "bumper";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const semitone = (root: number, steps: number) => root * Math.pow(2, steps / 12);

/** Short exponential envelope — percussive unless `hold` says otherwise. */
function envelope(i: number, length: number, attack = 0.01, hold = 0.2, rate = 5): number {
  const t = i / length;
  const attackT = attack;
  if (t < attackT) return t / attackT;
  if (t < attackT + hold) return 1;
  return Math.exp(-(t - attackT - hold) * rate * 10);
}

/**
 * A rising sweep. The classic "here comes something" cue before a segment.
 */
function riser(seconds: number, seed: number, sampleRate: number): AudioBuffer {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);

  // Noise swept upward through a resonant filter, plus a rising tone under it.
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const freq = 180 * Math.pow(14, t); // 180 Hz up to ~2.5 kHz
    phase += (2 * Math.PI * freq) / sampleRate;

    const tone = Math.sin(phase) * 0.35;
    const noise = (rand() * 2 - 1) * 0.5 * t;
    // Volume swells towards the top of the sweep.
    out[i] = (tone + noise) * Math.pow(t, 1.6);
  }

  let shaped = highpass({ sampleRate, data: out }, 200);
  shaped = peaking(shaped, 2200, 5, 1.4);
  return shaped;
}

/** A filtered noise sweep that moves past the listener. Segment glue. */
function whoosh(seconds: number, seed: number, sampleRate: number): AudioBuffer {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);

  for (let i = 0; i < n; i++) {
    const t = i / n;
    // Bell-shaped level: comes in, peaks, leaves.
    const level = Math.sin(Math.PI * t);
    out[i] = (rand() * 2 - 1) * level * level * 0.8;
  }

  // Sweeping the cutoff is what makes noise read as movement rather than hiss.
  const stages = 24;
  const chunk = Math.floor(n / stages);
  const swept = new Float32Array(n);

  for (let s = 0; s < stages; s++) {
    const from = s * chunk;
    const to = s === stages - 1 ? n : from + chunk;
    const cutoff = 400 + 5200 * Math.sin((Math.PI * s) / stages);
    const slice = lowpass({ sampleRate, data: out.slice(from, to) }, cutoff);
    swept.set(slice.data, from);
  }

  return { sampleRate, data: swept };
}

/** A low hit with a short tail. Punctuation. */
function impact(seconds: number, seed: number, sampleRate: number): AudioBuffer {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // Pitch drops fast, which is what gives a hit its weight.
    const freq = 110 * Math.exp(-t * 9) + 38;
    const decay = Math.exp(-t * 7);
    const body = Math.sin(2 * Math.PI * freq * t) * decay;
    const click = (rand() * 2 - 1) * Math.exp(-t * 90) * 0.35;
    out[i] = body * 0.85 + click;
  }

  return lowpass({ sampleRate, data: out }, 3000);
}

/** Two-tone station ident. Short, musical, recognisable. */
function ident(seconds: number, seed: number, sampleRate: number): AudioBuffer {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);

  // A station's ident should be the same every time, so the intervals are
  // chosen from the seed rather than at random per render.
  const root = 220 * Math.pow(2, Math.floor(rand() * 3) / 12);
  const intervals = [
    [0, 7, 12],
    [0, 4, 9],
    [0, 5, 12],
    [0, 3, 10],
  ][seed % 4];

  const noteLength = Math.floor(n / 2);

  for (let note = 0; note < 2; note++) {
    const start = note * noteLength;
    const steps = note === 0 ? intervals.slice(0, 2) : intervals;

    for (const step of steps) {
      const freq = semitone(root, step + (note === 1 ? 5 : 0));
      const phase = rand() * Math.PI * 2;

      for (let i = 0; i < noteLength && start + i < n; i++) {
        const t = i / sampleRate;
        const env = envelope(i, noteLength, 0.02, 0.15, 4);
        // A little FM gives it a bell quality rather than a bare sine.
        const mod = Math.sin(2 * Math.PI * freq * 2 * t) * 0.6;
        out[start + i] += Math.sin(2 * Math.PI * freq * t + phase + mod) * env * 0.16;
      }
    }
  }

  return peaking({ sampleRate, data: out }, 1800, 3, 1.2);
}

/** Short high blip, like a studio talkback cue. */
function beep(seconds: number, seed: number, sampleRate: number): AudioBuffer {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const freq = 880 + (seed % 3) * 110;

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    out[i] = Math.sin(2 * Math.PI * freq * t) * envelope(i, n, 0.005, 0.3, 8) * 0.4;
  }

  return { sampleRate, data: out };
}

/** Ident over an impact — the full "we are back" package. */
function bumper(seconds: number, seed: number, sampleRate: number): AudioBuffer {
  const hit = impact(Math.min(0.8, seconds), seed, sampleRate);
  const tune = ident(seconds, seed, sampleRate);
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    out[i] = (tune.data[i] ?? 0) + (hit.data[i] ?? 0) * 0.7;
  }

  return { sampleRate, data: out };
}

export function makeSting(
  kind: StingKind,
  seconds: number,
  seed: number,
  sampleRate: number = SAMPLE_RATE,
): AudioBuffer {
  switch (kind) {
    case "riser":
      return riser(seconds, seed, sampleRate);
    case "whoosh":
      return whoosh(seconds, seed, sampleRate);
    case "impact":
      return impact(seconds, seed, sampleRate);
    case "beep":
      return beep(seconds, seed, sampleRate);
    case "bumper":
      return bumper(seconds, seed, sampleRate);
    default:
      return ident(seconds, seed, sampleRate);
  }
}

/** Sensible default lengths, in seconds. */
export const STING_LENGTHS: Record<StingKind, number> = {
  ident: 1.6,
  riser: 1.2,
  whoosh: 0.7,
  impact: 0.9,
  beep: 0.18,
  bumper: 1.8,
};
