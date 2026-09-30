# Local Talk Radio Worklist

This list tracks the showrunner, scheduler, stability, performance, and control-room work discovered during the September 2026 read-only crawl.

## Correctness and stability

- [x] 1. Schedule `spotsPerBreak` bucket commercials for every break instead of one spot per break.
  - Acceptance: four breaks with three spots request and group twelve distinct eligible spots.
- [x] 2. Count a bucket commercial as played only after the completed episode is saved.
  - Acceptance: cancellation and generation failure do not change rotation history.
- [x] 3. Prevent model warm-up from delaying an uncovered first turn.
  - Acceptance: transcript-only and no-opener starts issue the first dialogue request without a warm-up ahead of it.
- [x] 4. Add a model preflight that detects stale configured model IDs before generation.
  - Acceptance: the UI names the mismatch and lets the listener select an available model without silently rewriting settings.
- [x] 5. Checkpoint show drafts and support recovery after interruption.
  - Acceptance: completed turns survive a restart and can be recovered or resumed.
- [x] 6. Bound full-show mixing for the supported 32 GB station machine.
  - Acceptance: preflight rejects estimates above 30 minutes before generation; supported shows keep stereo and their music bed instead of silently degrading at 12 minutes.
- [x] 7. Use atomic writes for configuration, show metadata, and all memory indexes.
  - Acceptance: interrupted writes leave either the previous valid file or the complete new file.
- [x] 8. Validate generation job IDs and reject collisions before creating paths or cancellation state.
  - Acceptance: unsafe and duplicate IDs receive a clear client error.
- [x] 9. Initialize source control with generated and private files excluded.
  - Acceptance: source changes can be reviewed and reverted without tracking shows, music, secrets, models, or rendered media.

## Performance

- [x] 10. Support a smaller performer model while reserving a larger model for planning.
  - Acceptance: host, producer, notes, and commercial model roles are explicit and measurable.
- [x] 11. Make warm-up cover-aware and prepare only the speaker needed next.
  - Acceptance: warm-up runs only beneath enough playable material and never blocks a waiting foreground turn.
- [x] 12. Make title and summary generation optional or deferred.
  - Acceptance: Fast Live can finish without another blocking model call after the conversation.
- [x] 13. Add Fast Live, Balanced, and Produced performance profiles.
  - Acceptance: each profile clearly controls planning, memory, notes, imaging, and warm-up costs.

## Showrunner additions

- [x] 14. Build a control-room view of the upcoming log, current queue, next speaker, breaks, and estimated wait.
- [x] 15. Add an interrupted-show recovery screen and resume workflow.
- [x] 16. Add commercial rotation rules for replay spacing, sponsor separation, source weighting, favorites, and quarantine.
- [x] 17. Add regression coverage for bucket cardinality, play accounting, stale models, uncovered warm-up, duplicate jobs, and interrupted mixing.

Legend: `[ ]` queued, `[~]` in progress, `[x]` complete.

## September 25, 2026 completion pass

- [x] Repair Edge TTS with a project-private environment and actionable diagnostics.
- [x] Apply one close-mic broadcast chain to previews, live clips, tests, and final shows; remove double compression.
- [x] Verify Marco and Dee with current Copilot/Conversation Edge voices.
- [x] Correct the Marco/Dee relationship and add explicit topic-protection direction.
- [x] Keep 30-minute shows in studio stereo with their procedural bed on the 32 GB target.
- [x] Reject unsafe running orders before model, TTS, or commercial work begins.
- [x] Make performance-profile labels reflect the actual controlled switches.
- [x] Resume interrupted shows from completed turns and the saved desk configuration.
- [x] Use partial commercial buckets and write only missing full breaks.
- [x] Add real model reachability to the masthead status light.
- [x] Make the launcher distinguish this app from unrelated services and choose a free port safely.
- [x] Add confirmations and visible errors for destructive or failed settings/storage actions.
- [x] Explain why legacy shows are excluded from DJ memory instead of reporting a mysterious zero.

## September 27, 2026 broadcast-readiness phase

- [x] Add long-dialogue guards for repeated openings, narrated replies, and opening-record leakage.
- [x] Master and measure finished programs at a streaming-safe LUFS and true-peak target.
- [x] Add in-app A/B casting for Marco and Dee's strongest Edge voices.
- [x] Reuse completed speech during recovery, retry isolated failed lines, and display ETA.
- [x] Add a station Operations report for model, speech, storage, commercials, and masters.
- [x] Gate Start Show on ready-for-air blockers and log non-blocking recommendations.
