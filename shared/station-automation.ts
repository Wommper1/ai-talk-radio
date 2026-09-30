export type MonitorSeverity = "info" | "warning" | "error" | "recovered";

export interface StationMonitorEvent {
  id: string;
  at: string;
  severity: MonitorSeverity;
  component: "station" | "model" | "speech" | "storage" | "scheduler" | "playout" | "backup";
  message: string;
}

export interface ScheduleSlot {
  id: string;
  enabled: boolean;
  name: string;
  topic: string;
  /** Local station time, 24-hour HH:MM. */
  time: string;
  /** JavaScript weekday numbers: Sunday 0 through Saturday 6. */
  days: number[];
  turns?: number;
  lastRunKey?: string;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastShowId?: string;
  lastError?: string;
  retryAt?: string;
  retryCount?: number;
}

export interface PlayoutState {
  enabled: boolean;
  autoFallback: boolean;
  queue: string[];
  current?: { showId: string; startedAt: string; fallback: boolean };
  history: Array<{ showId: string; startedAt: string; finishedAt: string; fallback: boolean }>;
}

export interface AutomationSettings {
  enabled: boolean;
  monitorEnabled: boolean;
  retryMinutes: number;
  dailyBackup: boolean;
  slots: ScheduleSlot[];
  playout: PlayoutState;
}

export interface PlayoutItem {
  id: string;
  title: string;
  duration: number;
  createdAt: string;
  audioUrl: string;
  streamingReady: boolean | null;
  fallback: boolean;
}

export interface AutomationStatus {
  leader: boolean;
  generatedAt: string;
  settings: AutomationSettings;
  queue: PlayoutItem[];
  current: PlayoutItem | null;
  fallbackCount: number;
  events: StationMonitorEvent[];
}

export interface BackupSummary {
  id: string;
  createdAt: string;
  kind: "state" | "full" | "safety";
  bytes: number;
  fileCount: number;
  appVersion: number;
}

export const AUTOMATION_FORMAT = 1;

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  enabled: false,
  monitorEnabled: true,
  retryMinutes: 10,
  dailyBackup: true,
  slots: [],
  playout: {
    enabled: false,
    autoFallback: true,
    queue: [],
    history: [],
  },
};

export function safeAutomationId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,100}$/i.test(value) && !value.includes("..");
}

export function validStationTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function stationDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function slotRunKey(slot: Pick<ScheduleSlot, "id">, date: Date): string {
  return `${slot.id}:${stationDateKey(date)}`;
}

export function scheduleSlotDue(slot: ScheduleSlot, now: Date): boolean {
  if (!slot.enabled || !validStationTime(slot.time) || !slot.days.includes(now.getDay())) return false;
  const [hour, minute] = slot.time.split(":").map(Number);
  if (now.getHours() !== hour || now.getMinutes() !== minute) return false;
  return slot.lastRunKey !== slotRunKey(slot, now);
}

export function normalizeScheduleSlot(raw: Partial<ScheduleSlot>): ScheduleSlot {
  const days = Array.from(new Set((Array.isArray(raw.days) ? raw.days : [0, 1, 2, 3, 4, 5, 6])
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))).sort();
  return {
    id: safeAutomationId(String(raw.id ?? "")) ? String(raw.id) : `slot-${Date.now().toString(36)}`,
    enabled: raw.enabled !== false,
    name: String(raw.name ?? "Scheduled show").trim().slice(0, 80) || "Scheduled show",
    topic: String(raw.topic ?? "").trim().slice(0, 500),
    time: validStationTime(String(raw.time ?? "")) ? String(raw.time) : "09:00",
    days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
    turns: raw.turns === undefined ? undefined : Math.max(4, Math.min(60, Math.round(Number(raw.turns) || 12))),
    lastRunKey: raw.lastRunKey,
    lastStartedAt: raw.lastStartedAt,
    lastFinishedAt: raw.lastFinishedAt,
    lastShowId: raw.lastShowId,
    lastError: raw.lastError,
    retryAt: raw.retryAt,
    retryCount: Math.max(0, Math.min(3, Math.round(Number(raw.retryCount) || 0))),
  };
}
