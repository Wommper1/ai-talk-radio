import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Play, RotateCcw, Save, Check } from "lucide-react";
import type { Config, HostConfig, MemoryStats, ModelInfo, Options, TtsEngine, Voice } from "../types";
import { api } from "../lib/api";
import { Button, Callout, Field, Input, Panel, Select, Slider, StatusDot, Textarea, Toggle } from "./ui";
import { Ads } from "./Ads";

interface Props {
  config: Config;
  options: Options | null;
  onChange: (config: Config) => void;
  onSaved: () => void;
  configPath: string;
}

type ProbeState = "unknown" | "busy" | "ok" | "bad";

export function Settings({ config, options, onChange, onSaved, configPath }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [llmState, setLlmState] = useState<ProbeState>("unknown");
  const [ttsState, setTtsState] = useState<ProbeState>("unknown");
  const [llmError, setLlmError] = useState<{ error?: string; hint?: string } | null>(null);
  const [ttsError, setTtsError] = useState<{ error?: string; hint?: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [previewing, setPreviewing] = useState<number | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [memStats, setMemStats] = useState<MemoryStats | null>(null);
  const [memBusy, setMemBusy] = useState(false);
  const [memQuery, setMemQuery] = useState("");
  const [memResults, setMemResults] = useState<Array<{ showTitle: string; date: string; text: string }> | null>(
    null,
  );
  const [memError, setMemError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const rebuildMemory = async () => {
    setMemBusy(true);
    setMemError(null);
    try {
      const result = await api.rebuildMemory();
      if (result.error) setMemError(result.error);
      setMemStats(await api.memory());
    } catch (err) {
      setMemError((err as Error).message);
    } finally {
      setMemBusy(false);
    }
  };

  const searchMemory = async () => {
    if (!memQuery.trim()) return;
    setMemBusy(true);
    setMemError(null);
    try {
      const { results } = await api.searchMemory(memQuery.trim(), config);
      setMemResults(results);
    } catch (err) {
      setMemError((err as Error).message);
    } finally {
      setMemBusy(false);
    }
  };

  const update = useCallback(
    <K extends keyof Config>(key: K, value: Partial<Config[K]>) => {
      onChange({ ...config, [key]: { ...config[key], ...value } } as Config);
    },
    [config, onChange],
  );

  const updateHost = useCallback(
    (index: 0 | 1, patch: Partial<HostConfig>) => {
      const hosts = [...config.hosts] as [HostConfig, HostConfig];
      hosts[index] = { ...hosts[index], ...patch };
      onChange({ ...config, hosts });
    },
    [config, onChange],
  );

  const checkLlm = useCallback(
    async (cfg: Config) => {
      setLlmState("busy");
      setLlmError(null);
      try {
        const result = await api.checkLlm(cfg);
        setModels(result.models ?? []);
        setLlmState(result.ok ? "ok" : "bad");
        if (!result.ok) setLlmError({ error: result.error, hint: result.hint });
      } catch (err) {
        setLlmState("bad");
        setLlmError({ error: (err as Error).message });
      }
    },
    [],
  );

  const checkTts = useCallback(async (cfg: Config) => {
    setTtsState("busy");
    setTtsError(null);
    try {
      const result = await api.checkTts(cfg);
      setVoices(result.voices ?? []);
      setTtsState(result.ok ? "ok" : "bad");
      if (!result.ok) setTtsError({ error: result.error, hint: result.hint });
    } catch (err) {
      setTtsState("bad");
      setTtsError({ error: (err as Error).message });
    }
  }, []);

  // Opening Settings should not wake LM Studio or the speech engine. The
  // Refresh buttons do that explicitly; everything else here is local state.
  useEffect(() => {
    void api.memory().then(setMemStats).catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const save = async () => {
    await api.saveConfig(config);
    setSaved(true);
    onSaved();
    setTimeout(() => setSaved(false), 1800);
  };

  const reset = async () => {
    const { config: fresh } = await api.resetConfig();
    onChange(fresh);
    setModels([]);
    setVoices([]);
    setLlmState("unknown");
    setTtsState("unknown");
    setLlmError(null);
    setTtsError(null);
  };

  const preview = async (index: 0 | 1) => {
    setPreviewing(index);
    setPreviewError(null);
    try {
      const url = await api.previewVoice(config, index);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = url;

      if (!audioRef.current) audioRef.current = new Audio();
      audioRef.current.src = url;
      await audioRef.current.play();
    } catch (err) {
      setPreviewError((err as Error).message);
    } finally {
      setPreviewing(null);
    }
  };

  // The preset name is a starting point, not a lock — settings can be edited
  // afterwards. Showing when they diverge stops "Studio" claiming stereo that
  // has since been switched off.
  const PRESET_VALUES: Record<string, Omit<Config["audio"], "preset">> = {
    standard: { sampleRate: 22050, bitDepth: 16, stereo: false, width: 0, compress: false },
    high: { sampleRate: 44100, bitDepth: 16, stereo: true, width: 0.35, compress: true },
    studio: { sampleRate: 48000, bitDepth: 24, stereo: true, width: 0.45, compress: true },
  };

  const presetBase = PRESET_VALUES[config.audio.preset];
  const presetModified = presetBase
    ? presetBase.sampleRate !== config.audio.sampleRate ||
      presetBase.bitDepth !== config.audio.bitDepth ||
      presetBase.stereo !== config.audio.stereo ||
      presetBase.compress !== config.audio.compress
    : false;

  const onProviderChange = (providerId: string) => {
    const provider = options?.providers.find((p) => p.id === providerId);
    // Switching provider swaps in that provider's default URL and clears the
    // stale model id, which will not exist on the new backend.
    update("llm", {
      provider: providerId as Config["llm"]["provider"],
      baseUrl: provider?.baseUrl ?? config.llm.baseUrl,
      model: "",
    });
    setModels([]);
    setLlmState("unknown");
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-5 py-6">
      {/* ── Model ─────────────────────────────────────────────── */}
      <Panel
        title="Language model"
        subtitle="Where the hosts' dialogue comes from."
        right={
          <div className="flex items-center gap-2">
            <StatusDot state={llmState} />
            <Button size="sm" onClick={() => void checkLlm(config)} disabled={llmState === "busy"}>
              <RefreshCw size={13} className={llmState === "busy" ? "animate-spin" : ""} />
              {llmState === "busy" ? "Checking" : "Refresh"}
            </Button>
          </div>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Provider">
            <Select value={config.llm.provider} onChange={(e) => onProviderChange(e.target.value)}>
              {options?.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Server address">
            <Input
              value={config.llm.baseUrl}
              onChange={(e) => update("llm", { baseUrl: e.target.value })}
              placeholder="http://127.0.0.1:1234/v1"
              spellCheck={false}
            />
          </Field>

          <Field
            label="DJ model"
            hint={
              models.length > 0
                ? `${models.length} model${models.length === 1 ? "" : "s"} available.`
                : "Press Refresh once your server is running."
            }
            className="sm:col-span-2"
          >
            {models.length > 0 ? (
              <Select value={config.llm.model} onChange={(e) => update("llm", { model: e.target.value })}>
                <option value="">Select a model…</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                value={config.llm.model}
                onChange={(e) => update("llm", { model: e.target.value })}
                placeholder="Model id"
                spellCheck={false}
              />
            )}
          </Field>

          <Field
            label="Producer model"
            hint="Optional. Use a reasoning model for topic structure; blank uses the DJ model."
            className="sm:col-span-2"
          >
            {models.length > 0 ? (
              <Select
                value={config.llm.producerModel}
                onChange={(e) => update("llm", { producerModel: e.target.value })}
              >
                <option value="">Same as DJ model</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                value={config.llm.producerModel}
                onChange={(e) => update("llm", { producerModel: e.target.value })}
                placeholder="Same as DJ model"
                spellCheck={false}
              />
            )}
          </Field>

          {(["notesModel", "commercialModel"] as const).map((key) => (
            <Field
              key={key}
              label={key === "notesModel" ? "Notes model" : "Commercial model"}
              hint={key === "notesModel" ? "Optional. A small model is enough for titles and summaries." : "Optional. Keeps ad writing off the live DJ model."}
              className="sm:col-span-2"
            >
              {models.length > 0 ? (
                <Select value={config.llm[key]} onChange={(e) => update("llm", { [key]: e.target.value })}>
                  <option value="">Same as DJ model</option>
                  {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                </Select>
              ) : (
                <Input value={config.llm[key]} onChange={(e) => update("llm", { [key]: e.target.value })} placeholder="Same as DJ model" spellCheck={false} />
              )}
            </Field>
          ))}

          {config.llm.provider === "gemini" && (
            <Field label="API key" hint="Stored in config.json on this machine." className="sm:col-span-2">
              <Input
                type="password"
                value={config.llm.apiKey}
                onChange={(e) => update("llm", { apiKey: e.target.value })}
                placeholder="Required for the cloud provider"
                autoComplete="off"
              />
            </Field>
          )}

          <Slider
            label="Max tokens per turn"
            value={config.llm.maxTokens}
            min={64}
            max={2048}
            step={32}
            onChange={(maxTokens) => update("llm", { maxTokens })}
            hint="A hard ceiling. Turn length is really set per host below."
          />

          <Slider
            label="Request timeout"
            value={config.llm.timeoutSeconds}
            min={30}
            max={900}
            step={30}
            onChange={(timeoutSeconds) => update("llm", { timeoutSeconds })}
            format={(v) => `${v}s`}
            hint="Raise this if a large model is slow to answer."
          />
        </div>

        {llmError && (
          <div className="mt-4">
            <Callout tone="error" title={llmError.error}>
              {llmError.hint}
            </Callout>
          </div>
        )}
      </Panel>

      {/* ── Speech ────────────────────────────────────────────── */}
      <Panel
        title="Speech"
        subtitle="How the dialogue is turned into audio."
        right={
          <div className="flex items-center gap-2">
            <StatusDot state={ttsState} />
            <Button size="sm" onClick={() => void checkTts(config)} disabled={ttsState === "busy"}>
              <RefreshCw size={13} className={ttsState === "busy" ? "animate-spin" : ""} />
              {ttsState === "busy" ? "Checking" : "Refresh"}
            </Button>
          </div>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Engine">
            <Select
              value={config.tts.engine}
              onChange={(e) => {
                const engine = e.target.value as Config["tts"]["engine"];
                const next = { ...config, tts: { ...config.tts, engine } };
                onChange(next);
                setVoices([]);
                setTtsState("unknown");
                setTtsError(null);
              }}
            >
              {options?.ttsEngines.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Voices found">
            <div className="flex h-[38px] items-center rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 text-sm text-[var(--color-dim)]">
              {config.tts.engine === "none" ? "Speech is off" : `${voices.length} voice${voices.length === 1 ? "" : "s"}`}
            </div>
          </Field>

          {config.tts.engine === "piper" && (
            <>
              <Field label="Piper folder" hint="Folder containing piper.exe.">
                <Input
                  value={config.tts.piperPath}
                  onChange={(e) => update("tts", { piperPath: e.target.value })}
                  placeholder="C:\\tools\\piper"
                  spellCheck={false}
                />
              </Field>
              <Field label="Voices folder" hint="Folder containing .onnx voice models.">
                <Input
                  value={config.tts.piperVoicesDir}
                  onChange={(e) => update("tts", { piperVoicesDir: e.target.value })}
                  placeholder="C:\\tools\\piper\\voices"
                  spellCheck={false}
                />
              </Field>
            </>
          )}
        </div>

        {ttsError && (
          <div className="mt-4">
            <Callout tone="error" title={ttsError.error}>
              {ttsError.hint}
            </Callout>
          </div>
        )}
      </Panel>

      {/* ── Station imaging ───────────────────────────────────── */}
      <Panel title="Station imaging" subtitle="The stings and cues that make it sound like a broadcast.">
        <div className="space-y-4">
          <Toggle
            label="Station ident"
            hint="A short signature at the top and tail of every show. Generated from the station name, so yours always sounds like yours."
            checked={config.imaging.useIdent}
            onChange={(useIdent) => update("imaging", { useIdent })}
          />
          <Toggle
            label="Transitions between segments"
            hint="A sweep as the show moves from one beat to the next."
            checked={config.imaging.useTransitions}
            onChange={(useTransitions) => update("imaging", { useTransitions })}
          />
          <Toggle
            label="Call cues"
            hint="A talkback blip as a caller comes on air, and a sweep as they are released."
            checked={config.imaging.useCallStings}
            onChange={(useCallStings) => update("imaging", { useCallStings })}
          />
          <Slider
            label="Imaging level"
            value={config.imaging.level}
            min={0}
            max={1}
            step={0.05}
            onChange={(level) => update("imaging", { level })}
            format={(v) => (v < 0.03 ? "off" : `${Math.round(v * 100)}%`)}
            hint="Stings sit over the dialogue rather than between it, the way a desk rides them."
          />
        </div>
      </Panel>

      {/* ── Ad breaks ─────────────────────────────────────────── */}
      <Ads config={config} options={options} onChange={onChange} voices={voices} />

      {/* ── Memory ────────────────────────────────────────────── */}
      <Panel
        title="Memory"
        subtitle="What the hosts remember, during a show and between shows."
        right={
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-[var(--color-mute)]">
              {memStats ? `${memStats.shows} shows · ${memStats.passages} passages` : "—"}
            </span>
            <Button size="sm" disabled={memBusy} onClick={() => void rebuildMemory()}>
              <RefreshCw size={13} className={memBusy ? "animate-spin" : ""} />
              Rebuild
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Toggle
            label="Remember the show as it goes"
            hint="Keeps a running digest, a list of established facts and the night's running jokes. This is what lets a host call something back an hour later — and it is the main reason a small model stops losing the thread."
            checked={config.memory.enabled}
            onChange={(enabled) => update("memory", { enabled })}
          />

          {config.memory.enabled && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Slider
                label="Turns kept word for word"
                value={config.memory.historyTurns}
                min={2}
                max={24}
                step={1}
                onChange={(historyTurns) => update("memory", { historyTurns })}
                hint="Older turns are represented by the digest instead. Lower keeps the prompt small, which is what small models need."
              />
              <Slider
                label="Refresh notes every"
                value={config.memory.updateEvery}
                min={1}
                max={8}
                step={1}
                onChange={(updateEvery) => update("memory", { updateEvery })}
                format={(v) => `${v} turn${v === 1 ? "" : "s"}`}
                hint="Each refresh is one extra model call."
              />
            </div>
          )}

          <Toggle
            label="Remember previous shows"
            hint="Searches past episodes for anything relevant to tonight's topic, so the hosts can genuinely say what they said last time."
            checked={config.memory.crossShow}
            onChange={(crossShow) => update("memory", { crossShow })}
          />

          {config.memory.crossShow && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="How it searches">
                  <Select
                    value={config.memory.backend}
                    onChange={(e) =>
                      update("memory", { backend: e.target.value as Config["memory"]["backend"] })
                    }
                  >
                    <option value="lexical">Keywords — no model, no VRAM</option>
                    <option value="embeddings">Vectors — needs an embedding model</option>
                  </Select>
                </Field>

                <Slider
                  label="Moments recalled"
                  value={config.memory.recallCount}
                  min={0}
                  max={6}
                  step={1}
                  onChange={(recallCount) => update("memory", { recallCount })}
                />
              </div>

              {config.memory.backend === "embeddings" && (
                <Field
                  label="Embedding model"
                  hint="Must be loaded in your server alongside the chat model. On a 6 GB card it competes for VRAM with the model writing the show."
                >
                  <Input
                    value={config.memory.embeddingModel}
                    onChange={(e) => update("memory", { embeddingModel: e.target.value })}
                    placeholder="text-embedding-nomic-embed-text-v1.5"
                    spellCheck={false}
                  />
                </Field>
              )}

              <div className="flex gap-2">
                <Input
                  value={memQuery}
                  onChange={(e) => setMemQuery(e.target.value)}
                  placeholder="Test what it remembers, e.g. dishwasher"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void searchMemory();
                  }}
                />
                <Button size="md" disabled={!memQuery.trim() || memBusy} onClick={() => void searchMemory()}>
                  Search
                </Button>
              </div>

              {memResults && (
                <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3">
                  {memResults.length === 0 ? (
                    <p className="text-xs text-[var(--color-mute)]">Nothing relevant in past shows.</p>
                  ) : (
                    <ul className="space-y-2">
                      {memResults.map((r, i) => (
                        <li key={i} className="text-xs leading-relaxed">
                          <span className="font-mono text-[10px] text-[var(--color-amber)]">
                            {r.date} · {r.showTitle}
                          </span>
                          <p className="mt-0.5 text-[var(--color-dim)]">{r.text.slice(0, 200)}…</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}

          {memError && <Callout tone="error">{memError}</Callout>}
        </div>
      </Panel>

      {/* ── Quality ───────────────────────────────────────────── */}
      <Panel
        title="Audio quality"
        subtitle="How the finished show is rendered."
        right={
          presetModified ? (
            <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--color-amber)]">
              edited
            </span>
          ) : null
        }
      >
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-3">
            {options?.qualityPresets.map((p) => {
              const active = config.audio.preset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() =>
                    // Apply the preset's values outright. Anything edited
                    // afterwards shows as "edited" above.
                    onChange({
                      ...config,
                      audio: {
                        preset: p.id as Config["audio"]["preset"],
                        ...(PRESET_VALUES[p.id] ?? {}),
                      } as Config["audio"],
                    })
                  }
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    active
                      ? "border-[var(--color-amber)] bg-[var(--color-amber)]/10"
                      : "border-[var(--color-line)] bg-[var(--color-panel-2)] hover:border-[var(--color-line-bright)]"
                  }`}
                >
                  <div className={`text-sm font-semibold ${active ? "text-[var(--color-amber)]" : "text-[#e8e8ee]"}`}>
                    {p.label}
                  </div>
                  <div className="mt-1 text-xs leading-relaxed text-[var(--color-mute)]">{p.description}</div>
                </button>
              );
            })}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sample rate">
              <Select
                value={String(config.audio.sampleRate)}
                onChange={(e) => update("audio", { sampleRate: Number(e.target.value) })}
              >
                {[22050, 24000, 32000, 44100, 48000].map((r) => (
                  <option key={r} value={r}>
                    {(r / 1000).toFixed(r % 1000 === 0 ? 0 : 3).replace(/\.?0+$/, "")} kHz
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Bit depth">
              <Select
                value={String(config.audio.bitDepth)}
                onChange={(e) => update("audio", { bitDepth: Number(e.target.value) as 16 | 24 })}
              >
                <option value="16">16-bit</option>
                <option value="24">24-bit</option>
              </Select>
            </Field>
          </div>

          <Toggle
            label="Level the dialogue"
            hint="Evens out loud and quiet lines so nothing gets lost under the music. This is the setting you actually hear."
            checked={config.audio.compress}
            onChange={(compress) => update("audio", { compress })}
          />

          <Toggle
            label="Stereo"
            hint="Places each host to one side, which makes them much easier to tell apart."
            checked={config.audio.stereo}
            onChange={(stereo) => update("audio", { stereo })}
          />

          {config.audio.stereo && (
            <Slider
              label="Host separation"
              value={config.audio.width}
              min={0}
              max={1}
              step={0.05}
              onChange={(width) => update("audio", { width })}
              format={(v) => (v < 0.03 ? "centre" : `${Math.round(v * 100)}%`)}
            />
          )}

          <Callout tone="info" title="What actually changes how it sounds">
            Sample rate and bit depth are capped by the voice itself — Piper produces 22 kHz and Edge
            24 kHz, so rendering above 44.1 kHz mainly makes larger files. In order of real impact:
            set a host&apos;s <strong>mic sound</strong> to Studio (Phone-in deliberately band-limits
            the voice to sound like a phone call, which is the single biggest quality reduction in the
            chain); switch the engine to <strong>Edge TTS</strong> for the most natural voices; pick a
            <code> -high</code> Piper voice; and leave levelling on.
          </Callout>
        </div>
      </Panel>

      {/* ── Host presets ──────────────────────────────────────── */}
      {options && options.hostPresets.length > 0 && (
        <Panel title="The pair" subtitle="Start from a pairing, then edit either host below.">
          <div className="grid gap-2 sm:grid-cols-3">
            {options.hostPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  // Names, character and angle come from the preset; voices,
                  // models and mic settings are yours and are left alone.
                  const hosts = config.hosts.map((h, i) => ({
                    ...h,
                    name: preset.hosts[i]?.name ?? h.name,
                    persona: preset.hosts[i]?.persona ?? h.persona,
                    stance: preset.hosts[i]?.stance ?? h.stance,
                  })) as Config["hosts"];
                  onChange({ ...config, hosts });
                }}
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3 text-left transition-colors hover:border-[var(--color-amber)]"
              >
                <div className="text-sm font-semibold text-[#e8e8ee]">{preset.label}</div>
                <div className="mt-1 text-xs leading-relaxed text-[var(--color-mute)]">{preset.description}</div>
                <div className="mt-2 font-mono text-[10px] text-[var(--color-amber)]">
                  {preset.hosts.map((h) => h.name).join(" · ")}
                </div>
              </button>
            ))}
          </div>
        </Panel>
      )}

      {/* ── Hosts ─────────────────────────────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-2">
        {config.hosts.map((host, i) => (
          <HostPanel
            key={host.id}
            host={host}
            index={i as 0 | 1}
            models={models}
            voices={voices}
            options={options}
            globalModel={config.llm.model}
            engine={config.tts.engine}
            ttsOff={config.tts.engine === "none"}
            previewing={previewing === i}
            onPreview={() => void preview(i as 0 | 1)}
            onChange={(patch) => updateHost(i as 0 | 1, patch)}
          />
        ))}
      </div>

      {previewError && <Callout tone="error">{previewError}</Callout>}

      {/* ── Save bar ──────────────────────────────────────────── */}
      <div className="sticky bottom-0 -mx-5 border-t border-[var(--color-line)] bg-[var(--color-ink)]/95 px-5 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-[11px] text-[var(--color-mute)]">{configPath}</p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void reset()}>
              <RotateCcw size={13} />
              Reset to defaults
            </Button>
            <Button variant="primary" onClick={() => void save()}>
              {saved ? <Check size={15} /> : <Save size={15} />}
              {saved ? "Saved" : "Save settings"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function HostPanel({
  host,
  index,
  models,
  voices,
  options,
  globalModel,
  engine,
  ttsOff,
  previewing,
  onPreview,
  onChange,
}: {
  host: HostConfig;
  index: 0 | 1;
  models: ModelInfo[];
  voices: Voice[];
  options: Options | null;
  globalModel: string;
  engine: TtsEngine;
  ttsOff: boolean;
  previewing: boolean;
  onPreview: () => void;
  onChange: (patch: Partial<HostConfig>) => void;
}) {
  return (
    <Panel
      title={`Host ${index + 1}`}
      subtitle={index === 0 ? "Opens and closes the show." : "Replies and pushes back."}
      right={
        <Button size="sm" onClick={onPreview} disabled={previewing || ttsOff} title={ttsOff ? "Speech is off" : "Hear this voice"}>
          {previewing ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}
          Preview
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={host.name} onChange={(e) => onChange({ name: e.target.value })} maxLength={40} />
          </Field>

          <Field label="Mic sound">
            <Select value={host.tone} onChange={(e) => onChange({ tone: e.target.value as HostConfig["tone"] })}>
              {options?.tones.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label} — {t.description}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="Voice"
          hint={
            ttsOff
              ? "Turn speech on to pick a voice."
              : "Remembered separately for each engine, so switching engines keeps your other choices."
          }
        >
          {voices.length > 0 ? (
            <Select
              value={host.voices[engine] ?? ""}
              onChange={(e) => onChange({ voices: { ...host.voices, [engine]: e.target.value } })}
              disabled={ttsOff}
            >
              <option value="">Default voice</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                  {v.detail ? ` — ${v.detail}` : ""}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              value={host.voices[engine] ?? ""}
              onChange={(e) => onChange({ voices: { ...host.voices, [engine]: e.target.value } })}
              placeholder="Voice id"
              disabled={ttsOff}
              spellCheck={false}
            />
          )}
        </Field>

        <Field
          label="Model"
          hint="Leave on Default to use the main model. Giving each host a different model is the best way to make them sound like different people."
        >
          {models.length > 0 ? (
            <Select value={host.model} onChange={(e) => onChange({ model: e.target.value })}>
              <option value="">Default — {globalModel || "not set"}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              value={host.model}
              onChange={(e) => onChange({ model: e.target.value })}
              placeholder="Leave empty for the default model"
              spellCheck={false}
            />
          )}
        </Field>

        <Field label="Character" hint="Who they are and how they talk. This is most of the system prompt.">
          <Textarea rows={4} value={host.persona} onChange={(e) => onChange({ persona: e.target.value })} />
        </Field>

        <Field label="Angle" hint="The position they argue from. Flip this to change the whole dynamic.">
          <Textarea rows={2} value={host.stance} onChange={(e) => onChange({ stance: e.target.value })} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Slider
            label="Words per turn"
            value={host.maxWords}
            min={20}
            max={220}
            step={5}
            onChange={(maxWords) => onChange({ maxWords })}
          />
          <Slider
            label="Temperature"
            value={host.temperature}
            min={0}
            max={1.5}
            step={0.05}
            onChange={(temperature) => onChange({ temperature })}
            format={(v) => v.toFixed(2)}
          />
        </div>

        <Slider
          label="Speaking rate"
          value={host.rate}
          min={-10}
          max={10}
          step={1}
          onChange={(rate) => onChange({ rate })}
          format={(v) => (v === 0 ? "normal" : v > 0 ? `+${v} faster` : `${v} slower`)}
        />
      </div>
    </Panel>
  );
}
