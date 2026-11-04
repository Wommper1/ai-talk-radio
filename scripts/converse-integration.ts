/**
 * Integration test for POST /api/world/v1/converse: the real server, the real Python
 * conversation script, a fake local model, and a throwaway world, checked over real HTTP.
 *
 *   npm run converse-integration
 *
 * The unit tests in selftest.ts use a fake script runner and the Python tests do not involve
 * the server, so neither proves the two halves agree. This does. Nothing outside a temporary
 * folder is touched: the server runs from its own working directory with its own config.json
 * and a made-up world key, and the "model" is a local stub that this script controls.
 *
 * Needs the Southern Indiana Realm project (REALM_PROJECT_PATH, default
 * ~/SouthernIndianaRealm) and Python (REALM_PYTHON, default `python`). If either
 * is missing it says SKIPPED and exits 0; set REALM_REQUIRE=1 to make that a failure.
 */

import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = (process.env.REALM_PROJECT_PATH?.trim() || path.join(os.homedir(), "SouthernIndianaRealm")).replace(/\\/g, "/");
const PYTHON = process.env.REALM_PYTHON?.trim() || "python";

function skip(reason: string): never {
  console.log(`SKIPPED: ${reason}`);
  process.exit(process.env.REALM_REQUIRE ? 1 : 0);
}

if (!fs.existsSync(path.join(PROJECT, "tools", "converse.py")) || !fs.existsSync(path.join(PROJECT, "content", "floyd_npcs.json"))) {
  skip(`the Southern Indiana Realm project was not found at ${PROJECT} (set REALM_PROJECT_PATH)`);
}
if (spawnSync(PYTHON, ["--version"], { encoding: "utf8" }).status !== 0) {
  skip(`Python was not found as "${PYTHON}" (set REALM_PYTHON)`);
}

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(`[${condition ? "  ok  " : " FAIL "}] ${label}${detail && !condition ? ` — ${detail}` : ""}`);
}

/* ── A throwaway world, shaped the way the importer and the engine leave one ─────────── */

const work = fs.mkdtempSync(path.join(os.tmpdir(), "converse-it-"));
const realmDir = path.join(work, "realm");
const serverDir = path.join(work, "server");
fs.mkdirSync(realmDir);
fs.mkdirSync(serverDir);
const dbPath = path.join(realmDir, "world.db");

// The text below is invented for this test. The characters are the project's own (content/floyd_npcs.json),
// tied to their real site ids, so what the script reads is exactly what a real world holds.
const MANSION = {
  id: "test_mansion", name: "Test Mansion", site: "floyd_culbertson_mansion", flagged: 0, access: "Public park",
  facts: "The hall was raised in 1901 by a travelling joiner. It has 77 windows.",
  legend: "They say a pale lantern drifts slowly past the old hall every autumn night.",
};
const CHAPEL = {
  id: "test_chapel", name: "Test Chapel", site: "floyd_town_clock_church", flagged: 0, access: "Active site",
  facts: "The chapel was finished in 1860 and seats 120.", legend: "",
};
const TUNNEL = {
  id: "test_tunnel", name: "Test Tunnel", site: "floyd_duncan_tunnel", flagged: 1, access: "Active Freight Rail Bridge",
  facts: "The bore opened in 1881 and runs 4000 feet. It is still a working line.", legend: "",
};

function buildWorld() {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE realm_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO realm_meta VALUES ('current_campaign_id', 'c1');
    CREATE TABLE discord_runtime (campaign_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, roster_json TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE locations (
      location_id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, kingdom TEXT, description TEXT, connected_to TEXT DEFAULT '[]',
      lore_site_id TEXT, confidence_level TEXT, verification_grade TEXT, county TEXT, era TEXT, category TEXT, sources TEXT,
      source_notes TEXT, access_status TEXT, do_not_visit INTEGER DEFAULT 0, latitude REAL, longitude REAL,
      folklore_tradition TEXT, verified_history TEXT
    );
    CREATE TABLE npcs (
      npc_id TEXT PRIMARY KEY, name TEXT NOT NULL, occupation TEXT, faction TEXT, home_location TEXT, current_location TEXT,
      personality TEXT, current_mood TEXT, is_alive INTEGER DEFAULT 1, relationships TEXT DEFAULT '{}',
      memories TEXT DEFAULT '[]', secrets TEXT DEFAULT '[]', created_at TEXT
    );
  `);
  const place = db.prepare(
    "INSERT INTO locations VALUES (?, ?, 'site', 'Testford County', ?, '[]', ?, 'OFFICIAL_SOURCE', 'Archival', 'Testford County', '1900s', 'Test', 'Invented deed book 1', '', ?, ?, 38.3, -85.8, ?, ?)",
  );
  for (const p of [MANSION, CHAPEL, TUNNEL]) place.run(p.id, p.name, p.facts, p.site, p.access, p.flagged, p.legend, p.facts);
  const person = db.prepare("INSERT INTO npcs VALUES (?, ?, ?, '', ?, ?, 'x', 'calm', 1, '{}', '[]', '[]', 'now')");
  person.run("npc_culbertson_docent", "Odalys Marlowe", "night docent", MANSION.name, MANSION.name);
  person.run("npc_town_clock_sexton", "Ephraim Tull", "church sexton", CHAPEL.name, CHAPEL.name);
  person.run("npc_duncan_brakeman", "Gideon Rusk", "retired railroad brakeman", TUNNEL.name, TUNNEL.name);
  db.close();
  setRuntime(false);
}

/** Ashra (actor 1) stands in the mansion and Brin (actor 2) in the tunnel; `combat` puts the party in a fight. */
function setRuntime(combat: boolean) {
  const db = new DatabaseSync(dbPath);
  const state = JSON.stringify({ total_turns: 1, location: MANSION.name, in_combat: combat });
  const member = (name: string, location: string) => ({
    name, is_fallen: false, stats: { player_class: "mage", level: 2, current_hp: 20, max_hp: 25, location },
  });
  const roster = JSON.stringify({ "1": member("Ashra", MANSION.name), "2": member("Brin", TUNNEL.name) });
  db.prepare(
    "INSERT INTO discord_runtime VALUES ('c1', ?, ?, 3, ?) ON CONFLICT(campaign_id) DO UPDATE SET state_json=excluded.state_json, roster_json=excluded.roster_json",
  ).run(state, roster, new Date().toISOString());
  db.close();
}

function memoriesOf(npcId: string): Array<{ text: string }> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT memories FROM npcs WHERE npc_id=?").get(npcId) as { memories: string };
    return JSON.parse(row.memories);
  } finally {
    db.close();
  }
}

/* ── A fake local model ──────────────────────────────────────────────────────────────── */

type ModelMode = { kind: "reply"; text: string; delayMs?: number } | { kind: "down" };
let modelMode: ModelMode = { kind: "down" };
let modelCalls: Array<{ messages: Array<{ role: string; content: string }>; model?: string }> = [];

const fakeModel = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    // The radio app also probes `${baseUrl}/models` for its status light. That is not a conversation,
    // so it is answered and not counted; only chat requests are recorded.
    if (!(req.method === "POST" && req.url?.endsWith("/chat/completions"))) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [{ id: "test-model" }] }));
      return;
    }
    modelCalls.push(JSON.parse(raw || "{}"));
    const mode = modelMode;
    if (mode.kind === "down") {
      res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "model is down" }));
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: mode.text } }] }));
    }, mode.delayMs ?? 0);
  });
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}

/* ── The real server, as a child process ─────────────────────────────────────────────── */

const TOKEN = `it-${randomBytes(24).toString("hex")}`;
let server: ChildProcess | null = null;
const serverLog: string[] = [];
let base = "";
const configFile = path.join(serverDir, "config.json");

function writeConfig(modelPort: number, remember: boolean) {
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      llm: { provider: "lmstudio", baseUrl: `http://127.0.0.1:${modelPort}/v1`, model: "test-model", timeoutSeconds: 15 },
      orion: { realmPath: realmDir.replace(/\\/g, "/"), converse: { projectPath: PROJECT, remember } },
    }),
  );
  // The server reloads config.json when its modification time changes; make sure it does.
  const bumped = new Date(Date.now() + 5_000 * (remember ? 2 : 1));
  fs.utimesSync(configFile, bumped, bumped);
}

async function startServer(modelPort: number) {
  writeConfig(modelPort, false);
  const entry = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  server = spawn(process.execPath, [entry, path.join(ROOT, "server.ts")], {
    cwd: serverDir,
    env: { ...process.env, WORLD_API_TOKEN: TOKEN, PORT: "3200", NODE_ENV: "production", REALM_PYTHON: PYTHON },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", (chunk) => serverLog.push(String(chunk)));
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const port = /localhost:(\d+)/.exec(serverLog.join(""))?.[1];
    if (port) {
      base = `http://127.0.0.1:${port}`;
      try {
        if ((await fetch(`${base}/api/world/v1/health`)).ok) return;
      } catch {
        // not up yet
      }
    }
    if (server.exitCode !== null) throw new Error("the server exited during startup");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("the server did not become ready in 90 seconds");
}

function stopServer() {
  if (!server?.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else server.kill("SIGKILL");
}

/* ── Requests ────────────────────────────────────────────────────────────────────────── */

interface Answer {
  status: number;
  json: Record<string, any> | null;
  headers: Headers;
}

async function converse(body: unknown, key: string | null = TOKEN): Promise<Answer> {
  const res = await fetch(`${base}/api/world/v1/converse`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "X-World-Key": key } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json, headers: res.headers };
}

const sayTo = (npcId: string, line: string, actorId = "1") => converse({ npcId, actorId, line });
const takeModelCalls = () => {
  const taken = modelCalls;
  modelCalls = [];
  return taken;
};

/* ── The checks ──────────────────────────────────────────────────────────────────────── */

async function run() {
  const modelPort = await listen(fakeModel);
  buildWorld();
  console.log(`starting the real server (this takes a few seconds)...`);
  await startServer(modelPort);
  console.log(`server ready at ${base}; project ${PROJECT}\n`);

  const capabilities = (await (await fetch(`${base}/api/world/v1/capabilities`)).json()) as Record<string, any>;
  check("capabilities report conversation as enabled", capabilities.conversation?.enabled === true && capabilities.conversation?.maxLineLength === 400);

  // ---- who may ask
  check("no world key is refused", (await converse({ npcId: "npc_culbertson_docent", actorId: "1", line: "Hi" }, null)).status === 401);
  check("a wrong world key is refused", (await converse({ npcId: "npc_culbertson_docent", actorId: "1", line: "Hi" }, "not-the-key-not-the-key-not-the-key-xx")).status === 401);
  check("a refused request never reaches the model", takeModelCalls().length === 0);

  // ---- the model is down: the character answers from the record
  modelMode = { kind: "down" };
  const offline = await sayTo("npc_culbertson_docent", "Who built the hall?");
  check("with the model down, the docent still answers", offline.status === 200 && offline.json?.source === "offline", JSON.stringify(offline.json));
  check("the offline reply is the character's opener and the place's own record",
    String(offline.json?.text).startsWith("Mind the staircase, and welcome.") && String(offline.json?.text).includes("raised in 1901"));
  check("the answer names the character and the place's record",
    offline.json?.npc?.name === "Odalys Marlowe" && offline.json?.place?.name === "Test Mansion" && offline.json?.place?.record === "OFFICIAL_SOURCE" && offline.json?.place?.doNotVisit === false);
  const downCalls = takeModelCalls().length;
  check("a model that is down is tried once and not retried", downCalls === 1 && offline.json?.rejected === 0, `calls ${downCalls}, rejected ${offline.json?.rejected}`);

  // ---- a good model reply is used, and the prompt is built from the record
  modelMode = { kind: "reply", text: "It was raised in 1901 by a travelling joiner." };
  const line = "Who built the hall? XYZZY-line";
  const spoken = await sayTo("npc_culbertson_docent", line);
  const [call] = takeModelCalls();
  check("a model reply that follows the rules is shown as the model's", spoken.status === 200 && spoken.json?.source === "model" && spoken.json?.text === "It was raised in 1901 by a travelling joiner.", JSON.stringify(spoken.json));
  // The layout is the Realm project's (realm/narration.py build_messages): a short system message and a
  // greeting exchange, then the record, the rules and the traveller's words together in the final user message.
  const messages = call?.messages ?? [];
  const briefing = messages.at(-1)?.content ?? "";
  check("the model was sent the place's verified history and its record strength", briefing.includes(MANSION.facts) && briefing.includes("Record strength: Official Source"));
  check("the docent, who knows the legend, was given it as an attributed legend", briefing.includes(MANSION.legend) && briefing.includes("always attribute it"));
  check("the traveller's words went only in the user message", messages.at(-1)?.role === "user" && briefing.includes(`The traveller says: ${line}`) && !messages.slice(0, -1).some((message) => message.content.includes("XYZZY-line")));
  check("the configured model name was passed along", call?.model === "test-model");

  // ---- a reply that breaks the rules never reaches the traveller
  modelMode = { kind: "reply", text: "It was raised in 1875 by a famous general." };
  const invented = await sayTo("npc_culbertson_docent", "Who built it?");
  const inventedCalls = takeModelCalls();
  check("an invented date is thrown away and the record is used", invented.json?.source === "offline" && invented.json?.rejected === 2 && !String(invented.json?.text).includes("1875"), JSON.stringify(invented.json));
  check("the model was asked a second time, with the reason", inventedCalls.length === 2 && String(inventedCalls[1].messages.at(-1)?.content).includes("broke these rules"));

  modelMode = { kind: "reply", text: "A pale lantern drifts slowly past the old hall every autumn night." };
  const legend = await sayTo("npc_culbertson_docent", "Is it haunted?");
  takeModelCalls();
  check("a legend told as fact is thrown away", legend.json?.source === "offline" && legend.json?.rejected === 2);

  modelMode = { kind: "reply", text: "They say a pale lantern drifts slowly past the old hall every autumn night." };
  const attributed = await sayTo("npc_culbertson_docent", "Is it haunted?");
  takeModelCalls();
  check("the same legend, attributed, is allowed", attributed.json?.source === "model" && attributed.json?.rejected === 0);

  // ---- the do-not-visit place
  modelMode = { kind: "reply", text: "The bore opened in 1881 and runs 4000 feet." };
  const tunnel = await sayTo("npc_duncan_brakeman", "How long is it?", "2");
  takeModelCalls();
  check("a reply with no safety note at a rail site is rejected", tunnel.json?.source === "offline" && tunnel.json?.rejected === 2);
  check("the replacement tells the traveller to keep clear", /keep clear/i.test(String(tunnel.json?.text)) && tunnel.json?.place?.doNotVisit === true);
  modelMode = { kind: "reply", text: "The bore opened in 1881 and runs 4000 feet. Stay clear of it, friend." };
  const careful = await sayTo("npc_duncan_brakeman", "How long is it?", "2");
  takeModelCalls();
  check("a reply that carries the safety note is allowed", careful.json?.source === "model");

  // ---- the scene decides who may speak
  modelMode = { kind: "reply", text: "Good day." };
  const elsewhere = await sayTo("npc_town_clock_sexton", "Hello");
  check("a character in another room is refused", elsewhere.status === 409 && elsewhere.json?.code === "not_here");
  check("an unknown character is refused", (await sayTo("npc_nobody", "Hello")).status === 404);
  check("an unknown player is refused", (await sayTo("npc_culbertson_docent", "Hello", "99")).status === 404);
  check("a path-like character id is refused", (await sayTo("../../etc/passwd", "Hello")).status === 400);
  check("a line over 400 characters is refused", (await sayTo("npc_culbertson_docent", "x".repeat(401))).status === 400);
  check("refusals never reach the model", takeModelCalls().length === 0);
  setRuntime(true);
  const fighting = await sayTo("npc_culbertson_docent", "Hello");
  check("no one talks in the middle of a fight", fighting.status === 409 && fighting.json?.code === "in_combat");
  setRuntime(false);
  check("and they talk again afterwards", (await sayTo("npc_culbertson_docent", "Hello")).status === 200);
  takeModelCalls();

  // ---- at most two at once
  modelMode = { kind: "reply", text: "It was raised in 1901 by a travelling joiner.", delayMs: 2000 };
  const burst = await Promise.all([1, 2, 3].map(() => sayTo("npc_culbertson_docent", "Who built it?")));
  const statuses = burst.map((answer) => answer.status).sort();
  check("three simultaneous conversations: two run, one is told to wait", JSON.stringify(statuses) === "[200,200,429]", JSON.stringify(statuses));
  const waiting = burst.find((answer) => answer.status === 429);
  check("the one told to wait is given a retry time", waiting?.headers.get("retry-after") === "3" && waiting?.json?.code === "busy");
  takeModelCalls();
  modelMode = { kind: "reply", text: "It was raised in 1901 by a travelling joiner." };
  check("the slots are free again afterwards", (await sayTo("npc_culbertson_docent", "Who built it?")).status === 200);
  takeModelCalls();

  // ---- memory: off by default, then on
  check("by default nothing is remembered", memoriesOf("npc_culbertson_docent").length === 0 && spoken.json?.remembered === false);
  writeConfig(modelPort, true);
  const secret = "XYZZY-secret-question";
  const remembered = await sayTo("npc_culbertson_docent", `Who built the hall? ${secret}`);
  takeModelCalls();
  check("with the memory switch on, the answer says it was remembered", remembered.status === 200 && remembered.json?.remembered === true);
  const stored = memoriesOf("npc_culbertson_docent");
  check("one memory was stored, in the character's own words and the traveller's name", stored.length === 1 && stored[0].text.startsWith("Spoke with Ashra. I said: ") && stored[0].text.includes("1901"), JSON.stringify(stored));
  check("the traveller's own words were not stored", !stored.some((memory) => memory.text.includes(secret)));
  await sayTo("npc_culbertson_docent", "And again?");
  const [followUp] = takeModelCalls();
  check("the next prompt carries the memory as a note, not an instruction",
    String(followUp?.messages?.at(-1)?.content).includes("NOTES ABOUT THIS TRAVELLER") && String(followUp.messages.at(-1)?.content).includes("Spoke with Ashra."));
}

try {
  await run();
} catch (error) {
  failures++;
  console.log(`[ FAIL ] the integration run stopped early: ${(error as Error).message}`);
}
stopServer();
fakeModel.close();
fakeModel.closeAllConnections?.();
try {
  fs.rmSync(work, { recursive: true, force: true });
} catch {
  // a Windows file lock may delay cleanup; the folder is in the system temp directory
}
if (failures > 0) {
  console.log(`\nlast server output:\n${serverLog.join("").split(/\r?\n/).slice(-15).join("\n")}`);
  console.log(`\n─── ${failures} check(s) FAILED ───`);
  process.exit(1);
}
console.log("\n─── all integration checks passed ───");
process.exit(0);
