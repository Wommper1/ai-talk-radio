/** Fine-tuning export assembled from royal examples and approved court lines. */

import { listDjFeedback, type DjTrainingRow } from "../memory/djfeedback.ts";
import { ORION_EXAMPLES } from "./examples.ts";

const KING_SYSTEM =
  "You are King Orion hosting the Night Court broadcast. You are calm, strategic, exact with canon names, " +
  "and frightening through enforceable consequences rather than shouting. Separate fact, inference, and plan.";
const MAEVE_SYSTEM =
  "You are Maeve, King Orion's chronicler and Night Court co-host. Clarify the record for the listener, " +
  "challenge hidden assumptions, use exact canon names, and hand the King one precise question.";

export function orionTrainingRows(): DjTrainingRow[] {
  const curated = ORION_EXAMPLES.flatMap((example, index): DjTrainingRow[] => [
    {
      id: `orion-curated-${index + 1}-king`,
      source: "curated",
      messages: [
        { role: "system", content: KING_SYSTEM },
        { role: "user", content: `Tonight's matter: ${example.topic}\nOpen or advance the broadcast.` },
        { role: "assistant", content: example.king },
      ],
    },
    {
      id: `orion-curated-${index + 1}-maeve`,
      source: "curated",
      messages: [
        { role: "system", content: MAEVE_SYSTEM },
        { role: "user", content: `Tonight's matter: ${example.topic}\nKing Orion: ${example.king}\nRespond as co-host.` },
        { role: "assistant", content: example.chronicler },
      ],
    },
  ]);

  const keepers = listDjFeedback()
    .filter((row) => row.lane === "court" && row.rating === "keeper")
    .map(
      (row): DjTrainingRow => ({
        id: `orion-keeper-${row.id}`,
        source: "keeper",
        messages: [
          {
            role: "system",
            content: /maeve/i.test(row.speaker) ? MAEVE_SYSTEM : `${KING_SYSTEM} Your on-air name is ${row.speaker}.`,
          },
          {
            role: "user",
            content: row.previousLine
              ? `Tonight's matter: ${row.topic}\nPrevious speaker: ${row.previousLine}\nRespond and advance the broadcast.`
              : `Tonight's matter: ${row.topic}\nOpen or advance the broadcast.`,
          },
          { role: "assistant", content: row.text },
        ],
      }),
    );

  return [...curated, ...keepers];
}

export function orionTrainingSplit(): { train: DjTrainingRow[]; evaluation: DjTrainingRow[] } {
  const rows = orionTrainingRows();
  return {
    train: rows.filter((_, index) => index % 10 !== 9),
    evaluation: rows.filter((_, index) => index % 10 === 9),
  };
}

export function orionTrainingReadiness() {
  const feedback = listDjFeedback().filter((row) => row.lane === "court");
  const keepers = feedback.filter((row) => row.rating === "keeper").length;
  const rejected = feedback.filter((row) => row.rating === "reject").length;
  return {
    curatedExchanges: ORION_EXAMPLES.length,
    curatedRows: ORION_EXAMPLES.length * 2,
    keepers,
    rejected,
    totalRows: ORION_EXAMPLES.length * 2 + keepers,
    minimumKeeperTarget: 500,
    readyForLora: keepers >= 500,
    reason:
      keepers >= 500
        ? "Enough reviewed Night Court lines exist for a controlled LoRA experiment."
        : `Collect ${500 - keepers} more reviewed Night Court keeper lines before training.`,
  };
}
