import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../lib/atomic-file.ts";
import { loadConfig, type Config } from "../config.ts";
import { listShows, readShow, type StoredShow } from "../pipeline/store.ts";
import {
  AUTOMATION_FORMAT,
  DEFAULT_AUTOMATION_SETTINGS,
  nextRetryState,
  normalizeScheduleSlot,
  safeAutomationId,
  scheduleSlotDue,
  slotRunKey,
  stationDateKey,
  type AutomationSettings,
  type AutomationStatus,
  type BackupSummary,
  type MonitorSeverity,
  type PlayoutItem,
  type ScheduleSlot,
  type StationMonitorEvent,
} from "../../shared/station-automation.ts";

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_PATH = path.join(DATA_DIR, "station-automation.json");
const LOCK_PATH = path.join(DATA_DIR, "station-automation.lock");
export const BACKUPS_DIR = path.join(process.cwd(), "backups");
const MAX_EVENTS = 250;
const MAX_HISTORY = 100;

interface PersistedState {
  format: number;
  settings: AutomationSettings;
  events: StationMonitorEvent[];
  lastDailyBackup?: string;
  lastHealthSignature?: string;
}

interface BackupManifest extends BackupSummary {
  items: string[];
}

let state: PersistedState = loadState();
let leader = false;
let baseUrl = "";
let timer: NodeJS.Timeout | null = null;
let monitorBusy = false;
let lastMonitorAt = 0;
const runningSlots = new Set<string>();

function cloneDefaults(): AutomationSettings {
  return JSON.parse(JSON.stringify(DEFAULT_AUTOMATION_SETTINGS)) as AutomationSettings;
}

function normalizeSettings(raw: Partial<AutomationSettings> | undefined): AutomationSettings {
  const defaults = cloneDefaults();
  const playout = raw?.playout;
  return {
    enabled: raw?.enabled === true,
    monitorEnabled: raw?.monitorEnabled !== false,
    retryMinutes: Math.max(1, Math.min(120, Math.round(Number(raw?.retryMinutes) || defaults.retryMinutes))),
    dailyBackup: raw?.dailyBackup !== false,
    slots: (Array.isArray(raw?.slots) ? raw.slots : []).map(normalizeScheduleSlot),
    playout: {
      enabled: playout?.enabled === true,
      autoFallback: playout?.autoFallback !== false,
      queue: (Array.isArray(playout?.queue) ? playout.queue : []).map(String).filter(safeAutomationId),
      current: playout?.current && safeAutomationId(String(playout.current.showId))
        ? {
            showId: String(playout.current.showId),
            startedAt: String(playout.current.startedAt || new Date().toISOString()),
            fallback: playout.current.fallback === true,
          }
        : undefined,
      history: (Array.isArray(playout?.history) ? playout.history : []).slice(-MAX_HISTORY).flatMap((item) =>
        item && safeAutomationId(String(item.showId))
          ? [{
              showId: String(item.showId),
              startedAt: String(item.startedAt || ""),
              finishedAt: String(item.finishedAt || ""),
              fallback: item.fallback === true,
            }]
          : [],
      ),
    },
  };
}

function loadState(): PersistedState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Partial<PersistedState>;
    return {
      format: AUTOMATION_FORMAT,
      settings: normalizeSettings(raw.settings),
      events: Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS) : [],
      lastDailyBackup: raw.lastDailyBackup,
      lastHealthSignature: raw.lastHealthSignature,
    };
  } catch {
    return { format: AUTOMATION_FORMAT, settings: cloneDefaults(), events: [] };
  }
}

function saveState(): void {
  atomicWriteJson(STATE_PATH, state);
}

function eventId(): string {
  return `event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function recordStationEvent(
  severity: MonitorSeverity,
  component: StationMonitorEvent["component"],
  message: string,
): StationMonitorEvent {
  const entry: StationMonitorEvent = {
    id: eventId(),
    at: new Date().toISOString(),
    severity,
    component,
    message: message.trim().slice(0, 1000),
  };
  state.events = [...state.events.slice(-(MAX_EVENTS - 1)), entry];
  saveState();
  return entry;
}

function showItem(show: StoredShow, fallback: boolean): PlayoutItem | null {
  if (!show.hasAudio || !show.audioUrl) return null;
  return {
    id: show.id,
    title: show.title,
    duration: show.duration,
    createdAt: show.createdAt,
    audioUrl: show.audioUrl,
    streamingReady: show.audioAnalysis?.streamingReady ?? null,
    fallback,
  };
}

function queuedItems(): PlayoutItem[] {
  return state.settings.playout.queue.flatMap((id) => {
    const show = readShow(id);
    const item = show ? showItem(show, false) : null;
    return item ? [item] : [];
  });
}

function fallbackCandidates(): StoredShow[] {
  const history = new Set(state.settings.playout.history.slice(-12).map((item) => item.showId));
  const queued = new Set(state.settings.playout.queue);
  return listShows()
    .filter((show) => show.hasAudio && show.audioAnalysis?.streamingReady === true && !queued.has(show.id))
    .sort((a, b) => Number(history.has(a.id)) - Number(history.has(b.id)) || b.createdAt.localeCompare(a.createdAt));
}

export function fallbackPlayoutItems(limit = 20): PlayoutItem[] {
  return fallbackCandidates().slice(0, Math.max(0, limit)).flatMap((show) => {
    const item = showItem(show, true);
    return item ? [item] : [];
  });
}

export function automationStatus(): AutomationStatus {
  const currentShow = state.settings.playout.current ? readShow(state.settings.playout.current.showId) : null;
  return {
    leader,
    generatedAt: new Date().toISOString(),
    settings: JSON.parse(JSON.stringify(state.settings)) as AutomationSettings,
    queue: queuedItems(),
    current: currentShow ? showItem(currentShow, state.settings.playout.current?.fallback === true) : null,
    fallbackCount: fallbackCandidates().length,
    events: [...state.events].reverse().slice(0, 80),
  };
}

export function updateAutomationSettings(raw: Partial<AutomationSettings>): AutomationStatus {
  state.settings = normalizeSettings({
    ...state.settings,
    ...raw,
    slots: raw.slots ?? state.settings.slots,
    playout: { ...state.settings.playout, ...(raw.playout ?? {}) },
  });
  saveState();
  return automationStatus();
}

export function upsertScheduleSlot(raw: Partial<ScheduleSlot>): ScheduleSlot {
  const slot = normalizeScheduleSlot(raw);
  if (!slot.topic) throw new Error("A scheduled show needs a topic.");
  const at = state.settings.slots.findIndex((item) => item.id === slot.id);
  if (at >= 0) state.settings.slots[at] = { ...state.settings.slots[at], ...slot };
  else state.settings.slots.push(slot);
  saveState();
  recordStationEvent("info", "scheduler", `${at >= 0 ? "Updated" : "Added"} ${slot.name} at ${slot.time}.`);
  return slot;
}

export function removeScheduleSlot(id: string): boolean {
  if (!safeAutomationId(id)) return false;
  const before = state.settings.slots.length;
  state.settings.slots = state.settings.slots.filter((slot) => slot.id !== id);
  if (state.settings.slots.length === before) return false;
  saveState();
  recordStationEvent("info", "scheduler", `Removed schedule slot ${id}.`);
  return true;
}

export function enqueueShow(id: string): AutomationStatus {
  const show = readShow(id);
  if (!show?.hasAudio) throw new Error("Only a finished show with audio can enter playout.");
  if (!state.settings.playout.queue.includes(id) && state.settings.playout.current?.showId !== id) {
    state.settings.playout.queue.push(id);
    saveState();
    recordStationEvent("info", "playout", `Queued “${show.title}”.`);
  }
  return automationStatus();
}

export function removeQueuedShow(id: string): AutomationStatus {
  state.settings.playout.queue = state.settings.playout.queue.filter((item) => item !== id);
  saveState();
  return automationStatus();
}

export function clearPlayoutQueue(): AutomationStatus {
  state.settings.playout.queue = [];
  saveState();
  recordStationEvent("info", "playout", "Cleared the waiting playout queue.");
  return automationStatus();
}

export function nextPlayoutItem(): PlayoutItem | null {
  const playout = state.settings.playout;
  if (!playout.enabled) return null;
  if (playout.current) {
    const show = readShow(playout.current.showId);
    const item = show ? showItem(show, playout.current.fallback) : null;
    if (item) return item;
    playout.current = undefined;
    saveState();
  }

  let id = playout.queue.shift();
  let fallback = false;
  while (id && !readShow(id)?.hasAudio) id = playout.queue.shift();
  if (!id && playout.autoFallback) {
    id = fallbackCandidates()[0]?.id;
    fallback = Boolean(id);
  }
  if (!id) {
    saveState();
    recordStationEvent("warning", "playout", "Playout has no queued show and no streaming-ready fallback.");
    return null;
  }

  const show = readShow(id);
  if (!show) return null;
  playout.current = { showId: id, startedAt: new Date().toISOString(), fallback };
  saveState();
  recordStationEvent(fallback ? "warning" : "info", "playout", `${fallback ? "Fallback started" : "Now playing"}: “${show.title}”.`);
  return showItem(show, fallback);
}

export function completePlayoutItem(): AutomationStatus {
  const current = state.settings.playout.current;
  if (current) {
    const show = readShow(current.showId);
    state.settings.playout.history.push({
      showId: current.showId,
      startedAt: current.startedAt,
      finishedAt: new Date().toISOString(),
      fallback: current.fallback,
    });
    state.settings.playout.history = state.settings.playout.history.slice(-MAX_HISTORY);
    state.settings.playout.current = undefined;
    saveState();
    recordStationEvent("info", "playout", `Finished ${show ? `“${show.title}”` : current.showId}.`);
  }
  return automationStatus();
}

function walkStats(target: string): { bytes: number; fileCount: number } {
  if (!fs.existsSync(target)) return { bytes: 0, fileCount: 0 };
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return { bytes: stat.size, fileCount: 1 };
  return fs.readdirSync(target).reduce(
    (total, entry) => {
      const nested = walkStats(path.join(target, entry));
      return { bytes: total.bytes + nested.bytes, fileCount: total.fileCount + nested.fileCount };
    },
    { bytes: 0, fileCount: 0 },
  );
}

function backupItems(kind: BackupSummary["kind"]): string[] {
  const stateItems = ["config.json", "data", "memory", "commercials", "ads", "openers"];
  return kind === "full" ? [...stateItems, "shows", "music"] : stateItems;
}

function copyItem(relative: string, destinationRoot: string): void {
  const source = path.resolve(process.cwd(), relative);
  const workspace = path.resolve(process.cwd());
  if (!(source === workspace || source.startsWith(`${workspace}${path.sep}`)) || !fs.existsSync(source)) return;
  const destination = path.join(destinationRoot, relative);
  const stat = fs.statSync(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (stat.isDirectory()) {
    fs.cpSync(source, destination, {
      recursive: true,
      force: true,
      filter: (item) => path.resolve(item) !== path.resolve(LOCK_PATH) && !path.resolve(item).startsWith(path.resolve(BACKUPS_DIR)),
    });
  } else {
    fs.copyFileSync(source, destination);
  }
}

export function createStationBackup(kind: BackupSummary["kind"] = "state"): BackupSummary {
  const createdAt = new Date().toISOString();
  const id = `backup-${createdAt.replace(/[:.]/g, "-")}-${kind}`;
  const root = path.join(BACKUPS_DIR, id);
  const snapshot = path.join(root, "snapshot");
  fs.mkdirSync(snapshot, { recursive: true });
  const items = backupItems(kind);
  for (const item of items) copyItem(item, snapshot);
  const totals = walkStats(snapshot);
  const manifest: BackupManifest = { id, createdAt, kind, ...totals, appVersion: AUTOMATION_FORMAT, items };
  atomicWriteJson(path.join(root, "manifest.json"), manifest);
  recordStationEvent("info", "backup", `Created ${kind} backup ${id} (${totals.fileCount} files).`);
  return manifest;
}

export function listStationBackups(): BackupSummary[] {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  return fs.readdirSync(BACKUPS_DIR, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || !safeAutomationId(entry.name)) return [];
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(BACKUPS_DIR, entry.name, "manifest.json"), "utf8")) as BackupManifest;
      return [{
        id: manifest.id,
        createdAt: manifest.createdAt,
        kind: manifest.kind,
        bytes: manifest.bytes,
        fileCount: manifest.fileCount,
        appVersion: manifest.appVersion,
      }];
    } catch {
      return [];
    }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function restoreStationBackup(id: string): BackupSummary {
  if (!safeAutomationId(id)) throw new Error("Invalid backup id.");
  const root = path.join(BACKUPS_DIR, id);
  const manifestPath = path.join(root, "manifest.json");
  const snapshot = path.join(root, "snapshot");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(snapshot)) throw new Error("Backup not found.");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
  createStationBackup("safety");
  for (const item of manifest.items) {
    const source = path.join(snapshot, item);
    if (!fs.existsSync(source)) continue;
    const destination = path.resolve(process.cwd(), item);
    const workspace = path.resolve(process.cwd());
    if (!(destination === workspace || destination.startsWith(`${workspace}${path.sep}`))) continue;
    const stat = fs.statSync(source);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (stat.isDirectory()) fs.cpSync(source, destination, { recursive: true, force: true });
    else fs.copyFileSync(source, destination);
  }
  state = loadState();
  recordStationEvent("recovered", "backup", `Restored ${id}; a safety backup was created first.`);
  return manifest;
}

function acquireLeader(): boolean {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const existing = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as { pid?: number };
    if (existing.pid && existing.pid !== process.pid) {
      try {
        process.kill(existing.pid, 0);
        return false;
      } catch {
        // Stale lock from a process that no longer exists.
      }
    }
  } catch {
    // No readable lock.
  }
  atomicWriteJson(LOCK_PATH, { pid: process.pid, startedAt: new Date().toISOString() });
  return true;
}

async function readSseCompletion(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new Error(`Generation returned HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let showId = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const event = JSON.parse(trimmed.slice(5).trim()) as { type?: string; message?: string; hint?: string; show?: { id?: string } };
      if (event.type === "done") showId = String(event.show?.id ?? "");
      if (event.type === "error") throw new Error([event.message, event.hint].filter(Boolean).join(" — "));
      if (event.type === "cancelled") throw new Error("Scheduled production was cancelled.");
    }
  }
  if (!showId) throw new Error("Scheduled production ended without a finished show.");
  return showId;
}

async function runSlot(slotId: string, retry = false): Promise<void> {
  if (runningSlots.has(slotId)) return;
  const slot = state.settings.slots.find((item) => item.id === slotId);
  if (!slot || !state.settings.enabled) return;
  runningSlots.add(slotId);
  const now = new Date();
  slot.lastRunKey ??= slotRunKey(slot, now);
  slot.lastStartedAt = now.toISOString();
  slot.lastError = undefined;
  slot.retryAt = undefined;
  saveState();
  recordStationEvent("info", "scheduler", `${retry ? "Retrying" : "Starting"} “${slot.name}”.`);
  try {
    const configResponse = await fetch(`${baseUrl}/api/config`);
    if (!configResponse.ok) throw new Error(`Could not read station config (HTTP ${configResponse.status}).`);
    const config = ((await configResponse.json()) as { config: Config }).config;
    const scheduledConfig: Config = slot.turns
      ? { ...config, show: { ...config.show, turns: slot.turns } }
      : config;
    const statusResponse = await fetch(`${baseUrl}/api/station/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: scheduledConfig }),
    });
    if (!statusResponse.ok) throw new Error(`Preflight returned HTTP ${statusResponse.status}.`);
    const status = (await statusResponse.json()) as { checks: Array<{ status: string; label: string; detail: string }> };
    const blockers = status.checks.filter((check) => check.status === "blocker");
    if (blockers.length) throw new Error(blockers.map((check) => `${check.label}: ${check.detail}`).join("; "));

    const jobId = `scheduled-${slot.id}-${Date.now().toString(36)}`;
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: slot.topic, sources: [], sourceText: "", config: scheduledConfig, jobId }),
    });
    const showId = await readSseCompletion(response);
    slot.lastFinishedAt = new Date().toISOString();
    slot.lastShowId = showId;
    slot.lastError = undefined;
    slot.retryAt = undefined;
    slot.retryCount = 0;
    if (!state.settings.playout.queue.includes(showId)) state.settings.playout.queue.push(showId);
    saveState();
    recordStationEvent("recovered", "scheduler", `Finished “${slot.name}” and queued ${showId} for playout.`);
  } catch (error) {
    const message = (error as Error).message || "Scheduled production failed.";
    slot.lastError = message;
    const next = nextRetryState(slot.retryCount, retry, state.settings.retryMinutes, new Date());
    slot.retryCount = next.retryCount;
    slot.retryAt = next.retryAt;
    saveState();
    recordStationEvent("error", "scheduler", `${slot.name} failed: ${message}${slot.retryAt ? ` Retrying at ${new Date(slot.retryAt).toLocaleTimeString()}.` : " Retry limit reached; fallback playout remains available."}`);
  } finally {
    runningSlots.delete(slotId);
  }
}

async function monitorStation(): Promise<void> {
  if (!state.settings.monitorEnabled || monitorBusy) return;
  monitorBusy = true;
  try {
    const config = loadConfig();
    const response = await fetch(`${baseUrl}/api/station/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    });
    if (!response.ok) throw new Error(`Health probe returned HTTP ${response.status}.`);
    const status = (await response.json()) as { ready: boolean; checks: Array<{ status: string; label: string; detail: string }> };
    const problems = status.checks.filter((check) => check.status !== "pass");
    const signature = JSON.stringify(problems.map((check) => [check.status, check.label, check.detail]));
    if (signature !== state.lastHealthSignature) {
      if (status.ready && problems.length === 0) {
        recordStationEvent(state.lastHealthSignature ? "recovered" : "info", "station", "All unattended station checks pass.");
      } else {
        recordStationEvent(status.ready ? "warning" : "error", "station", problems.map((check) => `${check.label}: ${check.detail}`).join(" "));
      }
      state.lastHealthSignature = signature;
      saveState();
    }
  } catch (error) {
    const signature = `probe:${(error as Error).message}`;
    if (signature !== state.lastHealthSignature) {
      recordStationEvent("error", "station", `Unattended health probe failed: ${(error as Error).message}`);
      state.lastHealthSignature = signature;
      saveState();
    }
  } finally {
    monitorBusy = false;
  }
}

async function tick(): Promise<void> {
  if (!leader) return;
  const now = new Date();
  for (const slot of state.settings.slots) {
    if (scheduleSlotDue(slot, now)) {
      slot.lastRunKey = slotRunKey(slot, now);
      saveState();
      void runSlot(slot.id);
    } else if (slot.enabled && slot.retryAt && new Date(slot.retryAt).getTime() <= now.getTime()) {
      void runSlot(slot.id, true);
    }
  }

  if (state.settings.dailyBackup) {
    const today = stationDateKey(now);
    if (state.lastDailyBackup !== today && now.getHours() >= 3) {
      try {
        createStationBackup("state");
        state.lastDailyBackup = today;
        saveState();
      } catch (error) {
        recordStationEvent("error", "backup", `Daily backup failed: ${(error as Error).message}`);
      }
    }
  }
}

export function startStationAutomation(url: string): void {
  baseUrl = url.replace(/\/$/, "");
  leader = acquireLeader();
  if (!leader) {
    console.log("  Station automation is already owned by another local server process.");
    return;
  }
  recordStationEvent("info", "station", "Unattended station services started.");
  void monitorStation();
  lastMonitorAt = Date.now();
  void tick();
  timer = setInterval(() => {
    void tick();
    if (Date.now() - lastMonitorAt >= 5 * 60_000) {
      lastMonitorAt = Date.now();
      void monitorStation();
    }
  }, 30_000);

  const release = () => {
    if (timer) clearInterval(timer);
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as { pid?: number };
      if (lock.pid === process.pid) fs.rmSync(LOCK_PATH, { force: true });
    } catch {
      // Process shutdown must continue even if the lock is already gone.
    }
  };
  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    release();
    process.exit(0);
  });
}
