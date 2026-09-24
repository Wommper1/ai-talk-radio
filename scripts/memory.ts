/**
 * Rebuild and inspect the cross-show memory index.
 *
 *   npm run memory                 rebuild, then show stats
 *   npm run memory -- "dishwasher" rebuild, then search
 */

import { loadConfig } from "../server/config.ts";
import { buildIndex, recall, memoryStats } from "../server/memory/retrieval.ts";

const config = loadConfig();
const query = process.argv.slice(2).join(" ").trim();

console.log(`\nbackend: ${config.memory.backend}`);

const built = await buildIndex(config, true);
if (built.error) {
  console.error(`\n  ${built.error}\n`);
  process.exit(1);
}

const stats = memoryStats();
console.log(`indexed: ${stats.shows} show(s), ${stats.passages} passage(s)`);
console.log(`file:    ${stats.path}\n`);

if (query) {
  const hits = await recall(config, query, 5);
  console.log(`"${query}" →\n`);
  if (hits.length === 0) {
    console.log("  nothing relevant\n");
  } else {
    for (const h of hits) {
      console.log(`  [${h.score.toFixed(2)}] ${h.date} · ${h.showTitle}`);
      console.log(`    ${h.text.slice(0, 160)}...\n`);
    }
  }
}
