#!/usr/bin/env bash
# Journey: setup-sh — run core/scripts/setup.sh non-interactively against a
# minimal HQ tree. On a bare image this is EXPECTED to fail fast (node/npm/jq
# required) — the check records the exact exit point. After desktop-deps it
# must pass, and must NOT downgrade qmd.
#
# Needs artifact: $HQ_MATRIX_ARTIFACTS/hq-tree.tar.gz (stage-artifacts.sh).
source "$HQ_MATRIX_ROOT/kit/common.sh"
TAR="$HQ_MATRIX_ARTIFACTS/hq-tree.tar.gz"
[[ -f "$TAR" ]] || { check "artifact.hq-tree" 1 "missing $TAR"; result_write 1; exit 2; }
rm -rf "$HOME/hq-matrix-tree"; mkdir -p "$HOME/hq-matrix-tree"; tar -xzf "$TAR" -C "$HOME/hq-matrix-tree"
cd "$HOME/hq-matrix-tree"
before="$(login_run 'qmd --version' | tail -1)"
set +e
$(login_shell_cmd) 'HQ_SKIP_PACKAGES=1 bash core/scripts/setup.sh </dev/null' >"$HQ_MATRIX_OUT/setup-sh.log" 2>&1; ec=$?
set -e
after="$(login_run 'qmd --version' | tail -1)"
expect="${HQ_MATRIX_DEPS_EXPECT:-pass}"
if [[ "$HQ_MATRIX_IMAGE" == *consumer* && "$HQ_MATRIX_JOURNEY" == setup-sh ]]; then expect=fail-fast; fi
case "$expect" in
  fail-fast) [[ $ec -ne 0 ]] && check "setup-sh.fails-fast-on-bare" 0 "exit $ec: $(grep -m1 -E 'not found|required|missing' "$HQ_MATRIX_OUT/setup-sh.log" | head -c 200)" \
                             || check "setup-sh.fails-fast-on-bare" 1 "unexpectedly passed on a bare image" ;;
  *)         [[ $ec -eq 0 ]] && check "setup-sh.exit0" 0 || check "setup-sh.exit0" 1 "exit $ec — $(tail -c 300 "$HQ_MATRIX_OUT/setup-sh.log" | tr '\n' ' ')" ;;
esac
grep -q "hang\|Install recommended pack" "$HQ_MATRIX_OUT/setup-sh.log" && note "pack prompt reached non-interactively" || true
if [[ -n "$before" && "$before" == qmd* ]]; then
  [[ "$before" == "$after" || "$after" > "$before" ]] && check "setup-sh.no-qmd-downgrade" 0 "$before → $after" || check "setup-sh.no-qmd-downgrade" 1 "$before → $after"
fi
result_write 0
