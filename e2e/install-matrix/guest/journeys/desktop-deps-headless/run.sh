#!/usr/bin/env bash
# Journey: desktop-deps-headless — run the desktop app's REAL dependency
# engine (install_deps) unattended via HQ_HEADLESS_INSTALL_DEPS, then verify
# from a fresh login shell that every tool a user would type actually works.
#
# Needs artifact: $HQ_MATRIX_ARTIFACTS/hq-sync-menubar (stage-artifacts.sh).
source "$HQ_MATRIX_ROOT/kit/common.sh"
BIN="$HQ_MATRIX_ARTIFACTS/hq-sync-menubar"
[[ -x "$BIN" ]] || { check "artifact.binary" 1 "missing $BIN — run stage-artifacts.sh on the host"; result_write 1; exit 2; }
check "artifact.binary" 0 "$(ls -la "$BIN" | awk '{print $5" bytes"}')"
OUT="$HQ_MATRIX_OUT/headless-install.json"; LOG="$HQ_MATRIX_OUT/headless-install.log"
TIMEOUT="${HQ_MATRIX_DEPS_TIMEOUT:-1500}"

run_engine() {
  # $1 = launcher mode
  rm -f "$OUT"
  case "$1" in
    direct)  env HQ_HEADLESS_INSTALL_DEPS="$OUT" "$BIN" >"$LOG" 2>&1 & ;;
    asuser)  echo "$HQ_MATRIX_GUEST_PASS" | sudo -S launchctl asuser "$(id -u)" sudo -u "$(id -un)" env HOME="$HOME" HQ_HEADLESS_INSTALL_DEPS="$OUT" "$BIN" >"$LOG" 2>&1 & ;;
  esac
  local pid=$! t=0
  while kill -0 "$pid" 2>/dev/null; do
    (( t >= TIMEOUT )) && { log "engine timeout after ${t}s — killing"; kill "$pid" 2>/dev/null; return 124; }
    sleep 5; t=$((t+5))
  done
  wait "$pid" 2>/dev/null; return $?
}
t0=$(date +%s)
run_engine direct; ec=$?
if [[ ! -f "$OUT" && $ec -ne 124 ]]; then
  note "direct launch produced no result (exit $ec) — retrying under launchctl asuser (GUI session)"
  run_engine asuser; ec=$?
fi
elapsed=$(( $(date +%s) - t0 ))
if [[ -f "$OUT" ]]; then
  # Parse with the freshly installed managed node (no python3/jq on a bare Mac).
  NODE="$(login_which node)"
  if [[ -n "$NODE" ]] && ! is_clt_stub "$NODE"; then
    $(login_shell_cmd) "node -e '
      const d=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"));
      console.log(\"engine.ok\", d.ok?0:1, (d.error||(d.duration_secs+\"s, \"+d.progress_lines+\" progress lines\")).slice(0,300).replace(/\\s+/g,\" \"));
      for (const p of d.probes) console.log(\"engine.probe.\"+p.id, (p.installed||p.optional)?0:1, (p.optional?\"optional\":\"required\")+\" installed=\"+p.installed+\" version=\"+p.version+\" path=\"+p.path);
    ' \"$OUT\"" >"$HQ_MATRIX_OUT/.engine-checks" 2>/dev/null || true
  fi
  if [[ -s "$HQ_MATRIX_OUT/.engine-checks" ]]; then
    while read -r name ok detail; do check "$name" "$ok" "$detail"; done <"$HQ_MATRIX_OUT/.engine-checks"
  else
    # grep fallback: only the top-level ok flag
    if grep -q '"ok": true' "$OUT"; then check "engine.ok" 0 "(parsed by grep — node unavailable)"; else check "engine.ok" 1 "$(grep -o '"error": "[^"]*"' "$OUT" | head -c 300)"; fi
  fi
else
  check "engine.ran" 1 "no result json; launcher exit=$ec after ${elapsed}s; log tail: $(tail -c 300 "$LOG" | tr '\n' ' ')"
fi
# Error-shape corpus — every distinct [dep] error line the engine emitted, so
# a failure taxonomy can be built across the matrix without re-running.
grep -E '^\[[a-z-]+\] .*(error|Error|ERR|failed|Failed|not found|denied|timeout)' "$LOG" 2>/dev/null | sort -u | head -50 >"$HQ_MATRIX_OUT/engine-errors.txt" || true

# ── what the USER sees: a brand-new login shell ────────────────────────────
for t in node npm yq qmd hq git; do
  p="$(login_which $t)"
  [[ -n "$p" ]] && check "login.$t.on-path" 0 "$p" || check "login.$t.on-path" 1 "not on login-shell PATH"
done
run_check "login.node.runs"  $(login_shell_cmd) 'node -e "console.log(process.version)"'
run_check "login.qmd.runs"   $(login_shell_cmd) 'qmd --version'
run_check "login.hq.runs"   $(login_shell_cmd) 'hq --version'
run_check "login.yq.runs"   $(login_shell_cmd) 'yq --version'
run_check "login.git.runs"   $(login_shell_cmd) 'git --version'
# git must be a REAL git (not the CLT shim that pops a dialog) and able to TLS-clone.
gitp="$(login_which git)"
if clt_present; then check "login.git.usable" 0 "CLT present; $gitp is a real git"
elif [[ "$gitp" != "/usr/bin/git" ]]; then check "login.git.not-clt-shim" 0 "$gitp"
else check "login.git.not-clt-shim" 1 "resolves to CLT shim (no CLT installed)"; fi
rm -rf /tmp/hq-matrix-clone; run_check "git.https-clone" $(login_shell_cmd) 'git clone -q --depth 1 https://github.com/cirruslabs/tart.git /tmp/hq-matrix-clone'
# qmd must actually index + search, not just print a version (native deps!).
mkdir -p /tmp/hq-matrix-qmd && printf '# Hello\nmatrix sentinel phrase\n' >/tmp/hq-matrix-qmd/a.md
run_check "qmd.collection.add" $(login_shell_cmd) 'cd /tmp/hq-matrix-qmd && qmd collection add . --name hqmatrix'
run_check "qmd.update"         $(login_shell_cmd) 'cd /tmp/hq-matrix-qmd && qmd update --name hqmatrix'
run_check "qmd.search"         $(login_shell_cmd) 'cd /tmp/hq-matrix-qmd && qmd search "sentinel phrase" 2>&1 | grep -q a.md'
# the shell PATH block must survive a NEW shell AND be present in the rc the
# user's login shell actually reads (bash-default-shell profile catches the gap)
sh_now="$(dscl . -read /Users/$(id -un) UserShell 2>/dev/null | awk '{print $2}')"
if [[ "$sh_now" == */bash ]]; then
  grep -q "Indigo HQ managed toolchain" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.profile" 2>/dev/null && check "shell.path-block.bash" 0 || check "shell.path-block.bash" 1 "PATH block not in any bash rc; login shell is bash"
  [[ -n "$(bash -lc 'command -v qmd' 2>/dev/null)" ]] && check "login.bash.qmd" 0 || check "login.bash.qmd" 1 "qmd not on bash login PATH"
else
  grep -q "Indigo HQ managed toolchain" "$HOME/.zprofile" "$HOME/.zshrc" 2>/dev/null && check "shell.path-block.zsh" 0 || check "shell.path-block.zsh" 1
fi
# Non-interactive shells (scripts, hooks, launchd, `zsh -lc`) do NOT read
# ~/.zshrc. If the PATH block only lives there, every subprocess that is not a
# user terminal loses the toolchain. Record it as a check.
ni="$(noninteractive_which qmd)"
if [[ -n "$ni" ]]; then check "path.non-interactive-shell" 0 "$ni"; else check "path.non-interactive-shell" 1 "qmd not on PATH in a non-interactive login shell (PATH block only in the interactive rc?) — scripts/hooks/launchd won't find the toolchain"; fi
# optional deps are silently never installed today — record, don't fail
for t in claude gh; do p="$(login_which $t)"; note "optional $t: ${p:-NOT installed}"; done
cp "$LOG" "$HQ_MATRIX_OUT/" 2>/dev/null || true
result_write 0
