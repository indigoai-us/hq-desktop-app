#!/usr/bin/env bash
#
# ci-local.sh — run what CI runs, locally, before you push.
#
# Why this exists: the checks CI runs live in six separate jobs in
# .github/workflows/ci.yml, and no single command ran them. Running the test
# suites and calling it green is the easy mistake — `pnpm test` and
# `pnpm typecheck` between them cover maybe a third of what gates a PR. A
# change can pass both and still fail on the release contract tests, the
# changelog-entry check, version lockstep, lint, a build, or the desktop E2E
# harness. Assembling the right set by hand every time is the thing this
# script exists to stop.
#
# Usage:
#   bash scripts/ci-local.sh              # everything (mirrors a full CI run)
#   bash scripts/ci-local.sh --fast       # skip builds, Rust, and E2E
#   bash scripts/ci-local.sh --list       # print the checks and exit
#
# Every check runs even if an earlier one fails, so one pass shows you the
# whole picture instead of one failure at a time. The exit code is non-zero if
# any check failed, and the summary names every failure.
#
# Jobs mirrored, by name in ci.yml:
#   frontend · workspace-packages · rust-macos · rust-linux
#   shell-boot-matrix · e2e-desktop-alt
#
# Two honest caveats. This runs on YOUR platform: the Windows jobs
# (windows-check.yml) cannot run here, and rust-macos on a Linux box is not the
# same job CI runs. And a green run here is evidence, not proof — CI remains
# the authority. It is the difference between "I ran the tests" and "I ran what
# CI runs", which is the gap this script closes.
#
# Known local-only reds, as of 2026-09-15. Each of these was reproduced on an
# untouched base commit, so seeing one does NOT mean your change broke it.
# Confirm it the same way before you spend time on it: check out the merge-base
# and run the same check there.
#   - work app build (desktop|web): fails resolving a transitive Node builtin
#     out of mqtt. CI installs on Node 22 with --no-frozen-lockfile and passes.
#   - cargo fmt: a local rustfmt newer than CI's reformats files CI accepts.
#     A base commit showed ~280 such diffs.
#   - release contract tests: the installer-E2E version test demands a stable
#     X.Y.Z, so it fails by design on a release branch stamped with a
#     prerelease version.
# If a check here goes red for a reason NOT in this list, treat it as yours.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

FAST=0
LIST=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --list) LIST=1 ;;
    -h|--help) sed -n '2,44p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

PASSED=()
FAILED=()
SKIPPED=()

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

# run <label> <slow|fast> <working-dir> <command...>
run() {
  local label="$1" tier="$2" dir="$3"; shift 3

  if [ "$tier" = "slow" ] && [ "$FAST" = "1" ]; then
    SKIPPED+=("$label")
    return 0
  fi
  if [ "$LIST" = "1" ]; then
    echo "  $label  (${tier})"
    return 0
  fi

  bold "── $label"
  if ( cd "$ROOT/$dir" && "$@" ); then
    PASSED+=("$label")
  else
    FAILED+=("$label")
    echo "✗ FAILED: $label"
  fi
}

[ "$LIST" = "1" ] && bold "Checks (slow ones are skipped by --fast):"

# ── frontend ────────────────────────────────────────────────────────────────
run "release contract tests"      fast .         pnpm test:scripts
run "changelog bullet tests"      fast .         node --test .github/scripts/release-changelog-bullets.test.mjs
run "app version lockstep"        fast .         pnpm version:check
run "@hq/ui typecheck"            fast .         pnpm --filter @hq/ui typecheck
run "@hq/ui tests"                fast .         pnpm --filter @hq/ui test
run "hq-sync typecheck"           fast apps/sync pnpm typecheck
run "hq-sync lint"                fast apps/sync pnpm lint
# CI runs `pnpm coverage`, not `pnpm test` -- same suite, but it also enforces
# the coverage reporters, so mirror the command CI actually runs.
run "hq-sync tests + coverage"    fast apps/sync pnpm coverage
run "hq-sync build"               slow apps/sync env SENTRY_AUTH_TOKEN= VITE_SENTRY_DSN= pnpm build

# The Playwright layout-regression suite is its own CI step and is easy to miss
# locally: it needs a build to serve and browsers installed. Skipping it is how
# a whole suite of specs pointed at deleted UI reached CI green-looking. The
# install is idempotent and quiet once the browsers are present.
run "browser install (chromium+webkit)" slow apps/sync \
  pnpm exec playwright install chromium webkit
run "browser E2E (chromium+webkit)"     slow apps/sync pnpm test:e2e:browser

run "work app typecheck"          fast apps/work pnpm typecheck
run "work app lint"               fast apps/work pnpm lint
run "work app tests"              fast apps/work pnpm test
# Two builds off one tree: the desktop target and the web target share
# SvelteKit output directories, so CI wipes them in between. Same order here.
run "work app build (desktop)"    slow apps/work env TAURI=1 pnpm build
run "work app build (web)"        slow .         bash -c \
  'rm -rf apps/work/.svelte-kit/output apps/work/build && cd apps/work && pnpm build'

# ── workspace-packages ──────────────────────────────────────────────────────
run "workspace package tests"     fast .         pnpm turbo run test --force \
  --filter=@hq/auth --filter=@hq/core --filter=@hq/platform

# ── rust ────────────────────────────────────────────────────────────────────
# The app crate's build script bundles the recall sidecar as a Tauri resource,
# so cargo cannot even check the crate until that directory exists. CI's
# rust-macos job installs it first; a fresh worktree does not have it, and the
# resulting failure ("resource path ... doesn't exist") names the sidecar
# rather than the build step that was skipped.
run "sidecar install"             slow apps/sync            pnpm run sidecar:install
run "cargo fmt (workspace)"       fast .                    cargo fmt --check
run "cargo fmt (src-tauri)"       fast apps/sync/src-tauri  cargo fmt --check
run "cargo test (core crates)"    slow .                    cargo test -p hq-desktop-core -p hq-telemetry --locked
run "cargo test (app)"            slow apps/sync/src-tauri  cargo test --locked

# ── shell-boot-matrix + e2e ─────────────────────────────────────────────────
run "shell boot persona matrix"   slow apps/sync pnpm exec vitest run __tests__/stories/shell-boot-persona-matrix.test.ts
run "desktop-alt E2E"             slow apps/sync pnpm test:e2e:desktop-alt

[ "$LIST" = "1" ] && exit 0

# ── summary ─────────────────────────────────────────────────────────────────
echo
bold "═══ summary ═══"
echo "passed:  ${#PASSED[@]}"
[ "${#SKIPPED[@]}" -gt 0 ] && echo "skipped: ${#SKIPPED[@]} (--fast)"

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "failed:  ${#FAILED[@]}"
  for f in "${FAILED[@]}"; do echo "  ✗ $f"; done
  echo
  echo "Not ready to push. Fix these, then re-run."
  exit 1
fi

if [ "$FAST" = "1" ]; then
  echo
  echo "Fast checks pass. Run without --fast before you push — builds, Rust,"
  echo "and E2E are where the slow failures hide."
  exit 0
fi

echo
echo "All local checks pass. Windows jobs still run only in CI."
