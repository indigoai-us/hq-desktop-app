import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  inspectNativeReleaseBundle,
  type NativeReleaseCommandRunner,
} from "./verify-native-macos-release";
import { sparkleFeedURL } from "./native-macos-release";

const fixturePublicKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

describe("native macOS release bundle inspection", () => {
  it("derives publishable facts from the signed arm64 app and sidecar", async () => {
    const appPath = await makeBundleFixture();
    const calls: string[] = [];
    const runner = fixtureRunner(calls);

    const bundle = await inspectNativeReleaseBundle(appPath, runner);

    expect(bundle).toMatchObject({
      appName: "HQ.app",
      bundleIdentifier: "ai.indigo.hq-sync-menubar",
      shortVersion: "0.11.0",
      buildVersion: "11000",
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
    });
    expect(calls).toContain("lipo -archs HQ");
    expect(calls).toContain("lipo -archs hq-engine-sidecar");
    expect(calls).toContain("file -b HQ");
    expect(calls).toContain("file -b hq-engine-sidecar");
    expect(calls).toContain("lipo -archs hq-recall-runtime");
    expect(calls).toContain("file -b hq-recall-runtime");
    expect(calls).toContain("otool -D libui_recorder.dylib");
    expect(calls).toContain(
      "codesign --verify --strict --verbose=2 hq-recall-runtime",
    );
    expect(calls).toContain("otool -L hq-recall-runtime");
    expect(calls).toContain("codesign --verify --strict --verbose=2 HQ.app");
    expect(calls).toContain("xcrun stapler validate HQ.app");
    expect(calls).toContain("otool -L HQ");
    expect(calls).toContain("otool -L hq-engine-sidecar");
  });

  it("detects web assets and bundled Tauri or Node runtime files", async () => {
    const appPath = await makeBundleFixture();
    await writeFile(join(appPath, "Contents/Resources/index.html"), "<html>");
    await writeFile(join(appPath, "Contents/Frameworks/libtauri.dylib"), "");
    await symlink("HQ", join(appPath, "Contents/MacOS/node"));

    const bundle = await inspectNativeReleaseBundle(appPath, fixtureRunner([]));

    expect(bundle.containsBundledWebAssets).toBe(true);
    expect(bundle.containsTauriRuntime).toBe(true);
    expect(bundle.containsNodeRuntime).toBe(true);
  });

  it("rejects entitlement leakage onto the host or engine sidecar", async () => {
    const appPath = await makeBundleFixture();
    const runner = fixtureRunner([], undefined, undefined, (path) =>
      path.endsWith("HQ.app")
        ? ["com.apple.security.get-task-allow"]
        : path.endsWith("hq-engine-sidecar")
        ? ["com.apple.security.cs.allow-jit"]
        : recallEntitlementKeys
    );

    const bundle = await inspectNativeReleaseBundle(appPath, runner);

    expect(bundle.hostEntitlementsEmpty).toBe(false);
    expect(bundle.sidecarEntitlementsEmpty).toBe(false);
  });

  it("rejects extra entitlements on the Recall helper", async () => {
    const appPath = await makeBundleFixture();
    const runner = fixtureRunner([], undefined, undefined, (path) =>
      path.endsWith("hq-recall-runtime")
        ? [...recallEntitlementKeys, "com.apple.security.get-task-allow"]
        : []
    );

    const bundle = await inspectNativeReleaseBundle(appPath, runner);

    expect(bundle.recallRuntimeEntitlementsValid).toBe(false);
  });

  it("requires the host, engine, and Recall helper to share one signing team", async () => {
    const appPath = await makeBundleFixture();
    const runner = fixtureRunner(
      [],
      undefined,
      undefined,
      undefined,
      (path) => path.endsWith("hq-engine-sidecar") ? "OTHERTEAM" : "TEAMID",
    );

    const bundle = await inspectNativeReleaseBundle(appPath, runner);

    expect(bundle.signedWithDeveloperID).toBe(false);
  });

  it("rejects a foreign-team Mach-O nested in the Recall runtime", async () => {
    const appPath = await makeBundleFixture();
    const runner = fixtureRunner(
      [],
      undefined,
      undefined,
      undefined,
      (path) =>
        path.endsWith("libui_recorder.dylib") ? "FOREIGNTEAM" : "TEAMID",
    );

    const bundle = await inspectNativeReleaseBundle(appPath, runner);

    expect(bundle.signedWithDeveloperID).toBe(true);
    expect(bundle.recallRuntimeSigned).toBe(false);
  });

  it("rejects a foreign-team Mach-O nested in Sparkle", async () => {
    const appPath = await makeBundleFixture();
    const runner = fixtureRunner(
      [],
      undefined,
      undefined,
      undefined,
      (path) =>
        path.endsWith("/Autoupdate") ? "FOREIGNTEAM" : "TEAMID",
    );

    const bundle = await inspectNativeReleaseBundle(appPath, runner);

    expect(bundle.signedWithDeveloperID).toBe(true);
    expect(bundle.sparkleRuntimeSigned).toBe(false);
  });

  it("allows only Apple's system WebKit linkage inside pinned Sparkle", async () => {
    const appPath = await makeBundleFixture();
    const systemWebKit =
      "/System/Library/Frameworks/WebKit.framework/Versions/A/WebKit";

    await expect(
      inspectNativeReleaseBundle(
        appPath,
        fixtureRunner([], `${systemWebKit}\n`),
      ),
    ).resolves.toMatchObject({
      hostLinksWebKit: false,
      sidecarLinksWebKit: false,
      sparkleVersion: "2.9.2",
    });

    await expect(
      inspectNativeReleaseBundle(
        appPath,
        fixtureRunner(
          [],
          "@rpath/WebKit.framework/Versions/A/WebKit\n",
        ),
      ),
    ).rejects.toThrow(
      "Sparkle may link only Apple's system WebKit framework",
    );
  });

  it("rejects an x86_64 Mach-O anywhere in the Recall runtime", async () => {
    const appPath = await makeBundleFixture();
    const runner = fixtureRunner([], undefined, (path) =>
      path.endsWith("libui_recorder.dylib") ? ["x86_64"] : ["arm64"]
    );

    await expect(inspectNativeReleaseBundle(appPath, runner)).rejects.toThrow(
      "Recall runtime component libui_recorder.dylib is not arm64-only",
    );
  });

  it("rejects a non-relocatable Recall recorder install name", async () => {
    const appPath = await makeBundleFixture();
    const runner = fixtureRunner(
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      "/Users/runner/work/nebula/libui_recorder.dylib",
    );

    await expect(inspectNativeReleaseBundle(appPath, runner)).rejects.toThrow(
      "Recall recorder install name must be @rpath/libui_recorder.dylib",
    );
  });

  it("requires every pinned Sparkle helper to contain a native arm64 slice", async () => {
    const appPath = await makeBundleFixture();
    const runner = fixtureRunner([], undefined, (path) =>
      path.includes("Sparkle.framework") ? ["x86_64"] : ["arm64"]
    );

    const bundle = await inspectNativeReleaseBundle(appPath, runner);

    expect(bundle.sparkleRuntimeArm64Only).toBe(false);
  });
});

async function makeBundleFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "native-release-"));
  const appPath = join(root, "HQ.app");
  const executableDirectory = join(appPath, "Contents/MacOS");
  const resourcesDirectory = join(appPath, "Contents/Resources");
  const frameworksDirectory = join(appPath, "Contents/Frameworks");
  const sparkleResources = join(
    appPath,
    "Contents/Frameworks/Sparkle.framework/Resources",
  );

  await mkdir(executableDirectory, { recursive: true });
  await mkdir(resourcesDirectory, { recursive: true });
  await mkdir(sparkleResources, { recursive: true });
  await writeFile(join(executableDirectory, "HQ"), "fixture");
  await writeFile(join(executableDirectory, "hq-engine-sidecar"), "fixture");
  await writeFile(join(executableDirectory, "hq-recall-runtime"), "fixture");
  await chmod(join(executableDirectory, "HQ"), 0o755);
  await chmod(join(executableDirectory, "hq-engine-sidecar"), 0o755);
  await chmod(join(executableDirectory, "hq-recall-runtime"), 0o755);
  await writeFile(
    join(frameworksDirectory, "liblibbot_desktop_rs.dylib"),
    "fixture",
  );
  await writeFile(join(frameworksDirectory, "libui_recorder.dylib"), "fixture");
  const gstreamerBinary = join(
    frameworksDirectory,
    "GStreamer.framework/Versions/1.0/GStreamer",
  );
  await mkdir(join(gstreamerBinary, ".."), { recursive: true });
  await writeFile(gstreamerBinary, "fixture");
  await writeFile(join(appPath, "Contents/Info.plist"), "fixture plist");
  const sparkleExecutables = [
    join(appPath, "Contents/Frameworks/Sparkle.framework/Sparkle"),
    join(appPath, "Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate"),
    join(
      appPath,
      "Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app/Contents/MacOS/Updater",
    ),
    join(
      appPath,
      "Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Downloader.xpc/Contents/MacOS/Downloader",
    ),
    join(
      appPath,
      "Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Installer.xpc/Contents/MacOS/Installer",
    ),
  ];
  for (const executable of sparkleExecutables) {
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
    await chmod(executable, 0o755);
  }
  await writeFile(join(sparkleResources, "Info.plist"), "fixture plist");
  await writeFile(join(sparkleResources, "ReleaseNotesColorStyle.css"), "");
  return appPath;
}

function fixtureRunner(
  calls: string[],
  sparkleLibraries =
    "/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation\n",
  architecturesFor: (path: string) => string[] = () => ["arm64"],
  entitlementsFor: (path: string) => string[] = (path) =>
    path.endsWith("hq-recall-runtime") ? recallEntitlementKeys : [],
  signingTeamFor: (path: string) => string = () => "TEAMID",
  recorderInstallName = "@rpath/libui_recorder.dylib",
): NativeReleaseCommandRunner {
  return async (command, args) => {
    calls.push(
      [basename(command), ...args.map((argument) => basename(argument))].join(" "),
    );

    if (command.endsWith("plutil")) {
      const key = args[1];
      const values: Record<string, string> = {
        CFBundleIdentifier: "ai.indigo.hq-sync-menubar",
        CFBundleShortVersionString: "0.11.0",
        CFBundleVersion: "11000",
        SUFeedURL: sparkleFeedURL("stable"),
        SUPublicEDKey: fixturePublicKey,
        HQValidationOnlyBuild: "",
      };
      if (args.at(-1)?.includes("Sparkle.framework")) {
        return { stdout: "2.9.2\n", stderr: "" };
      }
      return { stdout: `${values[key] ?? ""}\n`, stderr: "" };
    }
    if (command.endsWith("lipo")) {
      return { stdout: `${architecturesFor(args.at(-1) ?? "").join(" ")}\n`, stderr: "" };
    }
    if (command.endsWith("file")) {
      const path = args.at(-1) ?? "";
      if (/\.(?:css|html|plist)$/i.test(path)) {
        return { stdout: "ASCII text\n", stderr: "" };
      }
      return { stdout: "Mach-O 64-bit executable arm64\n", stderr: "" };
    }
    if (command.endsWith("codesign") && args[0] === "-dv") {
      const signingTeam = signingTeamFor(args.at(-1) ?? "");
      return {
        stdout: "",
        stderr:
          `Authority=Developer ID Application: Indigo (${signingTeam})\n` +
          `TeamIdentifier=${signingTeam}\n` +
          "Timestamp=Jul 26, 2026 at 11:00:00 PM\n" +
          "flags=0x10000(runtime)\n",
      };
    }
    if (command.endsWith("codesign")
        && args[0] === "-d"
        && args.includes("--entitlements")) {
      const entitlementKeys = entitlementsFor(args.at(-1) ?? "");
      return {
        stdout:
          `<plist><dict>${entitlementKeys
            .map((key) => `<key>${key}</key><true/>`)
            .join("")}</dict></plist>`,
        stderr: "",
      };
    }
    if (command.endsWith("otool")) {
      if (args[0] === "-D" && args.at(-1)?.endsWith("libui_recorder.dylib")) {
        return {
          stdout: `${args.at(-1)}:\n${recorderInstallName}\n`,
          stderr: "",
        };
      }
      if (args.at(-1)?.endsWith("/Sparkle")) {
        return { stdout: sparkleLibraries, stderr: "" };
      }
      return {
        stdout:
          "/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation\n",
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
}

const recallEntitlementKeys = [
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.device.audio-input",
];
