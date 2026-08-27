# HQ Work handoff — QA smoke checklist

Executable checklist for the HQ Sync → HQ Work desktop-view handoff. Run
**once on a real macOS machine** before flipping `hqWorkHandoff` beyond the
alpha cohort (`@getindigo.ai`).

Canonical file: this document (`apps/sync/docs/hq-work-handoff-qa.md`).
Rollout, bake, and rollback procedure: [hq-work-handoff.md](hq-work-handoff.md).

macOS only. Tray popover and widget stay in Sync. No account or data
migration. Flag **defaults off**.

This file is the script. The **Results** section at the bottom is blank until
an operator records a live run. Do not mark Results from a coding session.

## Flag file and logs

Flag (merge; do not overwrite other keys): `~/.hq/menubar.json`

```json
{
  "hqWorkHandoff": true
}
```

Same write path as `set_hq_work_handoff(true)`. Related keys operators may
see:

| Key | Role |
| --- | --- |
| `hqWorkHandoff` | Intercept + co-install gate. Absent → off. |
| `hqWorkHandoffCardShown` | First-show emphasis for the US-003 card. |
| `hqWorkUninstalled` | User removed HQ Work → skip silent co-install. |
| `hqWorkLastSeenInstalled` | Last detect result; used to infer uninstall. |
| `hqWorkCoInstalledForVersion` | Once-per-Sync-version co-install marker. |

Inspect without dumping secrets:

```bash
python3 - <<'PY'
import json
from pathlib import Path
p = Path.home() / ".hq" / "menubar.json"
data = json.loads(p.read_text()) if p.exists() else {}
keys = (
    "hqWorkHandoff",
    "hqWorkHandoffCardShown",
    "hqWorkUninstalled",
    "hqWorkLastSeenInstalled",
    "hqWorkCoInstalledForVersion",
)
print({k: data.get(k) for k in keys})
PY
```

Handoff events append to `~/.hq/logs/hq-sync.log` (rotated `.1` … `.3`).
Category is `handoff` (bracketed `[handoff]`):

```bash
grep '\[handoff\]' ~/.hq/logs/hq-sync.log
```

| Event | Line | When |
| --- | --- | --- |
| detected | `handoff.detected installed={true\|false}` | Each desktop-alt / channel / DM intercept; once per launch co-install check |
| launched | `handoff.launched {url\|hqwork://open}` | HQ Work `open` succeeded |
| card-shown | `handoff.card_shown first={true\|false}` | US-003 overlay shown |
| co-installed | `handoff.co_installed` | Silent co-install succeeded (also `co_install ok`) |
| failed | `handoff.failed {err}` | Launch or co-install failure (co-install also `co_install failed:`) |

Skip noise on the same category: `co_install skipped: flag off`,
`already installed`, `user uninstalled HQ Work`,
`already attempted this version`.

Do not paste `~/.hq/cognito-tokens.json` or other secret files into Results.

## Prerequisites (every scenario)

- macOS machine with a signed-in HQ Sync tray (`ai.indigo.hq-sync-menubar`,
  product name HQ). Alpha operator: `@getindigo.ai`.
- Network to the HQ Work updater feed
  `https://indigo-electron-releases.s3.us-east-1.amazonaws.com/hq-work/latest.json`.
- HQ Work bundle id `ai.getindigo.hq-work`. Detect: Spotlight
  `kMDItemCFBundleIdentifier == 'ai.getindigo.hq-work'` or
  `/Applications/HQ Work.app`.
- Quit and relaunch Sync after every `menubar.json` flag edit so intercept
  re-reads the file.

Merge helper (true/false):

```bash
python3 -c 'import json,sys; from pathlib import Path
flag = sys.argv[1].lower()=="true"
p = Path.home()/".hq"/"menubar.json"
p.parent.mkdir(parents=True, exist_ok=True)
data = json.loads(p.read_text()) if p.exists() else {}
data["hqWorkHandoff"] = flag
p.write_text(json.dumps(data, indent=2)+"\n")
print("hqWorkHandoff", data["hqWorkHandoff"])
' true
```

Confirm HQ Work present/absent:

```bash
ls -d "/Applications/HQ Work.app" 2>/dev/null || echo "HQ Work.app absent"
mdfind "kMDItemCFBundleIdentifier == 'ai.getindigo.hq-work'"
```

---

## Scenario 1: Fresh machine (no HQ Work) → card → install → open

**Goal:** Flag on, HQ Work never installed, Open HQ shows the ghost
"desktop view moved" card. Install then Open launches HQ Work.

**Why isolate the card:** with the flag on and no uninstall marker, next-launch
silent co-install (scenario 2) may install HQ Work before the operator clicks
Open HQ. Pin `hqWorkCoInstalledForVersion` to the **running Sync version** so
co-install skips (`already attempted this version`) and the card path is
exercised.

### Steps

1. Confirm `/Applications/HQ Work.app` is absent (quit HQ Work first if it was
   running; move the bundle to Trash and empty, or `rm -rf`).
2. Merge `hqWorkHandoff: true`. Set `hqWorkUninstalled` false/absent,
   `hqWorkLastSeenInstalled` false/absent. Set
   `hqWorkCoInstalledForVersion` to the running Sync version (About / tray
   version, currently documented as `0.10.150` in-tree — use the live string).
3. Quit and relaunch HQ Sync.
4. Open HQ (tray Open HQ / Opt+Shift+O). Do **not** expect desktop-alt.
5. Confirm the compact popover overlay: title **The HQ desktop view moved**,
   body mentions HQ Work, CTA **Install** (`data-testid="hq-work-handoff-install"`).
6. Click Install. Wait until the CTA becomes **Open** (no unsigned-bytes
   error).
7. Click Open. HQ Work launches (`ai.getindigo.hq-work`).
8. Blur / click away: compact tray popover returns to normal (left-click tray
   still works).

### Expected

- Desktop-alt window does **not** open.
- Card copy is ghost layout (no extra card chrome). Install is user-initiated
  from the signed feed (minisign); not opened by mere detection.
- After install, `/Applications/HQ Work.app` exists.

### Logs to grep

```bash
grep '\[handoff\]' ~/.hq/logs/hq-sync.log
```

Look for, in order:

- `handoff.detected installed=false`
- `handoff.card_shown first=true` (or `first=false` on a repeat)
- later `handoff.detected installed=true` and `handoff.launched hqwork://open`
  (generic Open uses bundle-id launch; the log line still prints
  `hqwork://open` when no query URL was passed)

Fail: `handoff.failed`, Install stuck, unsigned-bytes refusal, or desktop-alt
appearing while the flag is on and HQ Work is missing.

- [ ] Pass — Scenario 1: Fresh machine (no HQ Work) → card → install → open

**Operator notes:**

---

## Scenario 2: Upgrade path co-install

**Goal:** Existing Sync user, flag on, HQ Work never installed, **no** card
click. Next launch silently co-installs from the same signed feed. No windows,
dialogs, or extra TCC prompts from the co-install path.

### Steps

1. Quit HQ Work. Remove `/Applications/HQ Work.app`.
2. Merge `hqWorkHandoff: true`. **Clear** (delete keys or set false/empty):
   `hqWorkUninstalled`, `hqWorkLastSeenInstalled`,
   `hqWorkCoInstalledForVersion`. Last-seen must not be true-then-missing
   (that marks uninstall and skips forever).
3. Quit HQ Sync fully. Relaunch. Do **not** click Open HQ for ~30–60s.
4. Confirm HQ Work appears under `/Applications` without a card, dialog, or
   focus steal.
5. Then Open HQ: HQ Work comes to front (no card).
6. Optional negative: set `hqWorkUninstalled: true`, remove the app, relaunch
   — co-install must skip (`user uninstalled HQ Work`). Restore the key
   afterwards.

### Expected

- Co-install uses the public updater feed and refuses unsigned bytes.
- Tray popover and widget never open as part of co-install.
- Once-per-version: a second relaunch of the **same** Sync version skips
  (`already attempted this version`) even if the first attempt failed after
  retries.

### Logs to grep

```bash
grep '\[handoff\]' ~/.hq/logs/hq-sync.log
```

Look for:

- `handoff.detected installed=false` on the co-install check
- `handoff.co_installed` and `co_install ok`
- after Open HQ: `handoff.detected installed=true` and `handoff.launched`

Skip lines that are **not** this scenario's pass: `co_install skipped: flag off`,
`already installed`, `user uninstalled HQ Work`. Fail: `handoff.failed` /
`co_install failed:` with no app on disk, or a visible installer UI.

- [ ] Pass — Scenario 2: Upgrade path co-install

**Operator notes:**

---

## Scenario 3: Notification → correct channel including reply threads

**Goal:** Flag on, HQ Work installed. A Sync notification (and a native
`hqwork://` open) lands in the right HQ Work conversation, including thread
replies.

Deep-link contract (HQ Work US-001 + Sync URL builder):

| Target | URL |
| --- | --- |
| Channel | `hqwork://open?channel={id}` |
| Channel thread | `hqwork://open?channel={id}&reply={rootEventId}` |
| DM | `hqwork://open?person={uid}` |
| DM thread | `hqwork://open?person={uid}&reply={rootEventId}` |

Generic `hqwork://open` (no `?`) is rejected by validation; Sync uses bundle-id
`open -b ai.getindigo.hq-work` for a bare desktop open.

### Steps

1. Flag on, HQ Work installed, both apps signed in (scenario 5). HQ Work
   running and once cold (quit it) for the scheme check.
2. **Scheme fidelity (running):**
   `open 'hqwork://open?channel={knownChannelId}&reply={knownRootEventId}'`
   — HQ Work focuses that channel's thread.
3. **Scheme fidelity (cold):** quit HQ Work, run the same `open`, app starts
   on that thread.
4. **Channel notification:** from another account or device, post in a
   channel the operator can see. Click the macOS / Sync notification (or the
   matching row in the tray notification feed). HQ Work must show **that**
   channel, not a generic home surface.
5. **Reply thread:** reply in a thread. Click the thread notification. HQ Work
   must open the thread (not only the parent channel).
6. **DM:** click a DM notification. HQ Work opens that person
   (`hqwork://open?person=…`).
7. Confirm tray popover and widget still open in Sync (not HQ Work).

### Expected

- `handoff.launched` includes the URL actually passed to `open`.
  Channel+reply should look like
  `handoff.launched hqwork://open?channel={id}&reply={root}`.
- Malformed URLs (`hqwork://settings`, `hqwork://open` with no query, spaces
  in ids) must not navigate HQ Work to a random conversation.
- `settings:updates` from the Sync updater ticket still opens **desktop-alt**,
  not HQ Work (intentional exception).

### Logs to grep

```bash
grep '\[handoff\]' ~/.hq/logs/hq-sync.log | grep -E 'launched|detected|failed'
```

Pass only if the launched URL matches the notification's channel/person and,
for thread clicks, includes `&reply=`. If a thread click logs
`hqwork://open?channel=…` **without** `&reply=`, mark this scenario **fail**
and note the intercept call sites (`open_communications_window` /
`open_dm_detail` currently pass `reply=None` into
`maybe_intercept_conversation_open` / `maybe_intercept_dm_open`). Scheme
steps 2–3 can still pass independently — record them separately in notes.

- [ ] Pass — Scenario 3: Notification → correct channel including reply threads

**Operator notes:**

---

## Scenario 4: Flag-off rollback

**Goal:** `hqWorkHandoff: false` restores desktop-alt with zero data loss.
HQ Work may remain installed. No migration to undo.

### Steps

1. Start from flag on + HQ Work installed (after scenario 2 or 3).
2. Merge `hqWorkHandoff: false` in `~/.hq/menubar.json`. Quit and relaunch
   Sync.
3. Open HQ (tray, Opt+Shift+O, widget Open HQ). **desktop-alt** appears.
   HQ Work does not have to quit, but Sync must not route this click to it.
4. Click a channel or DM notification: compact communications / DM detail
   (legacy), not HQ Work.
5. Confirm tray popover and widget are unchanged.
6. Open updater settings (`settings:updates`) — still desktop-alt.
7. Confirm local HQ folder, companies, and messages are intact. This handoff
   never copied accounts.

### Expected

- `plan_desktop_alt_open(false, …) == OpenDesktopAlt` regardless of install
  (unit: `flag_off_opens_desktop_alt_regardless_of_install`).
- Explicit `"hqWorkHandoff": false` keeps desktop-alt even after a future
  default-on bake.

### Logs to grep

```bash
grep '\[handoff\]' ~/.hq/logs/hq-sync.log
```

Expect `handoff.detected` (intercept still samples). Must **not** see a new
`handoff.launched` for these Open HQ / notification clicks. `co_install skipped:
flag off` on launch is correct.

- [ ] Pass — Scenario 4: Flag-off rollback

**Operator notes:**

---

## Scenario 5: Both-apps-signed-in Cognito sanity

**Goal:** Sync and HQ Work both signed in as the same Indigo person against
the canonical Cognito pool. No handoff-specific token copy.

### Steps

1. Sign into HQ Sync with an `@getindigo.ai` account. Tray shows
   authenticated.
2. Launch HQ Work. If it prompts, complete **its** sign-in against the same
   pool (do not paste tokens). If it picks up `~/.hq/cognito-tokens.json`,
   confirm the displayed identity matches Sync.
3. In HQ Work, open a company channel the operator already sees in Sync.
4. Sign-out drill (optional, destructive to the local session): signing out of
   **one** app is not in scope as a shared logout. If both read
   `~/.hq/cognito-tokens.json`, note that in Results — it is shared local
   state, not a handoff feature.
5. Re-enable the flag if it was turned off in scenario 4; Open HQ still
   launches HQ Work while both remain signed in.

### Expected

- Pool: `vault-users-${stage}` (production `vault-users-prod`). Both apps
  authenticate independently; this story does not ship token sharing.
- HQ Work README/desktop: bearer from `~/.hq/cognito-tokens.json` (same file
  as CLI). Web `work.hq.computer` holds tokens server-side — out of scope.
- No second Cognito pool, no migration wizard, no credentials in handoff
  logs.

### Logs to grep

```bash
grep '\[handoff\]' ~/.hq/logs/hq-sync.log | grep -E 'launched|failed'
```

Handoff logs must not contain access tokens, refresh tokens, or passwords.
Fail this scenario if either app cannot load the same company identity, or if
Open HQ with flag on launches HQ Work signed-out while Sync is signed-in and
HQ Work has no way to complete OAuth.

- [ ] Pass — Scenario 5: Both-apps-signed-in Cognito sanity

**Operator notes:**

---

## Results (live machine)

**Not executed in the story commit.** Fill this table during one operator run
on a dedicated QA Mac before broader rollout. Leave boxes in the scenarios
above as `[ ]` until that run; then copy outcomes here.

| Field | Value |
| --- | --- |
| Date | _YYYY-MM-DD_ |
| Machine | _macOS version, chip (e.g. 15.x / M-series)_ |
| Operator | _name / @getindigo.ai_ |
| Sync version | _HQ.app / tray_ |
| HQ Work version | _HQ Work.app_ |
| `~/.hq/menubar.json` `hqWorkHandoff` after run | _true/false_ |
| Overall | **not executed** |

| Scenario | Pass | Fail | Notes |
| --- | --- | --- | --- |
| 1 Fresh machine (no HQ Work) → card → install → open | | | |
| 2 Upgrade path co-install | | | |
| 3 Notification → correct channel including reply threads | | | |
| 4 Flag-off rollback | | | |
| 5 Both-apps-signed-in Cognito sanity | | | |

Log excerpt pointer (path only, no secrets): `~/.hq/logs/hq-sync.log` grep
`[handoff]` from _HH:MM_ to _HH:MM_.

Broader default-on is still a config change in [hq-work-handoff.md](hq-work-handoff.md).
Do not flip compiled defaults until this Results table is filled by a live run.
