# Station readiness — 6 GB VRAM / 32 GB RAM

Reviewed and updated September 27, 2026 for the station machine (GTX 1660,
6 GB VRAM, 32 GB system RAM) and LM Studio. The unattended-operation section
and the October 6 operator-gate record were added on October 6, 2026.

## Ready for air

- [x] The 8B Stheno DJ model fits in VRAM and is preflighted before a show.
- [x] Marco and Dee use current Edge Conversation/Copilot voices, with a
  project-private `edge-tts` install rather than the broken system launcher.
- [x] Voice previews, live speech, test renders, and finished episodes share a
  close-mic studio chain. Dialogue is not compressed twice.
- [x] The Studio preset renders 48 kHz, 24-bit stereo and keeps the rock/music
  bed for every supported show length.
- [x] Running orders estimated above 30 minutes are refused before generation,
  protecting RAM and avoiding lost model/TTS time.
- [x] The quality-first Produced profile is internally consistent. Editing any
  controlled switch changes the label to Custom.
- [x] Interrupted broadcasts resume with their completed lines and saved desk
  configuration as context.
- [x] A partially stocked commercial bucket supplies every complete break it
  can; only missing breaks are written live.
- [x] The launcher identifies this app before stopping a process and moves to
  a free port when another program owns port 3000.
- [x] The masthead model light reflects actual LM Studio reachability.
- [x] Destructive storage, draft, shelf, and reset actions ask first; settings
  failures are visible.
- [x] Incomplete show folders and legacy memory/advert material are reported
  and preserved rather than silently used or deleted.
- [x] Controlled and full-load burn-ins completed with every DJ line voiced,
  four scheduled commercial breaks, and no detected PCM clipping.
- [x] Every finished show is mastered toward -16 LUFS-I with a -1 dBTP ceiling,
  measured, and labelled in the player as streaming-ready or needing review.
- [x] Settings can audition Marco and Dee's four best Edge candidates with the
  same script through the real close-mic chain before changing the cast.
- [x] The Operations tab gives one station report for model, speech, storage,
  running order, commercials, recent-master loudness, and recovery folders.
- [x] Start Show runs that preflight first and refuses real blockers while
  keeping ordinary recommendations visible in the control-room log.
- [x] Resume reuses completed speech files, a failed line is retried in
  isolation, and Studio displays a production ETA based on completed turns.

## Burn-in evidence

- The controlled 12-turn Produced show completed in 233.8 seconds and rendered
  832.7 seconds of finished programming. Dialogue quality scored 91/100. The
  master measured 48 kHz / 24-bit stereo, peak 0.8930, with no sampled clipping.
- The normal 24-turn, four-break stress show completed in 465.8 seconds and
  rendered 1,467.7 seconds of finished programming. All 24 lines had live
  neural audio. Dialogue quality scored 92/100, topic drift control scored
  100, and repetition control scored 70. The master measured 48 kHz / 24-bit
  stereo, peak 0.8784, RMS 0.1206, with no clipping in 4,025,642 sampled values.
- The stress run used two complete commercial breaks from the bucket and wrote
  only the two missing breaks, confirming partial-bucket operation under load.
- The first controlled attempt exposed intermittent Edge WebSocket failures.
  Edge work is now serialized station-wide and retried four times with backoff;
  both subsequent end-to-end broadcasts completed successfully.
- The final phase smoke completed four LM Studio turns and four live Edge
  clips in 58.7 seconds. Its delivered 48 kHz / 24-bit master measured -17.2
  LUFS-I and -1.0 dBTP and passed the new streaming gate.
- The operator report passed with six checks, zero blockers, 406.5 GB free,
  322 Edge voices, and the configured Stheno 8B model available.

Machine-readable reports are saved in `output/burn-in/`. The completed show
masters remain in their matching folders under `shows/`.

## Deliberate limits

- Edge voices need internet access. Piper remains the offline fallback, but it
  will sound more synthetic than Andrew/Emma.
- Finished episodes are capped at 30 minutes. Split longer programming into
  parts; this also gives the model a cleaner context window.
- The 43 legacy episodes remain playable but do not teach the current DJs.
  This prevents retired names and older prompt behavior from leaking on air.
- DJ LoRA training is intentionally not started. The notes require 500
  human-approved keeper lines and a commercially suitable base-model license;
  there are not yet enough reviewed lines.

## Unattended operation — implemented, not yet certified

Scheduled production and automatic playout are **off by default**. Implementation
and certification are recorded separately: the code below exists and its failure
paths have run for real, but no scheduled show has ever finished.

**Implemented** (`server/station/automation.ts`, `shared/station-automation.ts`,
the Operations tab):

- **Scheduled production.** Weekday/time slots. At a slot's local minute the
  station runs the ready-for-air preflight, refuses real blockers, generates the
  show, and queues it for playout. A slot runs once per local day.
- **Retries.** A failed scheduled run is retried after `retryMinutes` (default
  10), three attempts in all. Each new scheduled run gets a fresh attempt budget
  (fixed October 6, 2026: before that, once a slot used up its attempts no later
  day's failure was retried until a run happened to succeed).
- **Persistent playout.** The queue, the current item, and the last 100 plays
  survive a restart. With auto-fallback on and the queue empty, playout picks a
  streaming-ready finished show, preferring shows not among the last 12 played.
- **Health monitor.** Station readiness is probed every five minutes and only
  changes are logged (last 250 events).
- **Backups.** A daily state backup (config, data, memory, commercials, ads,
  openers) runs after 03:00 local time; a full backup also takes shows and music.
  Restore always takes a safety backup first. (Fixed October 6, 2026: the
  "day" used to be the UTC date, so the daily backup fired around 8 PM local
  time on this machine instead of after 03:00.)
- **Single owner.** One server process holds the scheduler through
  `data/station-automation.lock`.

**Evidence so far** (from `data/station-automation.json`, September 27–28):

- The scheduler fired the "24-turn station certification" slot, ran the
  preflight, and failed because the DJ model was not loaded, then because LM
  Studio could not be reached. It retried on schedule and stopped at the retry
  limit, logging that fallback playout remains available.
- One backup-and-restore round trip worked and created its safety backup first.
- The health monitor logged real transitions: model not loaded, LM Studio
  unreachable, and the commercial-rotation shortfall.
- **No scheduled production has ever completed.** Playout and fallback have
  never run: the queue and play history are empty.

**Automated coverage.** `npm run selftest` covers slot timing, once-per-day
firing, id safety, turn bounds, and the retry budget. `npm run
automation-selftest` (52 checks, added October 6) covers the playout queue and
its persistence, fallback selection (streaming-ready and silent shows, recently
played shows, a queued show whose files vanished), the history and event-log
caps, schedule-slot management, settings clamping, backup contents and
exclusions (the lock file, the backups folder itself, shows and music for state
backups), and restore (the safety backup is taken first, saved settings are
reloaded, and unsafe or tampered ids and manifests cannot write outside the
station folder). It runs in a throwaway temporary folder, imports the modules
only after changing into it, and refuses to run otherwise, so it cannot touch
the real `shows/`, `data/` or `backups/`. Deliberately breaking three of those
behaviours in the module made exactly the matching checks fail. Still **not**
covered: an end-to-end slot run, the five-minute health monitor, and the
single-owner lock; they need a running station server and a loaded model.

**Known limits.**

- Restore overlays the saved snapshot onto the station folder. It does not delete
  files created after the backup, so a restore is not a rollback to an exact
  earlier state. (A safety backup of the pre-restore state is always taken first.)
- A slot only fires if the server is running during its exact minute. If the app
  or the PC is off or asleep then, that day's show is skipped; there is no
  catch-up run.
- Backups are written to `backups/` on the same drive. They are not an
  off-machine copy.
- Edge speech needs internet access, so an unattended show fails while offline.
  Piper is the offline fallback.

**Certification still open.**

- [ ] A scheduled (not manually started) 24-turn Produced show completes
  unattended with the intended model: every host turn voiced, four commercial
  breaks, mastered, and queued for playout. The October 6 PC project audit
  records an earlier attempt interrupted because the loaded Qwen 3.5 9B was too
  slow for 6 GB of VRAM; restore the proven 8B Stheno model or choose another
  that meets the latency target.
- [ ] Playout plays a queued show, then falls back correctly with the intended
  model unavailable. The queue and fallback rules are covered offline
  (`automation-selftest`); what is open is seeing it happen in a live run.
- [ ] Backup and restore are confirmed again on the final release state. The
  logic is covered offline; this is a check on the real station files.
- [ ] `dialogue-smoke` and `phase-smoke` are rerun with the intended model loaded.
- [ ] Decide whether scheduled production is a launch requirement or stays an
  optional feature. Until decided it is not counted as a launch blocker.

**Operational note.** The saved slot "24-turn station certification" (Sundays,
20:00) is still enabled and automation is switched on. If the station server is
running on a Sunday evening, it will start a full 24-turn production by itself,
using whichever model is loaded in LM Studio.

## Optional wish list (not launch blockers)

- [x] Add a loudness meter and export target in LUFS for matching external
  playout systems.
- [x] Add an A/B voice audition panel for Andrew, Brian, Emma, and Ava before
  changing the permanent cast.
- [x] Add scheduled unattended recording after the station has completed a
  few supervised full-show burn-in runs. Implemented September 27; **not yet
  certified**, see "Unattended operation" above.
- [ ] Add a second fully local premium neural voice engine when a model that
  fits beside the 8B DJ on 6 GB VRAM meets the station's quality bar.
- [ ] Collect and label 500 keeper lines before revisiting DJ fine-tuning.
- [x] Diversify turn openings and block narration, parroting, and opening-record
  leakage. The live 12-turn dialogue check scored 97 for repetition control
  and 100 for topic drift control.

## Operator checks

Run these after changing Python, Node, the model, or audio settings:

```text
npm run doctor
npm run typecheck
npm run selftest
npm run automation-selftest
npm run unattended-status
npm run ttstest -- edge
npm run dialogue-smoke
npm run phase-smoke
```

The voice audition files are written to `output/ttstest/` and may be cleared
from the Files screen without affecting finished shows.

### Operator gate record — October 6, 2026 (offline portion)

LM Studio was not running, so the model-dependent checks were deliberately not
run.

| Check | Result |
| --- | --- |
| `npm run doctor` | One problem: LM Studio not reachable. Node 24.19.0, config, 322 Edge voices, Marco/Dee casting and the show setup all pass. |
| `npm run typecheck` | Passed. |
| `npm run selftest` | 496 passed, 0 failed. |
| `npm run automation-selftest` | 52 passed, 0 failed (added later the same day; run in a temporary sandbox). |
| `npm run unattended-status` | Added October 7. Read-only; reports the durable certification result without starting the server, model, audio, or network. Current state: `BLOCKED` because the last three-attempt run did not reach a finished show. |
| `npm run ttstest -- edge` | Passed. Marco rendered 5.66 s of audio in 1.10 s; Dee 6.12 s in 1.13 s. |
| `npm run dialogue-smoke` | Not run: needs a loaded model. |
| `npm run phase-smoke` | Not run: needs LM Studio and the station server. |

The gate is therefore **not** fully re-passed. Re-run the last two with the
intended model loaded before calling this release state certified.
