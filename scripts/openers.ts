/**
 * Make the opening packs, ahead of time.
 *
 *   npm run openers            make three more packs
 *   npm run openers -- 5       make five
 *   npm run openers -- list    what is on the shelf
 *   npm run openers -- clear   throw the shelf away
 *
 * This is the only thing in the project that calls a model to make an opener,
 * and it never runs during a show. Everything it produces is audio on disk, so
 * pressing Start plays a file instead of starting a queue of round trips.
 *
 * The commercial is written about people the realm actually has — the ones on
 * the character sheet — because an advert naming somebody you met last Tuesday
 * is funnier than one naming nobody, and because the codex exists precisely so
 * both halves of this project know the same people.
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../server/config.ts";
import { generate, looksLikeToolCall } from "../server/providers/llm.ts";
import { renderBreak, type AdBreak } from "../server/pipeline/ads.ts";
import { readRealm } from "../server/orion/realm.ts";
import { durationOf, encodeWav } from "../server/audio/wav.ts";
import {
  OPENERS_DIR,
  addPreroll,
  forgetPreroll,
  listPrerolls,
  type Preroll,
} from "../server/pipeline/preroll.ts";
import { coldOpenScript, renderRockImaging } from "../server/pipeline/coldopen.ts";

const config = loadConfig();

/** Built from code points so no shell heredoc can eat the escape. */
const BLANK = String.fromCharCode(10, 10);
const args = process.argv.slice(2);

if (args[0] === "list") {
  const packs = listPrerolls();
  if (packs.length === 0) {
    console.log("The shelf is empty. Run `npm run openers` to make some.");
  } else {
    for (const pack of packs) {
      console.log(
        `${pack.id}  ${String(pack.plays).padStart(2)} play(s)  ` +
          `${pack.openSeconds.toFixed(0)}s + ${pack.adSeconds.toFixed(0)}s  ${pack.about}`,
      );
    }
  }
  process.exit(0);
}

if (args[0] === "clear") {
  forgetPreroll();
  console.log("Shelf emptied.");
  process.exit(0);
}

const wanted = Math.max(1, Math.min(12, Number(args[0]) || 3));

/* ── Who the town has ─────────────────────────────────────────────── */

const realm = readRealm(config.orion.realmPath);
const townsfolk = realm.npcs
  .map((n) => [n.name, n.location].filter(Boolean).join(" of "))
  .filter(Boolean);
const places = realm.locations.map((l) => l.name).filter(Boolean);

console.log(
  `${townsfolk.length} people and ${places.length} places on the character sheet.` +
    (townsfolk.length === 0 ? " The adverts will have to invent their own." : ""),
);

const CAST = townsfolk.length > 0
  ? `Real people in this town, and you must use at least one of them by name:\n${townsfolk.map((t) => `- ${t}`).join("\n")}`
  : "";

const PLACES = places.length > 0 ? `Real places: ${places.join(", ")}.` : "";

/* ── What they are for ────────────────────────────────────────────── */

/**
 * What each advert is selling.
 *
 * Naming Rick and Morty's Interdimensional Cable in the brief as a *style*
 * reference backfired immediately: all three packs in the first batch opened
 * with the words "Welcome to Interdimensional Cable!" because the model took
 * it as the product. The style stays; the business is assigned, and it is a
 * different one every time.
 */
const BUSINESSES = [
  "a funeral home that also does weddings, and does not see why that is a problem",
  "a dentist who advertises on the radio at two in the afternoon for reasons nobody has explained",
  "a haulage firm that moves things between timelines and is very casual about what",
  "a discount armoury run by somebody who clearly cannot count",
  "an insurance company whose exclusions are all suspiciously specific",
  "a staffing agency that supplies replacements for people, broadly defined",
  "a restaurant with one dish and a great deal of confidence about it",
  "a laundry that has started offering a service it is not licensed for",
  "a driving school in a place with no roads",
  "a storage facility where the units have started asking questions",
  "a matchmaking service that works across parallel versions of the same person",
  "a pest control outfit whose definition of pest has expanded lately",
  "a shop that sells replacement childhoods with free installation while you wait",
  "a weather service that repossesses forecasts when invoices are late",
  "a mattress store whose beds remember everybody who has ever slept in them",
  "a legal firm specialising in crimes you have not committed yet",
  "a pharmacy that dispenses side effects first and medicine later",
  "a repair shop for souls, warranties, toasters, and one forbidden hallway",
];

const AD_BRIEF =
  "Write a sixty-second radio commercial. That is roughly a hundred and forty words, so it has room " +
  "to build, go wrong, and keep going.\n" +
  "\n" +
  "THE STYLE IS LATE-NIGHT INTERDIMENSIONAL CABLE. Do NOT call the business that, do not sell cable " +
  "television, and do not name any existing TV characters — you are selling the business named below:\n" +
  "- A business that should not exist, advertised with total commercial confidence by somebody who " +
  "sees nothing strange about it at all.\n" +
  "- The joke is never that it is weird. The joke is that it is ordinary — it has opening hours, a " +
  "returns policy, a financing option, an employee of the month.\n" +
  "- Start from a boring real advert shape, then let one wrong detail infect the whole read: a coupon, " +
  "a car park, a waiting room, a loyalty card, a branch manager, a refund desk.\n" +
  "- Include one hard left turn that sounds like it came from a different advert, then keep selling " +
  "as though it obviously belonged there.\n" +
  "- Something goes badly wrong partway through and the read does not stop. Nobody acknowledges it.\n" +
  "- Non-sequiturs are good. A detail nobody asked for is better.\n" +
  "- It never quite explains what the product is.\n" +
  "\n" +
  "RULES:\n" +
  "- Use at least one real person from the list by name, and say something specific about them.\n" +
  "- It is a multiverse: other versions of people, other timelines, a branch office in a worse one.\n" +
  "- Spoken words only. No stage directions, no speaker labels, no sound cues, no quotation marks.\n" +
  "- One voice, reading straight through.";

async function write(brief: string, extra = ""): Promise<string> {
  const raw = await generate(config.llm, {
    messages: [
      {
        role: "system",
        content:
          `You write for ${config.show.station}, a local radio station. You have no tools and no ` +
          "functions. Everything you write is words a person says out loud into a microphone. " +
          "Never output JSON, labels, or stage directions.",
      },
      { role: "user", content: [brief, extra, CAST, PLACES].filter(Boolean).join(BLANK) },
    ],
    temperature: Math.min(1.15, config.llm.temperature + 0.15),
    maxTokens: 600,
    signal: undefined,
  });

  if (looksLikeToolCall(raw)) throw new Error("the model answered with a tool call");

  return raw;
}

/**
 * Clean one piece of copy and cut it to length.
 *
 * The role token is the one that bit. An empty assistant prefill — added to
 * stop a Llama-family model answering with a schema — made this model emit the
 * literal word "assistant" as the first word of every open and every advert,
 * and the announcer read it out. The prefill is gone; this strips the token
 * anyway, because the next model may well do the same thing.
 */
function tidy(raw: string, maxWords = 0): string {
  let text = String(raw ?? "")
    .replace(/^\s*(?:assistant|system|user)\b[:,]?\s*/i, "")
    .replace(/^\s*(?:announcer|voice ?over|vo|narrator)\s*:\s*/gim, "")
    .replace(/\*+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // An unmatched opening quote, which a speech engine reads as a change of
  // tone that never comes back.
  if (((text.match(/"/g) ?? []).length) % 2 === 1) text = text.replace(/"/g, "");
  text = text.replace(/^["']|["']$/g, "").trim();

  return maxWords > 0 ? cutToSentence(text, maxWords) : text;
}

/**
 * Trim to a word budget, ending on a full stop.
 *
 * The model ignores "sixty seconds" and "roughly a hundred and forty words"
 * completely — the first batch came back at 256 words and rendered at 98
 * seconds against a 60 second brief. Asking is not enough. This is the part
 * that actually decides how long the commercial is.
 */
function cutToSentence(text: string, maxWords: number): string {
  const words = text.split(" ");
  if (words.length <= maxWords) return text;

  const cut = words.slice(0, maxWords).join(" ");
  const stop = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  return stop > cut.length * 0.5 ? cut.slice(0, stop + 1) : `${cut.trim()}.`;
}

/** Render one piece of copy through the station's own advert chain. */
async function render(text: string, sponsor: string, outPath: string, seed: number) {
  const brk: AdBreak = {
    index: 0,
    spots: [{ kind: "produced", sponsor, lines: [{ voice: "announcer", text }] }],
  };
  const audio = await renderBreak(config, brk, outPath, seed, undefined, { shelve: false });
  fs.writeFileSync(outPath, encodeWav(audio));
  return durationOf(audio);
}

/* ── Make them ────────────────────────────────────────────────────── */

fs.mkdirSync(OPENERS_DIR, { recursive: true });

let made = 0;

for (let i = 0; i < wanted; i++) {
  const id = `pack-${Date.now().toString(36)}-${i}`;
  const seed = Date.now() + i * 7919;

  try {
    process.stdout.write(`\n${id}\n  writing the open... `);
    // The station identity is not delegated to a model. Old generated packs
    // invented new station names, towns and presenters, then cached the lie.
    const openText = coldOpenScript(config, "");
    if (openText.length < 20) throw new Error("the open came back empty");
    console.log(`${openText.split(/\s+/).length} words`);
    console.log(`    ${openText}`);

    process.stdout.write("  writing the commercial... ");
    const business = BUSINESSES[(listPrerolls().length + i) % BUSINESSES.length];
    const adText = tidy(await write(AD_BRIEF, `THE BUSINESS TONIGHT IS: ${business}`), 155);
    if (adText.length < 80) throw new Error("the commercial came back too short");
    console.log(`${adText.split(/\s+/).length} words`);
    console.log(`    ${adText.slice(0, 150)}...`);

    process.stdout.write("  rendering... ");
    const openFile = `${id}-open.wav`;
    const adFile = `${id}-ad.wav`;
    const openAudio = await renderRockImaging(
      config,
      openText,
      path.join(OPENERS_DIR, openFile),
      { seed, intro: 3.8, outro: 3.2, rateBoost: 2.5 },
    );
    if (!openAudio) throw new Error("the station opener could not be rendered");
    const openSeconds = durationOf(openAudio);
    const adSeconds = await render(adText, "Commercial", path.join(OPENERS_DIR, adFile), seed + 1);
    console.log(`${openSeconds.toFixed(1)}s + ${adSeconds.toFixed(1)}s`);

    // And the breaks for the rest of the show. Four of three spots is eleven
    // fresh generations during a show, which is more model time than the
    // opening record covers -- and a radio advert has nothing to do with
    // tonight's subject, so there was never a reason to write them then.
    const wantedBreaks = Math.max(0, Math.min(8, config.ads.breaks));
    const breaks: Array<{ text: string; file: string; seconds: number }> = [];

    for (let b = 0; b < wantedBreaks; b++) {
      process.stdout.write(`  break ${b + 1} of ${wantedBreaks}... `);
      const spot = BUSINESSES[(listPrerolls().length * 3 + i + b + 1) % BUSINESSES.length];
      const text = tidy(await write(AD_BRIEF, `THE BUSINESS TONIGHT IS: ${spot}`), 130);
      if (text.length < 60) {
        console.log("came back too short, skipped");
        continue;
      }
      const file = `${id}-break-${b}.wav`;
      const seconds = await render(text, "Commercial", path.join(OPENERS_DIR, file), seed + 100 + b);
      breaks.push({ text, file, seconds: Number(seconds.toFixed(2)) });
      console.log(`${seconds.toFixed(0)}s`);
    }

    // Who it is about, for the shelf listing.
    // Prefer an ordinary townsperson over the King, who is on every sheet and
    // was winning this match every time purely by being listed first.
    const mentions = townsfolk.filter((t) => adText.toLowerCase().includes(t.split(" of ")[0].toLowerCase()));
    const named = mentions.find((t) => !/orion|king/i.test(t)) ?? mentions[0];

    const pack: Preroll = {
      id,
      madeAt: new Date().toISOString(),
      plays: 0,
      station: config.show.station,
      imagingVersion: 2,
      about: named ? named.split(" of ")[0] : "nobody in particular",
      openText,
      openFile,
      openSeconds: Number(openSeconds.toFixed(2)),
      adText,
      adFile,
      adSeconds: Number(adSeconds.toFixed(2)),
      breaks,
    };

    addPreroll(pack);
    made += 1;
  } catch (err) {
    console.log(`\n  skipped: ${(err as Error).message}`);
  }
}

console.log(`\n${made} of ${wanted} packs made. ${listPrerolls().length} on the shelf.`);
if (made > 0) {
  console.log("Pressing Start now plays audio straight off disk while the show is being written.");
}
