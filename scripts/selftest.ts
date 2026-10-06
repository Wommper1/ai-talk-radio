/**
 * Offline self-test for the audio engine. No network, no models, no API keys.
 * Run with: npm run selftest
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  encodeWav,
  encodeWavStereo,
  pan,
  decodeWav,
  durationOf,
  normalize,
  concat,
  silence,
  trimSilence,
  resample,
  mixInto,
  fade,
} from "../server/audio/wav.ts";
import { generateBed, makeLoopBed, renderRock, MOODS } from "../server/audio/music.ts";
import {
  AD_ANGLES,
  breakPositions,
  chooseAngle,
  describeBreak,
  resolveAdFile,
  smallPrintFor,
  toLines,
} from "../server/pipeline/ads.ts";
import { callerBriefing, findCaller } from "../server/memory/callers.ts";
import { openingOf } from "../server/memory/adhistory.ts";
import {
  briefing as runningBriefing,
  forget as forgetRunning,
  get as getRunning,
  laneFor,
  remember as rememberRunning,
} from "../server/memory/running.ts";
import { coldOpenScript } from "../server/pipeline/coldopen.ts";
import { SHOWS_PER_PACK, currentPreroll, listPrerolls } from "../server/pipeline/preroll.ts";
import { advancePlayedRecords, bucketStats, listBucket, pickForShow } from "../server/pipeline/bucket.ts";
import {
  activeBrainVersion,
  briefFor,
  commercialCopyIssue,
  realmCommercialPulse,
} from "../server/pipeline/bucketwriter.ts";
import { CURRENT_AD_LIBRARY_FORMAT, pickForReuse } from "../server/pipeline/adlibrary.ts";
import { matchAdLoudness, type Placed } from "../server/pipeline/produce.ts";
import { normalizeConfig, DEFAULT_CONFIG } from "../server/config.ts";
import { duck, applyTone, compress, limit } from "../server/audio/effects.ts";
import { analyseLoudness, masterStereo } from "../server/audio/loudness.ts";
import {
  addressesSelf,
  beatsFromText,
  cleanLine,
  fallsIntoBureaucracy,
  reportsOtherInsteadOfReplying,
  reusesOpeningRecord,
  runConversation,
  unsupportedCourtClaim,
} from "../server/pipeline/conversation.ts";
import { DJ_EXAMPLES, selectDjExamples } from "../server/pipeline/djexamples.ts";
import { auditDjConfig, DJ_EVAL_TOPICS, evaluateDjTranscript } from "../server/pipeline/djeval.ts";
import { isRecallEligible, recallBlock } from "../server/memory/retrieval.ts";
import { CURRENT_SHOW_FORMAT } from "../server/pipeline/store.ts";
import { groupCommercialBreaks } from "../shared/commercial-rotation.ts";
import { isSafeJobId, jobIdProblem, shouldWarmUpShow } from "../shared/show-job.ts";
import { applyPerformanceProfile } from "../shared/performance-profiles.ts";
import { missingModels } from "../shared/model-preflight.ts";
import { LOW_MEMORY_MIX_SECONDS, MAX_MIX_SECONDS, mixPolicy } from "../shared/mix-policy.ts";
import {
  nextRetryState,
  normalizeScheduleSlot,
  safeAutomationId,
  scheduleSlotDue,
  slotRunKey,
  stationDateKey,
  validStationTime,
} from "../shared/station-automation.ts";
import {
  GUILD_NAME,
  readRealm,
  realmBriefing,
  realmSummary,
  royalMemoryIndex,
  resolveRealm,
} from "../server/orion/realm.ts";
import { ORION_EXAMPLES, selectOrionExamples } from "../server/orion/examples.ts";
import { evaluateOrionTranscript } from "../server/orion/eval.ts";
import { createWorldSnapshot, WORLD_CONTRACT } from "../server/orion/world-contract.ts";
import { parseWorldCommand, WorldCommandError } from "../server/orion/world-command.ts";
import { orionTrainingReadiness, orionTrainingRows } from "../server/orion/training.ts";
import { forgetTales, recordTales } from "../server/orion/chronicle.ts";
import { choosePetitioner, isWommper, voiceForMember } from "../server/orion/petitioners.ts";
import { generate, looksLikeToolCall, queueStats } from "../server/providers/llm.ts";
import { preferDistinctCopy, uniqueByCopy } from "../shared/commercial-rotation.ts";
import {
  buildRunSheet,
  echoesPrevious,
  repeatsOpening,
  repeatsImage,
  leansOnSimile,
  recentOpenings,
  usedOpenings,
  memoryBlock,
  EMPTY_MEMORY,
} from "../server/pipeline/showrunner.ts";

let failures = 0;

function check(label: string, condition: boolean, detail = "") {
  const mark = condition ? "  ok  " : " FAIL ";
  if (!condition) failures++;
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function allFinite(data: Float32Array): boolean {
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i])) return false;
  }
  return true;
}

function peakOf(data: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  return peak;
}

console.log("\n─── audio engine self-test ───\n");

// Music bed generation
const bed = generateBed(6, "tech", 42);
check("bed has the requested duration", Math.abs(durationOf(bed) - 6) < 0.05, `${durationOf(bed).toFixed(3)}s`);
check("bed samples are all finite", allFinite(bed.data));
check("bed is not silent", peakOf(bed.data) > 0.01, `peak ${peakOf(bed.data).toFixed(3)}`);

console.log("\n─── station automation ───\n");

const scheduleNow = new Date(2026, 8, 27, 9, 30, 0);
const scheduleSlot = normalizeScheduleSlot({
  id: "morning-drive",
  enabled: true,
  name: "Morning drive",
  topic: "What the city is talking about",
  time: "09:30",
  days: [0],
  turns: 24,
});
check("station time accepts a real clock value", validStationTime("23:59"));
check("station time refuses an impossible value", !validStationTime("24:60"));
check("scheduled show becomes due at its local minute", scheduleSlotDue(scheduleSlot, scheduleNow));
scheduleSlot.lastRunKey = slotRunKey(scheduleSlot, scheduleNow);
check("scheduled show runs only once per day", !scheduleSlotDue(scheduleSlot, scheduleNow));
check("station date keys use local calendar days", stationDateKey(scheduleNow) === "2026-09-27");
check("backup and schedule ids reject traversal", safeAutomationId("backup-2026") && !safeAutomationId("../backup"));
check("schedule turn counts are bounded", normalizeScheduleSlot({ turns: 500 }).turns === 60);

const firstFailure = nextRetryState(0, false, 10, scheduleNow);
check("a first failed run schedules a retry", firstFailure.retryCount === 1 && firstFailure.retryAt === new Date(scheduleNow.getTime() + 600_000).toISOString());
check("a second failed attempt still schedules a retry", nextRetryState(firstFailure.retryCount, true, 10, scheduleNow).retryAt !== undefined);
check("the third failed attempt stops retrying", nextRetryState(2, true, 10, scheduleNow).retryAt === undefined);
check("a new day's failure retries even after an earlier day exhausted its attempts", nextRetryState(3, false, 10, scheduleNow).retryAt !== undefined);

// Deterministic from seed
const bedA = generateBed(2, "chill", 99);
const bedB = generateBed(2, "chill", 99);
let identical = bedA.data.length === bedB.data.length;
for (let i = 0; identical && i < bedA.data.length; i++) {
  if (bedA.data[i] !== bedB.data[i]) identical = false;
}
check("same seed produces the same bed", identical);

// Every mood renders
for (const { id } of MOODS) {
  const b = generateBed(1.5, id, 7);
  check(`mood "${id}" renders`, allFinite(b.data) && Math.abs(durationOf(b) - 1.5) < 0.05);
}

// WAV round-trip
const encoded = encodeWav(normalize(bed, 0.5));
check("encoded WAV has a RIFF header", encoded.toString("ascii", 0, 4) === "RIFF");
check("encoded WAV declares WAVE", encoded.toString("ascii", 8, 12) === "WAVE");
check("encoded byte count matches sample count", encoded.length === 44 + bed.data.length * 2);

const decoded = decodeWav(encoded);
check("round-trip preserves duration", Math.abs(durationOf(decoded) - durationOf(bed)) < 0.01);
check("round-trip preserves sample rate", decoded.sampleRate === bed.sampleRate);

let maxErr = 0;
const src = normalize(bed, 0.5);
for (let i = 0; i < decoded.data.length; i++) {
  maxErr = Math.max(maxErr, Math.abs(decoded.data[i] - src.data[i]));
}
check("round-trip error is within 16-bit quantisation", maxErr < 0.0001, `max ${maxErr.toExponential(2)}`);

// Normalisation
const normalized = normalize(bed, 0.89);
check("normalize hits the target peak", Math.abs(peakOf(normalized.data) - 0.89) < 0.001);
check("normalize leaves silence alone", peakOf(normalize(silence(1)).data) === 0);

// Clipping guard
const hot = encodeWav({ sampleRate: 44100, data: Float32Array.from([2, -2, 0.5]) });
const hotBack = decodeWav(hot);
check("encoder clamps out-of-range samples", hotBack.data[0] <= 1 && hotBack.data[1] >= -1);

// Voice tones
for (const tone of ["phone", "studio", "room", "throne", "raw"] as const) {
  const t = applyTone(decoded, tone);
  check(`tone "${tone}" is stable`, allFinite(t.data) && peakOf(t.data) < 8, `peak ${peakOf(t.data).toFixed(3)}`);
}

// Telephone should actually remove low end
const lowTone: Float32Array = new Float32Array(44100);
for (let i = 0; i < lowTone.length; i++) lowTone[i] = Math.sin((2 * Math.PI * 80 * i) / 44100);
const phoned = applyTone({ sampleRate: 44100, data: lowTone }, "phone");
check("telephone filter attenuates 80 Hz", peakOf(phoned.data) < 0.25, `peak ${peakOf(phoned.data).toFixed(3)}`);

// Sidechain ducking
const ducked = duck(bed.data, decoded.data, bed.sampleRate, 0.7);
check("duck returns a matching length", ducked.length === bed.data.length);
check("duck output is finite", allFinite(ducked));
check("duck reduces level under speech", peakOf(ducked) <= peakOf(bed.data) + 1e-6);

// Assembly helpers
const joined = concat([bed, silence(1), bed]);
check("concat sums durations", Math.abs(durationOf(joined) - 13) < 0.05, `${durationOf(joined).toFixed(2)}s`);

const padded = concat([silence(0.5), bed, silence(0.5)]);
const trimmed = trimSilence(padded);
check("trimSilence removes the padding", durationOf(trimmed) < durationOf(padded) - 0.5, `${durationOf(trimmed).toFixed(2)}s`);

const resampled = resample(bed, 22050);
check("resample changes the rate", resampled.sampleRate === 22050);
check("resample preserves duration", Math.abs(durationOf(resampled) - durationOf(bed)) < 0.01);

const mixed = mixInto(silence(10), bed, 2);
check("mixInto places audio at the offset", peakOf(mixed.data.slice(0, 44100)) === 0 && peakOf(mixed.data.slice(2 * 44100)) > 0.01);

const faded = fade(bed, 1, 1);
check("fade starts from silence", Math.abs(faded.data[0]) < 1e-6);
check("fade ends in silence", Math.abs(faded.data[faded.data.length - 1]) < 1e-6);

/* ── Quality chain ─────────────────────────────────────────────── */

console.log("\n─── quality chain ───\n");

// 24-bit round trip
const tone24 = new Float32Array(2000);
for (let i = 0; i < tone24.length; i++) tone24[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.7;

const wav24 = encodeWav({ sampleRate: 44100, data: tone24 }, 24);
check("24-bit header declares 24 bits", wav24.readUInt16LE(34) === 24);
check("24-bit uses 3 bytes per sample", wav24.length === 44 + tone24.length * 3);

const back24 = decodeWav(wav24);
let err24 = 0;
for (let i = 0; i < tone24.length; i++) err24 = Math.max(err24, Math.abs(back24.data[i] - tone24[i]));
check("24-bit round trip is near-lossless", err24 < 1e-6, `max ${err24.toExponential(2)}`);

// Negative values are the case a hand-rolled 24-bit packer gets wrong.
const neg = encodeWav({ sampleRate: 44100, data: Float32Array.from([-0.5, -1, 0.5, 1]) }, 24);
const negBack = decodeWav(neg);
check("24-bit encodes negatives correctly", Math.abs(negBack.data[0] + 0.5) < 1e-5 && negBack.data[1] <= -0.99);

// Stereo
const { left: pl, right: pr } = pan(tone24, -1);
check("hard-left pan silences the right", peakOf(pr) < 1e-6 && peakOf(pl) > 0.6);
const centre = pan(tone24, 0);
check("centre pan is equal power", Math.abs(peakOf(centre.left) - peakOf(centre.right)) < 1e-6);
check("centre pan is ~-3 dB per side", Math.abs(peakOf(centre.left) - 0.7 * Math.SQRT1_2) < 0.01);

const stereoWav = encodeWavStereo({ sampleRate: 44100, left: pl, right: pr }, 16);
check("stereo header declares 2 channels", stereoWav.readUInt16LE(22) === 2);
check("stereo byte count is interleaved", stereoWav.length === 44 + pl.length * 2 * 2);
const stereoBack = decodeWav(stereoWav);
check("stereo decodes as the mono downmix", Math.abs(peakOf(stereoBack.data) - peakOf(pl) / 2) < 0.01);

const quietFrames = 48_000 * 2;
const quietLeft = new Float32Array(quietFrames);
const quietRight = new Float32Array(quietFrames);
for (let i = 0; i < quietFrames; i++) {
  const sample = Math.sin(2 * Math.PI * 440 * i / 48_000) * 0.035;
  quietLeft[i] = sample;
  quietRight[i] = sample;
}
const quietAnalysis = analyseLoudness({ sampleRate: 48_000, channels: [quietLeft, quietRight] });
check("integrated loudness is measured", quietAnalysis.integratedLufs !== null && Number.isFinite(quietAnalysis.integratedLufs));
check("true peak is measured", quietAnalysis.truePeakDbtp !== null && Number.isFinite(quietAnalysis.truePeakDbtp));
const masteredQuiet = masterStereo({ sampleRate: 48_000, left: quietLeft, right: quietRight });
check(
  "streaming master moves quiet material toward the target",
  Math.abs((masteredQuiet.analysis.integratedLufs ?? -100) + 16) < Math.abs((quietAnalysis.integratedLufs ?? -100) + 16),
);
check(
  "streaming master respects the true-peak ceiling",
  (masteredQuiet.analysis.truePeakDbtp ?? 0) <= -0.9,
  `${masteredQuiet.analysis.truePeakDbtp} dBTP`,
);

// Compression should reduce dynamic range, not destroy the signal.
const dyn = new Float32Array(44100);
for (let i = 0; i < dyn.length; i++) {
  const amp = i < dyn.length / 2 ? 0.08 : 0.9; // quiet half, then loud half
  dyn[i] = Math.sin((2 * Math.PI * 200 * i) / 44100) * amp;
}
const compressed = compress({ sampleRate: 44100, data: dyn }, { thresholdDb: -20, ratio: 4, makeupDb: 0 });
const quietBefore = peakOf(dyn.slice(0, 20000));
const loudBefore = peakOf(dyn.slice(30000));
const quietAfter = peakOf(compressed.data.slice(0, 20000));
const loudAfter = peakOf(compressed.data.slice(30000));
check("compressor output is finite", allFinite(compressed.data));
check(
  "compressor narrows the loud/quiet gap",
  loudAfter / quietAfter < loudBefore / quietBefore,
  `${(loudBefore / quietBefore).toFixed(1)}x → ${(loudAfter / quietAfter).toFixed(1)}x`,
);
check("compressor leaves quiet passages alone", Math.abs(quietAfter - quietBefore) < 0.02);

// Limiter must actually stop overs.
const overs = new Float32Array(44100);
for (let i = 0; i < overs.length; i++) overs[i] = Math.sin((2 * Math.PI * 300 * i) / 44100) * 1.6;
const limited = limit({ sampleRate: 44100, data: overs }, 0.97);
check("limiter holds the ceiling", peakOf(limited.data) <= 0.9701, `peak ${peakOf(limited.data).toFixed(4)}`);
check("limiter output is finite", allFinite(limited.data));
check("limiter leaves quiet audio untouched", peakOf(limit({ sampleRate: 44100, data: dyn }, 0.97).data) > 0.85);

// The loudness jump into a commercial is the one level relationship a listener
// notices, so check it lands where the config asks rather than near it.
const rmsOf = (data: Float32Array) => {
  let sum = 0;
  for (const v of data) sum += v * v;
  return Math.sqrt(sum / Math.max(1, data.length));
};

const noise = (seconds: number, amp: number, seed: number) => {
  const data = new Float32Array(Math.round(seconds * 44100));
  let x = seed;
  for (let i = 0; i < data.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (x / 0x3fffffff - 1) * amp;
  }
  return { sampleRate: 44100, data };
};

const jumpFor = (loudnessDb: number, adAmp: number) => {
  const items: Placed[] = [
    { kind: "voice", clip: noise(2, 0.3, 7), side: -1, start: 0 },
    { kind: "voice", clip: noise(2, 0.3, 99), side: 1, start: 2 },
    { kind: "ad", clip: noise(3, adAmp, 5), side: 0, start: 4 },
  ];
  const treated = matchAdLoudness(items, loudnessDb);
  const dialogue = rmsOf(treated.filter((i) => i.kind === "voice")[0].clip.data);
  const ad = treated.find((i) => i.kind === "ad")!.clip;
  return { db: 20 * Math.log10(rmsOf(ad.data) / dialogue), peak: peakOf(ad.data) };
};

for (const want of [0, 3, 6]) {
  // Once from below the dialogue and once from above, since a break that came
  // back hot has to be brought down as readily as a quiet one is lifted.
  for (const [label, amp] of [["quiet", 0.25] as const, ["hot", 0.6] as const]) {
    const got = jumpFor(want, amp);
    check(
      `a ${label} break lands ${want} dB above the dialogue`,
      Math.abs(got.db - want) < 0.15,
      `${got.db >= 0 ? "+" : ""}${got.db.toFixed(2)} dB`,
    );
    check(`a ${label} ${want} dB break stays under the ceiling`, got.peak <= 0.9801, `peak ${got.peak.toFixed(3)}`);
  }
}

// The correction is bounded, so a break that came back broken is moved as far
// as the guard allows and no further — nine dB, not however much it would take.
const wild = jumpFor(6, 0.02);
const unmatched = 20 * Math.log10(rmsOf(noise(3, 0.02, 5).data) / rmsOf(noise(2, 0.3, 7).data));
check("a broken break is lifted by the guard, not to the target", wild.db < 6 - 1, `${wild.db.toFixed(2)} dB`);
check("the guard lifts it by nine dB", Math.abs(wild.db - unmatched - 9) < 0.2, `+${(wild.db - unmatched).toFixed(2)} dB`);

check("dialogue is left alone by the ad matching", (() => {
  const voice = noise(1, 0.3, 21);
  const [out] = matchAdLoudness([{ kind: "voice", clip: voice, side: 0, start: 0 }], 6);
  return out.clip === voice;
})());

check("a silent break is not amplified into noise", (() => {
  const items: Placed[] = [
    { kind: "voice", clip: noise(1, 0.3, 3), side: 0, start: 0 },
    { kind: "ad", clip: { sampleRate: 44100, data: new Float32Array(44100) }, side: 0, start: 1 },
  ];
  return peakOf(matchAdLoudness(items, 6).find((i) => i.kind === "ad")!.clip.data) === 0;
})());

check("a show with no dialogue leaves its breaks alone", (() => {
  const ad = noise(1, 0.2, 11);
  const [out] = matchAdLoudness([{ kind: "ad", clip: ad, side: 0, start: 0 }], 6);
  return out.clip === ad;
})());

/* ── Text handling ───────────────────────────────────────────────
 * These cases are all real output shapes seen from local models.
 */

console.log("\n─── text handling ───\n");

// Tool-call detection: local models answer directives with function calls.
check("detects a Llama tool call", looksLikeToolCall('{"name": "welcome", "parameters": {"topic": "x"}}'));
check("detects a truncated tool call", looksLikeToolCall('{"name": "welcome", "parameters": {"topic": "x'));
check("detects a python_tag call", looksLikeToolCall('<|python_tag|>{"name": "go"}'));
check("passes ordinary dialogue through", !looksLikeToolCall("Welcome to the show, I'm Paul."));
check("passes dialogue containing braces", !looksLikeToolCall("He said the config was a {} and left."));
check("treats empty text as not a call", !looksLikeToolCall("   "));

// Line cleaning: models add labels, stage directions and markdown despite instructions.
check("strips a speaker label", cleanLine("Paul: Good evening.", "Paul", "Rae") === "Good evening.");
check("strips a bold speaker label", cleanLine("**Paul:** Good evening.", "Paul", "Rae") === "Good evening.");
check("strips the co-host's label", cleanLine("Rae: Not so fast.", "Paul", "Rae") === "Not so fast.");
check(
  "strips stage directions",
  cleanLine("(laughs) That's the point. [music swells]", "Paul", "Rae") === "That's the point.",
);
check("strips wrapping quotes", cleanLine('"Just like that."', "Paul", "Rae") === "Just like that.");
check("strips markdown emphasis", cleanLine("That is *really* the issue.", "Paul", "Rae") === "That is really the issue.");
check("collapses newlines into spaces", cleanLine("One thing.\n\nThen another.", "Paul", "Rae") === "One thing. Then another.");
check("leaves clean dialogue untouched", cleanLine("Nothing to strip here.", "Paul", "Rae") === "Nothing to strip here.");
check(
  "keeps a colon that is not a label",
  cleanLine("Here is the thing: it does not add up.", "Paul", "Rae") === "Here is the thing: it does not add up.",
);

// Narration. The cue list this used to run on only held laughs, sighs and
// applause, so anything the model invented — "*reads the proclamation*" — had
// its asterisks stripped as markdown and was then read aloud by a king. These
// are the shapes that actually reached the speech engine.
const king = (text: string) => cleanLine(text, "King Orion", "Maeve");

check("a direction the old cue list never knew is gone", !king("*reads the proclamation* Bring him in.").includes("reads"));
check("and the line it was attached to survives", king("*reads the proclamation* Bring him in.") === "Bring him in.");
check("the word director is never spoken", !king("*director says this* The road is closed.").toLowerCase().includes("director"));
check("a narrator label is stripped", king("Narrator: The hall went quiet.") === "The hall went quiet.");
check("third-person narration of himself is gone", king("*He sets down the cup.* Bring him in.") === "Bring him in.");
check("an unclosed direction is still a direction", king("*he leans forward in the chair. Bring him in.") === "Bring him in.");
check("a parenthetical direction goes", king("(leaning back, coldly) Bring him in.") === "Bring him in.");
check(
  "an unclosed director note never reaches speech",
  king("Use the lobby instead. (Director's note: keep this as one continuous thought") === "Use the lobby instead.",
);
check("a turn that is nothing but a direction is not aired", king("*The King reads the proclamation aloud.*") === "");
check("emphasis on one word still survives", king("That is *really* the issue.") === "That is really the issue.");
check("emphasis on a pronoun survives", king("*He* took the granaries, not I.") === "He took the granaries, not I.");
check(
  "a whole line the model emphasised is still a line",
  king("*I will have him, and I will have the men who fed him.*") ===
    "I will have him, and I will have the men who fed him.",
);
// Caught in a live court on 2026-09-11, spoken aloud by the King: neither
// "stops" nor "trails" was in any cue list, and parentheses were exempt from
// the length test, so both were read out.
check("a parenthetical the model invented is gone", king("I will have him. (Stops, turning to face her directly) Bring the next one.") === "I will have him. Bring the next one.");
check("and a trailing one too", king("You will have to do better. (trails off, considering) What say you?") === "You will have to do better. What say you?");
// Found in a live court once a third voice was in the room: both speakers
// started writing prose with dialogue tags, and Maeve began writing the
// petitioner's lines for him. Read aloud, the listener hears the narration in
// the character's own voice.
check(
  "prose with a dialogue tag is reduced to the speech",
  king(`King Orion's eyes never leave her as he speaks: "You have made quite the claim there." he says, his voice cold as steel.`) ===
    "You have made quite the claim there.",
);
check(
  "a quote inside real speech is left alone",
  king('He wrote "the granaries were empty" in the record, and I have read it.') ===
    'He wrote "the granaries were empty" in the record, and I have read it.',
);
check(
  "a line that is only a quotation still survives",
  king('"I will have him, and the men who fed him."') === "I will have him, and the men who fed him.",
);
check("a two-word direction is gone too", king("The debt grows. (trailing off) But I will not let it cloud my judgment.") === "The debt grows. But I will not let it cloud my judgment.");
check("a one-word participle is a direction", king("I will have him. (considering) Bring the next one.") === "I will have him. Bring the next one.");
check("a one-word aside is not", king("He tried it (again) and it did not take.") === "He tried it (again) and it did not take.");
check("a two-word aside that links survives", king("The granaries (or worse) are gone.") === "The granaries (or worse) are gone.");
check("a short aside that is not narration survives", king("Greyditch (or what is left of it) pays nothing.") === "Greyditch (or what is left of it) pays nothing.");

check(
  "a real parenthetical aside is left alone",
  king("Greyditch (what is left of it) pays nothing this year.") ===
    "Greyditch (what is left of it) pays nothing this year.",
);

// An empty other-name is what a caller's line is cleaned with, and the label
// pattern must not turn that into a rule that eats a leading colon.
check("cleaning with no second speaker is safe", cleanLine("Ashra: I came back. Twice.", "Ashra", "") === "I came back. Twice.");
check("and it does not eat an ordinary colon", cleanLine("One thing: he lied.", "Ashra", "") === "One thing: he lied.");
check("a petitioner's stage business never reaches the hall", cleanLine("*shrugs* You sent for me.", "Ashra", "") === "You sent for me.");

// Beat recovery from every shape models actually return.
const beatCases: Array<[string, string, number]> = [
  [
    "tool call with nested single-quoted array",
    '{"name": "plan", "parameters": {"discussion_points": "[[\'Efficiency benefits\', \'Cost savings\'], [\'Technical issues\']]"}}',
    3,
  ],
  ['tool call with flat array', '{"name": "plan", "parameters": {"beats": ["History of the machines", "Pros and cons for shoppers", "Impact on retail jobs"]}}', 3],
  ["plain numbered list", "1. Open with the shopper experience\n2. Bring in the staffing costs\n3. Close on who benefits", 3],
  ["fenced json", '```json\n{"beats": ["First the hook about queues", "Then the economics", "Finally the human cost"]}\n```', 3],
  ["bare array", '["Open on the queue problem", "Move to the savings claim", "End on the job losses"]', 3],
  ["preamble then bullets", "Sure! Here is a plan:\n- Discuss the convenience argument\n- Examine the reliability complaints\n- Finish with the labour question", 3],
  ["garbage fragment", '"parameters": {"topic": "working from home", "num_points": 4}}', 0],
];

for (const [label, input, expected] of beatCases) {
  const beats = beatsFromText(input);
  check(`beats: ${label}`, beats.length === expected, `${beats.length} of ${expected}`);
}


/* ── Showrunner ──────────────────────────────────────────────────── */

console.log("\n─── showrunner ───\n");

const sheet = buildRunSheet(12, "debate");
check("run sheet has one beat per turn", sheet.length === 12, `${sheet.length}`);
check("run sheet opens with the intro", sheet[0].kind === "intro");
check("run sheet ends with the signoff", sheet[sheet.length - 1].kind === "signoff");
check("run sheet winds down before closing", sheet[sheet.length - 2].kind === "wind_down");
check(
  "no callback before there is anything to call back to",
  !sheet.slice(0, 4).some((b) => b.kind === "callback"),
);
check("the middle varies", new Set(sheet.slice(2, -2).map((b) => b.kind)).size > 1);
check("cold open style opens cold", buildRunSheet(6, "coldopen")[0].kind === "cold_open");
check("a two-turn show still resolves", buildRunSheet(2, "banter").length === 2);
check("a one-turn show does not crash", buildRunSheet(1, "debate").length === 1);

// Filler detection
const priorTurns = [
  { index: 0, hostId: "a" as const, speaker: "A", text: "That's a fair point, but I disagree." },
];
check("spots a repeated filler opening", repeatsOpening("That's a fair point, and also...", priorTurns) !== null);
check("allows a fresh opening", repeatsOpening("Three years ago I worked in one.", priorTurns) === null);
check("allows filler used only once", repeatsOpening("Absolutely, and here is why.", priorTurns) === null);
const patternedTurns = [
  ...priorTurns,
  { index: 1, hostId: "b" as const, speaker: "B", text: "I think there is room for a compromise." },
];
check(
  "spots an ordinary repeated three-word opening",
  repeatsOpening("I think there should be limits.", patternedTurns) === "i think there",
);
check("allows a different three-word opening", repeatsOpening("A waiter sees the cost first.", patternedTurns) === null);
check(
  "rotating to a different generic agreement is still caught later",
  repeatsOpening("That's exactly why the policy matters.", patternedTurns) === "that's exactly",
);
check("catches a host narrating the other host", reportsOtherInsteadOfReplying("Dee makes a great point about manners.", "Dee"));
check("allows a direct reply addressed by name", !reportsOtherInsteadOfReplying("Dee, that misses the cost to servers.", "Dee"));
const openingRecord = { title: "Reckoning", artist: "Ju Ju" };
check(
  "opening record title cannot become discussion material",
  reusesOpeningRecord("Reckoning would lose customers if it banned phones.", openingRecord, "phone-free dining") === "Reckoning",
);
check(
  "opening record artist cannot become discussion material",
  reusesOpeningRecord("Ju Ju should offer coloring sheets instead.", openingRecord, "phone-free dining") === "Ju Ju",
);
check(
  "a song named by the actual topic remains discussable",
  reusesOpeningRecord("Reckoning changes key in the bridge.", openingRecord, "the song Reckoning") === null,
);

check("recentOpenings summarises the last turns", recentOpenings(priorTurns)[0].startsWith("That's a fair"));

// Long shows: an opening repeats at a distance the old twelve-turn window forgot.
const longShow = Array.from({ length: 20 }, (_, i) => ({
  index: i,
  hostId: (i % 2 ? "b" : "a") as "a" | "b",
  speaker: i % 2 ? "B" : "A",
  text: i === 0 ? "Picture a waiter carrying four plates." : `Reason number ${i} is about the bill.`,
}));
check(
  "an opening from twenty turns back is still caught",
  repeatsOpening("Picture a waiter who dropped them all.", longShow) === "picture a waiter",
);
check("usedOpenings reaches back through the whole show", usedOpenings(longShow, 30).includes("picture a waiter"));
check("usedOpenings lists each opening once", new Set(usedOpenings(longShow)).size === usedOpenings(longShow).length);
check("usedOpenings is capped", usedOpenings(longShow, 5).length === 5);
check("usedOpenings puts the newest first", usedOpenings(longShow)[0] === "reason number 19");

// Memory rendering
const mem = {
  digest: "They argued about chores.",
  facts: ["the dishwasher is broken"],
  gags: ["the dog licking plates"],
  covered: ["whose turn it is"],
};
const block = memoryBlock(mem, "Alex");
check("memory block includes the digest", block.includes("They argued about chores"));
check("memory block includes facts", block.includes("dishwasher is broken"));
// Off a callback beat the gags are a list of things not to say again. Offering
// them as callback material on every turn is what made one joke run four times
// in a show.
check("running bits are held back by default", block.includes("must not say any of these again"));
check("and named to the host", block.includes("Alex"));
check(
  "a callback beat gets one, once",
  memoryBlock(mem, "Alex", true).includes("pick ONE"),
);
check("memory block lists what not to repeat", block.includes("do not repeat"));
check("empty memory renders as nothing", memoryBlock(EMPTY_MEMORY, "Alex") === "");

/* ── Ad breaks ───────────────────────────────────────────────── */

console.log("\n─── ad breaks ───\n");

const twelve = breakPositions(12, 1);
check("one break in a twelve-turn show", twelve.length === 1, JSON.stringify(twelve));
// Deliberately changed: the first break used to be held back to turn 2 or
// later, which is late for radio. It now lands after the opening exchange —
// one line each, then the break — which is how a real station is paced and
// which also buys a local model a head start it never recovers otherwise.
// What must still hold is that some dialogue happens first.
check("the break never comes before anyone has spoken", twelve.every((p) => p >= 1));
check("the break leaves room to come back and close", twelve.every((p) => p <= 12 - 3));

const twoBreaks = breakPositions(20, 2);
check("two breaks are spread apart", twoBreaks.length === 2 && twoBreaks[1] - twoBreaks[0] >= 2, JSON.stringify(twoBreaks));
check("a short show takes no breaks", breakPositions(4, 2).length === 0);
check("zero breaks means zero", breakPositions(20, 0).length === 0);

// The run sheet has to absorb a break without losing its ends.
const withBreak = buildRunSheet(12, "debate", breakPositions(12, 1));
check("a break still leaves one beat per turn", withBreak.length === 12);
check("a break does not displace the signoff", withBreak[withBreak.length - 1].kind === "signoff");
check("someone throws to the break", withBreak.some((b) => b.kind === "to_break"));
check("someone comes back from it", withBreak.some((b) => b.kind === "from_break"));
check(
  "coming back immediately follows throwing to it",
  withBreak.findIndex((b) => b.kind === "from_break") === withBreak.findIndex((b) => b.kind === "to_break") + 1,
);
check(
  "the break beat carries its index",
  withBreak.find((b) => b.kind === "to_break")?.breakIndex === 0,
);

// A break asked for in a show too short to hold one must be dropped, not forced.
const tooShort = buildRunSheet(5, "debate", [3]);
check("a break is refused when it would eat the close", !tooShort.some((b) => b.kind === "to_break"));

check(
  "a break describes what is in it",
  describeBreak({ index: 0, spots: [{ kind: "produced", sponsor: "Delroy's", lines: [] }] }).includes("Delroy's"),
);
check("an empty break still has a label", describeBreak({ index: 0, spots: [] }).length > 0);

// The ads folder is the only place a spot may come from.
check("a traversal path is refused", resolveAdFile("../../config.json") === null);
check("a non-audio file is refused", resolveAdFile("notes.txt") === null);
check("a missing file is refused", resolveAdFile("nothing-here.wav") === null);

/* ── Cold open ───────────────────────────────────────────────── */

const opener = coldOpenScript(
  { ...DEFAULT_CONFIG, show: { ...DEFAULT_CONFIG.show, station: "Night Owl FM" } },
  "the staged fight at the dance show",
);
check("the opener names the station", opener.includes("Night Owl FM"));
check("the opener names both hosts", opener.includes("Paul") && opener.includes("Rae"));
check("the opener names tonight's subject", opener.includes("staged fight"));
check("the opener sounds like station imaging", /meters|signal|background noise|record is armed|live microphones|lock the dial/i.test(opener));

/* ── The looping bed ─────────────────────────────────────────── */

const loop = makeLoopBed(6, "latenight", 42, 1.5);
check("the loop is exactly the length asked for", Math.abs(durationOf(loop) - 6) < 0.001, `${durationOf(loop)}s`);

// The join is what matters: the last sample must run into the first without a
// step, or the bed clicks once every pass.
const seam = Math.abs(loop.data[loop.data.length - 1] - loop.data[0]);
let biggestInternalStep = 0;
for (let i = 1; i < loop.data.length; i++) {
  biggestInternalStep = Math.max(biggestInternalStep, Math.abs(loop.data[i] - loop.data[i - 1]));
}
check(
  "the loop seam is no worse than the audio either side of it",
  seam <= biggestInternalStep,
  `seam ${seam.toFixed(5)} vs largest step ${biggestInternalStep.toFixed(5)}`,
);
check("a silent mood loops silently", makeLoopBed(3, "none", 1).data.every((v) => v === 0));

/* ── The band ────────────────────────────────────────────────── */

const rock = renderRock(8, { seed: 3, crashIn: true, button: true });
check("the band fills the requested time", Math.abs(durationOf(rock) - 8) < 0.02, `${durationOf(rock).toFixed(3)}s`);
check("the band's samples are all finite", allFinite(rock.data));
check("the band is not silent", peakOf(rock.data) > 0.2, `peak ${peakOf(rock.data).toFixed(3)}`);
check("the band stays inside full scale", peakOf(rock.data) <= 1, `peak ${peakOf(rock.data).toFixed(3)}`);

// The energy window is what lets an announcer sit on top of distorted guitars,
// so it has to be a real drop and not a token one.
const withHole = renderRock(12, { seed: 3, duckFrom: 4, duckTo: 8 });
const rms = (data: Float32Array, from: number, to: number) => {
  let sum = 0;
  let n = 0;
  for (let i = Math.round(from * 48000); i < Math.round(to * 48000) && i < data.length; i++) {
    sum += data[i] * data[i];
    n++;
  }
  return Math.sqrt(sum / Math.max(1, n));
};
const loudPart = rms(withHole.data, 0.5, 3.2);
const quietPart = rms(withHole.data, 4.6, 7.4);
check(
  "the band pulls back where a voice goes",
  quietPart < loudPart * 0.55,
  `${(20 * Math.log10(quietPart / loudPart)).toFixed(1)} dB down`,
);

// A rock bed loops by landing on a bar line, not by cross-fading, so the join
// must still be no worse than the transients inside it.
const rockLoop = makeLoopBed(9.8, "rock", 5);
let rockSeam = Math.abs(rockLoop.data[0] - rockLoop.data[rockLoop.data.length - 1]);
let rockStep = 0;
for (let i = 1; i < rockLoop.data.length; i++) {
  rockStep = Math.max(rockStep, Math.abs(rockLoop.data[i] - rockLoop.data[i - 1]));
}
check("the rock loop joins cleanly", rockSeam <= rockStep, `seam ${rockSeam.toFixed(5)} vs step ${rockStep.toFixed(5)}`);
check("rock is offered as a mood", MOODS.some((m) => m.id === "rock"));

/* ── Ad formats ──────────────────────────────────────────────── */

// The whole point of the format list: a sponsor booked four times in one show
// must get four different adverts.
const seenTonight = new Set<string>();
let rollingSeed = 1;
const nextRandom = () => {
  rollingSeed = (rollingSeed * 1103515245 + 12345) & 0x7fffffff;
  return rollingSeed / 0x7fffffff;
};
const tonight: string[] = [];
for (let i = 0; i < 6; i++) {
  const angle = chooseAngle([], seenTonight, nextRandom);
  seenTonight.add(angle.id);
  tonight.push(angle.id);
}
check("a sponsor never repeats a format in one show", new Set(tonight).size === tonight.length, tonight.join(", "));

// And must not open tomorrow with what it used tonight.
const usedLastNight = tonight.slice(0, 4);
const tomorrow = chooseAngle(usedLastNight, new Set(), nextRandom);
check("last night's formats are avoided", !usedLastNight.includes(tomorrow.id), tomorrow.id);

// Exhausting the list must still return something rather than nothing.
const everything = new Set(AD_ANGLES.map((a) => a.id));
check("running out of formats still yields one", Boolean(chooseAngle([], everything, nextRandom)?.id));
check("every format has direction and a length", AD_ANGLES.every((a) => a.brief.length > 30 && a.length > 0));

check("small print is optional", smallPrintFor(1, false) === undefined);
check("small print is there when asked for", (smallPrintFor(1, true) ?? "").length > 10);

/* ── Copy clean-up ───────────────────────────────────────────── */

const spoken = (copy: string, name = "Wommper1") =>
  toLines(copy, "announcer", 80, name)
    .map((l) => l.text)
    .join(" ");

check(
  "the model talking about its own job never reaches the air",
  !spoken("Your bridge, delivered. I will now write the function calls in JSON format.").includes("JSON"),
  spoken("Your bridge, delivered. I will now write the function calls in JSON format."),
);
check(
  "a shouted sentence comes back down",
  spoken("GET DOWN TO WOMMPER1 RIGHT NOW AND GET READY FOR IT! Our prices are the best.").startsWith("Get down"),
);
check(
  "the advertiser keeps its capital letter",
  spoken("GET DOWN TO WOMMPER1 RIGHT NOW AND GET READY FOR IT! Our prices are the best.").includes("Wommper1"),
);
check(
  "short emphasis is left alone",
  spoken("Come to Delroy's on Main Street. We fit them SAME DAY, no appointment.", "Delroy's").includes("SAME DAY"),
);
check(
  "a sentence cut off by the token limit is dropped",
  !spoken("Bootleg Spoon has bridges. Your bridge, delivered. And we're.").includes("And we're"),
);
check("a tool call is not copy", toLines('{"name": "advert", "parameters": {}}', "announcer", 80).length === 0);
check(
  "a sentence that ran out of tokens is cut back to its last finished clause",
  spoken("We have stuff for dogs, stuff for cats, and stuff for") === "We have stuff for dogs, stuff for cats.",
  spoken("We have stuff for dogs, stuff for cats, and stuff for"),
);
check(
  "a spot is never trimmed away to nothing",
  spoken("Wommper1 has all of the").length > 0,
  spoken("Wommper1 has all of the"),
);

/* ── Spoken-line clean-up ────────────────────────────────────── */

check(
  "a line that opens on a trail-off starts on a word",
  cleanLine("...and now I'm wondering, does the dog own the house? —", "Dee", "Marco").startsWith("and now"),
);
check(
  "a line that ends on a dash is closed off",
  !cleanLine("I've got a better argument here —", "Dee", "Marco").endsWith("—"),
);
check(
  "an em dash inside a line survives",
  cleanLine("He said — and I quote — that the dog pays rent.", "Dee", "Marco").includes("—"),
);

/* ── Echo and stray characters ───────────────────────────────── */

const said = [{ text: "Wommper's face keeps coming back to me, a rogue unwounded, carrying an oath." }];
check(
  "a line handed straight back is caught",
  echoesPrevious("I agree — Wommper's face keeps coming back to me, a rogue unwounded, and there it is.", said) !== null,
);
check(
  "a genuine reply is not caught",
  echoesPrevious("He swore it at the ford and I watched him do it. That is not the same as meaning it.", said) === null,
);
check("a short line cannot echo", echoesPrevious("Aye.", said) === null);
check("nothing to echo when nothing was said", echoesPrevious("Anything at all here", []) === null);

check(
  "a trailing backslash never reaches the air",
  !cleanLine("I keep coming back to Wommper's words, \\", "Dee", "Marco").includes("\\"),
);
check(
  "a line of pure punctuation is dropped",
  cleanLine("\\", "Dee", "Marco") === "",
);

/* ── Recall does not leak an old show's names ────────────────── */

const leaky = recallBlock([
  {
    showId: "x",
    showTitle: "Dishwasher",
    date: "2026-09-09",
    speaker: "Alex & Lacey",
    score: 1,
    text: "Alex: Welcome to Wommper1, folks. Tonight we are arguing about who loads the dishwasher, and Lacey has been doing it wrong for years.",
  },
]);
check("recall drops the old station's welcome", !leaky.includes("Welcome to Wommper1"), leaky.slice(-100));
check("recall keeps the subject matter", leaky.includes("dishwasher"));
check("recall says these are notes, not lines", leaky.includes("notes, not lines"));


/* ── The phone book ──────────────────────────────────────────── */

check("an unknown caller is unknown", findCaller("Nobody Who Has Ever Rung") === null);
check("an empty book briefs nothing", typeof callerBriefing() === "string");
check("the opening of a spot is short", openingOf("One two three four five six seven eight nine").split(" ").length === 7);

/* ── Running bits between shows ──────────────────────────────── */

// A court and the station must never share a lane: a joke about self-checkout
// has no business in a king's hall, and a grudge from the Wildlands none on
// drive-time.
const stationLane = laneFor("Test Station");
const courtLane = laneFor("Test Station", "King Orion");
check("the station and a court are separate lanes", stationLane !== courtLane);

forgetRunning(stationLane);
forgetRunning(courtLane);

check("an empty lane briefs nothing", runningBriefing(stationLane) === "");

rememberRunning(stationLane, { gags: ["the three-seater sofa story"], facts: ["Marco owns a dog called Max"] });
rememberRunning(stationLane, { gags: ["the three-seater sofa story", "Dee will not say the word"], facts: [] });
rememberRunning(courtLane, { gags: ["the King calls them the roadkill"], facts: [] });

const lane = getRunning(stationLane);
check("two shows are counted", lane.shows === 2, String(lane.shows));
check("a repeated gag is kept once", lane.gags.filter((g) => g.includes("three-seater")).length === 1);
check("a repeated gag moves to the end", lane.gags[lane.gags.length - 1].includes("will not say"));
check("the court did not inherit the station's bits", !getRunning(courtLane).gags.some((g) => g.includes("sofa")));

const stationBrief = runningBriefing(stationLane);
check("the station is told what is running", stationBrief.includes("STILL RUNNING"));
check("the briefing warns against working through them", stationBrief.includes("one landed callback"));
check("a court's briefing defers to the chronicle", runningBriefing(courtLane, true).includes("the record is right"));

// A bare word is a noun, not a running gag.
forgetRunning(stationLane);
rememberRunning(stationLane, { gags: ["sofa"], facts: [] });
check("a single word is not a running gag", getRunning(stationLane).gags.length === 0);

forgetRunning(stationLane);
forgetRunning(courtLane);

/* ── Reworded echoes ─────────────────────────────────────────── */

// The real failure: a hand-back with three words changed, which no run of six
// matches. Both of these came off actual courts.
const ghosts = [{ text: "They walk among us as if they are already ghosts, unkillable. How long before you tire of this?" }];
check(
  "a reworded hand-back is caught",
  echoesPrevious("They walk among us as ghosts, unkillable, and I'll believe he tires when he stops.", ghosts) !== null,
  String(echoesPrevious("They walk among us as ghosts, unkillable, and I'll believe he tires when he stops.", ghosts)),
);
check(
  "a real reply is not caught",
  echoesPrevious("Then we starve the road until nobody will carry for him. Two winters should do it.", ghosts) === null,
);
check(
  "answering with one shared word is fine",
  echoesPrevious("Ghosts do not pay tolls. Living men do, and that is where I will have him.", ghosts) === null,
  String(echoesPrevious("Ghosts do not pay tolls. Living men do, and that is where I will have him.", ghosts)),
);

/* ── Break placement at every length ─────────────────────────── */

// Every break costs two turns — one to throw to it, one to come back. Two
// landing next to each other used to overwrite one another silently: the
// second throw took the first's return, and a whole break vanished with no
// error. Moving the first break earlier made it far more likely, so this
// sweeps every length rather than spot-checking.
let malformed = 0;
for (let turns = 1; turns <= 60; turns++) {
  for (const breaks of [1, 2, 4, 12]) {
    const positions = breakPositions(turns, breaks);
    const sheet = buildRunSheet(turns, "deepdive", positions);

    if (sheet.length !== turns) malformed++;
    if (positions.some((p) => p < 1 || p + 1 > turns - 2)) malformed++;
    if (new Set(positions).size !== positions.length) malformed++;

    for (const at of positions) {
      if (sheet[at]?.kind !== "to_break" || sheet[at + 1]?.kind !== "from_break") malformed++;
    }
  }
}
check("breaks are well-formed at every show length", malformed === 0, `${malformed} malformed`);
check("the first break comes early", (breakPositions(12, 2)[0] ?? 99) <= 2, JSON.stringify(breakPositions(12, 2)));
check("a short show takes no break", breakPositions(2, 4).length === 0);
check(
  "adjacent breaks never both land",
  buildRunSheet(10, "deepdive", [3, 4]).filter((b) => b.kind === "to_break").length === 1,
);

/* ── Similes ─────────────────────────────────────────────────── */

check("one figure of speech is allowed", leansOnSimile("He came at us like a dog off a chain.").length === 0);
check(
  "a line of nothing but comparison is caught",
  leansOnSimile("They spread like a plague, just as the tide comes in, as if winter had come early.").length > 0,
);
check("plain speech is never caught", leansOnSimile("Greyditch is empty. Forty men did not come back.").length === 0);

/* ── Who is allowed to speak at court ─────────────────────────── */

// The Guild chiming in is a feature, not a fact of the format, and it has to
// be switchable without touching memory.
check("the Guild speaks by default", DEFAULT_CONFIG.orion.guildVoices === true);
check(
  "and can be switched off",
  normalizeConfig({ orion: { guildVoices: false } }).orion.guildVoices === false,
);
check(
  "switching it off changes nothing about the record",
  normalizeConfig({ orion: { guildVoices: false } }).orion.writeBack === DEFAULT_CONFIG.orion.writeBack,
);
check(
  "rubbish is ignored rather than read as off",
  normalizeConfig({ orion: { guildVoices: "no" } }).orion.guildVoices === DEFAULT_CONFIG.orion.guildVoices,
);

/* ── The commercial bucket ────────────────────────────────────── */

// The bucket is a collection, not a cache. The ad library trims itself once it
// passes 120 spots, which is right for a rotation and exactly wrong for
// something you are keeping, so these pin the difference.
const bucket = listBucket();
const bucketNumbers = bucketStats();

check("the bucket reads whether or not anything is in it", Array.isArray(bucket));
check("the count matches what is actually there", bucketNumbers.total === bucket.length);
check(
  "every spot says where it came from",
  bucket.every((s) => ["station", "realm", "multiverse"].includes(s.source)),
);
check("nothing in the bucket has an empty id", bucket.every((s) => Boolean(s.id)));

// There must be no cap anywhere. A number that trims the bucket is the one
// thing that would quietly lose work.
// Code only. The first version of this read the comments too and tripped on
// the docstring that says "no cap, no trim, no eviction" — the sentence
// promising the very thing it was checking for.
const bucketSource = fs
  .readFileSync("server/pipeline/bucket.ts", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/.*/g, " ");
check(
  "the bucket has no size cap",
  // A cap looks like a MAX constant, a slice to a fixed length, or a function
  // whose whole job is trimming. An earlier version of this also matched
  // "trim(" — which caught String.trim() on a field and made the check cry
  // wolf at itself the moment the bucket learned to correct a spot's copy.
  !/MAX_SPOTS|MAX_BUCKET|\bcap\b|\.slice\(0,\s*\d{2,}\)|function \w*[Tt]rim/.test(bucketSource),
);
check("and no way to empty it in one go", !/clearBucket|emptyBucket|forgetAll/.test(bucketSource));
check("a starred spot refuses to be deleted", bucketSource.includes("spot.keep"));

// A court must never be sold a tyre barn, and the station must never be sold
// a reanimation service.
const courtPicks = pickForShow(4, "court");
const stationPicks = pickForShow(4, "station");
check("a court is only offered realm and multiverse spots", courtPicks.every((s) => s.source !== "station"));
check("the station is only offered its own and multiverse spots", stationPicks.every((s) => s.source !== "realm"));
check("asking for none returns none", pickForShow(0, "court").length === 0);

const groupedCommercials = groupCommercialBreaks(
  Array.from({ length: 12 }, (_, index) => ({ id: `spot-${index}` })),
  4,
  3,
);
check("bucket scheduling fills every configured break", groupedCommercials.length === 4);
check("bucket scheduling honors spots per break", groupedCommercials.every((group) => group.length === 3));
check(
  "bucket scheduling neither drops nor duplicates spots",
  new Set(groupedCommercials.flat().map((spot) => spot.id)).size === 12,
);
check("browser show ids are accepted", isSafeJobId("job-mu123abc"));
check("show ids cannot escape the live folder", !isSafeJobId("../outside"));
check("show ids cannot contain path separators", !isSafeJobId("job/live"));
check("duplicate running jobs are rejected", jobIdProblem("job-live", new Set(["job-live"]))?.includes("already running") === true);
check(
  "transcript-only shows skip model warm-up",
  !shouldWarmUpShow({ speakLive: false, hasOpeningAudio: true, hasOpeningSong: true }),
);
check(
  "uncovered live shows skip model warm-up",
  !shouldWarmUpShow({ speakLive: true, hasOpeningAudio: false, hasOpeningSong: false }),
);
check(
  "a playable opener permits model warm-up",
  shouldWarmUpShow({ speakLive: true, hasOpeningAudio: true, hasOpeningSong: false }),
);
check("a loaded model passes preflight", missingModels(["radio-8b"], ["radio-8b"]).length === 0);
check(
  "a stale model is named by preflight",
  missingModels(["old-radio-model"], ["current-radio-model"]).join(",") === "old-radio-model",
);
check(
  "model preflight covers host overrides without duplicate warnings",
  missingModels(["main", "guest", "guest"], ["main"]).join(",") === "guest",
);
check("ordinary shows retain stereo", mixPolicy(LOW_MEMORY_MIX_SECONDS, true).stereo);
check("long shows enter bounded mono mode", !mixPolicy(LOW_MEMORY_MIX_SECONDS + 1, true).stereo);
check("long-show mode skips the full procedural bed", !mixPolicy(LOW_MEMORY_MIX_SECONDS + 1, true).proceduralBed);
check("unsafe mix durations are rejected before allocation", !mixPolicy(MAX_MIX_SECONDS + 1, false).allowed);
const accountingRows = [{ id: "aired", plays: 2, lastPlayed: "" }, { id: "unused", plays: 4, lastPlayed: "old" }];
check("completed spots advance play accounting", advancePlayedRecords(accountingRows, new Set(["aired"]), "now"));
check("only completed spots advance", accountingRows[0].plays === 3 && accountingRows[1].plays === 4);
const fastProfile = applyPerformanceProfile(DEFAULT_CONFIG, "fast");
check("Fast Live removes blocking planning calls", !fastProfile.show.useProducer && !fastProfile.show.useOutline && !fastProfile.show.generateNotes);
check("Fast Live disables model warm-up", !fastProfile.show.warmUpModel);
const producedProfile = applyPerformanceProfile(DEFAULT_CONFIG, "produced");
check("Produced enables the full planning chain", producedProfile.show.useProducer && producedProfile.show.useOutline && producedProfile.show.generateNotes);
const roleModels = normalizeConfig({ llm: { model: "performer", producerModel: "planner", notesModel: "tiny", commercialModel: "copywriter" } });
check("performer model remains explicit", roleModels.llm.model === "performer");
check("producer model remains explicit", roleModels.llm.producerModel === "planner");
check("notes model remains explicit", roleModels.llm.notesModel === "tiny");
check("commercial model remains explicit", roleModels.llm.commercialModel === "copywriter");
const rotationRules = normalizeConfig({ ads: { minReplayHours: 48, separateSponsors: false, sourceWeights: { station: 2, realm: 0.5, multiverse: 3 } } });
check("commercial replay spacing is normalized", rotationRules.ads.minReplayHours === 48);
check("commercial sponsor separation can be disabled", rotationRules.ads.separateSponsors === false);
check("commercial source weights are preserved", rotationRules.ads.sourceWeights.multiverse === 3);

const activeCommercialBrain = activeBrainVersion().id;
const currentBrainPicks = [
  ...pickForShow(20, "court", activeCommercialBrain),
  ...pickForShow(20, "station", activeCommercialBrain),
];
check(
  "automatic rotation only uses the active commercial brain",
  currentBrainPicks.every((s) => s.brainVersion === activeCommercialBrain),
);
check("automatic rotation rejects silent renders", currentBrainPicks.every((s) => s.seconds >= 2));
check(
  "legacy bucket count matches preserved old brains",
  bucketStats(activeCommercialBrain).legacy === bucket.filter((s) => s.brainVersion !== activeCommercialBrain).length,
);

const reusableAds = pickForReuse(200, []);
check(
  "the repeat shelf only offers current-format adverts",
  reusableAds.every((s) => s.formatVersion === CURRENT_AD_LIBRARY_FORMAT),
);
check("old shows cannot seed upgraded DJ recall", !isRecallEligible({}));
check("current shows can seed upgraded DJ recall", isRecallEligible({ generationVersion: CURRENT_SHOW_FORMAT }));

const multiverseBrief = briefFor(normalizeConfig({ ads: { sponsors: [] } }), 0);
check("multiverse spots use the wacker commercial brain", multiverseBrief.prompt.includes("THE WACKER MULTIVERSE COMMERCIAL BRAIN"));
check("multiverse spots get a hard left turn", multiverseBrief.prompt.includes("hard left turn"));
check("multiverse spots stay out of borrowed character names", multiverseBrief.prompt.includes("existing TV characters"));
check("multiverse prompts do not receive Orion's cast", !multiverseBrief.prompt.includes("Real people in this world"));
check(
  "generic infomercial copy is rejected before broadcast",
  Boolean(commercialCopyIssue("Listen up. Are you tired of this? Our state-of-the-art product is here. So why wait?")),
);
check(
  "one ordinary sales phrase does not reject otherwise usable copy",
  commercialCopyIssue("Form Seven Portals. Act now, before the loading bay remembers your childhood.") === "",
);
check(
  "multiverse copy needs more than a dimension and a coupon",
  Boolean(commercialCopyIssue("Bistro Dimension. Present this coupon at the counter for breakfast.", "multiverse")),
);
check(
  "broken commercial logic passes the multiverse editor",
  commercialCopyIssue(
    "Form Seven Portals. Bring the receipt to the loading bay unless the refund desk remembers you first.",
    "multiverse",
  ) === "",
);
check("a preferred realm source gets a realm brief", briefFor(normalizeConfig({ ads: { sponsors: [] } }), 0, "realm").source === "realm");
check(
  "a preferred station source falls back when no sponsor exists",
  briefFor(normalizeConfig({ ads: { sponsors: [] } }), 0, "station").source !== "station",
);
check(
  "a preferred station source is honoured when a sponsor exists",
  briefFor(
    normalizeConfig({
      ads: {
        sponsors: [
          {
            id: "sponsor-test",
            name: "Test Sponsor",
            product: "a thing",
            talkingPoints: "",
            tagline: "",
            style: "",
            audioFile: "",
            enabled: true,
          },
        ],
      },
    }),
    0,
    "station",
  ).source === "station",
);

/* ── The shelved opening ──────────────────────────────────────── */

// The answer to a seven-minute wait before anything made a sound: the opener
// and the first commercial are rendered days in advance, so pressing Start
// copies two files instead of starting four round trips.
const shelf = listPrerolls();
check("the shelf reads without a pack on it", Array.isArray(shelf));
check("an empty shelf offers nothing rather than failing", shelf.length > 0 || currentPreroll() === null);
check("legacy imaging cannot front a different station", currentPreroll("Station That Does Not Exist") === null);
check("a pack fronts more than one show", SHOWS_PER_PACK >= 2);
check("but not so many that the joke wears out", SHOWS_PER_PACK <= 6);

for (const pack of shelf) {
  check(`"${pack.id}" has both halves`, Boolean(pack.openFile && pack.adFile));
  check(`"${pack.id}" open is short enough to be an open`, pack.openSeconds > 2 && pack.openSeconds < 30, `${pack.openSeconds}s`);
  check(`"${pack.id}" commercial is about a minute`, pack.adSeconds > 25 && pack.adSeconds < 95, `${pack.adSeconds}s`);
  check(`"${pack.id}" never says the word assistant first`, !/^\s*assistant/i.test(pack.openText) && !/^\s*assistant/i.test(pack.adText));
}

/* ── Petitioners ─────────────────────────────────────────────── */

const rider = (name: string, deaths = 0, kills = 0, turns = 1) => ({
  name,
  deaths,
  kills,
  turns,
  fallen: false,
});

// The roster the game actually keeps is a Discord party, so the player sits in
// it under his own handle. He is the enemy, not one of the King's petitioners,
// and everything below exists because the first live read of the real save
// brought Wommper into the hall as an anonymous rider who follows himself.
const riders = [rider("Wommper1", 2, 1, 6), rider("Ashra")];

check("an empty guild yields no petitioner", choosePetitioner([], 7) === null);
check("a nameless rider is not brought forward", choosePetitioner([rider("")], 1) === null);
check("the same seed brings the same rider", choosePetitioner(riders, 3)?.name === choosePetitioner(riders, 3)?.name);
check("a rider keeps one voice across courts", voiceForMember(riders[0], "edge") === voiceForMember(riders[0], "edge"));
check("two riders do not share a voice", voiceForMember(riders[0], "edge") !== voiceForMember(riders[1], "edge"));
check("an unknown speech engine still yields a voice", voiceForMember(riders[0], "nonsense").length > 0);

check("the player's handle is read as Wommper himself", isWommper("Wommper1") && isWommper("wommper") && isWommper("Wommper12"));
check("somebody else is not", !isWommper("Ashra") && !isWommper("Wommperson") && !isWommper(""));

check(
  "Wommper is never sent forward while there is a rider to send",
  Array.from({ length: 40 }, (_, i) => choosePetitioner(riders, i)?.name).every((n) => n === "Ashra"),
);

const alone = [rider("Wommper1", 0, 0, 6)];
const nights = Array.from({ length: 60 }, (_, i) => choosePetitioner(alone, i)?.name ?? null);
const appearances = nights.filter((n) => n !== null).length;
check(
  "with nobody else to send, most nights have no petitioner at all",
  appearances > 0 && appearances < nights.length / 2,
  `${appearances} of ${nights.length} nights`,
);
check("and when he does come it is him", nights.find((n) => n !== null) === "Wommper1");
check(
  "he sounds the same every time, and not like a stranger",
  voiceForMember(alone[0], "edge") === voiceForMember(riders[0], "edge") &&
    voiceForMember(alone[0], "edge") !== voiceForMember(riders[1], "edge"),
);

/* ── Who holds the floor ─────────────────────────────────────── */

check(
  "the King leads without reducing Maeve to a prompt",
  DEFAULT_CONFIG.orion.king.maxWords > DEFAULT_CONFIG.orion.chronicler.maxWords &&
    DEFAULT_CONFIG.orion.chronicler.maxWords >= 40,
  `${DEFAULT_CONFIG.orion.king.maxWords} vs ${DEFAULT_CONFIG.orion.chronicler.maxWords}`,
);
const lengths = normalizeConfig({ orion: { king: { maxWords: 999 }, chronicler: { maxWords: 0 } } });
check("turn lengths are clamped", lengths.orion.king.maxWords === 200 && lengths.orion.chronicler.maxWords === 10);

/* ── Speaker confusion ───────────────────────────────────────── */

// The real failure, from a real court: Maeve said "It's not a game, Maeve."
check(
  "a speaker talking to itself is caught",
  addressesSelf("The charade haunts me still. It's not a game, Maeve. This is war.", "Maeve"),
);
check(
  "a speaker addressing the other is fine",
  !addressesSelf("It's not a game, Marco. This is war.", "Maeve"),
);
// A DJ saying their own name is normal radio and must not be caught.
check("saying your own name is allowed", !addressesSelf("Marco here, and we are back.", "Marco"));
check("naming yourself in passing is allowed", !addressesSelf("They still call me Marco on that road.", "Marco"));
check("an opening vocative is caught", addressesSelf("Maeve, you are not listening.", "Maeve"));

/* ── Repetition guards ───────────────────────────────────────── */

// A model can loop on one image forever by alternating singular and plural.
const spectral = [
  { index: 0, hostId: "a" as const, speaker: "K", text: "Their ability to return from death like specters is a challenge." },
  { index: 1, hostId: "b" as const, speaker: "M", text: "He rises again like a specter from the dead." },
  { index: 2, hostId: "a" as const, speaker: "K", text: "I watch him rise like a specter every time." },
];
check(
  "a plural does not hide a repeated image",
  repeatsImage("Another specter walking out of the ashes again.", spectral, "the guild", ["K", "M"]) !== null,
  String(repeatsImage("Another specter walking out of the ashes again.", spectral, "the guild", ["K", "M"])),
);
check(
  "a word from the topic is still exempt",
  repeatsImage("The specters of the guild.", spectral, "specters and the guild", ["K", "M"]) === null,
);

/* ── King Orion's Realm ──────────────────────────────────────── */

// The realm is somebody else's project and may not be on this machine at all,
// so everything that needs it is skipped rather than failed. What is checked
// unconditionally is the behaviour that protects it.

check("a wrong realm path resolves to nothing", resolveRealm("Z:/no/such/realm") === null);
check("a realm path pointing at a file is refused", resolveRealm("Z:/no/such/realm/world.db") === null);

const absent = readRealm("Z:/no/such/realm");
check("a missing realm says so", absent.problems.length > 0 && absent.root === "");
check("a missing realm briefs nothing", realmBriefing(absent) === "");
check("a missing realm summarises safely", realmSummary(absent) === "Not found");
check("a missing realm has an empty guild", Array.isArray(absent.guild) && absent.guild.length === 0);

const parsedCommand = parseWorldCommand({
  id: "selftest-command-001",
  actorId: "player-1",
  type: "travel",
  expectedRevision: 4,
  payload: { destination: "Brindlemark" },
});
check("world commands retain optimistic revisions", parsedCommand.expectedRevision === 4);
check("world commands retain structured payloads", parsedCommand.payload.destination === "Brindlemark");
let rejectedUnknownCommand = false;
try {
  parseWorldCommand({
    id: "selftest-command-002",
    actorId: "player-1",
    type: "rewrite_history",
    expectedRevision: 4,
  });
} catch (error) {
  rejectedUnknownCommand = error instanceof WorldCommandError && error.code === "invalid_command";
}
check("unknown world commands are rejected before the engine", rejectedUnknownCommand);

// Writing is the dangerous direction, so it must refuse rather than improvise.
const refused = recordTales("Z:/no/such/realm", [
  { type: "court", description: "must never be written", participants: [], location: "", importance: 5 },
]);
check("writing to a missing realm refuses", refused.written === 0 && Boolean(refused.error));
check("writing an empty list is a no-op", recordTales("Z:/no/such/realm", []).written === 0);
check("forgetting an empty list is a no-op", forgetTales("Z:/no/such/realm", []).written === 0);

// A whole show's chronicle is written as one transaction, so a single ragged
// tale used to throw on `tale.type.trim()`, roll the batch back, and lose the
// lot. Only the description is genuinely required now.
const ragged = recordTales("Z:/no/such/realm", [
  { description: "words and nothing else" },
] as Parameters<typeof recordTales>[1]);
check("a tale needs nothing but its words", Boolean(ragged.error) && !ragged.error?.includes("trim"));

const contractRoot = fs.mkdtempSync(path.join(process.cwd(), ".realm-contract-"));
try {
  const contractDb = new DatabaseSync(path.join(contractRoot, "world.db"));
  contractDb.exec(`
    CREATE TABLE realm_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO realm_meta VALUES ('current_campaign_id', 'campaign-test');
    CREATE TABLE discord_runtime (
      campaign_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, roster_json TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, participants TEXT,
      description TEXT, location TEXT, importance INTEGER, timestamp TEXT,
      is_embedded INTEGER, campaign_id TEXT, source TEXT, canonical INTEGER, message_id TEXT
    );
    CREATE TABLE claims (
      claim_id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT, source TEXT,
      claim_type TEXT, participants TEXT, description TEXT, location TEXT,
      confidence REAL, status TEXT, timestamp TEXT
    );
    CREATE TABLE quests (quest_id TEXT, name TEXT, description TEXT, status TEXT, location TEXT, campaign_id TEXT);
    CREATE TABLE npcs (npc_id TEXT, name TEXT, location TEXT, status TEXT, disposition TEXT);
    CREATE TABLE locations (location_id TEXT, name TEXT, description TEXT);
  `);
  const state = JSON.stringify({ total_turns: 12, world_journal: "At Brindlemark.", location: "Brindlemark" });
  const roster = JSON.stringify({
    "42": {
      name: "Ashra", deaths: 1, kills: 3, turns_taken: 12, is_fallen: false,
      stats: { player_class: "mage", level: 4, xp: 9, current_hp: 21, max_hp: 25, gold: 18, inventory: ["Wand"], location: "Brindlemark" },
    },
  });
  contractDb.prepare("INSERT INTO discord_runtime VALUES (?, ?, ?, 1, ?)").run("campaign-test", state, roster, new Date().toISOString());
  contractDb.prepare(
    "INSERT INTO events(event_type,participants,description,location,importance,timestamp,is_embedded,campaign_id,source,canonical,message_id) VALUES('travel','[\"Ashra\"]','Ashra reached Brindlemark.','Brindlemark',4,'now',0,'campaign-test','discord',1,'m1')",
  ).run();
  contractDb.close();

  const connected = readRealm(contractRoot);
  check("radio prefers the atomic Discord campaign snapshot", connected.stateSource === "discord");
  check("radio reads per-player Discord mechanics", connected.guild[0]?.level === 4 && connected.guild[0]?.currentHp === 21);
  check("radio filters the active campaign chronicle", connected.events.length === 1 && connected.events[0]?.type === "travel");
  const snapshot = createWorldSnapshot(connected);
  check("the engine contract is explicitly versioned", snapshot.contract === WORLD_CONTRACT);
  check("the engine contract carries the campaign revision", snapshot.campaign.revision === 1);
  check("the engine contract marks deeds canonical", snapshot.events[0]?.canonical === true);
  check("the engine contract does not expose the realm's filesystem path", !JSON.stringify(snapshot).includes(contractRoot));

  const claim = recordTales(contractRoot, [{ type: "court", description: "Orion promised a bridge." }]);
  const afterClaim = readRealm(contractRoot);
  check("a broadcast enters the claims ledger", claim.written === 1 && afterClaim.claims.length === 1);
  check("a broadcast does not become a canonical deed", afterClaim.events.length === 1);
  check("the engine contract marks radio claims non-canonical", createWorldSnapshot(afterClaim).claims[0]?.canonical === false);
  const forgotten = forgetTales(contractRoot, claim.ids);
  check("a radio claim can be removed without derived canon", forgotten.written === 1 && readRealm(contractRoot).claims.length === 0);
} finally {
  fs.rmSync(contractRoot, { recursive: true, force: true });
}

// The briefing's framing is load-bearing: written the other way round the King
// reads his own enemy's victories as his own achievements.
const pretend = {
  ...absent,
  root: "Z:/pretend",
  save: {
    level: 3, xp: 0, maxHp: 20, currentHp: 12, playerClass: "rogue", inventory: ["a knife"],
    gold: 40, equippedWeapon: null, equippedArmor: null, knownSpells: [],
    journal: "At the edge of the Wildlands.", contacts: "", turnCount: 9, inCombat: false,
  },
  guild: [{ name: "Wommper1", deaths: 2, kills: 1, turns: 6, fallen: false }],
  events: [
    {
      id: 1,
      type: "battle",
      description: "Wommper burned the camp at Greyditch.",
      participants: ["Wommper"],
      location: "Greyditch",
      importance: 7,
      timestamp: "2026-09-10T00:00:00+00:00",
      source: "game",
    },
  ],
};

const briefed = realmBriefing(pretend, "Orion took this realm by force.");
const commercialPulse = realmCommercialPulse(pretend);
check("the briefing puts the history first", briefed.startsWith("HOW THIS REALM CAME TO BE"));
check("the briefing names Wommper the enemy", /Not your champion/.test(briefed));
check(
  "the briefing names the Respawn Guild",
  briefed.toLowerCase().includes(GUILD_NAME.toLowerCase()),
);
check("the briefing counts the Guild's deaths", /died 2 times/.test(briefed));
check("the briefing carries the chronicle", briefed.includes("Greyditch"));
check("the briefing forbids invented names", /NAMES ARE THE HARD RULE/.test(briefed));
check("the briefing forbids invented deeds", /may NOT invent a deed/.test(briefed));
const royalIndex = royalMemoryIndex(pretend);
check("the royal memory index repeats exact places", royalIndex.includes("Greyditch"));
check("the royal memory index repeats exact people", royalIndex.includes("Wommper1"));
check("the royal memory index protects the evidence hierarchy", /recorded, what you infer, and what you plan/.test(royalIndex));
check("the commercial pulse carries Wommper's current state", commercialPulse.includes("level 3"));
check("the commercial pulse carries the Guild's ledger", commercialPulse.includes("2 recorded deaths"));
check("the commercial pulse carries recent deeds", commercialPulse.includes("Greyditch"));
// Found in a live court: the realm briefing told everyone who read it that the
// realm was theirs, so the chronicler answered a rider's petition as the King
// -- "my rule", "you think fire can fell me". Ownership is persona now.
check(
  "the shared briefing no longer hands the realm to whoever reads it",
  !realmBriefing(pretend).toLowerCase().includes("this realm is yours"),
);

check("no history still briefs", realmBriefing(pretend).includes("THE REALM AS IT ACTUALLY STANDS"));

/* ── Night Court brain ───────────────────────────────────────── */

check("Night Court school contains twenty exchanges", ORION_EXAMPLES.length === 20, String(ORION_EXAMPLES.length));
check(
  "the court selects an exact Brindlemark lesson",
  selectOrionExamples("What happened in Brindlemark?", `${briefed}\nBlackwood\nLyra Moonwhisper`)[0]?.topic.includes("Brindlemark") === true,
);
const courtTarget = evaluateOrionTranscript(
  ORION_EXAMPLES[11].topic,
  [
    { index: 0, hostId: "a", speaker: "King Orion", text: ORION_EXAMPLES[11].king },
    { index: 1, hostId: "b", speaker: "Maeve", text: ORION_EXAMPLES[11].chronicler },
  ],
  pretend,
);
check("curated court exchange demonstrates intelligence", courtTarget.intelligence >= 45, String(courtTarget.intelligence));
check("curated court exchange demonstrates radio craft", courtTarget.radioCraft >= 30, String(courtTarget.radioCraft));
const inventedCourt = evaluateOrionTranscript(
  "What happened in Greyditch?",
  [
    {
      index: 0,
      hostId: "a",
      speaker: "King Orion",
      text: "I remember the Greyditch rebellion two winters ago. I crushed the uprising and reclaimed its granaries.",
    },
    { index: 1, hostId: "b", speaker: "Maeve", text: "But the record says only that Wommper burned a camp there." },
  ],
  pretend,
);
check("invented court history is scored as a canon failure", inventedCourt.canonGrounding < 50, String(inventedCourt.canonGrounding));
const knownPersonIsNotAPlace = evaluateOrionTranscript(
  "Wommper's next move",
  [{ index: 0, hostId: "a", speaker: "King Orion", text: "The warning came from Wommper, and the road remains watched." }],
  pretend,
);
check(
  "a known person after a preposition is not scored as an invented place",
  !knownPersonIsNotAPlace.notes.some((note) => note.includes("Unrecorded place names")),
);
check(
  "a secret family tie absent from the record is caught",
  unsupportedCourtClaim("Blackwood fathered Lyra's child.", briefed)?.includes("fathered") === true,
);
check(
  "a relationship stated in the record remains usable",
  unsupportedCourtClaim("Lyra may have been Blackwood's lover.", briefed) === null,
);
check(
  "ordinary words containing a guarded syllable are not false positives",
  unsupportedCourtClaim("One person should answer the question.", briefed) === null,
);
const royalTraining = orionTrainingReadiness();
check("royal training has forty curated rows", orionTrainingRows().length >= 40, String(orionTrainingRows().length));
check("royal training keeps court feedback separate", royalTraining.curatedExchanges === 20 && royalTraining.minimumKeeperTarget === 500);

/* ── Regular DJ station brain ─────────────────────────────────── */

const conversationSource = fs.readFileSync("server/pipeline/conversation.ts", "utf8");
const configSource = fs.readFileSync("server/config.ts", "utf8");
const showrunnerSource = fs.readFileSync("server/pipeline/showrunner.ts", "utf8");

check("regular DJs have a station reality bible", conversationSource.includes("THE STATION REALITY"));
check("regular DJs put the topic first", conversationSource.includes("TOPIC FIRST, DAMAGED UNIVERSE SECOND"));
check("regular DJs have an explicit weirdness budget", conversationSource.includes("four turns out of five"));
check("bureaucracy fallback is banned", conversationSource.includes("Permits, zoning, councils"));
check("regular DJs do not borrow existing TV characters", conversationSource.includes("Do not name or imitate any existing TV characters"));
check("regular DJs are told not to explain the multiverse", conversationSource.includes("Never explain the multiverse"));
check("Night Court is explicitly a broadcast", conversationSource.includes("HOW TO BROADCAST THE NIGHT COURT"));
check("Night Court has an intelligence discipline", conversationSource.includes("THE INTELLIGENCE JOB"));
check("Night Court has controlled menace rules", conversationSource.includes("THE MENACE JOB"));
check("the obsolete no-radio court rule is gone", !conversationSource.includes("You are not on the radio"));
check("court story beats cannot invent precedent", conversationSource.includes("A known place is not a memory"));
check("Orion is required to turn analysis into a ruling", conversationSource.includes("A question alone is not a ruling"));
check("corrected court drafts pass a final canon gate", conversationSource.includes("Give the final draft its own gate"));
check("Orion remembers a substantial realm history", DEFAULT_CONFIG.orion.recallEvents >= 60, String(DEFAULT_CONFIG.orion.recallEvents));
check("Orion's default temperature favors continuity", DEFAULT_CONFIG.orion.temperature <= 0.9, String(DEFAULT_CONFIG.orion.temperature));
check("Paul's default role holds the format together", configSource.includes("Keeps the format together"));
check("Rae's default role tests assumptions", configSource.includes("spots the hidden assumption"));
check("run-sheet beats demand topic substance", showrunnerSource.includes("Name the principle, mechanism, evidence, or tradeoff"));
check("trolley zoning is detected as drift", fallsIntoBureaucracy("The trolley needs a zoning permit.", "the trolley problem"));
check("real zoning topics are exempt", !fallsIntoBureaucracy("The council changed zoning.", "whether zoning reform lowers rents"));
check("DJ school contains twenty exchanges", DJ_EXAMPLES.length === 20, String(DJ_EXAMPLES.length));
check("DJ evaluation contains twenty topics", DJ_EVAL_TOPICS.length === 20, String(DJ_EVAL_TOPICS.length));
check("trolley examples are selected for trolley topics", selectDjExamples("the trolley problem")[0]?.topic === "The trolley problem");
const trolleyScore = evaluateDjTranscript(DJ_EVAL_TOPICS[0], [
  { index: 0, hostId: "a", speaker: "Alex", text: DJ_EXAMPLES[0].hostA },
  { index: 1, hostId: "b", speaker: "Wren", text: DJ_EXAMPLES[0].hostB },
]);
check("curated trolley exchange stays on topic", trolleyScore.topicAccuracy >= 70, String(trolleyScore.topicAccuracy));
check("curated trolley exchange avoids bureaucracy drift", trolleyScore.driftControl === 100, String(trolleyScore.driftControl));
const djAudit = auditDjConfig(normalizeConfig({
  llm: { producerModel: "reasoning-model" },
  show: { relationship: "Paul and Rae have hosted together for six years." },
}));
check("healthy DJ defaults pass the offline audit", djAudit.passed === djAudit.total, `${djAudit.passed}/${djAudit.total}`);

/* ── Ad config validation ────────────────────────────────────── */

const clamped = normalizeConfig({
  ads: {
    breaks: 99,
    spotsPerBreak: 0,
    loudnessDb: -20,
    spotWords: 5,
    source: "nonsense",
    style: "nonsense",
    sponsors: [
      { name: "Good Sponsor" },
      { name: "", audioFile: "" },
      { name: "Escaper", audioFile: "../../../etc/passwd" },
    ],
  },
});
check("breaks are clamped", clamped.ads.breaks === 24, String(clamped.ads.breaks));
check("spots per break are clamped", clamped.ads.spotsPerBreak === 1);
check("loudness cannot go negative", clamped.ads.loudnessDb === 0);
check("spot length has a floor", clamped.ads.spotWords === 20);
check("an unknown source falls back", clamped.ads.source === DEFAULT_CONFIG.ads.source);
check("an unknown style falls back", clamped.ads.style === DEFAULT_CONFIG.ads.style);
check("empty sponsors are dropped", clamped.ads.sponsors.length === 2, String(clamped.ads.sponsors.length));
check(
  "a sponsor cannot point outside the ads folder",
  clamped.ads.sponsors.every((sp) => !sp.audioFile.includes("/") && !sp.audioFile.includes("\\")),
  JSON.stringify(clamped.ads.sponsors.map((sp) => sp.audioFile)),
);
check("a sponsor keeps a stable id", clamped.ads.sponsors.every((sp) => sp.id.length > 0));

const repeatedCopy = [
  { id: "first", text: "The offer is only here today." },
  { id: "second", text: "  THE offer is only here today.  " },
  { id: "third", text: "A completely different offer." },
];
check("channel rotation skips identical scripts", uniqueByCopy(repeatedCopy).map((spot) => spot.id).join(",") === "first,third");
check("show breaks prefer distinct scripts", preferDistinctCopy(repeatedCopy, 2).map((spot) => spot.id).join(",") === "first,third");
check("show breaks reuse only when needed", preferDistinctCopy(repeatedCopy, 3).map((spot) => spot.id).join(",") === "first,third,second");

/* ── Model queue cancellation (offline) ─────────────────────── */

const realFetch = globalThis.fetch;
const testReply = new Response('data: {"choices":[{"delta":{"content":"ready"}}]}\n\ndata: [DONE]\n\n');
let releaseFirst: ((reply: Response) => void) | undefined;
let modelCalls = 0;
let firstCall: Promise<string> | undefined;
let completedTiming: { queueMs: number; requestMs: number } | undefined;

try {
  globalThis.fetch = (async () => {
    modelCalls++;
    if (modelCalls === 1) {
      return new Promise<Response>((resolve) => { releaseFirst = resolve; });
    }
    throw new Error("A canceled request reached the model");
  }) as typeof fetch;

  const llm = { ...DEFAULT_CONFIG.llm, model: "offline-test", baseUrl: "http://127.0.0.1:1/v1" };
  const messages = [{ role: "user" as const, content: "Ready?" }];
  firstCall = generate(llm, { messages, onTiming: (timing) => { completedTiming = timing; } });
  await Promise.resolve();

  const canceled = new AbortController();
  const waiting = generate(llm, { messages, signal: canceled.signal, priority: "background" });
  check("second model request waits behind the first", queueStats().pending === 1);
  canceled.abort();
  check("waiting request cancels promptly", await waiting.then(() => false, (err: Error) => err.name === "AbortError"));
  check("canceled request leaves the queue", queueStats().pending === 0);

  const alreadyCanceled = new AbortController();
  alreadyCanceled.abort();
  check("pre-canceled request is rejected", await generate(llm, { messages, signal: alreadyCanceled.signal })
    .then(() => false, (err: Error) => err.name === "AbortError"));

  releaseFirst?.(testReply);
  check("first request still finishes", await firstCall === "ready");
  check("model request reports queue and service time", completedTiming !== undefined &&
    completedTiming.queueMs >= 0 && completedTiming.requestMs >= 0);
  check("canceled requests never reach the model", modelCalls === 1, String(modelCalls));
} finally {
  releaseFirst?.(testReply);
  await firstCall?.catch(() => {});
  globalThis.fetch = realFetch;
}

let activeSignal: AbortSignal | undefined;
let activeStream: ReadableStreamDefaultController<Uint8Array> | undefined;
let activeCall: Promise<string> | undefined;
try {
  globalThis.fetch = (async (_input, init) => {
    activeSignal = init?.signal as AbortSignal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { activeStream = controller; },
    }));
  }) as typeof fetch;

  const llm = { ...DEFAULT_CONFIG.llm, model: "offline-test", baseUrl: "http://127.0.0.1:1/v1" };
  const controller = new AbortController();
  activeCall = generate(llm, { messages: [{ role: "user", content: "Ready?" }], signal: controller.signal });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  controller.abort();
  check("active model stream receives cancel", (activeSignal as AbortSignal | undefined)?.aborted === true);
  activeStream?.error(new DOMException("Aborted", "AbortError"));
  check("active model request stops", await activeCall.then(() => false, (err: Error) => err.name === "AbortError"));
} finally {
  activeStream?.error(new DOMException("Aborted", "AbortError"));
  await activeCall?.catch(() => {});
  globalThis.fetch = realFetch;
}

try {
  globalThis.fetch = (async (_input, init) => {
    const signal = init?.signal as AbortSignal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }));
  }) as typeof fetch;

  const llm = {
    ...DEFAULT_CONFIG.llm,
    model: "offline-test",
    baseUrl: "http://127.0.0.1:1/v1",
    timeoutSeconds: 0.03,
  };
  const result = await generate(llm, { messages: [{ role: "user", content: "Ready?" }] })
    .then(() => null, (err: Error) => err);
  check("stream timeout reports an error instead of a cancel", result?.name === "LlmError" &&
    result.message.includes("timed out"));
} finally {
  globalThis.fetch = realFetch;
}

/* ── Running-order smoke test (offline) ──────────────────────── */

const breakCalls: number[] = [];
let spokenCalls = 0;
try {
  globalThis.fetch = (async () => {
    spokenCalls++;
    const line = `Point ${spokenCalls} changes the decision because the evidence has a specific cost for the listener.`;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: line } }] })}\n\ndata: [DONE]\n\n`);
  }) as typeof fetch;

  const runningOrderConfig = normalizeConfig({
    llm: { model: "offline-test", baseUrl: "http://127.0.0.1:1/v1" },
    show: { turns: 8, useRunSheet: true, useOutline: false },
    memory: { enabled: false },
  });
  const conversation = await runConversation(
    runningOrderConfig,
    "How a town chooses its energy supply",
    null,
    { onBreak: (index) => { breakCalls.push(index); } },
    undefined,
    [],
    undefined,
    [3],
  );
  check("running order completes a short show", conversation.turns.length === 8, String(conversation.turns.length));
  check("running order reaches its commercial break", breakCalls.length === 1 && breakCalls[0] === 0);
  check("running-order smoke test uses only the fake model", spokenCalls > 0, String(spokenCalls));
} finally {
  globalThis.fetch = realFetch;
}

/* ── Cancel and restart a running-order show (offline) ──────── */

const restartController = new AbortController();
let restartCalls = 0;
try {
  globalThis.fetch = (async (_input, init) => {
    restartCalls++;
    if (restartCalls === 1) {
      const signal = init?.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      }));
    }
    const line = `Response ${restartCalls} gives a specific reason that the next decision matters to listeners.`;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: line } }] })}\n\ndata: [DONE]\n\n`);
  }) as typeof fetch;

  const config = normalizeConfig({
    llm: { model: "offline-test", baseUrl: "http://127.0.0.1:1/v1" },
    show: { turns: 4, useRunSheet: true, useOutline: false },
    memory: { enabled: false },
  });
  const interrupted = runConversation(config, "A shorter radio show", null, {}, restartController.signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  restartController.abort();
  check("interrupted running-order show cancels", await interrupted
    .then(() => false, (err: Error) => err.name === "AbortError"));

  const restarted = await runConversation(config, "A fresh radio show", null, {});
  check("new show runs after cancellation", restarted.turns.length === 4, String(restarted.turns.length));
  check("restarted show leaves no model requests queued", queueStats().pending === 0 && queueStats().inFlight === 0);

  let resumedStarts = 0;
  const resumed = await runConversation(
    config,
    "A resumed radio show",
    null,
    { onTurnStart: () => { resumedStarts++; } },
    undefined,
    [],
    undefined,
    [],
    null,
    "",
    [
      { index: 0, hostId: "a", speaker: config.hosts[0].name, text: "The first completed point stays in the resumed conversation." },
      { index: 1, hostId: "b", speaker: config.hosts[1].name, text: "The second completed point also survives the interruption." },
    ],
  );
  check("resumed show preserves completed lines", resumed.turns[0]?.text.includes("first completed") && resumed.turns[1]?.text.includes("second completed"));
  check("resumed show generates only missing host turns", resumedStarts === 2, String(resumedStarts));
  check("resumed show reaches the configured length", resumed.turns.length === 4, String(resumed.turns.length));
} finally {
  restartController.abort();
  globalThis.fetch = realFetch;
}

console.log(`
─── ${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`} ───
`);
process.exit(failures === 0 ? 0 : 1);
