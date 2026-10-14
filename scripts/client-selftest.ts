/**
 * Runs the Godot client's headless checks (game-client/tests/*_check.gd) with the bundled
 * Godot, one process each. A check passes only if Godot exits cleanly, the script reports
 * `failures: 0`, and nothing printed a script or parse error: Godot can exit 0 after failing
 * to load a script, so the exit code alone is not trusted.
 *
 *   npm run client-selftest
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GODOT = path.join(ROOT, "tools", "godot-4.7.2", "Godot_v4.7.2-stable_win64_console.exe");
const PROJECT = path.join(ROOT, "game-client");
const TESTS = path.join(PROJECT, "tests");

if (!fs.existsSync(GODOT)) {
  console.error(`Godot was not found at ${GODOT}; the client checks cannot run.`);
  process.exit(1);
}

const scripts = fs.readdirSync(TESTS).filter((name) => name.endsWith("_check.gd")).sort();
if (scripts.length === 0) {
  console.error(`No *_check.gd scripts in ${TESTS}.`);
  process.exit(1);
}

let failed = 0;
for (const script of scripts) {
  const run = spawnSync(GODOT, ["--headless", "--path", PROJECT, "--script", path.join(TESTS, script)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const problems: string[] = [];
  if (run.status !== 0) problems.push(`exit status ${run.status}`);
  if (!/^failures: 0$/m.test(output)) problems.push("did not report `failures: 0`");
  if (/SCRIPT ERROR|Parse Error/.test(output)) problems.push("a script error was printed");
  const checks = (output.match(/^\[  ok  \]/gm) ?? []).length;
  const failures = output.split(/\r?\n/).filter((line) => line.startsWith("[ FAIL ]"));
  if (problems.length === 0) {
    console.log(`  ok  ${script} (${checks} checks)`);
    continue;
  }
  failed++;
  console.log(` FAIL ${script}: ${problems.join("; ")}`);
  for (const line of failures) console.log(`        ${line}`);
  if (failures.length === 0) console.log(output.split(/\r?\n/).slice(-12).map((line) => `        ${line}`).join("\n"));
}

console.log(failed === 0 ? `\n─── all ${scripts.length} client check files passed ───` : `\n─── ${failed} client check file(s) FAILED ───`);
process.exit(failed === 0 ? 0 : 1);
