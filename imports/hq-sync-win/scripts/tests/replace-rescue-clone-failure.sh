#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/replace-rescue.sh"
TEST_ROOT="$(mktemp -d -t hq-rescue-clone-test-XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAKE_BIN="$TEST_ROOT/bin"
HQ_ROOT="$TEST_ROOT/hq"
mkdir -p "$FAKE_BIN" "$HQ_ROOT/core" "$HQ_ROOT/companies" "$HQ_ROOT/personal"
REAL_GIT="$(command -v git)"
TOKEN="sc013-test-token-do-not-leak"

cat > "$FAKE_BIN/git" <<'FAKE_GIT'
#!/bin/sh
if [ "${1:-}" = "clone" ]; then
  printf '%s\n' "${FAKE_GIT_STDERR:-fatal: synthetic clone failure}" >&2
  exit 128
fi
exec "$REAL_GIT" "$@"
FAKE_GIT
chmod +x "$FAKE_BIN/git"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_class() {
  local expected="$1"
  local diagnostic="$2"
  local output status

  if output="$(PATH="$FAKE_BIN:$PATH" REAL_GIT="$REAL_GIT" GH_TOKEN="$TOKEN" \
      FAKE_GIT_STDERR="$diagnostic" bash "$SCRIPT" --hq-root "$HQ_ROOT" --dry-run --yes 2>&1)"; then
    fail "clone fixture for $expected unexpectedly succeeded"
  else
    status=$?
  fi

  [ "$status" -eq 5 ] || fail "clone fixture for $expected exited $status, expected 5"
  case "$output" in
    *"HQ_RESCUE_CLONE_FAILURE_CLASS=$expected"*) ;;
    *) fail "missing clone failure class $expected; output was: $output" ;;
  esac
  case "$output" in
    *"$TOKEN"*|*"x-access-token:$TOKEN@"*|*"Bearer $TOKEN"*)
      fail "clone credentials leaked for class $expected"
      ;;
  esac
}

assert_class network \
  "fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/indigoai-us/hq-core.git': Could not resolve host: github.com"
assert_class auth "fatal: Authentication failed for 'https://github.com/indigoai-us/hq-core.git'"
assert_class filter_unsupported "fatal: filter 'blob:none' is not supported by this server"
assert_class path "error: unable to create file core/docs/a-very-long-file: Filename too long"
assert_class exists "fatal: destination path 'src' already exists and is not an empty directory"
assert_class unknown "fatal: remote returned an unclassified response"

printf 'PASS: clone failure classes are bounded and credentials stay out of output\n'
