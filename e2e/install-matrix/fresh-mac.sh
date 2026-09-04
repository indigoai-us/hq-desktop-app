#!/usr/bin/env bash
# Spin up a disposable macOS VM in Tart for E2E testing.
#
# Usage:
#   bash workspace/e2e-mac/fresh-mac.sh up              # boot headless (default: consumer-mac)
#   bash workspace/e2e-mac/fresh-mac.sh up --headed     # boot with a visible VM window
#   bash workspace/e2e-mac/fresh-mac.sh up --configured # boot with dev tooling (brew + CLT)
#   bash workspace/e2e-mac/fresh-mac.sh up --consumer   # boot bare macOS Sonoma (no brew, no CLT)
#   bash workspace/e2e-mac/fresh-mac.sh up --tahoe      # boot bare macOS Tahoe (26.x) clean room
#   bash workspace/e2e-mac/fresh-mac.sh down            # stop + delete active VM
#   bash workspace/e2e-mac/fresh-mac.sh ssh             # ssh into the active VM
#
# Flags compose: `up --tahoe --headed` opens a Tahoe clean-room VM with a visible window.
#
# Snapshots (pick per-test based on what you're validating):
#   consumer-mac       — bare macOS Sonoma, harness only. Use for installer/first-run tests.
#                        Re-bake: bash workspace/e2e-mac/bake-consumer-mac.sh
#   consumer-mac-tahoe — bare macOS Tahoe (26.x), harness only. Use when validating on the
#                        newest macOS release.
#                        Re-bake: bash workspace/e2e-mac/bake-consumer-mac-tahoe.sh
#   configured-mac     — harness + Homebrew + Xcode CLT. Use for dev-workflow tests
#                        where you'd otherwise spend the whole test installing prereqs.
#                        Re-bake: bash workspace/e2e-mac/bake-configured-mac.sh
#
# Guaranteed-clean one-shot (rebake + spin up + pre-download HQ installer):
#   bash workspace/e2e-mac/clean-tahoe.sh    # ~5–10 min; lands hq-installer_universal.zip
#                                            # (latest from GitHub) in the VM's ~/Downloads/
#
# Environment:
#   TART_BASE  - Override snapshot/image directly (e.g. ghcr.io/cirruslabs/macos-sonoma-base:latest
#                for a raw, never-configured base).
#
# State:
#   /tmp/tart-fresh-mac.state  - last VM_NAME/VM_IP (written by up, read by ssh/down)

set -euo pipefail

STATE_FILE="/tmp/tart-fresh-mac.state"
# Default to consumer-mac (bare — matches what real users hit).
# Override via --configured flag or TART_BASE env var.
BASE="${TART_BASE:-consumer-mac}"
SSH_KEY="${HOME}/.ssh/id_ed25519"
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o IdentitiesOnly=yes)
# Default headless (--no-graphics). `--headed` flag flips this to show the VM window.
HEADED="${HEADED:-0}"

cmd_up() {
  local vm_name="e2e-$(date +%Y%m%d-%H%M%S)"

  if [[ ! -f "$SSH_KEY" ]]; then
    echo "[harness] Generating SSH key at $SSH_KEY..."
    ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -q
  fi

  echo "[harness] Cloning base image ($BASE) → $vm_name..."
  if ! tart list 2>/dev/null | awk '{print $2}' | grep -qx "$BASE"; then
    echo "[harness] WARN: '$BASE' not found locally. Available local snapshots:"
    tart list 2>/dev/null | awk '$1=="local"{print "  " $2}'
    echo "[harness] Bake it first:"
    [[ "$BASE" == "consumer-mac"       ]] && echo "  bash workspace/e2e-mac/bake-consumer-mac.sh"
    [[ "$BASE" == "consumer-mac-tahoe" ]] && echo "  bash workspace/e2e-mac/bake-consumer-mac-tahoe.sh"
    [[ "$BASE" == "configured-mac"     ]] && echo "  bash workspace/e2e-mac/bake-configured-mac.sh"
    return 1
  fi
  tart clone "$BASE" "$vm_name"

  if [[ "$HEADED" == "1" ]]; then
    echo "[harness] Booting VM (HEADED — a VM window will appear)..."
    # Still backgrounded so the script returns and prints SSH info. The Cocoa
    # window pops up on the host desktop; you can watch + click, OR just SSH in.
    nohup tart run "$vm_name" >/tmp/tart-"$vm_name".log 2>&1 &
  else
    echo "[harness] Booting VM headless..."
    nohup tart run --no-graphics "$vm_name" >/tmp/tart-"$vm_name".log 2>&1 &
  fi
  echo $! > /tmp/tart-"$vm_name".pid
  disown

  echo "[harness] Waiting for VM IP (up to 2min)..."
  local vm_ip=""
  for i in $(seq 1 60); do
    vm_ip=$(tart ip "$vm_name" 2>/dev/null || true)
    [[ -n "$vm_ip" ]] && break
    sleep 2
  done
  if [[ -z "$vm_ip" ]]; then
    echo "[harness] FAIL: VM never got an IP"
    return 1
  fi
  echo "[harness] VM IP: $vm_ip"

  echo "[harness] Waiting for SSH port 22 (up to 3min from boot)..."
  for i in $(seq 1 90); do
    if nc -z -G 2 "$vm_ip" 22 2>/dev/null; then
      echo "[harness] SSH port open after ${i}x2s"
      break
    fi
    sleep 2
  done

  sleep 3  # let sshd finish init

  # SSH key is baked into configured-mac snapshot. If cloning from raw base, we'd
  # need to re-add the expect/ssh-copy-id block. Detect by trying passwordless first.
  if ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" -o ConnectTimeout=5 "admin@${vm_ip}" "true" 2>/dev/null; then
    echo "[harness] ✓ Passwordless SSH (key baked in)"
  else
    echo "[harness] Key not baked — injecting via expect..."
    expect <<EOF >/tmp/tart-"$vm_name".sshcopy.log 2>&1
set timeout 30
spawn ssh-copy-id -i ${SSH_KEY}.pub -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no -o PreferredAuthentications=password admin@${vm_ip}
expect {
  -nocase "password:" { send "admin\r"; exp_continue }
  "Now try logging into" { }
  "already exist" { }
  eof
}
EOF
    if ! ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "admin@${vm_ip}" "true" 2>/dev/null; then
      echo "[harness] FAIL: SSH key injection didn't take"
      cat /tmp/tart-"$vm_name".sshcopy.log
      return 1
    fi
    echo "[harness] ✓ Passwordless SSH confirmed"
  fi

  cat >"$STATE_FILE" <<EOF
VM_NAME=$vm_name
VM_IP=$vm_ip
EOF

  echo ""
  echo "[harness] VM READY"
  echo "  VM_NAME=$vm_name"
  echo "  VM_IP=$vm_ip"
  echo "  SSH:       bash workspace/e2e-mac/fresh-mac.sh ssh"
  echo "  Tear down: bash workspace/e2e-mac/fresh-mac.sh down"
}

cmd_down() {
  local vm_name="${VM_NAME:-}"
  if [[ -z "$vm_name" && -f "$STATE_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$STATE_FILE"
    vm_name="$VM_NAME"
  fi
  if [[ -z "$vm_name" ]]; then
    echo "[harness] No VM_NAME in env or $STATE_FILE. Nothing to tear down."
    return 0
  fi

  echo "[harness] Stopping $vm_name..."
  tart stop "$vm_name" 2>/dev/null || true
  sleep 2
  echo "[harness] Deleting $vm_name..."
  tart delete "$vm_name" 2>/dev/null || true

  local pid_file="/tmp/tart-$vm_name.pid"
  if [[ -f "$pid_file" ]]; then
    kill "$(cat "$pid_file")" 2>/dev/null || true
    rm -f "$pid_file"
  fi
  rm -f "$STATE_FILE"
  echo "[harness] ✓ Torn down."
}

cmd_ssh() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "[harness] No active VM. Run 'up' first."
    return 1
  fi
  # shellcheck source=/dev/null
  source "$STATE_FILE"
  exec ssh "${SSH_OPTS[@]}" -i "$SSH_KEY" "admin@${VM_IP}" "$@"
}

sub="${1:-up}"
shift 2>/dev/null || true

# Parse flags (only meaningful for `up`; safe to ignore elsewhere)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --consumer)   BASE="consumer-mac";       shift ;;
    --tahoe)      BASE="consumer-mac-tahoe"; shift ;;
    --configured) BASE="configured-mac";     shift ;;
    --headed)     HEADED=1;              shift ;;
    --headless)   HEADED=0;              shift ;;
    *) break ;;
  esac
done

case "$sub" in
  up)   cmd_up ;;
  down) cmd_down ;;
  ssh)  cmd_ssh "$@" ;;
  *)    echo "Usage: $0 {up [--consumer|--tahoe|--configured] [--headed]|down|ssh}"; exit 1 ;;
esac
