import { useCallback, useEffect, useState } from "react";
import { FolderOpen, RefreshCw, Trash2, Scissors, HardDrive, Play, Download, ChevronRight } from "lucide-react";
import type { ShowFiles, StorageSummary } from "../types";
import { api, formatBytes, formatDate } from "../lib/api";
import { Button, Callout, Panel } from "./ui";

interface Props {
  onOpenShow: (id: string) => void;
}

export function Files({ onOpenShow }: Props) {
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [files, setFiles] = useState<ShowFiles | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSummary(await api.storage());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      setFiles(null);
      return;
    }
    setExpanded(id);
    setFiles(null);
    try {
      setFiles(await api.showFiles(id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const act = async (label: string, fn: () => Promise<{ freedBytes?: number } | unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = (await fn()) as { freedBytes?: number };
      setMessage(
        typeof result?.freedBytes === "number"
          ? `${label} — freed ${formatBytes(result.freedBytes)}`
          : `${label} — done`,
      );
      await refresh();
      if (expanded) setFiles(await api.showFiles(expanded).catch(() => null));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !summary) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-10">
        <Callout tone="error">{error}</Callout>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="px-5 py-16 text-center font-mono text-sm text-[var(--color-mute)]">Reading disk…</div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-5 py-6">
      <Panel
        title="Storage"
        subtitle={summary.root}
        right={
          <Button size="sm" onClick={() => void refresh()}>
            <RefreshCw size={13} />
            Refresh
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-4">
          <Stat label="Shows" value={String(summary.showCount)} />
          <Stat label="Files" value={String(summary.fileCount)} />
          <Stat label="Shows on disk" value={formatBytes(summary.totalBytes)} />
          <Stat label="Working files" value={formatBytes(summary.scratchBytes)} />
        </div>

        {summary.scratchBytes > 1_000_000 && (
          <div className="mt-4">
            <Callout tone="info">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  {formatBytes(summary.scratchBytes)} of live clips, previews and test renders. These are
                  regenerated as needed and safe to delete.
                </span>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void act("Cleared working files", () => api.clearScratch())}
                >
                  <Trash2 size={13} />
                  Clear
                </Button>
              </div>
            </Callout>
          </div>
        )}

        {message && (
          <p className="mt-3 font-mono text-xs text-[var(--color-good)]">{message}</p>
        )}
        {error && <p className="mt-3 font-mono text-xs text-[var(--color-live)]">{error}</p>}
      </Panel>

      <Panel title={`Shows (${summary.shows.length})`}>
        {summary.shows.length === 0 ? (
          <p className="text-sm text-[var(--color-mute)]">Nothing recorded yet.</p>
        ) : (
          <div className="divide-y divide-[var(--color-line)]">
            {summary.shows.map((show) => {
              const open = expanded === show.id;
              return (
                <div key={show.id} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      onClick={() => void toggle(show.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      aria-expanded={open}
                    >
                      <ChevronRight
                        size={14}
                        className={`shrink-0 text-[var(--color-mute)] transition-transform ${open ? "rotate-90" : ""}`}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-[#e8e8ee]">{show.title}</span>
                        <span className="block font-mono text-[10px] text-[var(--color-mute)]">
                          {formatDate(show.createdAt)} · {show.hasAudio ? "audio" : "transcript only"}
                        </span>
                      </span>
                    </button>

                    <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--color-amber)]">
                      {formatBytes(show.bytes)}
                    </span>

                    <div className="flex shrink-0 gap-1">
                      <Button size="sm" variant="ghost" onClick={() => onOpenShow(show.id)} title="Open in player">
                        <Play size={13} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Show the folder on disk"
                        onClick={() => void act("Opened folder", () => api.revealShow(show.id))}
                      >
                        <FolderOpen size={13} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Delete the per-turn clips, keep the finished show"
                        disabled={busy}
                        onClick={() => void act("Pruned clips", () => api.pruneShow(show.id))}
                      >
                        <Scissors size={13} />
                      </Button>
                    </div>
                  </div>

                  {open && (
                    <div className="mt-2 ml-6 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3">
                      {!files ? (
                        <p className="font-mono text-xs text-[var(--color-mute)]">Reading…</p>
                      ) : (
                        <ul className="space-y-1">
                          {files.files.map((f) => (
                            <li key={f.path} className="flex items-center gap-3 font-mono text-xs">
                              <a
                                href={`/api/shows/${show.id}/file/${f.path}`}
                                target="_blank"
                                rel="noreferrer"
                                className="min-w-0 flex-1 truncate text-[var(--color-cyan)] underline-offset-2 hover:underline"
                              >
                                {f.path}
                              </a>
                              <span className="shrink-0 tabular-nums text-[var(--color-mute)]">
                                {formatBytes(f.bytes)}
                              </span>
                              <a
                                href={`/api/shows/${show.id}/file/${f.path}`}
                                download
                                className="shrink-0 text-[var(--color-mute)] hover:text-white"
                                title="Download"
                              >
                                <Download size={12} />
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <p className="flex items-center gap-2 font-mono text-[11px] text-[var(--color-mute)]">
        <HardDrive size={12} />
        Each show is a plain folder. Copy it to back it up; delete it to remove it.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[var(--color-mute)]">{label}</div>
      <div className="mt-1 font-mono text-lg text-[#e8e8ee]">{value}</div>
    </div>
  );
}
