/**
 * The showrunner: structure and memory.
 *
 * A flat run of N turns is a conversation, not a show. This module gives the
 * dialogue a shape (a run sheet of segments) and a memory (a rolling digest of
 * what has actually been said), then hands the conversation engine a compact
 * brief for each turn.
 *
 * Both exist mainly for small models. An 8B model asked to hold twenty turns
 * of transcript in attention will drift, repeat itself and forget its own
 * jokes. Summarising the past into a few lines and telling it exactly what
 * this turn is for costs one cheap call every few turns and fixes most of it.
 */

import type { Config } from "../config.ts";
import { generate, generateJson, looksLikeToolCall } from "../providers/llm.ts";
import type { Turn } from "./conversation.ts";

/* ── Run sheet ───────────────────────────────────────────────────── */

export type SegmentKind =
  | "cold_open"
  | "intro"
  | "topic"
  | "dig_in"
  | "clash"
  | "story"
  | "callback"
  | "turn_the_tables"
  | "wind_down"
  | "to_break"
  | "from_break"
  | "signoff";

export interface Beat {
  kind: SegmentKind;
  /** What this specific turn has to accomplish. */
  brief: string;
  /** Set on a `to_break` beat: the ad break that plays after this turn. */
  breakIndex?: number;
}

/** What each kind of beat asks of the host, in radio terms. */
const BEAT_BRIEFS: Record<SegmentKind, string> = {
  cold_open:
    "Drop straight into the middle of the subject. No greeting, no station name, no throat-clearing. Grab the listener with the real dilemma, claim, or consequence.",
  intro:
    "Welcome the listener, name the station once, and set tonight's topic in a sentence. Then put a real question to your co-host. Keep it brisk and radio-real.",
  topic: "Take a clear position on the actual subject and say why. Name the principle, mechanism, evidence, or tradeoff behind it. Universe flavor is optional and must clarify the point.",
  dig_in:
    "Respond to what was just said, then go one level deeper: define a term, test an assumption, give a concrete example, or examine a harder case.",
  clash:
    "Disagree with the last point directly. Say what they got wrong and what you would say instead. Do not be polite about it.",
  story:
    "Tell one short, specific story that demonstrates your point. The story must change how the listener understands the subject; it cannot be a detour.",
  callback:
    "Bring back something already said earlier tonight and use it against your co-host or to make a new point. Reward the listener who stayed.",
  turn_the_tables:
    "Put your co-host on the spot with a direct question they will not enjoy answering.",
  wind_down: "Start landing the segment. React to the last point and offer a closing thought.",
  to_break:
    "Land the point you are on, then throw to the commercial break like a DJ: tease what is coming up after it, " +
    "tell the listener to stay with you, and hand off. Do not read an advert yourself — just get us to the break like this is normal station business.",
  from_break:
    "You are back on air after the commercials. Welcome the listener back in one breath, remind them what the " +
    "conversation is about, and pick the argument straight back up. Do not recap at length; one weird sponsor hangover is allowed if it is quick.",
  signoff:
    "Close the show. React briefly, thank your co-host and the listener, name the station once. Nothing new, no universe explanation.",
};

function producerLlm(config: Config) {
  return { ...config.llm, model: config.llm.producerModel || config.llm.model };
}

/**
 * Build the running order.
 *
 * The shape is deliberately not random: open, establish positions, escalate,
 * vary the middle so it does not become call-and-response, then land it.
 */
export function buildRunSheet(
  totalTurns: number,
  style: Config["show"]["style"],
  /** Turn indices after which an ad break plays, from `breakPositions`. */
  breakAfter: number[] = [],
): Beat[] {
  if (totalTurns <= 0) return [];

  const open: SegmentKind = style === "coldopen" ? "cold_open" : "intro";

  // Build the fixed ends first, then fill whatever is left in the middle, so
  // the sign-off is never the beat that gets truncated away.
  const head: SegmentKind[] = [open];
  const tail: SegmentKind[] = [];

  if (totalTurns >= 2) tail.unshift("signoff");
  if (totalTurns >= 4) tail.unshift("wind_down");
  if (totalTurns >= 3) head.push("topic");

  // The middle rotates so a long show does not settle into one rhythm.
  const middleShapes: SegmentKind[] =
    style === "deepdive"
      ? ["dig_in", "story", "dig_in", "callback"]
      : style === "interview"
      ? ["dig_in", "story", "dig_in", "turn_the_tables"]
      : style === "explainer"
        ? ["dig_in", "topic", "dig_in", "callback"]
        : style === "roundtable"
          ? ["dig_in", "story", "callback", "dig_in"]
          : style === "banter"
            ? ["clash", "story", "callback", "turn_the_tables"]
            : ["clash", "dig_in", "story", "callback", "turn_the_tables"];

  const middleCount = Math.max(0, totalTurns - head.length - tail.length);
  const middle: SegmentKind[] = [];

  for (let i = 0; i < middleCount; i++) {
    // A callback only makes sense once there is something to call back to.
    let kind = middleShapes[i % middleShapes.length];
    if (kind === "callback" && head.length + i < 4) kind = "dig_in";
    middle.push(kind);
  }

  const kinds = [...head, ...middle, ...tail].slice(0, totalTurns);

  // Breaks are woven in after the shape exists, so they replace a middle beat
  // rather than pushing the sign-off off the end of the show.
  const breakIndexAt = new Map<number, number>();

  breakAfter.forEach((at, i) => {
    // A host has to throw to the break and another has to come back from it,
    // and neither may eat the close.
    if (at < 1 || at + 1 > totalTurns - 2) return;
    // Nor may one break land on top of another. `breakPositions` spaces them,
    // but this is the place where a collision would actually do the damage —
    // a second throw overwriting the first's return loses a whole break with
    // no error anywhere — so it is refused here too.
    if (kinds[at] === "to_break" || kinds[at] === "from_break") return;
    if (kinds[at + 1] === "to_break" || kinds[at + 1] === "from_break") return;

    kinds[at] = "to_break";
    kinds[at + 1] = "from_break";
    breakIndexAt.set(at, i);
  });

  return kinds.map((kind, i) => ({
    kind,
    brief: BEAT_BRIEFS[kind],
    ...(breakIndexAt.has(i) ? { breakIndex: breakIndexAt.get(i) } : {}),
  }));
}

/* ── The producer ────────────────────────────────────────────────── */

export interface ProducerBrief {
  /** The single most surprising thing in the material. */
  hook: string;
  /** Ideas that must reach the listener. */
  concepts: string[];
  /** Counterintuitive points a host can genuinely react to. */
  ahaMoments: string[];
  /** Everyday comparisons for the hard parts. */
  analogies: string[];
  /** Who this matters to, and why. */
  audience: string;
}

export const EMPTY_BRIEF: ProducerBrief = {
  hook: "",
  concepts: [],
  ahaMoments: [],
  analogies: [],
  audience: "",
};

export function hasBrief(brief: ProducerBrief): boolean {
  return Boolean(brief.hook || brief.concepts.length || brief.ahaMoments.length || brief.analogies.length);
}

/**
 * Read the material before anyone goes on air.
 *
 * Handing a document straight to the hosts gets you a summary read aloud.
 * A producer pass finds the angle first — the surprise, the ideas worth
 * explaining, the moments worth reacting to, and plain-English comparisons
 * for the hard parts — so the hosts have something to perform rather than
 * recite.
 */
/**
 * Longest slice of source material sent in one prompt.
 *
 * A small model on a modest card chokes on a whole document: prompt processing
 * at the top of an 8K window is slow enough to look like a hang. Condensing in
 * small pieces first is far faster than one large call, and fits any context.
 */
const CHUNK_CHARS = 3500;

function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];

  const chunks: string[] = [];
  let at = 0;

  while (at < text.length) {
    let end = Math.min(text.length, at + size);

    // Prefer to break at a paragraph, then a sentence, then anywhere.
    if (end < text.length) {
      const window = text.slice(at, end);
      const para = window.lastIndexOf("\n\n");
      const stop = window.lastIndexOf(". ");
      if (para > size * 0.5) end = at + para;
      else if (stop > size * 0.5) end = at + stop + 1;
    }

    chunks.push(text.slice(at, end).trim());
    at = end;
  }

  return chunks.filter(Boolean);
}

/**
 * Condense a long document into notes the producer can work from.
 * Each chunk is summarised on its own, then the notes are concatenated.
 */
async function condense(
  config: Config,
  text: string,
  onInfo?: (message: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const chunks = chunkText(text, CHUNK_CHARS);
  if (chunks.length === 1) return chunks[0];

  const notes: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    onInfo?.(`Reading part ${i + 1} of ${chunks.length}...`);

    try {
      const note = await generate(producerLlm(config), {
        messages: [
          {
            role: "system",
            content:
              "You condense source material for a podcast producer. You have no tools. " +
              "Keep concrete facts, numbers, names and anything surprising. Drop filler. Plain prose.",
          },
          { role: "user", content: `${chunks[i]}\n\nCondense the above into at most six sentences.` },
        ],
        temperature: 0.2,
        maxTokens: 320,
        signal,
      });
      // Source material that itself contains prompts or instructions makes a
      // small model imitate them instead of summarising. Garbage here poisons
      // everything downstream, so fall back to a plain excerpt of the chunk.
      notes.push(looksLikeToolCall(note) || note.trim().length < 40 ? chunks[i].slice(0, 900) : note.trim());
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      // A chunk that fails is better excerpted than lost.
      onInfo?.(`Part ${i + 1} could not be summarised; using it as written.`);
      notes.push(chunks[i].slice(0, 900));
    }
  }

  return notes.join("\n\n");
}

export async function runProducer(
  config: Config,
  topic: string,
  sourceText: string,
  signal?: AbortSignal,
  onInfo?: (message: string) => void,
): Promise<ProducerBrief> {
  const raw = sourceText.trim();

  // Long documents are condensed first so the producer prompt stays small.
  const material = raw.length > CHUNK_CHARS ? await condense(config, raw, onInfo, signal) : raw;

  const brief = await generateJson<{
    hook?: string;
    concepts?: string[];
    aha_moments?: string[];
    ahaMoments?: string[];
    analogies?: string[];
    audience?: string;
  }>(producerLlm(config), {
    messages: [
      {
        role: "system",
        content:
          "You are the subject editor for an entertaining radio show. You have no tools and no functions. " +
          "Accuracy and topic coverage are your job; the hosts handle personality later. " +
          "Do not add multiverse jokes, station lore, local bureaucracy, or comedy premises. " +
          "Identify the standard meaning of the topic, its essential concepts, and its strongest competing positions. " +
          "Reply with JSON only: " +
          '{"hook": "...", "concepts": ["..."], "aha_moments": ["..."], "analogies": ["..."], "audience": "..."}',
      },
      {
        role: "user",
        content:
          (material
            ? `Source material:\n"""\n${material.slice(0, 12000)}\n"""\n\n`
            : `There is no document. Work from general knowledge of the topic.\n\n`) +
          `Topic: ${topic}\n\n` +
          "Produce the brief:\n" +
          "- hook: the single most surprising or counterintuitive fact. One sentence.\n" +
          "- concepts: 3 to 5 indispensable ideas the listener must come away with. Cover the standard definition and the strongest disagreement. Short phrases.\n" +
          "- aha_moments: 2 points a host can genuinely be surprised by on air. Short phrases.\n" +
          "- analogies: 2 everyday comparisons that explain the hardest parts. Short phrases.\n" +
          "- audience: who cares about this and why it affects them. One sentence.",
      },
    ],
    temperature: 0.6,
    maxTokens: 700,
    signal,
  });

  const text = (v: unknown, max: number) =>
    typeof v === "string" && !looksLikeToolCall(v) && !isPlaceholder(v) ? v.trim().slice(0, max) : "";

  const structured: ProducerBrief = brief
    ? {
        hook: text(brief.hook, 400),
        concepts: cleanList(brief.concepts, 5).filter((c) => !isPlaceholder(c)),
        ahaMoments: cleanList(brief.aha_moments ?? brief.ahaMoments, 3).filter((a) => !isPlaceholder(a)),
        analogies: cleanList(brief.analogies, 3).filter((a) => !isPlaceholder(a)),
        audience: text(brief.audience, 300),
      }
    : { ...EMPTY_BRIEF };

  if (hasBrief(structured)) return structured;

  // The structured request failed — usually because the model answered with a
  // function *schema* rather than content. Small models are far more reliable
  // at plain prose, so ask again without any JSON at all.
  onInfo?.("Structured brief came back empty — asking in plain English instead.");
  return plainBrief(config, topic, material, signal);
}

/**
 * A JSON request can come back describing the fields rather than filling them
 * in — "hook_type": "surprising_fact". Those are never usable content.
 */
function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (/^[a-z]+(_[a-z]+)+$/.test(v)) return true; // snake_case token
  if (/^(the )?(raw )?(source[_ ]document|topic|hook|concepts?|analogies|audience|aha[_ ]moments?)$/i.test(v)) {
    return true;
  }
  if (/^(string|text|list|array|number|\.\.\.)$/i.test(v)) return true;
  return false;
}

/** Fallback producer: no JSON, just a numbered list, which small models handle. */
async function plainBrief(
  config: Config,
  topic: string,
  material: string,
  signal?: AbortSignal,
): Promise<ProducerBrief> {
  try {
    const text = await generate(producerLlm(config), {
      messages: [
        {
          role: "system",
          content:
            "You are the subject editor for a radio show. Accuracy and topic coverage are your job. " +
            "Do not add station lore or comedy. You have no tools and no functions. " +
            "Answer with a plain numbered list and nothing else. Never describe the format; fill it in.",
        },
        {
          role: "user",
          content:
            (material ? `Notes:\n${material.slice(0, 4000)}\n\n` : "") +
            `Topic: ${topic}\n\n` +
            "Write exactly five numbered lines, each filled in with real content:\n" +
            "1. The most surprising thing about this, in one sentence.\n" +
            "2. Three things the listener must understand, separated by semicolons.\n" +
            "3. Two things a host could be genuinely surprised by, separated by semicolons.\n" +
            "4. Two everyday comparisons that explain the hard parts, separated by semicolons.\n" +
            "5. Who cares about this and why, in one sentence.",
        },
      ],
      temperature: 0.6,
      maxTokens: 500,
      signal,
    });

    const lines = text
      .split("\n")
      .map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim())
      .filter((l) => l.length > 8 && !looksLikeToolCall(l) && !isPlaceholder(l));

    const split = (line: string | undefined, max: number) =>
      (line ?? "")
        .split(/;|(?<!\d)\.\s+(?=[A-Z])/)
        .map((s) => s.trim().replace(/\.$/, ""))
        .filter((s) => s.length > 3 && !isPlaceholder(s))
        .slice(0, max);

    return {
      hook: lines[0]?.slice(0, 400) ?? "",
      concepts: split(lines[1], 5),
      ahaMoments: split(lines[2], 3),
      analogies: split(lines[3], 3),
      audience: lines[4]?.slice(0, 300) ?? "",
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return { ...EMPTY_BRIEF };
  }
}

/** Render the producer's brief as a prompt block. */
export function briefBlock(brief: ProducerBrief): string {
  if (!hasBrief(brief)) return "";

  const parts: string[] = ["THE PRODUCER'S BRIEF — this is what makes the show worth hearing:"];

  if (brief.hook) parts.push(`The hook: ${brief.hook}`);
  if (brief.concepts.length) parts.push(`Cover these: ${brief.concepts.map((c) => `- ${c}`).join("\n")}`);
  if (brief.ahaMoments.length) {
    parts.push(
      "React genuinely when these land — surprise is the point, do not just state them:\n" +
        brief.ahaMoments.map((a) => `- ${a}`).join("\n"),
    );
  }
  if (brief.analogies.length) {
    parts.push(`Use these comparisons for the hard parts:\n${brief.analogies.map((a) => `- ${a}`).join("\n")}`);
  }
  if (brief.audience) parts.push(`Who is listening: ${brief.audience}`);

  return parts.join("\n\n");
}

/* ── Rolling memory ──────────────────────────────────────────────── */

export interface ShowMemory {
  /** Two or three lines covering what has happened so far. */
  digest: string;
  /** Concrete things established as true tonight. */
  facts: string[];
  /** Jokes, phrases and bits worth calling back to. */
  gags: string[];
  /** Points already made, so hosts stop repeating them. */
  covered: string[];
}

export const EMPTY_MEMORY: ShowMemory = { digest: "", facts: [], gags: [], covered: [] };

function cleanList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 3 && v.length < 200 && !looksLikeToolCall(v))
    .slice(0, max);
}

/**
 * Fold the newest turns into the running memory.
 *
 * Only the turns since the last update are sent, plus the previous digest, so
 * this stays cheap no matter how long the show runs.
 */
export async function updateMemory(
  config: Config,
  previous: ShowMemory,
  newTurns: Turn[],
  signal?: AbortSignal,
): Promise<ShowMemory> {
  if (newTurns.length === 0) return previous;

  const recent = newTurns.map((t) => `${t.speaker}: ${t.text}`).join("\n");

  try {
    const result = await generateJson<{
      digest?: string;
      facts?: string[];
      gags?: string[];
      covered?: string[];
    }>(config.llm, {
      priority: "background",
      messages: [
        {
          role: "system",
          content:
            "You are a radio producer keeping notes during a live show. You have no tools. " +
            "Reply with JSON only: " +
            '{"digest": "...", "facts": ["..."], "gags": ["..."], "covered": ["..."]}',
        },
        {
          role: "user",
          content:
            (previous.digest ? `Notes so far:\n${previous.digest}\n\n` : "") +
            `New dialogue:\n${recent}\n\n` +
            "Update the notes.\n" +
            "- digest: at most three sentences covering the whole show so far.\n" +
            "- facts: specific things established as true (names, places, events, numbers). Short phrases.\n" +
            "- gags: jokes, nicknames or recurring bits worth bringing back. Short phrases.\n" +
            "- covered: points already argued, so nobody repeats them. Short phrases.",
        },
      ],
      temperature: 0.3,
      maxTokens: 400,
      signal,
    });

    if (!result) return previous;

    const digest = typeof result.digest === "string" ? result.digest.trim() : previous.digest;

    // Merge rather than replace: the model only sees the newest turns, so
    // anything it omits is old, not retracted.
    const merge = (old: string[], next: string[], cap: number) =>
      Array.from(new Set([...old, ...next].map((s) => s.trim()).filter(Boolean))).slice(-cap);

    return {
      digest: digest && !looksLikeToolCall(digest) ? digest.slice(0, 600) : previous.digest,
      facts: merge(previous.facts, cleanList(result.facts, 12), 14),
      gags: merge(previous.gags, cleanList(result.gags, 8), 10),
      covered: merge(previous.covered, cleanList(result.covered, 10), 12),
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    // Memory is an optimisation. Losing an update must never stop the show.
    return previous;
  }
}

/**
 * Render the memory as a compact prompt block. Empty string when there is
 * nothing yet.
 *
 * `allowCallback` decides whether the running bits are offered at all, and it
 * matters more than it looks. A list of jokes headed "you can call these back"
 * sitting in every prompt is not a memory, it is a standing instruction, and a
 * small model obeys it — which is how one bit about a smelly dumpster ends up
 * being said four times in one show. The gags are offered only on the turn
 * whose job is a callback; every other turn is shown the same list as
 * something to steer away from.
 */
export function memoryBlock(memory: ShowMemory, hostName: string, allowCallback = false): string {
  const parts: string[] = [];

  if (memory.digest) parts.push(`SO FAR TONIGHT:\n${memory.digest}`);

  if (memory.facts.length) {
    parts.push(`ESTABLISHED — treat as true:\n${memory.facts.map((f) => `- ${f}`).join("\n")}`);
  }

  if (memory.gags.length) {
    const bits = memory.gags.map((g) => `- ${g}`).join("\n");
    parts.push(
      allowCallback
        ? `RUNNING BITS — pick ONE of these, land it once, and move on. Not all of them:\n${bits}`
        : `ALREADY USED TONIGHT — ${hostName} must not say any of these again:\n${bits}`,
    );
  }

  if (memory.covered.length) {
    parts.push(`ALREADY ARGUED — do not repeat these:\n${memory.covered.map((c) => `- ${c}`).join("\n")}`);
  }

  return parts.join("\n\n");
}

/* ── Anti-repetition ─────────────────────────────────────────────── */

const FILLER = [
  "that's a great point",
  "that's a fair point",
  "that's exactly",
  "that's so true",
  "that's precisely",
  "i love that idea",
  "you raise a fair point",
  "you make a fair point",
  "absolutely right",
  "i see where you're coming from",
  "i hear what you're saying",
  "that's a good question",
  "absolutely",
  "at the end of the day",
  "let's be real",
  "look,",
];

/**
 * Detect a line that opens with the same filler as a recent one.
 *
 * Small models fall into a groove — every turn starting "That's a fair point,
 * but" — which is the single most obvious tell that a show is machine-made.
 */
/**
 * A line built out of comparison instead of fact.
 *
 * The prompt has forbidden similes for a while and it does not work — measured,
 * four with the rule against three without. A roleplay-tuned model reaches for
 * "like a" the way an instruct model reaches for "certainly", and no amount of
 * telling it not to changes what it was trained on.
 *
 * So this catches it after the fact instead. One simile in a line is a figure
 * of speech and perfectly good; two or more is a line that has stopped saying
 * anything — "their ranks swell like embers on a fire, spreading like a tide,
 * as inexorably as night follows day". Returns the offending phrases.
 */
export function leansOnSimile(text: string, limit = 2): string[] {
  const found = text.match(/\b(?:like an?|like the|as an?|just as|akin to|as if|as though)\b[^,.;!?]{0,40}/gi) ?? [];
  return found.length >= limit ? found.map((f) => f.trim()) : [];
}

/**
 * A line that hands the previous one straight back.
 *
 * Small models mirror. Asked to react to what was just said, they reach for
 * the safest possible move and say it again in their own mouth — "Wommper's
 * face keeps coming back to me, a rogue unwounded, but that oath..." arriving
 * one turn after exactly those words. Two turns of that and the show is a
 * hall of mirrors.
 *
 * The system prompt forbids it and is ignored, so this catches it after the
 * fact: any run of consecutive words long enough to be a quotation rather
 * than a coincidence. Returns the echoed run, or null.
 */
export function echoesPrevious(text: string, turns: Array<{ text: string }>, run = 6): string | null {
  const previous = turns[turns.length - 1]?.text;
  if (!previous) return null;

  const words = (value: string): string[] =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9' ]/g, " ")
      .split(/\s+/)
      .filter(Boolean);

  const mine = words(text);
  const theirs = words(previous);
  if (mine.length < 4 || theirs.length < 4) return null;

  // -- Verbatim. Any run long enough to be a quotation, not a coincidence.
  if (mine.length >= run && theirs.length >= run) {
    const seen = new Set<string>();
    for (let i = 0; i + run <= theirs.length; i++) seen.add(theirs.slice(i, i + run).join(" "));

    for (let i = 0; i + run <= mine.length; i++) {
      const window = mine.slice(i, i + run).join(" ");
      if (seen.has(window)) return window;
    }
  }

  // -- Reworded. The harder and far more common case: the same thought handed
  // back with three words changed, which the verbatim check sails past.
  // "They walk among us as ghosts, unkillable" one turn after "They walk among
  // us as if they are already ghosts, unkillable" is the whole problem, and no
  // run of six words matches it.
  //
  // Only the opening is compared. A line that begins by restating the other
  // speaker has already lost, however well it recovers afterwards.
  const content = (list: string[]) => list.filter((w) => w.length >= 4 && !ORDINARY.has(w));

  const opening = content(mine.slice(0, 14));
  if (opening.length < 4) return null;

  const theirWords = new Set(content(theirs));
  const shared = opening.filter((w) => theirWords.has(w));

  // Half the opening, and at least three real words. Measured against actual
  // courts: a genuine reply to the same subject shares one or two words with
  // the line before it, a hand-back shares most of them.
  if (shared.length >= 3 && shared.length / opening.length >= 0.5) return shared.slice(0, 6).join(" ");

  return null;
}

export function repeatsOpening(text: string, previous: Turn[]): string | null {
  const opening = text.trim().toLowerCase().slice(0, 80);

  const usedFiller = FILLER.find((f) => opening.startsWith(f));
  if (usedFiller) {
    const alreadyUsed = previous.slice(-8).some((t) => t.text.trim().toLowerCase().startsWith(usedFiller));
    // The opening exchange gets some grace. After that, rotating among five
    // different generic agreements is still one audible chatbot habit.
    if (alreadyUsed || previous.length >= 2) return usedFiller;
  }

  // Filler is only one form of a groove. Long shows also develop perfectly
  // ordinary but very audible templates: "I think there's room...", "Marco,
  // I think...", "The real issue is...". Compare the first three spoken words
  // across the recent show, which is the same unit the transcript audit uses.
  //
  // The whole show is compared, not a recent window: the transcript audit
  // counts a repeat however far apart the two lines are, and a long show
  // repeats most often at exactly the distance a window forgets.
  const fingerprint = openingKey(text);
  if (fingerprint.split(" ").length < 3) return null;
  return previous.some((turn) => openingKey(turn.text) === fingerprint) ? fingerprint : null;
}

/** The first three spoken words of a line: the unit the transcript audit compares. */
function openingKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
}

/**
 * Every three-word opening the show has already used, most recent first.
 *
 * {@link recentOpenings} only remembers the last few turns, so a long show
 * happily returns to an opening it used twenty turns ago. This is the whole
 * show's list, for telling the next speaker what is taken.
 */
export function usedOpenings(turns: Turn[], limit = 16): string[] {
  const seen = new Set<string>();
  for (let i = turns.length - 1; i >= 0 && seen.size < limit; i--) {
    const key = openingKey(turns[i].text);
    if (key.split(" ").length >= 3) seen.add(key);
  }
  return Array.from(seen);
}

/**
 * Words too ordinary to count as an image.
 *
 * This is deliberately not a full stopword list. The job is only to let
 * "dumpster" and "casserole" through while keeping "actually" and "everybody"
 * out, so that what gets tracked is the thing a listener would notice being
 * said twice.
 */
const ORDINARY = new Set([
  "about", "actually", "again", "against", "already", "always", "another", "anything", "around",
  "because", "been", "before", "being", "better", "between", "cannot", "come", "coming", "could",
  "does", "doing", "down", "even", "ever", "every", "everybody", "everyone", "everything", "from",
  "gets", "getting", "going", "gonna", "have", "having", "here", "hold", "into", "just", "keep",
  "kind", "know", "last", "like", "listen", "little", "look", "looking", "made", "make", "makes",
  "making", "many", "mean", "more", "most", "much", "need", "never", "next", "nothing", "only",
  "other", "over", "people", "point", "pretty", "probably", "properly", "question", "really",
  "right", "said", "same", "says", "seen", "show", "since", "some", "someone", "something",
  "sort", "still", "stuff", "such", "sure", "take", "talk", "talking", "tell", "than", "that",
  "their", "them", "then", "there", "these", "they", "thing", "things", "think", "this", "those",
  "thought", "through", "time", "today", "tonight", "turn", "under", "very", "want", "well",
  "were", "what", "when", "where", "which", "while", "whole", "will", "with", "without", "would",
  "yeah", "year", "years", "your",
]);

/** Distinctive words in a line: long enough and unusual enough to be an image. */
function imagesIn(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-']+|[-']+$/g, ""))
    .filter((w) => w.length >= 5 && !ORDINARY.has(w))
    // Collapse a plural onto its singular before counting. Without this a
    // model can loop on one image indefinitely just by alternating the two:
    // "specters" and "specter" were counted as different images, so a court
    // said the same thing four times and never tripped the guard.
    .map((w) => (w.length >= 6 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));

  return Array.from(new Set(words));
}

/**
 * Words the show is *about*, which are supposed to recur and must never be
 * flagged. Built from the topic and the host names.
 */
function exemptWords(topic: string, hostNames: string[]): Set<string> {
  const out = new Set<string>();
  for (const word of imagesIn(`${topic} ${hostNames.join(" ")}`)) {
    out.add(word);
    // Cheap singular/plural pairing, so "machines" in the topic also exempts
    // "machine" in the dialogue.
    if (word.endsWith("s")) out.add(word.slice(0, -1));
    else out.add(`${word}s`);
  }
  return out;
}

/** How many previous turns each distinctive word appeared in. */
function imageCounts(turns: Turn[], exempt: Set<string>): Map<string, number> {
  const counts = new Map<string, number>();

  for (const turn of turns) {
    for (const word of imagesIn(turn.text)) {
      if (exempt.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  return counts;
}

/**
 * Images the show has already leaned on, so the next turn can be told to find
 * a different one. A soft hint: being slightly wrong here costs nothing.
 */
export function overusedImages(
  turns: Turn[],
  topic: string,
  hostNames: string[],
  minTurns = 2,
  limit = 8,
): string[] {
  const counts = imageCounts(turns, exemptWords(topic, hostNames));

  return Array.from(counts.entries())
    .filter(([, n]) => n >= minTurns)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

/**
 * The image this line is about to say for the fourth time.
 *
 * Stricter than {@link overusedImages} because acting on it costs a model
 * call: it only fires once a word has already carried three separate turns,
 * which is well past the point a listener notices the loop.
 */
export function repeatsImage(text: string, turns: Turn[], topic: string, hostNames: string[], limit = 3): string | null {
  const counts = imageCounts(turns, exemptWords(topic, hostNames));

  for (const word of imagesIn(text)) {
    if ((counts.get(word) ?? 0) >= limit) return word;
  }

  return null;
}

/** First few words of recent turns, so the prompt can ask for something different. */
export function recentOpenings(turns: Turn[], count = 4): string[] {
  return turns
    .slice(-count)
    .map((t) => t.text.trim().split(/\s+/).slice(0, 5).join(" "))
    .filter(Boolean);
}

/* ── Show titling from memory ────────────────────────────────────── */

/** A tighter title prompt than raw transcript, using the digest we already have. */
export async function titleFromMemory(
  config: Config,
  topic: string,
  memory: ShowMemory,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!memory.digest) return null;

  try {
    const text = await generate({ ...config.llm, model: config.llm.notesModel || config.llm.model }, {
      messages: [
        {
          role: "system",
          content: "You write radio episode titles. You have no tools. Reply with the title only, nothing else.",
        },
        {
          role: "user",
          content: `Topic: ${topic}\nWhat happened: ${memory.digest}\n\nGive a punchy episode title, at most eight words. No quotes.`,
        },
      ],
      temperature: 0.8,
      maxTokens: 40,
      signal,
    });

    const title = text.trim().replace(/^["']|["']$/g, "").split("\n")[0];
    return title && !looksLikeToolCall(title) && title.length < 90 ? title : null;
  } catch {
    return null;
  }
}
