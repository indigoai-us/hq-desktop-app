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
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "hq-desktop-release-validation",
        "x-github-api-version": "2022-11-28",
      },
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

function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "hq-desktop-release-validation",
    "x-github-api-version": "2022-11-28",
  };
}

async function fetchCompareStatus({ repository, base, head, token, fetchImpl }) {
  if (typeof repository !== "string" || !repository.includes("/")) {
    throw orderError(`invalid repository ${String(repository)}`);
  }
  if (typeof token !== "string" || !token) {
    throw orderError("GitHub token is required");
  }

  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/compare/${base}...${head}`,
    {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw orderError(
      `could not compare ${base}...${head}: HTTP ${response.status}`,
    );
  }
  return response.json();
}

// Parse the terminal Git trailer block — the last paragraph, and only when
// every line in it is `Token: value` — and return the Rollback-Of value if the
// block declares one. This deliberately ignores a `Rollback-Of:` line quoted or
// discussed in the message BODY (only a real trailer authorizes a rollback) and
// reads the whole block so an earlier mention cannot mask the actual trailer.
function extractRollbackTarget(message) {
  const normalized = message.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (!normalized) {
    return null;
  }
  const lines = normalized.split("\n");
  let start = lines.length;
  while (start > 0 && lines[start - 1].trim() !== "") {
    start -= 1;
  }
  const block = lines.slice(start);
  const trailerLine = /^[A-Za-z][A-Za-z0-9-]*:[ \t]*(.*)$/;
  let target = null;
  for (const line of block) {
    if (/^[ \t]/.test(line)) {
      continue; // folded continuation of the previous trailer
    }
    const match = trailerLine.exec(line);
    if (!match) {
      return null; // a prose line — this is not a pure trailer block
    }
    if (line.slice(0, line.indexOf(":")) === "Rollback-Of") {
      target = match[1].trim();
    }
  }
  return target;
}

// Read a tag's annotated message. Returns the message for an annotated tag, or
// null for a lightweight tag — whose ref points straight at a commit object, so
// it carries no message. A null therefore fails closed at the caller: a
// lightweight tag can never satisfy the declared-rollback escape hatch.
async function fetchAnnotatedTagMessage({ repository, tag, token, fetchImpl }) {
  if (typeof repository !== "string" || !repository.includes("/")) {
    throw orderError(`invalid repository ${String(repository)}`);
  }
  if (typeof token !== "string" || !token) {
    throw orderError("GitHub token is required");
  }

  const refResponse = await fetchImpl(
    `https://api.github.com/repos/${repository}/git/ref/tags/${tag}`,
    {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!refResponse.ok) {
    throw orderError(`could not read tag ref ${tag}: HTTP ${refResponse.status}`);
  }
  const ref = await refResponse.json();
  const object = ref?.object;
  if (!object || object.type !== "tag" || typeof object.sha !== "string") {
    // Lightweight tag (object.type === "commit") or an unexpected ref shape.
    return null;
  }

  const tagResponse = await fetchImpl(
    `https://api.github.com/repos/${repository}/git/tags/${object.sha}`,
    {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!tagResponse.ok) {
    throw orderError(
      `could not read tag object for ${tag}: HTTP ${tagResponse.status}`,
    );
  }
  const tagObject = await tagResponse.json();
  return typeof tagObject?.message === "string" ? tagObject.message : null;
}

function toCommitSummaries(commits) {
  return commits.map((entry) => ({
    sha: typeof entry?.sha === "string" ? entry.sha : "",
    title:
      typeof entry?.commit?.message === "string"
        ? entry.commit.message.split("\n", 1)[0]
        : "",
  }));
}

// Enumerate the commits a rollback withdraws — those present in the current
// public latest but absent from the rollback target. The compare endpoint caps
// `commits` at 100 per page, so paginate until the collected count reaches
// `total_commits`; otherwise a rollback of more than one page would silently
// undercount despite the summary promising to list every one. `total_commits`
// is the authoritative count even when the page cap truncates enumeration.
async function fetchWithdrawnCommits({ repository, base, head, token, fetchImpl }) {
  if (typeof repository !== "string" || !repository.includes("/")) {
    throw orderError(`invalid repository ${String(repository)}`);
  }
  if (typeof token !== "string" || !token) {
    throw orderError("GitHub token is required");
  }

  const collected = [];
  let total = 0;
  const maxPages = 100; // hard loop bound: 100 pages * 100 = 10k commits
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/compare/${base}...${head}?per_page=100&page=${page}`,
      {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw orderError(
        `could not compare ${base}...${head}: HTTP ${response.status}`,
      );
    }
    const body = await response.json();
    if (page === 1) {
      total = Number.isInteger(body?.total_commits) ? body.total_commits : 0;
    }
    const commits = Array.isArray(body?.commits) ? body.commits : [];
    collected.push(...commits);
    if (commits.length === 0 || collected.length >= total) {
      break;
    }
  }

  return {
    total: total || collected.length,
    commits: toCommitSummaries(collected),
  };
}

// An emergency rollback stays possible without a workflow or code change: the
// operator annotates the older tag with a machine-readable
// `Rollback-Of: <tag>` trailer that names the EXACT current public latest
// stable tag. Requiring the exact latest tag stops a stale or mechanically
// copied trailer from validating. Returns a declared-rollback result carrying
// the commits being withdrawn when accepted, or null to fail closed.
async function evaluateDeclaredRollback({
  repository,
  targetTag,
  latestTag,
  token,
  fetchImpl,
}) {
  const message = await fetchAnnotatedTagMessage({
    repository,
    tag: targetTag,
    token,
    fetchImpl,
  });
  if (typeof message !== "string") {
    return null;
  }
  if (extractRollbackTarget(message) !== latestTag) {
    return null;
  }

  // The withdrawn fixes are the commits present in the current public latest
  // but absent from the rollback target: compare(target...latest) lists exactly
  // those on its `commits` array.
  const withdrawn = await fetchWithdrawnCommits({
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
    rollbackOf: latestTag,
    withdrawnCount: withdrawn.total,
    withdrawnCommits: withdrawn.commits,
  };
}

// Ancestry gate the numeric order check cannot see. A higher stable version
// number can still carry strictly OLDER code when its tag sits on a commit the
// current public latest already moved past — `verifyStableReleaseOrder`
// compares only the numbers, so such a rollback passes it. This compares commit
// lineage through the GitHub compare API and blocks a stable tag whose commit
// does not contain the current public latest's commit, unless the tag declares
// an explicit rollback.
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

  const compare = await fetchCompareStatus({
    repository,
    base: latestTag,
    head: targetTag,
    token,
    fetchImpl,
  });
  const status = compare?.status;

  if (status === "ahead") {
    return { status: "advance", targetTag, latestTag };
  }
  if (status === "identical") {
    return { status: "rerun", targetTag, latestTag };
  }
  if (status === "behind" || status === "diverged") {
    const declared = await evaluateDeclaredRollback({
      repository,
      targetTag,
      latestTag,
      token,
      fetchImpl,
    });
    if (declared) {
      return declared;
    }
    const behindBy = Number.isInteger(compare?.behind_by)
      ? compare.behind_by
      : "an unknown number of";
    throw orderError(
      `Refusing stable lineage rollback: ${targetTag} is ${status} public latest ` +
        `${latestTag} by ${behindBy} commit(s) and does not contain its code. To ship ` +
        `an intentional rollback, annotate ${targetTag} with a 'Rollback-Of: ${latestTag}' ` +
        `trailer naming the current public latest.`,
    );
  }

  throw orderError(
    `unrecognized compare status '${String(status)}' for ${targetTag} against ${latestTag}`,
  );
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
  const isStableTag = stablePattern.test(targetTag);
  if (makeLatest) {
    stableParts(targetTag);
  } else if (!isStableTag && !prereleasePattern.test(targetTag)) {
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
          isStableTag
            ? `staged stable ${targetTag} unexpectedly became latest before promotion`
            : `prerelease ${targetTag} unexpectedly replaced stable latest`,
        );
      }

      return {
        status: makeLatest
          ? "stable-latest"
          : isStableTag
            ? "staged-not-latest"
            : "prerelease-isolated",
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

// An accepted declared rollback still ships, but never silently: annotate the
// Actions log with a warning and enumerate every withdrawn commit in the job
// summary so the operator sees exactly which merged fixes are leaving stable.
function reportDeclaredRollback(result) {
  const total = result.withdrawnCount;
  const shown = result.withdrawnCommits.length;
  console.log(
    `::warning::Stable ${result.targetTag} is a DECLARED ROLLBACK of public latest ` +
      `${result.latestTag}. Publishing it drops ${total} commit(s) that ${result.latestTag} ` +
      `contains and this rollback does not.`,
  );

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const enumeration =
    shown < total
      ? `It drops ${total} commit(s) that \`${result.latestTag}\` contains and ` +
        `\`${result.targetTag}\` does not (first ${shown} shown):`
      : `It drops the following ${total} commit(s) that \`${result.latestTag}\` contains ` +
        `and \`${result.targetTag}\` does not:`;
  const lines = [
    `### Stable lineage rollback: ${result.targetTag}`,
    "",
    `\`${result.targetTag}\` is publishing as a declared rollback of the current public ` +
      `latest \`${result.latestTag}\`.`,
    enumeration,
    "",
    ...result.withdrawnCommits.map(
      (commit) => `- \`${commit.sha.slice(0, 12)}\` ${commit.title}`,
    ),
    "",
  ];
  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
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
        `No existing stable release; ${result.targetTag} establishes stable lineage.`,
      );
    } else if (result.status === "rerun") {
      console.log(
        `Stable ${result.targetTag} is identical to public latest ${result.latestTag}; allowing intentional rerun.`,
      );
    } else if (result.status === "advance") {
      console.log(
        `Stable ${result.targetTag} descends from public latest ${result.latestTag}; lineage advances.`,
      );
    } else if (result.status === "declared-rollback") {
      reportDeclaredRollback(result);
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
