# Local Talk Radio

Two AI hosts talk to each other and the station turns the conversation into a
finished radio show, with voices, music beds, station idents, commercial breaks
and a timecoded transcript.

The language model, the production pipeline, your shows and the station's
memory all run on your own machine. There is no account and no subscription.
With Piper voices, nothing you make leaves your PC; the optional Edge voices
send each line's text to Microsoft to be spoken.

<!-- TODO: add a screenshot of the Studio and a 30-second sample clip here. -->

## What it does

- **Two real agents, not a script.** Each host has its own prompt, model and
  temperature, and they take turns answering each other.
- **You hear it while it is written.** Each line is spoken a few seconds after
  it appears, and the same clips go into the final mix.
- **It sounds like radio.** Synthesised music beds, a cold-open band, stings,
  commercial breaks with made-up local sponsors, and a master at -16 LUFS.
- **Call in.** Type a name and a line; you go on air in a phone-line voice and
  the next host answers you by name. Regular callers are remembered.
- **Deep dives.** Paste a document and a producer pass finds the hook before
  the hosts discuss it.
- **Memory across shows.** Hosts can refer back to earlier episodes.
- **Built for small models.** Tuned to run on an 8B model with a 6 GB GPU.
- **No ffmpeg.** All audio decoding, mixing and mastering is done in TypeScript.

## Requirements

| | |
| --- | --- |
| **Node.js** | 22.13 or newer (24 recommended). Not needed for the Windows download, which includes it |
| **A local model server** | [LM Studio](https://lmstudio.ai), [Ollama](https://ollama.com), or anything with an OpenAI-compatible API |
| **A model** | A plain instruct model, about 8B (for example Qwen, Gemma or Mistral). 6 GB of VRAM is enough |
| **Speech** (pick one) | Piper (offline, downloaded by a script), Edge TTS (best quality, needs Python and an internet connection), or Windows SAPI |
| **OS** | Developed and tested on Windows. The server and tests also run on Linux; macOS is untested |

## Quick start

### Windows: download and double-click

No Node.js, no terminal. Everything the station needs is inside the zip.

1. Download **`LocalTalkRadio-…-windows-x64.zip`** from the
   [latest release](https://github.com/Wommper1/ai-talk-radio/releases/latest).
2. Right-click it → **Extract All**, into a folder you can write to, such as
   Documents. Your shows and settings are saved inside that folder.
3. Install [LM Studio](https://lmstudio.ai), download a model (for example
   *Qwen2.5 7B Instruct*), then on its **Developer** tab load it and press
   **Start Server**.
4. Double-click **Start Local Talk Radio**. The setup screen opens in your
   browser, finds LM Studio and offers to download voices.

The download is not code-signed, so Windows may say it protected your PC.
Choose **More info → Run anyway**.

### From source (Windows, macOS, Linux)

1. Get the code and install dependencies:

   ```bash
   git clone https://github.com/Wommper1/ai-talk-radio.git
   ```

   ```bash
   cd ai-talk-radio
   ```

   ```bash
   npm install
   ```

2. Start your model server. In [LM Studio](https://lmstudio.ai): download a
   model, then **Developer** tab → load it → **Start Server**. For Ollama, run
   `ollama serve`.

3. Run the station:

   ```bash
   npm run dev
   ```

4. Open <http://localhost:3000>. A setup screen finds your model server,
   picks the model (or asks, if you have several loaded), and offers a
   **Download offline voices** button. Press **Go to the studio**, type a topic
   and press **Start the show**.

If anything is not working, `npm run doctor` checks the model server, voices
and settings and explains how to fix each problem.

**Voices from the command line.** The setup screen's download is the same as:

```bash
npm run setup-piper
```

For the more natural Edge voices on Windows, run this once, then press
**Check again** on the setup screen:

```bash
npm run setup-edge-tts
```

On macOS or Linux, install Edge voices into the same private folder by hand:

```bash
python3 -m venv tools/edge-tts && tools/edge-tts/bin/pip install edge-tts
```

Finished shows are saved as plain folders under `shows/`.

On Windows, `npm run shortcut` adds a **Local Talk Radio** desktop shortcut
that starts the server and opens the browser in one step.

## Documentation

- **[Getting started](docs/guides/GETTING_STARTED.md)**: from nothing to your
  first show, step by step, no technical knowledge needed.
- **[How to…](docs/guides/HOW_TO.md)**: short recipes for call-ins, deep dives,
  sponsors, songs, voices, speed and more.
- **[Troubleshooting](docs/guides/TROUBLESHOOTING.md)**: what to do when
  something is not working.
- **[The full guide](docs/GUIDE.md)** covers how a show is built, ad breaks,
  openers, the hosts, the showrunner, memory, providers, every setting and
  every command.
- [Development history](docs/history/) holds the burn-in and certification
  logs from the reference machine (GTX 1660, 6 GB VRAM, 32 GB RAM).
- [King Orion's Realm](docs/REALM.md) is an optional integration with a
  separate game project. You do not need it to run the station.

## Common commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the app with auto-reload |
| `npm run doctor` | Check model, speech and config, and explain any problems |
| `npm run selftest` | Offline tests; no model or network needed |
| `npm run e2e -- "topic"` | Generate a show from the command line |
| `npm run build` then `npm run serve` | Build the frontend and serve it |

The full list is in the [guide](docs/GUIDE.md#commands).

## Security

The station is a desktop tool for the person at the keyboard. It listens on
`127.0.0.1` only and has **no login**. Anyone who can reach it can change
settings, delete shows and run the model. **Do not expose it to a network or
the internet**, for example by port-forwarding or running it behind a public
reverse proxy. It also refuses DNS-rebinding and cross-site requests from web
pages you visit; see `server/lib/request-guard.ts`.

## A note on Edge TTS

The Edge voices use Microsoft's online read-aloud service through the
community [`edge-tts`](https://github.com/rany2/edge-tts) package. It is not an
official, supported API, and it may change or stop working. If you need speech
that is fully offline or free of third-party terms, use Piper.

## Third-party licenses

This repository contains only its own code, under the MIT license. Everything
below is downloaded on your machine when you install or set up the station, and
stays under its own license. The Windows download bundles the npm packages and
Node.js, and lists every license in `THIRD-PARTY-NOTICES.txt`:

| Component | License | Notes |
| --- | --- | --- |
| npm dependencies | MIT, ISC, BSD, Apache-2.0, MPL-2.0 (build tool only) | Installed by `npm install` |
| [`mpg123-decoder`](https://www.npmjs.com/package/mpg123-decoder) | MIT wrapper around mpg123 (LGPL-2.1) | Decodes Edge MP3s |
| [Piper](https://github.com/rhasspy/piper) engine | MIT | Downloaded by `npm run setup-piper` |
| Piper voices | **Varies by voice** | See below |
| [`edge-tts`](https://github.com/rany2/edge-tts) | LGPL-3.0 | Installed into `tools/edge-tts`; the Microsoft service has its own terms |
| [Node.js](https://nodejs.org) | MIT and others | Included in the Windows download; see `node/LICENSE.txt` there |
| Fonts (Inter, Instrument Serif, JetBrains Mono) | SIL Open Font License | Loaded from Google Fonts by the browser |

**Piper voice licenses differ, and some datasets do not allow commercial use.**
The station only plays voices on your own machine, but if you publish or sell
shows, check the `MODEL_CARD` for each voice you use in
[rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices). The
defaults are `en_US-ryan-high` and `en_US-amy-medium`.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
