/** Topic-aware recall from King Orion's previously saved broadcasts. */

import { listShows } from "../pipeline/store.ts";
import { listDjFeedback } from "../memory/djfeedback.ts";

const words = (value: string): Set<string> =>
  new Set((value.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((word) => word.length > 3));

function overlapScore(query: Set<string>, value: string): number {
  const haystack = words(value);
  return Array.from(query).filter((word) => haystack.has(word)).length;
}

export function courtBroadcastMemory(kingName: string, chroniclerName: string, topic: string, limit = 4): string {
  const query = words(topic);
  if (query.size === 0) return "";

  // Old court shows predate the canon guards and contain invented history.
  // Only a line the listener explicitly approved may return as memory.
  const keepers = listDjFeedback().filter((row) => row.lane === "court" && row.rating === "keeper");
  const keepersByShow = new Map<string, typeof keepers>();
  for (const keeper of keepers) {
    const rows = keepersByShow.get(keeper.showId) ?? [];
    rows.push(keeper);
    keepersByShow.set(keeper.showId, rows);
  }

  const minimumOverlap = Math.min(2, query.size);
  const courtShows = listShows()
    .filter((show) =>
      show.hosts.some((host) => host.name.toLowerCase() === kingName.toLowerCase()) &&
      keepersByShow.has(show.id),
    )
    .map((show, index) => ({
      show,
      score: overlapScore(
        query,
        `${show.topic} ${show.title} ${(keepersByShow.get(show.id) ?? []).map((row) => row.text).join(" ")}`,
      ),
      recency: index,
    }))
    .filter((entry) => entry.score >= minimumOverlap)
    .sort((a, b) => b.score - a.score || a.recency - b.recency)
    .slice(0, Math.max(0, limit));

  if (courtShows.length === 0) return "";

  const lines = [
    "MEMORY OF EARLIER BROADCASTS - what you said before, not proof that it happened:",
    "The live realm record outranks every line below. Recall these as opinions, promises, plans, or",
    "unfinished arguments. Never turn one into a battle, death, oath, or town unless the realm record confirms it.",
  ];

  for (const { show } of courtShows) {
    const matchingLines = (keepersByShow.get(show.id) ?? [])
      .map((line) => `${line.speaker}: ${line.text}`)
      .sort((a, b) => overlapScore(query, b) - overlapScore(query, a))
      .slice(0, 2);
    lines.push(
      "",
      `- ${show.createdAt.slice(0, 10)}, ${show.title}. Subject: ${show.topic}.`,
      ...matchingLines.map((line) => `  Listener-approved remembered line: ${line.slice(0, 280)}`),
    );
  }

  lines.push(
    "",
    `Use at most one useful callback. ${kingName} remembers his own promises; ${chroniclerName} remembers`,
    "the contradiction he would prefer to lose. Neither of you recaps an old episode for its own sake.",
  );
  return lines.join("\n");
}
