#!/usr/bin/env node
// Build the compact "what changed" bullet list for a release announcement.
//
// Input is a list of git commit subjects between the previous tag and this one.
// Two shapes are recognised, because this repo has used both over its history:
//
//   "Merge pull request #684 from indigoai-us/some-branch"  -> needs a title lookup
//   "Channel-native company lifecycle: ... (#684)"          -> title is already there
//
// Both become "#684 <PR title>". Titles are kept exactly as the author wrote
// them — no rewriting, no sentence-casing, no truncation of the words.

export const MAX_BULLETS = 12;

const MERGE_COMMIT = /^Merge pull request #(\d+) from \S+(?:\s+(.*))?$/;
const SQUASH_COMMIT = /^(.*?)\s*\(#(\d+)\)\s*$/;

/**
 * @param {string[]} subjects one commit subject per entry, newest first
 * @param {(pr: number) => (string|null)} lookupTitle resolves a PR title, may return null
 * @returns {string[]} bullet lines without the leading "- "
 */
export function buildBullets(subjects, lookupTitle = () => null) {
  const seen = new Set();
  const bullets = [];

  for (const raw of subjects) {
    const subject = String(raw ?? "").trim();
    if (!subject) continue;

    let pr = null;
    let title = null;

    const merge = subject.match(MERGE_COMMIT);
    if (merge) {
      pr = merge[1];
      title = (merge[2] ?? "").trim() || null;
      if (!title) {
        const looked = lookupTitle(Number(pr));
        title = looked ? String(looked).trim() : null;
      }
    } else {
      const squash = subject.match(SQUASH_COMMIT);
      if (squash) {
        title = squash[1].trim();
        pr = squash[2];
      }
    }

    // A commit with no PR reference (a direct push, a version stamp) is not a
    // change anyone reading the announcement needs to see.
    if (!pr) continue;
    if (seen.has(pr)) continue;
    seen.add(pr);

    bullets.push(title ? `#${pr} ${title}` : `#${pr}`);
  }

  return bullets;
}

/**
 * @returns {{ bullets: string[], omitted: number }}
 */
export function capBullets(bullets, max = MAX_BULLETS) {
  if (bullets.length <= max) return { bullets, omitted: 0 };
  return { bullets: bullets.slice(0, max), omitted: bullets.length - max };
}

/**
 * The full announcement body for a build that is starting.
 */
export function buildAnnouncement({ version, previousTag, bullets, omitted = 0 }) {
  const lines = [
    `HQ desktop v${version} is being built now — public in ~20 min once checks pass.`,
  ];
  if (bullets.length === 0) {
    lines.push(
      previousTag
        ? `No merged pull requests since ${previousTag}.`
        : "No previous release tag to compare against.",
    );
    return lines.join("\n");
  }
  lines.push(`Changes since ${previousTag}:`);
  for (const bullet of bullets) lines.push(`- ${bullet}`);
  if (omitted > 0) lines.push(`- …and ${omitted} more`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI: release-changelog-bullets.mjs --version X.Y.Z --previous vA.B.C --tag vX.Y.Z
// Reads commit subjects from git (or from stdin with --stdin) and prints the
// announcement message on stdout.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[name] = next;
      i += 1;
    } else {
      args[name] = true;
    }
  }
  return args;
}

async function main() {
  const { execFileSync } = await import("node:child_process");
  const args = parseArgs(process.argv.slice(2));
  const tag = args.tag;
  if (!tag) {
    console.error("usage: release-changelog-bullets.mjs --tag vX.Y.Z [--previous vA.B.C] [--stdin]");
    process.exit(2);
  }
  const version = args.version || String(tag).replace(/^v/, "");

  const git = (cliArgs) =>
    execFileSync("git", cliArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  let previousTag = args.previous && args.previous !== true ? String(args.previous) : "";
  if (!previousTag) {
    try {
      previousTag = git(["describe", "--tags", "--abbrev=0", `${tag}^`]);
    } catch {
      previousTag = "";
    }
  }

  let subjects = [];
  if (args.stdin) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    subjects = Buffer.concat(chunks).toString("utf8").split("\n");
  } else if (previousTag) {
    // --merges first (the historical shape), then fall back to every commit so
    // squash-merged repos still produce a changelog.
    const range = `${previousTag}..${tag}`;
    let out = "";
    try {
      out = git(["log", "--merges", "--format=%s", range]);
    } catch {
      out = "";
    }
    if (!out) {
      try {
        out = git(["log", "--no-merges", "--format=%s", range]);
      } catch {
        out = "";
      }
    }
    subjects = out.split("\n");
  }

  const lookupTitle = (pr) => {
    try {
      return execFileSync("gh", ["pr", "view", String(pr), "--json", "title", "-q", ".title"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };

  const { bullets, omitted } = capBullets(buildBullets(subjects, lookupTitle));
  process.stdout.write(`${buildAnnouncement({ version, previousTag, bullets, omitted })}\n`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
