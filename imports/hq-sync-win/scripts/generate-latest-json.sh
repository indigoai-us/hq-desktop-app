#!/bin/bash
# Generate latest.json for the Tauri auto-updater (Windows fork).
# Usage:
#   ./scripts/generate-latest-json.sh \
#       <version> \
#       <x64-signature> <x64-url> \
#       [arm64-signature] [arm64-url] \
#       [output-path]
#
# Each per-arch (signature, url) pair points at the Tauri 2.10 NSIS
# updater artifact (`*-setup.exe`) that tauri-plugin-updater downloads +
# executes. The signature is the contents of `<installer>.sig` produced
# by Tauri's bundler when `TAURI_SIGNING_PRIVATE_KEY` is set — strict
# per-platform, no shared signature across bundles. (2.10 dropped the old
# `.nsis.zip`/`.msi.zip` wrapper; it signs the installer bytes directly.)
#
# The arm64 pair is OPTIONAL: pass empty strings ("" "") to emit an
# x86_64-only manifest. The current release matrix is x64-only (see the
# release.yml matrix comment re: the omitted arm64 leg).
#
# In CI, the "Generate latest.json" step in .github/workflows/release.yml
# invokes this from the matrix artefacts and attaches the result to the
# GitHub release. Run it by hand only for local testing.

set -euo pipefail

VERSION="${1:?Usage: generate-latest-json.sh <version> <x64-sig> <x64-url> [arm64-sig arm64-url] [output]}"
X64_SIGNATURE="${2:?Missing x64 signature argument}"
X64_DOWNLOAD_URL="${3:?Missing x64 download URL argument}"
ARM64_SIGNATURE="${4:-}"
ARM64_DOWNLOAD_URL="${5:-}"
OUTPUT="${6:-latest.json}"
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# x86_64 is always present; aarch64 is appended only when both its args are set.
PLATFORMS="    \"windows-x86_64\": {
      \"signature\": \"${X64_SIGNATURE}\",
      \"url\": \"${X64_DOWNLOAD_URL}\"
    }"
if [ -n "${ARM64_SIGNATURE}" ] && [ -n "${ARM64_DOWNLOAD_URL}" ]; then
  PLATFORMS="${PLATFORMS},
    \"windows-aarch64\": {
      \"signature\": \"${ARM64_SIGNATURE}\",
      \"url\": \"${ARM64_DOWNLOAD_URL}\"
    }"
fi

cat > "$OUTPUT" <<EOF
{
  "version": "${VERSION}",
  "notes": "See https://github.com/indigoai-us/hq-sync-win/releases/tag/v${VERSION}",
  "pub_date": "${PUB_DATE}",
  "platforms": {
${PLATFORMS}
  }
}
EOF

echo "Generated ${OUTPUT} for version ${VERSION}"
