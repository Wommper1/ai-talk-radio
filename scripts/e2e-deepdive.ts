/**
 * Deep dive on a real document: producer brief, then the show.
 *
 *   npm run e2e-deepdive -- "Topic" path/to/document.md
 */

import fs from "node:fs";

const BASE = process.env.RADIO_URL ?? "http://127.0.0.1:3000";
const topic = process.argv[2] ?? "how a two-host AI podcast is actually built";
const file = process.argv[3];

const sourceText = file && fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
console.log(`source: ${file ?? "(none)"} — ${sourceText.length} chars\n`);

const res = await fetch(`${BASE}/api/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ topic, sourceText, jobId: "e2e-deepdive", sources: [] }),
});

if (!res.ok || !res.body) {
  console.error(`generate failed: HTTP ${res.status}`);
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

const started = Date.now();
const textTimes: number[] = [];
let brief: Record<string, unknown> | null = null;
let failed: string | null = null;
const lines: string[] = [];

const since = () => ((Date.now() - started) / 1000).toFixed(0);

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split("\n");
  buffer = parts.pop() ?? "";

  for (const line of parts) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const event = JSON.parse(t.slice(5).trim()) as Record<string, unknown>;

    switch (event.type) {
      case "stage":
        console.log(`[${since()}s] ${event.stage}`);
        break;
      case "brief":
        brief = event.brief as Record<string, unknown>;
        console.log(`\n  HOOK: ${brief.hook}`);
        console.log(`  CONCEPTS: ${(brief.concepts as string[]).join(" | ")}`);
        console.log(`  ANALOGIES: ${(brief.analogies as string[]).join(" | ")}`);
        console.log(`  AHA: ${(brief.ahaMoments as string[]).join(" | ")}\n`);
        break;
      case "turn_end": {
        const turn = event.turn as { speaker: string; text: string };
        textTimes.push(Date.now());
        lines.push(`${turn.speaker}: ${turn.text}`);
        console.log(`[${since()}s] ${turn.speaker}: ${turn.text.slice(0, 90)}...`);
        break;
      }
      case "error":
        failed = String(event.message);
        break;
      case "done":
        console.log(`\n[${since()}s] done`);
        break;
    }
  }
}

// Gaps between consecutive lines show whether writing ever stalls.
const gaps: number[] = [];
for (let i = 1; i < textTimes.length; i++) gaps.push((textTimes[i] - textTimes[i - 1]) / 1000);

const all = lines.join(" ");
const affirmations = (all.match(/\b(Right|Exactly|Absolutely|Wait, really|Hang on|See,)\b/g) || []).length;
const ellipses = (all.match(/\.\.\./g) || []).length;
const emDashes = (all.match(/—/g) || []).length;

console.log("");
console.log(`  brief produced   : ${brief ? "yes" : "NO"}`);
console.log(`  lines            : ${lines.length}`);
console.log(`  gap between lines: ${gaps.length ? (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : 0}s avg, ${gaps.length ? Math.max(...gaps).toFixed(1) : 0}s worst`);
console.log(`  affirmations     : ${affirmations}`);
console.log(`  ellipses         : ${ellipses}`);
console.log(`  em dashes        : ${emDashes}`);

const ok = !failed && !!brief && lines.length > 0;
console.log(`\n${ok ? "DEEP DIVE OK" : "DEEP DIVE FAILED"}\n`);
process.exit(ok ? 0 : 1);
