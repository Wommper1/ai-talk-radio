/** Ratings for individual DJ lines and export helpers for future fine-tuning. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StoredShow } from "../pipeline/store.ts";
import { DJ_EXAMPLES } from "../pipeline/djexamples.ts";

export type DjRating = "keeper" | "reject";
export type DjLane = "station" | "court";
export type DjFeedbackTag =
  | "great-point"
  | "funny"
  | "good-radio"
  | "in-character"
  | "off-topic"
  | "too-weird"
  | "flat"
  | "repetitive";

export const DJ_FEEDBACK_TAGS: DjFeedbackTag[] = [
  "great-point",
  "funny",
  "good-radio",
  "in-character",
  "off-topic",
  "too-weird",
  "flat",
  "repetitive",
];

export interface DjFeedback {
  id: string;
  showId: string;
  lineIndex: number;
  topic: string;
  speaker: string;
  hostId: string;
  text: string;
  previousLine: string;
  model: string;
  lane: DjLane;
  rating: DjRating;
  tags: DjFeedbackTag[];
  updatedAt: string;
}

export interface DjTrainingRow {
  id: string;
  source: "curated" | "keeper";
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

const FEEDBACK_PATH = path.join(process.cwd(), "memory", "dj-feedback.json");

function readAll(): DjFeedback[] {
  if (!fs.existsSync(FEEDBACK_PATH)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(FEEDBACK_PATH, "utf-8"));
    return Array.isArray(value) ? (value as DjFeedback[]) : [];
  } catch {
    return [];
  }
}

function writeAll(rows: DjFeedback[]): void {
  fs.mkdirSync(path.dirname(FEEDBACK_PATH), { recursive: true });
  const temp = `${FEEDBACK_PATH}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(rows, null, 2), "utf-8");
  fs.renameSync(temp, FEEDBACK_PATH);
}

export function listDjFeedback(): DjFeedback[] {
  return readAll().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function feedbackForShow(showId: string): DjFeedback[] {
  return listDjFeedback().filter((row) => row.showId === showId);
}

export function rateDjLine(
  show: StoredShow,
  lineIndex: number,
  rating: DjRating,
  requestedTags: unknown,
  lane: DjLane = "station",
): DjFeedback {
  const line = show.transcript[lineIndex];
  if (!line || (line.hostId !== "a" && line.hostId !== "b")) {
    throw new Error("Only DJ lines can be rated.");
  }

  const tags = Array.isArray(requestedTags)
    ? Array.from(
        new Set(
          requestedTags
            .map(String)
            .filter((tag): tag is DjFeedbackTag => DJ_FEEDBACK_TAGS.includes(tag as DjFeedbackTag)),
        ),
      )
    : [];
  const previous = show.transcript
    .slice(0, lineIndex)
    .reverse()
    .find((item) => item.hostId === "a" || item.hostId === "b" || item.hostId === "caller");
  const host = show.hosts.find((item) => item.id === line.hostId);

  const row: DjFeedback = {
    id: `${show.id}:${lineIndex}`,
    showId: show.id,
    lineIndex,
    topic: show.topic,
    speaker: line.speaker,
    hostId: line.hostId,
    text: line.text,
    previousLine: previous?.text ?? "",
    model: host?.model ?? show.models[0] ?? "",
    lane,
    rating,
    tags,
    updatedAt: new Date().toISOString(),
  };

  const rows = readAll().filter((item) => item.id !== row.id);
  rows.push(row);
  writeAll(rows);
  return row;
}

const SCHOOL_SYSTEM =
  "You are one half of a smart, funny live radio duo. Make a substantive point about the requested subject, " +
  "react to your co-host, and use at most one brief damaged-universe detail only when it clarifies the point.";

export function djTrainingRows(): DjTrainingRow[] {
  const curated = DJ_EXAMPLES.flatMap((example, index): DjTrainingRow[] => [
    {
      id: `curated-${index + 1}-a`,
      source: "curated",
      messages: [
        { role: "system", content: SCHOOL_SYSTEM },
        { role: "user", content: `Topic: ${example.topic}\nOpen with a clear, engaging point.` },
        { role: "assistant", content: example.hostA },
      ],
    },
    {
      id: `curated-${index + 1}-b`,
      source: "curated",
      messages: [
        { role: "system", content: SCHOOL_SYSTEM },
        { role: "user", content: `Topic: ${example.topic}\nCo-host: ${example.hostA}\nRespond and advance the argument.` },
        { role: "assistant", content: example.hostB },
      ],
    },
  ]);

  const keepers = readAll()
    .filter((row) => row.rating === "keeper" && row.lane !== "court")
    .map(
      (row): DjTrainingRow => ({
        id: `keeper-${row.id}`,
        source: "keeper",
        messages: [
          { role: "system", content: `${SCHOOL_SYSTEM} You are ${row.speaker}.` },
          {
            role: "user",
            content: row.previousLine
              ? `Topic: ${row.topic}\nCo-host: ${row.previousLine}\nRespond and advance the argument.`
              : `Topic: ${row.topic}\nOpen with a clear, engaging point.`,
          },
          { role: "assistant", content: row.text },
        ],
      }),
    );

  return [...curated, ...keepers];
}

export function djTrainingSplit(): { train: DjTrainingRow[]; evaluation: DjTrainingRow[] } {
  const rows = djTrainingRows();
  const evaluation = rows.filter((_, index) => index % 10 === 9);
  const train = rows.filter((_, index) => index % 10 !== 9);
  return { train, evaluation };
}

export function djTrainingReadiness() {
  const feedback = readAll();
  const station = feedback.filter((row) => row.lane !== "court");
  const keepers = station.filter((row) => row.rating === "keeper").length;
  const rejected = station.filter((row) => row.rating === "reject").length;
  const rows = djTrainingRows().length;
  return {
    curatedExchanges: DJ_EXAMPLES.length,
    curatedRows: DJ_EXAMPLES.length * 2,
    keepers,
    rejected,
    totalRows: rows,
    minimumKeeperTarget: 500,
    readyForLora: keepers >= 500,
    reason:
      keepers >= 500
        ? "Enough reviewed keeper lines exist for a first controlled LoRA experiment."
        : `Collect ${500 - keepers} more reviewed keeper lines before training.`,
  };
}

export function trainingJsonl(rows: DjTrainingRow[]): string {
  return rows.map((row) => JSON.stringify({ messages: row.messages, metadata: { id: row.id, source: row.source } })).join("\n") + "\n";
}
