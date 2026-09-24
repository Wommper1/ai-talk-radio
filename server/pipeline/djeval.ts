/** Deterministic DJ quality checks. Live generation is driven by scripts/dj-eval.ts. */

import type { Config } from "../config.ts";
import type { Turn } from "./conversation.ts";
import { DJ_EXAMPLES } from "./djexamples.ts";

export interface DjEvalTopic {
  topic: string;
  requiredConcepts: string[];
}

export interface DjQualityScores {
  topicAccuracy: number;
  radioQuality: number;
  personality: number;
  weirdnessControl: number;
  repetitionControl: number;
  driftControl: number;
  overall: number;
  notes: string[];
}

export const DJ_EVAL_TOPICS: DjEvalTopic[] = DJ_EXAMPLES.map((example) => ({
  topic: example.topic,
  requiredConcepts: example.concepts,
}));

const BUREAUCRACY = /\b(zoning|council|permit|paperwork|application form|filing fee|hotline|car park|parking ticket|sponsor disclaimer|municipal|planning office)\b/i;
const WEIRD = /\b(portal|alternate|parallel|timeline|dimension|reality|duplicate|tomorrow's newspaper|time travel|two skies|gravity|oracle|glowing cube)\b/i;

const tokens = (value: string): string[] => value.toLowerCase().match(/[a-z0-9']+/g) ?? [];
const clampScore = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

function repeatedNgramRate(lines: string[], size = 4): number {
  const seen = new Set<string>();
  let total = 0;
  let repeats = 0;
  for (const line of lines) {
    const words = tokens(line);
    for (let i = 0; i <= words.length - size; i++) {
      const key = words.slice(i, i + size).join(" ");
      total++;
      if (seen.has(key)) repeats++;
      seen.add(key);
    }
  }
  return total ? repeats / total : 0;
}

export function evaluateDjTranscript(evalTopic: DjEvalTopic, turns: Turn[]): DjQualityScores {
  const djTurns = turns.filter((turn) => turn.hostId === "a" || turn.hostId === "b");
  const lines = djTurns.map((turn) => turn.text.trim()).filter(Boolean);
  const joined = ` ${tokens(lines.join(" ")).join(" ")} `;
  const notes: string[] = [];

  const topicTerms = Array.from(new Set([...tokens(evalTopic.topic), ...evalTopic.requiredConcepts.flatMap(tokens)]))
    .filter((word) => word.length > 3);
  const covered = topicTerms.filter((word) => joined.includes(` ${word} `));
  const conceptCoverage = topicTerms.length ? covered.length / topicTerms.length : 0;
  const topicAccuracy = clampScore(35 + conceptCoverage * 65);
  if (conceptCoverage < 0.45) notes.push(`Only ${covered.length}/${topicTerms.length} topic terms were covered.`);

  const averageWords = lines.length ? lines.reduce((sum, line) => sum + tokens(line).length, 0) / lines.length : 0;
  const questions = lines.filter((line) => line.includes("?")).length;
  const listenerLanguage = lines.filter((line) => /\b(you|we|us|listener)\b/i.test(line)).length;
  const lengthScore = averageWords >= 12 && averageWords <= 90 ? 45 : averageWords > 0 ? 25 : 0;
  const radioQuality = clampScore(lengthScore + Math.min(30, questions * 8) + Math.min(25, listenerLanguage * 5));
  if (radioQuality < 60) notes.push("The exchange needs stronger spoken-radio shape or listener contact.");

  const speakers = new Set(djTurns.map((turn) => turn.hostId));
  const directReaction = lines.slice(1).filter((line) => /\b(but|because|right|except|which|that|and)\b/i.test(line)).length;
  const personality = clampScore((speakers.size / 2) * 55 + Math.min(45, directReaction * 10));
  if (speakers.size < 2) notes.push("Only one DJ voice appeared.");

  const weirdTurns = lines.filter((line) => WEIRD.test(line)).length;
  const weirdRatio = lines.length ? weirdTurns / lines.length : 0;
  const allowedWeirdTurns = Math.max(1, Math.floor(lines.length / 4));
  const weirdnessControl = clampScore(
    weirdTurns <= allowedWeirdTurns
      ? 100
      : weirdRatio <= 0.4
        ? 75
        : weirdRatio <= 0.55
          ? 45
          : 15,
  );
  if (weirdTurns > allowedWeirdTurns) {
    notes.push(`Universe flavor occupied ${Math.round(weirdRatio * 100)}% of turns; target is 25% or less.`);
  }

  const repetitionRate = repeatedNgramRate(lines);
  const repeatedOpenings = new Set<string>();
  let openingRepeats = 0;
  for (const line of lines) {
    const opening = tokens(line).slice(0, 3).join(" ");
    if (opening && repeatedOpenings.has(opening)) openingRepeats++;
    repeatedOpenings.add(opening);
  }
  const repetitionControl = clampScore(100 - repetitionRate * 500 - openingRepeats * 12);
  if (repetitionControl < 75) notes.push("Repeated wording or turn openings are becoming audible.");

  const bureaucracyTurns = lines.filter((line) => BUREAUCRACY.test(line) && !BUREAUCRACY.test(evalTopic.topic)).length;
  const anchoredTurns = lines.filter((line) => topicTerms.some((term) => ` ${tokens(line).join(" ")} `.includes(` ${term} `))).length;
  const anchorRatio = lines.length ? anchoredTurns / lines.length : 0;
  const driftControl = clampScore(100 - bureaucracyTurns * 35 - Math.max(0, 0.55 - anchorRatio) * 100);
  if (bureaucracyTurns) notes.push(`${bureaucracyTurns} turn(s) fell into the old bureaucracy fallback.`);
  if (anchorRatio < 0.55) notes.push("Too many turns lacked a direct anchor to the requested topic.");

  const dimensions = [topicAccuracy, radioQuality, personality, weirdnessControl, repetitionControl, driftControl];
  const overall = clampScore(dimensions.reduce((sum, score) => sum + score, 0) / dimensions.length);
  return { topicAccuracy, radioQuality, personality, weirdnessControl, repetitionControl, driftControl, overall, notes };
}

export function auditDjConfig(config: Config) {
  const checks = [
    { name: "Producer pass enabled", pass: config.show.useProducer },
    { name: "Topic outline enabled", pass: config.show.useOutline },
    { name: "Structured run sheet enabled", pass: config.show.useRunSheet },
    { name: "Episode length is drift-resistant", pass: config.show.turns >= 12 && config.show.turns <= 30, detail: `${config.show.turns} turns` },
    {
      name: "Relationship uses the active DJ names",
      pass: config.hosts.every((host) => config.show.relationship.toLowerCase().includes(host.name.toLowerCase())),
    },
    {
      name: "DJ personas protect the topic",
      pass: config.hosts.every((host) => /topic|subject|argument|point|claim|question/i.test(`${host.persona} ${host.stance}`)),
    },
    {
      name: "Producer model can be separated",
      pass: Boolean(config.llm.producerModel),
      detail: config.llm.producerModel || "currently uses the DJ model",
    },
    { name: "Evaluation set contains 20 topics", pass: DJ_EVAL_TOPICS.length === 20, detail: `${DJ_EVAL_TOPICS.length} topics` },
  ];
  return { checks, passed: checks.filter((check) => check.pass).length, total: checks.length };
}
