# apps/web E2E tests (Playwright)

Layout:

```
apps/web/
  playwright.config.ts        # projects: "smoke" (browser) and "canary" (network-only)
  e2e/
    smoke.test.ts             # app-shell smoke tests (run on every PR)
    canary/
      v1-updater-stream.test.ts   # live-path guard: V1 latest.json must serve 0.10.x
    stories/
      {STORY-ID}.test.ts      # per-story acceptance tests (added by /execute-task
                              # acceptance-test-writer; one describe block per story,
                              # one test per e2eTests entry in prd.json)
```

## Running

```bash
cd apps/web
pnpm exec playwright install chromium   # one-time browser install
pnpm exec playwright test --project=smoke    # builds + previews the app, runs browser tests
PW_NO_SERVER=1 pnpm exec playwright test --project=canary   # network-only, no server
```

The `smoke` project starts `pnpm build && pnpm preview --port 4173` automatically
(see `webServer` in `playwright.config.ts`). Set `PW_NO_SERVER=1` to skip the
server for network-only runs.

## Conventions

- Story acceptance tests live in `e2e/stories/{STORY-ID}.test.ts` with a
  `test.describe("{STORY-ID}: {title}")` block and one `test()` per `e2eTests`
  entry from the PRD. They run under the `smoke` project on every PR and act as
  regression guards for later stories.
- Unit tests stay in `src/**/*.test.ts` (vitest); Playwright owns `e2e/` only.
- The canary (`e2e/canary/`) guards the live V1 updater stream and runs on a
  schedule via `.github/workflows/canary.yml`. Never loosen its assertion —
  only the future deliberate-cutover project may retire it.

## CI

- PRs: `.github/workflows/ci.yml` runs the `smoke` project (includes `stories/`).
- Schedule: `.github/workflows/canary.yml` runs the `canary` project every 2
  hours and opens/refreshes a `canary`-labeled issue on failure.
