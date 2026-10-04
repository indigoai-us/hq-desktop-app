// Decide whether changed paths need the macOS Rust gate.
//
// This is a job-level scope check, not a workflow path filter. The Rust job is
// a required status check, so the workflow must start for every PR and the
// same job name must report for both a run and a skip.
//
// Empty input means the changed-file set could not be established. Run the
// gate in that case rather than risk hiding a platform regression.

export const MACOS_RELEVANT_PATTERNS = [
  "apps/sync/**",
  "crates/**",
  "imports/**",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "versions.toml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/**",
  ".github/**",
];

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
