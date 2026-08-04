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

type ProductionSourceName = "main" | "tray" | "windowFocus";

type ProductionSources = Record<ProductionSourceName, string>;

interface BoundaryContract {
  label: string;
  file: ProductionSourceName;
  hook: string;
  startMarker: string;
  endMarker: string;
  afterMarkers?: string[];
}

const boundaryContracts: BoundaryContract[] = [
  {
    label: "popover shortcut seam",
    file: "main",
    hook: "NativePanicSeam::GlobalShortcutTogglePopover",
    startMarker:
      "if shortcut == &show_shortcut && event.state() == ShortcutState::Pressed {",
    endMarker: "} else if shortcut == &desktop_shortcut",
  },
  {
    label: "desktop shortcut seam",
    file: "main",
    hook: "NativePanicSeam::GlobalShortcutToggleDesktop",
    startMarker: "} else if shortcut == &desktop_shortcut",
    endMarker: "                .build(),",
  },
  {
    label: "close-requested seam recorder",
    file: "main",
    hook: "NativePanicSeam::WindowCloseRequestedHide",
    startMarker: "fn handle_window_close_requested_hide<F>",
    endMarker: "fn main() {",
  },
  {
    label: "close-requested callback",
    file: "main",
    hook: "handle_window_close_requested_hide(true, || {",
    startMarker:
      "if let tauri::WindowEvent::CloseRequested { api, .. } = event {",
    endMarker: "// Windows: reapply Mica/Acrylic",
    afterMarkers: ['if window.label() == "main" {'],
  },
  {
    label: "theme-changed seam",
    file: "main",
    hook: "NativePanicSeam::WindowThemeChanged",
    startMarker:
      "if let tauri::WindowEvent::ThemeChanged(theme) = event {",
    endMarker: "        })\n        .invoke_handler",
  },
  {
    label: "single-instance seam recorder",
    file: "main",
    hook: "NativePanicSeam::SingleInstanceSurfaceExisting",
    startMarker: "fn surface_existing_instance(app: &tauri::AppHandle) {",
    endMarker: "fn handle_window_close_requested_hide<F>",
  },
  {
    label: "single-instance callback",
    file: "main",
    hook: "surface_existing_instance(app);",
    startMarker:
      ".plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {",
    endMarker: ".plugin(tauri_plugin_shell::init())",
  },
  {
    label: "exit-requested seam",
    file: "main",
    hook: "NativePanicSeam::AppExitRequested",
    startMarker: "if let tauri::RunEvent::ExitRequested { .. } = event {",
    endMarker: "if matches!(&event, tauri::RunEvent::Exit) {",
  },
  {
    label: "running phase",
    file: "main",
    hook:
      "set_native_panic_phase(hq_telemetry::NativePanicPhase::Running)",
    startMarker: "fn main() {",
    endMarker: "// Wire the foundation crate's injected dependencies",
  },
  {
    label: "exiting phase",
    file: "main",
    hook:
      "set_native_panic_phase(hq_telemetry::NativePanicPhase::Exiting)",
    startMarker: "if let tauri::RunEvent::ExitRequested { .. } = event {",
    endMarker: "if matches!(&event, tauri::RunEvent::Exit) {",
  },
  {
    label: "destroyed phase",
    file: "main",
    hook:
      "set_native_panic_phase(hq_telemetry::NativePanicPhase::Destroyed)",
    startMarker: "if matches!(&event, tauri::RunEvent::Exit) {",
    endMarker: "// Dock-icon click on the already-running app.",
  },
  {
    label: "tray-left-click seam",
    file: "tray",
    hook: "NativePanicSeam::TrayLeftClick",
    startMarker: "if let TrayIconEvent::Click {",
    endMarker: "        .build(app)?;",
  },
  {
    label: "tray-blur seam recorder",
    file: "tray",
    hook: "NativePanicSeam::TrayBlurHide",
    startMarker: "pub(crate) fn handle_tray_blur_hide<F>",
    endMarker: "/// Create the system tray icon with its context menu",
  },
  {
    label: "tray-blur callback",
    file: "tray",
    hook: "handle_tray_blur_hide(should_hide, || {",
    startMarker: "if let WindowEvent::Focused(false) = event {",
    endMarker: "// NOTE: on macOS there is no tao tray",
    afterMarkers: ["let should_hide = !is_modal_open()"],
  },
  {
    label: "foreground raise call",
    file: "windowFocus",
    hook: "force_foreground_hwnd(hwnd.0 as isize);",
    startMarker: "fn raise_webview(window: &WebviewWindow, keep_on_top: bool) {",
    endMarker: '    #[cfg(target_os = "macos")]',
  },
  {
    label: "foreground seam recorder",
    file: "windowFocus",
    hook: "NativePanicSeam::WindowForceForeground",
    startMarker: "fn force_foreground_hwnd(hwnd_raw: isize) {",
    endMarker: "#[cfg(test)]\nmod tests {",
  },
];

function currentSources(): ProductionSources {
  return { main, tray, windowFocus };
}

function boundaryError(contract: BoundaryContract, count: number): string {
  return `${contract.label} must occur exactly once in its ${contract.file} production boundary (found ${count})`;
}

function fileCountError(contract: BoundaryContract, count: number): string {
  return `${contract.label} must occur exactly once in ${contract.file} (found ${count})`;
}

function orderError(contract: BoundaryContract, marker: string): string {
  return `${contract.label} must remain after ${marker} in its production boundary`;
}

function productionBoundaryErrors(sources: ProductionSources): string[] {
  return boundaryContracts.flatMap((contract) => {
    const source = sources[contract.file];
    const boundary = sourceBetween(
      source,
      contract.startMarker,
      contract.endMarker,
    );
    const count = countOccurrences(boundary, contract.hook);
    const errors = count === 1 ? [] : [boundaryError(contract, count)];

    const fileCount = countOccurrences(source, contract.hook);
    if (fileCount !== 1) {
      errors.push(fileCountError(contract, fileCount));
    }

    if (count === 1) {
      const hookIndex = boundary.indexOf(contract.hook);
      for (const marker of contract.afterMarkers ?? []) {
        const markerIndex = boundary.indexOf(marker);
        if (markerIndex === -1 || hookIndex <= markerIndex) {
          errors.push(orderError(contract, marker));
        }
      }
    }

    return errors;
  });
}

function replaceBoundaryHook(
  source: string,
  contract: BoundaryContract,
  replacement: string,
): string {
  const boundary = sourceBetween(
    source,
    contract.startMarker,
    contract.endMarker,
  );
  const count = countOccurrences(boundary, contract.hook);
  if (count !== 1) {
    throw new Error(boundaryError(contract, count));
  }

  const start = source.indexOf(contract.startMarker);
  const end = start + boundary.length;
  return `${source.slice(0, start)}${boundary.replace(contract.hook, replacement)}${source.slice(end)}`;
}

function withSource(
  sources: ProductionSources,
  file: ProductionSourceName,
  source: string,
): ProductionSources {
  return { ...sources, [file]: source };
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
        expect(
          countOccurrences(source, `NativePanicSeam::${variant}`),
          `${variant} must have exactly one production recorder in ${file}`,
        ).toBe(1);
      }
    }
  });

  it("binds every seam and lifecycle phase to its production boundary", () => {
    expect(productionBoundaryErrors(currentSources())).toEqual([]);
  });

  it("rejects deletion and same-file relocation at every production boundary", () => {
    const sources = currentSources();

    for (const [index, contract] of boundaryContracts.entries()) {
      const source = sources[contract.file];
      const deleted = replaceBoundaryHook(
        source,
        contract,
        `__deleted_boundary_hook_${index}__`,
      );
      expect(
        productionBoundaryErrors(withSource(sources, contract.file, deleted)),
        `${contract.label} deletion must fail the contract`,
      ).toContain(boundaryError(contract, 0));

      const removed = replaceBoundaryHook(
        source,
        contract,
        `__relocated_boundary_hook_${index}__`,
      );
      const relocated = `${removed}\n// same-file relocation probe\n${contract.hook}\n`;
      expect(
        productionBoundaryErrors(
          withSource(sources, contract.file, relocated),
        ),
        `${contract.label} same-file relocation must fail the contract`,
      ).toContain(boundaryError(contract, 0));
    }
  });
});
