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
VERIFY_DS_STORE="$DMG_DIR/verify_ds_store.py"
# 1.6.7 is the floor, not just a pin: up to 1.6.6 dmgbuild wrote a pBBk
# background bookmark that makes Finder on macOS 26.2+ show a blank window
# instead of the artwork (dmgbuild/dmgbuild#273). verify_ds_store.py enforces
# the outcome on the built image whatever version produced it.
DMGBUILD_VERSION="1.6.7"

for required in "$SETTINGS" "$BACKGROUND" "$VOLUME_ICON" "$VERIFY_DS_STORE"; do
  if [ ! -f "$required" ]; then
    echo "Error: missing required file '$required'" >&2
    exit 1
  fi
done

# dmgbuild is a build-time tool, not a product dependency, so it is not in
# package.json or Cargo.toml. It always runs from a pinned virtualenv beside
# the repo, reused across builds on the same machine. A dmgbuild already on PATH
# is deliberately not used: its version is whatever happened to be installed,
# and an old one silently ships an installer whose background never shows.
# A reused venv holding any other version is rebuilt for the same reason.
# dmgbuild 1.6.7 needs Python 3.10+. macOS's own /usr/bin/python3 is 3.9, so
# prefer a newer interpreter wherever one is installed and fail with a clear
# message, not a pip resolver error, when there is none.
find_python() {
  local candidate
  for candidate in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1 &&
      "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
      command -v "$candidate"
      return
    fi
  done
  echo "Error: dmgbuild $DMGBUILD_VERSION needs Python 3.10 or newer; none found on PATH" >&2
  exit 1
}

resolve_dmgbuild() {
  local venv="${DMGBUILD_VENV:-$SCRIPT_DIR/../.dmgbuild-venv}"
  local installed=""
  if [ -x "$venv/bin/python" ]; then
    installed="$("$venv/bin/python" -c \
      'import importlib.metadata as m; print(m.version("dmgbuild"))' \
      2>/dev/null || true)"
  fi
  if [ "$installed" != "$DMGBUILD_VERSION" ]; then
    echo "==> Installing dmgbuild==$DMGBUILD_VERSION into $venv${installed:+ (replacing $installed)}..."
    local python
    python="$(find_python)"
    rm -rf "$venv"
    "$python" -m venv "$venv"
    "$venv/bin/pip" install --quiet --disable-pip-version-check \
      "dmgbuild==$DMGBUILD_VERSION"
  fi
  DMGBUILD="$venv/bin/dmgbuild"
  DMGBUILD_PYTHON="$venv/bin/python"
  echo "==> Using dmgbuild $DMGBUILD_VERSION from venv: $DMGBUILD"
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

# Mount the finished image read-only and check the window it will actually
# open with. A DMG whose background Finder cannot show still builds, still
# lays its icons out correctly and still uploads, so nothing else would notice.
VERIFY_MOUNT="$(mktemp -d "${TMPDIR:-/tmp}/hq-dmg-verify.XXXXXX")"
cleanup_verify_mount() {
  hdiutil detach "$VERIFY_MOUNT" -quiet >/dev/null 2>&1 || true
  rmdir "$VERIFY_MOUNT" 2>/dev/null || true
}
trap cleanup_verify_mount EXIT
hdiutil attach "$DMG_PATH" -readonly -nobrowse -noverify -noautoopen \
  -mountpoint "$VERIFY_MOUNT" -quiet
"$DMGBUILD_PYTHON" "$VERIFY_DS_STORE" "$VERIFY_MOUNT"
cleanup_verify_mount
trap - EXIT

DMG_SIZE=$(du -h "$DMG_PATH" | cut -f1)
echo "==> DMG created: $DMG_PATH ($DMG_SIZE)"
