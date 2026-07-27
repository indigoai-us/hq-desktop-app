import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "indigoai-us/hq-desktop-app";
const STABLE_LATEST_MANIFEST_URL =
  `https://github.com/${REPOSITORY}/releases/latest/download/latest.json`;
const INSTALL_PAGE_URL = "https://hqforwork.com/install";
const INSTALL_LINKS = [
  `https://github.com/${REPOSITORY}/releases/latest/download/HQ.dmg`,
  `https://github.com/${REPOSITORY}/releases/latest/download/HQ_x64-setup.exe`,
];
const REQUIRED_PLATFORMS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "windows-x86_64",
  "windows-aarch64",
] as const;

type PlatformRelease = {
  signature?: unknown;
  url?: unknown;
};

type ReleaseManifest = {
  version?: unknown;
  platforms?: unknown;
};

export type ProductReleaseChannel = "stable" | "beta" | "alpha";

export type ProductRelease = {
  channel: ProductReleaseChannel;
  version: string;
};

type MonitorOptions = {
  fetch?: typeof fetch;
  log?: (message: string) => void;
  readVersionsToml?: (path: string) => Promise<string>;
};

const SEMVER_NUMBER = "(?:0|[1-9][0-9]*)";
const STABLE_VERSION_PATTERN = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}$`,
);
const PRERELEASE_VERSION_PATTERN = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}-(beta|alpha)\\.(${SEMVER_NUMBER})$`,
);

export function readProductVersion(text: string): string {
  const header = /^\[product\][^\S\r\n]*$/m.exec(text);
  const remainder = header
    ? text.slice(header.index + header[0].length)
    : "";
  const nextTable = /^\[[^\]]+\][^\S\r\n]*$/m.exec(remainder);
  const product = nextTable
    ? remainder.slice(0, nextTable.index)
    : remainder;
  const version = product && /^version\s*=\s*"([^"]+)"/m.exec(product)?.[1];

  if (!version) {
    throw new Error("versions.toml is missing [product] version");
  }

  return version;
}

export function classifyProductVersion(version: string): ProductRelease {
  if (STABLE_VERSION_PATTERN.test(version)) {
    return { channel: "stable", version };
  }

  const prerelease = PRERELEASE_VERSION_PATTERN.exec(version);
  if (prerelease) {
    return {
      channel: prerelease[1] as Exclude<ProductReleaseChannel, "stable">,
      version,
    };
  }

  throw new Error(
    `Unsupported product version ${version}; expected X.Y.Z, X.Y.Z-beta.N, or X.Y.Z-alpha.N`,
  );
}

export function prereleaseManifestUrl(version: string): string {
  return `https://github.com/${REPOSITORY}/releases/download/v${version}/latest.json`;
}

function releaseManifestVersion(value: unknown): string {
  if (!value || typeof value !== "object") {
    throw new Error("latest.json must contain an object");
  }

  const version = (value as ReleaseManifest).version;
  if (typeof version !== "string") {
    throw new Error("latest.json is missing version");
  }

  return version;
}

export function validateReleaseManifest(value: unknown, version: string): string[] {
  if (!value || typeof value !== "object") {
    throw new Error("latest.json must contain an object");
  }

  const manifest = value as ReleaseManifest;
  if (manifest.version !== version) {
    throw new Error(`latest.json version ${String(manifest.version)} does not match ${version}`);
  }
  if (!manifest.platforms || typeof manifest.platforms !== "object") {
    throw new Error("latest.json is missing platforms");
  }

  const platforms = manifest.platforms as Record<string, PlatformRelease>;
  const urls: string[] = [];

  for (const platform of REQUIRED_PLATFORMS) {
    const release = platforms[platform];
    if (!release || typeof release !== "object") {
      throw new Error(`latest.json is missing ${platform}`);
    }
    if (typeof release.signature !== "string" || release.signature.length === 0) {
      throw new Error(`latest.json ${platform} has no updater signature`);
    }
    if (typeof release.url !== "string") {
      throw new Error(`latest.json ${platform} has no artifact URL`);
    }
    const expectedPrefix =
      `https://github.com/${REPOSITORY}/releases/download/v${version}/HQ_${version}_`;
    if (!release.url.startsWith(expectedPrefix)) {
      throw new Error(`latest.json ${platform} URL is not version-pinned to v${version}`);
    }
    urls.push(release.url);
  }

  return [...new Set(urls)];
}

async function fetchOk(
  url: string,
  init: RequestInit | undefined,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
    ...init,
    headers: {
      "user-agent": "hq-desktop-onboarding-release-monitor",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }

  return response;
}

export async function runMonitor(
  rootDir = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  options: MonitorOptions = {},
) {
  const fetchImpl = options.fetch ?? fetch;
  const log = options.log ?? console.log;
  const readVersionsToml =
    options.readVersionsToml ??
    ((path: string) => readFile(path, "utf8"));
  const product = classifyProductVersion(
    readProductVersion(await readVersionsToml(resolve(rootDir, "versions.toml"))),
  );
  const stableManifestResponse = await fetchOk(
    STABLE_LATEST_MANIFEST_URL,
    undefined,
    fetchImpl,
  );
  const stableManifest = await stableManifestResponse.json();
  const stableVersion = releaseManifestVersion(stableManifest);
  const stableRelease = classifyProductVersion(stableVersion);
  if (stableRelease.channel !== "stable") {
    throw new Error(
      `Public stable latest.json version ${stableVersion} must be a non-prerelease X.Y.Z version`,
    );
  }
  if (product.channel === "stable" && stableVersion !== product.version) {
    throw new Error(
      `latest.json version ${stableVersion} does not match ${product.version}`,
    );
  }

  const stableArtifactUrls = validateReleaseManifest(stableManifest, stableVersion);
  let prereleaseArtifactUrls: string[] = [];
  if (product.channel !== "stable") {
    const manifestResponse = await fetchOk(
      prereleaseManifestUrl(product.version),
      undefined,
      fetchImpl,
    );
    prereleaseArtifactUrls = validateReleaseManifest(
      await manifestResponse.json(),
      product.version,
    );
  }

  const installPage = await (
    await fetchOk(INSTALL_PAGE_URL, undefined, fetchImpl)
  ).text();

  for (const link of INSTALL_LINKS) {
    if (!installPage.includes(link)) {
      throw new Error(`Install page is missing ${link}`);
    }
  }

  const artifactUrls = [
    ...new Set([
      ...stableArtifactUrls,
      ...prereleaseArtifactUrls,
      ...INSTALL_LINKS,
    ]),
  ];
  for (const url of artifactUrls) {
    await fetchOk(url, { method: "HEAD" }, fetchImpl);
  }

  if (product.channel === "stable") {
    log(
      `Onboarding release monitor passed for v${product.version}: ${REQUIRED_PLATFORMS.length} updater targets and ${INSTALL_LINKS.length} installer links are healthy.`,
    );
    return;
  }

  log(
    `Onboarding release monitor passed for ${product.channel} v${product.version} with public stable v${stableVersion}: ${REQUIRED_PLATFORMS.length} stable updater targets, ${REQUIRED_PLATFORMS.length} prerelease updater targets, and ${INSTALL_LINKS.length} installer links are healthy.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMonitor().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
