import { describe, expect, it } from "vitest";

import {
  planRelease,
  verifyAssetSet,
  verifyPublishedManifest,
  verifyReleaseContract,
} from "./release-asset-contract.mjs";

const localAssets = Array.from({ length: 21 }, (_, index) => ({
  name: `asset-${String(index).padStart(2, "0")}.bin`,
  size: index + 1,
  digest: `sha256:${index.toString(16).padStart(64, "0")}`,
}));

const remoteAssets = localAssets.map((asset, index) => ({
  id: index + 100,
  name: asset.name,
  size: asset.size,
  digest: asset.digest,
  state: "uploaded",
}));

function release(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    tag_name: "v0.10.35-beta.2",
    name: "HQ v0.10.35-beta.2",
    draft: false,
    prerelease: true,
    assets: remoteAssets,
    ...overrides,
  };
}

const updaterVersion = "0.10.35-beta.2";
const updaterTag = `v${updaterVersion}`;
const updaterRepository = "indigoai-us/hq-desktop-app";
const updaterBase =
  `https://github.com/${updaterRepository}/releases/download/${updaterTag}`;

function validUpdaterManifest() {
  return {
    version: updaterVersion,
    platforms: {
      "darwin-aarch64": {
        signature: "mac-signature",
        url: `${updaterBase}/HQ_${updaterVersion}_universal.app.tar.gz`,
      },
      "darwin-x86_64": {
        signature: "mac-signature",
        url: `${updaterBase}/HQ_${updaterVersion}_universal.app.tar.gz`,
      },
      "windows-x86_64": {
        signature: "x64-signature",
        url: `${updaterBase}/HQ_${updaterVersion}_x64-setup.exe`,
      },
      "windows-aarch64": {
        signature: "arm64-signature",
        url: `${updaterBase}/HQ_${updaterVersion}_arm64-setup.exe`,
      },
      "linux-x86_64-deb": {
        signature: "deb-signature",
        url: `${updaterBase}/HQ_${updaterVersion}_amd64.deb`,
      },
      "linux-x86_64-appimage": {
        signature: "appimage-signature",
        url: `${updaterBase}/HQ_${updaterVersion}_amd64.AppImage`,
      },
      "linux-x86_64": {
        signature: "appimage-signature",
        url: `${updaterBase}/HQ_${updaterVersion}_amd64.AppImage`,
      },
    },
  };
}

// Sidecar lookup shared by the manifest fetch stubs: every `.sig` URL maps to
// the signature its platform entry carries in the manifest above.
function sidecarSignature(url: string, signatures: {
  mac: string;
  x64: string;
  arm64: string;
  deb: string;
  appimage: string;
}) {
  if (url.includes("universal")) return signatures.mac;
  if (url.includes("arm64")) return signatures.arm64;
  if (url.endsWith(".deb.sig")) return signatures.deb;
  if (url.endsWith(".AppImage.sig")) return signatures.appimage;
  return signatures.x64;
}

function manifestFetch(
  manifest: ReturnType<typeof validUpdaterManifest>,
  { mismatchSidecar = false } = {},
) {
  return async (url: string | URL | Request) => {
    const value = String(url);
    if (value.endsWith("/latest.json")) {
      return new Response(JSON.stringify(manifest), { status: 200 });
    }
    if (value.endsWith(".sig")) {
      const signature = sidecarSignature(value, {
        mac: "mac-signature",
        x64: "x64-signature",
        arm64: "arm64-signature",
        deb: "deb-signature",
        appimage: "appimage-signature",
      });
      return new Response(
        mismatchSidecar ? `${signature}-mismatch` : signature,
        { status: 200 },
      );
    }
    return new Response(null, { status: 200 });
  };
}

describe("atomic release asset contract", () => {
  it("plans a new hidden draft when the tag has no release", () => {
    expect(
      planRelease({
        releases: [[]],
        localAssets,
        tag: "v0.10.35-beta.2",
        prerelease: true,
      }),
    ).toEqual({ action: "create-draft" });
  });

  it("resets an existing hidden draft regardless of partial assets", () => {
    expect(
      planRelease({
        releases: [[release({ draft: true, assets: remoteAssets.slice(0, 2) })]],
        localAssets,
        tag: "v0.10.35-beta.2",
        prerelease: true,
      }),
    ).toEqual({ action: "reset-draft", releaseId: "42" });
  });

  it("treats an exact published release as an idempotent success", () => {
    expect(
      planRelease({
        releases: [[release()]],
        localAssets,
        tag: "v0.10.35-beta.2",
        prerelease: true,
      }),
    ).toEqual({ action: "already-published", releaseId: "42" });
  });

  it.each([
    ["missing asset", remoteAssets.slice(0, -1)],
    [
      "unexpected asset",
      [
        ...remoteAssets.slice(0, -1),
        {
          ...remoteAssets.at(-1),
          name: "unexpected.bin",
        },
      ],
    ],
    [
      "zero-size asset",
      remoteAssets.map((asset, index) =>
        index === 0 ? { ...asset, size: 0 } : asset,
      ),
    ],
    [
      "non-uploaded state",
      remoteAssets.map((asset, index) =>
        index === 0 ? { ...asset, state: "new" } : asset,
      ),
    ],
  ])("rejects a published release with a %s", (_label, assets) => {
    expect(() =>
      planRelease({
        releases: [[release({ assets })]],
        localAssets,
        tag: "v0.10.35-beta.2",
        prerelease: true,
      }),
    ).toThrow("Release asset contract failed");
  });

  it("ignores UI hot-update assets attached after publication", () => {
    const withUi = [
      ...remoteAssets,
      { id: 900, name: "ui-0.10.35-beta.2.tar.gz", size: 9, digest: `sha256:${"e".repeat(64)}`, state: "uploaded" },
      { id: 901, name: "ui-0.10.35-beta.2.tar.gz.sig", size: 9, digest: `sha256:${"e".repeat(64)}`, state: "uploaded" },
      { id: 902, name: "ui-manifest.json", size: 9, digest: `sha256:${"e".repeat(64)}`, state: "uploaded" },
    ];
    expect(
      planRelease({
        releases: [[release({ assets: withUi })]],
        localAssets,
        tag: "v0.10.35-beta.2",
        prerelease: true,
      }),
    ).toEqual({ action: "already-published", releaseId: "42" });
    // The exemption is narrow: other extra assets still fail the contract.
    expect(() =>
      verifyAssetSet(localAssets, [...withUi, { ...remoteAssets[0], id: 903, name: "ui-extra.bin" }]),
    ).toThrow("Release asset contract failed");
  });

  it("accepts nondeterministic byte changes on an otherwise healthy published rerun", () => {
    const rebuilt = remoteAssets.map((asset) => ({
      ...asset,
      size: asset.size + 100,
      digest: `sha256:${"f".repeat(64)}`,
    }));
    expect(
      planRelease({
        releases: [[release({ assets: rebuilt })]],
        localAssets,
        tag: "v0.10.35-beta.2",
        prerelease: true,
      }),
    ).toEqual({ action: "already-published", releaseId: "42" });
  });

  it("rejects duplicate asset names", () => {
    const duplicate = remoteAssets.map((asset, index) =>
      index === 1 ? { ...asset, name: remoteAssets[0].name } : asset,
    );
    expect(() => verifyAssetSet(localAssets, duplicate)).toThrow(
      "remote asset names are not unique",
    );
  });

  it("rejects ambiguous releases with the same tag", () => {
    expect(() =>
      planRelease({
        releases: [[release(), release({ id: 43 })]],
        localAssets,
        tag: "v0.10.35-beta.2",
        prerelease: true,
      }),
    ).toThrow("found 2 releases");
  });

  it("rejects published metadata on a hidden-draft verification", () => {
    expect(() =>
      verifyReleaseContract({
        release: release(),
        remoteAssets: [remoteAssets],
        localAssets,
        tag: "v0.10.35-beta.2",
        prerelease: true,
        draft: true,
        matchBytes: true,
      }),
    ).toThrow("release draft=false does not match true");
  });

  it("rejects a prerelease classification mismatch before mutation", () => {
    expect(() =>
      planRelease({
        releases: [[release({ draft: true, prerelease: false })]],
        localAssets,
        tag: "v0.10.35-beta.2",
        prerelease: true,
      }),
    ).toThrow("release prerelease=false does not match true");
  });

  it("resumes a staged stable public prerelease at promote-pending", () => {
    expect(
      planRelease({
        releases: [[
          release({
            tag_name: "v0.10.179",
            name: "HQ v0.10.179",
            draft: false,
            prerelease: true,
          }),
        ]],
        localAssets,
        tag: "v0.10.179",
        prerelease: true,
        stagedStable: true,
      }),
    ).toEqual({ action: "promote-pending", releaseId: "42" });
  });

  it("treats a promoted staged stable release as already-published", () => {
    expect(
      planRelease({
        releases: [[
          release({
            tag_name: "v0.10.179",
            name: "HQ v0.10.179",
            draft: false,
            prerelease: false,
          }),
        ]],
        localAssets,
        tag: "v0.10.179",
        prerelease: true,
        stagedStable: true,
      }),
    ).toEqual({ action: "already-published", releaseId: "42" });
  });

  it.each([
    [
      "wrong size",
      remoteAssets.map((asset, index) =>
        index === 0 ? { ...asset, size: asset.size + 1 } : asset,
      ),
    ],
    [
      "wrong digest",
      remoteAssets.map((asset, index) =>
        index === 0
          ? { ...asset, digest: `sha256:${"f".repeat(64)}` }
          : asset,
      ),
    ],
  ])("rejects a hidden draft with a %s", (_label, assets) => {
    expect(() =>
      verifyReleaseContract({
        release: release({ draft: true, assets }),
        remoteAssets: [assets],
        localAssets,
        tag: "v0.10.35-beta.2",
        prerelease: true,
        draft: true,
        matchBytes: true,
      }),
    ).toThrow("Release asset contract failed");
  });

  it("verifies the public seven-platform updater manifest and sidecars", async () => {
    const version = "0.10.35-beta.2";
    const tag = `v${version}`;
    const repository = "indigoai-us/hq-desktop-app";
    const base = `https://github.com/${repository}/releases/download/${tag}`;
    const signatures = {
      mac: "mac-signature",
      x64: "x64-signature",
      arm64: "arm64-signature",
      deb: "deb-signature",
      appimage: "appimage-signature",
    };
    const manifest = {
      version,
      platforms: {
        "darwin-aarch64": {
          signature: signatures.mac,
          url: `${base}/HQ_${version}_universal.app.tar.gz`,
        },
        "darwin-x86_64": {
          signature: signatures.mac,
          url: `${base}/HQ_${version}_universal.app.tar.gz`,
        },
        "windows-x86_64": {
          signature: signatures.x64,
          url: `${base}/HQ_${version}_x64-setup.exe`,
        },
        "windows-aarch64": {
          signature: signatures.arm64,
          url: `${base}/HQ_${version}_arm64-setup.exe`,
        },
        "linux-x86_64-deb": {
          signature: signatures.deb,
          url: `${base}/HQ_${version}_amd64.deb`,
        },
        "linux-x86_64-appimage": {
          signature: signatures.appimage,
          url: `${base}/HQ_${version}_amd64.AppImage`,
        },
        "linux-x86_64": {
          signature: signatures.appimage,
          url: `${base}/HQ_${version}_amd64.AppImage`,
        },
      },
    };
    const fetchImpl = async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/latest.json")) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      if (value.endsWith(".sig")) {
        return new Response(sidecarSignature(value, signatures), {
          status: 200,
        });
      }
      return new Response(null, { status: 200 });
    };

    await expect(
      verifyPublishedManifest({
        repository,
        tag,
        version,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({
      version,
      platforms: [
        "darwin-aarch64",
        "darwin-x86_64",
        "linux-x86_64",
        "linux-x86_64-appimage",
        "linux-x86_64-deb",
        "windows-aarch64",
        "windows-x86_64",
      ],
    });
  });

  it.each([
    {
      label: "missing platform",
      mutate: (manifest: ReturnType<typeof validUpdaterManifest>) => {
        delete (
          manifest.platforms as Partial<typeof manifest.platforms>
        )["windows-aarch64"];
      },
      expected: "latest.json platforms",
      mismatchSidecar: false,
    },
    {
      label: "missing Linux platform",
      mutate: (manifest: ReturnType<typeof validUpdaterManifest>) => {
        delete (
          manifest.platforms as Partial<typeof manifest.platforms>
        )["linux-x86_64-deb"];
      },
      expected: "latest.json platforms",
      mismatchSidecar: false,
    },
    {
      label: "version-pinned URL drift",
      mutate: (manifest: ReturnType<typeof validUpdaterManifest>) => {
        manifest.platforms["windows-x86_64"].url =
          `${updaterBase}/HQ_x64-setup.exe`;
      },
      expected: "URL does not match",
      mismatchSidecar: false,
    },
    {
      label: "Linux alias URL drift",
      mutate: (manifest: ReturnType<typeof validUpdaterManifest>) => {
        manifest.platforms["linux-x86_64"].url =
          `${updaterBase}/HQ_amd64.AppImage`;
      },
      expected: "URL does not match",
      mismatchSidecar: false,
    },
    {
      label: "deb entry pointing at the AppImage",
      mutate: (manifest: ReturnType<typeof validUpdaterManifest>) => {
        manifest.platforms["linux-x86_64-deb"].url =
          `${updaterBase}/HQ_${updaterVersion}_amd64.AppImage`;
      },
      expected: "URL does not match",
      mismatchSidecar: false,
    },
    {
      label: "empty signature",
      mutate: (manifest: ReturnType<typeof validUpdaterManifest>) => {
        manifest.platforms["darwin-aarch64"].signature = "";
      },
      expected: "has an empty signature",
      mismatchSidecar: false,
    },
    {
      label: "signature sidecar mismatch",
      mutate: (_manifest: ReturnType<typeof validUpdaterManifest>) => {},
      expected: "signature sidecar mismatch",
      mismatchSidecar: true,
    },
  ])("rejects a public manifest with $label", async ({
    mutate,
    expected,
    mismatchSidecar,
  }) => {
    const manifest = validUpdaterManifest();
    mutate(manifest);

    await expect(
      verifyPublishedManifest({
        repository: updaterRepository,
        tag: updaterTag,
        version: updaterVersion,
        fetchImpl: manifestFetch(manifest, {
          mismatchSidecar,
        }) as typeof fetch,
        attempts: 1,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(expected);
  });

  it("retries while newly published assets propagate", async () => {
    const version = "0.10.35-beta.2";
    const tag = `v${version}`;
    const repository = "indigoai-us/hq-desktop-app";
    const base = `https://github.com/${repository}/releases/download/${tag}`;
    const manifest = {
      version,
      platforms: {
        "darwin-aarch64": {
          signature: "mac",
          url: `${base}/HQ_${version}_universal.app.tar.gz`,
        },
        "darwin-x86_64": {
          signature: "mac",
          url: `${base}/HQ_${version}_universal.app.tar.gz`,
        },
        "windows-x86_64": {
          signature: "x64",
          url: `${base}/HQ_${version}_x64-setup.exe`,
        },
        "windows-aarch64": {
          signature: "arm64",
          url: `${base}/HQ_${version}_arm64-setup.exe`,
        },
        "linux-x86_64-deb": {
          signature: "deb",
          url: `${base}/HQ_${version}_amd64.deb`,
        },
        "linux-x86_64-appimage": {
          signature: "appimage",
          url: `${base}/HQ_${version}_amd64.AppImage`,
        },
        "linux-x86_64": {
          signature: "appimage",
          url: `${base}/HQ_${version}_amd64.AppImage`,
        },
      },
    };
    let calls = 0;
    const fetchImpl = async (url: string | URL | Request) => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 404 });
      const value = String(url);
      if (value.endsWith("/latest.json")) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      if (value.endsWith(".sig")) {
        return new Response(
          sidecarSignature(value, {
            mac: "mac",
            x64: "x64",
            arm64: "arm64",
            deb: "deb",
            appimage: "appimage",
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 200 });
    };

    await expect(
      verifyPublishedManifest({
        repository,
        tag,
        version,
        fetchImpl: fetchImpl as typeof fetch,
        attempts: 2,
        retryDelayMs: 0,
      }),
    ).resolves.toMatchObject({ version });
    expect(calls).toBeGreaterThan(1);
  });
});
