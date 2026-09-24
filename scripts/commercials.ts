/**
 * Fill the commercial bucket.
 *
 *   npm run commercials           five more
 *   npm run commercials -- 12     twelve
 *   npm run commercials -- list   what is in the bucket
 *   npm run commercials -- repair re-record anything whose copy has since
 *                                 been cleaned up (no model needed)
 *
 * A command line over server/pipeline/bucketwriter.ts, which is where the
 * three sources, the tone and the cleaning rules actually live — the server
 * tops the bucket up after a show using the same code, and two copies of those
 * rules would have drifted apart within a week.
 */

import path from "node:path";
import { loadConfig } from "../server/config.ts";
import { renderBreak, type AdBreak } from "../server/pipeline/ads.ts";
import { durationOf } from "../server/audio/wav.ts";
import { BUCKET_DIR, bucketStats, listBucket, updateSpot } from "../server/pipeline/bucket.ts";
import { tidy, worldContext, writeSpot } from "../server/pipeline/bucketwriter.ts";

const config = loadConfig();
const args = process.argv.slice(2);

/* ── What is in there ─────────────────────────────────────────────── */

if (args[0] === "list") {
  const spots = listBucket();
  if (spots.length === 0) {
    console.log("The bucket is empty. Run `npm run commercials` to fill it.");
  } else {
    for (const spot of spots) {
      console.log(
        `${spot.keep ? "*" : " "} ${spot.source.padEnd(11)} ${spot.seconds.toFixed(0).padStart(3)}s  ` +
          `${String(spot.plays).padStart(2)} play(s)  ${spot.sponsor}`,
      );
    }
  }
  console.log();
  console.log(bucketStats());
  process.exit(0);
}

/* ── Re-record copy that has since been cleaned ───────────────────── */

if (args[0] === "repair") {
  const spots = listBucket();
  let fixed = 0;

  for (const spot of spots) {
    const cleaned = tidy(spot.text);
    if (cleaned === spot.text) continue;

    process.stdout.write(`repairing ${spot.sponsor}... `);
    try {
      const brk: AdBreak = {
        index: 0,
        spots: [{ kind: "produced", sponsor: spot.sponsor, lines: [{ voice: "announcer", text: cleaned }] }],
      };
      const audio = await renderBreak(config, brk, path.join(BUCKET_DIR, spot.file), Date.now(), undefined, {
        shelve: false,
      });
      updateSpot(spot.id, { text: cleaned, seconds: Number(durationOf(audio).toFixed(2)) });
      fixed += 1;
      console.log(`${durationOf(audio).toFixed(0)}s`);
      console.log(`    was: ${spot.text.slice(0, 70)}`);
      console.log(`    now: ${cleaned.slice(0, 70)}`);
    } catch (err) {
      console.log(`failed: ${(err as Error).message}`);
    }
  }

  console.log(`\n${fixed} of ${spots.length} spot(s) needed repairing.`);
  process.exit(0);
}

/* ── Make some ────────────────────────────────────────────────────── */

const wanted = Math.max(1, Math.min(30, Number(args[0]) || 5));
const { cast, places } = worldContext(config);

console.log(
  `${cast ? cast.split("\n").length - 1 : 0} people and ` +
    `${places ? places.split(",").length : 0} places on the character sheet. ` +
    `${listBucket().length} spot(s) already in the bucket.\n`,
);

let made = 0;

for (let i = 0; i < wanted; i++) {
  process.stdout.write(`${String(i + 1).padStart(2)}. writing... `);
  try {
    const spot = await writeSpot(config, i + listBucket().length);
    made += 1;
    console.log(`${spot.source.padEnd(11)} ${spot.seconds.toFixed(0)}s  ${spot.sponsor}`);
    console.log(`    ${spot.text.slice(0, 120)}...`);
  } catch (err) {
    console.log(`skipped: ${(err as Error).message}`);
  }
}

const stats = bucketStats();
console.log(
  `\n${made} of ${wanted} made. The bucket now holds ${stats.total} spot(s), ` +
    `${Math.round(stats.seconds / 60)} minutes of audio.`,
);
console.log(`station ${stats.bySource.station} · realm ${stats.bySource.realm} · multiverse ${stats.bySource.multiverse}`);
console.log("Both shows draw their breaks from here, so none of it has to be written again.");
