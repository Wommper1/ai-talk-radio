/**
 * Ad breaks.
 *
 * A break does two jobs. It sounds like radio — the loudness jumps, the bed
 * changes, an announcer appears out of nowhere — and it buys time. Every
 * break is written and rendered while the hosts are still talking, so playing
 * one hands the model most of a minute to run ahead of the listener. That
 * makes the ads a speed feature as much as a production one.
 *
 * Nothing here is allowed to fail the show. Every model call has a plain-text
 * fallback, and behind that a template, so a break always has something in it.
 */

import fs from "node:fs";
import path from "node:path";
import { voiceFor, type AdsConfig, type Config, type Sponsor } from "../config.ts";
import { synthesize } from "../providers/tts.ts";
import { generate, looksLikeToolCall, type ChatMessage } from "../providers/llm.ts";
import { decodeMp3 } from "../audio/mp3.ts";
import {
  decodeWav,
  encodeWav,
  concat,
  silence,
  durationOf,
  normalize,
  trimSilence,
  gain,
  fade,
  resample,
  SAMPLE_RATE,
  type AudioBuffer,
} from "../audio/wav.ts";
import { applyTone, compress, limit, peaking, duck } from "../audio/effects.ts";
import { generateBed, type Mood } from "../audio/music.ts";
import { makeSting, STING_LENGTHS, type StingKind } from "../audio/stings.ts";
import { hostFor, type SpeakerVoice } from "./produce.ts";
import { openingOf, recentForAll, remember } from "../memory/adhistory.ts";
import { audioPathFor, markPlayed, pickForReuse, save as shelve } from "./adlibrary.ts";

/* ── The drop folder ─────────────────────────────────────────────── */

/** Where your own spots live. Drop a .wav or .mp3 in and it can be scheduled. */
export const ADS_DIR = path.join(process.cwd(), "ads");

const AUDIO_EXTENSIONS = [".wav", ".mp3"];

export interface AdFile {
  name: string;
  bytes: number;
  modified: string;
}

export function listAdFiles(): AdFile[] {
  try {
    fs.mkdirSync(ADS_DIR, { recursive: true });
    return fs
      .readdirSync(ADS_DIR)
      .filter((name) => AUDIO_EXTENSIONS.includes(path.extname(name).toLowerCase()))
      .map((name) => {
        const stat = fs.statSync(path.join(ADS_DIR, name));
        return { name, bytes: stat.size, modified: stat.mtime.toISOString() };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Turn a configured filename into a path inside the ads folder, or null.
 * Only a bare filename is ever accepted, so config cannot reach outside it.
 */
export function resolveAdFile(name: string): string | null {
  const base = path.basename(String(name ?? "").trim());
  if (!base || !AUDIO_EXTENSIONS.includes(path.extname(base).toLowerCase())) return null;

  const full = path.join(ADS_DIR, base);
  if (!path.resolve(full).startsWith(path.resolve(ADS_DIR))) return null;
  return fs.existsSync(full) ? full : null;
}

/* ── What a break is made of ─────────────────────────────────────── */

export type SpotKind = "live_read" | "produced" | "promo" | "psa" | "custom";

export interface SpotLine {
  /** Host a, host b, or the station announcer. */
  voice: "a" | "b" | "announcer";
  text: string;
}

export interface AdSpot {
  kind: SpotKind;
  /** Shown in the transcript and the live feed. */
  sponsor: string;
  lines: SpotLine[];
  /** Set for a spot that is a file you supplied rather than a synthesised read. */
  audioFile?: string;
  /** Which format it was written to. Logged, so the next one is a different one. */
  angle?: string;
  /** The fast small print at the end. Templates, never the model. */
  disclaimer?: string;
  /** Set when this spot is a repeat off the shelf rather than a fresh cut. */
  libraryId?: string;
}

export interface AdBreak {
  index: number;
  spots: AdSpot[];
}

/**
 * Where the breaks fall.
 *
 * Never in the opening pair, never against the sign-off, and spread evenly
 * through what is left. Returns turn positions: a break plays after the turn
 * at that index.
 */
export function breakPositions(totalTurns: number, breaks: number): number[] {
  if (breaks <= 0 || totalTurns < 6) return [];

  // One exchange to establish the show, two turns to land it. The first break
  // used to sit a third of the way in, which is late for radio — a real station
  // is in and out of a break before you have settled, and on a local model an
  // early one buys the writer a head start it never recovers otherwise.
  const first = 1;
  const last = totalTurns - 3;
  if (last < first) return [];

  // Every break takes two turns: one to throw to it and one to come back. Two
  // breaks landing on adjacent turns therefore overwrite each other — the
  // second one's throw lands on the first one's return, and the show goes
  // "throw, throw, return" with a break silently lost. So they are placed at
  // least three turns apart, which is also simply how a log is spaced.
  const SPACING = 3;
  const room = Math.floor((last - first) / SPACING) + 1;
  const count = Math.max(0, Math.min(breaks, room));
  if (count === 0) return [];

  const positions: number[] = [];

  // The first one goes early on purpose rather than being evenly spread with
  // the rest; the rest fill the room that is left.
  for (let i = 0; i < count; i++) {
    const at = count === 1 ? first : Math.round(first + ((last - first) * i) / (count - 1));
    const previous = positions[positions.length - 1];
    if (previous !== undefined && at - previous < SPACING) continue;
    if (at < first || at > last) continue;
    positions.push(at);
  }

  return positions;
}

/* ── Formats ─────────────────────────────────────────────────────── */

/**
 * The shapes a radio advert comes in.
 *
 * Ad copy from a language model, given nothing but a business and a product,
 * converges hard: it will write "are you tired of" and a list of benefits every
 * single time, so four spots for the same sponsor come out as one spot read
 * four times. The fix is not a hotter temperature, it is a different brief.
 * Each of these is a real format an agency would actually book, and each one
 * forces a different opening line, a different rhythm and a different length.
 *
 * `length` scales the configured spot length: a jingle tag is short, a
 * testimonial rambles.
 */
export interface AdAngle {
  id: string;
  label: string;
  /** Direction for the writer. Never spoken aloud. */
  brief: string;
  length: number;
}

export const AD_ANGLES: AdAngle[] = [
  {
    id: "hard_sell",
    label: "Hard sell",
    brief:
      "Shout it. A sale with a deadline — name the days, name a price, name the street. No warm-up, start mid-shout.",
    length: 0.9,
  },
  {
    id: "problem_solution",
    label: "Problem and solution",
    brief:
      "Open on the listener's problem, in the second person, and make it specific and a bit humiliating. Two sentences of that, then the business arrives as the answer.",
    length: 1,
  },
  {
    id: "testimonial",
    label: "Testimonial",
    brief:
      "One customer talking, in their own words, like they were stopped in a car park. Halting, over-detailed, obviously not a professional. They name the business twice because nobody told them not to.",
    length: 1.15,
  },
  {
    id: "overheard",
    label: "Overheard",
    brief:
      "Drop into the middle of a conversation. One person is baffled by how good the thing is, the other explains where they got it. It ends the moment the name has been said.",
    length: 1.05,
  },
  {
    id: "deadpan",
    label: "Deadpan",
    brief:
      "Read something completely unreasonable in a flat, reasonable voice, at the pace of an insurance advert. Never acknowledge that any of it is strange. The comedy is entirely in not noticing.",
    length: 1,
  },
  {
    id: "list_blitz",
    label: "Inventory blitz",
    brief:
      "Rapid-fire stock list. A long run of things they have, no breath, no conjunctions, and about a third of them should not be sold by this kind of business. End on the name, hard.",
    length: 0.95,
  },
  {
    id: "guarantee",
    label: "The guarantee",
    brief:
      "The whole spot is one promise, stated three times, each version more reckless than the last, until it is clearly not a promise anyone should make.",
    length: 0.85,
  },
  {
    id: "derailed",
    label: "Derailed",
    brief:
      "The read goes off the rails halfway through — the reader says something they plainly should not have, catches themselves, and finishes the copy as written as if nothing happened.",
    length: 1.1,
  },
  {
    id: "endorsement",
    label: "Personal endorsement",
    brief:
      "The reader swears they personally use this. One specific, slightly too personal detail about their own life proves it, and slightly oversells how much it has changed things.",
    length: 1,
  },
  {
    id: "countdown",
    label: "Running out",
    brief:
      "Pure urgency. Stock is going, the date is named, the clock is running. Numbers all the way through — how many are left, how many hours, how far away it is.",
    length: 0.85,
  },
  {
    id: "institutional",
    label: "Institutional",
    brief:
      "Warm and slow, no offer at all. How long they have been here, who runs it now, what this town would be without them. Almost a eulogy. It only sells at the very end.",
    length: 1.1,
  },
  {
    id: "jingle_tag",
    label: "Jingle tag",
    brief:
      "Almost sung. Short lines that rhyme, the name repeated three times as a hook, and nothing resembling information.",
    length: 0.7,
  },
  {
    id: "public_notice",
    label: "Public notice",
    brief:
      "Read like an official announcement — a warning, an advisory, a thing the public should be aware of — which turns out about halfway through to be an advert.",
    length: 0.95,
  },
  {
    id: "unqualified",
    label: "Wrong presenter",
    brief:
      "The person reading is manifestly the wrong person to be selling this, in a way nobody in the advert ever mentions. They press on regardless and finish the copy properly.",
    length: 1.05,
  },
];

/**
 * Pick a format this advertiser has not just used.
 *
 * Never used beats used-a-while-back beats used-last-night, and anything
 * already heard tonight is out of the running entirely.
 */
export function chooseAngle(
  recentAngles: string[],
  usedTonight: Set<string>,
  rand: () => number,
  /** Formats any advertiser has used tonight. Two blitzes in one break is a lot. */
  usedByAnyone: Set<string> = new Set(),
): AdAngle {
  const unheard = AD_ANGLES.filter((a) => !usedTonight.has(a.id) && !usedByAnyone.has(a.id));
  const fresh = unheard.length > 0 ? unheard : AD_ANGLES.filter((a) => !usedTonight.has(a.id));
  const candidates = fresh.length > 0 ? fresh : AD_ANGLES;

  let best = candidates[0];
  let bestScore = Infinity;

  // Walk them in a random order, so ties — and the whole first show, when
  // nothing has any history — do not always land on the same format.
  for (const angle of shuffled(candidates, Math.floor(rand() * 0xffffffff))) {
    const score = recentAngles.lastIndexOf(angle.id);
    if (score < bestScore) {
      bestScore = score;
      best = angle;
      if (score === -1) break;
    }
  }

  return best;
}

/* ── Small print ─────────────────────────────────────────────────── */

/**
 * The fast bit at the end.
 *
 * Templates rather than the model: it is the most recognisable furniture in
 * commercial radio, it has to be read at a speed nobody can follow, and asking
 * an eight-billion-parameter model to be funny in one sentence is a worse bet
 * than a written list.
 */
const SMALL_PRINT: string[] = [
  "Terms and conditions apply. Offer subject to availability, and to whether anybody turns up.",
  "Prices correct at time of recording. Not a legally binding statement. Do not operate heavy machinery.",
  "Participating locations only. There is one location. Ask for it by name.",
  "Offer ends when it ends. No cash alternative, no refunds, no eye contact.",
  "Void where prohibited. Not available in every dimension. Please advertise responsibly.",
  "Individual results vary. Individual results have, on occasion, been the opposite.",
  "Not a medical device. Not a vehicle. Not, in the strict sense, a product.",
  "Finance subject to status. Status subject to finance. Both subject to change without notice.",
  "Your statutory rights are unaffected, which is the nicest thing we can say about them.",
  "Guarantee covers parts, labour, and absolutely nothing that actually goes wrong.",
];

/** The same furniture, for a realm that has never heard of a legal department. */
const COURT_SMALL_PRINT: string[] = [
  "Terms as posted at the gate. The Crown is not liable for the road, the weather, or your choices.",
  "Prices correct at the last bell. Subject to siege, flood, and the toll being raised again.",
  "No refunds. No exchanges. No appeals to the King, who has heard enough of them.",
  "Guarantee void if the item is used in anger, in water, or against anything that does not stay dead.",
  "Payment in coin, oats, or labour. Labour is the road. Most people pay in coin.",
  "The proprietor accepts no responsibility for what is done with the goods after they leave the stall.",
  "Offer holds until the stock is gone or the seller is. Whichever comes first.",
  "By purchasing you agree that you were told, and that you did it anyway.",
];

/** The small print for a given spot, or nothing when the spot does not want one. */
export function smallPrintFor(seed: number, wanted: boolean, court = false): string | undefined {
  if (!wanted) return undefined;
  const list = court ? COURT_SMALL_PRINT : SMALL_PRINT;
  return list[seed % list.length];
}

/* ── Copy ────────────────────────────────────────────────────────── */

/**
 * Fictional advertisers, used when the model is off, fails, or has nothing to
 * work from. They are deliberately small and local — a national brand read by
 * a synthesised announcer sounds wrong, a tyre shop on a ring road does not.
 */
const INVENTED: Array<{ name: string; product: string; tagline: string }> = [
  { name: "Delroy's Tyre Barn", product: "part-worn tyres and same-day fitting", tagline: "Delroy's. We'll get you rolling." },
  { name: "The Second Breakfast Diner", product: "an all-day breakfast served until closing", tagline: "Come hungry. Leave slowly." },
  { name: "Ferris Brothers Storage", product: "climate-controlled units by the month", tagline: "Ferris Brothers. Out of sight, not out of mind." },
  { name: "Marlow's Carpet World", product: "end-of-roll carpet and free underlay", tagline: "Marlow's. Mind the step." },
  { name: "Nightingale Locksmiths", product: "twenty-four-hour emergency lockouts", tagline: "Nightingale. We're already on the way." },
  { name: "Cobb & Daughter Roofing", product: "flat roof repairs with a ten-year guarantee", tagline: "Cobb and Daughter. Look up." },
  { name: "The Wandering Fork", product: "a food truck that never parks in the same place twice", tagline: "The Wandering Fork. Find us if you can." },
  { name: "Hollis Driving School", product: "intensive courses and nervous-driver lessons", tagline: "Hollis. Everybody starts somewhere." },
  { name: "Pemberton Aquatics", product: "pond supplies and koi you cannot afford", tagline: "Pemberton Aquatics. Deeper than it looks." },
  { name: "Route 9 Self-Serve Car Wash", product: "four bays, open all night, exact change only", tagline: "Route Nine. Bring quarters." },
  { name: "Auntie Val's Upholstery", product: "sofa recovering and dining chair repairs", tagline: "Auntie Val's. Sit down properly." },
  { name: "Kestrel Office Supplies", product: "the last shop in town that still sells carbon paper", tagline: "Kestrel. We have it in the back." },
];

/* ── The market at the gate ──────────────────────────────────────── */

/**
 * Who advertises at a king's court.
 *
 * Not the station's sponsors — a tyre barn has no business in a hall with a
 * bell in it. These are the trades a realm like this actually supports, sold
 * the way Futurama sells things: brisk commercial cheer wrapped around
 * something plainly awful, delivered by people entirely at peace with it.
 *
 * The joke is never that fantasy is silly. It is that a functioning market has
 * grown up around a war nobody is winning, and the people running it have
 * quarterly targets.
 */
const COURT_TRADERS: Array<{ name: string; product: string; tagline: string; style: string }> = [
  {
    name: "Grumwald's Reanimation Services",
    product: "getting your people back on their feet, mostly",
    tagline: "Grumwald's. Death is a scheduling problem.",
    style:
      "Brisk and corporate about something horrifying. He is not a necromancer, he is a service provider, " +
      "and he would like you to know the difference is legal rather than practical.",
  },
  {
    name: "The Toll House at {place}",
    product: "safe passage, and a receipt",
    tagline: "The Toll House. You were going to cross anyway.",
    style:
      "The unbothered confidence of a monopoly. There is one crossing, they own it, and the price went up " +
      "again. Says this the way you would read out opening hours.",
  },
  {
    name: "Bristle & Bone, Apothecaries",
    product: "tonics, poultices and one thing they will not name",
    tagline: "Bristle and Bone. Ask for it by the other name.",
    style:
      "Two proprietors who plainly disagree about what is legal. Warm, chatty, and the warmth never falters " +
      "even when the product being described is clearly a crime.",
  },
  {
    name: "Hollowmere Insurance",
    product: "cover against fire, siege, and coming back wrong",
    tagline: "Hollowmere. We have read the small print. You have not.",
    style:
      "Reasonable, patient, faintly bored. Lists exclusions the way a clerk does, and every exclusion is " +
      "the exact thing that is going to happen to you.",
  },
  {
    name: "The Respawn Guild Surplus Store",
    product: "gear off travellers who did not need it any more",
    tagline: "Surplus. Somebody's loss, your gain.",
    style:
      "Cheerful profiteering off a war. Never once acknowledges where the stock comes from, and is visibly " +
      "delighted by how much of it there is lately.",
  },
  {
    name: "Ferryman & Sons",
    product: "one crossing, one way, no refunds",
    tagline: "Ferryman and Sons. Family run since before the river.",
    style:
      "A family business with a very long memory and an unclear number of living employees. Proud, old, and " +
      "slightly threatening about tradition.",
  },
  {
    name: "The {place} Salvage Company",
    product: "everything left standing after a fire, cheap",
    tagline: "{place} Salvage. We were there first.",
    style:
      "Opportunistic and entirely shameless. Arrives before the ashes are cool and treats that as good " +
      "customer service.",
  },
  {
    name: "Marrow's Reliable Mercenaries",
    product: "men who will fight for you until the money stops",
    tagline: "Marrow's. Paid up front, obviously.",
    style:
      "Utterly professional about disloyalty. States the terms plainly, including the ones about what " +
      "happens when a better offer arrives.",
  },
  {
    name: "The Hanged Man",
    product: "a bed, a bath, and no questions at all",
    tagline: "The Hanged Man. Nobody here knows your face.",
    style:
      "An inn that has decided discretion is its entire brand. Says nothing about the rooms and a great deal " +
      "about how little it will remember.",
  },
  {
    name: "{place} Cartography",
    product: "maps of the roads around {place}, updated whenever somebody survives one",
    tagline: "{place} Cartography. Now with fewer blank spaces.",
    style:
      "Academic pride in a data set gathered at appalling human cost. Genuinely excited about the coverage.",
  },
  {
    name: "Cinderhold Ironworks",
    product: "blades, hinges, and cages built to a royal standard",
    tagline: "Cinderhold. Made to last longer than you.",
    style:
      "Industrial and dour. Talks about tolerances and load-bearing when the product is obviously for hurting " +
      "people, and takes real craftsman's pride in it.",
  },
  {
    name: "Widow Ash's Debt Collection",
    product: "recovering what is owed to the Crown",
    tagline: "Widow Ash. She would rather not have to come.",
    style:
      "Soft, polite, apologetic. Every sentence is an apology for something that has not happened yet, and " +
      "somehow that is far worse than shouting.",
  },
];

/**
 * The Crown's own notices.
 *
 * A break has to end on something that needs no sponsor, and at a station that
 * is a promo — "the phones are open all hour". In a king's hall that is
 * nonsense, and it was going out verbatim: Marco and Dee being plugged at the
 * gate of a mediaeval court. A realm at war has its own version, and it is
 * more useful than a promo ever was: the Crown telling people what the roads
 * are doing.
 */
function proclamationLines(config: Config, places: string[], seed: number): SpotLine[] {
  const king = config.orion.king.name;
  const where = places.length > 0 ? places[seed % places.length] : "the northern road";
  const other = places.length > 1 ? places[(seed + 1) % places.length] : "the crossing";

  const options: string[][] = [
    [
      `By order of ${king}.`,
      `The road past ${where} is closed from dusk until the bell. Travel it and the Crown will not come for you.`,
    ],
    [
      "A notice from the Crown.",
      `Tolls at ${where} are raised again this quarter. Those who cannot pay may work the road instead. Most choose the road.`,
    ],
    [
      `${king} reminds the realm that harbouring a traveller who does not stay dead is itself a crime.`,
      "Report them. There is coin in it.",
    ],
    [
      "A notice from the Crown.",
      `Any man of fighting age at ${other} is to present himself at the muster. Bring your own iron. There is none left to give you.`,
    ],
    [
      "By order of the Crown.",
      `The wells at ${where} are not to be drunk from. No reason is given, and none will be.`,
    ],
    [
      `${king} thanks the realm for its patience.`,
      "The war is going well. This notice will be read again next quarter, unchanged.",
    ],
  ];

  return options[seed % options.length].map((text) => ({ voice: "announcer" as const, text }));
}

/** Station promos need no sponsor and always work, so they backstop a break. */
function promoLines(config: Config, topic: string, seed: number): SpotLine[] {
  const { station } = config.show;
  const [a, b] = config.hosts;
  const subject = topic.trim().replace(/\s+/g, " ").slice(0, 70) || "whatever is in front of them";

  const options: string[][] = [
    [`You're listening to ${station}.`, `${a.name} and ${b.name} are back after this, still arguing about ${subject}.`],
    [`${station}. The phones are open all hour.`, `Call in, and you go straight on air with ${a.name} and ${b.name}.`],
    [`This is ${station}, where nobody has ever agreed about anything.`, `Stay with us.`],
    [`${station}. Same two voices, same desk, every night.`, `${a.name}. ${b.name}. Nobody in charge.`],
    [`Turn it up. This is ${station}.`, `More of ${a.name} and ${b.name} in sixty seconds, and they have not finished.`],
    [
      `Something to say? ${station} wants to hear it.`,
      `Get on the line and tell ${a.name} and ${b.name} exactly where they went wrong.`,
    ],
    [`${station}, all the way through the night.`, `Don't touch that dial. ${a.name} and ${b.name} are right back.`],
    [
      `You're locked in to ${station}.`,
      `Coming up: ${subject}, and neither of them is backing down.`,
    ],
  ];

  return options[seed % options.length].map((text) => ({ voice: "announcer" as const, text }));
}

/**
 * A spot built from a sponsor's own details, with no model involved.
 *
 * This is the last line of defence — it runs when the model is off, refuses, or
 * hands back a schema — so it varies too. A fallback that is word-for-word
 * identical every time is only marginally better than dead air.
 */
function templateLines(
  sponsor: { name: string; product: string; tagline: string },
  station: string,
  seed: number,
): SpotLine[] {
  const tag = sponsor.tagline || `${sponsor.name}. You know where we are.`;
  const product = sponsor.product || "everything you need";

  const shapes: string[][] = [
    [
      `This part of ${station} is brought to you by ${sponsor.name}.`,
      `${sponsor.name} — ${product}.`,
      tag,
    ],
    [
      `${sponsor.name}. You have heard the name, now hear the rest of it.`,
      `${product}, and nobody else in this town is doing it.`,
      tag,
    ],
    [
      `Still here? Good. ${sponsor.name} would like a word.`,
      `${product}. That is the whole advert. That is all there is.`,
      tag,
    ],
    [
      `A message from ${sponsor.name}, who paid for this bit.`,
      `${product}. Come in, ask for it by name, do not haggle.`,
      tag,
    ],
    [
      `${station} runs on two things: bad opinions, and ${sponsor.name}.`,
      `${product}. Open now, or near enough.`,
      tag,
    ],
  ];

  return shapes[seed % shapes.length].map((text) => ({ voice: "announcer" as const, text }));
}

interface SpotRequest {
  kind: SpotKind;
  sponsor: { name: string; product: string; talkingPoints: string; tagline: string; style: string };
  /** Who should read it, decided before the copy is written. */
  reader: "a" | "b" | "announcer";
  /** The format it is written to. The thing that stops four spots being one spot. */
  angle: AdAngle;
  /** This spot's own length, which the format decides. */
  words: number;
  /** Which time tonight this is — 0 the first, 1 the second, and so on. */
  appearance: number;
}

/**
 * Decide what every break in the show contains, before a word is generated.
 *
 * Sponsors with an audio file are scheduled straight through — those never
 * touch the model. Everything else becomes a copy request, and the whole show's
 * copy is written in a single call so the ads cost one model round trip, not one
 * per spot.
 *
 * Each request also picks up a format and the advertiser's recent history, so a
 * sponsor booked into all four breaks gets four genuinely different adverts,
 * and gets different ones again tomorrow night.
 */
/** What a court's commercial break is, as opposed to a radio station's. */
export interface CourtAds {
  /** Places the realm actually has. Adverts may name these and nothing else. */
  places: string[];
}

export async function planBreaks(
  config: Config,
  topic: string,
  signal?: AbortSignal,
  onInfo?: (message: string) => void,
  court?: CourtAds,
): Promise<AdBreak[]> {
  const ads = config.ads;
  if (!ads.enabled || ads.breaks <= 0) return [];

  // A court takes no sponsors and no repeats. The station's advertisers have
  // no business in a hall with a bell in it, and the King has never in his
  // life heard the same crier twice — every break is cut fresh.
  const usable = court ? [] : ads.sponsors.filter((s) => s.enabled && (s.name || s.audioFile));
  const total = ads.breaks * ads.spotsPerBreak;

  // Seeded per run rather than per topic: the same show on the same subject
  // twice should not produce the same commercial log.
  const runSeed = (Date.now() ^ hashOf(`${config.show.station}|${topic}`)) >>> 0;
  const rand = randomFrom(runSeed);

  // ── Decide the running order of spots first.
  const slots: Array<{ custom?: Sponsor; sponsor?: Sponsor; invented?: boolean; promo?: boolean }> = [];
  let sponsorAt = 0;

  const wantsSponsors = !court && ads.source !== "invented" && usable.length > 0;
  const wantsInvented = court || ads.source !== "sponsors" || usable.length === 0;

  // Adding a sponsor and leaving "who advertises" on made-up businesses is the
  // easy mistake to make, and it is a silent one: the break sounds fine, it
  // just never mentions you. Say so rather than letting it be a mystery.
  if (usable.length > 0 && !wantsSponsors) {
    const many = usable.length !== 1;
    onInfo?.(
      `${usable.length} sponsor${many ? "s" : ""} configured, but "Who advertises" is set to made-up ` +
        `businesses — so ${many ? "they are" : "it is"} not on tonight's log. Switch it to "Mixed" or ` +
        `"My sponsors only" to hear ${many ? "them" : "it"}.`,
    );
  }

  for (let i = 0; i < total; i++) {
    const sponsor = wantsSponsors ? usable[sponsorAt % usable.length] : undefined;

    // In "mixed", alternate between your advertisers and made-up ones so a
    // single real sponsor is not read four times in one show.
    const useSponsor =
      sponsor && (ads.source === "sponsors" || (ads.source === "mixed" && i % 2 === 0));

    if (useSponsor && sponsor) {
      sponsorAt++;
      if (resolveAdFile(sponsor.audioFile)) slots.push({ custom: sponsor });
      else slots.push({ sponsor });
    } else if (wantsInvented) {
      slots.push({ invented: true });
    } else if (ads.usePromos) {
      slots.push({ promo: true });
    } else {
      slots.push({ invented: true });
    }
  }

  // The last spot of the show is a station promo when they are on — real
  // stations come out of the final break selling themselves, not a tyre shop.
  if (ads.usePromos && slots.length > 1) slots[slots.length - 1] = { promo: true };

  // ── What everyone in tonight's log has said before.
  const histories = recentForAll([
    ...usable.map((s) => s.name),
    ...INVENTED.map((s) => s.name),
    config.show.station,
  ]);
  const usedTonight = new Map<string, Set<string>>();
  const usedByAnyone = new Set<string>();

  // ── Take part of tonight's load off the shelf.
  //
  // Done before any copy is written, because a repeat costs neither the model
  // call nor the synthesis — which between them are essentially the whole cost
  // of a break. What is left over is written fresh, so the log still moves.
  const freshSlots = slots.filter((slot) => !slot.custom).length;
  const wantReused = court ? 0 : Math.floor((freshSlots * ads.reusePercent) / 100);
  const shelved = wantReused > 0 ? pickForReuse(wantReused, []) : [];

  if (shelved.length > 0) {
    onInfo?.(
      `${shelved.length} of ${freshSlots} spots are repeats from the shelf — ` +
        `${freshSlots - shelved.length} written fresh.`,
    );
  }

  // ── Build the copy requests.
  const requests: Array<SpotRequest | null> = [];
  const spots: Array<AdSpot | null> = [];
  // A trader that advertises a place takes one the realm actually has. With no
  // recorded geography at all those traders simply do not trade tonight —
  // inventing a town to sell insurance in is the same lie as inventing a deed.
  const traders = court ? placeTraders(COURT_TRADERS, court.places, runSeed) : INVENTED;
  const invented = shuffled(traders, runSeed);
  let inventedAt = 0;

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const reader = readerFor(ads, i);

    if (slot.custom) {
      spots.push({
        kind: "custom",
        sponsor: slot.custom.name || slot.custom.audioFile,
        lines: [],
        audioFile: resolveAdFile(slot.custom.audioFile) ?? undefined,
      });
      requests.push(null);
      continue;
    }

    // A repeat, if there is one left to hand out. It arrives already produced,
    // so it needs no copy request and no line to synthesise.
    const repeat = shelved.shift();
    if (repeat) {
      spots.push({
        kind: repeat.kind as SpotKind,
        sponsor: repeat.sponsor,
        // Carried for the commercial log and the transcript only. The audio is
        // already cut, so nothing here is ever synthesised.
        lines: [{ voice: "announcer", text: repeat.text }],
        angle: repeat.angle,
        libraryId: repeat.id,
      });
      requests.push(null);
      continue;
    }

    if (slot.promo) {
      spots.push({
        kind: "promo",
        sponsor: court ? config.orion.king.name : config.show.station,
        lines: court
          ? proclamationLines(config, court.places, runSeed + i * 3)
          : promoLines(config, topic, runSeed + i * 3),
      });
      requests.push(null);
      continue;
    }

    const source = slot.sponsor
      ? {
          name: slot.sponsor.name,
          product: slot.sponsor.product,
          talkingPoints: slot.sponsor.talkingPoints,
          tagline: slot.sponsor.tagline,
          style: slot.sponsor.style,
        }
      : { ...invented[inventedAt++ % invented.length], talkingPoints: "", style: "" };

    const history = histories.get(source.name);
    const tonight = usedTonight.get(source.name) ?? new Set<string>();
    const angle = chooseAngle(history?.angles ?? [], tonight, rand, usedByAnyone);
    const appearance = tonight.size;
    tonight.add(angle.id);
    usedTonight.set(source.name, tonight);
    usedByAnyone.add(angle.id);

    spots.push(null);
    requests.push({
      kind: reader === "announcer" ? "produced" : "live_read",
      sponsor: source,
      reader,
      angle,
      words: Math.max(18, Math.round(ads.spotWords * angle.length)),
      appearance,
    });
  }

  // ── One call for the show's whole ad load.
  const pending = requests.filter((r): r is SpotRequest => r !== null);
  let written: SpotLine[][] = [];

  if (pending.length > 0) {
    onInfo?.(`Writing ${pending.length} spot${pending.length === 1 ? "" : "s"} for the break...`);
    written = await writeCopy(config, pending, signal, court);
  }

  let writtenAt = 0;
  const log: Array<{ sponsor: string; angle: string; opening: string }> = [];

  const finished: AdSpot[] = spots.map((spot, i) => {
    if (spot) return spot;

    const request = requests[i] as SpotRequest;
    const lines = written[writtenAt++] ?? [];
    const body = lines.length > 0 ? lines : templateLines(request.sponsor, config.show.station, runSeed + i);

    log.push({ sponsor: request.sponsor.name, angle: request.angle.id, opening: openingOf(body[0]?.text ?? "") });

    return {
      kind: request.kind,
      sponsor: request.sponsor.name,
      lines: body,
      angle: request.angle.id,
      // Small print on about half the produced spots. On every one it stops
      // being a joke and starts being a format.
      disclaimer: smallPrintFor(
        runSeed + i * 7,
        request.kind === "produced" && (runSeed + i * 13) % 100 < 55,
        Boolean(court),
      ),
    };
  });

  // Written down before it airs, so tomorrow's brief already knows.
  remember(log);

  const dealt = dedupeOpenings(finished);

  // ── Deal them into breaks.
  const breaks: AdBreak[] = [];
  for (let i = 0; i < ads.breaks; i++) {
    breaks.push({
      index: i,
      spots: dealt
        .slice(i * ads.spotsPerBreak, (i + 1) * ads.spotsPerBreak)
        .filter((s) => s.lines.length > 0 || s.audioFile || s.libraryId),
    });
  }

  return breaks.filter((b) => b.spots.length > 0);
}

/** FNV-1a, so a station and a topic give a stable starting point. */
function hashOf(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function randomFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stop two adverts on the same log opening with the same words.
 *
 * The model will not reliably do this on its own, and asking it to by quoting
 * the words back makes things worse. But it always writes more advert than it
 * needs, so an advert whose first line has already been heard tonight can
 * simply start on its second - which is usually the better line anyway.
 */
function dedupeOpenings(spots: AdSpot[]): AdSpot[] {
  const heard = new Set<string>();

  const key = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .join(" ");

  return spots.map((spot) => {
    // A repeat is already recorded; trimming its text would only make the log
    // disagree with what actually goes out.
    if (spot.lines.length === 0 || spot.libraryId) return spot;

    let lines = spot.lines;
    // Never strip an advert down to a single line to avoid a repeat; a short
    // repeat is better than half an advert.
    while (lines.length >= 3 && heard.has(key(lines[0].text))) lines = lines.slice(1);

    heard.add(key(lines[0].text));
    return lines === spot.lines ? spot : { ...spot, lines };
  });
}

/**
 * Bind the place-bound traders to real locations.
 *
 * `{place}` in a trader's name, product or tagline is filled from the realm's
 * own geography, one trader per place so a single ford does not end up hosting
 * four separate businesses in one break.
 */
function placeTraders<T extends { name: string; product: string; tagline: string }>(
  all: T[],
  places: string[],
  seed: number,
): T[] {
  const pool = shuffled(places.filter(Boolean), seed);
  let at = 0;

  return all.flatMap((trader) => {
    const wants = `${trader.name}${trader.product}${trader.tagline}`.includes("{place}");
    if (!wants) return [trader];
    if (at >= pool.length) return [];

    const place = pool[at++];
    const fill = (text: string) => text.split("{place}").join(place);

    return [{ ...trader, name: fill(trader.name), product: fill(trader.product), tagline: fill(trader.tagline) }];
  });
}

/** Alternate readers so a break is not one voice for a minute. */
function readerFor(ads: AdsConfig, index: number): "a" | "b" | "announcer" {
  if (ads.style === "produced") return "announcer";
  if (ads.style === "live_read") return index % 2 === 0 ? "a" : "b";
  // Mixed: announcer, host, announcer, host...
  return index % 2 === 0 ? "announcer" : index % 4 === 1 ? "a" : "b";
}

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const ORDINALS = [
  "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT",
  "NINE", "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN",
];

const ordinal = (i: number): string => ORDINALS[i] ?? `NUMBER ${i + 1}`;

/**
 * A different slice of what an advertiser has to say, per appearance.
 *
 * Everything is still true of the business; the advert just leads on something
 * else. Rotating rather than sampling means nothing is ever permanently unsaid.
 */
function rotatePoints(talkingPoints: string, appearance: number): string {
  const sentences = String(talkingPoints ?? "")
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (sentences.length < 3) return sentences.join(" ");

  const keep = Math.max(2, Math.ceil(sentences.length * 0.6));
  const from = (appearance * keep) % sentences.length;

  return Array.from({ length: keep }, (_, i) => sentences[(from + i) % sentences.length]).join(" ");
}

/**
 * One advertiser's brief, written as English rather than as fields.
 *
 * The shape of this matters more than the content. A brief written as
 * `Name — sells: X — format: Y — read by: Z` is, to a Llama-family model, a
 * function signature, and it answers with `{"name": ..., "parameters": ...}`
 * instead of copy — measured, repeatedly, on exactly this prompt. The same
 * information in sentences comes back as an advert.
 */
function spotBrief(request: SpotRequest, index: number): string {
  const s = request.sponsor;
  const parts = [`SPOT ${ordinal(index)} is for ${s.name}`];

  if (s.product) parts[0] += `, which sells ${s.product}`;
  parts[0] += ".";

  // The second advert for the same shop gets a different half of what there is
  // to say about it. Two spots with the same brief and only a different format
  // still come back as one advert written twice — measured, on this model.
  const points = rotatePoints(s.talkingPoints, request.appearance);
  if (points) parts.push(points);
  parts.push(request.angle.brief);
  if (s.tagline) parts.push(`Finish on the line "${s.tagline}"`);
  parts.push(`About ${request.words} words.`);
  parts.push(
    request.reader === "announcer"
      ? "A station announcer reads it."
      : "One of the two hosts reads it, in their own voice.",
  );
  if (s.style) parts.push(`Perform it like this: ${s.style}`);
  // Note deliberately absent: an instruction not to reuse a quoted opening.
  // Showing this model the words it used last night and saying "not those" made
  // it use exactly those — measured, twice. What the log is genuinely good for
  // is picking a format the advertiser has not just had, which happens before
  // any of this is written.

  return parts.join(" ");
}

/**
 * A warning when the same business is booked more than once in the same show.
 *
 * Without it the model writes the advert once and hands back near-copies of it
 * under different headings, which is precisely what a listener notices first.
 */
function sameAdvertiserNote(requests: SpotRequest[]): string {
  const positions = new Map<string, number[]>();
  requests.forEach((r, i) => {
    const at = positions.get(r.sponsor.name) ?? [];
    at.push(i);
    positions.set(r.sponsor.name, at);
  });

  const repeated = [...positions.entries()].filter(([, at]) => at.length > 1);
  if (repeated.length === 0) return "";

  const lines = repeated.map(
    ([name, at]) =>
      `${at.map((i) => `SPOT ${ordinal(i)}`).join(" and ")} are both for ${name}, and the same listener ` +
      "hears them within the hour. They must share nothing: different opening words, a different offer, " +
      "different details, a different joke. Do not rewrite one into the other.",
  );

  return `${lines.join("\n")}\n\n`;
}

/**
 * Write every spot in one model call.
 *
 * Ad copy is the one place where a small model is genuinely good: it is short,
 * it is formulaic, and it has heard a hundred thousand of them. The obstacle is
 * that "write me N things to this specification" is the single strongest
 * trigger for a Llama-family model to answer with a tool call — it does it here
 * even when told in the system prompt that it has no tools.
 *
 * What actually breaks the habit is putting the first few words in its mouth.
 * An assistant turn ending mid-advert leaves it nothing to continue but prose,
 * and the copy that comes back is good. So the first attempt is prefilled, a
 * plain attempt backs it up, and behind both is a template.
 */
async function writeCopy(
  config: Config,
  requests: SpotRequest[],
  signal?: AbortSignal,
  court?: CourtAds,
): Promise<SpotLine[][]> {
  const brief = requests.map((r, i) => spotBrief(r, i)).join("\n\n");
  const count = requests.length;

  const order = requests
    .map((_, i) => `SPOT ${ordinal(i)}`)
    .join(", then a line containing only ---, then ");

  const system = court
    ? "You write what a crier shouts in the market at the gate of a king's hall. You write the words " +
      "said out loud and nothing else. You have no tools and no functions and you never call one. " +
      "You never reply with JSON, a schema, a field name or a curly brace. Plain spoken English only."
    : "You are a copywriter at a local radio station. You write the words the presenter says out loud " +
    "and nothing else. You have no tools and no functions and you never call one. " +
    "You never reply with JSON, a schema, a field name or a curly brace. Plain spoken English only.";

  // A court's market is sold the way Futurama sells things: brisk commercial
  // cheer wrapped around something plainly awful, by people entirely at peace
  // with it. The joke is never that fantasy is silly - it is that a working
  // market has grown up around a war nobody is winning.
  const courtRules = court
    ? "\nThese are cried in the market at the gate of a king's hall, in a dark fantasy realm at war." + "\n" +
      "- Sell it like a modern advert, set in a world with no modern anything. Brisk, upbeat, commercial," + "\n" +
      "  and completely unbothered that the product is grim, illegal, or plainly a crime." + "\n" +
      "- The comedy is the tone against the content. Never wink at it. Nobody in it finds it odd." + "\n" +
      "- Concrete mediaeval detail: coin, oats, iron, tolls, horses, weather, debts, an unsafe road." + "\n" +
      "- No radio, no station, no listeners, no broadcast, no electricity, no telephones, no science." + "\n" +
      (court.places.length > 0
        ? `- The realm's actual places are: ${court.places.join(", ")}. You may name these and no others.` +
          "\n  Never invent a town, a river or a road. Somewhere unnamed is fine: the old crossing." + "\n"
        : "- The realm has no recorded places, so name none. Say the crossing, the road, the north." + "\n") +
      "- Never name Wommper, the King, or the Respawn Guild unless the brief names them." + "\n"
    : "";

  const user =
    (court
      ? `Write ${count === 1 ? "a market cry" : `${count} market cries`} for the traders at the gate.\n\n`
      : `Write ${count === 1 ? "a radio advert" : `${count} radio adverts`} for a station called "${config.show.station}".\n\n`) +
    `${brief}\n\n` +
    courtRules +
    "Every advert names the business in its first sentence and again in its last, and includes one " +
    "concrete invented detail — a price, a street, opening hours, how long they have been trading. " +
    "Each one finishes on a call to action and then its tagline. Never open with \"Are you tired of\", " +
    "\"Introducing\", \"Looking for\", \"Imagine\" or \"Picture this\", and no two of them may open the " +
    "same way as each other. Write only the words that are spoken aloud — no headings, no labels, no " +
    "stage directions. Never mention that any of this is fictional.\n\n" +
    `${sameAdvertiserNote(requests)}` +
    `Write ${order}. Nothing else.`;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  // Generous on purpose: a spot that runs out of tokens ends mid-word, and
  // the cost of over-provisioning is nothing, because nothing is waiting on it.
  const budget = Math.min(3000, 200 + requests.reduce((n, r) => n + Math.round(r.words * 3.2), 0));

  // The prefill: the first advertiser's name, said the way the format would
  // say it. Local servers continue a trailing assistant turn; Gemini does not
  // work that way and does not need the help.
  const opener = requests[0].angle.length < 1 ? `${requests[0].sponsor.name}!` : `${requests[0].sponsor.name}.`;
  const canPrefill = config.llm.provider !== "gemini";

  const attempts: Array<{ messages: ChatMessage[]; prefix: string }> = [];
  if (canPrefill) {
    attempts.push({ messages: [...messages, { role: "assistant", content: opener }], prefix: `${opener} ` });
  }
  attempts.push({ messages, prefix: "" });

  for (const attempt of attempts) {
    try {
      const text = await generate({ ...config.llm, model: config.llm.commercialModel || config.llm.model }, {
      priority: "background",
        messages: attempt.messages,
        temperature: 0.95,
        maxTokens: budget,
        signal,
      });

      const lines = splitSpots(`${attempt.prefix}${text}`, requests);
      // One usable advert is worth keeping; the rest fall back individually.
      if (lines.some((l) => l.length > 0)) return lines;
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      // Try the next shape of the same request.
    }
  }

  // Nothing usable. The caller substitutes a template.
  return requests.map(() => []);
}

/**
 * Cut one response into one advert per request.
 *
 * Positionally, never by filtering: dropping an unusable block would shift
 * every advert after it onto the wrong advertiser, which is a worse failure
 * than a template, and a silent one.
 */
function splitSpots(text: string, requests: SpotRequest[]): SpotLine[][] {
  const blocks = text.split(/^\s*-{3,}\s*$/m).map((b) => b.trim());

  return requests.map((r, i) => {
    const block = blocks[i] ?? "";
    if (!block || block.length < 20 || looksLikeToolCall(block)) return [];
    return toLines(block, r.reader, r.words, r.sponsor.name);
  });
}

/**
 * Turn a block of copy into speakable lines.
 *
 * Splitting on sentences matters for more than tidiness: each line is
 * synthesised separately, so the break can start playing while the rest of it
 * is still being spoken.
 */
/**
 * Sentences that are the model talking about the job rather than doing it.
 *
 * These turn up at the end of a block — "I will now write the function calls in
 * JSON format" arrived on the end of a real advert — and unlike a mangled
 * sentence they would be read out on air in an announcer's voice, so they are
 * cut wherever they appear rather than only at the end.
 */
function isMetaSentence(sentence: string): boolean {
  const t = sentence.trim();
  if (!t) return true;
  if (/\b(?:json|schema|function call|tool call|api call|markdown|placeholder)\b/i.test(t)) return true;
  if (/\bas an? (?:ai|language model|assistant)\b/i.test(t)) return true;
  if (/^(?:here (?:is|are)|i (?:will|can|have|hope)|let me know|note:|word count|approx)/i.test(t)) return true;
  if (/\(\s*(?:about\s*)?\d+\s*words?\s*\)/i.test(t)) return true;
  return false;
}

export function toLines(
  copy: string,
  reader: "a" | "b" | "announcer",
  maxWords: number,
  /** Names that keep their capitals even inside a sentence that was shouted. */
  proper = "",
): SpotLine[] {
  let cleaned = String(copy ?? "")
    .replace(/^\s*(?:spot\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\s*[:.-]\s*/i, "")
    .replace(/\[[^\]\n]{0,120}\]/g, " ")
    .replace(/\*\*?/g, "")
    .replace(/^\s*["']|["']\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned || looksLikeToolCall(cleaned)) return [];

  // A model asked for a hard sell will sometimes shout a whole sentence in
  // capitals, which some speech engines read as an acronym. A long shouted run
  // comes back down to a sentence; short emphasis like SAME DAY is left alone,
  // and the run cannot cross a full stop, so the next sentence keeps its shape.
  // Proper nouns inside the shout lose their capitals, which is a fair price.
  cleaned = cleaned.replace(/[A-Z][A-Z'’\d]*(?:[ ,'’-]+[A-Z][A-Z'’\d]*){3,}/g, (run) =>
    run.charAt(0) + run.slice(1).toLowerCase(),
  );

  // ...except the advertiser's own name, which is the one word in the line that
  // has to look right in the transcript.
  for (const word of proper.split(/\s+/).filter((w) => w.length > 2)) {
    const safe = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`\\b${safe}\\b`, "gi"), word);
  }

  const words = cleaned.split(/\s+/);
  const capped = words.length > maxWords * 2 ? `${words.slice(0, maxWords * 2).join(" ")}.` : cleaned;

  let sentences = capped
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s && !isMetaSentence(s));

  // A spot that ran into the token limit ends mid-thought - "and stuff for." -
  // and an announcer reads that out with total conviction. Cut back to the last
  // clause that finished, or drop the sentence if there is another one.
  const TRAILS = /(?:^|[ ,])(?:and|but|so|or|nor|with|for|of|to|that|which|when|because|at|in|on|we're|it's|you're|the|a|an)[ ]*[.!?]?$/i;

  while (sentences.length > 0) {
    const last = sentences[sentences.length - 1];
    if (!TRAILS.test(last)) break;

    const comma = last.lastIndexOf(",");
    const salvage = comma > 0 ? last.slice(0, comma).trim() : "";

    if (salvage.split(/\s+/).length >= 4 && !TRAILS.test(salvage)) {
      sentences[sentences.length - 1] = `${salvage}.`;
      break;
    }

    if (sentences.length === 1) break; // something is better than nothing
    sentences.pop();
  }

  // Keep sentences together in pairs so the spot does not become a stutter of
  // one-line clips, each with its own synthesis overhead.
  const lines: SpotLine[] = [];
  for (let i = 0; i < sentences.length; i += 2) {
    const text = sentences.slice(i, i + 2).join(" ");
    if (text) lines.push({ voice: reader, text });
  }

  return lines;
}

/* ── Audio ───────────────────────────────────────────────────────── */

/** The announcer, as the rest of the pipeline sees a speaker. */
function announcerVoice(config: Config): SpeakerVoice {
  return config.ads.announcer;
}

function voiceOf(config: Config, role: "a" | "b" | "announcer"): SpeakerVoice {
  return role === "announcer" ? announcerVoice(config) : hostFor(config, role);
}

/** Read a supplied spot off disk, whatever container it is in. */
async function loadCustom(file: string): Promise<AudioBuffer> {
  const raw = fs.readFileSync(file);
  const decoded = path.extname(file).toLowerCase() === ".mp3" ? await decodeMp3(raw) : decodeWav(raw);
  return normalize(resample(decoded, SAMPLE_RATE), 0.85);
}

/**
 * Render one whole break to a single file.
 *
 * The break is mixed on its own rather than laid into the show's timeline,
 * because that is what lets it be produced to different rules: its own bed,
 * its own compression, and its own loudness. Dropping a finished, already-loud
 * block into the show is exactly how a real desk plays a commercial log.
 */
export async function renderBreak(
  config: Config,
  brk: AdBreak,
  outPath: string,
  seed: number,
  signal?: AbortSignal,
  options: { shelve?: boolean } = {},
): Promise<AudioBuffer> {
  const ads = config.ads;
  const scratch = path.join(path.dirname(outPath), `break-${brk.index}-parts`);
  fs.mkdirSync(scratch, { recursive: true });

  /** Synthesise one line and put the advertising voice on it. */
  const speak = async (
    text: string,
    speaker: SpeakerVoice,
    clipPath: string,
    rateBoost: number,
  ): Promise<AudioBuffer | null> => {
    try {
      await synthesize(
        {
          text,
          voice: voiceFor(speaker, config.tts.engine),
          rate: Math.max(-10, Math.min(10, speaker.rate + rateBoost)),
          outPath: clipPath,
        },
        config.tts,
        signal,
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      return null;
    }

    let clip = trimSilence(resample(decodeWav(fs.readFileSync(clipPath)), SAMPLE_RATE));
    clip = applyTone(clip, speaker.tone);
    // Advertising voice: forward, bright and squashed. This is most of what
    // makes a break sound unlike the conversation either side of it.
    clip = peaking(clip, 3200, 3, 0.9);
    clip = compress(clip, { thresholdDb: -18, ratio: 4.5, makeupDb: 5 });
    return normalize(clip, 0.88);
  };

  const mood = ads.bedMood as Mood;

  /** Shelved spots that went out tonight, so the rotation moves on. */
  const played: string[] = [];

  // Each spot is produced on its own, then the spots are butted together.
  // A single bed running the length of a break is the giveaway that it is one
  // recording: on a real log every advert arrives as a finished file with its
  // own music, which starts and stops with the copy.
  const blocks: AudioBuffer[] = [];

  for (let s = 0; s < brk.spots.length; s++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const spot = brk.spots[s];

    // A repeat off the shelf. Already produced — copy, voice and bed — so this
    // is a file read and nothing else, which is the entire point of it.
    if (spot.libraryId) {
      try {
        blocks.push(decodeWav(fs.readFileSync(audioPathFor(spot.libraryId))));
        played.push(spot.libraryId);
        continue;
      } catch {
        // The shelf lost it. Fall through; there is nothing to synthesise
        // either, so this slot simply drops out of the break.
        continue;
      }
    }

    // A supplied file is already a finished advert. It gets the separator and
    // the loudness treatment and otherwise is left alone.
    if (spot.audioFile) {
      try {
        blocks.push(await loadCustom(spot.audioFile));
      } catch {
        // A file that will not decode must not take the break down with it.
      }
      continue;
    }

    const parts: AudioBuffer[] = [];

    for (let l = 0; l < spot.lines.length; l++) {
      const line = spot.lines[l];
      const clip = await speak(line.text, voiceOf(config, line.voice), path.join(scratch, `${s}-${l}.wav`), 0);
      if (clip) parts.push(clip, silence(0.16));
    }

    // The small print, read at a speed nobody is meant to follow and pushed
    // back behind the music, straight off the end of the last word.
    if (spot.disclaimer && parts.length > 0) {
      const print = await speak(
        spot.disclaimer,
        announcerVoice(config),
        path.join(scratch, `${s}-print.wav`),
        6,
      );
      if (print) parts.push(gain(print, 0.6), silence(0.1));
    }

    if (parts.length === 0) continue;

    const voice = concat(parts);
    const lead = 0.3;
    const tail = 0.55;
    const seconds = lead + durationOf(voice) + tail;
    const total = Math.round(seconds * SAMPLE_RATE);
    const out = new Float32Array(total);

    const at = Math.round(lead * SAMPLE_RATE);
    for (let i = 0; i < voice.data.length && at + i < total; i++) out[at + i] += voice.data[i];

    // Its own music, from its own seed, at its own level — so two adverts in a
    // row do not sound like one advert with a pause in it.
    if (mood !== "none" && ads.bedVolume > 0.001) {
      const level = ads.bedVolume * (0.82 + ((seed + s * 31) % 5) * 0.09);
      const bed = gain(fade(generateBed(seconds, mood, seed + s * 977 + 13), 0.35, 0.9), level);
      const ducked = duck(bed.data, out, SAMPLE_RATE, 0.35);
      for (let i = 0; i < ducked.length && i < total; i++) out[i] += ducked[i];
    }

    const block = normalize({ sampleRate: SAMPLE_RATE, data: out }, 0.86);
    blocks.push(block);

    // Onto the shelf, so some future show can play it without writing or
    // recording it again. Stored produced, exactly as it just went out.
    if (spot.kind !== "custom" && options.shelve !== false) {
      shelve({
        sponsor: spot.sponsor,
        angle: spot.angle ?? "",
        kind: spot.kind,
        text: spot.lines.map((l) => l.text).join(" "),
        seconds: durationOf(block),
        wav: encodeWav(block),
      });
    }
  }

  markPlayed(played);

  fs.rmSync(scratch, { recursive: true, force: true });

  if (blocks.length === 0) {
    // No spot survived. An empty break is better than a broken show.
    const empty: AudioBuffer = { sampleRate: SAMPLE_RATE, data: new Float32Array(0) };
    fs.writeFileSync(outPath, encodeWav(empty));
    return empty;
  }

  // A short hit between adverts, rotating, so the join reads as the next one
  // starting rather than the same one continuing.
  const SEPARATORS: StingKind[] = ["bumper", "whoosh", "beep"];
  const joined: AudioBuffer[] = [];

  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) {
      const kind = SEPARATORS[(seed + i) % SEPARATORS.length];
      joined.push(
        silence(0.1),
        gain(makeSting(kind, STING_LENGTHS[kind], seed + i * 13, SAMPLE_RATE), 0.4),
        silence(0.08),
      );
    }
    joined.push(blocks[i]);
  }

  const body = concat(joined);

  // Head and tail room for the imaging to breathe either side of the log.
  const lead = 0.55;
  const tailRoom = 1.4;
  const totalSeconds = lead + durationOf(body) + tailRoom;
  const total = Math.round(totalSeconds * SAMPLE_RATE);
  const out = new Float32Array(total);

  const leadSamples = Math.round(lead * SAMPLE_RATE);
  for (let i = 0; i < body.data.length && leadSamples + i < total; i++) out[leadSamples + i] += body.data[i];

  // ── Imaging. A hit going in, the station coming back out.
  const cues: Array<{ at: number; buffer: AudioBuffer; level: number }> = [
    { at: 0, buffer: makeSting("impact", STING_LENGTHS.impact, seed, SAMPLE_RATE), level: 0.55 },
    {
      at: Math.max(0, totalSeconds - STING_LENGTHS.ident - 0.15),
      buffer: makeSting("ident", STING_LENGTHS.ident, seed + 7, SAMPLE_RATE),
      level: 0.5,
    },
  ];

  for (const cue of cues) {
    const offset = Math.round(cue.at * SAMPLE_RATE);
    for (let i = 0; i < cue.buffer.data.length && offset + i < total; i++) {
      out[offset + i] += cue.buffer.data[i] * cue.level;
    }
  }

  // ── Loudness. Level the block, lift it by the configured amount and catch the
  // peaks. Heavy compression on the voice has already raised the average, so
  // this reads as a real jump rather than a peak change. It is what a break
  // sounds like on its own — auditioned in Ads, or played into the live feed
  // beside dialogue that has not been through the mix. The finished show sets
  // the jump properly, by measuring the break against its own dialogue.
  let mixed: AudioBuffer = { sampleRate: SAMPLE_RATE, data: out };
  mixed = normalize(mixed, 0.8);
  mixed = gain(mixed, Math.pow(10, ads.loudnessDb / 20));
  mixed = limit(mixed, 0.95);

  fs.writeFileSync(outPath, encodeWav(mixed));
  return mixed;
}

/** A one-line description of a break, for the transcript and the live feed. */
export function describeBreak(brk: AdBreak): string {
  const names = brk.spots.map((s) => s.sponsor).filter(Boolean);
  if (names.length === 0) return "Commercial break";
  return `Commercial break — ${names.join(", ")}`;
}
