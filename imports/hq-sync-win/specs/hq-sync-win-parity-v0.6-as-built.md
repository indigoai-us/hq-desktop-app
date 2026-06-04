# As-Built Spec — hq-sync-win parity v0.4.0 → v0.6.3

**Project:** `hq-sync-win-parity-v0.6` (Indigo)
**Repo:** `indigoai-us/hq-sync-win`
**Branch:** `feature/parity-v0.6.3` (off `main`, which carries the v0.4.0 parity from PR #1)
**Upstream target:** `indigoai-us/hq-sync@94c1428` (v0.6.3) — 154 commits / 184 files / +36,701 LOC over v0.4.0
**Final version:** `0.6.3` (lockstep across `package.json`, `src-tauri/Cargo.toml`,
`src-tauri/tauri.conf.json`; `hq-sync-menubar` entry in `src-tauri/Cargo.lock`)
**Stories:** US-001 … US-013 (all green on this branch)

> **PRDs are blueprints; specs are as-builts.** This document records what was **actually
> ported** to the Windows fork, including Windows adaptations, deferrals, and the methodology
> that diverged from the PRD's planned mechanics. Where the PRD said one thing and the build did
> another, **the build is described here and the divergence is called out.**

---

## 0. As-built methodology — content-port, not cherry-pick (IMPORTANT)

The PRD specified a per-story **"cherry-pick refs"** list and an architecture note to "follow the
cherry-pick sequence (do not pre-build)." **In execution this approach did not hold and was
abandoned.** The PRD's per-story cherry-pick references were found to be **incomplete and
out-of-order** relative to the actual upstream history: individual story refs omitted dependent
commits, listed commits whose changes spanned multiple stories, and assumed a linear sequence
that the 154-commit upstream range did not provide. Mechanical `git cherry-pick` of those refs
would have produced a broken or misattributed tree.

**The whole project was therefore executed by CONTENT-PORTING**, not mechanical cherry-pick:

- For each story, the **Windows-relevant behavior** from the corresponding upstream surface was
  re-implemented/ported into the fork, reading the upstream commits as the **specification** of
  intended behavior rather than as patches to apply verbatim.
- **macOS-only surfaces were cfg-gated or dropped** at port time (notification action-button
  dropdown, objc2/AppKit folder-picker cleanup, AVFoundation/TCC permissions, NSVisualEffectView
  vibrancy, Mach-O signing, Entitlements.plist, hardened-runtime mic).
- **Windows platform patterns** established in the v0.4.0 effort were reused throughout: the Job
  Object daemon process supervisor (`commands::process`), `apply_windows_vibrancy` (Mica/Acrylic)
  for every secondary window, `cfg(target_os)` notification split, Git Bash sidecar invocation
  (`resolve_bin("bash")`), `paths::child_path` for child-process PATH/shebang resolution, and the
  single-final-version-triple deferral.

The commit history on this branch reflects this: commits are grouped by **story** (`feat(US-00x):`)
and describe the **ported behavior**, not upstream SHAs applied. This is the single most important
"as-built vs as-planned" delta in the project and the reader should treat the PRD's cherry-pick
refs as **historical pointers to upstream behavior**, not as a record of how the code landed.

---

## 1. Per-story as-built

Legend: **Landed** = ported and green on Windows. **Windows adaptation** = behavior differs from
macOS by necessity. **Deferred** = consciously out of scope for v0.6.3 parity (documented, not
silently dropped).

### US-001 — Recall Desktop SDK sidecar bridge + meeting detection
**Status: Landed (Windows-adapted).**
Commits: `1b4513e`, `80ee2db`, `c2d5827`, `fbcd3f7`, `c837d8f`, `ce7fa0f`.

- `src-tauri/src/commands/recall_sdk.rs` ported as a **sidecar process** lifecycle — spawns the
  Recall Desktop SDK child via the existing `commands::process` Job Object supervisor, parses
  `meeting:detected` ndjson from stdout, forwards typed Tauri `meeting:detected` events. **No
  macOS FFI** — the integration is purely a sidecar (consistent with the upstream
  Windows-supported model).
- The sidecar is driven by a **self-contained Node bridge** (`sidecar/recall-sdk-bridge/`,
  `bridge.mjs`) that wraps `@recall-ai/desktop-sdk`. The Windows port gates the entire macOS TCC
  permission dance behind `process.platform === 'darwin'` and reports `permissions:all-granted`
  on Windows.
- **Credential handshake** is server-side: `GET /v1/recall/credentials` on hq-pro at startup;
  404/network-error → `RECALL_SDK_UNAVAILABLE` log + `Ok(())` **graceful degradation** (the app
  continues normally; no Recall key persisted in plaintext).
- **Phase-0 / `@getindigo.ai` eligibility gate** ported; **URL-less** meeting-detected events
  forwarded with a synthetic key; **dedup** via an atomic notify-ledger claim; MeetingsWindow
  made **resilient** to upstream list-call outages (friendly one-liner instead of a raw HTTP-500
  blob; recovers on next poll without close+reopen; request/connect timeout budget).
- Sidecar registered under the singleton `"recall-sdk"` handle; teardown (SIGTERM→SIGKILL) with
  the app — **no orphan** under the Job Object supervisor (KILL_ON_JOB_CLOSE).
- Binary-absent path verified to no-op cleanly.

### US-002 — Meeting recording lifecycle + company attribution
**Status: Landed (Windows-adapted).**
Commits: `9acbe6d`, `27f98cf`, `46bd044`, `19bc63f`.

- Recording **start/stop wired end-to-end** (start from Record button / notification, stop from
  the window) via a **bridge stdin command channel**.
- **Auto-stop** on call end (meeting-closed → stopRecording).
- **Stop watchdog**: a recording stuck in `Stopping…` is force-stopped after a timeout — the
  Windows-equivalent of the macOS JIT-entitlement watchdog (`1d7ca1c`); **the watchdog is kept,
  the macOS JIT-entitlement bits are dropped**.
- **Default recording company** + per-recording **company dropdown** + "Manage" label; default
  applied on notification-Record and editable during recording; recording attribution via the
  company picker (MeetingsWindow "Live now" recording UI).

### US-003 — Meeting notifications + permissions wizard (Windows-simplified)
**Status: Landed (Windows adaptation — the canonical Windows simplification).**
Commits: `2077b03`, `4dadeea`, `8621768`, `7adcc46` (doc).

- Clickable meeting notification → opens popover; **Record button on the banner**; banner delayed
  (~4s) so it stacks above the host app; **atomic dedup ledger** for detected-meeting
  notifications.
- `src-tauri/src/commands/permissions.rs` ported and **Windows-adapted**: Windows has **no
  screen/mic permission system**, so the module reports **granted / not-required** and the macOS
  objc2 AVFoundation/TCC path is **cfg-gated out**. The Settings permissions row + the
  `MeetingPermissionsWindow` render a Windows-appropriate **informational / granted** state (no
  macOS API calls).
- `MeetingPermissionsWindow` CSS scoped to its window label; eligibility widened from stefan-only
  to **all `@getindigo.ai`** users.

### US-004 — desktop-alt "Company OS" Board + Projects port
**Status: Landed (core only) — SIGNIFICANT DEFERRAL (see below).**
Commits: `5653f9c`, `e320539`, `5f8d7d2`.

**Landed:**
- `src-tauri/src/commands/desktop_alt.rs` Rust data layer + `desktop_alt_enabled` Tauri command +
  **Indigo eligibility gate**.
- The gateable, **Windows-bootable Company OS core**: a minimal top-level **Board** with
  company-scoped goals/projects/in-flight and **real company summary counts** (no zero-stuck
  re-render loop).
- The **`titleBarStyle` Windows fix** (correct enum casing / cfg-adaptation so the window boots on
  Windows) — landed with a **source-contract regression guard** (`5f8d7d2`) so the macOS-only
  title-bar style cannot regress the Windows window boot.
- The desktop-alt **theme applies on Windows** (the `:global()` CSS fix), gated behind the flag;
  non-eligible users fall back to the classic surface.

**DEFERRED (documented, not silently dropped):**
- The **full upstream desktop-alt frontend tree (~11.7k LOC)** was **NOT** ported: the projects
  **kanban**, the **command palette**, `commands/projects_local.rs` (the local projects surface),
  and the broader **desktop-alt sync/meetings PAGE tree**. Upstream, this is a **multi-story
  sub-epic** whose surface area the PRD's single-story US-004 cherry-pick refs **did not
  capture**. Only the Windows-bootable Company OS core + classic-surface parity landed under the
  `desktop_alt` flag. `projects_local.rs` was therefore **not** created in this fork.
- Rationale: the deferred tree is gated behind `desktop_alt_enabled` (Indigo-only dogfood), is
  not on the V1 ship path, and porting it faithfully is its own multi-story effort. The flag
  default keeps Windows users on the classic surface, so the deferral does not degrade the
  shipping experience.

### US-005 — desktop-alt sync screen + meetings redesign
**Status: Landed as classic-surface parity (scoped to the deferral above).**
Commits: `f2aa95f` (+ the MeetingsWindow redesign / instant-paint / self-sufficient calendar
fetch work tracked under US-005 in the task list).

- **Sync-screen parity** applied to the **classic** `WorkspaceList`: classic ordering, the
  **"Personal"** tag on the personal workspace row, and the **hover sync-mode toggle**.
- **Meetings redesign + instant-paint** preload store; the Meetings page **fetches its own
  calendar data** (self-sufficient).
- **Preserves Windows controls**: the Windows sync-mode toggle (v0.4.0 US-018) and the
  personal/instant/share toggles are reconciled and kept (soft-conflict with v0.4.0 US-016/US-018
  resolved in favor of the Windows controls).
- **Scope note:** because the full desktop-alt PAGE tree is deferred (US-004), US-005's sync +
  meetings parity landed against the **classic** surfaces, not the deferred desktop-alt page
  versions. The user-visible behavior (classic ordering, Personal tag, hover toggle, instant
  meetings paint) matches upstream intent on the surfaces the Windows fork actually ships.

### US-006 — Unified notification-history window + cross-session new-file history
**Status: Landed (Windows-adapted).**
Commits: `d3ae5d5`, `c7fe977`.

- `src-tauri/src/commands/notification_history.rs` (+ `un_notify.rs` surface) ported — a
  **persistent** notification-history store; recording wiring threaded through the new-file/share/
  DM fire points.
- Unified **notification-history window** renders DM/share/update/**new-file** entries; wired to
  **cross-session new-file history** (Phase 3) so history **survives app restart**.
- `notification-history` window **capability** registered
  (`src-tauri/capabilities/notification-history.json`); window uses **Windows Mica/Acrylic**
  vibrancy (`apply_windows_vibrancy`), macOS title-bar cfg-gated — the standard secondary-window
  treatment from the v0.4.0 effort.

### US-007 — Banner refinements + notifications GA + popover header declutter
**Status: Landed (Windows-adapted vibrancy).**
Commits: `b6140b4`, `a112d5b`, `0c22336`, `9318855`, `6aa3c04`.

- **HQ-branded glass banners** for shares + meetings via the **Windows Mica/Acrylic** path
  (`banner.rs` already carried `apply_windows_vibrancy` from v0.4.0 US-018) — **not**
  NSVisualEffectView; **stuck share cursor** fixed.
- **Content-fit banner height** (removed the fixed 104px padding); **draining lifebar removed**.
- **Popover header decluttered** — a single settings entry, clearer **monochrome** icons (incl. a
  monochrome meeting icon).
- **Notifications GA**: the **DM** and **Share** notification toggles are opened to **all**
  signed-in users — the `@getindigo.ai` gate on the toggles was removed (backend delivery was
  already universal). The Indigo-only **Meeting permissions** row stays gated.

### US-008 — DM conversation thread in the DM window
**Status: Landed (platform-neutral).**
Commit: `4070170`.

- `DmDetail` window shows the **full conversation thread** (not just the single triggering DM);
  the reply-from-window flow (v0.4.0 US-015) is preserved.

### US-009 — Packages management window
**Status: Landed (Windows-adapted PATH/shebang).**
Commit: `5bd5748`.

- `src-tauri/src/commands/packages.rs` ported + **Packages window** renders installed/available HQ
  packs.
- **Child PATH** set so `hq`'s node shebang resolves on Windows — the v0.5.1 fix (`ca8aa43`) mapped
  to the fork's `paths::child_path` / Git Bash resolution pattern (proven for npx/node/bash in the
  v0.4.0 effort).
- `packages` window **capability** registered (`src-tauri/capabilities/packages.json`); window
  uses **Windows vibrancy**.

### US-010 — Rescue hardening (cloud-update, drift quarantine, overwrite-safe, live-fetch)
**Status: Landed (Windows invocation preserved).**
Commits: `41eb7fe`, `f9b59f6`.

- `src-tauri/src/commands/rescue_script_cache.rs`: **live-fetch fallback** when the bundled rescue
  script is stale (`#151`).
- Rescue bash-script hardening ported: **`--cloud-update`** (reconcile hq-symlink / flatten
  symlinks), **protect `settings.local.json`**, **quarantine** `.agents`/`.codex`/`.obsidian`/
  `MIGRATION.md` drift, **drop master-sync symlinks**, and **silently overwrite**
  `AGENTS.md`/`USER-GUIDE.md`/`_digest.md` (no rescue bucket, no conflict).
- Rescue is still invoked via **Git Bash** (`resolve_bin("bash")`) on Windows — the v0.4.0 US-007
  pattern preserved.

### US-011 — First-run onboarding (welcome, calmer first sync, auto-sync notice)
**Status: Landed (platform-neutral).**
Commits: `45feb68`, `7d598e5`.

- `src-tauri/src/commands/first_run.rs` ported — first-run **classification/detection** backend.
- **First-run welcome** carousel, **calmer first sync** (reduced initial-sync noise), and a
  one-time **auto-sync notice** (frontend); first-run state **persisted** so the welcome shows
  once.

### US-012 — Recall media runtime on Windows + macOS release-fix triage
**Status: Landed (x64 ships; arm64 launcher deferred; macOS fixes triaged N/A).**
Commits: `51ba9dd`, `f112b70`, `65bac1c`. Docs: `docs/RELEASE.md`.

- **Self-contained Recall SDK sidecar launcher** built via Node SEA
  (`sidecar/recall-sdk-bridge/build.mjs`); bundled via Tauri **`bundle.externalBin`** +
  `bundle.resources` (the `recall-sdk-bridge/` payload). Shipping binary:
  `src-tauri/binaries/recall-desktop-sdk-x86_64-pc-windows-msvc.exe`.
- **Windows media runtime confirmed**: the Recall Windows runtime ships plain **PE DLLs**
  (GStreamer DLLs + plugins under `GST_PLUGIN_PATH`); **no macOS `GStreamer.framework`** is
  required. Documented in `docs/RELEASE.md`.
- `release.yml` builds + **signs** the Recall sidecar (Authenticode SignTool covers the
  launcher); the Windows targets bundle the externalBin.
- **arm64 deferral (known TODO):** the `aarch64-pc-windows-msvc` matrix leg currently emits an
  **x64 launcher under an aarch64 name** (`build.mjs` copies the **host** `node.exe`; an arm64
  runner with an arm64 `node.exe` is needed for a truly-native arm64 launcher). **x64 is what we
  ship and dogfood today;** native arm64 is **deferred until arm64 is a real release target**.
  This does not affect the x64 build.
- **macOS-only release fixes triaged N/A** (documented in `docs/RELEASE.md`, not blindly
  cherry-picked):
  - `edbf27a` (sign every Mach-O in `GStreamer.framework`) — Windows has **no Mach-O / no
    notarization**; Authenticode on the installer + launcher suffices.
  - `52a38df` (strip XML comment from `Entitlements.plist`) — Windows has **no entitlements / no
    `Entitlements.plist`**; no `--entitlements` signing pass exists.
  - `f6b8b3b` (microphone `audio-input` entitlement under hardened runtime) — Windows has **no
    hardened runtime / no entitlement-gated mic**; the bridge gates the macOS TCC dance to
    `darwin` and reports `permissions:all-granted` on Windows.

### US-013 — v0.6.3 version triple + smoke checklist (parity acceptance gate)
**Status: Landed (this story).**

- **Version triple → `0.6.3`** lockstep: `package.json`, `src-tauri/Cargo.toml`,
  `src-tauri/tauri.conf.json`, plus the `hq-sync-menubar` entry in `src-tauri/Cargo.lock`
  (reconciled by `cargo check`). The app's `getVersion()` (Settings/About) and the tray
  right-click header now read **0.6.3**.
- **Smoke checklist** for the new v0.4.0→v0.6.3 surfaces:
  - `docs/SMOKE_TESTS.md` — fast pre-release sweep (the file named by the PRD; created here, as
    the repo previously only had the V1 gate `tests/SMOKE_WINDOWS.md`). Covers: Recall meeting
    detection/recording (+ graceful-degradation + no-orphan, always-runnable), permissions wizard
    (granted/not-required), desktop-alt Company OS (gate on/off), notification-history window,
    Packages window, first-run onboarding, banner refinements + notifications GA, DM conversation
    thread, and the version gate.
  - `tests/MANUAL_TESTING.md` — extended with a **"v0.6.3 — Windows parity surfaces"** section
    (WIN-RECALL, WIN-PERMS, WIN-DALT, WIN-NOTIFHIST, WIN-PKGS, WIN-RESCUE, WIN-FIRSTRUN,
    WIN-BANNER-GA, WIN-DMTHREAD, WIN-VERSION) with PowerShell / `%USERPROFILE%\.hq\` / system-tray
    steps. (The pre-existing body of that file is the upstream **macOS** checklist; the new
    section is explicitly the Windows port.)
- **As-built spec** — this document.

---

## 2. What did NOT come across (consolidated deferral/triage ledger)

| Item | Origin | Disposition | Why |
|------|--------|-------------|-----|
| Full desktop-alt frontend tree (~11.7k LOC): projects kanban, command palette, `projects_local.rs`, desktop-alt sync/meetings PAGE tree | US-004 / US-005 | **Deferred** | A multi-story upstream sub-epic the PRD's single-story cherry-pick refs did not capture; gated behind `desktop_alt` (Indigo dogfood), off the V1 ship path. Classic-surface parity shipped instead. |
| Native arm64 Recall sidecar launcher | US-012 | **Deferred** | `build.mjs` emits an x64-on-aarch64-name launcher; a native one needs an arm64 `node.exe`/runner. x64 ships + dogfoods. Deferred until arm64 is a real release target. |
| `edbf27a` — sign every Mach-O in GStreamer.framework | US-012 triage | **N/A on Windows** | No Mach-O / no notarization; Authenticode on installer+launcher suffices. |
| `52a38df` — strip XML comment from Entitlements.plist | US-012 triage | **N/A on Windows** | No entitlements / no `Entitlements.plist`; no `--entitlements` pass. |
| `f6b8b3b` — microphone hardened-runtime entitlement | US-012 triage | **N/A on Windows** | No hardened runtime / no entitlement-gated mic; TCC dance gated to `darwin`. |
| macOS permission system (TCC/AVFoundation), objc2 folder-picker cleanup, NSVisualEffectView vibrancy, mac-notification-sys action dropdown | US-003 / cross-cutting | **Dropped / cfg-gated** | macOS-only; replaced by Windows equivalents (granted/not-required, rfd picker, Mica/Acrylic, tauri-plugin-notification toasts). |
| Intermediate per-release version bumps across the 154-commit range | cross-cutting | **Dropped** | Per the v0.4.0 methodology, only the single final triple (0.6.3) is set, by US-013. |

---

## 3. Back-pressure (acceptance gate) — as recorded for US-013

Run from `src-tauri/` (Rust) and the repo root (frontend):

```
cargo fmt
cargo fmt --check
cargo clippy --target x86_64-pc-windows-msvc --bins -- -D warnings
cargo check  --target x86_64-pc-windows-msvc
cargo test   --target x86_64-pc-windows-msvc --bins
# repo root:
npm run build
```

The version bump compiles cleanly (`cargo check` reconciled `Cargo.lock`'s `hq-sync-menubar`
entry to 0.6.3 with no other lockfile churn). The per-story commits on this branch each landed
their own green gate; US-013 adds only version-string + documentation changes (no Rust/TS logic
change), so the gate state is unchanged by the docs and confirmed by the final full run.

---

## 4. Provenance

- 34 commits on `feature/parity-v0.6.3` over `main`, grouped by story (`feat(US-00x):` /
  `chore(US-012):` / `docs(US-013):`).
- Upstream reference range: v0.4.0 (`dd36e90`) → v0.6.3 (`94c1428`).
- Sequel to `hq-sync-win-parity` (v0.4.0, 18 stories). New Windows-fork modules introduced in this
  effort: `recall_sdk.rs`, `permissions.rs`, `desktop_alt.rs`, `notification_history.rs`,
  `packages.rs`, `rescue_script_cache.rs`, `first_run.rs` (plus the `recall-sdk-bridge/` sidecar
  payload). Upstream's `projects_local.rs` was **not** ported (see US-004 deferral).
