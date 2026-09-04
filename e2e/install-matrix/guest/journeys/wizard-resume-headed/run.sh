#!/usr/bin/env bash
# Journey: wizard-resume-headed — drive the REAL HQ Desktop onboarding wizard
# (its own Svelte stage runner, install manifest, retries, settings wiring),
# not the headless engine. Requires a HEADED VM (run-cell.sh --headed).
#
# How sign-in is handled: the wizard's first screen hands off to Google /
# Microsoft in the system browser, which cannot be driven by keystrokes. The
# product's own resume path skips that screen: if ~/.hq/install-manifest.json
# says an install is in progress, the lifecycle classifier returns
# InstallResume and the wizard opens on the setup stage and runs every stage
# itself. We seed that record plus a signed-in E2E test-user session
# (~/.hq/cognito-tokens.json, minted on the host from the Cognito E2E user
# with no cloud credentials) — both are files the product itself reads.
#
# Needs artifacts: $HQ_MATRIX_ARTIFACTS/HQ.app.tgz, $HQ_MATRIX_ARTIFACTS/cognito-tokens.json
source "$HQ_MATRIX_ROOT/kit/common.sh"
APP_TGZ="$HQ_MATRIX_ARTIFACTS/HQ.app.tgz"; TOK="$HQ_MATRIX_ARTIFACTS/cognito-tokens.json"
[[ -f "$APP_TGZ" ]] || { check "artifact.app" 1 "missing $APP_TGZ"; result_write 1; exit 2; }
[[ -s "$TOK" ]] || { check "artifact.tokens" 1 "missing $TOK (host mints it in stage-artifacts.sh --tokens)"; result_write 1; exit 2; }
SHOTS="$HQ_MATRIX_OUT/shots"; mkdir -p "$SHOTS"
TIMEOUT="${HQ_MATRIX_WIZARD_TIMEOUT:-1500}"

# Install the app (copied, not downloaded → no quarantine), keyboard UI on.
pkill -f hq-sync-menubar 2>/dev/null; sleep 1
rm -rf "$HOME/Applications/HQ.app"; mkdir -p "$HOME/Applications"
tar -xzf "$APP_TGZ" -C "$HOME/Applications" && xattr -dr com.apple.quarantine "$HOME/Applications/HQ.app" 2>/dev/null
defaults write -g AppleKeyboardUIMode -int 3
check "app.installed" 0 "$(defaults read "$HOME/Applications/HQ.app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)"

# Seed product-owned state: session + in-progress manifest (resume from `content`).
mkdir -p "$HOME/.hq"; rm -rf "$HOME/hq"
cp "$TOK" "$HOME/.hq/cognito-tokens.json"; chmod 600 "$HOME/.hq/cognito-tokens.json"
cat >"$HOME/.hq/install-manifest.json" <<EOM
{"schemaVersion":1,"installerVersion":"matrix","installPath":"$HOME/hq","startedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","completedAt":null,"steps":{"content":{"status":"failed","error":"harness: seeded resume point"}},"dependencies":{},"packs":{},"failures":[]}
EOM

# Launch the real bundle binary (stdout captured), keep the card on screen.
t0=$(date +%s)
env HQ_DISABLE_BLUR_HIDE=1 HQ_DEV_SHOW_ON_LAUNCH=1 HQ_INSTALLER_DEBUG_DEPS=1 \
  "$HOME/Applications/HQ.app/Contents/MacOS/hq-sync-menubar" >"$HQ_MATRIX_OUT/app.stdout" 2>&1 &
APP_PID=$!
sleep 12; screencapture -x "$SHOTS/t000.png"
# The first-run card auto-shows; if it did not, summon it (Opt+Shift+H).
if ! osascript -e 'tell application "System Events" to get name of every window of process "hq-sync-menubar"' 2>/dev/null | grep -q HQ; then
  osascript -e 'tell application "System Events" to key code 4 using {option down, shift down}' 2>/dev/null; sleep 3
fi
done_flag=0; i=0
while (( $(date +%s) - t0 < TIMEOUT )); do
  i=$((i+1)); sleep 15
  screencapture -x "$SHOTS/t$(printf %03d $i).png" 2>/dev/null
  if grep -Eq '^  "completedAt": *"' "$HOME/.hq/install-manifest.json" 2>/dev/null; then done_flag=1; break; fi
  # Liveness by name, not by $!: the app re-execs / hands off to a LaunchServices
  # instance shortly after launch, so the original PID goes away while the app lives on.
  pgrep -q -f "HQ.app/Contents/MacOS/hq-sync-menubar" || { note "no hq-sync-menubar process alive before the manifest completed"; break; }
  # A native dialog (Xcode CLT, etc.) appearing DURING the wizard is a product bug — record + dismiss.
  fg="$(osascript -e 'tell application "System Events" to get name of every process whose background only is false' 2>/dev/null)"
  if [[ "$fg" == *"Install Command Line Developer Tools"* ]]; then
    check "wizard.no-clt-dialog" 1 "Xcode CLT dialog appeared during the wizard (something invoked a CLT stub)"
    osascript -e 'tell application "System Events" to tell process "Install Command Line Developer Tools" to click button "Cancel" of window 1' 2>/dev/null || true
  fi
done
cp "$HOME/.hq/install-manifest.json" "$HQ_MATRIX_OUT/install-manifest.json" 2>/dev/null
cp "$HOME/.hq/logs/hq-sync.log" "$HQ_MATRIX_OUT/hq-sync.log" 2>/dev/null
[[ $done_flag == 1 ]] && check "wizard.completed" 0 "$(( $(date +%s) - t0 ))s" || check "wizard.completed" 1 "manifest never got completedAt within ${TIMEOUT}s"

# Per-stage verdicts straight from the wizard's own manifest (no screen scraping).
for st in content deps initial-sync packages git-init personalize import indexing menubar; do
  status="$(sed -n "/\"$st\": {/,/}/p" "$HOME/.hq/install-manifest.json" | sed -n 's/.*"status": *"\([a-z]*\)".*/\1/p' | head -1)"
  err="$(sed -n "/\"$st\": {/,/}/p" "$HOME/.hq/install-manifest.json" | sed -n 's/.*"error": *"\(.*\)".*/\1/p' | head -1 | cut -c1-200)"
  case "$status" in ok) check "wizard.stage.$st" 0;; "") check "wizard.stage.$st" 1 "not recorded";; *) check "wizard.stage.$st" 1 "$status: $err";; esac
done
[[ -d "$HOME/hq/.git" ]] && check "wizard.hq-is-git-repo" 0 || check "wizard.hq-is-git-repo" 1 "~/hq has no .git (git-init stage did not produce a repo)"

# The same user-facing checks the headless journey runs — this is the parity signal.
for t in node npm yq jq qmd hq git; do p="$(login_which $t)"; [[ -n "$p" ]] && check "login.$t.on-path" 0 "$p" || check "login.$t.on-path" 1 "not on login-shell PATH"; done
run_check "login.qmd.runs" $(login_shell_cmd) 'qmd --version'
run_check "login.hq.runs"  $(login_shell_cmd) 'hq --version'
gitp="$(login_which git)"; if clt_present; then check "login.git.usable" 0 "$gitp"; elif [[ "$gitp" != /usr/bin/git ]]; then check "login.git.not-clt-shim" 0 "$gitp"; else check "login.git.not-clt-shim" 1 "CLT stub"; fi
rm -rf /tmp/hq-matrix-clone; run_check "git.https-clone" $(login_shell_cmd) 'git clone -q --depth 1 https://github.com/cirruslabs/tart.git /tmp/hq-matrix-clone'
# Pre-existing cloud state (July 2026 report, rated HIGH): HQ Sync's first
# cloud sync overwrote the fresh install's .claude/settings.json env.PATH with
# another machine's PATH ~40 s after install, silently reverting the day-one
# qmd fix. Let the app keep running and re-check the file after the sync window.
SJ="$HOME/hq/.claude/settings.json"
if [[ -f "$SJ" ]]; then
  before_path="$(sed -n 's/.*"PATH": *"\([^"]*\)".*/\1/p' "$SJ" | head -1)"
  sleep 75
  after_path="$(sed -n 's/.*"PATH": *"\([^"]*\)".*/\1/p' "$SJ" | head -1)"
  if [[ "$after_path" == *"Indigo HQ/toolchain"* ]]; then check "settings.path-survives-first-sync" 0 "toolchain still in env.PATH after 75s"
  else check "settings.path-survives-first-sync" 1 "env.PATH lost the managed toolchain after first sync: '${after_path:0:160}' (was '${before_path:0:80}')"; fi
else
  note "no $SJ after wizard — cannot check first-sync PATH clobber"
fi
pkill -f hq-sync-menubar 2>/dev/null || true
result_write 0
