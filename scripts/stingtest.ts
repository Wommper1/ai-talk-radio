/** Render every sting so they can be judged by ear. */

import fs from "node:fs";
import path from "node:path";
import { makeSting, STING_LENGTHS, type StingKind } from "../server/audio/stings.ts";
import { encodeWav, normalize, concat, silence, durationOf } from "../server/audio/wav.ts";

const outDir = path.join(process.cwd(), "output", "stings");
fs.mkdirSync(outDir, { recursive: true });

const kinds: StingKind[] = ["ident", "bumper", "riser", "whoosh", "impact", "beep"];
const all = [];

for (const kind of kinds) {
  const sting = normalize(makeSting(kind, STING_LENGTHS[kind], 7), 0.85);
  let peak = 0;
  let finite = true;
  for (const v of sting.data) {
    if (!Number.isFinite(v)) finite = false;
    peak = Math.max(peak, Math.abs(v));
  }
  console.log(`${kind.padEnd(8)} ${durationOf(sting).toFixed(2)}s  peak ${peak.toFixed(2)}  finite ${finite}`);
  fs.writeFileSync(path.join(outDir, `${kind}.wav`), encodeWav(sting));
  all.push(sting, silence(0.6));
}

const reel = normalize(concat(all), 0.89);
fs.writeFileSync(path.join(outDir, "all.wav"), encodeWav(reel));
console.log(`\nreel: ${durationOf(reel).toFixed(1)}s -> output/stings/all.wav`);
