> **SUPERSEDED.** Combined-app rollout (embed `@hq/ui` DesktopApp in the
> desktop-alt window) is documented in
> [hq-work-embedded-rollout.md](hq-work-embedded-rollout.md). This file is
> the historical two-app launch / co-install / card procedure. Kept because
> existing tests source-contract it. Do not delete.

# HQ Work handoff — rollout, bake, rollback

Flag-gated handoff from Sync's desktop-alt window to the HQ Work app
(`ai.getindigo.hq-work`). Tray popover and widget stay in Sync. No account or
data migration.

**Default is off.** Broader default-on is a config change, not a leap. Do not
flip the compiled default until this doc's bake checklist is done.

## Alpha enable (`@getindigo.ai`)

Internal team is the alpha cohort (`@getindigo.ai`). There is no Settings
toggle for this flag — do not add one. Enable per machine:

1. Set `hqWorkHandoff` to `true` in `~/.hq/menubar.json` (merge; do not
   overwrite other keys):

   ```json
   {
     "hqWorkHandoff": true
   }
   ```

   Same write path as the Tauri command `set_hq_work_handoff(true)`
   (`merge_menubar_flags` on `hqWorkHandoff`).

2. Quit and relaunch Sync.

3. Confirm in logs (below): `[handoff] handoff.detected` on Open HQ / launch
   co-install.

Existing installs without the key keep desktop-alt. Flag on + HQ Work missing
shows the US-003 card. Flag on + installed launches HQ Work.

## Default stays false (do not flip in this release)

| Site | Default-off |
| --- | --- |
| `MenubarPrefs.hq_work_handoff` | `Option<bool>`, absent → `None` (`crates/hq-desktop-core/src/config.rs`) |
| `get_settings` no-file branch | `hq_work_handoff: Some(false)` |
| `get_settings` file-present branch | `prefs.hq_work_handoff.unwrap_or(false)` |
| `hq_work_handoff_enabled` | `.unwrap_or(false)` |
| `get_hq_work_handoff` missing file | `Ok(false)` |

Frontend `hqWorkHandoffEnabled` is `flag === true` (null/undefined → false).

## Default-on (copy-paste when baking)

When alpha is baked and launch is a config change, flip **all** of these in
the same Sync release. The intercept path reads `get_hq_work_handoff` /
`hq_work_handoff_enabled`, not only Settings.

**Canonical one-liners** (US-006):

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
```

**Lockstep** (otherwise Settings vs Open HQ disagree):

```text
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

An explicit `"hqWorkHandoff": false` on disk must still restore desktop-alt
after default-on.

## Handoff events (QA sampling)

Append-only log: `~/.hq/logs/hq-sync.log` (rotated `hq-sync.log.1` … `.3`).
Category is `handoff`. Shape:

```text
2026-08-26T12:00:00.000Z [handoff] handoff.detected installed=true
```

```bash
grep '\[handoff\]' ~/.hq/logs/hq-sync.log
```

| Event | Log line | When |
| --- | --- | --- |
| detected | `handoff.detected installed={true\|false}` | Each desktop-alt / channel / DM intercept; once per launch co-install check |
| launched | `handoff.launched {url\|hqwork://open}` | HQ Work `open` succeeded |
| card-shown | `handoff.card_shown first={true\|false}` | US-003 overlay shown |
| co-installed | `handoff.co_installed` | Silent co-install succeeded (also `co_install ok`) |
| failed | `handoff.failed {err}` | Launch or co-install failure (co-install also logs `co_install failed:`) |

Skip noise stays on the same category (`co_install skipped: flag off`,
`already installed`, `user uninstalled HQ Work`, `already attempted this version`).
Do not log on every app-activate cache refresh.

## Rollback drill

**Not a live macOS GUI session.** Procedure + automated proof only.

### Procedure

1. Set `hqWorkHandoff` to `false` in `~/.hq/menubar.json` (or
   `set_hq_work_handoff(false)`).
2. Quit and relaunch Sync so intercept re-reads the flag.
3. Open HQ (tray, Opt+Shift+O, widget, notification) opens **desktop-alt**.
4. Tray popover and widget are unchanged.
5. No data loss: this handoff has **no migration**. Both apps sign into the
   same Cognito pool independently. Flag off only picks the window.

`settings:updates` already stays on desktop-alt even with the flag on
(updater ticket UI has no HQ Work equivalent).

### Automated proof

`plan_desktop_alt_open(false, …) == OpenDesktopAlt` regardless of install
state. Unit test:

`flag_off_opens_desktop_alt_regardless_of_install` in
`apps/sync/src-tauri/src/commands/hq_work.rs`

```text
plan_desktop_alt_open(false, true,  …) → OpenDesktopAlt
plan_desktop_alt_open(false, false, …) → OpenDesktopAlt
```

Also `plan_three_outcomes_table` and source-contract
`hq-work-sync-handoff-US-005.test.ts` (`flag off restores desktop-alt
regardless of install`). Desktop-alt window builder (`WINDOW_LABEL`,
`desktop-alt.html`) is retained.

Verified 2026-08-26 by running those unit / source-contract tests, not a
real Mac GUI.

## Removal note (2026-08-26)

**desktop-alt deletion is scheduled one Sync release after default-on bake.**

Keep the window code until that release:

- `apps/sync/src-tauri/src/commands/desktop_alt.rs`
- `apps/sync/desktop-alt.html`, `apps/sync/src/desktop-alt/`
- `apps/sync/src-tauri/tauri.conf.json` window `desktop-alt`
- `apps/sync/src-tauri/capabilities/desktop-alt.json`

Do not delete in the default-on release. Rollback must still work for one
bake cycle. After that Sync release ships and bakes, file a follow-up to
remove desktop-alt and the intercept's `OpenDesktopAlt` arm.

## Related

- US-002 detection / launch / flag — `src-tauri/src/commands/hq_work.rs`,
  `commands/config.rs`
- US-003 handoff card
- US-004 silent co-install
- US-005 reroute (`plan_desktop_alt_open` / `maybe_intercept_*`)
- US-007 smoke checklist: [hq-work-handoff-qa.md](hq-work-handoff-qa.md)
  (live-machine Results stay blank until an operator run)
- US-007 (later): live-machine smoke checklist before flipping beyond alpha
