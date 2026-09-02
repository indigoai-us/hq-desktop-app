import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertPublishableNativeBundle,
  type PublishableNativeBundle,
} from "./native-macos-release";

export type NativeReleaseCommandResult = {
  stdout: string;
  stderr: string;
};

export type NativeReleaseCommandRunner = (
  command: string,
  args: string[],
) => Promise<NativeReleaseCommandResult>;

const execFileAsync = promisify(execFile);
const webAssetExtensions = new Set([".css", ".html", ".js", ".mjs", ".wasm"]);

export async function inspectNativeReleaseBundle(
  appPathInput: string,
  runCommand: NativeReleaseCommandRunner = defaultCommandRunner,
): Promise<PublishableNativeBundle> {
  const appPath = resolve(appPathInput);
  const appName = basename(appPath);
  const contents = join(appPath, "Contents");
  const infoPlist = join(contents, "Info.plist");
  const hostExecutable = join(contents, "MacOS", "HQ");
  const sidecarExecutable = join(contents, "MacOS", "hq-engine-sidecar");
  const recallHelper = join(contents, "MacOS", "hq-recall-runtime");
  const recallBotLibrary = join(
    contents,
    "Frameworks",
    "liblibbot_desktop_rs.dylib",
  );
  const recallRecorderLibrary = join(
    contents,
    "Frameworks",
    "libui_recorder.dylib",
  );
  const gstreamerFramework = join(
    contents,
    "Frameworks",
    "GStreamer.framework",
  );
  const sparkleFramework = join(contents, "Frameworks", "Sparkle.framework");
  const sparkleExecutable = join(sparkleFramework, "Sparkle");
  const sparkleInfoPlist = join(sparkleFramework, "Resources", "Info.plist");
  const sparkleVersionDirectory = join(sparkleFramework, "Versions", "B");
  const sparkleRequiredHelpers = [
    join(sparkleVersionDirectory, "Autoupdate"),
    join(
      sparkleVersionDirectory,
      "Updater.app",
      "Contents",
      "MacOS",
      "Updater",
    ),
    join(
      sparkleVersionDirectory,
      "XPCServices",
      "Downloader.xpc",
      "Contents",
      "MacOS",
      "Downloader",
    ),
    join(
      sparkleVersionDirectory,
      "XPCServices",
      "Installer.xpc",
      "Contents",
      "MacOS",
      "Installer",
    ),
  ];

  await Promise.all([
    access(infoPlist, constants.R_OK),
    access(hostExecutable, constants.R_OK | constants.X_OK),
    access(sidecarExecutable, constants.R_OK | constants.X_OK),
    access(recallHelper, constants.R_OK | constants.X_OK),
    access(recallBotLibrary, constants.R_OK),
    access(recallRecorderLibrary, constants.R_OK),
    access(gstreamerFramework, constants.R_OK),
    access(sparkleExecutable, constants.R_OK | constants.X_OK),
    access(sparkleInfoPlist, constants.R_OK),
    ...sparkleRequiredHelpers.map((helper) =>
      access(helper, constants.R_OK | constants.X_OK)
    ),
  ]);

  const [
    bundleIdentifier,
    shortVersion,
    buildVersion,
    feedURL,
    publicKey,
    validationMarker,
    sparkleVersion,
  ] = await Promise.all([
    readPlistValue(runCommand, infoPlist, "CFBundleIdentifier"),
    readPlistValue(runCommand, infoPlist, "CFBundleShortVersionString"),
    readPlistValue(runCommand, infoPlist, "CFBundleVersion"),
    readPlistValue(runCommand, infoPlist, "SUFeedURL"),
    readPlistValue(runCommand, infoPlist, "SUPublicEDKey"),
    readOptionalPlistValue(runCommand, infoPlist, "HQValidationOnlyBuild"),
    readPlistValue(
      runCommand,
      sparkleInfoPlist,
      "CFBundleShortVersionString",
    ),
  ]);

  const [
    appArchitectures,
    sidecarArchitectures,
    recallHelperArchitectures,
    appFile,
    sidecarFile,
    recallHelperFile,
  ] = await Promise.all([
    readArchitectures(runCommand, hostExecutable),
    readArchitectures(runCommand, sidecarExecutable),
    readArchitectures(runCommand, recallHelper),
    runCommand("/usr/bin/file", ["-b", hostExecutable]),
    runCommand("/usr/bin/file", ["-b", sidecarExecutable]),
    runCommand("/usr/bin/file", ["-b", recallHelper]),
  ]);

  assertArm64MachO(appFile.stdout, "HQ executable");
  assertArm64MachO(sidecarFile.stdout, "HQ engine sidecar");
  assertArm64MachO(recallHelperFile.stdout, "HQ Recall runtime helper");

  const recallCandidates = [
    recallHelper,
    recallBotLibrary,
    recallRecorderLibrary,
    ...(await filesBelow(gstreamerFramework)),
  ];
  const recallFileDescriptions = await Promise.all(
    recallCandidates.map(async (file) => ({
      file,
      description: (await runCommand("/usr/bin/file", ["-b", file])).stdout,
    })),
  );
  const recallMachOs = recallFileDescriptions
    .filter(({ description }) => /Mach-O/.test(description))
    .map(({ file }) => file);
  const recallInspections = await Promise.all(
    recallMachOs.map(async (file) => {
      const [architectures, description, libraries] = await Promise.all([
        readArchitectures(runCommand, file),
        runCommand("/usr/bin/file", ["-b", file]),
        runCommand("/usr/bin/otool", ["-L", file]),
        runCommand("/usr/bin/codesign", [
          "--verify",
          "--strict",
          "--verbose=2",
          file,
        ]),
      ]);
      assertExactlyArm64Runtime(
        architectures,
        description.stdout,
        basename(file),
      );
      const signature = await runCommand("/usr/bin/codesign", [
        "-dv",
        "--verbose=4",
        file,
      ]);
      return { signature, libraries };
    }),
  );
  const recorderInstallName = await runCommand("/usr/bin/otool", [
    "-D",
    recallRecorderLibrary,
  ]);
  const recorderInstallNames = recorderInstallName.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    recorderInstallNames.length !== 1
    || recorderInstallNames[0] !== "@rpath/libui_recorder.dylib"
  ) {
    throw new Error(
      "Recall recorder install name must be @rpath/libui_recorder.dylib",
    );
  }
  const sparkleCandidates = [
    sparkleExecutable,
    ...(await filesBelow(sparkleFramework)),
  ].filter((file, index, files) => files.indexOf(file) === index);
  const sparkleFileDescriptions = await Promise.all(
    sparkleCandidates.map(async (file) => ({
      file,
      description: (await runCommand("/usr/bin/file", ["-b", file])).stdout,
    })),
  );
  const sparkleMachOs = sparkleFileDescriptions
    .filter(({ description }) => /Mach-O/.test(description))
    .map(({ file }) => file);
  const sparkleInspections = await Promise.all(
    sparkleMachOs.map(async (file) => {
      const [architectures, libraries] = await Promise.all([
        readArchitectures(runCommand, file),
        runCommand("/usr/bin/otool", ["-L", file]),
        runCommand("/usr/bin/codesign", [
          "--verify",
          "--strict",
          "--verbose=2",
          file,
        ]),
      ]);
      assertSparkleWebKitExceptionIsNarrow(libraries.stdout);
      const signature = await runCommand("/usr/bin/codesign", [
        "-dv",
        "--verbose=4",
        file,
      ]);
      return { architectures, signature };
    }),
  );

  await Promise.all([
    runCommand("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      appPath,
    ]),
    runCommand("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      sidecarExecutable,
    ]),
    runCommand("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      recallHelper,
    ]),
  ]);
  const [
    appSignature,
    sidecarSignature,
    recallHelperSignature,
    hostEntitlements,
    sidecarEntitlements,
    recallHelperEntitlements,
  ] =
    await Promise.all([
    runCommand("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]),
    runCommand("/usr/bin/codesign", [
      "-dv",
      "--verbose=4",
      sidecarExecutable,
    ]),
    runCommand("/usr/bin/codesign", [
      "-dv",
      "--verbose=4",
      recallHelper,
    ]),
    runCommand("/usr/bin/codesign", [
      "-d",
      "--entitlements",
      "-",
      appPath,
    ]),
    runCommand("/usr/bin/codesign", [
      "-d",
      "--entitlements",
      "-",
      sidecarExecutable,
    ]),
    runCommand("/usr/bin/codesign", [
      "-d",
      "--entitlements",
      "-",
      recallHelper,
    ]),
  ]);
  const primarySignatureDetails = [
    appSignature,
    sidecarSignature,
    recallHelperSignature,
  ].map((result) => `${result.stdout}\n${result.stderr}`);
  const signingTeamIdentifiers = primarySignatureDetails.map(
    (details) => /^TeamIdentifier=(.+)$/m.exec(details)?.[1].trim() ?? "",
  );
  const signedWithDeveloperID = primarySignatureDetails.every(
    (details) => {
      return details.includes("Authority=Developer ID Application:")
        && /\bflags=.*\bruntime\b/.test(details)
        && /^Timestamp=.+$/m.test(details);
    },
  ) && signingTeamIdentifiers.every(
    (teamIdentifier) =>
      teamIdentifier.length > 0
      && teamIdentifier === signingTeamIdentifiers[0],
  );
  const expectedSigningTeam = signingTeamIdentifiers[0];
  const recallRuntimeSigned = recallInspections.every(({ signature }) => {
    const details = `${signature.stdout}\n${signature.stderr}`;
    return details.includes("Authority=Developer ID Application:")
      && /\bflags=.*\bruntime\b/.test(details)
      && /^Timestamp=.+$/m.test(details)
      && /^TeamIdentifier=(.+)$/m.exec(details)?.[1].trim()
        === expectedSigningTeam;
  });
  const sparkleRuntimeArm64Only = sparkleInspections.every(
    ({ architectures }) =>
      architectures.length === 1 && architectures[0] === "arm64",
  );
  const sparkleRuntimeSigned = sparkleInspections.every(({ signature }) => {
    const details = `${signature.stdout}\n${signature.stderr}`;
    return details.includes("Authority=Developer ID Application:")
      && /\bflags=.*\bruntime\b/.test(details)
      && /^Timestamp=.+$/m.test(details)
      && /^TeamIdentifier=(.+)$/m.exec(details)?.[1].trim()
        === expectedSigningTeam;
  });
  const requiredRecallEntitlements = [
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.device.audio-input",
  ];
  const recallEntitlementKeys = entitlementKeys(recallHelperEntitlements);
  const recallRuntimeEntitlementsValid =
    recallEntitlementKeys.size === requiredRecallEntitlements.length
    && requiredRecallEntitlements.every((entitlement) =>
      recallEntitlementKeys.has(entitlement)
      && entitlementIsTrue(recallHelperEntitlements, entitlement)
    );
  const hostEntitlementsEmpty = entitlementKeys(hostEntitlements).size === 0;
  const sidecarEntitlementsEmpty =
    entitlementKeys(sidecarEntitlements).size === 0;

  let notarizationStapled = true;
  try {
    await runCommand("/usr/bin/xcrun", ["stapler", "validate", appPath]);
  } catch {
    notarizationStapled = false;
  }

  const [hostLibraries, sidecarLibraries, bundleFiles] =
    await Promise.all([
      runCommand("/usr/bin/otool", ["-L", hostExecutable]),
      runCommand("/usr/bin/otool", ["-L", sidecarExecutable]),
      filesBelow(appPath),
    ]);

  const relativeFiles = bundleFiles.map((file) => relative(appPath, file));
  const containsTauriRuntime = relativeFiles.some((file) =>
    /tauri|wry|webview2|node_modules|app\.asar/i.test(file)
  );
  const containsNodeRuntime = relativeFiles.some((file) =>
    /(^|\/)(?:node|nodejs)(?:\.exe)?$/i.test(file)
    || /(^|\/)(?:libnode(?:\.\d+)*\.(?:dylib|so)|node\.framework)(?:\/|$)/i
      .test(file)
  );
  const containsBundledWebAssets = relativeFiles.some((file) => {
    if (file.startsWith("Contents/Frameworks/Sparkle.framework/")) {
      return false;
    }
    const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
    return webAssetExtensions.has(extension)
      || /(^|\/)(dist|node_modules)(\/|$)/i.test(file);
  });

  return {
    appName,
    bundleIdentifier,
    shortVersion,
    buildVersion,
    feedURL,
    publicKey,
    validationOnly: validationMarker === "1",
    appArchitectures,
    sidecarArchitectures,
    recallHelperArchitectures,
    recallRuntimeMachOCount: recallMachOs.length,
    recallRuntimeSigned,
    recallRuntimeEntitlementsValid,
    sparkleRuntimeMachOCount: sparkleMachOs.length,
    sparkleRuntimeArm64Only,
    sparkleRuntimeSigned,
    hostEntitlementsEmpty,
    sidecarEntitlementsEmpty,
    signedWithDeveloperID,
    notarizationStapled,
    containsTauriRuntime,
    containsNodeRuntime,
    containsBundledWebAssets,
    hostLinksWebKit: linksWebKit(hostLibraries.stdout),
    sidecarLinksWebKit: linksWebKit(sidecarLibraries.stdout),
    recallRuntimeLinksWebKit: recallInspections.some(({ libraries }) =>
      linksWebKit(libraries.stdout)
    ),
    sparkleVersion,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const appPath = argv[0];
  if (!appPath || argv.length !== 1) {
    console.error(
      "Usage: tsx scripts/verify-native-macos-release.ts /absolute/path/HQ.app",
    );
    return 2;
  }

  const bundle = await inspectNativeReleaseBundle(appPath);
  assertPublishableNativeBundle(bundle);
  console.log(
    `Verified publishable HQ.app ${bundle.shortVersion} (${bundle.buildVersion}) for arm64.`,
  );
  return 0;
}

async function defaultCommandRunner(
  command: string,
  args: string[],
): Promise<NativeReleaseCommandResult> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

async function readPlistValue(
  runCommand: NativeReleaseCommandRunner,
  plist: string,
  key: string,
): Promise<string> {
  const result = await runCommand("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    plist,
  ]);
  return result.stdout.trim();
}

async function readOptionalPlistValue(
  runCommand: NativeReleaseCommandRunner,
  plist: string,
  key: string,
): Promise<string> {
  try {
    return await readPlistValue(runCommand, plist, key);
  } catch {
    return "";
  }
}

async function readArchitectures(
  runCommand: NativeReleaseCommandRunner,
  executable: string,
): Promise<string[]> {
  const result = await runCommand("/usr/bin/lipo", ["-archs", executable]);
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

function assertArm64MachO(description: string, component: string): void {
  if (!/Mach-O 64-bit .*arm64/.test(description)
      || /universal|x86_64/i.test(description)) {
    throw new Error(`${component} is not a truthful arm64-only Mach-O`);
  }
}

function assertExactlyArm64Runtime(
  architectures: readonly string[],
  description: string,
  component: string,
): void {
  if (
    architectures.length !== 1
    || architectures[0] !== "arm64"
    || !/Mach-O/.test(description)
    || /universal|x86_64/i.test(description)
  ) {
    throw new Error(
      `Recall runtime component ${component} is not arm64-only`,
    );
  }
}

function linksWebKit(libraries: string): boolean {
  return /\/WebKit\.framework\//.test(libraries);
}

function entitlementKeys(result: NativeReleaseCommandResult): Set<string> {
  const output = `${result.stdout}\n${result.stderr}`;
  return new Set([
    ...output.matchAll(/<key>([^<]+)<\/key>/g),
    ...output.matchAll(/^\s*\[Key\]\s+(.+)$/gm),
  ].map((match) => match[1].trim()));
}

function entitlementIsTrue(
  result: NativeReleaseCommandResult,
  entitlement: string,
): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  const escapedEntitlement = escapeRegExp(entitlement);
  return new RegExp(
    `<key>${escapedEntitlement}</key>\\s*<true\\s*/>`,
  ).test(output)
    || new RegExp(
      `^\\s*\\[Key\\]\\s+${escapedEntitlement}\\s*\\n`
      + "\\s*\\[Value\\]\\s*\\n\\s*\\[Bool\\]\\s+true\\s*$",
      "m",
    ).test(output);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertSparkleWebKitExceptionIsNarrow(libraries: string): void {
  for (const line of libraries.split("\n")) {
    if (/WebKit\.framework/.test(line)
        && !line.includes(
          "/System/Library/Frameworks/WebKit.framework/Versions/A/WebKit",
        )) {
      throw new Error(
        "Sparkle may link only Apple's system WebKit framework for release notes",
      );
    }
    if (/tauri|wry|webview2/i.test(line)) {
      throw new Error("Sparkle must not link a bundled web or Tauri runtime");
    }
  }
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await filesBelow(path));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      paths.push(path);
    }
  }
  return paths;
}

function isCliEntrypoint(metaURL: string): boolean {
  return process.argv[1] !== undefined
    && resolve(process.argv[1]) === fileURLToPath(metaURL);
}

if (isCliEntrypoint(import.meta.url)) {
  main().then((status) => {
    process.exitCode = status;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
