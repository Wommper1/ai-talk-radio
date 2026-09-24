/**
 * Procedural music beds.
 *
 * The original app called a hosted music model for this. Running locally we
 * synthesise the bed instead: it costs nothing, needs no network, and is
 * reproducible from a seed. Each mood is a chord progression plus a voicing
 * and texture recipe.
 */

import { SAMPLE_RATE, type AudioBuffer } from "./wav.ts";
import { lowpass } from "./effects.ts";

export type Mood = "tech" | "chill" | "news" | "latenight" | "upbeat" | "noir" | "rock" | "none";

export const MOODS: Array<{ id: Mood; label: string; description: string }> = [
  { id: "tech", label: "Tech", description: "Bright synth pad, steady pulse" },
  { id: "chill", label: "Chill", description: "Warm, slow, unhurried" },
  { id: "news", label: "Newsroom", description: "Tense, driving, urgent" },
  { id: "latenight", label: "Late Night", description: "Smoky minor keys, sparse" },
  { id: "upbeat", label: "Upbeat", description: "Major key, lively pulse" },
  { id: "noir", label: "Noir", description: "Dark, cinematic, brooding" },
  { id: "rock", label: "Rock", description: "Live drums, bass and dirty guitar" },
  { id: "none", label: "No music", description: "Dialogue only" },
];

interface MoodRecipe {
  /** Semitone offsets from the root, one chord per bar. */
  progression: number[][];
  rootHz: number;
  barSeconds: number;
  /** Relative level of the pulse/arpeggio layer. */
  pulse: number;
  pulseRate: number;
  brightness: number;
  detune: number;
}

// Rock is not a chord pad, so it is not in here — it has its own engine below.
const RECIPES: Record<Exclude<Mood, "none" | "rock">, MoodRecipe> = {
  tech: {
    progression: [
      [0, 7, 12, 16],
      [-3, 4, 9, 12],
      [-5, 2, 7, 11],
      [-1, 4, 7, 14],
    ],
    rootHz: 146.83, // D3
    barSeconds: 3.6,
    pulse: 0.34,
    pulseRate: 4,
    brightness: 2600,
    detune: 0.16,
  },
  chill: {
    progression: [
      [0, 4, 7, 11],
      [-3, 2, 5, 9],
      [-5, 0, 4, 7],
      [-7, -2, 2, 5],
    ],
    rootHz: 130.81, // C3
    barSeconds: 5.2,
    pulse: 0.13,
    pulseRate: 2,
    brightness: 1500,
    detune: 0.1,
  },
  news: {
    progression: [
      [0, 7, 12],
      [0, 5, 12],
      [-2, 5, 10],
      [0, 7, 12],
    ],
    rootHz: 164.81, // E3
    barSeconds: 2.4,
    pulse: 0.44,
    pulseRate: 6,
    brightness: 3000,
    detune: 0.06,
  },
  latenight: {
    progression: [
      [0, 3, 7, 10],
      [-2, 3, 7, 10],
      [-4, 0, 5, 8],
      [-5, 2, 7, 10],
    ],
    rootHz: 110.0, // A2
    barSeconds: 6.0,
    pulse: 0.1,
    pulseRate: 1.5,
    brightness: 1150,
    detune: 0.2,
  },
  upbeat: {
    progression: [
      [0, 4, 7, 12],
      [5, 9, 12, 16],
      [-3, 4, 9, 12],
      [2, 7, 11, 14],
    ],
    rootHz: 174.61, // F3
    barSeconds: 3.0,
    pulse: 0.4,
    pulseRate: 4,
    brightness: 3200,
    detune: 0.12,
  },
  noir: {
    progression: [
      [0, 3, 7],
      [-1, 3, 8],
      [-3, 0, 7],
      [-4, 3, 7],
    ],
    rootHz: 98.0, // G2
    barSeconds: 6.5,
    pulse: 0.07,
    pulseRate: 1,
    brightness: 900,
    detune: 0.22,
  },
};

/** Deterministic PRNG so a given seed always yields the same bed. */
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

export function generateBed(
  seconds: number,
  mood: Mood,
  seed = 1,
  sampleRate = SAMPLE_RATE,
): AudioBuffer {
  if (mood === "none" || seconds <= 0) {
    return { sampleRate, data: new Float32Array(Math.max(0, Math.round(seconds * sampleRate))) };
  }

  // A rock bed is a band playing quietly, not a pad. At this energy the
  // guitars stay out and what is left is a kit and a bass you can talk over.
  if (mood === "rock") {
    return renderRock(seconds, { seed, energy: 0.5, sampleRate });
  }

  const recipe = RECIPES[mood];
  const rand = mulberry32(seed);
  const total = Math.round(seconds * sampleRate);
  const out = new Float32Array(total);

  const barSamples = Math.round(recipe.barSeconds * sampleRate);
  const bars = Math.ceil(total / barSamples);

  // ── Pad layer: sustained detuned sines per chord tone, cross-faded across bars.
  for (let bar = 0; bar < bars; bar++) {
    const chord = recipe.progression[bar % recipe.progression.length];
    const barStart = bar * barSamples;
    // Overlap into the next bar so chord changes glide instead of clicking.
    const barLength = Math.min(barSamples * 2, total - barStart);
    if (barLength <= 0) break;

    for (const step of chord) {
      const freq = semitone(recipe.rootHz, step);
      const phase = rand() * Math.PI * 2;
      const detuneHz = freq * (recipe.detune / 100);
      const voiceGain = 0.13 / Math.sqrt(chord.length);

      for (let i = 0; i < barLength; i++) {
        const t = i / sampleRate;
        // Equal-power-ish triangular envelope across the doubled bar length.
        const pos = i / barLength;
        const env = pos < 0.5 ? pos * 2 : (1 - pos) * 2;
        const a = Math.sin(2 * Math.PI * freq * t + phase);
        const b = Math.sin(2 * Math.PI * (freq + detuneHz) * t + phase * 1.3);
        // A quiet octave above adds shimmer without muddying the bed.
        const c = Math.sin(2 * Math.PI * freq * 2 * t + phase * 0.7) * 0.18;
        out[barStart + i] += (a + b + c) * env * voiceGain;
      }
    }
  }

  // ── Pulse layer: short plucked tones on a grid, following the current chord.
  if (recipe.pulse > 0.01) {
    const stepSamples = Math.round(sampleRate / recipe.pulseRate);
    const noteLength = Math.min(stepSamples, Math.round(0.22 * sampleRate));

    for (let start = 0; start + noteLength < total; start += stepSamples) {
      if (rand() > 0.82) continue; // leave gaps so it breathes

      const bar = Math.floor(start / barSamples);
      const chord = recipe.progression[bar % recipe.progression.length];
      const step = chord[Math.floor(rand() * chord.length)];
      const freq = semitone(recipe.rootHz, step + 12); // an octave up from the pad
      const phase = rand() * Math.PI * 2;
      const level = recipe.pulse * (0.6 + rand() * 0.4) * 0.09;

      for (let i = 0; i < noteLength; i++) {
        const t = i / sampleRate;
        const env = Math.exp(-t * 11); // percussive decay
        out[start + i] += Math.sin(2 * Math.PI * freq * t + phase) * env * level;
      }
    }
  }

  // ── Air: filtered noise, keeps the bed from sounding like a test tone.
  for (let i = 0; i < total; i++) {
    out[i] += (rand() * 2 - 1) * 0.006;
  }

  const shaped = lowpass({ sampleRate, data: out }, recipe.brightness);
  return shaped;
}

/**
 * A bed that loops without a seam.
 *
 * The live feed plays one short bed on repeat for the whole show, so the join
 * has to be inaudible. Generating a little extra and cross-fading the tail
 * back over the head means the end of the file already contains the start of
 * it, and the wrap is a cross-fade rather than a cut.
 */
export function makeLoopBed(
  seconds: number,
  mood: Mood,
  seed = 1,
  crossfadeSeconds = 2,
  sampleRate = SAMPLE_RATE,
): AudioBuffer {
  const length = Math.max(1, Math.round(seconds * sampleRate));

  if (mood === "none") return { sampleRate, data: new Float32Array(length) };

  // The band already fills whole bars, so the end of it lands exactly where
  // the start does. Cross-fading a groove would smear one hit over another;
  // a hard join on the bar line is what actually loops.
  if (mood === "rock") return renderRock(seconds, { seed, energy: 0.5, sampleRate });

  const fade = Math.min(Math.round(crossfadeSeconds * sampleRate), Math.floor(length / 2));
  const source = generateBed(seconds + crossfadeSeconds, mood, seed, sampleRate);
  const out = new Float32Array(length);

  out.set(source.data.subarray(0, length), 0);

  // Fold the extra tail back over the opening, equal-power so the level holds.
  // At i = 0 the output is the sample that would have followed the last one,
  // so the wrap is continuous; by i = fade it is the real opening again.
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const fadeIn = Math.sin((t * Math.PI) / 2);
    const fadeOut = Math.cos((t * Math.PI) / 2);
    const extra = source.data[length + i] ?? 0;
    out[i] = source.data[i] * fadeIn + extra * fadeOut;
  }

  return { sampleRate, data: out };
}

/* ── The band ────────────────────────────────────────────────────── */

/**
 * A rock groove, played by four synthesised instruments.
 *
 * The pad engine above cannot do this. A rock bed is not a chord held under a
 * voice, it is a kit, a bass and two dirty guitars playing a pattern in time,
 * so it gets its own engine: a step sequencer over a sixteenth grid, with a
 * kick built from a pitch sweep, a snare from filtered noise, and power chords
 * made by clipping a stack of sawtooths — which is genuinely how an amp gets
 * that sound.
 *
 * Everything is seeded, so a given show always opens with the same take.
 */
export interface RockOptions {
  seed?: number;
  bpm?: number;
  /** 1 is the full band. Below about 0.55 the guitars sit out. */
  energy?: number;
  /** Seconds. The band pulls back between these two marks so a voice fits on top. */
  duckFrom?: number;
  duckTo?: number;
  /** Crash and a ringing chord on the very first beat. */
  crashIn?: boolean;
  /** Stop dead on the last downbeat and let it ring, the way an opener ends. */
  button?: boolean;
  sampleRate?: number;
}

export function renderRock(seconds: number, options: RockOptions = {}): AudioBuffer {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const total = Math.max(0, Math.round(seconds * sampleRate));
  const out = new Float32Array(total);
  if (total === 0) return { sampleRate, data: out };

  const rand = mulberry32((options.seed ?? 1) >>> 0 || 1);
  const baseEnergy = options.energy ?? 1;

  // Whole bars, always. A groove that stops halfway through a bar can neither
  // loop nor land on a button, so the tempo bends by a fraction of a percent
  // rather than the bar count coming out wrong.
  const targetBar = (60 / (options.bpm ?? 148)) * 4;
  const bars = Math.max(1, Math.round(seconds / targetBar));
  const barSeconds = seconds / bars;
  const step = barSeconds / 16;

  /** How hard the band is playing at a given moment. */
  const ramp = 0.4;
  const duckFrom = options.duckFrom ?? Infinity;
  const duckTo = options.duckTo ?? Infinity;
  const energyAt = (t: number): number => {
    if (!Number.isFinite(duckFrom) || !(duckTo > duckFrom)) return baseEnergy;
    const low = baseEnergy * 0.34;
    if (t <= duckFrom - ramp || t >= duckTo + ramp) return baseEnergy;
    if (t < duckFrom) return baseEnergy + (low - baseEnergy) * ((t - (duckFrom - ramp)) / ramp);
    if (t > duckTo) return low + (baseEnergy - low) * ((t - duckTo) / ramp);
    return low;
  };

  const add = (at: number, length: number, level: number, voice: (t: number) => number): void => {
    if (level <= 0.0005) return;
    const from = Math.round(at * sampleRate);
    const count = Math.round(length * sampleRate);
    for (let i = 0; i < count; i++) {
      const j = from + i;
      if (j < 0) continue;
      if (j >= total) break;
      out[j] += voice(i / sampleRate) * level;
    }
  };

  /* ── The kit ── */

  const kick = (at: number, level: number): void => {
    // The pitch drops from a click to a thump, and that sweep is the sound.
    let phase = 0;
    add(at, 0.26, level, (t) => {
      phase += (2 * Math.PI * (46 + 78 * Math.exp(-t * 34))) / sampleRate;
      return (Math.sin(phase) + Math.exp(-t * 200) * 0.4) * Math.exp(-t * 16);
    });
  };

  const snare = (at: number, level: number): void => {
    let hp = 0;
    let last = 0;
    add(at, 0.3, level, (t) => {
      const n = rand() * 2 - 1;
      hp = 0.74 * (hp + n - last);
      last = n;
      const body = Math.sin(2 * Math.PI * 186 * t) * Math.exp(-t * 34) * 0.5;
      return (hp * 1.15 + body) * Math.exp(-t * 22);
    });
  };

  const hat = (at: number, level: number, open = false): void => {
    let hp = 0;
    let last = 0;
    const decay = open ? 9 : 58;
    add(at, open ? 0.3 : 0.08, level, (t) => {
      const n = rand() * 2 - 1;
      hp = 0.93 * (hp + n - last);
      last = n;
      return hp * Math.exp(-t * decay);
    });
  };

  const crash = (at: number, level: number): void => {
    let hp = 0;
    let last = 0;
    add(at, 2.0, level, (t) => {
      const n = rand() * 2 - 1;
      hp = 0.88 * (hp + n - last);
      last = n;
      // Two ringing partials, or it reads as a hiss rather than a cymbal.
      const ring = Math.sin(2 * Math.PI * 3120 * t) * 0.11 + Math.sin(2 * Math.PI * 4670 * t) * 0.08;
      return (hp + ring) * Math.exp(-t * 2.4);
    });
  };

  /* ── Strings ── */

  const GUITAR_ROOT = 164.81; // E3
  const BASS_ROOT = 82.41; // E2

  const chord = (at: number, length: number, offset: number, level: number): void => {
    const root = semitone(GUITAR_ROOT, offset);
    // Root, fifth, octave — a power chord, with no third to argue with the key.
    const tones = [root, semitone(root, 7), root * 2];
    const phases = tones.map(() => rand());
    add(at, length, level, (t) => {
      let v = 0;
      for (let k = 0; k < tones.length; k++) {
        // Sawtooths. Clipping a sine only gives a squarer sine; clipping a
        // stack of saws is what sounds like a guitar.
        const x = (t * tones[k] + phases[k]) % 1;
        v += (2 * x - 1) * (k === 2 ? 0.5 : 1);
      }
      const env = Math.min(1, t * 260) * Math.exp(-t * (length > 0.5 ? 1.4 : 7));
      return Math.tanh(v * 2.4) * env * 0.5;
    });
  };

  const bass = (at: number, length: number, offset: number, level: number): void => {
    const root = semitone(BASS_ROOT, offset);
    const phase = rand() * Math.PI * 2;
    add(at, length, level, (t) => {
      const env = Math.min(1, t * 420) * Math.exp(-t * 3.2);
      return Math.tanh(Math.sin(2 * Math.PI * root * t + phase) * 1.9) * env;
    });
  };

  /* ── The arrangement ── */

  // E, D, A, E. Three chords and the truth.
  const PROGRESSION = [0, -2, 5, 0];
  const CHUG = [0, 2, 4, 6, 8, 10, 12, 14];
  const KICK = [0, 6, 8, 14];
  const SNARE = [4, 12];

  const lastBar = bars - 1;

  for (let bar = 0; bar < bars; bar++) {
    const offset = PROGRESSION[bar % PROGRESSION.length];
    const barAt = bar * barSeconds;
    const e = energyAt(barAt);

    // The button: everything lands on the downbeat and rings out.
    if (options.button && bar === lastBar) {
      crash(barAt, 0.34 * e);
      kick(barAt, 0.58 * e);
      chord(barAt, barSeconds, offset, 0.34 * e);
      bass(barAt, barSeconds, offset, 0.36 * e);
      break;
    }

    if (options.crashIn && bar === 0 && e >= 0.55) crash(barAt, 0.32 * e);

    for (let slot = 0; slot < 16; slot++) {
      const at = barAt + slot * step;
      const here = energyAt(at);
      const playing = here >= 0.55;

      if (KICK.includes(slot)) kick(at, 0.55 * here * (slot === 0 ? 1 : 0.85));
      if (SNARE.includes(slot)) snare(at, 0.4 * here);

      // Hats stay in through the quiet part. That is what keeps time under an
      // announcer without fighting the words.
      if (slot % 2 === 0) hat(at, 0.1 * here * (slot % 4 === 0 ? 1.25 : 0.8), playing && slot === 14);

      if (!playing) {
        // Guitars out; the bass keeps the bar moving.
        if (slot % 4 === 0) bass(at, step * 4, offset, 0.3 * here);
        continue;
      }

      if (CHUG.includes(slot)) {
        // The downbeat rings, the rest are palm-muted eighths.
        chord(at, slot === 0 ? barSeconds * 0.95 : step * 1.7, offset, (slot === 0 ? 0.32 : 0.24) * here);
        bass(at, step * 1.8, offset, 0.32 * here);
      }
    }
  }

  // Glue. The parts were written to sit together, but four instruments landing
  // on one downbeat still add up past full scale.
  for (let i = 0; i < total; i++) out[i] = Math.tanh(out[i] * 1.15) * 0.86;

  return { sampleRate, data: out };
}

/* ── The hall ────────────────────────────────────────────────────── */

/**
 * A struck bell.
 *
 * Nothing else in this file will do for a court. A bell is not a note — it is
 * a stack of partials that are deliberately *not* harmonic, which is why it
 * rings rather than sings, and why a sine with a decay sounds like a doorbell
 * instead. The ratios below are the ones a real founder's bell lands on: the
 * hum an octave under, the prime, the minor third that makes it sound solemn,
 * the fifth, and the nominal an octave up.
 *
 * The strike is the other half. A short burst of filtered noise on the front
 * is the clapper hitting bronze, and without it the bell fades in rather than
 * being struck.
 */
export function makeBell(seconds: number, rootHz = 74, seed = 1, sampleRate = SAMPLE_RATE): AudioBuffer {
  const total = Math.max(0, Math.round(seconds * sampleRate));
  const out = new Float32Array(total);
  if (total === 0) return { sampleRate, data: out };

  const rand = mulberry32(seed >>> 0 || 1);

  // ratio, level, and how fast that partial dies — the high ones go first,
  // which is what makes a bell darken as it rings out.
  const PARTIALS: Array<[number, number, number]> = [
    [0.5, 0.55, 0.35], // hum
    [1.0, 1.0, 0.42], // prime
    [1.2, 0.62, 0.75], // minor third — the solemn one
    [1.5, 0.42, 0.95], // fifth
    [2.0, 0.34, 1.25], // nominal
    [2.68, 0.16, 2.1],
    [3.42, 0.1, 3.0],
  ];

  for (const [ratio, level, decay] of PARTIALS) {
    const freq = rootHz * ratio;
    const phase = rand() * Math.PI * 2;
    // A little beating between partials, as real bronze has.
    const wobble = 1 + (rand() - 0.5) * 0.002;

    for (let i = 0; i < total; i++) {
      const t = i / sampleRate;
      out[i] += Math.sin(2 * Math.PI * freq * wobble * t + phase) * Math.exp(-t * decay) * level * 0.11;
    }
  }

  // The clapper.
  let hp = 0;
  let last = 0;
  const strike = Math.min(total, Math.round(0.06 * sampleRate));
  for (let i = 0; i < strike; i++) {
    const n = rand() * 2 - 1;
    hp = 0.86 * (hp + n - last);
    last = n;
    out[i] += hp * Math.exp(-(i / sampleRate) * 90) * 0.28;
  }

  return { sampleRate, data: out };
}

/**
 * The hall, before anyone speaks.
 *
 * A low drone, a bell tolled twice, and room enough for both to still be
 * ringing when the first word lands. No band, no riser, no sweep — those
 * belong to a radio station, and this is a king's hall at midnight.
 */
export function makeCourtOpen(seconds: number, seed = 1, sampleRate = SAMPLE_RATE): AudioBuffer {
  const total = Math.max(0, Math.round(seconds * sampleRate));
  const out = new Float32Array(total);
  if (total === 0) return { sampleRate, data: out };

  const rand = mulberry32(seed >>> 0 || 1);

  // ── The drone. Two fifths, detuned against each other, well under the voice.
  // A tone below the bells rather than under the voice. Low enough to be felt
  // more than heard, which is the difference between solemn and frightening.
  const ROOT = 41.2; // E1
  for (const [ratio, level] of [
    [1, 0.62],
    [1.5, 0.3],
    [2, 0.24],
    // A minor second against the root. Two notes a semitone apart beat against
    // each other and the ear reads it as wrongness rather than as music.
    [2.12, 0.1],
    [3, 0.07],
  ] as Array<[number, number]>) {
    const freq = ROOT * ratio;
    const phase = rand() * Math.PI * 2;
    const detune = freq * 0.0012;

    for (let i = 0; i < total; i++) {
      const t = i / sampleRate;
      // Swells in, holds, and is still there when the voice arrives.
      const env = Math.min(1, t / 1.6) * (1 - Math.min(1, Math.max(0, (t - (seconds - 2.2)) / 2.2)) * 0.55);
      const a = Math.sin(2 * Math.PI * freq * t + phase);
      const b = Math.sin(2 * Math.PI * (freq + detune) * t + phase * 1.7);
      out[i] += (a + b) * env * level * 0.07;
    }
  }

  // ── Air. A hall is never silent.
  for (let i = 0; i < total; i++) out[i] += (rand() * 2 - 1) * 0.004;

  // ── A sub that climbs the whole way through. Never audible as a note, but
  // the room gets heavier the longer it goes on, and it stops the moment the
  // herald finishes — which is the part the listener actually notices.
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    const climb = Math.min(1, t / Math.max(1, seconds - 1.5));
    out[i] += Math.sin(2 * Math.PI * (28 + climb * 6) * t) * climb * climb * 0.055;
  }

  // ── Two tolls, far enough apart to be counted.
  for (const [at, level] of [
    [0.3, 1],
    [2.6, 0.8],
    // A third, late and quieter, so the hall does not feel finished when the
    // herald starts. Something is still coming.
    [5.1, 0.5],
  ] as Array<[number, number]>) {
    // 58 Hz: a heavier bell than a chapel's. Deep enough that the minor third
    // in it lands as dread rather than as ceremony.
    const bell = makeBell(Math.max(1, seconds - at), 58, seed + Math.round(at * 100), sampleRate);
    const offset = Math.round(at * sampleRate);
    for (let i = 0; i < bell.data.length && offset + i < total; i++) out[offset + i] += bell.data[i] * level;
  }

  return { sampleRate, data: out };
}
