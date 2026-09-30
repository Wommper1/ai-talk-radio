/**
 * Exercise every available speech engine and report what each produced.
 * Writes one WAV per engine/host so they can be compared by ear.
 *
 *   npm run ttstest              all engines
 *   npm run ttstest -- piper     just one
 */

import fs from "node:fs";
import path from "node:path";
import { synthesize, probeTts } from "../server/providers/tts.ts";
import { decodeWav, durationOf, encodeWav, normalize, resample, trimSilence, SAMPLE_RATE } from "../server/audio/wav.ts";
import { applyTone, broadcastVoice } from "../server/audio/effects.ts";
import { loadConfig, voiceFor, type TtsEngine } from "../server/config.ts";

const config = loadConfig();
const outDir = path.join(process.cwd(), "output", "ttstest");
fs.mkdirSync(outDir, { recursive: true });

const requested = process.argv[2] as TtsEngine | undefined;
const engines: TtsEngine[] = requested ? [requested] : ["piper", "edge", "sapi"];

const LINE =
  "Good evening, you are listening to local talk radio. " +
  "It is quarter past midnight, and the lines are open.";

let failures = 0;

for (const engine of engines) {
  console.log(`\n─── ${engine} ───`);

  const engineConfig = { ...config.tts, engine };
  const probe = await probeTts(engineConfig);

  if (!probe.ok) {
    console.log(`  unavailable: ${probe.error}`);
    if (probe.hint) console.log(`  → ${probe.hint}`);
    continue;
  }

  console.log(`  ${probe.voices.length} voice(s)`);
  for (const v of probe.voices.slice(0, 6)) {
    console.log(`    ${v.id}${v.detail ? `  (${v.detail})` : ""}`);
  }
  if (probe.voices.length > 6) console.log(`    ...and ${probe.voices.length - 6} more`);

  for (const host of config.hosts) {
    const voice = voiceFor(host, engine) || probe.voices[0]?.id || "";
    const raw = path.join(outDir, `${engine}-${host.id}-raw.wav`);

    const started = Date.now();
    try {
      await synthesize({ text: LINE, voice, rate: host.rate, outPath: raw }, engineConfig);
    } catch (err) {
      failures++;
      const e = err as Error & { hint?: string };
      console.log(`  ${host.name}: FAILED — ${e.message}`);
      if (e.hint) console.log(`    → ${e.hint}`);
      continue;
    }
    const elapsed = (Date.now() - started) / 1000;

    // Run it through the same chain the show pipeline uses.
    let clip = resample(decodeWav(fs.readFileSync(raw)), SAMPLE_RATE);
    clip = normalize(broadcastVoice(applyTone(trimSilence(clip), host.tone)), 0.86);

    const shaped = path.join(outDir, `${engine}-${host.id}-${host.tone}.wav`);
    fs.writeFileSync(shaped, encodeWav(clip));

    let peak = 0;
    for (let i = 0; i < clip.data.length; i++) peak = Math.max(peak, Math.abs(clip.data[i]));

    const realtime = elapsed / durationOf(clip);
    console.log(
      `  ${host.name.padEnd(6)} ${voice.padEnd(26)} ` +
        `${durationOf(clip).toFixed(2)}s audio in ${elapsed.toFixed(2)}s ` +
        `(${realtime.toFixed(2)}x realtime), peak ${peak.toFixed(2)}`,
    );
    console.log(`         → ${path.relative(process.cwd(), shaped)}`);

    if (peak < 0.05) {
      failures++;
      console.log("         WARNING: output is nearly silent");
    }
  }
}

console.log(`\n${failures === 0 ? "TTS OK" : `${failures} failure(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
