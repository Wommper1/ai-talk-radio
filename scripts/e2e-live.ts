/**
 * Verify that lines are spoken while the show is still being written.
 *
 * Reports, per turn, how long after the text appeared the audio became
 * playable — the gap the listener actually experiences.
 */

const BASE = process.env.RADIO_URL ?? "http://127.0.0.1:3000";
const topic = process.argv[2] ?? "whether hotel gyms are ever worth using";

const res = await fetch(`${BASE}/api/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ topic, jobId: "e2e-live", sources: [] }),
});

if (!res.ok || !res.body) {
  console.error(`generate failed: HTTP ${res.status}`);
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

const textAt = new Map<number, number>();
const gaps: number[] = [];
const clips: Array<{ index: number; url: string; seconds: number }> = [];
const started = Date.now();
let failed: string | null = null;
let showId = "";

const since = () => ((Date.now() - started) / 1000).toFixed(1);

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
        console.log(`[${since()}s] stage: ${event.stage}`);
        break;

      case "turn_end": {
        const turn = event.turn as { index: number; speaker: string; text: string };
        textAt.set(turn.index, Date.now());
        console.log(`[${since()}s] text  #${turn.index} ${turn.speaker}: ${turn.text.slice(0, 62)}...`);
        break;
      }

      case "turn_audio": {
        const index = event.index as number;
        const seconds = event.seconds as number;
        const gap = (Date.now() - (textAt.get(index) ?? Date.now())) / 1000;
        gaps.push(gap);
        clips.push({ index, url: String(event.url), seconds });
        console.log(`[${since()}s] AUDIO #${index} ready ${gap.toFixed(2)}s after the text, ${seconds}s long`);
        break;
      }

      case "done":
        showId = (event.show as { id: string }).id;
        console.log(`[${since()}s] done in ${event.elapsedSeconds}s`);
        break;

      case "error":
        failed = String(event.message);
        console.error(`[${since()}s] error: ${failed}`);
        break;
    }
  }
}

console.log("");

// Every clip must actually be fetchable while the show is running.
let fetched = 0;
for (const clip of clips) {
  const r = await fetch(`${BASE}${clip.url}`);
  const bytes = (await r.arrayBuffer()).byteLength;
  const ok = r.ok && bytes > 44 && r.headers.get("content-type") === "audio/wav";
  if (ok) fetched++;
  else console.error(`  clip ${clip.index}: HTTP ${r.status}, ${bytes} bytes`);
}

const spoken = clips.reduce((n, c) => n + c.seconds, 0);
const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
const maxGap = gaps.length ? Math.max(...gaps) : 0;

console.log(`  turns with text : ${textAt.size}`);
console.log(`  turns with audio: ${clips.length}`);
console.log(`  clips playable  : ${fetched}/${clips.length}`);
console.log(`  gap text→audio  : ${avgGap.toFixed(2)}s average, ${maxGap.toFixed(2)}s worst`);
console.log(`  speech produced : ${spoken.toFixed(1)}s`);

const ok =
  !failed &&
  showId !== "" &&
  clips.length === textAt.size &&
  clips.length > 0 &&
  fetched === clips.length &&
  maxGap < 30;

console.log(`\n${ok ? "LIVE AUDIO OK" : "LIVE AUDIO FAILED"}\n`);
process.exit(ok ? 0 : 1);
