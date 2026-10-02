# scripts/perf

Local measurements. They are not a CI gate.

`console-rail-baseline.mjs` records three numbers for the console shell:

- cold-start first contentful paint of the main shell
- time until the Messages view is interactive (conversation rail or new-message control)
- production JS and CSS bytes of that shell build (`packages/ui` DesktopApp mounted by `apps/sync`)

It reuses `harness-build.mjs` and Playwright from `apps/sync`. It does not launch the native Tauri process.

```bash
pnpm install --frozen-lockfile
pnpm --dir apps/sync exec playwright install chromium
node scripts/perf/console-rail-baseline.mjs
```

Output: `reports/perf/baseline-<YYYY-MM-DD>.json`.

`pnpm perf` (`scripts/perf-run.mjs`) is the broader scroll and idle harness. Its runs land in gitignored `perf-results/`. The committed comparison file is `scripts/fixtures/perf-baseline.json`.

`pnpm perf:rail` is the same harness plus three console-rail scenarios, judged against `scripts/fixtures/perf-baseline.console-rail.json`:

- company switch (click a company tile). Skipped until US-004 and US-009 add the tile and the Atlas landing.
- sidepane switch (Home to company and back), timed once the US-006 sidepane host is mounted.
- lazy-chunk check. Atlas and telemetry must be absent from the initial JS graph (Vite manifest). Size limits: Atlas 120 KB, telemetry 80 KB.

```bash
pnpm perf:rail
pnpm perf:rail -- --reps 5 --record-reference
```

`--record-reference` rewrites only the console-rail fixture. It does not touch `perf-baseline.json`.

### `@hq/work` build and the `https` package

`pnpm test` builds `@hq/work`. Vite's SSR bundle of `mqtt` (imported from `packages/core`) used to fail with `Failed to resolve entry for package "https"` because mqtt's Node entry imports the `https` builtin by bare name. `apps/work/vite.config.ts` marks those builtins external on the SSR build (`externalize-node-builtins`). The client build is unchanged and still takes mqtt's browser entry.
