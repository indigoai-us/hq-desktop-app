#!/usr/bin/env node

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
