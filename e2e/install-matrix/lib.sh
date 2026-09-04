#!/usr/bin/env bash
# HQ install matrix — shared host-side library.
#
# Design goals (see README.md):
#   * per-run state under runs/<run-id>/ — NEVER a global /tmp state file, so
#     two cells can run side by side without clobbering each other
#   * a slot lease that encodes Apple Virtualization's hard limit of 2 running
#     macOS VMs per host, so a third cell waits instead of failing mid-boot
#   * teardown on EXIT/INT/TERM, always — orphaned VMs cost ~25 GB each
#   * every SSH call uses IdentitiesOnly=yes (without it ssh-agent causes
#     too-many-auth-failures against the guest)

set -euo pipefail

MATRIX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The harness is versioned in hq-desktop-app (e2e/install-matrix) and symlinked
# into HQ at workspace/e2e-mac/matrix. HQ_ROOT: env, else walk up from the
# physical or logical location for core/core.yaml, else ~/hq.
_find_hq_root() {
  local d; for d in "$MATRIX_DIR" "$(cd "$MATRIX_DIR" && pwd -P)"; do
    while [[ "$d" != "/" ]]; do [[ -f "$d/core/core.yaml" ]] && { echo "$d"; return; }; d="$(dirname "$d")"; done
  done
  [[ -f "$HOME/hq/core/core.yaml" ]] && echo "$HOME/hq"
}
HQ_ROOT="${HQ_ROOT:-$(_find_hq_root)}"; [[ -n "$HQ_ROOT" ]] || { echo "lib.sh: cannot locate HQ root (set HQ_ROOT)" >&2; exit 2; }
E2E_DIR="$HQ_ROOT/workspace/e2e-mac"; mkdir -p "$E2E_DIR/reports"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o IdentitiesOnly=yes -o ConnectTimeout=8 -i "$SSH_KEY")
GUEST_USER="${GUEST_USER:-admin}"
GUEST_PASS="${GUEST_PASS:-admin}"
GUEST_ROOT="/Users/Shared/hq-matrix"

MAX_VMS="${HQ_MATRIX_MAX_VMS:-2}"          # Apple Virtualization limit
SLOT_DIR="${HQ_MATRIX_SLOT_DIR:-/tmp/hq-tart-matrix-slots}"
BOOT_TIMEOUT="${HQ_MATRIX_BOOT_TIMEOUT:-240}"
VM_PREFIX="hq-matrix"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { log "FAIL: $*"; exit 1; }

# ── image → snapshot mapping ────────────────────────────────────────────────
# Image ids are stable names used in cell specs; snapshots are Tart VM names.
image_snapshot() {
  case "$1" in
    sonoma-consumer)      echo consumer-mac ;;
    tahoe-consumer)       echo consumer-mac-tahoe ;;
    sequoia-consumer)     echo consumer-mac-sequoia ;;
    sonoma-configured)    echo configured-mac ;;
    *) return 1 ;;
  esac
}
image_bake_hint() {
  case "$1" in
    sonoma-consumer)   echo "bash workspace/e2e-mac/bake-consumer-mac.sh" ;;
    tahoe-consumer)    echo "bash workspace/e2e-mac/bake-consumer-mac-tahoe.sh" ;;
    sequoia-consumer)  echo "bash workspace/e2e-mac/bake-consumer-mac-sequoia.sh" ;;
    sonoma-configured) echo "bash workspace/e2e-mac/bake-configured-mac.sh" ;;
  esac
}
snapshot_exists() { tart list 2>/dev/null | awk '$1=="local"{print $2}' | grep -qx "$1"; }

# ── slot lease (2 concurrent VMs per host) ──────────────────────────────────
running_vm_count() { tart list 2>/dev/null | awk '$NF=="running"' | wc -l | tr -d ' '; }

slot_acquire() {
  # Sets SLOT (path). Waits up to $1 seconds (default 2h).
  local wait="${1:-7200}" waited=0 i
  mkdir -p "$SLOT_DIR"
  while :; do
    for i in $(seq 1 "$MAX_VMS"); do
      local s="$SLOT_DIR/slot-$i"
      if [[ -d "$s" ]]; then
        # stale? (owner pid gone)
        local pid; pid="$(cat "$s/pid" 2>/dev/null || true)"
        if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
          log "reclaiming stale slot $i (pid $pid gone)"; rm -rf "$s"
        fi
      fi
      if mkdir "$s" 2>/dev/null; then
        echo $$ >"$s/pid"; SLOT="$s"; return 0
      fi
    done
    (( waited >= wait )) && die "no VM slot free after ${wait}s"
    sleep 15; waited=$((waited+15))
  done
}
slot_release() { [[ -n "${SLOT:-}" ]] && rm -rf "$SLOT"; SLOT=""; }

# ── VM lifecycle ────────────────────────────────────────────────────────────
vm_boot() {
  # vm_boot <snapshot> <vm-name> <run-dir> [headed]
  local snap="$1" name="$2" run="$3" headed="${4:-0}"
  snapshot_exists "$snap" || die "snapshot '$snap' missing — bake it first"
  # Guard the hypervisor limit even if slots were bypassed.
  (( $(running_vm_count) < MAX_VMS )) || die "already $(running_vm_count) VMs running (limit $MAX_VMS)"
  log "clone $snap → $name"
  tart clone "$snap" "$name"
  if [[ "$headed" == 1 ]]; then
    nohup tart run "$name" >"$run/tart.log" 2>&1 &
  else
    nohup tart run --no-graphics "$name" >"$run/tart.log" 2>&1 &
  fi
  echo $! >"$run/tart.pid"; disown
  local ip="" t=0
  while (( t < BOOT_TIMEOUT )); do
    ip="$(tart ip "$name" 2>/dev/null || true)"
    if [[ -n "$ip" ]] && nc -z -G 2 "$ip" 22 2>/dev/null; then
      if ssh "${SSH_OPTS[@]}" "$GUEST_USER@$ip" true 2>/dev/null; then
        echo "$ip" >"$run/vm.ip"; echo "$name" >"$run/vm.name"
        log "VM up: $name @ $ip (${t}s)"; VM_IP="$ip"; return 0
      fi
      # key not baked (raw base) — inject once
      vm_inject_key "$ip" "$run" || true
    fi
    sleep 3; t=$((t+3))
  done
  die "VM $name did not become SSH-reachable in ${BOOT_TIMEOUT}s"
}
vm_inject_key() {
  local ip="$1" run="$2"
  command -v expect >/dev/null || return 1
  expect >>"$run/sshcopy.log" 2>&1 <<EOX
set timeout 30
spawn ssh-copy-id -i ${SSH_KEY}.pub -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no -o PreferredAuthentications=password ${GUEST_USER}@${ip}
expect { -nocase "password:" { send "${GUEST_PASS}\r"; exp_continue } eof }
EOX
}
vm_destroy() {
  # vm_destroy <run-dir>
  local run="$1" name
  name="$(cat "$run/vm.name" 2>/dev/null || true)"
  [[ -z "$name" ]] && return 0
  log "teardown $name"
  tart stop "$name" 2>/dev/null || true; sleep 2
  tart delete "$name" 2>/dev/null || true
  [[ -f "$run/tart.pid" ]] && kill "$(cat "$run/tart.pid")" 2>/dev/null || true
  rm -f "$run/vm.name" "$run/vm.ip" "$run/tart.pid"
}

vssh() { ssh "${SSH_OPTS[@]}" "$GUEST_USER@$VM_IP" "$@"; }
vscp_to() { scp -q "${SSH_OPTS[@]}" -r "$1" "$GUEST_USER@$VM_IP:$2"; }
vscp_from() { scp -q "${SSH_OPTS[@]}" -r "$GUEST_USER@$VM_IP:$1" "$2"; }

# ── sweep ───────────────────────────────────────────────────────────────────
list_matrix_vms() { tart list 2>/dev/null | awk -v p="$VM_PREFIX-" '$1=="local" && index($2,p)==1 {print $2}'; }
