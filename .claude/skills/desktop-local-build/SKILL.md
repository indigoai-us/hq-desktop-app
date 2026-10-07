---
name: desktop-local-build
description: Build hq-desktop-app from the current branch as a private, side-by-side debug bundle (own product name and identifier, updater off, ad-hoc signed), install it next to the shipped HQ.app, carry or reset window state, and verify what it did from logs and on-disk state rather than screenshots. Use when asked to "do a local build", "build this branch so I can test it", "install a test build", or "reset to a fresh user". For a throwaway VM see docs/LOCAL-BUILD-AND-TEST.md §6.
---

# desktop-local-build

Full reference: `docs/LOCAL-BUILD-AND-TEST.md`. This skill is the executable
summary.

## When to bundle at all

Run the vitest / svelte-check suites first (`packages/ui`, `apps/sync`). Bundle
only when the behaviour needs the installed-app lifecycle: the setup flow,
sessions spawning real agents, LaunchAgents, the updater being off.

## Build (from the branch's worktree)

```bash
cd apps/sync
TAG=$(date +%Y%m%d)<letter>          # e.g. 20260910m — bump the letter per build
rm -rf src-tauri/target/debug/bundle
./node_modules/.bin/tauri build --debug --bundles app --config "{
  \"productName\": \"HQ Onboarding Test $TAG\",
  \"identifier\": \"ai.indigo.hq-onboarding-test-$TAG\",
  \"plugins\": { \"updater\": { \"endpoints\": [] } },
  \"bundle\": { \"createUpdaterArtifacts\": false, \"macOS\": { \"signingIdentity\": \"-\" } }
}" > /tmp/build-$TAG.log 2>&1; echo "exit=$?" >> /tmp/build-$TAG.log
tail -3 /tmp/build-$TAG.log
```

Run it in the background; it takes minutes. Never reuse a tag: the identifier
is what keeps builds' state apart.

## Install

```bash
APP="src-tauri/target/debug/bundle/macos/HQ Onboarding Test $TAG.app"
ditto -c -k --keepParent "$APP" /tmp/hq-test-$TAG.zip
pkill -f "Onboarding Test" || true
rm -rf "/Applications/HQ Onboarding Test"*.app
ditto -x -k /tmp/hq-test-$TAG.zip /Applications/
xattr -dr com.apple.quarantine "/Applications/HQ Onboarding Test $TAG.app"
open -a "HQ Onboarding Test $TAG"; sleep 4; open -a "HQ Onboarding Test $TAG"
```

To continue from the previous build's window state, copy
`~/Library/WebKit/<old identifier>/WebsiteData/Default` to the new identifier
before the first `open`.

## Verify (never rely on screencapture)

- `~/.hq/logs/hq-sync.log` — tagged app log.
- `~/.claude/projects/<cwd-slug>/*.jsonl` — one transcript per Claude session; the
  tail shows why a session died.
- `ps -axo pid,etime,command | grep -E "claude|codex"` — orphaned agent processes.
- WebKit local storage (SQLite, UTF-16LE values) for `hq.welcome.*` keys.

Report what the evidence shows, with the file it came from.

## Reset to a fresh user

Cloud: POST `/membership/purge-self` then `/entity/purge-self` on
`https://hqapi.hq.computer` with the bearer token from `~/.hq/cognito-tokens.json`
(read it in-process; never print it). Local: kill the app and helpers, boot out
the LaunchAgents, `rm -rf ~/.hq ~/hq` and every `ai.indigo.*` dir under
`~/Library`. Keep `~/.claude` and `~/.codex`. Exact commands in the doc, §5.

## Rules

- Confirm with the person before the cloud purge: it deletes everything the
  account owns. Only ever run it against a dedicated test account.
- Say which build is on screen. The dock tooltip shows the product name.
- A test build proves the branch; the public download proves the release. When
  the ask is "test as a new user", the final pass is the public build.
