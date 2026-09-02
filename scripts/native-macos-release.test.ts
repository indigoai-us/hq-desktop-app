import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  SPARKLE_VALIDATION_PUBLIC_KEY,
  archiveNameForRelease,
  assertPublishableNativeBundle,
  channelsReceivingRelease,
  classifyNativeReleaseTag,
  createLegacyLatestManifest,
  parseSparkleSigningOutput,
  renderSparkleAppcast,
  sparkleFeedTag,
  sparkleFeedURL,
  sparklePublicKeyFromPrivateSeed,
} from "./native-macos-release";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureAppcast = join(
  scriptsDirectory,
  "../apps/native-macos/Release/Fixtures/stable-appcast.xml",
);
const fixturePublicKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const fixtureSignature =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const fixturePrivateSeed = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const derivedFixturePublicKey = "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";

describe("native macOS release bridge", () => {
  it("classifies only the three approved tag shapes", () => {
    expect(classifyNativeReleaseTag("v1.2.3")).toEqual({
      tag: "v1.2.3",
      version: "1.2.3",
      channel: "stable",
    });
    expect(classifyNativeReleaseTag("v1.2.3-beta.4")).toEqual({
      tag: "v1.2.3-beta.4",
      version: "1.2.3-beta.4",
      channel: "beta",
    });
    expect(classifyNativeReleaseTag("v1.2.3-alpha.5")).toEqual({
      tag: "v1.2.3-alpha.5",
      version: "1.2.3-alpha.5",
      channel: "alpha",
    });

    for (const invalidTag of [
      "1.2.3",
      "v1.2",
      "v1.2.3-rc.1",
      "v1.2.3-beta",
      "v1.2.3-alpha.0",
      "v01.2.3",
    ]) {
      expect(() => classifyNativeReleaseTag(invalidTag)).toThrow(
        "Unsupported release tag",
      );
    }
  });

  it("updates only feeds allowed to see the release channel", () => {
    expect(channelsReceivingRelease("stable")).toEqual([
      "stable",
      "beta",
      "alpha",
    ]);
    expect(channelsReceivingRelease("beta")).toEqual(["beta", "alpha"]);
    expect(channelsReceivingRelease("alpha")).toEqual(["alpha"]);
  });

  it("uses durable public GitHub release assets for every channel feed", () => {
    expect(sparkleFeedTag("stable")).toBe("sparkle-stable");
    expect(sparkleFeedTag("beta")).toBe("sparkle-beta");
    expect(sparkleFeedTag("alpha")).toBe("sparkle-alpha");
    expect(sparkleFeedURL("stable")).toBe(
      "https://github.com/indigoai-us/hq-desktop-app/releases/download/sparkle-stable/appcast.xml",
    );
    expect(sparkleFeedURL("beta")).toBe(
      "https://github.com/indigoai-us/hq-desktop-app/releases/download/sparkle-beta/appcast.xml",
    );
    expect(sparkleFeedURL("alpha")).toBe(
      "https://github.com/indigoai-us/hq-desktop-app/releases/download/sparkle-alpha/appcast.xml",
    );
  });

  it("uses one truthful aarch64 archive and one legacy macOS platform entry", () => {
    const archiveName = archiveNameForRelease("0.11.0-beta.2");
    expect(archiveName).toBe("HQ_0.11.0-beta.2_aarch64.app.tar.gz");
    expect(archiveName).not.toMatch(/universal|x86_64/i);

    const manifest = createLegacyLatestManifest({
      tag: "v0.11.0-beta.2",
      archiveURL:
        `https://github.com/indigoai-us/hq-desktop-app/releases/download/` +
        `v0.11.0-beta.2/${archiveName}`,
      legacySignature: "legacy-minisign-fixture",
      publicationDate: new Date("2026-07-26T18:00:00Z"),
      notesURL:
        "https://github.com/indigoai-us/hq-desktop-app/releases/tag/v0.11.0-beta.2",
    });

    expect(manifest.platforms).toEqual({
      "darwin-aarch64": {
        signature: "legacy-minisign-fixture",
        url:
          "https://github.com/indigoai-us/hq-desktop-app/releases/download/" +
          "v0.11.0-beta.2/HQ_0.11.0-beta.2_aarch64.app.tar.gz",
      },
    });
    expect(manifest.platforms).not.toHaveProperty("darwin-x86_64");
  });

  it("parses Sparkle's EdDSA signature output without accepting partial data", () => {
    expect(
      parseSparkleSigningOutput(
        `sparkle:edSignature="${fixtureSignature}" length="4242"`,
      ),
    ).toEqual({ signature: fixtureSignature, length: 4242 });

    expect(() => parseSparkleSigningOutput("length=\"4242\"")).toThrow(
      "Invalid Sparkle sign_update output",
    );
    expect(() =>
      parseSparkleSigningOutput(
        `sparkle:edSignature="${fixtureSignature}" length="0"`,
      ),
    ).toThrow("Invalid Sparkle sign_update output");
  });

  it("derives and validates the public key for the production signing seed", () => {
    expect(sparklePublicKeyFromPrivateSeed(fixturePrivateSeed)).toBe(
      derivedFixturePublicKey,
    );
    expect(() => sparklePublicKeyFromPrivateSeed("not-a-private-key")).toThrow(
      "32-byte Ed25519 seed",
    );
  });

  it("renders the fixture appcast with the bundle build as sparkle:version", () => {
    const appcast = renderSparkleAppcast({
      channel: "stable",
      release: classifyNativeReleaseTag("v0.11.0"),
      buildVersion: "11000",
      archiveURL:
        "https://github.com/indigoai-us/hq-desktop-app/releases/download/" +
        "v0.11.0/HQ_0.11.0_aarch64.app.tar.gz",
      archiveLength: 4242,
      sparkleSignature: fixtureSignature,
      publicationDate: new Date("2026-07-26T18:00:00Z"),
      releaseNotesURL:
        "https://github.com/indigoai-us/hq-desktop-app/releases/tag/v0.11.0",
    });

    expect(appcast).toBe(readFileSync(fixtureAppcast, "utf8"));
    expect(appcast).toContain('sparkle:version="11000"');
    expect(appcast).toContain('sparkle:shortVersionString="0.11.0"');
    expect(appcast).not.toContain("universal");
  });

  it("rejects validation, unsigned, wrong-identity, and mislabeled bundles", () => {
    const publishable = {
      appName: "HQ.app",
      bundleIdentifier: "ai.indigo.hq-sync-menubar",
      shortVersion: "0.11.0",
      buildVersion: "11000",
      feedURL: sparkleFeedURL("stable"),
      publicKey: fixturePublicKey,
      validationOnly: false,
      appArchitectures: ["arm64"],
      sidecarArchitectures: ["arm64"],
      recallHelperArchitectures: ["arm64"],
      recallRuntimeMachOCount: 4,
      recallRuntimeSigned: true,
      recallRuntimeEntitlementsValid: true,
      sparkleRuntimeMachOCount: 5,
      sparkleRuntimeArm64Only: true,
      sparkleRuntimeSigned: true,
      hostEntitlementsEmpty: true,
      sidecarEntitlementsEmpty: true,
      signedWithDeveloperID: true,
      notarizationStapled: true,
      containsTauriRuntime: false,
      containsNodeRuntime: false,
      containsBundledWebAssets: false,
      hostLinksWebKit: false,
      sidecarLinksWebKit: false,
      recallRuntimeLinksWebKit: false,
      sparkleVersion: "2.9.2",
    } as const;

    expect(() => assertPublishableNativeBundle(publishable)).not.toThrow();
    expect(() =>
      assertPublishableNativeBundle({
        ...publishable,
        validationOnly: true,
        publicKey: SPARKLE_VALIDATION_PUBLIC_KEY,
      }),
    ).toThrow("validation-only");
    expect(() =>
      assertPublishableNativeBundle({
        ...publishable,
        appArchitectures: ["arm64", "x86_64"],
      }),
    ).toThrow("exactly arm64");
    expect(() =>
      assertPublishableNativeBundle({
        ...publishable,
        containsTauriRuntime: true,
      }),
    ).toThrow("Tauri");
    expect(() =>
      assertPublishableNativeBundle({
        ...publishable,
        containsNodeRuntime: true,
      }),
    ).toThrow("Node.js");
    expect(() =>
      assertPublishableNativeBundle({
        ...publishable,
        hostLinksWebKit: true,
      }),
    ).toThrow("HQ executable");
    expect(() =>
      assertPublishableNativeBundle({
        ...publishable,
        recallRuntimeSigned: false,
      }),
    ).toThrow("Every Recall runtime Mach-O");
    expect(() =>
      assertPublishableNativeBundle({
        ...publishable,
        recallRuntimeEntitlementsValid: false,
      }),
    ).toThrow("capture entitlements");
    expect(() =>
      assertPublishableNativeBundle({
        ...publishable,
        sparkleRuntimeArm64Only: false,
      }),
    ).toThrow("Sparkle runtime");
    expect(() =>
      assertPublishableNativeBundle({
        ...publishable,
        sparkleRuntimeSigned: false,
      }),
    ).toThrow("Every Sparkle runtime Mach-O");
    expect(() =>
      assertPublishableNativeBundle({
        ...publishable,
        hostEntitlementsEmpty: false,
      }),
    ).toThrow("HQ host");
    expect(() =>
      assertPublishableNativeBundle({
        ...publishable,
        sidecarEntitlementsEmpty: false,
      }),
    ).toThrow("engine sidecar");
    expect(() =>
      assertPublishableNativeBundle({
        ...publishable,
        recallRuntimeLinksWebKit: true,
      }),
    ).toThrow("Recall runtime");
    expect(() =>
      assertPublishableNativeBundle({
        ...publishable,
        sparkleVersion: "2.9.1",
      }),
    ).toThrow("Sparkle 2.9.2");
  });
});
