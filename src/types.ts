export type LlmProvider = "lmstudio" | "ollama" | "openai-compatible" | "gemini";
export type TtsEngine = "sapi" | "piper" | "edge" | "none";
export type VoiceTone = "studio" | "phone" | "room" | "throne" | "raw";
export type ShowStyle = "debate" | "interview" | "roundtable" | "banter" | "explainer" | "coldopen" | "deepdive";
export type QualityPreset = "standard" | "high" | "studio";

export interface AudioConfig {
  preset: QualityPreset;
  sampleRate: number;
  bitDepth: 16 | 24;
  stereo: boolean;
  width: number;
  compress: boolean;
}

export interface ImagingConfig {
  useIdent: boolean;
  useTransitions: boolean;
  useCallStings: boolean;
  level: number;
  talkOverIntro: boolean;
}

export type AdStyle = "live_read" | "produced" | "mixed";
export type AdSource = "sponsors" | "invented" | "mixed";

export interface OpeningSongConfig {
  enabled: boolean;
  file: string;
  title: string;
  artist: string;
  volume: number;
}

export interface Sponsor {
  id: string;
  name: string;
  product: string;
  talkingPoints: string;
  tagline: string;
  /** Direction for the copywriter on how the spot is performed. Never read out. */
  style: string;
  audioFile: string;
  enabled: boolean;
}

export interface AdsConfig {
  enabled: boolean;
  breaks: number;
  spotsPerBreak: number;
  source: AdSource;
  style: AdStyle;
  spotWords: number;
  /** How much of the load is repeated from the shelf rather than cut fresh. */
  reusePercent: number;
  bedMood: string;
  bedVolume: number;
  loudnessDb: number;
  usePromos: boolean;
  /** Keep the commercial bucket stocked on its own, after a show. */
  topUpBucket: boolean;
  announcer: {
    name: string;
    voices: Record<TtsEngine, string>;
    tone: VoiceTone;
    rate: number;
  };
  sponsors: Sponsor[];
}

/** A file sitting in the ads drop folder. */
export interface AdFile {
  name: string;
  bytes: number;
  modified: string;
}

/** One break, as planned before the show goes to air. */
export interface PlannedBreak {
  index: number;
  label: string;
  spots: Array<{ kind: string; sponsor: string; text: string; repeat?: boolean }>;
}

export interface HostConfig {
  id: "a" | "b";
  name: string;
  persona: string;
  stance: string;
  /** Chosen voice per engine, so switching engines keeps your other choices. */
  voices: Record<TtsEngine, string>;
  tone: VoiceTone;
  rate: number;
  model: string;
  temperature: number;
  maxWords: number;
}

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  producerModel: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
}

export interface TtsConfig {
  engine: TtsEngine;
  piperPath: string;
  piperVoicesDir: string;
  timeoutSeconds: number;
}

export interface ShowConfig {
  station: string;
  style: ShowStyle;
  turns: number;
  mood: string;
  musicVolume: number;
  duckDepth: number;
  gapSeconds: number;
  outroSeconds: number;
  useProducer: boolean;
  useRunSheet: boolean;
  useOutline: boolean;
  speakWhileWriting: boolean;
  useColdOpen: boolean;
  liveBed: boolean;
  useResearch: boolean;
  openingSong: OpeningSongConfig;
  relationship: string;
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

export interface TranscriptLine {
  start: number;
  end: number;
  speaker: string;
  /** "break" is a commercial, "station" the show's own imaging, "song" a record. */
  hostId: "a" | "b" | "caller" | "break" | "station" | "song";
  text: string;
}

export interface Show {
  id: string;
  title: string;
  summary: string;
  topic: string;
  station: string;
  style: string;
  mood: string;
  createdAt: string;
  duration: number;
  hasAudio: boolean;
  hosts: Array<{ id: string; name: string; voice: string; tone: string; model: string }>;
  outline: string[];
  sources: Array<{ title: string; url: string }>;
  transcript: TranscriptLine[];
  models: string[];
  generationVersion?: number;
  audioUrl?: string;
  coverUrl?: string;
}

export type DjRating = "keeper" | "reject";

export interface DjFeedback {
  id: string;
  showId: string;
  lineIndex: number;
  topic: string;
  speaker: string;
  hostId: string;
  text: string;
  previousLine: string;
  model: string;
  lane: "station" | "court";
  rating: DjRating;
  tags: string[];
  updatedAt: string;
}

export interface DjTrainingReadiness {
  curatedExchanges: number;
  curatedRows: number;
  keepers: number;
  rejected: number;
  totalRows: number;
  minimumKeeperTarget: number;
  readyForLora: boolean;
  reason: string;
}

export interface StoredFile {
  name: string;
  bytes: number;
  modified: string;
  path: string;
}

export interface ShowFiles {
  id: string;
  title: string;
  totalBytes: number;
  files: StoredFile[];
}

export interface StorageSummary {
  root: string;
  totalBytes: number;
  showCount: number;
  fileCount: number;
  scratchBytes: number;
  shows: Array<{ id: string; title: string; createdAt: string; bytes: number; hasAudio: boolean }>;
}

export interface CallerConfig {
  name: string;
  voices: Record<TtsEngine, string>;
  tone: VoiceTone;
  rate: number;
}

export interface MemoryConfig {
  enabled: boolean;
  historyTurns: number;
  updateEvery: number;
  crossShow: boolean;
  backend: "lexical" | "embeddings";
  embeddingModel: string;
  recallCount: number;
}

export interface MemoryStats {
  backend: string;
  shows: number;
  passages: number;
  path: string;
}

export interface ProducerBrief {
  hook: string;
  concepts: string[];
  ahaMoments: string[];
  analogies: string[];
  audience: string;
}

export interface Option {
  id: string;
  label: string;
  description?: string;
  baseUrl?: string;
}

export interface HostPreset {
  id: string;
  label: string;
  description: string;
  hosts: Array<{ name: string; persona: string; stance: string }>;
}

export interface Options {
  moods: Option[];
  adStyles: Option[];
  adSources: Option[];
  hostPresets: HostPreset[];
  qualityPresets: Option[];
  styles: Option[];
  tones: Option[];
  providers: Option[];
  ttsEngines: Option[];
}

export interface ModelInfo {
  id: string;
  label: string;
}

export interface Voice {
  id: string;
  label: string;
  detail?: string;
}

export interface ProbeResult<T> {
  ok: boolean;
  error?: string;
  hint?: string;
  models?: T[];
  voices?: T[];
}

/** A line as it is being produced, before the show is saved. */
export interface LiveTurn {
  index: number;
  speaker: string;
  hostId: "a" | "b" | "caller" | "break" | "station" | "song";
  text: string;
  streaming: boolean;
  /** Set once the line has been spoken and is ready to play. */
  audioUrl?: string;
  seconds?: number;
}

export interface TimingEntry {
  phase: string;
  milliseconds: number;
  index?: number;
  queueMs?: number;
  turns?: number;
  skipped?: boolean;
}

export type Stage =
  | "idle"
  | "producer"
  | "research"
  | "ads"
  | "conversation"
  | "notes"
  | "audio"
  | "done"
  | "error"
  | "cancelled";

/** Somebody who has rung the station, remembered across every show. */
export interface CallerRecord {
  name: string;
  calls: number;
  firstHeard: string;
  lastHeard: string;
  topics: string[];
  lines: string[];
}

/** A finished commercial kept on the shelf for reuse on later shows. */
export interface LibrarySpot {
  id: string;
  sponsor: string;
  angle: string;
  kind: string;
  text: string;
  seconds: number;
  created: string;
  lastPlayed: string;
  plays: number;
  formatVersion?: number;
}

/* ── King Orion's Realm ──────────────────────────────────────────── */

export interface OrionSpeaker {
  name: string;
  voices: Record<TtsEngine, string>;
  tone: VoiceTone;
  rate: number;
}

export interface OrionConfig {
  enabled: boolean;
  realmPath: string;
  /** The realm's standing history, spoken from as fact. */
  lore: string;
  writeBack: boolean;
  /**
   * Whether a rider of the Respawn Guild is brought into the hall to speak.
   * Off, the night is the King and his chronicler alone. Nothing to do with
   * memory: the character sheet and the chronicle are written either way.
   */
  guildVoices: boolean;
  recallEvents: number;
  /** How hot the court runs. Separate from the radio hosts'. */
  temperature: number;
  king: OrionSpeaker;
  chronicler: OrionSpeaker;
}

/** Wommper's state, straight out of the game's save file. */
export interface RealmSave {
  level: number;
  xp: number;
  maxHp: number;
  currentHp: number;
  playerClass: string;
  inventory: string[];
  gold: number;
  equippedWeapon: string | null;
  equippedArmor: string | null;
  knownSpells: string[];
  journal: string;
  contacts: string;
  turnCount: number;
  inCombat: boolean;
}

export interface RealmEvent {
  id: number;
  type: string;
  description: string;
  participants: string[];
  location: string;
  importance: number;
  timestamp: string;
}

/** The game's brain, as read for the King. */
export interface Realm {
  found: boolean;
  root: string;
  summary: string;
  problems: string[];
  save: RealmSave | null;
  /** The Respawn Guild — the party riding with the realm's enemy. */
  guild: Array<{
    name: string; deaths: number; kills: number; turns: number; fallen: boolean;
    level?: number; currentHp?: number; maxHp?: number; playerClass?: string; location?: string;
  }>;
  events: RealmEvent[];
  quests: Array<{ id: string; name: string; description: string; status: string; location: string }>;
  npcs: Array<{ id: string; name: string; location: string; status: string; disposition: string }>;
  locations: Array<{ id: string; name: string; description: string }>;
  claims: Array<{
    id: number; source: string; description: string; participants: string[];
    location: string; status: string; timestamp: string;
  }>;
  campaignId: string;
  stateSource: "discord" | "solo" | "none";
  /** Exactly what goes into his prompt, so it can be read rather than trusted. */
  briefing: string;
}
