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

`app.emit(...)` wakes **every** open webview — popover, main window, banner —
even when only one subscribes. The count of broadcast `.emit(` sites in
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
