# Contributing

Thanks for helping. Bug reports, fixes and small improvements are all welcome.
For anything large, such as a new provider, a new show format or a change to
the pipeline, please open an issue first so we can agree on the approach.

## Setting up

You need Node.js 22.13 or newer. Follow the
[quick start](README.md#quick-start), then confirm your setup with:

```bash
npm run doctor
```

You do not need a model or voices to work on most of the code. The tests below
run fully offline.

## Before you open a pull request

Run the same checks as CI:

```bash
npm run typecheck
```

```bash
npm run selftest
```

```bash
npm run automation-selftest
```

```bash
npm run build
```

If your change affects what a show sounds like or how the hosts talk, also
generate a real show with a local model, using `npm run e2e -- "a topic"` or
the Studio, and say in the pull request which model and speech engine you
used.

## Guidelines

- **Add a test with a fix.** Most offline tests live in `scripts/selftest.ts`.
  A bug that reached the air should get a regression check there.
- **Keep it local.** The station must work with no account, no API key and no
  cloud service. Cloud providers stay optional and off by default.
- **Never commit generated or personal files.** That means shows, music, ads,
  memory, `config.json`, `.env` or anything under `tools/`. The `.gitignore`
  already covers these; please don't work around it.
- **Target small models.** Changes to prompts should still work on an 8B
  instruct model. The [guide](docs/GUIDE.md) explains the tricks the pipeline
  relies on and why.
- **No new native dependencies.** All audio work is done in TypeScript, so
  there is nothing like ffmpeg to install. Please keep it that way.
- Match the style of the surrounding code. TypeScript is strict; `npm run
  typecheck` must pass.

## Reporting a bug

Use the bug report template and include the output of `npm run doctor`. It
lists your Node version, operating system, model server and speech engine,
which answers most of the first questions.

Security problems should be reported privately; see [SECURITY.md](SECURITY.md).
