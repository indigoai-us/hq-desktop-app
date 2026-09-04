#!/usr/bin/env bash
# Run ONE matrix cell: <image>:<profile>:<journey> in a disposable VM.
#
#   bash workspace/e2e-mac/matrix/run-cell.sh sonoma-consumer bare desktop-deps-headless [--headed] [--keep]
#
# Writes runs/<run-id>/cells/<cell>/{result.json,journey.log,guest/...}.
# Exit code: 0 = journey ok, 1 = journey failed, 2 = harness/infra failure.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

IMAGE="${1:?image}"; PROFILE="${2:?profile}"; JOURNEY="${3:?journey}"; shift 3
HEADED=0; KEEP=0; RUN_ID="${HQ_MATRIX_RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
for a in "$@"; do case "$a" in --headed) HEADED=1;; --keep) KEEP=1;; --run-id=*) RUN_ID="${a#*=}";; esac; done
# Journeys that drive the real UI need a window server session with a display → always headed.
[[ "$JOURNEY" == *headed* ]] && HEADED=1

CELL="${IMAGE}__${PROFILE}__${JOURNEY}"
RUN="$MATRIX_DIR/runs/$RUN_ID/cells/$CELL"; mkdir -p "$RUN/guest"
SNAP="$(image_snapshot "$IMAGE")" || { echo "unknown image '$IMAGE'" >&2; exit 2; }
[[ -f "$MATRIX_DIR/guest/journeys/$JOURNEY/run.sh" ]] || { echo "unknown journey '$JOURNEY'" >&2; exit 2; }
[[ -f "$MATRIX_DIR/guest/profiles/$PROFILE.sh" ]] || { echo "unknown profile '$PROFILE'" >&2; exit 2; }
if ! snapshot_exists "$SNAP"; then
  log "snapshot $SNAP missing for image $IMAGE — bake with: $(image_bake_hint "$IMAGE")"
  write_infra_result() { :; }
  printf '{"cell":"%s","image":"%s","profile":"%s","journey":"%s","ok":false,"infra":"snapshot-missing","checks":[]}\n' \
    "$CELL" "$IMAGE" "$PROFILE" "$JOURNEY" >"$RUN/result.json"
  exit 2
fi

VM_NAME="$VM_PREFIX-$(echo "$CELL" | tr -c 'A-Za-z0-9-' '-' | cut -c1-40)-$(date +%H%M%S)-$$"
STATUS=2
finish() {
  local ec=$?
  if [[ "$KEEP" == 1 ]]; then log "--keep: leaving $VM_NAME running (tart stop/delete it yourself)"; else vm_destroy "$RUN"; fi
  slot_release
  exit "${STATUS}"
}
trap finish EXIT INT TERM

slot_acquire
vm_boot "$SNAP" "$VM_NAME" "$RUN" "$HEADED"

# Push the guest kit (journeys + profiles + common) and any staged artifacts.
vssh "rm -rf $GUEST_ROOT && mkdir -p $GUEST_ROOT/out"
vscp_to "$MATRIX_DIR/guest" "$GUEST_ROOT/kit"
if [[ -d "$MATRIX_DIR/artifacts" ]] && [[ -n "$(ls -A "$MATRIX_DIR/artifacts" 2>/dev/null)" ]]; then
  vscp_to "$MATRIX_DIR/artifacts" "$GUEST_ROOT/artifacts"
else
  vssh "mkdir -p $GUEST_ROOT/artifacts"
fi

# Guest env for the journey.
cat >"$RUN/guest-env.sh" <<ENV
export HQ_MATRIX_IMAGE="$IMAGE"
export HQ_MATRIX_PROFILE="$PROFILE"
export HQ_MATRIX_JOURNEY="$JOURNEY"
export HQ_MATRIX_ROOT="$GUEST_ROOT"
export HQ_MATRIX_OUT="$GUEST_ROOT/out"
export HQ_MATRIX_ARTIFACTS="$GUEST_ROOT/artifacts"
export HQ_MATRIX_GUEST_PASS="$GUEST_PASS"
export HQ_MATRIX_DEPS_EXPECT="${HQ_MATRIX_DEPS_EXPECT:-}"
# Mirror what Terminal.app gives a real user (SSH sessions otherwise run in the C locale).
export LANG="${HQ_MATRIX_GUEST_LANG:-en_US.UTF-8}"
ENV
vscp_to "$RUN/guest-env.sh" "$GUEST_ROOT/env.sh"

# Baseline inventory BEFORE anything runs (proves the clean room, per policy
# hq-verify-clean-room-vm-bare-full-disk: full-disk find, not command -v).
vssh "source $GUEST_ROOT/env.sh && bash $GUEST_ROOT/kit/common.sh inventory before" >"$RUN/inventory-before.json" 2>"$RUN/inventory-before.err" || true

# Apply profile (machine-shape mutation), then run the journey.
log "profile: $PROFILE"
if ! vssh "source $GUEST_ROOT/env.sh && bash $GUEST_ROOT/kit/profiles/$PROFILE.sh" >"$RUN/profile.log" 2>&1; then
  log "profile $PROFILE failed — see $RUN/profile.log"
  printf '{"cell":"%s","image":"%s","profile":"%s","journey":"%s","ok":false,"infra":"profile-failed","checks":[]}\n' \
    "$CELL" "$IMAGE" "$PROFILE" "$JOURNEY" >"$RUN/result.json"
  exit 2
fi

# A profile may need a reboot (e.g. to hand the console session to another user).
if vssh "test -f $GUEST_ROOT/reboot-required" 2>/dev/null; then
  log "profile requested a reboot — rebooting $VM_NAME"
  vssh "rm -f $GUEST_ROOT/reboot-required; echo '$GUEST_PASS' | sudo -S -p '' shutdown -r now" >/dev/null 2>&1 || true
  sleep 15
  t=0; until ssh "${SSH_OPTS[@]}" "$GUEST_USER@$VM_IP" true 2>/dev/null; do sleep 4; t=$((t+4)); (( t > BOOT_TIMEOUT )) && die "VM did not come back after reboot"; done
  sleep 20  # let loginwindow finish the console auto-login
  log "VM back after reboot (${t}s); console user: $(vssh "stat -f %Su /dev/console" 2>/dev/null)"
fi

# A profile may ask for the journey to run as a different guest user
# (nonadmin-user). Same kit, same env; only the SSH login changes.
JOURNEY_USER="$(vssh "cat $GUEST_ROOT/run-as-user 2>/dev/null" || true)"
log "journey: $JOURNEY (this can take several minutes)${JOURNEY_USER:+ — as user '$JOURNEY_USER'}"
set +e
if [[ -n "$JOURNEY_USER" ]]; then
  ssh "${SSH_OPTS[@]}" "$JOURNEY_USER@$VM_IP" "source $GUEST_ROOT/env.sh && export HQ_MATRIX_GUEST_PASS= && bash $GUEST_ROOT/kit/journeys/$JOURNEY/run.sh" >"$RUN/journey.log" 2>&1
else
  vssh "source $GUEST_ROOT/env.sh && bash $GUEST_ROOT/kit/journeys/$JOURNEY/run.sh" >"$RUN/journey.log" 2>&1
fi
JEC=$?
set -e
vssh "source $GUEST_ROOT/env.sh && bash $GUEST_ROOT/kit/common.sh inventory after" >"$RUN/inventory-after.json" 2>/dev/null || true
vscp_from "$GUEST_ROOT/out/." "$RUN/guest/" || true

if [[ -f "$RUN/guest/result.json" ]]; then
  python3 - "$RUN/guest/result.json" "$RUN/result.json" "$CELL" "$IMAGE" "$PROFILE" "$JOURNEY" "$JEC" "$VM_NAME" <<'PY'
import json,sys
src,dst,cell,image,profile,journey,ec,vm=sys.argv[1:9]
d=json.load(open(src,encoding="utf-8",errors="replace"))
d.update(cell=cell,image=image,profile=profile,journey=journey,exit_code=int(ec),vm=vm)
d.setdefault("ok", int(ec)==0)
json.dump(d,open(dst,"w"),indent=2)
PY
else
  printf '{"cell":"%s","image":"%s","profile":"%s","journey":"%s","ok":false,"infra":"no-result-json","exit_code":%s,"checks":[]}\n' \
    "$CELL" "$IMAGE" "$PROFILE" "$JOURNEY" "$JEC" >"$RUN/result.json"
  JEC=2
fi
STATUS=$(( JEC == 0 ? 0 : (JEC == 2 ? 2 : 1) ))
log "cell $CELL → $( [[ $STATUS == 0 ]] && echo PASS || echo FAIL ) (exit $JEC); results in $RUN"
exit $STATUS
