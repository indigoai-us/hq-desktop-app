#!/bin/bash
# build-bench-bundle.sh — build the idea-board benchmark .app with a PINNED
# bundle identifier so the macOS Screen Recording grant survives rebuilds.
#
# Why this exists
# ---------------
# TCC keys privacy grants on (bundle identifier + code signature). The plain
# `npm run bundle:debug` bundle reuses the SHIPPING identifier
# ai.indigo.hq-sync-menubar, which collides with the installed/dev app — so
# the two fight over the single-instance socket, the LaunchAgent and ~/.hq
# (see company policy hq-desktop-app-local-builds-follow-local-build-guide and
# docs/LOCAL-BUILD-AND-TEST.md §3). Worse for benchmarking, re-signing that
# bundle invalidates the grant and the latency bench silently records zero
# samples. Two benchmark runs were lost that way.
#
# This script follows the guide's `--config`-override recipe, but pins the
# identifier instead of date-tagging it: the WHOLE POINT is that the grant is
# granted ONCE for ai.indigo.hq-idea-board-bench and survives every rebuild.
# Ad-hoc signing ("-") keeps the same (empty) designated-requirement identity
# across rebuilds, so TCC keeps matching the bundle by identifier.
#
# Usage: ./scripts/build-bench-bundle.sh [--print-path]
#   --print-path   print the .app path and exit (no build)
set -euo pipefail

BENCH_IDENTIFIER="ai.indigo.hq-idea-board-bench"
BENCH_PRODUCT_NAME="HQ Idea Board Bench"

cd "$(dirname "$0")/.."
APP_PATH="$PWD/src-tauri/target/debug/bundle/macos/$BENCH_PRODUCT_NAME.app"

if [ "${1:-}" = "--print-path" ]; then
  echo "$APP_PATH"
  exit 0
fi

echo "Building $BENCH_PRODUCT_NAME ($BENCH_IDENTIFIER)…"
npm run sidecar:install

# `tauri build` runs beforeBuildCommand (`npm run build`), so the embedded
# frontend is always rebuilt from the current source — a stale apps/sync/dist
# cannot end up inside the bundle.
rm -rf "$APP_PATH"
./node_modules/.bin/tauri build --debug --bundles app --config "{
  \"productName\": \"$BENCH_PRODUCT_NAME\",
  \"identifier\": \"$BENCH_IDENTIFIER\",
  \"plugins\": { \"updater\": { \"endpoints\": [] } },
  \"bundle\": { \"createUpdaterArtifacts\": false, \"macOS\": { \"signingIdentity\": \"-\" } }
}"

bash scripts/fix-recall-framework-symlinks.sh "$APP_PATH"
# Ad-hoc identity: stable, certificate-free, and the same on every rebuild.
bash scripts/sign-bundle.sh "$APP_PATH" "-"

echo ""
echo "Bundle: $APP_PATH"
codesign -dv "$APP_PATH" 2>&1 | grep -E "^(Identifier|Signature)" || true
echo ""
echo "Grant Screen Recording ONCE to this bundle:"
echo "  System Settings > Privacy & Security > Screen & System Audio Recording > + > $APP_PATH"
echo "Rebuilding with this script does NOT void that grant (identifier is pinned)."
