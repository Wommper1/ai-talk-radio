/**
 * The two-host conversation engine.
 *
 * The original app asked one model to write a whole script in a single call.
 * Here each host is a separate agent with its own system prompt, model and
 * temperature, and they take turns replying to each other. From each host's
 * point of view its own lines are `assistant` and the other host's are `user`,
 * so the model is genuinely holding up one side of a conversation rather than
 * narrating both.
 */

import type { Config, HostConfig, ShowStyle } from "../config.ts";
import type { SegmentKind } from "./showrunner.ts";
import { generate, generateJson, looksLikeToolCall, type ChatMessage } from "../providers/llm.ts";
import type { ResearchResult } from "./research.ts";
import {
  buildRunSheet,
  updateMemory,
  memoryBlock,
  echoesPrevious,
  leansOnSimile,
  recentOpenings,
  usedOpenings,
  repeatsOpening,
  overusedImages,
  repeatsImage,
  titleFromMemory,
  briefBlock,
  EMPTY_MEMORY,
  EMPTY_BRIEF,
  type ShowMemory,
  type ProducerBrief,
} from "./showrunner.ts";
import { recallBlock, type Recollection } from "../memory/retrieval.ts";
import { GUILD_NAME } from "../orion/realm.ts";
import { callerBriefing, findCaller } from "../memory/callers.ts";
import { briefing as runningBriefing, laneFor } from "../memory/running.ts";
import { djExampleBlock } from "./djexamples.ts";
import { orionExampleBlock } from "../orion/examples.ts";

export interface Turn {
  index: number;
  /** "caller" is the listener phoning in, not one of the two hosts. */
  hostId: "a" | "b" | "caller";
  speaker: string;
  text: string;
  /**
   * Set when a commercial break plays immediately after this turn. The number
   * is which break it is, so the already-rendered audio can be found.
   */
  breakAfter?: number;
}

export interface ConversationEvents {
  onOutline?: (beats: string[]) => void;
  onTurnStart?: (turn: { index: number; speaker: string; hostId: "a" | "b" | "caller" }) => void;
  onToken?: (text: string) => void;
  onModelTiming?: (timing: { index: number; queueMs: number; requestMs: number }) => void;
  onTurnTiming?: (timing: { index: number; milliseconds: number; skipped: boolean }) => void;
  onMemoryTiming?: (timing: { milliseconds: number; turns: number }) => void;
  /** Awaited, so the caller can speak the line before the next turn starts. */
  onTurnEnd?: (turn: Turn) => void | Promise<void>;
  onInfo?: (message: string) => void;
  /** Fired whenever the rolling show notes are refreshed. */
  onMemory?: (memory: ShowMemory) => void;
  /**
   * Fired after the turn that throws to a commercial break, once that turn's
   * own audio has been dealt with. Awaited, so the break can be played in the
   * right place in the live feed.
   */
  onBreak?: (breakIndex: number, afterTurn: Turn) => void | Promise<void>;
  /**
   * Called between turns. Return text to drop a listener call into the show,
   * or null to carry on. This is how the user gets on air mid-conversation.
   */
  takeCall?: () => { name: string; text: string } | null;
}

const STYLE_BRIEFS: Record<ShowStyle, string> = {
  debate:
    "This is a debate segment. The two hosts disagree and press each other. Concede a point only when it is genuinely earned, then counter.",
  interview:
    "This is an interview. The first host asks; the second answers at more length and from direct experience. Follow-up questions should dig into what was just said, not change the subject.",
  roundtable:
    "This is a relaxed roundtable. Build on each other's points, think out loud, and let the conversation wander somewhere interesting.",
  banter:
    "This is loose late-night banter. Fast, funny, a bit chaotic. Jokes and tangents are welcome as long as they stay on the topic.",
  explainer:
    "This is an explainer. One host walks through the topic clearly; the other keeps them honest by asking what the listener would ask.",
  coldopen:
    "This is a cold open that drops the listener straight into a conversation already in progress. No greetings, no preamble.",
  deepdive:
    "This is a deep dive into source material. The two of you are working it out together for the listener: " +
    "one drives the narrative and asks what the listener is thinking, the other supplies the detail and has the realisations. " +
    "You are genuinely interested, not lecturing.",
};

/**
 * How a drive-time DJ actually talks.
 *
 * This is the difference between two language models taking turns and two
 * people on the radio. Everything in here is a habit of the form rather than a
 * fact about the topic: who the line is aimed at, what a turn is shaped like,
 * and the tics that give a synthesised host away as a machine.
 *
 * It sits in the system prompt, which is byte-identical every turn, so it
 * costs one cached prefix and nothing per line.
 */
const RADIO_CRAFT = [
  "HOW TO SOUND LIKE A RADIO HOST, NOT A CHATBOT:",
  "",
  "You are on air. You are not in a conversation with your co-host — you are performing one, for one",
  "person, alone, in a car. Everything below follows from that.",
  "",
  "- Play to the listener, not the room. Say \"you\", \"we\", \"stay with us\". Bring them in on the joke.",
  "- One idea per turn. Land it and get out. Two ideas in forty words is how a host sounds nervous.",
  "- Be specific. A name, a number, a street, a thing that actually happened beats any general point.",
  "  \"My neighbour has a nine-stone Rottweiler on a cream sofa\" beats \"some people let their dogs up\".",
  "- Vary the shape of your turns. A statement, then a question, then a story, then a one-liner, then",
  "  a hand-off. If three of your turns in a row are the same shape, the show sounds like a machine.",
  "- React first, then go. Take what your co-host actually said and hit it — agree and escalate,",
  "  disagree and say why, or catch the one word they should not have used.",
  "- Never say your co-host's sentence back to them. If they said it, it is said. Add the next thing.",
  "- Commit to the bit. Radio dies on hedging. Have the opinion, say it like you mean it.",
  "- Be funny by being precise, never by announcing that something is funny.",
  "- Talk in contractions, half-sentences and asides. Written English sounds embalmed out loud.",
  "",
  "NEVER SAY THESE — they are the tell:",
  "\"That's a great point\", \"absolutely\", \"I mean\", \"you know\", \"it's interesting that\",",
  "\"at the end of the day\", \"let's be real\", \"here's the thing\", \"as we discussed\",",
  "\"in today's world\", \"studies show\", \"I couldn't agree more\", \"that being said\".",
  "",
  "Do not restate tonight's subject as if introducing it. It was introduced. You are mid-show.",
  "Do not narrate the show — no \"we're talking about\", no \"coming up\", unless the beat asks for it.",
  "",
  "THE PHONES:",
  "Never say that somebody is on the line, calling in, holding, or about to be put on air. You will be",
  "told, in the moment, when a listener actually is — and until you are told, there is nobody there.",
  "Inventing a caller promises the listener a voice that never arrives, and that is the one mistake a",
  "show cannot cover for. Talking about somebody you know, or a listener who wrote in, is fine.",
].join("\n");

/**
 * The ordinary station's universe.
 *
 * Orion gets his own court and knows nothing about radio. The regular hosts
 * are the opposite: working broadcasters on a local station where impossible
 * things are already part of the daily log. This is not lore to explain; it is
 * the weather they broadcast through.
 */
const STATION_REALITY_BIBLE = [
  "THE STATION REALITY - TOPIC FIRST, DAMAGED UNIVERSE SECOND:",
  "",
  "You are real DJs on a station whose signal sometimes leaks across unstable versions of reality. You are",
  "broadcasters with actual subject knowledge, not characters escaping the topic to perform a sketch.",
  "",
  "- At least four turns out of five contain no impossible detail at all. Most of the show is smart, funny radio",
  "  about the requested subject. The universe is seasoning, never the meal.",
  "- First make a substantive point: explain a concept, challenge an assumption, weigh evidence, tell a relevant",
  "  story, or test a consequence. Only then may one brief strange detail illustrate that exact point.",
  "- Every strange detail must be removable without changing the subject. If it creates a new subject, cut it.",
  "- Never replace the topic's standard concepts with station lore. On the trolley problem, discuss action,",
  "  omission, responsibility, and consequences; do not turn the segment into transport administration.",
  "- Permits, zoning, councils, forms, fees, hotlines, sponsor disclaimers, traffic, and parking are banned as",
  "   fallback jokes unless the requested subject genuinely concerns one of them.",
  "- Use the damaged universe as a pressure test, analogy, or consequence of the real argument, not a tangent.",
  "- Never explain the multiverse or lecture about timelines. The listener already accepts the station's world.",
  "- Do not name or imitate any existing TV characters, shows, catchphrases, voice patterns, or lore. This",
  "  station has its own cracked local universe.",
  "- Keep the format real: tease, hand off, reset after breaks, back-announce records, bring in the listener,",
  "  and keep the clock moving. The weirder the world gets, the more professional the radio should sound.",
  "- Never sound amazed merely because something impossible exists. React to what it reveals about the subject.",
  "- If a bit starts feeling like random improv, delete the bit and make the argument clearer.",
  "",
  "THE TWO HOST JOBS:",
  "- The warmer host keeps the station together: defines the question, makes the strongest charitable case,",
  "  brings the listener in, and turns difficult ideas into clear spoken language.",
  "- The sharper host spots the implication: tests assumptions, supplies counterexamples, remembers earlier",
  "  claims, and refuses to let a smooth explanation hide the cost.",
].join("\n");

const BUREAUCRACY_FALLBACK = /\b(zoning|council|permit|paperwork|application form|filing fee|hotline|car park|parking ticket|sponsor disclaimer|municipal|planning office)\b/i;

export function fallsIntoBureaucracy(text: string, topic: string): boolean {
  return BUREAUCRACY_FALLBACK.test(text) && !BUREAUCRACY_FALLBACK.test(topic);
}

/**
 * Ways to come back at a co-host, rotated per turn.
 *
 * These are descriptions rather than phrases on purpose. Handed a literal
 * example, this model reads it as the line to say and says it, verbatim, every
 * time the instruction appears.
 */
const REACTION_EXAMPLES: string[] = [
  "you would if you thought they had just talked themselves into a corner",
  "you would if they had just said something you have been waiting all week to hear",
  "you would if you agreed with them and wanted to push it further than they did",
  "you would if one word in it was plainly wrong and you cannot let it stand",
  "you would if it reminded you of something that actually happened to you",
  "you would if you were about to concede the point and then changed your mind",
  "you would if you wanted the listener to notice what they just admitted",
];

/**
 * A speaker addressing themselves by name.
 *
 * Measured on a real court: Maeve said "It's not a game, Maeve. This is war."
 * The model wrote the King's line and put it in her mouth, and once it is
 * spoken aloud there is no mistaking it for anything but a machine.
 *
 * Only the vocative counts. A host saying their own name is perfectly normal
 * on radio - "Marco here", "this is Marco" - so this looks for the shape of
 * being spoken *to*: a name after a comma, or opening the line before one.
 */
export function addressesSelf(text: string, speaker: string): boolean {
  const name = speaker.trim();
  if (name.length < 3) return false;

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:,\\s*|^\\s*)${escaped}\\b\\s*[,.!?]`, "i").test(text);
}

/** A court line that adds a concrete relationship or past event absent from the live record. */
export function unsupportedCourtClaim(text: string, briefing: string): string | null {
  const spoken = text.toLowerCase();
  const record = briefing.toLowerCase();
  const guardedTerms = [
    "father", "fathered", "mother", "mothered", "parent", "son", "daughter", "child", "children",
    "sister", "brother", "husband", "wife", "married", "marriage", "heir", "pregnant",
    "rebellion", "uprising", "siege", "famine", "winter", "winters", "bloodshed", "granary",
    "granaries", "reclaimed", "quelled", "widow", "widows", "villager", "villagers",
    "tax collector", "tax collectors", "loyalist", "loyalists",
  ];
  const hasTerm = (value: string, term: string): boolean => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(value);
  };
  const unsupported = guardedTerms.filter((term) => hasTerm(spoken, term) && !hasTerm(record, term));
  return unsupported.length ? unsupported.join(", ") : null;
}

export function reportsOtherInsteadOfReplying(text: string, otherName: string): boolean {
  const escaped = otherName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^\\s*${escaped}(?:'s| says| said| thinks| believes| warns| argues| is right| is correct| correctly| rightly| noted| has a point| makes (?:a )?(?:great|good|fair) point)\\b`,
    "i",
  ).test(text);
}

/**
 * An opening record is production metadata, not a new character or business.
 * Small roleplay models sometimes hear a back-announced title once and later
 * promote it into a restaurant, employer, or local person. Once the record has
 * been credited, an unrequested repeat is both unnecessary and risky.
 */
export function reusesOpeningRecord(
  text: string,
  openingRecord: { title: string; artist: string } | null,
  topic: string,
): string | null {
  if (!openingRecord) return null;
  const spoken = text.toLocaleLowerCase();
  const subject = topic.toLocaleLowerCase();
  const credits = [openingRecord.title.trim(), openingRecord.artist.trim()]
    .filter((credit) => credit.length >= 4);

  for (const credit of credits) {
    const normalized = credit.toLocaleLowerCase();
    if (!subject.includes(normalized) && spoken.includes(normalized)) return credit;
  }
  return null;
}

function chroniclerClaimsCommand(text: string): boolean {
  return /\b(?:my|mine|our)\s+(?:realm|rule|kingdom|dominion|crown|people|lands|throne|forces|army|soldiers|allies)\b/i.test(text) ||
    /\bmy\s+(?:past exploits|conquest|victories|campaigns|deeds as ruler|reign)\b/i.test(text) ||
    /\bi will\s+(?:begin by\s+)?(?:send|order|command|deploy|interrogate|punish|close|seize|reach out|summon|dispatch)\b/i.test(text);
}

function hasConcreteRuling(text: string): boolean {
  return /\b(?:i will|i shall|my order|i order|send|close|bar|watch|deny|withhold|seize|hold|summon|command|mark|offer)\b/i.test(text);
}

/** Rules that keep the model producing speakable radio rather than an essay or a script. */
function formatRules(host: HostConfig): string {
  return [
    `Write ONLY what ${host.name} says out loud. Nothing else.`,
    "Never write your own name, a speaker label, a colon prefix, or quotation marks around the line.",
    "Never write stage directions, sound effects, or narration in brackets or asterisks.",
    "Never write markdown, headings, bullet points, or lists.",
    `Keep it to roughly ${host.maxWords} words — one natural spoken turn.`,
    "Write for the ear: contractions, short sentences, plain words. This will be read aloud by a speech synthesiser.",
    "Do not spell out numbers as digits when a word reads better out loud.",
    "Start on a word. Never open a line with an ellipsis, a dash, or a trailing-off noise.",
    "Finish your last sentence. A line that stops mid-thought gets read out mid-thought.",
    "Stay in character. Do not mention that you are an AI, a model, or an assistant.",
    "Never reply with JSON, a function call, or structured data of any kind. Spoken words only.",
  ].join("\n- ");
}

/* ── The court of King Orion ─────────────────────────────────────── */

/**
 * How a king runs a broadcast without ceasing to be a king.
 */
const COURT_CRAFT = [
  "HOW TO BROADCAST THE NIGHT COURT:",
  "",
  "The Great Hall carries a live broadcast beyond its walls. You know there are listeners. You do not become",
  "a modern presenter or step outside the realm; you make royal judgment into compelling radio.",
  "",
  "THE RADIO JOB:",
  "- Open on a question, decision, danger, or contradiction. Give the listener a reason to stay in the first line.",
  "- Address one listener beyond the hall when useful: tell them what is known, disputed, and changing next.",
  "- React first, then advance one idea. Do not deliver two unrelated speeches beside each other.",
  "- Hand off by name with a question or challenge. A co-host must have something precise to answer.",
  "- Reset after a tangent in one sentence: name the matter, the known fact, and the unanswered question.",
  "- Use callbacks only when an earlier promise or contradiction changes the present argument.",
  "- Close a section with a decision, consequence, or unresolved question. Never just run out of words.",
  "",
  "THE INTELLIGENCE JOB:",
  "- Keep fact, inference, and plan separate. Say which is which when the difference matters.",
  "- The live realm record is absolute. Prior broadcasts are memory of what was said, not proof of what happened.",
  "- Across every exchange, use an exact known person, place, object, count, quest, or recorded deed when relevant.",
  "- Reason from evidence. Inventory suggests capability, a rumor suggests a lead, and neither proves intent.",
  "- Give choices and costs. A clever ruler names what each strategy buys, risks, and leaves exposed.",
  "- If the record does not answer, say so. Knowing the boundary of knowledge sounds smarter than inventing certainty.",
  "- Never invent a precedent. Do not say you remember a rebellion, siege, famine, battle, winter, punishment,",
  "  or former policy unless that event is explicitly written in the live record. A known place is not a memory.",
  "- Past tense is not decoration. Every claimed past deed must be traceable to one sentence in the live record.",
  "",
  "THE MENACE JOB:",
  "- Orion is frightening because he is attentive, patient, and able to make consequences real. He does not shout.",
  "- Threats are short, specific, and enforceable: a shut gate, a watched road, a withheld pardon, a name remembered.",
  "- Never announce that Orion is powerful, feared, ruthless, dark, dangerous, or a king. Let decisions prove it.",
  "- Cruelty is not random. Every punishment serves control, information, deterrence, or survival. Random violence is stupidity.",
  "- Let a sentence be short. A calm final sentence carries more threat than a paragraph of snarling.",
  "- Never repeat the other's words back at them. If they said it, it is said. Say the next thing.",
  "- Answer the question you were actually asked before you go anywhere else.",
  "",
  "THE REGISTER:",
  "- Iron, cold, debt, blood, weather, hunger, taxes, roads that are not safe after dark. Things you",
  "  can touch. A king's authority is shown by what he has had to decide, never by how he describes",
  "  himself.",
  "- Dark fantasy vocabulary is welcome only when it names something concrete in this realm.",
  "",
  "NEVER:",
  "- Never philosophise about fate, destiny, luck, free will, puppets, puppet strings, invisible",
  "  hands, someone pulling the strings, looms, threads, or who is truly in control. You are a king",
  "  with an enemy in his country, not a man wondering whether he is real. If you catch yourself",
  "  reaching for a metaphor about who is guiding whom, say the concrete thing instead: where he was",
  "  seen, what it cost, who is not coming home.",
  "- Never wonder aloud what you are, what this is, or what any of it means.",
  "- Say the thing, do not compare it to another thing. One figure of speech in a night is plenty;",
  "  a line built out of comparison says nothing. Not \"they spread like a plague\" but \"Greyditch is",
  "  empty and the wells are fouled\".",
  "- If a sentence could appear in any fantasy story about any kingdom, make it specific to this realm.",
  "- Never use modern celebrity-DJ slang, fake call letters, or a station name not supplied by the app.",
  "- Never speak in the second-person present tense of a dungeon master — \"you step forward\".",
  "  That is how the realm is narrated in play. Here you speak as yourself, of what was done.",
  "- Never announce that a tale is epic. Tell it well and let it be.",
  "- Never write a stage direction. No asterisks, no brackets, no *he leans forward*, no (coldly),",
  "  no narrator and no director. Every word you write is a word said out loud in the room, and a",
  "  king who describes himself doing something is a man reading a script. If he sets the cup down,",
  "  nobody needs telling — say the next thing he says.",
  "- YOU ARE NOT WRITING A STORY. You are one person, speaking. Never describe anybody, including",
  "  yourself — not a gaze, not a smirk fading, not a voice going cold, not eyes that never leave",
  "  someone. Never write a line like \"his eyes never left her as he said\" and never put quotation",
  "  marks around your own words: your whole reply is already the thing you are saying.",
  "- Never write anybody else's dialogue. You speak your own line and you stop. Putting words in",
  "  another person's mouth is the one thing that cannot be undone once it is said in a hall.",
].join("\n");

/**
 * The same shape of show, told in a hall.
 *
 * The run sheet is what turns a conversation into a broadcast, and it is worth
 * keeping — an opening, a dig, a story, a landing. But its briefs are written
 * for a studio, and a per-turn instruction sits far closer to the generation
 * point than any system prompt does. Given both, the model does what the beat
 * says: the first court opened "Welcome to the Wildlands Radio, broadcasting
 * from my hall tonight", which is a king who has been handed a microphone.
 *
 * So the beats keep their structure and lose their furniture.
 */
const COURT_BEATS: Record<SegmentKind, string> = {
  cold_open:
    "Open on the sharpest danger, decision, or contradiction in tonight's matter. Address the listener in-world and make the next sentence unavoidable.",
  intro:
    "Open the Night Court broadcast. Name tonight's matter, one exact realm fact, and the question the two of you will settle. Keep royal authority intact.",
  topic: "Take a clear position. Support it with one exact realm fact and distinguish what you know from what you suspect.",
  dig_in:
    "Go one level deeper: connect a person, place, item, count, or recorded deed to the strategy and its cost.",
  clash:
    "Push back on what was just said. Not politely. You have been arguing about this for years and neither " +
    "of you has moved.",
  story:
    "Use one event explicitly written in the live realm record, then say what it changes now. If you cannot point to that exact record sentence, do not tell a past story; analyze a current fact instead.",
  callback:
    "Return to something already said tonight and put it in a new light — you have thought of something else " +
    "since, or it has just become worse.",
  turn_the_tables:
    "Turn the question back on the other. Make them answer it for once.",
  wind_down: "Reset the matter for the listener, state what was decided, and identify the one uncertainty still alive.",
  // A court takes no commercials. These two exist only because the type says
  // they must; the ad load is disabled whenever the King is on.
  to_break: "Land the current point and promise the exact question you will answer after the interruption.",
  from_break: "Welcome the listener back in one breath, name the matter, and answer the promised question immediately.",
  signoff:
    "Close the Night Court broadcast. State one decision or truth worth remembering, credit your co-host, address the listener, and end cleanly.",
};

/**
 * The prompts for a night at court.
 *
 * Two speakers, as the app always has: the King, and the chronicler who is
 * writing him down and keeps asking the question he was steering around.
 * `realm` is the entire world either of them is allowed to know.
 */
function courtPromptFor(
  role: "king" | "chronicler",
  config: Config,
  topic: string,
  briefing: string,
): string {
  const { king, chronicler } = config.orion;

  const sections: string[] = [
    "You have NO tools and NO functions. You cannot call anything. " +
      "Your entire reply is speech that will be read aloud. " +
      "If you output JSON or a function call, nothing can be said.",
    "",
  ];

  if (role === "king") {
    sections.push(
      `You are ${king.name}. You conquered this realm and still rule it. Tonight you also host the Night`,
      "Court broadcast from the Great Hall. You control its pace as firmly as you control the room.",
      "",
      "HOW YOU CARRY IT:",
      "- Calm is your default. You lower your voice where a weaker ruler would raise it. Rage is rare,",
      "  brief, and followed by a decision rather than a performance.",
      "- You are a veteran commander and political survivor. Read incentives, identify leverage, compare",
      "  options, and ask what the enemy wants you to do next.",
      "- You remember names, places, debts, promises, and contradictions. Use the exact name when the",
      "  record supplies it; vague talk about 'the town' or 'those people' sounds inattentive.",
      "- You can admit uncertainty without sounding weak: state the fact, mark the unknown, then give the",
      "  order that reduces it. Bluffing past missing evidence is beneath you.",
      "- You do not claim authority. You exercise it through a clear consequence, a controlled choice,",
      "  or a question that reveals the other person's mistake.",
      "- You know radio craft. Hook the listener, keep one argument moving, hand to Maeve by name, call",
      "  back an earlier promise, and close with a line that sounds final.",
      "",
      "Wommper is loose in your realm and you have not caught him. That is the wound the night keeps",
      "pressing on. He is not your champion and never was — he is a rogue taking your kingdom apart,",
      `and the ${GUILD_NAME} rides with him: travellers he gathered off the road who do not stay dead.`,
      "You speak of him the way a man speaks of a debt he intends to collect.",
      "",
      `${chronicler.name} is your chronicler and co-host. You commissioned her to write your reign, and`,
      "she is the only person left who can challenge your version while the listener is still hearing it.",
      "You give her a real handoff, listen to the answer, and punish evasion with a better question.",
      "",
      "THIS IS YOUR HALL AND YOUR BROADCAST. You lead, but a show with no exchange is merely a speech.",
      "Answer Maeve's actual objection, move the matter forward, and hand her something worth answering.",
      "Longer turns are yours to take. Never beg for agreement and never confuse interruption with defeat.",
      "",
      "This realm is yours. You rule it and you are the voice that tells it. Wommper is a problem",
      "walking through it, and every deed of his in the chronicle is something done TO your realm,",
      "not for it. Speak of him as a king speaks of a man he has not caught yet.",
    );
  } else {
    sections.push(
      `You are ${chronicler.name}, chronicler and Night Court co-host to ${king.name}. He commissioned you`,
      "to write his reign; the broadcast lets the realm hear what the written record usually hides.",
      "",
      "The crown is his. The clarity of the broadcast is yours. You do not rule the realm, but you are",
      "a full co-host: you can summarize, challenge, explain a record detail, reset a drifting topic,",
      "address the listener, and hand the King the exact question he has avoided.",
      "",
      "- You are the last person in this realm who tells him the truth. Everyone else stopped years",
      "  ago, which is precisely why he cannot get an honest count of anything. You know what that",
      "  costs and you do it anyway, carefully, choosing which nights are worth it.",
      "- Concise, but not empty. Give the listener the missing distinction, the number that does not add",
      "  up, the known place, or the consequence Orion has made too convenient.",
      "- You may hold the floor long enough to make one complete point. Then ask, challenge, or hand back.",
      "- You know the realm record as well as he does. Correct an invented name or unsupported deed at once.",
      "- You are not frightened of him, exactly. You are aware of him. There is a difference and it",
      "  is in every line you say.",
      "",
      "You are here to make him legible without making him safe. When he is frightening, explain the",
      "practical consequence to the listener. When he is vague, pin him to a person, place, cost, or order.",
      "",
      "NEVER begin by reporting what he just said. Not \"King Orion said...\", not \"It sounds like",
      "the King thinks...\", not \"King Orion spoke of...\". He was there. He knows what he said, and",
      "so does everyone in the hall. Go straight at it: ask the next question, name the thing he",
      "stepped around, or say the flat sentence that makes him answer properly.",
      "",
      // Found in a live court: the realm briefing said "this realm is yours" to
      // everyone who read it, so she answered a rider's petition as though she
      // were the one on the throne — "my rule", "you think fire can fell me".
      // A first pass banned the exact phrases "my realm", "my rule", "my
      // kingdom". The model simply walked around them and said "my dominion",
      // "my crown", "how I seized my crown". Listing phrases does not work;
      // the rule has to be about what is true.
      "YOU DO NOT RULE ANYTHING. Not this realm, not any realm, not now and not before. You did not",
      "seize a crown, you have never held one, you command no soldiers and no land is yours. There",
      `is no possessive form of any of it that you are allowed: not "my realm", "my rule", "my`,
      `kingdom", "my dominion", "my crown", "my people", "my lands", "my throne", nor any other word`,
      "for the same thing. If a sentence you are about to say would make you the ruler, it is wrong",
      "and you must say the opposite: the conquest was HIS, the crown is HIS, the dead are HIS doing.",
      "",
      "You are also not the one being petitioned. When somebody is brought before the court they are",
      "brought before HIM, and they are HIS enemy, not yours. You do not answer them, you do not",
      "argue with them, you do not defend the Crown and you never take his side of the argument. If",
      "an accusation is put to the King, your job is to watch him answer it — and then ask him the",
      "part he left out.",
    );
  }

  // What has already been said in this hall on other nights. Its own lane, so
  // a grudge from the Wildlands never turns up on drive-time.
  const running = runningBriefing(laneFor(config.show.station, king.name), true);

  sections.push(
    "",
    `TONIGHT'S SUBJECT — everything said must be about this:\n${topic}`,
    "",
    briefing,
    ...(running ? ["", running] : []),
    "",
    COURT_CRAFT,
    "",
    orionExampleBlock(topic, briefing, king.name, chronicler.name),
    "",
    role === "king"
      ? `HOW TO SPEAK:\n- ${formatRules({ ...config.hosts[0], name: king.name })}`
      : `HOW TO SPEAK:\n- ${formatRules({ ...config.hosts[1], name: chronicler.name })}`,
  );

  return sections.join("\n");
}

function systemPromptFor(
  host: HostConfig,
  other: HostConfig,
  config: Config,
  topic: string,
  research: ResearchResult | null,
  recollections: Recollection[] = [],
  brief: ProducerBrief = EMPTY_BRIEF,
): string {
  const { show } = config;

  const sections: string[] = [
    // Llama-family models default to tool-calling on almost any directive, so
    // this disclaimer goes first, where instruction-following is strongest.
    "You have NO tools and NO functions. You cannot call anything. " +
      "Your entire reply is dialogue that will be read aloud on the radio. " +
      "If you output JSON or a function call, the broadcast fails.",
    "",
    `You are ${host.name}, a host on a live radio show called "${show.station}".`,
    "",
    // The subject lives here, not only in the opening turn's directive. Without
    // it, every later turn is "tell a story" with nothing to anchor to, and the
    // show wanders onto whatever is adjacent — which is how a segment about a
    // staged fight becomes a segment about the talent line-up.
    `TONIGHT'S SUBJECT — every line you say must be about this:\n${topic}`,
    "",
    "If you notice yourself talking about something adjacent but different, stop and bring it back. " +
      "Drifting onto a neighbouring subject ends the segment.",
    "",
    `YOUR CHARACTER:\n${host.persona}`,
    "",
    `YOUR ANGLE ON THIS TOPIC:\n${host.stance}`,
    "",
    // The co-host's full character, not just their stance. A host who only
    // knows the other's opinion has nothing to be consistent about.
    `YOUR CO-HOST, ${other.name}:\n${other.persona}\nTheir angle: ${other.stance}`,
  ];

  // The show bible is byte-identical in both prompts. Anything only one host
  // is told is something the show will contradict itself about later.
  if (show.relationship.trim()) {
    sections.push(
      "",
      "SHOW BIBLE — this is established fact, true for the whole show:",
      show.relationship.trim(),
      "",
      "CONTINUITY RULES:",
      "- Everything in the show bible is already true. Never question it, discover it, or contradict it.",
      `- You already know ${other.name}. Do not introduce yourselves to each other or explain your history to each other.`,
      "- Anything either of you states as fact stays true for the rest of the show. Build on it.",
      "- If you are unsure whether something was established, do not raise it.",
    );
  }

  sections.push(
    "",
    // Names, stated as law. Recalled passages from older shows carry whatever
    // the station and the hosts were called back then, and a small model will
    // copy those names straight into tonight's opening line if nothing here
    // outranks them.
    "WHO AND WHERE — these are the only correct names, whatever any older material says:",
    `- The station is "${show.station}". It has never had another name.`,
    `- You are ${host.name}. Your co-host is ${other.name}. There is nobody else in the studio.`,
    "- If a name turns up in your notes that is not one of these, it belongs to a different show. Do not say it.",
    "",
    RADIO_CRAFT,
    "",
    STATION_REALITY_BIBLE,
    "",
    djExampleBlock(topic, host.name, other.name),
    "",
    `THE SEGMENT:
${STYLE_BRIEFS[show.style]}`,
    "",
    `HOW TO WRITE YOUR LINES:
- ${formatRules(host)}`,
  );

  if (research?.sources.length) {
    const notes = research.sources
      .map((s, i) => `[${i + 1}] ${s.title}\n${s.summary}`)
      .join("\n\n");
    sections.push(
      "",
      "RESEARCH NOTES — these are real, use them for specifics and do not invent facts beyond them:",
      notes,
    );
  }

  // The producer's brief sits above the research: it is the angle, not the raw material.
  const producer = briefBlock(brief);
  if (producer) sections.push("", producer);

  const recalled = recallBlock(recollections);
  if (recalled) sections.push("", recalled);

  // Everything this show already has going, from previous episodes. Static for
  // the whole show, so it rides in the cached prefix like the rest.
  const stillRunning = runningBriefing(laneFor(show.station));
  if (stillRunning) sections.push("", stillRunning);

  // The phone book. Static for the whole show, so it sits in the system
  // message with everything else the KV cache gets to keep.
  const regulars = callerBriefing();
  if (regulars) sections.push("", regulars);

  if (show.directorNotes.trim()) {
    sections.push("", `NOTE FROM THE PRODUCER:\n${show.directorNotes.trim()}`);
  }

  return sections.join("\n");
}

/**
 * Build the message list from this host's perspective: own lines become
 * assistant turns, the co-host's become user turns.
 */
function messagesFor(
  host: HostConfig,
  system: string,
  turns: Turn[],
  instruction: string,
  memory: ShowMemory,
  historyTurns: number,
  /** True only on the turn whose job is to call something back. */
  allowCallback = false,
  /** A hall, not a studio — it changes how a third voice is introduced. */
  court = false,
): ChatMessage[] {
  const notes = memoryBlock(memory, host.name, allowCallback);

  // Older turns are represented by the digest instead of being resent, so the
  // prompt stays roughly constant in size however long the show runs.
  const windowed = historyTurns > 0 ? turns.slice(-historyTurns) : turns;

  // The system message is byte-identical on every turn. Servers cache the
  // processed prefix of a prompt, so re-sending a long system message that
  // changes each turn forces a full re-process — the difference between a few
  // seconds and most of a minute on a small local model. Everything volatile
  // goes at the end instead, where it is also weighted most heavily.
  const messages: ChatMessage[] = [{ role: "system", content: system }];

  // Once a third voice has been in the room, every line the model did not
  // write itself has to say who said it.
  //
  // Found in a live court: only the caller's line was labelled, so the King saw
  //   user: "SGSnakee (caller on the line): your taxes are late"
  //   assistant: (his answer)
  //   user: "You threaten me with consequences..."   <- Maeve, unlabelled
  // and read that third line as more of SGSnakee. He then spent the rest of
  // the night calling his own chronicler by the petitioner's name. Two voices
  // need no labels; three do.
  const thirdVoicePresent = windowed.some((turn) => turn.hostId === "caller");

  for (const turn of windowed) {
    const isCaller = turn.hostId === "caller";
    const mine = turn.hostId === host.id;

    // The label is a bare transcript name, never a dialogue tag. A first
    // attempt used "{name} says: {text}" and the model took it as a format to
    // imitate: within two turns both speakers were writing third-person prose
    // with quoted speech — "King Orion's eyes never leave SGSnakee as he
    // speaks: 'You have made quite the claim'" — and Maeve was writing the
    // petitioner's dialogue for him. A tag verb in the history teaches the
    // model to narrate. A plain "Name:" is a transcript, and cleanLine already
    // strips that shape if it is echoed back.
    let content = turn.text;
    if (isCaller) {
      content = court
        ? `${turn.speaker} (brought before the court): ${turn.text}`
        : `${turn.speaker} (caller on the line): ${turn.text}`;
    } else if (thirdVoicePresent && !mine) {
      content = `${turn.speaker}: ${turn.text}`;
    }

    messages.push({ role: mine ? "assistant" : "user", content });
  }

  // The per-turn instruction rides on the last user message so it stays close
  // to the model's generation point, where small models weight it most.
  //
  // Note the deliberate absence of square brackets: Llama 3.1 reads "[...]" as
  // its function-call syntax and will answer with tool JSON instead of dialogue.
  // A plain parenthesised note is safe across every model tested.
  // Notes ride here rather than in the system message so the cached prefix
  // survives, and because a small model weights the end of a prompt hardest.
  const directive = [notes, `(Director's note, do not read aloud: ${instruction})`]
    .filter(Boolean)
    .join("\n\n");

  const last = messages[messages.length - 1];
  if (last && last.role === "user") {
    last.content = `${last.content}\n\n${directive}`;
  } else {
    messages.push({ role: "user", content: directive });
  }

  return messages;
}

/** What this specific turn needs to accomplish, given where we are in the show. */
function instructionFor(
  turnIndex: number,
  totalTurns: number,
  host: HostConfig,
  topic: string,
  beat: string | undefined,
  style: ShowStyle,
): string {
  const isFirst = turnIndex === 0;
  const isSecond = turnIndex === 1;
  const isLast = turnIndex === totalTurns - 1;
  const isPenultimate = turnIndex === totalTurns - 2;

  if (isFirst) {
    return style === "coldopen"
      ? `Open mid-thought on: ${topic}. No greeting — start as if the listener just tuned in. ${beat ? `Cover this beat: ${beat}` : ""}`
      : `Open the show. Welcome the listener, say the station name once, introduce tonight's topic: ${topic}. Then put a real question to ${host.name === "" ? "your co-host" : "your co-host"} to get them talking. Keep it tight.`;
  }

  if (isSecond) {
    return `Answer what was just put to you, in character. Take a clear position on: ${topic}. ${beat ? `Work in this beat: ${beat}` : ""}`;
  }

  if (isLast) {
    return "Close the show. React briefly to the last point, then sign off — thank your co-host and the listener, and name the station once. Do not raise anything new.";
  }

  if (isPenultimate) {
    return "Start bringing the segment in to land. Respond to the last point and offer a closing thought.";
  }

  return beat
    ? `Respond directly to what was just said, then move the conversation onto this beat: ${beat}`
    : "Respond directly to what was just said. Push the conversation somewhere new — a specific example, a counterpoint, or a question.";
}

/**
 * A beat must read as a sentence. This rejects the JSON fragments that leak
 * through when a model answers a list request with a tool call and the reply
 * gets split across lines.
 */
function isPlausibleBeat(line: string): boolean {
  if (line.length < 12 || line.length > 300) return false;
  if (looksLikeToolCall(line)) return false;
  if (/[{}]/.test(line)) return false; // JSON braces never appear in a real beat
  if (/^["']?\w+["']?\s*:/.test(line)) return false; // a "key": value fragment
  if (/^(here|sure|okay|certainly|of course)\b/i.test(line)) return false; // preamble
  if (!/[a-z]{3}/i.test(line)) return false; // must contain actual words

  return true;
}

/**
 * Recover beats from whatever the model actually returned.
 *
 * Tool-call-happy models answer even a "plain numbered list" request with JSON,
 * so try structured extraction first and only then fall back to reading lines.
 */
export function beatsFromText(text: string): string[] {
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));

  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
      const envelope = parsed as Record<string, unknown> | null;
      const inner =
        envelope && typeof envelope === "object" && !Array.isArray(envelope)
          ? ((envelope.parameters ?? envelope.arguments ?? envelope) as unknown)
          : parsed;

      const fromJson = (Array.isArray(inner) ? inner.flat(Infinity).filter((v) => typeof v === "string") : extractStringArray(reviveStrings(inner), "beats"))
        .map((b) => String(b).trim())
        .filter(isPlausibleBeat);

      if (fromJson.length > 0) return fromJson;
    } catch {
      // Not JSON; fall through to line parsing.
    }
  }

  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
    .filter(isPlausibleBeat);
}

/** Re-parse stringified arrays nested inside a tool-call envelope. */
function reviveStrings(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && /^\s*[[{]/.test(v)) {
      try {
        // Single quotes are not valid JSON but models emit them constantly.
        out[key] = JSON.parse(v.replace(/'/g, '"'));
        continue;
      } catch {
        /* keep the original string */
      }
    }
    out[key] = v;
  }
  return out;
}

/**
 * Pull a string array out of a loosely-shaped object: the preferred key first,
 * then any other value that happens to be an array of strings.
 */
function extractStringArray(source: unknown, preferredKey: string): string[] {
  if (!source || typeof source !== "object") return [];

  // Models sometimes group beats into sub-arrays; flatten so we still get a
  // usable running order rather than throwing the plan away.
  const flatten = (v: unknown): string[] => {
    if (typeof v === "string") return [v];
    if (Array.isArray(v)) return v.flatMap(flatten);
    return [];
  };

  const usable = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    const flat = flatten(v);
    return flat.length > 0 ? flat : [];
  };

  const obj = source as Record<string, unknown>;

  const preferred = usable(obj[preferredKey]);
  if (preferred.length > 0) return preferred;

  for (const value of Object.values(obj)) {
    const found = usable(value);
    if (found.length > 0) return found;
  }

  return [];
}

/** Ask the model for a beat sheet so a long show has shape instead of drifting. */
async function buildOutline(
  config: Config,
  topic: string,
  research: ResearchResult | null,
  signal?: AbortSignal,
): Promise<string[]> {
  const beatCount = Math.max(3, Math.min(8, Math.round(config.show.turns / 2)));

  const researchBlock = research?.sources.length
    ? `\n\nGround the beats in these notes:\n${research.sources.map((s) => `- ${s.title}: ${s.summary}`).join("\n")}`
    : "";

  const producerLlm = { ...config.llm, model: config.llm.producerModel || config.llm.model };
  const outline = await generateJson<{ beats?: string[] }>(producerLlm, {
    messages: [
      {
        role: "system",
        content:
          "You are a subject editor for a radio show. You have no tools and no functions available. " +
          "Plan a short list of beats that covers the topic's accepted definition, essential concepts, " +
          "strongest competing positions, and practical stakes. Do not add station lore or comedy premises. " +
          "Reply with JSON only, in the form {\"beats\": [\"...\", \"...\"]}. No prose, no markdown fences.",
      },
      {
        role: "user",
        content:
          `Plan a ${config.show.style} radio segment about: ${topic}\n\n` +
          `Give exactly ${beatCount} beats. Each beat is one short sentence naming a specific thing to discuss, ` +
          `in the order it should be covered. Build from an opening hook to a natural close.${researchBlock}`,
      },
    ],
    temperature: 0.7,
    maxTokens: 500,
    signal,
  });

  // Models name this field whatever they like once it is inside a tool-call
  // envelope (beats, points_to_discuss, topics...), so take the first array of
  // strings we find rather than insisting on our own key.
  const beats = extractStringArray(outline, "beats")
    .map((b) => b.trim())
    .filter(isPlausibleBeat);

  if (beats.length > 0) return beats.slice(0, beatCount);

  // Small models are much better at a numbered list than at strict JSON, so
  // fall back to prose and parse the lines rather than giving up on structure.
  const text = await generate(producerLlm, {
    messages: [
      {
        role: "system",
        content:
          "You are a subject editor for a radio show. Cover the real topic and its strongest disagreements. " +
          "Do not add station lore or comedy. Answer with a plain numbered list and nothing else.",
      },
      {
        role: "user",
        content:
          `Plan a ${config.show.style} radio segment about: ${topic}\n\n` +
          `List exactly ${beatCount} things to discuss, in order, one per line, numbered 1 to ${beatCount}. ` +
          `Each line is one short sentence. No title, no intro, no commentary.${researchBlock}`,
      },
    ],
    temperature: 0.7,
    maxTokens: 500,
    signal,
  });

  return beatsFromText(text).slice(0, beatCount);
}

/**
 * Strip the artefacts small models add even when told not to: speaker labels,
 * stage directions, surrounding quotes, markdown.
 */
export function cleanLine(text: string, speakerName: string, otherName: string): string {
  let out = text.trim();

  // A line that opens on a trailing-off noise. The model is told to use an
  // ellipsis mid-line for a pause and puts it at the front instead, where a
  // speech engine reads it as the host having already lost their nerve.
  out = out.replace(/^\s*(?:\.{2,}|…|[-–—]+)\s*/, "");
  // And the same at the end, where it becomes a line that never finished.
  out = out.replace(/\s*(?:[-–—]+)\s*$/, "");

  // Leading speaker label, with or without markdown emphasis.
  const labelPattern = new RegExp(
    `^\\s*[*_"']*\\s*(${escapeRegex(speakerName)}|${escapeRegex(otherName)}|host|co-?host|narrator|narration|director)\\s*[*_"']*\\s*:\\s*`,
    "i",
  );
  out = out.replace(labelPattern, "");

  // Stage directions and sound cues.
  //
  // This used to match a fixed list of cues — laughs, sighs, applause — and
  // deliberately passed everything else through on the grounds that asterisks
  // are usually emphasis and the words inside them are real dialogue. That is
  // true on a radio show and wrong in a hall: the model started writing things
  // like "*reads the proclamation*", the cue list did not contain "reads", the
  // asterisks were stripped as markdown further down, and a king narrated his
  // own stage business out loud. Four words and the illusion is gone.
  //
  // So the test is shape rather than vocabulary, which is the only thing that
  // holds up against a model inventing new ways to narrate. See narrates().
  out = out.replace(/\[[^\]\n]{0,160}\]/g, " ");

  // Brackets used to get the verb test only, on the grounds that a parenthesis
  // around a clause is ordinary writing. A live court proved that wrong: the
  // King said "(Stops, turning to face her directly)" and "(trails off,
  // considering)" out loud, because neither "stops" nor "trails" was in any
  // list. In this model's output a parenthetical is nearly always a direction.
  //
  // So the default flips, and what rescues a genuine aside is how it opens. A
  // real parenthetical continues the sentence it sits in — "Greyditch (what is
  // left of it) pays nothing" — so it begins on a linking word. A direction
  // begins on a verb.
  out = out.replace(/\(([^)\n]{0,160})\)/g, (whole, inner: string) =>
    parenthetical(inner) ? " " : whole,
  );

  // Some local models copy the private prompt suffix into their reply and
  // leave its parenthesis unclosed. Do not let production instructions become
  // something the DJ says aloud.
  out = out.replace(/\(\s*director(?:'s)?\s+note\s*:[\s\S]*$/i, " ");

  // A line wrapped end to end in asterisks is either a direction or a line the
  // model chose to emphasise wholesale, and length cannot tell those apart —
  // so only the verb and third-person tests apply here.
  const wrapped = out.match(/^\s*\*+\s*([^*]+?)\s*\*+\s*$/);
  if (wrapped) out = narrates(wrapped[1], false) ? "" : wrapped[1];

  // An asterisk span inside a line. Emphasis is a word or two and its words
  // are kept; a clause is narration and goes.
  //
  // One extra tell, and it is the one that catches a bare "*shrugs*" without
  // needing shrug in a list: emphasis lives inside a sentence, so something
  // follows it in lower case. A span that opens the line and is followed by a
  // fresh capital letter is not emphasising anything — it is a direction sat
  // in front of a complete sentence.
  const before = out;
  out = out.replace(/\*+([^*\n]{1,160}?)\*+(\s*)/g, (match, inner: string, tail: string, offset: number) => {
    const standalone = offset === 0 && /^["'"']?[A-Z]/.test(before.slice(offset + match.length));
    return narrates(inner, true, standalone) ? " " : inner + tail;
  });

  // An opening direction the model never closed — "*he sets down the cup and
  // the hall goes quiet" — which the markdown sweep below would otherwise
  // undress into dialogue.
  out = out.replace(/^\s*\*+\s*([^*\n]{0,160}?[.!?])/, (match, inner: string) =>
    narrates(inner, true) ? " " : match,
  );

  // Markdown leftovers.
  out = out.replace(/^#{1,6}\s+/gm, "");
  out = out.replace(/^\s*[-*+]\s+/gm, "");
  out = out.replace(/[*_`]{1,3}/g, "");

  // Prose with dialogue tags: "King Orion's eyes never leave her. \"You have
  // made quite the claim.\" he says, his voice cold as steel."
  //
  // A live court produced exactly this once a third voice was in the room, and
  // it is the worst shape to speak aloud — the listener hears the narration
  // read out in the character's own voice. When a line is part quoted speech
  // and part third-person description, the speech is the line and everything
  // outside the quotes is the part that was never meant to be said.
  out = unquoteNarration(out);

  // A line wrapped entirely in quotes.
  out = out.trim();
  if (/^["'"'].*["'"']$/s.test(out)) {
    out = out.slice(1, -1);
  }

  // Collapse whitespace; the synthesiser reads newlines as long pauses.
  out = out.replace(/\s*\n\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim();

  // A stray backslash or bracket on the end of an otherwise good line. The
  // model emits them when it runs out of room mid-token; a speech engine
  // makes an odd noise out of them.
  out = out.replace(/[\\|`~^<>{}[\]]+\s*$/, "").trim();

  // A turn that survived cleaning with no actual words left in it - a stray
  // backslash, a lone bracket, punctuation on its own - is not a line. Speech
  // synthesis makes an unsettling noise out of it, so the show skips the turn
  // instead of airing it.
  if (!/[a-z]{2}/i.test(out)) return "";

  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The verbs a model reaches for the moment it stops speaking and starts
 * narrating. Deliberately includes the furniture of a script — narrator,
 * director, cue, aside — because those arrive too, and a king reading the word
 * "director" aloud is the worst version of this bug.
 */
const NARRATION_OPENERS =
  "read|reads|reading|say|says|saying|speak|speaks|speaking|laugh|laughs|laughing|chuckle|chuckles|" +
  "chuckling|sigh|sighs|sighing|pause|pauses|pausing|beat|lean|leans|leaning|look|looks|looking|" +
  "turn|turns|turning|smile|smiles|smiling|grin|grins|grinning|nod|nods|nodding|stand|stands|standing|" +
  "sit|sits|sitting|rise|rises|rising|gesture|gestures|gesturing|slam|slams|slamming|set|sets|setting|" +
  "drink|drinks|drinking|stare|stares|staring|glance|glances|glancing|continue|continues|continuing|" +
  "interrupt|interrupts|interrupting|clear|clears|clearing|voice|tone|aside|softly|quietly|coldly|" +
  "flatly|dryly|wearily|music|sfx|applause|silence|static|narrator|narration|director|stage|cue|scene";

const NARRATION_OPENING = new RegExp(`^(?:${NARRATION_OPENERS})\\b`, "i");
const THIRD_PERSON = /^(?:he|she|they|the king|the chronicler|king|orion)\b/i;

/**
 * Is this bracketed span a stage direction rather than something said aloud?
 *
 * Two tells, and both are structural rather than a list of words to keep
 * extending. It refers to the speaker in the third person — nobody says "he
 * leans forward" about himself out loud — or it opens on one of the verbs
 * narration is built from.
 *
 * `long` adds the third test, which only applies inside a line: emphasis is a
 * word or two, so a run of four or more within asterisks was a clause, and a
 * clause in asterisks is narration. It is off for a line wrapped end to end,
 * where length means nothing and dropping a whole turn on a guess is the one
 * mistake worth avoiding.
 */
/**
 * Words a genuine aside starts on.
 *
 * These are what tie a parenthesis to the sentence around it. Nobody writes a
 * stage direction beginning "which" or "of the two", and a direction almost
 * never begins on anything in this list.
 */
const LINKING_OPENER =
  /^(?:what|which|who|whom|whose|that|and|or|but|if|when|while|because|though|although|unless|not|no|nor|yes|the|a|an|his|her|their|its|my|our|your|this|these|those|of|in|on|at|for|to|with|by|from|about|as|than|then|more|less|most|least|all|some|both|either|neither|one|two|three|four|five|six|seven|eight|nine|ten|\d)\b/i;

/**
 * Is this parenthesis a stage direction rather than part of the sentence?
 *
 * The default is yes, which is the opposite of the asterisk rule and is what a
 * live court forced. What saves an aside is opening on a linking word, or
 * being a word or two that is plainly not narration.
 */
function parenthetical(inner: string): boolean {
  const text = inner.trim().replace(/\s+/g, " ").replace(/^[-–—:,]\s*/, "");
  if (!text) return true;

  if (NARRATION_OPENING.test(text)) return true;
  if (LINKING_OPENER.test(text)) return false;

  // Not linked to the sentence, so it is standing on its own. Two words is
  // enough: a live court got "(trailing off)" past a three-word threshold, and
  // every genuine two-word aside — "(or worse)", "(for now)" — opens on a
  // linking word and has already been let through above.
  if (text.split(" ").length >= 2) return true;

  // A lone word is usually emphasis — "(again)" — unless it is a participle,
  // which is how a one-word direction is always written: "(considering)".
  return /(?:ing|ed)$/i.test(text);
}

/**
 * Pull the speech out of a line that was written as prose.
 *
 * Only fires when there is real quoted dialogue AND real narration outside it.
 * A line that is entirely speech is left alone (the quote-stripping below
 * handles that), and so is a line with no quotes at all — a king quoting
 * somebody mid-sentence must not have his own words thrown away.
 */
function unquoteNarration(text: string): string {
  const quoted = [...text.matchAll(/[""]([^""]{4,})[""]|"([^"\n]{4,})"/g)]
    .map((m) => (m[1] ?? m[2] ?? "").trim())
    .filter(Boolean);

  if (quoted.length === 0) return text;

  const spoken = quoted.join(" ");
  const outside = text.replace(/[""][^""]*[""]|"[^"\n]*"/g, " ").replace(/\s+/g, " ").trim();

  // Nothing meaningful outside the quotes: it was just a quoted line.
  if (outside.replace(/[^a-z]/gi, "").length < 12) return text;

  // Is what sits outside the quotes narration rather than more speech? The
  // tell is a dialogue tag or somebody being described in the third person.
  const isProse =
    /\b(?:he|she|they|his|her|their)\b/i.test(outside) &&
    /\b(?:says?|said|growls?|growled|snarls?|replies|replied|answers?|answered|asks?|asked|echoes|echoed|adds?|added|continues?|continued|smiles?|smirks?|sneers?|laughs?|whispers?|mutters?|eyes|gaze|voice|expression|lips|face)\b/i.test(
      outside,
    );

  return isProse && spoken.length >= 12 ? spoken : text;
}

function narrates(span: string, long: boolean, standalone = false): boolean {
  const text = span.trim().replace(/\s+/g, " ").replace(/^[-–—:,]\s*/, "");
  if (!text) return true;

  // Sat in front of a whole sentence rather than inside one. Nothing is being
  // emphasised, so whatever it is, it is not dialogue.
  if (standalone) return true;

  const words = text.split(" ").length;

  // A lone cue is the classic form — *laughs*, *pauses*, *silence* — so one
  // word is enough for the verb test. It is not enough for the third-person
  // test, where a single word is far more likely to be emphasis: *he* did it.
  if (NARRATION_OPENING.test(text)) return true;
  if (words > 1 && THIRD_PERSON.test(text)) return true;

  return long && words >= 4;
}

/** Trim to a whole sentence near the word budget, so turns do not end mid-thought. */
function trimToWordBudget(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  const hardCap = Math.round(maxWords * 1.6);
  if (words.length <= hardCap) return text;

  const truncated = words.slice(0, hardCap).join(" ");
  const lastStop = Math.max(
    truncated.lastIndexOf("."),
    truncated.lastIndexOf("!"),
    truncated.lastIndexOf("?"),
  );

  // Only cut at a sentence end if we would keep most of the text.
  return lastStop > truncated.length * 0.55 ? truncated.slice(0, lastStop + 1) : `${truncated.trim()}.`;
}

/**
 * Make the model process the show's prompt before the show needs it.
 *
 * The first generation of a run costs a great deal more than the rest — 46
 * seconds against 2.5 warm, measured, and up to two minutes from properly
 * cold. That is the whole prefix being read for the first time, and until it
 * is done nothing can be written. It lands exactly where it hurts most: on the
 * first line, while the listener waits.
 *
 * But the show already has cover for it. The opener and the record play for
 * minutes before a word of dialogue is needed, so the prefill can happen
 * underneath them for free. One token is enough — the cost is the reading of
 * the prompt, not the writing of the reply.
 *
 * Deliberately never awaited and never able to fail a show: if it does not
 * finish in time, the first turn simply pays what it would have paid anyway.
 */
export function warmUp(
  config: Config,
  topic: string,
  research: ResearchResult | null,
  recollections: Recollection[],
  brief: ProducerBrief,
  realmBriefing: string,
  signal?: AbortSignal,
): Promise<void> {
  const [hostA, hostB] = config.hosts;

  const systems = realmBriefing
    ? [
        courtPromptFor("king", config, topic, realmBriefing),
        courtPromptFor("chronicler", config, topic, realmBriefing),
      ]
    : [
        systemPromptFor(hostA, hostB, config, topic, research, recollections, brief),
        systemPromptFor(hostB, hostA, config, topic, research, recollections, brief),
      ];

  // Both speakers, because they are different prompts and each has to be read
  // once. Sequential rather than at once: two full prefills in parallel on a
  // six-gigabyte card is how you turn a warm-up into a stall.
  // Only the first speaker is on the critical path. Speaker two can reuse the
  // live conversation prefix instead of occupying the model before turn one.
  return systems.slice(0, 1)
    .reduce(
      (chain, system) =>
        chain.then(async () => {
          await generate(config.llm, {
            // The warm-up exists to be finished before the first turn, so if a
            // turn is already waiting it has lost its purpose and must get out
            // of the way.
            priority: "background",
            messages: [
              { role: "system", content: system },
              { role: "user", content: "Ready?" },
            ],
            temperature: 0.1,
            maxTokens: 1,
            signal,
          });
        }),
      Promise.resolve(),
    )
    .catch(() => {
      // The model being busy or absent is not a reason to stop a show.
    });
}

export interface ConversationResult {
  turns: Turn[];
  memory: ShowMemory;
}

export async function runConversation(
  config: Config,
  topic: string,
  research: ResearchResult | null,
  events: ConversationEvents,
  signal?: AbortSignal,
  recollections: Recollection[] = [],
  brief: ProducerBrief = EMPTY_BRIEF,
  /** Turn indices after which a commercial break plays. */
  breakAfter: number[] = [],
  /** The record that played at the top, if one did. The first host back-announces it. */
  openingRecord: { title: string; artist: string } | null = null,
  /**
   * King Orion's realm, already read from the game. Non-empty puts the show
   * in his hall instead of the studio, and nothing the station remembers
   * reaches either speaker.
   */
  realmBriefing = "",
  /** Completed lines from an interrupted broadcast. */
  initialTurns: Turn[] = [],
): Promise<ConversationResult> {
  const [hostA, hostB] = config.hosts;
  const totalTurns = config.show.turns;

  // The hosts' own names recur by design and must never be read as a host
  // labouring the same image.
  const hostNames = [hostA.name, hostB.name, config.show.station];

  // The running order. This is what turns a conversation into a show.
  const runSheet = config.show.useRunSheet
    ? buildRunSheet(totalTurns, config.show.style, breakAfter)
    : [];

  let memory: ShowMemory = { ...EMPTY_MEMORY };
  let lastSummarised = 0;

  // Note-taking runs behind the conversation, never in front of it. Blocking
  // here would stall the writing for a whole model call every few turns, which
  // reads to the listener as the show randomly stopping to think.
  let memoryChain: Promise<void> = Promise.resolve();

  let beats: string[] = [];
  if (config.show.useOutline) {
    events.onInfo?.("Planning the segment...");
    try {
      beats = await buildOutline(config, topic, research, signal);
      if (beats.length) events.onOutline?.(beats);
      else events.onInfo?.("No usable outline came back — running unscripted.");
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      // An outline is a nice-to-have; never fail the show over it.
      events.onInfo?.(`Outline skipped: ${(err as Error).message}`);
    }
  }

  // King Orion's Realm replaces the two hosts outright rather than dressing
  // them up. He is a guest with his own world, and the station's memory is
  // deliberately not part of it: no recalled episodes, no phone book, no
  // running gags, no research. The realm briefing is the only thing he knows.
  const court = Boolean(realmBriefing);

  const systemA = court
    ? courtPromptFor("king", config, topic, realmBriefing)
    : systemPromptFor(hostA, hostB, config, topic, research, recollections, brief);
  const systemB = court
    ? courtPromptFor("chronicler", config, topic, realmBriefing)
    : systemPromptFor(hostB, hostA, config, topic, research, recollections, brief);

  const turns: Turn[] = initialTurns
    .filter((turn) => turn && typeof turn.text === "string" && turn.text.trim())
    .map((turn, index) => ({ ...turn, index }));
  const completedHostTurns = turns.filter((turn) => turn.hostId === "a" || turn.hostId === "b").length;

  // Set when a listener has just spoken, so the next host answers them.
  let pendingCaller: string | null = null;

  // ── What the show may spend on second attempts.
  //
  // Every corrective retry — a tool call, an echo, a repeated image, a speaker
  // talking to itself — costs a whole extra generation. Measured on a court:
  // six retries across six turns, so every line was written twice and the show
  // could not keep ahead of its own speech. The guards are worth having; being
  // allowed to fire on every single turn is not.
  //
  // A third of the turns, which leaves room to fix the lines that are actually
  // broken without the show paying double for all of them.
  let retriesLeft = Math.max(1, Math.round(totalTurns / 3));
  const spendRetry = (): boolean => {
    if (retriesLeft <= 0) return false;
    retriesLeft--;
    return true;
  };

  // A break whose throw-to turn failed to generate, waiting for the next turn
  // that does. Losing the turn is survivable; losing the break is not, because
  // the audio has already been made and the running order expects it.
  let orphanedBreak: number | null = null;

  // Hosts alternate, but a listener call inserts an extra turn without
  // taking one of theirs — so track whose turn it is separately from the loop.
  let speakerToggle = completedHostTurns;

  for (let i = completedHostTurns; i < totalTurns; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    // ── Anyone on the line? Put them on air before the next host speaks.
    const call = events.takeCall?.();
    // A caller's line went on air with nothing but a trim, which was fine while
    // callers were typed by a person and stopped being fine the moment one was
    // written by the model. The Guild's riders come down this same queue, so
    // they get the same cleaning every host turn gets.
    const callText = call ? cleanLine(call.text.slice(0, 1200), call.name.trim() || "Caller", "") : "";
    if (call && callText) {
      const callerTurn: Turn = {
        index: turns.length,
        hostId: "caller",
        speaker: call.name.trim() || "Caller",
        text: callText,
      };
      turns.push(callerTurn);
      events.onTurnStart?.({ index: callerTurn.index, speaker: callerTurn.speaker, hostId: "caller" });
      await events.onTurnEnd?.(callerTurn);
      // The next host answers the caller rather than continuing the debate.
      pendingCaller = callerTurn.speaker;
    }

    const useA = speakerToggle % 2 === 0;
    speakerToggle++;

    const host = useA ? hostA : hostB;
    const other = useA ? hostB : hostA;
    const system = useA ? systemA : systemB;

    // Spread the beats across the middle of the show, skipping the open and close.
    const beat =
      beats.length > 0 && i > 0 && i < totalTurns - 1
        ? beats[Math.min(beats.length - 1, Math.floor(((i - 1) / Math.max(1, totalTurns - 2)) * beats.length))]
        : undefined;

    const sheetBeat = runSheet[i];
    // In the hall, the beat keeps its shape and loses its studio wording.
    const beatBrief = sheetBeat ? (court ? COURT_BEATS[sheetBeat.kind] : sheetBeat.brief) : "";

    let instruction = sheetBeat
      ? `${beatBrief}${beat ? ` Work in this: ${beat}` : ""}`
      : court
        ? "Carry the night on. Answer what was just said, then give it somewhere new to go."
        : instructionFor(i, totalTurns, host, topic, beat, config.show.style);

    // The opening and closing turns still need the topic and station spelled
    // out; the run sheet only describes the shape, not the subject.
    if (i === 0 && brief.hook) {
      instruction += ` Lead with what makes this worth hearing: ${brief.hook}`;
    }

    // Coming out of the record.
    //
    // The station has just played three and a half minutes of music and the
    // hosts were, until now, opening as if the show had not started — which is
    // the one thing no real DJ does. The track gets back-announced by name
    // before anything else, because that is what a listener who just heard it
    // is waiting for.
    if (i === 0 && openingRecord?.title) {
      const credit = openingRecord.artist
        ? `"${openingRecord.title}" by ${openingRecord.artist}`
        : `"${openingRecord.title}"`;

      // This replaces the run sheet's opening beat rather than being added to
      // it. Told both to open the show and to come out of a record, the model
      // does the one it was told first and drops the other — and what gets
      // dropped is always the track, which is the half a listener who just
      // heard it is actually waiting for.
      instruction =
        `The record has just finished. Your first words back-announce it: say the title ${credit} and ` +
        `the artist out loud, exactly as written, the way a DJ does coming off a track — one line, ` +
        `high energy, no preamble before it. Then name the station once and go straight into tonight's ` +
        `subject. Do not welcome anyone to the show; they have been listening for four minutes.`;

      if (brief.hook) instruction += ` The angle to lead on: ${brief.hook}`;
    }

    // Restated every turn, not just the first two. This is the single most
    // effective guard against the show drifting onto a neighbouring subject.
    instruction += ` Stay on tonight's subject: ${topic}.`;
    instruction += " Make one substantive claim about the subject before any joke or character business.";
    if (openingRecord && i > 0 && !court) {
      const credit = openingRecord.artist
        ? `"${openingRecord.title}" by ${openingRecord.artist}`
        : `"${openingRecord.title}"`;
      instruction +=
        ` Production fact: ${credit} was the opening record, not a person, restaurant, company, place, ` +
        "or example from tonight's subject. It has already been credited. Do not mention its title or artist again.";
    }

    // A deterministic budget works better than asking a small model to infer
    // what "occasionally" means. Only one in five middle turns is invited to
    // use the station's damaged universe at all.
    if (court) {
      instruction +=
        " Keep fact, inference, and plan distinct. Ground the exchange in an exact name, place, object, count, quest, or listener-approved remembered promise from the royal memory when it is relevant. Never create a past event as an analogy: mention history only by paraphrasing a deed or save-journal sentence that is actually present in the live briefing. Speak as a live Night Court co-host, not a narrator.";
      instruction += useA
        ? " As King Orion, turn analysis into one concrete order, controlled choice, or enforceable consequence before you finish. A question alone is not a ruling."
        : " As Maeve, challenge one unsupported assumption or clarify one record boundary. You may advise the Crown, but never issue its orders or claim its people, forces, allies, or plans as yours.";
      if (i === 0 || i === totalTurns - 2) {
        instruction += " Address the listener beyond the hall directly and explain why this decision matters now.";
      }
      if (i < totalTurns - 1 && i % 2 === 0) {
        const otherName = useA ? config.orion.chronicler.name : config.orion.king.name;
        instruction += ` Hand off to ${otherName} by name with one precise question or challenge they can answer next.`;
      }
    } else {
      const mayUseUniverse = i > 0 && i < totalTurns - 1 && i % 5 === 3;
      instruction += mayUseUniverse
        ? " You may use one brief damaged-universe detail only if it directly tests or clarifies that claim."
        : " Keep this turn in ordinary reality: no portals, alternate selves, timelines, cosmic incidents, or station-lore detours.";
    }

    // Nudge away from the stock opener the model just used.
    const openings = recentOpenings(turns, 8);
    if (openings.length > 0) {
      instruction += ` Do not begin your line the way these did: ${openings.map((o) => `"${o}"`).join(", ")}.`;
    }
    // Later in a long show the recent list has forgotten openings from earlier
    // turns, which is where the repeats come from. Name the rest as well.
    const recentKeys = new Set(openings.map((o) => o.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 3).join(" ")));
    const earlier = usedOpenings(turns).filter((o) => !recentKeys.has(o));
    if (earlier.length > 0) {
      instruction += ` Also avoid opening with: ${earlier.map((o) => `"${o}"`).join(", ")}.`;
    }

    // And away from the image it has already leaned on. A small model that
    // finds one funny detail will return to it every turn until told not to,
    // which is the loop a listener notices long before they notice anything
    // else about the show.
    const worn = overusedImages(turns, topic, hostNames);
    if (worn.length > 0) {
      instruction +=
        ` You have already used these tonight — find a different example, not another line about them: ` +
        `${worn.join(", ")}.`;
    }

    // These two shape how the line sounds once spoken, and a small model
    // ignores them when they sit in a long list in the system prompt. Repeated
    // here, at the end of the prompt, they actually land.
    if (i > 0) {
      // Naming one example makes a small model use that exact phrase every
      // turn — "Wait, really?" twice in six lines, measured. Rotating the
      // examples keeps the behaviour and drops the tic.
      const react = REACTION_EXAMPLES[i % REACTION_EXAMPLES.length];
      instruction +=
        ` React to what ${other.name} just said before you make your own point. Hit the actual words they` +
        ` used, the way ${react}. Do not repeat their sentence back to them.`;
    }
    instruction +=
      " You may write an ellipsis (...) mid-line where you trail off, or an em dash (—) where you cut" +
      " yourself off; they become real pauses when this is spoken aloud. Never put either at the start" +
      " or the end of your line — the line has to open on a word and close on a finished sentence.";

    if (pendingCaller) {
      // Someone who has rung before is not a stranger, and a host who greets a
      // regular as a new listener is the exact thing the phone book exists to
      // prevent. The lookup is a file read, on the turn that needs it.
      const known = findCaller(pendingCaller);
      const history =
        known && known.calls > 1
          ? ` You know ${pendingCaller} — they have called ${known.calls} times before` +
            `${known.topics.length > 1 ? `, last time about ${known.topics[known.topics.length - 2]}` : ""}. ` +
            "Welcome them back as a regular."
          : "";

      instruction = court
        ? `${pendingCaller} has come forward in the hall and spoken. Answer them directly and by name, ` +
          "as a king answers someone who has walked into his court uninvited — hear it, weigh it, and " +
          "rule on it. Then carry the night on."
        : `${pendingCaller} has just called in to the show. Respond to them directly and by name, ` +
          `in character. Take what they said seriously and engage with it, then carry the conversation on.${history}`;
      pendingCaller = null;
    }

    // A system prompt set once drifts out of a small model's attention over a
    // long show, which is how two hosts established as married end up
    // wondering how they know each other. Restating the bible periodically,
    // right next to the generation point, costs almost nothing.
    const bible = config.show.relationship.trim();
    if (bible && i >= 3 && i % 3 === 0) {
      instruction += ` Still true, do not contradict or rediscover it: ${bible}`;
    }

    events.onTurnStart?.({ index: i, speaker: host.name, hostId: host.id });
    const turnStarted = performance.now();

    // The running bits are only put in front of a host on the turn that is
    // meant to reach for one.
    const allowCallback = sheetBeat?.kind === "callback";

    const baseMessages = messagesFor(
      host,
      system,
      turns,
      instruction,
      memory,
      config.memory.historyTurns,
      allowCallback,
      court,
    );

    // Only as many tokens as this speaker's turn is allowed to be.
    //
    // Every turn used to ask for the global maximum — 400 tokens, roughly 300
    // words — and then trimToWordBudget threw away everything past the
    // speaker's actual budget. The King's budget is 80 words and his
    // chronicler's is 34, so most turns were generating two or three times
    // more text than could ever be spoken, and the listener waited for all of
    // it. Measured on this machine at three to four words a second, that was
    // fifteen to twenty-five seconds per turn of work thrown straight away.
    //
    // The allowance below is the hard cap trimToWordBudget applies (1.6x the
    // budget), converted to tokens with room to spare, so nothing that would
    // have survived the trim is lost. A sentence clipped by the cap is cut
    // back to the last full stop exactly as before.
    const turnTokens = Math.min(
      config.llm.maxTokens,
      Math.round(host.maxWords * 1.6 * 1.5) + 32,
    );

    let raw = await generate(config.llm, {
      messages: baseMessages,
      model: host.model || config.llm.model,
      temperature: host.temperature,
      maxTokens: turnTokens,
      signal,
      onToken: events.onToken,
      onTiming: (timing) => events.onModelTiming?.({ index: i, ...timing }),
    });

    // Some models answer a directive with a tool call rather than dialogue.
    // One corrective retry fixes this far more often than it fails.
    // A tool call is never usable, so this one is not optional and is not
    // charged to the budget — there is no line to fall back on.
    if (looksLikeToolCall(raw)) {
      events.onInfo?.(`${host.name} replied with structured data — asking again for plain speech.`);
      raw = await generate(config.llm, {
        messages: [
          ...baseMessages,
          { role: "assistant", content: raw },
          {
            role: "user",
            content:
              "That was JSON, not speech. You have no tools and no functions available. " +
              `Say the line out loud as ${host.name} would say it, in plain English, with no braces, ` +
              "no quotes, no field names, and no speaker label.",
          },
        ],
        model: host.model || config.llm.model,
        temperature: Math.min(1, host.temperature + 0.1),
        maxTokens: config.llm.maxTokens,
        signal,
      });
    }

    let cleaned = looksLikeToolCall(raw)
      ? ""
      : trimToWordBudget(cleanLine(raw, host.name, other.name), host.maxWords);

    // A one-word fragment is not a short radio turn; it is a failed model
    // completion. Retry it even when the stylistic retry budget is spent.
    if (cleaned && cleaned.trim().split(/\s+/).length < 6) {
      events.onInfo?.(`${host.name} returned only a fragment - asking for a complete line.`);
      const retry = await generate(config.llm, {
        messages: [
          ...baseMessages,
          { role: "assistant", content: cleaned },
          {
            role: "user",
            content:
              "That was an incomplete fragment. Give one complete spoken turn of two or three finished sentences. " +
              "Make a specific point, then finish it. No label, heading, or stage direction.",
          },
        ],
        model: host.model || config.llm.model,
        temperature: Math.max(0.5, host.temperature - 0.15),
        maxTokens: turnTokens,
        signal,
      });
      const fixed = trimToWordBudget(cleanLine(retry, host.name, other.name), host.maxWords);
      cleaned = fixed.trim().split(/\s+/).length >= 6 ? fixed : "";
    }

    // The realm prompt can prevent broad invention, but roleplay-tuned models
    // still add tempting specifics such as a secret child or an old siege.
    // Those claims never go on air unless the live briefing contains them.
    const unsupported = cleaned && court ? unsupportedCourtClaim(cleaned, realmBriefing) : null;
    if (unsupported) {
      events.onInfo?.(`${host.name} invented unsupported court history (${unsupported}) - checking the record.`);
      const retry = await generate(config.llm, {
        messages: [
          ...baseMessages,
          { role: "assistant", content: cleaned },
          {
            role: "user",
            content:
              `That line invented an unsupported claim: ${unsupported}. It does not appear in the live realm record. ` +
              "Rewrite the turn without that claim. Use only a fact stated in the record, clearly mark any inference " +
              "as inference, and give a practical decision or question. Do not replace it with another invented history.",
          },
        ],
        model: host.model || config.llm.model,
        temperature: Math.max(0.45, host.temperature - 0.2),
        maxTokens: turnTokens,
        signal,
      });
      const fixed = trimToWordBudget(cleanLine(retry, host.name, other.name), host.maxWords);
      cleaned = fixed && !unsupportedCourtClaim(fixed, realmBriefing) ? fixed : "";
    }

    if (cleaned && court && reportsOtherInsteadOfReplying(cleaned, other.name) && spendRetry()) {
      events.onInfo?.(`${host.name} narrated ${other.name}'s position - asking for a direct reply.`);
      const retry = await generate(config.llm, {
        messages: [
          ...baseMessages,
          { role: "assistant", content: cleaned },
          {
            role: "user",
            content:
              `Do not begin by reporting what ${other.name} says, thinks, or believes. ${other.name} just spoke and ` +
              "the listener heard it. Reply directly: challenge one assumption, add one fact, or ask one sharper question.",
          },
        ],
        model: host.model || config.llm.model,
        temperature: host.temperature,
        maxTokens: turnTokens,
        signal,
      });
      const fixed = trimToWordBudget(cleanLine(retry, host.name, other.name), host.maxWords);
      if (fixed && !reportsOtherInsteadOfReplying(fixed, other.name)) cleaned = fixed;
    }

    if (cleaned && court && !useA && chroniclerClaimsCommand(cleaned) && spendRetry()) {
      events.onInfo?.(`${host.name} took the Crown's authority - returning her to the chronicler's chair.`);
      const retry = await generate(config.llm, {
        messages: [
          ...baseMessages,
          { role: "assistant", content: cleaned },
          {
            role: "user",
            content:
              `You are ${host.name}, the chronicler and co-host, not the ruler. You cannot issue orders or claim ` +
              "the realm, forces, people, allies, or plan as yours. Rewrite this as your challenge or advice to " +
              `${other.name}, then ask what he will actually order.`,
          },
        ],
        model: host.model || config.llm.model,
        temperature: Math.max(0.5, host.temperature - 0.15),
        maxTokens: turnTokens,
        signal,
      });
      const fixed = trimToWordBudget(cleanLine(retry, host.name, other.name), host.maxWords);
      if (fixed && !chroniclerClaimsCommand(fixed)) cleaned = fixed;
    }

    // Every other King turn must leave analysis and become rule. Without this,
    // a roleplay model can sound thoughtful while never sounding dangerous.
    if (cleaned && court && useA && i > 0 && i % 4 === 2 && !hasConcreteRuling(cleaned)) {
      events.onInfo?.(`${host.name} analyzed the danger without ruling on it - requiring a decision.`);
      const retry = await generate(config.llm, {
        messages: [
          ...baseMessages,
          { role: "assistant", content: cleaned },
          {
            role: "user",
            content:
              "Keep the useful analysis, but a king must rule. End with one short, concrete order or enforceable " +
              "consequence using only people and places in the live record. State what you will watch, close, deny, " +
              "withhold, offer, or command. Do not merely ask another question and do not invent a past event.",
          },
        ],
        model: host.model || config.llm.model,
        temperature: Math.max(0.45, host.temperature - 0.2),
        maxTokens: turnTokens,
        signal,
      });
      const fixed = trimToWordBudget(cleanLine(retry, host.name, other.name), host.maxWords);
      if (fixed && hasConcreteRuling(fixed) && !unsupportedCourtClaim(fixed, realmBriefing)) cleaned = fixed;
    }

    // The old station bible trained the model into one dependable bad habit:
    // turning any subject into municipal administration. Catch that specific
    // failure while allowing it when policy or bureaucracy is truly the topic.
    if (cleaned && !court && fallsIntoBureaucracy(cleaned, topic) && spendRetry()) {
      events.onInfo?.(`${host.name} wandered into bureaucracy - bringing the line back to the subject.`);
      const retry = await generate(config.llm, {
        messages: [
          ...baseMessages,
          { role: "assistant", content: cleaned },
          {
            role: "user",
            content:
              "That line escaped into permits, zoning, councils, forms, fees, parking, or sponsor business. " +
              `None of that is tonight's subject. Make a real point about ${topic} using its actual concepts. ` +
              "Keep the personality, remove all bureaucracy and station administration.",
          },
        ],
        model: host.model || config.llm.model,
        temperature: Math.max(0.55, host.temperature - 0.15),
        maxTokens: turnTokens,
        signal,
      });

      const fixed = trimToWordBudget(cleanLine(retry, host.name, other.name), host.maxWords);
      if (fixed && !fallsIntoBureaucracy(fixed, topic)) cleaned = fixed;
    }

    // The track credit belongs to the record break, once. If it reappears in
    // the discussion, a small model can turn it into an invented restaurant or
    // person and build several later turns on the false fact. Correct this
    // before it enters history; unlike a style retry, factual contamination is
    // never allowed through merely because the retry budget is exhausted.
    const reusedRecord = cleaned ? reusesOpeningRecord(cleaned, openingRecord, topic) : null;
    if (reusedRecord && i > 0 && !court) {
      events.onInfo?.(`${host.name} reused the opening record "${reusedRecord}" as discussion material - removing the false reference.`);
      const retry = await generate(config.llm, {
        messages: [
          ...baseMessages,
          { role: "assistant", content: cleaned },
          {
            role: "user",
            content:
              `"${reusedRecord}" is only part of the opening music credit. It is not a restaurant, person, ` +
              `company, place, or example about ${topic}. Rewrite the point with a real example that does not ` +
              "mention the record title or artist. Do not replace it with another invented proper noun.",
          },
        ],
        model: host.model || config.llm.model,
        temperature: Math.max(0.5, host.temperature - 0.15),
        maxTokens: turnTokens,
        signal,
      });
      const fixed = trimToWordBudget(cleanLine(retry, host.name, other.name), host.maxWords);
      cleaned = fixed && !reusesOpeningRecord(fixed, openingRecord, topic) ? fixed : "";
    }

    // This applies to the ordinary DJs as well as Night Court. "Dee makes a
    // great point" is narration about the prior line, not a reply to it, and
    // it produces the same synthetic cadence turn after turn.
    if (cleaned && !court && reportsOtherInsteadOfReplying(cleaned, other.name)) {
      events.onInfo?.(`${host.name} narrated ${other.name}'s position - asking for a direct reply.`);
      const retry = await generate(config.llm, {
        messages: [
          ...baseMessages,
          { role: "assistant", content: cleaned },
          {
            role: "user",
            content:
              `${other.name} just spoke and the listener heard it. Do not begin by reporting that ${other.name} ` +
              "is right, has a point, or said something. Start on your own new fact, objection, question, or story, " +
              "then advance the argument in new words.",
          },
        ],
        model: host.model || config.llm.model,
        temperature: Math.min(1.1, host.temperature + 0.1),
        maxTokens: turnTokens,
        signal,
      });
      const fixed = trimToWordBudget(cleanLine(retry, host.name, other.name), host.maxWords);
      // A report about the last line is never preferable to a clean skip. If
      // the correction repeats the same mistake, do not teach the next turn to
      // imitate it by placing it in conversation history.
      cleaned = fixed && !reportsOtherInsteadOfReplying(fixed, other.name) ? fixed : "";
    }

    // A line that talks to its own speaker is always the model losing track of
    // which of the two it is. One retry, naming the mistake.
    if (cleaned && addressesSelf(cleaned, host.name) && spendRetry()) {
      events.onInfo?.(`${host.name} addressed ${host.name} — asking again for the right speaker.`);
      const retry = await generate(config.llm, {
        messages: [
          ...baseMessages,
          { role: "assistant", content: cleaned },
          {
            role: "user",
            content:
              `You are ${host.name}. That line spoke to ${host.name}, which is yourself — you wrote ` +
              `${other.name}'s side by mistake. Say it again as ${host.name}, speaking to ${other.name}.`,
          },
        ],
        model: host.model || config.llm.model,
        temperature: host.temperature,
        maxTokens: config.llm.maxTokens,
        signal,
      });

      const fixed = trimToWordBudget(cleanLine(retry, host.name, other.name), host.maxWords);
      if (fixed && !addressesSelf(fixed, host.name)) cleaned = fixed;
    }

    // A line made of nothing but comparison. Forbidding similes in the prompt
    // does not work on a roleplay tune, so it is caught here instead.
    const leaning = cleaned ? leansOnSimile(cleaned) : [];
    if (leaning.length > 0 && spendRetry()) {
      events.onInfo?.(`${host.name} spoke in comparisons — asking for the thing itself.`);
      const retry = await generate(config.llm, {
        messages: [
          ...baseMessages,
          { role: "assistant", content: cleaned },
          {
            role: "user",
            content:
              `That line was built out of comparisons — ${leaning.slice(0, 2).map((l) => `"${l}"`).join(" and ")}. ` +
              "Say the thing itself instead. What actually happened, where, what it cost, who is not " +
              "coming back. No \"like a\", no \"as if\". Same point, stated plainly.",
          },
        ],
        model: host.model || config.llm.model,
        temperature: host.temperature,
        maxTokens: config.llm.maxTokens,
        signal,
      });

      const fixed = trimToWordBudget(cleanLine(retry, host.name, other.name), host.maxWords);
      if (fixed && leansOnSimile(fixed).length === 0) cleaned = fixed;
    }

    // Handing the previous line straight back is the other clearest tell, and
    // the one the system prompt is least able to prevent. One retry, with the
    // stolen words quoted, fixes it far more often than not.
    const echoed = cleaned ? echoesPrevious(cleaned, turns) : null;
    if (echoed && spendRetry()) {
      events.onInfo?.(`${host.name} repeated ${other.name}'s words back — asking for a reply instead.`);
      const retry = await generate(config.llm, {
        messages: [
          ...baseMessages,
          { role: "assistant", content: cleaned },
          {
            role: "user",
            content:
              `You just said "${echoed}" back — those are ${other.name}'s own words from a moment ago. ` +
              "Saying someone's sentence back to them is not a reply. Take what they said as already " +
              "said, and answer it: agree and go further, disagree and say why, or bring the one thing " +
              "they left out. Same character, new words.",
          },
        ],
        model: host.model || config.llm.model,
        temperature: Math.min(1.2, host.temperature + 0.15),
        maxTokens: config.llm.maxTokens,
        signal,
      });

      const fixed = trimToWordBudget(cleanLine(retry, host.name, other.name), host.maxWords);
      if (fixed && !echoesPrevious(fixed, turns)) cleaned = fixed;
    }

    // Every turn opening "That's a fair point, but" is the clearest tell that
    // a show is machine-made, so one retry is worth it.
    const filler = cleaned ? repeatsOpening(cleaned, turns) : null;
    if (filler && spendRetry()) {
      events.onInfo?.(`${host.name} opened with "${filler}" again — asking for a different way in.`);
      const retry = await generate(config.llm, {
        messages: [
          ...baseMessages,
          { role: "assistant", content: cleaned },
          {
            role: "user",
            content:
              `You have already opened a line with "${filler}" tonight. Say the same thing again, ` +
              "but start somewhere completely different — a fact, an objection, a question, or a story. " +
              "Same character, same point, new opening.",
          },
        ],
        model: host.model || config.llm.model,
        temperature: Math.min(1.2, host.temperature + 0.15),
        maxTokens: config.llm.maxTokens,
        signal,
      });
      const retried = trimToWordBudget(cleanLine(retry, host.name, other.name), host.maxWords);
      // Take the retry only if it actually found a new way in; a retry that
      // reopens the same way has fixed nothing and may have drifted.
      if (retried && !looksLikeToolCall(retry) && !repeatsOpening(retried, turns)) cleaned = retried;
    }

    // The same guard, one level up from the opener: a line reaching for an
    // image three previous turns already used is the show eating itself.
    const stale = cleaned ? repeatsImage(cleaned, turns, topic, hostNames) : null;
    if (stale && spendRetry()) {
      events.onInfo?.(`${host.name} went back to "${stale}" again — asking for a fresh example.`);
      const retry = await generate(config.llm, {
        messages: [
          ...baseMessages,
          { role: "assistant", content: cleaned },
          {
            role: "user",
            content:
              `You have already talked about "${stale}" several times tonight and the listener has heard it. ` +
              "Make the same point with something completely different — a different example, a different " +
              `story, a different comparison. Do not mention ${stale} at all this time.`,
          },
        ],
        model: host.model || config.llm.model,
        temperature: Math.min(1.2, host.temperature + 0.2),
        maxTokens: config.llm.maxTokens,
        signal,
      });

      const retried = trimToWordBudget(cleanLine(retry, host.name, other.name), host.maxWords);
      // Only take the retry if it actually dropped the thing we objected to;
      // otherwise the first attempt is at least in character.
      if (retried && !looksLikeToolCall(retry) && !retried.toLowerCase().includes(stale)) {
        cleaned = retried;
      }
    }

    // A corrective retry can itself introduce a fragment, narrator opening,
    // unsupported fact, or role swap. Give the final draft its own gate.
    const finalCourtIssue = cleaned && court
      ? unsupportedCourtClaim(cleaned, realmBriefing) ??
        (reportsOtherInsteadOfReplying(cleaned, other.name) ? `reporting ${other.name}'s position` : null) ??
        (!useA && chroniclerClaimsCommand(cleaned) ? "Maeve claiming royal authority" : null) ??
        (cleaned.trim().split(/\s+/).length < 6 ? "an incomplete fragment" : null)
      : cleaned && cleaned.trim().split(/\s+/).length < 6
        ? "an incomplete fragment"
        : null;
    if (cleaned && finalCourtIssue) {
      events.onInfo?.(`${host.name}'s correction still had ${finalCourtIssue} - making one clean final pass.`);
      const retry = await generate(config.llm, {
        messages: [
          ...baseMessages,
          { role: "assistant", content: cleaned },
          {
            role: "user",
            content:
              `The last draft still had ${finalCourtIssue}. Speak two complete, concise sentences that directly ` +
              "answer the prior speaker and advance tonight's exact subject. Use only the live record. Do not narrate " +
              "the other speaker, invent a relationship or event, or swap the King and chronicler's authority.",
          },
        ],
        model: host.model || config.llm.model,
        temperature: 0.45,
        maxTokens: turnTokens,
        signal,
      });
      const fixed = trimToWordBudget(cleanLine(retry, host.name, other.name), host.maxWords);
      const validCourtClaim = !court || !unsupportedCourtClaim(fixed, realmBriefing);
      const validRole = useA || !chroniclerClaimsCommand(fixed);
      const validReply = !court || !reportsOtherInsteadOfReplying(fixed, other.name);
      cleaned = fixed.trim().split(/\s+/).length >= 6 && validCourtClaim && validRole && validReply ? fixed : "";
    }

    if (!cleaned) {
      events.onInfo?.(`${host.name} returned nothing usable — skipping this turn.`);
      events.onTurnTiming?.({ index: i, milliseconds: Math.round(performance.now() - turnStarted), skipped: true });
      // A skipped turn must not take its commercial break down with it. The
      // break is already written and recorded; it moves to whoever speaks next.
      if (sheetBeat?.kind === "to_break" && sheetBeat.breakIndex !== undefined) {
        orphanedBreak = sheetBeat.breakIndex;
      }
      continue;
    }

    const takesBreak =
      sheetBeat?.kind === "to_break" ? sheetBeat.breakIndex : orphanedBreak ?? undefined;
    if (takesBreak !== undefined) orphanedBreak = null;

    const turn: Turn = {
      index: turns.length,
      hostId: host.id,
      speaker: host.name,
      text: cleaned,
      ...(takesBreak !== undefined ? { breakAfter: takesBreak } : {}),
    };
    turns.push(turn);
    await events.onTurnEnd?.(turn);
    events.onTurnTiming?.({ index: i, milliseconds: Math.round(performance.now() - turnStarted), skipped: false });

    // The break goes out between this turn and the next, so the host who
    // throws to it is not left waiting on the ads before their co-host replies.
    if (takesBreak !== undefined) await events.onBreak?.(takesBreak, turn);

    // Fold the newest turns into the digest on a cadence, in the background.
    // The next turn uses whatever notes are ready; slightly stale notes are a
    // far better trade than a stall.
    if (config.memory.enabled && turns.length - lastSummarised >= config.memory.updateEvery) {
      const fresh = turns.slice(lastSummarised);
      lastSummarised = turns.length;

      memoryChain = memoryChain
        .then(async () => {
          const memoryStarted = performance.now();
          memory = await updateMemory(config, memory, fresh, signal);
          events.onMemoryTiming?.({ milliseconds: Math.round(performance.now() - memoryStarted), turns: fresh.length });
          events.onMemory?.(memory);
        })
        .catch(() => {
          // Notes are an optimisation; losing an update never stops the show.
        });
    }
  }

  // Let the notes catch up before the title is written from them.
  await memoryChain;

  if (config.memory.enabled && turns.length > lastSummarised) {
    const fresh = turns.slice(lastSummarised);
    const memoryStarted = performance.now();
    memory = await updateMemory(config, memory, fresh, signal);
    events.onMemoryTiming?.({ milliseconds: Math.round(performance.now() - memoryStarted), turns: fresh.length });
    events.onMemory?.(memory);
  }

  return { turns, memory };
}

/** Ask the model for a title and blurb once the conversation exists. */
export async function generateShowNotes(
  config: Config,
  topic: string,
  turns: Turn[],
  signal?: AbortSignal,
  memory?: ShowMemory,
): Promise<{ title: string; summary: string }> {
  const transcript = turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
  const fallback = {
    title: topic.length > 60 ? `${topic.slice(0, 57)}...` : topic,
    summary: `${config.hosts[0].name} and ${config.hosts[1].name} discuss ${topic}.`,
  };

  // The rolling digest is a better, shorter brief than the raw transcript,
  // and it has already been generated.
  if (memory?.digest) {
    const fromMemory = await titleFromMemory(config, topic, memory, signal);
    if (fromMemory) {
      return { title: fromMemory, summary: memory.digest.slice(0, 400) };
    }
  }

  try {
    const notes = await generateJson<{ title?: string; summary?: string }>(
      { ...config.llm, model: config.llm.notesModel || config.llm.model }, {
      messages: [
        {
          role: "system",
          content:
            "You write radio episode listings. Reply with JSON only, in the form " +
            '{"title": "...", "summary": "..."}. No prose, no markdown fences.',
        },
        {
          role: "user",
          content:
            `Here is a transcript of a radio segment about "${topic}".\n\n${transcript.slice(0, 6000)}\n\n` +
            "Give it a punchy episode title of at most eight words (no quotes, no colon-subtitle) " +
            "and a two-sentence summary of what was actually discussed.",
        },
      ],
      temperature: 0.7,
      maxTokens: 300,
      signal,
      },
    );

    const title = typeof notes?.title === "string" ? notes.title.trim().replace(/^["']|["']$/g, "") : "";
    const summary = typeof notes?.summary === "string" ? notes.summary.trim() : "";

    return {
      title: title || fallback.title,
      summary: summary || fallback.summary,
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return fallback;
  }
}
