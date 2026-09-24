import { loadConfig, type Config } from "../server/config.ts";
import { runConversation } from "../server/pipeline/conversation.ts";
import { courtBroadcastMemory } from "../server/orion/broadcast-memory.ts";
import { evaluateOrionTranscript } from "../server/orion/eval.ts";
import { readRealm, realmBriefing, realmSummary } from "../server/orion/realm.ts";
import { orionTrainingReadiness } from "../server/orion/training.ts";

const topic = process.argv.slice(2).filter((arg) => !arg.startsWith("--")).join(" ").trim() ||
  "What Wommper learned in Brindlemark, and how the Crown should answer";
const requestedTurns = Number(process.argv.find((arg) => arg.startsWith("--turns="))?.split("=")[1] ?? 10);

const source = loadConfig();
const realm = readRealm(source.orion.realmPath, source.orion.recallEvents);
if (!realm.root) {
  console.error(`Orion's realm is unavailable. ${realm.problems.join(" ")}`);
  process.exit(1);
}

const { king, chronicler } = source.orion;
const config: Config = {
  ...source,
  orion: { ...source.orion, enabled: true, writeBack: false, guildVoices: false },
  tts: { ...source.tts, engine: "none" },
  ads: { ...source.ads, enabled: false },
  memory: { ...source.memory, crossShow: false },
  show: {
    ...source.show,
    style: "debate",
    mood: "noir",
    turns: Math.max(6, Math.min(20, Number.isFinite(requestedTurns) ? Math.round(requestedTurns) : 10)),
    useProducer: false,
    useOutline: false,
    openingSong: { ...source.show.openingSong, enabled: false },
  },
  hosts: [
    {
      ...source.hosts[0],
      name: king.name,
      voices: king.voices,
      tone: king.tone,
      rate: king.rate,
      temperature: source.orion.temperature,
      maxWords: king.maxWords,
    },
    {
      ...source.hosts[1],
      name: chronicler.name,
      voices: chronicler.voices,
      tone: chronicler.tone,
      rate: chronicler.rate,
      temperature: source.orion.temperature,
      maxWords: chronicler.maxWords,
    },
  ],
};

const briefing = [
  realmBriefing(realm, config.orion.lore),
  courtBroadcastMemory(king.name, chronicler.name, topic),
].filter(Boolean).join("\n\n");

console.log(`Night Court live evaluation`);
console.log(`Model: ${config.llm.model || "server default"}`);
console.log(`Realm: ${realmSummary(realm)}`);
console.log(`Topic: ${topic}\n`);

try {
  const result = await runConversation(
    config,
    topic,
    null,
    { onInfo: (message) => console.log(`[info] ${message}`) },
    undefined,
    [],
    undefined,
    [],
    null,
    briefing,
  );

  for (const turn of result.turns) console.log(`${turn.speaker}: ${turn.text}\n`);

  const score = evaluateOrionTranscript(topic, result.turns, realm, king.name, chronicler.name);
  console.log("Scores");
  console.log(`  Overall:             ${score.overall}/100`);
  console.log(`  Canon grounding:     ${score.canonGrounding}/100`);
  console.log(`  Intelligence:        ${score.intelligence}/100`);
  console.log(`  Controlled menace:   ${score.menace}/100`);
  console.log(`  Radio craft:         ${score.radioCraft}/100`);
  console.log(`  Orion/Maeve exchange:${score.partnership.toString().padStart(4)}/100`);
  console.log(`  Repetition control:  ${score.repetitionControl}/100`);
  for (const note of score.notes) console.log(`  - ${note}`);
} catch (err) {
  console.error(`\nLIVE MODEL UNAVAILABLE: ${(err as Error).message}`);
  console.error("The offline brain, tests, evaluator, and training data still work without LM Studio; this live score does not.");
  process.exit(1);
}

const readiness = orionTrainingReadiness();
console.log(`\nTraining: ${readiness.totalRows} rows, ${readiness.keepers} reviewed court keepers.`);
console.log(`${readiness.readyForLora ? "READY" : "NOT READY"}: ${readiness.reason}`);
