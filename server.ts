/**
 * Local Talk Radio — server.
 *
 * Everything runs on this machine: your LLM, your speech engine, your files.
 * No cloud storage and no quota. Mutating the local game world requires a
 * generated machine-local key. Other network calls go only to the configured
 * model endpoint and, when research is enabled, the URLs the user supplies.
 */

import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

import {
  loadConfig,
  saveConfig,
  withOverrides,
  configPath,
  voiceFor,
  DEFAULT_CONFIG,
  type Config,
} from "./server/config.ts";
import { isLocalOrigin, requestGuard } from "./server/lib/request-guard.ts";
import { probe as probeLlm, defaultBaseUrl, LlmError, queueStats } from "./server/providers/llm.ts";
import { probeTts, synthesize, TtsError } from "./server/providers/tts.ts";
import { DEFAULT_PIPER_VOICES, installPiper, installedPiperVoices } from "./server/setup/piper.ts";
import {
  coverImage,
  customCover,
  loadPodcastSettings,
  podcastDir,
  podcastJob,
  podcastShows,
  podcastSiteDir,
  removeCustomCover,
  saveCustomCover,
  savePodcastSettings,
  startPublish,
} from "./server/podcast/publish.ts";
import { PODCAST_CATEGORIES } from "./server/podcast/feed.ts";
import { QUALITY as PODCAST_QUALITY } from "./server/podcast/mp3.ts";
import { runConversation, generateShowNotes, warmUp, type Turn } from "./server/pipeline/conversation.ts";
import { buildIndex, recall, memoryStats, clearIndex, type Recollection } from "./server/memory/retrieval.ts";
import { callerBriefing, findCaller, forgetCaller, listCallers, rememberCall } from "./server/memory/callers.ts";
import {
  djTrainingReadiness,
  djTrainingSplit,
  feedbackForShow,
  listDjFeedback,
  rateDjLine,
  trainingJsonl,
} from "./server/memory/djfeedback.ts";
import {
  briefing as runningBriefing,
  forget as forgetRunning,
  laneFor,
  listLanes,
  remember as rememberRunning,
} from "./server/memory/running.ts";
import { buildRunSheet, runProducer, hasBrief, EMPTY_BRIEF, type ProducerBrief } from "./server/pipeline/showrunner.ts";
import {
  audioFor,
  auditBucket,
  BUCKET_DIR,
  bucketStats,
  getSpot,
  listBucket,
  markPlayed as markBucketPlayed,
  markPlayedMany as markBucketPlayedMany,
  pickForShow,
  removeSpot,
  setRotation,
  setTags,
  setKeep,
  updateSpot,
} from "./server/pipeline/bucket.ts";
import {
  activateCommercialBrain,
  activeBrainVersion,
  commercialBrain,
  commercialHistory,
  dryRunCommercial,
  runBrainTests,
  saveCommercialBrain,
  tidy,
  topUp,
  writeSpot,
  type Brief,
} from "./server/pipeline/bucketwriter.ts";
import { runResearch, type ResearchResult } from "./server/pipeline/research.ts";
import { produceShow, renderTurnClip, hostFor } from "./server/pipeline/produce.ts";
import { MAX_MIX_SECONDS } from "./shared/mix-policy.ts";
import {
  planBreaks,
  renderBreak,
  breakPositions,
  describeBreak,
  listAdFiles,
  resolveAdFile,
  ADS_DIR,
  type AdBreak,
} from "./server/pipeline/ads.ts";
import {
  renderColdOpen,
  coldOpenScript,
  renderCourtOpen,
  courtOpenScript,
} from "./server/pipeline/coldopen.ts";
import {
  MUSIC_DIR,
  listSongFiles,
  resolveSongFile,
  renderSongIntro,
  songIntroScript,
  courtSongIntroScript,
  songLabel,
  songDetails,
  loadSong,
} from "./server/pipeline/songs.ts";
import { audioPathFor, listLibrary, forget as forgetLibrarySpot } from "./server/pipeline/adlibrary.ts";
import {
  EMPTY_REALM,
  readRealm,
  realmBriefing as buildRealmBriefing,
  realmPlaces,
  realmSummary,
  type Realm,
} from "./server/orion/realm.ts";
import { recordTales, forgetTales } from "./server/orion/chronicle.ts";
import { courtBroadcastMemory } from "./server/orion/broadcast-memory.ts";
import {
  claimsSince,
  createWorldSnapshot,
  eventsSince,
  WORLD_CONTRACT,
  WORLD_SCHEMA_VERSION,
} from "./server/orion/world-contract.ts";
import {
  ensureWorldApiToken,
  executeWorldCommand,
  isAuthorizedWorldCommand,
  parseWorldCommand,
  WorldCommandError,
  WORLD_COMMAND_TYPES,
} from "./server/orion/world-command.ts";
import { converse, ConverseError, CONVERSE_MAX_LINE } from "./server/orion/converse.ts";
import { orionTrainingReadiness, orionTrainingSplit } from "./server/orion/training.ts";
import { choosePetitioner, isWommper, speakPetition, voiceForMember } from "./server/orion/petitioners.ts";
import {
  OPENERS_DIR,
  currentPreroll,
  prerollFile,
  shelvedBreaks,
  usePreroll,
} from "./server/pipeline/preroll.ts";
import { renderCoverSvg } from "./server/pipeline/cover.ts";
import { MOODS, makeLoopBed, type Mood } from "./server/audio/music.ts";
import {
  SHOWS_DIR,
  CURRENT_SHOW_FORMAT,
  listShows,
  readShow,
  saveShow,
  deleteShow,
  makeShowId,
  showDir,
  isSafeId,
  showFiles,
  storageSummary,
  pruneSegments,
  clearScratch,
  type StoredShow,
} from "./server/pipeline/store.ts";
import {
  decodeWav,
  encodeWav,
  durationOf,
  normalize,
  resample,
  trimSilence,
  gain,
  concat,
  silence,
  SAMPLE_RATE,
  type AudioBuffer,
} from "./server/audio/wav.ts";
import { STING_LENGTHS, makeSting } from "./server/audio/stings.ts";
import { applyTone, broadcastVoice } from "./server/audio/effects.ts";
import { groupCommercialBreaks } from "./shared/commercial-rotation.ts";
import { jobIdProblem, shouldWarmUpShow } from "./shared/show-job.ts";
import { missingModels } from "./shared/model-preflight.ts";
import { listDrafts, readDraft, removeDraft, saveDraft, type ShowDraft } from "./server/pipeline/drafts.ts";
import {
  BACKUPS_DIR,
  automationStatus,
  clearPlayoutQueue,
  completePlayoutItem,
  createStationBackup,
  enqueueShow,
  fallbackPlayoutItems,
  listStationBackups,
  nextPlayoutItem,
  removeQueuedShow,
  removeScheduleSlot,
  restoreStationBackup,
  startStationAutomation,
  updateAutomationSettings,
  upsertScheduleSlot,
} from "./server/station/automation.ts";


/** The one Piper download the setup screen can start. */
let piperJob: { state: "idle" | "running" | "done" | "failed"; lines: string[]; error?: string } = {
  state: "idle",
  lines: [],
};

const PORT = Number(process.env.PORT ?? 3000);
const isProduction = process.env.NODE_ENV === "production";

/** In-flight generations, so the UI can cancel one. */
/** When this process compiled the source it is running. */
const BOOTED_AT = Date.now();

const running = new Map<string, AbortController>();

/**
 * Lines the listener has phoned in, waiting to go on air. The conversation
 * loop drains this between turns, so a call joins at a natural gap rather
 * than interrupting a host mid-sentence.
 */
const callQueues = new Map<string, Array<{ name: string; text: string }>>();

/** Where the shelved opening commercial sits, well clear of the planned breaks. */
const PREROLL_BREAK_INDEX = 900;

/**
 * What each running show is about, so a call can be written into the phone
 * book against the subject the caller actually rang about.
 */
const jobTopics = new Map<string, string>();

/**
 * Drop live-clip folders from previous runs. The current job is kept so its
 * audio stays playable, and anything under an hour old is left alone in case a
 * second tab is still listening to it.
 */
function cleanLiveDirs(keepJobId: string): void {
  const liveRoot = path.join(process.cwd(), "output", "live");
  if (!fs.existsSync(liveRoot)) return;

  const cutoff = Date.now() - 60 * 60 * 1000;

  for (const entry of fs.readdirSync(liveRoot)) {
    if (entry === keepJobId) continue;
    const dir = path.join(liveRoot, entry);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // A folder disappearing under us is fine.
    }
  }
}

type ChannelMode = "all" | "station" | "realm" | "multiverse";

function channelMode(value: unknown): ChannelMode {
  return value === "station" || value === "realm" || value === "multiverse" ? value : "all";
}

function preferredSource(value: unknown): Brief["source"] | undefined {
  return value === "station" || value === "realm" || value === "multiverse" ? value : undefined;
}

function djBumperLines(config: Config, spot: { sponsor: string; source: string }, seed: number, mode: ChannelMode): string[] {
  const sponsor = spot.sponsor || "that place";
  const station = config.show.station;

  const stationLines = [
    [`That was ${sponsor}, still legally a business as of this recording.`, "I respect any advert that raises more questions than it answers."],
    [`${sponsor} there, proving a coupon can be a threat if you print it confidently enough.`, "Somebody initialed the paperwork. That is the part I cannot get past."],
    [`We asked ${sponsor} for clarification and got a fax that was warm to the touch.`, "So that's a no on clarification."],
    [`You are listening to ${station}, where the adverts arrive with their own weather.`, "Do not look directly at the sale price."],
  ];

  const realmLines = [
    [`The crier for ${sponsor} has paid in coin and panic, so the court has heard them.`, "A surprisingly common tariff."],
    [`${sponsor} serves the realm, technically, depending on who survives the receipt.`, "The King will decide if that counts as service."],
    [`That was ${sponsor}. If you heard your name in the small print, report to the gate.`, "Bring witnesses, but not optimistic ones."],
    [`A message from ${sponsor}, approved by nobody brave enough to sign it.`, "The seal was mostly wax and bad news."],
  ];

  const multiverseLines = [
    [`${sponsor}. Open weekdays, alternate Thursdays, and one Tuesday that has not happened yet.`, "I hate that the financing sounded reasonable."],
    [`That was ${sponsor}, broadcasting from a branch office behind a branch office.`, "Their parking validation is a full moral philosophy."],
    [`We are required to say ${sponsor} is not a portal.`, "We are not required to sound convinced."],
    [`${sponsor}: for listeners who looked at reality and asked if it came with a cheaper plan.`, "It does, but the deductible remembers you."],
  ];

  const pool = mode === "realm" || spot.source === "realm"
    ? realmLines
    : mode === "multiverse" || spot.source === "multiverse"
      ? multiverseLines
      : stationLines;

  return pool[seed % pool.length];
}

async function renderDjBumper(config: Config, spotId: string, seed: number, mode: ChannelMode): Promise<{ path: string; text: string }> {
  const spot = getSpot(spotId);
  if (!spot) throw new Error("That spot is not in the bucket.");

  const cacheDir = path.join(process.cwd(), "commercials", "dj-cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  const voiceKey = [
    config.tts.engine,
    voiceFor(config.hosts[0], config.tts.engine),
    voiceFor(config.hosts[1], config.tts.engine),
    voiceFor(config.orion.king, config.tts.engine),
    voiceFor(config.orion.chronicler, config.tts.engine),
  ].join("|");
  // Version the derived file explicitly. Changing DJ behaviour should never
  // leave yesterday's spoken bumper eligible just because its voices match.
  const id = hashString(`dj-bumper-v2|${spot.id}|${seed}|${mode}|${voiceKey}`).toString(36);
  const outPath = path.join(cacheDir, `dj-${id}.wav`);
  const textPath = path.join(cacheDir, `dj-${id}.txt`);

  if (fs.existsSync(outPath)) {
    const text = fs.existsSync(textPath) ? fs.readFileSync(textPath, "utf8") : "";
    return { path: outPath, text };
  }

  if (config.tts.engine === "none") throw new Error("Speech is turned off.");

  const court = mode === "realm" || spot.source === "realm";
  const first = court ? config.orion.king : config.hosts[0];
  const second = court ? config.orion.chronicler : config.hosts[1];
  const [a, b] = djBumperLines(config, spot, seed, mode);
  const stem = path.join(cacheDir, `dj-${id}`);

  const one = await renderTurnClip(config, first, a, `${stem}-a.wav`);
  const two = await renderTurnClip(config, second, b, `${stem}-b.wav`);
  const bumper = normalize(concat([one, silence(0.12), two]), 0.86);

  fs.writeFileSync(outPath, encodeWav(bumper));
  fs.writeFileSync(textPath, `${a}\n${b}\n`, "utf8");
  return { path: outPath, text: `${a} ${b}` };
}

async function main() {
  const app = express();
  // First of all: refuse a Host that is not this PC (DNS rebinding) and writes from another site (see request-guard.ts).
  app.use(requestGuard);
  app.use(express.json({ limit: "4mb" }));

  fs.mkdirSync(SHOWS_DIR, { recursive: true });
  ensureWorldApiToken();

  /* ── Config ──────────────────────────────────────────────────── */

  app.get("/api/config", (_req, res) => {
    res.json({ config: loadConfig(), configPath, defaults: DEFAULT_CONFIG });
  });

  app.put("/api/config", (req, res) => {
    try {
      res.json({ config: saveConfig(req.body) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/config/reset", (_req, res) => {
    res.json({ config: saveConfig(DEFAULT_CONFIG) });
  });

  /* ── Engine-neutral world contract ───────────────────────────── */

  app.use("/api/world/v1", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    // Pages served from this PC (a browser-based game client) may call the world API; a page from any other
    // site may not even read it. Commands additionally need X-World-Key.
    const requester = req.header("Origin");
    if (isLocalOrigin(requester)) res.setHeader("Access-Control-Allow-Origin", requester!);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Accept, Content-Type, If-None-Match, Idempotency-Key, X-World-Key",
    );
    if (req.method === "OPTIONS") return res.status(204).end();
    const isCommand = req.method === "POST" && (req.path === "/commands" || req.path === "/converse");
    if (req.method !== "GET" && !isCommand) {
      return res.status(405).json({ error: "Only the command and converse endpoints accept world writes." });
    }
    next();
  });

  app.get("/api/world/v1/capabilities", (_req, res) => {
    res.json({
      contract: WORLD_CONTRACT,
      commands: WORLD_COMMAND_TYPES,
      concurrency: "expectedRevision",
      idempotency: "command id",
      authority: "discord_runtime",
      conversation: {
        endpoint: "/api/world/v1/converse",
        enabled: Boolean(loadConfig().orion.converse.projectPath),
        maxLineLength: CONVERSE_MAX_LINE,
      },
    });
  });

  /**
   * Speak with a character at the player's place. Needs the same local world key
   * as commands. It does not move anyone or record a deed; the client sends the
   * ordinary `talk` command for that.
   */
  app.post("/api/world/v1/converse", async (req, res) => {
    if (!isAuthorizedWorldCommand(req.header("X-World-Key"))) {
      return res.status(401).json({ error: "A valid local world key is required.", code: "unauthorized" });
    }
    try {
      return res.json(await converse(loadConfig(), req.body));
    } catch (error) {
      if (error instanceof ConverseError) {
        const retry = error.details?.retryAfterSeconds;
        if (typeof retry === "number") res.setHeader("Retry-After", String(retry));
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      return res.status(500).json({ error: "The conversation failed.", code: "converse_failed" });
    }
  });

  app.post("/api/world/v1/commands", async (req, res) => {
    if (!isAuthorizedWorldCommand(req.header("X-World-Key"))) {
      return res.status(401).json({ error: "A valid local world key is required.", code: "unauthorized" });
    }
    try {
      const command = parseWorldCommand(req.body, req.header("Idempotency-Key") ?? "");
      const config = loadConfig();
      const result = await executeWorldCommand(config.orion.realmPath, command);
      const realm = readRealm(config.orion.realmPath, 200);
      return res.json({ ...result, snapshot: createWorldSnapshot(realm, listShows()) });
    } catch (error) {
      if (error instanceof WorldCommandError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.details ?? {}),
        });
      }
      return res.status(500).json({ error: (error as Error).message, code: "command_failed" });
    }
  });

  app.get("/api/world/v1/health", (_req, res) => {
    const config = loadConfig();
    const realm = readRealm(config.orion.realmPath, 1);
    res.status(realm.root ? 200 : 503).json({
      contract: WORLD_CONTRACT,
      schemaVersion: WORLD_SCHEMA_VERSION,
      connected: Boolean(realm.root),
      campaignId: realm.campaignId,
      revision: realm.runtimeRevision,
      stateSource: realm.stateSource,
      problems: realm.problems,
    });
  });

  app.get("/api/world/v1/snapshot", (req, res) => {
    const config = loadConfig();
    const realm = readRealm(config.orion.realmPath, 200);
    const snapshot = createWorldSnapshot(realm, listShows());
    const latestShow = snapshot.radio.latestShow?.id ?? "";
    const signature = [
      snapshot.campaign.id,
      snapshot.campaign.revision,
      snapshot.cursors.events,
      snapshot.cursors.claims,
      latestShow,
    ].join("|");
    const etag = `W/"world-${hashString(signature).toString(36)}"`;
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) return res.status(304).end();
    res.json(snapshot);
  });

  app.get("/api/world/v1/events", (req, res) => {
    const after = Math.max(0, Math.floor(Number(req.query.after) || 0));
    const limit = Math.max(1, Math.min(200, Math.floor(Number(req.query.limit) || 50)));
    const realm = readRealm(loadConfig().orion.realmPath, 200);
    const events = eventsSince(realm, after).slice(0, limit);
    res.json({
      contract: WORLD_CONTRACT,
      campaignId: realm.campaignId,
      after,
      nextCursor: events.reduce((cursor, event) => Math.max(cursor, event.id), after),
      events,
    });
  });

  app.get("/api/world/v1/claims", (req, res) => {
    const after = Math.max(0, Math.floor(Number(req.query.after) || 0));
    const realm = readRealm(loadConfig().orion.realmPath, 1);
    const claims = claimsSince(realm, after);
    res.json({
      contract: WORLD_CONTRACT,
      campaignId: realm.campaignId,
      after,
      nextCursor: claims.reduce((cursor, claim) => Math.max(cursor, claim.id), after),
      claims,
    });
  });

  /** Options the UI renders as dropdowns, so the lists live in one place. */
  app.get("/api/options", (_req, res) => {
    res.json({
      moods: MOODS,
      styles: [
        { id: "debate", label: "Debate", description: "They disagree and press each other" },
        { id: "interview", label: "Interview", description: "One asks, one answers at length" },
        { id: "roundtable", label: "Roundtable", description: "Relaxed, builds on each point" },
        { id: "banter", label: "Banter", description: "Fast, funny, a little chaotic" },
        { id: "explainer", label: "Explainer", description: "One teaches, one keeps them honest" },
        { id: "coldopen", label: "Cold open", description: "Drops in mid-conversation" },
        { id: "deepdive", label: "Deep dive", description: "Works through source material together" },
      ],
      adStyles: [
        { id: "live_read", label: "Live read", description: "The hosts read the copy, in character" },
        { id: "produced", label: "Produced spot", description: "A separate announcer, like a real advert" },
        { id: "mixed", label: "Mixed", description: "An announcer spot, then a host read" },
      ],
      adSources: [
        { id: "invented", label: "Made-up sponsors", description: "The model invents local businesses" },
        { id: "sponsors", label: "My sponsors only", description: "Only the advertisers you have added" },
        { id: "mixed", label: "Mixed", description: "Yours first, made-up ones to fill the break" },
      ],
      tones: [
        { id: "studio", label: "Studio", description: "Warm, close-mic'd" },
        { id: "phone", label: "Phone-in", description: "Band-limited call-in sound" },
        { id: "room", label: "Room", description: "Slightly distant, remote guest" },
        { id: "throne", label: "Throne", description: "Weighty close royal broadcast" },
        { id: "raw", label: "Raw", description: "No processing" },
      ],
      providers: [
        { id: "lmstudio", label: "LM Studio", baseUrl: defaultBaseUrl("lmstudio") },
        { id: "ollama", label: "Ollama", baseUrl: defaultBaseUrl("ollama") },
        { id: "openai-compatible", label: "OpenAI-compatible", baseUrl: defaultBaseUrl("openai-compatible") },
        { id: "gemini", label: "Gemini (cloud)", baseUrl: defaultBaseUrl("gemini") },
      ],
      // Ready-made pairings. Asymmetric on purpose: two hosts with the same
      // energy talk past each other, and the contrast is what makes it a show.
      hostPresets: [
        {
          id: "djs",
          label: "Drive-time DJs",
          description: "Two working radio DJs. Fast, loose, station patter.",
          hosts: [
            {
              name: "Marco",
              persona:
                "Drive-time radio DJ, fifteen years on air. Big warm energy, talks fast, always working the mic. " +
                "Reads the room, teases what is coming up, throws to his co-host by name. Loves a bit, commits to it fully. " +
                "Talks to the listener directly — 'you', 'we', 'stay with us'.",
              stance: "Sells the fun of it. Wants the segment to move and to land a laugh.",
            },
            {
              name: "Dee",
              persona:
                "Co-host on the drive-time desk. Deadpan, faster than she lets on, the one who punctures her co-host. " +
                "Cuts in with the line the listener is thinking. Dry, never mean. Runs the phones and remembers what callers said.",
              stance: "Keeps it honest. Undercuts hype and calls out anything that sounds rehearsed.",
            },
          ],
        },
        {
          id: "deepdive",
          label: "Deep-dive duo",
          description: "One drives the story, one has the realisations.",
          hosts: [
            {
              name: "Alex",
              persona:
                "The enthusiastic storyteller. Friendly, energetic, relatable. Drives the narrative, introduces each idea, " +
                "and asks the question the listener is already thinking. Reaches for everyday comparisons to make hard things land.",
              stance: "Curious and optimistic. Wants to understand it well enough to explain it to anyone.",
            },
            {
              name: "Wren",
              persona:
                "The calm analyst. Precise, logical, a little eccentric. Supplies the detail and the context, clarifies how " +
                "the pieces connect, and is the one who suddenly sees the implication nobody mentioned.",
              stance: "Rigorous. Will not let a neat story stand if the detail does not support it.",
            },
          ],
        },
        {
          id: "latenight",
          label: "Late-night pair",
          description: "Quieter, wry, after midnight.",
          hosts: [
            {
              name: "Paul",
              persona:
                "Veteran late-night host. Warm, curious, quick with a wry aside. Keeps the show moving and is not afraid " +
                "to push back when an answer is too tidy.",
              stance: "Optimistic about where this is heading, but wants the details to hold up.",
            },
            {
              name: "Rae",
              persona:
                "Sharp co-host. Dry humour, allergic to hype, argues from specifics and lived experience rather than theory.",
              stance: "Sceptical. Looks for the catch, the cost, and who actually pays it.",
            },
          ],
        },
      ],
      qualityPresets: [
        {
          id: "standard",
          label: "Standard",
          description: "22 kHz mono, no processing. Smallest files.",
        },
        {
          id: "high",
          label: "High",
          description: "44.1 kHz stereo, hosts separated, dialogue levelled.",
        },
        {
          id: "studio",
          label: "Studio",
          description: "48 kHz 24-bit stereo, wider, fully levelled.",
        },
      ],
      ttsEngines: [
        { id: "piper", label: "Piper", description: "Neural voices, offline, bundled" },
        { id: "edge", label: "Edge TTS", description: "Best quality, uses Microsoft's servers" },
        { id: "sapi", label: "Windows (built-in)", description: "Basic, always available" },
        { id: "none", label: "No speech", description: "Transcript only, no audio" },
      ],
    });
  });

  /* ── Connection checks ───────────────────────────────────────── */

  app.post("/api/check/llm", async (req, res) => {
    const config = withOverrides(loadConfig(), req.body);
    res.json(await probeLlm(config.llm));
  });

  app.post("/api/check/tts", async (req, res) => {
    const config = withOverrides(loadConfig(), req.body);
    res.json(await probeTts(config.tts));
  });

  /*
   * First-run voice install. The download takes minutes, so it runs as one
   * background job that the setup screen polls; a second request while it is
   * running just reports on the first. Always the default voices: the screen
   * has no reason to choose others, and it keeps names out of the request.
   */
  app.get("/api/setup/piper", (_req, res) => {
    res.json({ ...piperJob, installed: installedPiperVoices(), voices: DEFAULT_PIPER_VOICES });
  });

  app.post("/api/setup/piper", (_req, res) => {
    if (piperJob.state !== "running") {
      piperJob = { state: "running", lines: [], error: undefined };
      const job = piperJob;
      const note = (line: string) => {
        // A percentage replaces the previous percentage for the same file rather than piling up.
        const stem = line.replace(/ … (\d+%|[\d.]+ MB)$/, "");
        const last = job.lines[job.lines.length - 1];
        if (last && last.replace(/ … (\d+%|[\d.]+ MB)$/, "") === stem) job.lines[job.lines.length - 1] = line;
        else job.lines.push(line);
        if (job.lines.length > 40) job.lines.splice(0, job.lines.length - 40);
      };
      installPiper(DEFAULT_PIPER_VOICES, note)
        .then(() => {
          job.state = "done";
        })
        .catch((err: Error) => {
          job.state = "failed";
          job.error = err.message;
        });
    }
    res.status(202).json({ ...piperJob, installed: installedPiperVoices(), voices: DEFAULT_PIPER_VOICES });
  });

  /* ── Podcast ───────────────────────────────────────────────────
   * Turns chosen shows into a folder (MP3s, RSS feed, website) that can be
   * uploaded to any static host. Nothing here goes online by itself.
   */
  const station = () => loadConfig().show.station;

  const podcastState = () => {
    const settings = loadPodcastSettings(station());
    return {
      settings,
      shows: podcastShows(settings),
      job: podcastJob(),
      siteDir: podcastSiteDir(),
      published: fs.existsSync(path.join(podcastSiteDir(), "feed.xml")),
      customCover: Boolean(customCover()),
      categories: PODCAST_CATEGORIES,
      qualities: Object.entries(PODCAST_QUALITY).map(([id, q]) => ({ id, label: q.label })),
    };
  };

  app.get("/api/podcast", (_req, res) => res.json(podcastState()));

  app.put("/api/podcast", (req, res) => {
    savePodcastSettings(req.body, station());
    res.json(podcastState());
  });

  app.get("/api/podcast/job", (_req, res) => res.json(podcastJob()));

  app.post("/api/podcast/publish", (_req, res) => {
    try {
      startPublish(station());
      res.status(202).json(podcastState());
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/podcast/cover", (_req, res) => {
    const cover = coverImage(loadPodcastSettings(station()));
    res.setHeader("Cache-Control", "no-store");
    res.type(cover.type).send(cover.data);
  });

  app.post("/api/podcast/cover", express.raw({ type: ["image/png", "image/jpeg"], limit: "8mb" }), (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "Send a PNG or JPEG image." });
    }
    try {
      res.json({ ...podcastState(), ...saveCustomCover(req.body) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/podcast/cover", (_req, res) => {
    removeCustomCover();
    res.json(podcastState());
  });

  /** Open the folder to upload in the system file browser. */
  app.post("/api/podcast/reveal", (_req, res) => {
    const dir = fs.existsSync(podcastSiteDir()) ? podcastSiteDir() : podcastDir();
    fs.mkdirSync(dir, { recursive: true });
    const command =
      process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    spawn(command, [dir], { detached: true, stdio: "ignore", windowsHide: false }).unref();
    res.json({ ok: true, path: dir });
  });

  /** The built website, exactly as it will look once uploaded. */
  app.use("/podcast-preview", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    express.static(podcastSiteDir(), { index: "index.html", dotfiles: "ignore" })(req, res, next);
  });

  /** One operator-facing view of everything required to put a show on air. */
  app.post("/api/station/status", async (req, res) => {
    const config = withOverrides(loadConfig(), req.body?.config);
    const [model, speech] = await Promise.all([
      probeLlm(config.llm),
      config.tts.engine === "none"
        ? Promise.resolve({ ok: true, voices: [] as Array<{ id: string; label: string }>, error: undefined })
        : probeTts(config.tts),
    ]);
    const storage = storageSummary();
    let freeBytes = 0;
    try {
      const disk = fs.statfsSync(process.cwd());
      freeBytes = Number(disk.bavail) * Number(disk.bsize);
    } catch {
      // The report still works when the filesystem does not expose capacity.
    }
    const brain = activeBrainVersion();
    const commercials = bucketStats(brain.id);
    const commercialAudit = auditBucket();
    const requiredForShow = config.ads.enabled ? config.ads.breaks * config.ads.spotsPerBreak : 0;
    const selectedModels = [
      config.llm.model,
      ...config.hosts.map((host) => host.model),
      ...(config.show.useProducer || config.show.useOutline ? [config.llm.producerModel] : []),
      ...(config.show.generateNotes ? [config.llm.notesModel] : []),
      ...(config.ads.enabled ? [config.llm.commercialModel] : []),
    ].filter(Boolean);
    const unavailable = missingModels(selectedModels, model.models?.map((item) => item.id) ?? []);
    const wordsPerMinute = 155;
    const estimatedSeconds = config.show.turns * Math.max(...config.hosts.map((host) => host.maxWords)) / wordsPerMinute * 60 +
      config.show.turns * config.show.gapSeconds +
      (config.ads.enabled ? config.ads.breaks * (2 + config.ads.spotsPerBreak * (config.ads.spotWords / wordsPerMinute * 60 + 1.3)) : 0) +
      (config.show.useColdOpen ? 13 : 0) +
      (config.show.openingSong.enabled && config.show.openingSong.file ? 210 : 0) +
      config.show.outroSeconds;
    const recentShows = listShows().slice(0, 5).map((show) => ({
      id: show.id,
      title: show.title,
      createdAt: show.createdAt,
      duration: show.duration,
      integratedLufs: show.audioAnalysis?.integratedLufs ?? null,
      truePeakDbtp: show.audioAnalysis?.truePeakDbtp ?? null,
      streamingReady: show.audioAnalysis?.streamingReady ?? null,
    }));

    const checks: Array<{ id: string; label: string; status: "pass" | "warning" | "blocker"; detail: string }> = [
      {
        id: "model",
        label: "Language model",
        status: model.ok && unavailable.length === 0 ? "pass" : "blocker",
        detail: !model.ok ? model.error ?? "LM Studio is unavailable." : unavailable.length ? `Not loaded: ${unavailable.join(", ")}` : `${config.llm.model} is available.`,
      },
      {
        id: "speech",
        label: "DJ voices",
        status: config.tts.engine === "none" ? "warning" : speech.ok ? "pass" : "blocker",
        detail: config.tts.engine === "none" ? "Speech is off; this production will be transcript-only." : speech.ok ? `${speech.voices?.length ?? 0} ${config.tts.engine} voices available.` : speech.error ?? "The speech engine is unavailable.",
      },
      {
        id: "disk",
        label: "Recording storage",
        status: freeBytes > 0 && freeBytes < 5 * 1024 ** 3 ? "blocker" : freeBytes > 0 && freeBytes < 10 * 1024 ** 3 ? "warning" : "pass",
        detail: freeBytes > 0 ? `${(freeBytes / 1024 ** 3).toFixed(1)} GB free; ${(storage.totalBytes / 1024 ** 3).toFixed(1)} GB of finished shows.` : "Free-space reporting is unavailable.",
      },
      {
        id: "running-order",
        label: "Running order",
        status: estimatedSeconds > MAX_MIX_SECONDS ? "blocker" : estimatedSeconds > MAX_MIX_SECONDS * 0.85 ? "warning" : "pass",
        detail: `${Math.round(estimatedSeconds / 60)} minute estimate; the protected mix limit is ${Math.round(MAX_MIX_SECONDS / 60)} minutes.`,
      },
      {
        id: "commercials",
        label: "Commercial rotation",
        status: !config.ads.enabled || commercials.rotation >= requiredForShow ? "pass" : "warning",
        detail: !config.ads.enabled ? "Commercials are off." : `${commercials.rotation} ready for rotation; ${requiredForShow} requested for this show. Missing spots will be written live.`,
      },
      {
        id: "commercial-audit",
        label: "Commercial files",
        status: commercialAudit.ok ? "pass" : commercialAudit.issues.some((issue) => issue.severity === "error") ? "warning" : "warning",
        detail: commercialAudit.ok ? "Bucket index and audio files agree." : `${commercialAudit.issues.length} bucket issue${commercialAudit.issues.length === 1 ? "" : "s"} need attention.`,
      },
      {
        id: "master",
        label: "Recent master",
        status: recentShows[0]?.streamingReady === false ? "warning" : "pass",
        detail: recentShows[0]?.streamingReady === true
          ? `${recentShows[0].integratedLufs?.toFixed(1)} LUFS-I, ${recentShows[0].truePeakDbtp?.toFixed(1)} dBTP.`
          : recentShows[0]?.streamingReady === false
            ? "The most recent measured show needs a level review."
            : "The next show will be the first one saved with LUFS and true-peak measurements.",
      },
      {
        id: "orphans",
        label: "Show folders",
        status: storage.orphaned.length ? "warning" : "pass",
        detail: storage.orphaned.length ? `${storage.orphaned.length} incomplete show folder${storage.orphaned.length === 1 ? " is" : "s are"} preserved for review.` : "No incomplete show folders found.",
      },
    ];

    res.json({
      generatedAt: new Date().toISOString(),
      ready: !checks.some((check) => check.status === "blocker"),
      checks,
      model: { ok: model.ok && unavailable.length === 0, selected: config.llm.model, available: model.models?.map((item) => item.id) ?? [], error: model.error },
      speech: { ok: speech.ok, engine: config.tts.engine, voices: speech.voices?.length ?? 0, error: speech.error },
      // Keep preflight responses small: the operator view only needs a recent
      // sample, while the Files page owns the complete recording inventory.
      storage: { ...storage, shows: storage.shows.slice(0, 5), freeBytes },
      commercials: { total: commercials.total, rotation: commercials.rotation, requiredForShow, issues: commercialAudit.issues.length, auditOk: commercialAudit.ok },
      recentShows,
    });
  });

  /* ── Unattended station automation ─────────────────────────── */

  app.get("/api/automation", (_req, res) => res.json(automationStatus()));

  app.put("/api/automation", (req, res) => {
    try {
      res.json(updateAutomationSettings(req.body ?? {}));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/api/automation/slots", (req, res) => {
    try {
      res.json({ slot: upsertScheduleSlot(req.body ?? {}), status: automationStatus() });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.delete("/api/automation/slots/:id", (req, res) => {
    if (!removeScheduleSlot(req.params.id)) return res.status(404).json({ error: "Schedule slot not found" });
    res.json(automationStatus());
  });

  app.post("/api/playout/queue/:id", (req, res) => {
    try {
      res.json(enqueueShow(req.params.id));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.delete("/api/playout/queue/:id", (req, res) => res.json(removeQueuedShow(req.params.id)));
  app.delete("/api/playout/queue", (_req, res) => res.json(clearPlayoutQueue()));
  app.post("/api/playout/next", (_req, res) => res.json({ item: nextPlayoutItem() }));
  app.post("/api/playout/complete", (_req, res) => res.json(completePlayoutItem()));

  /** A portable playlist for VLC, OBS, or another playout application. */
  app.get("/api/playout/listen.m3u", (req, res) => {
    const status = automationStatus();
    const origin = `${req.protocol}://${req.get("host")}`;
    const scheduled = [...(status.current ? [status.current] : []), ...status.queue];
    const items = scheduled.length ? scheduled : fallbackPlayoutItems();
    const lines = ["#EXTM3U"];
    for (const item of items) {
      lines.push(`#EXTINF:${Math.round(item.duration)},${item.title}`);
      lines.push(`${origin}${item.audioUrl}`);
    }
    res.type("audio/x-mpegurl").send(`${lines.join("\n")}\n`);
  });

  app.get("/api/backups", (_req, res) => res.json({ backups: listStationBackups() }));

  app.post("/api/backups", (req, res) => {
    try {
      const kind = req.body?.kind === "full" ? "full" : "state";
      res.json({ backup: createStationBackup(kind), backups: listStationBackups() });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.post("/api/backups/:id/restore", (req, res) => {
    if (req.body?.confirm !== req.params.id) {
      return res.status(400).json({ error: "Type the backup id exactly to confirm restore." });
    }
    if (running.size > 0) return res.status(409).json({ error: "Wait for the running production to finish before restoring." });
    try {
      res.json({ backup: restoreStationBackup(req.params.id), restartRequired: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/api/backups/reveal", (_req, res) => {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    spawn(command, [BACKUPS_DIR], { detached: true, stdio: "ignore", windowsHide: false }).unref();
    res.json({ ok: true, path: BACKUPS_DIR });
  });

  /** Speak one line so voices can be auditioned without generating a show. */
  app.post("/api/preview-voice", async (req, res) => {
    const config = withOverrides(loadConfig(), req.body?.config);
    const hostIndex = req.body?.hostIndex === 1 ? 1 : 0;
    const host = config.hosts[hostIndex];
    const text =
      typeof req.body?.text === "string" && req.body.text.trim()
        ? req.body.text.trim().slice(0, 400)
        : `This is ${host.name}, live on ${config.show.station}.`;

    if (config.tts.engine === "none") {
      return res.status(400).json({ error: "Speech is turned off. Pick an engine in Settings first." });
    }

    const tmpDir = path.join(process.cwd(), "output", "preview");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `preview-${hostIndex}.wav`);

    try {
      await synthesize(
        { text, voice: voiceFor(host, config.tts.engine), rate: host.rate, outPath: tmpPath },
        config.tts,
      );

      let clip = resample(decodeWav(fs.readFileSync(tmpPath)), SAMPLE_RATE);
      clip = normalize(broadcastVoice(applyTone(trimSilence(clip), host.tone)), 0.89);

      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-store");
      res.send(encodeWav(clip));
    } catch (err) {
      const e = err as TtsError;
      res.status(500).json({ error: e.message, hint: e.hint });
    }
  });

  /* ── Show library ────────────────────────────────────────────── */

  app.get("/api/shows", (_req, res) => {
    res.json(listShows());
  });

  app.get("/api/drafts", (_req, res) => res.json(listDrafts()));

  app.delete("/api/drafts/:id", (req, res) => {
    removeDraft(req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/drafts/:id/recover", (req, res) => {
    const draft = readDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: "That interrupted show draft was not found." });

    let cursor = 0;
    const transcript = draft.turns.map((turn) => {
      const seconds = Math.max(2, turn.text.trim().split(/\s+/).length / 2.6);
      const line = { start: cursor, end: cursor + seconds, speaker: turn.speaker, hostId: turn.hostId, text: turn.text };
      cursor = line.end + 0.3;
      return line;
    });
    const id = makeShowId(draft.topic);
    const show: StoredShow = {
      id,
      title: `${draft.topic} (recovered)`,
      summary: `Recovered ${draft.turns.length} completed turn${draft.turns.length === 1 ? "" : "s"} from an interrupted broadcast.`,
      topic: draft.topic,
      station: draft.station,
      style: draft.style,
      mood: draft.mood,
      createdAt: draft.createdAt,
      duration: Math.max(0, cursor - 0.3),
      hasAudio: false,
      hosts: [],
      outline: [],
      sources: [],
      transcript,
      models: [],
      generationVersion: CURRENT_SHOW_FORMAT,
    };
    saveShow(show);
    removeDraft(draft.id);
    res.json(readShow(id));
  });

  app.get("/api/shows/:id", (req, res) => {
    const show = readShow(req.params.id);
    if (!show) return res.status(404).json({ error: "Show not found" });
    res.json(show);
  });

  app.get("/api/shows/:id/dj-feedback", (req, res) => {
    if (!readShow(req.params.id)) return res.status(404).json({ error: "Show not found" });
    res.json({ feedback: feedbackForShow(req.params.id) });
  });

  app.post("/api/shows/:id/dj-feedback/:lineIndex", (req, res) => {
    const show = readShow(req.params.id);
    if (!show) return res.status(404).json({ error: "Show not found" });

    const lineIndex = Number(req.params.lineIndex);
    const rating = String(req.body?.rating ?? "");
    if (!Number.isInteger(lineIndex) || lineIndex < 0 || (rating !== "keeper" && rating !== "reject")) {
      return res.status(400).json({ error: "Give a valid DJ line and a keeper or reject rating." });
    }

    try {
      const current = loadConfig();
      const lane = show.hosts.some((host) => host.name.toLowerCase() === current.orion.king.name.toLowerCase())
        ? "court"
        : "station";
      res.json({ feedback: rateDjLine(show, lineIndex, rating, req.body?.tags, lane) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/dj/feedback", (_req, res) => {
    res.json({ feedback: listDjFeedback(), readiness: djTrainingReadiness() });
  });

  app.get("/api/dj/training/:split.jsonl", (req, res) => {
    const split = djTrainingSplit();
    const rows = req.params.split === "train" ? split.train : req.params.split === "eval" ? split.evaluation : null;
    if (!rows) return res.status(404).json({ error: "Training split not found" });
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="dj-${req.params.split}.jsonl"`);
    res.send(trainingJsonl(rows));
  });

  app.delete("/api/shows/:id", (req, res) => {
    if (!deleteShow(req.params.id)) return res.status(404).json({ error: "Show not found" });
    res.json({ ok: true });
  });

  /** Audio and cover art. Ids are validated so paths cannot escape ./shows. */
  app.get("/media/:id/:file", (req, res) => {
    const { id, file } = req.params;
    if (!isSafeId(id) || !/^[a-z0-9._-]+$/i.test(file) || file.includes("..")) {
      return res.status(400).send("Bad request");
    }

    if (file === "cover.svg") {
      const show = readShow(id);
      if (!show) return res.status(404).send("Not found");
      res.setHeader("Content-Type", "image/svg+xml");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(renderCoverSvg(show));
    }

    const full = path.join(showDir(id), file);
    if (!path.resolve(full).startsWith(path.resolve(SHOWS_DIR)) || !fs.existsSync(full)) {
      return res.status(404).send("Not found");
    }

    if (file.endsWith(".wav")) res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Accept-Ranges", "bytes");
    res.sendFile(full);
  });

  /**
   * Clips spoken while a show is still being written. They live under
   * output/live/<jobId> until a later run clears them, so playback keeps
   * working after the show is finished and saved.
   */
  app.get("/api/live/:jobId/:file", (req, res) => {
    const { jobId, file } = req.params;
    if (!/^[a-z0-9-]{1,120}$/i.test(jobId)) return res.status(400).send("Bad request");

    const liveRoot = path.join(process.cwd(), "output", "live");

    // Turn clips are addressed by index and zero-padded on disk; the show's
    // furniture — opener, bed, commercial breaks — is addressed by name.
    let name: string;
    if (/^\d{1,4}\.wav$/.test(file)) {
      name = `${String(Number(file.replace(/\.wav$/, ""))).padStart(3, "0")}.wav`;
    } else if (/^(open|bed|break-\d{1,2})\.wav$/.test(file)) {
      name = file;
    } else {
      return res.status(400).send("Bad request");
    }

    const full = path.join(liveRoot, jobId, name);

    if (!path.resolve(full).startsWith(path.resolve(liveRoot)) || !fs.existsSync(full)) {
      return res.status(404).send("Not found");
    }

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(full);
  });

  /* ── Ad breaks ───────────────────────────────────────────────── */

  /** Everything sitting in the ads drop folder, ready to be scheduled. */
  app.get("/api/ads/files", (_req, res) => {
    res.json({ dir: ADS_DIR, files: listAdFiles() });
  });

  /**
   * Add your own spot.
   *
   * Deliberately a raw body rather than multipart: one dependency fewer, and
   * the only thing that ever travels this route is a single audio file.
   */
  app.post(
    "/api/ads/upload",
    express.raw({ type: "*/*", limit: "48mb" }),
    (req, res) => {
      const requested = path.basename(String(req.query.name ?? "")).trim();
      const extension = path.extname(requested).toLowerCase();

      if (!requested || ![".wav", ".mp3"].includes(extension)) {
        return res.status(400).json({ error: "Only .wav and .mp3 files can be used as spots." });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: "The file was empty." });
      }

      // Strip anything that is not obviously safe in a filename, then keep the
      // extension we already validated.
      const safe = `${requested.slice(0, -extension.length).replace(/[^a-z0-9 ._-]/gi, "_").slice(0, 80) || "spot"}${extension}`;

      fs.mkdirSync(ADS_DIR, { recursive: true });
      const full = path.join(ADS_DIR, safe);

      if (!path.resolve(full).startsWith(path.resolve(ADS_DIR))) {
        return res.status(400).json({ error: "Bad filename." });
      }

      fs.writeFileSync(full, req.body);
      res.json({ name: safe, bytes: req.body.length, files: listAdFiles() });
    },
  );

  /** Play one of your own spots back, so it can be checked before it airs. */
  app.get("/api/ads/file/:name", (req, res) => {
    const full = resolveAdFile(req.params.name);
    if (!full) return res.status(404).send("Not found");

    res.setHeader("Content-Type", full.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/wav");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(full);
  });

  app.delete("/api/ads/files/:name", (req, res) => {
    const full = resolveAdFile(req.params.name);
    if (!full) return res.status(404).json({ error: "No such file." });
    fs.rmSync(full, { force: true });
    res.json({ ok: true, files: listAdFiles() });
  });

  /* ── The music folder ─────────────────────────────────────────── */

  app.get("/api/music/files", (_req, res) => {
    res.json({ dir: MUSIC_DIR, files: listSongFiles() });
  });

  /** Same raw-body upload as the ads folder, for the same reason. */
  app.post("/api/music/upload", express.raw({ type: "*/*", limit: "96mb" }), (req, res) => {
    const requested = path.basename(String(req.query.name ?? "")).trim();
    const extension = path.extname(requested).toLowerCase();

    if (!requested || ![".mp3", ".wav"].includes(extension)) {
      return res.status(400).json({ error: "Only .mp3 and .wav files can be played as records." });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "The file was empty." });
    }

    const safe = `${requested.slice(0, -extension.length).replace(/[^a-z0-9 ._-]/gi, "_").slice(0, 80) || "song"}${extension}`;

    fs.mkdirSync(MUSIC_DIR, { recursive: true });
    const full = path.join(MUSIC_DIR, safe);

    if (!path.resolve(full).startsWith(path.resolve(MUSIC_DIR))) {
      return res.status(400).json({ error: "Bad filename." });
    }

    fs.writeFileSync(full, req.body);
    res.json({ name: safe, bytes: req.body.length, files: listSongFiles() });
  });

  /**
   * The record itself, streamed to the browser during the show.
   *
   * `sendFile` honours Range, which matters here in a way it does not for a
   * ten-second spot: the listener can scrub a four-minute song.
   */
  app.get("/api/music/file/:name", (req, res) => {
    const full = resolveSongFile(req.params.name);
    if (!full) return res.status(404).send("Not found");

    res.setHeader("Content-Type", full.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/wav");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(full);
  });

  app.delete("/api/music/files/:name", (req, res) => {
    const full = resolveSongFile(req.params.name);
    if (!full) return res.status(404).json({ error: "No such file." });
    fs.rmSync(full, { force: true });
    res.json({ ok: true, files: listSongFiles() });
  });

  app.post("/api/music/reveal", (_req, res) => {
    fs.mkdirSync(MUSIC_DIR, { recursive: true });
    const command =
      process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    spawn(command, [MUSIC_DIR], { detached: true, stdio: "ignore", windowsHide: false }).unref();
    res.json({ ok: true, path: MUSIC_DIR });
  });

  app.post("/api/ads/reveal", (_req, res) => {
    fs.mkdirSync(ADS_DIR, { recursive: true });
    const command =
      process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    spawn(command, [ADS_DIR], { detached: true, stdio: "ignore", windowsHide: false }).unref();
    res.json({ ok: true, path: ADS_DIR });
  });

  /**
   * Build one break and send it back, so a break can be auditioned without
   * committing to a whole show.
   */
  app.post("/api/ads/preview", async (req, res) => {
    const config = withOverrides(loadConfig(), req.body?.config);
    const topic = String(req.body?.topic ?? "").trim() || "tonight's show";

    if (config.tts.engine === "none") {
      return res.status(400).json({ error: "Speech is turned off. Pick an engine in Settings first." });
    }

    const dir = path.join(process.cwd(), "output", "preview");
    fs.mkdirSync(dir, { recursive: true });

    try {
      // One break's worth, whatever the show is configured to run.
      const planned = await planBreaks({ ...config, ads: { ...config.ads, breaks: 1 } }, topic);
      if (planned.length === 0) {
        return res.status(400).json({ error: "Nothing to advertise — add a sponsor or turn made-up sponsors on." });
      }

      const outPath = path.join(dir, "break.wav");
      const audio = await renderBreak(config, planned[0], outPath, Date.now() & 0xffff);

      if (durationOf(audio) < 0.5) {
        return res.status(500).json({ error: "The break came back empty." });
      }

      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Break-Label", encodeURIComponent(describeBreak(planned[0])));
      res.send(fs.readFileSync(outPath));
    } catch (err) {
      const e = err as TtsError;
      res.status(500).json({ error: e.message, hint: e.hint });
    }
  });

  /** Audition the station opener on its own. */
  app.post("/api/ads/preview-open", async (req, res) => {
    const config = withOverrides(loadConfig(), req.body?.config);
    const topic = String(req.body?.topic ?? "").trim() || "tonight's show";

    if (config.tts.engine === "none") {
      return res.status(400).json({ error: "Speech is turned off. Pick an engine in Settings first." });
    }

    const outPath = path.join(process.cwd(), "output", "preview", "open.wav");

    try {
      const audio = await renderColdOpen(config, topic, outPath);
      if (!audio) return res.status(500).json({ error: "The opener could not be built." });

      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-store");
      res.send(fs.readFileSync(outPath));
    } catch (err) {
      const e = err as TtsError;
      res.status(500).json({ error: e.message, hint: e.hint });
    }
  });

  /* ── Long-term memory ────────────────────────────────────────── */

  app.get("/api/memory", (_req, res) => {
    res.json(memoryStats());
  });

  /** Re-read every show into the memory index. */
  app.post("/api/memory/rebuild", async (_req, res) => {
    try {
      res.json(await buildIndex(loadConfig(), true));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/memory/clear", (_req, res) => {
    clearIndex();
    res.json({ ok: true });
  });

  /** Try a recall query without generating a show, to see what memory holds. */
  app.post("/api/memory/search", async (req, res) => {
    const query = String(req.body?.query ?? "").trim();
    if (!query) return res.status(400).json({ error: "Give it something to look for." });

    try {
      const config = withOverrides(loadConfig(), req.body?.config);
      await buildIndex(config);
      res.json({ results: await recall(config, query, 6) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /* ── Files ───────────────────────────────────────────────────── */

  app.get("/api/storage", (_req, res) => {
    res.json(storageSummary());
  });

  app.get("/api/shows/:id/files", (req, res) => {
    const files = showFiles(req.params.id);
    if (!files) return res.status(404).json({ error: "Show not found" });
    res.json(files);
  });

  /** Drop the per-turn clips, keeping the finished mix. */
  app.post("/api/shows/:id/prune", (req, res) => {
    if (!readShow(req.params.id)) return res.status(404).json({ error: "Show not found" });
    res.json({ freedBytes: pruneSegments(req.params.id) });
  });

  app.post("/api/storage/clear-scratch", (_req, res) => {
    res.json({ freedBytes: clearScratch() });
  });

  /** Open a show's folder in the system file browser. */
  app.post("/api/shows/:id/reveal", (req, res) => {
    const id = req.params.id;
    if (!isSafeId(id) || !readShow(id)) return res.status(404).json({ error: "Show not found" });

    const dir = showDir(id);
    const command =
      process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";

    // explorer.exe returns a non-zero exit code even on success, so the result
    // is deliberately not checked.
    spawn(command, [dir], { detached: true, stdio: "ignore", windowsHide: false }).unref();
    res.json({ ok: true, path: dir });
  });

  /** Serve any file inside a show folder, for previewing segments. */
  app.get("/api/shows/:id/file/*", (req, res) => {
    const id = req.params.id;
    const rel = String((req.params as Record<string, string>)[0] ?? "");

    if (!isSafeId(id) || rel.includes("..")) return res.status(400).send("Bad request");

    const full = path.join(showDir(id), rel);
    if (!path.resolve(full).startsWith(path.resolve(showDir(id))) || !fs.existsSync(full)) {
      return res.status(404).send("Not found");
    }

    if (full.endsWith(".wav")) res.setHeader("Content-Type", "audio/wav");
    if (full.endsWith(".json")) res.setHeader("Content-Type", "application/json");
    res.setHeader("Accept-Ranges", "bytes");
    res.sendFile(full);
  });

  /** Download the transcript as plain text. */
  app.get("/api/shows/:id/transcript.txt", (req, res) => {
    const show = readShow(req.params.id);
    if (!show) return res.status(404).send("Not found");

    const body = [
      show.title,
      show.station,
      show.createdAt.slice(0, 10),
      "",
      show.summary,
      "",
      ...show.transcript.map((l) => `[${formatTime(l.start)}] ${l.speaker}: ${l.text}`),
    ].join("\n");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${show.id}.txt"`);
    res.send(body);
  });

  /* ── The commercial shelf ─────────────────────────────── */

  /** Finished spots kept for reuse on later shows. */
  app.get("/api/ads/library", (_req, res) => {
    res.json({ spots: listLibrary() });
  });

  /** Play one back, to hear what is on the shelf. */
  app.get("/api/ads/library/:id.wav", (req, res) => {
    const id = String(req.params.id ?? "");
    if (!/^[a-z0-9-]{1,64}$/i.test(id)) return res.status(400).end();

    const file = audioPathFor(id);
    if (!fs.existsSync(file)) return res.status(404).end();

    res.setHeader("Content-Type", "audio/wav");
    fs.createReadStream(file).pipe(res);
  });

  /** Drop one spot, or clear the shelf so everything is written fresh again. */
  app.delete("/api/ads/library", (req, res) => {
    const id = String(req.query?.id ?? "").trim();
    forgetLibrarySpot(id || undefined);
    res.json({ ok: true, spots: listLibrary() });
  });

  /* ── The commercial bucket ────────────────────────────── */

  /** Everything in the bucket, newest first, plus what it adds up to. */
  app.get("/api/commercials", (_req, res) => {
    res.json({ spots: listBucket(), stats: bucketStats(activeBrainVersion().id) });
  });

  /** A control-room snapshot. Probing providers is opt-in because LM Studio may be closed. */
  app.get("/api/control-room", async (req, res) => {
    const config = loadConfig();
    const audit = auditBucket();
    const probe = String(req.query.probe ?? "") === "1";
    const llm = probe ? await probeLlm(config.llm) : null;
    const tts = probe ? await probeTts(config.tts) : null;

    res.json({
      generatedAt: new Date().toISOString(),
      lmStudioNote: probe
        ? "Provider probes were attempted."
        : "Provider probes skipped. Add ?probe=1 to test LM Studio/TTS reachability.",
      model: {
        provider: config.llm.provider,
        baseUrl: defaultBaseUrl(config.llm.provider) === config.llm.baseUrl ? config.llm.baseUrl : config.llm.baseUrl,
        selected: config.llm.model,
        queue: queueStats(),
        probe: llm,
      },
      tts: {
        engine: config.tts.engine,
        voice: config.ads.announcer.voices[config.tts.engine] ?? "",
        probe: tts,
      },
      bucket: {
        stats: bucketStats(activeBrainVersion().id),
        audit,
        recentAttempts: commercialHistory(8),
      },
      notes: [
        "Model-designed copy requires LM Studio or another configured model server.",
        "Prompt preview, bucket audit, tagging, rotation, brain edits and offline tests do not require LM Studio.",
      ],
    });
  });

  /** The commercial brain plus recent generation attempts. */
  app.get("/api/commercials/brain", (_req, res) => {
    const config = loadConfig();
    res.json({
      brain: commercialBrain(config),
      history: commercialHistory(12),
      tests: runBrainTests(config),
      dryRun: dryRunCommercial(config),
    });
  });

  /** Save or create a commercial brain version, then make it active. */
  app.post("/api/commercials/brain", (req, res) => {
    const version = saveCommercialBrain(req.body ?? {});
    const config = loadConfig();
    res.json({ version, brain: commercialBrain(config), tests: runBrainTests(config), dryRun: dryRunCommercial(config) });
  });

  app.post("/api/commercials/brain/activate", (req, res) => {
    const version = activateCommercialBrain(String(req.body?.id ?? ""));
    const config = loadConfig();
    res.json({ version, brain: commercialBrain(config), tests: runBrainTests(config), dryRun: dryRunCommercial(config) });
  });

  /** Preview the exact prompt without calling the model or rendering audio. */
  app.post("/api/commercials/dry-run", (req, res) => {
    const config = withOverrides(loadConfig(), req.body?.config);
    const source = preferredSource(req.body?.source);
    const inspiration = typeof req.body?.inspirationId === "string" ? getSpot(req.body.inspirationId) : null;
    res.json(dryRunCommercial(config, { source, inspiration: inspiration ?? undefined }));
  });

  app.get("/api/commercials/brain/tests", (_req, res) => {
    res.json({ tests: runBrainTests(loadConfig()) });
  });

  /** Check the bucket's index and audio files without changing anything. */
  app.get("/api/commercials/audit", (_req, res) => {
    res.json(auditBucket());
  });

  /** Re-render repairable bucket entries from their saved copy. Nothing is deleted here. */
  app.post("/api/commercials/repair", async (_req, res) => {
    const config = loadConfig();
    if (config.tts.engine === "none") {
      return res.status(400).json({ error: "Speech is turned off. Pick a voice engine before repairing commercials." });
    }

    const issues = auditBucket().issues.filter((issue) => issue.repairable);
    const ids = Array.from(new Set(issues.map((issue) => issue.id))).slice(0, 20);
    let repaired = 0;
    let error = "";

    for (const id of ids) {
      const spot = getSpot(id);
      if (!spot || !spot.text || path.basename(spot.file) !== spot.file) continue;
      try {
        const text = tidy(spot.text);
        const brk = {
          index: 0,
          spots: [{ kind: "produced" as const, sponsor: spot.sponsor, lines: [{ voice: "announcer" as const, text }] }],
        };
        const audio = await renderBreak(
          config,
          brk,
          path.join(BUCKET_DIR, spot.file),
          Date.now() + repaired,
          undefined,
          { shelve: false },
        );
        updateSpot(spot.id, { text, seconds: Number(durationOf(audio).toFixed(2)) });
        repaired += 1;
      } catch (err) {
        error = (err as Error).message;
        break;
      }
    }

    const audit = auditBucket();
    res.status(error && repaired === 0 ? 500 : 200).json({
      repaired,
      error,
      audit,
      spots: listBucket(),
      stats: bucketStats(activeBrainVersion().id),
    });
  });

  /**
   * Make the channel fresher without leaving the tab.
   *
   * This is deliberately small. A couple of spots at a time keeps the channel
   * alive while it plays, and background priority means a real show can still
   * jump the queue if one is running.
   */
  app.post("/api/commercials/freshen", async (req, res) => {
    const config = withOverrides(loadConfig(), req.body?.config);
    const count = Math.max(1, Math.min(5, Math.round(Number(req.body?.count) || 1)));
    const source = preferredSource(req.body?.source);
    const inspiration = typeof req.body?.inspirationId === "string" ? getSpot(req.body.inspirationId) : null;

    if (config.tts.engine === "none") {
      return res.status(400).json({ error: "Speech is turned off. Pick a voice engine before making commercials." });
    }

    const made = [];
    let error = "";

    for (let i = 0; i < count; i++) {
      try {
        made.push(
          await writeSpot(config, listBucket().length + i, {
            background: true,
            source,
            inspiration: inspiration ?? undefined,
          }),
        );
      } catch (err) {
        error = (err as Error).message;
        break;
      }
    }

    const ok = made.length > 0 || !error;
    res.status(ok ? 200 : 500).json({
      made,
      error,
      spots: listBucket(),
      stats: bucketStats(activeBrainVersion().id),
    });
  });

  /**
   * A station ident, for between spots on the channel.
   *
   * Procedural, so it costs nothing and needs neither a model nor a speech
   * engine. Seeded by the index the channel asks for, so consecutive idents
   * are not identical and the channel does not develop a tic.
   */
  app.get("/api/commercials/ident/:seed", (req, res) => {
    const seed = Math.abs(Number(req.params.seed) || 1);
    const sting = normalize(makeSting("ident", STING_LENGTHS.ident, seed), 0.82);
    res.type("audio/wav").send(encodeWav(sting));
  });

  /** Two short host lines reacting to the spot that just aired. Cached on disk. */
  app.get("/api/commercials/dj/:seed/:id", async (req, res) => {
    const seed = Math.abs(Number(req.params.seed) || 1);
    const mode = channelMode(req.query.mode);

    try {
      const bumper = await renderDjBumper(loadConfig(), String(req.params.id), seed, mode);
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Bumper-Text", encodeURIComponent(bumper.text));
      res.sendFile(bumper.path);
    } catch {
      const sting = normalize(makeSting("ident", STING_LENGTHS.ident, seed), 0.82);
      res.type("audio/wav").send(encodeWav(sting));
    }
  });

  /** One spot's audio. */
  app.get("/api/commercials/:id/audio", (req, res) => {
    const full = audioFor(String(req.params.id));
    if (!full) return res.status(404).json({ error: "That spot's audio is not there." });
    res.setHeader("Cache-Control", "no-store");
    res.type("audio/wav").sendFile(full);
  });

  /** Note that one went out, so the least-played come round first. */
  app.post("/api/commercials/:id/played", (req, res) => {
    markBucketPlayed(String(req.params.id));
    res.json({ ok: true });
  });

  /** Star or unstar. A starred spot cannot be deleted. */
  app.post("/api/commercials/:id/keep", (req, res) => {
    const spot = setKeep(String(req.params.id), Boolean(req.body?.keep));
    if (!spot) return res.status(404).json({ error: "That spot is not in the bucket." });
    res.json({ spot });
  });

  /** Include or remove a spot from automatic rotation without deleting it. */
  app.post("/api/commercials/:id/rotation", (req, res) => {
    const spot = setRotation(String(req.params.id), Boolean(req.body?.rotation));
    if (!spot) return res.status(404).json({ error: "That spot is not in the bucket." });
    res.json({ spot, spots: listBucket(), stats: bucketStats(activeBrainVersion().id) });
  });

  /** Rating and workflow tags: keeper, too-normal, great-premise, bad-voice, quarantine. */
  app.post("/api/commercials/:id/tags", (req, res) => {
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : [];
    const spot = setTags(String(req.params.id), tags);
    if (!spot) return res.status(404).json({ error: "That spot is not in the bucket." });
    res.json({ spot, spots: listBucket(), stats: bucketStats(activeBrainVersion().id) });
  });

  /**
   * Delete one, deliberately, by id.
   *
   * There is no route that empties the bucket, and nothing anywhere trims it
   * by age or size. That is the point of it: the adverts are the collection,
   * not a cache.
   */
  app.delete("/api/commercials/:id", (req, res) => {
    const result = removeSpot(String(req.params.id));
    if (!result.removed) return res.status(409).json({ error: result.reason });
    res.json({ ok: true });
  });

  /* ── King Orion's Realm ───────────────────────────────── */

  /** The brain, as the King would be given it. Read-only. */
  app.get("/api/orion", (_req, res) => {
    const config = loadConfig();
    const realm = readRealm(config.orion.realmPath, config.orion.recallEvents);

    res.json({
      found: Boolean(realm.root),
      root: realm.root,
      summary: realmSummary(realm),
      problems: realm.problems,
      save: realm.save,
      guild: realm.guild,
      events: realm.events,
      quests: realm.quests,
      npcs: realm.npcs,
      locations: realm.locations,
      claims: realm.claims,
      campaignId: realm.campaignId,
      stateSource: realm.stateSource,
      // Exactly what would go into his prompt, so it can be read rather than
      // taken on trust.
      briefing: buildRealmBriefing(realm, config.orion.lore),
    });
  });

  /** Readiness and downloadable data for a future King/Maeve LoRA. */
  app.get("/api/orion/training", (_req, res) => {
    res.json({ readiness: orionTrainingReadiness() });
  });

  app.get("/api/orion/training/:split.jsonl", (req, res) => {
    const split = orionTrainingSplit();
    const rows = req.params.split === "train" ? split.train : req.params.split === "eval" ? split.evaluation : null;
    if (!rows) return res.status(404).json({ error: "Training split not found" });
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="orion-${req.params.split}.jsonl"`);
    res.send(trainingJsonl(rows));
  });

  /** Take a broadcast back out of the game's chronicle. */
  app.delete("/api/orion/chronicle", (req, res) => {
    const config = loadConfig();
    const ids = String(req.query?.ids ?? "")
      .split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (ids.length === 0) return res.status(400).json({ error: "Which events? Pass ids=1,2,3." });

    const result = forgetTales(config.orion.realmPath, ids);
    if (result.error) return res.status(500).json({ error: result.error });
    res.json({ removed: result.written });
  });

  /* ── Running bits ─────────────────────────────────────── */

  /** What each show has going, carried between episodes. */
  app.get("/api/running", (_req, res) => {
    const config = loadConfig();
    const lane = laneFor(config.show.station, config.orion.enabled ? config.orion.king.name : undefined);
    res.json({ lane, lanes: listLanes(), briefing: runningBriefing(lane, config.orion.enabled) });
  });

  /** Forget one lane, or all of them, and start the history again. */
  app.delete("/api/running", (req, res) => {
    const lane = String(req.query?.lane ?? "").trim();
    forgetRunning(lane || undefined);
    res.json({ ok: true, lanes: listLanes() });
  });

  /* ── The phone book ──────────────────────────── */

  /** Who has called this station, across every show it has ever run. */
  app.get("/api/callers", (_req, res) => {
    res.json({ callers: listCallers(), briefing: callerBriefing() });
  });

  /** Forget one caller, or clear the book entirely. */
  app.delete("/api/callers", (req, res) => {
    const name = String(req.query?.name ?? "").trim();
    forgetCaller(name || undefined);
    res.json({ ok: true, callers: listCallers() });
  });

  /* ── Generation ──────────────────────────────────────────────── */

  /** Put a listener on air in a running show. */
  app.post("/api/call-in/:id", (req, res) => {
    const jobId = req.params.id;
    if (!running.has(jobId)) {
      return res.status(404).json({ error: "No show is running to call into." });
    }

    const text = String(req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "Say something first." });

    const name = String(req.body?.name ?? "").trim().slice(0, 40);
    const queue = callQueues.get(jobId) ?? [];
    queue.push({ name, text: text.slice(0, 1200) });
    callQueues.set(jobId, queue);

    // Into the phone book, so the hosts know this voice on future shows.
    // Named callers only: "Caller" is a placeholder, not a person.
    rememberCall({
      name,
      text,
      topic: jobTopics.get(jobId),
      anonymous: loadConfig().caller.name,
    });

    res.json({ queued: queue.length, known: findCaller(name)?.calls ?? 0 });
  });

  app.post("/api/cancel/:id", (req, res) => {
    const controller = running.get(req.params.id);
    if (!controller) return res.status(404).json({ error: "Nothing running with that id" });
    controller.abort();
    running.delete(req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/generate", async (req, res) => {
    const resumeDraftId = String(req.body?.resumeDraftId ?? "").trim();
    const resumeDraft = resumeDraftId ? readDraft(resumeDraftId) : null;
    if (resumeDraftId && !resumeDraft) {
      return res.status(404).json({ error: "That interrupted broadcast is no longer available." });
    }
    const topic = (resumeDraft?.topic ?? String(req.body?.topic ?? "")).trim();
    const jobId = String(req.body?.jobId ?? "").trim() || makeShowId("job");
    let config: Config = resumeDraft?.config ?? withOverrides(loadConfig(), req.body?.config);
    const researchSources: string[] = Array.isArray(req.body?.sources)
      ? req.body.sources.map((s: unknown) => String(s)).slice(0, 10)
      : [];
    // Pasted or uploaded material for the producer to find an angle in.
    const sourceText = String(req.body?.sourceText ?? "").slice(0, 200_000);

    if (!topic) {
      return res.status(400).json({ error: "Give the show a topic." });
    }
    // Reject an impossible running order before the model writes a word. This
    // is deliberately conservative; real turns are often shorter, but a show
    // must never spend an hour generating only to fail at the final mix.
    const wordsPerMinute = 155;
    const spokenSeconds = config.show.turns * Math.max(...config.hosts.map((host) => host.maxWords)) / wordsPerMinute * 60;
    const breakSeconds = config.ads.enabled
      ? config.ads.breaks * (2 + config.ads.spotsPerBreak * (config.ads.spotWords / wordsPerMinute * 60 + 1.3))
      : 0;
    const estimatedSeconds = spokenSeconds + config.show.turns * config.show.gapSeconds + breakSeconds +
      (config.show.useColdOpen ? 13 : 0) + (config.show.openingSong.enabled && config.show.openingSong.file ? 210 : 0) +
      config.show.outroSeconds;
    if (estimatedSeconds > MAX_MIX_SECONDS) {
      return res.status(400).json({
        error: `This running order is estimated at ${Math.round(estimatedSeconds / 60)} minutes; the safe episode limit is ${Math.round(MAX_MIX_SECONDS / 60)} minutes.`,
        hint: "Reduce turns or commercial load, or record it as two episodes.",
      });
    }
    const jobProblem = jobIdProblem(jobId, new Set(running.keys()));
    if (jobProblem) return res.status(running.has(jobId) ? 409 : 400).json({ error: jobProblem });

    // LM Studio exposes the model it can currently serve. Catch a stale saved
    // id before opening an SSE stream and before the listener waits through
    // imaging for a request that can only return 404.
    if (config.llm.provider === "lmstudio") {
      const check = await probeLlm(config.llm);
      if (!check.ok) {
        return res.status(503).json({
          error: check.error ?? "LM Studio is not available.",
          hint: check.hint,
        });
      }

      const configuredModels = [
        config.llm.model,
        ...config.hosts.map((host) => host.model),
        ...(config.show.useProducer || config.show.useOutline ? [config.llm.producerModel] : []),
        ...(config.show.generateNotes ? [config.llm.notesModel] : []),
        ...(config.ads.enabled ? [config.llm.commercialModel] : []),
      ];
      const missing = missingModels(configuredModels, check.models.map((model) => model.id));
      if (missing.length > 0) {
        const available = check.models.map((model) => model.id).join(", ") || "none";
        return res.status(409).json({
          error: `The selected model is not loaded: ${missing.join(", ")}.`,
          hint: `LM Studio currently offers: ${available}. Open Settings, refresh the model list, and choose one of those models.`,
        });
      }
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: Record<string, unknown>) => {
      // The browser can go away mid-show - a reload, a closed tab, a machine
      // going to sleep - and writing to the socket it left behind throws. That
      // throw unwinds the pipeline from inside a turn callback and takes the
      // whole show down, for no better reason than that nobody is watching.
      // The episode is being recorded to disk either way, so let it finish.
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Nothing to do, and nobody left to report it to.
      }
    };

    // Proxies drop idle SSE connections; a comment ping keeps them open.
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(": ping\n\n");
      } catch {
        /* the listener has gone; the recording has not */
      }
    }, 15000);

    const controller = new AbortController();
    running.set(jobId, controller);
    jobTopics.set(jobId, topic);
    const { signal } = controller;

    req.on("close", () => clearInterval(heartbeat));

    const started = Date.now();
    const timing = (phase: string, milliseconds: number, extra: Record<string, number | boolean> = {}) => {
      send({ type: "timing", phase, milliseconds: Math.max(0, Math.round(milliseconds)), ...extra });
    };

    // Everything the show plays that is not dialogue lives here, alongside the
    // live turn clips.
    const liveDir = path.join(process.cwd(), "output", "live", jobId);
    const speakLive = config.show.speakWhileWriting && config.tts.engine !== "none";

    try {
      send({ type: "started", jobId });

      if (speakLive) {
        cleanLiveDirs(jobId);
        fs.mkdirSync(liveDir, { recursive: true });
      }

      // ── King Orion's Realm.
      //
      // Read before the station's own memory is touched, because when he is on
      // it replaces it. He is a guest with his own world: the chronicle and the
      // save are all he knows, and none of the station's past reaches him.
      let realmBriefing = "";
      let realm: Realm = EMPTY_REALM;

      if (config.orion.enabled) {
        realm = readRealm(config.orion.realmPath, config.orion.recallEvents);

        for (const problem of realm.problems) send({ type: "info", message: problem });

        if (realm.root) {
          realmBriefing = [
            buildRealmBriefing(realm, config.orion.lore),
            courtBroadcastMemory(config.orion.king.name, config.orion.chronicler.name, topic),
          ].filter(Boolean).join("\n\n");

          // Give the two speaker slots to the King and his chronicler. Doing it
          // here, once, means every stage downstream — synthesis, the mix, the
          // transcript, the cover — uses their names and voices without a
          // single one of them needing to know Orion exists.
          const { king, chronicler } = config.orion;
          config = {
            ...config,
            // Whatever the station's music is set to, a hall is dark. Rock
            // under a king taking counsel is the station leaking back in.
            show: { ...config.show, mood: "noir" },
            hosts: [
              {
                ...config.hosts[0],
                name: king.name,
                voices: king.voices,
                tone: king.tone,
                rate: king.rate,
                temperature: config.orion.temperature,
                maxWords: king.maxWords,
              },
              {
                ...config.hosts[1],
                name: chronicler.name,
                voices: chronicler.voices,
                tone: chronicler.tone,
                rate: chronicler.rate,
                temperature: config.orion.temperature,
                maxWords: chronicler.maxWords,
              },
            ],
          };

          send({
            type: "info",
            message: `King Orion's court — ${realmSummary(realm)}.`,
          });
          send({ type: "realm", realm: { summary: realmSummary(realm), root: realm.root, events: realm.events.length } });
        } else {
          send({
            type: "info",
            message: "Orion is switched on but his realm was not found, so tonight is an ordinary show.",
          });
        }
      }

      // ── The cold open and the bed.
      //
      // Neither needs the model, so both exist within a second of the request.
      // The listener is hearing the station while the producer is still
      // reading, which is what turns the first turn's latency into something
      // that sounds intentional.
      if (speakLive && config.show.liveBed && (config.show.mood as Mood) !== "none") {
        try {
          const bedPath = path.join(liveDir, "bed.wav");
          // Forty seconds is long enough not to sound like a loop and short
          // enough to synthesise in well under a second.
          const loop = gain(makeLoopBed(40, config.show.mood as Mood, hashString(jobId)), 0.9);
          fs.writeFileSync(bedPath, encodeWav(loop));
          send({ type: "bed_audio", url: `/api/live/${jobId}/bed.wav` });
        } catch (err) {
          send({ type: "info", message: `No bed for the live feed: ${(err as Error).message}` });
        }
      }

      // ── Something to play when the show is not ready.
      //
      // A bed under a two-minute gap is still a two-minute gap. The listener
      // hears a quiet pad and reasonably concludes nothing is happening, which
      // is the complaint: the record ends and then there is a long nothing
      // before anybody speaks.
      //
      // So the gap gets actual programming. These are instrumental interludes
      // rendered by the DSP in well under a second — no model, no speech
      // engine, no network — so they exist whether or not LM Studio is even
      // running. Half a minute each, short enough that a turn which becomes
      // ready never waits long behind one.
      const fillerUrls: string[] = [];

      if (speakLive && (config.show.mood as Mood) !== "none") {
        for (let i = 0; i < 3; i++) {
          try {
            fs.mkdirSync(liveDir, { recursive: true });
            const file = `filler-${i}.wav`;
            const piece = gain(makeLoopBed(30, config.show.mood as Mood, hashString(`${jobId}-fill-${i}`)), 0.95);
            fs.writeFileSync(path.join(liveDir, file), encodeWav(piece));
            fillerUrls.push(`/api/live/${jobId}/${file}`);
          } catch {
            // Filler is a courtesy. Never fail a show over it.
          }
        }
      }

      if (fillerUrls.length > 0) {
        send({ type: "filler", urls: fillerUrls });
      }

      // ── The opening, off the shelf.
      //
      // This is the whole answer to "it took seven minutes before anything
      // happened". Pressing Start used to begin a queue of round trips — a TTS
      // call for the opener, an LLM call for the petitioner, two more to write
      // the break, and a cold warm-up that costs 46 seconds on its own — and
      // none of it made a sound until it was finished.
      //
      // A pack is an announcer's open and a sixty-second commercial, written
      // and rendered days ago by `npm run openers`. Copying two files is
      // instant, so the listener hears the station about a second after
      // pressing Start, and the first turns are written underneath the opener,
      // the record and the commercial — five minutes of cover.
      // Legacy shelves may contain an opener generated for another station,
      // and a station rock open never belongs in Orion's Great Hall.
      let pack = speakLive && config.show.useColdOpen && !realmBriefing
        ? currentPreroll(config.show.station)
        : null;
      let hasOpeningAudio = false;

      if (pack) {
        try {
          fs.mkdirSync(liveDir, { recursive: true });
          const from = prerollFile(pack, "open");
          if (!from) throw new Error("its audio is missing");

          fs.copyFileSync(from, path.join(liveDir, "open.wav"));
          send({
            type: "open_audio",
            url: `/api/live/${jobId}/open.wav`,
            seconds: pack.openSeconds,
            text: pack.openText,
          });
          hasOpeningAudio = true;
        } catch (err) {
          // A bad pack falls back to rendering the opener the old way.
          send({ type: "info", message: `Shelved opener skipped: ${(err as Error).message}` });
          pack = null;
        }
      }

      if (!pack && speakLive && config.show.useColdOpen) {
        try {
          const openPath = path.join(liveDir, "open.wav");
          // A king's hall does not open on a rock band. Bells and a herald.
          const open = realmBriefing
            ? await renderCourtOpen(config, topic, openPath, signal)
            : await renderColdOpen(config, topic, openPath, signal);
          if (open) {
            send({
              type: "open_audio",
              url: `/api/live/${jobId}/open.wav`,
              seconds: Number(durationOf(open).toFixed(2)),
              text: realmBriefing ? courtOpenScript(config, topic) : coldOpenScript(config, topic),
            });
            hasOpeningAudio = true;
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") throw err;
          send({ type: "info", message: `Cold open skipped: ${(err as Error).message}` });
        }
      }

      // ── One of the Respawn Guild, brought before the King.
      //
      // Delivered down the same queue a listener's phone call uses, because it
      // is the same thing: a third voice arriving between turns, which whoever
      // speaks next has to answer. Prepared here so the model writes their line
      // during the opener rather than stopping the court to do it.
      if (realmBriefing && config.orion.guildVoices && realm.guild.length > 0) {
        const member = choosePetitioner(realm.guild, hashString(jobId));
        if (member) {
          // Their own voice, not the station's phone-in voice, and stable
          // across courts so somebody brought in three times sounds like the
          // same person all three. Only one rider comes forward per night, so
          // borrowing the caller slot for them is exact rather than a bodge.
          config = {
            ...config,
            caller: {
              ...config.caller,
              name: member.name,
              tone: "room",
              voices: {
                ...config.caller.voices,
                [config.tts.engine]: voiceForMember(member, config.tts.engine),
              },
            },
          };

          void speakPetition(config, member, topic, signal)
            .then((text) => {
              const queue = callQueues.get(jobId) ?? [];
              queue.push({ name: member.name, text });
              callQueues.set(jobId, queue);
              send({
                type: "info",
                message: isWommper(member.name)
                  ? `${member.name} has come to the hall, and he came on his own.`
                  : `${member.name} of the Respawn Guild has been brought into the hall.`,
              });
            })
            .catch(() => {
              // A petitioner who cannot be written simply does not appear.
            });
        }
      }

      // ── Warm the model while the imaging plays.
      //
      // The first generation of a run costs 46 seconds against 2.5 warm — the
      // whole prompt being read for the first time — and it lands on the first
      // line, where the listener is already waiting. The opener and the record
      // are minutes of cover that were sitting unused, so the prefill happens
      // underneath them instead. Never awaited: if it is not done in time the
      // first turn pays what it would have paid anyway.
      const hasOpeningSong = speakLive && config.show.openingSong.enabled && Boolean(resolveSongFile(config.show.openingSong.file));
      const hasWarmupCover = config.show.warmUpModel && shouldWarmUpShow({ speakLive, hasOpeningAudio, hasOpeningSong });
      const warming = hasWarmupCover
        ? warmUp(config, topic, null, [], EMPTY_BRIEF, realmBriefing, signal)
        : Promise.resolve();
      warming.catch(() => {});

      // ── The record.
      //
      // This is the app's best answer to a slow model, and it is not a trick:
      // the station throws to a song, the song plays, and the four minutes
      // that buys are four minutes of the hosts' first turns being written.
      // Neither the throw nor the record involves the model, so both are ready
      // within a second of the request.
      const songConfig = config.show.openingSong;
      let songBuffer: Promise<AudioBuffer> | null = null;
      let songIntroPath: string | undefined;
      let songText = "";
      let songTitle = "";

      if (songConfig.enabled && config.tts.engine !== "none") {
        const resolved = resolveSongFile(songConfig.file);

        if (!resolved) {
          send({
            type: "info",
            message: songConfig.file
              ? `Opening record "${songConfig.file}" is not in the music folder — starting without it.`
              : "No opening record is chosen, so the show starts on the hosts.",
          });
        } else {
          const file = path.basename(resolved);
          songTitle = songLabel(config, file);
          songText = realmBriefing
            ? courtSongIntroScript(config, topic, file)
            : songIntroScript(config, topic, file);

          // Decoding runs alongside everything else; only the final mix needs
          // it, and by then it has long finished.
          const decoding = loadSong(resolved);
          // Handled where it is awaited; attached here too so an early failure
          // is never an unhandled rejection.
          decoding.catch(() => {});
          songBuffer = decoding;

          try {
            fs.mkdirSync(liveDir, { recursive: true });
            const introPath = path.join(liveDir, "song-intro.wav");
            const intro = await renderSongIntro(config, topic, file, introPath, signal, Boolean(realmBriefing));

            if (intro) {
              songIntroPath = introPath;
              if (speakLive) {
                send({
                  type: "song_intro_audio",
                  url: `/api/live/${jobId}/song-intro.wav`,
                  seconds: Number(durationOf(intro).toFixed(2)),
                  text: songText,
                });
              }
            }
          } catch (err) {
            if ((err as Error).name === "AbortError") throw err;
            send({ type: "info", message: `Could not announce the record: ${(err as Error).message}` });
          }

          if (speakLive) {
            send({
              type: "song_audio",
              url: `/api/music/file/${encodeURIComponent(file)}`,
              label: songTitle,
              volume: songConfig.volume,
            });

            // The commercial, queued behind the record so it lands the moment
            // the song ends and the show starts when it finishes. Another
            // minute of cover, and it cost nothing to produce just now.
            if (pack) {
              try {
                const adFrom = prerollFile(pack, "ad");
                if (adFrom) {
                  fs.copyFileSync(adFrom, path.join(liveDir, "preroll-ad.wav"));
                  send({
                    type: "break_audio",
                    // Well clear of the planned breaks, which number from zero.
                    index: PREROLL_BREAK_INDEX,
                    url: `/api/live/${jobId}/preroll-ad.wav`,
                    seconds: pack.adSeconds,
                    label: "Commercial",
                  });
                }
              } catch (err) {
                send({ type: "info", message: `Shelved commercial skipped: ${(err as Error).message}` });
              }
            }
          }
        }
      }

      // ── Research
      let research: ResearchResult | null = null;
      if (config.show.useResearch && researchSources.length > 0) {
        const researchStarted = Date.now();
        send({ type: "stage", stage: "research" });
        research = await runResearch(
          config,
          { sources: researchSources, topic },
          (message) => send({ type: "info", message }),
          signal,
        );
        send({ type: "research", sources: research.sources.map((s) => ({ title: s.title, url: s.url })) });
        timing("Research", Date.now() - researchStarted);
      }

      // ── Producer: find the angle before anyone goes on air.
      let brief: ProducerBrief = EMPTY_BRIEF;
      if (config.show.useProducer) {
        const producerStarted = Date.now();
        send({ type: "stage", stage: "producer" });
        send({
          type: "info",
          message: sourceText ? "Reading the material..." : "Working out the angle...",
        });

        try {
          brief = await runProducer(config, topic, sourceText, signal, (message) =>
            send({ type: "info", message }),
          );
          if (hasBrief(brief)) {
            send({ type: "brief", brief });
          } else {
            send({ type: "info", message: "The producer came back empty — going in unbriefed." });
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") throw err;
          send({ type: "info", message: `Producer skipped: ${(err as Error).message}` });
        } finally {
          timing("Producer", Date.now() - producerStarted);
        }
      }

      // ── Long-term memory: what did we say about this before?
      let recollections: Recollection[] = [];
      // The station remembers its own shows. The King does not get them.
      if (!realmBriefing && config.memory.crossShow && config.memory.recallCount > 0) {
        const recallStarted = Date.now();
        try {
          const built = await buildIndex(config);
          if (built.error) send({ type: "info", message: built.error });

          recollections = await recall(config, topic, config.memory.recallCount);
          if (recollections.length > 0) {
            send({
              type: "recall",
              items: recollections.map((r) => ({ showTitle: r.showTitle, date: r.date, text: r.text })),
            });
            send({
              type: "info",
              message: `Recalled ${recollections.length} moment(s) from previous shows.`,
            });
          }
        } catch (err) {
          send({ type: "info", message: `Memory unavailable: ${(err as Error).message}` });
        } finally {
          timing("Recall", Date.now() - recallStarted);
        }
      }

      // ── Commercials.
      //
      // Written before anyone goes on air, in a single call, and rendered in
      // the background while the hosts talk. By the time the show reaches a
      // break the audio is already on disk — which is why a break costs the
      // listener nothing and hands the model most of a minute of head start.
      const positions = breakPositions(
        config.show.turns,
        // The court takes breaks too. They are the reason breaks exist — a
        // rendered block buys the model most of a minute — and the criers at
        // the gate are their own joke rather than a tyre barn in a hall.
        config.ads.enabled && config.show.useRunSheet ? config.ads.breaks : 0,
      );
      send({
        type: "run_order",
        beats: buildRunSheet(config.show.turns, config.show.style, positions).map((beat, index) => ({
          index,
          kind: beat.kind,
          brief: beat.brief,
          breakIndex: beat.breakIndex,
          speaker: config.hosts[index % 2].name,
        })),
      });

      let plannedBreaks: AdBreak[] = [];
      const breakPaths = new Map<number, string>();
      const breakLabels = new Map<number, string>();
      const breakRenders = new Map<number, Promise<string | null>>();
      const usedBucketIds = new Set<string>();

      // Writing the breaks used to be awaited here, before a word of the show
      // existed — four breaks of three spots is a dozen round trips, and with
      // the opener and the record now playing from disk it was the largest
      // remaining thing standing between pressing Start and hearing somebody
      // speak. Measured at 388 seconds to the first line against about 300
      // seconds of cover.
      //
      // Nothing needs the copy until a break actually lands, which is several
      // turns in, so this runs underneath the conversation instead. Everything
      // that does need it waits on `planning`.
      // ── Breaks off the shelf, when there are enough of them.
      //
      // This is where the show's time was actually going. Four breaks of three
      // spots is eleven fresh generations, measured at twenty-five to thirty
      // seconds each: over four minutes of model work before a word of the
      // show exists — longer than the opening record covers. Moving it to run
      // underneath the conversation was worse, not better, because a local
      // model serves one request at a time and every turn then queued behind
      // an advert already in flight.
      //
      // A radio commercial has nothing to do with tonight's subject, so the
      // right answer was never to write it tonight at all.
      // The bucket first, then the opener pack, then writing them live.
      //
      // Both shows draw from the same bucket, which is most of the point of
      // having one: a court gets the realm's own traders and the multiverse
      // ones, the station gets its sponsors and the multiverse ones, and the
      // least recently played come round first — so a freshly generated batch
      // is always what you hear next and nothing repeats until the bucket has
      // been all the way round.
      const bucketSpotCount = positions.length * config.ads.spotsPerBreak;
      const fromBucket = positions.length > 0
        ? pickForShow(bucketSpotCount, realmBriefing ? "court" : "station", activeBrainVersion().id, {
            minReplayHours: config.ads.minReplayHours,
            separateSponsors: config.ads.separateSponsors,
            sourceWeights: config.ads.sourceWeights,
          })
        : [];
      const shelved = shelvedBreaks(pack);
      const bucketBreakCount = Math.min(
        positions.length,
        Math.floor(fromBucket.length / config.ads.spotsPerBreak),
      );
      const usingBucket = positions.length > 0 && bucketBreakCount === positions.length;
      const usingSomeBucket = bucketBreakCount > 0;
      const fromShelf = !usingSomeBucket && positions.length > 0 && shelved.length >= positions.length;

      if (!usingBucket && !fromShelf && positions.length > 0) {
        // The single largest cost in a show, and the one worth naming out loud
        // rather than leaving the listener to wonder where the time went.
        const fresh = (positions.length - bucketBreakCount) * config.ads.spotsPerBreak;
        send({
          type: "info",
          message:
            `Writing ${fresh} spot${fresh === 1 ? "" : "s"} from scratch — this is most of the wait. ` +
            `Fill the commercial bucket once and the breaks come out of it instead.`,
        });
      }

      if (usingSomeBucket) {
        send({
          type: "info",
          message:
            `${bucketBreakCount} break${bucketBreakCount === 1 ? "" : "s"} out of the commercial bucket` +
            (usingBucket ? " — nothing to write." : `; writing only the remaining ${positions.length - bucketBreakCount}.`),
        });

        const groupedSpots = groupCommercialBreaks(
          fromBucket.slice(0, bucketBreakCount * config.ads.spotsPerBreak),
          bucketBreakCount,
          config.ads.spotsPerBreak,
        );
        positions.slice(0, bucketBreakCount).forEach((_, index) => {
          const spots = groupedSpots[index] ?? [];
          const sources = spots.map((spot) => audioFor(spot.id));
          if (sources.some((source) => !source)) return;

          const outPath = path.join(liveDir, `break-${index}.wav`);
          try {
            fs.mkdirSync(liveDir, { recursive: true });
            const parts: AudioBuffer[] = [];
            for (const source of sources) {
              parts.push(decodeWav(fs.readFileSync(source!)), silence(0.35));
            }
            if (parts.length > 0) parts.pop();
            fs.writeFileSync(outPath, encodeWav(concat(parts)));
            breakPaths.set(index, outPath);
            breakLabels.set(index, spots.map((spot) => spot.sponsor).filter(Boolean).join(" / ") || "Commercial break");
            breakRenders.set(index, Promise.resolve(outPath));
            spots.forEach((spot) => usedBucketIds.add(spot.id));
          } catch (err) {
            send({ type: "info", message: `Bucket break ${index + 1} skipped: ${(err as Error).message}` });
          }
        });
      } else if (fromShelf) {
        send({
          type: "info",
          message: `${positions.length} break${positions.length === 1 ? "" : "s"} off the shelf — nothing to write.`,
        });

        positions.forEach((_, index) => {
          const brk = shelved[index];
          const outPath = path.join(liveDir, `break-${index}.wav`);
          try {
            fs.mkdirSync(liveDir, { recursive: true });
            fs.copyFileSync(path.join(OPENERS_DIR, brk.file), outPath);
            breakPaths.set(index, outPath);
            breakLabels.set(index, "Commercial break");
            breakRenders.set(index, Promise.resolve(outPath));
          } catch (err) {
            send({ type: "info", message: `Shelved break ${index + 1} skipped: ${(err as Error).message}` });
          }
        });
      }

      const planningStarted = Date.now();
      const planning: Promise<void> =
        positions.length === 0 || fromShelf || usingBucket
          ? Promise.resolve()
          : (async () => {
              send({ type: "stage", stage: "ads" });
              try {
                const remainingConfig = bucketBreakCount > 0
                  ? { ...config, ads: { ...config.ads, breaks: positions.length - bucketBreakCount } }
                  : config;
                plannedBreaks = await planBreaks(
                  remainingConfig,
                  topic,
                  signal,
                  (message) => send({ type: "info", message }),
                  // At court the criers advertise the realm's own places, take
                  // no sponsors, and are never a repeat off the shelf.
                  realmBriefing ? { places: realmPlaces(realm) } : undefined,
                );
                if (bucketBreakCount > 0) {
                  plannedBreaks = plannedBreaks.map((brk) => ({ ...brk, index: brk.index + bucketBreakCount }));
                }
              } catch (err) {
                if ((err as Error).name === "AbortError") throw err;
                send({ type: "info", message: `Ad break skipped: ${(err as Error).message}` });
              }

              for (const brk of plannedBreaks) {
                breakLabels.set(brk.index, describeBreak(brk));
              }

              if (plannedBreaks.length > 0) {
                send({
                  type: "breaks",
                  breaks: plannedBreaks.map((b) => ({
                    index: b.index,
                    label: describeBreak(b),
                    spots: b.spots.map((sp) => ({
                      kind: sp.kind,
                      sponsor: sp.sponsor,
                      text: sp.audioFile
                        ? `(your file: ${path.basename(sp.audioFile)})`
                        : sp.lines.map((l) => l.text).join(" "),
                      // Flagged so the log says which spots cost nothing tonight.
                      repeat: Boolean(sp.libraryId),
                    })),
                  })),
                });
              }

              // Rendering starts the moment the copy exists and is never
              // awaited on the hot path either.
              if (config.tts.engine !== "none") {
                for (const brk of plannedBreaks) {
                  const outPath = path.join(liveDir, `break-${brk.index}.wav`);
                  fs.mkdirSync(liveDir, { recursive: true });

                  breakRenders.set(
                    brk.index,
                    renderBreak(config, brk, outPath, hashString(`${jobId}-${brk.index}`), signal)
                      .then((audio) => {
                        if (durationOf(audio) < 0.5) return null;
                        breakPaths.set(brk.index, outPath);
                        return outPath;
                      })
                      .catch((err: Error) => {
                        if (err.name !== "AbortError") {
                          send({
                            type: "info",
                            message: `Break ${brk.index + 1} could not be produced: ${err.message}`,
                          });
                        }
                        return null;
                      }),
                  );
                }
              }
            })();

      // Handled wherever it is awaited; attached here too so a failure while
      // the conversation is running is never an unhandled rejection.
      void planning.then(
        () => timing("Commercials", Date.now() - planningStarted),
        () => timing("Commercials", Date.now() - planningStarted),
      );
      planning.catch(() => {});

      // ── Conversation
      timing("Startup", Date.now() - started);
      send({ type: "stage", stage: "conversation" });
      let outline: string[] = [];
      const conversationStarted = Date.now();
      const draft: ShowDraft = {
        id: jobId,
        topic,
        station: config.show.station,
        style: config.show.style,
        mood: config.show.mood,
        createdAt: resumeDraft?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        turns: resumeDraft ? [...resumeDraft.turns] : [],
        config,
      };

      // Turn index -> already-treated voice clip. On a resumed broadcast this
      // begins with the clips made before the interruption, so recovery does
      // not call the speech service again or change a voice that was already
      // heard on air.
      const prerendered = new Map<number, string>();

      if (resumeDraft?.turns.length) {
        send({
          type: "info",
          message: `Resuming after ${resumeDraft.turns.length} completed line${resumeDraft.turns.length === 1 ? "" : "s"}.`,
        });
        for (const turn of resumeDraft.turns) {
          send({ type: "turn_start", index: turn.index, speaker: turn.speaker, hostId: turn.hostId });
          send({ type: "turn_end", turn });
        }

        const priorLiveDir = path.join(process.cwd(), "output", "live", resumeDraft.id);
        let reusedAudio = 0;
        fs.mkdirSync(liveDir, { recursive: true });
        for (const turn of resumeDraft.turns) {
          const name = `${String(turn.index).padStart(3, "0")}.wav`;
          const source = path.join(priorLiveDir, name);
          const target = path.join(liveDir, name);
          try {
            if (!fs.existsSync(source) || durationOf(decodeWav(fs.readFileSync(source))) < 0.5) continue;
            if (path.resolve(source) !== path.resolve(target)) fs.copyFileSync(source, target);
            prerendered.set(turn.index, target);
            reusedAudio++;
          } catch {
            // The final mix will render only this missing line again.
          }
        }
        if (reusedAudio > 0) {
          send({
            type: "info",
            message: `Reused ${reusedAudio} completed voice clip${reusedAudio === 1 ? "" : "s"}; only missing audio will be rendered again.`,
          });
        }
      }

      // Speak each line as soon as it exists, so the listener hears the show
      // being made instead of watching text for minutes and then getting a file.
      // Serialises live speech without blocking the conversation loop.
      let speechChain: Promise<void> = Promise.resolve();

      // The warm-up is deliberately NOT waited for.
      //
      // Measured with the commercials coming off the shelf, so nothing else
      // was competing: the conversation stage began at 4 seconds and the first
      // turn was not even started until 202. All of that was this wait.
      //
      // The reason is that warmUp prefills BOTH system prompts, the King's and
      // his chronicler's, one after the other. The first turn needs exactly one
      // of them. Waiting for both means paying a full cold prefill — most of a
      // minute on this machine — for a speaker who does not go until turn two.
      //
      // Not waiting costs nothing: the King's prefill is already in flight when
      // the first turn asks, so the turn lands on a warm cache either way, and
      // the chronicler's runs in the background behind it, ready exactly when
      // she needs it. The warm-up was always meant to hide under the opener and
      // the record, and this is what lets it.

      // The advert copy is NOT waited for here.
      //
      // This has been measured both ways and the numbers decided it. Writing
      // the breaks first gives the conversation the model to itself — gaps of
      // about 24 seconds — but the first line does not exist until 161
      // seconds. Letting them run underneath gets the first line at 100
      // seconds with gaps that are burstier, between 10 and 44.
      //
      // Bursty used to be the worse of the two, because a gap was silence.
      // With interludes filling the gaps it is not: the air stays alive either
      // way, so the version that starts the show a minute earlier wins. A turn
      // still jumps the queue ahead of any advert not yet started, and
      // anything that actually needs the copy waits on `planning`.

      const conversation = await runConversation(
        config,
        topic,
        research,
        {
          onOutline: (beats) => {
            outline = beats;
            send({ type: "outline", beats });
          },
          onInfo: (message) => send({ type: "info", message }),
          onMemory: (memory) => send({ type: "memory", memory }),
          onMemoryTiming: ({ milliseconds, turns }) => timing("Memory", milliseconds, { turns }),
          onModelTiming: ({ index, queueMs, requestMs }) => timing("Model", requestMs, { index, queueMs }),
          onTurnTiming: ({ index, milliseconds, skipped }) => timing("Turn", milliseconds, { index, skipped }),
          onTurnStart: (turn) => {
            send({ type: "turn_start", ...turn });
            send({ type: "control", current: turn.index, speaker: turn.speaker, queue: queueStats() });
          },
          onToken: (text) => send({ type: "token", text }),
          takeCall: () => {
            const queue = callQueues.get(jobId);
            const next = queue?.shift();
            if (!next) return null;
            return { name: next.name || config.caller.name, text: next.text };
          },
          onTurnEnd: (turn) => {
            send({ type: "turn_end", turn });
            draft.turns = [...draft.turns.filter((saved) => saved.index !== turn.index), turn]
              .sort((a, b) => a.index - b.index);
            draft.updatedAt = new Date().toISOString();
            saveDraft(draft);
            if (!speakLive) return;

            // Deliberately not awaited. Speech runs alongside the model writing
            // the next turn instead of after it, which matters most for cloud
            // engines where a round trip would otherwise be dead time. The
            // promise chain keeps clips in order even when one is slow.
            speechChain = speechChain
              .then(async () => {
                const voiceStarted = Date.now();
                const clipPath = path.join(liveDir, `${String(turn.index).padStart(3, "0")}.wav`);
                let clip;
                try {
                  clip = await renderTurnClip(config, hostFor(config, turn.hostId), turn.text, clipPath, signal);
                } catch (firstError) {
                  if ((firstError as Error).name === "AbortError") throw firstError;
                  send({ type: "info", message: `${turn.speaker}'s line did not render; retrying that line only.` });
                  clip = await renderTurnClip(config, hostFor(config, turn.hostId), turn.text, clipPath, signal);
                }
                timing("Voice", Date.now() - voiceStarted, { index: turn.index });
                prerendered.set(turn.index, clipPath);

                send({
                  type: "turn_audio",
                  index: turn.index,
                  url: `/api/live/${jobId}/${turn.index}.wav`,
                  seconds: Number(durationOf(clip).toFixed(2)),
                });
              })
              .catch((err: Error) => {
                if (err.name === "AbortError") return;
                // Losing live audio must never lose the show; the mix re-renders.
                send({ type: "info", message: `Could not speak that line yet: ${err.message}. The final mix will retry only that missing line.` });
              });
          },

          // A break goes out between two turns. Queueing it on the same chain
          // as the speech is what keeps it in the right place in the feed —
          // and by now it has almost always finished rendering, so nothing
          // actually waits here.
          onBreak: (breakIndex) => {
            if (!speakLive) return;

            speechChain = speechChain
              .then(async () => {
                // The copy may still be being written: planning now runs
                // underneath the conversation rather than in front of it. A
                // break whose render has not even been queued yet would
                // otherwise look like a break that failed, and be skipped.
                await planning;

                const ready = await breakRenders.get(breakIndex);
                if (!ready) return;

                const audio = decodeWav(fs.readFileSync(ready));
                send({
                  type: "break_audio",
                  index: breakIndex,
                  url: `/api/live/${jobId}/break-${breakIndex}.wav`,
                  seconds: Number(durationOf(audio).toFixed(2)),
                  label: breakLabels.get(breakIndex) ?? "Commercial break",
                });
              })
              .catch(() => {
                // A break that will not play is not worth stopping a show for.
              });
          },
        },
        signal,
        recollections,
        brief,
        positions,
        // So the first host comes out of the record naming it, rather than
        // opening as though nothing had been playing.
        songTitle ? songDetails(config, path.basename(resolveSongFile(songConfig.file) ?? "")) : null,
        realmBriefing,
        resumeDraft?.turns ?? [],
      );
      timing("Conversation", Date.now() - conversationStarted);

      const turns: Turn[] = conversation.turns;

      // Let any still-rendering live clips finish so the mix can reuse them
      // rather than synthesising the same lines a second time.
      const finishingStarted = Date.now();
      await speechChain;
      // Everything the breaks need, finished. Planning first, because the
      // render map is only filled once the copy exists.
      await planning;
      await Promise.all(breakRenders.values());
      timing("Finish live audio", Date.now() - finishingStarted);

      if (turns.length === 0) {
        // Almost always one of two things on a small local model: it answered
        // every turn with a tool call, or the prompt got long enough that it
        // stopped following the format. Both are fixable, so say which levers
        // to pull rather than reporting a bare failure.
        throw new Error(
          "Every turn came back unusable, so there is no show to record. On a small local model this is " +
            "usually the prompt pushing it into structured output: try shortening the producer's notes, " +
            "turning off Plan the segment first, or lowering the host temperature. The log above shows " +
            "what each turn actually returned.",
        );
      }

      // ── Titles
      send({ type: "stage", stage: "notes" });
      const notesStarted = Date.now();
      const notes = config.show.generateNotes
        ? await generateShowNotes(config, topic, turns, signal, conversation.memory)
        : {
            title: topic.length > 60 ? `${topic.slice(0, 57)}...` : topic,
            summary: `${config.hosts[0].name} and ${config.hosts[1].name} discuss ${topic}.`,
          };
      timing("Title and summary", Date.now() - notesStarted);
      send({ type: "notes", ...notes });

      // ── Audio
      send({ type: "stage", stage: "audio" });
      const id = makeShowId(notes.title);
      const dir = showDir(id);

      const mixStarted = Date.now();
      const produced = await produceShow(
        config,
        turns,
        dir,
        {
          onInfo: (message) => send({ type: "info", message }),
          onProgress: (done, total, speaker) => send({ type: "audio_progress", done, total, speaker }),
        },
        signal,
        prerendered,
        {
          breaks: breakPaths,
          breakLabels,
          coldOpen: config.show.useColdOpen ? path.join(liveDir, "open.wav") : undefined,
          coldOpenText: realmBriefing ? courtOpenScript(config, topic) : coldOpenScript(config, topic),
          songIntro: songIntroPath,
          songIntroText: songText,
          songLabel: songTitle,
          // A record that failed to decode is not worth losing a finished show
          // over; the mix simply goes out without it.
          song: songBuffer
            ? await songBuffer.catch((err: Error) => {
                send({ type: "info", message: `The record is not in the mix: ${err.message}` });
                return undefined;
              })
            : undefined,
        },
      );
      timing("Final mix", Date.now() - mixStarted);

      // ── Persist
      const show: StoredShow = {
        id,
        title: notes.title,
        summary: notes.summary,
        topic,
        station: config.show.station,
        style: config.show.style,
        mood: config.show.mood,
        createdAt: new Date().toISOString(),
        duration: produced.duration,
        hasAudio: produced.hasAudio,
        hosts: config.hosts.map((h) => ({
          id: h.id,
          name: h.name,
          voice: voiceFor(h, config.tts.engine),
          tone: h.tone,
          model: h.model || config.llm.model,
        })),
        outline,
        sources: research?.sources.map((s) => ({ title: s.title, url: s.url })) ?? [],
        transcript: produced.transcript,
        models: Array.from(new Set(config.hosts.map((h) => h.model || config.llm.model))).filter(Boolean),
        generationVersion: CURRENT_SHOW_FORMAT,
        audioAnalysis: produced.audioAnalysis,
      };

      saveShow(show);
      removeDraft(jobId);
      if (resumeDraft) removeDraft(resumeDraft.id);

      // Rotation history describes broadcasts that actually completed. A
      // cancelled or failed show must leave tonight's unused spots available.
      if (usedBucketIds.size > 0) markBucketPlayedMany([...usedBucketIds]);

      // ── What is worth keeping for next time.
      //
      // The rolling notes already spotted tonight's running gags and the facts
      // the pair established; until now all of it went in the bin when the show
      // ended, which is why every episode read like a pilot. Folded into this
      // show's own lane instead — the station and each court keep separate
      // ones, so a joke about self-checkout never turns up in a king's hall.
      rememberRunning(
        laneFor(config.show.station, realmBriefing ? config.orion.king.name : undefined),
        conversation.memory,
      );

      // ── Back into the game.
      //
      // A court the realm never hears about is just a podcast about a save
      // file. One unverified broadcast claim is handed to the game through its
      // integration boundary. The game decides whether and how to surface it;
      // spoken radio copy is never promoted into a confirmed deed here.
      //
      // Deliberately one, not one per line: a broadcast that dumps forty claims
      // into the realm would drown the deeds that were actually done. The ids
      // come back so the claim can be taken straight out again.
      // The pack went out, so note it. Three shows on one pack and the
      // rotation moves to the next — the same joke a fourth night running is
      // not a joke, it is furniture.
      if (pack) usePreroll(pack.id);

      // ── Keep the bucket stocked.
      //
      // Deliberately here, after the broadcast is finished and nothing is
      // waiting on the model, at background priority. The bucket is what makes
      // a break free; a bucket that runs dry puts the show back to writing
      // twelve spots live, which is the largest single thing that ever made
      // one slow. Never awaited, and a failure is never worth a word.
      if (config.ads.enabled && config.ads.topUpBucket) {
        void topUp(config, {
          onInfo: (message) => send({ type: "info", message }),
        }).catch(() => {});
      }

      if (realmBriefing && config.orion.writeBack) {
        const digest = conversation.memory.digest?.trim();
        const said = digest || notes.summary?.trim() || "";

        if (said) {
          const result = recordTales(config.orion.realmPath, [
            {
              // Its own type, not one of the game's (battle, death, milestone).
              // That is what lets a court be picked back out of the chronicle
              // afterwards without guessing from the wording.
              type: "court",
              description: `${config.orion.king.name} held court and spoke of ${topic}. ${said}`,
              participants: [config.orion.king.name, config.orion.chronicler.name],
              location: "The Great Hall",
              importance: 5,
            },
          ]);

          if (result.error) {
            send({ type: "info", message: `The chronicle was not written: ${result.error}` });
          } else if (result.written > 0) {
            send({
              type: "info",
              message: `Saved for the game as an unverified court claim (${result.ids.join(", ")}).`,
            });
            send({ type: "chronicled", ids: result.ids });
          }
        }
      }

      send({
        type: "done",
        show: readShow(id),
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "AbortError") {
        send({ type: "cancelled" });
      } else {
        console.error("[generate]", e);
        send({
          type: "error",
          message: e.message || "Generation failed",
          hint: (e as LlmError | TtsError).hint,
        });
      }
    } finally {
      clearInterval(heartbeat);
      running.delete(jobId);
      callQueues.delete(jobId);
      jobTopics.delete(jobId);
      res.end();
    }
  });

  /**
   * Health, plus the two timestamps that answer "am I running the latest code".
   *
   * The server compiles from source once, at boot. Leave the window open while
   * the files underneath change and it will happily keep serving the old
   * behaviour with no outward sign — which is exactly how an afternoon gets
   * spent wondering why a fix did nothing.
   */
  app.get("/api/health", (_req, res) =>
    res.json({
      ok: true,
      app: "local-talk-radio",
      startedAt: new Date(BOOTED_AT).toISOString(),
      codeAt: new Date(newestCodeTime()).toISOString(),
      stale: newestCodeTime() > BOOTED_AT,
    }),
  );

  /* ── Frontend ────────────────────────────────────────────────── */

  const distDir = path.join(process.cwd(), "dist");
  const indexPath = path.join(distDir, "index.html");
  const hasBuild = fs.existsSync(indexPath);

  /**
   * The app shell is never cached.
   *
   * The server itself always runs the newest code — it compiles from source at
   * startup — so the only way to end up looking at an old version is the
   * browser holding on to an `index.html` it already has. It is one small
   * document, fetched once per launch, and not caching it costs nothing.
   */
  const noStore: express.RequestHandler = (req, res, next) => {
    const wantsHtml = req.method === "GET" && !path.extname(req.path);
    if (wantsHtml || req.path === "/" || req.path.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
    next();
  };

  app.use(noStore);

  if (isProduction && hasBuild) {
    // A build older than the source it was made from is the other way to end
    // up staring at an old version, and it is silent. Say so at startup.
    if (newestSourceTime() > fs.statSync(indexPath).mtimeMs) {
      console.warn(
        "\n  The build in dist/ is older than the source. Run `npm run build` to " +
          "pick up the latest changes, or start with `npm run dev`.\n",
      );
    }

    // Vite fingerprints asset filenames, so those can be cached hard; the
    // shell above them cannot.
    app.use(express.static(distDir, { index: false, maxAge: "1y", immutable: true }));
    app.get("*", (_req, res) => res.sendFile(indexPath));
  } else {
    if (isProduction) {
      console.warn("NODE_ENV=production but dist/index.html is missing — falling back to the dev server.");
    }
    // Loaded only here: the portable Windows build ships a prebuilt dist/ and no Vite at all.
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: process.env.ENABLE_HMR === "true" },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  listen(app, PORT, 0, (port) => startStationAutomation(`http://127.0.0.1:${port}`));
}

/**
 * When the client source was last touched, so a stale build can be spotted.
 * Cheap: a few dozen files, walked once at startup.
 */
function newestSourceTime(): number {
  const roots = [path.join(process.cwd(), "src"), path.join(process.cwd(), "index.html")];
  let newest = 0;

  const walk = (target: string) => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      return;
    }

    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) walk(path.join(target, entry));
      return;
    }
    newest = Math.max(newest, stat.mtimeMs);
  };

  for (const root of roots) walk(root);
  return newest;
}

/**
 * When any of the code this process runs was last touched — client and server.
 * `newestSourceTime` deliberately covers only the client, because it answers a
 * different question: whether the build in dist/ is behind the source.
 */
function newestCodeTime(): number {
  const roots = [
    path.join(process.cwd(), "src"),
    path.join(process.cwd(), "server"),
    path.join(process.cwd(), "server.ts"),
    path.join(process.cwd(), "index.html"),
    path.join(process.cwd(), "vite.config.ts"),
  ];

  let newest = 0;
  const walk = (target: string) => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) walk(path.join(target, entry));
      return;
    }
    newest = Math.max(newest, stat.mtimeMs);
  };

  for (const root of roots) walk(root);
  return newest;
}

function listen(app: express.Express, port: number, attempt = 0, onListening?: (port: number) => void) {
  const server = app
    .listen(port, "127.0.0.1", () => {
      console.log(`\n  Local Talk Radio  →  http://localhost:${port}\n`);
      onListening?.(port);
    })
    .on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && attempt < 10) {
        console.log(`Port ${port} is busy, trying ${port + 1}...`);
        listen(app, port + 1, attempt + 1, onListening);
      } else {
        console.error(err);
        process.exit(1);
      }
    });

  // Generation can legitimately run for many minutes on a local model.
  server.setTimeout(0);
  server.requestTimeout = 0;
  server.headersTimeout = 0;
}

/** Stable small integer from a string, for seeding procedural audio. */
function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Never let one bad promise take the station off the air.
 *
 * A show is dozens of independent async pieces — speech, music, a chronicle
 * write, a shelved advert — and several are deliberately fired without being
 * awaited so they happen underneath something else. Node's default for an
 * unhandled rejection is to kill the process, which means a failed background
 * write of an advert could end a broadcast that was otherwise going fine. That
 * is the wrong trade for this app: the listener has already lost the show, and
 * they lose the recording too.
 *
 * So both are logged loudly and survived. An exception that leaves the process
 * genuinely unable to continue will still fail on its own terms at the point
 * it matters, rather than here.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[unhandled rejection]", reason instanceof Error ? reason.stack : reason);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaught exception]", err instanceof Error ? err.stack : err);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
