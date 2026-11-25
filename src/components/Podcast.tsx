import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ExternalLink, FolderOpen, ImagePlus, Rss, Save, Trash2, Upload } from "lucide-react";
import type { PodcastSettings, PodcastState } from "../types";
import { api } from "../lib/api";
import { Button, Callout, Field, Input, Panel, Select, Textarea, Toggle } from "./ui";

/**
 * The Podcast tab: choose shows, describe the podcast, and build a folder of
 * MP3s, an RSS feed and a small website that can be uploaded anywhere. The
 * station itself never goes online; only the finished folder does.
 */

const clock = (seconds: number) => {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function Podcast() {
  const [state, setState] = useState<PodcastState | null>(null);
  const [draft, setDraft] = useState<PodcastSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [coverVersion, setCoverVersion] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback((next: PodcastState) => {
    setState(next);
    setDraft(next.settings);
    setDirty(false);
  }, []);

  useEffect(() => {
    api.podcast().then(load).catch((err: Error) => setError(err.message));
  }, [load]);

  // Follow a publish while it runs, then refresh everything once it ends.
  const running = state?.job.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(async () => {
      try {
        const job = await api.podcastJob();
        if (job.state === "running") setState((s) => (s ? { ...s, job } : s));
        else {
          const fresh = await api.podcast();
          setState(fresh); // keep any unsaved edits in the draft
        }
      } catch {
        /* try again on the next tick */
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!state || !draft) {
    return (
      <div className="mx-auto max-w-5xl px-5 py-6">
        {error ? <Callout tone="error">{error}</Callout> : <p className="text-sm text-[var(--color-mute)]">Loading…</p>}
      </div>
    );
  }

  const edit = (patch: Partial<PodcastSettings>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
    setNotice(null);
  };

  const toggleEpisode = (id: string, on: boolean) =>
    edit({ episodes: on ? [...draft.episodes, id] : draft.episodes.filter((e) => e !== id) });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      load(await api.savePodcast(draft));
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (dirty && !(await save())) return;
    setBusy(true);
    setError(null);
    try {
      setState(await api.publishPodcast());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const uploadCover = async (file: File) => {
    setError(null);
    try {
      const next = await api.uploadPodcastCover(file);
      setState(next);
      setNotice(next.warning ?? "Cover saved.");
      setCoverVersion((v) => v + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const removeCover = async () => {
    setState(await api.removePodcastCover());
    setCoverVersion((v) => v + 1);
  };

  const publishable = state.shows.filter((s) => s.publishable);
  const chosen = state.shows.filter((s) => draft.episodes.includes(s.id) && s.publishable);
  const withRecords = chosen.filter((s) => s.hasRecord);
  const toEncode = chosen.filter((s) => !s.encoded || draft.quality !== state.settings.quality).length;
  const job = state.job;
  const feedUrl = draft.siteUrl ? `${draft.siteUrl.replace(/\/?$/, "/")}feed.xml` : "";

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-5 py-6">
      <div>
        <h1 className="flex items-center gap-2 font-serif text-3xl tracking-tight text-white">
          <Rss size={22} className="text-[var(--color-amber)]" /> Podcast
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--color-dim)]">
          Turn your shows into a podcast anyone can subscribe to. Choose the episodes, press Publish, and the
          station builds a folder with the MP3s, a podcast feed and a small website. Upload that folder to a free host
          (steps below). The station itself never goes online.
        </p>
      </div>

      {error && <Callout tone="error">{error}</Callout>}

      {/* ── About the podcast ─────────────────────────────── */}
      <Panel
        title="Your podcast"
        subtitle="How it appears in podcast apps."
        right={
          <Button size="sm" variant={dirty ? "primary" : "default"} onClick={() => void save()} disabled={!dirty || busy}>
            <Save size={13} /> {dirty ? "Save" : "Saved"}
          </Button>
        }
      >
        <div className="grid gap-5 md:grid-cols-[220px_1fr]">
          <div className="space-y-2">
            <img
              src={`/api/podcast/cover?v=${coverVersion}-${encodeURIComponent(state.settings.title)}`}
              alt="Podcast cover"
              className="aspect-square w-full rounded-lg border border-[var(--color-line)] object-cover"
            />
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadCover(file);
                e.target.value = "";
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => fileInput.current?.click()}>
                <ImagePlus size={13} /> {state.customCover ? "Replace" : "Use my own"}
              </Button>
              {state.customCover && (
                <Button size="sm" variant="ghost" onClick={() => void removeCover()}>
                  <Trash2 size={13} /> Remove
                </Button>
              )}
            </div>
            <p className="text-xs leading-relaxed text-[var(--color-mute)]">
              {state.customCover
                ? "Your own artwork."
                : "Drawn from the title. Use your own square PNG or JPEG, 1400 to 3000 pixels, for a better one."}
            </p>
            {notice && <p className="text-xs text-[var(--color-amber)]">{notice}</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title">
              <Input value={draft.title} onChange={(e) => edit({ title: e.target.value })} />
            </Field>
            <Field label="By" hint="Your name, or a name for the show's creator.">
              <Input value={draft.author} onChange={(e) => edit({ author: e.target.value })} placeholder="Optional" />
            </Field>
            <Field label="Description" className="sm:col-span-2">
              <Textarea rows={3} value={draft.description} onChange={(e) => edit({ description: e.target.value })} />
            </Field>
            <Field
              label="Web address it will live at"
              hint="Needed before publishing: every link in the feed is built from it. For GitHub Pages it is https://YOUR-NAME.github.io/REPOSITORY-NAME/ (see the steps below)."
              className="sm:col-span-2"
            >
              <Input
                value={draft.siteUrl}
                onChange={(e) => edit({ siteUrl: e.target.value })}
                placeholder="https://your-name.github.io/my-show/"
                spellCheck={false}
              />
            </Field>
            <Field label="Category">
              <Select value={draft.category} onChange={(e) => edit({ category: e.target.value })}>
                {state.categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Audio quality" hint="Standard suits most shows. Small halves the file size.">
              <Select value={draft.quality} onChange={(e) => edit({ quality: e.target.value as PodcastSettings["quality"] })}>
                {state.qualities.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Language code" hint='For example "en", "en-GB" or "es".'>
              <Input value={draft.language} onChange={(e) => edit({ language: e.target.value })} spellCheck={false} />
            </Field>
            <Field
              label="Contact email (optional)"
              hint="Apple and Spotify email it to confirm you own the podcast. It is public: anyone reading the feed can see it."
            >
              <Input
                type="email"
                value={draft.ownerEmail}
                onChange={(e) => edit({ ownerEmail: e.target.value })}
                placeholder="Leave empty to keep it private"
              />
            </Field>
            <div className="space-y-2 sm:col-span-2">
              <Toggle
                label="Say each episode was made with AI"
                hint="Adds a line to every episode description. Recommended: listeners and several podcast directories expect AI-made audio to be labelled."
                checked={draft.aiNotice}
                onChange={(aiNotice) => edit({ aiNotice })}
              />
              <Toggle
                label="Explicit"
                hint="Turn on if the hosts swear or the topics are adult."
                checked={draft.explicit}
                onChange={(explicit) => edit({ explicit })}
              />
            </div>
          </div>
        </div>
      </Panel>

      {/* ── Episodes ──────────────────────────────────────── */}
      <Panel
        title="Episodes"
        subtitle={`${chosen.length} of ${publishable.length} shows chosen. Only the shows you tick are published.`}
        right={
          publishable.length > 0 && (
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => edit({ episodes: publishable.map((s) => s.id) })}>
                All
              </Button>
              <Button size="sm" variant="ghost" onClick={() => edit({ episodes: [] })}>
                None
              </Button>
            </div>
          )
        }
      >
        {state.shows.length === 0 ? (
          <p className="text-sm text-[var(--color-dim)]">No shows yet. Make one in the Studio first.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {state.shows.map((s) => {
              const on = draft.episodes.includes(s.id);
              return (
                <li key={s.id} className="py-2.5">
                  <label className={`flex items-start gap-3 ${s.publishable ? "cursor-pointer" : "opacity-50"}`}>
                    <input
                      type="checkbox"
                      className="mt-1 accent-[var(--color-amber)]"
                      checked={on && s.publishable}
                      disabled={!s.publishable}
                      onChange={(e) => toggleEpisode(s.id, e.target.checked)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-white">{s.title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-mute)]">
                        <span>{new Date(s.createdAt).toLocaleDateString()}</span>
                        <span>{clock(s.duration)}</span>
                        {!s.publishable && <span>No audio (transcript only)</span>}
                        {s.publishable && s.encoded && <span className="text-[var(--color-good)]">MP3 ready</span>}
                        {s.hasRecord && (
                          <span className="inline-flex items-center gap-1 text-[var(--color-amber)]">
                            <AlertTriangle size={11} /> Contains a song from your music folder
                          </span>
                        )}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {/* ── Before publishing ─────────────────────────────── */}
      <Panel title="Before you publish" subtitle="Publishing makes these shows public. Worth a minute.">
        <ul className="space-y-2.5 text-sm leading-relaxed text-[var(--color-dim)]">
          {withRecords.length > 0 && (
            <li className="flex gap-2 text-[var(--color-amber)]">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span>
                {withRecords.length === 1 ? "One chosen episode plays" : `${withRecords.length} chosen episodes play`} a
                song from your music folder. Only publish it if you own the rights to that song; otherwise untick it or
                make the show again without <em>Open with a record</em>.
              </span>
            </li>
          )}
          <li className="flex gap-2">
            <Check size={15} className="mt-0.5 shrink-0 text-[var(--color-dim)]" />
            <span>
              <strong className="text-white">Voices have licenses.</strong> Some Piper voices are free for
              non-commercial use only, and Edge voices come from a Microsoft service with its own terms. Check the voice
              you used before you make money from the podcast.
            </span>
          </li>
          <li className="flex gap-2">
            <Check size={15} className="mt-0.5 shrink-0 text-[var(--color-dim)]" />
            <span>
              <strong className="text-white">Listen first.</strong> The hosts are AI and can say odd or wrong things. Play
              each episode in the Library before publishing it.
            </span>
          </li>
          <li className="flex gap-2">
            <Check size={15} className="mt-0.5 shrink-0 text-[var(--color-dim)]" />
            <span>
              <strong className="text-white">Your own adverts and sponsors</strong> are published too. Make sure any real
              business you added is happy to be advertised.
            </span>
          </li>
        </ul>
      </Panel>

      {/* ── Publish ───────────────────────────────────────── */}
      <Panel title="Publish" subtitle="Builds the folder to upload. Nothing is uploaded for you.">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={() => void publish()} disabled={busy || running || chosen.length === 0 || !draft.siteUrl}>
              <Upload size={14} /> {running ? "Publishing…" : `Publish ${chosen.length} episode${chosen.length === 1 ? "" : "s"}`}
            </Button>
            {state.published && (
              <>
                <Button onClick={() => void api.revealPodcast()}>
                  <FolderOpen size={14} /> Open the folder
                </Button>
                <Button onClick={() => window.open("/podcast-preview/", "_blank", "noopener")}>
                  <ExternalLink size={14} /> Preview the website
                </Button>
              </>
            )}
          </div>

          {!running && chosen.length > 0 && !draft.siteUrl && (
            <p className="text-xs text-[var(--color-amber)]">Add the web address it will live at, above, first.</p>
          )}
          {!running && chosen.length > 0 && draft.siteUrl && toEncode > 0 && (
            <p className="text-xs text-[var(--color-mute)]">
              {toEncode} episode{toEncode === 1 ? " needs" : "s need"} converting to MP3 first. That takes roughly a
              tenth of the show's length; later publishes reuse them.
            </p>
          )}

          {running && (
            <div className="space-y-1.5">
              <div className="h-2 overflow-hidden rounded-full bg-[var(--color-panel-2)]">
                <div
                  className="h-full bg-[var(--color-amber)] transition-all"
                  style={{ width: `${Math.round(((job.done + Math.min(job.fraction, 0.999)) / Math.max(1, job.total)) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-[var(--color-dim)]">
                {job.message} ({job.done} of {job.total} done)
              </p>
            </div>
          )}

          {job.state === "failed" && job.error && <Callout tone="error" title="Publishing failed">{job.error}</Callout>}

          {job.state === "done" && (
            <Callout tone="good" title={`Published ${job.published ?? ""} episode${job.published === 1 ? "" : "s"}`}>
              The folder is ready to upload: <span className="break-all font-mono text-xs">{state.siteDir}</span>
            </Callout>
          )}

          {feedUrl && (
            <p className="text-xs leading-relaxed text-[var(--color-mute)]">
              Once uploaded, the feed listeners subscribe to is{" "}
              <span className="break-all font-mono text-[var(--color-dim)]">{feedUrl}</span>
            </p>
          )}
        </div>
      </Panel>

      {/* ── Hosting ───────────────────────────────────────── */}
      <Panel title="Put it online for free" subtitle="One way to do it, with GitHub Pages. Any static web host works.">
        <ol className="ml-5 list-decimal space-y-2.5 text-sm leading-relaxed text-[var(--color-dim)]">
          <li>
            On <a className="text-[var(--color-amber)] underline" href="https://github.com/new" target="_blank" rel="noreferrer">github.com/new</a>,
            create a <strong className="text-white">public</strong> repository, for example <span className="font-mono">my-show</span>.
          </li>
          <li>
            Your podcast's address will be <span className="font-mono text-white">https://YOUR-NAME.github.io/my-show/</span>. Type
            it into <em>Web address it will live at</em>, above, and press <strong className="text-white">Publish</strong>.
          </li>
          <li>
            In the new repository, click <strong className="text-white">uploading an existing file</strong>, press{" "}
            <strong className="text-white">Open the folder</strong> here, and drag <em>everything inside it</em> (including the{" "}
            <span className="font-mono">episodes</span> folder) onto the page. Press <strong className="text-white">Commit changes</strong>.
          </li>
          <li>
            In the repository's <strong className="text-white">Settings → Pages</strong>, choose <em>Deploy from a branch</em>,
            branch <span className="font-mono">main</span>, folder <span className="font-mono">/ (root)</span>, and Save. After a
            minute or two the address from step 2 shows your podcast's website.
          </li>
          <li>
            To be listed in Apple Podcasts or Spotify, submit the feed address (shown under Publish) at{" "}
            <a className="text-[var(--color-amber)] underline" href="https://podcastsconnect.apple.com" target="_blank" rel="noreferrer">Apple Podcasts Connect</a>{" "}
            and{" "}
            <a className="text-[var(--color-amber)] underline" href="https://creators.spotify.com" target="_blank" rel="noreferrer">Spotify for Creators</a>.
            Anyone can also paste it straight into a podcast app.
          </li>
          <li>
            <strong className="text-white">New episode?</strong> Tick it, Publish again, and upload the changed files the same
            way.
          </li>
        </ol>
        <p className="mt-4 text-xs leading-relaxed text-[var(--color-mute)]">
          GitHub's upload page takes files up to 25 MB, which fits about 30 minutes at Standard quality. For bigger files use
          GitHub Desktop, or Small quality. GitHub Pages suits a hobby podcast; a popular one may outgrow its bandwidth.
        </p>
      </Panel>
    </div>
  );
}
