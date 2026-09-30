import type {
  AdFile,
  CallerRecord,
  Config,
  DjFeedback,
  DjRating,
  DjTrainingReadiness,
  LibrarySpot,
  Realm,
  MemoryStats,
  ModelInfo,
  Options,
  ProbeResult,
  Show,
  ShowDraft,
  ShowFiles,
  StorageSummary,
  StationStatus,
  AutomationSettings,
  AutomationStatus,
  BackupSummary,
  PlayoutItem,
  ScheduleSlot,
  Voice,
} from "../types";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      message = body.error ?? message;
    } catch {
      /* keep the status message */
    }
    throw new Error(message);
  }

  return (await res.json()) as T;
}

export const api = {
  getConfig: () => json<{ config: Config; configPath: string; defaults: Config }>("/api/config"),

  saveConfig: (config: Config) =>
    json<{ config: Config }>("/api/config", { method: "PUT", body: JSON.stringify(config) }),

  resetConfig: () => json<{ config: Config }>("/api/config/reset", { method: "POST" }),

  getOptions: () => json<Options>("/api/options"),

  checkLlm: (config: Config) =>
    json<ProbeResult<ModelInfo>>("/api/check/llm", { method: "POST", body: JSON.stringify(config) }),

  checkTts: (config: Config) =>
    json<ProbeResult<Voice>>("/api/check/tts", { method: "POST", body: JSON.stringify(config) }),

  stationStatus: (config: Config) =>
    json<StationStatus>("/api/station/status", { method: "POST", body: JSON.stringify({ config }) }),

  automation: () => json<AutomationStatus>("/api/automation"),

  saveAutomation: (settings: Partial<AutomationSettings>) =>
    json<AutomationStatus>("/api/automation", { method: "PUT", body: JSON.stringify(settings) }),

  saveScheduleSlot: (slot: Partial<ScheduleSlot>) =>
    json<{ slot: ScheduleSlot; status: AutomationStatus }>("/api/automation/slots", {
      method: "POST",
      body: JSON.stringify(slot),
    }),

  deleteScheduleSlot: (id: string) =>
    json<AutomationStatus>(`/api/automation/slots/${encodeURIComponent(id)}`, { method: "DELETE" }),

  enqueueShow: (id: string) =>
    json<AutomationStatus>(`/api/playout/queue/${encodeURIComponent(id)}`, { method: "POST" }),

  removeQueuedShow: (id: string) =>
    json<AutomationStatus>(`/api/playout/queue/${encodeURIComponent(id)}`, { method: "DELETE" }),

  clearPlayoutQueue: () => json<AutomationStatus>("/api/playout/queue", { method: "DELETE" }),

  nextPlayout: () => json<{ item: PlayoutItem | null }>("/api/playout/next", { method: "POST" }),

  completePlayout: () => json<AutomationStatus>("/api/playout/complete", { method: "POST" }),

  listBackups: () => json<{ backups: BackupSummary[] }>("/api/backups"),

  createBackup: (kind: "state" | "full") =>
    json<{ backup: BackupSummary; backups: BackupSummary[] }>("/api/backups", {
      method: "POST",
      body: JSON.stringify({ kind }),
    }),

  restoreBackup: (id: string) =>
    json<{ backup: BackupSummary; restartRequired: boolean }>(`/api/backups/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      body: JSON.stringify({ confirm: id }),
    }),

  revealBackups: () => json<{ ok: true; path: string }>("/api/backups/reveal", { method: "POST" }),

  listShows: () => json<Show[]>("/api/shows"),

  listDrafts: () => json<ShowDraft[]>("/api/drafts"),

  recoverDraft: (id: string) => json<Show>(`/api/drafts/${id}/recover`, { method: "POST" }),

  deleteDraft: (id: string) => json<{ ok: true }>(`/api/drafts/${id}`, { method: "DELETE" }),

  getShow: (id: string) => json<Show>(`/api/shows/${id}`),

  getDjFeedback: (id: string) =>
    json<{ feedback: DjFeedback[] }>(`/api/shows/${id}/dj-feedback`),

  rateDjLine: (id: string, lineIndex: number, rating: DjRating, tags: string[] = []) =>
    json<{ feedback: DjFeedback }>(`/api/shows/${id}/dj-feedback/${lineIndex}`, {
      method: "POST",
      body: JSON.stringify({ rating, tags }),
    }),

  getDjTrainingReadiness: () =>
    json<{ feedback: DjFeedback[]; readiness: DjTrainingReadiness }>("/api/dj/feedback"),

  deleteShow: (id: string) => json<{ ok: true }>(`/api/shows/${id}`, { method: "DELETE" }),

  cancel: (jobId: string) => json<{ ok: true }>(`/api/cancel/${jobId}`, { method: "POST" }),

  callIn: (jobId: string, name: string, text: string) =>
    json<{ queued: number }>(`/api/call-in/${jobId}`, { method: "POST", body: JSON.stringify({ name, text }) }),

  listCallers: () => json<{ callers: CallerRecord[]; briefing: string }>("/api/callers"),

  listAdLibrary: () => json<{ spots: LibrarySpot[] }>("/api/ads/library"),

  getRealm: () => json<Realm>("/api/orion"),

  forgetChronicle: (ids: number[]) =>
    json<{ removed: number }>(`/api/orion/chronicle?ids=${ids.join(",")}`, { method: "DELETE" }),

  clearAdLibrary: (id?: string) =>
    json<{ ok: true; spots: LibrarySpot[] }>(
      `/api/ads/library${id ? `?id=${encodeURIComponent(id)}` : ""}`,
      { method: "DELETE" },
    ),

  forgetCaller: (name?: string) =>
    json<{ ok: true; callers: CallerRecord[] }>(
      `/api/callers${name ? `?name=${encodeURIComponent(name)}` : ""}`,
      { method: "DELETE" },
    ),

  storage: () => json<StorageSummary>("/api/storage"),

  memory: () => json<MemoryStats>("/api/memory"),

  rebuildMemory: () =>
    json<{ backend: string; shows: number; passages: number; error?: string }>("/api/memory/rebuild", {
      method: "POST",
    }),

  clearMemory: () => json<{ ok: true }>("/api/memory/clear", { method: "POST" }),

  searchMemory: (query: string, config: Config) =>
    json<{ results: Array<{ showTitle: string; date: string; text: string; score: number }> }>(
      "/api/memory/search",
      { method: "POST", body: JSON.stringify({ query, config }) },
    ),

  showFiles: (id: string) => json<ShowFiles>(`/api/shows/${id}/files`),

  pruneShow: (id: string) => json<{ freedBytes: number }>(`/api/shows/${id}/prune`, { method: "POST" }),

  clearScratch: () => json<{ freedBytes: number }>("/api/storage/clear-scratch", { method: "POST" }),

  revealShow: (id: string) => json<{ ok: true; path: string }>(`/api/shows/${id}/reveal`, { method: "POST" }),

  adFiles: () => json<{ dir: string; files: AdFile[] }>("/api/ads/files"),

  deleteAdFile: (name: string) =>
    json<{ ok: true; files: AdFile[] }>(`/api/ads/files/${encodeURIComponent(name)}`, { method: "DELETE" }),

  revealAds: () => json<{ ok: true; path: string }>("/api/ads/reveal", { method: "POST" }),

  /** Send one of your own spots to the drop folder. */
  async uploadAd(file: File): Promise<{ name: string; bytes: number; files: AdFile[] }> {
    const res = await fetch(`/api/ads/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as { name: string; bytes: number; files: AdFile[] };
  },

  songFiles: () => json<{ dir: string; files: AdFile[] }>("/api/music/files"),

  deleteSongFile: (name: string) =>
    json<{ ok: true; files: AdFile[] }>(`/api/music/files/${encodeURIComponent(name)}`, { method: "DELETE" }),

  revealMusic: () => json<{ ok: true; path: string }>("/api/music/reveal", { method: "POST" }),

  /** Put a record in the music folder. Same raw-body upload as a spot. */
  async uploadSong(file: File): Promise<{ name: string; bytes: number; files: AdFile[] }> {
    const res = await fetch(`/api/music/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as { name: string; bytes: number; files: AdFile[] };
  },

  /** Build one break and return an object URL for it. Caller revokes it. */
  async previewBreak(config: Config, topic?: string): Promise<{ url: string; label: string }> {
    const res = await fetch("/api/ads/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, topic }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error([body.error, body.hint].filter(Boolean).join(" — "));
    }

    const label = decodeURIComponent(res.headers.get("X-Break-Label") ?? "Commercial break");
    return { url: URL.createObjectURL(await res.blob()), label };
  },

  /** Audition the station opener. Caller revokes the object URL. */
  async previewColdOpen(config: Config, topic?: string): Promise<string> {
    const res = await fetch("/api/ads/preview-open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, topic }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error([body.error, body.hint].filter(Boolean).join(" — "));
    }
    return URL.createObjectURL(await res.blob());
  },

  /** Returns an object URL for the rendered preview clip. Caller revokes it. */
  async previewVoice(config: Config, hostIndex: 0 | 1, text?: string): Promise<string> {
    const res = await fetch("/api/preview-voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, hostIndex, text }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error([body.error, body.hint].filter(Boolean).join(" — "));
    }

    return URL.createObjectURL(await res.blob());
  },
};

export interface GenerateEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * POST to the generate endpoint and yield decoded SSE events.
 * The stream is a POST body, so EventSource cannot be used here.
 */
export async function* generateStream(
  body: unknown,
  signal: AbortSignal,
): AsyncGenerator<GenerateEvent> {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error([err.error ?? `HTTP ${res.status}`, err.hint].filter(Boolean).join(" "));
  }
  if (!res.body) throw new Error("The server returned no stream.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue; // skip ": ping" heartbeats

        const payload = trimmed.slice(5).trim();
        if (!payload) continue;

        try {
          yield JSON.parse(payload) as GenerateEvent;
        } catch {
          // Partial frame; the next chunk completes it.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : value >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}
