/**
 * The commercial bucket and channel.
 *
 * The adverts turned out to be the funniest thing the station makes, so they
 * get a room of their own: fill it in batches, listen through it, star the
 * ones worth keeping, and let both shows draw their breaks from it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Brain,
  CheckCircle,
  Crown,
  Eye,
  Gauge,
  Megaphone,
  MessagesSquare,
  Play,
  Radio,
  RefreshCw,
  Save,
  Sparkles,
  Square,
  Star,
  Tag,
  ThumbsUp,
  Trash2,
  Wrench,
} from "lucide-react";
import { Button, Callout, Field, Input, Panel, Textarea } from "./ui";
import { uniqueByCopy } from "../../shared/commercial-rotation";

export type SpotSource = "station" | "realm" | "multiverse";
type ChannelMode = "all" | SpotSource;
type CollectionMode = "collection" | "rotation" | "quarantine";

export interface BucketSpot {
  id: string;
  sponsor: string;
  source: SpotSource;
  text: string;
  file: string;
  seconds: number;
  created: string;
  plays: number;
  lastPlayed: string;
  keep: boolean;
  rotation?: boolean;
  tags?: string[];
  brainVersion?: string;
}

interface Stats {
  total: number;
  kept: number;
  seconds: number;
  rotation: number;
  quarantine: number;
  legacy: number;
  bySource: Record<SpotSource, number>;
}

interface Brief {
  source: SpotSource;
  sponsor: string;
  prompt: string;
}

interface CommercialBrain {
  activeId: string;
  versions: CommercialBrainVersion[];
  active: CommercialBrainVersion;
  style: string;
  multiverseBrain: string;
  rules: string;
  multiverseSeeds: string[];
  realmTraders: Array<{ name: string; product: string }>;
  sampleBriefs: Record<SpotSource, Brief>;
}

interface CommercialBrainVersion {
  id: string;
  name: string;
  created: string;
  style: string;
  multiverseBrain: string;
  rules: string;
  multiverseSeeds: string[];
  realmTraders: Array<{ name: string; product: string }>;
}

interface CommercialAttempt {
  id: string;
  at: string;
  status: "started" | "made" | "fallback" | "failed";
  source: SpotSource;
  sponsor: string;
  model: string;
  brainVersion: string;
  error?: string;
  text?: string;
  spotId?: string;
}

interface BrainTest {
  name: string;
  ok: boolean;
  detail: string;
}

interface DryRun {
  brief: Brief;
  prompt: string;
  brainVersion: string;
  notes: string[];
}

interface ControlRoom {
  generatedAt: string;
  lmStudioNote: string;
  model: {
    provider: string;
    baseUrl: string;
    selected: string;
    queue: { inFlight: number; pending: number; foreground: number; background: number };
    probe?: { ok: boolean; error?: string; hint?: string } | null;
  };
  tts: {
    engine: string;
    voice: string;
    probe?: { ok: boolean; error?: string; hint?: string } | null;
  };
  bucket: { stats: Stats; audit: { ok: boolean; issues: BucketIssue[] }; recentAttempts: CommercialAttempt[] };
  notes: string[];
}

interface BucketIssue {
  id: string;
  sponsor: string;
  severity: "error" | "warning";
  kind: string;
  message: string;
  repairable: boolean;
}

const SOURCES: Record<SpotSource, { label: string; hint: string; icon: typeof Radio }> = {
  station: { label: "Station", hint: "Your own sponsors", icon: Radio },
  realm: { label: "Realm", hint: "Traders inside King Orion's world", icon: Crown },
  multiverse: { label: "Multiverse", hint: "Businesses that should not exist", icon: Sparkles },
};

const CHANNELS: Record<ChannelMode, { label: string; hint: string; icon: typeof Radio }> = {
  all: { label: "After Dark", hint: "Everything in the bucket, shuffled into one strange broadcast", icon: Megaphone },
  station: { label: "Station", hint: "Your station's sponsors and local oddities", icon: Radio },
  realm: { label: "Realm", hint: "King Orion's traders, proclamations and bad-news receipts", icon: Crown },
  multiverse: { label: "Multiverse", hint: "Pure impossible businesses from the cracked cable dial", icon: Sparkles },
};

const RATING_TAGS = ["keeper", "too-normal", "too-long", "great-premise", "bad-voice", "reroll-this", "quarantine"];

export function Commercials() {
  const [spots, setSpots] = useState<BucketSpot[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<ChannelMode>("all");
  const [collectionMode, setCollectionMode] = useState<CollectionMode>("collection");
  const [channelMode, setChannelMode] = useState<ChannelMode>("all");
  const [playing, setPlaying] = useState<string | null>(null);
  const [channelOn, setChannelOn] = useState(false);
  const [djBumpers, setDjBumpers] = useState(true);
  const [autoFresh, setAutoFresh] = useState(true);
  const [freshening, setFreshening] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"info" | "error" | "good">("info");
  const [loading, setLoading] = useState(true);
  const [brain, setBrain] = useState<CommercialBrain | null>(null);
  const [brainDraft, setBrainDraft] = useState<CommercialBrainVersion | null>(null);
  const [savingBrain, setSavingBrain] = useState(false);
  const [history, setHistory] = useState<CommercialAttempt[]>([]);
  const [tests, setTests] = useState<BrainTest[]>([]);
  const [dryRun, setDryRun] = useState<DryRun | null>(null);
  const [controlRoom, setControlRoom] = useState<ControlRoom | null>(null);
  const [probing, setProbing] = useState(false);
  const [issues, setIssues] = useState<BucketIssue[]>([]);
  const [repairing, setRepairing] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const channelRef = useRef<string[]>([]);
  const channelAtRef = useRef(0);
  const fresheningRef = useRef(false);
  const lastFreshAtRef = useRef(-1);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/commercials");
      const data = await res.json();
      setSpots(data.spots ?? []);
      setStats(data.stats ?? null);
    } catch (err) {
      setMessageTone("error");
      setMessage(`Could not read the bucket: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBrain = useCallback(async () => {
    try {
      const res = await fetch("/api/commercials/brain");
      const data = await res.json();
      setBrain(data.brain ?? null);
      setBrainDraft(data.brain?.active ?? null);
      setHistory(data.history ?? []);
      setTests(data.tests ?? []);
      setDryRun(data.dryRun ?? null);
    } catch {
      setBrain(null);
      setBrainDraft(null);
      setHistory([]);
      setTests([]);
      setDryRun(null);
    }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const res = await fetch("/api/commercials/audit");
      const data = await res.json();
      setIssues(data.issues ?? []);
    } catch {
      setIssues([]);
    }
  }, []);

  const loadControlRoom = useCallback(async (probe = false) => {
    setProbing(probe);
    try {
      const res = await fetch(`/api/control-room${probe ? "?probe=1" : ""}`);
      const data = await res.json();
      setControlRoom(data);
    } catch {
      setControlRoom(null);
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadBrain();
    void loadAudit();
    void loadControlRoom(false);
  }, [load, loadAudit, loadBrain, loadControlRoom]);

  const spotsFor = useCallback(
    (mode: ChannelMode) => (mode === "all" ? spots : spots.filter((spot) => spot.source === mode)),
    [spots],
  );

  const isLegacy = (spot: BucketSpot) => Boolean(brain?.activeId) && spot.brainVersion !== brain?.activeId;
  const inRotation = (spot: BucketSpot) =>
    spot.seconds >= 2 && spot.rotation !== false && !(spot.tags ?? []).includes("quarantine") && !isLegacy(spot);

  const inCollectionMode = (spot: BucketSpot) => {
    if (collectionMode === "rotation") return inRotation(spot);
    if (collectionMode === "quarantine") return (spot.tags ?? []).includes("quarantine");
    return true;
  };

  const freshen = useCallback(
    async (options: { count?: number; source?: SpotSource; inspirationId?: string } = {}) => {
      setFreshening(true);
      fresheningRef.current = true;
      setMessageTone("info");
      setMessage(options.inspirationId ? "Making one in the same wrong little family..." : "Making fresh commercials...");

      try {
        const res = await fetch("/api/commercials/freshen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            count: options.count ?? 1,
            source: options.source,
            inspirationId: options.inspirationId,
          }),
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          setMessageTone("error");
          setMessage(data.error ?? "The commercial brain could not make one right now.");
          return;
        }

        const allSpots = (data.spots ?? []) as BucketSpot[];
        setSpots(allSpots);
        setStats(data.stats ?? null);
        void loadBrain();
        void loadAudit();
        const made = Array.isArray(data.made) ? data.made.length : 0;
        const madeIds = Array.isArray(data.made)
          ? data.made.map((spot: BucketSpot) => spot.id).filter(Boolean)
          : [];
        if (channelRef.current.length > 0 && madeIds.length > 0) {
          const byId = new Map(allSpots.map((spot) => [spot.id, spot]));
          const current = channelRef.current.map((id) => byId.get(id)).filter((spot): spot is BucketSpot => Boolean(spot));
          channelRef.current = uniqueByCopy([...current, ...(data.made as BucketSpot[])]).map((spot) => spot.id);
        }
        setMessageTone(made > 0 ? "good" : data.error ? "error" : "info");
        setMessage(
          made > 0
            ? `${made} fresh commercial${made === 1 ? "" : "s"} landed in the bucket.`
            : data.error
              ? `Nothing new landed: ${data.error}`
              : "The bucket is already caught up.",
        );
      } catch (err) {
        setMessageTone("error");
        setMessage(`The commercial brain went quiet: ${(err as Error).message}`);
      } finally {
        setFreshening(false);
        fresheningRef.current = false;
      }
    },
    [loadAudit, loadBrain],
  );

  const repair = async () => {
    setRepairing(true);
    setMessageTone("info");
    setMessage("Repairing bucket entries...");
    try {
      const res = await fetch("/api/commercials/repair", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessageTone("error");
        setMessage(data.error ?? "The repair pass could not run.");
        return;
      }
      setSpots(data.spots ?? spots);
      setStats(data.stats ?? stats);
      setIssues(data.audit?.issues ?? []);
      setMessageTone(data.error ? "error" : "good");
      setMessage(
        data.error
          ? `Repaired ${data.repaired ?? 0}, then stopped: ${data.error}`
          : `Repaired ${data.repaired ?? 0} bucket entr${data.repaired === 1 ? "y" : "ies"}.`,
      );
    } catch (err) {
      setMessageTone("error");
      setMessage(`The repair pass failed: ${(err as Error).message}`);
    } finally {
      setRepairing(false);
      void loadBrain();
      void loadAudit();
    }
  };

  const saveBrain = async () => {
    if (!brainDraft) return;
    setSavingBrain(true);
    setMessageTone("info");
    setMessage("Saving commercial brain...");
    try {
      const res = await fetch("/api/commercials/brain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(brainDraft),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessageTone("error");
        setMessage(data.error ?? "The brain would not save.");
        return;
      }
      setBrain(data.brain ?? null);
      setBrainDraft(data.brain?.active ?? null);
      setTests(data.tests ?? []);
      setDryRun(data.dryRun ?? null);
      setMessageTone("good");
      setMessage(`Saved "${data.version?.name ?? "Commercial Brain"}" as the active brain.`);
    } catch (err) {
      setMessageTone("error");
      setMessage(`The brain would not save: ${(err as Error).message}`);
    } finally {
      setSavingBrain(false);
      void loadControlRoom(false);
    }
  };

  const activateBrain = async (id: string) => {
    const res = await fetch("/api/commercials/brain/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json().catch(() => ({}));
    setBrain(data.brain ?? brain);
    setBrainDraft(data.brain?.active ?? brainDraft);
    setTests(data.tests ?? tests);
    setDryRun(data.dryRun ?? dryRun);
  };

  const previewDryRun = async (source?: SpotSource) => {
    const res = await fetch("/api/commercials/dry-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    });
    const data = await res.json().catch(() => null);
    if (data) setDryRun(data);
  };

  const updateSpotState = (data: { spots?: BucketSpot[]; stats?: Stats }) => {
    if (data.spots) setSpots(data.spots);
    if (data.stats) setStats(data.stats);
    void loadAudit();
    void loadControlRoom(false);
  };

  const toggleRotation = async (spot: BucketSpot) => {
    const res = await fetch(`/api/commercials/${spot.id}/rotation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rotation: spot.rotation === false }),
    });
    updateSpotState(await res.json().catch(() => ({})));
  };

  const toggleTag = async (spot: BucketSpot, tag: string) => {
    const current = new Set(spot.tags ?? []);
    if (current.has(tag)) current.delete(tag);
    else current.add(tag);
    const res = await fetch(`/api/commercials/${spot.id}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: Array.from(current) }),
    });
    updateSpotState(await res.json().catch(() => ({})));
  };

  const maybeFreshen = useCallback(() => {
    if (!autoFresh || fresheningRef.current) return;

    const cycle = djBumpers ? 3 : 2;
    const heard = Math.floor(channelAtRef.current / cycle);
    if (heard < 3 || heard % 4 !== 0 || lastFreshAtRef.current === heard) return;

    lastFreshAtRef.current = heard;
    const source = channelMode === "all" ? undefined : channelMode;
    void freshen({ count: 1, source });
  }, [autoFresh, channelMode, djBumpers, freshen]);

  const advance = useCallback(() => {
    const el = audioRef.current;
    const order = channelRef.current;
    if (!el || order.length === 0) return;

    const step = channelAtRef.current;
    channelAtRef.current += 1;

    const cycle = djBumpers ? 3 : 2;
    const slot = step % cycle;
    const id = order[Math.floor(step / cycle) % order.length];

    if (djBumpers && slot === 1) {
      setPlaying(null);
      el.src = `/api/commercials/dj/${step}/${id}?mode=${channelMode}`;
      void el.play().catch(() => setChannelOn(false));
      return;
    }

    if (slot === cycle - 1) {
      setPlaying(null);
      el.src = `/api/commercials/ident/${step}`;
      void el.play().catch(() => setChannelOn(false));
      return;
    }

    setPlaying(id);
    el.src = `/api/commercials/${id}/audio`;
    void el
      .play()
      .then(() => {
        void fetch(`/api/commercials/${id}/played`, { method: "POST" });
        maybeFreshen();
      })
      .catch(() => setChannelOn(false));
  }, [channelMode, djBumpers, maybeFreshen]);

  useEffect(() => {
    const el = new Audio();
    el.preload = "auto";
    const onEnded = () => {
      if (channelRef.current.length > 0) advance();
      else setPlaying(null);
    };
    el.addEventListener("ended", onEnded);
    audioRef.current = el;
    return () => {
      el.removeEventListener("ended", onEnded);
      el.pause();
      audioRef.current = null;
    };
  }, [advance]);

  const stopChannel = useCallback(() => {
    channelRef.current = [];
    channelAtRef.current = 0;
    setChannelOn(false);
    setPlaying(null);
    audioRef.current?.pause();
    void load();
  }, [load]);

  const startChannel = () => {
    const candidates = uniqueByCopy(spotsFor(channelMode).filter(inRotation));
    if (candidates.length === 0) {
      setMessageTone("error");
      setMessage(`No ${CHANNELS[channelMode].label.toLowerCase()} commercials in the bucket yet.`);
      return;
    }

    const order = candidates.map((s) => s.id);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    channelRef.current = order;
    channelAtRef.current = 0;
    lastFreshAtRef.current = -1;
    setMessageTone("info");
    setMessage("");
    setChannelOn(true);
    advance();
  };

  const play = (spot: BucketSpot) => {
    const el = audioRef.current;
    if (!el) return;

    if (channelOn) {
      channelRef.current = [];
      setChannelOn(false);
    }

    if (playing === spot.id) {
      el.pause();
      setPlaying(null);
      return;
    }

    el.src = `/api/commercials/${spot.id}/audio`;
    void el
      .play()
      .then(() => {
        setPlaying(spot.id);
        void fetch(`/api/commercials/${spot.id}/played`, { method: "POST" }).then(load);
      })
      .catch(() => {
        setMessageTone("error");
        setMessage("The browser blocked playback. Click anywhere on the page first.");
      });
  };

  const toggleKeep = async (spot: BucketSpot) => {
    await fetch(`/api/commercials/${spot.id}/keep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep: !spot.keep }),
    });
    void load();
  };

  const remove = async (spot: BucketSpot) => {
    if (!confirm(`Delete "${spot.sponsor}"? This cannot be undone.`)) return;

    const res = await fetch(`/api/commercials/${spot.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setMessageTone("error");
      setMessage(data.error ?? "That one would not delete.");
      return;
    }
    setMessageTone("info");
    setMessage("");
    void load();
  };

  const shown = spotsFor(filter).filter(inCollectionMode);
  const channelCount = uniqueByCopy(spotsFor(channelMode).filter(inRotation)).length;
  const channelSource = channelMode === "all" ? undefined : channelMode;

  if (loading) {
    return <div className="px-5 py-24 text-center text-sm text-[var(--color-mute)]">Reading the bucket...</div>;
  }

  if (spots.length === 0) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-5 py-24 text-center">
        <Megaphone size={34} className="text-[var(--color-line-bright)]" />
        <h2 className="font-serif text-2xl text-white">The bucket is empty</h2>
        <p className="text-sm leading-relaxed text-[var(--color-mute)]">
          Run <span className="font-mono text-xs text-white">Make-Commercials.bat</span>, or freshen it here once
          the model and voice engine are ready. Every spot you make becomes channel fuel and a show break that
          does not have to be written live.
        </p>
        <Button variant="primary" onClick={() => void freshen({ count: 2 })} disabled={freshening}>
          <RefreshCw size={14} className={freshening ? "animate-spin" : ""} />
          Make commercials
        </Button>
        {message && <Callout tone={messageTone}>{message}</Callout>}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6">
      <Panel
        title="Commercial channel"
        subtitle="A live feed of spots, idents, DJ reactions and new ads landing while it plays."
      >
        <div className="space-y-4">
          {stats && (
            <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--color-mute)]">
              <span className="text-white">{stats.total} spot{stats.total === 1 ? "" : "s"}</span>
              <span>-</span>
              <span>{Math.round(stats.seconds / 60)} minutes of audio</span>
              <span>-</span>
              <span>{stats.rotation} in rotation</span>
              {stats.legacy > 0 && <span>{stats.legacy} legacy, preserved but off-air</span>}
              {stats.quarantine > 0 && (
                <>
                  <span>-</span>
                  <span className="text-[#fca5a5]">{stats.quarantine} quarantined</span>
                </>
              )}
              {stats.kept > 0 && (
                <>
                  <span>-</span>
                  <span className="text-[var(--color-amber)]">{stats.kept} starred</span>
                </>
              )}
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-4">
            {(Object.keys(CHANNELS) as ChannelMode[]).map((mode) => {
              const Icon = CHANNELS[mode].icon;
              const active = channelMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    if (channelOn) stopChannel();
                    setChannelMode(mode);
                    setFilter(mode);
                  }}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    active
                      ? "border-[var(--color-amber)] bg-[var(--color-amber)]/10 text-white"
                      : "border-[var(--color-line)] bg-[var(--color-panel-2)] text-[var(--color-dim)] hover:text-white"
                  }`}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Icon size={14} />
                    {CHANNELS[mode].label}
                  </div>
                  <div className="mt-1 text-[11px] leading-snug text-[var(--color-mute)]">{CHANNELS[mode].hint}</div>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-2">
            <FilterChip
              active={collectionMode === "collection"}
              onClick={() => setCollectionMode("collection")}
              label="Collection"
            />
            <FilterChip
              active={collectionMode === "rotation"}
              onClick={() => setCollectionMode("rotation")}
              label={`Rotation ${stats?.rotation ?? 0}`}
            />
            <FilterChip
              active={collectionMode === "quarantine"}
              onClick={() => setCollectionMode("quarantine")}
              label={`Quarantine ${stats?.quarantine ?? 0}`}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <FilterChip active={filter === "all"} onClick={() => setFilter("all")} label={`All ${spots.length}`} />
            {(Object.keys(SOURCES) as SpotSource[]).map((source) => (
              <FilterChip
                key={source}
                active={filter === source}
                onClick={() => setFilter(source)}
                label={`${SOURCES[source].label} ${stats?.bySource[source] ?? 0}`}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {channelOn ? (
              <Button variant="danger" onClick={stopChannel}>
                <Square size={14} />
                Stop the channel
              </Button>
            ) : (
              <Button variant="primary" onClick={startChannel}>
                <Play size={14} />
                Play {CHANNELS[channelMode].label}
              </Button>
            )}

            <Button onClick={() => void freshen({ count: 2, source: channelSource })} disabled={freshening}>
              <RefreshCw size={14} className={freshening ? "animate-spin" : ""} />
              Freshen
            </Button>

            <Button variant={djBumpers ? "primary" : "default"} onClick={() => setDjBumpers((v) => !v)}>
              <MessagesSquare size={14} />
              DJs
            </Button>

            <Button variant={autoFresh ? "primary" : "default"} onClick={() => setAutoFresh((v) => !v)}>
              <Sparkles size={14} />
              Auto
            </Button>

            <span className="text-xs leading-relaxed text-[var(--color-mute)]">
              {channelOn
                ? `${CHANNELS[channelMode].label} is on air with ${channelCount} spot${channelCount === 1 ? "" : "s"} in rotation.`
                : `${channelCount} spot${channelCount === 1 ? "" : "s"} ready for this channel.`}
            </span>
          </div>

          {message && <Callout tone={messageTone}>{message}</Callout>}
        </div>
      </Panel>

      <Panel
        title="Control room"
        subtitle="Status lights for the commercial system. Provider checks are manual so LM Studio can stay closed."
        right={
          <Button onClick={() => void loadControlRoom(true)} disabled={probing} size="sm">
            <Gauge size={13} />
            {probing ? "Checking" : "Probe"}
          </Button>
        }
      >
        {controlRoom ? (
          <div className="grid gap-3 md:grid-cols-4">
            <StatusTile
              label="Model"
              value={controlRoom.model.selected || "None selected"}
              tone={controlRoom.model.probe ? (controlRoom.model.probe.ok ? "good" : "bad") : "info"}
              detail={
                controlRoom.model.probe?.error ??
                `${controlRoom.model.queue.inFlight} running, ${controlRoom.model.queue.pending} queued`
              }
            />
            <StatusTile
              label="TTS"
              value={controlRoom.tts.engine}
              tone={controlRoom.tts.probe ? (controlRoom.tts.probe.ok ? "good" : "bad") : "info"}
              detail={controlRoom.tts.probe?.error ?? controlRoom.tts.voice}
            />
            <StatusTile
              label="Bucket"
              value={`${controlRoom.bucket.stats.total} spots`}
              tone={controlRoom.bucket.audit.ok ? "good" : "bad"}
              detail={`${controlRoom.bucket.stats.rotation} in rotation`}
            />
            <StatusTile
              label="LM Studio"
              value={controlRoom.model.probe ? (controlRoom.model.probe.ok ? "reachable" : "offline") : "not probed"}
              tone={controlRoom.model.probe ? (controlRoom.model.probe.ok ? "good" : "bad") : "info"}
              detail={controlRoom.lmStudioNote}
            />
          </div>
        ) : (
          <div className="text-sm text-[var(--color-mute)]">Control room has not reported yet.</div>
        )}
      </Panel>

      <Panel
        title="Commercial brain"
        subtitle="The current writing rules, bucket health and recent generation attempts."
        right={
          issues.length > 0 ? (
            <Button onClick={repair} disabled={repairing} size="sm">
              <Wrench size={13} />
              Repair
            </Button>
          ) : null
        }
      >
        <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="inline-flex items-center gap-2 text-white">
                <Brain size={15} />
                {brain ? `${brain.multiverseSeeds.length} seeds` : "Brain unavailable"}
              </span>
              {issues.length > 0 ? (
                <span className="inline-flex items-center gap-1 text-[#fca5a5]">
                  <AlertTriangle size={14} />
                  {issues.length} issue{issues.length === 1 ? "" : "s"}
                </span>
              ) : (
                <span className="text-[var(--color-good)]">Bucket audit clean</span>
              )}
            </div>

            {brain && brainDraft && (
              <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3">
                <div className="mb-3 flex flex-wrap items-end gap-2">
                  <Field label="Version" className="min-w-0 flex-1">
                    <Input
                      value={brainDraft.name}
                      onChange={(e) => setBrainDraft({ ...brainDraft, name: e.target.value })}
                    />
                  </Field>
                  {brain.versions.length > 1 && (
                    <select
                      className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-sm text-white"
                      value={brain.activeId}
                      onChange={(e) => void activateBrain(e.target.value)}
                      aria-label="Active brain version"
                    >
                      {brain.versions.map((version) => (
                        <option key={version.id} value={version.id}>
                          {version.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button onClick={() => void saveBrain()} disabled={savingBrain}>
                    <Save size={14} />
                    Save
                  </Button>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Style">
                    <Textarea
                      rows={7}
                      value={brainDraft.style}
                      onChange={(e) => setBrainDraft({ ...brainDraft, style: e.target.value })}
                    />
                  </Field>
                  <Field label="Multiverse brain">
                    <Textarea
                      rows={7}
                      value={brainDraft.multiverseBrain}
                      onChange={(e) => setBrainDraft({ ...brainDraft, multiverseBrain: e.target.value })}
                    />
                  </Field>
                  <Field label="Spoken rules">
                    <Textarea
                      rows={4}
                      value={brainDraft.rules}
                      onChange={(e) => setBrainDraft({ ...brainDraft, rules: e.target.value })}
                    />
                  </Field>
                  <Field label="Seeds" hint="One impossible business premise per line.">
                    <Textarea
                      rows={4}
                      value={brainDraft.multiverseSeeds.join("\n")}
                      onChange={(e) =>
                        setBrainDraft({
                          ...brainDraft,
                          multiverseSeeds: e.target.value.split("\n").map((line) => line.trim()).filter(Boolean),
                        })
                      }
                    />
                  </Field>
                  <Field label="Realm traders" hint="One per line: name | product.">
                    <Textarea
                      rows={5}
                      value={brainDraft.realmTraders.map((trader) => `${trader.name} | ${trader.product}`).join("\n")}
                      onChange={(e) =>
                        setBrainDraft({
                          ...brainDraft,
                          realmTraders: e.target.value
                            .split("\n")
                            .map((line) => {
                              const [name, ...rest] = line.split("|");
                              return { name: name.trim(), product: rest.join("|").trim() };
                            })
                            .filter((trader) => trader.name && trader.product),
                        })
                      }
                    />
                  </Field>
                </div>
              </div>
            )}

            {brain && (
              <div className="grid gap-3 md:grid-cols-2">
                <BrainBlock title="Style" text={brain.style} />
                <BrainBlock title="Multiverse" text={brain.multiverseBrain} />
                <BrainBlock title="Rules" text={brain.rules} />
                <BrainBlock
                  title="Sample brief"
                  text={brain.sampleBriefs[channelSource ?? "multiverse"]?.prompt ?? brain.sampleBriefs.multiverse.prompt}
                />
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase tracking-[0.13em] text-[var(--color-dim)]">
                  Brain tests
                </div>
                <Button size="sm" onClick={() => void previewDryRun(channelSource)}>
                  <Eye size={13} />
                  Dry run
                </Button>
              </div>
              <div className="space-y-2">
                {tests.map((test) => (
                  <div key={test.name} className="flex items-start gap-2 text-xs leading-relaxed">
                    {test.ok ? (
                      <CheckCircle size={13} className="mt-0.5 shrink-0 text-[var(--color-good)]" />
                    ) : (
                      <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[#fca5a5]" />
                    )}
                    <span className="text-[var(--color-mute)]">
                      <span className="text-white">{test.name}</span> - {test.detail}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {dryRun && (
              <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.13em] text-[var(--color-dim)]">
                  Dry-run prompt
                </div>
                <div className="mb-2 text-xs text-[var(--color-mute)]">
                  {dryRun.brief.source} · {dryRun.brief.sponsor || "invented sponsor"} · brain {dryRun.brainVersion}
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-[var(--color-mute)]">
                  {dryRun.prompt}
                </pre>
              </div>
            )}

            {issues.length > 0 && (
              <div className="rounded-lg border border-[#7f1d1d] bg-[#7f1d1d]/10 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.13em] text-[#fca5a5]">
                  Bucket audit
                </div>
                <div className="space-y-2">
                  {issues.slice(0, 5).map((issue, index) => (
                    <div key={`${issue.id}-${issue.kind}-${index}`} className="text-xs leading-relaxed text-[#fecaca]">
                      <span className="text-white">{issue.sponsor}</span> - {issue.message}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.13em] text-[var(--color-dim)]">
                Recent attempts
              </div>
              {history.length === 0 ? (
                <div className="text-xs text-[var(--color-mute)]">No attempts logged yet.</div>
              ) : (
                <div className="space-y-2">
                  {history.slice(0, 6).map((attempt) => (
                    <div key={attempt.id} className="text-xs leading-relaxed text-[var(--color-mute)]">
                      <span
                        className={
                          attempt.status === "made"
                            ? "text-[var(--color-good)]"
                            : attempt.status === "fallback"
                              ? "text-[var(--color-amber)]"
                              : attempt.status === "failed"
                                ? "text-[#fca5a5]"
                                : "text-[var(--color-dim)]"
                        }
                      >
                        {attempt.status}
                      </span>
                      {" - "}
                      <span className="text-white">{attempt.sponsor || SOURCES[attempt.source]?.label}</span>
                      {attempt.error && <span> - {attempt.error}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </Panel>

      <div className="space-y-3">
        {shown.map((spot) => {
          const Icon = SOURCES[spot.source].icon;
          const live = playing === spot.id;

          return (
            <div
              key={spot.id}
              className={`rounded-lg border p-4 transition-colors ${
                live
                  ? "border-[var(--color-amber)]/50 bg-[var(--color-amber)]/5"
                  : "border-[var(--color-line)] bg-[var(--color-panel)]"
              }`}
            >
              <div className="flex items-start gap-3">
                <Button
                  variant={live ? "primary" : "default"}
                  onClick={() => play(spot)}
                  aria-label={live ? "Stop" : "Play"}
                >
                  {live ? <Square size={14} /> : <Play size={14} />}
                </Button>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-serif text-base text-white">{spot.sponsor}</span>
                    <span className="inline-flex items-center gap-1 rounded-md border border-[var(--color-line)] px-1.5 py-0.5 text-[11px] text-[var(--color-mute)]">
                      <Icon size={10} />
                      {SOURCES[spot.source].label}
                    </span>
                    <span className="text-xs text-[var(--color-mute)]">
                      {spot.seconds.toFixed(0)}s - {spot.plays} play{spot.plays === 1 ? "" : "s"}
                    </span>
                  </div>

                  <p className="mt-2 text-sm leading-relaxed text-[var(--color-dim)]">{spot.text}</p>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant={inRotation(spot) ? "primary" : "default"}
                      onClick={() => void toggleRotation(spot)}
                    >
                      <Radio size={12} />
                      {isLegacy(spot) ? "Legacy" : inRotation(spot) ? "In rotation" : "Out"}
                    </Button>
                    {RATING_TAGS.map((tag) => {
                      const active = (spot.tags ?? []).includes(tag);
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => void toggleTag(spot, tag)}
                          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                            active
                              ? tag === "quarantine"
                                ? "border-[#7f1d1d] bg-[#7f1d1d]/20 text-[#fca5a5]"
                                : "border-[var(--color-amber)] bg-[var(--color-amber)]/10 text-white"
                              : "border-[var(--color-line)] text-[var(--color-mute)] hover:text-white"
                          }`}
                        >
                          <Tag size={10} />
                          {tag}
                        </button>
                      );
                    })}
                    {spot.brainVersion && (
                      <span className="text-[11px] text-[var(--color-mute)]">brain {spot.brainVersion}</span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 flex-col gap-1.5">
                  <Button
                    variant={spot.keep ? "primary" : "ghost"}
                    onClick={() => void toggleKeep(spot)}
                    aria-label={spot.keep ? "Unstar" : "Star, so it cannot be deleted"}
                  >
                    <Star size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => void freshen({ count: 1, source: spot.source, inspirationId: spot.id })}
                    disabled={freshening}
                    aria-label="Make more like this"
                  >
                    <ThumbsUp size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => void remove(spot)}
                    disabled={spot.keep}
                    aria-label={spot.keep ? "Unstar it first" : "Delete"}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BrainBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.13em] text-[var(--color-dim)]">{title}</div>
      <pre className="max-h-52 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-[var(--color-mute)]">
        {text}
      </pre>
    </div>
  );
}

function StatusTile({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "good" | "bad" | "info";
}) {
  const dot = tone === "good" ? "bg-[var(--color-good)]" : tone === "bad" ? "bg-[#f87171]" : "bg-[var(--color-amber)]";
  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.13em] text-[var(--color-dim)]">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        {label}
      </div>
      <div className="truncate text-sm text-white">{value}</div>
      <div className="mt-1 text-xs leading-relaxed text-[var(--color-mute)]">{detail}</div>
    </div>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
        active ? "bg-[var(--color-panel-2)] text-white" : "text-[var(--color-mute)] hover:text-white"
      }`}
    >
      {label}
    </button>
  );
}
