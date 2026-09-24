import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Plus, Trash2, Upload, FolderOpen, RefreshCw, Megaphone } from "lucide-react";
import type { AdFile, Config, LibrarySpot, Options, Sponsor, TtsEngine, Voice } from "../types";
import { api, formatBytes } from "../lib/api";
import { Button, Callout, Field, Input, Panel, Select, Slider, Textarea, Toggle } from "./ui";

interface Props {
  config: Config;
  options: Options | null;
  onChange: (config: Config) => void;
  /** Voices for the current engine, already loaded by Settings. */
  voices: Voice[];
}

function newSponsor(): Sponsor {
  return {
    id: `sponsor-${Date.now().toString(36)}`,
    name: "",
    product: "",
    talkingPoints: "",
    tagline: "",
    style: "",
    audioFile: "",
    enabled: true,
  };
}

export function Ads({ config, options, onChange, voices }: Props) {
  const [files, setFiles] = useState<AdFile[]>([]);
  const [adsDir, setAdsDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const ads = config.ads;
  const engine = config.tts.engine as TtsEngine;

  const update = useCallback(
    (patch: Partial<Config["ads"]>) => onChange({ ...config, ads: { ...config.ads, ...patch } }),
    [config, onChange],
  );

  const refreshFiles = useCallback(async () => {
    try {
      const result = await api.adFiles();
      setFiles(result.files);
      setAdsDir(result.dir);
    } catch {
      /* the folder is optional; a failure here is not worth a banner */
    }
  }, []);

  useEffect(() => {
    void refreshFiles();
  }, [refreshFiles]);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      audioRef.current?.pause();
    };
  }, []);

  const play = (url: string, isObjectUrl = true) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    // Only blobs we made are ours to revoke; a plain route URL is not.
    objectUrlRef.current = isObjectUrl ? url : null;

    if (!audioRef.current) audioRef.current = new Audio();
    audioRef.current.src = url;
    void audioRef.current.play().catch(() => setError("The browser would not play the clip."));
  };

  const previewBreak = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const { url, label } = await api.previewBreak(config);
      setNote(label);
      play(url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.uploadAd(file);
      setFiles(result.files);
      setNote(`Added ${result.name} (${formatBytes(result.bytes)}).`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const setSponsor = (index: number, patch: Partial<Sponsor>) => {
    const sponsors = ads.sponsors.map((s, i) => (i === index ? { ...s, ...patch } : s));
    update({ sponsors });
  };

  const spotsTotal = ads.breaks * ads.spotsPerBreak;

  return (
    <>
      <Panel
        title="Ad breaks"
        subtitle="Commercials, station promos and your own spots — written and recorded while the hosts are still talking."
        right={
          <Button size="sm" disabled={busy || !ads.enabled} onClick={() => void previewBreak()}>
            <Play size={13} />
            Hear a break
          </Button>
        }
      >
        <div className="space-y-4">
          <Toggle
            label="Take commercial breaks"
            hint="The hosts throw to the break and come back from it. Because each break is produced in the background and then simply played, it costs no waiting — and gives the model close to a minute to run ahead."
            checked={ads.enabled}
            onChange={(enabled) => update({ enabled })}
          />

          {ads.enabled && !config.show.useRunSheet && (
            <Callout tone="info" title="Breaks need a running order">
              The hosts have to throw to the break and come back from it, and those two lines come from the run
              sheet. Turn on "Give it a running order" in the Studio and the breaks will schedule themselves.
            </Callout>
          )}

          {ads.enabled && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Slider
                  label="Breaks per show"
                  value={ads.breaks}
                  min={0}
                  max={12}
                  step={1}
                  onChange={(breaks) => update({ breaks })}
                  format={(v) => (v === 0 ? "none" : String(v))}
                  hint="Never in the opening pair and never against the sign-off. A short show may fit fewer than you ask for; a long one wants more."
                />
                <Slider
                  label="Spots per break"
                  value={ads.spotsPerBreak}
                  min={1}
                  max={4}
                  step={1}
                  onChange={(spotsPerBreak) => update({ spotsPerBreak })}
                  hint={`${spotsTotal} spot${spotsTotal === 1 ? "" : "s"} across the show.`}
                />
              </div>

              <Slider
                label="Repeat from the shelf"
                value={ads.reusePercent}
                min={0}
                max={100}
                step={10}
                onChange={(reusePercent) => update({ reusePercent })}
                format={(v) =>
                  v === 0
                    ? "all written fresh"
                    : `${v}% · about ${Math.round((spotsTotal * v) / 100)} of ${spotsTotal}`
                }
                hint="Finished spots are kept and played again on later shows. A repeat costs no model time and no synthesis, which is most of what a break costs — and a real station plays the same advert for a month anyway. The rest are still written fresh every time."
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Who advertises" hint="Made-up sponsors need no setup and are usually funnier.">
                  <Select value={ads.source} onChange={(e) => update({ source: e.target.value as Config["ads"]["source"] })}>
                    {(options?.adSources ?? []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label} — {o.description}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Who reads them" hint="A separate announcer is the clearest break from the conversation.">
                  <Select value={ads.style} onChange={(e) => update({ style: e.target.value as Config["ads"]["style"] })}>
                    {(options?.adStyles ?? []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label} — {o.description}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <Toggle
                label="End on a station promo"
                hint="The last spot of the night sells the show rather than a sponsor, the way a real station comes out of its final break."
                checked={ads.usePromos}
                onChange={(usePromos) => update({ usePromos })}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Announcer voice" hint="The voice that reads produced spots and the station opener.">
                  <Select
                    value={ads.announcer.voices[engine] ?? ""}
                    onChange={(e) =>
                      update({
                        announcer: {
                          ...ads.announcer,
                          voices: { ...ads.announcer.voices, [engine]: e.target.value },
                        },
                      })
                    }
                    disabled={engine === "none"}
                  >
                    {voices.length === 0 && <option value="">{ads.announcer.voices[engine] || "No voices found"}</option>}
                    {voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Slider
                  label="Spot length"
                  value={ads.spotWords}
                  min={20}
                  max={160}
                  step={5}
                  onChange={(spotWords) => update({ spotWords })}
                  format={(v) => `${v} words · ~${Math.round((v / 155) * 60)}s`}
                  hint="Real radio spots run thirty seconds."
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Bed under the spots">
                  <Select value={ads.bedMood} onChange={(e) => update({ bedMood: e.target.value })}>
                    {(options?.moods ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Slider
                  label="Bed level"
                  value={ads.bedVolume}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(bedVolume) => update({ bedVolume })}
                  format={(v) => (v < 0.03 ? "off" : `${Math.round(v * 100)}%`)}
                />

                <Slider
                  label="Louder than the show"
                  value={ads.loudnessDb}
                  min={0}
                  max={8}
                  step={0.5}
                  onChange={(loudnessDb) => update({ loudnessDb })}
                  format={(v) => (v < 0.25 ? "same" : `+${v.toFixed(1)} dB`)}
                />
              </div>

              <p className="text-xs leading-relaxed text-[var(--color-mute)]">
                That loudness jump going into the break is the thing everyone recognises without being able to
                name it. The show's own music drops out entirely underneath a commercial — the break brings its
                own.
              </p>

              {note && <Callout tone="good">{note}</Callout>}
              {error && <Callout tone="error" title="That did not work">{error}</Callout>}
            </>
          )}
        </div>
      </Panel>

      {ads.enabled && (
        <Panel
          title="Sponsors"
          subtitle="Advertisers of your own. A name alone is enough — the rest just makes the copy better."
          right={
            <Button size="sm" onClick={() => update({ sponsors: [...ads.sponsors, newSponsor()] })}>
              <Plus size={13} />
              Add sponsor
            </Button>
          }
        >
          <div className="space-y-4">
            {ads.sponsors.length === 0 && (
              <p className="text-sm text-[var(--color-mute)]">
                Nothing here yet. With no sponsors the station runs made-up local businesses, which needs no
                setup at all.
              </p>
            )}

            {ads.sponsors.map((sponsor, i) => (
              <div
                key={sponsor.id}
                className="space-y-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3.5"
              >
                <div className="flex items-center gap-2">
                  <Input
                    value={sponsor.name}
                    onChange={(e) => setSponsor(i, { name: e.target.value })}
                    placeholder="Business name"
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    title={sponsor.enabled ? "On the log" : "Off the log"}
                    onClick={() => setSponsor(i, { enabled: !sponsor.enabled })}
                  >
                    {sponsor.enabled ? "On air" : "Held"}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => update({ sponsors: ads.sponsors.filter((_, j) => j !== i) })}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="What they sell">
                    <Input
                      value={sponsor.product}
                      onChange={(e) => setSponsor(i, { product: e.target.value })}
                      placeholder="part-worn tyres and same-day fitting"
                    />
                  </Field>
                  <Field label="Tagline" hint="The line the spot ends on.">
                    <Input
                      value={sponsor.tagline}
                      onChange={(e) => setSponsor(i, { tagline: e.target.value })}
                      placeholder="We'll get you rolling."
                    />
                  </Field>
                </div>

                <Field label="Must mention" hint="Offers, opening hours, a phone number — anything the copy has to carry.">
                  <Textarea
                    rows={2}
                    value={sponsor.talkingPoints}
                    onChange={(e) => setSponsor(i, { talkingPoints: e.target.value })}
                    placeholder="Optional"
                  />
                </Field>

                <Field
                  label="How it should be read"
                  hint="Direction for the writer, never read out. This is what makes one spot sound different from the next."
                >
                  <Textarea
                    rows={2}
                    value={sponsor.style}
                    onChange={(e) => setSponsor(i, { style: e.target.value })}
                    placeholder="Optional — e.g. breathless hard sell, too many claims, no pause for breath"
                  />
                </Field>

                <Field
                  label="Or play my own recording"
                  hint="Pick a file and this sponsor's spot becomes that file, exactly as recorded. Nothing is written or synthesised."
                >
                  <Select
                    value={sponsor.audioFile}
                    onChange={(e) => setSponsor(i, { audioFile: e.target.value })}
                  >
                    <option value="">Let the station write it</option>
                    {files.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.name} · {formatBytes(f.bytes)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {ads.enabled && (
        <Panel
          title="Your own spots"
          subtitle="Drop a .wav or .mp3 in here and any sponsor can play it instead of a written read."
          right={
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void refreshFiles()}>
                <RefreshCw size={13} />
                Refresh
              </Button>
              <Button size="sm" onClick={() => void api.revealAds().catch(() => {})}>
                <FolderOpen size={13} />
                Open folder
              </Button>
              <Button size="sm" variant="primary" onClick={() => fileInputRef.current?.click()} disabled={busy}>
                <Upload size={13} />
                Add a file
              </Button>
            </div>
          }
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".wav,.mp3,audio/wav,audio/mpeg"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />

          <div className="space-y-2">
            {files.length === 0 ? (
              <p className="text-sm text-[var(--color-mute)]">
                Nothing in the folder yet. Anything you put here is played untouched apart from being levelled
                to sit with the rest of the show.
              </p>
            ) : (
              files.map((f) => (
                <div
                  key={f.name}
                  className="flex items-center gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 py-2"
                >
                  <Megaphone size={13} className="shrink-0 text-[var(--color-mute)]" />
                  <span className="min-w-0 flex-1 truncate text-sm text-[#e8e8ee]">{f.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-[var(--color-mute)]">
                    {formatBytes(f.bytes)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => play(`/api/ads/file/${encodeURIComponent(f.name)}`, false)}
                    title="Play"
                  >
                    <Play size={13} />
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      if (!window.confirm(`Delete ${f.name} from the ads folder?`)) return;
                      void api
                        .deleteAdFile(f.name)
                        .then((r) => setFiles(r.files))
                        .catch((err: Error) => setError(err.message));
                    }}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))
            )}
          </div>

          {adsDir && (
            <p className="mt-3 break-all font-mono text-[11px] text-[var(--color-mute)]">{adsDir}</p>
          )}
        </Panel>
      )}

      {ads.enabled && <AdShelf reusePercent={ads.reusePercent} />}
    </>
  );
}

/**
 * What is on the shelf.
 *
 * Finished spots the station has already cut. Shown mostly so the reuse
 * setting is not a black box: you can hear exactly which adverts are coming
 * back, and throw one away when you are tired of it.
 */
function AdShelf({ reusePercent }: { reusePercent: number }) {
  const [spots, setSpots] = useState<LibrarySpot[]>([]);
  const [busy, setBusy] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const refresh = () => {
    api
      .listAdLibrary()
      .then((r) => setSpots(r.spots))
      .catch(() => setSpots([]));
  };

  useEffect(refresh, []);

  const play = (id: string) => {
    audioRef.current?.pause();
    const audio = new Audio(`/api/ads/library/${id}.wav`);
    audioRef.current = audio;
    void audio.play().catch(() => {});
  };

  const drop = async (id?: string) => {
    setBusy(true);
    try {
      const r = await api.clearAdLibrary(id);
      setSpots(r.spots);
    } catch {
      // Nothing to do about it here; the shelf is a convenience.
    } finally {
      setBusy(false);
    }
  };

  const totalSeconds = spots.reduce((n, s) => n + s.seconds, 0);

  return (
    <Panel
      title="On the shelf"
      subtitle="Spots already cut. A share of every show is played from here instead of being written and recorded again."
      right={
        spots.length > 0 ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void drop()}>
            <Trash2 size={13} />
            Clear
          </Button>
        ) : null
      }
    >
      {spots.length === 0 ? (
        <Callout tone="info">
          Nothing on the shelf yet. Every spot the station records is kept here, so this fills up on its
          own after a show or two — and then {reusePercent === 0 ? "raising" : "about"}{" "}
          {reusePercent === 0 ? "the repeat setting above" : `${reusePercent}% of each break`} comes off
          it for free.
        </Callout>
      ) : (
        <>
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--color-mute)]">
            {spots.length} spot{spots.length === 1 ? "" : "s"} · {Math.round(totalSeconds)}s recorded
          </p>
          <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {spots.map((spot) => (
              <li
                key={spot.id}
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-2.5"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[11px] text-[var(--color-amber)]">{spot.sponsor}</span>
                  <span className="shrink-0 font-mono text-[10px] text-[var(--color-mute)]">
                    {spot.seconds.toFixed(0)}s · played {spot.plays}×
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[var(--color-dim)]">
                  {spot.text}
                </p>
                <div className="mt-1.5 flex gap-3">
                  <button
                    type="button"
                    onClick={() => play(spot.id)}
                    className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-mute)] transition-colors hover:text-white"
                  >
                    Play
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void drop(spot.id)}
                    className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-mute)] transition-colors hover:text-[var(--color-live)] disabled:opacity-40"
                  >
                    Throw away
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

