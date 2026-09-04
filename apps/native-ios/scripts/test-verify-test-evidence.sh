#!/usr/bin/env bash
set -euo pipefail

script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture_root="$script_root/test-fixtures/strict-evidence"
verifier="$script_root/verify-test-evidence.sh"
required_tests="$fixture_root/required-tests.txt"
valid_summary="$(jq -c . "$fixture_root/summary-valid.json")"
valid_tests="$(jq -c . "$fixture_root/tests-valid.json")"
valid_devices="$(jq -c . "$fixture_root/simctl-valid.json")"

run_verifier() {
  local summary="$1"
  local tests="$2"
  local devices="$3"
  local manifest="${4:-$required_tests}"
  HQ_TEST_EVIDENCE_FIXTURE_MODE=1 \
  HQ_TEST_XCRESULT_SUMMARY_JSON="$summary" \
  HQ_TEST_XCRESULT_TESTS_JSON="$tests" \
  HQ_TEST_SIMCTL_DEVICES_JSON="$devices" \
    "$verifier" \
      --result-bundle "$fixture_root" \
      --expected-device "iPhone 17 Pro" \
      --required-tests "$manifest"
}

expect_failure() {
  local label="$1"
  local expected_diagnostic="$2"
  local summary="$3"
  local tests="$4"
  local devices="$5"
  local manifest="${6:-$required_tests}"
  local output
  local exit_code

  set +e
  output="$(run_verifier "$summary" "$tests" "$devices" "$manifest" 2>&1)"
  exit_code=$?
  set -e
  if [[ $exit_code -eq 0 ]]; then
    echo "Expected strict evidence verifier to reject: $label" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected_diagnostic"* ]]; then
    echo "Verifier rejected '$label' for the wrong reason." >&2
    echo "Expected diagnostic: $expected_diagnostic" >&2
    echo "Actual output: $output" >&2
    exit 1
  fi
}

run_verifier "$valid_summary" "$valid_tests" "$valid_devices" >/dev/null

missing_required_test="$(jq -c 'del(.testNodes[0].children[0].children[0].children[1])' "$fixture_root/tests-valid.json")"
missing_required_summary="$(jq -c '
  .passedTests = 1
  | .totalTestCount = 1
  | (.devicesAndConfigurations[].passedTests) = 1
' "$fixture_root/summary-valid.json")"
expect_failure \
  "missing required test ID" \
  "xcresult test nodes do not exactly match the required IDs." \
  "$missing_required_summary" \
  "$missing_required_test" \
  "$valid_devices"

extra_test="$(jq -c '.testNodes[0].children[0].children[0].children += [(.testNodes[0].children[0].children[0].children[0] | .nodeIdentifier = "UnexpectedTests/testUnexpected()" | .name = "testUnexpected()")]' "$fixture_root/tests-valid.json")"
extra_test_summary="$(jq -c '
  .passedTests = 3
  | .totalTestCount = 3
  | (.devicesAndConfigurations[].passedTests) = 3
' "$fixture_root/summary-valid.json")"
expect_failure \
  "unexpected extra test ID" \
  "xcresult test nodes do not exactly match the required IDs." \
  "$extra_test_summary" \
  "$extra_test" \
  "$valid_devices"

same_count_replacement="$(jq -c '
  .testNodes[0].children[0].children[0].children[1].nodeIdentifier = "UnexpectedTests/testReplacement()"
  | .testNodes[0].children[0].children[0].children[1].name = "testReplacement()"
' "$fixture_root/tests-valid.json")"
expect_failure \
  "same-count replacement test ID" \
  "xcresult test nodes do not exactly match the required IDs." \
  "$valid_summary" \
  "$same_count_replacement" \
  "$valid_devices"

one_configuration="$(jq -c '(.testNodes[0].children[0].children[0].children[].children) |= map(select(.name == "Smoke Local"))' "$fixture_root/tests-valid.json")"
one_configuration_summary="$(jq -c '
  .devicesAndConfigurations |= map(
    if .testPlanConfiguration.configurationName == "Fixture Visual Tour"
    then .passedTests = 0
    else .
    end
  )
' "$fixture_root/summary-valid.json")"
expect_failure \
  "required tests absent from one plan configuration" \
  "xcresult required test cases were not passed exactly once in both configurations." \
  "$one_configuration_summary" \
  "$one_configuration" \
  "$valid_devices"

duplicate_test="$(jq -c '.testNodes[0].children[0].children[0].children += [.testNodes[0].children[0].children[0].children[0]]' "$fixture_root/tests-valid.json")"
duplicate_test_summary="$(jq -c '
  .passedTests = 3
  | .totalTestCount = 3
  | (.devicesAndConfigurations[].passedTests) = 3
' "$fixture_root/summary-valid.json")"
expect_failure \
  "duplicate test-case ID" \
  "xcresult test nodes contain duplicate Test Case identifiers." \
  "$duplicate_test_summary" \
  "$duplicate_test" \
  "$valid_devices"

skipped_summary="$(jq -c '
  .passedTests = 1
  | .skippedTests = 1
  | (.devicesAndConfigurations[].passedTests) = 1
  | (.devicesAndConfigurations[].skippedTests) = 1
' "$fixture_root/summary-valid.json")"
skipped_tests="$(jq -c '
  .testNodes[0].children[0].children[0].children[1].result = "Skipped"
  | (.testNodes[0].children[0].children[0].children[1].children[].result) = "Skipped"
' "$fixture_root/tests-valid.json")"
expect_failure \
  "skipped test" \
  "xcresult summary contains failures, skips, or expected failures." \
  "$skipped_summary" \
  "$skipped_tests" \
  "$valid_devices"

expected_failure_summary="$(jq -c '
  .passedTests = 1
  | .expectedFailures = 1
  | (.devicesAndConfigurations[].passedTests) = 1
  | (.devicesAndConfigurations[].expectedFailures) = 1
' "$fixture_root/summary-valid.json")"
expected_failure_tests="$(jq -c '
  .testNodes[0].children[0].children[0].children[1].result = "Expected Failure"
  | (.testNodes[0].children[0].children[0].children[1].children[].result) = "Expected Failure"
' "$fixture_root/tests-valid.json")"
expect_failure \
  "expected failure" \
  "xcresult summary contains failures, skips, or expected failures." \
  "$expected_failure_summary" \
  "$expected_failure_tests" \
  "$valid_devices"

wrong_device_summary="$(jq -c '(.devicesAndConfigurations[].device.deviceName) = "iPhone 16"' "$fixture_root/summary-valid.json")"
expect_failure \
  "wrong simulator" \
  "xcresult summary is not an exact iPhone 17 Pro run in both required configurations." \
  "$wrong_device_summary" \
  "$valid_tests" \
  "$valid_devices"

unavailable_device="$(jq -c '(.devices[][] | select(.udid == "TEST-UDID")).isAvailable = false' "$fixture_root/simctl-valid.json")"
expect_failure \
  "unavailable simulator identity" \
  "xcresult simulator is not the exact available device requested" \
  "$valid_summary" \
  "$valid_tests" \
  "$unavailable_device"

expect_failure \
  "blank required-test manifest" \
  "Required-test manifest must contain at least one test identifier." \
  "$valid_summary" \
  "$valid_tests" \
  "$valid_devices" \
  "$fixture_root/manifest-blank.txt"

expect_failure \
  "malformed required-test manifest" \
  "Malformed required-test manifest entry" \
  "$valid_summary" \
  "$valid_tests" \
  "$valid_devices" \
  "$fixture_root/manifest-malformed.txt"

expect_failure \
  "duplicate required-test manifest entry" \
  "Required-test manifest contains duplicate identifiers." \
  "$valid_summary" \
  "$valid_tests" \
  "$valid_devices" \
  "$fixture_root/manifest-duplicate.txt"

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/hq-evidence-manifest.XXXXXX")"
unreadable_manifest="$temporary_root/required-tests.txt"
cp "$required_tests" "$unreadable_manifest"
chmod 000 "$unreadable_manifest"
expect_failure \
  "unreadable required-test manifest" \
  "Unreadable required-test manifest" \
  "$valid_summary" \
  "$valid_tests" \
  "$valid_devices" \
  "$unreadable_manifest"
chmod 600 "$unreadable_manifest"
rm -rf -- "$temporary_root"

# Invoked indirectly by the verifier's child Bash process.
# shellcheck disable=SC2329
xcrun() {
  echo "STRICT_EVIDENCE_LIVE_XCRUN_CALLED" >&2
  return 73
}
export -f xcrun
set +e
fixture_boundary_output="$(
  HQ_TEST_XCRESULT_SUMMARY_JSON="$valid_summary" \
  HQ_TEST_XCRESULT_TESTS_JSON="$valid_tests" \
  HQ_TEST_SIMCTL_DEVICES_JSON="$valid_devices" \
    "$verifier" \
      --result-bundle "$fixture_root" \
      --expected-device "iPhone 17 Pro" \
      --required-tests "$required_tests" \
      2>&1
)"
fixture_boundary_exit=$?
set -e
unset -f xcrun
if [[ $fixture_boundary_exit -eq 0 ||
      "$fixture_boundary_output" != *"STRICT_EVIDENCE_LIVE_XCRUN_CALLED"* ||
      "$fixture_boundary_output" != *"Failed to read xcresult summary using xcrun."* ]]; then
  echo "Fixture JSON was usable without explicit fixture-mode opt-in." >&2
  echo "Exit: $fixture_boundary_exit; output: $fixture_boundary_output" >&2
  exit 1
fi

echo "Strict xcresult evidence verifier tests passed."
