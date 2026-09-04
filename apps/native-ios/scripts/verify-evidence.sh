#!/usr/bin/env bash
set -euo pipefail

ios_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
evidence_root="$ios_root/Evidence"
device_contracts=(
  "iPhone-17-Pro|iPhone 17 Pro"
  "iPad-Pro-11-inch-M5|iPad Pro 11-inch (M5)"
)

for device_contract in "${device_contracts[@]}"; do
  device_dir="${device_contract%%|*}"
  expected_device="${device_contract#*|}"
  result_bundle="$evidence_root/$device_dir/HQIOSSmoke.xcresult"
  attachments_dir="$evidence_root/$device_dir/HQIOSSmoke.attachments"
  screenshot="$evidence_root/$device_dir/HQIOSSmoke.png"
  [[ -d "$result_bundle" ]] || { echo "Missing result bundle: $result_bundle" >&2; exit 1; }
  [[ -f "$attachments_dir/manifest.json" ]] || { echo "Missing attachment manifest: $attachments_dir/manifest.json" >&2; exit 1; }
  [[ -s "$screenshot" ]] || { echo "Missing screenshot: $screenshot" >&2; exit 1; }

  summary="$(xcrun xcresulttool get test-results summary --path "$result_bundle" --compact)"
  jq -e --arg expected_device "$expected_device" '
    .result == "Passed"
    and .failedTests == 0
    and .totalTestCount > 0
    and (.devicesAndConfigurations | length > 0)
    and all(
      .devicesAndConfigurations[];
      .device.deviceName == $expected_device
      and .device.modelName == $expected_device
      and .device.platform == "iOS Simulator"
      and (.device.deviceId | length > 0)
    )
    and (
      [.devicesAndConfigurations[].testPlanConfiguration.configurationName] | unique | sort
    ) == ["Fixture Visual Tour", "Smoke Local"]
    and ([.devicesAndConfigurations[].device.deviceId] | unique | length) == 1
  ' <<<"$summary" >/dev/null || {
    echo "xcresult did not pass on exactly the expected $expected_device default-plan configurations" >&2
    exit 1
  }

  result_udid="$(jq -r '[.devicesAndConfigurations[].device.deviceId] | unique | .[0]' <<<"$summary")"
  xcrun simctl list devices available --json | jq -e \
    --arg expected_device "$expected_device" \
    --arg result_udid "$result_udid" \
    'any(.devices[][]; .udid == $result_udid and .name == $expected_device and .isAvailable == true)' \
    >/dev/null || {
      echo "xcresult simulator is not the exact available device requested: $expected_device ($result_udid)" >&2
      exit 1
    }

  attachment_file="$(jq -r --arg expected_device "$expected_device" '
    [
      .[]
      | select(.testIdentifier == "HQIOSSmokeUITests/testSignedOutLaunchPublishesStableReadiness()")
      | .attachments[]
      | select(
          .configurationName == "Smoke Local"
          and .deviceName == $expected_device
          and .isAssociatedWithFailure == false
          and (.suggestedHumanReadableName | startswith("hq.screen.signed-out") and endswith(".ready"))
        )
      | .exportedFileName
    ]
    | if length == 1 then .[0] else empty end
  ' "$attachments_dir/manifest.json")"
  [[ -n "$attachment_file" && -s "$attachments_dir/$attachment_file" ]] || {
    echo "Missing unique passed readiness attachment for $expected_device" >&2
    exit 1
  }
  cmp -s "$attachments_dir/$attachment_file" "$screenshot" || {
    echo "Screenshot is not the verified HQ readiness attachment: $screenshot" >&2
    exit 1
  }

  width="$(sips -g pixelWidth "$screenshot" | awk '/pixelWidth/ { print $2 }')"
  height="$(sips -g pixelHeight "$screenshot" | awk '/pixelHeight/ { print $2 }')"
  [[ "${width:-0}" -gt 1 && "${height:-0}" -gt 1 ]] || {
    echo "Blank screenshot: $screenshot" >&2
    exit 1
  }
done

echo "Verified passed iPhone and iPad xcresults on exact simulators with signed-out HQ readiness screenshots."
