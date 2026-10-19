// Decide whether changed paths need the macOS Rust gate.
//
// This is a job-level scope check, not a workflow path filter. The Rust job is
// a required status check, so the workflow must start for every PR and the
// same job name must report for both a run and a skip.
//
// Empty input means the changed-file set could not be established. Run the
// gate in that case rather than risk hiding a platform regression.

// Scoped to what the macOS runner compiles or links: Rust sources and
// manifests, the toolchain pin, build scripts, native Swift/Objective-C
// sources, the Recall sidecar (apps/sync/src-tauri/build.rs validates its
// bundled resource paths), and the files that define this gate. The Svelte
// bundle the app crate's tests read is built on Linux by the
// `rust-macos-bundle` job, and the frontend itself is covered there, so
// TypeScript, Svelte, docs, and workspace lockfile changes do not reach the
// 10x macOS runner.
//
// Two non-Rust files are compiled into Rust tests with include_str!, so a
// change to either one has to run the gate:
//   apps/sync/src-tauri/src/welcome_window.rs reads welcome.css
//   apps/sync/src-tauri/src/commands/version_gate.rs reads release.yml
// When a Rust test starts reading another file outside these patterns, add it
// here.
//
// `**/` matches zero or more leading directories; `**` matches any suffix;
// `*` matches within one path segment. The test pins this list exactly.
export const MACOS_RELEVANT_PATTERNS = [
  "**/src-tauri/**",
  "apps/sync/sidecar/**",
  "crates/**",
  ".cargo/**",
  "**/Cargo.toml",
  "**/Cargo.lock",
  "rust-toolchain*",
  "**/build.rs",
  "**/*.rs",
  "**/*.swift",
  "**/*.m",
  "**/*.mm",
  "**/*.h",
  "apps/sync/src/components/onboarding/welcome/welcome.css",
  ".github/workflows/release.yml",
  ".github/workflows/ci.yml",
  "scripts/macos-check-relevant.mjs",
];

function toRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*" && pattern[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else if (pattern[i + 1] === "*") {
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

const MATCHERS = MACOS_RELEVANT_PATTERNS.map(toRegExp);

export function isMacosRelevant(paths) {
  const cleaned = paths.map((path) => path.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return true;
  }
  return cleaned.some((path) => MATCHERS.some((matcher) => matcher.test(path)));
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const paths = Buffer.concat(chunks).toString("utf8").split("\n");
  process.stdout.write(isMacosRelevant(paths) ? "true" : "false");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
