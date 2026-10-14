/**
 * Engine-neutral view of King Orion's Realm.
 *
 * SQLite remains the authority. This module only normalizes that authority
 * into a stable contract for Discord-adjacent clients, Godot, and the radio.
 */

import type { StoredShow } from "../pipeline/store.ts";
import type { Realm, RealmClaim, RealmEvent } from "./realm.ts";

export const WORLD_CONTRACT = "world.v1" as const;
/**
 * Additive changes within `world.v1` bump this number; breaking changes need a new route.
 *   2  locations carry an optional `lore` object (tier, sources, access, coordinates).
 */
export const WORLD_SCHEMA_VERSION = 2;

export interface WorldSnapshot {
  contract: typeof WORLD_CONTRACT;
  schemaVersion: number;
  generatedAt: string;
  connected: boolean;
  campaign: {
    id: string;
    name: string;
    revision: number;
    updatedAt: string;
    stateSource: Realm["stateSource"];
  };
  player: {
    id: string;
    name: string;
    level: number;
    xp: number;
    hp: { current: number; max: number };
    class: string;
    gold: number;
    location: string;
    inventory: string[];
    equippedWeapon: string | null;
    equippedArmor: string | null;
    reputation: { hero: number; crime: number };
    inCombat: boolean;
  } | null;
  party: Array<{
    id: string;
    name: string;
    level: number;
    hp: { current: number; max: number };
    class: string;
    location: string;
    kills: number;
    deaths: number;
    fallen: boolean;
  }>;
  locations: Realm["locations"];
  npcs: Realm["npcs"];
  quests: Realm["quests"];
  events: Array<RealmEvent & { canonical: true }>;
  claims: Array<RealmClaim & { canonical: false }>;
  combat: {
    active: boolean;
    enemy: RealmEnemy | null;
  };
  cursors: { events: number; claims: number };
  radio: {
    online: boolean;
    latestShow: {
      id: string;
      title: string;
      topic: string;
      createdAt: string;
      duration: number;
      audioUrl: string;
      coverUrl: string;
    } | null;
  };
  problems: string[];
}

type RealmEnemy = NonNullable<NonNullable<Realm["save"]>["enemy"]>;

function stableId(name: string, index: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || `party-${index + 1}`;
}

function latestCursor(items: Array<{ id: number }>): number {
  return items.reduce((highest, item) => Math.max(highest, item.id), 0);
}

function campaignName(id: string): string {
  if (!id || id === "legacy") return "King Orion's Realm";
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function locationKey(name: string): string {
  return name.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "");
}

function normalizedLocations(locations: Realm["locations"]): Realm["locations"] {
  const merged = new Map<string, Realm["locations"][number]>();
  for (const location of locations) {
    const key = locationKey(location.name);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, location);
      continue;
    }
    merged.set(key, {
      ...existing,
      ...location,
      id: location.id || existing.id,
      name: location.name || existing.name,
      type: location.type || existing.type,
      description: location.description || existing.description,
      connectedTo: [...new Set([...existing.connectedTo, ...location.connectedTo])],
      lore: location.lore ?? existing.lore,
    });
  }
  return [...merged.values()];
}

export function eventsSince(realm: Realm, after = 0): WorldSnapshot["events"] {
  return realm.events.filter((event) => event.id > after).map((event) => ({ ...event, canonical: true }));
}

export function claimsSince(realm: Realm, after = 0): WorldSnapshot["claims"] {
  return realm.claims.filter((claim) => claim.id > after).map((claim) => ({ ...claim, canonical: false }));
}

export function createWorldSnapshot(realm: Realm, shows: StoredShow[] = []): WorldSnapshot {
  const lead = realm.guild[0];
  const latest = shows.find((show) => show.hasAudio && show.audioUrl);
  const save = realm.save;

  return {
    contract: WORLD_CONTRACT,
    schemaVersion: WORLD_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    connected: Boolean(realm.root),
    campaign: {
      id: realm.campaignId,
      name: campaignName(realm.campaignId),
      revision: realm.runtimeRevision,
      updatedAt: realm.runtimeUpdatedAt,
      stateSource: realm.stateSource,
    },
    player: save
      ? {
          id: lead?.id || stableId(lead?.name || "Wommper", 0),
          name: lead?.name || "Wommper",
          level: save.level,
          xp: save.xp,
          hp: { current: save.currentHp, max: save.maxHp },
          class: save.playerClass,
          gold: save.gold,
          location: lead?.location || "The Wildlands",
          inventory: save.inventory,
          equippedWeapon: save.equippedWeapon,
          equippedArmor: save.equippedArmor,
          reputation: { hero: save.reputationHero ?? 0, crime: save.reputationCrime ?? 0 },
          inCombat: save.inCombat,
        }
      : null,
    party: realm.guild.map((member, index) => ({
      id: member.id || stableId(member.name, index),
      name: member.name,
      level: member.level ?? 1,
      hp: { current: member.currentHp ?? 0, max: member.maxHp ?? 0 },
      class: member.playerClass ?? "unknown",
      location: member.location ?? "",
      kills: member.kills,
      deaths: member.deaths,
      fallen: member.fallen,
    })),
    locations: normalizedLocations(realm.locations),
    npcs: realm.npcs,
    quests: realm.quests,
    events: eventsSince(realm),
    claims: claimsSince(realm),
    combat: {
      active: Boolean(save?.inCombat && save.enemy),
      enemy: save?.enemy ?? null,
    },
    cursors: {
      events: latestCursor(realm.events),
      claims: latestCursor(realm.claims),
    },
    radio: {
      online: true,
      latestShow: latest
        ? {
            id: latest.id,
            title: latest.title,
            topic: latest.topic,
            createdAt: latest.createdAt,
            duration: latest.duration,
            audioUrl: latest.audioUrl!,
            coverUrl: latest.coverUrl ?? `/media/${latest.id}/cover.svg`,
          }
        : null,
    },
    problems: [...realm.problems],
  };
}
