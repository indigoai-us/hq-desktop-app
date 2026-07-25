# Wave 6 — Tungstenite WSS ship notes

Date: 2026-07-21

## HQ-DESKTOP-3G — WSS send-after-close recovery

PR #243 fixes the desktop WSS failure path where a send can race a closed
Tungstenite connection. The client now recovers instead of treating that
send-after-close condition as fatal, and explicitly selects the WSS TLS
provider used by the desktop build.

## Release gate

Do **not** resolve HQ-DESKTOP-3G solely because PR #243 merged. Resolve it
only after a production release containing the merge commit is published.
Release v0.10.28 is the intended adopting release: its branch is rebased on
`main` after PR #243 and its release CI must pass before merge/publish.

HQ-PRO-6B is explicitly out of scope for this wave.

## Verification

PR #243 CI passed after its rebase onto `main`:

- Frontend (typecheck + lint + coverage)
- Rust tests (macOS)
- Desktop-alt E2E
- cargo check (x86_64-pc-windows-msvc)
