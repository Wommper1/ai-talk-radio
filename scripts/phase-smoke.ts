/**
 * Short live production check for the six-task broadcast-readiness phase.
 * It uses the configured LM Studio model and real speech engine, but keeps the
 * running order intentionally small so it is safe to repeat after changes.
 */

import type { Config } from "../server/config.ts";

const base = process.env.RADIO_URL ?? "http://127.0.0.1:3000";
const topic = "Why hearing a familiar radio voice can make a city feel like home";

interface FinishedShow {
  id: string;
  hasAudio: boolean;
  duration: number;
  transcript: Array<{ hostId: string; speaker: string; text: string }>;
  audioAnalysis?: {
    targetLufs: number;
    integratedLufs: number;
    truePeakDbtp: number;
    samplePeakDbfs: number;
    gainAppliedDb: number;
    streamingReady: boolean;
  };
}

const configResponse = await fetch(`${base}/api/config`);
if (!configResponse.ok) throw new Error(`Could not load station config: HTTP ${configResponse.status}`);
const current = ((await configResponse.json()) as { config: Config }).config;
const config: Config = {
  ...current,
  ads: { ...current.ads, enabled: false, breaks: 0 },
  show: {
    ...current.show,
    turns: 4,
    mood: "none",
    performanceProfile: "fast",
    useProducer: false,
    useOutline: false,
    generateNotes: false,
    warmUpModel: false,
    useColdOpen: false,
    liveBed: false,
    useResearch: false,
    openingSong: { ...current.show.openingSong, enabled: false },
  },
};

const jobId = `phase-smoke-${Date.now().toString(36)}`;
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
let show: FinishedShow | null = null;
let failure = "";
let turnAudio = 0;

console.log(`Broadcast phase smoke @ ${base}`);
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
    if (event.type === "stage") console.log(`  ${event.stage}`);
    if (event.type === "turn_end") {
      const turn = event.turn as { speaker: string; text: string };
      console.log(`  ${turn.speaker}: ${turn.text}`);
    }
    if (event.type === "turn_audio") turnAudio++;
    if (event.type === "info") console.log(`    ${event.message}`);
    if (event.type === "done") show = event.show as unknown as FinishedShow;
    if (event.type === "error") failure = `${event.message ?? "Generation error"} ${event.hint ?? ""}`.trim();
  }
}

if (failure) throw new Error(failure);
if (!show) throw new Error("The production stream ended without a finished show.");

const savedResponse = await fetch(`${base}/api/shows/${show.id}`);
if (!savedResponse.ok) throw new Error(`Finished show is not reachable: HTTP ${savedResponse.status}`);
const saved = (await savedResponse.json()) as FinishedShow & { audioUrl?: string };
const audioResponse = await fetch(`${base}${saved.audioUrl}`);
const audioBytes = (await audioResponse.arrayBuffer()).byteLength;
const analysis = saved.audioAnalysis;

console.log("\nLive production measurements");
console.log(`  show       ${saved.id}`);
console.log(`  elapsed    ${((Date.now() - started) / 1000).toFixed(1)} seconds`);
console.log(`  dialogue   ${saved.transcript.filter((line) => line.hostId === "a" || line.hostId === "b").length}/4 turns`);
console.log(`  live audio ${turnAudio}/4 clips`);
console.log(`  master     ${analysis ? `${analysis.integratedLufs.toFixed(1)} LUFS-I, ${analysis.truePeakDbtp.toFixed(1)} dBTP` : "not measured"}`);
console.log(`  delivery   HTTP ${audioResponse.status}, ${audioBytes} bytes`);

const passed =
  saved.hasAudio &&
  saved.transcript.filter((line) => line.hostId === "a" || line.hostId === "b").length === 4 &&
  turnAudio === 4 &&
  audioResponse.ok &&
  audioBytes > 44 &&
  Boolean(analysis?.streamingReady) &&
  (analysis?.truePeakDbtp ?? 0) <= -0.9;

console.log(`\n${passed ? "PHASE SMOKE PASSED" : "PHASE SMOKE NEEDS ATTENTION"}`);
process.exit(passed ? 0 : 1);
