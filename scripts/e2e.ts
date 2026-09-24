/**
 * End-to-end check against a running server: generate a short show and report
 * every stage. Run with: npm run e2e -- "topic"
 */

const BASE = process.env.RADIO_URL ?? "http://127.0.0.1:3000";
const topic = process.argv[2] ?? "whether self-checkout machines actually save anyone time";

const res = await fetch(`${BASE}/api/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ topic, jobId: "e2e-test", sources: [] }),
});

if (!res.ok || !res.body) {
  console.error(`generate failed: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let turns = 0;
let tokens = 0;
let showId = "";
let failed: string | null = null;
const started = Date.now();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;

    const event = JSON.parse(t.slice(5).trim()) as Record<string, unknown>;

    switch (event.type) {
      case "stage":
        console.log(`\n[stage] ${event.stage}`);
        break;
      case "info":
        console.log(`  info: ${event.message}`);
        break;
      case "outline":
        console.log(`  outline: ${(event.beats as string[]).length} beats`);
        for (const b of event.beats as string[]) console.log(`    - ${b}`);
        break;
      case "turn_start":
        console.log(`  turn ${event.index}: ${event.speaker}`);
        break;
      case "token":
        tokens++;
        break;
      case "turn_end": {
        const turn = event.turn as { speaker: string; text: string };
        turns++;
        console.log(`    ${turn.speaker}: ${turn.text}`);
        break;
      }
      case "audio_progress":
        if ((event.done as number) % 2 === 0 || event.done === event.total) {
          console.log(`  audio ${event.done}/${event.total}`);
        }
        break;
      case "notes":
        console.log(`  title: ${event.title}`);
        console.log(`  summary: ${event.summary}`);
        break;
      case "done": {
        const show = event.show as { id: string; duration: number; hasAudio: boolean; transcript: unknown[] };
        showId = show.id;
        console.log(`\n[done] ${event.elapsedSeconds}s`);
        console.log(`  id:         ${show.id}`);
        console.log(`  duration:   ${show.duration.toFixed(1)}s`);
        console.log(`  hasAudio:   ${show.hasAudio}`);
        console.log(`  transcript: ${show.transcript.length} lines`);
        break;
      }
      case "error":
        failed = `${event.message}${event.hint ? ` — ${event.hint}` : ""}`;
        console.error(`\n[error] ${failed}`);
        break;
      case "cancelled":
        failed = "cancelled";
        break;
    }
  }
}

console.log(`\nstreamed ${tokens} tokens across ${turns} turns in ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (failed || !showId) {
  console.error("E2E FAILED");
  process.exit(1);
}

// Verify the artefacts are actually reachable.
const show = (await (await fetch(`${BASE}/api/shows/${showId}`)).json()) as {
  audioUrl?: string;
  coverUrl?: string;
};

const audio = await fetch(`${BASE}${show.audioUrl}`);
const cover = await fetch(`${BASE}${show.coverUrl}`);
const transcript = await fetch(`${BASE}/api/shows/${showId}/transcript.txt`);

const audioBytes = (await audio.arrayBuffer()).byteLength;
console.log(`  audio:      HTTP ${audio.status}, ${audioBytes} bytes, ${audio.headers.get("content-type")}`);
console.log(`  cover:      HTTP ${cover.status}, ${cover.headers.get("content-type")}`);
console.log(`  transcript: HTTP ${transcript.status}`);

const ok = audio.ok && cover.ok && transcript.ok && audioBytes > 44;
console.log(`\n${ok ? "E2E PASSED" : "E2E FAILED"}`);
process.exit(ok ? 0 : 1);
