#!/usr/bin/env bash
set -euo pipefail

script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: $0 --result-bundle PATH --expected-device NAME --required-tests FILE" >&2
  exit 64
}

result_bundle=""
expected_device=""
required_tests_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --result-bundle)
      [[ $# -ge 2 ]] || usage
      result_bundle="$2"
      shift 2
      ;;
    --expected-device)
      [[ $# -ge 2 ]] || usage
      expected_device="$2"
      shift 2
      ;;
    --required-tests)
      [[ $# -ge 2 ]] || usage
      required_tests_file="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ -n "$result_bundle" && -n "$expected_device" && -n "$required_tests_file" ]] || usage
[[ -d "$result_bundle" ]] || { echo "Missing result bundle: $result_bundle" >&2; exit 1; }
[[ -e "$required_tests_file" ]] || { echo "Missing required-test manifest: $required_tests_file" >&2; exit 1; }
[[ -f "$required_tests_file" ]] || { echo "Required-test manifest is not a regular file: $required_tests_file" >&2; exit 1; }
[[ -r "$required_tests_file" ]] || { echo "Unreadable required-test manifest: $required_tests_file" >&2; exit 1; }

expected_configurations='["Fixture Visual Tour","Smoke Local"]'
required_tests_json="$(jq -Rsc '
  split("\n")
  | map(gsub("^[[:space:]]+|[[:space:]]+$"; ""))
  | map(select(length > 0 and (startswith("#") | not)))
' "$required_tests_file")"
required_count="$(jq 'length' <<<"$required_tests_json")"
if [[ "$required_count" -eq 0 ]]; then
  echo "Required-test manifest must contain at least one test identifier." >&2
  exit 1
fi
jq -e 'all(.[]; test("^[A-Za-z_][A-Za-z0-9_]*/test[A-Za-z0-9_]+$"))' \
  <<<"$required_tests_json" >/dev/null || {
    echo "Malformed required-test manifest entry; expected Suite/testMethod without parentheses." >&2
    exit 1
  }
jq -e 'length == (unique | length)' <<<"$required_tests_json" >/dev/null || {
  echo "Required-test manifest contains duplicate identifiers." >&2
  exit 1
}

fixture_mode="${HQ_TEST_EVIDENCE_FIXTURE_MODE:-0}"
if [[ "$fixture_mode" == 1 ]]; then
  resolved_result_bundle="$(cd "$result_bundle" && pwd -P)"
  case "$resolved_result_bundle/" in
    "$script_root/test-fixtures/"*) ;;
    *) echo "Fixture mode is restricted to checked-in verifier fixtures." >&2; exit 1 ;;
  esac
  [[ -n "${HQ_TEST_XCRESULT_SUMMARY_JSON:-}" &&
     -n "${HQ_TEST_XCRESULT_TESTS_JSON:-}" &&
     -n "${HQ_TEST_SIMCTL_DEVICES_JSON:-}" ]] || {
    echo "Fixture mode requires summary, test-node, and simulator JSON." >&2
    exit 1
  }
  summary="$HQ_TEST_XCRESULT_SUMMARY_JSON"
  tests="$HQ_TEST_XCRESULT_TESTS_JSON"
else
  if ! summary="$(xcrun xcresulttool get test-results summary --path "$result_bundle" --compact)"; then
    echo "Failed to read xcresult summary using xcrun." >&2
    exit 1
  fi
  if ! tests="$(xcrun xcresulttool get test-results tests --path "$result_bundle" --compact)"; then
    echo "Failed to read xcresult test nodes using xcrun." >&2
    exit 1
  fi
fi

jq -e \
  '
    .result == "Passed"
    and .failedTests == 0
    and .skippedTests == 0
    and .expectedFailures == 0
    and all(
      .devicesAndConfigurations[];
      .failedTests == 0
      and .skippedTests == 0
      and .expectedFailures == 0
    )
  ' <<<"$summary" >/dev/null || {
  echo "xcresult summary contains failures, skips, or expected failures." >&2
  exit 1
}

jq -e '
  [
    .testNodes[]?
    | recurse(.children[]?)
    | select(.nodeType == "Test Case")
    | (.nodeIdentifier | sub("\\(\\)$"; ""))
  ]
  | length == (unique | length)
' <<<"$tests" >/dev/null || {
  echo "xcresult test nodes contain duplicate Test Case identifiers." >&2
  exit 1
}

jq -e \
  --argjson required_tests "$required_tests_json" '
    [
      .testNodes[]?
      | recurse(.children[]?)
      | select(.nodeType == "Test Case")
      | (.nodeIdentifier | sub("\\(\\)$"; ""))
    ]
    | sort == ($required_tests | sort)
  ' <<<"$tests" >/dev/null || {
  echo "xcresult test nodes do not exactly match the required IDs." >&2
  exit 1
}

jq -e \
  --argjson expected_configurations "$expected_configurations" '
    [
      .testNodes[]?
      | recurse(.children[]?)
      | select(.nodeType == "Test Case")
      | {
          identifier: (.nodeIdentifier | sub("\\(\\)$"; "")),
          result,
          configurations: [
            .children[]?
            | select(.nodeType == "Test Plan Configuration")
            | {name, result}
          ]
        }
    ] as $cases
    | all(
        $cases[];
        .result == "Passed"
        and (.configurations | length) == 2
        and ([.configurations[].name] | unique | sort) == $expected_configurations
        and all(.configurations[]; .result == "Passed")
      )
  ' <<<"$tests" >/dev/null || {
  echo "xcresult required test cases were not passed exactly once in both configurations." >&2
  exit 1
}

jq -e \
  --arg expected_device "$expected_device" \
  --argjson expected_configurations "$expected_configurations" \
  --argjson required_count "$required_count" '
    .totalTestCount == $required_count
    and .passedTests == $required_count
    and (.devicesAndConfigurations | length) == 2
    and all(
      .devicesAndConfigurations[];
      .device.deviceName == $expected_device
      and .device.modelName == $expected_device
      and .device.platform == "iOS Simulator"
      and (.device.deviceId | type == "string" and length > 0)
      and .passedTests == $required_count
    )
    and (
      [.devicesAndConfigurations[].testPlanConfiguration.configurationName] | unique | sort
    ) == $expected_configurations
    and ([.devicesAndConfigurations[].device.deviceId] | unique | length) == 1
  ' <<<"$summary" >/dev/null || {
  echo "xcresult summary is not an exact $expected_device run in both required configurations." >&2
  exit 1
}

result_udid="$(jq -r '[.devicesAndConfigurations[].device.deviceId] | unique | .[0]' <<<"$summary")"
if [[ "$fixture_mode" == 1 ]]; then
  devices="$HQ_TEST_SIMCTL_DEVICES_JSON"
else
  devices="$(xcrun simctl list devices available --json)"
fi
jq -e \
  --arg expected_device "$expected_device" \
  --arg result_udid "$result_udid" '
    any(.devices[][]; .udid == $result_udid and .name == $expected_device and .isAvailable == true)
  ' <<<"$devices" >/dev/null || {
  echo "xcresult simulator is not the exact available device requested: $expected_device ($result_udid)" >&2
  exit 1
}

echo "Verified $required_count exact tests on $expected_device in both configurations with zero failures, skips, or expected failures."
