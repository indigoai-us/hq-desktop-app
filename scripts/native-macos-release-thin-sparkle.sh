#!/usr/bin/env bash

set -euo pipefail

app_path="${1:?Usage: native-macos-release-thin-sparkle.sh /path/HQ.app SIGNING_IDENTITY}"
signing_identity="${2:?Usage: native-macos-release-thin-sparkle.sh /path/HQ.app SIGNING_IDENTITY}"
sparkle_framework="$app_path/Contents/Frameworks/Sparkle.framework"
sparkle_version="$sparkle_framework/Versions/B"

if [[ ! -d "$app_path" || "$(basename "$app_path")" != "HQ.app" ]]; then
  echo "error: Expected an existing HQ.app bundle." >&2
  exit 1
fi
if [[ ! -d "$sparkle_version" ]]; then
  echo "error: Expected the pinned Sparkle 2.9.2 Versions/B framework." >&2
  exit 1
fi

autoupdate="$sparkle_version/Autoupdate"
updater_app="$sparkle_version/Updater.app"
updater="$updater_app/Contents/MacOS/Updater"
downloader_xpc="$sparkle_version/XPCServices/Downloader.xpc"
downloader="$downloader_xpc/Contents/MacOS/Downloader"
installer_xpc="$sparkle_version/XPCServices/Installer.xpc"
installer="$installer_xpc/Contents/MacOS/Installer"
sparkle_binary="$sparkle_version/Sparkle"
sparkle_machos=(
  "$autoupdate"
  "$updater"
  "$downloader"
  "$installer"
  "$sparkle_binary"
)

for macho in "${sparkle_machos[@]}"; do
  if [[ ! -f "$macho" ]]; then
    echo "error: Missing pinned Sparkle runtime component: $macho" >&2
    exit 1
  fi
  description="$(/usr/bin/file -b "$macho")"
  if [[ "$description" != *"Mach-O"* ]]; then
    echo "error: Sparkle runtime component is not Mach-O: $macho" >&2
    exit 1
  fi
  architectures="$(/usr/bin/lipo -archs "$macho")"
  has_arm64=0
  for architecture in $architectures; do
    case "$architecture" in
      arm64)
        has_arm64=1
        ;;
      x86_64)
        ;;
      *)
        echo "error: Unexpected Sparkle architecture $architecture in $macho" >&2
        exit 1
        ;;
    esac
  done
  if [[ "$has_arm64" != "1" ]]; then
    echo "error: Sparkle runtime component has no arm64 slice: $macho" >&2
    exit 1
  fi
  if [[ "$architectures" != "arm64" ]]; then
    thin_path="${macho}.hq-arm64-thin"
    case "$thin_path" in
      "$sparkle_framework"/*) ;;
      *)
        echo "error: Refusing to thin an unresolved Sparkle path." >&2
        exit 1
        ;;
    esac
    /usr/bin/lipo -thin arm64 "$macho" -output "$thin_path"
    /bin/mv -f "$thin_path" "$macho"
  fi
  if [[ "$(/usr/bin/lipo -archs "$macho")" != "arm64" ]]; then
    echo "error: Sparkle runtime component is not arm64-only: $macho" >&2
    exit 1
  fi
done

timestamp_argument="--timestamp"
if [[ "${HQ_CODESIGN_TIMESTAMP:-}" == "none" ]]; then
  timestamp_argument="--timestamp=none"
fi

sign_component() {
  /usr/bin/codesign \
    --force \
    --sign "$signing_identity" \
    --options runtime \
    "$timestamp_argument" \
    --preserve-metadata=identifier,entitlements,requirements \
    "$1"
}

# Re-sign from the deepest nested code outward after lipo invalidates the
# archived signatures. Preserve Sparkle's own XPC/updater entitlements while
# keeping those capabilities out of the HQ host.
sign_component "$autoupdate"
sign_component "$updater_app"
sign_component "$downloader_xpc"
sign_component "$installer_xpc"
sign_component "$sparkle_framework"
sign_component "$app_path"

for macho in "${sparkle_machos[@]}"; do
  /usr/bin/codesign --verify --strict --verbose=2 "$macho"
done
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path"

echo "Thinned and re-signed Sparkle 2.9.2 for arm64."
