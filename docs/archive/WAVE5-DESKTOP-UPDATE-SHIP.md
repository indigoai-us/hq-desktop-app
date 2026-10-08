# Wave 5 desktop update ship notes

## Scope

- **HQ-DESKTOP-1:** CLI-update npm failures now retain actionable output for the
  UI and diagnostic log. Only unexpected failures create a Sentry event.
- **HQ-DESKTOP-3D:** Windows `STATUS_CONTROL_C_EXIT` (`0xC000013A`) and Node's
  abort status (`0xC0000409`) are classified as expected local-environment
  interruptions in both desktop command implementations. They show recovery
  guidance and the existing copy-command fallback, but are not sent to Sentry.
- **HQ-DESKTOP-3B:** provisioning scans stdout backward for a complete
  `CliProvisionResult`, so trailing `npm fund`/wrapper notices no longer make
  an exit-0 provision look like a JSON parse failure.

## Observability

Unexpected updater failures carry the stable Sentry fingerprint:

`hq-cli-update / install-failed / unexpected / <exit-code>`

Expected local failures retain distinct diagnostic classification keys
(`expected-prefix-permission` or `expected-windows-abort`) and are deliberately
not captured. Provision errors continue to include the bounded stderr tail for
triage.

## Verification

- `cargo fmt --check`
- `cargo test -p hq-desktop-core hq_cli_update::tests::`
- `cargo test -p hq-desktop-core run_cli_provision::tests::`

The unit coverage includes root-owned npm prefixes, both Windows NTSTATUS
variants, actionable empty-output guidance, trailing npm funding notices, ANSI
prefixes, unrelated JSON, and a genuine schema error.

The Windows binary target is validated by the repository's Windows CI job. A
Linux-hosted direct build of that Tauri binary requires the unavailable system
`glib-2.0` development package, so it is intentionally left to the Windows
runner rather than treating that host dependency as a product failure.
