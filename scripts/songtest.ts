/**
 * Checks the pieces added for the record and the repetition guards, none of
 * which need a model or a speech engine.
 *
 *   npm run songtest
 */

import { speakable } from "../server/providers/tts.ts";
import { titleFromFilename, songIntroScript, songLabel } from "../server/pipeline/songs.ts";
import { overusedImages, repeatsImage, memoryBlock } from "../server/pipeline/showrunner.ts";
import type { Turn } from "../server/pipeline/conversation.ts";
import { loadConfig } from "../server/config.ts";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${e}\n        got      ${a}`);
}

console.log("\nPronunciation\n");
check("a name ending in a digit", speakable("Wommper1"), "Wommper one");
check("inside a sentence", speakable("Brought to you by Wommper1."), "Brought to you by Wommper one.");
check("two digits", speakable("Studio12"), "Studio one two");
check("a real number is left alone", speakable("It cost 20 pounds in 2026."), "It cost 20 pounds in 2026.");
check("ordinary words untouched", speakable("Bootleg Spoon sells used bridges."), "Bootleg Spoon sells used bridges.");

console.log("\nFilenames\n");
check("artist and title", titleFromFilename("Aphex Twin - Xtal.mp3"), { artist: "Aphex Twin", title: "Xtal" });
check("a track number is filing, not a name", titleFromFilename("04 - Boards of Canada - Roygbiv.mp3"), {
  artist: "Boards of Canada",
  title: "Roygbiv",
});
check("underscores", titleFromFilename("my_demo_track.wav"), { artist: "", title: "my demo track" });

console.log("\nThe throw to the record\n");
const config = loadConfig();
const withSong = {
  ...config,
  show: { ...config.show, openingSong: { ...config.show.openingSong, title: "", artist: "" } },
};
const script = songIntroScript(withSong, "whether hotel breakfast is worth it", "Aphex Twin - Xtal.mp3");
console.log(`        "${script}"`);
check("names the station", script.includes(withSong.show.station), true);
check("teases the topic", script.includes("hotel breakfast"), true);
check("promises to come back", /right back/i.test(script), true);
check("names the record", script.includes("Xtal"), true);
check("credits the artist", script.includes("Aphex Twin"), true);
check("labelled for the feed", songLabel(withSong, "Aphex Twin - Xtal.mp3"), "Xtal — Aphex Twin");

console.log("\nRepetition\n");
const turn = (index: number, text: string): Turn => ({ index, hostId: index % 2 ? "b" : "a", speaker: "x", text });

const dumpster: Turn[] = [
  turn(0, "It smells like the dumpster behind a restaurant, honestly."),
  turn(1, "Everything smells like a dumpster to you."),
  turn(2, "That dumpster comparison is doing a lot of work tonight."),
];
const topic = "whether hotel breakfast is worth the extra cost";

check(
  "a worn image is offered up",
  overusedImages(dumpster, topic, ["Marco", "Dee"]).includes("dumpster"),
  true,
);
check(
  "the fourth time is caught",
  repeatsImage("Back to the dumpster, then.", dumpster, topic, ["Marco", "Dee"]),
  "dumpster",
);
check(
  "a fresh line is not",
  repeatsImage("The croissants were fine, actually.", dumpster, topic, ["Marco", "Dee"]),
  null,
);
check(
  "the topic's own words are never flagged",
  repeatsImage(
    "Breakfast is breakfast.",
    [turn(0, "breakfast breakfast"), turn(1, "breakfast again"), turn(2, "still breakfast")],
    topic,
    ["Marco", "Dee"],
  ),
  null,
);
check(
  "a host's name is never flagged",
  repeatsImage(
    "Marco, come on.",
    [turn(0, "Marco please"), turn(1, "Marco again"), turn(2, "Marco, honestly")],
    topic,
    ["Marco", "Dee"],
  ),
  null,
);

console.log("\nRunning bits\n");
const memory = { digest: "", facts: [], gags: ["the smelly dumpster"], covered: [] };
check(
  "off a callback beat, they are a do-not-repeat list",
  memoryBlock(memory, "Marco").includes("must not say"),
  true,
);
check(
  "on a callback beat, exactly one is offered",
  memoryBlock(memory, "Marco", true).includes("pick ONE"),
  true,
);

console.log(failures === 0 ? "\nAll good.\n" : `\n${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
