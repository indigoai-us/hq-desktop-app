import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(repo, "apps/native-macos");

function filesBelow(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function productVersion(): string {
  const versions = readFileSync(join(repo, "versions.toml"), "utf8");
  const match = /^\s*version\s*=\s*"([^"]+)"/m.exec(
    versions.slice(versions.indexOf("[product]")),
  );
  if (!match) {
    throw new Error("versions.toml is missing [product].version");
  }
  return match[1];
}

function productBuildNumber(): string {
  const versions = readFileSync(join(repo, "versions.toml"), "utf8");
  const match = /^\s*build\s*=\s*(\d+)/m.exec(
    versions.slice(versions.indexOf("[product]")),
  );
  if (!match) {
    throw new Error("versions.toml is missing [product].build");
  }
  return match[1];
}

describe("native macOS shipping contract", () => {
  it("contains no web view or Tauri runtime in production Swift sources", () => {
    const sources = filesBelow(join(nativeRoot, "Sources"))
      .filter((path) => extname(path) === ".swift")
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(sources).not.toMatch(/\bimport\s+WebKit\b|\bWKWebView\b/i);
    expect(sources).not.toMatch(/\btauri\b/i);
  });

  it("contains no production no-op Swift controls", () => {
    const sources = [
      join(nativeRoot, "Sources/App"),
      join(nativeRoot, "Sources/Features"),
    ]
      .flatMap(filesBelow)
      .filter((path) => extname(path) === ".swift")
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    for (const pattern of [
      /Button\([^\n]*\)\s*\{\s*\}/,
      /Button\s*\{\s*\}\s*label:/,
      /onAction:\s*@escaping[^\n]*=\s*\{\s*_\s+in\s*\}/,
      /var\s+onAction:[^\n]*=\s*\{\s*_\s+in\s*\}/,
    ]) {
      expect(sources).not.toMatch(pattern);
    }
    expect(sources).not.toContain(".control(id:");
  });

  it("preserves the updater identity, app name, architecture, and product version", () => {
    const project = readFileSync(join(nativeRoot, "project.yml"), "utf8");
    const version = productVersion();
    const buildNumber = productBuildNumber();

    expect(project).toMatch(
      /^\s*PRODUCT_BUNDLE_IDENTIFIER: ai\.indigo\.hq-sync-menubar\s*$/m,
    );
    expect(project).toMatch(/^\s*PRODUCT_NAME: HQ\s*$/m);
    expect(project).toMatch(/^\s*PRODUCT_MODULE_NAME: HQNative\s*$/m);
    expect(project).toContain("ARCHS: arm64");
    expect(project).toContain(`MARKETING_VERSION: "${version}"`);
    expect(project).toContain(
      `INFOPLIST_KEY_CFBundleShortVersionString: "${version}"`,
    );
    expect(project).toContain(
      `INFOPLIST_KEY_CFBundleVersion: "${buildNumber}"`,
    );
    expect(project).toContain(`CURRENT_PROJECT_VERSION: "${buildNumber}"`);
    expect(project).toContain("hq-engine-sidecar");
    expect(project).toContain("--target aarch64-apple-darwin");
    expect(project).toContain("Resources/icon.icns");
    expect(project).not.toContain("../sync/src-tauri/icons/icon.icns");
    expect(project).toContain("/usr/bin/codesign");
  });

  it("pins Sparkle 2.9.2 and injects the production update key at release time", () => {
    const project = readFileSync(join(nativeRoot, "project.yml"), "utf8");

    expect(project).toMatch(
      /Sparkle:\s*\n\s+url: https:\/\/github\.com\/sparkle-project\/Sparkle\s*\n\s+exactVersion: 2\.9\.2/,
    );
    expect(project).toMatch(/dependencies:\s*(?:\n\s+-[^\n]+)*\n\s+- package: Sparkle/);
    expect(project).toMatch(
      /info:\s*\n\s+path: Config\/HQNative-Info\.plist\s*\n\s+properties:/,
    );
    expect(project).toContain("GENERATE_INFOPLIST_FILE: NO");
    expect(project).toMatch(
      /^\s+SUFeedURL: "https:\/\/github\.com\/indigoai-us\/hq-desktop-app\/releases\/download\/sparkle-stable\/appcast\.xml"$/m,
    );
    expect(project).toMatch(
      /^\s+SUPublicEDKey: "\$\(SPARKLE_PUBLIC_ED_KEY\)"$/m,
    );
    expect(project).toMatch(
      /^\s+HQValidationOnlyBuild: "\$\(HQ_NATIVE_VALIDATION_BUILD\)"$/m,
    );
    expect(project).toContain("Validate Sparkle Update Key");
    expect(project).toContain('if [[ "$CONFIGURATION" != "Release" ]]');
    expect(project).toContain('public_key="${SPARKLE_PUBLIC_ED_KEY:-}"');
    expect(project).toContain("Sparkle public key is required for Release");
    expect(project).toContain(
      'validation_public_key="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="',
    );
    expect(project).toContain(
      "The deterministic validation key is forbidden in a production Release",
    );
    expect(project).toContain(
      "Production Release requires a Developer ID signing identity",
    );
    expect(project).toContain('timestamp_argument="--timestamp"');
    expect(project).toMatch(/^\s+SUEnableAutomaticChecks: true$/m);
    expect(project).toMatch(/^\s+SUScheduledCheckInterval: 21600$/m);
    expect(project).toMatch(/^\s+SUAllowsAutomaticUpdates: false$/m);
    expect(project).toMatch(/^\s+SUAutomaticallyUpdate: false$/m);
    expect(project).not.toMatch(/SPARKLE_PUBLIC_ED_KEY:\s*["']?[A-Za-z0-9+/]{43}=/);
  });

  it("embeds only the signed arm64 native Recall runtime", () => {
    const project = readFileSync(join(nativeRoot, "project.yml"), "utf8");
    const hostEntitlements = readFileSync(
      join(nativeRoot, "Config/HQNative.entitlements"),
      "utf8",
    );
    const recallEntitlements = readFileSync(
      join(nativeRoot, "Config/HQRecallRuntime.entitlements"),
      "utf8",
    );

    expect(project).toContain("Build and Embed Native Recall Runtime");
    expect(project).toContain(
      "sidecar/recall-sdk-bridge/node_modules/@recallai/desktop-sdk",
    );
    expect(project).toContain("desktop_sdk_macos_exe");
    expect(project).toContain("hq-recall-runtime");
    expect(project).toContain("GStreamer.framework");
    expect(project).toContain("liblibbot_desktop_rs.dylib");
    expect(project).toContain("libui_recorder.dylib");
    expect(project).toContain("/usr/bin/lipo -thin arm64");
    expect(project).toContain("/usr/bin/codesign --remove-signature");
    expect(project).toContain("/usr/bin/install_name_tool");
    expect(project).toContain('-id "@rpath/libui_recorder.dylib"');
    expect(
      project.indexOf("/usr/bin/codesign --remove-signature"),
    ).toBeLessThan(
      project.indexOf("/usr/bin/install_name_tool"),
    );
    expect(project.indexOf("/usr/bin/install_name_tool")).toBeLessThan(
      project.indexOf('for macho_file in "${macho_files[@]}"'),
    );
    expect(project).toContain("/usr/bin/codesign");
    expect(project).toContain('sign_identity="${EXPANDED_CODE_SIGN_IDENTITY:--}"');
    expect(project).toContain("HQRecallRuntime.entitlements");
    expect(project).toContain('--entitlements "$recall_entitlements"');
    expect(project).not.toMatch(/\b(cp|ditto)\b[^\n]*index\.(js|mjs)/);
    expect(project).not.toMatch(/\b(cp|ditto)\b[^\n]*"\$sdk_root"\s/);
    expect(hostEntitlements).not.toContain(
      "com.apple.security.cs.allow-jit",
    );
    for (const entitlement of [
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.device.audio-input",
    ]) {
      expect(recallEntitlements).toContain(entitlement);
    }
  });

  it("thins and re-signs every pinned Sparkle helper before notarization", () => {
    const thinner = readFileSync(
      join(repo, "scripts/native-macos-release-thin-sparkle.sh"),
      "utf8",
    );
    const workflow = readFileSync(
      join(repo, ".github/workflows/release.yml"),
      "utf8",
    );

    for (const component of [
      "Versions/B",
      "Autoupdate",
      "Updater.app",
      "Downloader.xpc",
      "Installer.xpc",
      "Sparkle",
    ]) {
      expect(thinner).toContain(component);
    }
    expect(thinner).toContain("/usr/bin/lipo -thin arm64");
    expect(thinner).toContain(
      "--preserve-metadata=identifier,entitlements,requirements",
    );
    expect(thinner).toContain("--options runtime");
    expect(thinner).toContain('timestamp_argument="--timestamp"');
    expect(thinner).toContain('sign_component "$autoupdate"');
    expect(thinner.indexOf('sign_component "$updater_app"')).toBeLessThan(
      thinner.indexOf('sign_component "$sparkle_framework"'),
    );
    expect(thinner.indexOf('sign_component "$installer_xpc"')).toBeLessThan(
      thinner.indexOf('sign_component "$sparkle_framework"'),
    );
    expect(thinner.indexOf('sign_component "$sparkle_framework"')).toBeLessThan(
      thinner.indexOf('sign_component "$app_path"'),
    );
    const signingFunction = thinner.slice(
      thinner.indexOf("sign_component()"),
      thinner.indexOf("# Re-sign from the deepest nested code"),
    );
    expect(signingFunction).not.toContain("--deep");

    const thinStep = workflow.indexOf(
      "Thin Sparkle to arm64 and re-sign the native bundle",
    );
    const notarizeStep = workflow.indexOf(
      "Notarize and staple native HQ.app",
    );
    expect(thinStep).toBeGreaterThan(0);
    expect(thinStep).toBeLessThan(notarizeStep);
  });

  it("uses Sparkle's native standard updater controller behind the injected service", () => {
    const source = readFileSync(
      join(nativeRoot, "Sources/Platform/HQSparkleUpdaterDriver.swift"),
      "utf8",
    );

    expect(source).toContain("import Sparkle");
    expect(source).toContain("SPUStandardUpdaterController");
    expect(source).toContain("SPUUpdaterDelegate");
    expect(source).toContain("func feedURLString(for updater: SPUUpdater)");
    expect(source).toContain("startingUpdater: false");
    expect(source).toContain("try updater.start()");
    expect(source).toContain("updater.checkForUpdateInformation()");
    expect(source).toContain("standardUpdaterController.checkForUpdates(nil)");
    expect(source).not.toContain(
      "standardUpdaterController.startUpdater()",
    );
    expect(source).not.toMatch(/downloads\.getindigo\.ai/);
  });

  it("runs native Swift, Rust, UI, and release gates on a macOS 26 CI runner", () => {
    const workflow = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("native-macos:");
    expect(workflow).toContain("runs-on: macos-26");
    expect(workflow).toContain("node scripts/check-native-parity.mjs");
    expect(workflow).toContain("cargo fmt --all -- --check");
    expect(workflow).toContain(
      "cargo check -p hq-engine-protocol -p hq-engine -p hq-engine-sidecar",
    );
    expect(workflow).toContain("cargo clippy");
    expect(workflow).toContain("-- -D warnings");
    expect(workflow).toContain(
      "cargo test -p hq-engine-protocol -p hq-engine -p hq-engine-sidecar",
    );
    expect(workflow).toContain(
      "cargo run -q -p hq-engine --example parity_blocked",
    );
    expect(workflow).toContain("-scheme HQEngineContract");
    expect(workflow).toContain("-only-testing:HQNativeTests");
    expect(workflow).toContain("-only-testing:HQNativeUITests");
    expect(workflow).toContain("pnpm visual-tour:native");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("-configuration Release");
    expect(workflow).toContain("HQ_NATIVE_VALIDATION_BUILD=1");
    expect(workflow).toContain(
      "SPARKLE_PUBLIC_ED_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
  });

  it("ships the native arm64 app and channel feeds without changing Windows Tauri packaging", () => {
    const workflow = readFileSync(
      join(repo, ".github/workflows/release.yml"),
      "utf8",
    );
    const macJob = workflow.slice(
      workflow.indexOf("  macos:"),
      workflow.indexOf("  windows:"),
    );
    const windowsJob = workflow.slice(
      workflow.indexOf("  windows:"),
      workflow.indexOf("  publish:"),
    );
    const publishJob = workflow.slice(workflow.indexOf("  publish:"));

    expect(macJob).toContain("name: Build native macOS arm64");
    expect(macJob).toContain("runs-on: macos-26");
    expect(macJob).toContain("xcodegen generate");
    expect(macJob).toContain("xcodebuild archive");
    expect(macJob).toContain("-scheme HQNative");
    expect(macJob).toContain("ARCHS=arm64");
    expect(macJob).toContain(
      "native-macos-release-thin-sparkle.sh",
    );
    expect(macJob).toContain("CODE_SIGN_IDENTITY");
    expect(macJob).toContain("xcrun notarytool submit");
    expect(macJob).toContain("xcrun stapler staple");
    expect(macJob).toContain("verify-native-macos-release.ts");
    expect(macJob).toContain("prepare-native-macos-release.ts");
    expect(macJob).toContain("SPARKLE_ED_PRIVATE_KEY");
    expect(macJob).toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(macJob).toContain(
      "SourcePackages/artifacts/sparkle/Sparkle/bin/sign_update",
    );
    expect(macJob).not.toContain("-name sign_update");
    expect(macJob).toContain("HQ_${VERSION}_aarch64.dmg");
    expect(macJob).toContain("name: hq-macos-aarch64");
    expect(macJob).not.toMatch(/universal-apple-darwin|_universal/);
    expect(macJob).not.toContain("UNVERIFIED_RELEASE");

    expect(windowsJob).toContain(
      "pnpm tauri build --target ${{ matrix.target }}",
    );
    expect(windowsJob).toContain("pnpm version:check");
    expect(windowsJob).toContain(
      "Release tag ${tag} expects product.version ${expected}",
    );
    expect(windowsJob).toContain("x86_64-pc-windows-msvc");
    expect(windowsJob).toContain("aarch64-pc-windows-msvc");
    expect(windowsJob).toContain("Azure Trusted Signing");

    expect(publishJob).toContain(
      'MAC_TAR_PATH="release/HQ_${VERSION}_aarch64.app.tar.gz"',
    );
    expect(publishJob).toContain('platforms["darwin-aarch64"] = mac');
    expect(publishJob).toContain('feed_tag="sparkle-${channel}"');
    expect(publishJob).toContain("gh release upload");
    expect(publishJob).toContain("--clobber");
    expect(publishJob).toContain("next.build < current.build");
    expect(publishJob).toContain(
      "next.version !== current.version",
    );
    expect(publishJob).toContain(
      "Refusing to move a Sparkle feed",
    );
    expect(publishJob).toContain(
      "Probe public release assets and channel feeds",
    );
    expect(publishJob).not.toContain(
      'platforms["darwin-x86_64"] =',
    );
  });

  it("has no unresolved downloads host in the native updater or release bridge", () => {
    const files = [
      join(nativeRoot, "project.yml"),
      join(nativeRoot, "Config/HQNative-Info.plist"),
      join(nativeRoot, "Sources/Platform/HQUpdaterService.swift"),
      join(nativeRoot, "Release/Fixtures/stable-appcast.xml"),
      join(repo, "scripts/native-macos-release.ts"),
      join(repo, ".github/workflows/release.yml"),
    ];
    const contents = files
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(contents).not.toContain("downloads.getindigo.ai");
    expect(contents).toContain(
      "https://github.com/indigoai-us/hq-desktop-app/releases/download/sparkle-stable/appcast.xml",
    );
  });
});
