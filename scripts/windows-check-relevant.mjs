// Decide whether a changed-file set needs the Windows check gate.
//
// `windows-check.yml` used to carry this list as a `paths:` filter on its
// `pull_request` trigger. That is the wrong mechanism for a REQUIRED check:
// GitHub leaves the required contexts of a path-filtered workflow permanently
// "Expected — Waiting for status to be reported" on any pull request that does
// not match, so the PR can never merge. A job that is skipped by a job-level
// `if:` reports Success instead, which is what branch protection needs.
//
// So the workflow now triggers on every pull request, and the two expensive
// windows-latest jobs are gated on this matcher. Nothing runs that did not run
// before; the difference is that irrelevant PRs get a green skip instead of an
// eternal pending.
//
// Usage: newline-separated changed paths on stdin; prints "true" or "false".
//
// Covered by scripts/windows-check-relevant.test.ts.

/**
 * Path patterns that require the Windows gate. These are the exact patterns the
 * workflow's `paths:` filter carried, and they must stay in sync with it — the
 * test asserts that.
 *
 * `**` matches any suffix; `*` matches within one segment.
 */
export const WINDOWS_RELEVANT_PATTERNS = [
  "apps/sync/**",
  "imports/hq-installer-react/**",
  "crates/**",
  "Cargo.toml",
  "Cargo.lock",
  "versions.toml",
  "scripts/release-*.mjs",
  "scripts/release-*.test.ts",
  "scripts/windows-msi-version.mjs",
  "scripts/windows-msi-version.test.ts",
  ".github/workflows/release.yml",
  ".github/workflows/windows-check.yml",
  "workspace/evidence/**",
];

/** Compile one GitHub-style path pattern to an anchored RegExp. */
function toRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

const MATCHERS = WINDOWS_RELEVANT_PATTERNS.map(toRegExp);

/**
 * True when any changed path needs the Windows gate.
 *
 * An EMPTY path list returns true, not false. An empty list means the diff
 * could not be determined (a broken base ref, a shallow clone, a force-push
 * mid-run), and silently skipping a required platform gate on unknown input
 * would let a Windows regression merge green. Unknown means run it.
 */
export function isWindowsRelevant(paths) {
  const cleaned = paths.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return true;
  }
  return cleaned.some((path) => MATCHERS.some((re) => re.test(path)));
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const paths = Buffer.concat(chunks).toString("utf8").split("\n");
  process.stdout.write(isWindowsRelevant(paths) ? "true" : "false");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
