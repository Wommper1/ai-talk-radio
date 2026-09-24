/** Deterministic quality checks for King Orion and Maeve's Night Court. */

import type { Turn } from "../pipeline/conversation.ts";
import { realmPlaces, type Realm } from "./realm.ts";

export interface OrionQualityScores {
  canonGrounding: number;
  intelligence: number;
  menace: number;
  radioCraft: number;
  partnership: number;
  repetitionControl: number;
  overall: number;
  notes: string[];
}

const tokens = (value: string): string[] => value.toLowerCase().match(/[a-z0-9']+/g) ?? [];
const clamp = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

function includesAny(value: string, choices: string[]): boolean {
  const lower = value.toLowerCase();
  return choices.some((choice) => choice.length > 2 && lower.includes(choice.toLowerCase()));
}

function repeatedNgramRate(lines: string[], size = 4): number {
  const seen = new Set<string>();
  let total = 0;
  let repeated = 0;
  for (const line of lines) {
    const words = tokens(line);
    for (let index = 0; index <= words.length - size; index++) {
      const gram = words.slice(index, index + size).join(" ");
      total++;
      if (seen.has(gram)) repeated++;
      seen.add(gram);
    }
  }
  return total ? repeated / total : 0;
}

export function evaluateOrionTranscript(
  topic: string,
  turns: Turn[],
  realm: Realm,
  kingName = "King Orion",
  chroniclerName = "Maeve",
): OrionQualityScores {
  const courtTurns = turns.filter((turn) => turn.hostId === "a" || turn.hostId === "b");
  const lines = courtTurns.map((turn) => turn.text.trim()).filter(Boolean);
  const notes: string[] = [];

  const anchors = Array.from(new Set([
    ...realmPlaces(realm),
    ...realm.npcs.map((npc) => npc.name),
    ...realm.guild.map((member) => member.name),
    ...realm.quests.flatMap((quest) => [quest.name, quest.location]),
    ...(realm.save?.inventory ?? []),
    realm.save?.equippedWeapon ?? "",
    realm.save?.equippedArmor ?? "",
    "Wommper",
    "Respawn Guild",
  ].filter(Boolean)));

  const groundedTurns = lines.filter((line) => includesAny(line, anchors)).length;
  const distinctAnchors = anchors.filter((anchor) => includesAny(lines.join(" "), [anchor])).length;
  const topicTerms = tokens(topic).filter((word) => word.length > 3);
  const topicalTurns = lines.filter((line) => includesAny(line, topicTerms)).length;
  const recordText = [
    realm.save?.journal ?? "",
    ...realm.events.map((event) => event.description),
    ...realm.quests.map((quest) => quest.description),
  ].join(" ").toLowerCase();
  const unsupportedHistoryTerms = [
    "rebellion", "uprising", "siege", "famine", "winter", "bloodshed", "granary", "granaries",
    "reclaimed", "quelled", "widow", "villager", "tax collector", "loyalist",
  ].filter((term) => lines.some((line) => line.toLowerCase().includes(term)) && !recordText.includes(term));
  const knownPlaces = realmPlaces(realm).map((place) => place.toLowerCase());
  const knownPeople = new Set([
    "wommper",
    "wommper1",
    kingName.toLowerCase(),
    chroniclerName.toLowerCase(),
    ...realm.npcs.map((npc) => npc.name.toLowerCase()),
    ...realm.guild.map((member) => member.name.toLowerCase()),
  ]);
  const unknownPlaces = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/\b(?:in|at|from|through|near|outside|into|across)\s+(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/g)) {
      const place = match[1].trim();
      const lower = place.toLowerCase();
      if (!knownPeople.has(lower) && !knownPlaces.some((known) => known.includes(lower))) unknownPlaces.add(place);
    }
  }
  const canonGrounding = clamp(
    10 + Math.min(45, groundedTurns * 7) + Math.min(25, distinctAnchors * 4) + Math.min(20, topicalTurns * 4) -
      unsupportedHistoryTerms.length * 25 - unknownPlaces.size * 30,
  );
  if (groundedTurns < Math.ceil(lines.length / 3)) {
    notes.push(`Only ${groundedTurns}/${lines.length} turns used a recorded person, place, quest, or object.`);
  }
  if (unsupportedHistoryTerms.length) notes.push(`Unsupported history appeared: ${unsupportedHistoryTerms.join(", ")}.`);
  if (unknownPlaces.size) notes.push(`Unrecorded place names appeared: ${Array.from(unknownPlaces).join(", ")}.`);

  const evidenceTurns = lines.filter((line) => /\b(fact|record|recorded|evidence|know|known|confirmed|account)\b/i.test(line)).length;
  const uncertaintyTurns = lines.filter((line) => /\b(infer|inference|suspect|unknown|uncertain|rumou?r|may|might|if)\b/i.test(line)).length;
  const strategyTurns = lines.filter((line) => /\b(plan|order|watch|send|learn|find|cost|option|leverage|because|therefore|next)\b/i.test(line)).length;
  const explicitHierarchy = lines.some((line) => /\bfact\b/i.test(line)) &&
    lines.some((line) => /\b(inference|infer|suspect)\b/i.test(line)) &&
    lines.some((line) => /\b(plan|intend|order)\b/i.test(line));
  const intelligence = clamp(
    15 + Math.min(25, evidenceTurns * 7) + Math.min(20, uncertaintyTurns * 7) +
      Math.min(25, strategyTurns * 5) + (explicitHierarchy ? 15 : 0),
  );
  if (intelligence < 65) notes.push("The court needs more audible evidence, uncertainty, and strategic consequence.");

  const threatTurns = lines.filter((line) => /\b(consequence|gate|road|command|order|sentence|dawn|deny|close|watch|take|answer|punish|crown)\b/i.test(line)).length;
  const conditionalThreats = lines.filter((line) => /\b(if|unless|when|by dawn|will not|shall not)\b/i.test(line)).length;
  const selfDeclared = lines.filter((line) => /\b(i am|i'm) (?:so )?(powerful|ruthless|terrifying|feared|scary|merciless)\b/i.test(line)).length;
  const shouting = lines.filter((line) => /!/.test(line) || /\b[A-Z]{5,}\b/.test(line)).length;
  const menace = clamp(30 + Math.min(40, threatTurns * 7) + Math.min(25, conditionalThreats * 6) - selfDeclared * 30 - shouting * 8);
  if (threatTurns < 2) notes.push("Orion needs more concrete, enforceable consequences rather than atmosphere alone.");
  if (selfDeclared) notes.push("Orion announced that he was frightening instead of demonstrating it.");

  const listenerTurns = lines.filter((line) => /\b(listener|listeners|you listening|beyond (?:this|the) hall|on air|broadcast|tonight|stay with us)\b/i.test(line)).length;
  const questions = lines.filter((line) => line.includes("?")).length;
  const handoffs = lines.filter((line) => includesAny(line, [kingName, chroniclerName])).length;
  const averageWords = lines.length ? lines.reduce((sum, line) => sum + tokens(line).length, 0) / lines.length : 0;
  const spokenLength = averageWords >= 12 && averageWords <= 85 ? 25 : averageWords > 0 ? 12 : 0;
  const radioCraft = clamp(spokenLength + Math.min(30, listenerTurns * 8) + Math.min(25, questions * 6) + Math.min(20, handoffs * 5));
  if (radioCraft < 65) notes.push("The exchange needs more listener contact, questions, or named handoffs.");

  const kingTurns = courtTurns.filter((turn) => turn.hostId === "a").length;
  const chroniclerTurns = courtTurns.filter((turn) => turn.hostId === "b").length;
  const balance = courtTurns.length ? Math.min(kingTurns, chroniclerTurns) / Math.max(kingTurns, chroniclerTurns, 1) : 0;
  const reactions = lines.slice(1).filter((line) => /\b(but|because|then|except|good|no|yes|that|which|question)\b/i.test(line)).length;
  const challenges = courtTurns.filter((turn) => turn.hostId === "b" && /\b(but|yet|except|question|cost|record|what|why|how|who)\b/i.test(turn.text)).length;
  const partnership = clamp(balance * 45 + Math.min(30, reactions * 6) + Math.min(25, challenges * 8));
  if (partnership < 65) notes.push("Maeve needs to challenge, clarify, and advance Orion rather than merely acknowledge him.");

  const repetitionRate = repeatedNgramRate(lines);
  const openingSet = new Set<string>();
  let repeatedOpenings = 0;
  for (const line of lines) {
    const opening = tokens(line).slice(0, 3).join(" ");
    if (opening && openingSet.has(opening)) repeatedOpenings++;
    openingSet.add(opening);
  }
  const stageDirections = lines.filter((line) => /\*[^*]+\*|\[[^\]]+\]|\([^)]*(?:voice|pause|laugh|leans|whisper)[^)]*\)/i.test(line)).length;
  const repetitionControl = clamp(100 - repetitionRate * 500 - repeatedOpenings * 12 - stageDirections * 25);
  if (repetitionControl < 75) notes.push("Repeated phrasing, openings, or stage directions are becoming audible.");

  const dimensions = [canonGrounding, intelligence, menace, radioCraft, partnership, repetitionControl];
  const overall = clamp(dimensions.reduce((sum, score) => sum + score, 0) / dimensions.length);
  return { canonGrounding, intelligence, menace, radioCraft, partnership, repetitionControl, overall, notes };
}
