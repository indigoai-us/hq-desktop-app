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
app, no co-install, no account or data migration. Flag **defaults off**.

This file is the script. The **Results** section is blank until an operator
records a live run against a **this-branch** bundle (not the stale pre-embed
`HQ.app` under `target/release/bundle`).

## Flag file and logs

Flag (merge; do not overwrite other keys): `~/.hq/menubar.json`

```json
{
  "hqWorkHandoff": true
}
```

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

- This-branch HQ.app (or debug bundle) whose inner `Contents/MacOS` binary
  contains a distinctive embed string (`HqWorkDesktopShell` or
  `createSyncPlatformAdapter`) and whose mtime matches the build just run.
  Stale `target/release/bundle/macos/HQ.app` from before US-101 is **not**
  valid proof (custom-protocol assets are compiled into the binary).
- Signed-in HQ Sync session (canonical `vault-users-*` Cognito). Alpha
  operator: `@getindigo.ai`.
- Kill any other `ai.indigo.hq-sync-menubar` process before launching the
  worktree bundle so AX / tray clicks hit this binary.
- Restore `hqWorkHandoff` and the production `/Applications/HQ.app` after
  the run.

Merge helper:

```bash
python3 -c 'import json,sys; from pathlib import Path
flag = sys.argv[1].lower()=="true"
p = Path.home()/".hq"/"menubar.json"
p.parent.mkdir(parents=True, exist_ok=True)
data = json.loads(p.read_text()) if p.exists() else {}
if flag:
    data["hqWorkHandoff"] = True
else:
    data.pop("hqWorkHandoff", None)
p.write_text(json.dumps(data, indent=2)+"\n")
print("hqWorkHandoff", data.get("hqWorkHandoff"))
' true
```

---

## Scenario 1: Cold start, flag off (legacy)

**Goal:** Default-off cold start still shows the legacy desktop-alt shell.
No embed, no extra handoff probes.

### Steps

1. Ensure `hqWorkHandoff` is absent or false. Quit HQ fully.
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

- [ ] Pass — Scenario 1: Cold start, flag off (legacy)

**Operator notes:**

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

- [ ] Pass — Scenario 2: Flag on — embedded shell + sign-in reuse

**Operator notes:**

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

- [ ] Pass — Scenario 3: Notification / widget tap routing

**Operator notes:**

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

- [ ] Pass — Scenario 4: Flag-off rollback

**Operator notes:**

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

- [ ] Pass — Scenario 5: Update-in-place / updater path intact
- [ ] N/A — no signed AFTER release on this branch; config-flip relaunch only

**Operator notes:**

---

## Results (live machine)

Fill during one operator run. Leave scenario boxes `[ ]` until that run.

| Field | Value |
| --- | --- |
| Date | _YYYY-MM-DD_ |
| Machine | _macOS version, chip_ |
| Operator | _name / @getindigo.ai_ |
| Bundle | _path + binary mtime + distinctive string_ |
| Sync identity | _signed-in / not (no token values)_ |
| `hqWorkHandoff` after run | _absent/false_ (restore default-off) |
| Overall | **not executed** |

| Scenario | Pass | Fail | Notes |
| --- | --- | --- | --- |
| 1 Cold start, flag off | | | |
| 2 Flag on embed + sign-in reuse | | | |
| 3 Notification / widget tap routing | | | |
| 4 Flag-off rollback | | | |
| 5 Update-in-place | | | |

Log excerpt pointer (path only, no secrets): `~/.hq/logs/hq-sync.log` from
_HH:MM_ to _HH:MM_.
