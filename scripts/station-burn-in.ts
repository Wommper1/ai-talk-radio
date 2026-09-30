import fs from "node:fs";
import path from "node:path";
import type { Config } from "../server/config.ts";
import type { Turn } from "../server/pipeline/conversation.ts";
import { evaluateDjTranscript } from "../server/pipeline/djeval.ts";

const base = process.env.RADIO_URL ?? "http://127.0.0.1:3000";
const mode = process.argv[2] === "stress" ? "stress" : "controlled";
const topic = mode === "stress"
  ? "Should restaurants ban phones at the dinner table?"
  : "Should restaurants ban phones at the dinner table?";

interface StoredShow {
  id: string;
  title: string;
  duration: number;
  hasAudio: boolean;
  transcript: Array<{ hostId: string; speaker: string; text: string }>;
  audioUrl?: string;
}

const configResponse = await fetch(`${base}/api/config`);
if (!configResponse.ok) throw new Error(`Could not load config from ${base}: HTTP ${configResponse.status}`);
const current = ((await configResponse.json()) as { config: Config }).config;

const config: Config = mode === "controlled"
  ? {
      ...current,
      ads: { ...current.ads, enabled: true, breaks: 2, spotsPerBreak: 2 },
      show: {
        ...current.show,
        performanceProfile: "produced",
        turns: 12,
        useProducer: true,
        useOutline: true,
        generateNotes: true,
        warmUpModel: true,
        useColdOpen: true,
        liveBed: true,
        useResearch: false,
      },
    }
  : current;

const jobId = `burn-${mode}-${Date.now().toString(36)}`;
const response = await fetch(`${base}/api/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ topic, config, sources: [], sourceText: "", jobId }),
});
if (!response.ok || !response.body) {
  throw new Error(`Generation failed: HTTP ${response.status} ${await response.text()}`);
}

const started = Date.now();
const reader = response.body.getReader();
const decoder = new TextDecoder();
let pending = "";
let show: StoredShow | null = null;
let failure = "";
let turnAudio = 0;
let turnEnds = 0;
let breakAudio = 0;
const modelTimes: number[] = [];
const voiceTimes: number[] = [];
const info: string[] = [];

const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);
console.log(`Station burn-in: ${mode} @ ${base}`);
console.log(`Topic: ${topic}`);

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  pending += decoder.decode(value, { stream: true });
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const event = JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown>;
    if (event.type === "stage") console.log(`[${elapsed()}s] ${event.stage}`);
    if (event.type === "info") {
      info.push(String(event.message));
      console.log(`  ${event.message}`);
    }
    if (event.type === "turn_end") {
      turnEnds++;
      const turn = event.turn as Turn;
      console.log(`  ${turn.speaker}: ${turn.text}`);
    }
    if (event.type === "turn_audio") turnAudio++;
    if (event.type === "break_audio") breakAudio++;
    if (event.type === "timing") {
      const label = String(event.phase ?? "");
      const milliseconds = Number(event.milliseconds ?? 0);
      if (label === "Model") modelTimes.push(milliseconds + Number(event.queueMs ?? 0));
      if (label === "Voice") voiceTimes.push(milliseconds);
    }
    if (event.type === "done") show = event.show as unknown as StoredShow;
    if (event.type === "error") failure = `${event.message ?? "Generation error"} ${event.hint ?? ""}`.trim();
  }
}

if (failure) throw new Error(failure);
if (!show) throw new Error("The stream ended without a completed show.");

const showDir = path.join(process.cwd(), "shows", show.id);
const audioPath = path.join(showDir, "show.wav");
const metadataPath = path.join(showDir, "show.json");
if (!fs.existsSync(audioPath) || !fs.existsSync(metadataPath)) throw new Error("Completed show artifacts are missing.");
const wav = fs.readFileSync(audioPath);

function wavMetrics(buffer: Buffer) {
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitDepth = buffer.readUInt16LE(34);
  let offset = 12;
  let dataAt = -1;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") {
      dataAt = offset + 8;
      dataBytes = Math.min(size, buffer.length - dataAt);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataAt < 0 || (bitDepth !== 16 && bitDepth !== 24)) throw new Error("Unsupported burn-in WAV format.");
  const bytesPerSample = bitDepth / 8;
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(dataBytes / frameBytes);
  const stride = Math.max(1, Math.floor(frames / 2_000_000));
  let peak = 0;
  let energy = 0;
  let samples = 0;
  let clipped = 0;
  for (let frame = 0; frame < frames; frame += stride) {
    for (let channel = 0; channel < channels; channel++) {
      const at = dataAt + frame * frameBytes + channel * bytesPerSample;
      let sample: number;
      if (bitDepth === 16) sample = buffer.readInt16LE(at) / 32768;
      else sample = (buffer.readUInt8(at) | (buffer.readUInt8(at + 1) << 8) | (buffer.readInt8(at + 2) << 16)) / 8388608;
      peak = Math.max(peak, Math.abs(sample));
      energy += sample * sample;
      samples++;
      if (Math.abs(sample) >= 0.9999) clipped++;
    }
  }
  return {
    channels,
    sampleRate,
    bitDepth,
    seconds: frames / sampleRate,
    peak,
    rms: samples ? Math.sqrt(energy / samples) : 0,
    clippedSampled: clipped,
    sampledValues: samples,
  };
}

const djTurns: Turn[] = show.transcript
  .filter((line) => line.hostId === "a" || line.hostId === "b")
  .map((line, index) => ({ index, hostId: line.hostId as "a" | "b", speaker: line.speaker, text: line.text }));
const quality = evaluateDjTranscript(
  {
    topic,
    requiredConcepts: ["attention", "conversation", "choice", "etiquette", "enforcement", "emergency"],
  },
  djTurns,
);
const audio = wavMetrics(wav);
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const report = {
  mode,
  topic,
  showId: show.id,
  title: show.title,
  elapsedSeconds: (Date.now() - started) / 1000,
  durationSeconds: show.duration,
  turnsExpected: config.show.turns,
  turnsCompleted: djTurns.length,
  turnAudio,
  breakAudio,
  audio,
  quality,
  averageModelMilliseconds: average(modelTimes),
  averageVoiceMilliseconds: average(voiceTimes),
  info,
  paths: { showDir, audioPath, metadataPath },
};
const outDir = path.join(process.cwd(), "output", "burn-in");
fs.mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, `${mode}-${show.id}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log("\nBurn-in measurements");
console.log(`  show             ${show.id}`);
console.log(`  dialogue         ${djTurns.length}/${config.show.turns} turns, ${turnAudio} live clips`);
console.log(`  commercial audio ${breakAudio} break(s) sent live`);
console.log(`  format           ${audio.sampleRate} Hz, ${audio.bitDepth}-bit, ${audio.channels} channels`);
console.log(`  level            peak ${audio.peak.toFixed(4)}, RMS ${audio.rms.toFixed(4)}, clipped sampled ${audio.clippedSampled}`);
console.log(`  DJ quality       ${quality.overall}/100 (topic ${quality.topicAccuracy}, radio ${quality.radioQuality}, drift ${quality.driftControl})`);
if (quality.notes.length) console.log(`  notes            ${quality.notes.join(" ")}`);
console.log(`  report           ${reportPath}`);

const passed =
  show.hasAudio &&
  djTurns.length === config.show.turns &&
  turnAudio === config.show.turns &&
  audio.channels === 2 &&
  audio.sampleRate === 48000 &&
  audio.bitDepth === 24 &&
  audio.clippedSampled === 0 &&
  quality.driftControl >= 70 &&
  quality.repetitionControl >= 70;
console.log(`\n${passed ? "BURN-IN PASSED" : "BURN-IN NEEDS ATTENTION"}\n`);
process.exit(passed ? 0 : 1);
