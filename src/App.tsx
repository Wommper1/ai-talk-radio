import { useCallback, useEffect, useRef, useState } from "react";
import { Radio, Library as LibraryIcon, SlidersHorizontal, Cpu, HardDrive, Crown, Megaphone } from "lucide-react";
import type { Config, LiveTurn, Options, PlannedBreak, ProducerBrief, Show, Stage, TimingEntry } from "./types";
import { api, generateStream } from "./lib/api";
import { Studio } from "./components/Studio";
import { Library } from "./components/Library";
import { Commercials } from "./components/Commercials";
import { Player } from "./components/Player";
import { Settings } from "./components/Settings";
import { Files } from "./components/Files";
import { Realm } from "./components/Realm";
import { Callout, StatusDot } from "./components/ui";

type Tab = "studio" | "realm" | "commercials" | "library" | "files" | "settings";

export default function App() {
  const [tab, setTab] = useState<Tab>("studio");
  const [config, setConfig] = useState<Config | null>(null);
  const [configPath, setConfigPath] = useState("");
  const [options, setOptions] = useState<Options | null>(null);
  const [shows, setShows] = useState<Show[]>([]);
  const [openShow, setOpenShow] = useState<Show | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  // Generation state
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [outline, setOutline] = useState<string[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [timings, setTimings] = useState<TimingEntry[]>([]);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [audioProgress, setAudioProgress] = useState<{ done: number; total: number; speaker: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Show | null>(null);
  const [brief, setBrief] = useState<ProducerBrief | null>(null);
  const [breaks, setBreaks] = useState<PlannedBreak[]>([]);

  /**
   * The commercials, keyed by the turn they follow. Kept out of `turns`
   * deliberately: a break is queued from the speech chain and can therefore
   * arrive while the next turn is still streaming tokens in, and appending it
   * to the transcript would put those tokens in the wrong place.
   */
  const [breakItems, setBreakItems] = useState<
    Array<{ index: number; afterIndex: number; label: string; seconds?: number }>
  >([]);
  const [openItem, setOpenItem] = useState<{ text: string; seconds?: number } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const jobIdRef = useRef<string>("");

  /* ── Live playback ─────────────────────────────────────────────
   * Lines are spoken as they are written, so the queue is a radio feed:
   * play in order, never overlap, and drop the backlog if sound is muted
   * rather than replaying stale turns later.
   */
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<Array<{ index: number; url: string; kind: "turn" | "open" | "songintro" | "break" | "song" | "filler" }>>([]);
  // Instrumental interludes for when the show is not ready yet. Cycled
  // rather than exhausted, so a long stall still has something on the air.
  const fillerRef = useRef<string[]>([]);
  const fillerAtRef = useRef(0);
  const busyRef = useRef(false);
  const soundOnRef = useRef(true);

  const [soundOn, setSoundOn] = useState(true);
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  /** What is on air right now, when it is not one of the hosts. */
  const [nowPlaying, setNowPlaying] = useState<"open" | "songintro" | "break" | "song" | "filler" | null>(null);
  const [songItem, setSongItem] = useState<{ label: string; text: string } | null>(null);

  /**
   * The bed under the live feed.
   *
   * The gaps while the model writes the next line are the single thing that
   * makes a local show feel slow. A bed running underneath turns that silence
   * into dead air on a real station, which is a thing listeners already know
   * how to hear.
   */
  const bedElRef = useRef<HTMLAudioElement | null>(null);
  const bedRampRef = useRef<number | null>(null);
  const bedLevelRef = useRef({ idle: 0.5, ducked: 0.15 });
  const runningRef = useRef(false);
  /** Index of the most recently finished line, so a break knows where it sits. */
  const lastTurnIndexRef = useRef(-1);

  /**
   * Swapping `src` on a playing element fires a spurious error/abort for the
   * load being replaced. Advancing the queue on that event skips a clip and
   * then carries on, which sounds like the show stuttering. Every playback is
   * therefore stamped with a token, and only events belonging to the clip
   * currently on air are allowed to move the queue along.
   */
  const playTokenRef = useRef(0);

  /** Slide the bed to a level over ~350ms, so ducking is not a step change. */
  const rampBed = useCallback((target: number) => {
    const el = bedElRef.current;
    if (!el) return;

    if (bedRampRef.current !== null) window.clearInterval(bedRampRef.current);

    const from = el.volume;
    const steps = 14;
    let step = 0;

    bedRampRef.current = window.setInterval(() => {
      step++;
      const t = step / steps;
      try {
        el.volume = Math.max(0, Math.min(1, from + (target - from) * t));
      } catch {
        /* the element went away mid-ramp */
      }
      if (step >= steps && bedRampRef.current !== null) {
        window.clearInterval(bedRampRef.current);
        bedRampRef.current = null;
      }
    }, 25);
  }, []);

  const stopBed = useCallback(() => {
    if (bedRampRef.current !== null) {
      window.clearInterval(bedRampRef.current);
      bedRampRef.current = null;
    }
    const el = bedElRef.current;
    if (!el) return;
    el.pause();
    el.removeAttribute("src");
    el.load();
  }, []);

  const pump = useCallback(() => {
    if (busyRef.current || !soundOnRef.current) return;

    let next = queueRef.current.shift();

    // Nothing ready, but the show is still being written. Rather than sitting
    // on a quiet bed for two minutes — which is what the record ending used to
    // sound like — put an instrumental interlude on the air. It is real
    // programming, it was rendered by the DSP in under a second, and it needs
    // no model, so it is there even when nothing else is.
    if (!next && runningRef.current && fillerRef.current.length > 0) {
      const url = fillerRef.current[fillerAtRef.current % fillerRef.current.length];
      fillerAtRef.current += 1;
      next = { index: -1, url, kind: "filler" };
    }

    if (!next) {
      setSpeakingIndex(null);
      setNowPlaying(null);
      // Nothing left to play. The bed comes back up on its own — that gap is
      // the model writing, and it should sound like a station, not a stall.
      if (runningRef.current) rampBed(bedLevelRef.current.idle);
      else stopBed();
      return;
    }

    const el = audioElRef.current;
    if (!el) return;

    const token = ++playTokenRef.current;
    busyRef.current = true;
    setSpeakingIndex(next.index);
    setNowPlaying(next.kind === "turn" ? null : next.kind);

    // A commercial brought its own music and a record simply is the music;
    // the show's bed drops out entirely under both, the way a desk mutes the
    // studio channel for the log.
    const ownsTheAir = next.kind === "break" || next.kind === "song" || next.kind === "filler";
    rampBed(ownsTheAir ? 0 : bedLevelRef.current.ducked);

    el.src = next.url;
    void el.play().catch(() => {
      if (playTokenRef.current !== token) return; // superseded, not a failure
      busyRef.current = false;
      setSpeakingIndex(null);
      setNowPlaying(null);
      setAudioBlocked(true);
    });
  }, [rampBed, stopBed]);

  useEffect(() => {
    const el = new Audio();
    el.preload = "auto";

    const finish = (token: number) => {
      if (playTokenRef.current !== token) return;
      busyRef.current = false;
      pump();
    };

    const onEnded = () => finish(playTokenRef.current);
    const onError = () => {
      // A clip that genuinely failed should not strand the rest of the queue.
      const token = playTokenRef.current;
      if (!busyRef.current) return;
      console.warn("[radio] clip failed to play, moving on");
      finish(token);
    };

    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    audioElRef.current = el;

    const bed = new Audio();
    bed.loop = true;
    bed.preload = "auto";
    bed.volume = 0;
    bedElRef.current = bed;

    return () => {
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
      el.pause();
      audioElRef.current = null;
      bed.pause();
      bedElRef.current = null;
    };
  }, [pump]);

  const stopPlayback = useCallback(() => {
    queueRef.current = [];
    busyRef.current = false;
    setSpeakingIndex(null);
    setNowPlaying(null);
    audioElRef.current?.pause();
    stopBed();
  }, [stopBed]);

  const toggleSound = useCallback(
    (on: boolean) => {
      soundOnRef.current = on;
      setSoundOn(on);
      if (on) {
        setAudioBlocked(false);
        pump();
      } else {
        stopPlayback();
      }
    },
    [pump, stopPlayback],
  );

  /* ── Boot ──────────────────────────────────────────────────── */

  useEffect(() => {
    (async () => {
      try {
        const [cfg, opts, list] = await Promise.all([api.getConfig(), api.getOptions(), api.listShows()]);
        setConfig(cfg.config);
        setConfigPath(cfg.configPath);
        setOptions(opts);
        setShows(list);
      } catch (err) {
        setBootError((err as Error).message);
      }
    })();
  }, []);

  /* ── Elapsed clock ─────────────────────────────────────────── */

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const refreshShows = useCallback(async () => {
    try {
      setShows(await api.listShows());
    } catch {
      /* the library will refresh on the next navigation */
    }
  }, []);

  /* ── Generation ────────────────────────────────────────────── */

  const generate = useCallback(
    async (topic: string, sources: string[], sourceText: string) => {
      if (!config) return;

      const controller = new AbortController();
      abortRef.current = controller;
      jobIdRef.current = `job-${Date.now().toString(36)}`;

      setRunning(true);
      setStage("conversation");
      setTurns([]);
      setOutline([]);
      setLogs([]);
      setTimings([]);
      setError(null);
      setAudioProgress(null);
      setResult(null);
      setBrief(null);
      setBreaks([]);
      setBreakItems([]);
      setOpenItem(null);
      lastTurnIndexRef.current = -1;
      stopPlayback();
      setAudioBlocked(false);

      runningRef.current = true;
      // The bed sits under everything, so it is set from the same slider that
      // controls music in the finished mix rather than being its own control.
      const idle = Math.max(0.12, Math.min(0.7, config.show.musicVolume * 3));
      bedLevelRef.current = { idle, ducked: idle * 0.28 };

      // Set by the terminal events; anything else means the stream was cut off.
      let finished = false;

      try {
        const stream = generateStream(
          { topic, sources, sourceText, config, jobId: jobIdRef.current },
          controller.signal,
        );

        for await (const event of stream) {
          switch (event.type) {
            case "stage":
              setStage(event.stage as Stage);
              break;

            case "info":
              setLogs((prev) => [...prev.slice(-99), String(event.message)]);
              break;

            case "timing": {
              const milliseconds = Number(event.milliseconds);
              if (!Number.isFinite(milliseconds) || milliseconds < 0) break;
              const index = Number(event.index);
              const queueMs = Number(event.queueMs);
              const turns = Number(event.turns);
              setTimings((prev) => [...prev.slice(-199), {
                phase: String(event.phase ?? "Stage"),
                milliseconds,
                ...(event.index !== undefined && Number.isFinite(index) ? { index } : {}),
                ...(event.queueMs !== undefined && Number.isFinite(queueMs) ? { queueMs } : {}),
                ...(event.turns !== undefined && Number.isFinite(turns) ? { turns } : {}),
                ...(event.skipped === true ? { skipped: true } : {}),
              }]);
              break;
            }

            case "brief":
              setBrief(event.brief as ProducerBrief);
              break;

            case "outline":
              setOutline(event.beats as string[]);
              break;

            case "research":
              setLogs((prev) => [
                ...prev.slice(-99),
                `Using ${(event.sources as unknown[]).length} source(s).`,
              ]);
              break;

            case "turn_start":
              setTurns((prev) => [
                ...prev,
                {
                  index: event.index as number,
                  speaker: String(event.speaker),
                  hostId: event.hostId as "a" | "b" | "caller",
                  text: "",
                  streaming: true,
                },
              ]);
              break;

            case "token":
              // Append to whichever turn is currently open.
              setTurns((prev) => {
                if (prev.length === 0) return prev;
                const next = [...prev];
                const last = { ...next[next.length - 1] };
                last.text += String(event.text);
                next[next.length - 1] = last;
                return next;
              });
              break;

            case "turn_end": {
              // Replace the streamed draft with the server's cleaned line.
              const turn = event.turn as { index: number; speaker: string; hostId: "a" | "b"; text: string };
              lastTurnIndexRef.current = turn.index;
              setTurns((prev) => {
                if (prev.length === 0) return prev;
                const next = [...prev];
                next[next.length - 1] = { ...turn, streaming: false };
                return next;
              });
              break;
            }

            case "turn_audio": {
              const index = event.index as number;
              const url = String(event.url);
              const seconds = event.seconds as number | undefined;

              setTurns((prev) => prev.map((t) => (t.index === index ? { ...t, audioUrl: url, seconds } : t)));
              queueRef.current.push({ index, url, kind: "turn" });
              pump();
              break;
            }

            case "filler": {
              // Instrumental interludes, rendered by the DSP rather than by a
              // model, for whenever the show is not ready to speak yet.
              const urls = (event.urls as unknown[] | undefined) ?? [];
              fillerRef.current = urls.map((u) => String(u)).filter(Boolean);
              fillerAtRef.current = 0;
              break;
            }

            case "bed_audio": {
              // Start the bed straight away. It is the first sound of the show
              // and, crucially, it is playing before the model has answered.
              const bed = bedElRef.current;
              if (bed && soundOnRef.current) {
                bed.src = String(event.url);
                bed.volume = 0;
                void bed
                  .play()
                  .then(() => rampBed(bedLevelRef.current.idle))
                  .catch(() => {
                    // Blocked until the listener interacts; the main element
                    // reports that, and the bed joins on the next pump.
                  });
              }
              break;
            }

            case "open_audio": {
              const url = String(event.url);
              const seconds = event.seconds as number | undefined;
              setOpenItem({ text: String(event.text ?? ""), seconds });
              queueRef.current.push({ index: -1, url, kind: "open" });
              pump();
              break;
            }

            case "song_intro_audio": {
              const url = String(event.url);
              setSongItem((prev) => ({ label: prev?.label ?? "", text: String(event.text ?? "") }));
              queueRef.current.push({ index: -1, url, kind: "songintro" });
              pump();
              break;
            }

            case "song_audio": {
              // The record is queued behind the throw, so it starts the moment
              // the announcer stops — and the hosts' first turns are being
              // written underneath it the whole time it plays.
              const url = String(event.url);
              const label = String(event.label ?? "");
              setSongItem((prev) => ({ label, text: prev?.text ?? "" }));
              queueRef.current.push({ index: -1, url, kind: "song" });
              pump();
              break;
            }

            case "breaks":
              setBreaks(event.breaks as PlannedBreak[]);
              break;

            case "break_audio": {
              const index = event.index as number;
              const url = String(event.url);
              const seconds = event.seconds as number | undefined;
              const label = String(event.label ?? "Commercial break");

              // The break follows whichever line threw to it.
              const afterIndex = lastTurnIndexRef.current;
              setBreakItems((items) =>
                items.some((b) => b.index === index)
                  ? items
                  : [...items, { index, afterIndex, label, seconds }],
              );

              queueRef.current.push({ index: -2 - index, url, kind: "break" });
              pump();
              break;
            }

            case "audio_progress":
              setAudioProgress({
                done: event.done as number,
                total: event.total as number,
                speaker: String(event.speaker ?? ""),
              });
              break;

            case "notes":
              setLogs((prev) => [...prev.slice(-99), `Titled: ${event.title}`]);
              break;

            case "done": {
              const show = event.show as Show;
              finished = true;
              setResult(show);
              setStage("done");
              setLogs((prev) => [...prev.slice(-99), `Finished in ${event.elapsedSeconds}s.`]);
              void refreshShows();
              break;
            }

            case "cancelled":
              finished = true;
              setStage("cancelled");
              break;

            case "error":
              finished = true;
              setStage("error");
              setError({ message: String(event.message), hint: event.hint ? String(event.hint) : undefined });
              break;
          }
        }
        // Reaching here means the stream closed. If it closed without a final
        // event, the server went away mid-show — say so rather than sitting
        // there looking frozen.
        if (!finished) {
          setStage("error");
          setError({
            message: "The connection to the server was lost before the show finished.",
            hint: "The server restarted or stopped. Check its window is still open, then start the show again.",
          });
          stopPlayback();
        }
      } catch (err) {
        const e = err as Error;
        if (e.name === "AbortError") {
          setStage("cancelled");
        } else {
          setStage("error");
          setError({ message: e.message });
        }
        stopPlayback();
      } finally {
        setRunning(false);
        runningRef.current = false;
        // Anything still queued keeps playing; the bed stops once it drains.
        if (queueRef.current.length === 0 && !busyRef.current) stopBed();
        abortRef.current = null;
      }
    },
    [config, refreshShows, pump, stopPlayback, rampBed, stopBed],
  );

  const cancel = useCallback(() => {
    // Tell the server first so the model call is dropped, then close the stream.
    void api.cancel(jobIdRef.current).catch(() => {});
    abortRef.current?.abort();
    stopPlayback();
  }, [stopPlayback]);

  const callIn = useCallback(async (name: string, text: string) => {
    await api.callIn(jobIdRef.current, name, text);
  }, []);

  const remove = useCallback(
    async (show: Show) => {
      if (!window.confirm(`Delete "${show.title}"? This removes the folder and its audio from disk.`)) return;
      await api.deleteShow(show.id);
      if (openShow?.id === show.id) setOpenShow(null);
      if (result?.id === show.id) setResult(null);
      await refreshShows();
    },
    [openShow, result, refreshShows],
  );

  /* ── Render ────────────────────────────────────────────────── */

  if (bootError) {
    return (
      <div className="mx-auto max-w-md px-5 py-24">
        <Callout tone="error" title="Could not reach the server">
          {bootError}
        </Callout>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="font-mono text-sm text-[var(--color-mute)]">Starting…</span>
      </div>
    );
  }

  const tabs: Array<{ id: Tab; label: string; icon: typeof Radio }> = [
    { id: "studio", label: "Studio", icon: Radio },
    { id: "realm", label: "Realm", icon: Crown },
    { id: "commercials", label: "Commercials", icon: Megaphone },
    { id: "library", label: "Library", icon: LibraryIcon },
    { id: "files", label: "Files", icon: HardDrive },
    { id: "settings", label: "Settings", icon: SlidersHorizontal },
  ];

  return (
    <div className="min-h-full">
      <StaleBuildBanner />

      <header className="sticky top-0 z-20 border-b border-[var(--color-line)] bg-[var(--color-ink)]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-5 px-5 py-3">
          <button
            onClick={() => {
              setTab("studio");
              setOpenShow(null);
            }}
            className="flex items-center gap-2.5"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--color-amber)]/50 bg-[var(--color-amber)]/10">
              <span className={`h-2 w-2 rounded-full bg-[var(--color-amber)] ${running ? "live-dot" : ""}`} />
            </span>
            <span className="font-serif text-lg tracking-tight text-white">{config.show.station}</span>
          </button>

          <nav className="ml-auto flex items-center gap-1">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => {
                  setTab(id);
                  setOpenShow(null);
                  if (id === "library") void refreshShows();
                }}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  tab === id && !openShow
                    ? "bg-[var(--color-panel-2)] text-white"
                    : "text-[var(--color-dim)] hover:text-white"
                }`}
              >
                <Icon size={14} />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </nav>

          <div className="hidden items-center gap-2 border-l border-[var(--color-line)] pl-4 md:flex">
            <StatusDot state={running ? "busy" : config.llm.model ? "ok" : "unknown"} />
            <span className="max-w-[190px] truncate font-mono text-[11px] text-[var(--color-mute)]">
              {config.llm.model || "no model selected"}
            </span>
          </div>
        </div>
      </header>

      <main>
        {openShow ? (
          <Player show={openShow} onBack={() => setOpenShow(null)} onDelete={remove} />
        ) : tab === "studio" ? (
          <Studio
            config={config}
            options={options}
            onChange={setConfig}
            onGenerate={generate}
            onCancel={cancel}
            running={running}
            stage={stage}
            turns={turns}
            outline={outline}
            logs={logs}
            timings={timings}
            error={error}
            audioProgress={audioProgress}
            elapsed={elapsed}
            result={result}
            onOpenResult={() => result && setOpenShow(result)}
            soundOn={soundOn}
            onToggleSound={toggleSound}
            speakingIndex={speakingIndex}
            audioBlocked={audioBlocked}
            onCallIn={callIn}
            brief={brief}
            breaks={breaks}
            breakItems={breakItems}
            openItem={openItem}
            nowPlaying={nowPlaying}
            songItem={songItem}
          />
        ) : tab === "realm" ? (
          <Realm
            config={config}
            onChange={setConfig}
            running={running}
            onCancel={cancel}
            // Starting a court hands over to the Studio, which is where the
            // broadcast panel lives — there is no second live feed to build.
            onHoldCourt={(topic: string) => {
              setTab("studio");
              void generate(topic, [], "");
            }}
          />
        ) : tab === "commercials" ? (
          <Commercials />
        ) : tab === "library" ? (
          <Library shows={shows} onOpen={setOpenShow} onDelete={remove} onNew={() => setTab("studio")} />
        ) : tab === "files" ? (
          <Files
            onOpenShow={(id) => {
              void api.getShow(id).then(setOpenShow).catch(() => {});
            }}
          />
        ) : (
          <Settings
            config={config}
            options={options}
            onChange={setConfig}
            onSaved={() => {}}
            configPath={configPath}
          />
        )}
      </main>

      <footer className="border-t border-[var(--color-line)] px-5 py-4">
        <p className="mx-auto flex max-w-7xl items-center gap-2 font-mono text-[11px] text-[var(--color-mute)]">
          <Cpu size={12} />
          Runs entirely on this machine — {config.llm.provider} · {config.tts.engine === "none" ? "no speech" : config.tts.engine}
        </p>
      </footer>
    </div>
  );
}

/**
 * "Am I looking at the latest version?"
 *
 * The server compiles from source once, at boot, and then serves whatever it
 * compiled for as long as the window stays open. Change the code underneath a
 * running window and nothing about the screen says so — which is how a fix
 * gets tested against the code it was meant to replace.
 *
 * So the server reports when it started and when the code last changed, and
 * when the second is later than the first this says so, in the one place
 * nobody can miss.
 */
function StaleBuildBanner() {
  const [stale, setStale] = useState<{ codeAt: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch("/api/health");
        const body = (await res.json()) as { stale?: boolean; codeAt?: string };
        if (!cancelled) setStale(body.stale ? { codeAt: String(body.codeAt ?? "") } : null);
      } catch {
        // The server is gone; the banner is the least of it.
      }
    };

    void check();
    const timer = setInterval(check, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!stale) return null;

  const changed = stale.codeAt ? new Date(stale.codeAt) : null;

  return (
    <div className="border-b border-[var(--color-amber)]/40 bg-[var(--color-amber)]/10 px-5 py-2">
      <p className="mx-auto max-w-7xl text-xs leading-relaxed text-[var(--color-amber)]">
        <strong className="font-semibold">This window is running older code.</strong>{" "}
        The app was updated
        {changed ? ` at ${changed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}, after
        this window started. Close the Local Talk Radio window and open the shortcut again to pick it up —
        reloading the page is not enough.
      </p>
    </div>
  );
}
