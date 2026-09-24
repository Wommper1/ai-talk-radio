/**
 * Writing one commercial, wherever the request comes from.
 *
 * This used to live entirely inside scripts/commercials.ts, which was fine
 * while a person running a batch was the only way spots got made. The bucket
 * now tops itself up after a show as well, and the server cannot import a
 * script that calls process.exit, so the part that actually makes a spot lives
 * here and both callers use it.
 *
 * Everything about tone, the three sources and the cleaning rules is in here.
 * The script is a command line over it; the server's top-up is a loop over it.
 */

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { generate, looksLikeToolCall } from "../providers/llm.ts";
import { renderBreak, type AdBreak } from "./ads.ts";
import { readRealm, realmPlaces, realmSummary, type Realm } from "../orion/realm.ts";
import { durationOf } from "../audio/wav.ts";
import { BUCKET_DIR, addSpot, listBucket, type BucketSpot, type SpotSource } from "./bucket.ts";

const BLANK = String.fromCharCode(10, 10);
const HISTORY_PATH = path.join(BUCKET_DIR, "history.json");
const BRAIN_PATH = path.join(BUCKET_DIR, "brain.json");

/** Businesses that should not exist. The multiverse register. */
export const MULTIVERSE = [
  "a funeral home that also does weddings, and does not see why that is a problem",
  "a dentist advertising at two in the afternoon for reasons nobody has explained",
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
  "a bank that will hold your memories as collateral",
  "a taxidermist branching out into something adjacent and much worse",
  "a gym whose equipment is from a timeline with different physics",
  "a locksmith who is extremely relaxed about whose door it is",
  "a shop that sells replacement childhoods with free installation while you wait",
  "a weather service that repossesses forecasts when invoices are late",
  "a mattress store whose beds remember everybody who has ever slept in them",
  "a legal firm specialising in crimes you have not committed yet",
  "a pet shop for animals that are technically municipal infrastructure",
  "a pharmacy that dispenses side effects first and medicine later",
  "a travel agent booking holidays inside other people's family arguments",
  "a theme park where every ride is a different version of the same accident",
  "a repair shop for souls, warranties, toasters, and one forbidden hallway",
  "a grocery store where produce negotiates its own price at checkout",
];

/** Trades a realm at war actually supports. */
export const REALM_TRADERS = [
  { name: "Grumwald's Reanimation Services", product: "getting your people back on their feet, mostly" },
  { name: "The Toll House at the Sunken Ford", product: "safe passage, and a receipt" },
  { name: "Bristle & Bone, Apothecaries", product: "tonics, poultices and one thing they will not name" },
  { name: "Hollowmere Insurance", product: "cover against fire, siege, and coming back wrong" },
  { name: "Ferryman & Sons", product: "one crossing, one way, no refunds" },
  { name: "The Greyditch Salvage Company", product: "everything left standing after a fire, cheap" },
  { name: "Marrow's Reliable Mercenaries", product: "men who will fight for you until the money stops" },
  { name: "The Hanged Man", product: "a bed, a bath, and no questions at all" },
  { name: "Wildlands Cartography", product: "maps, updated whenever somebody survives a road" },
  { name: "Cinderhold Ironworks", product: "blades, hinges, and cages built to a royal standard" },
  { name: "Widow Ash's Debt Collection", product: "recovering what is owed to the Crown" },
  { name: "The Respawn Guild Surplus Store", product: "gear off travellers who did not need it any more" },
];

export const STYLE =
  "THE STYLE IS LATE-NIGHT INTERDIMENSIONAL CABLE:\n" +
  "- Advertised with total commercial confidence by somebody who sees nothing strange about it.\n" +
  "- The joke is never that it is weird. The joke is that it is ordinary: opening hours, a returns\n" +
  "  policy, financing, an employee of the month, a branch manager with a badge.\n" +
  "- The reader treats impossible, unsafe, or emotionally catastrophic details as normal sales copy.\n" +
  "- Something goes badly wrong partway through and the read does not stop. Nobody acknowledges it.\n" +
  "- Non-sequiturs are good. A detail nobody asked for is better.\n" +
  "- It never quite explains what the product actually is.\n" +
  "- Do not name or imitate any existing TV characters. This is its own cursed local cable universe.";

export const MULTIVERSE_BRAIN =
  "THE WACKER MULTIVERSE COMMERCIAL BRAIN:\n" +
  "- Start from a boring real advert shape, then let one wrong detail infect the whole read.\n" +
  "- The wrongest detail should be mundane: a coupon, a car park, a waiting room, a loyalty card,\n" +
  "  a badly named manager, a delivery window, a refund desk, an employee birthday.\n" +
  "- Include one hard left turn that sounds like a sentence from a completely different advert, then\n" +
  "  keep selling as though it obviously belonged there.\n" +
  "- Make the business sound local even when it is selling across dimensions: name a strip mall, a\n" +
  "  branch office, a loading bay, a hotline, a form, a fee.\n" +
  "- Let the reader be too specific in a way that raises more questions than it answers.\n" +
  "- No lore dump. No explaining the multiverse. Sell the thing like the listener already lives there.";

export const RULES =
  "RULES:\n" +
  "- Spoken words only. No stage directions, no speaker labels, no sound cues, no quotation marks.\n" +
  "- One voice, reading straight through.\n" +
  "- Roughly a hundred and thirty words, which is about a minute on air.";

export interface Brief {
  source: SpotSource;
  sponsor: string;
  prompt: string;
}

export interface CommercialBrain {
  activeId: string;
  versions: CommercialBrainVersion[];
  active: CommercialBrainVersion;
  style: string;
  multiverseBrain: string;
  rules: string;
  multiverseSeeds: string[];
  realmTraders: typeof REALM_TRADERS;
  sampleBriefs: Record<SpotSource, Brief>;
}

export interface CommercialBrainVersion {
  id: string;
  name: string;
  created: string;
  style: string;
  multiverseBrain: string;
  rules: string;
  multiverseSeeds: string[];
  realmTraders: typeof REALM_TRADERS;
}

interface BrainFile {
  version: 1;
  activeId: string;
  versions: CommercialBrainVersion[];
}

export interface CommercialAttempt {
  id: string;
  at: string;
  status: "started" | "made" | "fallback" | "failed";
  source: SpotSource;
  sponsor: string;
  model: string;
  brainVersion: string;
  prompt: string;
  error?: string;
  text?: string;
  spotId?: string;
}

interface HistoryFile {
  version: 1;
  attempts: CommercialAttempt[];
}

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function defaultBrainVersion(): CommercialBrainVersion {
  return {
    id: "default",
    name: "Default Wacker Cable",
    created: "built-in",
    style: STYLE,
    multiverseBrain: MULTIVERSE_BRAIN,
    rules: RULES,
    multiverseSeeds: MULTIVERSE.slice(),
    realmTraders: REALM_TRADERS.slice(),
  };
}

function normaliseBrainVersion(input: Partial<CommercialBrainVersion>, fallback = defaultBrainVersion()): CommercialBrainVersion {
  const seeds = Array.isArray(input.multiverseSeeds)
    ? input.multiverseSeeds.map((seed) => String(seed).trim()).filter(Boolean)
    : fallback.multiverseSeeds;
  const traders = Array.isArray(input.realmTraders)
    ? input.realmTraders
        .map((trader) => ({
          name: String(trader?.name ?? "").trim(),
          product: String(trader?.product ?? "").trim(),
        }))
        .filter((trader) => trader.name && trader.product)
    : fallback.realmTraders;

  return {
    id: String(input.id || fallback.id || `brain-${Date.now().toString(36)}`).trim().replace(/[^a-zA-Z0-9_-]/g, "-"),
    name: String(input.name || fallback.name || "Commercial Brain").trim(),
    created: String(input.created || fallback.created || new Date().toISOString()),
    style: String(input.style || fallback.style || STYLE).trim(),
    multiverseBrain: String(input.multiverseBrain || fallback.multiverseBrain || MULTIVERSE_BRAIN).trim(),
    rules: String(input.rules || fallback.rules || RULES).trim(),
    multiverseSeeds: seeds.length ? seeds.slice(0, 80) : fallback.multiverseSeeds,
    realmTraders: traders.length ? traders.slice(0, 40) : fallback.realmTraders,
  };
}

function readBrainFile(): BrainFile {
  const fallback = defaultBrainVersion();
  try {
    const raw = JSON.parse(fs.readFileSync(BRAIN_PATH, "utf8")) as BrainFile;
    const versions = Array.isArray(raw.versions)
      ? raw.versions.map((version) => normaliseBrainVersion(version, fallback))
      : [];
    if (versions.length) {
      const activeId = versions.some((version) => version.id === raw.activeId) ? raw.activeId : versions[0].id;
      return { version: 1, activeId, versions };
    }
  } catch {
    // The built-in version is a complete commercial brain.
  }
  return { version: 1, activeId: fallback.id, versions: [fallback] };
}

function writeBrainFile(file: BrainFile): void {
  fs.mkdirSync(BUCKET_DIR, { recursive: true });
  const temporary = `${BRAIN_PATH}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
  fs.renameSync(temporary, BRAIN_PATH);
}

export function activeBrainVersion(): CommercialBrainVersion {
  const file = readBrainFile();
  return file.versions.find((version) => version.id === file.activeId) ?? file.versions[0] ?? defaultBrainVersion();
}

export function saveCommercialBrain(input: Partial<CommercialBrainVersion>): CommercialBrainVersion {
  const file = readBrainFile();
  const base = input.id ? file.versions.find((version) => version.id === input.id) : undefined;
  const version = normaliseBrainVersion(
    {
      ...base,
      ...input,
      id: input.id || `brain-${Date.now().toString(36)}`,
      created: input.created || base?.created || new Date().toISOString(),
    },
    base ?? activeBrainVersion(),
  );
  const versions = file.versions.filter((existing) => existing.id !== version.id);
  versions.push(version);
  writeBrainFile({ version: 1, activeId: version.id, versions: versions.slice(-12) });
  return version;
}

export function activateCommercialBrain(id: string): CommercialBrainVersion {
  const file = readBrainFile();
  const active = file.versions.find((version) => version.id === id) ?? file.versions[0] ?? defaultBrainVersion();
  writeBrainFile({ ...file, activeId: active.id });
  return active;
}

function readHistory(): HistoryFile {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")) as HistoryFile;
    if (raw && Array.isArray(raw.attempts)) return { version: 1, attempts: raw.attempts };
  } catch {
    // A missing history is just a quiet station.
  }
  return { version: 1, attempts: [] };
}

function writeHistory(file: HistoryFile): void {
  fs.mkdirSync(BUCKET_DIR, { recursive: true });
  const temporary = `${HISTORY_PATH}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
  fs.renameSync(temporary, HISTORY_PATH);
}

function rememberAttempt(attempt: CommercialAttempt): void {
  const file = readHistory();
  const next = file.attempts.filter((a) => a.id !== attempt.id);
  next.push(attempt);
  file.attempts = next.slice(-80);
  writeHistory(file);
}

export function commercialHistory(limit = 20): CommercialAttempt[] {
  return readHistory().attempts.slice(-limit).reverse();
}

export function commercialBrain(config: Config): CommercialBrain {
  const file = readBrainFile();
  const active = file.versions.find((version) => version.id === file.activeId) ?? file.versions[0] ?? defaultBrainVersion();
  return {
    activeId: active.id,
    versions: file.versions,
    active,
    style: active.style,
    multiverseBrain: active.multiverseBrain,
    rules: active.rules,
    multiverseSeeds: active.multiverseSeeds.slice(),
    realmTraders: active.realmTraders.slice(),
    sampleBriefs: {
      station: briefFor(config, 0, "station"),
      realm: briefFor(config, 0, "realm"),
      multiverse: briefFor(config, 0, "multiverse"),
    },
  };
}

/** One advert's brief, of whichever kind came up. */
export function briefFor(config: Config, index: number, preferredSource?: SpotSource): Brief {
  const brain = activeBrainVersion();
  const sponsors = config.ads.sponsors.filter((s) => s.enabled && s.name.trim() && !s.audioFile);

  // Rotate through the kinds so a batch is always mixed. Station spots only
  // come up when there is a sponsor to write for.
  const order: SpotSource[] = sponsors.length > 0
    ? ["multiverse", "realm", "station"]
    : ["multiverse", "realm"];
  const source = preferredSource && order.includes(preferredSource) ? preferredSource : order[index % order.length];

  if (source === "station") {
    const sponsor = pick(sponsors);
    return {
      source,
      sponsor: sponsor.name,
      prompt:
        `Write a radio commercial for ${sponsor.name}, who sell: ${sponsor.product}.\n\n` +
        (sponsor.talkingPoints ? `They want these in it: ${sponsor.talkingPoints}\n\n` : "") +
        (sponsor.style ? `How it should be performed: ${sponsor.style}\n\n` : "") +
        (sponsor.tagline ? `It ends on: ${sponsor.tagline}\n\n` : "") +
        brain.rules,
    };
  }

  if (source === "realm") {
    const trader = pick(brain.realmTraders.length ? brain.realmTraders : REALM_TRADERS);
    return {
      source,
      sponsor: trader.name,
      prompt:
        `Write a radio commercial for ${trader.name}, who sell: ${trader.product}.\n\n` +
        "This is a dark fantasy realm at war. A functioning market has grown up around a war nobody " +
        "is winning, and the people running it have quarterly targets. The joke is never that fantasy " +
        "is silly.\n\n" +
        `${brain.style}\n\n${brain.rules}\n` +
        "- Name a real place from the list below. Never invent one.",
    };
  }

  const seed = pick(brain.multiverseSeeds.length ? brain.multiverseSeeds : MULTIVERSE);
  return {
    source,
    sponsor: "",
    prompt:
      `Write a radio commercial for ${seed}.\n\n` +
      "Invent a name for the business and use it. It is a multiverse: other versions of people, " +
      "other timelines, a branch office in a worse one.\n\n" +
      `${brain.style}\n\n${brain.multiverseBrain}\n\n${brain.rules}`,
  };
}

/**
 * Clean the copy and cut it to about a minute.
 *
 * Two rules here were each learned from something that went out on air. The
 * role token — an empty assistant prefill once made every advert begin with
 * the literal word "assistant". And the hand-over, where the model announces
 * the work before doing it: "Here's your radio commercial for Bootleg Spoon:
 * Listen up, folks!" — recorded, and it would have been read out.
 */
export function tidy(raw: string, maxWords = 150): string {
  let text = String(raw ?? "")
    .replace(/^\s*(?:assistant|system|user)\b[:,]?\s*/i, "")
    .replace(/^\s*(?:announcer|voice ?over|vo|narrator)\s*:\s*/gim, "")
    .replace(
      /^\s*(?:here(?:['’]s| is)|this is|below is|sure[,!]?)\b[^:.]{0,80}?(?:commercial|advert|ad|spot|copy)\b[^:.]{0,40}[:.]\s*/i,
      "",
    )
    .replace(/\*+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (((text.match(/"/g) ?? []).length) % 2 === 1) text = text.replace(/"/g, "");
  text = text.replace(/^["']|["']$/g, "").trim();

  const words = text.split(" ");
  if (words.length <= maxWords) return text;

  const cut = words.slice(0, maxWords).join(" ");
  const stop = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  return stop > cut.length * 0.5 ? cut.slice(0, stop + 1) : `${cut.trim()}.`;
}

const SALES_CLICHES = [
  /\blisten up\b/i,
  /\bare you tired of\b/i,
  /\bworry no more\b/i,
  /\blook no further\b/i,
  /\bstate[- ]of[- ]the[- ]art\b/i,
  /\bone[- ]stop[- ]shop\b/i,
  /\blimited[- ]time offer\b/i,
  /\bspecial promotion\b/i,
  /\bknowledgeable staff\b/i,
  /\bas a valued customer\b/i,
  /\bwhat (?:really )?sets us apart\b/i,
  /\bsatisfaction guarantee\b/i,
  /\bbut wait,? there(?:'s| is) more\b/i,
  /\bso why wait\b/i,
  /\bact now\b/i,
];

const WRONG_DETAIL_MARKERS = [
  /\b(?:returns?|refund|receipt|warranty|deductible|financing)\b/i,
  /\b(?:branch manager|employee of the month|loading bay|car park|parking validation)\b/i,
  /\b(?:form|clipboard|waiting room|counter|coupon)\b/i,
  /\b(?:wrong door|remembers? you|machine in the ceiling|unqualified)\b/i,
];

/** A cheap final editor for failures the prompt alone cannot prevent. */
export function commercialCopyIssue(text: string, source?: SpotSource): string {
  const clean = String(text ?? "").trim();
  if (/\b(?:dr|mr|mrs|ms|st)\.$/i.test(clean) || !/[.!?][\"']?$/.test(clean)) {
    return "ended in the middle of a sentence";
  }

  const cliches = SALES_CLICHES.filter((pattern) => pattern.test(clean)).length;
  if (cliches >= 2) return `stacked ${cliches} generic infomercial phrases`;
  if (source === "multiverse" && WRONG_DETAIL_MARKERS.filter((pattern) => pattern.test(clean)).length < 2) {
    return "never made the required hard left turn into broken commercial logic";
  }
  return "";
}

/** Pull the business name out of copy that invented its own. */
export function sponsorFrom(text: string, fallback: string): string {
  if (fallback) return fallback;
  const match = text.match(/(?:welcome to|come to|visit|here at|introducing)\s+([A-Z][^.,!?]{2,44})/i);
  return match ? match[1].trim().replace(/[,!.]$/, "") : "A commercial";
}

export function dryRunCommercial(
  config: Config,
  options: { index?: number; source?: SpotSource; inspiration?: BucketSpot } = {},
): { brief: Brief; prompt: string; brainVersion: string; notes: string[] } {
  const index = options.index ?? listBucket().length;
  const brain = activeBrainVersion();
  const brief = briefFor(config, index, options.source);
  const { cast, places, pulse } = worldContext(config);
  const extras = brief.source === "realm" ? [cast, places, pulse] : [];
  const inspiration = options.inspiration
    ? [
        "MAKE A NEW SPOT IN THE SAME COMEDY FAMILY AS THIS ONE, BUT DO NOT REPEAT ITS EXACT BUSINESS,",
        "phrases, offer, or ending. Keep the same level of broken commercial logic:",
        options.inspiration.text,
      ].join("\n")
    : "";
  const prompt = [brief.prompt, inspiration, ...extras].filter(Boolean).join(BLANK);
  return {
    brief,
    prompt,
    brainVersion: brain.id,
    notes: [
      "Dry run only: no model call and no TTS render.",
      "With LM Studio closed, this still shows the exact prompt that would be sent.",
    ],
  };
}

export function runBrainTests(config: Config): Array<{ name: string; ok: boolean; detail: string }> {
  const brain = commercialBrain(config);
  const station = brain.sampleBriefs.station.prompt;
  const realm = brain.sampleBriefs.realm.prompt;
  const multiverse = brain.sampleBriefs.multiverse.prompt;
  const tests = [
    {
      name: "multiverse brain present",
      ok: multiverse.includes("THE WACKER MULTIVERSE COMMERCIAL BRAIN") || multiverse.includes(brain.multiverseBrain),
      detail: "Multiverse prompt carries the wrong-detail rule set.",
    },
    {
      name: "multiverse avoids borrowed characters",
      ok: /existing TV characters|do not name or imitate/i.test(multiverse),
      detail: "Prompt warns against copying named TV characters.",
    },
    {
      name: "multiverse stays out of Orion's realm",
      ok: !/REAL PEOPLE IN THIS WORLD|KING ORION MEMORY PULSE|REAL PLACES/i.test(multiverse),
      detail: "Multiverse copy is not seeded with the realm's cast or places.",
    },
    {
      name: "realm uses real places",
      ok: /Name a real place|Never invent/i.test(realm),
      detail: "Realm prompt keeps place names constrained.",
    },
    {
      name: "realm stays non-modern",
      ok: !/\btelephone\b|\belectricity\b/i.test(realm),
      detail: "Realm commercial brief does not inject modern devices.",
    },
    {
      name: "spoken-only rule",
      ok: /Spoken words only|words a person says/i.test(`${station}\n${realm}\n${multiverse}`),
      detail: "The brain still asks for speakable copy rather than labels or stage directions.",
    },
    {
      name: "seed list available",
      ok: brain.multiverseSeeds.length > 0,
      detail: `${brain.multiverseSeeds.length} multiverse seed(s) are available.`,
    },
    {
      name: "realm traders available",
      ok: brain.realmTraders.length > 0,
      detail: `${brain.realmTraders.length} realm trader(s) are available.`,
    },
  ];
  return tests;
}

function fallbackCopy(brief: Brief, index: number, error: string): { sponsor: string; text: string } {
  if (brief.source === "station") {
    const sponsor = brief.sponsor || "The Station Sponsor";
    return {
      sponsor,
      text:
        `${sponsor}. When the main commercial desk goes quiet, ${sponsor} still gets on air. ` +
        "There are opening hours, there is a counter, there is someone in the back who knows where the forms are, " +
        "and there is an offer that probably made sense when it left the printer. Come in today, ask for the radio " +
        `${index + 1} special, and pretend everybody agreed this was the plan. ${sponsor}. Still trading, still local.`,
    };
  }

  if (brief.source === "realm") {
    const sponsor = brief.sponsor || REALM_TRADERS[index % REALM_TRADERS.length].name;
    return {
      sponsor,
      text:
        `${sponsor}. The road is wet, the toll has gone up again, and somebody with a clipboard says this is now ` +
        "a standard market condition. Bring coin, bring oats, bring the receipt you were told not to lose, and leave " +
        "before the second bell if you want the cheaper rate. Siege, weather, and poor judgement may affect availability. " +
        `${sponsor}. Serving the realm until the realm says otherwise.`,
    };
  }

  const sponsor = ["Form 7 Discount Portals", "The Other You Outlet", "Kevin's Timeline Annex"][index % 3];
  const reason = error ? "after a minor scheduling disagreement with the machine in the ceiling" : "with normal local confidence";
  return {
    sponsor,
    text:
      `${sponsor}. Now open beside the loading bay that was not there yesterday, ${reason}. Bring your coupon, ` +
      "your government name, and the version of your childhood that still fits in the envelope. Our branch manager " +
      "Dale says returns are welcome between Tuesday and Tuesday, unless the item remembers you first. Financing is " +
      "available for qualified applicants and several unqualified ones. Form seven Discount Portals. Wrong door, right price.",
  };
}

/** What the world gives the writer to work with. */
export function realmCommercialPulse(realm: Realm): string {
  if (!realm.root) return "";

  const lines = [`KING ORION MEMORY PULSE FOR REALM COMMERCIALS: ${realmSummary(realm)}.`];

  if (realm.save) {
    const s = realm.save;
    lines.push(
      `- Wommper right now: ${s.playerClass}, level ${s.level}, ${s.currentHp}/${s.maxHp} HP, ` +
        `${s.gold} gold, turn ${s.turnCount}.`,
    );
    if (s.inventory.length) lines.push(`- He carries: ${s.inventory.slice(0, 8).join(", ")}.`);
    if (s.journal) lines.push(`- Latest journal line: ${s.journal}`);
  }

  const guildDeaths = realm.guild.reduce((sum, member) => sum + member.deaths, 0);
  if (realm.guild.length) {
    lines.push(
      `- The Respawn Guild has ${realm.guild.length} rider${realm.guild.length === 1 ? "" : "s"} and ` +
        `${guildDeaths} recorded death${guildDeaths === 1 ? "" : "s"}.`,
    );
  }

  const recent = realm.events.slice(-4);
  if (recent.length) {
    lines.push("- Recent deeds the advert may use as market gossip:");
    for (const event of recent) lines.push(`  - ${event.description}${event.location ? ` (${event.location})` : ""}`);
  }

  const open = realm.quests.filter((quest) => quest.status === "active").slice(0, 3);
  if (open.length) {
    lines.push("- Open work and bounties people may be selling around:");
    for (const quest of open) lines.push(`  - ${quest.name}: ${quest.description}`);
  }

  lines.push(
    "- Use these as pressure in the advert, not as a lore lecture. Sell a product to people living through it.",
  );

  return lines.join("\n");
}

export function worldContext(config: Config): { cast: string; places: string; pulse: string } {
  const realm = readRealm(config.orion.realmPath);
  const townsfolk = realm.npcs.map((n) => n.name).filter(Boolean);
  const places = realmPlaces(realm);

  return {
    cast: townsfolk.length > 0
      ? `Real people in this world, and you should use at least one by name:\n${townsfolk.map((t) => `- ${t}`).join("\n")}`
      : "",
    places: places.length > 0 ? `Real places, and only these: ${places.join(", ")}.` : "",
    pulse: realmCommercialPulse(realm),
  };
}

/**
 * Write and record one spot, and put it in the bucket.
 *
 * `background` marks the model request as work nobody is waiting to hear, so a
 * conversation turn always jumps ahead of it. That matters for the top-up,
 * which runs after a show while the model may still be finishing something.
 */
export async function writeSpot(
  config: Config,
  index: number,
  options: { background?: boolean; signal?: AbortSignal; source?: SpotSource; inspiration?: BucketSpot } = {},
): Promise<BucketSpot> {
  const brainVersion = activeBrainVersion();
  const brief = briefFor(config, index, options.source);
  const { cast, places, pulse } = worldContext(config);
  const extras = brief.source === "realm" ? [cast, places, pulse] : [];
  const inspiration = options.inspiration
    ? [
        "MAKE A NEW SPOT IN THE SAME COMEDY FAMILY AS THIS ONE, BUT DO NOT REPEAT ITS EXACT BUSINESS,",
        "phrases, offer, or ending. Keep the same level of broken commercial logic:",
        options.inspiration.text,
      ].join("\n")
    : "";
  const attemptId = `attempt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const prompt = [brief.prompt, inspiration, ...extras].filter(Boolean).join(BLANK);

  rememberAttempt({
    id: attemptId,
    at: new Date().toISOString(),
    status: "started",
    source: brief.source,
    sponsor: brief.sponsor,
    model: config.llm.commercialModel || config.llm.model,
    brainVersion: brainVersion.id,
    prompt,
  });

  let text = "";
  let sponsor = "";
  let status: CommercialAttempt["status"] = "made";
  let error = "";

  try {
    const raw = await generate({ ...config.llm, model: config.llm.commercialModel || config.llm.model }, {
      messages: [
        {
          role: "system",
          content:
            `You write commercials for ${config.show.station}. You have no tools and no functions. ` +
            "Everything you write is words a person says out loud into a microphone. Never output " +
            "JSON, labels, or stage directions. Prefer bold, broken commercial logic over tidy jokes: " +
            "the read should sound like an ad that is very confident and deeply wrong.",
        },
        { role: "user", content: prompt },
      ],
      temperature: Math.min(1.2, config.llm.temperature + 0.2),
      maxTokens: 500,
      priority: options.background ? "background" : "foreground",
      signal: options.signal,
    });

    if (looksLikeToolCall(raw)) throw new Error("the model answered with a tool call");

    text = tidy(raw);
    if (text.length < 60) throw new Error("came back too short");
    const copyIssue = commercialCopyIssue(text, brief.source);
    if (copyIssue) throw new Error(copyIssue);
    if (brief.source === "multiverse") {
      const realm = readRealm(config.orion.realmPath);
      const guarded = [
        config.orion.king.name,
        config.orion.chronicler.name,
        ...realm.npcs.map((npc) => npc.name),
        ...realmPlaces(realm),
      ]
        .map((name) => name.trim())
        .filter((name) => name.length >= 4);
      const leaked = guarded.find((name) => text.toLowerCase().includes(name.toLowerCase()));
      if (leaked) throw new Error(`borrowed ${leaked} from King Orion's realm`);
    }
    sponsor = sponsorFrom(text, brief.sponsor);
  } catch (err) {
    error = (err as Error).message;
    const fallback = fallbackCopy(brief, index, error);
    text = tidy(fallback.text);
    sponsor = fallback.sponsor;
    status = "fallback";
  }

  const id = `spot-${Date.now().toString(36)}-${index}`;
  const file = `${id}.wav`;

  fs.mkdirSync(BUCKET_DIR, { recursive: true });
  const brk: AdBreak = {
    index: 0,
    spots: [{ kind: "produced", sponsor, lines: [{ voice: "announcer", text }] }],
  };
  let audio;
  try {
    audio = await renderBreak(
      config,
      brk,
      path.join(BUCKET_DIR, file),
      Date.now() + index,
      options.signal,
      { shelve: false },
    );
  } catch (err) {
    rememberAttempt({
      id: attemptId,
      at: new Date().toISOString(),
      status: "failed",
      source: brief.source,
      sponsor,
      model: config.llm.model,
      brainVersion: brainVersion.id,
      prompt,
      error: (err as Error).message,
      text,
    });
    throw err;
  }

  const seconds = Number(durationOf(audio).toFixed(2));
  if (seconds < 2) {
    const message =
      `Speech produced no usable audio for ${sponsor}. Check the ${config.tts.engine} voice connection before retrying.`;
    fs.rmSync(path.join(BUCKET_DIR, file), { force: true });
    rememberAttempt({
      id: attemptId,
      at: new Date().toISOString(),
      status: "failed",
      source: brief.source,
      sponsor,
      model: config.llm.model,
      brainVersion: brainVersion.id,
      prompt,
      error: message,
      text,
    });
    throw new Error(message);
  }

  const spot = addSpot({
    id,
    sponsor,
    source: brief.source,
    text,
    file,
    seconds,
    brainVersion: brainVersion.id,
  });
  rememberAttempt({
    id: attemptId,
    at: new Date().toISOString(),
    status,
    source: brief.source,
    sponsor,
    model: config.llm.model,
    brainVersion: brainVersion.id,
    prompt,
    error: error || undefined,
    text,
    spotId: spot.id,
  });
  return spot;
}

/**
 * Quietly keep the bucket stocked after a show.
 *
 * Deliberately small and deliberately late: a couple of spots, after the
 * broadcast is finished and nothing is waiting on the model, at background
 * priority. The bucket is what makes breaks free, and a bucket that runs dry
 * puts the show back to writing twelve spots live — which is the thing all of
 * this exists to avoid.
 */
export async function topUp(
  config: Config,
  options: { floor?: number; batch?: number; onInfo?: (message: string) => void } = {},
): Promise<number> {
  const floor = options.floor ?? 12;
  const batch = options.batch ?? 2;

  const have = listBucket().length;
  if (have >= floor) return 0;

  let made = 0;
  for (let i = 0; i < batch; i++) {
    try {
      const spot = await writeSpot(config, have + i, { background: true });
      made += 1;
      options.onInfo?.(`A new commercial for ${spot.sponsor} went into the bucket.`);
    } catch {
      // The model may have gone away, which is not worth a word after a show.
      break;
    }
  }

  return made;
}
