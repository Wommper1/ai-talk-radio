# Station readiness — 6 GB VRAM / 32 GB RAM

Reviewed and updated September 27, 2026 for the station machine (GTX 1660,
6 GB VRAM, 32 GB system RAM) and LM Studio.

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

## Optional wish list (not launch blockers)

- [x] Add a loudness meter and export target in LUFS for matching external
  playout systems.
- [x] Add an A/B voice audition panel for Andrew, Brian, Emma, and Ava before
  changing the permanent cast.
- [ ] Add scheduled unattended recording after the station has completed a
  few supervised full-show burn-in runs.
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
npm run ttstest -- edge
npm run dialogue-smoke
npm run phase-smoke
```

The voice audition files are written to `output/ttstest/` and may be cleared
from the Files screen without affecting finished shows.
