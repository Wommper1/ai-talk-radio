import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, SkipBack, SkipForward, ArrowLeft, Download, Trash2, FileText, ThumbsDown, ThumbsUp } from "lucide-react";
import type { DjFeedback, DjRating, Show, TranscriptLine } from "../types";
import { api, formatDate, formatTime } from "../lib/api";
import { Button, Panel } from "./ui";

interface Props {
  show: Show;
  onBack: () => void;
  onDelete: (show: Show) => void;
}

export function Player({ show, onBack, onDelete }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(show.duration || 0);
  const [rate, setRate] = useState(1);
  const [feedback, setFeedback] = useState<Record<number, DjFeedback>>({});

  // Reset transport state when a different show is opened.
  useEffect(() => {
    setPlaying(false);
    setTime(0);
    setDuration(show.duration || 0);
  }, [show.id, show.duration]);

  useEffect(() => {
    let current = true;
    setFeedback({});
    void api.getDjFeedback(show.id).then(({ feedback: rows }) => {
      if (!current) return;
      setFeedback(Object.fromEntries(rows.map((row) => [row.lineIndex, row])));
    }).catch(() => {
      // Ratings are optional; a library show remains readable if storage fails.
    });
    return () => {
      current = false;
    };
  }, [show.id]);

  const rateLine = async (lineIndex: number, rating: DjRating) => {
    const { feedback: row } = await api.rateDjLine(show.id, lineIndex, rating);
    setFeedback((current) => ({ ...current, [lineIndex]: row }));
  };

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
    } else {
      el.pause();
    }
  };

  const seek = (seconds: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(duration || 0, seconds));
    setTime(el.currentTime);
  };

  const activeIndex = show.transcript.findIndex((l) => time >= l.start && time < l.end);

  return (
    <div className="mx-auto max-w-6xl px-5 py-6">
      <Button variant="ghost" size="sm" className="mb-4" onClick={onBack}>
        <ArrowLeft size={14} />
        Back to library
      </Button>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* ── Show card ───────────────────────────────────────── */}
        <div className="space-y-5">
          <div className="overflow-hidden rounded-xl border border-[var(--color-line)]">
            <img
              src={show.coverUrl}
              alt=""
              className="aspect-square w-full bg-[var(--color-panel)] object-cover"
            />
          </div>

          <div>
            <h1 className="font-serif text-3xl leading-tight text-white">{show.title}</h1>
            <p className="mt-2 text-sm leading-relaxed text-[var(--color-dim)]">{show.summary}</p>
          </div>

          <dl className="space-y-2 border-t border-[var(--color-line)] pt-4 text-xs">
            <Meta label="Station" value={show.station} />
            <Meta label="Recorded" value={formatDate(show.createdAt)} />
            <Meta label="Length" value={formatTime(show.duration)} />
            <Meta label="Format" value={show.style} />
            <Meta label="Hosts" value={show.hosts.map((h) => h.name).join(" · ")} />
            {show.audioAnalysis?.integratedLufs !== null && show.audioAnalysis?.integratedLufs !== undefined && (
              <Meta
                label="Loudness"
                value={`${show.audioAnalysis.integratedLufs.toFixed(1)} LUFS-I · ${show.audioAnalysis.truePeakDbtp?.toFixed(1) ?? "—"} dBTP`}
                mono
              />
            )}
            {show.audioAnalysis && (
              <Meta label="Master" value={show.audioAnalysis.streamingReady ? "Streaming ready" : "Review level"} />
            )}
            {show.models.length > 0 && <Meta label="Model" value={show.models.join(" · ")} mono />}
          </dl>

          {show.sources.length > 0 && (
            <div className="border-t border-[var(--color-line)] pt-4">
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.15em] text-[var(--color-dim)]">
                Sources
              </h3>
              <ul className="space-y-1.5">
                {show.sources.map((s, i) => (
                  <li key={i}>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-xs text-[var(--color-cyan)] underline-offset-2 hover:underline"
                    >
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2 border-t border-[var(--color-line)] pt-4">
            {show.hasAudio && show.audioUrl && (
              <a href={show.audioUrl} download={`${show.id}.wav`}>
                <Button size="sm">
                  <Download size={13} />
                  Audio
                </Button>
              </a>
            )}
            <a href={`/api/shows/${show.id}/transcript.txt`}>
              <Button size="sm">
                <FileText size={13} />
                Transcript
              </Button>
            </a>
            <Button size="sm" variant="danger" onClick={() => onDelete(show)}>
              <Trash2 size={13} />
              Delete
            </Button>
          </div>
        </div>

        {/* ── Transcript ──────────────────────────────────────── */}
        <div className="space-y-4">
          {show.hasAudio && show.audioUrl ? (
            <Panel className="sticky top-4 z-10">
              <audio
                ref={audioRef}
                src={show.audioUrl}
                preload="metadata"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                onLoadedMetadata={(e) => {
                  // Trust the file over the stored estimate.
                  if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
                }}
                onEnded={() => setPlaying(false)}
              />

              <div className="flex items-center gap-3">
                <Button size="sm" variant="ghost" onClick={() => seek(time - 10)} aria-label="Back ten seconds">
                  <SkipBack size={16} />
                </Button>

                <button
                  onClick={toggle}
                  aria-label={playing ? "Pause" : "Play"}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--color-amber)] text-[#1a1206] transition-colors hover:bg-[var(--color-amber-soft)]"
                >
                  {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" className="ml-0.5" />}
                </button>

                <Button size="sm" variant="ghost" onClick={() => seek(time + 10)} aria-label="Forward ten seconds">
                  <SkipForward size={16} />
                </Button>

                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span className="font-mono text-xs tabular-nums text-[var(--color-dim)]">{formatTime(time)}</span>
                  <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={0.1}
                    value={time}
                    aria-label="Seek"
                    onChange={(e) => seek(Number(e.target.value))}
                    className="min-w-0 flex-1 cursor-pointer"
                  />
                  <span className="font-mono text-xs tabular-nums text-[var(--color-mute)]">{formatTime(duration)}</span>
                </div>

                <select
                  value={rate}
                  onChange={(e) => setRate(Number(e.target.value))}
                  aria-label="Playback speed"
                  className="cursor-pointer rounded border border-[var(--color-line)] bg-[var(--color-panel-2)] px-1.5 py-1 font-mono text-xs text-[var(--color-dim)]"
                >
                  {[0.75, 1, 1.25, 1.5, 2].map((r) => (
                    <option key={r} value={r}>
                      {r}×
                    </option>
                  ))}
                </select>
              </div>
            </Panel>
          ) : (
            <Panel>
              <p className="text-sm text-[var(--color-mute)]">
                This show was generated with speech turned off, so there is no audio — only the transcript below.
              </p>
            </Panel>
          )}

          <Reader
            showId={show.id}
            transcript={show.transcript}
            activeIndex={activeIndex}
            onSeek={seek}
            hasAudio={Boolean(show.hasAudio && show.audioUrl)}
            feedback={feedback}
            onRate={rateLine}
          />
        </div>
      </div>
    </div>
  );
}

/* ── Reading the show ────────────────────────────────────────────── */

/** Things on the timeline that are not a person talking. */
function isFurniture(hostId: TranscriptLine["hostId"]): boolean {
  return hostId === "break" || hostId === "station" || hostId === "song";
}

/**
 * Consecutive lines from one speaker, as one block.
 *
 * A transcript is a list of turns, but a show is not read that way — two lines
 * from the same host in a row are one thing they said, and stamping the name
 * above each of them is noise the eye has to step over on every paragraph.
 */
interface Block {
  hostId: TranscriptLine["hostId"];
  speaker: string;
  start: number;
  lines: Array<{ index: number; line: TranscriptLine }>;
}

function groupBySpeaker(lines: TranscriptLine[], showBreaks: boolean): Block[] {
  const blocks: Block[] = [];

  lines.forEach((line, index) => {
    const isStation = isFurniture(line.hostId);
    // The record is part of the show; the commercials are what "Ads" hides.
    if (line.hostId === "break" && !showBreaks) return;

    const last = blocks[blocks.length - 1];
    // Station imaging never merges into a host's block, even when it follows
    // one — it is a different kind of thing and it reads as an interruption.
    if (last && last.hostId === line.hostId && !isStation) {
      last.lines.push({ index, line });
      return;
    }

    blocks.push({ hostId: line.hostId, speaker: line.speaker, start: line.start, lines: [{ index, line }] });
  });

  return blocks;
}

const READING_SIZES = [
  { id: "s", label: "Small", body: "text-[15px]", leading: "leading-[1.7]" },
  { id: "m", label: "Medium", body: "text-[17px]", leading: "leading-[1.75]" },
  { id: "l", label: "Large", body: "text-[19px]", leading: "leading-[1.8]" },
] as const;

type SizeId = (typeof READING_SIZES)[number]["id"];

const READING_PREFS = "talkradio.reading";

interface Prefs {
  size: SizeId;
  timestamps: boolean;
  breaks: boolean;
}

const DEFAULT_PREFS: Prefs = { size: "m", timestamps: false, breaks: true };

function readPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(READING_PREFS) ?? "{}") };
  } catch {
    return DEFAULT_PREFS;
  }
}

/**
 * The show, laid out to be read rather than scanned.
 *
 * Held to a comfortable measure, set in the same serif as the title, grouped
 * by speaker, and with the furniture — timestamps, commercials — switchable,
 * because the person catching up on an episode and the person hunting for the
 * moment at 4:12 want two different pages.
 */
function Reader({
  showId,
  transcript,
  activeIndex,
  onSeek,
  hasAudio,
  feedback,
  onRate,
}: {
  showId: string;
  transcript: TranscriptLine[];
  activeIndex: number;
  onSeek: (seconds: number) => void;
  hasAudio: boolean;
  feedback: Record<number, DjFeedback>;
  onRate: (lineIndex: number, rating: DjRating) => Promise<void>;
}) {
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const activeRef = useRef<HTMLParagraphElement>(null);

  const set = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      localStorage.setItem(READING_PREFS, JSON.stringify(next));
    } catch {
      /* private window; the page still works, it just forgets */
    }
  };

  // Follow the audio, but only gently — a jump to centre on every line makes
  // the page feel like it is fighting you when you are reading ahead.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [activeIndex]);

  const size = READING_SIZES.find((s) => s.id === prefs.size) ?? READING_SIZES[1];
  const blocks = useMemo(() => groupBySpeaker(transcript, prefs.breaks), [transcript, prefs.breaks]);

  const words = useMemo(
    () => transcript.reduce((n, l) => n + l.text.trim().split(/\s+/).length, 0),
    [transcript],
  );

  return (
    <Panel
      title="The show"
      subtitle={`${words.toLocaleString()} words · about ${Math.max(1, Math.round(words / 220))} min to read`}
      right={
        <div className="flex items-center gap-3">
          <div className="flex rounded-md border border-[var(--color-line)]">
            {READING_SIZES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => set({ size: s.id })}
                aria-label={`${s.label} text`}
                className={`px-2 py-1 font-serif leading-none transition-colors ${
                  s.id === prefs.size
                    ? "bg-[var(--color-amber)]/15 text-[var(--color-amber)]"
                    : "text-[var(--color-mute)] hover:text-white"
                } ${s.id === "s" ? "text-[11px]" : s.id === "m" ? "text-[13px]" : "text-[15px]"}`}
              >
                A
              </button>
            ))}
          </div>

          {hasAudio && (
            <button
              type="button"
              onClick={() => set({ timestamps: !prefs.timestamps })}
              className={`font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
                prefs.timestamps ? "text-[var(--color-amber)]" : "text-[var(--color-mute)] hover:text-white"
              }`}
            >
              Times
            </button>
          )}

          <button
            type="button"
            onClick={() => set({ breaks: !prefs.breaks })}
            className={`font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
              prefs.breaks ? "text-[var(--color-amber)]" : "text-[var(--color-mute)] hover:text-white"
            }`}
          >
            Ads
          </button>
        </div>
      }
    >
      <div className="mx-auto max-w-[68ch] space-y-7 py-1">
        {blocks.map((block) => {
          // A commercial and a record are markers in the running order, not
          // things to read — one quiet rule across the page carrying whatever
          // actually went out. The station's own imaging is different: those
          // are real words somebody said, so they stay on the page.
          if (block.hostId === "break" || block.hostId === "song") {
            const label = block.lines.map(({ line }) => line.text).join(" · ");
            return (
              <div key={`${block.hostId}-${block.start}`} className="flex items-center gap-3 py-1">
                <span className="h-px flex-1 bg-[var(--color-line)]" />
                <button
                  type="button"
                  onClick={() => hasAudio && onSeek(block.start)}
                  className={`shrink-0 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-mute)] ${
                    hasAudio ? "transition-colors hover:text-[var(--color-amber)]" : "cursor-default"
                  }`}
                >
                  {block.hostId === "song" ? `♪ ${label}` : label}
                  {prefs.timestamps && ` · ${formatTime(block.start)}`}
                </button>
                <span className="h-px flex-1 bg-[var(--color-line)]" />
              </div>
            );
          }

          if (block.hostId === "station") {
            return (
              <div key={`station-${block.start}`} className="space-y-2 py-1">
                {block.lines.map(({ index, line }) => (
                  <p
                    key={index}
                    onClick={() => hasAudio && onSeek(line.start)}
                    className={`text-center font-serif text-[15px] italic leading-relaxed text-[var(--color-mute)] ${
                      hasAudio ? "cursor-pointer transition-colors hover:text-[var(--color-dim)]" : ""
                    } ${index === activeIndex ? "text-[var(--color-amber)]" : ""}`}
                  >
                    {line.text}
                  </p>
                ))}
              </div>
            );
          }

          const isA = block.hostId === "a";
          const isCaller = block.hostId === "caller";
          const nameColour = isCaller
            ? "text-[var(--color-good)]"
            : isA
              ? "text-[var(--color-amber)]"
              : "text-[var(--color-cyan)]";

          return (
            <div key={`${block.hostId}-${block.start}`}>
              <h3 className={`mb-2 font-mono text-[11px] uppercase tracking-[0.18em] ${nameColour}`}>
                {block.speaker}
                {isCaller && <span className="ml-2 text-[var(--color-mute)]">on the line</span>}
              </h3>

              <div className="space-y-3">
                {block.lines.map(({ index, line }) => {
                  const isActive = index === activeIndex;
                  const rating = feedback[index]?.rating;
                  return (
                    <div key={`${showId}-${index}`} className="group/line relative">
                      <p
                        ref={isActive ? activeRef : undefined}
                        onClick={() => hasAudio && onSeek(line.start)}
                        className={`relative pr-16 font-serif ${size.body} ${size.leading} transition-colors ${
                          hasAudio ? "cursor-pointer" : ""
                        } ${isActive ? "text-white" : "text-[#c9c9d4] hover:text-white"}`}
                      >
                        {prefs.timestamps && (
                          <span
                            className={`mr-2.5 select-none font-mono text-[11px] tabular-nums ${
                              isActive ? "text-[var(--color-amber)]" : "text-[var(--color-mute)]"
                            }`}
                          >
                            {formatTime(line.start)}
                          </span>
                        )}
                        {isActive && (
                          <span
                            aria-hidden
                            className={`absolute -left-4 top-1 bottom-1 w-[3px] rounded-full ${
                              isA ? "bg-[var(--color-amber)]" : "bg-[var(--color-cyan)]"
                            }`}
                          />
                        )}
                        {line.text}
                      </p>
                      {(line.hostId === "a" || line.hostId === "b") && (
                        <div className={`absolute right-0 top-0 flex gap-1 transition-opacity ${rating ? "opacity-100" : "opacity-30 group-hover/line:opacity-100"}`}>
                          <button
                            type="button"
                            title="Keep this line for this host's training set"
                            aria-label="Mark line as keeper"
                            aria-pressed={rating === "keeper"}
                            onClick={() => void onRate(index, "keeper")}
                            className={`flex h-7 w-7 items-center justify-center rounded border transition-colors ${
                              rating === "keeper"
                                ? "border-[var(--color-good)]/60 bg-[var(--color-good)]/10 text-[var(--color-good)]"
                                : "border-[var(--color-line)] text-[var(--color-mute)] hover:text-white"
                            }`}
                          >
                            <ThumbsUp size={13} />
                          </button>
                          <button
                            type="button"
                            title="Reject this line"
                            aria-label="Mark line as rejected"
                            aria-pressed={rating === "reject"}
                            onClick={() => void onRate(index, "reject")}
                            className={`flex h-7 w-7 items-center justify-center rounded border transition-colors ${
                              rating === "reject"
                                ? "border-[var(--color-danger)]/60 bg-[var(--color-danger)]/10 text-[var(--color-danger)]"
                                : "border-[var(--color-line)] text-[var(--color-mute)] hover:text-white"
                            }`}
                          >
                            <ThumbsDown size={13} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 uppercase tracking-[0.12em] text-[var(--color-mute)]">{label}</dt>
      <dd className={`min-w-0 break-words text-[var(--color-dim)] ${mono ? "font-mono text-[11px]" : ""}`}>{value}</dd>
    </div>
  );
}
