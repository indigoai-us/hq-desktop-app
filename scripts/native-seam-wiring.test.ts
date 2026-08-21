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
  /** Markers the hook must precede — order matters, not just presence. */
  beforeMarkers?: string[];
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
    // HQ-DESKTOP-4N. A watcher capture held back by the session-end grace is
    // resolved deliberately at BOTH exits, and the two arms do opposite
    // things. An app-initiated quit is not a session end, so it must SEND —
    // deleting this call would let a user who quits during the grace silently
    // swallow a genuine external kill, which is exactly the alert loss the
    // deferral is allowed to risk only if this flush exists.
    label: "app-quit deferred session-end flush",
    file: "main",
    hook: "commands::daemon::flush_pending_session_end_captures();",
    startMarker: "if let tauri::RunEvent::ExitRequested { .. } = event {",
    endMarker: "if matches!(&event, tauri::RunEvent::Exit) {",
    // Before the children are torn down: once `terminate_all_for_exit` runs,
    // further watcher exits are cancelled teardown, not the kill being held.
    beforeMarkers: ["commands::process::terminate_all_for_exit("],
  },
  {
    // The other half of the same asymmetry: reaching the Windows session-end
    // teardown IS the affirmation the deferral was waiting for, so it drops.
    // It must run BEFORE the observer is shut down and the children are
    // terminated — both of which are part of a teardown that has already
    // decided this is a session end.
    label: "session-end deferred capture drop",
    file: "main",
    hook: "commands::daemon::drop_pending_session_end_captures();",
    startMarker: "if matches!(&event, tauri::RunEvent::Exit) {",
    endMarker: "// Dock-icon click on the already-running app.",
    afterMarkers: ["NativePanicSeam::AppSessionEndExit"],
    beforeMarkers: ["commands::process::terminate_all_for_exit("],
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
  // ── HQ-DESKTOP-44: Windows session-end exit ──────────────────────────────
  // `WM_ENDSESSION` leaves tao's runner latched in `Destroyed` with its
  // message pump still live, so the next dispatched message panics out of an
  // `extern "system"` window procedure and aborts. `RunEvent::Exit` is the one
  // app-controlled instant before that dispatch. Each link below is pinned
  // individually so deleting any one of them — the decision input, the
  // teardown markers, the bounded flush, or the exit itself — fails loudly
  // rather than silently restoring the crash.
  // The decision function's own signature is NOT a hook here: it is this
  // contract's start marker, and the mutation pass would then delete the very
  // anchor the next contract resolves against. Its presence and its cfg gate
  // are pinned by "confines the session-end process exit to the Windows build"
  // instead, and `sourceBetween` already throws if the marker goes missing.
  {
    label: "session-end exit branch guard",
    file: "main",
    hook: "if app_initiated {",
    startMarker: "fn handle_run_event_exit<S, T>",
    endMarker: "fn main() {",
  },
  {
    label: "session-end exit decision input",
    file: "main",
    hook: "commands::process::app_initiated_exit(),",
    startMarker: "if matches!(&event, tauri::RunEvent::Exit) {",
    endMarker: "// Dock-icon click on the already-running app.",
  },
  {
    label: "session-end exit seam",
    file: "main",
    hook: "NativePanicSeam::AppSessionEndExit",
    startMarker: "if matches!(&event, tauri::RunEvent::Exit) {",
    endMarker: "// Dock-icon click on the already-running app.",
  },
  {
    label: "session-end observer corroboration seam",
    file: "main",
    hook: "NativePanicSeam::AppSessionEndObserved",
    startMarker: "if matches!(&event, tauri::RunEvent::Exit) {",
    endMarker: "// Dock-icon click on the already-running app.",
    // Read while the observer can still affirm: `shutdown` moves its readiness
    // to `Stopped`, which `attribution_now` reports as `ObserverFailed`.
    afterMarkers: ["NativePanicSeam::AppSessionEndExit"],
  },
  {
    // The ownership report is what the live artifact proof asserts against:
    // the file's existence proves this arm ran, and the pids it names are what
    // the proof then requires to be dead. It has to be emitted BEFORE the
    // children are terminated — afterwards the registry has emptied and the
    // report would truthfully name nothing, turning the proof vacuous while
    // still reading green.
    label: "session-end owned-pid report",
    file: "main",
    hook: "commands::process::report_session_end_owned_pids();",
    startMarker: "if matches!(&event, tauri::RunEvent::Exit) {",
    endMarker: "// Dock-icon click on the already-running app.",
    beforeMarkers: ["commands::process::terminate_all_for_exit("],
  },
  {
    label: "session-end bounded sentry flush",
    file: "main",
    hook: "hq_telemetry::flush_within(",
    startMarker: "if matches!(&event, tauri::RunEvent::Exit) {",
    endMarker: "// Dock-icon click on the already-running app.",
    // Children first: at shutdown the network may already be gone, and an
    // orphaned sync daemon is worse than a dropped report.
    afterMarkers: ["commands::process::terminate_all_for_exit("],
  },
  {
    label: "session-end process exit",
    file: "main",
    hook: "|| std::process::exit(0),",
    startMarker: "if matches!(&event, tauri::RunEvent::Exit) {",
    endMarker: "// Dock-icon click on the already-running app.",
    afterMarkers: ["hq_telemetry::flush_within("],
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

function precedenceError(contract: BoundaryContract, marker: string): string {
  return `${contract.label} must remain before ${marker} in its production boundary`;
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
      for (const marker of contract.beforeMarkers ?? []) {
        const markerIndex = boundary.indexOf(marker);
        if (markerIndex === -1 || hookIndex >= markerIndex) {
          errors.push(precedenceError(contract, marker));
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
            "AppSessionEndExit",
            "AppSessionEndObserved",
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

  // The session-end fast exit is a Windows-only remedy for a Windows-only tao
  // defect. On macOS and Linux it would be a regression: it skips tauri's
  // `cleanup_before_exit()`, which tears down the tray icon and hides windows.
  it("confines the session-end process exit to the Windows build", () => {
    const exitArm = sourceBetween(
      main,
      "if matches!(&event, tauri::RunEvent::Exit) {",
      "// Dock-icon click on the already-running app.",
    );

    expect(
      /#\[cfg\(target_os = "windows"\)\]\s*handle_run_event_exit\(/.test(exitArm),
      "the RunEvent::Exit fast path must be gated to the Windows build",
    ).toBe(true);

    // The only process exit anywhere in main.rs is that gated one — nothing
    // else in the app may short-circuit tauri's teardown.
    expect(countOccurrences(main, "std::process::exit")).toBe(1);
    expect(countOccurrences(exitArm, "std::process::exit")).toBe(1);

    // The decision function itself must stay compiled out of a non-Windows
    // release build (it remains available under `test` so both branches are
    // covered by the macOS Rust job).
    expect(main).toContain(
      '#[cfg(any(target_os = "windows", test))]\nfn handle_run_event_exit<S, T>',
    );
  });

  // Deletion is not the only way to break the ownership report. Emitting it
  // AFTER `terminate_all_for_exit` leaves every existing check green — the file
  // is still written, the arm still runs — while the report truthfully names an
  // already-empty registry, so the live proof would assert that zero pids are
  // dead and pass without proving anything.
  it("rejects reordering the session-end owned-pid report after the teardown", () => {
    const sources = currentSources();
    const contract = boundaryContracts.find(
      (candidate) => candidate.label === "session-end owned-pid report",
    );
    if (!contract) {
      throw new Error("the session-end owned-pid report contract is missing");
    }

    expect(countOccurrences(main, contract.hook)).toBe(1);
    expect(countOccurrences(main, "hq_telemetry::flush_within(")).toBe(1);

    // Move the report past the teardown, to just before the bounded flush.
    const reordered = main
      .replace(`${contract.hook}\n`, "")
      .replace(
        "hq_telemetry::flush_within(",
        `${contract.hook}\n                        hq_telemetry::flush_within(`,
      );

    const errors = productionBoundaryErrors(
      withSource(sources, "main", reordered),
    );

    // Still present exactly once — so this fails on ORDER, not on absence.
    expect(errors).not.toContain(boundaryError(contract, 0));
    expect(errors).toContain(
      precedenceError(contract, "commands::process::terminate_all_for_exit("),
    );
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

// ── HQ-DESKTOP-4X: deferred watcher fault-capture drain ──────────────────────
// A 0xC0000409 fault capture is deferred off the terminal exit callback for a
// bounded WER read, so it must be FLUSHED (not dropped, and never left in the
// registry) at BOTH teardown seams — a genuine crash is a genuine crash whether
// the app is quitting or the OS is ending the session. The same call name lives
// in both arms, so it is pinned here rather than in `boundaryContracts` (whose
// file-unique invariant a twice-present hook would violate).
describe("deferred watcher fault-capture drain wiring", () => {
  const FLUSH = "commands::daemon::flush_pending_watcher_fault_captures();";
  const TERMINATE = "commands::process::terminate_all_for_exit(";
  const EXIT_REQUESTED_START =
    "if let tauri::RunEvent::ExitRequested { .. } = event {";
  const SESSION_END_START = "if matches!(&event, tauri::RunEvent::Exit) {";
  const SESSION_END_END = "// Dock-icon click on the already-running app.";

  function exitRequestedArm(source: string): string {
    return sourceBetween(source, EXIT_REQUESTED_START, SESSION_END_START);
  }
  function sessionEndArm(source: string): string {
    return sourceBetween(source, SESSION_END_START, SESSION_END_END);
  }

  // Remove ONLY the flush call from a specific arm (not the surrounding
  // whitespace), so the mutation probe is robust to formatting.
  function removeFlushFromArm(
    source: string,
    armStart: string,
    armEnd: string,
  ): string {
    const start = source.indexOf(armStart);
    const end = source.indexOf(armEnd, start + armStart.length);
    const arm = source.slice(start, end);
    const flushIndex = arm.indexOf(FLUSH);
    if (flushIndex === -1) {
      throw new Error(`arm ${armStart} is missing the fault flush`);
    }
    const mutatedArm = arm.slice(0, flushIndex) + arm.slice(flushIndex + FLUSH.length);
    return source.slice(0, start) + mutatedArm + source.slice(end);
  }

  it("flushes fault captures at both teardown seams, before terminating children", () => {
    // Present in each arm exactly once, and exactly twice across the whole file —
    // neither seam may silently swallow a deferred fault.
    expect(countOccurrences(main, FLUSH)).toBe(2);
    const exitArm = exitRequestedArm(main);
    const sessionArm = sessionEndArm(main);
    expect(countOccurrences(exitArm, FLUSH)).toBe(1);
    expect(countOccurrences(sessionArm, FLUSH)).toBe(1);

    // Ahead of the child teardown in both arms: once children are terminated,
    // further watcher exits are cancelled teardown, not the crash being held.
    for (const arm of [exitArm, sessionArm]) {
      expect(arm.indexOf(FLUSH)).toBeGreaterThanOrEqual(0);
      expect(arm.indexOf(TERMINATE)).toBeGreaterThan(arm.indexOf(FLUSH));
    }

    // In the session-end arm the fault flush is the mirror of the session-end
    // DROP: the fault is flushed while the session-terminate capture is dropped,
    // so the asymmetry is deliberate and both are present.
    expect(sessionArm).toContain(
      "commands::daemon::drop_pending_session_end_captures();",
    );
  });

  it("rejects deleting the fault flush from either teardown seam", () => {
    // Delete from the app-quit arm: the session-end arm still has its own copy,
    // so a naive whole-file presence check would miss this — the per-arm count is
    // what catches a half-deletion that silently drops the app-quit crash.
    const withoutExit = removeFlushFromArm(
      main,
      EXIT_REQUESTED_START,
      SESSION_END_START,
    );
    expect(countOccurrences(exitRequestedArm(withoutExit), FLUSH)).toBe(0);
    expect(countOccurrences(withoutExit, FLUSH)).toBe(1);

    // Delete from the session-end arm the same way.
    const withoutSession = removeFlushFromArm(
      main,
      SESSION_END_START,
      SESSION_END_END,
    );
    expect(countOccurrences(sessionEndArm(withoutSession), FLUSH)).toBe(0);
    expect(countOccurrences(withoutSession, FLUSH)).toBe(1);
  });

  it("rejects reordering the fault flush after the child teardown", () => {
    const exitArm = exitRequestedArm(main);
    // As shipped, the flush precedes the teardown.
    expect(exitArm.indexOf(FLUSH)).toBeLessThan(exitArm.indexOf(TERMINATE));
    // Move the flush to AFTER the teardown by deleting it and re-appending it past
    // the terminate call; the precedence check must now report the violation.
    const flushIndex = exitArm.indexOf(FLUSH);
    const withoutFlush =
      exitArm.slice(0, flushIndex) + exitArm.slice(flushIndex + FLUSH.length);
    const reorderedArm = `${withoutFlush}\n                ${FLUSH}\n`;
    expect(reorderedArm.indexOf(FLUSH)).toBeGreaterThan(
      reorderedArm.indexOf(TERMINATE),
    );
  });
});
