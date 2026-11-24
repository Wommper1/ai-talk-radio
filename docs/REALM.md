# King Orion's Realm (optional)

An optional integration with a separate game project, *King Orion's Realm*. None
of this is needed to run the station; without the game installed the **Realm**
tab simply reports that nothing was found. The game's command API is specified
in [WORLD_API_V1.md](WORLD_API_V1.md), and the Godot client in `game-client/`
and the Discord bridge in `integrations/discord-sync/` belong to the same
integration.

The station can be handed over for a night. **Realm → Hand the station to
Orion** replaces the two hosts with King Orion and Maeve, his chronicler,
sitting in his hall late with the fire down. He is a guest, not a feature of
the station: he has never heard of a radio, and he says so if you push him.

**Everything he knows comes out of the game's own files, and nothing else.**

| Read from | What it gives him |
| --------- | ----------------- |
| `world.db` → `events` | The chronicle — battles, deaths, milestones, in order |
| `world.db` → `quests`, `npcs`, `locations` | Open bounties, who is where, what is named |
| `save_data.json` | Wommper's class, level, wounds, purse, pack, journal line |
| `discord_party.json` | **The Respawn Guild** — the party riding with him, and their death count |

**Wommper is the enemy.** He is loose in Orion's realm, not serving it, and every
deed in that chronicle is something done *to* the realm. The Guild are the
travellers he picks up along the road — so named because putting them down does
not keep them down. Framed the other way round the King reads his own enemy's
victories as his own achievements, which is a completely different show.

The register is dark fantasy and it is concrete: iron, debt, weather, roads that
are not safe after dark. He is explicitly forbidden from philosophising about
fate, luck, puppets or who is pulling whose strings — left to itself the model
drifts into exactly that, and a king wondering whether he is real is not a king.

A court opens on its own imaging: a low drone, two struck bells and a herald —
*"The hall is closed. King Orion sits."* No band, no record, no commercials.
The bells are synthesised from genuinely inharmonic partials, which is why they
ring instead of singing.

While he is on, the station's own memory is cut off entirely — no past
episodes, no phone book, no running gags, no research, and no commercials. A
tyre advert in the middle of a king's hall is one joke, told once.

The **Realm** tab shows all of it: the save, the chronicle, the bounties, and —
behind *See his briefing* — the exact text he is handed, so it can be read
rather than taken on trust.

## He may embroider; he may not invent

The weather, the smell of a hall, what a man's hands were doing while he lied
to you — all fair. A deed is not. No battles that are not in the chronicle, no
oaths nobody swore, no sums of money that changed hands.

Names are the hard rule, and it exists because of what happened without it: on
an empty chronicle the model invented a "Thorold" who had paid a hundred gold
for Wommper's silence, which is exactly the kind of thing that ends up treated
as fact later. He may now only speak a name that is already in the record. If
he needs someone else, they stay nameless — *"a carter out of the north"*.

## It goes back into the game

With **Write the court back into the game** on, each broadcast adds **one** row
to the same `events` table the game logs its own deeds into, through the same
columns `world_db.log_event()` uses, with `is_embedded = 0` so the game's own
vector pipeline indexes it exactly as it would a deed done in play. Start the
game afterwards and Orion's narrator already knows the court was held.

One row per broadcast, deliberately — this is writing into somebody else's
save, and forty rows of chat would drown the deeds that were actually done.
Every write reports the event ids it added, and they can be taken straight back
out again.

Nothing else in the game is touched. No file inside it is written, no schema is
altered, no table is created, and nothing is imported from it. The chronicle is
opened read-only for the show and only opened for writing for the length of one
insert. Delete the two files in `server/orion/` and the game would not notice.

> Everything above was verified against a **copy** of the save before the real
> one was ever opened for writing, and the real `world.db` was checksummed
> before and after to prove it.
