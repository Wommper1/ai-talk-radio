/**
 * User-editable configuration, persisted to config.json in the project root.
 *
 * Everything the show pipeline can be steered by lives here, so the UI and the
 * file on disk are two views of the same thing. Unknown keys from an older
 * config are dropped on load; missing keys fall back to DEFAULT_CONFIG.
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./lib/atomic-file.ts";

export type LlmProvider = "lmstudio" | "ollama" | "openai-compatible" | "gemini";
export type TtsEngine = "sapi" | "piper" | "edge" | "none";
export type VoiceTone = "studio" | "phone" | "room" | "throne" | "raw";
export type ShowStyle = "debate" | "interview" | "roundtable" | "banter" | "explainer" | "coldopen" | "deepdive";
export type QualityPreset = "standard" | "high" | "studio";

export interface HostConfig {
  id: "a" | "b";
  /** On-air name. Used in the transcript and in the other host's prompt. */
  name: string;
  /** Free-text character brief. This is the bulk of the system prompt. */
  persona: string;
  /** The angle this host argues from. Kept separate so it is easy to flip. */
  stance: string;
  /**
   * Chosen voice per engine, so switching engines does not throw away the
   * voices you picked for the others. The identifier's meaning depends on the
   * engine: a SAPI voice name, a Piper .onnx filename, or an Edge voice id.
   */
  voices: Record<TtsEngine, string>;
  /** Mic character applied after synthesis. */
  tone: VoiceTone;
  /** SAPI/Edge speaking rate. -10..10 for SAPI, percent for Edge. */
  rate: number;
  /** Per-host model override. Empty string means "use the global model". */
  model: string;
  temperature: number;
  /** Soft cap for how long a turn should run. */
  maxWords: number;
}

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  /** Optional reasoning model for producer briefs and outlines. */
  producerModel: string;
  /** Optional cheap model for episode titles and summaries. */
  notesModel: string;
  /** Optional model dedicated to writing commercial copy. */
  commercialModel: string;
  /** Default performer model. Individual hosts may still override it. */
  model: string;
  temperature: number;
  /** Upper bound on tokens per turn. */
  maxTokens: number;
  /** Seconds before a single generation call is abandoned. */
  timeoutSeconds: number;
}

export interface TtsConfig {
  engine: TtsEngine;
  /** Directory containing piper.exe, or the executable itself. */
  piperPath: string;
  /** Directory containing .onnx voice models for Piper. */
  piperVoicesDir: string;
  /** Seconds before a single synthesis call is abandoned. */
  timeoutSeconds: number;
}

/**
 * Output quality.
 *
 * Sample rate and bit depth are the headline numbers, but the two settings
 * that actually change how a show sounds are `stereo` (which separates the
 * hosts in the field) and `compress` (which levels the dialogue).
 */
export interface AudioConfig {
  preset: QualityPreset;
  /** Final render rate in Hz. TTS sources are 22-24 kHz, so beyond 44.1 adds little. */
  sampleRate: number;
  bitDepth: 16 | 24;
  /** Render in stereo, placing each host slightly off-centre. */
  stereo: boolean;
  /** How wide the hosts sit, 0 (centre) to 1 (hard left/right). */
  width: number;
  /** Level the dialogue so quiet lines are not lost under the music. */
  compress: boolean;
}

/** The listener who phones in. Rendered as a third voice on a phone line. */
export interface CallerConfig {
  /** Default on-air name; the UI can override it per call. */
  name: string;
  voices: Record<TtsEngine, string>;
  tone: VoiceTone;
  rate: number;
}

/**
 * Memory settings.
 *
 * `historyTurns` is the small-model lever: instead of resending the whole
 * transcript every turn, only the last few turns go in verbatim and everything
 * older is represented by the rolling digest. That keeps prompt size flat as a
 * show grows, which is what stops an 8B model drifting late in a long episode.
 */
export interface MemoryConfig {
  /** Keep a rolling digest, fact list and running-gag list during the show. */
  enabled: boolean;
  /** Verbatim turns kept in the prompt. Older turns survive as the digest. */
  historyTurns: number;
  /** Turns between digest refreshes. Lower is sharper but costs more calls. */
  updateEvery: number;
  /** Let hosts recall previous episodes. */
  crossShow: boolean;
  backend: "lexical" | "embeddings";
  embeddingModel: string;
  /** Passages pulled from past shows. */
  recallCount: number;
}

/** Station imaging: the stings and beds that make it sound broadcast. */
export interface ImagingConfig {
  /** Ident at the top and tail of the show. */
  useIdent: boolean;
  /** A sweep or hit between segments. */
  useTransitions: boolean;
  /** Cue before and after a listener call. */
  useCallStings: boolean;
  /** 0..1, level of the imaging relative to the dialogue. */
  level: number;
  /** Music under the opening and closing lines, as a DJ talks over a bed. */
  talkOverIntro: boolean;
}

/**
 * One advertiser.
 *
 * Everything except the name is optional: a name alone is enough for the
 * model to write a spot, and copy plus a bundled audio file is enough to skip
 * the model entirely.
 */
export interface Sponsor {
  id: string;
  /** Business name, read on air. */
  name: string;
  /** What they actually sell. */
  product: string;
  /** Facts, offers and phone numbers the spot should mention. */
  talkingPoints: string;
  /** The line the spot ends on. */
  tagline: string;
  /**
   * How the spot should be performed — "manic hard sell", "deadpan", "the
   * owner reading it himself". Direction for the writer, never words to be
   * read out, which is why it is separate from the talking points.
   */
  style: string;
  /**
   * A file in ./ads to play instead of a synthesised read. When set, nothing
   * about this sponsor goes near the model — the file is the spot.
   */
  audioFile: string;
  enabled: boolean;
}

/** Who reads the spot. */
export type AdStyle = "live_read" | "produced" | "mixed";
/** Where the copy comes from. */
export type AdSource = "sponsors" | "invented" | "mixed";

/**
 * Ad breaks.
 *
 * Structurally these are also the show's buffer: a break is rendered while the
 * hosts are still talking, so playing it buys the model most of a minute to
 * run ahead of the listener.
 */
export interface AdsConfig {
  enabled: boolean;
  /** How many breaks the show takes. */
  breaks: number;
  /** Spots inside one break. */
  spotsPerBreak: number;
  source: AdSource;
  style: AdStyle;
  /** Rough length of one spot, in words. */
  spotWords: number;
  /**
   * How much of the commercial load is repeated from the shelf rather than
   * written and recorded fresh, as a percentage. A repeat costs no model time
   * and no synthesis, which is most of what a break costs.
   */
  reusePercent: number;
  /** Bed under the spots. Deliberately separate from the show's own mood. */
  bedMood: string;
  bedVolume: number;
  /**
   * How much louder the break sits than the show, in dB. The jump in loudness
   * going into the ads is the thing everyone recognises without naming it.
   */
  loudnessDb: number;
  /** Station promos and public-service spots fill a break with no sponsor. */
  usePromos: boolean;
  /**
   * Keep the commercial bucket stocked on its own.
   *
   * After a show, if the bucket has fallen below a dozen spots, a couple more
   * are written in the background. Both shows take their breaks from the
   * bucket, so a bucket that runs dry puts them back to writing twelve spots
   * live — which is the single largest thing that ever made a show slow.
   */
  topUpBucket: boolean;
  /** Minimum age before an aired bucket spot is preferred again. */
  minReplayHours: number;
  /** Avoid placing the same sponsor back-to-back in a show. */
  separateSponsors: boolean;
  sourceWeights: { station: number; realm: number; multiverse: number };
  /** The separate voice used for produced spots. */
  announcer: {
    name: string;
    voices: Record<TtsEngine, string>;
    tone: VoiceTone;
    rate: number;
  };
  sponsors: Sponsor[];
}

/**
 * King Orion's Realm.
 *
 * A guest broadcast rather than a feature of the station. When it is on, the
 * show is King Orion holding court over the deeds of his realm, and everything
 * he knows comes from the game's files and his own prior Night Court shows.
 * Realm facts always outrank broadcast memory. He and his chronicler know how
 * to host the broadcast while remaining entirely inside their own world.
 *
 * The return trip is the point. What is said at court is written back into the
 * same chronicle the game reads at boot, so the next time the game starts, its
 * narrator already knows.
 */
export interface OrionConfig {
  enabled: boolean;
  /** The game folder. Empty means "look where it usually is". */
  realmPath: string;
  /**
   * The realm's history, in your words.
   *
   * The game's chronicle records what has been *done* — battles, deaths,
   * milestones — and nothing at all about what came before it. Without this
   * the King has a ledger and no past, which is most of why he reaches for
   * philosophy: there is nothing else to reach for. This is the standing
   * history he speaks from, and it is treated as fact exactly like the
   * chronicle is.
   */
  lore: string;
  /** Write the broadcast back into the game's chronicle. */
  writeBack: boolean;
  /**
   * Whether one of the Respawn Guild is brought into the hall to speak.
   *
   * On, a rider from the game's own Discord party is dragged in mid-court and
   * the King answers them. Off, the night is the King and his chronicler, and
   * nobody from the game says a word.
   *
   * This changes nothing about memory. The codex, the chronicle and the
   * character sheet are written by the game and by the show's own write-back,
   * neither of which has anything to do with who speaks at court — turning
   * this off loses a voice, never a record.
   */
  guildVoices: boolean;
  /**
   * How much of the chronicle he is given. The whole thing is rarely wanted:
   * a long chronicle crowds out the turn being written.
   */
  recallEvents: number;
  /**
   * How hot the court runs.
   *
   * Separate from the hosts' own setting because it is answering a different
   * question. A drive-time show wants a model that stays on the rails; a king
   * telling you what a winter cost him wants one that will reach for the
   * unusual word. Roleplay-tuned models in particular are built to run hotter
   * than an instruct model and sound like a careful assistant when they are
   * not allowed to.
   */
  temperature: number;
  /**
   * The King himself.
   *
   * `maxWords` is deliberately larger than the chronicler's. It is his hall and
   * his night, and a ruler given the same turn length as the person taking
   * notes does not read as a ruler however he is written.
   */
  king: {
    name: string;
    voices: Record<TtsEngine, string>;
    tone: VoiceTone;
    rate: number;
    maxWords: number;
  };
  /** Who draws him out — the chronicler he commissioned, and who serves him. */
  chronicler: {
    name: string;
    voices: Record<TtsEngine, string>;
    tone: VoiceTone;
    rate: number;
    maxWords: number;
  };
}

/**
 * The record played at the top of the show.
 *
 * This is a production choice that happens to be the app's best answer to a
 * slow model: three minutes of music is three minutes in which the listener is
 * hearing a station and the hosts' first half-dozen turns are being written.
 */
export interface OpeningSongConfig {
  /** Play a record after the station opener, before the hosts speak. */
  enabled: boolean;
  /** A file in ./music. Nothing plays when this is empty or missing. */
  file: string;
  /** What the announcer calls it. Falls back to the filename. */
  title: string;
  /** Who it is by. Left out of the throw entirely when empty. */
  artist: string;
  /** Level of the record against the show, 0..1. */
  volume: number;
}

export interface ShowConfig {
  performanceProfile: "fast" | "balanced" | "produced" | "custom";
  station: string;
  style: ShowStyle;
  /** Total dialogue turns across both hosts. */
  turns: number;
  mood: string;
  /** 0..1, level of the music bed under speech. */
  musicVolume: number;
  /** How hard speech ducks the bed, 0..1. */
  duckDepth: number;
  /** Silence inserted between turns, in seconds. */
  gapSeconds: number;
  /** Bed continues this long past the last word. */
  outroSeconds: number;
  /** Run a producer pass to find the angle before the hosts go on air. */
  useProducer: boolean;
  /** Give the show a structured running order instead of a flat conversation. */
  useRunSheet: boolean;
  /** Ask the model for a beat outline before writing dialogue. */
  useOutline: boolean;
  /** Generate a model-written title and summary after the show. */
  generateNotes: boolean;
  /** Prefill the next host prompt while opening audio plays. */
  warmUpModel: boolean;
  /** Speak each line as it is written, instead of only at the end. */
  speakWhileWriting: boolean;
  /**
   * Open with the station's own imaging the moment the show starts, before the
   * model has written anything. It is synthesised from templates rather than
   * generated, so it is ready instantly and hides the first turn's latency.
   */
  useColdOpen: boolean;
  /**
   * Keep a music bed running under the live feed, including the gaps between
   * lines. Silence while the model thinks reads as broken; a bed reads as radio.
   */
  liveBed: boolean;
  /** Let hosts cite fetched sources. */
  useResearch: boolean;
  /** Open with a record, announced by the station, before the hosts start. */
  openingSong: OpeningSongConfig;
  /**
   * How the hosts know each other. Injected identically into both system
   * prompts, because a fact only one host knows is a fact the show forgets.
   */
  relationship: string;
  /** Extra instructions appended to both hosts' system prompts. */
  directorNotes: string;
}

export interface Config {
  llm: LlmConfig;
  tts: TtsConfig;
  audio: AudioConfig;
  imaging: ImagingConfig;
  ads: AdsConfig;
  orion: OrionConfig;
  caller: CallerConfig;
  memory: MemoryConfig;
  hosts: [HostConfig, HostConfig];
  show: ShowConfig;
}

export const DEFAULT_CONFIG: Config = {
  llm: {
    provider: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "",
    producerModel: "",
    notesModel: "",
    commercialModel: "",
    model: "",
    temperature: 0.85,
    maxTokens: 400,
    timeoutSeconds: 180,
  },
  tts: {
    // Piper ships with the project, so it is the default: better than SAPI and
    // still fully offline. Falls back gracefully if the folder is missing.
    engine: "piper",
    piperPath: "",
    piperVoicesDir: "",
    timeoutSeconds: 120,
  },
  hosts: [
    {
      id: "a",
      name: "Paul",
      persona:
        "Veteran late-night local radio host on a station that leaks across unstable realities. " +
        "Warm, quick, curious, and professional under impossible conditions. Keeps the format together, " +
        "brings the listener in, understands the real subject before making jokes, and turns difficult ideas " +
        "into clean radio without flattening them.",
      stance:
        "Optimistic that the show can make the topic understandable. Leads with the strongest charitable " +
        "case, then admits the point where it becomes uncomfortable.",
      voices: {
        sapi: "Microsoft David Desktop",
        piper: "en_US-ryan-high.onnx",
        edge: "en-US-AndrewNeural",
        none: "",
      },
      tone: "studio",
      rate: 0,
      model: "",
      temperature: 0.85,
      maxWords: 90,
    },
    {
      id: "b",
      name: "Rae",
      persona:
        "Sharp co-host calling in from across the country, dry, attentive, and allergic to easy answers. " +
        "She spots the hidden assumption inside Paul's smooth explanation, remembers earlier claims, and " +
        "uses precise counterexamples without turning the conversation into a lecture.",
      stance:
        "Sceptical but fair. Looks for the cost, the exception, who carries the risk, and whether the neat " +
        "answer survives a harder version of the question.",
      voices: {
        sapi: "Microsoft Zira Desktop",
        piper: "en_US-lessac-high.onnx",
        edge: "en-US-EmmaNeural",
        none: "",
      },
      tone: "phone",
      rate: 0,
      model: "",
      temperature: 0.9,
      maxWords: 90,
    },
  ],
  caller: {
    name: "Caller",
    voices: {
      sapi: "Microsoft Hazel Desktop",
      piper: "en_US-hfc_female-medium.onnx",
      edge: "en-GB-RyanNeural",
      none: "",
    },
    tone: "phone",
    rate: 0,
  },
  memory: {
    enabled: true,
    historyTurns: 6,
    updateEvery: 3,
    crossShow: true,
    backend: "lexical",
    embeddingModel: "text-embedding-nomic-embed-text-v1.5",
    recallCount: 3,
  },
  imaging: {
    useIdent: true,
    useTransitions: true,
    useCallStings: true,
    level: 0.5,
    talkOverIntro: true,
  },
  ads: {
    enabled: true,
    breaks: 1,
    spotsPerBreak: 2,
    source: "invented",
    style: "mixed",
    spotWords: 55,
    reusePercent: 40,
    bedMood: "upbeat",
    bedVolume: 0.3,
    loudnessDb: 3,
    usePromos: true,
    topUpBucket: true,
    minReplayHours: 24,
    separateSponsors: true,
    sourceWeights: { station: 1, realm: 1, multiverse: 1.4 },
    announcer: {
      name: "Announcer",
      voices: {
        sapi: "Microsoft David Desktop",
        piper: "en_US-ryan-high.onnx",
        edge: "en-US-GuyNeural",
        none: "",
      },
      tone: "studio",
      rate: 1,
    },
    sponsors: [],
  },
  orion: {
    enabled: false,
    realmPath: "",
    lore:
      "Orion did not inherit this realm, he took it. He burned, robbed and annexed his way across " +
      "every land that touched his border, and the ones he did not take he bled. That is how the " +
      "kingdom got its size and it is why no neighbour will ride to help him now. He does not " +
      "apologise for any of it, and he does not pretend it was necessary.\n\n" +
      "Wommper is the first thing since the conquest that has genuinely threatened him. He is not " +
      "a bandit or a nuisance — he is taking the kingdom apart, piece by piece, and he is winning " +
      "in the places it matters. He rides with the Respawn Guild: travellers he has picked up on " +
      "the road who keep getting back up after they are put down, which is a thing Orion has no " +
      "answer to yet.\n\n" +
      "The King is old enough to see the shape of it. He built a kingdom by taking other people's, " +
      "and something has finally arrived to do the same to him.",
    writeBack: true,
    guildVoices: true,
    recallEvents: 80,
    temperature: 0.72,
    king: {
      name: "King Orion",
      voices: {
        sapi: "Microsoft David Desktop",
        piper: "en_GB-alan-medium.onnx",
        edge: "en-US-ChristopherNeural",
        none: "",
      },
      tone: "throne",
      rate: -3,
      maxWords: 72,
    },
    chronicler: {
      name: "Maeve",
      voices: {
        sapi: "Microsoft Hazel Desktop",
        piper: "en_GB-jenny_dioco-medium.onnx",
        edge: "en-GB-SoniaNeural",
        none: "",
      },
      tone: "room",
      rate: -1,
      maxWords: 52,
    },
  },
  audio: {
    preset: "high",
    sampleRate: 44100,
    bitDepth: 16,
    stereo: true,
    width: 0.35,
    compress: true,
  },
  show: {
    performanceProfile: "balanced",
    station: "Local Talk Radio",
    style: "debate",
    turns: 24,
    mood: "latenight",
    musicVolume: 0.16,
    duckDepth: 0.72,
    gapSeconds: 0.32,
    outroSeconds: 6,
    useProducer: true,
    useRunSheet: true,
    useOutline: true,
    generateNotes: true,
    warmUpModel: true,
    speakWhileWriting: true,
    useColdOpen: true,
    liveBed: true,
    useResearch: false,
    openingSong: { enabled: false, file: "", title: "", artist: "", volume: 0.85 },
    relationship: "",
    directorNotes: "",
  },
};

const CONFIG_PATH = path.join(process.cwd(), "config.json");

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Coerce arbitrary parsed JSON into a valid Config, filling gaps from defaults. */
export function normalizeConfig(raw: unknown): Config {
  const input = (raw ?? {}) as Partial<Config>;
  const d = DEFAULT_CONFIG;

  const llmIn = (input.llm ?? {}) as Partial<LlmConfig>;
  const llm: LlmConfig = {
    provider: oneOf(llmIn.provider, ["lmstudio", "ollama", "openai-compatible", "gemini"] as const, d.llm.provider),
    baseUrl: str(llmIn.baseUrl, d.llm.baseUrl).trim(),
    apiKey: str(llmIn.apiKey, d.llm.apiKey),
    producerModel: str(llmIn.producerModel, d.llm.producerModel).trim(),
    notesModel: str(llmIn.notesModel, d.llm.notesModel).trim(),
    commercialModel: str(llmIn.commercialModel, d.llm.commercialModel).trim(),
    model: str(llmIn.model, d.llm.model).trim(),
    temperature: clamp(llmIn.temperature, 0, 2, d.llm.temperature),
    maxTokens: Math.round(clamp(llmIn.maxTokens, 32, 8192, d.llm.maxTokens)),
    timeoutSeconds: Math.round(clamp(llmIn.timeoutSeconds, 10, 3600, d.llm.timeoutSeconds)),
  };

  const ttsIn = (input.tts ?? {}) as Partial<TtsConfig>;
  const tts: TtsConfig = {
    engine: oneOf(ttsIn.engine, ["sapi", "piper", "edge", "none"] as const, d.tts.engine),
    piperPath: str(ttsIn.piperPath, d.tts.piperPath),
    piperVoicesDir: str(ttsIn.piperVoicesDir, d.tts.piperVoicesDir),
    timeoutSeconds: Math.round(clamp(ttsIn.timeoutSeconds, 10, 3600, d.tts.timeoutSeconds)),
  };

  const audioIn = (input.audio ?? {}) as Partial<AudioConfig>;
  const preset = oneOf(audioIn.preset, ["standard", "high", "studio"] as const, d.audio.preset);

  // A named preset owns its settings; "custom" is expressed by leaving the
  // preset alone and editing fields, so only fill gaps from the preset here.
  const presetDefaults: Record<QualityPreset, Omit<AudioConfig, "preset">> = {
    standard: { sampleRate: 22050, bitDepth: 16, stereo: false, width: 0, compress: false },
    high: { sampleRate: 44100, bitDepth: 16, stereo: true, width: 0.35, compress: true },
    studio: { sampleRate: 48000, bitDepth: 24, stereo: true, width: 0.45, compress: true },
  };
  const base = presetDefaults[preset];

  const audio: AudioConfig = {
    preset,
    sampleRate: [22050, 24000, 32000, 44100, 48000].includes(Number(audioIn.sampleRate))
      ? Number(audioIn.sampleRate)
      : base.sampleRate,
    bitDepth: audioIn.bitDepth === 24 ? 24 : audioIn.bitDepth === 16 ? 16 : base.bitDepth,
    stereo: typeof audioIn.stereo === "boolean" ? audioIn.stereo : base.stereo,
    width: clamp(audioIn.width, 0, 1, base.width),
    compress: typeof audioIn.compress === "boolean" ? audioIn.compress : base.compress,
  };

  const callerIn = (input.caller ?? {}) as Partial<CallerConfig>;
  const callerVoices = (callerIn.voices ?? {}) as Partial<Record<TtsEngine, string>>;
  const caller: CallerConfig = {
    name: str(callerIn.name, d.caller.name).slice(0, 40) || d.caller.name,
    voices: {
      sapi: str(callerVoices.sapi, d.caller.voices.sapi),
      piper: str(callerVoices.piper, d.caller.voices.piper),
      edge: str(callerVoices.edge, d.caller.voices.edge),
      none: "",
    },
    tone: oneOf(callerIn.tone, ["studio", "phone", "room", "throne", "raw"] as const, d.caller.tone),
    rate: Math.round(clamp(callerIn.rate, -10, 10, d.caller.rate)),
  };

  const memIn = (input.memory ?? {}) as Partial<MemoryConfig>;
  const memory: MemoryConfig = {
    enabled: typeof memIn.enabled === "boolean" ? memIn.enabled : d.memory.enabled,
    historyTurns: Math.round(clamp(memIn.historyTurns, 2, 40, d.memory.historyTurns)),
    updateEvery: Math.round(clamp(memIn.updateEvery, 1, 10, d.memory.updateEvery)),
    crossShow: typeof memIn.crossShow === "boolean" ? memIn.crossShow : d.memory.crossShow,
    backend: oneOf(memIn.backend, ["lexical", "embeddings"] as const, d.memory.backend),
    embeddingModel: str(memIn.embeddingModel, d.memory.embeddingModel).trim(),
    recallCount: Math.round(clamp(memIn.recallCount, 0, 8, d.memory.recallCount)),
  };

  const imgIn = (input.imaging ?? {}) as Partial<ImagingConfig>;
  const imaging: ImagingConfig = {
    useIdent: typeof imgIn.useIdent === "boolean" ? imgIn.useIdent : d.imaging.useIdent,
    useTransitions: typeof imgIn.useTransitions === "boolean" ? imgIn.useTransitions : d.imaging.useTransitions,
    useCallStings: typeof imgIn.useCallStings === "boolean" ? imgIn.useCallStings : d.imaging.useCallStings,
    level: clamp(imgIn.level, 0, 1, d.imaging.level),
    talkOverIntro: typeof imgIn.talkOverIntro === "boolean" ? imgIn.talkOverIntro : d.imaging.talkOverIntro,
  };

  const adsIn = (input.ads ?? {}) as Partial<AdsConfig>;
  const weightsIn = (adsIn.sourceWeights ?? {}) as Partial<AdsConfig["sourceWeights"]>;
  const annIn = (adsIn.announcer ?? {}) as Partial<AdsConfig["announcer"]>;
  const annVoices = (annIn.voices ?? {}) as Partial<Record<TtsEngine, string>>;

  const sponsorsIn = Array.isArray(adsIn.sponsors) ? adsIn.sponsors : [];
  const sponsors: Sponsor[] = sponsorsIn
    .slice(0, 24)
    .map((raw, i) => {
      const sp = (raw ?? {}) as Partial<Sponsor>;
      return {
        // Ids are referenced by nothing else, so a missing one is not fatal —
        // but a stable one keeps React keys and edits from jumping around.
        id: str(sp.id, "").trim() || `sponsor-${i + 1}`,
        name: str(sp.name, "").trim().slice(0, 80),
        product: str(sp.product, "").trim().slice(0, 200),
        talkingPoints: str(sp.talkingPoints, "").trim().slice(0, 800),
        tagline: str(sp.tagline, "").trim().slice(0, 160),
        style: str(sp.style, "").trim().slice(0, 700),
        // Only a bare filename; the ads folder is not a path the config gets
        // to escape from.
        audioFile: path.basename(str(sp.audioFile, "").trim()).slice(0, 160),
        enabled: typeof sp.enabled === "boolean" ? sp.enabled : true,
      } satisfies Sponsor;
    })
    .filter((sp) => sp.name || sp.audioFile);

  const ads: AdsConfig = {
    enabled: typeof adsIn.enabled === "boolean" ? adsIn.enabled : d.ads.enabled,
    // A long show needs more of them; breakPositions spaces out whatever it gets.
    breaks: Math.round(clamp(adsIn.breaks, 0, 24, d.ads.breaks)),
    spotsPerBreak: Math.round(clamp(adsIn.spotsPerBreak, 1, 4, d.ads.spotsPerBreak)),
    minReplayHours: clamp(adsIn.minReplayHours, 0, 24 * 30, d.ads.minReplayHours),
    separateSponsors: typeof adsIn.separateSponsors === "boolean" ? adsIn.separateSponsors : d.ads.separateSponsors,
    sourceWeights: {
      station: clamp(weightsIn.station, 0.1, 5, d.ads.sourceWeights.station),
      realm: clamp(weightsIn.realm, 0.1, 5, d.ads.sourceWeights.realm),
      multiverse: clamp(weightsIn.multiverse, 0.1, 5, d.ads.sourceWeights.multiverse),
    },
    source: oneOf(adsIn.source, ["sponsors", "invented", "mixed"] as const, d.ads.source),
    style: oneOf(adsIn.style, ["live_read", "produced", "mixed"] as const, d.ads.style),
    spotWords: Math.round(clamp(adsIn.spotWords, 20, 160, d.ads.spotWords)),
    reusePercent: Math.round(clamp(adsIn.reusePercent, 0, 100, d.ads.reusePercent)),
    bedMood: str(adsIn.bedMood, d.ads.bedMood),
    bedVolume: clamp(adsIn.bedVolume, 0, 1, d.ads.bedVolume),
    loudnessDb: clamp(adsIn.loudnessDb, 0, 8, d.ads.loudnessDb),
    usePromos: typeof adsIn.usePromos === "boolean" ? adsIn.usePromos : d.ads.usePromos,
    topUpBucket: typeof adsIn.topUpBucket === "boolean" ? adsIn.topUpBucket : d.ads.topUpBucket,
    announcer: {
      name: str(annIn.name, d.ads.announcer.name).slice(0, 40) || d.ads.announcer.name,
      voices: {
        sapi: str(annVoices.sapi, d.ads.announcer.voices.sapi),
        piper: str(annVoices.piper, d.ads.announcer.voices.piper),
        edge: str(annVoices.edge, d.ads.announcer.voices.edge),
        none: "",
      },
      tone: oneOf(annIn.tone, ["studio", "phone", "room", "throne", "raw"] as const, d.ads.announcer.tone),
      rate: Math.round(clamp(annIn.rate, -10, 10, d.ads.announcer.rate)),
    },
    sponsors,
  };

  const hostsIn = Array.isArray(input.hosts) ? input.hosts : [];
  const hosts = d.hosts.map((def, i) => {
    const h = (hostsIn[i] ?? {}) as Partial<HostConfig> & { voice?: string };
    const vIn = (h.voices ?? {}) as Partial<Record<TtsEngine, string>>;

    // Configs written before per-engine voices had a single `voice` field.
    // Fold it into the slot for whichever engine was selected at the time.
    const legacy = typeof h.voice === "string" ? h.voice : "";
    const voices: Record<TtsEngine, string> = {
      sapi: str(vIn.sapi, def.voices.sapi),
      piper: str(vIn.piper, def.voices.piper),
      edge: str(vIn.edge, def.voices.edge),
      none: "",
    };
    if (legacy && vIn[tts.engine] === undefined) {
      voices[tts.engine] = legacy;
    }

    return {
      id: def.id,
      name: str(h.name, def.name).slice(0, 40) || def.name,
      persona: str(h.persona, def.persona),
      stance: str(h.stance, def.stance),
      voices,
      tone: oneOf(h.tone, ["studio", "phone", "room", "throne", "raw"] as const, def.tone),
      rate: Math.round(clamp(h.rate, -10, 10, def.rate)),
      model: str(h.model, def.model).trim(),
      temperature: clamp(h.temperature, 0, 2, def.temperature),
      maxWords: Math.round(clamp(h.maxWords, 15, 400, def.maxWords)),
    } satisfies HostConfig;
  }) as [HostConfig, HostConfig];

  const showIn = (input.show ?? {}) as Partial<ShowConfig>;
  const show: ShowConfig = {
    performanceProfile: oneOf(showIn.performanceProfile, ["fast", "balanced", "produced", "custom"] as const, d.show.performanceProfile),
    station: str(showIn.station, d.show.station).slice(0, 60) || d.show.station,
    style: oneOf(
      showIn.style,
      ["debate", "interview", "roundtable", "banter", "explainer", "coldopen", "deepdive"] as const,
      d.show.style,
    ),
    // No practical ceiling. Sixty turns was a guess at what a show should be,
    // not a limit the pipeline has: the prompt is windowed, the older turns
    // survive as a digest, and the breaks space themselves out however many
    // there are. Six hundred is roughly a five-hour show, which is far past
    // any real use and still leaves the number bounded.
    turns: Math.round(clamp(showIn.turns, 2, 600, d.show.turns)),
    mood: str(showIn.mood, d.show.mood),
    musicVolume: clamp(showIn.musicVolume, 0, 1, d.show.musicVolume),
    duckDepth: clamp(showIn.duckDepth, 0, 1, d.show.duckDepth),
    gapSeconds: clamp(showIn.gapSeconds, 0, 3, d.show.gapSeconds),
    outroSeconds: clamp(showIn.outroSeconds, 0, 30, d.show.outroSeconds),
    useProducer: typeof showIn.useProducer === "boolean" ? showIn.useProducer : d.show.useProducer,
    useRunSheet: typeof showIn.useRunSheet === "boolean" ? showIn.useRunSheet : d.show.useRunSheet,
    useOutline: typeof showIn.useOutline === "boolean" ? showIn.useOutline : d.show.useOutline,
    generateNotes: typeof showIn.generateNotes === "boolean" ? showIn.generateNotes : d.show.generateNotes,
    warmUpModel: typeof showIn.warmUpModel === "boolean" ? showIn.warmUpModel : d.show.warmUpModel,
    speakWhileWriting:
      typeof showIn.speakWhileWriting === "boolean" ? showIn.speakWhileWriting : d.show.speakWhileWriting,
    useColdOpen: typeof showIn.useColdOpen === "boolean" ? showIn.useColdOpen : d.show.useColdOpen,
    liveBed: typeof showIn.liveBed === "boolean" ? showIn.liveBed : d.show.liveBed,
    useResearch: typeof showIn.useResearch === "boolean" ? showIn.useResearch : d.show.useResearch,
    openingSong: (() => {
      const songIn = (showIn.openingSong ?? {}) as Partial<OpeningSongConfig>;
      const ds = d.show.openingSong;
      return {
        enabled: typeof songIn.enabled === "boolean" ? songIn.enabled : ds.enabled,
        // Only a bare filename; the music folder is not a path config gets to
        // escape from.
        file: path.basename(str(songIn.file, ds.file).trim()).slice(0, 160),
        title: str(songIn.title, ds.title).trim().slice(0, 120),
        artist: str(songIn.artist, ds.artist).trim().slice(0, 120),
        volume: clamp(songIn.volume, 0, 1, ds.volume),
      } satisfies OpeningSongConfig;
    })(),
    relationship: str(showIn.relationship, d.show.relationship).slice(0, 1000),
    directorNotes: str(showIn.directorNotes, d.show.directorNotes).slice(0, 2000),
  };

  // ── King Orion's Realm ─────────────────────────────────────────
  //
  // The realm path is the one place a user-supplied path is allowed to point
  // anywhere on disk, because it names somebody else's project. It is only
  // ever opened, never created, and the reader refuses any folder that does
  // not already contain the game's world.db.
  const orionIn = (input.orion ?? {}) as Partial<OrionConfig>;
  const kingIn = (orionIn.king ?? {}) as Partial<OrionConfig["king"]>;
  const kingVoices = (kingIn.voices ?? {}) as Partial<Record<TtsEngine, string>>;
  const chroniclerIn = (orionIn.chronicler ?? {}) as Partial<OrionConfig["chronicler"]>;
  const chroniclerVoices = (chroniclerIn.voices ?? {}) as Partial<Record<TtsEngine, string>>;

  const orion: OrionConfig = {
    enabled: typeof orionIn.enabled === "boolean" ? orionIn.enabled : d.orion.enabled,
    realmPath: str(orionIn.realmPath, d.orion.realmPath).trim().slice(0, 400),
    lore: str(orionIn.lore, d.orion.lore).slice(0, 4000),
    writeBack: typeof orionIn.writeBack === "boolean" ? orionIn.writeBack : d.orion.writeBack,
    guildVoices: typeof orionIn.guildVoices === "boolean" ? orionIn.guildVoices : d.orion.guildVoices,
    recallEvents: Math.round(clamp(orionIn.recallEvents, 0, 200, d.orion.recallEvents)),
    temperature: clamp(orionIn.temperature, 0, 2, d.orion.temperature),
    king: {
      name: str(kingIn.name, d.orion.king.name).slice(0, 40) || d.orion.king.name,
      voices: {
        sapi: str(kingVoices.sapi, d.orion.king.voices.sapi),
        piper: str(kingVoices.piper, d.orion.king.voices.piper),
        edge: str(kingVoices.edge, d.orion.king.voices.edge),
        none: "",
      },
      tone: oneOf(kingIn.tone, ["studio", "phone", "room", "throne", "raw"] as const, d.orion.king.tone),
      rate: Math.round(clamp(kingIn.rate, -10, 10, d.orion.king.rate)),
      maxWords: Math.round(clamp(kingIn.maxWords, 10, 200, d.orion.king.maxWords)),
    },
    chronicler: {
      name: str(chroniclerIn.name, d.orion.chronicler.name).slice(0, 40) || d.orion.chronicler.name,
      voices: {
        sapi: str(chroniclerVoices.sapi, d.orion.chronicler.voices.sapi),
        piper: str(chroniclerVoices.piper, d.orion.chronicler.voices.piper),
        edge: str(chroniclerVoices.edge, d.orion.chronicler.voices.edge),
        none: "",
      },
      tone: oneOf(chroniclerIn.tone, ["studio", "phone", "room", "throne", "raw"] as const, d.orion.chronicler.tone),
      rate: Math.round(clamp(chroniclerIn.rate, -10, 10, d.orion.chronicler.rate)),
      maxWords: Math.round(clamp(chroniclerIn.maxWords, 10, 200, d.orion.chronicler.maxWords)),
    },
  };

  return { llm, tts, audio, imaging, ads, orion, caller, memory, hosts, show };
}

let cached: Config | null = null;
let cachedMtimeMs = -1;

export function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const mtimeMs = fs.statSync(CONFIG_PATH).mtimeMs;
      if (cached && cachedMtimeMs === mtimeMs) return cached;
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      cached = normalizeConfig(parsed);
      cachedMtimeMs = mtimeMs;
      return cached;
    }
  } catch (err) {
    console.warn(`[config] ${CONFIG_PATH} could not be read, using defaults:`, (err as Error).message);
    // A half-written manual edit should not make a running station suddenly
    // revert every setting. Keep the last valid snapshot until it parses.
    if (cached) return cached;
  }

  cached = normalizeConfig({});
  cachedMtimeMs = -1;
  return cached;
}

export function saveConfig(raw: unknown): Config {
  const next = normalizeConfig(raw);
  atomicWriteJson(CONFIG_PATH, next, false);
  cached = next;
  cachedMtimeMs = fs.statSync(CONFIG_PATH).mtimeMs;
  return next;
}

/** Merge a partial override into the stored config without persisting it. */
export function withOverrides(base: Config, overrides: unknown): Config {
  if (!overrides || typeof overrides !== "object") return base;
  const o = overrides as Record<string, unknown>;
  return normalizeConfig({
    llm: { ...base.llm, ...((o.llm as object) ?? {}) },
    tts: { ...base.tts, ...((o.tts as object) ?? {}) },
    audio: { ...base.audio, ...((o.audio as object) ?? {}) },
    imaging: { ...base.imaging, ...((o.imaging as object) ?? {}) },
    ads: { ...base.ads, ...((o.ads as object) ?? {}) },
    orion: { ...base.orion, ...((o.orion as object) ?? {}) },
    caller: { ...base.caller, ...((o.caller as object) ?? {}) },
    memory: { ...base.memory, ...((o.memory as object) ?? {}) },
    hosts: [
      { ...base.hosts[0], ...(((o.hosts as unknown[])?.[0] as object) ?? {}) },
      { ...base.hosts[1], ...(((o.hosts as unknown[])?.[1] as object) ?? {}) },
    ],
    show: { ...base.show, ...((o.show as object) ?? {}) },
  });
}

export const configPath = CONFIG_PATH;

/** The voice a host or the caller uses under the given engine. */
export function voiceFor(speaker: { voices: Record<TtsEngine, string> }, engine: TtsEngine): string {
  return speaker.voices[engine] ?? "";
}

/**
 * Piper is shipped inside the project under tools/piper. When the user has not
 * set an explicit path, fall back to that bundled copy so it works with no
 * configuration at all.
 */
export function resolvePiperPaths(tts: TtsConfig): { exeDir: string; voicesDir: string } {
  const bundledDir = path.join(process.cwd(), "tools", "piper");

  const exeDir = tts.piperPath.trim() || bundledDir;
  const voicesDir = tts.piperVoicesDir.trim() || path.join(bundledDir, "voices");

  return { exeDir, voicesDir };
}
