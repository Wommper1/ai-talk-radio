# Local Talk Radio

Two AI hosts talk to each other, live, and the result is mixed into a radio show
with voices, music and a timecoded transcript.

The language model, production pipeline, shows and station memory run on your
machine. Piper speech is fully local; the higher-quality Edge neural voices use
Microsoft's online speech service but still save every result only on this PC.

---

## Quick start

Double-click **Local Talk Radio** on the Desktop. That starts the server, waits
for it, and opens the browser. Closing that window stops the app.

To create the desktop shortcut for this checkout:

```bash
npm run shortcut
```

From a terminal instead:

```bash
npm install
```

Start your model server (LM Studio: Developer tab → load a model → Start Server),
then check everything is wired up:

```bash
npm run doctor
```

For the most natural DJ voices, install the station's private Edge voice client
once (it does not alter your system Python):

```bash
npm run setup-edge-tts
npm run ttstest -- edge
```

The two WAVs in `output/ttstest/` use the same close-mic EQ, gentle broadcast
compression and limiter as a live show. The bundled Piper voices remain the
offline fallback. On a 6 GB GPU, keep speech on Edge or Piper so all VRAM stays
available to the DJ model.

Then run the app:

```bash
npm run dev
```

Open <http://localhost:3000>, go to **Settings**, press **Refresh** next to the
model list, pick your model, and hit **Save**. Back in the **Studio**, type a
topic and press **Start the show**.

---

## How it works

The two hosts are separate agents. Each has its own system prompt, model and
temperature, and they take turns replying to each other — from each host's point
of view, its own lines are `assistant` and the other host's are `user`. So the
model is genuinely holding up one side of a conversation, rather than being asked
to write a script of two people talking.

```
topic
  │
  ├─ research      (optional)  fetch URLs / Hacker News, summarise locally
  ├─ outline       (optional)  ask the model for a beat sheet
  ├─ conversation              host A ⇄ host B, one call per turn, streamed live
  │                            each finished line is spoken immediately and
  │                            plays in the browser while the next is written
  ├─ notes                     title and summary from the finished transcript
  └─ production               reuse the spoken clips → mix under music
                              → shows/<id>/
```

Timecodes come from the real length of each synthesised clip, not from a model's
guess, so the transcript always lines up with playback.

The performance profiles are operational presets rather than labels: **Fast
Live** minimizes model calls, **Balanced** keeps memory and notes, and
**Produced** enables the planning chain. Editing a controlled switch changes
the label to **Custom**, so the screen always describes what will really run.
Finished episodes are preflighted against a 30-minute safe mix limit before the
model starts. On the target 32 GB system, stereo, imaging and the selected music
bed remain enabled for that entire duration.

Before **Start Show** commits the station to a production, the ready-for-air
gate checks LM Studio, every selected model, speech, disk headroom, the running
order, commercial inventory, and saved-file health. The **Operations** tab
shows the same checks and separates blockers from recommendations.

If the app or server stops mid-show, every completed line is checkpointed.
**Interrupted broadcasts → Resume** continues with those lines as conversation
context rather than merely filing an incomplete transcript. Valid voice clips
already rendered for those lines are reused, and a failed voice line is retried
by itself rather than discarding the whole program.

**You hear the show as it is written.** A line is spoken about two to three
seconds after it appears, and the line currently playing is highlighted, so
reading and listening stay together instead of watching text for minutes and
then getting a file. The same clips are reused for the final mix, so nothing is
synthesised twice and the finished show is unchanged. Mute it with the speaker
icon, or turn it off entirely under **Direction → Speak each line as it is
written**.

Every finished mix is mastered toward **-16 LUFS-I** with a **-1 dBTP** true-
peak ceiling. The saved measurements appear in the player, so an operator can
see whether a show is ready for streaming without guessing from a waveform.

---

## Getting on air yourself

While a show is running, a **Call in** panel appears in the Studio. Type a name
and what you want to say; you join at the next gap between turns, in your own
voice on a phone line, and whoever speaks next answers you directly and by name.
Callers sit centred in the stereo field, between the two hosts.

---

## Deep dives on your own documents

Paste a document (or load a text file) into **Source material** in the Studio and
set the format to **Deep dive**. A producer pass reads it first and pulls out:

- **the hook** — the single most surprising thing in it
- **concepts** — what the listener must come away with
- **aha moments** — points a host can genuinely react to on air
- **analogies** — everyday comparisons for the hard parts
- **audience** — who this matters to

The hosts then perform that brief rather than reciting the document. Feeding a
document straight to a host gets you a summary read aloud; finding the angle
first is what makes it a show.

Long documents are read in pieces and condensed before the producer sees them —
a whole document in one prompt is slower than several small ones on a local
model, and can exceed its context entirely.

**Known limit on small models.** A document that is itself full of AI prompts or
JSON schemas will make an 8B model imitate them: it returns the *shape* of a
brief (`"hook_type": "surprising_fact"`) instead of the content. The pipeline
detects that and falls back, then runs the show unbriefed rather than failing.
Ordinary documents and plain topics work. A larger model does not have the
problem.

---

## Station imaging

Under **Settings → Station imaging**, the show gets the production furniture
that separates a recording from a broadcast:

- **Station ident** — a short signature at the top and tail, generated from
  your station name, so yours always sounds like yours
- **Transitions** — a sweep as the show moves to a new beat
- **Call cues** — a talkback blip as a caller comes on air, a sweep as they go

All synthesised, like the music beds. Stings are laid *over* the timeline
rather than inserted into it, so they overlap the dialogue the way a desk
rides them, and the transcript timings stay exactly as recorded.

Preview them all with:

```bash
npm run stingtest
```

---

## Ad breaks

**Settings → Ad breaks** gives the show commercials. A host lands the point
they are on, throws to the break, and another host welcomes the listener back
afterwards — so the break is part of the running order, not a splice.

The commercial bucket is the show's buffer. Ready spots are grouped into full
breaks first; if the bucket covers only part of tonight's log, the station uses
those and writes only the missing breaks. Copy and rendering run behind the
conversation, so a healthy bucket keeps the DJ model focused on the hosts.

| Setting              | What it does                                                      |
| -------------------- | ----------------------------------------------------------------- |
| Breaks per show      | Never in the opening pair, never against the sign-off             |
| Spots per break      | One to four                                                        |
| Who advertises       | Made-up local businesses, your own sponsors, or both              |
| Who reads them       | A separate announcer, the hosts in character, or alternating      |
| Louder than the show | The loudness jump going into the ads, in dB                       |

**Made-up sponsors need no setup at all** — the station invents small local
businesses, which is both the funniest option and the one that always works.
Add your own under **Sponsors**; a name alone is enough, and product details,
talking points and a tagline make the copy better.

> **Adding a sponsor is not enough on its own.** *Who advertises* has to be on
> **Mixed** or **My sponsors only**. Left on made-up businesses, your
> advertisers are never read — the break sounds completely normal, it just
> never mentions you. The show now says so in the log when it happens.

Each sponsor also has **How it should be read**: direction for the copywriter,
never read out. This is what separates one spot from the next — *"breathless
hard sell, no pause for breath"* against *"flat and matter-of-fact, as if none
of this were unusual"* — and it does more for a break than any amount of
talking points.

A name ending in a digit is spoken the way a person would say it, so
`Wommper1` goes out as "Wommper one" rather than being spelled or swallowed.

Copy for the whole show is written in a single model call, and every stage
falls back: structured → plain prose → a template built from the sponsor's own
details. A break always has something in it.

### The shelf

Every spot the station records is kept, produced, under `ads/library/`. The
next show plays a share of its commercial load off the shelf instead of writing
and recording it again — **Repeat from the shelf**, in Ad breaks, sets how much.

At the default forty percent, two adverts in a five-spot show are repeats and
three are new. A repeat costs one file read: no model call, no synthesis, no
mixing, which between them are essentially the whole cost of a break. It is
also just what a station does — nobody re-records a tyre advert every night.

The shelf rotates least-recently-played first, so it does not settle onto the
same two spots, and it trims itself at 120. **On the shelf** lists what is on
it, plays any of them back, and throws one away when you are sick of it. Set
the slider to zero and everything is written fresh, exactly as before.

The commercial log marks which spots in tonight's break are repeats.

### Why no two spots are the same

A sponsor booked into every break is where this app would repeat itself
fastest. The brief never changes, so the model writes one advert and hands it
back four times, and a listener notices that before they notice anything else.

Four things stop it, none of which is "turn the temperature up":

- **Fourteen formats.** Every spot is written to a named one — inventory
  blitz, testimonial, overheard, the guarantee, running out, public notice,
  wrong presenter, derailed, and so on. Each forces a different opening line, a
  different rhythm and a different length. An advertiser never gets the same
  format twice in one show, and the show spreads them so two blitzes do not
  land in the same break.
- **A rotating brief.** The second advert for the same shop leads on a
  different half of what there is to say about it.
- **A log.** `memory/ads.json` records the format each advertiser used and
  what it opened on, and the next show picks a format it has not just had. It
  is a plain JSON file; delete it and everyone starts fresh.
- **A duplicate check.** If two adverts on the same log still open with the
  same words, the second starts on its next line instead — which, since the
  model always writes more advert than it needs, is usually the better line.

> One thing deliberately **not** done: telling the model "you opened with
> these words last night, so do not use them". Quoting the words back made this
> model reproduce them exactly, twice out of two. The log is used to pick the
> format, before any copy exists.

### Getting real copy out of a small model

"Write me four adverts to this specification" is the single strongest trigger
for a Llama-family model to answer with a tool call. Given a brief shaped like
`Name — sells: X — format: Y`, Llama 3.1 8B replies with
`{"name": "write_radio_advert", "parameters": {...}}` every time, even when the
system prompt says it has no tools, and even when told not to use a curly
brace.

Two things fix it, both measured on this machine:

- The brief is **written as English sentences**, not as fields.
- The **first few words are put in its mouth** — the request ends on a partial
  assistant turn, so there is nothing to continue but prose. This is the one
  that actually works; local servers continue a trailing assistant message, and
  Gemini, which does not work that way and does not need the help, skips it.

Behind that: a plain attempt without the prefill, and behind that a template
built from the sponsor's own details, which now comes in five shapes rather
than one. A break always has something in it.

What comes back still gets cleaned before it is spoken. A sentence the token
limit cut off mid-clause is trimmed back to the last clause that finished, a
whole sentence shouted in capitals comes back down (the advertiser keeps its
capital letter; short emphasis like SAME DAY is left alone), and any sentence
where the model started talking about its own job is cut — "I will now write
the function calls in JSON format" arrived on the end of a real advert, and an
announcer would have read it out with total conviction.

### What makes it sound like a break

- The **loudness jumps**. That is the thing everyone recognises without being
  able to name it. It is set by measuring the break against the dialogue as it
  will actually sound in the mix — not by a fixed gain, which is why the dB
  setting means what it says.
- The **show's own music drops out entirely** underneath a commercial. The
  break brought its own bed.
- The voice is **brighter and harder compressed** than the conversation.
- An **impact going in, the station ident coming out**.

### Playing your own audio

Drop a `.wav` or `.mp3` into the `ads/` folder (records go in `music/` instead;
a song is not a spot, and keeping them apart stops one being scheduled as the
other) — or use **Add a file** — and
point any sponsor at it. That sponsor's spot becomes your recording, played
untouched apart from being levelled to sit with the rest of the show. Nothing
is written or synthesised for it.

Audition a whole break, with no model involved, using:

```bash
npm run adtest
```

That writes an opener, a break, a looping bed and a short demo show with the
break mixed into it, under `output/ads/`.

---

## Opening with a record

**Direction → Open with a record** puts a song at the top of the show. The
station opens, an announcer says what is coming up, throws to the record —
*"stay with us, we'll be right back, but first, here's..."* — and the record
plays.

Underneath it, the hosts' first turns are being written. A three-minute song is
three minutes in which the listener is hearing a station rather than waiting,
and by the time it ends the model is several turns ahead. Nothing about the
throw involves the model: it is built from templates and rendered in about a
second, the same way the cold open is.

Drop `.mp3` or `.wav` files into the `music/` folder, or use **Add a file**.
The title and artist are read out of the filename — `Artist - Title.mp3`, with
a leading track number ignored — and you can override either. The record goes
into the finished mix and onto the transcript timeline with the rest of the
show, and the show's own bed drops out underneath it, the way it does under a
commercial.

The switch is per show, so a deep dive can start cold and the drive-time show
can start on a record.

---

## Opening cold, and the gaps

Two settings under **Direction** exist purely because a local model takes time
to think:

- **Open with the station** plays the top of the show the moment you hit go —
  before the model has written a word. A riser, a band kicking in, two bars of
  nobody talking, then the announcer over a pulled-back groove, then a button.
  The band is synthesised here: a kick built from a pitch sweep, a snare from
  filtered noise, and power chords made by clipping a stack of sawtooths, which
  is genuinely how an amp gets that sound. None of it involves the model, so it
  is ready instantly and it hides the whole of the first turn's latency behind
  something that sounds deliberate. The throw to the record uses the same band,
  so the top of the show is one continuous piece rather than two unrelated
  stings. Six openers rotate on the station name and the topic, so it is not
  word-for-word the same show every night.

  Picking **No music** turns the band off and the opener falls back to the dry
  ident-and-bed treatment.
- **Music under the gaps** keeps a bed running through the live feed,
  including the pauses while the next line is written. Silence reads as
  broken; a bed reads as radio. The bed ducks under speech, drops out entirely
  under a commercial, and comes back up in the gaps.

Neither changes the finished file's dialogue — they change what the wait
sounds like.

---

## The pair

**Settings → The pair** has ready-made hosts. They are deliberately
asymmetric — two hosts with the same energy talk past each other, and the
contrast is what makes it a show:

| Pairing            | Who                                              |
| ------------------ | ------------------------------------------------ |
| **Drive-time DJs** | Marco works the mic; Dee punctures him           |
| Deep-dive duo      | Alex drives the story; Wren has the realisations |
| Late-night pair    | Paul is warm and curious; Rae is sceptical       |

Picking one sets names, character and angle. Your voices, models and mic
settings are left alone.

### Making them sound like DJs

A persona alone does not do it. Told only *who* they are, two models take
turns being reasonable at each other — grammatical, agreeable, and completely
unlike radio. So both hosts also carry a craft brief: not facts about the
topic, but habits of the form.

- **Play to the listener, not the room.** They are performing a conversation
  for one person alone in a car, not having one.
- **One idea per turn.** Land it and get out.
- **Be specific.** "My neighbour has a nine-stone Rottweiler on a cream sofa"
  beats "some people let their dogs up", and a small model will reach for the
  general version every time unless told not to.
- **Vary the shape.** Statement, question, story, one-liner, hand-off. Three
  turns of the same shape in a row is what a machine sounds like.
- **React, then go** — and never repeat the co-host's sentence back at them.
- A **banned list**: "that's a great point", "absolutely", "I mean", "at the
  end of the day", "here's the thing", and the rest of the tells.

Two more rules exist because of things that actually happened on air:

- **The names are law.** Recalled passages from older shows carry whatever the
  station and the hosts were called back then, and the model will copy them
  straight into tonight's opening line — one show opened "Welcome to Wommper1,
  folks" on a station of a different name, greeting a co-host who does not
  work there. The correct names now outrank anything in the notes, and recall
  is stripped of speaker labels and top-of-show furniture before it is shown.
- **Nobody is on the line until they are.** Left alone the model announces
  callers who do not exist, which promises the listener a voice that never
  arrives.

Coming out of the opening record, the first host **back-announces the track**
by name and artist, the way a DJ does. This replaces the run sheet's opening
beat rather than being added to it: told both to open the show and to come off
a record, the model does whichever it was told first and drops the other — and
what got dropped was always the track, which is the half the listener who just
heard it is waiting for.

---

## The showrunner

A flat run of turns is a conversation, not a show. **Direction → Give it a
running order** builds a run sheet and tells each turn what it is for:

```
intro → positions → clash → story → callback → turn the tables → wind down → sign off
```

The middle rotates by format, and a callback beat is never scheduled before
there is something to call back to.

Alongside it, the hosts keep **running notes** during the show: a rolling
digest, the facts established tonight, the running jokes, and the points
already argued (so nobody repeats them). One cheap model call every few turns
maintains it.

There is also an anti-filler guard: if a host opens two lines in a row with
"That's a fair point, but", it is asked again for a different way in. That
cadence is the clearest tell that a show is machine-made.

**And an anti-loop guard.** A small model that finds one good detail will
return to it every turn — the same smelly dumpster, four times in a show — so
two things stop it. Any image the show has already leaned on is listed in the
next turn's brief as something to move past, and a line reaching for something
three earlier turns already used is sent back for a different example. Words
from the topic itself and the hosts' own names are never counted: those are
*supposed* to recur.

Most of that problem was the running bits. They used to be handed to every turn
under the heading "you can call these back", which a small model reads as an
instruction rather than a memory. They are now offered only on the turn whose
job is actually a callback, and shown to every other turn as a list of things
not to say again.

---

## King Orion's Realm

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

### He may embroider; he may not invent

The weather, the smell of a hall, what a man's hands were doing while he lied
to you — all fair. A deed is not. No battles that are not in the chronicle, no
oaths nobody swore, no sums of money that changed hands.

Names are the hard rule, and it exists because of what happened without it: on
an empty chronicle the model invented a "Thorold" who had paid a hundred gold
for Wommper's silence, which is exactly the kind of thing that ends up treated
as fact later. He may now only speak a name that is already in the record. If
he needs someone else, they stay nameless — *"a carter out of the north"*.

### It goes back into the game

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

---

## Memory across shows

Past episodes are indexed so the hosts can genuinely reference them — "the
great washing-up debate from last week" — rather than inventing a history.

Two backends, under **Settings → Memory**:

| Backend      | Needs                     | Best at                                       |
| ------------ | ------------------------- | --------------------------------------------- |
| **Keywords** | nothing — the default     | Same words as last time. No model, no VRAM.    |
| Vectors      | an embedding model loaded | Same idea, different words.                    |

Keywords (BM25) is the default deliberately: on a 6 GB card an embedding model
competes for VRAM with the model actually writing the show, and over a few
dozen transcripts BM25 is genuinely competitive. Switch to vectors when the
wording of your topic differs from the wording used on air.

The index lives in `memory/index.json`, updates incrementally before each show,
and drops shows you delete. **Rebuild** re-reads everything; the search box
next to it shows you what memory actually holds.

---

### The phone book

Give a name when you call in and the station keeps it. Every named call is
written to `memory/callers.json` — who rang, what the show was about, and
roughly what they said — and the hosts are briefed on the regulars before the
next show starts. Ring in twice under the same name and they know who you are;
the host answering you is told how many times you have called and what you
said last time.

Anonymous calls are not recorded: "Caller" is not a person, and filling the
book with it would push the actual regulars out of the briefing. The Call in
panel lists the regulars and remembers the name you used last.

The hosts are separately forbidden from ever *claiming* somebody is on the
line. Left to itself a small model will announce a caller who does not exist,
which promises the listener a voice that never arrives — the one mistake a
show cannot cover for.

---

## Running on a small model

Everything above exists because an 8B model asked to hold twenty turns of
transcript in attention will drift, repeat itself and forget its own jokes.
The levers, under **Settings → Memory**:

- **Turns kept word for word** (default 6) — older turns are replaced by the
  digest, so prompt size stays flat however long the show runs. This is the
  single most useful setting for a small model.
- **Refresh notes every** (default 3 turns) — lower is sharper, but each
  refresh is one extra model call.

Three things keep it fast:

- **The system prompt never changes mid-show.** Servers cache the processed
  prefix of a prompt; a system message that changes every turn forces a full
  re-process. Everything volatile — the notes, the turn's brief — goes at the
  end, where a small model weights it most heavily anyway.
- **Note-taking runs behind the conversation, not in front of it.** Blocking on
  it stalled the writing for a whole model call every few turns.
- **Speech runs alongside the next turn being written**, rather than after it.

Turning memory off makes shows faster and noticeably dumber.

---

## Keeping them consistent

Under **Direction → Who they are to each other** is the show bible: shared
history that is injected into *both* hosts' prompts word for word, and restated
every few turns.

This exists because a fact only one host is told is a fact the show contradicts
later — two hosts set up as husband and wife would otherwise start wondering how
they knew each other halfway through. Fill it in for any show where the hosts
have a relationship:

> Alex and Lacey are married. Twelve years, two kids, one dog. They bicker like
> a couple who know exactly which buttons to press.

---

## What you can control

Everything below is in the UI, and is persisted to `config.json` in this folder.
Editing that file directly works too.

**Per host** — name, character brief, the angle they argue from, voice, mic
sound, speaking rate, words per turn, temperature, and **which model they use**.

> Giving each host a *different* model is the single most effective way to make
> them sound like two different people rather than one model doing voices.

**Per show** — station name, format (debate, interview, roundtable, banter,
explainer, cold open), length in turns, music mood, music level, how hard the
music ducks under speech, the pause between turns, and a producer's note that is
appended to both hosts' prompts.

---

## Providers

**Language model** — anything that speaks the OpenAI chat-completions API:

| Provider          | Default address                | Notes                          |
| ----------------- | ------------------------------ | ------------------------------ |
| LM Studio         | `http://127.0.0.1:1234/v1`     | Default                        |
| Ollama            | `http://127.0.0.1:11434/v1`    | Run `ollama serve` first       |
| OpenAI-compatible | `http://127.0.0.1:8080/v1`     | llama.cpp, vLLM, koboldcpp, …  |
| Gemini            | cloud                          | Off by default; needs a key    |

**Speech** — all local and free:

| Engine         | Quality | Offline | Setup                                     |
| -------------- | ------- | ------- | ----------------------------------------- |
| **Edge TTS**   | Best    | No      | `pip install edge-tts`; 322 voices — the default |
| Piper          | Good    | Yes     | Bundled in `tools/piper`; fully offline    |
| Windows (SAPI) | Basic   | Yes     | None — built into Windows                  |
| None           | —       | —       | Transcript only, no audio                  |

Your chosen voice is remembered **per engine**, so switching between them does
not lose the others.

Piper lives in `tools/`, which is not in version control. To restore it, or to
add voices:

```bash
npm run setup-piper
```

```bash
npm run setup-piper -- en_US-lessac-medium
```

Browse the full voice list at
[huggingface.co/rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices).

Edge TTS returns MP3, which is decoded by a WASM build of mpg123 that ships as
an npm dependency — there is no ffmpeg requirement anywhere in this project.

The default voices are the newer "Copilot" tier (Andrew, Emma), which are
markedly more natural than the older Guy/Jenny voices.

**The trade-off is latency.** Piper renders a line in about a quarter of the
time it takes to speak it; Edge has to make a network round trip, so lines
arrive roughly eight seconds after their text instead of three. Speech is
synthesised alongside the model writing the next turn rather than after it,
which hides most of that, but a show still takes noticeably longer end to end.
Switch back to Piper for speed or for working offline — your voices for each
engine are remembered separately.

### Picking a model

Speed matters more than raw capability here, because a show makes one model call
per turn — a 12-turn show is 13+ sequential requests. A model that fits entirely
in VRAM will finish a show in about a minute; one that spills to system RAM can
take ten.

Prefer a plain **instruct** model. Avoid reasoning models (DeepSeek-R1, gpt-oss)
— they spend time thinking before every line — and coding models, which write
stiff dialogue.

One quirk worth knowing: **Llama 3.x models answer directives with function
calls** instead of speech. The pipeline detects this and retries the turn, so
shows still come out fine, but each affected turn costs an extra request.
Qwen, Gemma and Mistral instruct models generally do not do this. `npm run
doctor` tells you if your model has the quirk.

---

## Files

The **Files** tab shows what is on disk: total size, every show, and every file
inside it. From there you can play or download any individual file, open a
show's folder in Explorer, prune a show's per-turn clips (which reclaims most of
its space while keeping the finished mix), and clear transient working files.

---

## Where things go

```
config.json          your settings
launcher/            desktop shortcut, launcher script, icon
tools/piper/         speech engine and voice models (not in git)
ads/                 your own spots — drop .wav or .mp3 in here
shows/<id>/
  show.json          metadata and timecoded transcript
  show.wav           the mixed show
  segments/          one wav per turn, plus the opener and any breaks
```

Shows are plain folders — back them up by copying, delete them by deleting.
The cover art is generated from the show id, so it is stable and needs no
image model.

---

## Commands

| Command            | What it does                                          |
| ------------------ | ----------------------------------------------------- |
| `npm run dev`      | Run the app with auto-reload                           |
| `npm run doctor`   | Check model, speech and config, and explain any issues |
| `npm run selftest` | Offline tests for the audio engine and text handling   |
| `npm run guard-selftest` | Offline tests for the request guard (Host and cross-site checks) |
| `npm run ttstest`  | Speak a line through every available engine and compare |
| `npm run ttstest -- piper` | Test just one engine                           |
| `npm run e2e -- "topic"` | Generate a show from the command line            |
| `npm run e2e-live -- "topic"` | Check lines are spoken while still being written |
| `npm run e2e-callin` | Check a listener call goes on air and gets answered |
| `npm run memory` | Rebuild the cross-show memory index from the command line |
| `npm run adtest` | Render an opener, a commercial break and a demo show, no model needed |
| `npm run setup-piper` | Download the Piper engine and voices                |
| `npm run shortcut` | Create the Desktop shortcut                            |
| `npm run typecheck`| TypeScript, no emit                                    |
| `npm run build`    | Build the frontend                                     |
| `npm run serve`    | Serve the built frontend                               |

---

## No ffmpeg needed

WAV decoding, resampling, the mic filters (the phone-in sound is a real
band-limited biquad chain), sidechain ducking, the music beds and the final mix
are all implemented in `server/audio/`. Nothing to install.

Music beds are synthesised from a chord progression per mood and seeded from the
show id, so a given show always sounds the same and nothing is ever downloaded.

---

## Notes

- The Desktop shortcut runs the current local TypeScript source and opens it
  explicitly in Chrome, or Edge if Chrome is unavailable. It checks Node and
  installs missing or changed dependencies. Start your local model server
  yourself before generating a show.
- An open station is left running so a show is not interrupted. Close its server
  window after the show finishes, then use the shortcut again to load new code.
- The server binds to `127.0.0.1` only — it is not reachable from your network.
- A loopback bind does not stop a web page you visit, so the server also refuses any request whose `Host` is not
  `localhost`, `127.0.0.1` or `[::1]` (DNS rebinding), and refuses a change (POST, PUT, DELETE) that a browser labels as coming
  from another site. The station's own page, scripts and tools such as the Godot client are unaffected. The world API accepts
  writes from another local page but still needs the key in `data/world_api_token.txt`, and answers cross-origin reads only to
  pages served from this PC. See `server/lib/request-guard.ts`.
- The Gemini provider is off by default and only used if you select it and add a key.
- `_original_backup/` holds the original Google AI Studio version of this app.
