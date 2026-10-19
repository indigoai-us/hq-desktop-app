# Dev-only build switches

These switches let you test the visual first run in a local build of the
desktop app while its flag (`desktop.visual-first-run`) stays off for
everyone else. They are read at build time and do nothing unless the build
sets them. The release workflows never set them, and
`scripts/dev-switches-contract.test.ts` fails if a workflow, a build script or
a Tauri config starts to.

## Native (Rust) switches

Set these when you run `cargo tauri build`. They are compiled in with
`option_env!`, so the bundle keeps them when you open it from Finder.
Code: `apps/sync/src-tauri/src/scratch_build.rs`.

| Switch | What it does |
| --- | --- |
| `HQ_SCRATCH_BUILD=1` | Stops the test bundle from changing your installed HQ. It turns off the app updater (the background check, the channel lookup, manual check, download and install, and the version gate), UI hot updates, the hq CLI, pack, HQ Core, qmd and HQ Work installers, every `install_*` command (dependencies and coding tools, so sign a coding tool in from the installed app or a terminal), the login item (launch repair, Start at login, the restart handoff to launchd) and the sync version marker. It also counts as `HQ_UPDATER_DISABLED=1`. |
| `HQ_SCRATCH_IMPORT_HQ_BIN=/abs/path/to/hq` | The "Bring in your context" scan runs this `hq` instead of the installed one. Ignored unless `HQ_SCRATCH_BUILD` is set. |
| `HQ_SCRATCH_IMPORT_SCANNER=/abs/path/to/scan.sh` | The scan uses this scanner (passed to hq as `HQ_IMPORT_SCANNER_OVERRIDE`). Ignored unless `HQ_SCRATCH_BUILD` is set. |

### HQ Core beta for walk and demo builds

`HQ_CORE_PRERELEASE=1` lets a walk or demo build install and offer the HQ Core
beta. Code: `apps/sync/src-tauri/src/demo_build.rs`. It is compiled in with
`option_env!` like the switches above. A scratch build (`HQ_SCRATCH_BUILD=1`)
turns off the HQ Core auto-installer, so there the update half of this switch
does nothing. Build without `HQ_SCRATCH_BUILD` to walk the HQ Core update.

| Switch | What it does |
| --- | --- |
| `HQ_CORE_PRERELEASE=1` | First-run setup and the HQ Core update check read the full hq-core release list instead of the latest stable release, take prereleases, and pick the highest version. They refuse anything below `16.0.31-beta.6` (`MIN_CORE_VERSION`), and never take a draft. If no release qualifies, setup fails with "no release at or above 16.0.31-beta.6" rather than installing an older stable. When the GitHub API is rate limited, the redirect fallback still only sees the latest stable, so a demo build uses it only when that stable is at or above the minimum. |

Without the switch, every caller keeps the stable-only rule it had before:
`/releases/latest`, the first non-draft stable, and no minimum. The release
workflows never set it, and `scripts/demo-core-prerelease-contract.test.ts`
fails if a workflow, build script, package script or Tauri config starts to.

The same switch makes a demo build read every flag in `DEMO_FLAG_DEFAULTS_ON`
(also in `demo_build.rs`) as on when hq-flags answers false, has no value for
it, or cannot be reached. The list holds one flag,
`desktop.first-run-found-apps-v1`, so a walk shows the "Your apps" first-run
step without a registry change. Rust reads it through `feature_flag_read`
(which also covers the first-run handoff hint). The desktop shell's
`hasFeature` reads it through the `demo_flag_defaults_on` command, once per
session; if that command fails, the list counts as empty. No other flag
changes. Without the switch the command returns an empty list and every flag
read is unchanged. To add a flag, add it to `DEMO_FLAG_DEFAULTS_ON` and to
`DEMO_FLAG_DEFAULT_CANDIDATES` in `packages/platform/src/tauri/sync-adapter.ts`;
`scripts/demo-core-prerelease-contract.test.ts` fails until both match.

`HQ_UPDATER_DISABLED=1` (from PR 1504) still works on its own as a run-time
variable for the updater paths. `HQ_SCRATCH_BUILD` covers more, and it is
baked into the build.

### Bundle identifier

A bundle that does not run as the shipped identifier
(`ai.indigo.hq-sync-menubar`, which stable, beta and alpha all use) is treated
the same way at launch even without `HQ_SCRATCH_BUILD`. It skips the HQ
Anywhere setup (`hq install` and `hq uninstall --global --runtime claude|codex`),
the Work Mesh unit install and removal, the updater, the login item repair and
reconcile, UI hot updates and the background hq CLI, pack, HQ Core, qmd and HQ
Work installers, and logs one line for each skipped step. Scratch, Lane Check,
worktree and side-by-side bundles all fall under this. One predicate decides:
`LaunchIdentity::is_production` in `scratch_build.rs`, built on
`is_production_bundle_identifier` in `crates/hq-platform/src/autostart.rs`.
Windows has no bundle identifier to read and counts as the shipped one.

Do not open a test bundle on a machine whose HQ folder you care about. Check
launch behavior in a Tart VM.

## Interface (Vite) switches

Set these when the interface is built (`pnpm --filter hq-sync build`, or
through `cargo tauri build`). Code:
`packages/ui/src/chat/first-run/dev-switches.ts`.

| Switch | What it does |
| --- | --- |
| `VITE_HQ_DEV_FIRST_RUN_FORCE=1` | Treats `desktop.visual-first-run` as on for this build and opens the takeover on every launch, even after setup ran or the takeover was finished. The flag service is not read or changed. The walk is real: it creates the setup bot under the name you give it (or renames the one you have), joins or starts the company you pick, and connects the apps you pick. |
| `VITE_HQ_DEV_FIRST_RUN_DRY=1` | Makes the walk side-effect free. Nothing is created, renamed, joined, connected or sent. Done and Continue in chat only close the takeover, and the "finished" marker is not written. Reads still happen, so the screens show your real companies and catalog. One exception: "Bring in your context" runs the real scan so you see your real tree, and the scan writes one report under `workspace/imports/<date>/report.json` in your HQ folder. After a dry walk, the setup channel's Start makes a real setup bot. On its own it changes nothing until the takeover opens. |

For a dry walk you can repeat, set both. For a real walk, set only
`VITE_HQ_DEV_FIRST_RUN_FORCE`.

## Example: an owner test build

```bash
HQ_SCRATCH_BUILD=1 \
VITE_HQ_DEV_FIRST_RUN_FORCE=1 \
VITE_HQ_DEV_FIRST_RUN_DRY=1 \
  pnpm --filter hq-sync tauri build --debug
```

Give the bundle its own name and identifier, as before, so it does not
replace the installed app.

## Browser dev harness

The preview harness (`apps/sync/dev-harness`, `pnpm --filter hq-sync dev:preview`)
has its own URL switches for the same screens. They are listed at the top of
`apps/sync/dev-harness/audit-switches.ts`:

- `?firstrun=visual|visual-notools|visual-fail|visual-import...` opens the takeover.
- `?team=invites|member|many|fail` sets the roster for "Your team".
- `?apps=on|empty|forbidden|fail` sets the catalog for Note taker and Project management.

Example: `/dev-harness/index.html?view=shell&firstrun=visual&team=member&apps=on`.
