#!/usr/bin/env node
// Windows exe version-resource stamping for the prebuilt-shell release
// pipeline (docs/RELEASE.md "Prebuilt shell"). rcedit rewrites the file's own
// Win32 VERSIONINFO resource (what Explorer/Task Manager/the MSI installer
// show); the shell was compiled version-agnostic, so this must happen here,
// after the cached shell is restored and before signing.
//
// `rcedit` on npm is a library only — it has no `bin` entry, so
// `npx --yes rcedit@2 ...` can never resolve an executable ("npm error could
// not determine executable to run"). It also has no CLI flag surface
// (--set-file-version etc.); the real API is `rcedit(exePath, options)` with
// options keyed by `file-version` / `product-version` / `version-string`.
// This script calls that API directly; rcedit is a devDependency (see
// package.json) so plain `require`/`import` resolution finds it without npx.
import rcedit from "rcedit";

function numericFromVersion(releaseVersion) {
  const base = releaseVersion.split("-")[0].split(".");
  while (base.length < 4) base.push("0");
  return base.slice(0, 4).join(".");
}

async function main() {
  const exe = process.argv[2];
  const releaseVersion = process.env.RELEASE_VERSION;
  if (!exe) {
    throw new Error("stamp-exe-version: missing <exe-path> argument");
  }
  if (!releaseVersion) {
    throw new Error("stamp-exe-version: RELEASE_VERSION is not set");
  }

  const numeric = numericFromVersion(releaseVersion);
  await rcedit(exe, {
    "file-version": numeric,
    "product-version": numeric,
    "version-string": {
      FileVersion: releaseVersion,
      ProductVersion: releaseVersion,
    },
  });
  console.log(`Stamped ${exe} with ${releaseVersion} (${numeric})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
