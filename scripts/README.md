# scripts

Repository-wide tooling for the single hq-desktop-app. Referenced by `MIGRATION.md`;
implemented across the migration phases.

Implemented:

- `version-app.ts` — stamp the app's `package.json`, Tauri config, `Cargo.toml`, and
  `Cargo.lock` from `versions.toml`; `--check` fails on any mismatch.
- `release-asset-contract.mjs` — verify the exact hidden-draft asset set and the
  public four-platform updater manifest before and after GitHub Release publication.
- `release-stable-order.mjs` — reject stable rollbacks both before native builds and
  inside the serialized publication lock.

Planned:

- `assert-versions.ts` — release-time gate; fail if any version file disagrees.
- `verify-downloads.ts` — fetch the public install pages, download the advertised artifact
  per OS, and verify signatures, checksums, and manifest shape.
- `diff-sync-forks.ts` — compare the macOS and Windows command/event surfaces and fail on
  unintended drift (feeds the `command-contract` CI gate).
