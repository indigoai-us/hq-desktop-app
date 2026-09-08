# Performance diagnostics

Two tools, deliberately kept separate:

| | what it is | when to run | cost |
|---|---|---|---|
| `pnpm perf` | a **local measurement harness** — real browser, real shell, real frame timings | before/after a change you think affects feel; when someone says "it got slower" | ~4 minutes |
| `pnpm perf:lint` | **static guards** over source text — no browser, no timing | any time; it is part of `pnpm test:scripts` | ~1 second |

Neither is a CI gate, and `pnpm perf` deliberately is not one: a shared GitHub
runner is a virtualised, GPU-less, noisy-neighbour machine, and frame timings
taken there would be neither trustworthy nor actionable. The static guards do
run in CI, but only as part of the existing `pnpm test:scripts` step — no new
required check was added.

---

## Why the app felt choppy

Worth reading once, because every metric below exists to catch one of these
coming back.

1. **Native glass + CSS blur stacking.** The window is transparent with a real
   macOS glass layer (`NSGlassEffectView`, `apps/sync/src-tauri/src/glass.rs`)
   painted behind the webview. Chrome that *also* carried a CSS
   `backdrop-filter` made the compositor blur the same pixels twice, per frame,
   for the element's whole box. On the always-on conversation rail that is a
   full-rail repaint on every hover and every scroll tick. Worse, the glass
   setup was not idempotent, so re-opening a window stacked another
   `NSGlassEffectView` on top of the last one.
2. **A session scan that never idled.** The Rust scanner walked every Claude /
   Codex session directory every 5 seconds, forever, whether the window was
   visible or not, and re-emitted a byte-identical snapshot each time — waking
   every subscriber for nothing.
3. **Presence / timer churn rewriting state.** Frontend stores ran their own
   sub-10-second `setInterval` refreshes that rewrote reactive state while the
   app sat in the background, re-running Svelte effects and the compositor with
   them.
4. **Layout-animating transitions.** `transition: width` on progress fills and
   `background-position` keyframe shimmers run style + layout + paint on the
   main thread every frame, forever, whether or not anyone is looking.

---

## `pnpm perf` — the measurement harness

```bash
pnpm perf                       # 5 repetitions, compared against the baseline
pnpm perf -- --reps 3           # faster, noisier
pnpm perf -- --idle-secs 10     # shorter idle sample (see the caveat below)
pnpm perf -- --skip-build       # reuse the last harness build
pnpm perf -- --headed           # watch it drive
pnpm perf -- --update-baseline  # record the current numbers as the new baseline
```

Output: a table on stdout, plus a timestamped JSON run under `perf-results/`
(gitignored) containing every sample and the machine context.

### What it drives

`apps/sync`'s design harness at `?view=shell&persona=indigo`, built for
production by `scripts/perf/harness-build.mjs`. That entry mounts the **real**
shell — `packages/ui`'s `DesktopApp`, with its real CSS, stores and effects —
against mocked Tauri IPC and committed fixture data, so a run is deterministic
and needs no network, no Cognito and no running `hq` daemon.

It is served by a plain static file server rather than `vite preview`, so the
bytes the browser receives are the bytes the app ships.

### Metrics

| metric | what it means | healthy today |
|---|---|---|
| `cold load · first/largest contentful paint` | browser paint timing from navigation start | ~150–200ms |
| `cold load · shell usable` | when the conversation rail is attached, i.e. there is something to click | ~150–200ms |
| `scroll · messages · avg frame` | mean `requestAnimationFrame` delta during a real wheel gesture | ~8ms (well inside the 16.7ms budget) |
| `scroll · messages · worst frame` | the single worst frame in the gesture — this is what a hitch feels like | ~17–25ms |
| `scroll · messages · dropped frames` | % of frames over the 16.7ms budget | <1% |
| `interaction · switch conversation` | input → next painted frame when clicking a rail row | ~45ms |
| `interaction · command palette` | input → next painted frame on Cmd-K | ~13ms |
| `interaction · composer keystroke` | mean per-character cost of typing in the composer | ~15ms |
| `idle · main-thread busy` | total time in >50ms long tasks while untouched for 30s | **0ms** |
| `idle · render batches /min` | DOM mutation batches (≈ render passes) while untouched | **~2/min** |
| `bundle · total JS` | bytes the shell downloads, parses and compiles | ~2.49 MB |

The idle numbers are the ones that catch a polling/churn regression coming
back. They should stay near zero; a store that starts refreshing in the
background shows up immediately.

### How the numbers are taken

**Frame timing uses in-page `requestAnimationFrame` deltas, not a CDP trace.**
Both were tried. `Tracing.start` with `devtools.timeline` gives DrawFrame /
Commit events, which are the truest picture of what the compositor did — but the
event names and nesting change between Chromium revisions, so a parser written
against one Playwright version silently reports zero frames against the next.
rAF deltas are stable API and answer the question directly: a callback that runs
33ms after the previous one *is* a dropped frame from the user's point of view.

The trade-off, stated plainly: rAF cannot see work that happens after the
callback (a long paint at the end of a frame lands on the *next* delta), and it
cannot see frames the compositor produced without the main thread. For a
main-thread-bound Svelte shell — which is exactly what a choppy build is — that
is the right lens.

Paint, LCP and long-task numbers come from `PerformanceObserver`, installed via
`addInitScript` before any app code runs.

**No source file was instrumented.** "Shell usable" is defined observably from
outside (the conversation rail is attached), not with a `performance.mark()`
added to app code — a diagnostic must not change the thing it measures, and
those files are owned by other work in flight.

### Noise discipline

- Every scenario runs N times (default 5); **the first run is discarded** as
  warm-up (cold module compile, empty HTTP cache, unwarmed JIT).
- Reported: **median** (robust to one hitchy run), **p95** (what actually feels
  bad), and **stdev** (whether to believe any of it).
- A regression is only declared when the median is **both** more than 25% worse
  **and** outside 2 standard deviations of the baseline **and** past a small
  absolute floor. All three, because a harness that cries wolf gets ignored.
- Each run records CPU model, core count, memory, 1-minute load average, power
  source (`pmset -g batt`) and Node version.

**Results are only comparable on the same machine in the same power state.** A
MacBook on battery throttles the GPU and parks efficiency cores; the same commit
can measure 40% slower with the charger out. Check the `machine` block of the
run file before believing a delta.

Idle metrics are additionally only compared when the run used the same
`--idle-secs` as the baseline; the harness says so rather than reporting a
spurious regression.

### Regenerating the baseline

```bash
pnpm perf -- --update-baseline
```

Writes `scripts/fixtures/perf-baseline.json` (committed). Do this on mains
power, with nothing heavy running, and say in the commit message which machine
it was taken on — the file records it, but a reader should not have to open it.
Update the baseline when you have *deliberately* changed performance, not to
silence a red run you have not explained.

### Known gaps

- **`scroll · rail` is usually skipped.** The committed fixtures hold a small
  conversation set, so the rail does not overflow and there is nothing to
  scroll. The harness reports it as skipped rather than inventing a zero. Richer
  fixtures would light it up.
- **Scrolling is measured in a compact 900×520 window** so the same real
  components are forced into overflow. That measures the per-frame cost of those
  components, not a claim about how much content a user has.
- **The native window is not measured.** Chromium has no `NSGlassEffectView`, so
  these scroll numbers are the *webview's* contribution only — a floor, not the
  whole truth. `scripts/native-visual-tour.mjs` drives the real app and is the
  obvious place to add frame capture, but the macOS side has no equivalent of
  rAF-from-outside: it would need either a `CVDisplayLink` probe compiled into a
  debug build or `WKWebView` evaluation of the same in-page collector. That is a
  real piece of work and is left as a documented follow-up rather than bolted on
  badly.

---

## `pnpm perf:lint` — the static guards

Fast, deterministic checks over source text, in the repo's existing
contract-test style (`scripts/ci-cost-contract.test.ts` and friends). They cost
nothing and catch the four structural regressions above at the moment someone
reintroduces them, with a failure message that explains what it prevents.

See **[docs/performance-budgets.md](./performance-budgets.md)** for what each
guard asserts, and for how to request an exception.
