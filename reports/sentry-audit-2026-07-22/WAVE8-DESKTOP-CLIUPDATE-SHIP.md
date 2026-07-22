# Wave 8 desktop CLI-update ship notes

## Finding

PR #240 (`0d22f1cc`) is on `main` and shipped in both `v0.10.27` and
`v0.10.28`. Its `exit 1` event is not explained by a missing deployment of
that fix: unexpected `exit 1` failures are intentionally still captured.

The audit found an over-broad expected-environment predicate: any npm output
containing `EACCES` or `permission denied` was suppressed, including cache,
lifecycle-script, and unrelated filesystem failures.

## Change

- Suppress only an `EACCES`/permission failure whose path is inside the exact
  npm prefix selected for the resolved `hq` binary:
  `<prefix>/lib/node_modules`, `<prefix>/node_modules`, or `<prefix>/bin/hq`.
- Keep every other failure, including `exit 1` permission failures outside that
  target, loud in Sentry with the existing stable fingerprint:
  `hq-cli-update / install-failed / unexpected / <exit-code>`.
- Expected global-prefix failures still return their original npm output to the
  UI and local log; they simply do not create a Sentry event.

## Verification

- `cargo fmt --all -- --check`
- `cargo test -p hq-desktop-core hq_cli_update::tests::` (19 passed)
- `cargo check --locked` in `apps/sync/src-tauri` reached the known Linux host
  limitation: `glib-2.0` and `gobject-2.0` development packages are absent.
  The desktop platform build remains covered by release CI.

## Adoption

This is a client-side capture-path change and requires desktop release
`v0.10.29` for field adoption.
