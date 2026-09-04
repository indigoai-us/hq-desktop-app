#!/usr/bin/env bash
# Parity check: the hidden-mode engine run vs the real headed wizard run on the
# same image + build. Compares every shared user-facing check (login.*, git.*,
# qmd.*) and the deps outcome. Any disagreement = harness-specific variance.
#   bash workspace/e2e-mac/matrix/compare-runs.sh <headless-run-id> <headed-run-id>
set -euo pipefail
M="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 - "$M/runs/$1" "$M/runs/$2" <<'PY'
import json,glob,os,sys
a,b=sys.argv[1:3]
def load(run):
    out={}
    for f in glob.glob(f"{run}/cells/*/result.json"):
        d=json.load(open(f,errors="replace")); out[d["image"]]=d
    return out
H,W=load(a),load(b)
bad=0
print(f"| image | check | hidden mode | real wizard |\n|---|---|---|---|")
for img in sorted(set(H)&set(W)):
    hc={c["name"]:c for c in H[img]["checks"]}; wc={c["name"]:c for c in W[img]["checks"]}
    # deps outcome
    h_deps=hc.get("engine.ok",{}).get("ok"); w_deps=wc.get("wizard.stage.deps",{}).get("ok")
    flag="" if h_deps==w_deps else " **MISMATCH**"; bad+= h_deps!=w_deps
    print(f"| {img} | dependency stage | {'PASS' if h_deps else 'FAIL'} | {'PASS' if w_deps else 'FAIL'}{flag} |")
    for name in sorted(n for n in hc if n.split('.')[0] in ('login','git','qmd')):
        if name in wc:
            ho,wo=hc[name]["ok"],wc[name]["ok"]; flag="" if ho==wo else " **MISMATCH**"; bad+= ho!=wo
            print(f"| {img} | {name} | {'PASS' if ho else 'FAIL'} | {'PASS' if wo else 'FAIL'}{flag} |")
    hb=json.load(open(f"{M}/artifacts/hq-sync-menubar.commit")) if False else None
print(f"\n{'No variance between hidden mode and real wizard.' if bad==0 else f'{bad} disagreement(s) — investigate.'}")
sys.exit(1 if bad else 0)
PY
