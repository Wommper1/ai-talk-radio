/**
 * Download the Piper speech engine and the default voices into tools/piper.
 *
 * The tools folder is deliberately not in version control, so this exists to
 * put it back on a fresh clone, or to add more voices later. The first-run
 * setup screen in the app does the same thing with a button.
 *
 *   npm run setup-piper
 *   npm run setup-piper -- en_US-lessac-medium      add one more voice
 */

import { DEFAULT_PIPER_VOICES, installPiper, piperVoicesDir } from "../server/setup/piper.ts";

const extraVoices = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const voices = extraVoices.length > 0 ? extraVoices : DEFAULT_PIPER_VOICES;

console.log("\nSetting up Piper\n");

// Percentages are printed on a single updating line; finished steps get their own line.
const progress = (line: string) => {
  if (process.stdout.isTTY && line.endsWith("%")) {
    process.stdout.write(`\r  ${line}   `);
  } else if (!line.endsWith("%")) {
    if (process.stdout.isTTY) process.stdout.write("\r");
    console.log(`  ${line}          `);
  }
};

try {
  const installed = await installPiper(voices, progress);
  console.log(`\nReady. ${installed.length} voice(s) in ${piperVoicesDir()}`);
  console.log("Browse more at huggingface.co/rhasspy/piper-voices\n");
} catch (err) {
  console.error(`\nSetup failed: ${(err as Error).message}\n`);
  process.exit(1);
}
