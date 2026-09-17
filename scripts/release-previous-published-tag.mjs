#!/usr/bin/env node

// Pick the release whose notes the tag being released must not repeat.
//
// The "Refuse to release empty release notes" guard in release.yml compares the
// tag's `## [Unreleased]` block against the notes the PREVIOUS stable release
// published, so a failed version sync cannot ship the same notes twice. It used
// to name that previous release with a bare
// `git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*'`, which
// finds the nearest stable TAG — and a tag is not a release. A release run can
// fail after the tag exists: v0.10.277 was tagged, built macOS, failed both
// Windows builds, and so never reached "Publish GitHub release". Its notes
// correctly stayed under `## [Unreleased]`, because nobody has ever seen them.
// Naming that tag "previous" then refused v0.10.278 for repeating notes that
// were never published — the guard blocking the very release meant to ship them.
//
// So walk the tag's stable ancestors newest-first and return the first one that
// has a PUBLISHED GitHub release. Ancestors whose release run died before
// publish are skipped. Behaviour is unchanged when the nearest stable ancestor
// did publish: that is the first candidate, one API call, same answer as before.
//
// Usage:
//   release-previous-published-tag.mjs --repository <owner/repo> --candidates <file>
//
// `--candidates` holds one stable tag per line, nearest ancestor first (the
// workflow builds it by walking `git describe` back through the tag's history).
// The chosen tag is printed on stdout and nothing else is, so the caller can
// read it straight out of a command substitution; every diagnostic goes to
// stderr. Prints nothing when no ancestor has a published release, which leaves
// the guard to run without a previous release — the same as a repo whose first
// stable release this is.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const stablePattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

// How far back to walk. A run of unpublished stable tags this long means the
// release pipeline has been broken for weeks, not that the walk is too short.
const DEFAULT_MAX_CHECKS = 20;

function selectionError(message) {
  return new Error(`Previous published release lookup failed: ${message}`);
}

/**
 * One stable tag per line, nearest ancestor first. Blank lines are dropped;
 * anything that is not a strict `vX.Y.Z` tag is rejected rather than skipped,
 * because a prerelease or a stray tag reaching this list means the caller's
 * candidate walk is wrong and silently ignoring it would hide that.
 * @param {string} text
 * @returns {string[]}
 */
export function parseCandidates(text) {
  const candidates = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const candidate of candidates) {
    if (!stablePattern.test(candidate)) {
      throw selectionError(`candidate is not a strict stable tag: ${candidate}`);
    }
  }
  return candidates;
}

/**
 * A release counts as published only when users can actually see it: a draft is
 * the hidden staging release publish.yml builds before it flips it public, and
 * a prerelease never carries stable's notes.
 * @param {{ draft?: boolean, prerelease?: boolean } | null | undefined} release
 * @returns {boolean}
 */
export function isPublishedStableRelease(release) {
  if (!release || typeof release !== "object") return false;
  return release.draft !== true && release.prerelease !== true;
}

function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "hq-desktop-release-validation",
    "x-github-api-version": "2022-11-28",
  };
}

/**
 * Look one tag up by name. 404 means no release for that tag, which is the
 * answer we are asking for and not an error; any other failure IS an error and
 * fails the release, because guessing "unpublished" from a rate limit would
 * walk past the real previous release and wave through repeated notes.
 * @param {{ repository: string, token: string, fetchImpl?: typeof fetch }} options
 * @returns {(tag: string) => Promise<object | null>}
 */
export function createReleaseLookup({ repository, token, fetchImpl = fetch }) {
  if (typeof repository !== "string" || !repository.includes("/")) {
    throw selectionError(`invalid repository ${String(repository)}`);
  }
  if (typeof token !== "string" || !token) {
    throw selectionError("GitHub token is required");
  }

  return async (tag) => {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
      {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw selectionError(
        `could not read the release for ${tag}: HTTP ${response.status}`,
      );
    }
    return response.json();
  };
}

/**
 * First candidate with a published release, plus the unpublished tags walked
 * past to reach it so the workflow log names them.
 * @param {{
 *   candidates: string[],
 *   lookupRelease: (tag: string) => Promise<object | null>,
 *   maxChecks?: number,
 * }} options
 * @returns {Promise<{ tag: string | null, skipped: string[], exhausted: boolean }>}
 */
export async function selectPreviousPublishedTag({
  candidates,
  lookupRelease,
  maxChecks = DEFAULT_MAX_CHECKS,
}) {
  if (!Array.isArray(candidates)) {
    throw selectionError("candidates must be an array of stable tags");
  }
  if (typeof lookupRelease !== "function") {
    throw selectionError("lookupRelease must be a function");
  }
  if (!Number.isInteger(maxChecks) || maxChecks < 1) {
    throw selectionError(`maxChecks must be a positive integer, got ${String(maxChecks)}`);
  }

  const skipped = [];
  const checked = candidates.slice(0, maxChecks);
  for (const candidate of checked) {
    if (isPublishedStableRelease(await lookupRelease(candidate))) {
      return { tag: candidate, skipped, exhausted: false };
    }
    skipped.push(candidate);
  }
  return {
    tag: null,
    skipped,
    exhausted: checked.length < candidates.length,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw selectionError(`invalid CLI arguments near ${String(key)}`);
    }
    values[key.slice(2)] = value;
  }
  return values;
}

async function runCli() {
  const values = parseArgs(process.argv.slice(2));
  if (!values.candidates) {
    throw selectionError("--candidates <file> is required");
  }

  const candidates = parseCandidates(readFileSync(values.candidates, "utf8"));
  if (candidates.length === 0) {
    console.error("No stable ancestor tags; releasing without a previous release.");
    return;
  }

  const result = await selectPreviousPublishedTag({
    candidates,
    lookupRelease: createReleaseLookup({
      repository: values.repository,
      token: process.env.GH_TOKEN ?? process.env.RELEASE_API_TOKEN,
    }),
  });

  for (const tag of result.skipped) {
    console.error(
      `${tag} is tagged but has no published GitHub release, so its notes were never shipped; skipping it.`,
    );
  }
  if (!result.tag) {
    console.error(
      "No stable ancestor has a published release; releasing without a previous release.",
    );
    return;
  }
  console.error(`Previous published stable release: ${result.tag}`);
  console.log(result.tag);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli().catch((error) => {
    console.error(
      `::error::${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
