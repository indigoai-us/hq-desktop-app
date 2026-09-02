#!/usr/bin/env bash
# Wrap a GitHub Actions run-script with ::group:: + UTC date + elapsed seconds.
script=$1
start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
start_s=$(date +%s)
echo "::group::${start}"
set +e
bash --noprofile --norc -eo pipefail "$script"
status=$?
set -e
end=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "elapsed_seconds=$(( $(date +%s) - start_s )) end=${end}"
echo "::endgroup::"
exit "$status"
