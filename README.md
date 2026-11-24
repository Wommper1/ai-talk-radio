# Local Talk Radio

Two AI hosts talk to each other and the station turns the conversation into a
finished radio show, with voices, music beds, station idents, commercial breaks
and a timecoded transcript.

The language model, the production pipeline, your shows and the station's
memory all run on your own machine. No account, no subscription, and nothing
you make leaves your PC.

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
| **Node.js** | 22.13 or newer (24 recommended) |
| **A local model server** | [LM Studio](https://lmstudio.ai), [Ollama](https://ollama.com), or anything with an OpenAI-compatible API |
| **A model** | A plain instruct model, about 8B (for example Qwen, Gemma or Mistral). 6 GB of VRAM is enough |
| **Speech** (pick one) | Piper (offline, downloaded by a script), Edge TTS (best quality, needs Python and an internet connection), or Windows SAPI |
| **OS** | Developed and tested on Windows. The server and tests also run on Linux; macOS is untested |

## Quick start

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

2. Start your model server. In LM Studio: **Developer** tab → load a model →
   **Start Server**. For Ollama, run `ollama serve`.

3. Install a voice. For fully offline speech:

   ```bash
   npm run setup-piper
   ```

   For the more natural Edge voices on Windows:

   ```bash
   npm run setup-edge-tts
   ```

   On macOS or Linux, create the same private environment by hand:

   ```bash
   python3 -m venv tools/edge-tts && tools/edge-tts/bin/pip install edge-tts
   ```

4. Check everything is wired up. It explains anything that is missing:

   ```bash
   npm run doctor
   ```

5. Run the station:

   ```bash
   npm run dev
   ```

6. Open <http://localhost:3000>, go to **Settings**, press **Refresh** next to
   the model list, pick your model and press **Save**. Back in **Studio**, type
   a topic and press **Start the show**.

Finished shows are saved as plain folders under `shows/`.

On Windows, `npm run shortcut` adds a **Local Talk Radio** desktop shortcut
that starts the server and opens the browser in one step.

## Documentation

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

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
