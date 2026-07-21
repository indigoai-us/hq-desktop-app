# scripts

Repository-wide tooling for the single hq-desktop-app. Referenced by `MIGRATION.md`;
implemented across the migration phases.

Implemented:

- `version-app.ts` — stamp the app's `package.json`, Tauri config, `Cargo.toml`, and
  `Cargo.lock` from `versions.toml`; `--check` fails on any mismatch.
- `onboarding-release-monitor.ts` — verify the published updater manifest,
  version-pinned artifacts, and stable installer links advertised by
  `hqforwork.com/install`; covered by `onboarding-release-monitor.test.ts` and run
  every six hours by the onboarding release monitor workflow.

Planned:

- `assert-versions.ts` — release-time gate; fail if any version file disagrees.
- `generate-latest-json.ts` — build per-channel updater manifests.
- `publish-updater-manifest.ts` — publish manifests to `downloads.getindigo.ai/hq-desktop-app`.
- `verify-downloads.ts` — fetch the public install pages, download the advertised artifact
  per OS, and verify signatures, checksums, and manifest shape.
- `diff-sync-forks.ts` — compare the macOS and Windows command/event surfaces and fail on
  unintended drift (feeds the `command-contract` CI gate).
