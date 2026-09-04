#!/usr/bin/env bash
# Stage the artifacts journeys need into matrix/artifacts/ (pushed to every VM).
#
#   bash workspace/e2e-mac/matrix/stage-artifacts.sh [--desktop-worktree <path>] [--skip-build]
#
# Artifacts:
#   hq-sync-menubar   — desktop app release binary built WITH the headless
#                       install mode (feature/headless-install-deps or later).
#   hq-tree.tar.gz    — minimal HQ tree (core/scripts/setup.sh + core.yaml +
#                       .claude/hooks) so setup.sh can run in the guest.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# Default: the checkout this harness lives in (it is versioned inside hq-desktop-app).
WT="${HQ_DESKTOP_WORKTREE:-$(cd "$MATRIX_DIR/../.." && pwd -P)}"; SKIP_BUILD=0; WITH_APP=1; WITH_TOKENS=1
while [[ $# -gt 0 ]]; do case "$1" in --desktop-worktree) WT="$2"; shift 2;; --skip-build) SKIP_BUILD=1; shift;; --no-app) WITH_APP=0; shift;; --no-tokens) WITH_TOKENS=0; shift;; *) shift;; esac; done
A="$MATRIX_DIR/artifacts"; mkdir -p "$A"

# 1. desktop binary
SRC="$WT/apps/sync/src-tauri"
grep -q "headless_install" "$SRC/src/commands/mod.rs" 2>/dev/null || die "$WT does not contain the headless install mode (commands/headless_install.rs)"
if [[ "$SKIP_BUILD" == 0 ]]; then
  log "building desktop binary in $WT (release)…"
  ( cd "$WT/apps/sync" && pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null \
    && pnpm -C sidecar/recall-sdk-bridge install --ignore-workspace --config.minimumReleaseAge=1440 >/dev/null \
    && cd src-tauri && cargo build --release --bin hq-sync-menubar 2>&1 | tail -3 )
fi
BIN="$SRC/target/release/hq-sync-menubar"; [[ -x "$BIN" ]] || die "binary not found at $BIN"
cp "$BIN" "$A/hq-sync-menubar"
# ad-hoc sign so the guest (Gatekeeper) runs an unbundled binary without prompts
codesign --force -s - "$A/hq-sync-menubar" >/dev/null 2>&1 || true
log "staged hq-sync-menubar ($(du -h "$A/hq-sync-menubar" | cut -f1)) from $(git -C "$WT" rev-parse --short HEAD)"
git -C "$WT" rev-parse HEAD >"$A/hq-sync-menubar.commit"

# 1b. the full .app bundle for the headed wizard journey (ad-hoc signed)
if [[ "$WITH_APP" == 1 ]]; then
  APP="$SRC/target/release/bundle/macos/HQ.app"
  if [[ "$SKIP_BUILD" == 0 || ! -d "$APP" ]]; then
    log "bundling HQ.app (tauri build --bundles app; updater-signing errors are expected and harmless)…"
    ( cd "$WT/apps/sync" && pnpm tauri build --bundles app >/dev/null 2>&1 || true )
  fi
  [[ -d "$APP" ]] || die "HQ.app not found at $APP"
  ( cd "$WT/apps/sync" && bash scripts/fix-recall-framework-symlinks.sh "$APP" >/dev/null 2>&1 || true )
  codesign --force --deep -s - "$APP" >/dev/null 2>&1 || true
  rm -f "$A/HQ.app.tgz"; tar -czf "$A/HQ.app.tgz" -C "$(dirname "$APP")" HQ.app
  log "staged HQ.app.tgz ($(du -h "$A/HQ.app.tgz" | cut -f1))"
fi

# 1c. a signed-in session for the Cognito E2E test user (public client, no AWS creds).
#     Written ONLY into artifacts/ (git-ignored, pushed into disposable VMs); 1h lifetime.
if [[ "$WITH_TOKENS" == 1 ]]; then
  CLIENT_ID="${HQ_MATRIX_COGNITO_CLIENT_ID:-7acei2c8v870enheptb1j5foln}"
  USER="${HQ_MATRIX_E2E_USER:-alice-e2e@getindigo.ai}"
  PASS="${HQ_MATRIX_E2E_PASSWORD:-E2eTest!Alice$(date +%Y)}"
  if aws cognito-idp initiate-auth --no-sign-request --region us-east-1 --client-id "$CLIENT_ID" --auth-flow USER_PASSWORD_AUTH        --auth-parameters "USERNAME=$USER,PASSWORD=$PASS" 2>/dev/null | python3 -c "
import sys,json,time; r=json.load(sys.stdin)['AuthenticationResult']
print(json.dumps({'accessToken':r['AccessToken'],'idToken':r['IdToken'],'refreshToken':r['RefreshToken'],'expiresAt':int((time.time()+r['ExpiresIn']-60)*1000)}))" >"$A/cognito-tokens.json.tmp" 2>/dev/null && [[ -s "$A/cognito-tokens.json.tmp" ]]; then
    mv "$A/cognito-tokens.json.tmp" "$A/cognito-tokens.json"; chmod 600 "$A/cognito-tokens.json"; log "staged E2E session for $USER (1h)"
  else
    rm -f "$A/cognito-tokens.json.tmp"; log "WARN: could not mint E2E session tokens; wizard-resume-headed will fail closed"
  fi
fi

# 2. minimal HQ tree for setup.sh
TMP="$(mktemp -d)"; mkdir -p "$TMP/core/scripts" "$TMP/.claude/hooks" "$TMP/.claude/skills"
cp "$HQ_ROOT/core/scripts/setup.sh" "$HQ_ROOT/core/scripts/compose-settings-path.sh" "$TMP/core/scripts/" 2>/dev/null || true
cp "$HQ_ROOT/core/core.yaml" "$TMP/core/" 2>/dev/null || true
printf '{}\n' >"$TMP/.claude/settings.json"
tar -czf "$A/hq-tree.tar.gz" -C "$TMP" .; rm -rf "$TMP"
log "staged hq-tree.tar.gz (setup.sh qmd pin: $(grep -m1 '^QMD_VERSION=' "$HQ_ROOT/core/scripts/setup.sh"))"
ls -la "$A"
