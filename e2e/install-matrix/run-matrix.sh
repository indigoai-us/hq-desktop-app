#!/usr/bin/env bash
# Run a set of matrix cells, ≤2 at a time (Apple Virtualization limit), and
# aggregate one summary per run.
#
#   bash workspace/e2e-mac/matrix/run-matrix.sh                 # cells from cells.txt
#   bash workspace/e2e-mac/matrix/run-matrix.sh --cells my.txt  # custom cell list
#   bash workspace/e2e-mac/matrix/run-matrix.sh --cell sonoma-consumer:bare:probe-machine
#   bash workspace/e2e-mac/matrix/run-matrix.sh --nightly       # stage artifacts + cells.txt + report
#
# Cell syntax: <image>:<profile>:<journey>  (one per line; # comments ok)
# Outputs: runs/<run-id>/summary.{json,md}; nightly also copies the summary to
# workspace/e2e-mac/reports/<run-id>-install-matrix/ and runs $HQ_MATRIX_NOTIFY_CMD
# (if set) with the summary.md path as $1.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CELLS_FILE="$MATRIX_DIR/cells.txt"; CELLS=(); NIGHTLY=0; PARALLEL="$MAX_VMS"; EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cells) CELLS_FILE="$2"; shift 2;;
    --cell) CELLS+=("$2"); shift 2;;
    --nightly) NIGHTLY=1; shift;;
    --parallel) PARALLEL="$2"; shift 2;;
    --headed|--keep) EXTRA+=("$1"); shift;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
if [[ ${#CELLS[@]} -eq 0 ]]; then
  while IFS= read -r l; do l="${l%%#*}"; l="$(echo "$l" | xargs)"; [[ -n "$l" ]] && CELLS+=("$l"); done <"$CELLS_FILE"
fi
RUN_ID="${HQ_MATRIX_RUN_ID:-$(date +%Y%m%d-%H%M%S)}"; RUN="$MATRIX_DIR/runs/$RUN_ID"; mkdir -p "$RUN/cells"
log "run $RUN_ID: ${#CELLS[@]} cell(s), parallel=$PARALLEL"
if [[ "$NIGHTLY" == 1 ]]; then
  bash "$MATRIX_DIR/stage-artifacts.sh" ${HQ_DESKTOP_WORKTREE:+--desktop-worktree "$HQ_DESKTOP_WORKTREE"} >"$RUN/stage-artifacts.log" 2>&1 || log "WARN: stage-artifacts failed (see $RUN/stage-artifacts.log); journeys needing artifacts will fail closed"
fi
printf '%s\n' "${CELLS[@]}" >"$RUN/cells.txt"
# Fan-out with bash job control (macOS xargs -I has a 255-byte limit); each
# cell is its own process with its own slot lease + trap.
export HQ_MATRIX_RUN_ID="$RUN_ID"
run_one() {
  local spec="$1" img prof jour ec
  IFS=: read -r img prof jour <<<"$spec"
  bash "$MATRIX_DIR/run-cell.sh" "$img" "$prof" "$jour" ${EXTRA[@]+"${EXTRA[@]}"} >"$RUN/cells/${img}__${prof}__${jour}.host.log" 2>&1; ec=$?
  echo "$spec: exit $ec" | tee -a "$RUN/cells.exit.txt"
}
: >"$RUN/cells.exit.txt"
for spec in "${CELLS[@]}"; do
  while (( $(jobs -rp | wc -l) >= PARALLEL )); do sleep 5; done
  run_one "$spec" &
done
wait
# aggregate
python3 - "$RUN" "$RUN_ID" <<'PY'
import json,glob,os,sys,datetime
run,run_id=sys.argv[1:3]
cells=[]
for f in sorted(glob.glob(f"{run}/cells/*/result.json")):
    d=json.load(open(f,encoding="utf-8",errors="replace")); d["dir"]=os.path.dirname(f); cells.append(d)
summary={"run_id":run_id,"finished_at":datetime.datetime.utcnow().isoformat()+"Z",
         "total":len(cells),"passed":sum(1 for c in cells if c.get("ok")),
         "infra_failures":sum(1 for c in cells if c.get("infra")),
         "cells":[{k:c.get(k) for k in ("cell","image","profile","journey","ok","infra","failed","duration_secs","exit_code","vm")} for c in cells]}
json.dump(summary,open(f"{run}/summary.json","w"),indent=2)
L=[f"# HQ install matrix — run {run_id}","",f"**{summary['passed']}/{summary['total']} cells passed**"+(f", {summary['infra_failures']} infra failure(s)" if summary['infra_failures'] else ""),"",
   "| image | profile | journey | result | failed checks | secs |","|---|---|---|---|---|---|"]
for c in cells:
    res="PASS" if c.get("ok") else ("INFRA: "+c["infra"] if c.get("infra") else "FAIL")
    L.append(f"| {c.get('image')} | {c.get('profile')} | {c.get('journey')} | {res} | {', '.join(c.get('failed') or [])} | {c.get('duration_secs','')} |")
L+=["","## Failure detail",""]
for c in cells:
    if c.get("ok"): continue
    L.append(f"### {c.get('cell')}")
    for ch in c.get("checks",[]):
        if not ch.get("ok"): L.append(f"- `{ch['name']}` — {ch.get('detail','')}")
    for n in c.get("notes",[]): L.append(f"- note: {n}")
    errs=os.path.join(c["dir"],"guest","engine-errors.txt")
    if os.path.exists(errs) and os.path.getsize(errs):
        L+=["","Engine error lines:","```"]+open(errs).read().splitlines()[:30]+["```"]
    L.append("")
open(f"{run}/summary.md","w").write("\n".join(L)+"\n")
print("\n".join(L[:len(cells)+6]))
PY
ln -sfn "$RUN" "$MATRIX_DIR/runs/latest"
if [[ "$NIGHTLY" == 1 ]]; then
  REP="$E2E_DIR/reports/${RUN_ID}-install-matrix"; mkdir -p "$REP"
  cp "$RUN/summary.md" "$REP/REPORT.md"; cp "$RUN/summary.json" "$REP/summary.json"
  log "report: $REP/REPORT.md"
  [[ -n "${HQ_MATRIX_NOTIFY_CMD:-}" ]] && bash -c "$HQ_MATRIX_NOTIFY_CMD \"$RUN/summary.md\"" || true
fi
python3 -c "import json,sys; d=json.load(open('$RUN/summary.json')); sys.exit(0 if d['passed']==d['total'] else 1)"
