import type { AudioBuffer, StereoBuffer } from "./wav.ts";

/** A speech/music streaming target with enough headroom for lossy encoding. */
export const STREAMING_TARGET_LUFS = -16;
export const STREAMING_TRUE_PEAK_DBTP = -1;

export interface AudioAnalysis {
  targetLufs: number;
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  samplePeakDbfs: number | null;
  gainAppliedDb: number;
  streamingReady: boolean;
}

type Channels = { sampleRate: number; channels: Float32Array[] };

const db = (linear: number): number | null => linear > 1e-12 ? 20 * Math.log10(linear) : null;

/** RBJ biquad, used for a practical K-weighting approximation at any rate. */
function biquad(
  input: Float32Array,
  coefficients: { b0: number; b1: number; b2: number; a1: number; a2: number },
): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const { b0, b1, b2, a1, a2 } = coefficients;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}

function highPass(sampleRate: number, hz = 60, q = Math.SQRT1_2) {
  const w0 = 2 * Math.PI * hz / sampleRate;
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

function highShelf(sampleRate: number, hz = 1500, gainDb = 4) {
  const a = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * hz / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / 2 * Math.SQRT2;
  const beta = 2 * Math.sqrt(a) * alpha;
  const a0 = (a + 1) - (a - 1) * cos + beta;
  return {
    b0: (a * ((a + 1) + (a - 1) * cos + beta)) / a0,
    b1: (-2 * a * ((a - 1) + (a + 1) * cos)) / a0,
    b2: (a * ((a + 1) + (a - 1) * cos - beta)) / a0,
    a1: (2 * ((a - 1) - (a + 1) * cos)) / a0,
    a2: ((a + 1) - (a - 1) * cos - beta) / a0,
  };
}

function weighted(channel: Float32Array, sampleRate: number): Float32Array {
  return biquad(biquad(channel, highShelf(sampleRate)), highPass(sampleRate));
}

/** EBU-style 400 ms gated program loudness, expressed as LUFS-I. */
export function integratedLufs(audio: Channels): number | null {
  const length = Math.min(...audio.channels.map((channel) => channel.length));
  if (!Number.isFinite(length) || length === 0) return null;
  const channels = audio.channels.map((channel) => weighted(channel.subarray(0, length), audio.sampleRate));
  const block = Math.max(1, Math.round(audio.sampleRate * 0.4));
  const step = Math.max(1, Math.round(audio.sampleRate * 0.1));
  const energies: number[] = [];

  // A shorter clip still gets one measurement rather than no measurement.
  const starts = length <= block ? [0] : Array.from({ length: Math.floor((length - block) / step) + 1 }, (_, i) => i * step);
  for (const start of starts) {
    const end = Math.min(length, start + block);
    let energy = 0;
    for (const channel of channels) {
      for (let i = start; i < end; i++) energy += channel[i] * channel[i];
    }
    energy /= Math.max(1, end - start);
    const loudness = energy > 1e-20 ? -0.691 + 10 * Math.log10(energy) : -Infinity;
    if (loudness >= -70) energies.push(energy);
  }
  if (energies.length === 0) return null;

  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const ungated = -0.691 + 10 * Math.log10(average(energies));
  const relativeGate = ungated - 10;
  const gated = energies.filter((energy) => -0.691 + 10 * Math.log10(energy) >= relativeGate);
  return -0.691 + 10 * Math.log10(average(gated.length ? gated : energies));
}

/**
 * Four-point cubic interpolation catches the common inter-sample overshoot a
 * sample peak meter misses. It is an estimate, deliberately labelled dBTP.
 */
export function peakMeasurements(audio: Channels): { samplePeak: number; truePeak: number } {
  let samplePeak = 0;
  let truePeak = 0;
  const interpolate = (p0: number, p1: number, p2: number, p3: number, t: number) => {
    const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
    const c = -0.5 * p0 + 0.5 * p2;
    return ((a * t + b) * t + c) * t + p1;
  };

  for (const channel of audio.channels) {
    for (let i = 0; i < channel.length; i++) samplePeak = Math.max(samplePeak, Math.abs(channel[i]));
    truePeak = Math.max(truePeak, samplePeak);
    for (let i = 1; i + 2 < channel.length; i++) {
      // Only inspect the neighbourhood of meaningful peaks; quiet audio cannot
      // set the program ceiling and skipping it keeps long shows inexpensive.
      if (Math.max(Math.abs(channel[i]), Math.abs(channel[i + 1])) < 0.1) continue;
      for (const t of [0.25, 0.5, 0.75]) {
        truePeak = Math.max(truePeak, Math.abs(interpolate(channel[i - 1], channel[i], channel[i + 1], channel[i + 2], t)));
      }
    }
  }
  return { samplePeak, truePeak };
}

export function analyseLoudness(audio: Channels, gainAppliedDb = 0): AudioAnalysis {
  const lufs = integratedLufs(audio);
  const peaks = peakMeasurements(audio);
  const truePeak = db(peaks.truePeak);
  const samplePeak = db(peaks.samplePeak);
  return {
    targetLufs: STREAMING_TARGET_LUFS,
    integratedLufs: lufs === null ? null : Number(lufs.toFixed(2)),
    truePeakDbtp: truePeak === null ? null : Number(truePeak.toFixed(2)),
    samplePeakDbfs: samplePeak === null ? null : Number(samplePeak.toFixed(2)),
    gainAppliedDb: Number(gainAppliedDb.toFixed(2)),
    streamingReady: lufs !== null && lufs >= -18 && lufs <= -14 && truePeak !== null && truePeak <= STREAMING_TRUE_PEAK_DBTP + 0.1,
  };
}

function master(audio: Channels): { channels: Float32Array[]; analysis: AudioAnalysis } {
  const before = integratedLufs(audio);
  let gainDb = before === null ? 0 : Math.max(-6, Math.min(6, STREAMING_TARGET_LUFS - before));
  const apply = (channels: Float32Array[], amountDb: number) => {
    const scale = Math.pow(10, amountDb / 20);
    return channels.map((channel) => Float32Array.from(channel, (sample) => sample * scale));
  };

  let channels = apply(audio.channels, gainDb);
  const peakAfterGain = peakMeasurements({ ...audio, channels }).truePeak;
  const ceiling = Math.pow(10, STREAMING_TRUE_PEAK_DBTP / 20);
  if (peakAfterGain > ceiling) {
    const attenuation = 20 * Math.log10(ceiling / peakAfterGain);
    channels = apply(channels, attenuation);
    gainDb += attenuation;
  }

  return { channels, analysis: analyseLoudness({ ...audio, channels }, gainDb) };
}

export function masterStereo(audio: StereoBuffer): { audio: StereoBuffer; analysis: AudioAnalysis } {
  const result = master({ sampleRate: audio.sampleRate, channels: [audio.left, audio.right] });
  return {
    audio: { sampleRate: audio.sampleRate, left: result.channels[0], right: result.channels[1] },
    analysis: result.analysis,
  };
}

export function masterMono(audio: AudioBuffer): { audio: AudioBuffer; analysis: AudioAnalysis } {
  const result = master({ sampleRate: audio.sampleRate, channels: [audio.data] });
  return { audio: { sampleRate: audio.sampleRate, data: result.channels[0] }, analysis: result.analysis };
}
