# HQ Work embedded window — rollout, bake, rollback, updater budget

Flag-gated embed of `@hq/ui` DesktopApp inside Sync's desktop-alt window.
Tray popover, widget, and sync engine stay in Sync. No second app, no
co-install, no account or data migration.

This file is the source of truth for the combined-app rollout
(US-101..US-107). The two-app doc [hq-work-handoff.md](hq-work-handoff.md)
(launch HQ Work / co-install / card) is superseded and kept only because
existing tests source-contract it.

**Default is off.** Broader default-on is a config change, not a leap. Do not
flip the compiled default until this doc's bake checklist is done.

ONE flag only. JSON key `hqWorkHandoff` in `~/.hq/menubar.json`. Rust field
`hq_work_handoff`. TS helper `hqWorkHandoffEnabled(flag)` is `flag === true`
(null/undefined → false). Missing file, missing key, parse failure → false.
No Settings toggle — do not add one. Do not invent a second flag.

Flag on: the same desktop-alt window mounts `@hq/ui` DesktopApp via
`HqWorkDesktopShell` + `createSyncPlatformAdapter` (US-103). Flag off:
legacy desktop-alt (`src/desktop-alt/DesktopApp.svelte`); no extra probes /
no `[handoff]` log on open (finding-6). Live
`maybe_intercept_desktop_alt_handoff` is a no-op (always false). Combined-app
does not launch HQ Work, does not show `HqWorkHandoffCard`, does not
co-install. Auth is the same Cognito vault-users session already in Sync.
No migration, no second sign-in, no token sharing.

## Alpha enable (`@getindigo.ai`)

Internal team is the alpha cohort (`@getindigo.ai`). There is no Settings
toggle for this flag — do not add one. Enable per machine:

1. Merge `{"hqWorkHandoff": true}` into `~/.hq/menubar.json` (do not
   overwrite other keys):

   ```json
   {
     "hqWorkHandoff": true
   }
   ```

   Same write path as `set_hq_work_handoff(true)` / `merge_menubar_flags` on
   `hqWorkHandoff`.

2. Quit and relaunch Sync so boot re-reads the flag.

3. Confirm flag-on mounts `HqWorkDesktopShell` (`@hq/ui` DesktopApp via
   `createSyncPlatformAdapter`) in the same desktop-alt window.

Existing installs without the key keep the legacy shell. Tray popover,
widget, and sync engine are unchanged.

## Default stays false (do not flip in this release)

This embed reuses the same flag as the two-app doc. Copy-lockstep:

| Site | Default-off |
| --- | --- |
| `MenubarPrefs.hq_work_handoff` | `Option<bool>`, absent → `None` (`crates/hq-desktop-core/src/config.rs`) comment "Absent → false" |
| `get_settings` no-file branch | `hq_work_handoff: Some(false)` |
| `get_settings` file-present branch | `prefs.hq_work_handoff.unwrap_or(false)` |
| `hq_work_handoff_enabled` | `.unwrap_or(false)` |
| `get_hq_work_handoff` missing file | `Ok(false)` |
| `hq_work_handoff_from_json` untyped fallback | `.unwrap_or(false)` |
| `crates/hq-desktop-core/src/settings.rs` `apply_defaults` | `unwrap_or(false)` |
| frontend `hqWorkHandoffEnabled` | `flag === true` (null/undefined → false) |

## Default-on (copy-paste when baking)

When alpha is baked and the embed is a config change, flip **all** of these
in the same Sync release. These one-liners now enable the embed in **this**
desktop-alt window (not launch a second app). The boot path reads
`get_hq_work_handoff` / `hq_work_handoff_enabled`, not only Settings.

**Canonical one-liners** (same flag as US-006; they now enable the embed):

```text
apps/sync/src-tauri/src/commands/settings.rs
  get_settings no-file branch:
    hq_work_handoff: Some(false)
  → hq_work_handoff: Some(true)

apps/sync/src-tauri/src/commands/settings.rs
  get_settings file-present branch:
    hq_work_handoff: Some(prefs.hq_work_handoff.unwrap_or(false))
  → hq_work_handoff: Some(prefs.hq_work_handoff.unwrap_or(true))

apps/sync/src-tauri/src/commands/config.rs
  hq_work_handoff_enabled:
    prefs.and_then(|p| p.hq_work_handoff).unwrap_or(false)
  → prefs.and_then(|p| p.hq_work_handoff).unwrap_or(true)

apps/sync/src-tauri/src/commands/config.rs
  get_hq_work_handoff missing file:
    return Ok(false);
  → return Ok(true);

  hq_work_handoff_from_json untyped fallback:
    .unwrap_or(false)
  → .unwrap_or(true)

crates/hq-desktop-core/src/settings.rs
  apply_defaults:
    hq_work_handoff: Some(prefs.hq_work_handoff.unwrap_or(false))
  → hq_work_handoff: Some(prefs.hq_work_handoff.unwrap_or(true))
```

Then update the unit tests that assert default-off
(`test_hq_work_handoff_defaults_false`, `hq_work_handoff_enabled_none_prefs_is_false`,
`hq_work_handoff_from_json_absent_is_false`, frontend
`hqWorkHandoffEnabled(undefined) === false`).

An explicit `"hqWorkHandoff": false` on disk must still restore the legacy
window after default-on.

## Rollback drill

**Not a live macOS GUI session.** Procedure + automated proof only.

### Procedure

1. Set `hqWorkHandoff` to `false` in `~/.hq/menubar.json` (or omit the key,
   or `set_hq_work_handoff(false)`).
2. Quit and relaunch Sync so boot re-reads the flag.
3. Open HQ (tray, Opt+Shift+O, widget, notification) opens the same
   desktop-alt WINDOW with the **legacy** shell
   (`src/desktop-alt/DesktopApp.svelte`).
4. Tray popover and widget are unchanged.
5. No data loss: **no migration**. Flag off only picks the webview mount.
   Same Cognito session already in Sync.

### Automated proof

Product rollback is the webview boot branch, not `launch_hq_work`. Cite
existing proof on this branch (do not invent new runtime code):

- `resolveDesktopAltShell` / `bootDesktopAltWindow` in
  `apps/sync/src/desktop-alt/boot.ts`: `getHandoff` false → `'legacy'`
- Vitest: `hq-work-sync-handoff-US-103.test.ts` "Given flag off, when the
  tray desktop-view action runs, then legacy desktop-alt mounts"
- `hqWorkHandoffEnabled(undefined/null/false) === false`
- Cargo: `hq_work_handoff_enabled_none_prefs_is_false`;
  `test_hq_work_handoff_defaults_false`
- Two-app leftover `plan_desktop_alt_open(false, …) == OpenDesktopAlt` still
  exists in `hq_work.rs` (`flag_off_opens_desktop_alt_regardless_of_install`)
  but live `maybe_intercept_desktop_alt_handoff` is a no-op; the product
  rollback is the boot branch, not `launch_hq_work`.

Verified 2026-08-27 by running the US-103 vitest + existing default-off
unit tests, not a real Mac GUI.

## Updater size budget

Acknowledge growth from bundling `@hq/ui` into the desktop-alt webview.
Native sidecar (Recall) dominates the ~71 MiB archive; JS growth of a few
MiB is expected and accepted.

### BEFORE (pre-embed, this worktree)

Local artifacts dated **2026-08-26 21:59**, app version **0.10.150**.
Measured on this worktree. Do not treat these as AFTER.

| Artifact | Bytes | Size |
| --- | ---: | ---: |
| Tauri updater archive `apps/sync/src-tauri/target/release/bundle/macos/HQ.app.tar.gz` | 74110996 | 70.68 MiB |
| macOS dmg `apps/sync/src-tauri/target/release/bundle/dmg/HQ_0.10.150_aarch64.dmg` | 73602559 | 70.19 MiB |
| Unpacked `HQ.app` (`du -sh`) | — | 191 MiB |
| Frontend dist (this pre-embed vite build, maps excluded) | 3671007 | 3.50 MiB |
| desktop-alt JS chunk `dist/assets/desktopAlt-Dncufime.js` | 560829 | 0.53 MiB |

Public GitHub redirect
`https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/latest.json`
resolves to **v0.10.150**. The asset is private; no unauthenticated size.
Do not claim `latest.json` bytes from this doc.

### AFTER (flag-on embed of `@hq/ui` DesktopApp)

not measured — requires a signed Sync release build
(`pnpm --filter hq-sync bundle:release` / the v-tag Release workflow that
emits `HQ_<ver>_universal.app.tar.gz` + `latest.json`). Re-measure the same
`HQ.app.tar.gz` path (or GitHub Release `latest.json` darwin-universal url)
on that build and fill the AFTER row.

Do not invent an AFTER number. There is no post-embed release build on this
branch.

### Budget (accept or trim)

- Updater archive `HQ.app.tar.gz`: **+10 MiB** vs BEFORE 70.68 MiB
  (absolute cap 80.68 MiB). Native sidecar (Recall) dominates the 71 MiB;
  JS growth of a few MiB is expected and accepted.
- desktop-alt JS (minified, no maps): **+2.00 MiB** vs BEFORE 0.53 MiB.

If AFTER exceeds the JS budget, **code-split**: change
`apps/sync/src/desktop-alt/main.ts` so `HqWorkDesktopShell` is a
`dynamic import()` only on the flag-on branch (today it is a static import,
so flag-off users still download `@hq/ui`). Vite already splits the
`desktopAlt` entry from `main`. Do not implement that dynamic import in
this story; document it as the trim if AFTER blows the JS budget.

## Removal note (2026-08-27)

**Legacy desktop-alt shell deletion is scheduled one Sync release after default-on bake.**

The WINDOW (label `desktop-alt`, `desktop-alt.html`) is the combined-app
surface and stays. What is retained one bake cycle, then deleted, is the
flag-off **legacy** mount:

- `apps/sync/src/desktop-alt/DesktopApp.svelte` (legacy shell)
- `apps/sync/src/desktop-alt/boot.ts` flag-off / `mountLegacy` branch
- supporting legacy screens under `apps/sync/src/desktop-alt/` that only
  the legacy shell uses

Keep until that follow-up release:

- `apps/sync/src-tauri/src/commands/desktop_alt.rs`
- `apps/sync/desktop-alt.html`
- `apps/sync/src-tauri/tauri.conf.json` window `desktop-alt`
- `apps/sync/src-tauri/capabilities/desktop-alt.json`

Do not delete in the default-on release. Rollback must still work for one
bake cycle. After that Sync release ships and bakes, file a follow-up to
remove the legacy shell and the boot branch.

## Related

- US-101 consume — `docs/hq-work-ui-consume.md`
- US-102 adapter — `src/lib/hq-work-adapter.ts`
- US-103 mount — `src/desktop-alt/boot.ts`, `HqWorkDesktopShell.svelte`
- US-104 routing — notification / conversation clicks into this window
- US-105 parity
- US-107 live smoke: [hq-work-embedded-smoke.md](hq-work-embedded-smoke.md)
