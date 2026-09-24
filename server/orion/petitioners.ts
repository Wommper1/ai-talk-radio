/**
 * The Respawn Guild, brought before the King.
 *
 * Until now the Guild was a number in a briefing: four names and a death
 * count. But they are not statistics — they are the people in your Discord
 * party, and the whole appeal of a court is being in the room when the man who
 * rules the place talks about you by name.
 *
 * So one of them is brought forward mid-court. They speak, once, in their own
 * voice, and the King answers them. Everything they say is drawn from what the
 * game actually records about them: how many times they have been put down,
 * how many they have taken, how long they have ridden.
 *
 * They are the enemy's party, standing in the enemy's enemy's hall. That is
 * the whole scene, and it needs no more setup than that.
 */

import type { Config } from "../config.ts";
import { generate, looksLikeToolCall } from "../providers/llm.ts";
import type { GuildMember } from "./realm.ts";
import { GUILD_NAME } from "./realm.ts";

/** Voices for people the station has never met, so they do not all sound alike. */
const PETITIONER_VOICES: Record<string, string[]> = {
  edge: [
    "en-GB-RyanNeural",
    "en-IE-ConnorNeural",
    "en-AU-WilliamMultilingualNeural",
    "en-US-EmmaMultilingualNeural",
    "en-GB-LibbyNeural",
    "en-US-EricNeural",
    "en-IE-EmilyNeural",
  ],
  sapi: ["Microsoft David Desktop", "Microsoft Hazel Desktop", "Microsoft Zira Desktop"],
  piper: ["en_GB-alan-medium.onnx", "en_US-hfc_female-medium.onnx", "en_US-ryan-high.onnx"],
  none: [""],
};

/**
 * Wommper's voice, which is not drawn from the pool.
 *
 * The pool exists so strangers do not all sound alike. He is not a stranger —
 * he is the one name in the roster the King already knows, and he should sound
 * the same every time he is in the room. Relaxed and American against a
 * formal king: the contrast is the point, because the threat is that none of
 * this is costing him anything.
 */
const WOMMPER_VOICES: Record<string, string> = {
  edge: "en-US-BrianNeural",
  sapi: "Microsoft David Desktop",
  piper: "en_US-ryan-high.onnx",
  none: "",
};

/**
 * Is this the man himself?
 *
 * The game's roster is a Discord party, so the player sits in it under whatever
 * handle they play as — "Wommper1" in the save this was built against. The
 * chronicle calls him Wommper. Matching on the stem rather than the exact
 * string is what keeps those two the same person, and keeps the King from
 * being told his worst enemy is an anonymous rider who follows himself around.
 */
export function isWommper(name: string): boolean {
  return /^wommper\d*$/.test(name.trim().toLowerCase());
}

function hashOf(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A voice for one rider, stable across shows.
 *
 * Chosen from their name rather than at random, so somebody who comes before
 * the King three courts running sounds like the same person all three times.
 */
export function voiceForMember(member: GuildMember, engine: string): string {
  if (isWommper(member.name)) return WOMMPER_VOICES[engine] ?? WOMMPER_VOICES.edge;
  const pool = PETITIONER_VOICES[engine] ?? PETITIONER_VOICES.edge;
  return pool[hashOf(member.name) % pool.length];
}

/** How this rider reads, from what the game has recorded about them. */
function standingOf(member: GuildMember): string {
  const bits: string[] = [];
  const him = isWommper(member.name);

  if (member.deaths === 0) bits.push("has never been put down, which is either luck or something worse");
  else if (member.deaths === 1) bits.push("has been killed once and came back");
  else bits.push(`has been killed ${member.deaths} times and has come back every time`);

  if (member.kills > 0) bits.push(`has taken ${member.kills} of the King's own`);
  if (member.fallen) bits.push("is down at this very moment, which has never stopped any of them before");
  if (member.turns > 0) {
    bits.push(
      him
        ? `has been loose in the realm for ${member.turns} turns`
        : `has ridden ${member.turns} turns with Wommper`,
    );
  }

  return bits.join(", ");
}

/**
 * Who comes forward tonight.
 *
 * One per court. More than one and the night stops being the King’s — and the
 * point of a petitioner is that it interrupts him, which only works if it is
 * rare.
 *
 * Wommper is not in the rotation. He is in the roster — the game keeps the
 * Discord party, and the player is in his own party — but he is the enemy, not
 * a rider to be paraded, and a save with no other members would otherwise put
 * the realm’s biggest threat in the hall every single night until he was
 * furniture. So the riders go first, and he comes only when there is nobody
 * else to send and the night happens to be his: roughly one court in three,
 * and the rest have no petitioner at all, which is the correct answer.
 */
const WOMMPER_ODDS = 3;

export function choosePetitioner(guild: GuildMember[], seed: number): GuildMember | null {
  const standing = guild.filter((m) => m.name);
  const riders = standing.filter((m) => !isWommper(m.name));

  if (riders.length > 0) return riders[seed % riders.length];

  const himself = standing.find((m) => isWommper(m.name));
  if (!himself) return null;
  return seed % WOMMPER_ODDS === 0 ? himself : null;
}

/**
 * What they say when they are brought in.
 *
 * Written by the model, but on a very short leash: they are one voice, once,
 * and they have no idea what has been said in the hall tonight. Everything
 * they know is their own record.
 *
 * Falls back to a written line rather than failing — a petitioner who arrives
 * silent is worse than one who says something plain.
 */
export async function speakPetition(
  config: Config,
  member: GuildMember,
  topic: string,
  signal?: AbortSignal,
): Promise<string> {
  const king = config.orion.king.name;

  const him = isWommper(member.name);

  const plain =
    "You have no tools and no functions. You say the words out loud and nothing else. No JSON, no " +
    "labels, no stage directions.";

  // Two different scenes, and they are not the same scene with the name swapped.
  // A rider is a prisoner being made an example of. Wommper is a parley, and
  // the man with the crown is the one who asked for it.
  const system = him
    ? `You are Wommper. You are the reason ${king} has a war. You have taken his roads, his ` +
      `granaries and his people, and you are not finished. You are standing in his hall tonight ` +
      `because he sent for you and you were curious enough to come. ${plain}`
    : `You are ${member.name}, a rider of ${GUILD_NAME} — the party that rides with Wommper, who is ` +
      `tearing ${king}'s realm apart. You have been brought into his hall, under guard, to speak. ` +
      plain;

  const shared =
    `The matter before the court tonight is ${topic}.\n\n` +
    `What the record says about you: you ${standingOf(member)}.\n\n` +
    `Say your piece to ${king}. One turn, under forty words, spoken aloud.\n`;

  const user = him
    ? shared +
      "- You are not a petitioner and you are not asking him for anything. You came to look at him.\n" +
      "- You are relaxed. He is the one who needs this to go somewhere. You can walk out and carry on " +
      "taking his realm apart either way, and you both know it.\n" +
      "- Do not threaten him. Threats are for people who need something. Be pleasant about it, which " +
      "is worse.\n" +
      "- Be specific and be short. A thing you took, a thing you are going to take, or a thing he has " +
      "got wrong about you.\n" +
      "- Never narrate yourself. Never describe the room. Just talk to him."
    : shared +
      "- You are not sorry and you are not begging. You came back from the dead more than once; a king " +
      "in a chair is not the worst thing you have faced.\n" +
      "- But you are not stupid either. He can have you killed in this room and you both know it, and " +
      "it would not be the first time it did not take.\n" +
      "- Be specific and be short. A thing you did, a thing you want, or a thing he has got wrong.\n" +
      "- Never narrate yourself. Never describe the room. Just talk to him.";

  try {
    const raw = await generate(config.llm, {
      priority: "background",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
        // The prefill that stops a Llama-family model answering with a schema.
        { role: "assistant", content: `${king},` },
      ],
      temperature: Math.min(1.2, config.orion.temperature + 0.05),
      maxTokens: 140,
      signal,
    });

    const line = `${king},${raw}`
      .replace(/\s+/g, " ")
      .replace(/^\s*["']|["']\s*$/g, "")
      .trim();

    if (line.length > 12 && !looksLikeToolCall(line)) return line;
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    // Fall through to the written line.
  }

  // Plain, true, and drawn entirely from the record.
  if (him) {
    return member.turns > 0
      ? `${king}. I have been loose in your realm ${member.turns} turns and you have sent for me once. ` +
          "That is the whole of it, and it is not my problem."
      : `${king}. You sent for me. I came. Say what it is.`;
  }

  return member.deaths > 0
    ? `${king}. You have had me killed ${member.deaths === 1 ? "once" : `${member.deaths} times`}. ` +
        "I am still standing in your hall. Whatever you are counting, it is not working."
    : `${king}. I ride with Wommper and I am not going to pretend otherwise. Ask me what you like.`;
}
