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
| `HQ_SCRATCH_BUILD=1` | Stops the test bundle from changing your installed HQ. It turns off the app updater (the background check, the channel lookup, manual check, download and install, and the version gate), UI hot updates, the hq CLI, pack, HQ Core, qmd and HQ Work installers, the login item (launch repair, Start at login, the restart handoff to launchd) and the sync version marker. It also counts as `HQ_UPDATER_DISABLED=1`. |
| `HQ_SCRATCH_IMPORT_HQ_BIN=/abs/path/to/hq` | The "Bring in your context" scan runs this `hq` instead of the installed one. Ignored unless `HQ_SCRATCH_BUILD` is set. |
| `HQ_SCRATCH_IMPORT_SCANNER=/abs/path/to/scan.sh` | The scan uses this scanner (passed to hq as `HQ_IMPORT_SCANNER_OVERRIDE`). Ignored unless `HQ_SCRATCH_BUILD` is set. |

`HQ_UPDATER_DISABLED=1` (from PR 1504) still works on its own as a run-time
variable for the updater paths. `HQ_SCRATCH_BUILD` covers more, and it is
baked into the build.

## Interface (Vite) switches

Set these when the interface is built (`pnpm --filter hq-sync build`, or
through `cargo tauri build`). Code:
`packages/ui/src/chat/first-run/dev-switches.ts`.

| Switch | What it does |
| --- | --- |
| `VITE_HQ_DEV_FIRST_RUN_FORCE=1` | Treats `desktop.visual-first-run` as on for this build and opens the takeover on every launch, even after setup ran or the takeover was finished. The flag service is not read or changed. The walk is real: it creates the setup bot under the name you give it (or renames the one you have), joins or starts the company you pick, and connects the apps you pick. |
| `VITE_HQ_DEV_FIRST_RUN_DRY=1` | Makes the walk side-effect free. Nothing is created, renamed, joined, connected or sent. Done and Continue in chat only close the takeover, and the "finished" marker is not written. Reads still happen, so the screens show your real companies and catalog. On its own it changes nothing until the takeover opens. |

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
