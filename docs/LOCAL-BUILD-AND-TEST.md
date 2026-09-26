# Local build and test

How to build the desktop app from a branch, run it beside the installed copy,
verify what it does, and reset to a fresh-user state — first on your own Mac,
then inside a throwaway macOS VM.

The release pipeline (`RELEASE.md`) is not part of this. Nothing here signs,
notarizes, or publishes anything.

## Prerequisites

- Xcode Command Line Tools, a stable Rust toolchain (`rustup`), Node 20+, pnpm.
- `pnpm install` at the repo root (once per checkout).
- A checkout of the branch under test. Use a worktree so `main` stays clean:

  ```bash
  git -C /path/to/hq-desktop-app worktree add ../hq-desktop-app-<topic> <branch>
  ```

## 1. The fast loop: tests and typecheck

Most changes are provable without a bundle. Run the suites for the packages
you touched; CI runs all of them.

```bash
# UI package (Svelte shell, chat, setup agent)
cd packages/ui && npx vitest run && npx svelte-check --threshold error

# Desktop host (Tauri front end, sessions, stores)
cd apps/sync && npx vitest run && npx svelte-check --threshold error

# Whole repo, the way CI does it
pnpm test && pnpm lint && pnpm typecheck
```

Rust: `cargo test` inside `apps/sync/src-tauri` or `cargo test --workspace`.

## 2. Run the dev shell

```bash
cd apps/sync && npm run tauri dev
```

This is the quickest way to see a UI change. It uses the same bundle identifier
as the installed app, so quit the installed HQ first or the two will fight over
the LaunchAgent, the sync runner, and `~/.hq`.

## 3. A private build you can install beside the real app

When you need the real thing — the installed-app lifecycle, the setup flow,
sessions spawning real Claude Code / Codex processes — build a debug bundle
under a **different product name and identifier**. It installs next to `HQ.app`,
keeps its own window state, never self-updates, and cannot be mistaken for
the shipped app.

Pick a tag (date + letter works well: `20260910m`) and build:

```bash
cd apps/sync
TAG=20260910m
rm -rf src-tauri/target/debug/bundle
./node_modules/.bin/tauri build --debug --bundles app --config "{
  \"productName\": \"HQ Onboarding Test $TAG\",
  \"identifier\": \"ai.indigo.hq-onboarding-test-$TAG\",
  \"plugins\": { \"updater\": { \"endpoints\": [] } },
  \"bundle\": { \"createUpdaterArtifacts\": false, \"macOS\": { \"signingIdentity\": \"-\" } }
}"
```

What each override does:

| Override | Why |
|---|---|
| `productName` / `identifier` | Separate app, separate `~/Library/Application Support`, WebKit, Caches, and Preferences dirs. The shipped `HQ.app` is untouched. |
| `updater.endpoints: []` | The test build never checks for or installs an update over itself. |
| `createUpdaterArtifacts: false` | Skips the `.tar.gz` + `.sig` the updater would need. Faster. |
| `signingIdentity: "-"` | Ad-hoc signature. Runs locally; Gatekeeper is cleared with `xattr` below. |
| `--bundles app` | Just the `.app`. No DMG. |
| `--debug` | Debug Rust build (minutes, not tens of minutes). |

Output: `src-tauri/target/debug/bundle/macos/HQ Onboarding Test <TAG>.app`.

Build takes roughly 3–6 minutes warm. Redirect output to a log and check the
last lines rather than watching it.

### Install it

```bash
APP="src-tauri/target/debug/bundle/macos/HQ Onboarding Test $TAG.app"
ditto -c -k --keepParent "$APP" /tmp/hq-test-$TAG.zip     # zip preserves the bundle exactly
pkill -f "Onboarding Test" || true
rm -rf "/Applications/HQ Onboarding Test"*.app
ditto -x -k /tmp/hq-test-$TAG.zip /Applications/
xattr -dr com.apple.quarantine "/Applications/HQ Onboarding Test $TAG.app"
open -a "HQ Onboarding Test $TAG"; sleep 4; open -a "HQ Onboarding Test $TAG"
```

The second `open` is deliberate: the first launch brings up the menubar item;
the second brings the desktop window forward.

### Carry state from one test build to the next

Window state (the welcome channel's setup progress, drafts, the remembered
pills) lives in WebKit local storage keyed by bundle identifier. To pick up
where the previous test build left off, copy its WebsiteData across before the
first launch:

```bash
OLD=ai.indigo.hq-onboarding-test-<previous tag>
NEW=ai.indigo.hq-onboarding-test-$TAG
mkdir -p ~/Library/WebKit/$NEW/WebsiteData
cp -R ~/Library/WebKit/$OLD/WebsiteData/Default ~/Library/WebKit/$NEW/WebsiteData/
```

Skip this to start the build with a fresh window. Either way it shares the
machine-level HQ state (`~/.hq`, the HQ folder, the Cognito sign-in) with the
installed app.

## 4. Verifying what the app actually did

Screenshots from an agent session are unreliable (`screencapture` needs Screen
Recording permission and fails silently without it). Read state instead:

- **App / sync log** — `~/.hq/logs/hq-sync.log`. Tagged lines (`[setup-run]`,
  `[agent-session]`, `[outpost]`…). `tail -f` it while you click.
- **Claude Code transcripts** — `~/.claude/projects/<cwd-slug>/*.jsonl`, one
  file per session. `<cwd-slug>` is the HQ folder path with `/` → `-`
  (e.g. `-Users-admin-hq`). The last lines show the exact error a session died on.
- **Codex rollouts** — `~/.codex/sessions/`.
- **Running agent processes** — `ps -axo pid,etime,command | grep -E "claude|codex"`.
  A `claude --print --input-format stream-json` process that outlives its
  session is a stuck run (see the "Run Setup does nothing" fix, PR #775).
- **Window state** — WebKit local storage is SQLite, values are UTF-16LE:

  ```bash
  DB=$(ls ~/Library/WebKit/ai.indigo.hq-onboarding-test-$TAG/WebsiteData/Default/*/*/LocalStorage/localstorage.sqlite3 | head -1)
  sqlite3 "$DB" "select key, hex(value) from ItemTable where key like 'hq.welcome.%'" \
    | python3 -c "import sys;[print(k, bytes.fromhex(v).decode('utf-16-le')[:300]) for k,v in (l.rstrip().split('|',1) for l in sys.stdin)]"
  ```

  Useful keys: `hq.welcome.setup-run-session.v1` (the setup run record),
  `hq.welcome.setup-run-transcript.v1`, `hq.sessions.lastPermission`.

## 5. Resetting to a fresh user

Two layers. Do both for a true first-run test.

**Cloud (the test account):** purge the account's memberships, company, vault
buckets, and identity through the API, authenticated with the access token the
app stored. Never print the token.

```bash
python3 - <<'PY'
import json, urllib.request
t = json.load(open("/Users/<you>/.hq/cognito-tokens.json"))["accessToken"]
for p in ("/membership/purge-self", "/entity/purge-self"):
    req = urllib.request.Request("https://hqapi.hq.computer" + p, method="POST", data=b"{}",
        headers={"Authorization": "Bearer " + t, "Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=90); print(p, r.status, r.read().decode()[:400])
    except urllib.error.HTTPError as e: print(p, "HTTP", e.code, e.read().decode()[:300])
PY
```

Use a dedicated test account for this. It deletes everything that account owns.

**Local:** stop the app and its helpers, then remove every place it keeps state.
Keep `~/.claude` and `~/.codex` so the coding agents stay signed in.

```bash
pkill -x HQ; pkill -f "Onboarding Test"; pkill -f hq-sync-menubar; pkill -f hq-sync-runner; pkill -f hq-mesh
launchctl bootout gui/$(id -u)/ai.indigo.hq-sync-menubar 2>/dev/null
launchctl bootout gui/$(id -u)/ai.getindigo.hq-mesh-daemon 2>/dev/null
setopt nullglob 2>/dev/null   # zsh: an unmatched glob must not abort the whole line
rm -rf ~/.hq ~/hq \
  ~/Library/LaunchAgents/ai.indigo.* ~/Library/LaunchAgents/ai.getindigo.* \
  ~/Library/Application\ Support/Indigo\ HQ ~/Library/Application\ Support/ai.indigo.* \
  ~/Library/WebKit/ai.indigo.* ~/Library/Caches/ai.indigo.* ~/Library/Preferences/ai.indigo.*.plist \
  ~/Library/Saved\ Application\ State/ai.indigo.* ~/Library/HTTPStorages/ai.indigo.* ~/Library/Logs/ai.indigo.*
```

Add `/Applications/HQ.app` and Safari's cookies/history if the test starts from
the website download.

## 6. Doing all of this in a VM

A VM gives you a Mac that has never seen HQ: no leftover sign-in, no HQ folder,
no Claude Code config unless you put it there. Use [tart](https://tart.run)
(`brew install cirruslabs/tap/tart`).

### Create

```bash
tart pull ghcr.io/cirruslabs/macos-sequoia-base:latest     # ~33 GB once; budget ~35 GB free
tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest hq-test-<date>   # APFS clone: instant, no extra disk
tart run hq-test-<date> --vnc-experimental                    # opens Screen Sharing so you can see it
```

The base image logs in as `admin` / `admin` with Remote Login on. Enable
scripted SSH once (this is the only interactive step):

```bash
ssh-keygen -t ed25519 -N "" -f ~/.hq-vm/id_ed25519
ssh-copy-id -i ~/.hq-vm/id_ed25519.pub -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null admin@$(tart ip hq-test-<date>)
```

Keep a helper so every later command is one line (`/tmp/vm.sh 'ls ~'`):

```bash
cat > /tmp/vm.sh <<EOS
#!/bin/bash
exec ssh -i ~/.hq-vm/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes admin@$(tart ip hq-test-<date>) "\$@"
EOS
chmod +x /tmp/vm.sh
```

Inside the guest, install and sign in to Claude Code (and Codex if you test it)
once. Those sign-ins are what a "fresh user" would already have; the reset
steps below keep them.

### Put a build in

Build on the host (section 3), then:

```bash
scp -i ~/.hq-vm/id_ed25519 -o StrictHostKeyChecking=no /tmp/hq-test-$TAG.zip admin@$(tart ip hq-test-<date>):/tmp/
/tmp/vm.sh "pkill -f 'Onboarding Test'; rm -rf '/Applications/HQ Onboarding Test'*.app; \
  ditto -x -k /tmp/hq-test-$TAG.zip /Applications/ && \
  xattr -dr com.apple.quarantine '/Applications/HQ Onboarding Test $TAG.app'; \
  open -a 'HQ Onboarding Test $TAG'; sleep 4; open -a 'HQ Onboarding Test $TAG'"
```

For the public build, download the DMG from the release page inside the guest,
exactly as a user would.

### Verify

Everything in section 4 works over the helper, with `~` being the guest's
home: `/tmp/vm.sh 'tail -50 ~/.hq/logs/hq-sync.log'`,
`/tmp/vm.sh 'ls -t ~/.claude/projects/-Users-admin-hq/ | head -3'`, and so on.
Watch the window through Screen Sharing; read the state through SSH.

### Reset

Run the section 5 commands through the helper (`/tmp/vm.sh '…'`), reading the
token file from `/Users/admin/.hq/cognito-tokens.json`. Then delete
`/Applications/HQ.app` and Safari's session data so the next run starts from
the website.

### Stop and remove

```bash
tart stop hq-test-<date>
tart delete hq-test-<date>        # frees the clone; the pulled base image stays for next time
tart delete ghcr.io/cirruslabs/macos-sequoia-base:latest   # only if you want the ~33 GB back
```

## Gotchas collected the hard way

- **Two builds, one sign-in.** Every build on the machine shares `~/.hq` and the
  Cognito token. Signing out in one signs out all of them.
- **Stuck agent processes.** If Run Setup starts failing instantly with an OAuth
  "another process is refreshing it" error, a previous session's `claude` process
  is still alive. The app now ends those itself (PR #775); on older builds,
  `pkill -f "claude --print"`.
- **The guided setup skill comes from hq-core.** A fresh HQ folder gets the
  `/setup` skill from the hq-core release the app installs. If the skill you
  need is not released yet, copy it into `<hq folder>/.claude/skills/setup/` by
  hand for the test, and say so in the report.
- **Codex usage limits** are per account and outlast a VM reset. Check
  `~/.codex` before blaming the app.
- **`zsh` and globs.** `rm -rf a/* b/*` aborts the whole line if any glob has no
  match. Use `setopt nullglob` or one path per `rm`.
