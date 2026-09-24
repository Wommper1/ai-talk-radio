/**
 * Verify the two features that need a live show to test:
 *   - a listener call goes on air mid-conversation and gets answered by name
 *   - the show bible keeps the hosts' relationship consistent
 */

const BASE = process.env.RADIO_URL ?? "http://127.0.0.1:3000";
const JOB = `callin-${Date.now().toString(36)}`;
const topic = process.argv[2] ?? "whose turn it is to do the washing up";

const CALLER_NAME = "Marcus from Leeds";
const CALLER_LINE = "You two argue about chores every single week. Just get a dishwasher and be done with it.";

const res = await fetch(`${BASE}/api/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ topic, jobId: JOB, sources: [] }),
});

if (!res.ok || !res.body) {
  console.error(`generate failed: HTTP ${res.status}`);
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let called = false;
let callerTurnIndex = -1;
const transcript: Array<{ hostId: string; speaker: string; text: string }> = [];
let failed: string | null = null;

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

    if (event.type === "turn_end") {
      const turn = event.turn as { index: number; hostId: string; speaker: string; text: string };
      transcript.push(turn);
      console.log(`  ${turn.hostId === "caller" ? "CALLER" : turn.speaker}: ${turn.text.slice(0, 100)}...`);

      if (turn.hostId === "caller") callerTurnIndex = transcript.length - 1;

      // Phone in once the show has warmed up.
      if (!called && transcript.length === 2) {
        called = true;
        const r = await fetch(`${BASE}/api/call-in/${JOB}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: CALLER_NAME, text: CALLER_LINE }),
        });
        console.log(`\n  >>> called in (HTTP ${r.status}) <<<\n`);
      }
    } else if (event.type === "error") {
      failed = String(event.message);
    } else if (event.type === "done") {
      console.log(`\n  finished in ${event.elapsedSeconds}s`);
    }
  }
}

console.log("");

const callerTurn = transcript.find((t) => t.hostId === "caller");
const answer = callerTurnIndex >= 0 ? transcript[callerTurnIndex + 1] : undefined;

const answersByName = answer ? /marcus/i.test(answer.text) : false;
const mentionsDishwasher = answer ? /dishwash|chore|washing/i.test(answer.text) : false;

console.log(`  caller went on air : ${callerTurn ? "yes" : "NO"}`);
console.log(`  caller name        : ${callerTurn?.speaker ?? "-"}`);
console.log(`  next host answered : ${answer ? answer.speaker : "-"}`);
console.log(`  addressed by name  : ${answersByName ? "yes" : "no"}`);
console.log(`  engaged with topic : ${mentionsDishwasher ? "yes" : "no"}`);

// Continuity: nobody should be working out how they know each other.
const all = transcript.map((t) => t.text).join(" ");
const amnesia = /nice to meet you|who are you|how do you know|are you related|are we related|remind me who/i.test(all);
console.log(`  continuity slips   : ${amnesia ? "FOUND" : "none"}`);

const ok = !failed && !!callerTurn && !!answer && (answersByName || mentionsDishwasher) && !amnesia;
console.log(`\n${ok ? "CALL-IN OK" : "CALL-IN FAILED"}\n`);
process.exit(ok ? 0 : 1);
