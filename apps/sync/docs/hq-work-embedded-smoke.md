# HQ Work embedded window — live smoke checklist (US-107)

Executable checklist for the **combined-app** embed: HQ Work's `@hq/ui`
DesktopApp inside Sync's desktop-alt window. Run **once on a real macOS
machine** before flipping `hqWorkHandoff` beyond the alpha cohort
(`@getindigo.ai`).

Canonical file: this document. It **supersedes** the two-app
[hq-work-handoff-qa.md](hq-work-handoff-qa.md) (card / co-install / launch HQ
Work / `hqwork://` hop). Keep that file only because existing tests
source-contract it.

Rollout, bake, rollback, updater budget:
[hq-work-embedded-rollout.md](hq-work-embedded-rollout.md). Fixture parity
(not a live Mac): [hq-work-embedded-qa.md](hq-work-embedded-qa.md).

macOS only. Tray popover, widget, and sync engine stay in Sync. No second
app, no co-install, no account or data migration.

The flag **defaults ON for `@getindigo.ai`** and off for everyone else. For an
operator running this checklist that inverts Scenario 1: *absent* no longer
means off, so the flag-off scenario must write an explicit `false`.

Executed once on a real machine — see [Results](#results-live-machine).
Re-record that section from scratch for any later run; it must always describe a
**this-branch** bundle, never the stale pre-embed `HQ.app` under
`target/release/bundle` and never a bundle the updater has replaced.

## Flag file and logs

Flag (merge; do not overwrite other keys): `~/.hq/menubar.json`

```json
{
  "hqWorkHandoff": true
}
```

**The key is a preference, not an authorisation.** `~/.hq/menubar.json` is a
plain user-writable file, so `get_hq_work_handoff` resolves
`is_indigo_user() AND (choice defaulting to true)`. Inside the
`@getindigo.ai` cohort the embed is on unless the user writes an explicit
`false`; outside it, the embed is off no matter what the file says, so writing
`"hqWorkHandoff": true` there still gets nothing. `set_hq_work_handoff(true)`
refuses outright rather than writing a key the reader would ignore. Same
`is_indigo_user` gate the updater uses for pre-release channels, so "who is
Indigo" has one definition.

Practical consequence for this checklist: **run it signed in as
`@getindigo.ai`**. Signed in as anyone else, every scenario below correctly
shows the legacy shell, and Scenario 2 will look like a failure when it is the
gate doing its job.

Same write path as `set_hq_work_handoff(true)`. Inspect without dumping
secrets:

```bash
python3 - <<'PY'
import json
from pathlib import Path
p = Path.home() / ".hq" / "menubar.json"
data = json.loads(p.read_text()) if p.exists() else {}
print({"hqWorkHandoff": data.get("hqWorkHandoff")})
PY
```

Quit and relaunch Sync after every flag edit so boot re-reads the file.

Combined-app must **not** emit two-app `[handoff] launched` / `card_shown` /
`co_installed` lines for Open HQ. Flag-off Open HQ must not add extra
`[handoff]` probes (finding-6).

Do not paste `~/.hq/cognito-tokens.json` into Results.

## Prerequisites (every scenario)

- **Turn `autoUpdate` off in `~/.hq/menubar.json` before the first launch, and
  restore it afterwards.** This is not optional hygiene — it is the difference
  between a valid run and a fictional one. `setup_update_checker` waits 10 s
  after launch and, when `auto_update_enabled()` is true, calls
  `download_and_install` + `handle.restart()`. The Tauri updater replaces the
  bundle it is *running from*, so a worktree `HQ.app` is silently overwritten
  by the released build within ~10 s of `open`, and every scenario after that
  exercises the release — which has no embed at all. Observed on the first
  attempt of the 2026-08-28 run: the worktree binary became byte-identical to
  `/Applications/HQ.app` (same sha256, same 87 MB, same mtime) and flag-on kept
  serving the legacy shell. Scenario 5's "do not install a production update"
  instruction is not self-enforcing; this flag is what enforces it.

  ```bash
  python3 -c 'import json,sys
  from pathlib import Path
  p = Path.home()/".hq"/"menubar.json"
  d = json.loads(p.read_text())
  d["autoUpdate"] = sys.argv[1].lower() == "true"
  p.write_text(json.dumps(d, indent=2)+"\n")
  print("autoUpdate", d["autoUpdate"])
  ' false
  ```

- This-branch HQ.app (or debug bundle) proven by **all three** of:
  1. `shasum -a 256 …/HQ.app/Contents/MacOS/hq-sync-menubar` differs from
     `/Applications/HQ.app/Contents/MacOS/hq-sync-menubar`, and its mtime
     matches the build just run. Re-check this **after** each launch — that is
     what catches the updater overwrite above.
  2. The desktop window title bar reads the branch's `App v<x.y.z>`
     (`__APP_VERSION__`, compiled from `apps/sync/package.json`). A release
     version there means you are looking at the release build.
  3. `grep -l hq-work-embedded-shell apps/sync/dist/assets/*.js` matches the
     content-hashed asset name embedded in the binary
     (`strings -a <binary> | grep -o 'desktopAlt-[A-Za-z0-9_-]*\.js'`).

  Do **not** try to `strings` the binary for `HqWorkDesktopShell` or
  `createSyncPlatformAdapter` as earlier drafts of this file suggested. Tauri
  compresses embedded frontend assets, so component names never appear as
  plain text and the check returns 0 hits for a perfectly good bundle. Only
  the asset *filenames* survive as plain strings.

  Stale `target/release/bundle/macos/HQ.app` from before US-101 is **not**
  valid proof.
- Signed-in HQ Sync session (canonical `vault-users-*` Cognito). Alpha
  operator: `@getindigo.ai`.
- Kill any other `ai.indigo.hq-sync-menubar` process before launching the
  worktree bundle so AX / tray clicks hit this binary.
- The screen must be **unlocked**. At the macOS lock screen the tray, the
  `Opt+Shift+O` global shortcut, and AX queries all silently no-op: the app
  runs, but no window is ever created and nothing reports an error.
- Restore `hqWorkHandoff`, `autoUpdate`, and the production
  `/Applications/HQ.app` after the run.

Merge helper:

Merge helper. Note it writes an explicit `false` rather than deleting the key:
for an `@getindigo.ai` operator, deleting it means *default on*, so the old
delete-to-disable helper would have silently made Scenario 1 test the wrong
thing.

```bash
python3 -c 'import json,sys; from pathlib import Path
p = Path.home()/".hq"/"menubar.json"
p.parent.mkdir(parents=True, exist_ok=True)
data = json.loads(p.read_text()) if p.exists() else {}
data["hqWorkHandoff"] = sys.argv[1].lower()=="true"
p.write_text(json.dumps(data, indent=2)+"\n")
print("hqWorkHandoff", data.get("hqWorkHandoff"))
' true
```

To clear the key entirely afterwards (back to the cohort default), remove it:

```bash
python3 -c 'import json; from pathlib import Path
p = Path.home()/".hq"/"menubar.json"
data = json.loads(p.read_text())
data.pop("hqWorkHandoff", None)
p.write_text(json.dumps(data, indent=2)+"\n")
print("hqWorkHandoff", data.get("hqWorkHandoff"))
'
```

---

## Scenario 1: Cold start, flag off (legacy)

**Goal:** Default-off cold start still shows the legacy desktop-alt shell.
No embed, no extra handoff probes.

### Steps

1. Set `hqWorkHandoff` to an explicit `false` — for an `@getindigo.ai`
   operator, absent now resolves to ON. Quit HQ fully.
2. Launch the this-branch bundle. Wait until the tray icon is up.
3. Open HQ (tray Open HQ / Opt+Shift+O).
4. Confirm the **legacy** desktop-alt shell (projects / board / v4 chrome),
   not `@hq/ui` DesktopApp (no chat sidebar / channel list as the full
   window).
5. Confirm tray popover and widget still work.

### Expected

- Same desktop-alt WINDOW label (`desktop-alt`).
- Boot resolved `'legacy'` (`boot.ts` / `resolveDesktopAltShell`).
- No new `[handoff] launched` / `card_shown` / `co_installed`.

- [x] Pass — Scenario 1: Cold start, flag off (legacy)

**Operator notes:** *(Recorded before the embed became default-on for the
cohort. At the time, "flag absent" was the off state; an operator repeating
this scenario today must write an explicit `false` instead. The observed
behaviour — legacy shell for the resolved-off case — is unchanged.)*
Flag absent, `autoUpdate` false, fresh debug bundle
(sha256 `df694705…`, 163,601,600 bytes, built 17:47 PKT). Binary sha re-checked
25 s after `open` — unchanged, so no updater overwrite. `Opt+Shift+O` opened one
`desktop-alt` window at 166,57 (1180x760). Legacy shell confirmed: HQ sidebar
(Inbox / Messages / Meetings / Marketplace / Library / Files), WORKSPACES +
COMPANIES tree, project board with Needs you / In flight / Goals / Recent
activity. Title bar read `App v0.10.150` — the branch version, not the installed
`v0.10.156`. No `[handoff] launched` / `card_shown` / `co_installed` lines in
`hq-sync.log` for the whole run. Tray helper alive throughout.

---

## Scenario 2: Flag on — embedded shell + sign-in reuse

**Goal:** Flag on, Open HQ mounts `@hq/ui` DesktopApp in the **same**
desktop-alt window. No second app. No second sign-in.

### Steps

1. Merge `hqWorkHandoff: true`. Quit and relaunch the this-branch bundle.
2. Confirm tray still shows the existing signed-in identity (no Cognito
   prompt).
3. Open HQ.
4. Confirm the window is the HQ Work shell: sidebar channels / DMs, not
   the legacy project board. Window title/chrome still HQ.
5. Confirm `/Applications/HQ Work.app` was **not** launched as the desktop
   view (standalone HQ Work may already be installed; this click must not
   front it as the product path).
6. ⌘, opens **embedded** settings inside this window (no extra settings
   window).

### Expected

- Boot resolved `'hq-work'`. `createSyncPlatformAdapter` is the host.
- Same Cognito session as the tray. No OAuth sheet for this Open HQ.
- Tray popover and widget unchanged.

- [x] Pass — Scenario 2: Flag on — embedded shell + sign-in reuse

**Operator notes:** `hqWorkHandoff: true` merged, app quit and relaunched,
binary sha unchanged after 20 s. Same `desktop-alt` window geometry (166,57
1180x760) now renders `@hq/ui` DesktopApp: channel sidebar with `# hq-desktop-v2`
(Indigo · project channel), Chat / Board / Files tabs, member count, and the
message composer. Sign-in carried over with no Cognito sheet — account chip
bottom-left read `SIGNED IN` and real channel history loaded on first paint.
`ps` showed no `HQ Work.app` process at any point in the run, and no
`launch_hq_work` in the log. Cmd+, opened Settings **inside** this window
(Profile / Companies / General / Appearance / Notifications / Sync / Meetings /
Updates, with a `← Back` affordance) and the AX window count stayed at 1 — no
second settings window.

Minor, not a gate: the embedded Settings → Profile pane rendered
"No data — No profile data yet." while the same session's identity chip showed
`SIGNED IN`. Worth a follow-up on how the embedded profile pane sources identity
from this host.

---

## Scenario 3: Notification → correct channel (reply when payload has one)

**Goal:** Flag on. A channel-message notification (or widget tap that
carries a channel/person/reply) focuses this window and opens that
conversation via pending-open — no `hqwork://` hop to HQ Work.app.

### Steps

1. Flag on, embedded window already proven in scenario 2.
2. Click a Sync tray/widget/notification for a channel message. If a reply
   id is on the payload, the reply thread should open.
3. Confirm the **embedded** window focused and the target channel (and
   reply thread when present) is selected.
4. Optional: if the OS delivers `hqwork://open?channel=…` to this process,
   it uses the same internal path; malformed URLs are ignored (no dialog).

### Expected

- `validate_hqwork_deep_link` / `hqwork_query_token` still gate the tokens.
- No `launch_hq_work`. No card.

- [x] Pass — Scenario 3: Notification / widget tap routing

**Operator notes:** Driven through the real product path rather than a
synthesised route. Four self-addressed DMs sent with `hq dm` produced
`DM_NOTIFY_CUSTOM_BANNER` + `[banner] show: kind=dm` and the custom banner
window (`dm-banner`, 366 px wide, top-right at 1132,40). Clicking the banner
card body logged `[banner] action request=… kind=dm action=open`, and the
embedded window came forward with the correct conversation selected — the
`prs_01KQ2TZQMA…` Direct message thread showing all four test messages. Title
bar version chip read `Desktop app v0.10.150`. No `launch_hq_work`, no handoff
card, no `HQ Work.app` process.

Driving note for the next operator: the banner window does not accept first
mouse. A single synthetic CGEvent click only focuses it and logs nothing —
send the click twice, roughly a second apart. The banner also auto-dismisses
in a few seconds, so send the DM and click inside the same command rather than
across two.

Reply-thread deep links (`&reply=`) were not exercised live; that path is
covered by the US-104 story tests, which now pass against
hq-work-mono `2aff667`.

External `hqwork://` delivery was **not** exercised: this bundle's Info.plist
declares no `CFBundleURLTypes`, so macOS routes `hqwork://` to the separately
installed HQ Work.app, not to Sync. The in-process route (the product path
above) is what US-104 actually ships.

---

## Scenario 4: Flag-off rollback

**Goal:** Turning the flag off restores the legacy window with zero data
loss.

### Steps

1. Merge `hqWorkHandoff: false` (or omit the key).
2. Quit and relaunch.
3. Open HQ: legacy desktop-alt shell, same window.
4. Confirm companies, messages, and the Cognito session are intact (flag
   only picks the webview mount; no migration).
5. Tray popover and widget unchanged.

### Expected

- Automated proof already in US-103 vitest + default-off unit tests. This
  scenario is the live confirmation.

- [x] Pass — Scenario 4: Flag-off rollback

**Operator notes:** `hqWorkHandoff` key removed, app quit and relaunched. Open HQ
returned the legacy desktop-alt shell in the same window, with the sync chip
reading `All synced · 21 watched`, the signed-in identity intact
(`Hassaan Saleem`), and the COMPANIES tree unchanged. No re-auth, no data
migration, no loss — the flag only selects the webview mount, as designed.

---

## Scenario 5: Update-in-place

**Goal:** The embed does not break the existing Sync updater path. A
this-branch build still talks to the signed updater feed; flipping the
flag does not require a reinstall of Sync.

### Steps

1. Flag off, then flag on, relaunching between (scenarios 1–4 already did
   this). Confirm the app still launches and the tray identity survives.
2. Open updater settings if reachable from the tray / embedded settings.
   Confirm it still points at the existing HQ Sync feed (not HQ Work's
   feed). Do **not** install a production update over the worktree bundle
   during this run.
3. Record whether a full update-in-place from an older **released** HQ.app
   to a future embed release was **not** in scope for this branch (no
   signed AFTER artifact yet — see rollout doc).

### Expected

- Flag is config-only. No second installer.
- AFTER updater size still unmeasured until a signed release build (see
  [hq-work-embedded-rollout.md](hq-work-embedded-rollout.md)).

- [x] Pass — Scenario 5: Update-in-place / updater path intact
- [x] N/A — no signed AFTER release on this branch; config-flip relaunch only

**Operator notes:** The app launched cleanly across four flag flips
(off → on → off) with the tray identity surviving every relaunch; the flag is
config-only and never required a reinstall. The updater still resolves the **HQ
Sync** feed —
`[updater] resolved channel=beta endpoint=https://github.com/indigoai-us/hq-desktop-app/releases/download/v0.10.156/latest.json provenance=ChannelRelease`
— and no HQ Work release endpoint appears anywhere in the run's log. With
`autoUpdate` off, the tray popover correctly degraded to a manual
"Update available HQ v0.10.156" notice instead of installing, which is the
intended recovery path.

Update-in-place from an older **released** HQ.app to a future embed release is
N/A here: this branch produces no signed AFTER artifact (`tauri build` reports
"A public key has been found, but no private key", and `sign-bundle.sh` finds no
`HQ Installer Dev` identity on this machine), so the AFTER updater size stays
unmeasured — see [hq-work-embedded-rollout.md](hq-work-embedded-rollout.md).

The strongest evidence that the updater path is intact is unfortunately the
first attempt at this run, where it worked *too* well: with `autoUpdate` on, the
running app downloaded v0.10.156 and installed it over the worktree bundle
within seconds of launch. See the Prerequisites section.

---

## Results (live machine)

Recorded from one operator run. Re-run and rewrite this section wholesale for
any later verification; do not append.

| Field | Value |
| --- | --- |
| Date | 2026-08-28 |
| Machine | macOS 26.3 (build 25D125), Apple silicon (arm64), 1512x982 logical display |
| Operator | Hassaan Saleem / hassaan@getindigo.ai |
| Bundle | `apps/sync/src-tauri/target/debug/bundle/macos/HQ.app` — binary sha256 `df6947055d2daea295494965a0ea6acabad526215f7208042de0bce505f618e7`, 163,601,600 bytes, built 2026-08-28T17:47:14+0500. Distinct from the installed release (`7b54377fcef6236d339431a37041687162991c08f176c82602aa5caf3673eeac`). Title bar read `App v0.10.150` (branch) vs the installed `v0.10.156`. |
| Source | hq-desktop-app `feature/hq-work-sync-handoff` @ `74098c15`; hq-work-mono `main` @ `2aff667` linked via the `file:` pins |
| Build gates | svelte-check 0 errors, lint 0 errors, 2288 vitest tests across 224 files, `cargo check` clean |
| Sync identity | Signed in for the whole run; no Cognito sheet at any point (no token values recorded) |
| `autoUpdate` during run | `false` (mandatory — see Prerequisites); restored to `true` afterwards |
| `hqWorkHandoff` after run | absent (default-off restored) |
| Overall | **pass — 5 of 5** |

| Scenario | Pass | Fail | Notes |
| --- | --- | --- | --- |
| 1 Cold start, flag off | ✓ | | Legacy desktop-alt shell; branch build confirmed by sha + version |
| 2 Flag on embed + sign-in reuse | ✓ | | `@hq/ui` DesktopApp in the same window; no re-auth; ⌘, embedded; no HQ Work.app |
| 3 Notification / widget tap routing | ✓ | | Real DM banner click → embedded window focused on the correct DM thread |
| 4 Flag-off rollback | ✓ | | Legacy shell restored, identity and companies intact |
| 5 Update-in-place | ✓ | | Sync updater feed intact; full update-in-place N/A (no signed AFTER artifact) |

Log excerpt pointer (path only, no secrets): `~/.hq/logs/hq-sync.log` from
12:41Z to 13:05Z on 2026-08-28 (17:41–18:05 PKT).

### Blocking defects found and fixed before this run could start

The branch as handed over did not build, typecheck, or pass its own tests
against a checkout of hq-work-mono, so none of the scenarios above were
runnable. Fixed in `74098c15`:

- US-104 imported `requestDeepLinkOpen` from `@hq/ui`; that symbol exists
  nowhere in hq-work-mono's history. `vite build` failed at rollup and 4 of 10
  US-104 story tests failed. The mapping now lives in the Sync host over
  `requestChannelOpen` / `requestConversation`.
- US-102's `appShell` omitted `setDesktopWidget` and `showOsNotification`,
  required by `@hq/platform`'s `AppShellApi` since 2026-08-26. They now return
  a `host-owned` unavailable result — Sync owns the tray, widget, and banners.
- US-101's story test resolved `@hq/{ui,core}/package.json`, a subpath neither
  package exports.
- US-103's `HqWorkDesktopShell` tore down its `desktop:navigate` listener
  without `safeUnlisten`, which the repo's cross-cutting listener test requires.

A new `hq-work-adapter-contract-parity` test derives the required member list
from `@hq/platform`'s own `adapter.ts` and asserts group-by-group parity at
runtime, so the `appShell` class of gap fails vitest and not just svelte-check.

### Follow-ups this run surfaced (none block the alpha flag)

1. Embedded Settings → Profile renders "No profile data yet." while the same
   session reports `SIGNED IN`.
2. External `hqwork://` delivery to Sync is unreachable — the bundle declares no
   `CFBundleURLTypes`, so macOS routes the scheme to the standalone HQ Work.app.
   Decide whether Sync should claim the scheme under the flag, or drop the
   optional external-URL step from this checklist.
3. The floating widget could not be visually re-verified: `widgetEnabled` was
   `false` for this operator before and after, so "widget unchanged" is
   asserted from configuration, not from pixels.
