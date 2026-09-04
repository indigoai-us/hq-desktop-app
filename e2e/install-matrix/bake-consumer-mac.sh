#!/usr/bin/env bash
# Bake a "consumer-mac" Tart VM snapshot that simulates a truly fresh consumer Mac —
# NO Homebrew, NO Xcode CLT, NO dev tooling. Installers and first-run flows face
# what a real user faces: bare macOS + whatever they ship themselves.
#
# Why not just use the cirruslabs base?
#   Because cirruslabs ships with /opt/homebrew + /Library/Developer/CommandLineTools
#   pre-installed (it's CI-optimized, not consumer) AND can carry a GitHub Actions
#   runner (~/actions-runner) with its own bundled node20/node24. That hides real
#   install failures — deps look already-present (often OFF-PATH, so `command -v`
#   misses them) and the installer's clean-room guarantees go untested.
#
# What stays in (needed by the harness, NOT by the product under test):
#   - SSH key in admin's authorized_keys
#   - ~/agent-browser binary + ~/.agent-browser (standalone Rust — no brew/CLT dep)
#   - Chrome for Testing cache under ~/.agent-browser/browsers (standalone Chromium)
#
# What gets stripped (so a clone is a GENUINELY bare consumer Mac):
#   - /opt/homebrew entirely (Cellar, Caskroom, bin — everything)
#   - /Library/Developer/CommandLineTools (git, swift, make, python3, etc. from CLT)
#   - xcode-select path reset (no lingering dev path)
#   - Shell rc entries that source brew shellenv
#   - ~/actions-runner (CI runner + its bundled node20/node24) and its launchd plists
#   - ~/Library/Application Support/Indigo HQ (a prior installer's node/npm/qmd toolchain)
#   - ~/hq + ~/.hq (a prior HQ clone/state) and ~/.local/bin/yq
#   - any node/npm/npx/qmd/yq/hq/hq-cli binary found under $HOME, /usr/local, /opt
#   - com.indigoai.hq-installer.cognito keychain items (a prior install's Cognito tokens)
#
# Post-bake HARD GATE: the bake FAILS (and deletes the dirty snapshot) if any of
# node/npm/qmd/yq/hq/brew resolve via `command -v` OR a filesystem find across
# $HOME//usr/local//opt, OR if ~/hq still exists. A passing bake is provably clean.
# NOTE: `command -v` alone is NOT enough — these tools live OFF-PATH (bundled in a
# CI runner or an app-support toolchain), so the filesystem find is the real gate.
#
# Re-run this to refresh the snapshot when agent-browser or Chrome version drifts.
#
# Tahoe (macOS 26.x) variant: use bake-consumer-mac-tahoe.sh (thin wrapper that
# sets TART_BASE + CONSUMER_VM and exec's this script).

set -euo pipefail

BASE="${TART_BASE:-ghcr.io/cirruslabs/macos-sonoma-base:latest}"
TARGET="${CONSUMER_VM:-consumer-mac}"
SSH_KEY="${HOME}/.ssh/id_ed25519"
AGENT_BROWSER_HOST="${AGENT_BROWSER_BIN:-/opt/homebrew/lib/node_modules/agent-browser/bin/agent-browser-darwin-arm64}"
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o IdentitiesOnly=yes)

if [[ ! -f "$SSH_KEY" ]]; then
  echo "[bake] Generating SSH key at $SSH_KEY..."
  ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -q
fi

if [[ ! -f "$AGENT_BROWSER_HOST" ]]; then
  echo "[bake] FAIL: agent-browser binary not found at $AGENT_BROWSER_HOST"
  echo "       Set AGENT_BROWSER_BIN to override."
  exit 1
fi

# If an old consumer-mac exists, delete it (re-bake)
if tart list 2>/dev/null | awk '{print $2}' | grep -qx "$TARGET"; then
  echo "[bake] Existing $TARGET found — stopping and deleting to re-bake..."
  tart stop "$TARGET" 2>/dev/null || true
  sleep 2
  tart delete "$TARGET"
fi

echo "[bake] Cloning $BASE → $TARGET..."
tart clone "$BASE" "$TARGET"

echo "[bake] Booting $TARGET headless..."
nohup tart run --no-graphics "$TARGET" >/tmp/tart-"$TARGET".log 2>&1 &
disown

cleanup() {
  echo "[bake] Stopping VM (snapshot preserved)..."
  tart stop "$TARGET" 2>/dev/null || true
}
trap cleanup ERR

echo "[bake] Waiting for VM IP..."
VM_IP=""
for i in $(seq 1 60); do
  VM_IP=$(tart ip "$TARGET" 2>/dev/null || true)
  [[ -n "$VM_IP" ]] && break
  sleep 2
done
[[ -z "$VM_IP" ]] && { echo "[bake] FAIL: no IP"; exit 1; }
echo "[bake] VM IP: $VM_IP"

echo "[bake] Waiting for SSH port..."
for i in $(seq 1 90); do
  nc -z -G 2 "$VM_IP" 22 2>/dev/null && break
  sleep 2
done
sleep 3

echo "[bake] Injecting SSH key..."
expect <<EOF >/tmp/bake-consumer-sshcopy.log 2>&1
set timeout 30
spawn ssh-copy-id -i ${SSH_KEY}.pub -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no -o PreferredAuthentications=password admin@${VM_IP}
expect {
  -nocase "password:" { send "admin\r"; exp_continue }
  "Now try logging into" { }
  "already exist" { }
  eof
}
EOF

if ! ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "admin@${VM_IP}" "true" 2>/dev/null; then
  echo "[bake] FAIL: key injection"; exit 1
fi
echo "[bake] ✓ SSH key baked in"

# ---------------------------------------------------------------------------
# Strip pre-installed dev tooling BEFORE we copy our harness essentials.
# (Order doesn't strictly matter — agent-browser is self-contained — but this
# makes the log easier to read.)
# ---------------------------------------------------------------------------
echo "[bake] Stripping Homebrew..."
ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "admin@${VM_IP}" 'bash -s' <<'REMOTE'
set -e
if [[ -d /opt/homebrew ]]; then
  echo "  removing /opt/homebrew ($(du -sh /opt/homebrew 2>/dev/null | cut -f1))"
  sudo rm -rf /opt/homebrew
fi
# Wipe Homebrew env lines from shell rcs (cirruslabs bakes 'eval $(brew shellenv)')
for rc in ~/.zshrc ~/.zprofile ~/.bash_profile ~/.bashrc ~/.profile; do
  if [[ -f "$rc" ]]; then
    # Remove lines referencing brew shellenv or /opt/homebrew
    sed -i '' '/brew shellenv/d;/\/opt\/homebrew/d' "$rc" 2>/dev/null || true
  fi
done
# Confirm brew is gone
if command -v brew >/dev/null 2>&1; then
  echo "  WARN: brew still on PATH: $(command -v brew)"
else
  echo "  ✓ brew removed"
fi
REMOTE

echo "[bake] Stripping Xcode Command Line Tools..."
ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "admin@${VM_IP}" 'bash -s' <<'REMOTE'
set -e
if [[ -d /Library/Developer/CommandLineTools ]]; then
  echo "  removing /Library/Developer/CommandLineTools ($(sudo du -sh /Library/Developer/CommandLineTools 2>/dev/null | cut -f1))"
  sudo rm -rf /Library/Developer/CommandLineTools
fi
# Reset xcode-select path
sudo xcode-select -r 2>/dev/null || true
# Confirm git is gone (git is the most common CLT artifact)
if command -v git >/dev/null 2>&1; then
  echo "  note: git still on PATH at $(command -v git) — likely a non-CLT install, leaving alone"
else
  echo "  ✓ git (and CLT toolchain) removed"
fi
# Confirm swift/make/clang are gone
for tool in swift make clang gcc python3; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "  note: $tool still at $(command -v $tool)"
  fi
done
REMOTE

echo "[bake] Scrubbing user-space state (so clones boot truly clean)..."
ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "admin@${VM_IP}" 'bash -s' <<'REMOTE'
set -e
cd "$HOME"

# 1. HQ / installer artifacts a prior run (or the base image) left behind.
#    A real first-run user has NONE of these — leaving them makes deps look
#    already-installed (often OFF-PATH) and silently invalidates clean-room tests.
#    1a. Prior HQ clone + state.
rm -rf "$HOME/hq" "$HOME/.hq" "$HOME/.hq-deploy" 2>/dev/null || true
#    1b. Prior installer's managed toolchain (node/npm/qmd live here, OFF-PATH).
sudo rm -rf "$HOME/Library/Application Support/Indigo HQ" \
            "$HOME/Library/Application Support/IndigoHQ" 2>/dev/null || true
rm -rf "$HOME/Library/Caches/com.indigoai."* \
       "$HOME/Library/Preferences/com.indigoai."* \
       "$HOME/Library/HTTPStorages/com.indigoai."* 2>/dev/null || true
#    1c. GitHub Actions runner (cirruslabs base may ship it) + its bundled node20/node24.
#        Unload any launchd jobs first so nothing re-spawns mid-scrub.
for plist in /Library/LaunchDaemons/actions.runner.*.plist \
             "$HOME/Library/LaunchAgents/actions.runner."*.plist \
             "$HOME/Library/LaunchAgents/com.indigoai."*.plist; do
  [ -e "$plist" ] || continue
  sudo launchctl unload "$plist" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
  sudo rm -f "$plist" 2>/dev/null || true
done
sudo rm -rf "$HOME/actions-runner" 2>/dev/null || true

# 2. Terminal "Resume previous session" — this is why a fresh boot shows
#    last sessions zombie-style. Both nuke the saved state and disable the
#    feature globally so it can never come back.
rm -rf "$HOME/Library/Saved Application State/com.apple.Terminal.savedState" 2>/dev/null || true
defaults write com.apple.Terminal NSQuitAlwaysKeepsWindows -bool false 2>/dev/null || true
defaults write -g NSQuitAlwaysKeepsWindows -bool false 2>/dev/null || true
defaults write com.apple.Terminal SecureKeyboardEntry -bool false 2>/dev/null || true

# Wipe ALL Saved Application State (not just Terminal) — covers TextEdit,
# Safari, anything else macOS auto-resumes.
rm -rf "$HOME/Library/Saved Application State"/* 2>/dev/null || true

# 3. Shell history — first-time terminals should have empty history.
rm -f "$HOME/.zsh_history" "$HOME/.bash_history" "$HOME/.zsh_sessions"/* 2>/dev/null || true
rm -rf "$HOME/.zsh_sessions" 2>/dev/null || true

# 4. npx / npm caches — stale pinned dep trees would defeat clean-room tests.
rm -rf "$HOME/.npm" 2>/dev/null || true

# 5. Recent items (Finder, app menus) and Dock recents.
rm -rf "$HOME/Library/Application Support/com.apple.sharedfilelist" 2>/dev/null || true
defaults write com.apple.recentitems Documents -dict-add MaxAmount 0 2>/dev/null || true
defaults write com.apple.recentitems Applications -dict-add MaxAmount 0 2>/dev/null || true

# 6. User folders that should be empty on first boot.
rm -rf "$HOME/Desktop"/* "$HOME/Documents"/* "$HOME/Downloads"/* 2>/dev/null || true

# 7. Quicklook / log caches that grow across runs.
rm -rf "$HOME/Library/Caches"/* 2>/dev/null || true
rm -rf "$HOME/Library/Logs"/* 2>/dev/null || true

# 8. Stray toolchain binaries anywhere a prior installer/CI dropped them.
#    The big dirs above are already gone; this nets stragglers (e.g. ~/.local/bin/yq,
#    /usr/local/bin/*) and is the SAME surface the post-bake hard gate asserts on.
#    agent-browser + Chrome for Testing are copied in AFTER this scrub, so they're
#    never in scope here (and ship no file named node/npm/qmd/yq/hq anyway).
rm -f "$HOME/.local/bin/yq" 2>/dev/null || true
sudo rm -f /usr/local/bin/git-credential-manager 2>/dev/null || true
for root in "$HOME" /usr/local /opt; do
  [ -d "$root" ] || continue
  sudo find "$root" \
    \( -name node -o -name npm -o -name npx -o -name qmd -o -name yq -o -name hq -o -name hq-cli \) \
    -type f -print -delete 2>/dev/null || true
done

# 9. Installer keychain items — a prior install's Cognito tokens. A fresh user has
#    none; leaving them lets first-run auth flows skip the login they should hit.
security unlock-keychain -p admin "$HOME/Library/Keychains/login.keychain-db" 2>/dev/null || true
for svc in com.indigoai.hq-installer.cognito; do
  while security delete-generic-password -s "$svc" >/dev/null 2>&1; do :; done
  while security delete-generic-password -l "$svc" >/dev/null 2>&1; do :; done
done

echo "  ✓ user-space scrubbed"
REMOTE

echo "[bake] Verifying stripped state (informational — hard gate runs post-bake)..."
ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "admin@${VM_IP}" 'bash -lc "
  echo \"  PATH: \$PATH\"
  for t in brew git node npm npx qmd yq hq gh; do
    printf \"  %-5s %s\n\" \"\$t\" \"\$(command -v \$t 2>/dev/null || echo MISSING)\"
  done
  echo \"  ~/hq:                \$(test -e \$HOME/hq && echo PRESENT || echo MISSING)\"
  echo \"  ~/actions-runner:    \$(test -e \$HOME/actions-runner && echo PRESENT || echo MISSING)\"
  echo \"  Indigo HQ toolchain: \$(test -e \"\$HOME/Library/Application Support/Indigo HQ\" && echo PRESENT || echo MISSING)\"
  echo \"  ~/.local/bin/yq:     \$(test -e \$HOME/.local/bin/yq && echo PRESENT || echo MISSING)\"
  echo \"  Terminal savedState: \$(test -e \"\$HOME/Library/Saved Application State/com.apple.Terminal.savedState\" && echo PRESENT || echo MISSING)\"
"'

# ---------------------------------------------------------------------------
# Now install the harness essentials. agent-browser is a standalone Rust binary;
# Chrome for Testing is standalone Chromium. Neither requires brew or CLT.
# ---------------------------------------------------------------------------
echo "[bake] Copying agent-browser binary..."
scp "${SSH_OPTS[@]}" -i "$SSH_KEY" "$AGENT_BROWSER_HOST" "admin@${VM_IP}:/Users/admin/agent-browser"
ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "admin@${VM_IP}" "chmod +x /Users/admin/agent-browser && /Users/admin/agent-browser --version"

echo "[bake] Pre-downloading Chrome for Testing (~1-2 min)..."
ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "admin@${VM_IP}" "/Users/admin/agent-browser install 2>&1 | tail -5"

# ---------------------------------------------------------------------------
# HARD GATE — the whole point of this script. A snapshot that still resolves a
# toolchain (on PATH, or anywhere on disk under $HOME//usr/local//opt) is NOT a
# clean room; clones of it would silently pass installer tests that should fail.
# Fail loud and DELETE the bad snapshot so fresh-mac.sh can never clone it.
# Runs AFTER the harness install (verified empirically that agent-browser + the
# Chrome for Testing cache ship no file named node/npm/qmd/yq/hq/brew).
# ---------------------------------------------------------------------------
echo "[bake] HARD GATE: asserting the snapshot is a genuinely clean room..."
if ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "admin@${VM_IP}" 'bash -s' <<'REMOTE'
set -u
fail=0
flag() { echo "  [gate] FAIL: $*"; fail=1; }

# (a) Nothing resolves on a login PATH.
for t in node npm qmd yq hq brew; do
  if loc=$(bash -lc "command -v $t" 2>/dev/null) && [ -n "$loc" ]; then
    flag "'$t' resolves on PATH -> $loc"
  fi
done

# (b) Nothing exists anywhere under $HOME /usr/local /opt — catches OFF-PATH
#     copies (a CI runner's bundled node, an app-support toolchain, etc).
for root in "$HOME" /usr/local /opt; do
  [ -d "$root" ] || continue
  hits=$(sudo find "$root" \( -name node -o -name npm -o -name qmd -o -name yq -o -name hq -o -name brew \) -type f 2>/dev/null || true)
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" | sed 's/^/  [gate] FAIL: stray binary on disk -> /'
    fail=1
  fi
done

# (c) No prior HQ clone.
[ -e "$HOME/hq" ] && flag "~/hq still exists"

if [ "$fail" -ne 0 ]; then
  echo "  [gate] ✗ snapshot is NOT a clean room"
  exit 1
fi
echo "  [gate] ✓ clean: no node/npm/qmd/yq/hq/brew on PATH or under \$HOME//usr/local//opt, no ~/hq"
REMOTE
then
  echo "[bake] ✓ HARD GATE passed — snapshot is provably clean."
else
  echo "[bake] ✗ HARD GATE FAILED — snapshot is dirty (see [gate] FAIL lines above)."
  echo "[bake]   Deleting $TARGET so fresh-mac.sh cannot clone a dirty clean-room."
  tart stop "$TARGET" 2>/dev/null || true
  sleep 2
  tart delete "$TARGET" 2>/dev/null || true
  exit 1
fi

echo "[bake] Shutting down cleanly so the snapshot is stable..."
ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "admin@${VM_IP}" "sudo -n shutdown -h now 2>/dev/null || shutdown -h now 2>/dev/null" || true
sleep 5
tart stop "$TARGET" 2>/dev/null || true

echo ""
echo "[bake] ✓ $TARGET is baked and stopped."
echo "       This snapshot has NO Homebrew, NO Xcode CLT — just bare macOS + harness."
echo "       Next: bash workspace/e2e-mac/fresh-mac.sh up --consumer"
tart list | grep -E "NAME|$TARGET|configured-mac|ghcr.io" || true
