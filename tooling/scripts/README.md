# tooling/scripts

Repository-wide tooling. These scripts are referenced by `MIGRATION.md` and are
implemented across the migration phases — this directory is a placeholder for the
scaffold and currently holds no executable scripts.

Planned:

- `version-app.ts` — stamp each app's `package.json`, Tauri config, and `Cargo.toml`
  from `versions.toml`.
- `assert-versions.ts` — release-time gate; fail if any version file disagrees with
  `versions.toml`.
- `generate-latest-json.ts` — build per-app, per-channel updater manifests.
- `publish-updater-manifest.ts` — publish manifests to `downloads.getindigo.ai`.
- `verify-downloads.ts` — fetch the public install pages, download every advertised
  artifact, and verify signatures, checksums, and manifest shape.
- `diff-sync-forks.ts` — compare the macOS and Windows sync command surfaces and fail
  on unintended drift (feeds the `sync-contract` CI gate).
