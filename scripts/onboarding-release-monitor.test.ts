import { describe, expect, it } from "vitest";
import {
  readProductVersion,
  validateReleaseManifest,
} from "./onboarding-release-monitor";

const version = "0.10.26";
const macUrl =
  `https://github.com/indigoai-us/hq-desktop-app/releases/download/v${version}/HQ_${version}_universal.app.tar.gz`;

function manifest() {
  return {
    version,
    platforms: {
      "darwin-aarch64": { signature: "mac-signature", url: macUrl },
      "darwin-x86_64": { signature: "mac-signature", url: macUrl },
      "windows-x86_64": {
        signature: "x64-signature",
        url: `https://github.com/indigoai-us/hq-desktop-app/releases/download/v${version}/HQ_${version}_x64-setup.exe`,
      },
      "windows-aarch64": {
        signature: "arm64-signature",
        url: `https://github.com/indigoai-us/hq-desktop-app/releases/download/v${version}/HQ_${version}_arm64-setup.exe`,
      },
    },
  };
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
