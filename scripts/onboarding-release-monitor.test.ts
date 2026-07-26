import { describe, expect, it, vi } from "vitest";
import {
  classifyProductVersion,
  prereleaseManifestUrl,
  readProductVersion,
  runMonitor,
  validateReleaseManifest,
} from "./onboarding-release-monitor";

const version = "0.10.26";
const repository = "indigoai-us/hq-desktop-app";
const stableManifestUrl =
  `https://github.com/${repository}/releases/latest/download/latest.json`;
const installPageUrl = "https://hqforwork.com/install";
const installLinks = [
  `https://github.com/${repository}/releases/latest/download/HQ.dmg`,
  `https://github.com/${repository}/releases/latest/download/HQ_x64-setup.exe`,
];

function manifest(releaseVersion = version) {
  const macUrl =
    `https://github.com/${repository}/releases/download/v${releaseVersion}/HQ_${releaseVersion}_universal.app.tar.gz`;
  return {
    version: releaseVersion,
    platforms: {
      "darwin-aarch64": { signature: "mac-signature", url: macUrl },
      "darwin-x86_64": { signature: "mac-signature", url: macUrl },
      "windows-x86_64": {
        signature: "x64-signature",
        url: `https://github.com/${repository}/releases/download/v${releaseVersion}/HQ_${releaseVersion}_x64-setup.exe`,
      },
      "windows-aarch64": {
        signature: "arm64-signature",
        url: `https://github.com/${repository}/releases/download/v${releaseVersion}/HQ_${releaseVersion}_arm64-setup.exe`,
      },
    },
  };
}

function toml(productVersion: string): string {
  return `[protocol]\nversion = "2"\n\n[product]\nversion = "${productVersion}"\n`;
}

function monitorFetch(stableVersion: string, prereleaseVersion?: string) {
  const calls: Array<{ method: string; url: string }> = [];
  const fetchImpl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });

      if (url === stableManifestUrl && method === "GET") {
        return Response.json(manifest(stableVersion));
      }
      if (
        prereleaseVersion &&
        url === prereleaseManifestUrl(prereleaseVersion) &&
        method === "GET"
      ) {
        return Response.json(manifest(prereleaseVersion));
      }
      if (url === installPageUrl && method === "GET") {
        return new Response(installLinks.join("\n"));
      }
      if (method === "HEAD") {
        return new Response(null, { status: 200 });
      }

      return new Response("unexpected request", { status: 404 });
    },
  ) as typeof fetch;

  return { calls, fetchImpl };
}

async function runMockedMonitor(
  productVersion: string,
  stableVersion: string,
  prereleaseVersion?: string,
) {
  const { calls, fetchImpl } = monitorFetch(stableVersion, prereleaseVersion);
  const log = vi.fn();
  await runMonitor("/virtual/repo", {
    fetch: fetchImpl,
    log,
    readVersionsToml: async () => toml(productVersion),
  });
  return { calls, log };
}

describe("onboarding release monitor", () => {
  it("reads the product version instead of a package or protocol version", () => {
    expect(
      readProductVersion(`\n[protocol]\nversion = "2"\n\n[product]\nversion = "${version}"\n`),
    ).toBe(version);
  });

  it("accepts signed, version-pinned artifacts for every supported platform", () => {
    expect(validateReleaseManifest(manifest(), version)).toHaveLength(3);
  });

  it("keeps stable behavior pinned to the product version", async () => {
    const { calls, log } = await runMockedMonitor(version, version);

    expect(calls).toContainEqual({ method: "GET", url: stableManifestUrl });
    expect(calls.some(({ url }) => url.includes("-beta."))).toBe(false);
    expect(calls.some(({ url }) => url.includes("-alpha."))).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`passed for v${version}`),
    );

    await expect(runMockedMonitor(version, "0.10.25")).rejects.toThrow(
      "does not match",
    );
  });

  it("checks beta against its tag-pinned manifest while stable may remain older", async () => {
    const betaVersion = "0.10.27-beta.1";
    const { calls, log } = await runMockedMonitor(
      betaVersion,
      version,
      betaVersion,
    );

    expect(calls).toContainEqual({ method: "GET", url: stableManifestUrl });
    expect(calls).toContainEqual({
      method: "GET",
      url: prereleaseManifestUrl(betaVersion),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("beta v0.10.27-beta.1"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`stable v${version}`));
  });

  it("checks alpha against its tag-pinned manifest while stable may remain older", async () => {
    const alphaVersion = "0.10.27-alpha.3";
    const { calls, log } = await runMockedMonitor(
      alphaVersion,
      version,
      alphaVersion,
    );

    expect(calls).toContainEqual({ method: "GET", url: stableManifestUrl });
    expect(calls).toContainEqual({
      method: "GET",
      url: prereleaseManifestUrl(alphaVersion),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("alpha v0.10.27-alpha.3"));
  });

  it.each([
    "0.10.27-beta",
    "0.10.27-alpha",
    "0.10.27-rc.1",
    "0.10.27-beta.1.2",
    "0.10.27-beta.one",
    "0.10.27-beta.01",
  ])("rejects malformed or unsupported prerelease %s before fetching", async (productVersion) => {
    expect(() => classifyProductVersion(productVersion)).toThrow(
      "Unsupported product version",
    );
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      runMonitor("/virtual/repo", {
        fetch: fetchImpl,
        readVersionsToml: async () => toml(productVersion),
      }),
    ).rejects.toThrow("Unsupported product version");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a prerelease masquerading as public stable latest", async () => {
    const betaVersion = "0.10.27-beta.1";
    await expect(
      runMockedMonitor(betaVersion, betaVersion, betaVersion),
    ).rejects.toThrow("must be a non-prerelease");
  });

  it("rejects a stale manifest before probing its artifacts", () => {
    expect(() => validateReleaseManifest({ ...manifest(), version: "0.10.25" }, version))
      .toThrow("does not match");
  });

  it("rejects a platform without an updater signature", () => {
    const value = manifest();
    value.platforms["windows-x86_64"].signature = "";

    expect(() => validateReleaseManifest(value, version)).toThrow("has no updater signature");
  });

  it("rejects an artifact URL that is not pinned to the release version", () => {
    const value = manifest();
    value.platforms["windows-aarch64"].url =
      "https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/HQ_arm64-setup.exe";

    expect(() => validateReleaseManifest(value, version)).toThrow("is not version-pinned");
  });
});
