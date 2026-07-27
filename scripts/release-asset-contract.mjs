#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_ASSET_COUNT = 15;

function contractError(message) {
  return new Error(`Release asset contract failed: ${message}`);
}

function parseBoolean(value, label) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw contractError(`${label} must be true or false, got ${String(value)}`);
}

function flattenPages(value) {
  if (!Array.isArray(value)) {
    throw contractError("GitHub API response must be an array");
  }
  return value.every(Array.isArray) ? value.flat() : value;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function readLocalReleaseAssets(directory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .sort((a, b) => a.name.localeCompare(b.name));
  const assets = [];

  for (const entry of entries) {
    const filePath = resolve(directory, entry.name);
    const fileStat = await stat(filePath);
    assets.push({
      name: entry.name,
      size: fileStat.size,
      digest: await sha256(filePath),
    });
  }

  return assets;
}

export function verifyAssetSet(
  localAssets,
  remoteAssets,
  { matchBytes = true } = {},
) {
  if (localAssets.length !== EXPECTED_ASSET_COUNT) {
    throw contractError(
      `expected ${EXPECTED_ASSET_COUNT} local assets, found ${localAssets.length}`,
    );
  }

  const localNames = localAssets.map(({ name }) => name);
  if (new Set(localNames).size !== localNames.length) {
    throw contractError("local asset names are not unique");
  }
  for (const local of localAssets) {
    if (!Number.isInteger(local.size) || local.size <= 0) {
      throw contractError(`local asset ${local.name} has invalid size ${local.size}`);
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(local.digest)) {
      throw contractError(`local asset ${local.name} has invalid SHA-256 digest`);
    }
  }

  const remoteNames = remoteAssets.map(({ name }) => name);
  if (new Set(remoteNames).size !== remoteNames.length) {
    throw contractError("remote asset names are not unique");
  }

  const missing = localNames.filter((name) => !remoteNames.includes(name));
  const unexpected = remoteNames.filter((name) => !localNames.includes(name));
  if (
    missing.length ||
    unexpected.length ||
    remoteAssets.length !== localAssets.length
  ) {
    throw contractError(
      `asset mismatch; missing=${missing.join(",") || "none"}; ` +
        `unexpected=${unexpected.join(",") || "none"}; ` +
        `local=${localAssets.length}; remote=${remoteAssets.length}`,
    );
  }

  for (const expected of localAssets) {
    const uploaded = remoteAssets.find(({ name }) => name === expected.name);
    if (uploaded.state !== "uploaded") {
      throw contractError(
        `remote asset ${expected.name} state is ${String(uploaded.state)}`,
      );
    }
    if (!Number.isInteger(uploaded.size) || uploaded.size <= 0) {
      throw contractError(
        `remote asset ${expected.name} has invalid size ${String(uploaded.size)}`,
      );
    }
    if (
      typeof uploaded.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(uploaded.digest)
    ) {
      throw contractError(`remote asset ${expected.name} has invalid SHA-256 digest`);
    }
    if (matchBytes && uploaded.size !== expected.size) {
      throw contractError(
        `remote asset ${expected.name} size ${String(uploaded.size)} ` +
          `does not match local ${expected.size}`,
      );
    }
    if (matchBytes && uploaded.digest !== expected.digest) {
      throw contractError(
        `remote asset ${expected.name} digest ${String(uploaded.digest)} ` +
          `does not match local ${expected.digest}`,
      );
    }
  }
}

function verifyReleaseIdentity(release, { tag, prerelease, draft }) {
  if (!release || typeof release !== "object") {
    throw contractError("release metadata must be an object");
  }
  if (!Number.isInteger(release.id) || release.id <= 0) {
    throw contractError(`release id is invalid: ${String(release.id)}`);
  }
  if (release.tag_name !== tag) {
    throw contractError(
      `release tag ${String(release.tag_name)} does not match ${tag}`,
    );
  }
  if (release.name !== `HQ ${tag}`) {
    throw contractError(
      `release name ${String(release.name)} does not match HQ ${tag}`,
    );
  }
  if (release.prerelease !== prerelease) {
    throw contractError(
      `release prerelease=${String(release.prerelease)} does not match ${prerelease}`,
    );
  }
  if (release.draft !== draft) {
    throw contractError(
      `release draft=${String(release.draft)} does not match ${draft}`,
    );
  }
}

export function planRelease({
  releases,
  localAssets,
  tag,
  prerelease,
}) {
  const matches = flattenPages(releases).filter(
    (release) => release?.tag_name === tag,
  );

  if (matches.length > 1) {
    throw contractError(`found ${matches.length} releases for tag ${tag}`);
  }
  if (matches.length === 0) {
    return { action: "create-draft" };
  }

  const release = matches[0];
  verifyReleaseIdentity(release, {
    tag,
    prerelease,
    draft: Boolean(release.draft),
  });

  if (release.draft) {
    return { action: "reset-draft", releaseId: String(release.id) };
  }

  // A published rerun may rebuild nondeterministic signed/notarized artifacts
  // and latest.json timestamps. Validate its remote-only health and exact names
  // rather than comparing it byte-for-byte with the fresh rebuild.
  verifyAssetSet(localAssets, release.assets ?? [], { matchBytes: false });
  return { action: "already-published", releaseId: String(release.id) };
}

export function verifyReleaseContract({
  release,
  remoteAssets,
  localAssets,
  tag,
  prerelease,
  draft,
  matchBytes,
}) {
  verifyReleaseIdentity(release, { tag, prerelease, draft });
  verifyAssetSet(localAssets, flattenPages(remoteAssets), { matchBytes });
  return { releaseId: String(release.id), assetCount: localAssets.length };
}

async function fetchOk(url, init, fetchImpl) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
    ...init,
    headers: {
      "user-agent": "hq-desktop-release-asset-contract",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw contractError(`${url} returned HTTP ${response.status}`);
  }
  return response;
}

async function verifyPublishedManifestOnce({
  repository,
  tag,
  version,
  fetchImpl,
}) {
  const base = `https://github.com/${repository}/releases/download/${tag}`;
  const response = await fetchOk(`${base}/latest.json`, undefined, fetchImpl);
  const manifest = await response.json();
  const expected = {
    "darwin-aarch64": `HQ_${version}_universal.app.tar.gz`,
    "darwin-x86_64": `HQ_${version}_universal.app.tar.gz`,
    "windows-x86_64": `HQ_${version}_x64-setup.exe`,
    "windows-aarch64": `HQ_${version}_arm64-setup.exe`,
  };

  if (manifest?.version !== version) {
    throw contractError(
      `latest.json version ${String(manifest?.version)} does not match ${version}`,
    );
  }

  const actualPlatforms = Object.keys(manifest.platforms ?? {}).sort();
  const expectedPlatforms = Object.keys(expected).sort();
  if (JSON.stringify(actualPlatforms) !== JSON.stringify(expectedPlatforms)) {
    throw contractError(
      `latest.json platforms ${actualPlatforms.join(",")} do not match ` +
        expectedPlatforms.join(","),
    );
  }

  for (const [platform, asset] of Object.entries(expected)) {
    const entry = manifest.platforms[platform];
    const url = `${base}/${asset}`;
    if (entry.url !== url) {
      throw contractError(`latest.json ${platform} URL does not match ${url}`);
    }
    if (typeof entry.signature !== "string" || !entry.signature.trim()) {
      throw contractError(`latest.json ${platform} has an empty signature`);
    }

    const [assetResponse, signatureResponse] = await Promise.all([
      fetchOk(url, { method: "HEAD" }, fetchImpl),
      fetchOk(`${url}.sig`, undefined, fetchImpl),
    ]);
    void assetResponse;
    if (entry.signature.trim() !== (await signatureResponse.text()).trim()) {
      throw contractError(`latest.json ${platform} signature sidecar mismatch`);
    }
  }

  return { version, platforms: expectedPlatforms };
}

export async function verifyPublishedManifest({
  repository,
  tag,
  version,
  fetchImpl = fetch,
  attempts = 5,
  retryDelayMs = 2_000,
}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verifyPublishedManifestOnce({
        repository,
        tag,
        version,
        fetchImpl,
      });
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
      throw contractError(`invalid CLI arguments near ${String(key)}`);
    }
    values[key.slice(2)] = value;
  }

  return { command, values };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function runCli() {
  const { command, values } = parseArgs(process.argv.slice(2));
  const tag = values.tag;

  if (command === "manifest") {
    if (!values.repository || !tag || !values.version) {
      throw contractError("manifest requires --repository, --tag, and --version");
    }
    const result = await verifyPublishedManifest({
      repository: values.repository,
      tag,
      version: values.version,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const directory = values.directory;
  const prerelease = parseBoolean(values.prerelease, "--prerelease");
  if (!directory || !tag) {
    throw contractError("--directory and --tag are required");
  }
  const localAssets = await readLocalReleaseAssets(directory);

  if (command === "plan") {
    if (!values.releases) {
      throw contractError("plan requires --releases");
    }
    const result = planRelease({
      releases: await readJson(values.releases),
      localAssets,
      tag,
      prerelease,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "verify") {
    if (!values.release || !values.assets) {
      throw contractError("verify requires --release and --assets");
    }
    const result = verifyReleaseContract({
      release: await readJson(values.release),
      remoteAssets: await readJson(values.assets),
      localAssets,
      tag,
      prerelease,
      draft: parseBoolean(values.draft, "--draft"),
      matchBytes: parseBoolean(values["match-bytes"], "--match-bytes"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  throw contractError(`unknown command ${String(command)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
