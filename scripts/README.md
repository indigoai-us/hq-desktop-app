# scripts

Repository-wide tooling for the single hq-desktop-app. Referenced by `MIGRATION.md`;
implemented across the migration phases.

Implemented:

- `version-app.ts` — stamp the app's `package.json`, Tauri config, `Cargo.toml`, and
  `Cargo.lock` from `versions.toml`; `--check` fails on any mismatch.
- `release-asset-contract.mjs` — verify the exact hidden-draft asset set and the
  public four-platform updater manifest before and after GitHub Release publication;
  accept an exact healthy public release as a read-only rerun.
- `release-stable-order.mjs` — reject stable rollbacks both before native builds and
  inside the serialized publication lock, then verify prerelease/stable isolation.
- `windows-msi-version.mjs` — map stable, beta, and alpha app SemVer to the
  numeric three-field WiX/MSI `ProductVersion` overlay without changing any
  user-visible or updater-facing version.
- `onboarding-release-monitor.ts` — verify stable updater targets and installer
  links, plus the tag-pinned beta or alpha updater manifest when the current
  `versions.toml` is a prerelease.

Planned:

- `assert-versions.ts` — release-time gate; fail if any version file disagrees.
- `verify-downloads.ts` — fetch the public install pages, download the advertised artifact
  per OS, and verify signatures, checksums, and manifest shape.
- `diff-sync-forks.ts` — compare the macOS and Windows command/event surfaces and fail on
  unintended drift (feeds the `command-contract` CI gate).
