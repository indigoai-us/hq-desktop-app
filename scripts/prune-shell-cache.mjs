#!/usr/bin/env node
// Keep-last-N cleanup for the rolling `shell-cache` prerelease (docs/RELEASE.md
// "Prebuilt shell"). Each shell job uploads shell-<target>-<key>.<ext> there;
// without pruning the release grows by one asset per shell-key change. At the
// end of each shell job this selects that target's assets beyond the newest N
// (default 6) for deletion. The key the job just used is always kept, and
// assets for other targets or with unrecognised names are never touched.
//
// Usage:
//   gh api repos/<owner>/<repo>/releases/tags/shell-cache --jq .assets |
//     node scripts/prune-shell-cache.mjs --target windows-x64 --keep 6 --protect <key>
// Prints one asset name per line to delete.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const TARGETS = ["macos", "windows-x64", "windows-arm64"];
const ASSET = /^shell-(macos|windows-x64|windows-arm64)-([0-9a-f]{64})\.(tar\.gz|tar)$/;

export function parseAssetName(name) {
  const m = ASSET.exec(name);
  return m ? { target: m[1], key: m[2] } : null;
}

/** @param {{name: string, created_at?: string, updated_at?: string}[]} assets */
export function selectAssetsToDelete(assets, { target, keep = 6, protectKey = "" }) {
  if (!TARGETS.includes(target)) {
    throw new Error(`prune-shell-cache: unknown target "${target}"`);
  }
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`prune-shell-cache: keep must be a positive integer, got ${keep}`);
  }
  const stamp = (a) => Date.parse(a.updated_at ?? a.created_at ?? "") || 0;
  const mine = assets
    .map((a) => ({ asset: a, parsed: parseAssetName(a.name) }))
    .filter(({ parsed }) => parsed?.target === target)
    .sort((a, b) => stamp(b.asset) - stamp(a.asset) || a.asset.name.localeCompare(b.asset.name));
  const kept = new Set(mine.slice(0, keep).map(({ asset }) => asset.name));
  return mine
    .filter(({ asset, parsed }) => !kept.has(asset.name) && parsed.key !== protectKey)
    .map(({ asset }) => asset.name);
}

function parseArgs(argv) {
  const opts = { target: "", keep: 6, protectKey: "" };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`prune-shell-cache: ${flag} needs a value`);
    if (flag === "--target") opts.target = value;
    else if (flag === "--keep") opts.keep = Number(value);
    else if (flag === "--protect") opts.protectKey = value;
    else throw new Error(`prune-shell-cache: unknown flag ${flag}`);
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const assets = JSON.parse(readFileSync(0, "utf8") || "[]");
  for (const name of selectAssetsToDelete(assets, parseArgs(process.argv.slice(2)))) {
    console.log(name);
  }
}
