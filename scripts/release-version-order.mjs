// Decides whether a released version should be stamped onto a branch.
//
// The release workflow syncs the tag's version back to main after publishing.
// Re-running an older tag — a retry of a historical release, or a hotfix tag
// pushed while a newer version already shipped — must never drag main
// backwards, so this compares the branch's current [product] version against
// the candidate and prints `proceed` or `skip`.
//
// Usage:
//   node scripts/release-version-order.mjs --versions-file versions.toml \
//     --candidate 0.10.96
//
// Prints `proceed` when the candidate is strictly newer than the current
// version, `skip` otherwise. Exits non-zero only on real errors (bad input,
// unreadable file), so the caller can distinguish "nothing to do" from
// "something is wrong".

import { readFileSync } from "node:fs";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(value) {
  const match = SEMVER.exec(String(value));

  if (!match) {
    throw new Error(`Not a semantic version: ${value}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export function readProductVersion(text) {
  const header = /^\[product\]\s*(?:#.*)?$/m.exec(text);

  if (!header) {
    throw new Error("versions.toml is missing [product]");
  }

  // Read only up to the next table header, so a `version` key in [updater] or
  // any later table can never be mistaken for the product version.
  const start = header.index + header[0].length;
  const nextTable = /^\[[^\]]+\]\s*(?:#.*)?$/m.exec(text.slice(start));
  const body = text.slice(start, nextTable ? start + nextTable.index : text.length);
  const version = /^version\s*=\s*"([^"]+)"/m.exec(body);

  if (!version) {
    throw new Error('versions.toml is missing [product] version = "..."');
  }

  return version[1];
}

/**
 * Returns a negative number when `a` precedes `b`, positive when it follows,
 * and 0 when they are equivalent. A release outranks a prerelease of the same
 * core version; prerelease identifiers compare by SemVer's dot-separated rules.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);

  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) {
      return left[field] - right[field];
    }
  }

  if (left.prerelease === right.prerelease) {
    return 0;
  }

  if (left.prerelease === null) {
    return 1;
  }

  if (right.prerelease === null) {
    return -1;
  }

  const leftParts = left.prerelease.split(".");
  const rightParts = right.prerelease.split(".");

  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i += 1) {
    const l = leftParts[i];
    const r = rightParts[i];

    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;

    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);

    if (lNumeric && rNumeric) return Number(l) - Number(r);
    if (lNumeric) return -1;
    if (rNumeric) return 1;

    return l < r ? -1 : 1;
  }

  return 0;
}

export function decide({ current, candidate }) {
  return compareVersions(candidate, current) > 0 ? "proceed" : "skip";
}

export function parseArgs(argv) {
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];

    if (arg === "--versions-file" || arg === "--candidate" || arg === "--current") {
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }

      options[arg.slice(2)] = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.candidate) {
    throw new Error("--candidate is required");
  }

  if (!options.current && !options["versions-file"]) {
    throw new Error("one of --current or --versions-file is required");
  }

  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const current =
    options.current ?? readProductVersion(readFileSync(options["versions-file"], "utf8"));

  const verdict = decide({ current, candidate: options.candidate });
  console.log(verdict);
  return verdict;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
