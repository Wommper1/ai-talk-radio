/**
 * King Orion's Realm, on screen.
 *
 * The point of this page is that the King's knowledge is not a mystery. Every
 * word he says on air comes from the game's own files, and this shows exactly
 * what those files say — the save, the chronicle, the open bounties — plus the
 * briefing he is actually handed, verbatim, so it can be read rather than
 * taken on trust.
 *
 * Read-only, except for the two switches at the top and the ability to take a
 * broadcast back out of the game's chronicle.
 */

import { useCallback, useEffect, useState } from "react";
import { Crown, RefreshCw, ScrollText } from "lucide-react";
import type { Config, Realm as RealmData, Voice } from "../types";
import { api } from "../lib/api";
import { Button, Callout, Field, Input, Panel, Select, Slider, Textarea, Toggle } from "./ui";

interface Props {
  config: Config;
  onChange: (config: Config) => void;
  running: boolean;
  /** Starts a court and hands over to the Studio, where the broadcast plays. */
  onHoldCourt: (topic: string) => void;
  onCancel: () => void;
}

export function Realm({ config, onChange, running, onHoldCourt, onCancel }: Props) {
  const [realm, setRealm] = useState<RealmData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showBriefing, setShowBriefing] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);

  const orion = config.orion;

  /**
   * Written to disk as well as to state.
   *
   * Format and Length are per-show knobs that live in memory until Settings is
   * saved. Handing the station to Orion is not that — it is a mode, and having
   * to set it again after every reload would be its own small annoyance.
   */
  const update = (patch: Partial<Config["orion"]>) => {
    const next = { ...config, orion: { ...config.orion, ...patch } };
    onChange(next);
    void api.saveConfig(next).catch(() => {
      // The run still honours it; only the memory of it is lost.
    });
  };

  const refresh = useCallback(() => {
    setLoading(true);
    api
      .getRealm()
      .then(setRealm)
      .catch(() => setRealm(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  // The voice list comes from the speech engine, the same call Settings makes.
  useEffect(() => {
    api
      .checkTts(config)
      .then((r) => setVoices(r.voices ?? []))
      .catch(() => setVoices([]));
    // Deliberately once per engine change, not on every config edit — this is
    // a network call to the speech engine, not a cheap read.
  }, [config.tts.engine]);

  /**
   * Take one court back out of the game's chronicle.
   *
   * The panel above promises this can be undone, so it has to actually be
   * here — writing into somebody else's save is only fair if it is reversible
   * from the same screen that offered it.
   */
  const removeCourt = async (id: number) => {
    setRemoving(id);
    try {
      await api.forgetChronicle([id]);
      refresh();
    } catch {
      // The chronicle is the source of truth; a failed removal shows up as the
      // row simply still being there after the reread.
    } finally {
      setRemoving(null);
    }
  };

  const save = realm?.save;
  const openQuests = (realm?.quests ?? []).filter((q) => q.status === "active");

  return (
    <div className="mx-auto grid max-w-7xl gap-5 px-5 py-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      {/* ── The switches ─────────────────────────────────────── */}
      <div className="space-y-5">
        <Panel
          title="King Orion's Realm"
          subtitle="A guest broadcast. The King holds court over the deeds of his realm, and knows nothing else."
          right={
            <Button size="sm" variant="ghost" onClick={refresh}>
              <RefreshCw size={13} />
              Reread
            </Button>
          }
        >
          <div className="space-y-4">
            <Toggle
              label="Hand the station to Orion"
              hint="The two hosts, the station's memory, the phone book and the commercials all step aside. What is left is a hall, a fire, and a king being asked questions by his chronicler."
              checked={orion.enabled}
              onChange={(enabled) => update({ enabled })}
            />

            {orion.enabled && (
              <>
                <Field
                  label="The realm folder"
                  hint="The game's own folder — the one with world.db in it. Left empty, the usual place is tried."
                >
                  <Input
                    value={orion.realmPath}
                    onChange={(e) => update({ realmPath: e.target.value })}
                    placeholder="C:\\Wommper1\\AlexAIHub\\projects\\king_orions_realm"
                    spellCheck={false}
                  />
                </Field>

                <Toggle
                  label="Write the court back into the game"
                  hint="Save noteworthy broadcast lines as unverified claims for review. They never become game facts automatically, and radio-created claims can be removed below."
                  checked={orion.writeBack}
                  onChange={(writeBack) => update({ writeBack })}
                />

                <Toggle
                  label="Let the Guild speak at court"
                  hint="Brings one rider from your Discord party into the hall to answer for themselves, and the King replies. Switch it off and the night is his and his chronicler's alone. This has nothing to do with memory — the character sheet and the chronicle are written either way."
                  checked={orion.guildVoices}
                  onChange={(guildVoices) => update({ guildVoices })}
                />

                <Slider
                  label="How freely he speaks"
                  value={orion.temperature}
                  min={0.6}
                  max={1.4}
                  step={0.05}
                  onChange={(temperature) => update({ temperature })}
                  format={(v) => v.toFixed(2)}
                  hint="Separate from the radio hosts. A roleplay-tuned model is built to run hot and sounds like a careful assistant when it is not allowed to; an instruct model wants less. Around 1.05 for Stheno or Lunaris, 0.85 for a plain instruct model."
                />

                <Slider
                  label="How much chronicle he is given"
                  value={orion.recallEvents}
                  min={0}
                  max={80}
                  step={4}
                  onChange={(recallEvents) => update({ recallEvents })}
                  format={(v) => (v === 0 ? "none" : `${v} deeds`)}
                  hint="The whole chronicle is rarely wanted — a long one crowds out the turn being written."
                />
              </>
            )}
          </div>
        </Panel>

        {orion.enabled && (
          <HoldCourt
            realm={realm}
            running={running}
            onHoldCourt={onHoldCourt}
            onCancel={onCancel}
            config={config}
            onChange={onChange}
          />
        )}

        {orion.enabled && (
          <Panel
            title="The history"
            subtitle="What the realm is, as opposed to what has been done in it. He speaks from this as fact."
          >
            <Textarea
              rows={10}
              value={orion.lore}
              onChange={(e) => update({ lore: e.target.value })}
              spellCheck={false}
              className="font-serif text-[13px] leading-relaxed"
            />
            <p className="mt-2 text-xs leading-relaxed text-[var(--color-mute)]">
              The game's chronicle records deeds and nothing about what came before them. Without a past
              he has only the ledger, which is most of why he reaches for philosophy — there is nothing
              else to reach for.
            </p>
          </Panel>
        )}

        {orion.enabled && (
          <CourtSettings config={config} onChange={onChange} running={running} voices={voices} />
        )}

        {orion.enabled && save && realm?.stateSource !== "discord" && (
          <Panel title="Wommper" subtitle="Who walks the realm, straight out of the save file.">
            <dl className="space-y-2 text-xs">
              <Row label="Class" value={`${save.playerClass} · level ${save.level}`} />
              <Row label="Health" value={`${save.currentHp} of ${save.maxHp}`} />
              <Row label="Purse" value={`${save.gold} gold`} />
              <Row label="Carrying" value={save.inventory.length ? save.inventory.join(", ") : "nothing"} />
              {save.knownSpells.length > 0 && <Row label="Spells" value={save.knownSpells.join(", ")} />}
              <Row label="Turns" value={String(save.turnCount)} />
              {save.inCombat && <Row label="Status" value="In a fight right now" />}
            </dl>

            {save.journal && (
              <p className="mt-3 border-t border-[var(--color-line)] pt-3 font-serif text-sm italic leading-relaxed text-[var(--color-dim)]">
                “{save.journal}”
              </p>
            )}
          </Panel>
        )}
      </div>

      {/* ── The brain ────────────────────────────────────────── */}
      <div className="space-y-5">
        {!orion.enabled ? (
          <Panel title="The brain">
            <Callout tone="info">
              Orion is switched off. The station runs its own show, and the realm is left alone entirely —
              nothing is read from the game and nothing is written to it.
            </Callout>
          </Panel>
        ) : loading ? (
          <Panel title="The brain">
            <p className="text-sm text-[var(--color-mute)]">Reading the realm…</p>
          </Panel>
        ) : !realm?.found ? (
          <Panel title="The brain">
            <Callout tone="error">
              {realm?.problems?.[0] ?? "The realm was not found. Point the folder at the game above."}
            </Callout>
          </Panel>
        ) : (
          <>
            <Panel
              title="The chronicle"
              subtitle={`${realm.summary} · read from ${realm.root}`}
              right={
                <button
                  type="button"
                  onClick={() => setShowBriefing((v) => !v)}
                  className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-mute)] transition-colors hover:text-white"
                >
                  {showBriefing ? "Hide his briefing" : "See his briefing"}
                </button>
              }
            >
              {showBriefing && (
                <pre className="mb-4 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3.5 font-mono text-[11px] leading-relaxed text-[var(--color-dim)]">
                  {realm.briefing}
                </pre>
              )}

              {realm.events.length === 0 ? (
                <Callout tone="info">
                  The chronicle is empty — nothing has been recorded in the realm yet. He will say so
                  rather than invent a history, and the first court will be about what is still ahead.
                </Callout>
              ) : (
                <ol className="space-y-2.5">
                  {realm.events.map((event) => {
                    // A court is the one kind of deed this app wrote. Everything
                    // else was done in the game and is not ours to remove.
                    const isCourt = event.type === "court";

                    return (
                      <li key={event.id} className="flex gap-3">
                        <span
                          className={`mt-0.5 shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] ${
                            isCourt ? "text-[var(--color-cyan)]" : "text-[var(--color-amber)]"
                          }`}
                          title={`importance ${event.importance}`}
                        >
                          {event.type || "deed"}
                        </span>
                        <span className="min-w-0">
                          <p className="font-serif text-[15px] leading-relaxed text-[#c9c9d4]">
                            {event.description}
                          </p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 font-mono text-[10px] text-[var(--color-mute)]">
                            {[event.location, event.participants.join(", ")].filter(Boolean).join(" · ")}
                            {isCourt && (
                              <button
                                type="button"
                                disabled={removing === event.id}
                                onClick={() => void removeCourt(event.id)}
                                className="uppercase tracking-[0.14em] underline underline-offset-2 transition-colors hover:text-[var(--color-live)] disabled:opacity-40"
                              >
                                {removing === event.id ? "Removing…" : "Take this back out"}
                              </button>
                            )}
                          </p>
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </Panel>

            {realm.claims.length > 0 && (
              <Panel title="Claims and broadcasts" subtitle="Remembered as things said, never as confirmed deeds.">
                <ul className="space-y-3">
                  {realm.claims.map((claim) => (
                    <li key={claim.id} className="flex items-start justify-between gap-3">
                      <span className="font-serif text-[15px] leading-relaxed text-[#c9c9d4]">
                        {claim.description}
                      </span>
                      {claim.source === "radio" && (
                        <button
                          type="button"
                          disabled={removing === claim.id}
                          onClick={() => void removeCourt(claim.id)}
                          className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-mute)] underline underline-offset-2 hover:text-[var(--color-live)] disabled:opacity-40"
                        >
                          {removing === claim.id ? "Removing…" : "Take back"}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            {openQuests.length > 0 && (
              <Panel title="Open bounties" subtitle="Sworn and unfinished, from the game's quest log.">
                <ul className="space-y-3">
                  {openQuests.map((q) => (
                    <li key={q.id}>
                      <div className="flex items-baseline gap-2">
                        <ScrollText size={12} className="shrink-0 text-[var(--color-amber)]" />
                        <span className="font-serif text-[15px] text-[#e8e8ee]">{q.name}</span>
                      </div>
                      <p className="mt-1 pl-5 text-sm leading-relaxed text-[var(--color-dim)]">
                        {q.description}
                      </p>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            {realm.guild.length > 0 && (
              <Panel
                title="The Respawn Guild"
                subtitle={`The active Discord campaign${realm.campaignId ? ` · ${realm.campaignId.slice(0, 8)}` : ""}.`}
              >
                <ul className="space-y-2 text-sm">
                  {realm.guild.map((m) => (
                    <li key={m.name} className="flex items-baseline justify-between gap-3">
                      <span className="text-[#e8e8ee]">
                        {m.name}
                        {m.fallen && <span className="ml-2 text-xs text-[var(--color-live)]">fallen</span>}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-[var(--color-mute)]">
                        {m.level !== undefined && `${m.playerClass ?? "warrior"} ${m.level} · ${m.currentHp}/${m.maxHp} HP · `}
                        {m.deaths} death{m.deaths === 1 ? "" : "s"} · {m.kills} kill{m.kills === 1 ? "" : "s"} ·{" "}
                        {m.turns} turn{m.turns === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            {realm.npcs.length > 0 && (
              <Panel title="Known to the record" subtitle="Where they are is fact; the King may not move them.">
                <ul className="space-y-1.5 text-sm text-[var(--color-dim)]">
                  {realm.npcs.map((n) => (
                    <li key={n.id}>
                      <span className="text-[#e8e8ee]">{n.name}</span>
                      {n.location && <span className="text-[var(--color-mute)]"> — at {n.location}</span>}
                      {n.status && <span className="text-[var(--color-mute)]">, {n.status}</span>}
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            <Panel title="How this works">
              <div className="space-y-2.5 text-sm leading-relaxed text-[var(--color-dim)]">
                <p>
                  <Crown size={12} className="mr-1.5 inline text-[var(--color-amber)]" />
                  Everything above is read straight out of the game — <code className="font-mono text-xs">world.db</code>{" "}
                  and <code className="font-mono text-xs">save_data.json</code> — and it is the entire world the
                  King is allowed to know. The station's own memory, its past episodes and its phone book are
                  cut off while he is on.
                </p>
                <p>
                  He may embroider the weather and what a man's hands were doing while he lied. He may not
                  invent a deed: no battles that are not in the chronicle, no names that are not in the record.
                </p>
                <p>
                  With writing back on, each broadcast adds <strong>one</strong> line to that same chronicle,
                  through the same door the game's own code uses. Play the game afterwards and its narrator
                  already knows the court was held.
                </p>
              </div>
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 uppercase tracking-[0.12em] text-[var(--color-mute)]">{label}</dt>
      <dd className="min-w-0 break-words text-[var(--color-dim)]">{value}</dd>
    </div>
  );
}

/**
 * What to hold court about.
 *
 * Drawn from the realm rather than typed from nothing. An open bounty, a deed
 * already in the chronicle, the line in the journal — these are the subjects
 * he can actually speak to, and picking one is the difference between a court
 * that cites the record and a court that strains to fill a silence.
 */
function courtSubjects(realm: RealmData | null): string[] {
  if (!realm?.found) return [];

  const subjects: string[] = [];

  for (const quest of realm.quests) {
    if (quest.status === "active" && quest.description) subjects.push(quest.description);
  }

  // Newest deeds first — the fresh wound is the better subject.
  for (const event of [...realm.events].reverse()) {
    if (event.description) subjects.push(event.description);
  }

  if (realm.save?.journal) subjects.push(realm.save.journal);

  // Trimmed to something that reads as a subject rather than a paragraph, and
  // deduplicated, because a bounty and the deed that started it often overlap.
  const seen = new Set<string>();
  return subjects
    .map((s) => s.replace(/\s+/g, " ").trim().replace(/[.]$/, ""))
    .filter((s) => {
      const key = s.toLowerCase();
      if (s.length < 12 || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

/** The topic box and the way in, for when the King is the one on tonight. */
function HoldCourt({
  realm,
  running,
  onHoldCourt,
  onCancel,
  config,
  onChange,
}: {
  realm: RealmData | null;
  running: boolean;
  onHoldCourt: (topic: string) => void;
  onCancel: () => void;
  config: Config;
  onChange: (config: Config) => void;
}) {
  const [topic, setTopic] = useState("");
  const subjects = courtSubjects(realm);

  const start = (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || running) return;
    onHoldCourt(topic.trim());
  };

  return (
    <Panel
      title="Hold court"
      subtitle="What is on his mind tonight. The broadcast opens in the Studio, where you can watch it."
    >
      <form onSubmit={start} className="space-y-3">
        <Textarea
          rows={2}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="the oath sworn over the Sunken Ford"
          disabled={running}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start(e);
          }}
        />

        {subjects.length > 0 && (
          <div className="space-y-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-mute)]">
              From the record
            </span>
            <div className="flex flex-col gap-1">
              {subjects.map((subject) => (
                <button
                  key={subject}
                  type="button"
                  disabled={running}
                  onClick={() => setTopic(subject)}
                  className="truncate text-left text-xs text-[var(--color-dim)] underline decoration-[var(--color-line-bright)] underline-offset-2 transition-colors hover:text-white disabled:opacity-40"
                  title={subject}
                >
                  {subject}
                </button>
              ))}
            </div>
          </div>
        )}

        <Field
          label="How long he holds it"
          hint={`${config.show.turns} turns — roughly ${Math.max(1, Math.round((config.show.turns * config.hosts[0].maxWords) / 155))} minutes of court.`}
        >
          <div className="flex items-center gap-3">
            <input
              type="range"
              className="w-full cursor-pointer"
              min={2}
              max={60}
              step={2}
              value={Math.min(60, config.show.turns)}
              aria-label="Turns"
              disabled={running}
              onChange={(e) =>
                onChange({ ...config, show: { ...config.show, turns: Number(e.target.value) } })
              }
            />
            <Input
              type="number"
              min={2}
              max={600}
              step={2}
              value={config.show.turns}
              aria-label="Turns"
              disabled={running}
              className="w-[4.5rem] shrink-0 px-2 text-center font-mono tabular-nums"
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n > 0) {
                  onChange({
                    ...config,
                    show: { ...config.show, turns: Math.max(2, Math.min(600, Math.round(n))) },
                  });
                }
              }}
            />
          </div>
        </Field>

        {running ? (
          <Button type="button" variant="danger" className="w-full" onClick={onCancel}>
            Stop
          </Button>
        ) : (
          <Button type="submit" variant="primary" className="w-full" disabled={!topic.trim() || !realm?.found}>
            <Crown size={15} />
            Hold court
          </Button>
        )}

        {/*
          A greyed-out button that will not say why is indistinguishable from a
          broken one — it was reported as "it keeps crashing, won't even let me
          start it" when the only thing wrong was an empty subject box. The
          realm-not-found case already explained itself; this is the other half.
        */}
        {!running && realm?.found && !topic.trim() && (
          <p className="text-xs leading-relaxed text-[var(--color-mute)]">
            Give him something to hold court about first — the box above.
          </p>
        )}

        {!realm?.found && (
          <p className="text-xs leading-relaxed text-[var(--color-mute)]">
            The realm has to be found first — there is nothing for him to speak from.
          </p>
        )}
      </form>
    </Panel>
  );
}

/**
 * The rest of the desk, moved into the hall.
 *
 * A court is a show and needs everything a show needs — music, a record to
 * open on, voices, a commercial load. Leaving those in the Studio meant
 * running one required two screens and knowing which of the Studio's controls
 * still applied, which is a poor way to hand somebody a feature.
 */
function CourtSettings({
  config,
  onChange,
  running,
  voices,
}: {
  config: Config;
  onChange: (config: Config) => void;
  running: boolean;
  voices: Voice[];
}) {
  const [songs, setSongs] = useState<Array<{ name: string }>>([]);
  const orion = config.orion;
  const song = config.show.openingSong;
  const engine = config.tts.engine;

  useEffect(() => {
    api
      .songFiles()
      .then((r) => setSongs(r.files))
      .catch(() => setSongs([]));
  }, []);

  const setShow = (patch: Partial<Config["show"]>) =>
    onChange({ ...config, show: { ...config.show, ...patch } });
  const setSong = (patch: Partial<Config["show"]["openingSong"]>) =>
    setShow({ openingSong: { ...song, ...patch } });
  const setAds = (patch: Partial<Config["ads"]>) => onChange({ ...config, ads: { ...config.ads, ...patch } });

  const setSpeaker = (who: "king" | "chronicler", patch: Partial<Config["orion"]["king"]>) =>
    onChange({ ...config, orion: { ...orion, [who]: { ...orion[who], ...patch } } });

  return (
    <>
      <Panel title="The hall" subtitle="Music, the record, and how the night is dressed.">
        <div className="space-y-4">
          <Field label="Music under the court" hint="The bed beneath the voices. Not the entrance — that is always bells.">
            <Select
              value={config.show.mood}
              onChange={(e) => setShow({ mood: e.target.value })}
              disabled={running}
            >
              {MOOD_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>

          <Toggle
            label="Open on a record"
            hint="The herald names the piece, it plays, and the King speaks when it is done. Four minutes of music is four minutes the model spends writing — it is the single biggest thing you can do about waiting."
            checked={song.enabled}
            onChange={(enabled) => setSong({ enabled })}
          />

          {song.enabled && (
            <>
              <Field label="The record" hint="Anything in the music folder.">
                <Select value={song.file} onChange={(e) => setSong({ file: e.target.value })} disabled={running}>
                  <option value="">Choose a file…</option>
                  {songs.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Title" hint="Left empty, the filename is used.">
                  <Input
                    value={song.title}
                    onChange={(e) => setSong({ title: e.target.value })}
                    placeholder="From the filename"
                    disabled={running}
                  />
                </Field>
                <Field label="Artist" hint="What the herald names it by.">
                  <Input
                    value={song.artist}
                    onChange={(e) => setSong({ artist: e.target.value })}
                    placeholder="Left out when empty"
                    disabled={running}
                  />
                </Field>
              </div>

              <Slider
                label="Record level"
                value={song.volume}
                min={0}
                max={1}
                step={0.05}
                onChange={(volume) => setSong({ volume })}
                format={(v) => `${Math.round(v * 100)}%`}
              />
            </>
          )}

          <Slider
            label="Pause between turns"
            value={config.show.gapSeconds}
            min={0}
            max={2}
            step={0.05}
            onChange={(gapSeconds) => setShow({ gapSeconds })}
            format={(v) => `${v.toFixed(2)}s`}
            hint="A hall breathes more slowly than a studio."
          />
        </div>
      </Panel>

      <Panel title="Direction" subtitle="How the night is run. Everything the Studio has, for a hall.">
        <div className="space-y-4">
          <Field label="Shape" hint="The court has its own beats — an opening, a dig, a story, a landing — but the shape of the middle still follows this.">
            <Select
              value={config.show.style}
              onChange={(e) => setShow({ style: e.target.value as Config["show"]["style"] })}
              disabled={running}
            >
              <option value="deepdive">Deep dive — work it out together</option>
              <option value="debate">Debate — they press each other</option>
              <option value="interview">Interview — she asks, he answers at length</option>
              <option value="roundtable">Roundtable — let it wander</option>
              <option value="banter">Banter — fast and loose</option>
              <option value="explainer">Explainer — one explains, one keeps them honest</option>
              <option value="coldopen">Cold open — straight into it, no preamble</option>
            </Select>
          </Field>

          <Field
            label="A note to the King"
            hint="Direction he is given every turn, in your words. A mood, a grudge, something he has decided before tonight."
          >
            <Textarea
              rows={3}
              value={config.show.directorNotes}
              onChange={(e) => setShow({ directorNotes: e.target.value })}
              placeholder="He has not slept. Someone has been stealing from the granaries and he already knows who."
              disabled={running}
            />
          </Field>

          <Toggle
            label="Give it a running order"
            hint="Tells each turn what it is for — open, dig in, tell it, land it — instead of letting the night wander. It is also what schedules the breaks."
            checked={config.show.useRunSheet}
            onChange={(useRunSheet) => setShow({ useRunSheet })}
          />

          <Toggle
            label="Open on the bells"
            hint="The herald and the summons, before a word is written. It exists to cover the wait as much as to set the scene."
            checked={config.show.useColdOpen}
            onChange={(useColdOpen) => setShow({ useColdOpen })}
          />

          <Toggle
            label="Music under the gaps"
            hint="Keeps the bed running through the pauses while the next line is written. Silence reads as broken; a room reads as a room."
            checked={config.show.liveBed}
            onChange={(liveBed) => setShow({ liveBed })}
          />

          <Toggle
            label="Speak each line as it is written"
            hint="Hear the court as it happens rather than waiting for the finished recording."
            checked={config.show.speakWhileWriting}
            onChange={(speakWhileWriting) => setShow({ speakWhileWriting })}
          />

          <Toggle
            label="Plan the night first"
            hint="Sketches the beats before anyone speaks. Another round trip, and on a small model it often comes back empty."
            checked={config.show.useOutline}
            onChange={(useOutline) => setShow({ useOutline })}
          />

          <Toggle
            label="Find the angle first"
            hint="A planning pass before anyone speaks. Costs a round trip and, on a small model, often comes back empty — worth trying, not worth relying on."
            checked={config.show.useProducer}
            onChange={(useProducer) => setShow({ useProducer })}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Slider
              label="Music level"
              value={config.show.musicVolume}
              min={0}
              max={1}
              step={0.02}
              onChange={(musicVolume) => setShow({ musicVolume })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <Slider
              label="Duck under speech"
              value={config.show.duckDepth}
              min={0}
              max={1}
              step={0.02}
              onChange={(duckDepth) => setShow({ duckDepth })}
              format={(v) => `${Math.round(v * 100)}%`}
              hint="How far the bed drops when someone speaks."
            />
          </div>

          <Slider
            label="Let it ring out"
            value={config.show.outroSeconds}
            min={0}
            max={30}
            step={1}
            onChange={(outroSeconds) => setShow({ outroSeconds })}
            format={(v) => `${v}s`}
            hint="How long the hall holds after the last word."
          />
        </div>
      </Panel>

      <Panel title="The voices" subtitle="Who speaks, and how.">
        <div className="space-y-4">
          {(["king", "chronicler"] as const).map((who) => {
            const speaker = orion[who];
            return (
              <div key={who} className="space-y-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3">
                <Field label={who === "king" ? "The King" : "The chronicler"}>
                  <Input
                    value={speaker.name}
                    onChange={(e) => setSpeaker(who, { name: e.target.value })}
                    disabled={running}
                    maxLength={40}
                  />
                </Field>

                <Field label="Voice">
                  <Select
                    value={speaker.voices[engine] ?? ""}
                    onChange={(e) =>
                      setSpeaker(who, { voices: { ...speaker.voices, [engine]: e.target.value } })
                    }
                    disabled={running || voices.length === 0}
                  >
                    {voices.length === 0 && <option value="">No voices loaded — open Settings once</option>}
                    {voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                        {v.detail ? ` · ${v.detail}` : ""}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Slider
                  label="Pace"
                  value={speaker.rate}
                  min={-6}
                  max={4}
                  step={1}
                  onChange={(rate) => setSpeaker(who, { rate })}
                  format={(v) => (v === 0 ? "as written" : v < 0 ? `${Math.abs(v)} slower` : `${v} faster`)}
                  hint={who === "king" ? "A king is not in a hurry. Two or three slower suits him." : undefined}
                />
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel
        title="The criers at the gate"
        subtitle="Commercials, but for a realm at war — and the reason a court can keep up with itself."
      >
        <div className="space-y-4">
          <Toggle
            label="Take breaks"
            hint="A break is written and recorded while the King is still talking, so playing one hands the model most of a minute of head start. That is what they are for."
            checked={config.ads.enabled}
            onChange={(enabled) => setAds({ enabled })}
          />

          {config.ads.enabled && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Slider
                  label="Breaks"
                  value={config.ads.breaks}
                  min={0}
                  max={12}
                  step={1}
                  onChange={(breaks) => setAds({ breaks })}
                  format={(v) => (v === 0 ? "none" : String(v))}
                />
                <Slider
                  label="Cries per break"
                  value={config.ads.spotsPerBreak}
                  min={1}
                  max={4}
                  step={1}
                  onChange={(spotsPerBreak) => setAds({ spotsPerBreak })}
                />
              </div>

              <Callout tone="info">
                The King never plays an old one. Every cry is written fresh, by traders who exist in his realm
                and advertise places the record actually has. They are still kept on the shelf afterwards — the
                station can play them, he will not.
              </Callout>
            </>
          )}
        </div>
      </Panel>
    </>
  );
}

/** The moods, matching the server's own list. */
const MOOD_OPTIONS = [
  { id: "noir", label: "Noir — dark, cinematic, brooding" },
  { id: "latenight", label: "Late Night — smoky minor keys, sparse" },
  { id: "chill", label: "Chill — warm, slow, unhurried" },
  { id: "tech", label: "Tech — bright synth pad" },
  { id: "news", label: "Newsroom — tense, driving" },
  { id: "upbeat", label: "Upbeat — major key, lively" },
  { id: "rock", label: "Rock — live drums, bass, dirty guitar" },
  { id: "none", label: "No music" },
];
