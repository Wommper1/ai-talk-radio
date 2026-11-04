/**
 * Run the existing offline self-test without using the station's live memory.
 * Several modules resolve data paths from process.cwd() at import time, so the
 * child must start in a disposable directory before selftest.ts is imported.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tsxRoot = path.dirname(require.resolve("tsx/package.json"));
const tsxCli = path.join(tsxRoot, "dist", "cli.mjs");
const selftest = path.join(projectRoot, "scripts", "selftest.ts");
const prefix = "ai-talk-radio-selftest-";
const temporaryRoot = fs.realpathSync.native(os.tmpdir());
const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(temporaryRoot, prefix)));

try {
  // selftest.ts reads these source files by relative path. Copy code only;
  // never copy the live config, memory, shows, backups or credentials.
  const sources = [
    "server/config.ts",
    "server/pipeline/bucket.ts",
    "server/pipeline/conversation.ts",
    "server/pipeline/showrunner.ts",
  ];
  for (const relative of sources) {
    const destination = path.join(scratch, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, relative), destination);
  }

  const child = spawnSync(process.execPath, [tsxCli, selftest], {
    cwd: scratch,
    stdio: "inherit",
    windowsHide: true,
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} finally {
  // The only recursive removal is the exact directory created above.
  if (
    path.dirname(scratch).toLowerCase() !== temporaryRoot.toLowerCase() ||
    !path.basename(scratch).startsWith(prefix)
  ) {
    throw new Error(`Refusing to remove unexpected self-test directory: ${scratch}`);
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
