/**
 * Live LM Studio check for the ordinary DJ conversation guardrails.
 * This deliberately skips TTS and mixing so dialogue changes can be verified
 * in about a minute without producing another full show.
 */

import { loadConfig } from "../server/config.ts";
import {
  reportsOtherInsteadOfReplying,
  reusesOpeningRecord,
  runConversation,
} from "../server/pipeline/conversation.ts";
import { evaluateDjTranscript } from "../server/pipeline/djeval.ts";

const topic = process.argv.slice(2).join(" ") || "whether restaurants should create phone-free dining sections";
const base = loadConfig();
const config = {
  ...base,
  show: {
    ...base.show,
    turns: 12,
    useProducer: false,
    useOutline: false,
    generateNotes: false,
    warmUpModel: false,
  },
  memory: { ...base.memory, enabled: false },
};
const openingRecord = { title: "Velvet Voltage", artist: "Neon Parish" };

console.log(`Dialogue smoke check\nTopic: ${topic}\nModel: ${config.llm.model}\n`);

const result = await runConversation(
  config,
  topic,
  null,
  {
    onInfo: (message) => console.log(`  guard: ${message}`),
    onTurnEnd: (turn) => console.log(`  ${turn.speaker}: ${turn.text}`),
  },
  undefined,
  [],
  undefined,
  [],
  openingRecord,
);

const score = evaluateDjTranscript(
  {
    topic,
    requiredConcepts: ["restaurant", "phone", "dining", "conversation", "policy"],
  },
  result.turns,
);

const recordLeaks = result.turns
  .slice(1)
  .filter((turn) => reusesOpeningRecord(turn.text, openingRecord, topic));
const narratedReplies = result.turns.filter((turn) => {
  const other = turn.hostId === "a" ? config.hosts[1].name : config.hosts[0].name;
  return reportsOtherInsteadOfReplying(turn.text, other);
});
const pass =
  result.turns.length === config.show.turns &&
  recordLeaks.length === 0 &&
  narratedReplies.length === 0 &&
  score.repetitionControl >= 75 &&
  score.driftControl >= 75;

console.log("\nMeasurements");
console.log(`  turns              ${result.turns.length}/${config.show.turns}`);
console.log(`  repetition control ${score.repetitionControl}/100`);
console.log(`  topic drift control ${score.driftControl}/100`);
console.log(`  overall dialogue   ${score.overall}/100`);
console.log(`  record-title leaks ${recordLeaks.length}`);
console.log(`  narrated replies   ${narratedReplies.length}`);
if (score.notes.length) console.log(`  notes              ${score.notes.join(" ")}`);
console.log(`\n${pass ? "DIALOGUE SMOKE PASSED" : "DIALOGUE SMOKE FAILED"}`);
process.exit(pass ? 0 : 1);
