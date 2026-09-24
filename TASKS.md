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
- [ ] 5. Checkpoint show drafts and support recovery after interruption.
  - Acceptance: completed turns survive a restart and can be recovered or resumed.
- [ ] 6. Replace full-show in-memory mixing with bounded or chunked processing.
  - Acceptance: long shows do not allocate several complete mono and stereo copies in memory.
- [x] 7. Use atomic writes for configuration, show metadata, and all memory indexes.
  - Acceptance: interrupted writes leave either the previous valid file or the complete new file.
- [x] 8. Validate generation job IDs and reject collisions before creating paths or cancellation state.
  - Acceptance: unsafe and duplicate IDs receive a clear client error.
- [ ] 9. Initialize source control with generated and private files excluded.
  - Acceptance: source changes can be reviewed and reverted without tracking shows, music, secrets, models, or rendered media.

## Performance

- [ ] 10. Support a smaller performer model while reserving a larger model for planning.
  - Acceptance: host, producer, notes, and commercial model roles are explicit and measurable.
- [~] 11. Make warm-up cover-aware and prepare only the speaker needed next.
  - Acceptance: warm-up runs only beneath enough playable material and never blocks a waiting foreground turn.
- [ ] 12. Make title and summary generation optional or deferred.
  - Acceptance: Fast Live can finish without another blocking model call after the conversation.
- [ ] 13. Add Fast Live, Balanced, and Produced performance profiles.
  - Acceptance: each profile clearly controls planning, memory, notes, imaging, and warm-up costs.

## Showrunner additions

- [ ] 14. Build a control-room view of the upcoming log, current queue, next speaker, breaks, and estimated wait.
- [ ] 15. Add an interrupted-show recovery screen and resume workflow.
- [ ] 16. Add commercial rotation rules for replay spacing, sponsor separation, source weighting, favorites, and quarantine.
- [~] 17. Add regression coverage for bucket cardinality, play accounting, stale models, uncovered warm-up, duplicate jobs, and interrupted mixing.

Legend: `[ ]` queued, `[~]` in progress, `[x]` complete.
