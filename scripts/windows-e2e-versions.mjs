#!/usr/bin/env node
// Single source of truth for the two synthetic patch versions the Windows
// installer E2E needs.
//
// The E2E installs this PR at one synthetic patch and then upgrades it with the
// same PR built at the next one, so the running parent and the copied helper
// carry the same updater implementation, exactly as they do in production.
//
// Those two installers are produced by two build jobs that run in parallel and
// never exchange the arithmetic -- each derives it on its own runner. If they
// disagreed by even one patch, the bridge job would publish X.Y.(Z+1) while the
// target job published something the E2E job never looks for, and the failure
// would surface as "installer was not produced" with no hint that two jobs had
// simply computed different numbers. Keeping the derivation in one tested
// function is what makes that split safe.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {string} baseVersion stable X.Y.Z version from apps/sync/package.json
 * @returns {{ base: string, bridge: string, target: string }}
 */
export function deriveInstallerE2eVersions(baseVersion) {
  const parts = String(baseVersion).split(".");
  const stable =
    parts.length === 3 && parts.every((part) => /^(0|[1-9]\d*)$/.test(part));

  if (!stable) {
    throw new Error(
      `Expected stable X.Y.Z base version, got ${baseVersion}`,
    );
  }

  const [major, minor, patch] = parts;

  return {
    base: baseVersion,
    bridge: `${major}.${minor}.${Number(patch) + 1}`,
    target: `${major}.${minor}.${Number(patch) + 2}`,
  };
}

/** Read apps/sync/package.json's version from a checkout root. */
export function readBaseVersion(rootDir) {
  const manifest = JSON.parse(
    readFileSync(resolve(rootDir, "apps/sync/package.json"), "utf8"),
  );

  return manifest.version;
}

const selfPath = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === selfPath) {
  const rootDir = resolve(dirname(selfPath), "..");

  try {
    const versions = deriveInstallerE2eVersions(readBaseVersion(rootDir));
    // GITHUB_OUTPUT lines, appended verbatim by the workflow step.
    process.stdout.write(
      `base=${versions.base}\nbridge=${versions.bridge}\ntarget=${versions.target}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}
