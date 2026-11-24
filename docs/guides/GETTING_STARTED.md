# Getting started

This guide takes you from nothing to your first finished radio show. It
assumes no technical knowledge. Allow about 20 minutes, most of it waiting for
downloads.

**What you will end up with:** two AI hosts talking about any topic you give
them, with voices, music, station jingles and ad breaks, saved as an audio file
with a transcript. Everything runs on your own computer.

---

## What you need

- **A Windows PC** for the easy download. (Mac and Linux work too, from the
  source code; see [the README](../../README.md#from-source-windows-macos-linux).)
- **A graphics card with about 6 GB of video memory** is ideal. Without one it
  still works, just much more slowly.
- **About 10 GB of free disk space**, mostly for the AI model.
- **An internet connection for setup.** After that it can run fully offline.

---

## Step 1: Install LM Studio and download a model

The hosts' words come from an AI language model that runs on your computer.
LM Studio is a free app that downloads and runs these models.

1. Go to <https://lmstudio.ai>, download LM Studio for Windows and install it.
2. Open LM Studio. Click the **search** (magnifying glass) icon.
3. Search for **Qwen2.5 7B Instruct** and download it. About 5 GB.
   *Other good choices: Gemma or Mistral "instruct" models around 7–8B.
   Avoid "reasoning" models such as DeepSeek-R1; they are slow on air.*
4. Click the **Developer** tab (the `>_` icon on the left).
5. Load the model you downloaded, using the box at the top.
6. Switch on **Start Server** (or **Status: Running**).

Leave LM Studio open. The station talks to it in the background.

---

## Step 2: Download Local Talk Radio

1. Go to the
   [latest release](https://github.com/Wommper1/ai-talk-radio/releases/latest).
2. Under **Assets**, download **`LocalTalkRadio-…-windows-x64.zip`**.
3. Find the zip in your Downloads folder, right-click it and choose
   **Extract All…**.
4. Extract it somewhere you can write to, for example **Documents**. Avoid
   *Program Files*. Your shows and settings are saved inside this folder.

---

## Step 3: Start the station

1. Open the folder you extracted.
2. Double-click **Start Local Talk Radio**.
3. If Windows shows **"Windows protected your PC"**, click **More info**, then
   **Run anyway**. This appears because the download is not code-signed.
4. A black window opens and then your browser opens on the station. **Leave the
   black window open**; closing it stops the station.

---

## Step 4: The setup screen

The first time, the station opens on **Set up your station**. It has two
parts.

**1. The hosts' brain.** The station looks for LM Studio by itself.

- If it says **Found LM Studio**, it is done. If you loaded more than one
  model, choose one from the list.
- If it says **No model server is running**, check that LM Studio's server is
  switched on (Step 1, part 6), then press **Check again**.

**2. Their voices.** Pick how the hosts sound.

| Option | What it is |
| --- | --- |
| **Piper voices** | Good quality, fully offline. Press **Download offline voices** (about 300 MB) and wait for it to finish. **Recommended to start.** |
| **Edge voices** | The most natural voices, but they need the internet and send each line to Microsoft. See [How to use Edge voices](HOW_TO.md#use-the-more-natural-edge-voices). |
| **Windows voices** | Built into Windows. Basic quality. |
| **No voices** | Text only. Handy for a quick test. |

Press **Go to the studio**.

---

## Step 5: Your first show

1. In **Topic**, type anything, for example *"Is it ever OK to recline your
   seat on a plane?"*. Or press **Surprise me**.
2. Leave **Format** on **Debate** and **Length** as it is for now.
3. Press **Start the show**.

Within a few seconds the station plays its opening jingle. Then the two hosts
start talking. Each line appears on screen and is spoken a moment later, with
the line being spoken highlighted.

When the show ends it is saved automatically. Press the result to open it in
the player, or find it later under **Library**.

**Congratulations, you are on air.**

---

## What to try next

- **Call in** while a show is running and the hosts answer you by name.
  ([How](HOW_TO.md#call-in-to-a-live-show))
- **Paste an article** and have them do a deep dive on it.
  ([How](HOW_TO.md#make-a-show-about-a-document))
- **Add your own sponsor** and hear it in the ad breaks.
  ([How](HOW_TO.md#advertise-your-own-business-or-a-friends))
- **Open with a song** from your music folder.
  ([How](HOW_TO.md#open-the-show-with-a-song))

All of these are in the [how-to guide](HOW_TO.md). If something goes wrong,
see [troubleshooting](TROUBLESHOOTING.md).
