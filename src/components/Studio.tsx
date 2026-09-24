import React, { useEffect, useRef, useState } from "react";
import {
  Radio,
  Square,
  Sparkles,
  ListTree,
  Volume2,
  VolumeX,
  Play,
  PhoneCall,
  FileText,
  Lightbulb,
  Megaphone,
  Music,
  Shuffle,
  Clock3,
  Copy,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { CallerRecord, Config, ControlState, LiveTurn, Options, PlannedBreak, ProducerBrief, RunOrderEntry, Show, ShowDraft, Stage, TimingEntry } from "../types";
import { Button, Callout, Equalizer, Field, Input, Panel, Select, Slider, Textarea, Toggle } from "./ui";
import { api } from "../lib/api";
import type { AdFile } from "../types";
import { applyPerformanceProfile, type PerformanceProfile } from "../../shared/performance-profiles";

interface Props {
  config: Config;
  options: Options | null;
  onChange: (config: Config) => void;
  onGenerate: (topic: string, sources: string[], sourceText: string) => void;
  brief: ProducerBrief | null;
  onCancel: () => void;
  running: boolean;
  stage: Stage;
  turns: LiveTurn[];
  outline: string[];
  logs: string[];
  timings: TimingEntry[];
  runOrder: RunOrderEntry[];
  control: ControlState | null;
  error: { message: string; hint?: string } | null;
  audioProgress: { done: number; total: number; speaker: string } | null;
  elapsed: number;
  result: Show | null;
  onOpenResult: () => void;
  soundOn: boolean;
  onToggleSound: (on: boolean) => void;
  /** Index of the line currently being spoken, if any. */
  speakingIndex: number | null;
  audioBlocked: boolean;
  onCallIn: (name: string, text: string) => Promise<void>;
  /** The commercial load, as planned before the show went to air. */
  breaks: PlannedBreak[];
  /** Breaks that have actually gone out, and the line each followed. */
  breakItems: Array<{ index: number; afterIndex: number; label: string; seconds?: number }>;
  openItem: { text: string; seconds?: number } | null;
  nowPlaying: "open" | "songintro" | "break" | "song" | "filler" | null;
  /** The record playing at the top of the show, once one has been announced. */
  songItem: { label: string; text: string } | null;
  drafts: ShowDraft[];
  onRecoverDraft: (id: string) => Promise<void>;
  onDeleteDraft: (id: string) => Promise<void>;
}

const STAGE_LABEL: Record<Stage, string> = {
  idle: "Ready",
  producer: "Finding the angle",
  research: "Reading sources",
  ads: "Writing the commercials",
  conversation: "On air",
  notes: "Writing the listing",
  audio: "Recording voices",
  done: "Finished",
  error: "Stopped",
  cancelled: "Cancelled",
};

function timingLabel(entry: TimingEntry): string {
  return `${entry.phase}${entry.index === undefined ? "" : ` ${entry.index + 1}`}${entry.skipped ? " (skipped)" : ""}`;
}

function durationLabel(milliseconds: number): string {
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)}s` : `${milliseconds}ms`;
}

/* ── The prompt box ──────────────────────────────────────────────── */

/**
 * Things to argue about, for when the box is empty and so is your head.
 *
 * Deliberately domestic and mid-sized. A subject that is too big ("the economy")
 * gives two hosts nothing to disagree about specifically, and a subject that is
 * too small runs out after four turns.
 */
const TOPIC_IDEAS: string[] = [
  "Whether it is ever acceptable to recline your seat on a flight",
  "Whether self-checkout actually saves anyone any time",
  "Whether the dog is allowed on the sofa",
  "Whose turn it is to do the washing up",
  "Whether tipping has gone too far",
  "Whether hotel breakfast is worth the extra cost",
  "The correct way to load a dishwasher",
  "Whether it is rude to take a phone call on speaker in public",
  "Whether people should have to earn the aisle seat",
  "Whether a hot dog is a sandwich, settled tonight, for good",
  "Whether you should tell a friend their new business idea is bad",
  "Whether it is fine to skip the queue if you are only buying one thing",
  "Whether office birthdays should be abolished",
  "Whether you should have to give notice before dropping in on someone",
  "Whether the last slice belongs to whoever paid",
  "Whether it is acceptable to watch a film on your phone in a cinema queue",
  "Whether group holidays ever actually work",
  "Whether the person who books the table gets to choose the restaurant",
  "Whether you should be allowed to eat hot food on public transport",
  "Whether replying 'k' is a hostile act",
  "Whether it is worse to be twenty minutes early or five minutes late",
  "Whether a wedding invitation obliges you to go",
  "Whether anyone has ever genuinely enjoyed a work social",
  "Whether the middle seat should get both armrests",
];

/** How long the finished show will actually run, in seconds. */
function estimateSeconds(config: Config): number {
  const { show, hosts, ads } = config;
  const wordsPerMinute = 155;

  // Dialogue, plus the pause the mix leaves between every line.
  const spoken = ((show.turns * hosts[0].maxWords) / wordsPerMinute) * 60;
  const gaps = show.turns * show.gapSeconds;

  // Each spot is copy plus its own top and tail, and each break has imaging
  // either side of the log.
  const breaks = ads.enabled
    ? ads.breaks * (2 + ads.spotsPerBreak * ((ads.spotWords / wordsPerMinute) * 60 + 1.3))
    : 0;

  const open = show.useColdOpen ? 13 : 0;
  // A record is whatever it is; three and a half minutes is the usual bet.
  const song = show.openingSong.enabled && show.openingSong.file ? 210 : 0;

  return spoken + gaps + breaks + open + song + show.outroSeconds;
}

function runtimeLabel(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

const RECENT_KEY = "talkradio.recent-topics";
const CALLER_KEY = "talkradio.caller-name";

function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((t) => typeof t === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}

function pushRecent(topic: string): string[] {
  const next = [topic, ...readRecent().filter((t) => t !== topic)].slice(0, 6);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // A private window, or storage turned off. The box still works.
  }
  return next;
}

export function Studio(props: Props) {
  const {
    config,
    options,
    onChange,
    onGenerate,
    onCancel,
    running,
    stage,
    turns,
    outline,
    logs,
    timings,
    runOrder,
    control,
    error,
    audioProgress,
    elapsed,
    result,
    onOpenResult,
    soundOn,
    onToggleSound,
    speakingIndex,
    audioBlocked,
    onCallIn,
    brief,
    breaks,
    breakItems,
    openItem,
    nowPlaying,
    songItem,
    drafts,
    onRecoverDraft,
    onDeleteDraft,
  } = props;

  const [topic, setTopic] = useState("");
  const [sources, setSources] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const topicRef = useRef<HTMLTextAreaElement>(null);

  // The box is the first thing anyone touches, so the cursor starts in it.
  useEffect(() => {
    if (!running) topicRef.current?.focus();
  }, [running]);

  /** An idea, and never the one already in the box. */
  const suggest = () => {
    const options = TOPIC_IDEAS.filter((t) => t !== topic.trim());
    setTopic(options[Math.floor(Math.random() * options.length)]);
    topicRef.current?.focus();
  };

  const update = <K extends keyof Config>(key: K, value: Partial<Config[K]>) => {
    onChange({ ...config, [key]: { ...config[key], ...value } } as Config);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || running) return;
    setRecent(pushRecent(topic.trim()));
    onGenerate(
      topic.trim(),
      sources
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      sourceText.trim(),
    );
  };

  // Dialogue, gaps, the breaks, the opener and the record — what actually goes out.
  const runtime = runtimeLabel(estimateSeconds(config));
  const modelSamples = timings.filter((entry) => entry.phase === "Model" && !entry.skipped);
  const averageModelMs = modelSamples.length
    ? modelSamples.reduce((sum, entry) => sum + entry.milliseconds + (entry.queueMs ?? 0), 0) / modelSamples.length
    : 0;
  const nextSpeaker = control && runOrder[control.current + 1]?.speaker;

  return (
    <div className="mx-auto grid max-w-7xl gap-5 px-5 py-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      {/* ── Controls ──────────────────────────────────────────── */}
      <div className="space-y-5">
        {!running && drafts.length > 0 && (
          <Panel title="Interrupted broadcasts" subtitle="Completed turns are safe and can be recovered.">
            <div className="divide-y divide-[var(--color-line)]">
              {drafts.map((draft) => (
                <div key={draft.id} className="flex items-center gap-2 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-white">{draft.topic}</div>
                    <div className="text-xs text-[var(--color-mute)]">{draft.turns.length} completed turns</div>
                  </div>
                  <Button size="sm" onClick={() => void onRecoverDraft(draft.id)} title="Recover to library">
                    <RotateCcw size={13} /> Recover
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void onDeleteDraft(draft.id)} title="Discard draft">
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
            </div>
          </Panel>
        )}
        <Panel title="On air">
          <form onSubmit={submit} className="space-y-4">
            <Field
              label="Topic"
              hint={
                topic.trim().length > 110
                  ? "That is long. The hosts are shown this on every single turn — one sentence keeps them on it."
                  : "What should the two hosts argue about tonight? Ctrl+Enter starts the show."
              }
            >
              <div>
                <Textarea
                  ref={topicRef}
                  rows={3}
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="Whether self-checkout actually saves anyone time"
                  disabled={running}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
                  }}
                />
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <button
                    type="button"
                    disabled={running}
                    onClick={suggest}
                    className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-amber)] transition-colors hover:text-white disabled:opacity-40"
                  >
                    <Shuffle size={11} />
                    Surprise me
                  </button>
                  {recent.map((t) => (
                    <button
                      key={t}
                      type="button"
                      title={t}
                      disabled={running}
                      onClick={() => setTopic(t)}
                      className="max-w-[160px] truncate text-[11px] text-[var(--color-mute)] underline underline-offset-2 transition-colors hover:text-white disabled:opacity-40"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Format">
                <Select
                  value={config.show.style}
                  onChange={(e) => update("show", { style: e.target.value as Config["show"]["style"] })}
                  disabled={running}
                >
                  {options?.styles.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Music">
                <Select
                  value={config.show.mood}
                  onChange={(e) => update("show", { mood: e.target.value })}
                  disabled={running}
                >
                  {options?.moods.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field
              label="Source material"
              hint={
                sourceText.trim()
                  ? `${sourceText.trim().split(/\s+/).length} words. The producer reads this first and finds the angle.`
                  : "Optional. Paste a document, article or notes and they will do a deep dive on it instead of talking from general knowledge."
              }
            >
              <Textarea
                rows={sourceText ? 5 : 2}
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
                placeholder="Paste anything — a spec, an article, your own notes…"
                disabled={running}
                spellCheck={false}
              />
            </Field>

            {sourceText.trim() && (
              <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-mute)]">
                <input
                  type="file"
                  accept=".txt,.md,.json,.csv,.log"
                  className="hidden"
                  disabled={running}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) setSourceText(await file.text());
                    e.target.value = "";
                  }}
                />
                <span className="underline underline-offset-2 hover:text-white">…or load a text file</span>
              </label>
            )}

            {!sourceText.trim() && (
              <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-mute)]">
                <input
                  type="file"
                  accept=".txt,.md,.json,.csv,.log"
                  className="hidden"
                  disabled={running}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) setSourceText(await file.text());
                    e.target.value = "";
                  }}
                />
                <FileText size={12} />
                <span className="underline underline-offset-2 hover:text-white">Load a text file</span>
              </label>
            )}

            <Field
              label="Length"
              hint={`About ${runtime} on air, breaks and the record included. The slider stops at eighty; type any number up to six hundred.`}
            >
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  className="w-full cursor-pointer"
                  min={2}
                  max={80}
                  step={2}
                  value={Math.min(80, config.show.turns)}
                  aria-label="Length in turns"
                  disabled={running}
                  onChange={(e) => update("show", { turns: Number(e.target.value) })}
                />
                <Input
                  type="number"
                  min={2}
                  max={600}
                  step={2}
                  value={config.show.turns}
                  aria-label="Turns"
                  disabled={running}
                  className="w-[4.5rem] shrink-0 px-2 text-center font-mono tabular-nums"
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n > 0) {
                      update("show", { turns: Math.max(2, Math.min(600, Math.round(n))) });
                    }
                  }}
                />
              </div>
            </Field>

            {running ? (
              <Button type="button" variant="danger" className="w-full" onClick={onCancel}>
                <Square size={15} />
                Stop
              </Button>
            ) : (
              <Button type="submit" variant="primary" className="w-full" disabled={!topic.trim()}>
                <Radio size={16} />
                Start the show
              </Button>
            )}
          </form>
        </Panel>

        {running && <CallInPanel onCallIn={onCallIn} callerName={config.caller.name} />}

        <Panel title="Direction" subtitle="Steer the conversation without editing the hosts.">
          <div className="space-y-4">
            <Field label="Performance profile" hint="Fast Live minimizes model calls; Produced uses the full planning chain.">
              <Select
                value={config.show.performanceProfile}
                disabled={running}
                onChange={(event) => {
                  const profile = event.target.value as PerformanceProfile;
                  onChange(profile === "custom" ? { ...config, show: { ...config.show, performanceProfile: "custom" } } : applyPerformanceProfile(config, profile));
                }}
              >
                <option value="fast">Fast Live</option>
                <option value="balanced">Balanced</option>
                <option value="produced">Produced</option>
                <option value="custom">Custom</option>
              </Select>
            </Field>
            <Field label="Station name">
              <Input
                value={config.show.station}
                onChange={(e) => update("show", { station: e.target.value })}
                disabled={running}
                maxLength={60}
              />
            </Field>

            <Field
              label={config.orion.enabled ? "Who they are to each other (radio hosts)" : "Who they are to each other"}
              hint="Shared history both hosts are told, word for word. Fill this in and they stop forgetting they are married."
            >
              <Textarea
                rows={2}
                value={config.show.relationship}
                onChange={(e) => update("show", { relationship: e.target.value })}
                placeholder="Alex and Lacey have been married twelve years and bicker like it."
                disabled={running}
              />
            </Field>

            <Field label="Producer's note" hint="Extra instructions given to both hosts. Try: keep it under three minutes, or: they have history.">
              <Textarea
                rows={3}
                value={config.show.directorNotes}
                onChange={(e) => update("show", { directorNotes: e.target.value })}
                placeholder="Optional"
                disabled={running}
              />
            </Field>

            <Toggle
              label="Speak each line as it is written"
              hint="Hear the show as it happens instead of waiting for the finished file. The mix at the end is unchanged."
              checked={config.show.speakWhileWriting}
              onChange={(speakWhileWriting) => update("show", { speakWhileWriting })}
            />

            <Toggle
              label="Open with the station"
              hint="Plays the ident, a bed and an announcer over the top the moment you hit go — before the model has written anything. It is the same few seconds either way, but they sound deliberate."
              checked={config.show.useColdOpen}
              onChange={(useColdOpen) => update("show", { useColdOpen })}
            />

            <OpeningRecord config={config} update={update} running={running} />

            <Toggle
              label="Music under the gaps"
              hint="Keeps a bed running through the whole live feed, including the pauses while the next line is written. Silence reads as broken; a bed reads as radio."
              checked={config.show.liveBed}
              onChange={(liveBed) => update("show", { liveBed })}
            />

            <Toggle
              label="Take commercial breaks"
              hint="The hosts throw to a break and come back from it. Each break is written and recorded while they are still talking, so it costs no waiting — and buys the model a head start."
              checked={config.ads.enabled}
              onChange={(enabled) => onChange({ ...config, ads: { ...config.ads, enabled } })}
            />

            <Toggle
              label="Find the angle first"
              hint="A producer pass reads the material and pulls out the hook, the ideas worth covering and everyday comparisons for the hard parts — before either host opens their mouth."
              checked={config.show.useProducer}
              onChange={(useProducer) => update("show", { useProducer })}
            />

            <Toggle
              label="Give it a running order"
              hint="Structures the show — open, positions, clashes, a story, a callback, then land it — instead of a flat back-and-forth."
              checked={config.show.useRunSheet}
              onChange={(useRunSheet) => update("show", { useRunSheet })}
            />

            <Toggle
              label="Plan the segment first"
              hint="Asks the model for a beat sheet before writing dialogue. Keeps long shows on track."
              checked={config.show.useOutline}
              onChange={(useOutline) => update("show", { useOutline })}
            />

            <Toggle
              label="Generate episode notes"
              hint="Turn this off to skip the final title-and-summary model call. The topic becomes the title."
              checked={config.show.generateNotes}
              onChange={(generateNotes) => update("show", { generateNotes, performanceProfile: "custom" })}
            />

            <Toggle
              label="Warm the first DJ"
              hint="Prefills only the opening speaker while playable opening audio is on air."
              checked={config.show.warmUpModel}
              onChange={(warmUpModel) => update("show", { warmUpModel, performanceProfile: "custom" })}
            />

            <Toggle
              label="Ground it in real sources"
              hint="Fetches the URLs below and summarises them for the hosts."
              checked={config.show.useResearch}
              onChange={(useResearch) => update("show", { useResearch })}
            />

            {config.show.useResearch && (
              <Field label="Sources" hint="One per line. Type hackernews for the current top stories.">
                <Textarea
                  rows={3}
                  value={sources}
                  onChange={(e) => setSources(e.target.value)}
                  placeholder={"hackernews\nhttps://example.com/article"}
                  disabled={running}
                  spellCheck={false}
                />
              </Field>
            )}
          </div>
        </Panel>

        <Panel title="Mix">
          <div className="space-y-4">
            <Slider
              label="Music level"
              value={config.show.musicVolume}
              min={0}
              max={0.6}
              step={0.01}
              onChange={(musicVolume) => update("show", { musicVolume })}
              format={(v) => (v < 0.005 ? "off" : `${Math.round(v * 100)}%`)}
            />
            <Slider
              label="Duck under speech"
              value={config.show.duckDepth}
              min={0}
              max={1}
              step={0.02}
              onChange={(duckDepth) => update("show", { duckDepth })}
              format={(v) => `${Math.round(v * 100)}%`}
              hint="How far the music drops when someone is talking."
            />
            <Slider
              label="Pause between turns"
              value={config.show.gapSeconds}
              min={0}
              max={1.5}
              step={0.02}
              onChange={(gapSeconds) => update("show", { gapSeconds })}
              format={(v) => `${v.toFixed(2)}s`}
            />
          </div>
        </Panel>
      </div>

      {/* ── Live output ───────────────────────────────────────── */}
      <div className="space-y-5">
        <Panel
          title="Broadcast"
          right={
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => onToggleSound(!soundOn)}
                aria-label={soundOn ? "Mute live audio" : "Unmute live audio"}
                title={soundOn ? "Mute" : "Listen as it is written"}
                className={`rounded-lg p-1.5 transition-colors ${
                  soundOn
                    ? "text-[var(--color-amber)] hover:bg-[var(--color-amber)]/10"
                    : "text-[var(--color-mute)] hover:text-white hover:bg-white/5"
                }`}
              >
                {soundOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
              </button>
              {running && <Equalizer active />}
              <span className="font-mono text-xs text-[var(--color-dim)]">{STAGE_LABEL[stage]}</span>
              {(running || elapsed > 0) && (
                <span className="font-mono text-xs tabular-nums text-[var(--color-mute)]">
                  {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
                </span>
              )}
            </div>
          }
          className="min-h-[420px]"
        >
          {audioBlocked && soundOn && (
            <div className="mb-4">
              <Callout tone="info" title="Your browser blocked the sound">
                <div className="mt-1">It needs a click before it will play audio on its own.</div>
                <Button size="sm" className="mt-3" onClick={() => onToggleSound(true)}>
                  <Play size={13} />
                  Turn the sound on
                </Button>
              </Callout>
            </div>
          )}

          {error && (
            <div className="mb-4">
              <Callout tone="error" title={error.message}>
                {error.hint}
              </Callout>
            </div>
          )}

          {stage === "done" && result && (
            <div className="mb-4">
              <Callout tone="good" title={result.title}>
                <div className="mt-1">{result.summary}</div>
                <Button size="sm" className="mt-3" onClick={onOpenResult}>
                  <Sparkles size={13} />
                  Open the show
                </Button>
              </Callout>
            </div>
          )}

          {brief && (brief.hook || brief.concepts.length > 0) && (
            <details className="mb-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)]" open>
              <summary className="flex cursor-pointer items-center gap-2 px-3.5 py-2.5 text-xs font-semibold uppercase tracking-[0.13em] text-[var(--color-dim)]">
                <Lightbulb size={13} />
                The angle
              </summary>
              <div className="space-y-2.5 border-t border-[var(--color-line)] px-3.5 py-3 text-sm">
                {brief.hook && (
                  <p className="leading-relaxed text-[#e8e8ee]">{brief.hook}</p>
                )}
                {brief.concepts.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] uppercase tracking-[0.15em] text-[var(--color-mute)]">
                      Must cover
                    </div>
                    <ul className="space-y-0.5 text-[var(--color-dim)]">
                      {brief.concepts.map((c, i) => (
                        <li key={i}>· {c}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {brief.analogies.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] uppercase tracking-[0.15em] text-[var(--color-mute)]">
                      Ways in
                    </div>
                    <ul className="space-y-0.5 text-[var(--color-dim)]">
                      {brief.analogies.map((a, i) => (
                        <li key={i}>· {a}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </details>
          )}

          {breaks.length > 0 && (
            <details className="mb-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)]">
              <summary className="flex cursor-pointer items-center gap-2 px-3.5 py-2.5 text-xs font-semibold uppercase tracking-[0.13em] text-[var(--color-dim)]">
                <Megaphone size={13} />
                Commercial log · {breaks.reduce((n, b) => n + b.spots.length, 0)} spots
              </summary>
              <div className="space-y-3 border-t border-[var(--color-line)] px-3.5 py-3 text-sm">
                {breaks.map((brk) => (
                  <div key={brk.index}>
                    <div className="mb-1.5 text-[10px] uppercase tracking-[0.15em] text-[var(--color-mute)]">
                      Break {brk.index + 1}
                    </div>
                    <ul className="space-y-2">
                      {brk.spots.map((spot, i) => (
                        <li key={i} className="border-l-2 border-[var(--color-line-bright)] pl-2.5">
                          <div className="flex items-baseline gap-2">
                            <span className="font-mono text-[11px] text-[var(--color-amber)]">{spot.sponsor}</span>
                            {spot.repeat && (
                              <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-[var(--color-mute)]">
                                repeat
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 leading-relaxed text-[var(--color-dim)]">{spot.text}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          )}

          {runOrder.length > 0 && (
            <details className="mb-4 border-y border-[var(--color-line)]" open>
              <summary className="flex cursor-pointer items-center justify-between py-2.5 text-xs font-semibold uppercase text-[var(--color-dim)]">
                <span className="flex items-center gap-2"><ListTree size={13} /> Control room</span>
                <span className="font-mono font-normal text-[var(--color-mute)]">
                  {control
                    ? `Turn ${control.current + 1} · next ${nextSpeaker ?? "close"} · queue ${control.queue.pending}${averageModelMs ? ` · ~${durationLabel(averageModelMs)} wait` : ""}`
                    : `${runOrder.length} turns`}
                </span>
              </summary>
              <div className="max-h-56 overflow-y-auto border-t border-[var(--color-line)] py-2">
                {runOrder.map((beat) => {
                  const active = beat.index === control?.current;
                  const done = control ? beat.index < control.current : false;
                  return (
                    <div key={beat.index} className={`grid grid-cols-[28px_90px_1fr] gap-2 px-2 py-1.5 text-xs ${active ? "bg-[var(--color-amber)]/10 text-white" : done ? "text-[var(--color-mute)]" : "text-[var(--color-dim)]"}`}>
                      <span className="font-mono">{beat.index + 1}</span>
                      <span className="truncate">{beat.speaker}</span>
                      <span className="truncate">{beat.kind.replaceAll("_", " ")}{beat.breakIndex === undefined ? "" : ` · break ${beat.breakIndex + 1}`}</span>
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          {outline.length > 0 && (
            <details className="mb-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)]">
              <summary className="flex cursor-pointer items-center gap-2 px-3.5 py-2.5 text-xs font-semibold uppercase tracking-[0.13em] text-[var(--color-dim)]">
                <ListTree size={13} />
                Segment plan · {outline.length} beats
              </summary>
              <ol className="space-y-1.5 border-t border-[var(--color-line)] px-3.5 py-3 text-sm text-[var(--color-dim)]">
                {outline.map((beat, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span className="font-mono text-xs text-[var(--color-mute)]">{i + 1}</span>
                    <span>{beat}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}

          {audioProgress && stage === "audio" && (
            <div className="mb-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3.5 py-3">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="text-[var(--color-dim)]">
                  Recording {audioProgress.speaker || "…"}
                </span>
                <span className="font-mono tabular-nums text-[var(--color-mute)]">
                  {audioProgress.done} / {audioProgress.total}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-[var(--color-line-bright)]">
                <div
                  className="h-full rounded-full bg-[var(--color-amber)] transition-all duration-300"
                  style={{ width: `${(audioProgress.done / Math.max(1, audioProgress.total)) * 100}%` }}
                />
              </div>
            </div>
          )}

          {turns.length === 0 && !running && stage === "idle" ? (
            <EmptyState config={config} />
          ) : (
            <LiveTranscript
              turns={turns}
              config={config}
              speakingIndex={speakingIndex}
              breakItems={breakItems}
              openItem={openItem}
              nowPlaying={nowPlaying}
              songItem={songItem}
            />
          )}
        </Panel>

        {timings.length > 0 && (
          <details className="border-t border-[var(--color-line)] py-3">
            <summary className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--color-dim)]">
              <Clock3 size={14} />
              Show timings
              <span className="font-mono font-normal text-[var(--color-mute)]">{timings.length}</span>
            </summary>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                title="Copy show timings"
                aria-label="Copy show timings"
                className="rounded border border-[var(--color-line)] p-1.5 text-[var(--color-dim)] hover:text-white"
                onClick={() => {
                  const lines = timings.map((entry) =>
                    `${timingLabel(entry)}: ${durationLabel(entry.milliseconds)}` +
                    (entry.queueMs === undefined ? "" : ` (queue ${durationLabel(entry.queueMs)})`) +
                    (entry.turns === undefined ? "" : ` (${entry.turns} turns)`),
                  );
                  void navigator.clipboard.writeText(lines.join("\n"));
                }}
              >
                <Copy size={14} />
              </button>
            </div>
            <div className="thin-scroll mt-2 max-h-56 overflow-y-auto font-mono text-xs">
              {timings.map((entry, i) => (
                <div key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-[var(--color-line)]/50 py-1">
                  <span className="text-[var(--color-dim)]">{timingLabel(entry)}</span>
                  <span className="tabular-nums text-[var(--color-mute)]">
                    {durationLabel(entry.milliseconds)}
                    {entry.queueMs !== undefined && ` · queue ${durationLabel(entry.queueMs)}`}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}

        {logs.length > 0 && (
          <Panel title="Log">
            <div className="thin-scroll max-h-48 space-y-1 overflow-y-auto font-mono text-xs text-[var(--color-mute)]">
              {logs.map((line, i) => (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 text-[var(--color-line-bright)]">›</span>
                  <span className="break-words">{line}</span>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

/**
 * Puts the listener on air. The line is queued and goes out at the next gap
 * between turns, so it never cuts a host off mid-sentence.
 *
 * The name matters more than it looks. Every named call is written into the
 * station's phone book, and the hosts are briefed on the regulars before the
 * next show starts — so ring in twice under the same name and they will know
 * who you are.
 */
function CallInPanel({
  onCallIn,
  callerName,
}: {
  onCallIn: (name: string, text: string) => Promise<void>;
  callerName: string;
}) {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(CALLER_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [text, setText] = useState("");
  const [queued, setQueued] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [regulars, setRegulars] = useState<CallerRecord[]>([]);

  useEffect(() => {
    api
      .listCallers()
      .then((r) => setRegulars(r.callers.slice(0, 5)))
      // The phone book is a nicety; a show is perfectly callable without it.
      .catch(() => setRegulars([]));
  }, [queued]);

  const known = regulars.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || sending) return;

    setSending(true);
    setError(null);
    try {
      await onCallIn(name.trim(), text.trim());
      setText("");
      setQueued((n) => n + 1);
      try {
        if (name.trim()) localStorage.setItem(CALLER_KEY, name.trim());
      } catch {
        /* storage off; the name just will not be remembered here */
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Panel
      title="Call in"
      subtitle="Say something and they will answer you on air."
      right={
        queued > 0 ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--color-good)]">
            {queued} on the line
          </span>
        ) : null
      }
    >
      <form onSubmit={send} className="space-y-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`Your name (default: ${callerName})`}
          maxLength={40}
        />

        {known && (
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-good)]">
            Known caller · {known.calls} {known.calls === 1 ? "call" : "calls"} on record
          </p>
        )}

        {regulars.length > 0 && !known && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-mute)]">
              Regulars
            </span>
            {regulars.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() => setName(c.name)}
                title={c.lines[c.lines.length - 1] ?? c.name}
                className="text-[11px] text-[var(--color-mute)] underline underline-offset-2 transition-colors hover:text-white"
              >
                {c.name}
              </button>
            ))}
          </div>
        )}

        <Textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Hey, long-time listener — you two are both wrong about this..."
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(e);
          }}
        />
        <Button type="submit" variant="primary" className="w-full" disabled={!text.trim() || sending}>
          <PhoneCall size={15} />
          {sending ? "Connecting..." : "Go on air"}
        </Button>
        {error && <p className="font-mono text-xs text-[var(--color-live)]">{error}</p>}
        <p className="text-xs leading-relaxed text-[var(--color-mute)]">
          You join at the next gap between turns, in your own voice, and whoever speaks next answers you
          directly. Give a name and the station remembers you — the hosts are briefed on their regulars
          before every show.
        </p>
      </form>
    </Panel>
  );
}

function EmptyState({ config }: { config: Config }) {
  // With Orion on, the two speaker slots belong to the King and his chronicler
  // — the server swaps them before a word is written. The Studio was still
  // showing Marco and Dee, which is only wrong on screen but reads as a bug.
  const court = config.orion.enabled;
  const speakers = court
    ? [
        { id: "a", name: config.orion.king.name, tone: config.orion.king.tone },
        { id: "b", name: config.orion.chronicler.name, tone: config.orion.chronicler.tone },
      ]
    : config.hosts;

  return (
    <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-4 text-center">
      <div className="flex items-center gap-3">
        {speakers.map((h, i) => (
          <React.Fragment key={h.id}>
            {i > 0 && <span className="text-[var(--color-line-bright)]">·</span>}
            <div>
              <div className="font-serif text-2xl text-[#e8e8ee]">{h.name}</div>
              <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--color-mute)]">
                {h.tone}
              </div>
            </div>
          </React.Fragment>
        ))}
      </div>
      <p className="max-w-sm text-sm leading-relaxed text-[var(--color-mute)]">
        {court
          ? "The station has been handed to Orion. Call a court from the Realm tab and it plays here."
          : "Give them a topic and they will talk it out, one turn each, live. Everything runs on this machine."}
      </p>
    </div>
  );
}

/** The station's own voice in the feed: the opener and the commercial breaks. */
/**
 * The record at the top of the show.
 *
 * Sitting in Direction rather than Settings because it is a decision about
 * this show, and because of what it does to the wait: the announcer throws to
 * a record, the record plays, and the hosts' first turns are written
 * underneath it. A three-minute song is three minutes the listener spends
 * hearing a station instead of watching a spinner.
 */
function OpeningRecord({
  config,
  update,
  running,
}: {
  config: Config;
  update: <K extends keyof Config>(key: K, patch: Partial<Config[K]>) => void;
  running: boolean;
}) {
  const song = config.show.openingSong;
  const [files, setFiles] = useState<AdFile[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    api
      .songFiles()
      .then((r) => setFiles(r.files))
      .catch(() => setFiles([]));
  };

  useEffect(refresh, []);

  const set = (patch: Partial<Config["show"]["openingSong"]>) =>
    update("show", { openingSong: { ...song, ...patch } });

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.uploadSong(file);
      setFiles(result.files);
      // Choosing it is what you wanted to do next anyway.
      set({ file: result.name, enabled: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-3">
      <Toggle
        label="Open with a record"
        hint="The station announces the show, throws to a song, and the song plays while the hosts' first lines are being written. It is the single biggest thing you can do about waiting."
        checked={song.enabled}
        onChange={(enabled) => set({ enabled })}
      />

      {song.enabled && (
        <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3">
          <Field label="The record" hint="Anything in the music folder. MP3 or WAV.">
            <Select value={song.file} onChange={(e) => set({ file: e.target.value })} disabled={running}>
              <option value="">Choose a file…</option>
              {files.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept=".mp3,.wav,audio/mpeg,audio/wav"
              className="hidden"
              onChange={(e) => void upload(e.target.files?.[0])}
            />
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => inputRef.current?.click()}>
              {busy ? "Adding…" : "Add a file"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void api.revealMusic().catch(() => {})}>
              Open the folder
            </Button>
            <Button size="sm" variant="ghost" onClick={refresh}>
              Refresh
            </Button>
          </div>

          {error && <Callout tone="error">{error}</Callout>}

          {!song.file && files.length === 0 && (
            <Callout tone="info">
              The music folder is empty. Add a file, or drop one in the folder and press Refresh.
            </Callout>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Title" hint="Left empty, the filename is used.">
              <Input
                value={song.title}
                onChange={(e) => set({ title: e.target.value })}
                placeholder="From the filename"
                disabled={running}
              />
            </Field>
            <Field label="Artist" hint="Left out of the announcement when empty.">
              <Input
                value={song.artist}
                onChange={(e) => set({ artist: e.target.value })}
                placeholder="Optional"
                disabled={running}
              />
            </Field>
          </div>

          <Slider
            label="Record level"
            hint="How loud it sits against the show."
            min={0.2}
            max={1}
            step={0.05}
            value={song.volume}
            onChange={(volume) => set({ volume })}
            format={(v) => `${Math.round(v * 100)}%`}
          />
        </div>
      )}
    </div>
  );
}

function StationCard({
  icon,
  label,
  text,
  seconds,
  live,
}: {
  icon: React.ReactNode;
  label: string;
  text: string;
  seconds?: number;
  live: boolean;
}) {
  return (
    <div className="flex justify-center">
      <div
        className={`w-full max-w-[92%] rounded-xl border px-3.5 py-2.5 transition-colors ${
          live
            ? "border-[var(--color-good)]/60 bg-[var(--color-good)]/[0.07]"
            : "border-dashed border-[var(--color-line-bright)] bg-[var(--color-panel-2)]"
        }`}
      >
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-[var(--color-mute)]">
          {icon}
          <span className="font-semibold">{label}</span>
          {seconds !== undefined && (
            <span className="font-mono tabular-nums">{seconds.toFixed(1)}s</span>
          )}
          {live && (
            <span className="ml-auto inline-flex items-center gap-1 text-[var(--color-good)]">
              <Equalizer active />
              on air
            </span>
          )}
        </div>
        {text && <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-dim)]">{text}</p>}
      </div>
    </div>
  );
}

function LiveTranscript({
  turns,
  config,
  speakingIndex,
  breakItems,
  openItem,
  nowPlaying,
  songItem,
}: {
  turns: LiveTurn[];
  config: Config;
  speakingIndex: number | null;
  breakItems: Array<{ index: number; afterIndex: number; label: string; seconds?: number }>;
  openItem: { text: string; seconds?: number } | null;
  nowPlaying: "open" | "songintro" | "break" | "song" | "filler" | null;
  songItem: { label: string; text: string } | null;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Follow the stream, but stop fighting the user if they scroll up to re-read.
  useEffect(() => {
    if (pinned) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, breakItems, pinned]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="thin-scroll max-h-[560px] space-y-5 overflow-y-auto pr-1"
    >
      {openItem && (
        <StationCard
          icon={<Radio size={12} />}
          label={`${config.show.station} — station opener`}
          text={openItem.text}
          seconds={openItem.seconds}
          live={nowPlaying === "open"}
        />
      )}

      {songItem && (
        <StationCard
          icon={<Music size={12} />}
          label={songItem.label ? `On the record — ${songItem.label}` : "On the record"}
          text={songItem.text}
          live={nowPlaying === "song" || nowPlaying === "songintro"}
        />
      )}

      {nowPlaying === "filler" && (
        <StationCard
          icon={<Music size={12} />}
          label="Music while the next line is written"
          text="The desk keeps the air alive rather than leaving a gap. The show comes back the moment it has something to say."
          live
        />
      )}

      {turns.map((turn) => {
        const isA = turn.hostId === "a";
        const host = config.hosts.find((h) => h.id === turn.hostId);
        const speaking = turn.index === speakingIndex;

        // Breaks are stored against the line that threw to them rather than
        // inside the transcript, so they are woven back in here.
        const after = breakItems.filter((b) => b.afterIndex === turn.index);

        return (
          <React.Fragment key={turn.index}>
          <div className={`flex gap-3 ${isA ? "" : "flex-row-reverse"}`}>
            <div
              className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border font-mono text-xs font-bold transition-shadow ${
                isA
                  ? "border-[var(--color-amber)]/40 bg-[var(--color-amber)]/10 text-[var(--color-amber)]"
                  : "border-[var(--color-cyan)]/40 bg-[var(--color-cyan)]/10 text-[var(--color-cyan)]"
              } ${speaking ? "ring-2 ring-offset-2 ring-offset-[var(--color-panel)] " + (isA ? "ring-[var(--color-amber)]" : "ring-[var(--color-cyan)]") : ""}`}
            >
              {turn.speaker.slice(0, 1).toUpperCase()}
            </div>

            <div className={`min-w-0 max-w-[85%] ${isA ? "" : "text-right"}`}>
              <div
                className={`mb-1 flex items-baseline gap-2 text-[10px] uppercase tracking-[0.15em] ${
                  isA ? "" : "justify-end"
                } ${isA ? "text-[var(--color-amber)]" : "text-[var(--color-cyan)]"}`}
              >
                <span className="font-semibold">{turn.speaker}</span>
                {host && <span className="text-[var(--color-mute)]">{host.tone}</span>}
                {speaking && (
                  <span className="inline-flex items-center gap-1 text-[var(--color-good)]">
                    <Equalizer active />
                    on air
                  </span>
                )}
              </div>
              <div
                className={`inline-block rounded-xl border px-3.5 py-2.5 text-left text-sm leading-relaxed transition-colors ${
                  speaking
                    ? isA
                      ? "border-[var(--color-amber)]/60 bg-[var(--color-amber)]/[0.07] text-white"
                      : "border-[var(--color-cyan)]/60 bg-[var(--color-cyan)]/[0.07] text-white"
                    : isA
                      ? "border-[var(--color-line)] bg-[var(--color-panel-2)]"
                      : "border-[var(--color-line)] bg-[#14181d]"
                }`}
              >
                {turn.text || <span className="text-[var(--color-mute)]">…</span>}
                {turn.streaming && (
                  <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 bg-[var(--color-amber)] live-dot" />
                )}
              </div>
            </div>
          </div>

          {after.map((brk) => (
            <StationCard
              key={`break-${brk.index}`}
              icon={<Megaphone size={12} />}
              label={brk.label}
              text=""
              seconds={brk.seconds}
              live={nowPlaying === "break"}
            />
          ))}
          </React.Fragment>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
