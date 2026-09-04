#!/usr/bin/env bash
# Bake `consumer-mac-sequoia` — a bare macOS Sequoia (15.x) clean room.
# Thin wrapper over bake-consumer-mac.sh (same strip + hard bare-gate).
# Sequoia is the most-installed current macOS and was missing from the matrix.
#
#   bash workspace/e2e-mac/bake-consumer-mac-sequoia.sh
set -euo pipefail
TART_BASE="${TART_BASE:-ghcr.io/cirruslabs/macos-sequoia-base:latest}" \
CONSUMER_VM="consumer-mac-sequoia" \
exec bash "$(dirname "${BASH_SOURCE[0]}")/bake-consumer-mac.sh"
