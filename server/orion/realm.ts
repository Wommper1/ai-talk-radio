/**
 * King Orion's Realm, read from the game's own brain.
 *
 * This is a guest on the station, not a part of it. Everything the King knows
 * comes out of the game's files and nothing else: no radio memory, no previous
 * episodes of the talk show, no phone book. If it did not happen in the realm,
 * he does not know it.
 *
 * Two sources, both the game's, both read exactly as the game writes them:
 *
 *   world.db        The chronicle. A SQLite database the game logs deeds into —
 *                   battles, deaths, milestones, quests, the people and places
 *                   it has met. This is ground truth for what has happened.
 *   save_data.json  Where Wommper stands right now: class, level, wounds,
 *                   purse, what is in the pack, the journal line, the turn count.
 *
 * Nothing here writes. Nothing here imports from the game. The database is
 * opened read-only, so a show can be made while the game is running and the
 * worst case is a slightly stale chronicle. Writing back is a separate module
 * with its own deliberate switch, because the two directions carry very
 * different risks.
 *
 * Read via node:sqlite, which ships with Node — adding a native database
 * dependency to a radio app so it can read a game's save file would be a poor
 * trade, and this app deliberately has almost none.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Wommper's state, exactly as the game stores it. */
export interface RealmSave {
  level: number;
  xp: number;
  maxHp: number;
  currentHp: number;
  playerClass: string;
  inventory: string[];
  gold: number;
  equippedWeapon: string | null;
  equippedArmor: string | null;
  knownSpells: string[];
  /** The one-line journal the game's narrator keeps. */
  journal: string;
  contacts: string;
  turnCount: number;
  inCombat: boolean;
  reputationHero?: number;
  reputationCrime?: number;
  enemy?: {
    key: string;
    name: string;
    hp: number;
    maxHp: number;
    boss: boolean;
  } | null;
}

/**
 * One rider of the Respawn Guild.
 *
 * The party Wommper picks up along the way — the game keeps its roster in
 * `discord_party.json`, with the tally that matters to a king counting his
 * enemies: how many times each of them has been put down, and got back up.
 */
export interface GuildMember {
  id?: string;
  name: string;
  deaths: number;
  kills: number;
  turns: number;
  fallen: boolean;
  level?: number;
  currentHp?: number;
  maxHp?: number;
  playerClass?: string;
  location?: string;
}

export interface RealmClaim {
  id: number;
  source: string;
  type: string;
  description: string;
  participants: string[];
  location: string;
  confidence: number;
  status: string;
  timestamp: string;
}

/** One deed from the chronicle. */
export interface RealmEvent {
  id: number;
  type: string;
  description: string;
  participants: string[];
  location: string;
  importance: number;
  timestamp: string;
  source: string;
}

export interface RealmQuest {
  id: string;
  name: string;
  description: string;
  status: string;
  location: string;
}

export interface RealmNpc {
  id: string;
  name: string;
  location: string;
  status: string;
  disposition: string;
}

export interface RealmLocation {
  id: string;
  name: string;
  type: string;
  description: string;
  connectedTo: string[];
}

export interface Realm {
  /** Absolute path to the game folder this was read from. */
  root: string;
  save: RealmSave | null;
  /** The Respawn Guild, riding with the realm's enemy. */
  guild: GuildMember[];
  events: RealmEvent[];
  quests: RealmQuest[];
  npcs: RealmNpc[];
  locations: RealmLocation[];
  claims: RealmClaim[];
  campaignId: string;
  runtimeRevision: number;
  runtimeUpdatedAt: string;
  stateSource: "discord" | "solo" | "none";
  /** Anything that could not be read, in plain words, for the UI to show. */
  problems: string[];
}

export const EMPTY_REALM: Realm = {
  root: "",
  save: null,
  guild: [],
  events: [],
  quests: [],
  npcs: [],
  locations: [],
  claims: [],
  campaignId: "",
  runtimeRevision: 0,
  runtimeUpdatedAt: "",
  stateSource: "none",
  problems: [],
};

/* ── Finding it ──────────────────────────────────────────────────── */

/** Where the game lives when nothing else is configured. */
const KNOWN_REALM = "C:/Wommper1/AlexAIHub/projects/king_orions_realm";

/**
 * The game folder, or null.
 *
 * A configured path wins. Failing that, the one place it is known to live is
 * tried, so the common case needs no setup at all.
 */
export function resolveRealm(configured: string): string | null {
  const asked = configured.trim();

  // A configured path is an instruction, not a hint. If it is wrong this
  // returns nothing and says so, rather than falling back to the known
  // location — because the case that matters is pointing at a copy to test
  // against, mistyping it, and silently writing to the real save instead.
  // Only an empty setting means "look where it usually is".
  const candidates = asked ? [asked] : [KNOWN_REALM];

  for (const candidate of candidates) {
    try {
      const full = path.resolve(candidate);
      // A folder is only the realm if the game's own brain is in it. This also
      // stops a mistyped path quietly producing an empty, plausible-looking King.
      if (fs.existsSync(path.join(full, "world.db"))) return full;
    } catch {
      // Unreadable path.
    }
  }

  return null;
}

/* ── Reading it ──────────────────────────────────────────────────── */

function readSave(root: string, problems: string[]): RealmSave | null {
  const file = path.join(root, "save_data.json");

  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
    const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

    const enemy = raw.enemy && typeof raw.enemy === "object" ? raw.enemy as Record<string, unknown> : null;
    return {
      level: num(raw.level, 1),
      xp: num(raw.xp),
      maxHp: num(raw.max_hp),
      currentHp: num(raw.current_hp),
      playerClass: String(raw.player_class ?? "wanderer"),
      inventory: list(raw.inventory),
      gold: num(raw.gold),
      equippedWeapon: raw.equipped_weapon ? String(raw.equipped_weapon) : null,
      equippedArmor: raw.equipped_armor ? String(raw.equipped_armor) : null,
      knownSpells: list(raw.known_spells),
      journal: String(raw.world_journal ?? "").trim(),
      contacts: String(raw.contacts ?? "").trim(),
      turnCount: num(raw.turn_count),
      inCombat: Boolean(raw.in_combat),
      reputationHero: num(raw.reputation_hero),
      reputationCrime: num(raw.reputation_crime),
      enemy: enemy
        ? {
            key: String(enemy.key ?? ""),
            name: String(enemy.name ?? "Unknown enemy"),
            hp: num(enemy.hp),
            maxHp: num(enemy.max_hp),
            boss: Boolean(enemy.boss),
          }
        : null,
    };
  } catch (err) {
    if (fs.existsSync(file)) {
      problems.push(`The save file could not be read: ${(err as Error).message}`);
    }
    return null;
  }
}

/**
 * The Respawn Guild's roster.
 *
 * The name is the party's own and does not appear in the game's files — the
 * game only keeps the roster. It is canon rather than configuration, so it
 * lives here beside the code that reads the roster it names.
 */
export const GUILD_NAME = "The Respawn Guild";

function readGuild(root: string): GuildMember[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "discord_party.json"), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;

    return Object.entries(raw)
      .map(([id, m]) => ({
        id,
        name: String(m.name ?? "").trim(),
        deaths: Number(m.deaths ?? 0),
        kills: Number(m.kills ?? 0),
        turns: Number(m.turns_taken ?? 0),
        fallen: Boolean(m.is_fallen),
      }))
      .filter((m) => m.name);
  } catch {
    // No party yet, or a roster that will not parse. He rides alone.
    return [];
  }
}

function readDiscordRuntime(
  db: DatabaseSync,
): { save: RealmSave; guild: GuildMember[]; campaignId: string; revision: number; updatedAt: string } | null {
  try {
    const meta = db.prepare("SELECT value FROM realm_meta WHERE key='current_campaign_id'").get() as
      | Record<string, unknown>
      | undefined;
    const campaignId = String(meta?.value ?? "legacy");
    const row = db
      .prepare("SELECT state_json, roster_json, revision, updated_at FROM discord_runtime WHERE campaign_id=?")
      .get(campaignId) as Record<string, unknown> | undefined;
    if (!row) return null;

    const state = JSON.parse(String(row.state_json ?? "{}")) as Record<string, unknown>;
    const roster = JSON.parse(String(row.roster_json ?? "{}")) as Record<string, Record<string, unknown>>;
    const members = Object.entries(roster);
    const firstStats = (members[0]?.[1]?.stats ?? {}) as Record<string, unknown>;
    const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
    const num = (value: unknown, fallback = 0): number =>
      typeof value === "number" && Number.isFinite(value) ? value : fallback;
    const contacts = Array.isArray(state.contacts)
      ? state.contacts.map((item) => (typeof item === "object" && item ? String((item as Record<string, unknown>).name ?? "") : String(item))).filter(Boolean).join(", ")
      : String(state.contacts ?? "");

    return {
      campaignId,
      revision: num(row.revision),
      updatedAt: String(row.updated_at ?? ""),
      save: {
        level: num(firstStats.level, 1),
        xp: num(firstStats.xp),
        maxHp: num(firstStats.max_hp, 30),
        currentHp: num(firstStats.current_hp, 30),
        playerClass: String(firstStats.player_class ?? "warrior"),
        inventory: list(firstStats.inventory),
        gold: num(firstStats.gold),
        equippedWeapon: firstStats.equipped_weapon ? String(firstStats.equipped_weapon) : null,
        equippedArmor: firstStats.equipped_armor ? String(firstStats.equipped_armor) : null,
        knownSpells: list(firstStats.known_spells),
        journal: String(state.world_journal ?? "").trim(),
        contacts,
        turnCount: num(state.total_turns, num(state.turn_count)),
        inCombat: Boolean(state.in_combat),
        reputationHero: num(firstStats.reputation_hero),
        reputationCrime: num(firstStats.reputation_crime),
        enemy: state.enemy && typeof state.enemy === "object"
          ? {
              key: String((state.enemy as Record<string, unknown>).key ?? ""),
              name: String((state.enemy as Record<string, unknown>).name ?? "Unknown enemy"),
              hp: num((state.enemy as Record<string, unknown>).hp),
              maxHp: num((state.enemy as Record<string, unknown>).max_hp),
              boss: Boolean((state.enemy as Record<string, unknown>).boss),
            }
          : null,
      },
      guild: members.map(([id, member]) => {
        const stats = (member.stats ?? {}) as Record<string, unknown>;
        return {
          id,
          name: String(member.name ?? "").trim(),
          deaths: num(member.deaths),
          kills: num(member.kills),
          turns: num(member.turns_taken),
          fallen: Boolean(member.is_fallen),
          level: num(stats.level, 1),
          currentHp: num(stats.current_hp, 30),
          maxHp: num(stats.max_hp, 30),
          playerClass: String(stats.player_class ?? "warrior"),
          location: String(stats.location ?? state.location ?? "The Wildlands"),
        };
      }).filter((member) => member.name),
    };
  } catch {
    return null;
  }
}

/** Parse a column the game stores as a JSON string, without ever throwing. */
function jsonList(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/**
 * Read the chronicle.
 *
 * Read-only and untouched by any write: the game may well be running, and a
 * radio show is never a good enough reason to hold a lock on somebody's save.
 */
export function readRealm(configured: string, eventLimit = 40): Realm {
  const root = resolveRealm(configured);
  if (!root) {
    return {
      ...EMPTY_REALM,
      problems: [
        configured.trim()
          ? `No world.db in "${configured.trim()}" — that is not the game folder.`
          : "King Orion's Realm was not found. Point the Realm folder at the game in Settings.",
      ],
    };
  }

  const problems: string[] = [];
  const realm: Realm = {
    ...EMPTY_REALM,
    root,
    problems,
    save: readSave(root, problems),
    guild: readGuild(root),
    stateSource: "solo",
  };

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path.join(root, "world.db"), { readOnly: true });

    const discord = readDiscordRuntime(db);
    if (discord) {
      realm.save = discord.save;
      realm.guild = discord.guild;
      realm.campaignId = discord.campaignId;
      realm.runtimeRevision = discord.revision;
      realm.runtimeUpdatedAt = discord.updatedAt;
      realm.stateSource = "discord";
    }

    const rows = <T>(sql: string, ...params: Array<string | number>): T[] => {
      try {
        return db!.prepare(sql).all(...params) as T[];
      } catch {
        // A table the game has not created yet is not an error worth reporting;
        // an empty realm is a perfectly good realm to open a show about.
        return [];
      }
    };

    const hasColumn = (table: string, column: string): boolean =>
      rows<Record<string, unknown>>(`PRAGMA table_info(${table})`).some((item) => String(item.name) === column);
    const eventSql = realm.campaignId && hasColumn("events", "campaign_id")
      ? "SELECT * FROM events WHERE campaign_id=? AND canonical=1 ORDER BY event_id DESC LIMIT ?"
      : "SELECT * FROM events ORDER BY event_id DESC LIMIT ?";
    const eventParams: Array<string | number> = realm.campaignId && hasColumn("events", "campaign_id")
      ? [realm.campaignId, eventLimit]
      : [eventLimit];
    realm.events = rows<Record<string, unknown>>(eventSql, ...eventParams)
      .map((r) => ({
        id: Number(r.event_id ?? 0),
        type: String(r.event_type ?? ""),
        description: String(r.description ?? "").trim(),
        participants: jsonList(r.participants),
        location: String(r.location ?? "").trim(),
        importance: Number(r.importance ?? 1),
        timestamp: String(r.timestamp ?? ""),
        source: String(r.source ?? "game"),
      }))
      .filter((e) => e.description)
      // Oldest first: a chronicle read backwards is a list, read forwards a story.
      .reverse();

    const questSql = realm.campaignId && hasColumn("quests", "campaign_id")
      ? "SELECT * FROM quests WHERE campaign_id=? ORDER BY rowid DESC LIMIT 20"
      : "SELECT * FROM quests ORDER BY rowid DESC LIMIT 20";
    const questParams: Array<string | number> = realm.campaignId && hasColumn("quests", "campaign_id")
      ? [realm.campaignId]
      : [];
    realm.quests = rows<Record<string, unknown>>(questSql, ...questParams).map((r) => ({
      id: String(r.quest_id ?? ""),
      name: String(r.name ?? "").trim(),
      description: String(r.description ?? "").trim(),
      status: String(r.status ?? "").trim(),
      location: String(r.location ?? "").trim(),
    }));

    realm.npcs = rows<Record<string, unknown>>("SELECT * FROM npcs LIMIT 40").map((r) => ({
      id: String(r.npc_id ?? ""),
      name: String(r.name ?? "").trim(),
      location: String(r.current_location ?? r.home_location ?? r.location ?? "").trim(),
      status:
        r.status !== undefined
          ? String(r.status).trim()
          : Number(r.is_alive ?? 1) === 1
            ? "alive"
            : "dead",
      disposition: String(r.current_mood ?? r.disposition ?? r.personality ?? "").trim(),
    }));

    realm.locations = rows<Record<string, unknown>>("SELECT * FROM locations LIMIT 40").map((r) => ({
      id: String(r.location_id ?? ""),
      name: String(r.name ?? "").trim(),
      type: String(r.type ?? "unknown").trim(),
      description: String(r.description ?? "").trim(),
      connectedTo: jsonList(r.connected_to),
    }));

    if (realm.campaignId) {
      realm.claims = rows<Record<string, unknown>>(
        "SELECT * FROM claims WHERE campaign_id=? ORDER BY claim_id DESC LIMIT 20",
        realm.campaignId,
      ).map((row) => ({
        id: Number(row.claim_id ?? 0),
        source: String(row.source ?? "unknown"),
        type: String(row.claim_type ?? "statement"),
        description: String(row.description ?? "").trim(),
        participants: jsonList(row.participants),
        location: String(row.location ?? "").trim(),
        confidence: Number(row.confidence ?? 0.5),
        status: String(row.status ?? "unverified"),
        timestamp: String(row.timestamp ?? ""),
      })).filter((claim) => claim.description);
    }
  } catch (err) {
    problems.push(`The chronicle could not be opened: ${(err as Error).message}`);
  } finally {
    try {
      db?.close();
    } catch {
      /* already gone */
    }
  }

  return realm;
}

/* ── Telling him what he knows ───────────────────────────────────── */

/** A deed, in one line, the way a chronicle would have it. */
function deedLine(event: RealmEvent): string {
  const where = event.location ? ` (${event.location})` : "";
  return `- ${event.description}${where}`;
}

/**
 * The realm, written for the King to read before he speaks.
 *
 * Deliberately a brief, not a transcript. This is the only thing standing
 * between "recounting the deeds of the realm" and "inventing a fantasy novel",
 * so it leads with what is true, says plainly how much is recorded, and says
 * what he is allowed to do with the gaps.
 *
 * The framing matters as much as the facts. Wommper is not his champion — he
 * is the thing loose in the realm, and the chronicle is a record of what that
 * has cost. Written the other way round, the King reads his own enemy's
 * victories as his own achievements, which is a different show entirely.
 */
export function realmBriefing(realm: Realm, lore = ""): string {
  if (!realm.root) return "";

  const sections: string[] = [];

  // History first. The chronicle says what has been done; this says what the
  // realm *is*, and a king with no past has nothing to speak from but the
  // ledger in front of him.
  if (lore.trim()) {
    sections.push(
      "HOW THIS REALM CAME TO BE — your own history. As true as anything in the record:",
      lore.trim(),
      "",
    );
  }

  sections.push("THE REALM AS IT ACTUALLY STANDS — this is the record, and it is the truth:");

  if (realm.save && realm.stateSource !== "discord") {
    const s = realm.save;
    const wounds =
      s.currentHp >= s.maxHp
        ? "unwounded, which is the problem"
        : s.currentHp <= s.maxHp * 0.35
          ? "badly hurt, and that is worth knowing"
          : "carrying wounds";

    sections.push(
      "",
      "WOMMPER — the one loose in your realm. Not your man. Not your champion. Your enemy:",
      `- A ${s.playerClass} of the ${ordinal(s.level)} rank, ${wounds} (${s.currentHp} of ${s.maxHp}).`,
      `- Carries: ${s.inventory.length ? s.inventory.join(", ") : "nothing worth naming"}.`,
      `- Purse: ${s.gold} gold — taken, not earned.`,
      s.knownSpells.length ? `- Knows the workings of: ${s.knownSpells.join(", ")}.` : "",
      s.journal ? `- Where the record last had him: "${s.journal}"` : "",
      s.contacts && s.contacts.toLowerCase() !== "no one met yet."
        ? `- Known to: ${s.contacts}`
        : "- Has met no one of consequence yet.",
      s.inCombat ? "- Is IN A FIGHT at this very moment." : "",
      `- ${s.turnCount} turn${s.turnCount === 1 ? "" : "s"} walked in your realm so far.`,
    );
  }

  if (realm.guild.length > 0) {
    const deaths = realm.guild.reduce((n, m) => n + m.deaths, 0);
    sections.push(
      "",
      `${GUILD_NAME.toUpperCase()} — the travellers who ride with him, picked up along the road.`,
      "They are called that because putting them down does not appear to keep them down:",
      ...realm.guild.map((m) => {
        const bits = [`${m.deaths} death${m.deaths === 1 ? "" : "s"}`, `${m.kills} kill${m.kills === 1 ? "" : "s"}`];
        if (m.level !== undefined) bits.push(`${m.playerClass ?? "warrior"} rank ${m.level}`);
        if (m.currentHp !== undefined && m.maxHp !== undefined) bits.push(`${m.currentHp}/${m.maxHp} health`);
        if (m.location) bits.push(`at ${m.location}`);
        if (m.fallen) bits.push("currently fallen");
        return `- ${m.name}: ${bits.join(", ")}, ${m.turns} turn${m.turns === 1 ? "" : "s"} taken.`;
      }),
      deaths > 0
        ? `They have died ${deaths} time${deaths === 1 ? "" : "s"} between them and are still riding.`
        : "None of them has fallen yet, which will not last.",
    );
  }

  if (realm.events.length > 0) {
    sections.push("", "THE CHRONICLE — what has actually been done, oldest first:", ...realm.events.map(deedLine));
  } else {
    sections.push(
      "",
      "THE CHRONICLE is empty. Nothing has been written into it yet. Wommper has barely set foot in your",
      "realm and the reckoning is still ahead of both of you — say so plainly and speak of what is at hand",
      "rather than inventing a history that does not exist.",
    );
  }

  if (realm.claims.length > 0) {
    sections.push(
      "",
      "THINGS SAID ON AIR OR EXTRACTED BY A MODEL - claims, not confirmed deeds:",
      ...realm.claims.slice(0, 8).map((claim) => `- [${claim.source}; ${claim.status}] ${claim.description}`),
      "Never repeat one as fact unless the canonical chronicle above confirms it.",
    );
  }

  const openQuests = realm.quests.filter((q) => q.status === "active");
  if (openQuests.length > 0) {
    sections.push(
      "",
      "OATHS AND BOUNTIES STILL OPEN:",
      ...openQuests.map((q) => `- ${q.name}: ${q.description}${q.location ? ` (${q.location})` : ""}`),
    );
  }

  if (realm.npcs.length > 0) {
    sections.push(
      "",
      "PEOPLE THE RECORD KNOWS — where they are is fact, do not move them:",
      ...realm.npcs.map(
        (n) =>
          `- ${n.name}${n.location ? `, at ${n.location}` : ""}${n.status ? `, ${n.status}` : ""}${
            n.disposition ? `, ${n.disposition} toward Wommper` : ""
          }`,
      ),
    );
  }

  if (realm.locations.length > 0) {
    sections.push(
      "",
      "PLACES THE RECORD KNOWS:",
      ...realm.locations.map((l) => `- ${l.name}${l.description ? `: ${l.description}` : ""}`),
    );
  }

  sections.push(
    "",
    "WHAT YOU MAY AND MAY NOT DO WITH THIS:",
    "- Everything above is fact. Never contradict it, never quietly correct it, never retire a",
    "  living character or resurrect a dead one.",
    "- You may embroider: the weather, the smell of a hall, what a man's hands were doing while he",
    "  lied to you, what you thought and did not say. That is a king telling a story.",
    "- You may NOT invent a deed. No battles that are not in the chronicle, no oaths nobody swore,",
    "  no sums of money that changed hands. If the chronicle is thin, the honest answer is that the",
    "  reckoning has not come yet — and that is a better tale than a fabricated one.",
    "- NAMES ARE THE HARD RULE. You may only speak the name of someone listed above. If you need a",
    "  person who is not listed, describe them by their trade and let them stay nameless: \"a carter",
    "  out of the north\", \"the woman who keeps the ford\". A name you invent tonight becomes a lie",
    "  the record has to carry afterwards.",
  );

  // Repeat the names at the end of the prompt, closest to generation. Small
  // models can read the full chronicle and still reach for "that village"
  // because the actual map was hundreds of tokens earlier.
  sections.push("", royalMemoryIndex(realm));

  // Who owns the place is deliberately NOT stated here any more. This briefing
  // goes to everyone in the hall, and while it said "this realm is yours" in
  // the second person, the chronicler read it too -- a live court had her
  // saying "my rule" and "you think fire can fell me", arguing as the King
  // against a rider who was petitioning the King. Ownership is persona, so it
  // now lives with the personas in courtPromptFor, which knows who is speaking.

  return sections.join("\n");
}

/** Compact, high-priority map and cast list for each generated turn. */
export function royalMemoryIndex(realm: Realm): string {
  if (!realm.root) return "";
  const places = realmPlaces(realm);
  const people = Array.from(
    new Set([
      ...realm.npcs.map((npc) => npc.name),
      ...realm.guild.map((member) => member.name),
    ].filter(Boolean)),
  );
  const activeQuests = realm.quests.filter((quest) => quest.status === "active");
  const dead = realm.npcs.filter((npc) => npc.status.toLowerCase() === "dead").map((npc) => npc.name);

  return [
    "ROYAL MEMORY INDEX - names you know without hesitation:",
    `- Known places and settlements: ${places.length ? places.join(", ") : "none recorded"}.`,
    `- Known people: ${people.length ? people.join(", ") : "none recorded"}.`,
    dead.length ? `- Confirmed dead: ${dead.join(", ")}. The record may not say how.` : "- No recorded deaths in the cast list.",
    activeQuests.length
      ? `- Open matters: ${activeQuests.map((quest) => `${quest.name}${quest.location ? ` at ${quest.location}` : ""}`).join("; ")}.`
      : "- No open quest is recorded.",
    realm.stateSource !== "discord" && realm.save
      ? `- Wommper now: ${realm.save.playerClass}, rank ${realm.save.level}, ${realm.save.currentHp} of ${realm.save.maxHp} health, ${realm.save.gold} gold.`
      : realm.guild.length
        ? `- Discord party now: ${realm.guild.map((member) => `${member.name}, rank ${member.level ?? 1}, ${member.currentHp ?? "?"}/${member.maxHp ?? "?"} health`).join("; ")}.`
        : "- Current player state is unavailable.",
    places.length
      ? `Use exact names such as ${places.slice(0, 4).join(", ")} when relevant; do not flatten Brindlemark or another known place into 'the town'.`
      : "Do not invent a place to sound knowledgeable.",
    "Knowing a name does not permit inventing a deed. Separate what is recorded, what you infer, and what you plan.",
    "Never invent another place or person to make the map sound larger.",
  ].join("\n");
}

function ordinal(n: number): string {
  const names = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  return names[n] ?? `${n}th`;
}

/**
 * Places the realm actually has.
 *
 * Pulled from the locations table and from wherever deeds were done, because
 * on a young realm the chronicle knows far more geography than the locations
 * table does — the Sunken Ford and Greyditch exist because things happened
 * there, not because anyone wrote them down as places.
 *
 * A court's commercials advertise these and nothing else. An advert for a
 * town that does not exist is the same lie as a deed that never happened.
 */
export function realmPlaces(realm: Realm): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (name: string) => {
    const clean = name.replace(/\s+/g, " ").trim();
    const key = clean.toLowerCase();
    if (clean.length < 3 || clean.length > 60 || seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };

  for (const place of realm.locations) add(place.name);
  for (const event of realm.events) if (event.location) add(event.location);
  for (const quest of realm.quests) if (quest.location) add(quest.location);

  return out;
}

/** A one-line summary for the UI, so the brain is visible rather than implied. */
export function realmSummary(realm: Realm): string {
  if (!realm.root) return "Not found";

  const bits: string[] = [];
  if (realm.save) bits.push(`${realm.stateSource} · turn ${realm.save.turnCount}`);
  bits.push(`${realm.events.length} recorded deed${realm.events.length === 1 ? "" : "s"}`);
  if (realm.guild.length > 0) bits.push(`${realm.guild.length} riding with him`);

  const open = realm.quests.filter((q) => q.status === "active").length;
  if (open > 0) bits.push(`${open} open quest${open === 1 ? "" : "s"}`);

  return bits.join(" · ");
}
