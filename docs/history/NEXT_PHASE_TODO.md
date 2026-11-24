# Next production phase — tasks 1 through 6

Started September 27, 2026. This phase improves the program listeners hear;
the completed stability burn-in remains documented separately.

1. [x] **Human dialogue guard** — diversify long-show openings, stop hosts from
   narrating or parroting the other host, and keep record titles/artists from
   being mistaken for people, businesses, or discussion examples.
2. [x] **Broadcast loudness master** — measure integrated program loudness and
   true peak, provide a safe streaming target, and save those measurements with
   every finished show.
3. [x] **Voice casting panel** — audition Andrew/Brian and Emma/Ava inside the
   app using the same script and the real studio processing chain, then apply a
   selected voice to a host.
4. [x] **Production recovery controls** — expose useful stage/ETA information,
   preserve completed speech work, and allow a failed line to be retried
   without throwing away the whole show.
5. [x] **Station operations report** — show storage headroom, model/TTS health,
   recent show quality, commercial readiness, and actionable warnings in one
   operator view.
6. [x] **Ready-for-air gate** — run the important preflight checks before an
   unattended production and clearly separate blockers from recommendations.

## Completion standard

Each task needs implementation, automated coverage, a production build, and a
live check against the station configuration. Existing shows, commercials,
music, memory, and configuration are preserved.

## Work log

- Task 1 completed. The live 12-turn LM Studio dialogue check scored 99/100,
  with 97 repetition control, 100 drift control, zero opening-record leaks,
  and zero narrated co-host replies. It also exposed and fixed an unclosed
  private Director's-note fragment before it could reach speech.
- Task 2 completed. Every finished master is now measured and saved with
  integrated LUFS, sample peak, intersample true peak, applied gain, and a
  streaming-readiness result. The live validation master measured -17.2
  LUFS-I and -1.0 dBTP.
- Task 3 completed. Settings now auditions Andrew/Brian for Marco and
  Emma/Ava for Dee with identical copy through the real studio voice chain.
  The live Andrew and Emma checks rendered in about 1.2 seconds apiece.
- Task 4 completed. Studio shows a measured ETA, resume reuses valid speech
  WAVs already on disk, and failed speech is retried one line at a time.
  Resume and missing-turn behavior are covered by automated showrunner tests.
- Task 5 completed. The Operations view reports model, voice, storage,
  running-order, commercial, recent-master, and incomplete-folder health.
  The final report found 406.5 GB free and no blocker.
- Task 6 completed. Start Show now runs the ready-for-air gate first. A live
  deliberately missing model was refused, while the real station configuration
  passed with six green checks, two recommendations, and zero blockers.
- Final live phase smoke completed 4/4 LM Studio turns and 4/4 neural voice
  clips in 58.7 seconds. `npm run doctor`, `npm run typecheck`, the full
  self-test suite, production build, and `git diff --check` all passed.
