# Troubleshooting

Start here: **Settings → Run the setup guide** re-checks the model server and
voices and tells you what is wrong. From the source code, `npm run doctor` does
the same in a terminal.

---

## Starting the station

**"Windows protected your PC" when I double-click Start Local Talk Radio.**
The download is not code-signed. Click **More info → Run anyway**.

**The black window says "Google Chrome and Microsoft Edge were not found".**
The station opens in Chrome or Edge. Install Chrome (preferred) or Edge, then
start it again.

**It says it is already running, or opens an old window.**
A station is already running in another black window, perhaps minimised. Use
that one, or close it and start again.

**Nothing happens, or the window closes straight away.**
Make sure you extracted the zip first (right-click → **Extract All**). Running
it from inside the zip does not work. Also avoid extracting to *Program Files*;
use Documents instead.

**A yellow banner says "This window is running older code".**
You updated the station while it was open. Close the black window and start it
again.

---

## The hosts' brain (the model)

**"No model server is running on this computer."**
LM Studio is closed, or its server is off. In LM Studio, open the
**Developer** tab, load a model and switch on **Start Server**. Then press
**Check again**.

**"The server is running but has no model loaded."**
In LM Studio's **Developer** tab, load a model using the box at the top.

**Start Show says the model is missing.**
The model you chose earlier is no longer loaded in LM Studio, perhaps because
you switched models. Load it again, or pick the new one under **Settings**.

**Using Ollama instead of LM Studio.**
Run `ollama serve` with a model pulled. The setup screen finds Ollama by
itself. Other servers (llama.cpp, vLLM and others) can be set under **Settings
→ Language model**.

**Shows are very slow.**

- The model may be too big for your graphics card and spilling into normal
  RAM, which can be ten times slower. Try a smaller model (7–8B, or 3–4B).
- "Reasoning" models (DeepSeek-R1, gpt-oss) think before every line. Use a
  plain instruct model.
- Choose **Fast Live** under **Studio → Direction → Performance profile**.
- Edge voices add a network round trip per line; Piper is faster.

**The hosts repeat themselves or wander off topic.**
Small models drift on long shows. Try fewer turns, a more specific topic, the
**Produced** performance profile, or a larger model. Giving each host a
different model also helps.

**Some lines are retried, or the log mentions function calls.**
Llama 3.x models sometimes answer with a "tool call" instead of speech. The
station detects it and retries, so the show still works, just more slowly.
Qwen, Gemma and Mistral instruct models rarely do this.

---

## Voices

**"Download offline voices" failed.**
The error names the file that failed. Usually the internet connection, a
firewall or a proxy blocked it. Press **Try the download again**. The voices
come from huggingface.co, and the speech engine from github.com.

**"Piper voice not found".**
A host is set to a voice that is not installed. Open **Settings → Run the setup
guide** and press **Go to the studio**; it points every host at an installed
voice.

**Edge voices say "Not installed".**
Run **Set up Edge voices** in the station folder (it needs Python from
python.org), then press **Check again**.

**Edge voices stopped working.**
They need the internet, and they use an unofficial Microsoft service that can
change. Run **Set up Edge voices** again to update it, or switch to Piper.

**I can see the text but hear nothing.**

- The browser may have blocked autoplay. The Studio shows **"Your browser
  blocked the sound"**; click it, or click anywhere on the page.
- Check the speaker icon in the Broadcast panel is not muted.
- Check the voice engine is not set to **No voices**.

---

## Ad breaks

**My sponsor is never mentioned.**
**Settings → Ad breaks → Who advertises** must be **Mixed** or **My sponsors
only**. On **Made-up sponsors**, only invented businesses are read.

**The same advert keeps coming back.**
The station reuses some recorded spots from **On the shelf** to save time.
Lower **Repeat from the shelf**, or delete spots you are tired of from the
shelf.

---

## Still stuck?

[Open an issue](https://github.com/Wommper1/ai-talk-radio/issues/new/choose)
and include the output of `npm run doctor` (from the source code), or a
screenshot of the setup screen (Windows download).
