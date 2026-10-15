#!/usr/bin/env bash
# Build the bundled hq-cli payload for one macOS arch.
#
#   bash scripts/build-bundled-hq-cli.sh <arm64|x64>
#
# Output: sidecar/hq-cli/bundle/darwin-<arch>/ (override the parent dir with
# HQ_CLI_BUNDLE_OUT). The tree holds the pinned hq-cli package with its
# production dependencies, the pinned Node runtime, and manifest.json.
# tauri.macos.conf.json ships the bundle dir as Contents/Resources/hq-cli/.
#
# The hq-cli and Node versions come from sidecar/hq-cli/pin.json only.
# node-llama-cpp (qmd's optional local-embedding engine) is replaced by an
# empty stub during install and then deleted, so it never ships. qmd loads it
# with a dynamic import, so the CLI still starts without it.
#
# Every failure exits non-zero: a version mismatch, a Node checksum mismatch,
# a symlink, a leftover node-llama-cpp, or a Mach-O file without the target arch.
set -euo pipefail

ARCH="${1:-}"
case "$ARCH" in
  arm64) MACHO_ARCH=arm64 ;;
  x64) MACHO_ARCH=x86_64 ;;
  *) echo "usage: build-bundled-hq-cli.sh <arm64|x64>" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HQ_CLI_DIR="$SYNC_DIR/sidecar/hq-cli"
PIN="$HQ_CLI_DIR/pin.json"
MANIFEST_TOOL="$SCRIPT_DIR/bundled-hq-cli-manifest.mjs"
OUT_ROOT="${HQ_CLI_BUNDLE_OUT:-$HQ_CLI_DIR/bundle}"
OUT="$OUT_ROOT/darwin-$ARCH"

pin_field() {
  node -e 'const p=require(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o&&o[k],p); if(typeof v!=="string"||!v){process.exit(1)} process.stdout.write(v)' "$PIN" "$1"
}
VERSION="$(pin_field version)" || { echo "pin.json has no version" >&2; exit 1; }
NODE_VERSION="$(pin_field node_version)" || { echo "pin.json has no node_version" >&2; exit 1; }
NODE_SHA256="$(pin_field "node_sha256.$ARCH")" || { echo "pin.json has no node_sha256.$ARCH" >&2; exit 1; }

echo "[bundled-hq-cli] building darwin-$ARCH: hq-cli $VERSION, node $NODE_VERSION"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hq-cli-bundle.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# 1. The pinned hq-cli package, as published.
(cd "$WORK" && npm pack "@indigoai-us/hq-cli@$VERSION" --silent >/dev/null)
CLI_TGZ="$WORK/indigoai-us-hq-cli-$VERSION.tgz"
[ -f "$CLI_TGZ" ] || { echo "npm pack did not produce $CLI_TGZ" >&2; exit 1; }
tar -xzf "$CLI_TGZ" -C "$WORK"
PKG="$WORK/package"

# 2. The node-llama-cpp stub, packed so npm copies it instead of linking it.
(cd "$HQ_CLI_DIR/node-llama-cpp-stub" && npm pack --pack-destination "$WORK" --silent >/dev/null)
STUB_TGZ="$WORK/node-llama-cpp-0.0.0-hq-bundle-stub.tgz"
[ -f "$STUB_TGZ" ] || { echo "stub pack did not produce $STUB_TGZ" >&2; exit 1; }

# 3. Production install for the target arch. Lifecycle scripts stay off; the
#    native modules that need a binary get their prebuilt one in step 4.
node -e '
const fs = require("fs");
const [pkgPath, stub, version] = process.argv.slice(1);
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
if (pkg.version !== version) { console.error(`packed version ${pkg.version} != pin ${version}`); process.exit(1); }
delete pkg.scripts;
delete pkg.devDependencies;
pkg.overrides = { ...(pkg.overrides || {}), "node-llama-cpp": `file:${stub}` };
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
' "$PKG/package.json" "$STUB_TGZ" "$VERSION"
(cd "$PKG" && npm install --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund \
  --no-package-lock --cpu="$ARCH" --os=darwin --loglevel=error)

# 4. better-sqlite3 prebuilt binaries for the pinned Node ABI and target arch.
#    qmd pins its own copy, so there can be more than one.
PREBUILD_INSTALL="$PKG/node_modules/prebuild-install/bin.js"
[ -f "$PREBUILD_INSTALL" ] || { echo "prebuild-install is missing from the install" >&2; exit 1; }
SQLITE_COUNT=0
while IFS= read -r sqlite_dir; do
  (cd "$sqlite_dir" && node "$PREBUILD_INSTALL" --arch="$ARCH" --platform=darwin \
    --runtime=node --target="${NODE_VERSION#v}" </dev/null)
  [ -f "$sqlite_dir/build/Release/better_sqlite3.node" ] || {
    echo "better-sqlite3 prebuild missing in $sqlite_dir" >&2; exit 1; }
  SQLITE_COUNT=$((SQLITE_COUNT + 1))
done < <(find "$PKG/node_modules" -type d -name better-sqlite3 -path '*/node_modules/better-sqlite3' -prune)
[ "$SQLITE_COUNT" -gt 0 ] || { echo "no better-sqlite3 found in the install" >&2; exit 1; }

# 5. Prune what never runs: the llama stub, npm's .bin symlinks, prebuilds for
#    other platforms, and C/C++ sources of the native modules.
find "$PKG/node_modules" -type d -name node-llama-cpp -prune -exec rm -rf {} +
find "$PKG/node_modules" -type d -name .bin -prune -exec rm -rf {} +
find "$PKG/node_modules" -type d -name package-lock.json -prune -exec rm -rf {} +
rm -f "$PKG/node_modules/.package-lock.json"
while IFS= read -r prebuilds; do
  for platform_dir in "$prebuilds"/*; do
    [ -e "$platform_dir" ] || continue
    [ "$(basename "$platform_dir")" = "darwin-$ARCH" ] || rm -rf "$platform_dir"
  done
done < <(find "$PKG/node_modules" -type d -name prebuilds -prune)
for native in "$PKG"/node_modules/tree-sitter-* "$PKG"/node_modules/better-sqlite3 \
  "$PKG"/node_modules/@tobilu/qmd/node_modules/better-sqlite3; do
  [ -d "$native" ] || continue
  find "$native" -type f \( -name '*.c' -o -name '*.cc' -o -name '*.cpp' -o -name '*.h' -o -name '*.hpp' \) -delete
  rm -rf "$native/deps" "$native/build/Release/obj" "$native/build/Release/.deps" "$native/build/Release/obj.target"
done
# Source maps and type declarations are never loaded at runtime; together they
# are about a fifth of the package tree. Dependency READMEs and changelogs go
# too. Other .md files stay: hq-cli ships runtime assets as markdown
# (package/assets/**.md).
find "$PKG" -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
  -o -name '*.tsbuildinfo' \) -delete
find "$PKG/node_modules" -type f \( -iname 'README*.md' -o -iname 'CHANGELOG*.md' -o -iname 'HISTORY*.md' \) -delete
find "$PKG/node_modules" -type d -empty -delete

# 6. Gates on the package tree.
if [ -n "$(find "$PKG" -type l -print -quit)" ]; then
  echo "symlinks remain in the bundle:" >&2; find "$PKG" -type l >&2; exit 1
fi
if [ -n "$(find "$PKG" -name 'node-llama-cpp*' -print -quit)" ]; then
  echo "node-llama-cpp remains in the bundle:" >&2; find "$PKG" -name 'node-llama-cpp*' >&2; exit 1
fi

# 7. The pinned Node runtime, checked against the pinned sha256.
NODE_DIST="node-$NODE_VERSION-darwin-$ARCH"
NODE_TGZ="$WORK/$NODE_DIST.tar.gz"
curl -fsSL --retry 3 --retry-delay 2 -o "$NODE_TGZ" \
  "https://nodejs.org/dist/$NODE_VERSION/$NODE_DIST.tar.gz" </dev/null
ACTUAL_SHA="$(shasum -a 256 "$NODE_TGZ" | awk '{print $1}')"
if [ "$ACTUAL_SHA" != "$NODE_SHA256" ]; then
  echo "Node checksum mismatch for $NODE_DIST: got $ACTUAL_SHA, pinned $NODE_SHA256" >&2
  exit 1
fi
tar -xzf "$NODE_TGZ" -C "$WORK" "$NODE_DIST/bin/node" "$NODE_DIST/LICENSE"

# 8. Assemble the arch dir.
STAGE="$WORK/darwin-$ARCH"
mkdir -p "$STAGE/node/bin"
mv "$PKG" "$STAGE/package"
mv "$WORK/$NODE_DIST/bin/node" "$STAGE/node/bin/node"
mv "$WORK/$NODE_DIST/LICENSE" "$STAGE/node/LICENSE"
chmod 755 "$STAGE/node/bin/node"

# Every Mach-O file must contain the target arch.
MACHO_COUNT=0
while IFS= read -r -d '' file; do
  if file -b "$file" | grep -q 'Mach-O'; then
    archs="$(lipo -archs "$file")"
    case " $archs " in
      *" $MACHO_ARCH "*) MACHO_COUNT=$((MACHO_COUNT + 1)) ;;
      *) echo "wrong-arch Mach-O ($archs, want $MACHO_ARCH): ${file#"$STAGE/"}" >&2; exit 1 ;;
    esac
  fi
done < <(find "$STAGE" -type f \( -name '*.node' -o -name '*.dylib' -o -path '*/node/bin/node' \) -print0)
echo "[bundled-hq-cli] $MACHO_COUNT Mach-O files, all $MACHO_ARCH"

node "$MANIFEST_TOOL" write "$STAGE" --version "$VERSION" --node-version "$NODE_VERSION" --arch "$ARCH"

# 9. Offline smoke check when this host can run the target arch: the bundled
#    Node runs the bundled CLI with a throwaway HOME and no registry.
HOST_ARCH="$(uname -m)"
RUNNER=()
if [ "$HOST_ARCH" = "$MACHO_ARCH" ]; then
  RUNNER=()
elif [ "$MACHO_ARCH" = x86_64 ] && arch -x86_64 /usr/bin/true 2>/dev/null; then
  RUNNER=(arch -x86_64)
else
  RUNNER=(unavailable)
fi
if [ "${RUNNER[0]:-}" != unavailable ]; then
  SMOKE_HOME="$WORK/smoke-home"
  mkdir -p "$SMOKE_HOME"
  BIN_TARGET="$(node -e 'process.stdout.write(require(process.argv[1]).bins.hq)' "$STAGE/manifest.json")"
  SMOKE_VERSION="$(env -i HOME="$SMOKE_HOME" PATH=/usr/bin:/bin npm_config_registry=http://127.0.0.1:9 \
    ${RUNNER[@]+"${RUNNER[@]}"} "$STAGE/node/bin/node" "$STAGE/package/$BIN_TARGET" --version </dev/null | tail -n 1)"
  case "$SMOKE_VERSION" in
    *"$VERSION"*) echo "[bundled-hq-cli] smoke: hq --version -> $SMOKE_VERSION" ;;
    *) echo "bundled hq --version printed '$SMOKE_VERSION', want $VERSION" >&2; exit 1 ;;
  esac
else
  echo "[bundled-hq-cli] smoke: host $HOST_ARCH cannot run $MACHO_ARCH; the release gate re-checks the manifest"
fi

# 10. Publish into the output slot.
mkdir -p "$OUT_ROOT"
rm -rf "$OUT"
mv "$STAGE" "$OUT"
node "$MANIFEST_TOOL" verify "$OUT" --version "$VERSION" --node-version "$NODE_VERSION" --arch "$ARCH"
echo "[bundled-hq-cli] wrote $OUT ($(du -sh "$OUT" | awk '{print $1}'))"
