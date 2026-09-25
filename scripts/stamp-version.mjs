#!/usr/bin/env node
// Assemble-time version stamping for the prebuilt-shell release pipeline
// (docs/RELEASE.md "Prebuilt shell"). The compiled shell is version-agnostic
// (built once, cached, reused across releases); the real release version is
// written in at assemble time, after the shell is downloaded from cache and
// before signing.
//
// Writes:
//   - <bundleResources>/version.json  — {"version":"X.Y.Z"}, read at runtime by
//     crates/hq-desktop-core/src/runtime_version.rs::resolve_app_version(),
//     which the client-attribution headers, telemetry, and (pending) the
//     About dialog use instead of the compile-time APP_VERSION/
//     CARGO_PKG_VERSION constants.
//   - macOS Info.plist CFBundleShortVersionString / CFBundleVersion (via the
//     plist string patcher below — a real .plist patch, PlistBuddy-equivalent,
//     kept dependency-free so it also runs in a unit test without Xcode
//     tools installed).
//
// Windows exe version-resource stamping (rcedit) is NOT implemented in this
// script — see the PR description for why.
import { readFile, writeFile } from "node:fs/promises";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:beta|alpha|shelltest)\.(0|[1-9]\d*))?$/;

export function assertValidVersion(version) {
  if (!SEMVER.test(version)) {
    throw new Error(`stamp-version: "${version}" is not a valid app version`);
  }
  return version;
}

export function renderVersionJson(version) {
  assertValidVersion(version);
  return `${JSON.stringify({ version })}\n`;
}

/** Patch CFBundleShortVersionString and CFBundleVersion in an XML plist's
 * text, replacing the value immediately following each key. Deliberately a
 * plain string patch (not a full plist parser) so bundle formatting the
 * patch doesn't touch stays byte-identical elsewhere. */
export function patchInfoPlist(plistText, version) {
  assertValidVersion(version);
  const patchKey = (text, key) => {
    const re = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
    if (!re.test(text)) {
      throw new Error(`stamp-version: Info.plist has no <key>${key}</key> entry`);
    }
    return text.replace(re, `$1${version}$3`);
  };
  let out = patchKey(plistText, "CFBundleShortVersionString");
  out = patchKey(out, "CFBundleVersion");
  return out;
}

export async function stampBundle({ version, resourcesDir, infoPlistPath }) {
  assertValidVersion(version);
  await writeFile(`${resourcesDir}/version.json`, renderVersionJson(version), "utf8");
  if (infoPlistPath) {
    const original = await readFile(infoPlistPath, "utf8");
    await writeFile(infoPlistPath, patchInfoPlist(original, version), "utf8");
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version") out.version = argv[++i];
    else if (a === "--resources-dir") out.resourcesDir = argv[++i];
    else if (a === "--info-plist") out.infoPlistPath = argv[++i];
  }
  if (!out.version || !out.resourcesDir) {
    throw new Error("usage: stamp-version.mjs --version X.Y.Z --resources-dir <dir> [--info-plist <path>]");
  }
  return out;
}

export async function main(argv) {
  const args = parseArgs(argv);
  await stampBundle(args);
  console.log(`stamped ${args.version} into ${args.resourcesDir}${args.infoPlistPath ? ` and ${args.infoPlistPath}` : ""}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(String(err?.message ?? err));
      process.exit(1);
    },
  );
}
