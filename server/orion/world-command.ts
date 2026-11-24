import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRealm } from "./realm.ts";

export const WORLD_COMMAND_TYPES = [
  "travel",
  "attack",
  "defend",
  "flee",
  "hunt",
  "use",
  "equip",
  "buy",
  "sell",
  "talk",
  "investigate",
  "help",
  "crime",
  "rest",
  "revive",
] as const;

export type WorldCommandType = (typeof WORLD_COMMAND_TYPES)[number];

export interface WorldCommand {
  id: string;
  actorId: string;
  type: WorldCommandType;
  expectedRevision: number;
  payload: Record<string, unknown>;
}

export interface WorldCommandResult {
  ok: boolean;
  duplicate: boolean;
  commandId: string;
  campaignId: string;
  revision: number;
  action: WorldCommandType;
  message: string;
  combat: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  error?: string;
  code?: string;
}

export class WorldCommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * The station folder. Normally two levels above this file; in the portable build everything is bundled into one
 * file at the top of the folder, so the working directory (which the launcher sets) is used when it holds the bridge.
 */
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT = fs.existsSync(path.join(process.cwd(), "scripts", "world_command_bridge.py")) ? process.cwd() : MODULE_ROOT;
const BRIDGE = path.join(ROOT, "scripts", "world_command_bridge.py");
export const WORLD_TOKEN_FILE = path.join(ROOT, "data", "world_api_token.txt");

function secureToken(): string {
  return randomBytes(32).toString("base64url");
}

export function ensureWorldApiToken(): string {
  const fromEnvironment = String(process.env.WORLD_API_TOKEN ?? "").trim();
  if (fromEnvironment) return fromEnvironment;

  fs.mkdirSync(path.dirname(WORLD_TOKEN_FILE), { recursive: true });
  try {
    fs.writeFileSync(WORLD_TOKEN_FILE, `${secureToken()}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const token = fs.readFileSync(WORLD_TOKEN_FILE, "utf8").trim();
  if (token.length < 32) throw new Error("The world API token file is invalid.");
  return token;
}

export function isAuthorizedWorldCommand(candidate: unknown): boolean {
  const supplied = Buffer.from(String(candidate ?? ""));
  const expected = Buffer.from(ensureWorldApiToken());
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function cleanString(value: unknown, name: string, maxLength = 160): string {
  const result = String(value ?? "").trim();
  if (!result) throw new WorldCommandError(`${name} is required.`, "invalid_command", 400);
  if (result.length > maxLength) {
    throw new WorldCommandError(`${name} is too long.`, "invalid_command", 400);
  }
  return result;
}

export function parseWorldCommand(body: unknown, headerId = ""): WorldCommand {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new WorldCommandError("A JSON command object is required.", "invalid_command", 400);
  }
  const input = body as Record<string, unknown>;
  const id = cleanString(input.id ?? headerId, "Command id", 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(id)) {
    throw new WorldCommandError("Command id must be 8-128 safe characters.", "invalid_command", 400);
  }
  const actorId = cleanString(input.actorId, "Actor id", 128);
  const type = cleanString(input.type, "Command type", 40) as WorldCommandType;
  if (!WORLD_COMMAND_TYPES.includes(type)) {
    throw new WorldCommandError(`Unsupported command type: ${type}`, "invalid_command", 400);
  }
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new WorldCommandError("expectedRevision must be a non-negative integer.", "invalid_command", 400);
  }
  const payload = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
    ? input.payload as Record<string, unknown>
    : {};
  if (JSON.stringify(payload).length > 4_000) {
    throw new WorldCommandError("Command payload is too large.", "invalid_command", 400);
  }
  return { id, actorId, type, expectedRevision, payload };
}

function pythonFor(root: string): string {
  const configured = String(process.env.REALM_PYTHON ?? "").trim();
  if (configured) return configured;
  const candidates = [
    path.join(root, ".venv", "Scripts", "python.exe"),
    path.join(root, "venv", "Scripts", "python.exe"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "python";
}

export async function executeWorldCommand(
  configuredRealm: string,
  command: WorldCommand,
  options: { dbPath?: string; timeoutMs?: number } = {},
): Promise<WorldCommandResult> {
  const realmRoot = resolveRealm(configuredRealm);
  if (!realmRoot) {
    throw new WorldCommandError("King Orion's realm database is unavailable.", "realm_unavailable", 503);
  }

  const request = JSON.stringify({
    realmRoot,
    dbPath: options.dbPath || path.join(realmRoot, "world.db"),
    command,
  });

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(pythonFor(realmRoot), [BRIDGE], {
      cwd: realmRoot,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new WorldCommandError("The world engine timed out.", "engine_timeout", 504));
    }, options.timeoutMs ?? 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) child.kill();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new WorldCommandError(`The world engine could not start: ${error.message}`, "engine_unavailable", 503));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        reject(new WorldCommandError(stderr.trim() || `World engine exited with code ${code}.`, "engine_failed", 500));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin.end(request);
  });

  let result: WorldCommandResult;
  try {
    result = JSON.parse(output) as WorldCommandResult;
  } catch {
    throw new WorldCommandError("The world engine returned an invalid response.", "engine_failed", 500, { output });
  }
  if (!result.ok) {
    const status = result.code === "revision_conflict" ? 409
      : result.code === "actor_not_found" ? 404
        : result.code === "command_busy" ? 423
          : 400;
    throw new WorldCommandError(result.error || result.message, result.code || "command_failed", status, {
      revision: result.revision,
      commandId: result.commandId,
    });
  }
  return result;
}
