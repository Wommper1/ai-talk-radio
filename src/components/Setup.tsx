import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Cpu, Download, ExternalLink, Mic, RefreshCw, Radio } from "lucide-react";
import type { Config, ModelInfo, Options, PiperSetupStatus, ProbeResult, Voice } from "../types";
import { api } from "../lib/api";
import { Button, Callout, Select, StatusDot } from "./ui";

/**
 * First-run setup.
 *
 * A new listener has to find a model server, pick a model and get a voice
 * before the first show can run, and each of those used to mean a trip to
 * Settings or a terminal. This screen checks all three, fixes what it can by
 * itself (it finds LM Studio or Ollama on their usual ports, chooses the model
 * when only one is loaded, downloads offline voices with a button) and says
 * exactly what to do about the rest.
 */

type Engine = Config["tts"]["engine"];

type ServerState =
  | { state: "checking" }
  | { state: "found"; provider: Config["llm"]["provider"]; baseUrl: string; label: string; models: ModelInfo[] }
  | { state: "missing"; error?: string };

const ENGINE_INFO: Record<Exclude<Engine, "none">, { label: string; blurb: string }> = {
  edge: { label: "Edge voices", blurb: "The most natural voices. Needs an internet connection; each line is sent to Microsoft to be spoken." },
  piper: { label: "Piper voices", blurb: "Good quality and fully offline. Nothing leaves this computer." },
  sapi: { label: "Windows voices", blurb: "Built into Windows. Basic quality, nothing to install." },
};

/** Models that cannot hold a conversation, so they are never offered as a host. */
const isChatModel = (m: ModelInfo) => !/embed|rerank|whisper|clip/i.test(m.id);

export function Setup({
  config,
  options,
  onDone,
  onSkip,
}: {
  config: Config;
  options: Options | null;
  onDone: (config: Config) => void;
  onSkip: () => void;
}) {
  const [server, setServer] = useState<ServerState>({ state: "checking" });
  const [model, setModel] = useState(config.llm.model);
  const [voices, setVoices] = useState<Partial<Record<Exclude<Engine, "none">, ProbeResult<Voice>>>>({});
  const [checkingVoices, setCheckingVoices] = useState(true);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [piper, setPiper] = useState<PiperSetupStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const engineTouched = useRef(false);

  /* ── 1. Find a model server ───────────────────────────────── */

  const findServer = useCallback(async () => {
    setServer({ state: "checking" });

    // What is configured first, then LM Studio and Ollama on their usual ports.
    const candidates: Array<{ provider: Config["llm"]["provider"]; baseUrl: string }> = [
      { provider: config.llm.provider, baseUrl: config.llm.baseUrl },
    ];
    for (const id of ["lmstudio", "ollama"] as const) {
      const baseUrl = options?.providers.find((p) => p.id === id)?.baseUrl;
      if (baseUrl && !candidates.some((c) => c.baseUrl === baseUrl)) candidates.push({ provider: id, baseUrl });
    }

    let lastError: string | undefined;
    for (const candidate of candidates) {
      try {
        const probe = await api.checkLlm({ ...config, llm: { ...config.llm, ...candidate } });
        const models = (probe.models ?? []).filter(isChatModel);
        if (probe.ok && models.length > 0) {
          const label = options?.providers.find((p) => p.id === candidate.provider)?.label ?? candidate.provider;
          setServer({ state: "found", ...candidate, label, models });
          // Keep a model that is still there; otherwise choose for the listener when there is only one choice.
          setModel((current) =>
            models.some((m) => m.id === current) ? current : models.length === 1 ? models[0].id : "",
          );
          return;
        }
        if (probe.ok) lastError = "The server is running but has no model loaded.";
        else lastError ??= probe.error;
      } catch (err) {
        lastError ??= (err as Error).message;
      }
    }
    setServer({ state: "missing", error: lastError });
  }, [config, options]);

  useEffect(() => {
    if (options) void findServer();
    // Run once options arrive; "Check again" calls it after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  /* ── 2. Find a voice ─────────────────────────────────────── */

  const checkVoices = useCallback(async () => {
    setCheckingVoices(true);
    const engines = ["edge", "piper", "sapi"] as const;
    const results = await Promise.all(
      engines.map((e) =>
        api
          .checkTts({ ...config, tts: { ...config.tts, engine: e } })
          .catch((err: Error) => ({ ok: false, error: err.message }) as ProbeResult<Voice>),
      ),
    );
    const found = Object.fromEntries(engines.map((e, i) => [e, results[i]])) as typeof voices;
    setVoices(found);
    setCheckingVoices(false);

    // Choose for the listener unless they already chose: what is configured if it works, else the best that does.
    if (!engineTouched.current) {
      const current = config.tts.engine;
      const ready = (e: Engine) => e === "none" || Boolean(found[e as Exclude<Engine, "none">]?.ok);
      const pick = ready(current) && current !== "none" ? current : engines.find((e) => ready(e)) ?? null;
      setEngine(pick);
    }
  }, [config]);

  useEffect(() => {
    void checkVoices();
    void api.piperSetup().then(setPiper).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While the download runs, follow it; when it finishes, look at the voices again.
  useEffect(() => {
    if (piper?.state !== "running") return;
    const timer = window.setInterval(async () => {
      try {
        const next = await api.piperSetup();
        setPiper(next);
        if (next.state === "done") {
          engineTouched.current = true;
          setEngine("piper");
          void checkVoices();
        }
      } catch {
        /* the next tick will try again */
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [piper?.state, checkVoices]);

  const startPiper = async () => {
    try {
      setPiper(await api.startPiperSetup());
    } catch (err) {
      setPiper({ state: "failed", lines: [], error: (err as Error).message, installed: [], voices: [] });
    }
  };

  /* ── 3. Save and go ──────────────────────────────────────── */

  const ready = server.state === "found" && Boolean(model) && engine !== null;

  const finish = async () => {
    if (server.state !== "found" || !engine) return;
    setSaving(true);
    setSaveError(null);

    const next: Config = structuredClone(config);
    next.llm = { ...next.llm, provider: server.provider, baseUrl: server.baseUrl, model };
    next.tts = { ...next.tts, engine };

    // Every Piper voice the station will use must exist, or that speaker goes silent mid-show.
    if (engine === "piper") {
      const installed = (voices.piper?.voices ?? []).map((v) => v.id);
      if (installed.length > 0) {
        const ensure = (current: string, fallback: number) =>
          installed.includes(current) ? current : installed[fallback % installed.length];
        const [a, b] = next.hosts;
        next.hosts = [
          { ...a, voices: { ...a.voices, piper: ensure(a.voices.piper, 0) } },
          { ...b, voices: { ...b.voices, piper: ensure(b.voices.piper, 1) } },
        ];
        next.caller = { ...next.caller, voices: { ...next.caller.voices, piper: ensure(next.caller.voices.piper, 2) } };
        next.ads = {
          ...next.ads,
          announcer: {
            ...next.ads.announcer,
            voices: { ...next.ads.announcer.voices, piper: ensure(next.ads.announcer.voices.piper, 0) },
          },
        };
      }
    }

    try {
      const saved = await api.saveConfig(next);
      onDone(saved.config);
    } catch (err) {
      setSaveError((err as Error).message);
      setSaving(false);
    }
  };

  /* ── Layout ──────────────────────────────────────────────── */

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-5 py-8">
      <div>
        <h1 className="font-serif text-3xl tracking-tight text-white">Set up your station</h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-dim)]">
          Two things before the first show: a model to write the hosts' lines, and voices to speak them.
          Everything that can be checked is checked for you.
        </p>
      </div>

      {/* Step 1: model server and model */}
      <Step
        n={1}
        title="The hosts' brain"
        icon={<Cpu size={15} />}
        done={server.state === "found" && Boolean(model)}
        right={
          <Button size="sm" onClick={() => void findServer()} disabled={server.state === "checking"}>
            <RefreshCw size={13} className={server.state === "checking" ? "animate-spin" : ""} />
            {server.state === "checking" ? "Looking" : "Check again"}
          </Button>
        }
      >
        {server.state === "checking" && <p className="text-sm text-[var(--color-dim)]">Looking for LM Studio or Ollama on this computer…</p>}

        {server.state === "found" && (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm text-[var(--color-good)]">
              <Check size={14} /> Found {server.label} with {server.models.length} model
              {server.models.length === 1 ? "" : "s"}.
            </p>
            {server.models.length === 1 ? (
              <p className="text-sm text-[var(--color-dim)]">
                The hosts will use <span className="font-mono text-white">{server.models[0].label}</span>.
              </p>
            ) : (
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-dim)]" htmlFor="setup-model">
                  Which model should the hosts use?
                </label>
                <Select id="setup-model" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">Choose a model…</option>
                  {server.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </Select>
                <p className="text-xs leading-relaxed text-[var(--color-mute)]">
                  A plain instruct model of about 8B works best, such as Qwen, Gemma or Mistral. Avoid reasoning
                  models (DeepSeek-R1, gpt-oss) and coding models: they are slow and stiff on air.
                </p>
              </div>
            )}
          </div>
        )}

        {server.state === "missing" && (
          <div className="space-y-3 text-sm leading-relaxed text-[var(--color-dim)]">
            <p>
              No model server is running on this computer
              {server.error ? <span className="text-[var(--color-mute)]"> ({server.error})</span> : null}. The
              station needs one to write the hosts' lines. The easiest is LM Studio:
            </p>
            <ol className="ml-5 list-decimal space-y-1.5">
              <li>
                Install{" "}
                <a className="inline-flex items-center gap-1 text-[var(--color-amber)] underline" href="https://lmstudio.ai" target="_blank" rel="noreferrer">
                  LM Studio <ExternalLink size={11} />
                </a>{" "}
                and open it.
              </li>
              <li>
                Search for and download a model such as <span className="font-mono text-white">Qwen2.5 7B Instruct</span>.
              </li>
              <li>
                Open the <strong className="text-white">Developer</strong> tab, load the model and press{" "}
                <strong className="text-white">Start Server</strong>.
              </li>
              <li>
                Come back here and press <strong className="text-white">Check again</strong>.
              </li>
            </ol>
            <p className="text-xs text-[var(--color-mute)]">
              Already use Ollama? Run <span className="font-mono">ollama serve</span> with a model pulled and it will be
              found the same way. Other servers can be set under Settings.
            </p>
          </div>
        )}
      </Step>

      {/* Step 2: voice */}
      <Step
        n={2}
        title="Their voices"
        icon={<Mic size={15} />}
        done={engine !== null && !checkingVoices}
        right={
          <Button size="sm" onClick={() => void checkVoices()} disabled={checkingVoices}>
            <RefreshCw size={13} className={checkingVoices ? "animate-spin" : ""} />
            {checkingVoices ? "Checking" : "Check again"}
          </Button>
        }
      >
        <div className="space-y-2">
          {(["edge", "piper", "sapi"] as const).map((e) => {
            const probe = voices[e];
            // Windows voices only exist on Windows; do not offer a dead end anywhere else.
            if (e === "sapi" && !probe?.ok) return null;
            const ok = Boolean(probe?.ok);
            return (
              <EngineRow
                key={e}
                selected={engine === e}
                disabled={!ok}
                onSelect={() => {
                  engineTouched.current = true;
                  setEngine(e);
                }}
                state={checkingVoices && !probe ? "busy" : ok ? "ok" : "unknown"}
                label={ENGINE_INFO[e].label}
                blurb={ENGINE_INFO[e].blurb}
                status={ok ? `${probe?.voices?.length ?? 0} voices ready` : "Not installed"}
              >
                {e === "piper" && !ok && (
                  <PiperInstall status={piper} onStart={() => void startPiper()} />
                )}
                {e === "edge" && !ok && !checkingVoices && (
                  <p className="mt-2 text-xs leading-relaxed text-[var(--color-mute)]">
                    Optional. To add them, run <span className="font-mono text-[var(--color-dim)]">npm run setup-edge-tts</span>{" "}
                    once (Windows), then press Check again. The README has the macOS and Linux command.
                  </p>
                )}
              </EngineRow>
            );
          })}
          <EngineRow
            selected={engine === "none"}
            onSelect={() => {
              engineTouched.current = true;
              setEngine("none");
            }}
            state="ok"
            label="No voices"
            blurb="Transcript only. Useful for trying the station out; you can add voices later in Settings."
          />
        </div>
      </Step>

      {/* Finish */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-5 py-4">
        <button onClick={onSkip} className="text-xs text-[var(--color-mute)] underline hover:text-white">
          Skip setup, I'll use Settings
        </button>
        <div className="flex items-center gap-3">
          {!ready && (
            <span className="text-xs text-[var(--color-mute)]">
              {server.state !== "found" ? "Waiting for a model server" : !model ? "Choose a model" : "Choose a voice"}
            </span>
          )}
          <Button variant="primary" onClick={() => void finish()} disabled={!ready || saving}>
            <Radio size={14} />
            {saving ? "Saving" : "Go to the studio"}
          </Button>
        </div>
      </div>
      {saveError && (
        <Callout tone="error" title="Could not save the setup">
          {saveError}
        </Callout>
      )}
    </div>
  );
}

function Step({
  n,
  title,
  icon,
  done,
  right,
  children,
}: {
  n: number;
  title: string;
  icon: ReactNode;
  done: boolean;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] texture">
      <header className="flex items-center justify-between gap-4 border-b border-[var(--color-line)] px-5 py-3.5">
        <h2 className="flex items-center gap-2.5 text-sm font-semibold text-white">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full border text-[11px] ${
              done
                ? "border-[var(--color-good)] bg-[var(--color-good)]/15 text-[var(--color-good)]"
                : "border-[var(--color-line-bright)] text-[var(--color-dim)]"
            }`}
          >
            {done ? <Check size={12} /> : n}
          </span>
          <span className="text-[var(--color-dim)]">{icon}</span>
          {title}
        </h2>
        {right}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function EngineRow({
  selected,
  disabled = false,
  onSelect,
  state,
  label,
  blurb,
  status,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  state: "ok" | "bad" | "unknown" | "busy";
  label: string;
  blurb: string;
  status?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 transition-colors ${
        selected ? "border-[var(--color-amber)] bg-[var(--color-amber)]/5" : "border-[var(--color-line)]"
      }`}
    >
      <label className={`flex items-start gap-3 ${disabled ? "cursor-default" : "cursor-pointer"}`}>
        <input
          type="radio"
          name="setup-engine"
          className="mt-1 accent-[var(--color-amber)]"
          checked={selected}
          disabled={disabled}
          onChange={onSelect}
        />
        <span className="flex-1">
          <span className="flex items-center gap-2 text-sm font-medium text-white">
            {label}
            {status && (
              <span className="flex items-center gap-1.5 font-mono text-[11px] font-normal text-[var(--color-mute)]">
                <StatusDot state={state} /> {status}
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-[var(--color-dim)]">{blurb}</span>
        </span>
      </label>
      {children && <div className="ml-7">{children}</div>}
    </div>
  );
}

function PiperInstall({ status, onStart }: { status: PiperSetupStatus | null; onStart: () => void }) {
  const running = status?.state === "running";
  const last = status?.lines[status.lines.length - 1];

  return (
    <div className="mt-2 space-y-2">
      {running ? (
        <p className="flex items-center gap-2 text-xs text-[var(--color-amber)]">
          <RefreshCw size={12} className="animate-spin" /> {last ?? "Starting the download"}
        </p>
      ) : (
        <Button size="sm" onClick={onStart}>
          <Download size={13} />
          {status?.state === "failed" ? "Try the download again" : "Download offline voices (about 300 MB)"}
        </Button>
      )}
      {status?.state === "failed" && status.error && (
        <p className="text-xs leading-relaxed text-[#fca5a5]">{status.error}</p>
      )}
    </div>
  );
}
