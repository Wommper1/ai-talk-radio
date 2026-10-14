/**
 * Talking with the lore-pack characters at the player's place.
 *
 * POST /api/world/v1/converse. Read-only on the world: it never moves anyone and
 * never writes a canonical event (the client records the deed with the ordinary
 * `talk` command). The words themselves come from the Southern Indiana Realm
 * project's narration module, run as one short script per turn, which asks the
 * local model, checks its reply against that place's record, and falls back to
 * the record when the model is down or breaks the rules.
 *
 * This module owns the checks a client must not be trusted with: the request's
 * shape, that the character really is in the traveller's room, that nobody is
 * mid-fight, and a cap on how many turns run at once. It reads the world
 * read-only and writes nothing except, when `orion.converse.remember` is on, one
 * memory line in the character's own words (done inside the script).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Config } from "../config.ts";
import { parseLoreConfidence, readRealm, resolveRealm, type LoreConfidence, type Realm } from "./realm.ts";
import { WORLD_CONTRACT } from "./world-contract.ts";

export const CONVERSE_MAX_LINE = 400;
const MAX_REPLY_CHARS = 800;
const MAX_IN_FLIGHT = 2;
const TURN_TIMEOUT_MS = 60_000;
const NPC_ID = /^[a-z][a-z0-9_]{0,63}$/;

export class ConverseError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ConverseRequest {
  npcId: string;
  actorId: string;
  line: string;
}

export interface ConverseResult {
  contract: typeof WORLD_CONTRACT;
  npc: { id: string; name: string; occupation: string };
  place: { name: string; record: LoreConfidence; doNotVisit: boolean };
  text: string;
  /** "model" if the local model's reply passed the rules, otherwise "offline" (from the record). */
  source: "model" | "offline";
  /** How many model replies were thrown away for breaking the rules. */
  rejected: number;
  remembered: boolean;
}

export interface RunnerInput {
  python: string;
  script: string;
  cwd: string;
  request: Record<string, unknown>;
  timeoutMs: number;
}

/** Runs the script with the request on stdin and returns what it printed. */
export type ConverseRunner = (input: RunnerInput) => Promise<string>;

export function parseConverseRequest(body: unknown): ConverseRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ConverseError("A JSON object is required.", "invalid_request", 400);
  }
  const input = body as Record<string, unknown>;
  const npcId = typeof input.npcId === "string" ? input.npcId.trim() : "";
  if (!NPC_ID.test(npcId)) {
    throw new ConverseError("npcId must be a character id.", "invalid_request", 400);
  }
  const actorId = typeof input.actorId === "string" ? input.actorId.trim() : "";
  if (!actorId || actorId.length > 128) {
    throw new ConverseError("actorId is required.", "invalid_request", 400);
  }
  if (typeof input.line !== "string") {
    throw new ConverseError("line must be text.", "invalid_request", 400);
  }
  // eslint-disable-next-line no-control-regex
  const line = input.line.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (line.length > CONVERSE_MAX_LINE) {
    throw new ConverseError(`line must be ${CONVERSE_MAX_LINE} characters or fewer.`, "invalid_request", 400);
  }
  return { npcId, actorId, line };
}

function placeKey(name: string): string {
  return name.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "");
}

/** The traveller and the character, or the reason they cannot speak. */
export function checkScene(realm: Realm, request: ConverseRequest) {
  if (realm.stateSource !== "discord") {
    throw new ConverseError("There is no active party to speak for.", "no_active_party", 409);
  }
  const actor = realm.guild.find((member) => member.id === request.actorId);
  if (!actor) throw new ConverseError("That player is not in the active party.", "actor_not_found", 404);
  if (actor.fallen) throw new ConverseError(`${actor.name} must revive before speaking.`, "actor_fallen", 409);
  if (realm.save?.inCombat) {
    throw new ConverseError("No one will talk in the middle of a fight.", "in_combat", 409);
  }
  const npc = realm.npcs.find((candidate) => candidate.id === request.npcId);
  if (!npc) throw new ConverseError("There is no such character.", "npc_not_found", 404);
  if (npc.status !== "alive") throw new ConverseError("That character cannot answer.", "npc_unavailable", 409);
  if (!actor.location || placeKey(actor.location) !== placeKey(npc.location)) {
    throw new ConverseError("That character is not here.", "not_here", 409);
  }
  return { actor, npc };
}

let inFlight = 0;

function pythonFor(projectPath: string): string {
  const configured = String(process.env.REALM_PYTHON ?? "").trim();
  if (configured) return configured;
  const candidates = [
    path.join(projectPath, ".venv", "Scripts", "python.exe"),
    path.join(projectPath, ".venv", "bin", "python"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "python";
}

export const spawnRunner: ConverseRunner = (input) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(input.python, ["-I", input.script], {
      cwd: input.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new ConverseError("The conversation timed out.", "engine_timeout", 504));
    }, input.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 100_000) child.kill();
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new ConverseError("The conversation script could not start.", "engine_unavailable", 503));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        reject(new ConverseError("The conversation script failed.", "engine_failed", 500));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin.end(JSON.stringify(input.request));
  });

const SCRIPT_FAILURE_STATUS: Record<string, number> = {
  bad_request: 400,
  unknown_npc: 404,
  unknown_place: 409,
  world_unreadable: 503,
  content_unreadable: 503,
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Turn the script's printed JSON into a result, trusting none of it. */
export function interpretAnswer(printed: string): ConverseResult {
  let answer: Record<string, unknown>;
  try {
    const lastLine = printed.split(/\r?\n/).filter((line) => line.trim()).pop() ?? "";
    answer = JSON.parse(lastLine) as Record<string, unknown>;
  } catch {
    throw new ConverseError("The conversation script gave an unreadable answer.", "bad_engine_answer", 502);
  }
  if (!answer || typeof answer !== "object") {
    throw new ConverseError("The conversation script gave an unreadable answer.", "bad_engine_answer", 502);
  }
  if (answer.ok !== true) {
    const code = str(answer.code) || "engine_failed";
    throw new ConverseError(str(answer.message) || "The conversation could not be held.", code, SCRIPT_FAILURE_STATUS[code] ?? 502);
  }
  const npc = (answer.npc ?? {}) as Record<string, unknown>;
  const place = (answer.place ?? {}) as Record<string, unknown>;
  const text = str(answer.text).trim().slice(0, MAX_REPLY_CHARS);
  const source = answer.source === "model" ? "model" : answer.source === "offline" ? "offline" : "";
  if (!text || !source || !str(npc.id) || !str(npc.name) || !str(place.name)) {
    throw new ConverseError("The conversation script gave an incomplete answer.", "bad_engine_answer", 502);
  }
  return {
    contract: WORLD_CONTRACT,
    npc: { id: str(npc.id), name: str(npc.name), occupation: str(npc.occupation) },
    place: { name: str(place.name), record: parseLoreConfidence(place.record), doNotVisit: place.doNotVisit !== false },
    text,
    source,
    rejected: Math.max(0, Math.min(10, Math.floor(Number(answer.rejected) || 0))),
    remembered: answer.remembered === true,
  };
}

export interface ConverseDeps {
  runner?: ConverseRunner;
  read?: typeof readRealm;
}

export async function converse(config: Config, body: unknown, deps: ConverseDeps = {}): Promise<ConverseResult> {
  const request = parseConverseRequest(body);

  const projectPath = config.orion.converse.projectPath;
  if (!projectPath) {
    throw new ConverseError("Conversation is not set up on this server.", "not_configured", 501);
  }
  const script = path.join(projectPath, "tools", "converse.py");
  if (!fs.existsSync(script)) {
    throw new ConverseError("Conversation is not set up on this server.", "not_configured", 501);
  }
  const root = resolveRealm(config.orion.realmPath);
  if (!root) throw new ConverseError("The realm database is unavailable.", "realm_unavailable", 503);

  const realm = (deps.read ?? readRealm)(config.orion.realmPath, 1);
  const { actor } = checkScene(realm, request);

  if (inFlight >= MAX_IN_FLIGHT) {
    throw new ConverseError("Too many conversations are in progress.", "busy", 429, { retryAfterSeconds: 3 });
  }
  inFlight++;
  try {
    const llm = config.llm;
    const timeoutSeconds = Math.max(5, Math.min(30, Number(llm.timeoutSeconds) || 20));
    const printed = await (deps.runner ?? spawnRunner)({
      python: pythonFor(projectPath),
      script,
      cwd: projectPath,
      timeoutMs: TURN_TIMEOUT_MS,
      request: {
        db: path.join(root, "world.db"),
        npcId: request.npcId,
        line: request.line,
        // Gemini is not an OpenAI-style local server; answer from the record instead.
        offline: llm.provider === "gemini",
        baseUrl: llm.baseUrl,
        model: llm.model,
        timeout: timeoutSeconds,
        remember: config.orion.converse.remember === true,
        player: actor.name,
      },
    });
    return interpretAnswer(printed);
  } finally {
    inFlight--;
  }
}
