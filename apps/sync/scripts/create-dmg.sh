#!/usr/bin/env bash
#
# create-dmg.sh — Create the styled DMG installer for the HQ app.
#
# Usage:
#   ./scripts/create-dmg.sh <path-to.app> <output.dmg>
#
# Example:
#   ./scripts/create-dmg.sh "target/release/bundle/macos/HQ.app" HQ.dmg
#
# The window layout, background artwork and icon coordinates live in
# scripts/dmg/. See scripts/dmg/settings.py for why this uses dmgbuild instead
# of the usual Finder/AppleScript recipe: styling a disk image through Finder
# needs a logged-in GUI session, which a headless release runner does not have,
# so that approach works on a laptop and fails in CI. dmgbuild writes the
# .DS_Store directly and never talks to Finder.

set -euo pipefail

APP_PATH="${1:?Usage: create-dmg.sh <path-to.app> <output.dmg>}"
DMG_PATH="${2:?Usage: create-dmg.sh <path-to.app> <output.dmg>}"

if [ ! -d "$APP_PATH" ]; then
  echo "Error: '$APP_PATH' is not a directory"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DMG_DIR="$SCRIPT_DIR/dmg"
SETTINGS="$DMG_DIR/settings.py"
BACKGROUND="$DMG_DIR/background.tiff"
VOLUME_ICON="$SCRIPT_DIR/../src-tauri/icons/icon.icns"
VOLUME_NAME="HQ"
DMGBUILD_VERSION="1.6.5"

for required in "$SETTINGS" "$BACKGROUND" "$VOLUME_ICON"; do
  if [ ! -f "$required" ]; then
    echo "Error: missing required file '$required'" >&2
    exit 1
  fi
done

# dmgbuild is a build-time tool, not a product dependency, so it is not in
# package.json or Cargo.toml. Resolve it from PATH when the environment already
# provides it; otherwise stand up a pinned virtualenv beside the repo. The
# venv is reused across builds on the same machine.
resolve_dmgbuild() {
  if command -v dmgbuild >/dev/null 2>&1; then
    DMGBUILD="$(command -v dmgbuild)"
    echo "==> Using dmgbuild from PATH: $DMGBUILD"
    return
  fi

  local venv="${DMGBUILD_VENV:-$SCRIPT_DIR/../.dmgbuild-venv}"
  if [ ! -x "$venv/bin/dmgbuild" ]; then
    echo "==> Installing dmgbuild==$DMGBUILD_VERSION into $venv..."
    python3 -m venv "$venv"
    "$venv/bin/pip" install --quiet --disable-pip-version-check \
      "dmgbuild==$DMGBUILD_VERSION"
  fi
  DMGBUILD="$venv/bin/dmgbuild"
  echo "==> Using dmgbuild from venv: $DMGBUILD"
}

resolve_dmgbuild

rm -f "$DMG_PATH"

echo "==> Building styled DMG..."
"$DMGBUILD" \
  -s "$SETTINGS" \
  -D app="$(cd "$(dirname "$APP_PATH")" && pwd)/$(basename "$APP_PATH")" \
  -D background="$BACKGROUND" \
  -D volume_icon="$VOLUME_ICON" \
  "$VOLUME_NAME" \
  "$DMG_PATH"

if [ ! -f "$DMG_PATH" ]; then
  echo "Error: dmgbuild reported success but '$DMG_PATH' is missing" >&2
  exit 1
fi

DMG_SIZE=$(du -h "$DMG_PATH" | cut -f1)
echo "==> DMG created: $DMG_PATH ($DMG_SIZE)"
