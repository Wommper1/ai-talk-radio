/**
 * Render a commercial break and the station opener, with no model involved.
 *
 * The copy comes from templates rather than the LLM, so this exercises exactly
 * the part that has to sound right — synthesis, the ad treatment, the bed, the
 * imaging and the loudness jump — without waiting on generation.
 *
 * Run with: npm run adtest
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../server/config.ts";
import { describeBreak, renderBreak, type AdBreak } from "../server/pipeline/ads.ts";
import { renderColdOpen, coldOpenScript } from "../server/pipeline/coldopen.ts";
import { makeLoopBed } from "../server/audio/music.ts";
import { matchAdLoudness } from "../server/pipeline/produce.ts";
import { compress } from "../server/audio/effects.ts";
import { concat, decodeWav, durationOf, encodeWav, silence, gain, SAMPLE_RATE } from "../server/audio/wav.ts";
import { produceShow } from "../server/pipeline/produce.ts";
import type { Turn } from "../server/pipeline/conversation.ts";

const config = loadConfig();
const outDir = path.join(process.cwd(), "output", "ads");
fs.mkdirSync(outDir, { recursive: true });

const topic = process.argv.slice(2).join(" ") || "the staged fight at the dance show";

if (config.tts.engine === "none") {
  console.error("Speech is turned off in config.json. Pick an engine first.");
  process.exit(1);
}

console.log(`\n  Station: ${config.show.station}`);
console.log(`  Engine:  ${config.tts.engine}`);
console.log(`  Voices:  ${config.hosts[0].name}, ${config.hosts[1].name}, ${config.ads.announcer.name}\n`);

/* ── The opener ──────────────────────────────────────────────────── */

console.log(`  Opener script: "${coldOpenScript(config, topic)}"`);
const openPath = path.join(outDir, "open.wav");
const opener = await renderColdOpen(config, topic, openPath);
console.log(`  → ${openPath} (${opener ? durationOf(opener).toFixed(1) : "0"}s)\n`);

/* ── One break, written from templates ───────────────────────────── */

const brk: AdBreak = {
  index: 0,
  spots: [
    {
      kind: "produced",
      sponsor: "Wommper1",
      angle: "list_blitz",
      lines: [
        {
          voice: "announcer",
          text:
            "Wommper1! We got stuff, we got more stuff, we got the stuff you came in for and four things you didn't. " +
            "Cable, buckets, a door, half a ladder, whatever that is - twelve dollars. Everything is twelve dollars.",
        },
        {
          voice: "announcer",
          text:
            "Oh - that's not - okay, that's fine, that's fine, it does that. Get down here right now, no appointment, " +
            "no questions. Wommper1. Get all the stuff you need.",
        },
      ],
      disclaimer:
        "Terms and conditions apply. Offer subject to availability, and to whether anybody turns up.",
    },
    {
      kind: "live_read",
      sponsor: "Bootleg Spoon",
      angle: "deadpan",
      lines: [
        {
          voice: "a",
          text:
            "Bootleg Spoon has used bridges. That's right - the ones the cars go over. She takes them herself and " +
            "she banks them, and she doesn't want to talk about where they came from.",
        },
        {
          voice: "a",
          text:
            "They're not new. They're not certified. They're bridges. Bootleg Spoon. Bootleg Spoon. Your bridge, delivered.",
        },
      ],
    },
    {
      kind: "promo",
      sponsor: config.show.station,
      lines: [
        { voice: "announcer", text: `You're listening to ${config.show.station}. The phones are open all hour.` },
        {
          voice: "announcer",
          text: `Call in, and you go straight on air with ${config.hosts[0].name} and ${config.hosts[1].name}.`,
        },
      ],
    },
  ],
};

console.log("  Rendering the break...");
const breakPath = path.join(outDir, "break.wav");
const audio = await renderBreak(config, brk, breakPath, 4242);
console.log(`  → ${breakPath} (${durationOf(audio).toFixed(1)}s)\n`);

/* ── In context: dialogue, break, dialogue ───────────────────────── */

// The break's own level, and the jump it would get once the mix has measured it
// against real dialogue.
const peakOf = (data: Float32Array) => {
  let max = 0;
  for (const v of data) max = Math.max(max, Math.abs(v));
  return max;
};

const rmsOf = (data: Float32Array) => {
  let sum = 0;
  for (const v of data) sum += v * v;
  return Math.sqrt(sum / Math.max(1, data.length));
};

console.log(`  Break peak: ${peakOf(audio.data).toFixed(3)}   RMS: ${rmsOf(audio.data).toFixed(4)}`);

// Stand it next to the opener's speech, which is the closest thing to dialogue
// this script has, and show where the mix would put it.
if (fs.existsSync(openPath)) {
  const dialogue = decodeWav(fs.readFileSync(openPath));
  const treated = matchAdLoudness(
    [
      { kind: "voice", clip: compress(dialogue, { thresholdDb: -20, ratio: 3, makeupDb: 3.5 }), side: 0, start: 0 },
      { kind: "ad", clip: audio, side: 0, start: 0 },
    ],
    config.ads.loudnessDb,
  );

  const voiceRms = rmsOf(treated[0].clip.data);
  const before = 20 * Math.log10(rmsOf(audio.data) / voiceRms);
  const after = 20 * Math.log10(rmsOf(treated[1].clip.data) / voiceRms);
  console.log(`  Against speech: ${before.toFixed(2)} dB as rendered, ${after.toFixed(2)} dB in the mix`);
  console.log(`  (the show asks for +${config.ads.loudnessDb.toFixed(1)})\n`);
}

/* ── The looping bed, three passes, to hear the seam ─────────────── */

const loop = gain(makeLoopBed(8, config.show.mood as never, 7), 0.9);
const loopPath = path.join(outDir, "bed-loop.wav");
fs.writeFileSync(loopPath, encodeWav(concat([loop, loop, loop])));
console.log(`  → ${loopPath} (three passes of an ${durationOf(loop).toFixed(0)}s loop — listen for a click at the join)\n`);

/* ── A reel of all of it ─────────────────────────────────────────── */

const parts = [];
if (fs.existsSync(openPath)) parts.push(decodeWav(fs.readFileSync(openPath)), silence(0.6));
parts.push(audio);

const reelPath = path.join(outDir, "reel.wav");
fs.writeFileSync(reelPath, encodeWav(concat(parts, SAMPLE_RATE)));
console.log(`  → ${reelPath} — opener then break, back to back\n`);

/* ── The whole thing in context ───────────────────────── */

// A short show that actually goes through produceShow, so the break is placed
// on the real timeline, levelled against real dialogue and mixed the way a
// finished episode is. This is the part that has to sound right.
console.log("  Mixing a short show with the break in it...");

const lines: Array<["a" | "b", string]> = [
  ["a", "Right, so the thing nobody wants to say out loud about Saturday night is that the whole fight was staged."],
  ["b", "Staged is a strong word. I would say... choreographed. Badly."],
  ["a", "Choreographed. Sure. By someone who has never seen a fight."],
  ["b", "We will get into who actually threw the first chair after this. Don't go anywhere."],
  ["a", "And we are back. Dee, you were about to name names."],
  ["b", "I was about to name one name, and then legal called."],
];

const showTurns: Turn[] = lines.map(([hostId, text], i) => ({
  index: i,
  hostId,
  speaker: hostId === "a" ? config.hosts[0].name : config.hosts[1].name,
  text,
  // The break goes out after the line that throws to it.
  ...(i === 3 ? { breakAfter: 0 } : {}),
}));

const showOut = path.join(outDir, "demo-show");
const produced = await produceShow(config, showTurns, showOut, {}, undefined, undefined, {
  breaks: new Map([[0, breakPath]]),
  breakLabels: new Map([[0, describeBreak(brk)]]),
  coldOpen: openPath,
  coldOpenText: coldOpenScript(config, topic),
});

console.log(`  → ${produced.audioPath} (${produced.duration.toFixed(1)}s)`);
console.log("\n  Running order:");
for (const line of produced.transcript) {
  const who = line.hostId === "break" ? "BREAK" : line.hostId === "station" ? "STATION" : line.speaker;
  const time = `${Math.floor(line.start / 60)}:${String(Math.floor(line.start % 60)).padStart(2, "0")}`;
  console.log(`    ${time}  ${who.padEnd(8)} ${line.text.slice(0, 60)}`);
}

// The transcript is only worth anything if it agrees with the audio, so check
// the last line ends inside the file rather than trusting that it does.
const last = produced.transcript[produced.transcript.length - 1];
const drift = produced.duration - last.end;
console.log(
  `\n  Transcript ends ${drift.toFixed(1)}s before the audio does ${drift >= -0.1 ? "— lines up" : "— MISMATCH"}\n`,
);
