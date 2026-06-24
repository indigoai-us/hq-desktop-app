# scripts

Repository-wide tooling for the single hq-desktop-app. Referenced by `MIGRATION.md`;
implemented across the migration phases. Placeholder for the scaffold — no executable
scripts yet.

Planned:

- `version-app.ts` — stamp the app's `package.json`, Tauri config, and `Cargo.toml` from
  `versions.toml`.
- `assert-versions.ts` — release-time gate; fail if any version file disagrees.
- `generate-latest-json.ts` — build per-channel updater manifests.
- `publish-updater-manifest.ts` — publish manifests to `downloads.getindigo.ai/hq-desktop-app`.
- `verify-downloads.ts` — fetch the public install pages, download the advertised artifact
  per OS, and verify signatures, checksums, and manifest shape.
- `diff-sync-forks.ts` — compare the macOS and Windows command/event surfaces and fail on
  unintended drift (feeds the `command-contract` CI gate).
