#!/usr/bin/env bash
# Bake the Tahoe (macOS 26.x) consumer-mac snapshot.
#
# Thin wrapper around bake-consumer-mac.sh — same scrub logic, Tahoe base image.
# Re-run to refresh the snapshot when agent-browser or Chrome version drifts.
#
# Usage:
#   bash workspace/e2e-mac/bake-consumer-mac-tahoe.sh
#
# Spin up after baking:
#   bash workspace/e2e-mac/fresh-mac.sh up --tahoe
#
# To bake AND spin up AND pre-download the HQ installer (guaranteed clean,
# always-latest installer in ~/Downloads/) in one command:
#   bash workspace/e2e-mac/clean-tahoe.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TART_BASE="ghcr.io/cirruslabs/macos-tahoe-base:latest" \
CONSUMER_VM="consumer-mac-tahoe" \
exec bash "$HERE/bake-consumer-mac.sh" "$@"
