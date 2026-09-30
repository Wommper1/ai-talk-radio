/**
 * Audio production: turn a finished conversation into a mixed show.
 *
 * Timecodes come from the real length of each synthesised clip rather than
 * being guessed by a model, so the transcript always lines up with playback.
 */

import fs from "node:fs";
import path from "node:path";
import { voiceFor, type Config, type TtsEngine, type VoiceTone } from "../config.ts";
import { synthesize } from "../providers/tts.ts";
import {
  decodeWav,
  encodeWav,
  encodeWavStereo,
  pan,
  durationOf,
  normalize,
  trimSilence,
  gain,
  fade,
  resample,
  SAMPLE_RATE,
  type AudioBuffer,
  type StereoBuffer,
} from "../audio/wav.ts";
import { applyTone, broadcastVoice, duck, limit } from "../audio/effects.ts";
import { masterMono, masterStereo, type AudioAnalysis } from "../audio/loudness.ts";
import { generateBed, type Mood } from "../audio/music.ts";
import { makeSting, STING_LENGTHS } from "../audio/stings.ts";
import type { Turn } from "./conversation.ts";
import { MAX_MIX_SECONDS, mixPolicy } from "../../shared/mix-policy.ts";

export interface TranscriptLine {
  start: number;
  end: number;
  speaker: string;
  /**
   * Who is on air. "break" is a commercial, "station" is the show's own
   * imaging and "song" is a record — none of them is a person, but each
   * occupies real time in the mix and so belongs on the same timeline as the
   * dialogue.
   */
  hostId: "a" | "b" | "caller" | "break" | "station" | "song";
  text: string;
}

export interface ProduceResult {
  transcript: TranscriptLine[];
  duration: number;
  audioPath: string;
  /** True when speech was synthesised; false when TTS is off. */
  hasAudio: boolean;
  /** Saved with the show so the operator can compare finished masters. */
  audioAnalysis?: AudioAnalysis;
}

export interface ProduceEvents {
  onInfo?: (message: string) => void;
  onProgress?: (done: number, total: number, speaker: string) => void;
}

/** The subset of a host or caller that turning text into audio needs. */
export interface SpeakerVoice {
  voices: Record<TtsEngine, string>;
  tone: VoiceTone;
  rate: number;
}

export function hostFor(config: Config, hostId: "a" | "b" | "caller"): SpeakerVoice {
  if (hostId === "caller") return config.caller;
  return config.hosts[0].id === hostId ? config.hosts[0] : config.hosts[1];
}

/**
 * Speak one turn and apply the full voice chain.
 *
 * This is the single place a turn becomes audio, so the clip played live while
 * the show is being written is bit-for-bit the clip that ends up in the mix.
 * The WAV written to `outPath` is already processed and at SAMPLE_RATE.
 */
export async function renderTurnClip(
  config: Config,
  host: SpeakerVoice,
  text: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<AudioBuffer> {
  await synthesize(
    { text, voice: voiceFor(host, config.tts.engine), rate: host.rate, outPath },
    config.tts,
    signal,
  );

  let clip = decodeWav(fs.readFileSync(outPath));
  clip = resample(clip, SAMPLE_RATE);
  clip = trimSilence(clip);
  clip = applyTone(clip, host.tone);
  clip = broadcastVoice(clip);
  // Level each turn individually so one host is not quieter than the other.
  clip = normalize(clip, 0.86);

  // Overwrite with the processed audio so re-reads are already correct.
  fs.writeFileSync(outPath, encodeWav(clip));
  return clip;
}

/**
 * Estimate speaking time when there is no audio, so a text-only show still has
 * usable timecodes. Roughly 155 words per minute plus a beat between turns.
 */
function estimateSeconds(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1.2, (words / 155) * 60);
}

export interface ProduceExtras {
  /** Break index → path of a break already rendered by `renderBreak`. */
  breaks?: Map<number, string>;
  /** Path of the pre-rendered cold open, played before the first line. */
  coldOpen?: string;
  /** Label for each break, used in the transcript. */
  breakLabels?: Map<number, string>;
  /** What the cold open actually says, for the transcript. */
  coldOpenText?: string;
  /** The announcer throwing to the opening record. */
  songIntro?: string;
  /** The opening record itself, already decoded to the pipeline's format. */
  song?: AudioBuffer;
  /** What to call the record in the feed and the transcript. */
  songLabel?: string;
  /** What the throw to the record actually says, for the transcript. */
  songIntroText?: string;
}

/**
 * One thing on the show's timeline.
 *
 * Dialogue, commercials and station imaging all end up as placed audio with a
 * known start time, which is what lets the transcript, the ducking and the
 * stereo placement all agree with each other no matter what is in the show.
 */
export interface Placed {
  kind: "voice" | "ad" | "open" | "song";
  clip: AudioBuffer;
  start: number;
  /** -1 left, 0 centre, 1 right. Commercials and imaging sit centred. */
  side: number;
  turn?: Turn;
  label?: string;
}

export async function produceShow(
  config: Config,
  turns: Turn[],
  showDir: string,
  events: ProduceEvents = {},
  signal?: AbortSignal,
  /** Turn index → path of a clip already rendered by renderTurnClip. */
  prerendered?: Map<number, string>,
  extras: ProduceExtras = {},
): Promise<ProduceResult> {
  fs.mkdirSync(showDir, { recursive: true });

  // ── Text-only path ───────────────────────────────────────────────
  if (config.tts.engine === "none") {
    events.onInfo?.("Speech is disabled — building a transcript with estimated timings.");

    let at = 0;
    const transcript: TranscriptLine[] = [];

    // No audio is being mixed, but the record is still part of the running
    // order and its length is known, so the timings stay honest.
    if (extras.song) {
      const seconds = durationOf(extras.song);
      transcript.push({
        start: at,
        end: at + seconds,
        speaker: "Music",
        hostId: "song",
        text: extras.songLabel ?? "Opening record",
      });
      at += seconds;
    }

    for (const turn of turns) {
      const seconds = estimateSeconds(turn.text);
      transcript.push({
        start: at,
        end: at + seconds,
        speaker: turn.speaker,
        hostId: turn.hostId,
        text: turn.text,
      });
      at += seconds + config.show.gapSeconds;

      // Breaks have no audio here, but they are still part of the running
      // order and belong in the transcript.
      if (turn.breakAfter !== undefined && extras.breakLabels?.has(turn.breakAfter)) {
        const label = extras.breakLabels.get(turn.breakAfter) ?? "Commercial break";
        transcript.push({ start: at, end: at + 30, speaker: "Break", hostId: "break", text: label });
        at += 30;
      }
    }

    return { transcript, duration: at, audioPath: "", hasAudio: false };
  }

  // ── Synthesise each turn ─────────────────────────────────────────
  const segmentsDir = path.join(showDir, "segments");
  fs.mkdirSync(segmentsDir, { recursive: true });

  const placed: Placed[] = [];
  const transcript: TranscriptLine[] = [];
  const quality = config.audio;

  let cursor = 0;

  /** Add an item at the play head and advance it, gap included. */
  const place = (item: Omit<Placed, "start">, gapAfter = config.show.gapSeconds) => {
    placed.push({ ...item, start: cursor });
    cursor += durationOf(item.clip) + gapAfter;
  };

  // The station's own opener, rendered before the model wrote anything.
  if (extras.coldOpen && fs.existsSync(extras.coldOpen)) {
    try {
      const open = decodeWav(fs.readFileSync(extras.coldOpen));
      const openPath = path.join(segmentsDir, "000-open.wav");
      fs.copyFileSync(extras.coldOpen, openPath);

      transcript.push({
        start: cursor,
        end: cursor + durationOf(open),
        speaker: config.show.station,
        hostId: "station",
        text: extras.coldOpenText ?? `${config.show.station} — station opener`,
      });
      place({ kind: "open", clip: open, side: 0 }, 0.15);
    } catch {
      // A missing or unreadable opener just means the show starts on line one.
    }
  }

  // The throw to the record, then the record. Both are centred: they are the
  // station, not one of the two people sitting either side of the desk.
  if (extras.songIntro && fs.existsSync(extras.songIntro)) {
    try {
      const intro = decodeWav(fs.readFileSync(extras.songIntro));
      fs.copyFileSync(extras.songIntro, path.join(segmentsDir, "000-song-intro.wav"));

      transcript.push({
        start: cursor,
        end: cursor + durationOf(intro),
        speaker: config.show.station,
        hostId: "station",
        text: extras.songIntroText ?? `${config.show.station} — into the record`,
      });
      place({ kind: "open", clip: intro, side: 0 }, 0.1);
    } catch {
      // Losing the throw is survivable; the record can still play.
    }
  }

  if (extras.song) {
    const song = config.show.openingSong.volume < 0.999
      ? gain(extras.song, config.show.openingSong.volume)
      : extras.song;

    transcript.push({
      start: cursor,
      end: cursor + durationOf(song),
      speaker: "Music",
      hostId: "song",
      text: extras.songLabel ?? "Opening record",
    });
    place({ kind: "song", clip: song, side: 0 }, 0.25);
  }

  for (let i = 0; i < turns.length; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const turn = turns[i];
    const host = hostFor(config, turn.hostId);
    events.onProgress?.(i, turns.length, turn.speaker);

    const clipPath = path.join(segmentsDir, `${String(i + 1).padStart(3, "0")}-${turn.hostId}.wav`);

    // Turns spoken live during the conversation are already rendered; reusing
    // them keeps the show instant to assemble and avoids paying for TTS twice.
    const ready = prerendered?.get(turn.index);
    let clip: AudioBuffer;

    if (ready && fs.existsSync(ready)) {
      clip = decodeWav(fs.readFileSync(ready));
      fs.copyFileSync(ready, clipPath);
    } else {
      clip = await renderTurnClip(config, host, turn.text, clipPath, signal);
    }

    transcript.push({
      start: cursor,
      end: cursor + durationOf(clip),
      speaker: turn.speaker,
      hostId: turn.hostId,
      text: turn.text,
    });

    // Host A sits left of centre, host B right of centre, and a caller sits
    // between them so a phone-in is clearly a third person in the room.
    const side = turn.hostId === "a" ? -1 : turn.hostId === "b" ? 1 : 0;
    place({ kind: "voice", clip, side, turn });

    // ── Commercials, already rendered while the hosts were still talking.
    if (turn.breakAfter !== undefined) {
      const breakPath = extras.breaks?.get(turn.breakAfter);
      if (breakPath && fs.existsSync(breakPath)) {
        try {
          const adClip = decodeWav(fs.readFileSync(breakPath));
          if (durationOf(adClip) > 0.5) {
            const label = extras.breakLabels?.get(turn.breakAfter) ?? "Commercial break";
            const adPath = path.join(segmentsDir, `${String(i + 1).padStart(3, "0")}-break.wav`);
            fs.copyFileSync(breakPath, adPath);

            transcript.push({
              start: cursor,
              end: cursor + durationOf(adClip),
              speaker: "Break",
              hostId: "break",
              text: label,
            });
            // A little more air either side than between two lines — a break
            // that butts straight up against dialogue sounds like a glitch.
            place({ kind: "ad", clip: adClip, side: 0, label }, 0.4);
          }
        } catch {
          // A break that will not decode is dropped; the show continues.
        }
      }
    }
  }

  events.onProgress?.(turns.length, turns.length, "");

  if (placed.length === 0) {
    throw new Error("No audio was produced — every turn failed to synthesise.");
  }

  const totalSeconds = cursor;
  const policy = mixPolicy(totalSeconds + config.show.outroSeconds, quality.stereo);
  if (!policy.allowed) {
    throw new Error(
      `This show is longer than the ${Math.round(MAX_MIX_SECONDS / 60)} minute safe mixing limit. ` +
      "Recover the saved draft, shorten the running order, or split it into episodes.",
    );
  }
  if (quality.stereo && !policy.stereo) {
    events.onInfo?.("Long-show safety mode: mixing in mono without a generated bed to keep memory bounded.");
  }

  // ── Station imaging ──────────────────────────────────────────────
  // Stings are laid over the assembled timeline rather than inserted into it,
  // so they overlap the dialogue the way a real desk rides them, and the
  // transcript timings stay exactly as recorded.
  const imaging = config.imaging;
  const stationSeed = hashSeed(config.show.station);
  const cues: Array<{ at: number; buffer: AudioBuffer; gain: number }> = [];

  if (imaging.level > 0.01) {
    const level = imaging.level;
    const hasColdOpen = placed[0]?.kind === "open";

    if (imaging.useIdent) {
      // Top of show, under the first words — unless the cold open already did
      // exactly this job, in which case a second ident is just clutter.
      if (!hasColdOpen) {
        cues.push({
          at: 0,
          buffer: makeSting("bumper", STING_LENGTHS.bumper, stationSeed, SAMPLE_RATE),
          gain: level * 0.9,
        });
      }
      // Tail, just as the last line lands.
      cues.push({
        at: Math.max(0, totalSeconds - 1.2),
        buffer: makeSting("ident", STING_LENGTHS.ident, stationSeed, SAMPLE_RATE),
        gain: level * 0.75,
      });
    }

    if (imaging.useTransitions || imaging.useCallStings) {
      let voiceIndex = 0;

      for (let index = 0; index < placed.length; index++) {
        const item = placed[index];
        // The break carries its own imaging, and the sweep out of it would
        // fight the ident it already ends on.
        if (item.kind !== "voice" || !item.turn) continue;

        const previous = index > 0 ? placed[index - 1] : undefined;
        const isCaller = item.turn.hostId === "caller";
        const previousWasCaller = previous?.kind === "voice" && previous.turn?.hostId === "caller";
        const afterBreak = previous?.kind === "ad";

        if (isCaller && imaging.useCallStings) {
          cues.push({
            at: Math.max(0, item.start - 0.35),
            buffer: makeSting("beep", STING_LENGTHS.beep, stationSeed + 1, SAMPLE_RATE),
            gain: level * 0.55,
          });
        } else if (previousWasCaller && imaging.useCallStings) {
          cues.push({
            at: Math.max(0, item.start - 0.3),
            buffer: makeSting("whoosh", STING_LENGTHS.whoosh, stationSeed + 2, SAMPLE_RATE),
            gain: level * 0.5,
          });
        } else if (imaging.useTransitions && !afterBreak && voiceIndex > 0 && voiceIndex % 4 === 0) {
          // Every few turns, a sweep marks the move to a new beat.
          cues.push({
            at: Math.max(0, item.start - 0.45),
            buffer: makeSting("whoosh", STING_LENGTHS.whoosh, stationSeed + voiceIndex, SAMPLE_RATE),
            gain: level * 0.42,
          });
        }

        voiceIndex++;
      }
    }
  }

  // ── Assemble ─────────────────────────────────────────────────────
  events.onInfo?.("Mixing...");

  const mood = config.show.mood as Mood;

  // Level each spoken clip before anything else. Doing it per clip rather than
  // on the finished mix means both the mono and stereo paths get identical
  // dialogue treatment, and the music is never squashed along with the voices.
  // Commercials and the opener arrive already produced to their own rules, so
  // they are not compressed again here.
  // Voice clips already carry the same per-mic chain heard during live
  // generation. Do not compress them a second time here; double compression
  // is one of the quickest ways to make neural speech sound flat and robotic.
  const compressed: Placed[] = placed;

  // Then set the loudness jump. A break arrives produced to its own rules, but
  // how loud that lands next to the show depends on the voices and on whether
  // the dialogue was compressed, so the jump is measured against the dialogue
  // as it will actually be heard rather than assumed.
  const treated = matchAdLoudness(compressed, config.ads.loudnessDb);

  const totalLength = Math.round(totalSeconds * SAMPLE_RATE);

  /** The dry sum of everything on the timeline, used to drive the ducker. */
  const dry = new Float32Array(totalLength);
  for (const item of treated) {
    const offset = Math.round(item.start * SAMPLE_RATE);
    for (let i = 0; i < item.clip.data.length && offset + i < totalLength; i++) {
      dry[offset + i] += item.clip.data[i];
    }
  }

  const useMusic = policy.proceduralBed && mood !== "none" && config.show.musicVolume > 0.001;

  const bed = useMusic
    ? gain(
        fade(
          generateBed(totalSeconds + config.show.outroSeconds, mood, hashSeed(showDir)),
          2.5,
          Math.min(4, config.show.outroSeconds || 2),
        ),
        config.show.musicVolume,
      )
    : null;

  const duckedBed = bed ? duck(bed.data, dry, SAMPLE_RATE, config.show.duckDepth) : null;

  // The bed runs past the last word, so the show is as long as whichever of
  // the two ends last.
  const mixLength = Math.max(totalLength, duckedBed?.length ?? 0);

  // The show's own music has no business playing under a commercial — the
  // break brought its own — nor under a record, which is the music. Muting it
  // there is most of what makes the transition sound like a real desk rather
  // than a crossfade.
  const adWindows = treated
    .filter((item) => item.kind === "ad" || item.kind === "song")
    .map((item) => ({
      from: Math.round((item.start - 0.25) * SAMPLE_RATE),
      to: Math.round((item.start + durationOf(item.clip) + 0.25) * SAMPLE_RATE),
    }));

  const bedAt = (i: number): number => {
    if (!duckedBed || i >= duckedBed.length) return 0;
    for (const w of adWindows) {
      if (i >= w.from && i < w.to) return 0;
    }
    return duckedBed[i];
  };

  let finalBuffer: Buffer;
  let duration: number;
  let audioAnalysis: AudioAnalysis;

  if (policy.stereo) {
    // Place the hosts either side of centre so they are easier to tell apart.
    const left = new Float32Array(mixLength);
    const right = new Float32Array(mixLength);

    for (const item of treated) {
      const placedAudio = pan(item.clip.data, item.side * quality.width);
      const offset = Math.round(item.start * SAMPLE_RATE);

      for (let j = 0; j < placedAudio.left.length && offset + j < mixLength; j++) {
        left[offset + j] += placedAudio.left[j];
        right[offset + j] += placedAudio.right[j];
      }
    }

    // Music stays wide and centred, behind the voices.
    for (let i = 0; i < mixLength; i++) {
      const v = bedAt(i);
      if (v === 0) continue;
      left[i] += v;
      right[i] += v;
    }

    // Imaging sits centred and on top, the way a desk rides it.
    for (const cue of cues) {
      const offset = Math.round(cue.at * SAMPLE_RATE);
      for (let i = 0; i < cue.buffer.data.length && offset + i < mixLength; i++) {
        const v = cue.buffer.data[i] * cue.gain;
        left[offset + i] += v;
        right[offset + i] += v;
      }
    }

    let stereo = { sampleRate: SAMPLE_RATE, left, right };
    stereo = normalizeStereo(stereo, 0.92);
    stereo = limitStereo(stereo, 0.97);
    stereo = resampleStereo(stereo, quality.sampleRate);
    const mastered = masterStereo(stereo);
    stereo = mastered.audio;
    audioAnalysis = mastered.analysis;

    duration = stereo.left.length / stereo.sampleRate;
    finalBuffer = encodeWavStereo(stereo, quality.bitDepth);
  } else {
    const out = new Float32Array(mixLength);
    out.set(dry.subarray(0, Math.min(dry.length, mixLength)), 0);

    for (let i = 0; i < mixLength; i++) out[i] += bedAt(i);

    for (const cue of cues) {
      const offset = Math.round(cue.at * SAMPLE_RATE);
      for (let i = 0; i < cue.buffer.data.length && offset + i < mixLength; i++) {
        out[offset + i] += cue.buffer.data[i] * cue.gain;
      }
    }

    let mixed: AudioBuffer = { sampleRate: SAMPLE_RATE, data: out };
    mixed = normalize(mixed, 0.92);
    mixed = limit(mixed, 0.97);
    mixed = resample(mixed, quality.sampleRate);
    const mastered = masterMono(mixed);
    mixed = mastered.audio;
    audioAnalysis = mastered.analysis;

    duration = durationOf(mixed);
    finalBuffer = encodeWav(mixed, quality.bitDepth);
  }

  const audioPath = path.join(showDir, "show.wav");
  fs.writeFileSync(audioPath, finalBuffer);

  return { transcript, duration, audioPath, hasAudio: true, audioAnalysis };
}

/** Average level of a set of clips, weighted by how long each one runs. */
function rmsOf(clips: AudioBuffer[]): number {
  let energy = 0;
  let samples = 0;
  for (const clip of clips) {
    for (const v of clip.data) energy += v * v;
    samples += clip.data.length;
  }
  return samples === 0 ? 0 : Math.sqrt(energy / samples);
}

/**
 * Put every commercial `loudnessDb` above the dialogue around it.
 *
 * The break is already produced and dense; what is unknown is how that sits
 * against these particular voices after the dialogue compressor, so the level
 * is set by measurement rather than by a fixed gain. Correcting the break
 * rather than the show keeps the dialogue exactly as it was mixed.
 */
export function matchAdLoudness(items: Placed[], loudnessDb: number): Placed[] {
  const dialogue = rmsOf(items.filter((item) => item.kind === "voice").map((item) => item.clip));
  if (dialogue < 1e-6) return items;

  const target = dialogue * Math.pow(10, loudnessDb / 20);

  return items.map((item) => {
    if (item.kind !== "ad") return item;

    const asRendered = rmsOf([item.clip]);
    if (asRendered < 1e-6) return item;

    // A nudge, not a rebuild: +/-9 dB is enough to correct production, and it
    // stops a break that came back nearly silent being amplified into noise.
    const bounded = (want: number) => Math.min(2.82, Math.max(0.355, want));

    // The limiter hands back a little of whatever gain it is given, so the
    // scaling is solved for over a few passes instead of applied once. Each
    // pass rescales the original clip, so the limiter only ever runs once on
    // the audio that is kept.
    let scale = bounded(target / asRendered);
    let clip = limit(gain(item.clip, scale), 0.98);

    for (let pass = 0; pass < 4; pass++) {
      const achieved = rmsOf([clip]);
      if (achieved < 1e-6) break;

      const correction = target / achieved;
      if (Math.abs(correction - 1) < 0.006) break; // within ~0.05 dB

      const next = bounded(scale * correction);
      if (Math.abs(next - scale) < 1e-4) break; // clamped, or already converged

      scale = next;
      clip = limit(gain(item.clip, scale), 0.98);
    }

    return { ...item, clip };
  });
}

/** Peak-normalise a stereo pair, preserving the balance between channels. */
function normalizeStereo(audio: StereoBuffer, peak: number): StereoBuffer {
  let max = 0;
  for (let i = 0; i < audio.left.length; i++) {
    max = Math.max(max, Math.abs(audio.left[i]), Math.abs(audio.right[i]));
  }
  if (max < 1e-6) return audio;

  const g = peak / max;
  const left = new Float32Array(audio.left.length);
  const right = new Float32Array(audio.right.length);
  for (let i = 0; i < left.length; i++) {
    left[i] = audio.left[i] * g;
    right[i] = audio.right[i] * g;
  }
  return { sampleRate: audio.sampleRate, left, right };
}

/** Limit both channels with a shared gain, so the stereo image does not wobble. */
function limitStereo(audio: StereoBuffer, ceiling: number): StereoBuffer {
  const mono: AudioBuffer = { sampleRate: audio.sampleRate, data: new Float32Array(audio.left.length) };
  for (let i = 0; i < mono.data.length; i++) {
    mono.data[i] = Math.max(Math.abs(audio.left[i]), Math.abs(audio.right[i]));
  }

  const limited = limit(mono, ceiling);
  const left = new Float32Array(audio.left.length);
  const right = new Float32Array(audio.right.length);

  for (let i = 0; i < left.length; i++) {
    // Recover the gain the limiter applied and use it on both channels.
    const g = mono.data[i] > 1e-9 ? limited.data[i] / mono.data[i] : 1;
    left[i] = audio.left[i] * g;
    right[i] = audio.right[i] * g;
  }

  return { sampleRate: audio.sampleRate, left, right };
}

function resampleStereo(audio: StereoBuffer, targetRate: number): StereoBuffer {
  if (audio.sampleRate === targetRate) return audio;
  const l = resample({ sampleRate: audio.sampleRate, data: audio.left }, targetRate);
  const r = resample({ sampleRate: audio.sampleRate, data: audio.right }, targetRate);
  return { sampleRate: targetRate, left: l.data, right: r.data };
}

/** Stable seed per show so re-rendering the same show gives the same bed. */
function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
