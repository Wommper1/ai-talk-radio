# Studio burn-in checklist

Started September 26, 2026. Existing shows and media are preserved.

- [x] 1. Confirm LM Studio, the selected 8B DJ model, and Edge voices are reachable.
- [x] 2. Render matched A/B auditions for Marco (Andrew/Brian) and Dee (Emma/Ava) through the real broadcast chain.
- [x] 3. Run a 12-turn Produced episode with music, stereo imaging, live neural speech, and two commercial breaks.
- [x] 4. Measure the controlled episode: dialogue quality, drift, repetition, render format, peak level, clipping, live-audio completeness, and final artifacts.
- [x] 5. Repair any issue exposed by the controlled episode and rerun the affected check.
- [x] 6. Run the normal 24-turn, four-break station configuration as the final 6 GB VRAM / 32 GB RAM stress test.
- [x] 7. Measure the full episode, record the result, and update the station readiness notes.

Completion means both shows save successfully, every DJ turn has audio, the
finished files are 48 kHz / 24-bit stereo, no sampled PCM value clips, and the
transcript audit finds no blocking topic-drift or repetition failure.

## Results in progress

- Voice A/B: all four candidates rendered successfully. Andrew remains the
  best written match for Marco's warm/confident lead role; Emma remains the
  best match for Dee's clear/conversational counterpoint. Brian and Ava are
  preserved in `output/voice-audition/` for human auditioning.
- Controlled run: the first attempt exposed intermittent Edge WebSocket/CLI
  failures on long Marco lines. Edge requests are now serialized station-wide
  and retried up to four times with exponential backoff.
- Controlled rerun: passed in 233.8 seconds. All 12 turns had live audio; the
  832.7-second finished show is 48 kHz, 24-bit stereo with peak 0.8930 and no
  sampled clipping. Dialogue scored 91/100 overall, 88 for repetition control,
  and 100 for drift control. Show id:
  `2026-09-27-phone-free-dining-tapping-deeper-connections-a890e7`.
- Full stress run: passed in 465.8 seconds. All 24 turns had live audio and all
  four scheduled breaks completed (five break-audio events including the
  opening record). The 1,467.7-second finished show is 48 kHz, 24-bit stereo
  with peak 0.8784, RMS 0.1206, and no clipping in 4,025,642 sampled PCM values.
  Dialogue scored 92/100 overall, 70 for repetition control, and 100 for drift
  control. Two complete breaks came from the bucket and only the missing two
  were written live. Show id:
  `2026-09-27-phone-free-tables-restaurants-future-6e6740`.

All seven burn-in tasks are complete. The 70 repetition score is a passing
result, but the audible repeated openings remain a quality-improvement item,
not a launch blocker.
