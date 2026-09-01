#!/usr/bin/env bash
#
# render-background.sh — Render background.html into background.tiff.
#
# The disk-image background must be sharp on Retina, so it ships as a
# multi-representation TIFF holding both a 720x470 @1x page and a 1440x940 @2x
# page. Finder picks the representation that matches the display.
#
# This is a build-time authoring tool, not part of the release. background.tiff
# is committed; re-run this only when the artwork changes, then commit the
# result. It needs Google Chrome and a network connection (the page pulls
# Fraunces and Geist from Google Fonts).
#
# Usage:
#   ./render-background.sh

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [ ! -x "$CHROME" ]; then
  echo "Error: Chrome not found at '$CHROME'. Set CHROME to override." >&2
  exit 1
fi

WIDTH=720
HEIGHT=470
WORK="$(mktemp -d -t dmg-background-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

render() {
  local scale="$1" out="$2"
  "$CHROME" \
    --headless=new \
    --disable-gpu \
    --hide-scrollbars \
    --default-background-color=00000000 \
    --force-device-scale-factor="$scale" \
    --window-size="${WIDTH},${HEIGHT}" \
    --virtual-time-budget=8000 \
    --screenshot="$out" \
    "file://$DIR/background.html" >/dev/null 2>&1
  [ -f "$out" ] || { echo "Error: Chrome produced no screenshot at ${scale}x" >&2; exit 1; }
}

echo "==> Rendering @1x (${WIDTH}x${HEIGHT})..."
render 1 "$WORK/background.png"
echo "==> Rendering @2x ($((WIDTH * 2))x$((HEIGHT * 2)))..."
render 2 "$WORK/background@2x.png"

# tiffutil -cathidpicheck verifies the second page is exactly twice the first
# before packing them, so a mis-sized render fails here rather than shipping.
echo "==> Packing background.tiff..."
tiffutil -cathidpicheck "$WORK/background.png" "$WORK/background@2x.png" \
  -out "$DIR/background.tiff" >/dev/null

echo "==> Wrote $DIR/background.tiff ($(du -h "$DIR/background.tiff" | cut -f1))"
