#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ios_root="$repo_root/apps/native-ios"
evidence_root="$ios_root/Evidence"
visual_tour=false

if [[ "${1:-}" == "--visual-tour" ]]; then
  visual_tour=true
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--visual-tour]" >&2
  exit 64
fi

xcodegen generate --spec "$ios_root/project.yml" --project "$ios_root"

assert_mobile_info_contract() {
  local plist_path="$1"
  local source_label="$2"
  local scheme

  [[ -f "$plist_path" ]] || { echo "Missing $source_label Info.plist: $plist_path" >&2; exit 1; }
  scheme="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes:0:CFBundleURLSchemes:0' "$plist_path" 2>/dev/null || true)"
  [[ "$scheme" == "hqmobile" ]] || {
    echo "$source_label Info.plist does not register hqmobile://: $plist_path" >&2
    exit 1
  }
  /usr/libexec/PlistBuddy -c 'Print :UILaunchScreen' "$plist_path" >/dev/null 2>&1 || {
    echo "$source_label Info.plist does not declare UILaunchScreen: $plist_path" >&2
    exit 1
  }
}

# XcodeGen owns the checked-in plist. This assertion catches a project.yml
# regression immediately, before a stale generated project can mask it.
assert_mobile_info_contract "$ios_root/Config/HQIOS-Info.plist" "Generated source"

source_fingerprint() {
  {
    find "$ios_root/Sources" "$ios_root/Tests" "$ios_root/UITests" "$ios_root/Config" \
      "$ios_root/Contracts" "$ios_root/scripts" -type f -print
    printf '%s\n' "$ios_root/project.yml"
  } | LC_ALL=C sort | while IFS= read -r source_file; do
    shasum -a 256 "$source_file"
  done
}

verified_source_fingerprint="$(source_fingerprint)"

assert_source_unchanged() {
  local current_fingerprint
  current_fingerprint="$(source_fingerprint)"
  [[ "$current_fingerprint" == "$verified_source_fingerprint" ]] || {
    echo "Native iOS source changed during the evidence run; discard this mixed-state evidence and retry." >&2
    exit 1
  }
}

devices=("iPhone 17 Pro" "iPad Pro 11-inch (M5)")
for device in "${devices[@]}"; do
  safe_name="$(printf '%s' "$device" | tr ' ' '-' | tr -cd '[:alnum:]-')"
  device_udid="$(xcrun simctl list devices available --json | jq -r --arg device "$device" '.devices[][] | select(.name == $device and .isAvailable == true) | .udid' | head -n 1)"
  [[ -n "$device_udid" ]] || { echo "No available simulator named: $device" >&2; exit 1; }
  output_dir="$evidence_root/$safe_name"
  result_bundle="$output_dir/HQIOSSmoke.xcresult"
  attachments_dir="$output_dir/HQIOSSmoke.attachments"
  screenshot="$output_dir/HQIOSSmoke.png"
  mkdir -p "$output_dir"
  if [[ -e "$result_bundle" ]]; then
    archived_bundle="$output_dir/HQIOSSmoke-$(date -u +%Y%m%dT%H%M%SZ).xcresult"
    mv "$result_bundle" "$archived_bundle"
  fi
  if [[ -e "$attachments_dir" ]]; then
    archived_attachments="$output_dir/HQIOSSmoke-$(date -u +%Y%m%dT%H%M%SZ).attachments"
    mv "$attachments_dir" "$archived_attachments"
  fi

  xcrun simctl boot "$device_udid" 2>/dev/null || true
  xcrun simctl bootstatus "$device_udid" -b

  test_args=(
    -project "$ios_root/HQIOS.xcodeproj"
    -scheme HQIOS
    -destination "platform=iOS Simulator,id=$device_udid"
    -resultBundlePath "$result_bundle"
  )
  if [[ "$visual_tour" == true ]]; then
    test_args+=( -only-testing:HQIOSUITests/HQIOSSmokeUITests )
  fi
  xcodebuild "${test_args[@]}" test
  assert_source_unchanged

  app_container="$(xcrun simctl get_app_container "$device_udid" com.hqforwork.mobile app)"
  built_plist="$app_container/Info.plist"
  assert_mobile_info_contract "$built_plist" "Installed app"
  built_bundle_identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$built_plist")"
  [[ "$built_bundle_identifier" == "com.hqforwork.mobile" ]] || {
    echo "Installed app has unexpected bundle identifier: $built_bundle_identifier" >&2
    exit 1
  }

  xcrun xcresulttool export attachments \
    --path "$result_bundle" \
    --output-path "$attachments_dir" >/dev/null
  attachment_file="$(jq -r --arg device "$device" '
    [
      .[]
      | select(.testIdentifier == "HQIOSSmokeUITests/testSignedOutLaunchPublishesStableReadiness()")
      | .attachments[]
      | select(
          .configurationName == "Smoke Local"
          and .deviceName == $device
          and (.suggestedHumanReadableName | startswith("hq.screen.signed-out") and endswith(".ready"))
        )
      | .exportedFileName
    ]
    | if length == 1 then .[0] else empty end
  ' "$attachments_dir/manifest.json")"
  [[ -n "$attachment_file" && -s "$attachments_dir/$attachment_file" ]] || {
    echo "Expected one signed-out readiness screenshot attachment for $device" >&2
    exit 1
  }
  cp "$attachments_dir/$attachment_file" "$screenshot"
done

assert_source_unchanged
bash "$ios_root/scripts/verify-evidence.sh"
