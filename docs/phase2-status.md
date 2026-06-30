# Phase 2 status — install-then-sync onboarding

_Last updated: 2026-06-30._

This document records the state of the unified app's Phase 2 work (the
install-then-sync lifecycle and onboarding wizard), what has shipped, what
remains, and — importantly — the verification gap that currently blocks the
install engine from being validated end to end.

## Summary

The unified app now classifies its launch state, routes a first-run user into a
complete five-step onboarding wizard, and contains most of the install engine
the wizard drives. Everything below is merged to `main` and passes the Windows
compile gate (`windows-check`). The onboarding **user interface** is complete.
The install **engine** is largely ported but, critically, has **never been
executed** — there is currently no environment in which to run it (see
Verification gap).

## What shipped

### Foundation (earlier phase)

The shared `hq-desktop-core` crate was grown from 127 to ~835 tests by
extracting the app's pure, synchronous logic out of the Tauri shell. The app is
now a thin command-and-orchestration layer over that crate.

### Lifecycle + routing

- A pure lifecycle classifier (`hq_desktop_core::lifecycle`) decides between six
  states (NeedsInstall, InstallResume, NeedsAuthForInstall, InstalledFirstRun,
  InstalledLegacyUpdate, SteadyState) and whether to backfill the legacy install
  marker.
- The classifier is wired into app startup (`commands/lifecycle.rs`), exposed via
  a `get_lifecycle_state` command, and the Svelte `App.svelte` routes the
  onboarding states to the wizard and everything else to the normal popover.

### Onboarding wizard UI (complete)

All five steps are built in Svelte 5 + vanilla CSS, ported from the React
installer:

1. **Welcome** — product identity + telemetry opt-in.
2. **Directory** — resolve/confirm the HQ install location (`resolve_hq_path`,
   `detect_hq`, `check_writable`, with a folder picker).
3. **Sign In** — Google/Microsoft OAuth, reusing the app's existing OAuth
   backend.
4. **Setup** — the orchestrator framework: an eight-stage progress screen that
   sequences the install stages and auto-advances when they settle.
5. **Done** — completion + an in-session handoff that hands control back to the
   tray/popover.

The wizard step machine (`lib/onboarding-wizard.ts`) is a faithful port of the
installer router, including the auth gate on the Setup step.

### Install engine (partial)

The Setup screen drives eight stages. Their backends:

| Stage | Command | Status |
|---|---|---|
| git-init | `git_init` | **Done** — resolves HQ root, shells out to `git init` + identity. |
| menubar | `install_menubar_app` | **Done** — no-op handoff (the unified app *is* the menu-bar agent). |
| initial-sync | `start_initial_cloud_sync` | **Done** — provisions the personal vault + first push, fire-and-forget. |
| deps | `install_deps` | **Ported, unrun** — full ~4000-line installer subsystem (homebrew/node/git/gh/claude-code/qmd/hq-cli) + orchestrator. |
| packages | `install_default_packages` | **Not started** — no backend exists to port. |
| personalize | `personalize_hq` | **Not started** — no backend exists to port. |
| import | `import_existing_setup` | **Not started** — no backend exists to port. |
| indexing | `register_search_index` | **Not started** — no backend exists to port. |

All implemented stage backends compile on macOS and Windows and (for `deps`)
carry the installer's 11 pure-helper unit tests. **None have been executed.**

## Verification gap (the blocker)

The install engine performs destructive, system-modifying operations: it
installs system software, edits shell profiles and `PATH`, provisions cloud
buckets, and writes the HQ tree. It cannot be safely run on the developer
machine, so the plan was to verify it on a clean macOS VM via `tart`.

That path is currently blocked. The `tart` base image is ~25 GB and the network
connection could not sustain the pull — it repeatedly lost the connection and,
after reaching ~7 GB, gave up and discarded the entire partial download. As a
result there is **no environment in which the onboarding flow or the install
engine has been run end to end.** Everything is verified only by compilation
(macOS + Windows) and unit tests of pure helpers.

This means the `deps` installer in particular — the largest and most dangerous
piece — has never executed. A mistake in shell-profile editing, `PATH`
handling, architecture detection, or an install invocation would not surface
until it runs on a real machine.

## Remaining work

1. **Establish a verification path.** Options: a faster network or off-peak
   window for the `tart` pull; authenticated `ghcr` pulls (`tart login`) for
   higher rate limits; a pre-built or exported VM image; or running the
   onboarding on a separate clean Mac.
2. **End-to-end verify** the onboarding wizard and the implemented stages on a
   clean machine; fix whatever the first real run surfaces.
3. **Design + build the four net-new stages** (packages, personalize, import,
   indexing). These have no installer backend to port and are most likely thin
   wrappers over the `hq` CLI run after install — they need a design decision
   before implementation.
4. **Telemetry + identity plumbing** the wizard currently collects (telemetry
   opt-in, git identity for `git-init`) but does not yet thread through to every
   consumer.

## Merged PRs (this phase)

#49 lifecycle classifier · #50 CI path filter · #51 lifecycle wiring + command ·
#52 routing skeleton · #53 story-test fix · #54 tauri-build version fix · #55
wizard scaffold + Welcome · #56 Directory backend + app-test-compile fix · #57
Directory screen · #58 Sign In screen · #59 Setup scaffold · #60 Done +
handoff · #61 git-init + menubar stages · #62 initial-sync stage · #63 deps
installer.

## Incidental fixes found along the way

- Frontend story tests read Rust source by path; the foundation extractions
  moved that code into the crate, so the tests were repointed (#53).
- The app's `cargo test` target did not compile (a `messages::Channel` fixture
  missed fields added during extraction); `cargo check` never compiles
  `#[cfg(test)]`, so it had gone unnoticed (#56).
- `tauri build` was broken by a Rust-crate/npm version skew (`tauri` 2.10.3 vs
  `@tauri-apps/api` 2.11.1); the crate was aligned to 2.11.3 (#54).
