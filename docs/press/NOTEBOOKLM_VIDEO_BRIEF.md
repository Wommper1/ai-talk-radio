# Local Talk Radio: NotebookLM video brief

This file has two parts:

- **Part A** is a short instruction to paste into NotebookLM's **Customize**
  box when you create the Video Overview.
- **Part B** is the full briefing. Add it to the notebook as a **source**
  (upload this file, or paste Part B as "Copied text").

---

## Part A: paste into the Video Overview "Customize" box

```text
Make an upbeat 6–8 minute tutorial and showcase for "Local Talk Radio", a free, open-source app where two AI hosts talk to each other and the station turns it into a finished radio show, all on the viewer's own computer. Audience: curious non-technical people and hobbyists. Structure: 1) hook with what it does, 2) how it works in one simple picture, 3) step-by-step setup with the Windows download, 4) first show, 5) tour of the coolest features (call-ins, deep dives on your own documents, fake sponsors and ad breaks, opening with a song, memory, publishing your shows as a podcast, King Orion's Realm), 6) tips and honest limits, 7) where to get it. Use only facts from the sources; never invent features, prices or numbers. Friendly, clear, a little playful, like a radio DJ explaining their station.
```

---

## Part B: the full briefing (add as a source)

### Instructions for the video

You are making a tutorial and showcase video about Local Talk Radio. Treat this
briefing as the only source of truth.

- **Do not invent** features, settings, prices, release dates, download counts
  or performance numbers. If something is not described here, leave it out.
- **Audience:** curious, non-technical people, hobbyists, podcast fans and
  people who like playing with AI on their own computer. Explain any jargon the
  first time it appears.
- **Tone:** friendly, clear, enthusiastic but honest, a little playful. The app
  is about radio, so a light radio-DJ energy fits. Avoid hype words such as
  "revolutionary" or "game-changing".
- **Length:** about 6–8 minutes.
- **Be honest about limits.** The section "Honest limits" below must be
  covered, briefly.
- **Say the name as** "Local Talk Radio".

### Suggested structure

1. **Cold open (0:00–0:30).** "What if you could run your own radio station,
   where two AI hosts argue about any topic you give them, complete with
   jingles, music, ad breaks and listener call-ins, and it all runs on your own
   computer?"
2. **What it is (0:30–1:30).** Two AI hosts, one finished radio show, made
   locally. Show the parts of a show: opening jingle, the hosts talking, an ad
   break, a caller, the sign-off.
3. **How it works, simply (1:30–2:30).** The two-agents idea and the
   production pipeline (see below).
4. **Setup tutorial (2:30–4:00).** The four steps for Windows.
5. **Your first show (4:00–4:45).** Type a topic, press Start the show.
6. **Feature tour (4:45–7:00).** The coolest things, in the order given below.
7. **Tips and honest limits (7:00–7:30).**
8. **Where to get it (7:30–8:00).** Free on GitHub, MIT licensed.

---

### 1. What Local Talk Radio is

Local Talk Radio is a free, open-source app (MIT license). Two AI hosts talk to
each other, live, about any topic you give them, and the station turns the
conversation into a finished radio show. A show has voices, synthesised music
beds, a station ident, transitions, commercial breaks, optional listener
call-ins, and a timecoded transcript.

The AI language model, the production, your shows and the station's memory
all run on your own computer. There is no account and no subscription. With the
offline Piper voices, nothing you make leaves your computer. (The optional,
more natural Edge voices use Microsoft's online service.)

It runs in your web browser, but the "server" is your own computer. It is
designed to run well on a modest gaming PC: an 8-billion-parameter AI model and
a graphics card with about 6 GB of video memory.

The project is on GitHub at **github.com/Wommper1/ai-talk-radio**.

### 2. How it works

**Two real AI agents, not a script.** The two hosts are separate AI agents.
Each has its own personality, its own instructions and even its own AI model.
They take turns replying to each other, so each model is genuinely holding up
one side of a conversation instead of writing a script of two people talking.

**The production pipeline**, in plain words:

1. **Topic.** You type a topic, or press *Surprise me*.
2. **Optional research and planning.** The station can read source material
   and plan a "running order" of beats, like a real producer.
3. **The conversation.** Host A and host B take turns, one AI call per turn.
4. **Speech while it is written.** Each finished line is turned into speech
   straight away and plays in the browser about two to three seconds after it
   appears on screen, while the next line is being written. You hear the show
   as it is made, with the current line highlighted.
5. **Production.** The same voice clips are mixed with the music, stings and
   ad breaks into one finished audio file, mastered to a streaming loudness
   standard (about -16 LUFS), and saved with its transcript.

**No ffmpeg, nothing extra.** All the audio work (mixing, voice processing,
the phone-line caller sound, music ducking under speech, mastering) is built
into the app.

**Music is generated, not downloaded.** Music beds are synthesised by the app
from a chord progression for each mood: Tech, Chill, Newsroom, Late Night,
Upbeat, Noir and Rock. That means no copyright problems and no downloads.

### 3. Setup tutorial (Windows download)

The easiest way is the Windows download. Node.js is included, so there is
nothing else to install except the AI model app.

**Step 1: Install LM Studio and get a model.** LM Studio is a free app that
runs AI models on your computer (lmstudio.ai). Download a model such as *Qwen2.5
7B Instruct*. On LM Studio's **Developer** tab, load the model and press
**Start Server**. (Ollama also works.)

**Step 2: Download Local Talk Radio.** From the GitHub releases page, download
the Windows zip, right-click it, choose **Extract All**, and put it somewhere
like Documents. Shows and settings are saved inside that folder.

**Step 3: Double-click "Start Local Talk Radio".** A small black window starts
the station and the browser opens. Windows may say "Windows protected your PC"
because the download is not code-signed; choose **More info → Run anyway**.
Closing the black window stops the station.

**Step 4: The setup screen.** On first launch, a setup screen does most of the
work:

- It **finds LM Studio or Ollama by itself**. If only one model is loaded, it
  picks it for you.
- It shows which **voices** are available and offers a **Download offline
  voices** button (about 300 MB) for the Piper voices.
- Press **Go to the studio**.

If a model and voices are already in place, setup needs no clicks at all
before "Go to the studio".

Mac and Linux users can run it from the source code with Node.js; the README
explains how.

### 4. Your first show

In the **Studio**, type a topic, for example "Is it ever OK to recline your
seat on a plane?", and press **Start the show**. Within seconds the station
plays its opening. The hosts start talking, each line spoken a moment after it
appears. When it ends, the show is saved and appears in the **Library** with a
player and transcript.

Show **formats**: Debate (they disagree and press each other), Interview (one
asks, one answers at length), Roundtable (relaxed, building on each point),
Banter (fast, funny, a little chaotic), Explainer (one teaches, one keeps them
honest), Cold open (drops in mid-conversation), and Deep dive (works through a
document you give it).

### 5. Feature tour: the cool stuff

**Call in live.** While a show is on air, a *Call in* panel appears. Type your
name and what you want to say; you go on air at the next gap, in your own voice
on a phone line, placed in the middle of the stereo picture between the two
hosts. Whoever speaks next answers you directly, by name.

**The phone book.** Give a name when you call and the station remembers you.
Call again and the hosts know you are a regular: how many times you have called
and what you said last time. The hosts are forbidden from ever pretending a
caller is on the line when nobody is.

**Deep dives on your own documents.** Paste an article, notes or a report and
choose *Deep dive*. A "producer" pass reads it first and pulls out the hook
(the single most surprising thing), the key concepts, the "aha" moments, and
everyday analogies. The hosts then perform that brief, so you get a real
discussion instead of a summary read aloud.

**Fake sponsors and real-sounding ad breaks.** With no setup at all, the
station invents funny small local businesses to advertise. The hosts throw to
the break and welcome listeners back afterwards. It sounds like radio because
it copies what real radio does: the ads are louder than the show, the show's
music drops out, the advert voice is brighter and more compressed, and there's
an impact going in and the station ident coming out.

**No two adverts the same.** Every advert is written to one of fourteen named
formats, such as the testimonial, the overheard conversation, the guarantee,
"running out", the public notice and "wrong presenter". The station remembers
which formats each advertiser has used and picks a different one next time.

**Your own sponsors.** Add a business (yours or a friend's) and a "how it
should be read" direction, such as "breathless hard sell" or "flat and
matter-of-fact, as if none of this were unusual". You can even drop in your own
recorded advert as an audio file.

**The shelf.** Every advert the station records is kept. Later shows replay
some of them, like a real station does, which saves time.

**Open with a song.** Drop music files into the music folder and turn on *Open
with a record*. An announcer throws to the song ("stay with us… but first,
here's…"), the song plays, and behind it the hosts' first lines are already
being written. Afterwards the host back-announces the track by name and artist,
like a real DJ.

**A synthesised band for the opening.** The opening jingle is a short rock
intro generated by the app: a kick drum made from a pitch sweep, a snare from
filtered noise, and power chords made by clipping a stack of sawtooth waves,
which is genuinely how a guitar amp gets that sound. It plays the instant you
press Start, covering the wait for the first AI line. Six openers rotate so it
is not the same every night.

**Ready-made host pairs.** *Drive-time DJs* (Marco works the mic, Dee punctures
him), *Deep-dive duo* (Alex drives the story, Wren has the realisations) and
*Late-night pair* (Paul is warm and curious, Rae is sceptical). They are
deliberately mismatched, because two hosts with the same energy talk past each
other.

**DJ craft built in.** The hosts follow radio habits: play to the listener,
one idea per turn, be specific, vary the shape of each line, react and move
on, and avoid filler phrases such as "that's a great point". An anti-loop guard
stops a small model from returning to the same example every turn.

**A shared history.** Tell both hosts their relationship ("married twelve
years, two kids, one dog") and they are reminded of it throughout, so they
never contradict it.

**Memory across shows.** Past episodes are indexed so hosts can genuinely
refer back to "last week's show" instead of inventing a history.

**Recovery.** If the computer stops mid-show, every finished line is saved;
*Resume* carries on from where it stopped.

**Station operations.** An Operations view checks everything before a show
goes on air (model, voices, disk space, ad inventory) and separates real
blockers from recommendations. It also handles backups.

**Publish your shows as a podcast.** The Podcast tab turns the shows you pick
into a real podcast. Press Publish and the station converts each show to MP3
and builds a folder with an RSS feed (what podcast apps subscribe to), a small
website with a player and the full transcript for every episode, transcript
files podcast apps can display, and cover art (drawn from the title if you do
not have your own). You upload that folder to a free host such as GitHub Pages;
your computer itself never goes online. Before publishing it reminds you to
label episodes as AI-made (on by default), to check voice licenses, and it
flags any episode that plays a song from your music folder, since you may not
own the rights to publish it.

**King Orion's Realm (optional, for fun).** The station can be handed over to
King Orion, a dark-fantasy king, and Maeve, his chronicler, sitting in his hall
late at night. Connected to a separate game project, everything the King knows
comes from the game's own save files, and he may embroider the weather and the
smell of the hall but may not invent deeds or names. A court opens with a low
drone, two struck bells and a herald: "The hall is closed. King Orion sits."
This is an optional extra, not needed to use the station.

### 6. Tips

- **Be specific.** "Should restaurants ban phones at the table?" beats
  "phones". A question with two sides works best.
- **Give each host a different model** to make them sound like two different
  people.
- **For speed,** use the *Fast Live* performance profile, Piper voices, and a
  model that fits in your graphics card's memory.
- **For the most natural voices,** use the optional Edge voices.

### 7. Honest limits

- You need to install **LM Studio or Ollama** and download an AI model (several
  GB) yourself.
- It works best with a **graphics card with about 6 GB of video memory**.
  Without one it runs, but slowly.
- Small AI models can **repeat themselves or drift** on long shows; the app has
  guards against this, but it is AI, and it can still say odd or wrong things.
  Do not treat what the hosts say as fact.
- The **Edge voices send each line to Microsoft** and use an unofficial
  service that may change. Piper voices are fully offline.
- Some **Piper voice models have their own licenses** that do not allow
  commercial use. Check before publishing or selling shows.
- Publishing a podcast builds the files, but **you upload them yourself**
  (step-by-step instructions are in the app).
- The Windows download is **not code-signed**, so Windows shows a warning the
  first time.
- The station is a desktop tool for one person. It must not be exposed to the
  internet.

### 8. Where to get it

Free and open source (MIT license) on GitHub: **github.com/Wommper1/ai-talk-radio**.
Windows users can download the zip from the Releases page. The README, a
getting-started guide, a how-to guide and troubleshooting are all in the
repository.

### Glossary

- **AI model / language model:** the AI that writes the hosts' lines. It runs
  on your computer.
- **LM Studio / Ollama:** free apps that download and run AI models locally.
- **8B model:** an AI model with about 8 billion parameters; small enough for a
  home PC.
- **VRAM:** your graphics card's memory.
- **Piper / Edge voices:** two ways of turning text into speech. Piper is
  offline; Edge is online and more natural.
- **Ident / sting:** short station jingles and sound effects.
- **Ducking:** the music automatically gets quieter under speech.
- **LUFS:** a loudness measurement used by streaming services.
- **Open source / MIT license:** the code is free to use, study and change.
