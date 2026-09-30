import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clock3,
  Download,
  FolderOpen,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import type { AutomationStatus, BackupSummary, Config, PlayoutItem, StationStatus } from "../types";
import { api, formatBytes, formatDate, formatTime } from "../lib/api";
import { Button, Callout, Input, Panel, Select, Toggle } from "./ui";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Operations({ config }: { config: Config }) {
  const [status, setStatus] = useState<StationStatus | null>(null);
  const [automation, setAutomation] = useState<AutomationStatus | null>(null);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [slotName, setSlotName] = useState("Daily show");
  const [slotTopic, setSlotTopic] = useState("");
  const [slotTime, setSlotTime] = useState("09:00");
  const [slotDays, setSlotDays] = useState("daily");
  const [slotTurns, setSlotTurns] = useState(config.show.turns);
  const [broadcasting, setBroadcasting] = useState(false);
  const [onAir, setOnAir] = useState<PlayoutItem | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const [nextStatus, nextAutomation, backupResult] = await Promise.all([
        api.stationStatus(config),
        api.automation(),
        api.listBackups(),
      ]);
      setStatus(nextStatus);
      setAutomation(nextAutomation);
      setBackups(backupResult.backups);
      setOnAir(nextAutomation.current);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !broadcasting || !onAir) return;
    audio.src = onAir.audioUrl;
    void audio.play().catch(() => {
      setError("The browser blocked station audio. Press Start broadcast again to grant playback permission.");
      setBroadcasting(false);
    });
  }, [broadcasting, onAir?.id]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveAutomation = (patch: Parameters<typeof api.saveAutomation>[0]) => run(async () => {
    setAutomation(await api.saveAutomation(patch));
  });

  const addSlot = () => run(async () => {
    const days = slotDays === "weekdays" ? [1, 2, 3, 4, 5] : slotDays === "weekends" ? [0, 6] : [0, 1, 2, 3, 4, 5, 6];
    const result = await api.saveScheduleSlot({
      enabled: true,
      name: slotName,
      topic: slotTopic,
      time: slotTime,
      days,
      turns: slotTurns,
    });
    setAutomation(result.status);
    setSlotTopic("");
    setNotice(`Scheduled “${result.slot.name}” at ${result.slot.time}.`);
  });

  const startBroadcast = () => run(async () => {
    if (!automation) return;
    const updated = await api.saveAutomation({
      playout: { ...automation.settings.playout, enabled: true },
    });
    setAutomation(updated);
    const { item } = await api.nextPlayout();
    if (!item) {
      setAutomation(await api.automation());
      throw new Error("Nothing is queued and no measured streaming-ready fallback is available.");
    }
    setOnAir(item);
    setBroadcasting(true);
    setNotice(item.fallback ? "Fallback programming is on air." : "Continuous playout started.");
  });

  const stopBroadcast = () => run(async () => {
    if (!automation) return;
    audioRef.current?.pause();
    setBroadcasting(false);
    const updated = await api.saveAutomation({
      playout: { ...automation.settings.playout, enabled: false },
    });
    setAutomation(updated);
    setNotice("Playout paused. The current program is retained for resume.");
  });

  const advancePlayout = () => run(async () => {
    await api.completePlayout();
    const { item } = await api.nextPlayout();
    setOnAir(item);
    setAutomation(await api.automation());
    if (!item) {
      setBroadcasting(false);
      setError("Playout ended because no queued or fallback program is available.");
    }
  });

  const createBackup = (kind: "state" | "full") => run(async () => {
    const result = await api.createBackup(kind);
    setBackups(result.backups);
    setNotice(`${kind === "full" ? "Full archive" : "Station state"} backup created: ${result.backup.id}`);
  });

  const restoreBackup = (backup: BackupSummary) => run(async () => {
    const confirmed = window.prompt(
      `Restore ${backup.id}? A safety snapshot will be created first. Type the complete backup id to continue.`,
    );
    if (confirmed !== backup.id) return;
    await api.restoreBackup(backup.id);
    setNotice("Backup restored. Restart Local Talk Radio before producing another show.");
    await refresh();
  });

  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-5 py-6">
      <audio ref={audioRef} preload="auto" onEnded={() => void advancePlayout()} onError={() => setError("The current program audio could not be played.")} />

      <Panel
        title="Station operations"
        subtitle="Preflight, scheduling, continuous output, recovery, and backups in one control room."
        right={
          <Button size="sm" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
            {busy ? "Working" : "Refresh"}
          </Button>
        }
      >
        {error && <Callout tone="error">{error}</Callout>}
        {notice && <Callout tone="good">{notice}</Callout>}
        {!status && !error && <p className="text-sm text-[var(--color-mute)]">Reading the station…</p>}
        {status && (
          <Callout
            tone={status.ready ? "good" : "error"}
            title={status.ready ? "Ready for production" : "A blocker must be fixed before production"}
          >
            Warnings are recommendations; blockers prevent a new show from starting.
          </Callout>
        )}
      </Panel>

      {status && automation && (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Metric label="Model" value={status.model.ok ? "Online" : "Blocked"} detail={status.model.selected} />
            <Metric label="Voices" value={`${status.speech.voices}`} detail={status.speech.engine} />
            <Metric label="Disk free" value={gb(status.storage.freeBytes)} detail={`${status.storage.showCount} finished shows`} />
            <Metric label="Automation" value={automation.settings.enabled ? "Armed" : "Manual"} detail={automation.leader ? "This server is the controller" : "Another app instance owns the clock"} />
          </div>

          <Panel title="Program clock" subtitle="The server starts these productions even when the browser is closed.">
            <div className="grid gap-3 lg:grid-cols-2">
              <Toggle
                label="Enable unattended productions"
                hint="Only enabled schedule slots run. A blocker postpones the show and retries it safely."
                checked={automation.settings.enabled}
                onChange={(enabled) => void saveAutomation({ enabled })}
              />
              <Toggle
                label="Daily station-state backup"
                hint="Creates one lightweight snapshot after 3 AM without copying the large show masters."
                checked={automation.settings.dailyBackup}
                onChange={(dailyBackup) => void saveAutomation({ dailyBackup })}
              />
            </div>

            <div className="mt-4 grid gap-3 rounded-xl border border-[var(--color-line)] bg-black/10 p-4 md:grid-cols-2 xl:grid-cols-5">
              <Input value={slotName} onChange={(event) => setSlotName(event.target.value)} placeholder="Show name" />
              <Input value={slotTopic} onChange={(event) => setSlotTopic(event.target.value)} placeholder="Topic or standing brief" />
              <Input type="time" value={slotTime} onChange={(event) => setSlotTime(event.target.value)} />
              <Select value={slotDays} onChange={(event) => setSlotDays(event.target.value)}>
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekends">Weekends</option>
              </Select>
              <div className="flex gap-2">
                <Input className="min-w-0" type="number" min={4} max={60} value={slotTurns} onChange={(event) => setSlotTurns(Number(event.target.value))} title="Turns" />
                <Button variant="primary" onClick={() => void addSlot()} disabled={busy || !slotTopic.trim()}>
                  <Plus size={14} /> Add
                </Button>
              </div>
            </div>

            <div className="mt-4 divide-y divide-[var(--color-line)]">
              {automation.settings.slots.length === 0 && <p className="py-3 text-sm text-[var(--color-mute)]">No scheduled shows yet.</p>}
              {automation.settings.slots.map((slot) => (
                <div key={slot.id} className="grid gap-3 py-3 md:grid-cols-[auto_minmax(0,1fr)_auto_auto] md:items-center">
                  <Clock3 size={15} className="text-[var(--color-amber)]" />
                  <div>
                    <div className="text-sm font-medium text-white">{slot.name} · {slot.time}</div>
                    <div className="text-xs text-[var(--color-mute)]">{slot.days.map((day) => DAY_NAMES[day]).join(" ")} · {slot.turns ?? config.show.turns} turns · {slot.topic}</div>
                    {slot.lastError && <div className="mt-1 text-xs text-red-300">{slot.lastError}</div>}
                    {slot.lastShowId && <div className="mt-1 text-xs text-emerald-300">Last completed: {slot.lastShowId}</div>}
                  </div>
                  <Button size="sm" onClick={() => void run(async () => {
                    const result = await api.saveScheduleSlot({ ...slot, enabled: !slot.enabled });
                    setAutomation(result.status);
                  })}>{slot.enabled ? "Enabled" : "Paused"}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void run(async () => setAutomation(await api.deleteScheduleSlot(slot.id)))}>
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
            </div>
          </Panel>

          <Panel
            title="Continuous playout"
            subtitle="Runs through the browser audio device for a mixer or OBS. The M3U link can be opened by VLC or external playout software."
            right={
              <a className="inline-flex items-center gap-1.5 text-xs text-[var(--color-amber)] hover:underline" href="/api/playout/listen.m3u" download="local-talk-radio.m3u">
                <Download size={13} /> M3U
              </a>
            }
          >
            <div className="grid gap-3 md:grid-cols-2">
              <Toggle
                label="Automatic emergency fallback"
                hint={`${automation.fallbackCount} measured streaming-ready shows are available if the queue runs dry.`}
                checked={automation.settings.playout.autoFallback}
                onChange={(autoFallback) => void saveAutomation({ playout: { ...automation.settings.playout, autoFallback } })}
              />
              <div className="flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3">
                {broadcasting ? (
                  <Button variant="danger" onClick={() => void stopBroadcast()} disabled={busy}><Pause size={14} /> Pause broadcast</Button>
                ) : (
                  <Button variant="primary" onClick={() => void startBroadcast()} disabled={busy}><Play size={14} /> Start broadcast</Button>
                )}
                <div className="min-w-0 text-xs text-[var(--color-mute)]">
                  {onAir ? <><span className="block truncate text-white">{onAir.title}</span>{onAir.fallback ? "Emergency fallback" : "Queued program"}</> : "Nothing on air"}
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-5 lg:grid-cols-2">
              <div>
                <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-dim)]">Waiting queue</div>
                {automation.queue.length === 0 ? <p className="text-sm text-[var(--color-mute)]">The queue is empty; fallback will take over if enabled.</p> : (
                  <div className="divide-y divide-[var(--color-line)]">
                    {automation.queue.map((item, index) => (
                      <div key={`${item.id}-${index}`} className="flex items-center gap-3 py-2">
                        <span className="w-5 font-mono text-xs text-[var(--color-mute)]">{index + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-sm text-white">{item.title}</span>
                        <span className="text-xs text-[var(--color-mute)]">{formatTime(item.duration)}</span>
                        <Button size="sm" variant="ghost" onClick={() => void run(async () => setAutomation(await api.removeQueuedShow(item.id)))}><Trash2 size={12} /></Button>
                      </div>
                    ))}
                  </div>
                )}
                {automation.queue.length > 0 && <Button className="mt-3" size="sm" variant="ghost" onClick={() => void run(async () => setAutomation(await api.clearPlayoutQueue()))}>Clear waiting queue</Button>}
              </div>
              <div>
                <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-dim)]">Add recent program</div>
                <div className="divide-y divide-[var(--color-line)]">
                  {status.recentShows.map((show) => (
                    <div key={show.id} className="flex items-center gap-3 py-2">
                      <span className="min-w-0 flex-1 truncate text-sm text-white">{show.title}</span>
                      <span className="text-xs text-[var(--color-mute)]">{formatTime(show.duration)}</span>
                      <Button size="sm" onClick={() => void run(async () => setAutomation(await api.enqueueShow(show.id)))}><Plus size={12} /> Queue</Button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Panel>

          <Panel title="Backup and restore" subtitle="State backups protect settings and station memory; full archives also include shows and music.">
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void createBackup("state")} disabled={busy}>Back up station state</Button>
              <Button onClick={() => void createBackup("full")} disabled={busy}>Create full archive</Button>
              <Button variant="ghost" onClick={() => void api.revealBackups()}><FolderOpen size={14} /> Open backup folder</Button>
            </div>
            <div className="mt-4 divide-y divide-[var(--color-line)]">
              {backups.length === 0 && <p className="py-3 text-sm text-[var(--color-mute)]">No backups yet.</p>}
              {backups.slice(0, 8).map((backup) => (
                <div key={backup.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                  <div>
                    <div className="truncate font-mono text-xs text-white">{backup.id}</div>
                    <div className="text-xs text-[var(--color-mute)]">{new Date(backup.createdAt).toLocaleString()} · {backup.kind} · {backup.fileCount} files</div>
                  </div>
                  <span className="font-mono text-xs text-[var(--color-dim)]">{formatBytes(backup.bytes)}</span>
                  <Button size="sm" variant="danger" onClick={() => void restoreBackup(backup)} disabled={busy}>Restore</Button>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Preflight checks" subtitle={`Updated ${new Date(status.generatedAt).toLocaleTimeString()}`}>
            <div className="divide-y divide-[var(--color-line)]">
              {status.checks.map((check) => (
                <div key={check.id} className="flex gap-3 py-3">
                  {check.status === "pass" ? <Check size={16} className="mt-0.5 shrink-0 text-emerald-400" /> : check.status === "blocker" ? <ShieldAlert size={16} className="mt-0.5 shrink-0 text-red-400" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--color-amber)]" />}
                  <div><div className="text-sm font-medium text-white">{check.label}</div><div className="mt-0.5 text-xs leading-relaxed text-[var(--color-mute)]">{check.detail}</div></div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Unattended event history" subtitle="Transitions, failures, recoveries, backups, and playout changes are retained across restarts.">
            <div className="divide-y divide-[var(--color-line)]">
              {automation.events.length === 0 && <p className="py-3 text-sm text-[var(--color-mute)]">No automation events yet.</p>}
              {automation.events.slice(0, 30).map((event) => (
                <div key={event.id} className="grid gap-1 py-2 sm:grid-cols-[110px_80px_minmax(0,1fr)]">
                  <span className="font-mono text-[11px] text-[var(--color-mute)]">{new Date(event.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  <span className={`text-[10px] font-bold uppercase tracking-wide ${event.severity === "error" ? "text-red-400" : event.severity === "warning" ? "text-[var(--color-amber)]" : event.severity === "recovered" ? "text-emerald-400" : "text-[var(--color-dim)]"}`}>{event.component}</span>
                  <span className="text-xs text-[var(--color-dim)]">{event.message}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Recent masters" subtitle="New shows retain their measured LUFS-I and true peak.">
            <div className="divide-y divide-[var(--color-line)]">
              {status.recentShows.map((show) => (
                <div key={show.id} className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-5">
                  <div><div className="truncate text-sm font-medium text-white">{show.title}</div><div className="text-xs text-[var(--color-mute)]">{formatDate(show.createdAt)} · {formatTime(show.duration)}</div></div>
                  <div className="font-mono text-xs text-[var(--color-dim)]">{show.integratedLufs === null ? "legacy master" : `${show.integratedLufs.toFixed(1)} LUFS-I`}</div>
                  <div className="font-mono text-xs text-[var(--color-dim)]">{show.truePeakDbtp === null ? "—" : `${show.truePeakDbtp.toFixed(1)} dBTP`}</div>
                </div>
              ))}
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4">
      <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--color-mute)]">{label}</div>
      <div className="mt-2 text-xl font-semibold text-white">{value}</div>
      <div className="mt-1 truncate text-xs text-[var(--color-dim)]">{detail}</div>
    </div>
  );
}
