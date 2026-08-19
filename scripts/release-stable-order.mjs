#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const stablePattern =
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const prereleasePattern =
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-(beta|alpha)\.(0|[1-9][0-9]*)$/;

function orderError(message) {
  return new Error(`Stable release order failed: ${message}`);
}

function stableParts(tag) {
  const match = stablePattern.exec(tag);
  if (!match) {
    throw orderError(`expected a strict stable tag, got ${String(tag)}`);
  }
  return match.slice(1);
}

function compareNumericText(left, right) {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareStableTags(left, right) {
  const leftParts = stableParts(left);
  const rightParts = stableParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const comparison = compareNumericText(leftParts[index], rightParts[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function apiHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "hq-desktop-release-validation",
    "x-github-api-version": "2022-11-28",
  };
}

async function fetchLatestRelease({ repository, token, fetchImpl }) {
  if (typeof repository !== "string" || !repository.includes("/")) {
    throw orderError(`invalid repository ${String(repository)}`);
  }
  if (typeof token !== "string" || !token) {
    throw orderError("GitHub token is required");
  }

  return fetchImpl(
    `https://api.github.com/repos/${repository}/releases/latest`,
    {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(30_000),
    },
  );
}

export async function verifyStableReleaseOrder({
  repository,
  targetTag,
  token,
  fetchImpl = fetch,
}) {
  stableParts(targetTag);

  const response = await fetchLatestRelease({ repository, token, fetchImpl });

  if (response.status === 404) {
    return { status: "first-stable", targetTag };
  }
  if (!response.ok) {
    throw orderError(
      `could not read public stable latest: HTTP ${response.status}`,
    );
  }

  const latest = await response.json();
  const latestTag = latest?.tag_name;
  if (typeof latestTag !== "string" || !stablePattern.test(latestTag)) {
    throw orderError(
      `public latest release has unsupported stable tag: ${String(latestTag)}`,
    );
  }

  const comparison = compareStableTags(targetTag, latestTag);
  if (comparison < 0) {
    throw orderError(
      `Refusing stable rollback: ${targetTag} is older than public latest ${latestTag}.`,
    );
  }
  if (comparison === 0) {
    return { status: "rerun", targetTag, latestTag };
  }
  return { status: "advance", targetTag, latestTag };
}

// A higher version number is not proof of newer code. `compareStableTags` only
// orders the numeric tag, so an annotated tag placed on an OLDER commit that is
// still on main passes it while shipping strictly older code — exactly how
// v0.10.107 and v0.10.109 rolled the fleet back onto pre-fix builds under
// bigger numbers. The GitHub compare endpoint reads the actual commit lineage:
// with base = public latest and head = the target tag, `status` is `ahead` for
// a genuine advance, `identical` for a rerun, and `behind`/`diverged` for a
// rollback.
async function compareStableCommits({ repository, base, head, token, fetchImpl }) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/compare/${base}...${head}`,
    {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw orderError(
      `could not compare ${base}...${head}: HTTP ${response.status}`,
    );
  }
  const body = await response.json();
  const status = body?.status;
  if (typeof status !== "string") {
    throw orderError(`compare ${base}...${head} returned no status`);
  }
  return {
    status,
    aheadBy: Number.isInteger(body?.ahead_by) ? body.ahead_by : 0,
    behindBy: Number.isInteger(body?.behind_by) ? body.behind_by : 0,
    commits: Array.isArray(body?.commits)
      ? body.commits.map((commit) => ({
          sha: typeof commit?.sha === "string" ? commit.sha : "",
          title:
            typeof commit?.commit?.message === "string"
              ? commit.commit.message.split("\n", 1)[0]
              : "",
        }))
      : [],
  };
}

// The declared-rollback escape hatch: an intentional emergency rollback stays
// possible without editing the workflow by annotating the tag with a
// machine-readable `Rollback-Of: vX.Y.Z` trailer naming the exact tag being
// withdrawn. Git trailer keys are conventionally case-insensitive; the value
// must match the current public latest stable tag exactly.
function parseRollbackTrailer(message) {
  for (const rawLine of String(message).split(/\r?\n/)) {
    const match = /^rollback-of:\s*(\S+)\s*$/i.exec(rawLine.trim());
    if (match) {
      return match[1];
    }
  }
  return null;
}

// Resolve a tag's annotated message. A lightweight tag resolves straight to a
// commit object (`ref.object.type === "commit"`) — it has no tag object and no
// message, so no declared rollback can exist and the gate fails closed.
async function readAnnotatedTagMessage({ repository, tag, token, fetchImpl }) {
  const refResponse = await fetchImpl(
    `https://api.github.com/repos/${repository}/git/ref/tags/${tag}`,
    {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!refResponse.ok) {
    throw orderError(`could not read tag ref ${tag}: HTTP ${refResponse.status}`);
  }
  const ref = await refResponse.json();
  const objectType = ref?.object?.type;
  const objectSha = ref?.object?.sha;
  if (objectType !== "tag" || typeof objectSha !== "string") {
    return null;
  }
  const tagResponse = await fetchImpl(
    `https://api.github.com/repos/${repository}/git/tags/${objectSha}`,
    {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!tagResponse.ok) {
    throw orderError(
      `could not read annotated tag ${tag}: HTTP ${tagResponse.status}`,
    );
  }
  const tagObject = await tagResponse.json();
  return typeof tagObject?.message === "string" ? tagObject.message : "";
}

export async function verifyStableReleaseLineage({
  repository,
  targetTag,
  token,
  fetchImpl = fetch,
}) {
  stableParts(targetTag);

  const response = await fetchLatestRelease({ repository, token, fetchImpl });
  if (response.status === 404) {
    return { status: "first-stable", targetTag };
  }
  if (!response.ok) {
    throw orderError(
      `could not read public stable latest: HTTP ${response.status}`,
    );
  }

  const latest = await response.json();
  const latestTag = latest?.tag_name;
  if (typeof latestTag !== "string" || !stablePattern.test(latestTag)) {
    throw orderError(
      `public latest release has unsupported stable tag: ${String(latestTag)}`,
    );
  }

  const comparison = await compareStableCommits({
    repository,
    base: latestTag,
    head: targetTag,
    token,
    fetchImpl,
  });

  if (comparison.status === "ahead") {
    return { status: "advance", targetTag, latestTag, compareStatus: "ahead" };
  }
  if (comparison.status === "identical") {
    return { status: "rerun", targetTag, latestTag, compareStatus: "identical" };
  }
  // Enumerate every status explicitly with no default-allow branch: an
  // unrecognized status fails closed rather than shipping.
  if (comparison.status !== "behind" && comparison.status !== "diverged") {
    throw orderError(
      `unrecognized compare status "${comparison.status}" for ${latestTag}...${targetTag}`,
    );
  }

  // Lineage rollback. Allow it ONLY when the tag declares it with a trailer
  // naming the exact current public latest stable tag; a missing trailer, a
  // stale/copied trailer naming a different tag, and a lightweight tag all fail
  // closed here.
  const message = await readAnnotatedTagMessage({
    repository,
    tag: targetTag,
    token,
    fetchImpl,
  });
  const declaredTag = message === null ? null : parseRollbackTrailer(message);
  if (declaredTag !== latestTag) {
    throw orderError(
      `Refusing stable lineage rollback: ${targetTag} is ${comparison.status} ` +
        `public latest ${latestTag} by ${comparison.behindBy} commit(s). ` +
        `Annotate the tag with a "Rollback-Of: ${latestTag}" trailer to ship an ` +
        `intentional rollback.`,
    );
  }

  // The withdrawn fixes are the commits in the current latest but not in the
  // rollback target — the reverse compare enumerates them for the operator.
  const withdrawn = await compareStableCommits({
    repository,
    base: targetTag,
    head: latestTag,
    token,
    fetchImpl,
  });
  return {
    status: "declared-rollback",
    targetTag,
    latestTag,
    compareStatus: comparison.status,
    behindBy: comparison.behindBy,
    withdrawnCommits: withdrawn.commits,
  };
}

function writeRollbackSummary(result) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const commitLines = result.withdrawnCommits.length
    ? result.withdrawnCommits.map(
        (commit) => `- \`${commit.sha.slice(0, 12)}\` ${commit.title}`,
      )
    : ["- (none enumerated)"];
  const block = [
    `## Declared stable rollback: ${result.targetTag}`,
    "",
    `Public latest \`${result.latestTag}\` is being rolled back to ` +
      `\`${result.targetTag}\` (${result.behindBy} commit(s) behind).`,
    "",
    `Withdrawing ${result.withdrawnCommits.length} merged commit(s) from the ` +
      "stable channel:",
    "",
    ...commitLines,
    "",
  ].join("\n");
  appendFileSync(summaryPath, `${block}\n`);
}

export async function confirmReleaseChannel({
  repository,
  targetTag,
  makeLatest,
  token,
  fetchImpl = fetch,
  attempts = 5,
  retryDelayMs = 2_000,
}) {
  if (makeLatest) {
    stableParts(targetTag);
  } else if (!prereleasePattern.test(targetTag)) {
    throw orderError(`expected a strict prerelease tag, got ${String(targetTag)}`);
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw orderError(`attempts must be a positive integer, got ${String(attempts)}`);
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchLatestRelease({
        repository,
        token,
        fetchImpl,
      });

      if (response.status === 404) {
        if (!makeLatest) {
          return { status: "no-stable", targetTag, latestTag: null };
        }
        throw orderError(
          `stable release ${targetTag} is public but GitHub latest does not exist`,
        );
      }
      if (!response.ok) {
        throw orderError(
          `could not read public stable latest: HTTP ${response.status}`,
        );
      }

      const latest = await response.json();
      const latestTag = latest?.tag_name;
      if (typeof latestTag !== "string" || !stablePattern.test(latestTag)) {
        throw orderError(
          `public latest release has unsupported stable tag: ${String(latestTag)}`,
        );
      }

      if (makeLatest && latestTag !== targetTag) {
        throw orderError(
          `stable release ${targetTag} did not become latest; latest is ${latestTag}`,
        );
      }
      if (!makeLatest && latestTag === targetTag) {
        throw orderError(
          `prerelease ${targetTag} unexpectedly replaced stable latest`,
        );
      }

      return {
        status: makeLatest ? "stable-latest" : "prerelease-isolated",
        targetTag,
        latestTag,
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs));
      }
    }
  }

  throw lastError;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw orderError(`invalid CLI arguments near ${String(key)}`);
    }
    values[key.slice(2)] = value;
  }
  return { command, values };
}

async function runCli() {
  const { command, values } = parseArgs(process.argv.slice(2));
  const common = {
    repository: values.repository,
    targetTag: values.tag,
    token: process.env.GH_TOKEN ?? process.env.RELEASE_API_TOKEN,
  };

  if (command === "confirm-channel") {
    const result = await confirmReleaseChannel({
      ...common,
      makeLatest:
        values["make-latest"] === "true"
          ? true
          : values["make-latest"] === "false"
            ? false
            : (() => {
                throw orderError("--make-latest must be true or false");
              })(),
    });
    console.log(
      `Confirmed ${result.targetTag} release channel; stable latest is ${result.latestTag ?? "none"}.`,
    );
    return;
  }

  if (command === "lineage") {
    const result = await verifyStableReleaseLineage(common);
    if (result.status === "first-stable") {
      console.log(
        `No existing stable release; ${result.targetTag} has no prior lineage to preserve.`,
      );
    } else if (result.status === "declared-rollback") {
      console.log(
        `::warning::Declared stable rollback: ${result.targetTag} rolls back public latest ${result.latestTag} (${result.behindBy} commit(s) behind); withdrawing ${result.withdrawnCommits.length} merged commit(s).`,
      );
      writeRollbackSummary(result);
    } else {
      console.log(
        `Stable ${result.targetTag} preserves the commit lineage of public latest ${result.latestTag} (${result.compareStatus}).`,
      );
    }
    return;
  }

  if (command !== "stable-order") {
    throw orderError(`unknown command ${String(command)}`);
  }
  const result = await verifyStableReleaseOrder(common);
  if (result.status === "first-stable") {
    console.log(
      `No existing stable release; ${result.targetTag} establishes stable latest.`,
    );
  } else if (result.status === "rerun") {
    console.log(
      `Stable ${result.targetTag} matches public latest; allowing intentional rerun.`,
    );
  } else {
    console.log(
      `Stable ${result.targetTag} advances public latest from ${result.latestTag}.`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli().catch((error) => {
    console.error(
      `::error::${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
