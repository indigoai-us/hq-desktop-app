import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(repo, "apps/native-macos/Sources");
const appStore = readFileSync(join(nativeRoot, "App/HQAppStore.swift"), "utf8");
const nativeApp = readFileSync(join(nativeRoot, "App/HQNativeApp.swift"), "utf8");
const secondaryWindows = readFileSync(
  join(nativeRoot, "Features/Windows/HQSecondaryWindows.swift"),
  "utf8",
);
const processTransport = readFileSync(
  join(nativeRoot, "Engine/HQProcessEngineTransport.swift"),
  "utf8",
);
const ciWorkflow = readFileSync(
  join(repo, ".github/workflows/ci.yml"),
  "utf8",
);
const visualTourScript = readFileSync(
  join(repo, "scripts/native-visual-tour.mjs"),
  "utf8",
);

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Missing source-contract boundary: ${start} … ${end}`);
  }
  return source.slice(startIndex, endIndex);
}

const liveSettings = between(
  nativeApp,
  "private func settings(section: HQSettingsSection)",
  "private var liveRouteContent",
);
const liveRouteActions = between(
  nativeApp,
  "private func liveRouteActions(",
  "private func rowsForCurrentRoute(",
);

describe("native macOS cluster 2/3 RED regressions", () => {
  it("sends the meeting row's selected company when Record is clicked", () => {
    expect(secondaryWindows).toContain(
      '"meeting-action|\\(actionOperation.rawValue)|\\(windowID)|\\(selectedCompanyUID)"',
    );
  });

  it("tracks a single observable OAuth flow", () => {
    expect(appStore).toMatch(
      /@Published[^\n]*(?:OAuth|oauth)[^\n]*(?:flow|Flow|state|State|pending|Pending|inFlight|InFlight)/,
    );
  });

  it("cancels the active OAuth listener from the sign-in Cancel action", () => {
    const registry = between(
      appStore,
      "enum HQSecondaryWindowActionRegistry",
      "// MARK: - Engine-backed state",
    );
    expect(registry).toMatch(
      /case \(\.signIn, "cancel"\)[\s\S]{0,240}(?:oauthCancelListen|cancelOAuth|oauthCancel)/,
    );
  });

  it("opens live file rows as content and exposes Open in Editor", () => {
    expect(liveRouteActions).toMatch(
      /(?=[\s\S]*\.navigate\(\.files)(?=[\s\S]*\.openInEditor)/,
    );
  });

  it("does not render a DM-detail composer from untyped history fallback", () => {
    const detailState = between(
      appStore,
      "case .directMessageDetail:\n            if let message",
      "case .messages:",
    );
    expect(detailState).not.toContain("return liveDomainWindowState(");
  });

  it("preserves moderation instruction text in the live row model", () => {
    const flattener = between(
      appStore,
      "private static func liveRouteRows(",
      "private static func humanized(",
    );
    expect(flattener).toContain('"text",');
  });

  it("renders injection-scan review data on the production moderation surface", () => {
    const moderation = between(
      liveRouteActions,
      "case .global(.moderation):",
      "case .library,",
    );
    expect(moderation).toContain("injectionScan");
  });

  it("requires an editable rejection note instead of submitting canned text", () => {
    expect(liveRouteActions).not.toContain(
      'note: "Rejected from the native HQ moderation screen."',
    );
  });

  it("gates Install Update on observable updater state", () => {
    const updates = between(liveSettings, "case .updates:", "case .general:");
    expect(updates).toMatch(
      /(?=[\s\S]*(?:updaterState|updateState))(?=[\s\S]*\.disabled\()/,
    );
  });

  it("starts the updater from a saved release-channel preference", () => {
    const updaterStart = between(
      appStore,
      "private func startUpdaterIfNeeded()",
      "private func startUpdaterAfterLiveBootstrap()",
    );
    expect(updaterStart).not.toContain("preferredChannel: nil");
  });

  it("requires an explicit marketplace install target", () => {
    const marketplace = between(
      liveRouteActions,
      "case .global(.marketplace):",
      "case .global(.moderation):",
    );
    expect(marketplace).not.toContain(
      '"scope": .object(["kind": .string("personal")])',
    );
  });

  it("surfaces marketplace install progress on the production screen", () => {
    const productionViews = nativeApp.slice(
      0,
      nativeApp.indexOf("private struct HQRouteView"),
    );
    expect(productionViews).toContain("marketplaceLog");
  });

  it("records a marketplace metric only after successful installation", () => {
    expect(appStore).toContain('"record_marketplace_install"');
  });

  it("uses an explicit workspace target for global sync settings", () => {
    const sync = between(liveSettings, "case .sync:", "case .notifications:");
    expect(sync).not.toContain(
      "store.content.snapshot.workspaces.first?.slug",
    );
  });

  it("skips completed setup stages for normal onboarding resume", () => {
    const setup = between(
      appStore,
      "private func runSetupStages(recoveryOnly: Bool)",
      "private func setupStage(",
    );
    expect(setup).not.toContain("guard !recoveryOnly");
  });

  it("rehydrates live domains before setup success exposes Open HQ", () => {
    const setup = between(
      appStore,
      "private func runSetupStages(recoveryOnly: Bool)",
      "private func setupStage(",
    );
    const success = between(setup, "if failedStageIDs.isEmpty {", "} else {");
    expect(success).toMatch(
      /reloadLiveContent|loadSecondaryDomains|workspaces\.list/,
    );
  });

  it("keys duplicate mutations and refreshes their affected route", () => {
    const mutation = between(
      appStore,
      "private func requestMutation(",
      "private func performNative(",
    );
    expect(mutation).toMatch(
      /(?=[\s\S]*(?:inFlight|activeMutation|pendingMutation))(?=[\s\S]*loadLiveRoute)/,
    );
  });

  it("counts direct-message history when deciding Messages readiness", () => {
    const messagesState = between(
      appStore,
      "case .messages:\n            if let target",
      "case .shareDetail:",
    );
    expect(messagesState).toContain('"fetch_notification_history"');
  });

  it("restores production actions for Drift, New Files, Notifications, and Settings", () => {
    const windows = between(
      appStore,
      "case .drift:",
      "case .recovery:",
    );
    for (const actionID of [
      "review",
      "preserve",
      "review-files",
      "reveal",
      "mark-read",
      "settings",
    ]) {
      expect(windows).toContain(`id: "${actionID}"`);
    }

    const settings = between(
      appStore,
      "case .settings:",
      "case .meetings:",
    );
    expect(settings).toContain('id: "done"');
    expect(settings).toContain('id: "defaults"');
  });

  it("tracks meeting mutations per window before launching async work", () => {
    const meetingMutation = between(
      appStore,
      "private func performNativeMeetingAction(",
      "private func performNativeDMNotificationAction(",
    );
    expect(meetingMutation).toMatch(
      /(?:inFlight|pending|active)[^\n]*(?:meeting|window)/i,
    );
  });

  it("does not block the async transport actor after exit polling completes", () => {
    const stop = between(
      processTransport,
      "func stop() async",
      "private func waitForExit(",
    );
    expect(processTransport).toContain("process.terminationHandler");
    expect(stop).not.toContain("while !didExit");
    expect(stop).not.toMatch(/\bprocess\.waitUntilExit\(\)/);
  });

  it("watchdogs native unit tests and forwards visual-tour arguments directly", () => {
    const unitStep = between(
      ciWorkflow,
      "- name: Test native unit suite",
      "- name: Test every native route and window",
    );
    expect(unitStep).toContain("-test-timeouts-enabled YES");
    expect(unitStep).toContain(
      "-maximum-test-execution-time-allowance 60",
    );
    expect(ciWorkflow).not.toContain("pnpm visual-tour:native --");
  });

  it("ad-hoc signs the macOS visual-tour app and UI-test runner", () => {
    expect(visualTourScript).not.toContain("CODE_SIGNING_ALLOWED=NO");
    expect(
      visualTourScript.match(/ENABLE_HARDENED_RUNTIME=NO/g),
    ).toHaveLength(1);
    expect(visualTourScript).toContain(
      "HQNativeUITests.EnvironmentVariables",
    );
    expect(visualTourScript).toContain("HQ_VISUAL_TOUR_OUTPUT_DIR");
    expect(visualTourScript).toContain('"-xctestrun"');
  });

  it("exports visual-tour captures from the sandboxed UI-test container", () => {
    expect(visualTourScript).toContain(
      "Library/Containers/ai.indigo.hq.native.uitests.xctrunner/Data/tmp",
    );
    expect(visualTourScript).toContain("mkdtempSync");
    expect(visualTourScript).toContain("cpSync");
    expect(visualTourScript).toContain("rmSync");
  });
});
