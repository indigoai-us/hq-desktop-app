import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let telemetry = "";
let main = "";
let tray = "";
let windowFocus = "";

beforeAll(async () => {
  [telemetry, main, tray, windowFocus] = await Promise.all([
    readFile(resolve(rootDir, "crates/hq-telemetry/src/lib.rs"), "utf8"),
    readFile(resolve(rootDir, "apps/sync/src-tauri/src/main.rs"), "utf8"),
    readFile(resolve(rootDir, "apps/sync/src-tauri/src/tray.rs"), "utf8"),
    readFile(
      resolve(rootDir, "apps/sync/src-tauri/src/util/window_focus.rs"),
      "utf8",
    ),
  ]);
});

function nativePanicSeamVariants(): string[] {
  const enumBody = /pub enum NativePanicSeam \{([\s\S]*?)\n\}/.exec(telemetry)?.[1];
  if (!enumBody) {
    throw new Error("NativePanicSeam enum is missing");
  }

  return [...enumBody.matchAll(/^\s+([A-Z][A-Za-z0-9]+)\s*=\s*\d+,?$/gm)]
    .map((match) => match[1]);
}

function sourceBetween(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Missing production boundary start: ${startMarker}`);
  }

  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    throw new Error(`Missing production boundary end: ${endMarker}`);
  }

  return source.slice(start, end);
}

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe("native panic seam wiring", () => {
  it("keeps every declared seam wired to its expected production source", () => {
    const expectedByFile = new Map<string, [string, string[]]>([
      [
        "main.rs",
        [
          main,
          [
            "GlobalShortcutTogglePopover",
            "GlobalShortcutToggleDesktop",
            "WindowCloseRequestedHide",
            "WindowThemeChanged",
            "SingleInstanceSurfaceExisting",
            "AppExitRequested",
          ],
        ],
      ],
      ["tray.rs", [tray, ["TrayLeftClick", "TrayBlurHide"]]],
      ["util/window_focus.rs", [windowFocus, ["WindowForceForeground"]]],
    ]);

    const expectedVariants = [...expectedByFile.values()]
      .flatMap(([, variants]) => variants)
      .sort();
    expect(nativePanicSeamVariants().sort()).toEqual(expectedVariants);

    for (const [file, [source, variants]] of expectedByFile) {
      for (const variant of variants) {
        expect(source, `${variant} must remain wired in ${file}`).toContain(
          `NativePanicSeam::${variant}`,
        );
      }
    }
  });

  it("binds guarded hide helpers to their real window event boundaries", () => {
    const closeRequestedBoundary = sourceBetween(
      main,
      ".on_window_event(|window, event| {",
      "// Windows: reapply Mica/Acrylic",
    );
    const closeEvent = closeRequestedBoundary.indexOf(
      "if let tauri::WindowEvent::CloseRequested { api, .. } = event",
    );
    const mainWindowGuard = closeRequestedBoundary.indexOf(
      'if window.label() == "main"',
    );
    const closeHelper = closeRequestedBoundary.indexOf(
      "handle_window_close_requested_hide(true, || {",
    );

    expect(closeEvent).toBeGreaterThan(-1);
    expect(mainWindowGuard).toBeGreaterThan(closeEvent);
    expect(closeHelper).toBeGreaterThan(mainWindowGuard);
    expect(
      countOccurrences(
        closeRequestedBoundary,
        "handle_window_close_requested_hide(",
      ),
    ).toBe(1);

    const blurBoundary = sourceBetween(
      tray,
      "window.on_window_event(move |event| {",
      "// NOTE: on macOS there is no tao tray",
    );
    const focusLostEvent = blurBoundary.indexOf(
      "if let WindowEvent::Focused(false) = event",
    );
    const guardDecision = blurBoundary.indexOf(
      "let should_hide = !is_modal_open()",
    );
    const blurHelper = blurBoundary.indexOf(
      "handle_tray_blur_hide(should_hide, || {",
    );

    expect(focusLostEvent).toBeGreaterThan(-1);
    expect(guardDecision).toBeGreaterThan(focusLostEvent);
    expect(blurHelper).toBeGreaterThan(guardDecision);
    expect(countOccurrences(blurBoundary, "handle_tray_blur_hide(")).toBe(1);
  });

  it("keeps running, exiting, and destroyed lifecycle hooks at their event boundaries", () => {
    const running = main.indexOf(
      "set_native_panic_phase(hq_telemetry::NativePanicPhase::Running)",
    );
    const exitRequested = main.indexOf("tauri::RunEvent::ExitRequested");
    const exiting = main.indexOf(
      "set_native_panic_phase(hq_telemetry::NativePanicPhase::Exiting)",
    );
    const exit = main.indexOf("tauri::RunEvent::Exit)", exitRequested + 1);
    const destroyed = main.indexOf(
      "set_native_panic_phase(hq_telemetry::NativePanicPhase::Destroyed)",
    );

    expect(running).toBeGreaterThan(-1);
    expect(exitRequested).toBeGreaterThan(running);
    expect(exiting).toBeGreaterThan(exitRequested);
    expect(exit).toBeGreaterThan(exiting);
    expect(destroyed).toBeGreaterThan(exit);
  });
});
