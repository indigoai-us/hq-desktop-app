#!/bin/bash
# Generate latest.json for the Tauri auto-updater (Windows fork).
# Usage:
#   ./scripts/generate-latest-json.sh \
#       <version> \
#       <x64-signature> <x64-url> \
#       <arm64-signature> <arm64-url> \
#       [output-path]
#
# Each per-arch (signature, url) pair points at the Tauri MSI updater
# bundle (`*.msi.zip`) that tauri-plugin-updater downloads + executes.
# The signature is the contents of `<bundle>.sig` produced by Tauri's
# bundler when `TAURI_SIGNING_PRIVATE_KEY` is set — strict per-platform,
# no shared signature across bundles.
#
# In CI, the "Generate latest.json" step in .github/workflows/release.yml
# invokes this script from the matrix artefacts (x64 + arm64) and attaches
# the result to the GitHub release. Run it by hand only for local testing.

set -euo pipefail

VERSION="${1:?Usage: generate-latest-json.sh <version> <x64-sig> <x64-url> <arm64-sig> <arm64-url> [output]}"
X64_SIGNATURE="${2:?Missing x64 signature argument}"
X64_DOWNLOAD_URL="${3:?Missing x64 download URL argument}"
ARM64_SIGNATURE="${4:?Missing arm64 signature argument}"
ARM64_DOWNLOAD_URL="${5:?Missing arm64 download URL argument}"
OUTPUT="${6:-latest.json}"
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > "$OUTPUT" <<EOF
{
  "version": "${VERSION}",
  "notes": "See https://github.com/indigoai-us/hq-sync-win/releases/tag/v${VERSION}",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "windows-x86_64": {
      "signature": "${X64_SIGNATURE}",
      "url": "${X64_DOWNLOAD_URL}"
    },
    "windows-aarch64": {
      "signature": "${ARM64_SIGNATURE}",
      "url": "${ARM64_DOWNLOAD_URL}"
    }
  }
}
EOF

echo "Generated ${OUTPUT} for version ${VERSION}"
