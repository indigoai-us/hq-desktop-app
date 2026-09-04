#!/usr/bin/env node

/**
 * Operator tool: mark a shipped desktop build as bad and point GitHub's
 * `latest.json` at a good one so the in-app updater can roll users back.
 *
 *   node scripts/release-mark-bad.mjs 0.10.178
 *   node scripts/release-mark-bad.mjs 0.10.178 --to 0.10.177
 *   node scripts/release-mark-bad.mjs 0.10.178 --dry-run --fixture scripts/fixtures/latest.json
 *
 * Live mode downloads the good release's `latest.json`, stamps
 * `rollback` / `bad_versions` / `min_supported`, uploads it with
 * `gh release upload --clobber`, and (when the bad tag is currently
 * GitHub's latest) marks that tag prerelease so `/releases/latest`
 * moves to the good build. Signature bytes on the platform artifacts
 * are left untouched.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_REPO = "indigoai-us/hq-desktop-app";
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function markBadError(message) {
  return new Error(`release-mark-bad: ${message}`);
}

export function normalizeVersion(input) {
  const raw = String(input ?? "").trim();
  const stripped = raw.replace(/^v/i, "");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta|alpha)\.(0|[1-9]\d*))?$/.test(stripped)) {
    throw markBadError(`expected X.Y.Z or X.Y.Z-beta.N, got ${JSON.stringify(input)}`);
  }
  return stripped;
}

export function versionToTag(version) {
  return `v${normalizeVersion(version)}`;
}

export function applyRollbackMarker(
  manifest,
  { badVersions, minSupported, rollback = true } = {},
) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw markBadError("latest.json must be an object");
  }
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw markBadError("latest.json is missing version");
  }
  if (!manifest.platforms || typeof manifest.platforms !== "object") {
    throw markBadError("latest.json is missing platforms");
  }
  const listed = (badVersions ?? []).map((version) => normalizeVersion(version));
  if (listed.length === 0) {
    throw markBadError("at least one bad version is required");
  }
  const unique = [...new Set(listed)];
  return {
    ...manifest,
    rollback: rollback !== false,
    bad_versions: unique,
    min_supported: minSupported
      ? normalizeVersion(minSupported)
      : normalizeVersion(manifest.version),
  };
}

export function planMarkBad({ badVersion, goodVersion, currentLatestTag }) {
  const bad = normalizeVersion(badVersion);
  const good = normalizeVersion(goodVersion);
  if (bad === good) {
    throw markBadError(`good version ${good} cannot be the same as the bad version`);
  }
  const currentLatest = currentLatestTag
    ? String(currentLatestTag).replace(/^v/i, "")
    : null;
  return {
    badVersion: bad,
    goodVersion: good,
    badTag: versionToTag(bad),
    goodTag: versionToTag(good),
    unpublishBad: currentLatest === bad,
  };
}

function parseArgs(argv) {
  const args = {
    repo: DEFAULT_REPO,
    dryRun: false,
    fixture: null,
    output: null,
    to: null,
    bad: null,
  };
  const rest = [...argv];
  while (rest.length > 0) {
    const token = rest.shift();
    if (token === "--dry-run") {
      args.dryRun = true;
    } else if (token === "--repo") {
      args.repo = rest.shift();
    } else if (token === "--to") {
      args.to = rest.shift();
    } else if (token === "--fixture") {
      args.fixture = rest.shift();
    } else if (token === "--output") {
      args.output = rest.shift();
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token.startsWith("-")) {
      throw markBadError(`unknown flag ${token}`);
    } else if (!args.bad) {
      args.bad = token;
    } else {
      throw markBadError(`unexpected argument ${token}`);
    }
  }
  return args;
}

function gh(args, { repo, allowFail = false } = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) {
    throw markBadError(`failed to spawn gh: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFail) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw markBadError(
      `gh ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return result;
}

function ghJson(args) {
  const result = gh(args);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw markBadError(`gh ${args.join(" ")} did not return JSON`);
  }
}

async function loadFixtureManifest(fixturePath) {
  const raw = await readFile(fixturePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw markBadError(`fixture ${fixturePath} is not valid JSON`);
  }
}

function resolveGoodVersion({ to, latestTag, releases, badVersion }) {
  if (to) return normalizeVersion(to);
  const latest = latestTag ? normalizeVersion(latestTag.replace(/^v/i, "")) : null;
  if (latest && latest !== badVersion) return latest;
  const stables = (releases ?? [])
    .map((release) => release.tag_name)
    .filter((tag) => STABLE_TAG.test(tag))
    .map((tag) => tag.slice(1))
    .filter((version) => version !== badVersion);
  if (stables.length === 0) {
    throw markBadError(
      "could not resolve a good version; pass --to <version>",
    );
  }
  return stables[0];
}

export async function markBad(options) {
  const badVersion = normalizeVersion(options.badVersion);
  let manifest;
  let latestTag = options.currentLatestTag ?? null;
  let releases = options.releases ?? [];

  if (options.fixturePath) {
    manifest = await loadFixtureManifest(options.fixturePath);
    latestTag = latestTag ?? (manifest.version ? `v${manifest.version}` : null);
  } else if (options.manifest) {
    manifest = options.manifest;
  } else {
    throw markBadError("fixturePath or manifest is required in this helper");
  }

  const goodVersion = resolveGoodVersion({
    to: options.to,
    latestTag,
    releases,
    badVersion,
  });
  const plan = planMarkBad({
    badVersion,
    goodVersion,
    currentLatestTag: latestTag,
  });
  const marked = applyRollbackMarker(manifest, {
    badVersions: [badVersion],
    minSupported: goodVersion,
  });
  if (normalizeVersion(marked.version) !== plan.goodVersion) {
    throw markBadError(
      `good latest.json version ${marked.version} does not match --to ${plan.goodVersion}`,
    );
  }
  return { plan, marked };
}

async function runLive(args) {
  const badVersion = normalizeVersion(args.bad);
  const repo = args.repo;
  const latest = ghJson([
    "api",
    `repos/${repo}/releases/latest`,
    "--jq",
    "{tag_name,prerelease,draft}",
  ]);
  const list = ghJson([
    "api",
    `repos/${repo}/releases?per_page=30`,
    "--jq",
    "[.[] | {tag_name,prerelease,draft}]",
  ]);
  const goodVersion = resolveGoodVersion({
    to: args.to,
    latestTag: latest.tag_name,
    releases: list,
    badVersion,
  });
  const plan = planMarkBad({
    badVersion,
    goodVersion,
    currentLatestTag: latest.tag_name,
  });

  const tmp = await mkdtemp(join(tmpdir(), "hq-mark-bad-"));
  const download = gh([
    "release",
    "download",
    plan.goodTag,
    "-R",
    repo,
    "-p",
    "latest.json",
    "-D",
    tmp,
    "--clobber",
  ]);
  void download;
  const localPath = join(tmp, "latest.json");
  const manifest = JSON.parse(await readFile(localPath, "utf8"));
  const marked = applyRollbackMarker(manifest, {
    badVersions: [badVersion],
    minSupported: goodVersion,
  });
  if (normalizeVersion(marked.version) !== plan.goodVersion) {
    throw markBadError(
      `downloaded latest.json version ${marked.version} does not match ${plan.goodVersion}`,
    );
  }
  await writeFile(localPath, `${JSON.stringify(marked, null, 2)}\n`);
  gh(["release", "upload", plan.goodTag, localPath, "-R", repo, "--clobber"]);
  if (plan.unpublishBad) {
    gh(["release", "edit", plan.badTag, "-R", repo, "--prerelease"]);
  }
  return { plan, marked, path: localPath };
}

function printHelp() {
  process.stdout.write(`Mark a shipped HQ desktop build as bad and point latest.json at a good one.

Usage:
  node scripts/release-mark-bad.mjs <bad-version> [--to <good-version>] [options]

Options:
  --to <version>       Good build to serve (default: current GitHub latest, else previous stable)
  --repo <owner/name>  GitHub repo (default: ${DEFAULT_REPO})
  --dry-run            Print the patched latest.json; do not call gh
  --fixture <path>     Read latest.json from disk (required with --dry-run unless piping)
  --output <path>      Write the patched JSON to this path
  -h, --help           Show this help
`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return { ok: true, help: true };
  }
  if (!args.bad) {
    throw markBadError("missing <bad-version>");
  }
  if (args.dryRun) {
    if (!args.fixture) {
      throw markBadError("--dry-run requires --fixture <latest.json>");
    }
    const result = await markBad({
      badVersion: args.bad,
      to: args.to,
      fixturePath: resolve(args.fixture),
    });
    const json = `${JSON.stringify(result.marked, null, 2)}\n`;
    if (args.output) {
      await writeFile(resolve(args.output), json);
    } else {
      process.stdout.write(json);
    }
    process.stderr.write(
      `dry-run: would upload ${result.plan.goodTag}/latest.json` +
        (result.plan.unpublishBad
          ? ` and mark ${result.plan.badTag} prerelease\n`
          : "\n"),
    );
    return result;
  }
  const result = await runLive(args);
  process.stderr.write(
    `uploaded ${result.plan.goodTag}/latest.json` +
      (result.plan.unpublishBad
        ? `; marked ${result.plan.badTag} prerelease so GitHub latest moves\n`
        : "\n"),
  );
  return result;
}

const isDirectRun =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
