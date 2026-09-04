#!/usr/bin/env bash
# List (default) or delete (--yes) orphaned disposable VMs so the matrix never
# runs out of disk. Base snapshots are never touched.
#   bash workspace/e2e-mac/matrix/sweep-orphans.sh            # dry run
#   bash workspace/e2e-mac/matrix/sweep-orphans.sh --yes      # delete
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
KEEP_RE='^(consumer-mac|consumer-mac-tahoe|consumer-mac-sequoia|configured-mac|e2e-base|e2e-base-backup-[0-9]+|clean-room)$'
YES=0; [[ "${1:-}" == "--yes" ]] && YES=1
total=0
while read -r name size state; do
  [[ "$name" =~ $KEEP_RE ]] && continue
  [[ "$state" == running ]] && { log "skip running: $name"; continue; }
  total=$((total+size))
  if [[ $YES == 1 ]]; then log "delete $name (${size}G)"; tart delete "$name"; else log "orphan: $name (${size}G)"; fi
done < <(tart list 2>/dev/null | awk '$1=="local"{print $2, $4, $NF}')
log "$([[ $YES == 1 ]] && echo reclaimed || echo reclaimable): ~${total} GB"
[[ $YES == 1 ]] || log "re-run with --yes to delete"
