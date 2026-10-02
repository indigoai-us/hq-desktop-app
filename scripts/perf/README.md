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

`pnpm perf` (`scripts/perf-run.mjs`) is the broader scroll and idle harness. Its runs land in gitignored `perf-results/`.
