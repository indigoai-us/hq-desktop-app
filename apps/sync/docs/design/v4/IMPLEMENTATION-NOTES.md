# V4 Implementation Notes

Last verified: 2026-07-26 on `fix/desktop-redesign-surface-audit`, based on
`origin/main` at `1618006d` (`v0.10.33`).

## Current Product Contract

The shipped route model in `src/desktop-alt/route.ts` is authoritative. The
older Paper exports and `SPEC.md` remain historical design inputs, not a
requirement to restore retired standalone screens.

- Home and Mission Control are command-palette routes.
- Inbox combines desktop notifications and messaging entry points; the separate
  Messages window remains native and independent.
- Companies are first-class primary-sidebar rows. Company tasks live as PRD
  stories inside Projects rather than a standalone Tasks route.
- Personal is a user-owned local workspace: its Overview board renders
  `personal/board.json` and `personal/projects/*/prd.json`, and that panel does
  not call company summary, board, provenance, goals, or activity services.
- Company sections are Overview, Goals, Projects, Skills, Workers, Knowledge,
  Team, Activity, Deployments, Secrets, and Settings.
- Library includes Skills, Workers, Installed, and Profile. Marketplace and
  admin Moderation are global routes.
- Settings includes Sync, Notifications, Widget, Updates, General, and Meetings.
- The titlebar owns live sync verdicts and the app-version updater popout. The
  retired status bar is not part of the current shell.
- Central-canvas text is 14px/400; sparse metadata may use 13px. Bold,
  semibold, arbitrary purple, and generated hue-wheel colors are excluded.

## 2026-07-26 Repair Audit

The complete desktop harness matrix was inspected at full and minimum desktop
widths:

- 29 primary routes
- 9 nested screens and popouts
- 10 minimum-width checks
- deterministic conflict, sync-error, drift, update-available, and admin states

The repair closed the audit findings for:

- Marketplace null payloads and the Moderation null-queue crash
- viewport-height overflow and undersized primary text
- inaccessible Projects columns and overlapping Deployments headers
- nested Inbox controls and keyboard-hidden row actions
- missing updater host, settings route, and install/restart action
- dishonest titlebar error/conflict verdicts
- production Team telemetry and duplicate project identity
- theme-inconsistent native controls and forbidden generated colors
- missing populated deployments, secrets, Marketplace, Moderation, updater, and
  safety-state fixtures

The evidence and machine-readable reports live under
`workspace/reports/qa/hq-desktop-app-2026-07-26/` in the HQ workspace.

## Verification

- `pnpm --filter hq-sync typecheck`: 0 errors; 3 pre-existing Svelte warnings
- `pnpm --filter hq-sync lint`: 0 errors; the same 3 warnings
- `pnpm --filter hq-sync test`: 116 files, 1341 tests passed
- `pnpm --filter hq-sync test:e2e:desktop-alt`: 64 files, 419 tests passed
- `pnpm --filter hq-sync build`: production Vite build passed
- `cargo test --workspace --quiet`: 323 passed, 1 ignored
- native Tauri debug application and macOS bundle built successfully
- `git diff --check`: passed

The normal desktop-alt E2E command still reports its scripted fallback when
`tauri-driver` is unavailable. The 2026-07-26 signoff therefore pairs those
source-contract tests with a real rendered browser-harness route matrix and
saved screenshots. The newly built native bundle was not launched because the
installed HQ app and its live sync runner were active.

Repository-wide coverage remains below the default quality-gate threshold for
statements, branches, and lines. `cargo clippy --workspace -- -D warnings` also
surfaces existing Rust lint debt outside this frontend repair. Neither result is
represented as passing.

Critical release guards:

- `e2e/desktop-alt/secrets-never-leak.spec.ts` keeps secrets metadata-only.
- `e2e/desktop-alt/safety-flows.spec.ts` preserves conflict, drift, core update,
  and abort-only sync-halted behavior.
- `src/desktop-alt/lib/marketplace.test.ts` guards malformed Marketplace and
  Moderation payloads at the adapter boundary.
- `__tests__/stories/US-005.test.ts` keeps conflict cards, titlebar verdicts,
  and tray state consistent.
