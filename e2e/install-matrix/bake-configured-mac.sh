#!/usr/bin/env bash
# Bake a "configured-mac" Tart VM snapshot with everything pre-installed for fast E2E.
#
# This is a ONE-TIME setup — after baking, `fresh-mac.sh up` clones from configured-mac
# and spin-up drops from ~4min to ~30s.
#
# What gets baked in:
#   - Host SSH public key in admin's authorized_keys (no more expect/ssh-copy-id)
#   - agent-browser binary at ~/agent-browser
#   - Chrome for Testing pre-downloaded at ~/.agent-browser/browsers/
#
# Re-run this script to refresh the snapshot (e.g. new agent-browser version).

set -euo pipefail

BASE="${TART_BASE:-ghcr.io/cirruslabs/macos-sonoma-base:latest}"
TARGET="${CONFIGURED_VM:-configured-mac}"
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

# If an old configured-mac exists, delete it (re-bake)
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
BOOT_PID=$!
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
expect <<EOF >/tmp/bake-sshcopy.log 2>&1
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

echo "[bake] Copying agent-browser binary..."
scp "${SSH_OPTS[@]}" -i "$SSH_KEY" "$AGENT_BROWSER_HOST" "admin@${VM_IP}:/Users/admin/agent-browser"
ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "admin@${VM_IP}" "chmod +x /Users/admin/agent-browser && /Users/admin/agent-browser --version"

echo "[bake] Pre-downloading Chrome for Testing (~1-2 min)..."
ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "admin@${VM_IP}" "/Users/admin/agent-browser install 2>&1 | tail -5"

echo "[bake] Scrubbing user-space state (so clones boot truly clean)..."
ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "admin@${VM_IP}" 'bash -s' <<'REMOTE'
set -e
cd "$HOME"
rm -rf "$HOME/hq" "$HOME/.hq" "$HOME/.hq-deploy" 2>/dev/null || true
rm -rf "$HOME/Library/Saved Application State"/* 2>/dev/null || true
defaults write com.apple.Terminal NSQuitAlwaysKeepsWindows -bool false 2>/dev/null || true
defaults write -g NSQuitAlwaysKeepsWindows -bool false 2>/dev/null || true
rm -f "$HOME/.zsh_history" "$HOME/.bash_history" 2>/dev/null || true
rm -rf "$HOME/.zsh_sessions" 2>/dev/null || true
rm -rf "$HOME/.npm" 2>/dev/null || true
rm -rf "$HOME/Library/Application Support/com.apple.sharedfilelist" 2>/dev/null || true
rm -rf "$HOME/Desktop"/* "$HOME/Documents"/* "$HOME/Downloads"/* 2>/dev/null || true
rm -rf "$HOME/Library/Caches"/* "$HOME/Library/Logs"/* 2>/dev/null || true
echo "  ✓ user-space scrubbed"
REMOTE

echo "[bake] Shutting down cleanly so the snapshot is stable..."
ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "admin@${VM_IP}" "sudo -n shutdown -h now 2>/dev/null || shutdown -h now 2>/dev/null" || true
sleep 5
tart stop "$TARGET" 2>/dev/null || true

echo ""
echo "[bake] ✓ $TARGET is baked and stopped."
echo "       Next: use 'bash workspace/e2e-mac/fresh-mac.sh up' — it now clones from $TARGET."
tart list | grep -E "NAME|$TARGET|ghcr.io" || true
