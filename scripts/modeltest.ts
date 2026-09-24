/**
 * Two models, the same court, side by side.
 *
 * "Which model should I use" is not answerable from a spec sheet or a
 * leaderboard — benchmarks measure whether a model can answer a question, and
 * what this app needs is whether it can hold a character for twenty turns
 * without turning into a helpful assistant. Those are different skills and
 * they are not correlated.
 *
 * So this asks the actual question: load a candidate alongside the current
 * model in LM Studio, run the identical court through both, and read the two
 * transcripts next to each other.
 *
 * Nothing here writes to the game. The chronicle is read, the court is held,
 * and the result is printed — the write-back path is deliberately not
 * involved, so a model can be auditioned as many times as you like.
 *
 *   npm run modeltest -- <model-a> <model-b> [topic]
 *
 * With no arguments it lists what the server currently has loaded.
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../server/config.ts";
import { resolveBaseUrl } from "../server/providers/llm.ts";
import { runConversation, type Turn } from "../server/pipeline/conversation.ts";
import { readRealm, realmBriefing, realmSummary } from "../server/orion/realm.ts";

const config = loadConfig();
const args = process.argv.slice(2);

/* ── What is available ───────────────────────────────────────────── */

async function loaded(): Promise<string[]> {
  const res = await fetch(`${resolveBaseUrl(config.llm)}/models`, {
    headers: config.llm.apiKey ? { Authorization: `Bearer ${config.llm.apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`The model server answered HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => String(m.id)).filter(Boolean);
}

const available = await loaded().catch((err: Error) => {
  console.error(`\n  Could not reach the model server: ${err.message}\n`);
  process.exit(1);
});

if (args.length < 2) {
  console.log("\n  Loaded in the model server right now:\n");
  for (const id of available) console.log(`    ${id}`);
  console.log(
    "\n  Load a second model alongside the first in LM Studio, then:\n" +
      "    npm run modeltest -- <model-a> <model-b> [topic]\n",
  );
  process.exit(0);
}

const [modelA, modelB] = args;
const topic = args.slice(2).join(" ") || "whether the Respawn Guild can be broken at all";

for (const model of [modelA, modelB]) {
  if (!available.includes(model)) {
    console.error(`\n  "${model}" is not loaded. Loaded: ${available.join(", ")}\n`);
    process.exit(1);
  }
}

/* ── The court, twice ────────────────────────────────────────────── */

const realm = readRealm(config.orion.realmPath, config.orion.recallEvents);
if (!realm.root) {
  console.error(`\n  ${realm.problems[0] ?? "The realm was not found."}\n`);
  process.exit(1);
}

const briefing = realmBriefing(realm, config.orion.lore);
console.log(`\n  Realm : ${realmSummary(realm)}`);
console.log(`  Topic : ${topic}\n`);

/** How often a model reaches for the tells this app spends its time fighting. */
function scoreOf(turns: Turn[]): Record<string, number> {
  const text = turns.map((t) => t.text).join(" ").toLowerCase();
  const count = (re: RegExp) => (text.match(re) ?? []).length;

  return {
    turns: turns.length,
    words: text.split(/\s+/).filter(Boolean).length,
    // Mirroring the other speaker instead of answering them.
    narrating: count(/\b(?:king orion|maeve|he|she) (?:said|spoke of|thinks|mentioned)\b/g),
    // The drift into philosophy that a king should never have.
    metaphysics: count(/\b(?:fate|destiny|puppet|strings|loom|specter|spectre|ghost|shadow|weight of)\b/g),
    // Assistant register leaking through the character.
    assistantish: count(/\b(?:that's a (?:great|good|fair)|absolutely|i understand|it's important|certainly)\b/g),
    // What we actually want: things you can touch.
    concrete: count(/\b(?:gold|road|iron|blood|burn|burned|village|thatch|ford|camp|winter|bread|tax|taxes)\b/g),
  };
}

const results: Array<{ model: string; turns: Turn[]; seconds: number }> = [];

for (const model of [modelA, modelB]) {
  console.log(`  ── ${model} ${"─".repeat(Math.max(0, 56 - model.length))}`);
  const started = Date.now();

  // Speech off: this is about the words, and synthesis would triple the wait.
  const runConfig = {
    ...config,
    tts: { ...config.tts, engine: "none" as const },
    llm: { ...config.llm, model },
    hosts: [
      { ...config.hosts[0], name: config.orion.king.name, model },
      { ...config.hosts[1], name: config.orion.chronicler.name, model },
    ] as typeof config.hosts,
  };

  const result = await runConversation(
    runConfig,
    topic,
    null,
    { onInfo: (m) => console.log(`     · ${m}`) },
    undefined,
    [],
    undefined,
    [],
    null,
    briefing,
  );

  const seconds = (Date.now() - started) / 1000;
  results.push({ model, turns: result.turns, seconds });

  console.log("");
  for (const turn of result.turns) console.log(`     ${turn.speaker}: ${turn.text}`);
  console.log("");
}

/* ── Side by side ────────────────────────────────────────────────── */

console.log("  ── the numbers ───────────────────────────────────────────\n");

const keys = Object.keys(scoreOf(results[0].turns));
const width = Math.max(...results.map((r) => r.model.length));

console.log(`     ${"".padEnd(width)}  ${keys.map((k) => k.padStart(12)).join("")}   seconds`);
for (const r of results) {
  const s = scoreOf(r.turns);
  console.log(
    `     ${r.model.padEnd(width)}  ${keys.map((k) => String(s[k]).padStart(12)).join("")}   ${r.seconds.toFixed(0)}`,
  );
}

console.log(
  "\n     Lower is better for narrating, metaphysics and assistantish.\n" +
    "     Higher is better for concrete. None of it replaces reading the two\n" +
    "     transcripts above — the numbers only point at where to look.\n",
);

const out = path.join(process.cwd(), "output", "modeltest.txt");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  results
    .map((r) => `=== ${r.model} (${r.seconds.toFixed(0)}s) ===\n${r.turns.map((t) => `${t.speaker}: ${t.text}`).join("\n")}`)
    .join("\n\n"),
);
console.log(`     Both transcripts: ${out}\n`);
