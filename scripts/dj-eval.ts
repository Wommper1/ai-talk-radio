import { loadConfig } from "../server/config.ts";
import { djTrainingReadiness } from "../server/memory/djfeedback.ts";
import { runConversation } from "../server/pipeline/conversation.ts";
import { DJ_EXAMPLES } from "../server/pipeline/djexamples.ts";
import { auditDjConfig, DJ_EVAL_TOPICS, evaluateDjTranscript } from "../server/pipeline/djeval.ts";
import { EMPTY_BRIEF, runProducer } from "../server/pipeline/showrunner.ts";

const liveArg = process.argv.find((arg) => arg.startsWith("--live"));
const liveCount = liveArg ? Math.max(1, Math.min(20, Number(liveArg.split("=")[1] || 3))) : 0;
const config = loadConfig();
const audit = auditDjConfig(config);

console.log("DJ brain offline audit");
for (const check of audit.checks) {
  console.log(`${check.pass ? "PASS" : "PENDING"}  ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
}

const exampleScores = DJ_EXAMPLES.map((example, index) =>
  evaluateDjTranscript(DJ_EVAL_TOPICS[index], [
    { index: 0, hostId: "a", speaker: config.hosts[0].name, text: example.hostA },
    { index: 1, hostId: "b", speaker: config.hosts[1].name, text: example.hostB },
  ]),
);
const baseline = Math.round(exampleScores.reduce((sum, score) => sum + score.overall, 0) / exampleScores.length);
console.log(`\nCurated target baseline: ${baseline}/100 across ${exampleScores.length} topics`);
console.log("This baseline validates the rubric and examples; it is not a score for the offline model.");

const readiness = djTrainingReadiness();
console.log(`\nTraining data: ${readiness.totalRows} rows (${readiness.keepers} reviewed keepers)`);
console.log(`${readiness.readyForLora ? "READY" : "NOT READY"}: ${readiness.reason}`);

if (liveCount > 0) {
  console.log(`\nLive model evaluation: ${liveCount} topic(s)`);
  const liveConfig = {
    ...config,
    tts: { ...config.tts, engine: "none" as const },
    ads: { ...config.ads, enabled: false },
    memory: { ...config.memory, crossShow: false },
    show: {
      ...config.show,
      turns: 12,
      useResearch: false,
      openingSong: { ...config.show.openingSong, enabled: false },
    },
  };

  for (const evalTopic of DJ_EVAL_TOPICS.slice(0, liveCount)) {
    try {
      const brief = liveConfig.show.useProducer
        ? await runProducer(liveConfig, evalTopic.topic, "")
        : EMPTY_BRIEF;
      const result = await runConversation(liveConfig, evalTopic.topic, null, {}, undefined, [], brief);
      const scores = evaluateDjTranscript(evalTopic, result.turns);
      console.log(`${scores.overall.toString().padStart(3)}  ${evalTopic.topic}`);
      if (scores.notes.length) console.log(`     ${scores.notes.join(" ")}`);
    } catch (err) {
      console.log(`UNAVAILABLE  ${evalTopic.topic}: ${(err as Error).message}`);
      console.log("LM Studio can stay closed for offline audits. Start its server before using --live.");
      break;
    }
  }
}
