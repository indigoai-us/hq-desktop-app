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
 * Path patterns that require the Windows gate.
 *
 * The old `apps/sync/**` entry ran the two Windows jobs (40-80 Windows-runner
 * minutes) on every Svelte/TS/test/icon-only change even though the frontend
 * is fully covered by ci.yml (typecheck, lint, vitest, desktop-alt E2E on
 * Linux). The list is now scoped to what the Windows jobs actually compile or
 * install: the Rust crate and its tauri configs/installer templates/icons
 * under src-tauri, the Recall sidecar, the desktop-alt E2E specs the Windows
 * jobs run live, the app package manifest/lockfile (installer contents),
 * shared crates, Cargo/toolchain files, release/Windows scripts, and the two
 * workflows.
 *
 * Release tags are not affected: release.yml always builds all targets on
 * every tag regardless of this gate.
 *
 * `**` matches any suffix; `*` matches within one segment. The test pins this
 * list exactly.
 */
export const WINDOWS_RELEVANT_PATTERNS = [
  "apps/sync/src-tauri/**",
  "apps/sync/sidecar/**",
  "apps/sync/e2e/desktop-alt/**",
  "apps/sync/package.json",
  "apps/sync/pnpm-lock.yaml",
  "apps/sync/pnpm-workspace.yaml",
  "imports/hq-installer-react/**",
  "crates/**",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "versions.toml",
  "scripts/release-*.mjs",
  "scripts/release-*.test.ts",
  "scripts/windows-*.mjs",
  "scripts/windows-*.test.ts",
  "scripts/windows-*.ps1",
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
