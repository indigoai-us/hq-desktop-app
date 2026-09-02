import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  prepareNativeMacOSRelease,
  releaseInputsFromEnvironment,
  type NativeReleaseProcessRunner,
} from "./prepare-native-macos-release";
import {
  sparkleFeedURL,
  type PublishableNativeBundle,
} from "./native-macos-release";

const sparklePrivateKeyFixture =
  "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const sparklePublicKeyFixture =
  "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";
const sparkleSignature =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

describe("native macOS release preparation", () => {
  it("creates legacy and Sparkle metadata from the same aarch64 archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "prepare-native-release-"));
    const appPath = join(root, "HQ.app");
    const outputDirectory = join(root, "output");
    await mkdir(appPath);
    const calls: Array<{
      command: string;
      args: string[];
      stdin?: string;
    }> = [];
    const runner = fixtureRunner(calls);

    const result = await prepareNativeMacOSRelease(
      {
        appPath,
        outputDirectory,
        tag: "v0.11.0",
        repository: "indigoai-us/hq-desktop-app",
        publicationDate: new Date("2026-07-26T18:00:00Z"),
        sparklePrivateKey: sparklePrivateKeyFixture,
        sparkleSignUpdateBinary: "/fixture/Sparkle-2.9.2/bin/sign_update",
        tauriSigningPrivateKey: "fixture-tauri-key",
        tauriSigningPrivateKeyPassword: "fixture-tauri-password",
      },
      {
        inspectBundle: async () => publishableBundle,
        runProcess: runner,
      },
    );

    expect(result.archiveName).toBe("HQ_0.11.0_aarch64.app.tar.gz");
    expect(result.channels).toEqual(["stable", "beta", "alpha"]);
    expect(result.publishingEnabled).toBe(false);
    const legacy = JSON.parse(
      await readFile(join(outputDirectory, "latest.json"), "utf8"),
    );
    expect(Object.keys(legacy.platforms)).toEqual(["darwin-aarch64"]);
    expect(legacy.platforms["darwin-aarch64"].url).toContain(
      result.archiveName,
    );

    for (const channel of result.channels) {
      const appcast = await readFile(
        join(outputDirectory, "feeds", channel, "appcast.xml"),
        "utf8",
      );
      expect(appcast).toContain('sparkle:version="11000"');
      expect(appcast).toContain('sparkle:shortVersionString="0.11.0"');
      expect(appcast).toContain(result.archiveName);
    }

    const tarCall = calls.find((call) => call.command === "/usr/bin/tar");
    expect(
      tarCall?.args.some((argument) =>
        argument.endsWith("HQ_0.11.0_aarch64.app.tar.gz")
      ),
    ).toBe(true);
    expect(tarCall?.args.join(" ")).not.toMatch(/universal|x86_64/i);
    const sparkleCall = calls.find((call) =>
      call.command.endsWith("sign_update")
    );
    expect(sparkleCall?.args).toContain("--ed-key-file");
    expect(sparkleCall?.args).toContain("-");
    expect(sparkleCall?.args).not.toContain(sparklePrivateKeyFixture);
    expect(sparkleCall?.stdin).toBe(sparklePrivateKeyFixture);
  });

  it("refuses a tag whose display version differs from the built bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "prepare-native-release-"));
    await expect(
      prepareNativeMacOSRelease(
        {
          appPath: join(root, "HQ.app"),
          outputDirectory: join(root, "output"),
          tag: "v0.12.0",
          repository: "indigoai-us/hq-desktop-app",
          publicationDate: new Date("2026-07-26T18:00:00Z"),
          sparklePrivateKey: sparklePrivateKeyFixture,
          sparkleSignUpdateBinary: "/fixture/sign_update",
          tauriSigningPrivateKey: "fixture-tauri-key",
        },
        {
          inspectBundle: async () => publishableBundle,
          runProcess: async () => ({ stdout: "", stderr: "" }),
        },
      ),
    ).rejects.toThrow("does not match bundle version");
  });

  it("refuses a Sparkle private key that does not match the built app", async () => {
    const root = await mkdtemp(join(tmpdir(), "prepare-native-release-"));
    await expect(
      prepareNativeMacOSRelease(
        {
          appPath: join(root, "HQ.app"),
          outputDirectory: join(root, "output"),
          tag: "v0.11.0",
          repository: "indigoai-us/hq-desktop-app",
          publicationDate: new Date("2026-07-26T18:00:00Z"),
          sparklePrivateKey:
            "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=",
          sparkleSignUpdateBinary: "/fixture/sign_update",
          tauriSigningPrivateKey: "fixture-tauri-key",
        },
        {
          inspectBundle: async () => publishableBundle,
          runProcess: async () => ({ stdout: "", stderr: "" }),
        },
      ),
    ).rejects.toThrow("does not match the public key embedded in HQ.app");
  });

  it("fails closed when any external signing input is absent", () => {
    expect(() =>
      releaseInputsFromEnvironment({
        HQ_NATIVE_APP_PATH: "/tmp/HQ.app",
        HQ_RELEASE_OUTPUT_DIR: "/tmp/release",
        HQ_RELEASE_TAG: "v0.11.0",
        HQ_RELEASE_REPOSITORY: "indigoai-us/hq-desktop-app",
      }),
    ).toThrow(
      "SPARKLE_ED_PRIVATE_KEY, SPARKLE_SIGN_UPDATE_BIN, and TAURI_SIGNING_PRIVATE_KEY",
    );
  });
});

const publishableBundle: PublishableNativeBundle = {
  appName: "HQ.app",
  bundleIdentifier: "ai.indigo.hq-sync-menubar",
  shortVersion: "0.11.0",
  buildVersion: "11000",
  feedURL: sparkleFeedURL("stable"),
  publicKey: sparklePublicKeyFixture,
  validationOnly: false,
  appArchitectures: ["arm64"],
  sidecarArchitectures: ["arm64"],
  recallHelperArchitectures: ["arm64"],
  recallRuntimeMachOCount: 107,
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
};

function fixtureRunner(
  calls: Array<{ command: string; args: string[]; stdin?: string }>,
): NativeReleaseProcessRunner {
  return async (command, args, options = {}) => {
    calls.push({ command, args, stdin: options.stdin });

    if (command === "/usr/bin/tar") {
      const archive = args[args.indexOf("-czf") + 1];
      await writeFile(archive, Buffer.alloc(4242));
      return { stdout: "", stderr: "" };
    }
    if (basename(command) === "pnpm") {
      const archive = args.at(-1)!;
      await writeFile(`${archive}.sig`, "legacy-minisign-fixture\n");
      return { stdout: "", stderr: "" };
    }
    if (command.endsWith("sign_update")) {
      return {
        stdout:
          `sparkle:edSignature="${sparkleSignature}" length="4242"\n`,
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
}
