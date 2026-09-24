/**
 * The cold open.
 *
 * The first thing a listener hears must not be silence while a model thinks.
 * This is the station's own top-of-show imaging — a riser, the band kicking in,
 * and an announcer welcoming the room back — and none of it involves the
 * language model, so it can be rendered the instant a show is requested and
 * played while the first turn is still being written. It costs one short
 * synthesis and hides the whole of the first turn's latency behind something
 * that sounds deliberate.
 */

import fs from "node:fs";
import path from "node:path";
import { voiceFor, type Config } from "../config.ts";
import { synthesize } from "../providers/tts.ts";
import {
  decodeWav,
  encodeWav,
  durationOf,
  normalize,
  trimSilence,
  gain,
  fade,
  resample,
  SAMPLE_RATE,
  type AudioBuffer,
} from "../audio/wav.ts";
import { applyTone, compress, duck, limit, peaking } from "../audio/effects.ts";
import { generateBed, makeCourtOpen, renderRock, type Mood } from "../audio/music.ts";
import { makeSting, STING_LENGTHS } from "../audio/stings.ts";

/* ── The words ───────────────────────────────────────────────────── */

/**
 * Top-of-show scripts.
 *
 * Templates, not generation — the point of this piece is that it exists before
 * the model has been asked for anything. `{station}`, `{a}`, `{b}` and the
 * optional `{topic}` clause are filled in below. Written to be read hot: short
 * sentences, hard stops, and a call to action at the end.
 */
const OPENERS: Array<{ withTopic: string; withoutTopic: string }> = [
  {
    withTopic: "Kill the room lights. Bring the meters up. This is {station}. {a} and {b} are live, and tonight, {topic} gets no easy answers. Turn it all the way up!",
    withoutTopic: "Kill the room lights. Bring the meters up. This is {station}. {a} and {b} are live. Turn it all the way up!",
  },
  {
    withTopic: "From silence to full signal in three. Two. One. {station} is live. {a} and {b} have the microphones, and {topic} is on the table. Nobody leaves with the same opinion.",
    withoutTopic: "From silence to full signal in three. Two. One. {station} is live. {a} and {b} have the microphones. Nobody leaves with the same opinion.",
  },
  {
    withTopic: "This is not background noise. This is {station}. The board is red, {a} and {b} are live, and tonight we put {topic} under the studio lights.",
    withoutTopic: "This is not background noise. This is {station}. The board is red, and {a} and {b} are live under the studio lights.",
  },
  {
    withTopic: "The record is armed. The lines are open. You found {station}. {a} and {b} are taking on {topic}, live and without a safety net. Stay close.",
    withoutTopic: "The record is armed. The lines are open. You found {station}. {a} and {b} are live and without a safety net. Stay close.",
  },
  {
    withTopic: "One studio. Two live microphones. No soft landing. This is {station}, with {a} and {b}. Tonight, {topic}. Let the room shake.",
    withoutTopic: "One studio. Two live microphones. No soft landing. This is {station}, with {a} and {b}. Let the room shake.",
  },
  {
    withTopic: "Clear the static and lock the dial. {station} starts now. {a} and {b} have one subject and nowhere to hide from it: {topic}.",
    withoutTopic: "Clear the static and lock the dial. {station} starts now. {a} and {b} are on the air.",
  },
];

/**
 * The words for tonight.
 *
 * Seeded on the station and the topic rather than random, because three
 * separate places ask for this script — the live feed, the finished
 * transcript, and the preview — and they must all get the same sentence.
 */
export function coldOpenScript(config: Config, topic: string): string {
  const [a, b] = config.hosts;
  const subject = topic.trim().replace(/\s+/g, " ").slice(0, 90);

  const variant = OPENERS[hashSeed(`${config.show.station}|${subject}`) % OPENERS.length];

  return (subject ? variant.withTopic : variant.withoutTopic)
    .replace("{station}", config.show.station)
    .replace("{a}", a.name)
    .replace("{b}", b.name)
    .replace("{topic}", subject);
}

/* ── Speaking ────────────────────────────────────────────────────── */

/**
 * The announcer, treated for imaging: forward, bright and squashed, so a voice
 * survives being put on top of a band rather than underneath it.
 */
async function speakAnnouncer(
  config: Config,
  text: string,
  scratch: string,
  rateBoost: number,
  signal?: AbortSignal,
): Promise<AudioBuffer | null> {
  const announcer = config.ads.announcer;

  try {
    await synthesize(
      {
        text,
        voice: voiceFor(announcer, config.tts.engine),
        rate: Math.max(-10, Math.min(10, announcer.rate + rateBoost)),
        outPath: scratch,
      },
      config.tts,
      signal,
    );

    let voice = trimSilence(resample(decodeWav(fs.readFileSync(scratch)), SAMPLE_RATE));
    voice = applyTone(voice, announcer.tone);
    voice = peaking(voice, 3000, 2.5 + rateBoost * 0.2, 0.9);
    voice = compress(voice, { thresholdDb: -18 - rateBoost, ratio: 4 + rateBoost * 0.3, makeupDb: 4.5 + rateBoost * 0.4 });
    return normalize(voice, 0.9);
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    // No announcer is fine; the imaging alone still beats dead air.
    return null;
  } finally {
    fs.rmSync(scratch, { force: true });
  }
}

/* ── General imaging ─────────────────────────────────────────────── */

/** How a piece of station imaging is dressed. */
export interface AnnouncementOptions {
  /** Ident at the top. Off for anything that is not the top of the show. */
  ident?: boolean;
  /** Sweep on the way out, into whatever plays next. */
  whoosh?: boolean;
  /** Silence before the first word. */
  lead?: number;
  /** How long the bed runs past the last word. */
  tail?: number;
  /** Varies the bed and the stings between pieces of imaging. */
  seedOffset?: number;
}

/**
 * Render one piece of station imaging — announcer over a bed, with stings.
 *
 * Everything here is templates and synthesis, never the language model, which
 * is the whole point: a piece of imaging exists within a second of being
 * asked for, so it can cover the time the model spends writing.
 */
export async function renderAnnouncement(
  config: Config,
  text: string,
  outPath: string,
  options: AnnouncementOptions = {},
  signal?: AbortSignal,
): Promise<AudioBuffer | null> {
  if (config.tts.engine === "none") return null;

  const { ident = true, whoosh = true, lead = 0.9, tail = 1.3, seedOffset = 0 } = options;

  const seed = hashSeed(config.show.station) + seedOffset;
  const voice = await speakAnnouncer(config, text, `${outPath}.voice.wav`, 0, signal);

  // The bed runs a moment past the last word so it hands over to whatever
  // comes next rather than stopping dead.
  const voiceSeconds = voice ? durationOf(voice) : 1.6;
  const totalSeconds = lead + voiceSeconds + tail;
  const total = Math.round(totalSeconds * SAMPLE_RATE);
  const out = new Float32Array(total);

  if (voice) {
    const offset = Math.round(lead * SAMPLE_RATE);
    for (let i = 0; i < voice.data.length && offset + i < total; i++) out[offset + i] += voice.data[i];
  }

  const mood = config.show.mood as Mood;
  if (mood !== "none") {
    const bed = gain(fade(generateBed(totalSeconds, mood, seed), 0.5, 1.2), 0.34);
    for (let i = 0; i < bed.data.length && i < total; i++) out[i] += bed.data[i];
  }

  // Ident under the first words, and a sweep out into whatever follows.
  const cues: Array<{ at: number; buffer: AudioBuffer; level: number }> = [];

  if (ident) {
    cues.push({ at: 0, buffer: makeSting("ident", STING_LENGTHS.ident, seed, SAMPLE_RATE), level: 0.62 });
  }
  if (whoosh) {
    cues.push({
      at: Math.max(0, totalSeconds - STING_LENGTHS.whoosh - 0.1),
      buffer: makeSting("whoosh", STING_LENGTHS.whoosh, seed + 3, SAMPLE_RATE),
      level: 0.42,
    });
  }

  for (const cue of cues) {
    const offset = Math.round(cue.at * SAMPLE_RATE);
    for (let i = 0; i < cue.buffer.data.length && offset + i < total; i++) {
      out[offset + i] += cue.buffer.data[i] * cue.level;
    }
  }

  let mixed: AudioBuffer = { sampleRate: SAMPLE_RATE, data: out };
  mixed = normalize(mixed, 0.9);
  mixed = limit(mixed, 0.96);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, encodeWav(mixed));
  return mixed;
}

/* ── The top of the show ─────────────────────────────────────────── */

/**
 * Render the opener to `outPath`. Returns null when speech is off, in which
 * case the show simply starts on the first line as it always did.
 *
 * A riser, the band crashing in, four bars of nobody talking, then the
 * announcer over a pulled-back groove, then a button. The four bars matter
 * twice over: it is how a rock show opens, and it is four more seconds the
 * model gets to write the first turn in.
 */
export interface RockImagingOptions {
  /** Varies the band and the riser between pieces of imaging. */
  seed?: number;
  /** Seconds of band before the first word. */
  intro?: number;
  /** How long the band runs past the last word, for the button to ring. */
  outro?: number;
  /** A crash on the downbeat. Off for imaging the cold open has just preceded. */
  crashIn?: boolean;
  /** A riser in front of the band. */
  riser?: boolean;
  /** How much hotter the announcer reads than usual. */
  rateBoost?: number;
}

/**
 * Station imaging with the band behind it.
 *
 * A riser, the band coming in, a bar or two of nobody talking, then the
 * announcer over a pulled-back groove, then a button. The bars before the
 * first word earn their place twice over: it is how a rock show opens, and it
 * is that many more seconds the model gets to write the first turn in.
 */
export async function renderRockImaging(
  config: Config,
  text: string,
  outPath: string,
  options: RockImagingOptions = {},
  signal?: AbortSignal,
): Promise<AudioBuffer | null> {
  if (config.tts.engine === "none") return null;

  const {
    seed = hashSeed(config.show.station),
    intro: bandIntro = 3.3,
    outro = 2.8,
    crashIn = true,
    riser: wantRiser = true,
    rateBoost = 2,
  } = options;

  const voice = await speakAnnouncer(config, text, `${outPath}.voice.wav`, rateBoost, signal);

  // Timing. The riser sits in front of the band; the band runs whole bars, so
  // it decides its own exact length and the voice is placed inside it.
  const riserLead = wantRiser ? 0.7 : 0;
  const voiceSeconds = voice ? durationOf(voice) : 2.4;

  const bandSeconds = bandIntro + voiceSeconds + outro;
  const totalSeconds = riserLead + bandSeconds;
  const total = Math.round(totalSeconds * SAMPLE_RATE);

  const voiceTrack = new Float32Array(total);
  const voiceAt = Math.round((riserLead + bandIntro) * SAMPLE_RATE);
  if (voice) {
    for (let i = 0; i < voice.data.length && voiceAt + i < total; i++) voiceTrack[voiceAt + i] = voice.data[i];
  }

  // The band drops back around the words twice over: the arrangement itself
  // thins out, and then the sidechain rides it under the syllables. One alone
  // is not enough to put an announcer on top of distorted guitars.
  const band = renderRock(bandSeconds, {
    seed,
    crashIn,
    button: true,
    duckFrom: bandIntro - 0.3,
    duckTo: bandIntro + voiceSeconds + 0.3,
  });

  const bandTrack = new Float32Array(total);
  const bandAt = Math.round(riserLead * SAMPLE_RATE);
  for (let i = 0; i < band.data.length && bandAt + i < total; i++) bandTrack[bandAt + i] = band.data[i] * 0.82;

  const ducked = duck(bandTrack, voiceTrack, SAMPLE_RATE, 0.4);

  const out = new Float32Array(total);
  for (let i = 0; i < total; i++) out[i] = ducked[i] + voiceTrack[i];

  // A riser into the downbeat, so the crash lands rather than just starting.
  if (wantRiser) {
    const riser = makeSting("riser", Math.max(0.4, riserLead + 0.15), seed + 11, SAMPLE_RATE);
    for (let i = 0; i < riser.data.length && i < total; i++) out[i] += riser.data[i] * 0.5;
  }

  let mixed: AudioBuffer = { sampleRate: SAMPLE_RATE, data: out };
  // Glued rather than merely levelled — an opener should be the loudest thing
  // in the show, and that is a density difference, not a peak one.
  mixed = compress(mixed, { thresholdDb: -14, ratio: 3, makeupDb: 3 });
  mixed = normalize(mixed, 0.94);
  mixed = limit(mixed, 0.97);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, encodeWav(mixed));
  return mixed;
}

/**
 * Render the opener to `outPath`. Returns null when speech is off, in which
 * case the show simply starts on the first line as it always did.
 */
export function renderColdOpen(
  config: Config,
  topic: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<AudioBuffer | null> {
  if (config.tts.engine === "none") return Promise.resolve(null);

  const text = coldOpenScript(config, topic);

  // Dialogue-only shows get the dry treatment; nobody who turned the music off
  // wants a band. Everything else opens on the band regardless of the bed
  // mood, because the top of the show is imaging, not underscore.
  if ((config.show.mood as Mood) === "none") {
    return renderAnnouncement(config, text, outPath, {}, signal);
  }

  return renderRockImaging(
    config,
    text,
    outPath,
    { seed: hashSeed(`${config.show.station}|${topic}`) },
    signal,
  );
}

/**
 * The King's entrance.
 *
 * A hall, a drone, two bells, and a herald naming him — then he speaks. The
 * station's rock opener is exactly wrong here: it belongs to a radio, and the
 * one thing this court must never sound like is a radio.
 *
 * Templates like every other piece of imaging, so it exists the moment a court
 * is called and covers the time the model spends writing the first turn.
 */
const COURT_OPENERS: Array<{ withTopic: string[]; withoutTopic: string[] }> = [
  {
    withTopic: [
      "Attend.",
      "The doors are barred and the hall is closed.",
      "{king} sits — who took this realm by fire and holds it the same way.",
      "The matter is {topic}.",
      "Speak when you are spoken to.",
    ],
    withoutTopic: [
      "Attend.",
      "The doors are barred and the hall is closed.",
      "{king} sits — who took this realm by fire and holds it the same way.",
      "Speak when you are spoken to.",
    ],
  },
  {
    withTopic: [
      "You are summoned. This is not an invitation.",
      "The hall is closed. Nobody leaves until it is done.",
      "{king} sits.",
      "The matter is {topic}.",
    ],
    withoutTopic: [
      "You are summoned. This is not an invitation.",
      "The hall is closed. Nobody leaves until it is done.",
      "{king} sits.",
    ],
  },
  {
    withTopic: [
      "Silence in the hall.",
      "{king} has come down, and he has not slept.",
      "The matter before him is {topic}.",
      "Answer plainly. He can tell.",
    ],
    withoutTopic: [
      "Silence in the hall.",
      "{king} has come down, and he has not slept.",
      "Answer plainly. He can tell.",
    ],
  },
  {
    withTopic: [
      "Kneel or stand, it makes no difference to him.",
      "The hall is closed by order of the Crown.",
      "{king} sits. The matter is {topic}.",
      "Be brief. He has had men hanged for less than a long answer.",
    ],
    withoutTopic: [
      "Kneel or stand, it makes no difference to him.",
      "The hall is closed by order of the Crown.",
      "{king} sits.",
      "Be brief. He has had men hanged for less than a long answer.",
    ],
  },
  {
    withTopic: [
      "The bell has gone. You should already be inside.",
      "The hall is closed. Whoever is not here is accounted for.",
      "{king} sits, and the matter is {topic}.",
    ],
    withoutTopic: [
      "The bell has gone. You should already be inside.",
      "The hall is closed. Whoever is not here is accounted for.",
      "{king} sits.",
    ],
  },
];

/**
 * The herald opening the hall.
 *
 * A summons, not a welcome. The first version of this said "The hall is closed.
 * King Orion sits. Speak, and be brief" — polite, and therefore wrong: nothing
 * about it suggested a man who took a kingdom by force and is not finished.
 * These are orders, and the fear in them is that attendance was never optional.
 *
 * Seeded on the King and the subject, because three separate places ask for
 * this text and all of them must get the same sentence.
 */
export function courtOpenScript(config: Config, topic: string): string {
  const subject = topic.trim().replace(/\s+/g, " ").slice(0, 90);
  const king = config.orion.king.name;

  const variant = COURT_OPENERS[hashSeed(`${king}|${subject}`) % COURT_OPENERS.length];
  const lines = subject ? variant.withTopic : variant.withoutTopic;

  return lines
    .map((line) => line.split("{king}").join(king).split("{topic}").join(subject))
    .join(" ");
}

export function renderCourtOpen(
  config: Config,
  topic: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<AudioBuffer | null> {
  if (config.tts.engine === "none") return Promise.resolve(null);
  return renderCourtImaging(config, courtOpenScript(config, topic), outPath, signal);
}

export async function renderCourtImaging(
  config: Config,
  text: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<AudioBuffer | null> {
  const seed = hashSeed(`${config.orion.king.name}|${text}`);

  // Slower still than before. A summons read at pace is a town crier; read
  // slowly it is somebody who knows nobody is going to interrupt him.
  const voice = await speakAnnouncer(config, text, `${outPath}.voice.wav`, -4, signal);

  // Two bells before a word is said. The wait is the threat.
  const lead = 5.6;
  const voiceSeconds = voice ? durationOf(voice) : 3;
  const totalSeconds = lead + voiceSeconds + 4.2;
  const total = Math.round(totalSeconds * SAMPLE_RATE);

  const voiceTrack = new Float32Array(total);
  const at = Math.round(lead * SAMPLE_RATE);
  if (voice) {
    for (let i = 0; i < voice.data.length && at + i < total; i++) voiceTrack[at + i] = voice.data[i];
  }

  const hall = makeCourtOpen(totalSeconds, seed, SAMPLE_RATE);
  const bed = new Float32Array(total);
  for (let i = 0; i < hall.data.length && i < total; i++) bed[i] = hall.data[i] * 0.95;

  // The drone steps back under the words rather than being cut — a bell that
  // stops when someone talks was never a bell.
  const ducked = duck(bed, voiceTrack, SAMPLE_RATE, 0.55);

  const out = new Float32Array(total);
  for (let i = 0; i < total; i++) out[i] = ducked[i] + voiceTrack[i];

  let mixed: AudioBuffer = { sampleRate: SAMPLE_RATE, data: out };
  mixed = compress(mixed, { thresholdDb: -18, ratio: 2.5, makeupDb: 2 });
  mixed = normalize(mixed, 0.9);
  mixed = limit(mixed, 0.97);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, encodeWav(mixed));
  return mixed;
}

export function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
