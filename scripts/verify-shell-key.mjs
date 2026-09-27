#!/usr/bin/env node
// Publish-time stale-shell check for the prebuilt-shell release pipeline
// (docs/RELEASE.md "Prebuilt shell"). Every assemble job writes the shell
// cache key it restored into the bundle as shell-key.txt. The publish job
// recomputes the key for each target from the tagged sources
// (scripts/shell-hash.mjs) and runs this script, which fails if any bundle's
// key is missing or differs, so a stale cached shell can never be published.
//
// Usage:
//   node scripts/verify-shell-key.mjs \
//     --check <label> <expected-key> <path-to-bundled-shell-key.txt> [--check ...]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const KEY = /^[0-9a-f]{64}$/;

/** Compare expected keys against the keys read from bundles.
 * @param {{label: string, expected: string, actual: string | null}[]} checks
 * @returns {{ok: boolean, errors: string[]}} */
export function compareShellKeys(checks) {
  const errors = [];
  if (checks.length === 0) {
    errors.push("no bundles were checked");
  }
  for (const { label, expected, actual } of checks) {
    const want = (expected ?? "").trim();
    const got = (actual ?? "").trim();
    if (!KEY.test(want)) {
      errors.push(`${label}: recomputed key "${want}" is not a 64-char hex key`);
    } else if (!got) {
      errors.push(`${label}: bundle has no shell-key.txt (or it is empty)`);
    } else if (got !== want) {
      errors.push(`${label}: bundled shell key ${got} does not match the key recomputed from the tag (${want})`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function parseArgs(argv) {
  const checks = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--check" || argv.length - i < 4) {
      throw new Error(`verify-shell-key: expected --check <label> <expected> <file>, got "${argv.slice(i).join(" ")}"`);
    }
    checks.push({ label: argv[i + 1], expected: argv[i + 2], file: argv[i + 3] });
    i += 3;
  }
  return checks;
}

function readKey(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    console.error(`verify-shell-key: cannot read ${file}: ${err.message}`);
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const checks = parseArgs(process.argv.slice(2)).map((c) => ({ ...c, actual: readKey(c.file) }));
  const { ok, errors } = compareShellKeys(checks);
  for (const error of errors) console.error(`::error::${error}`);
  if (!ok) process.exit(1);
  for (const c of checks) console.log(`${c.label}: bundled shell key matches the tagged sources (${c.expected.trim()})`);
}
