#!/bin/bash
# build-bench-bundle.sh — build the idea-board benchmark .app with a PINNED
# bundle identifier AND a STABLE Developer ID code signature, so the macOS
# Screen Recording grant survives rebuilds.
#
# Why this exists
# ---------------
# TCC keys privacy grants on (bundle identifier + CODE IDENTITY). The plain
# `npm run bundle:debug` bundle reuses the SHIPPING identifier
# ai.indigo.hq-sync-menubar, which collides with the installed/dev app — so
# the two fight over the single-instance socket, the LaunchAgent and ~/.hq
# (see company policy hq-desktop-app-local-builds-follow-local-build-guide and
# docs/LOCAL-BUILD-AND-TEST.md §3). Worse for benchmarking, losing the grant
# makes the latency bench silently record zero samples.
#
# A PINNED IDENTIFIER ALONE IS NOT ENOUGH — that was the original bug here.
# For AD-HOC signed code ("-") there is no certificate, so TCC has no stable
# code identity to key on and falls back to the binary's **cdhash**, which
# changes on literally every build. The owner granted Screen Recording to the
# ad-hoc bench bundle TWICE and both grants were voided by the next rebuild
# (a fresh launch logged `meetings_permissions_state: … sc=Denied`, while
# `codesign -dv` reported `Signature=adhoc`, `TeamIdentifier=not set`).
#
# The fix is to sign with a real certificate whose designated requirement is
# stable across rebuilds: the Developer ID Application identity mandated for
# this repo by company policy indigo-hq-desktop-app-signing-release-identity.
# TCC then keys the grant on (identifier + Team ID FSZQ97X3V6 + cert chain),
# none of which change when the code is rebuilt. Grant ONCE, rebuild freely.
#
# Usage: ./scripts/build-bench-bundle.sh [--print-path]
#   --print-path   print the .app path and exit (no build)
set -euo pipefail

BENCH_IDENTIFIER="ai.indigo.hq-idea-board-bench"
BENCH_PRODUCT_NAME="HQ Idea Board Bench"
# Stable code identity for TCC. Mandated by company policy
# indigo-hq-desktop-app-signing-release-identity (Developer ID Application, NOT
# Apple Distribution). Team ID FSZQ97X3V6.
BENCH_SIGNING_IDENTITY="Developer ID Application: Stefan Johnson (FSZQ97X3V6)"

cd "$(dirname "$0")/.."
APP_PATH="$PWD/src-tauri/target/debug/bundle/macos/$BENCH_PRODUCT_NAME.app"

if [ "${1:-}" = "--print-path" ]; then
  echo "$APP_PATH"
  exit 0
fi

# Fail LOUDLY rather than silently falling back to ad-hoc: an ad-hoc fallback
# would look like a successful build and then quietly void the owner's Screen
# Recording grant on the next rebuild — the exact failure this script exists to
# prevent.
if ! security find-identity -v -p codesigning | grep -qF "$BENCH_SIGNING_IDENTITY"; then
  echo "ERROR: required code-signing identity not found in the login keychain:" >&2
  echo "         $BENCH_SIGNING_IDENTITY" >&2
  echo "       The bench bundle MUST be signed with this stable Developer ID identity." >&2
  echo "       Ad-hoc signing ('-') is NOT an acceptable fallback: TCC keys ad-hoc code" >&2
  echo "       on its cdhash, which changes on every build, so the macOS Screen Recording" >&2
  echo "       grant would be voided by the next rebuild." >&2
  echo "       Identities visible to codesign:" >&2
  security find-identity -v -p codesigning >&2 || true
  exit 1
fi

echo "Building $BENCH_PRODUCT_NAME ($BENCH_IDENTIFIER)…"
echo "Signing identity: $BENCH_SIGNING_IDENTITY"
npm run sidecar:install

# `tauri build` runs beforeBuildCommand (`npm run build`), so the embedded
# frontend is always rebuilt from the current source — a stale apps/sync/dist
# cannot end up inside the bundle.
rm -rf "$APP_PATH"
./node_modules/.bin/tauri build --debug --bundles app --config "{
  \"productName\": \"$BENCH_PRODUCT_NAME\",
  \"identifier\": \"$BENCH_IDENTIFIER\",
  \"plugins\": { \"updater\": { \"endpoints\": [] } },
  \"bundle\": { \"createUpdaterArtifacts\": false, \"macOS\": { \"signingIdentity\": \"$BENCH_SIGNING_IDENTITY\" } }
}"

bash scripts/fix-recall-framework-symlinks.sh "$APP_PATH"

# Signing posture for a LOCAL DEBUG bench bundle:
#   HARDENED_RUNTIME=0 — hardened runtime is only required for NOTARIZATION,
#     and this bundle never ships or gets notarized. Leaving it off avoids the
#     Recall SDK's GStreamer/ORC JIT failure modes entirely while changing
#     nothing about the code identity TCC keys the grant on.
#   TIMESTAMP=0      — a secure timestamp is a notarization requirement too,
#     and it makes every local rebuild depend on Apple's timestamp server.
#   Entitlements     — attached anyway so the bench bundle's entitlement set
#     matches the shipping app's (disable-library-validation, JIT, mic).
HQ_SIGN_ENTITLEMENTS="$PWD/src-tauri/Entitlements.plist" \
HARDENED_RUNTIME=0 \
TIMESTAMP=0 \
  bash scripts/sign-bundle.sh "$APP_PATH" "$BENCH_SIGNING_IDENTITY"

# Assert the result is NOT ad-hoc. sign-bundle.sh already fails on a codesign
# error, but a silently ad-hoc bundle is the specific regression that cost the
# owner two Screen Recording grants, so check the end state explicitly.
SIG_INFO=$(codesign -dv "$APP_PATH" 2>&1)
if echo "$SIG_INFO" | grep -q "Signature=adhoc"; then
  echo "ERROR: bench bundle ended up AD-HOC signed despite the Developer ID identity." >&2
  echo "       TCC would void the Screen Recording grant on the next rebuild." >&2
  echo "$SIG_INFO" >&2
  exit 1
fi
if ! echo "$SIG_INFO" | grep -q "TeamIdentifier=FSZQ97X3V6"; then
  echo "ERROR: bench bundle is not signed by Team ID FSZQ97X3V6 — code identity is not stable." >&2
  echo "$SIG_INFO" >&2
  exit 1
fi

echo ""
echo "Bundle: $APP_PATH"
codesign -dv "$APP_PATH" 2>&1 | grep -E "^(Identifier|Signature|TeamIdentifier)" || true
codesign -dvvv "$APP_PATH" 2>&1 | grep -E "^(CDHash|Authority)" || true
echo ""
echo "Grant Screen Recording ONCE to this bundle:"
echo "  System Settings > Privacy & Security > Screen & System Audio Recording > + > $APP_PATH"
echo "Rebuilding with this script does NOT void that grant: the identifier is pinned AND"
echo "the Developer ID signature gives TCC a stable code identity across rebuilds."
echo "(An ad-hoc signature would NOT — TCC keys ad-hoc code on its per-build cdhash.)"
