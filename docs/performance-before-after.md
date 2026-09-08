# Before / after: the UI-smoothness batch

Branch `perf/ui-smoothness` (8 commits, `7a0f7dd0..05fd3acd`). Base `7a0f7dd0`
(= `origin/main`).

**Headline: the timing numbers in this document are NOT trustworthy, and are
published as "could not measure" rather than as results.** The measurement
machine was heavily contended throughout the attempt and changed power state
mid-sequence. One metric — bundle size — is deterministic and is reported as a
real result. It got slightly *worse*.

Read the [honesty section](#what-this-does-not-measure) before quoting anything
here.

---

## Method

The harness (`pnpm perf`) only exists on the fixed branch, so it has post-fix
numbers and no true "before". To get one:

1. A second worktree was created at the base commit
   (`git worktree add --detach … 7a0f7dd0`) and `pnpm install --frozen-lockfile`
   run in it.
2. Only the **runtime** harness was copied in from `05fd3acd`: `scripts/perf/`,
   `scripts/perf-run.mjs`, the `perf` entry in root `package.json`, and the
   `perf-results/` gitignore line. **No application source was copied** — the
   whole point is to measure the OLD app code with the NEW measuring tool.
3. Deliberately **not** copied: `scripts/perf-budget-contract.test.ts` (it
   asserts post-fix source and fails by design on old code) and
   `scripts/fixtures/perf-baseline.json` (post-fix numbers; leaving it out makes
   the before-run report raw values instead of a meaningless comparison).

### The harness needed no modification to run on the base commit

This is worth recording, because it was the main risk going in. Every DOM hook
the harness depends on already exists at `7a0f7dd0`:

| harness dependency | at base? |
|---|---|
| `apps/sync/dev-harness/` entry + all seven mocked Tauri/Sentry modules | yes |
| `data-testid="chat-sidebar"`, `chat-conversation-list`, `desktop-shell` | yes |
| `data-testid="conversation-thread"`, `conversation-composer` | yes |
| a Cmd-K handler for the command-palette metric (`DesktopApp.svelte:3650`) | yes |

So the before-tree runs the identical measuring tool against old app code, with
no compatibility shims and no judgement calls. The harness is genuinely portable
backwards. `scroll · rail` is reported as skipped on **both** trees for the same
documented reason (the committed fixtures do not overflow the rail) — that is a
pre-existing gap in the fixtures, not a difference between the trees.

---

## Machine context and power state

| | BEFORE pass 1 | AFTER pass 1 |
|---|---|---|
| commit | `7a0f7dd0` | `05fd3acd` |
| settings | `--reps 7 --idle-secs 30` | `--reps 7 --idle-secs 30` |
| reps kept (warm-up discarded) | 6 | 6 |
| CPU | Apple M5 Max, 18 cores | Apple M5 Max, 18 cores |
| memory | 128 GB | 128 GB |
| OS / Chromium | macOS 26.4 · Chromium 151.0.7922.34 | macOS 26.4 · Chromium 151.0.7922.34 |
| **power source** | **battery (25%)** | **AC** |
| **1-minute load average** | **20.07** | **33.3** |

Those last two rows are why this document reports no timing deltas.

Both trees were measured with a **clean** working tree at the commits named
above. (The perf worktree acquired uncommitted edits from a concurrent session
at 14:12–14:14 local, after the after-pass finished at ~13:48; file mtimes were
checked to confirm the measured build predates them. Only this document was
committed.)

- The two passes ran in **different power states**. `docs/performance-diagnostics.md`
  states plainly that a MacBook on battery throttles the GPU and parks
  efficiency cores, and that the same commit can measure 40% slower with the
  charger out. The charger was plugged in between the before and after passes by
  someone using the machine.
- Both passes ran at a **load average of 20–33 on an 18-core machine**, i.e.
  fully oversubscribed. A live Zoom call with camera, a `rustc` build, and other
  interactive work were running concurrently and were outside this measurement's
  control. The harness asks for a quiet machine; it did not get one.
- The intended protocol was **two passes per tree, interleaved
  (before, after, before, after)** so run-to-run variance would be visible. That
  protocol was **not completed** — conditions never settled. Roughly 95 minutes
  were spent waiting for load to fall below 5 on AC power; it never did.

---

## Comparison table

`n/t` = **not trustworthy**: the number was produced by a real run on this
machine, but under conditions that invalidate the comparison (see above). It is
shown only so the reader can see what was actually recorded — **not** as a
result.

| metric | before (median) | before p95 | after (median) | after p95 | change | verdict |
|---|---|---|---|---|---|---|
| cold load · first contentful paint | 234.0 ms | 244.0 | 226.0 ms | 432.0 | −8.0 ms (−3.4%) | **n/t** — power state differs; after-pass stdev 105.9 ms |
| cold load · largest contentful paint | 242.0 ms | 268.0 | 242.0 ms | 464.0 | 0.0 ms (0.0%) | **n/t** — stdev 116.4 ms |
| cold load · shell usable | 221.5 ms | 298.2 | 222.3 ms | 441.2 | +0.8 ms (+0.4%) | **n/t** — stdev 123.4 ms |
| scroll · messages · avg frame | 8.4 ms | 8.5 | 8.4 ms | 8.6 | +0.0 ms (+0.5%) | **flat** (see note) |
| scroll · messages · worst frame | 29.7 ms | 41.0 | 25.0 ms | 58.3 | −4.7 ms (−15.8%) | **n/t** — stdev 6.5 / 15.3 ms |
| scroll · messages · dropped frames | 0.53 % | 0.53 | 0.53 % | 0.53 | 0.00 pp | **flat** (see note) |
| scroll · rail · avg / worst / dropped | — | — | — | — | — | **not measurable on either tree** — committed fixtures do not overflow the rail |
| interaction · switch conversation | 76.9 ms | 98.0 | 89.1 ms | 141.7 | +12.2 ms (+15.9%) | **n/t** — stdev 20.1 / 27.1 ms |
| interaction · command palette | 38.9 ms | 69.6 | 15.8 ms | 22.1 | −23.1 ms (−59.4%) | **n/t** — before stdev 20.1 ms |
| interaction · composer keystroke | 14.9 ms | 15.8 | 17.1 ms | 19.4 | +2.2 ms (+14.8%) | **n/t** |
| idle · main-thread busy | 0.0 ms | 0.0 | 0.0 ms | 0.0 | 0.0 ms | **flat at zero on both** — see below |
| idle · main-thread busy (%) | 0.00 % | 0.00 | 0.00 % | 0.00 | 0.00 pp | **flat at zero on both** |
| idle · render batches | 0.0 /min | 0.0 | 2.0 /min | 2.0 | **+2.0 /min** | **WORSE / inconclusive** — see below |
| bundle · total JS | 2,475,669 B | — | 2,486,977 B | — | **+11,308 B (+0.46%)** | **WORSE — real, deterministic** |

### The two results that do survive the noise

**`bundle · total JS` got worse: +11,308 bytes (+0.46%).** This metric is a byte
count over the production build output. It does not depend on load, power state,
or thermal condition, so it is the one number in this table that is fully
trustworthy. The batch added roughly 11 KB of JavaScript — the keyboard-shortcut
registry and cheat sheet (`6b4d23db`) is the obvious candidate. This is a small
and probably fair price, but it is a regression on this axis and it should not be
buried: the batch made the shell marginally bigger to download, parse and
compile.

**`idle · main-thread busy` is 0.0 ms on BOTH trees.** This is not a measurement
failure and it is not a null result — it is the expected one, and it is the
clearest evidence in this document for the honesty section below. The idle churn
this batch attacked (the 5-second session scan that never idled, and the
snapshot re-emission) lived in **Rust**, behind the Tauri IPC boundary that the
harness *mocks out*. The webview cannot see it, before or after. The old code
therefore looks exactly as idle as the new code through this lens, while being
materially busier in the real app.

**`idle · render batches` moved the wrong way (0 → 2 /min).** Reported here
rather than buried. Two caveats keep this from being a clean "regression": the
post-fix value of ~2/min is what `docs/performance-diagnostics.md` documents as
healthy and is what the committed baseline records, and a *zero* on the before
tree is more likely a measurement artefact of a saturated machine (batches that
never got scheduled during the sample) than evidence that the old code idled
better. It needs a re-run on a quiet machine before anyone concludes anything.

**The two "flat" scroll rows are genuinely flat, and that is informative.**
`scroll · messages · avg frame` is 8.4 ms on both trees and `dropped frames` is
0.53% on both — with a stdev of 0.0–0.1 ms, i.e. these are the *least*
noise-sensitive timing numbers in the run, and they did not move. In the
Chromium harness, at this fixture size, the CSS work this batch removed was not
the thing holding back the average frame. The webview was already inside the
16.7 ms budget before the batch.

---

## What this means

For the metrics that *could* be read, in plain language:

- **Scroll smoothness** (`scroll · messages · avg frame`, `dropped frames`) —
  unchanged, and already healthy in the browser before the batch. Whatever
  choppiness users reported was not, on this evidence, the webview's average
  frame cost at this content size.
- **Time to open** (`cold load`, `shell usable`) — not measurable under these
  conditions. No claim either way.
- **Click-to-response** (`switch conversation`, `command palette`,
  `composer keystroke`) — not measurable under these conditions. No claim either
  way.
- **Background CPU when idle** (`idle · main-thread busy`) — zero on both, but
  only because the expensive idle work is native and mocked away here. The real
  idle win is not visible to this tool at all.
- **Download/parse cost** (`bundle · total JS`) — slightly worse, by 11 KB.

---

## What this does NOT measure

This is the most important section in the document.

**The harness drives the web/static shell in headless Chromium. It does not
drive the real Tauri window.** It loads `apps/sync`'s design harness at
`?view=shell&persona=indigo` with **mocked Tauri IPC** and committed fixtures.
That is a deliberate and correct choice for determinism, and it is stated in
`docs/performance-diagnostics.md` — but it means an entire half of this batch is
structurally invisible to every number above.

Concretely, these changes are **not reflected in these numbers at all**:

- **Idempotent glass backing** — Chromium has no `NSGlassEffectView`. The
  double-blur, and the stacking of a fresh glass view on every window re-open,
  cannot occur in the harness.
- **Window-visibility gating of the session poller** — the harness has no native
  window and no visibility state to gate on.
- **The filesystem watcher replacing the 5-second poll** — this is Rust behind
  the IPC boundary the harness mocks.
- **`FollowsWindowActiveState`** — a native macOS window property with no
  browser equivalent.

Two of the eight commits (`32d6d0f1`, `caff3737`) touch almost nothing *but*
`apps/sync/src-tauri/` and `crates/` — 1,382 changed lines of Rust that this
harness cannot observe.

**Those native-side wins were verified by tests and code inspection, not by
frame measurement.** No frame-level evidence is offered for them here, and none
should be inferred from this document. `docs/performance-diagnostics.md` records
the same gap as a known limitation and points at `scripts/native-visual-tour.mjs`
as the place a real native probe would go; that work has not been done.

Further limits:

- **Fixture size.** Scrolling is measured in a compact 900×520 window because the
  committed fixtures are small. These are per-frame costs for *these* components
  at *this* content size, not a claim about a real user's data volume.
- **rAF deltas, not a compositor trace.** Work after the callback lands on the
  next delta, and frames the compositor produced without the main thread are
  invisible.
- **One pass per tree, not two.** Run-to-run variance across passes was never
  characterised, because conditions never allowed the second pass. The per-run
  stdev column is the only variance signal available, and on the latency metrics
  it is large.

---

## How to finish this properly

The before-worktree was removed after this run. To redo it on a quiet machine
(the whole sequence is ~30 minutes):

```bash
git -C repos/public/hq-desktop-app worktree add --detach /tmp/hq-before 7a0f7dd0
cd /tmp/hq-before && pnpm install --frozen-lockfile
cp -R <perf-worktree>/scripts/perf scripts/perf
cp <perf-worktree>/scripts/perf-run.mjs scripts/
# add "perf": "node scripts/perf-run.mjs" to package.json; add perf-results/ to .gitignore
# do NOT copy scripts/perf-budget-contract.test.ts or scripts/fixtures/perf-baseline.json
```

Then, **on AC power, with load average below ~4, and nothing else running**, run
`pnpm perf --reps 7 --idle-secs 30` in each tree, sequentially, twice each, in
the order before / after / before / after. Confirm the `machine` block of every
resulting `perf-results/run-*.json` shows the same `powerSource` and a low
`loadAvg1m` before believing any delta.
