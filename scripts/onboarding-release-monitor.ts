import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "indigoai-us/hq-desktop-app";
const LATEST_MANIFEST_URL =
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

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, {
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

export async function runMonitor(rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  const version = readProductVersion(
    await readFile(resolve(rootDir, "versions.toml"), "utf8"),
  );
  const manifestResponse = await fetchOk(LATEST_MANIFEST_URL);
  const artifactUrls = validateReleaseManifest(await manifestResponse.json(), version);
  const installPage = await (await fetchOk(INSTALL_PAGE_URL)).text();

  for (const link of INSTALL_LINKS) {
    if (!installPage.includes(link)) {
      throw new Error(`Install page is missing ${link}`);
    }
  }

  for (const url of [...artifactUrls, ...INSTALL_LINKS]) {
    await fetchOk(url, { method: "HEAD" });
  }

  console.log(
    `Onboarding release monitor passed for v${version}: ${REQUIRED_PLATFORMS.length} updater targets and ${INSTALL_LINKS.length} installer links are healthy.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMonitor().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
