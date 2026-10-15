#!/usr/bin/env bash
# Check sidecar/hq-cli/pin.json, the single source of the bundled hq-cli and
# Node versions (US-006).
#
#   bash scripts/check-bundled-hq-cli-pin.sh
#
# Fails when pin.json is malformed (version not semver, node_version not
# v-prefixed semver, a node_sha256 entry that is not 64 lowercase hex), or when
# the build script or release workflow stops reading the pin and carries its
# own version literal instead.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$SYNC_DIR/../.." && pwd)"
PIN="${HQ_CLI_PIN:-$SYNC_DIR/sidecar/hq-cli/pin.json}"
BUILD="$SCRIPT_DIR/build-bundled-hq-cli.sh"
RELEASE="${HQ_CLI_RELEASE_WORKFLOW:-$REPO_DIR/.github/workflows/release.yml}"

fail() { echo "bundled hq-cli pin check: $*" >&2; exit 1; }

[ -f "$PIN" ] || fail "missing $PIN"

node - "$PIN" <<'EOF' || exit 1
const fs = require('fs');
const path = process.argv[2];
let pin;
try {
  pin = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch (error) {
  console.error(`bundled hq-cli pin check: ${path} is not JSON: ${error.message}`);
  process.exit(1);
}
const semver = /^\d+\.\d+\.\d+$/;
const problems = [];
if (typeof pin.version !== 'string' || !semver.test(pin.version)) {
  problems.push(`version must be an exact semver, got ${JSON.stringify(pin.version)}`);
}
if (typeof pin.node_version !== 'string' || !/^v\d+\.\d+\.\d+$/.test(pin.node_version)) {
  problems.push(`node_version must look like v22.17.0, got ${JSON.stringify(pin.node_version)}`);
}
const sha = pin.node_sha256 || {};
for (const arch of ['arm64', 'x64']) {
  if (typeof sha[arch] !== 'string' || !/^[0-9a-f]{64}$/.test(sha[arch])) {
    problems.push(`node_sha256.${arch} must be 64 lowercase hex characters`);
  }
}
const extra = Object.keys(sha).filter((arch) => arch !== 'arm64' && arch !== 'x64');
if (extra.length) problems.push(`node_sha256 has unexpected arches: ${extra.join(', ')}`);
if (problems.length) {
  for (const p of problems) console.error(`bundled hq-cli pin check: ${p}`);
  process.exit(1);
}
console.log(`bundled hq-cli pin: hq-cli ${pin.version}, node ${pin.node_version}`);
EOF

grep -q 'pin.json' "$BUILD" || fail "build-bundled-hq-cli.sh no longer reads pin.json"
grep -q 'pin_field version' "$BUILD" || fail "build-bundled-hq-cli.sh no longer takes the hq-cli version from pin.json"
grep -q 'pin_field node_version' "$BUILD" || fail "build-bundled-hq-cli.sh no longer takes the Node version from pin.json"

if [ -f "$RELEASE" ]; then
  grep -q 'check-bundled-hq-cli-pin.sh' "$RELEASE" || fail "release.yml does not run this pin check"
  grep -q 'build-bundled-hq-cli.sh arm64' "$RELEASE" || fail "release.yml does not build the arm64 bundle"
  grep -q 'build-bundled-hq-cli.sh x64' "$RELEASE" || fail "release.yml does not build the x64 bundle"
  grep -q 'sidecar/hq-cli/pin.json' "$RELEASE" || fail "release.yml does not read sidecar/hq-cli/pin.json"
fi

echo "bundled hq-cli pin check: ok"
