#!/usr/bin/env bash
# Install (or remove) the nightly LaunchAgent for the install matrix.
#   bash workspace/e2e-mac/matrix/schedule/install.sh            # load nightly 03:30
#   bash workspace/e2e-mac/matrix/schedule/install.sh --remove
# Pair with `caffeinate`/an always-on host: the run needs ~2–4 h of wall clock.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; MATRIX_DIR="$(cd "$HERE/.." && pwd)"
source "$MATRIX_DIR/lib.sh" >/dev/null 2>&1 || true   # resolves HQ_ROOT
KEEPAWAKE=ai.indigo.hq-install-matrix-keepawake
LABEL=ai.indigo.hq-install-matrix; DST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [[ "${1:-}" == "--remove" ]]; then launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$DST"; launchctl bootout "gui/$(id -u)/$KEEPAWAKE" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/$KEEPAWAKE.plist"; echo "removed $LABEL + $KEEPAWAKE"; exit 0; fi
sed -e "s#__HQ_ROOT__#$HQ_ROOT#g" -e "s#__HOME__#$HOME#g" -e "s#__MATRIX_DIR__#$MATRIX_DIR#g" "$HERE/$LABEL.plist" >"$DST"
# Keep the host awake so a 03:30 run is not skipped by sleep (caffeinate -s, like the wargames agent).
cat >"$HOME/Library/LaunchAgents/$KEEPAWAKE.plist" <<EOP
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$KEEPAWAKE</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-s</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
EOP
launchctl bootout "gui/$(id -u)/$KEEPAWAKE" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$KEEPAWAKE.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DST"
echo "loaded $LABEL (nightly 03:30) — kick manually: launchctl kickstart gui/$(id -u)/$LABEL"
