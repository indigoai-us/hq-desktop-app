# Performance budgets (static guards)

`scripts/perf-budget-contract.test.ts` pins a set of performance fixes as shape
assertions over source text, so they cannot be undone silently. It runs in about
a second and is part of `pnpm test:scripts` (and therefore of the existing CI
frontend job — no new required check was added for it).

```bash
pnpm perf:lint      # these guards + the harness statistics tests
pnpm test:scripts   # all script contract tests, including these
```

For the runtime measurement harness, see
**[docs/performance-diagnostics.md](./performance-diagnostics.md)**, which also
explains *why* the app was choppy. Short version: native glass and CSS blur
stacking, a 5-second session scan that never idled, presence/timer churn
rewriting state in the background, and layout-animating transitions.

## Scope

Only `packages/ui/src` is treated as "the live shell".
`apps/sync/src/desktop-alt/` (`v4/`, `panels/`, `pages/`, `styles/`) is **dead
code** — `apps/sync/src/desktop-alt/boot.ts` hard-returns `'hq-work'`, so the
`@hq/ui` workspace is the only shell that ever mounts. Budgeting dead CSS would
generate busywork with no user-visible payoff. A guard asserts that boot.ts
still hard-returns, so if desktop-alt ever comes back to life the scope decision
gets revisited rather than quietly forgotten.

## What each guard protects

### 1. No persistent CSS `backdrop-filter` on always-on chrome

The window is transparent with a real macOS glass layer behind it. A CSS
`backdrop-filter` on top is a **second** per-frame GPU blur of the same pixels.
On a permanently visible full-height surface that is a full-surface repaint on
every hover and scroll tick.

Transient surfaces (popovers, context menus, dialogs, the command palette,
tooltips, the emoji picker) are allowed — they exist for a few hundred
milliseconds and the frost is what makes them read as a floating layer.

Named guards: `.chat-sidebar` (`packages/ui/src/chat/ChatSidebar.svelte`), the
files rail (`packages/ui/src/files/FilesModeSidebar.svelte`) and `.launch-btn`
(`packages/ui/src/chat/SetupChannelIntro.svelte`) must stay blur-free. The fix
is to carry the extra alpha in the background colour (`--side-bg`).

### 2. No layout-animating transitions

Fails on `transition:` / `transition-property:` naming `width`, `height`, `top`,
`left`, `right`, `bottom`, `margin*`, `padding*`, `flex-basis`, or on
`transition: all` (which opts in every property anyone adds later). These run
style + layout + paint on the main thread for every frame of the transition;
`transform` and `opacity` are composited on the GPU.

The reference pattern is `packages/ui/src/projects/ProjectRow.svelte`: set a
`--fill` ratio, then `transform: scaleX(var(--fill, 0))` with
`transform-origin: left`.

### 3. No non-composited keyframe animation

Fails on `@keyframes` blocks animating `background-position`, `background-size`,
`width`, `height`, `top`/`left`/`right`/`bottom` or `box-shadow`. A keyframe
animation runs for its whole duration — usually `infinite`, as with a loading
shimmer — so a non-composited property burns main thread for as long as the
element is on screen. Only `transform` / `opacity` / `filter` / colour are
allowed. A `background-position` shimmer becomes a gradient overlay moved with
`transform: translateX()`.

### 4. Poll-interval floors

- The Rust constants in `crates/hq-desktop-core/src/sessions/mod.rs` —
  `SESSIONS_POLL_INTERVAL_SECS` and `SESSIONS_HIDDEN_POLL_INTERVAL_SECS` — are
  pinned as **minimums** at their post-fix values. Raise them freely; never
  lower them.
- No `setInterval` in `packages/ui/src` or `packages/core/src` may tick faster
  than 10 seconds without an allowlist entry. Periods are resolved through
  repo-wide numeric constants, so `setInterval(tick, POLL_INTERVAL_MS)` is
  checked too.
- The two stores fixed in the perf pass (`chat/agency-store.svelte.ts`,
  `sessions/sessions-store.svelte.ts`) must still reference `visibilitychange`
  or `visibilityState`: a long-lived poller has to stop while the window is
  hidden.

### 5. Broadcast-emit discipline (Rust)

`app.emit(...)` wakes **every** open webview — the `main` controller, the
desktop window, the banner — even when only one subscribes. The count of broadcast `.emit(` sites in
`apps/sync/src-tauri/src` is pinned as a **ceiling that ratchets down, never
up**; new event plumbing should use `emit_to(label, …)`.

Also asserted: the sync progress path keeps its time-based coalescer
(`SYNC_PROGRESS_EMIT_INTERVAL` + `with_progress_coalescer`), and
`commands/sessions.rs` still skips emitting an unchanged snapshot
(`emit_snapshot_if_changed`).

### 6. Native glass idempotency

`apps/sync/src-tauri/src/glass.rs` must keep its `GLASS_VIEW_IDENTIFIER` tag,
the `content_has_glass_backing` pre-insert lookup and the early return.
Without them, every window re-open inserts **another** `NSGlassEffectView`, so a
window opened ten times composites ten stacked blur layers.

### 7. Release build profile

`apps/sync/src-tauri/Cargo.toml` `[profile.release]` keeps `lto` enabled and
`codegen-units = 1` (the hot native paths are split across crates and do not
inline without them). `apps/sync/vite.config.ts` keeps `build.target` at
`safari16` or newer — the shipping WKWebView is Safari 16.4+, and down-levelling
re-adds polyfills the app then has to download, parse and run — and keeps the
`manualChunks` `hq-shared` chunk, without which each HTML entry bundles its own
copy of Svelte and the `@hq/*` UI.

### 8. Bundle size

Tracked by the runtime harness rather than as a separate static check: `pnpm
perf` measures the total JS of the built harness and compares it against
`scripts/fixtures/perf-baseline.json` with the same generous tolerance as every
other metric (25% plus a 50 KB absolute floor). See
[performance-diagnostics.md](./performance-diagnostics.md) for how to regenerate
the baseline.

## Console rail

`pnpm perf:rail` runs the same production harness as `pnpm perf` and then
judges the run against the console-rail reference at
`scripts/fixtures/perf-baseline.console-rail.json`. The shared
`scripts/fixtures/perf-baseline.json` (2026-09-08, M5 Max, 25% noise band)
stays the baseline for `pnpm perf`. The rail file is a re-record at the
`feat/console-rail` branch point, with the machine context in `machine`.

The rail tightens the numbers a person feels on every screen. The old harness
allows 25% before it calls a change a regression. The rail allows 10% on cold
start, because the rail is on every window.

| Check | Limit | Why |
| --- | --- | --- |
| Cold start, shell usable | reference median + 10% (about 160 ms on the 2026-09-08 harness) | Start is the first thing the window has to do. |
| First contentful paint | reference median + 10% (about 170 ms) | Same reason: paint before the shell is usable. |
| Company switch to cached Atlas paint | p95 ≤ 100 ms | Switching company is a navigation, and the destination is already cached. |
| Switch conversation | product target p95 ≤ 50 ms (2026-09-08 p95 was 49 ms). The gate is the worse of that target and the US-001 recording, because four samples make p95 equal the worst sample. | The message list is the home surface. |
| Command palette | product target p95 ≤ 20 ms, same gate rule as conversation switch. The clock stops on the first painted frame in which the palette input is visible (the input has a box and is not under `[hidden]`), which is one `requestAnimationFrame` after that, not the second frame after the key press. A trace of the open is about 3 ms of main-thread work (dispatch, style, layout, paint); the rest of the sample is the wait for that frame. | It is summoned constantly and has to feel instant. |
| Scroll dropped frames | ≤ 1% in Messages and every sidepane; worst frame ≤ 33 ms | A dropped frame is the original choppy-scroll complaint. |
| Idle main-thread busy | 0 ms | No new pollers. Presence keeps using the stores that already exist. |
| Initial JS | reference + 150 KB (2026-09-08 reference 2,486,977 bytes, about 6%) | The rail is added to every screen, so the boot bundle can grow a little and no more. |
| Lazy chunks | Atlas ≤ 120 KB, Telemetry ≤ 80 KB, neither in the initial JS | Those two views are the heavy ones, so they load only when opened. |

Company switch and sidepane switch stay skipped, with a TODO, until the
controls exist (US-004 and US-009 for the company tile, US-006 for the
sidepane host). The lazy-chunk check runs now: the Vite manifest must not
place `packages/ui/src/atlas` or `packages/ui/src/telemetry` in the entry's
static import graph.

`scripts/perf-budget-contract.test.ts` fails if the shell entry
(`packages/ui/src/index.ts` or `packages/ui/src/shell/DesktopApp.svelte`, and
anything they import statically) reaches those directories. A dynamic
`import()` is the allowed path.

The harness, the manifest, and these guards are dev-time only. None of them
are imported by the shipped shell.

## Requesting an exception

Every rule is allowlisted, never absolute. Add your entry to the relevant
allowlist in `scripts/perf-budget-contract.test.ts` **with a comment saying why
the cost is acceptable** — transient surface, user-invisible, no cheaper
equivalent. A silent allowlist entry is worse than no guard at all: the next
person to read the list cannot tell a considered exception from a drive-by
suppression.

Two of the allowlists (`LAYOUT_TRANSITION_ALLOWLIST`, `KEYFRAME_ALLOWLIST`) are
marked **known debt** — pre-existing offenders on low-traffic surfaces that were
left for a follow-up rather than dragged into a perf pass that had to stay
reviewable. Those lists may only ever shrink.

## Testing the guards

The detectors are pure functions over file *content* strings
(`scripts/perf/style-budget.ts`, `scripts/perf/poll-budget.ts`), and the
`detectors (inline fixtures)` block exercises each one against both a passing
and a failing fixture. Every repo-level assertion has also been mutation-tested
(pins moved, allowlists emptied) and observed to fail. Do not add a guard you
have not watched fail.
