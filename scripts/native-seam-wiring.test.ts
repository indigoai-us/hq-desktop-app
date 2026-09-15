import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let telemetry = "";
let main = "";
let tray = "";
let windowFocus = "";
let sessionEndIntercept = "";

beforeAll(async () => {
  [telemetry, main, tray, windowFocus, sessionEndIntercept] = await Promise.all([
    readFile(resolve(rootDir, "crates/hq-telemetry/src/lib.rs"), "utf8"),
    readFile(resolve(rootDir, "apps/sync/src-tauri/src/main.rs"), "utf8"),
    readFile(resolve(rootDir, "apps/sync/src-tauri/src/tray.rs"), "utf8"),
    readFile(
      resolve(rootDir, "apps/sync/src-tauri/src/util/window_focus.rs"),
      "utf8",
    ),
    readFile(
      resolve(
        rootDir,
        "apps/sync/src-tauri/src/commands/session_end_intercept.rs",
      ),
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

type ProductionSourceName =
  | "main"
  | "tray"
  | "windowFocus"
  | "sessionEndIntercept";

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
      // `argv` is bound, not `_argv`: US-104 reads it in this closure via
      // `hqwork_url_from_argv` so a hqwork:// URL delivered to a second
      // process routes internally instead of stealing the popover. That
      // commit renamed the binding and left this marker stale, which failed
      // every `pnpm test:scripts` run on the branch.
      ".plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {",
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
    // HQ-DESKTOP-4N (r2). The read-only teardown-probe diagnostic command must
    // stay registered in the invoke handler: the live Windows E2E
    // (live-preauth.spec.ts) invokes `session_end_teardown_probe_status` against
    // the real built binary to prove the pull-based probe answers to the OS
    // shutdown flag rather than to any window message. Dropping the registration
    // would make that command vanish at runtime and silently retire the live
    // artifact proof, so the wiring is pinned against deletion, same-file
    // relocation, and reordering ahead of the session-end observer command.
    label: "session-end teardown probe command registration",
    file: "main",
    hook: "commands::windows_teardown_probe::session_end_teardown_probe_status,",
    startMarker: ".invoke_handler(tauri::generate_handler![",
    endMarker: "])",
    afterMarkers: ["commands::session_end_observer::session_end_observer_status,"],
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
    // HQ-DESKTOP-4X. A fault-exit capture held back by its deferred OS fault read
    // names a REAL 0xC0000409-class crash. An app-initiated quit must SEND it —
    // deleting this would lose the alert to the ~60s deferral horizon — before the
    // children are torn down.
    label: "app-quit deferred fault flush",
    file: "main",
    hook: 'commands::daemon::flush_pending_watcher_fault_captures("app_quit_flush");',
    startMarker: "if let tauri::RunEvent::ExitRequested { .. } = event {",
    endMarker: "if matches!(&event, tauri::RunEvent::Exit) {",
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
  // ── HQ-DESKTOP-44: Windows session-end (two seams, one shared teardown) ────
  // `WM_ENDSESSION` leaves tao's runner unable to dispatch without panicking out
  // of an `extern "system"` window procedure. There are TWO app-controlled
  // instants that beat that panic: (1) the `RunEvent::Exit` arm, when tao's
  // handler was free (non-re-entrant path), and (2) the `WH_CALLWNDPROC`
  // intercept in `commands::session_end_intercept`, when the handler was taken
  // inside wry's `wait_with_pump` (the re-entrant path `RunEvent::Exit` can never
  // reach). Both route through the SAME `windows_session_end_teardown`. Each link
  // — the install call, the decision input, the shared-teardown call, the
  // teardown steps, and each process exit — is pinned individually so deleting or
  // reordering any one fails loudly rather than silently restoring the crash.
  // The decision function's own signature is NOT a hook here: it is a start
  // marker, so pinning it would let the mutation pass delete the very anchor the
  // next contract resolves against; its presence and cfg gate are pinned by
  // "confines the session-end process exit to the Windows build" instead.
  {
    label: "session-end exit branch guard",
    file: "main",
    hook: "if app_initiated {",
    startMarker: "fn handle_run_event_exit<S, T>",
    endMarker: "fn main() {",
  },
  {
    // The WH_CALLWNDPROC intercept must be installed in main() BEFORE the tauri
    // builder, so it is armed for a WM_ENDSESSION landing during the config
    // windows' WebView2 creation inside the RunEvent::Ready dispatch. Deleting or
    // relocating the install past `tauri::Builder::default()` leaves the
    // re-entrant path uncovered.
    label: "session-end intercept install before builder",
    file: "main",
    hook: "commands::session_end_intercept::install_session_end_intercept();",
    startMarker: "fn main() {",
    endMarker: "crate::recovery::register_protocol(tauri::Builder::default())",
  },
  {
    label: "session-end exit decision input",
    file: "main",
    hook: "commands::process::app_initiated_exit(),",
    startMarker: "if matches!(&event, tauri::RunEvent::Exit) {",
    endMarker: "// Dock-icon click on the already-running app.",
  },
  {
    // The RunEvent::Exit arm must still call the SHARED teardown — not its own
    // inline copy — so the fallback path and the intercept path stay identical.
    label: "session-end exit calls shared teardown",
    file: "main",
    hook: "commands::session_end_intercept::windows_session_end_teardown(",
    startMarker: "if matches!(&event, tauri::RunEvent::Exit) {",
    endMarker: "// Dock-icon click on the already-running app.",
    afterMarkers: ["commands::process::app_initiated_exit(),"],
    beforeMarkers: ["|| std::process::exit(0),"],
  },
  {
    label: "session-end exit process exit",
    file: "main",
    hook: "|| std::process::exit(0),",
    startMarker: "if matches!(&event, tauri::RunEvent::Exit) {",
    endMarker: "// Dock-icon click on the already-running app.",
    afterMarkers: ["commands::session_end_intercept::windows_session_end_teardown("],
  },
  // ── The shared teardown body (moved into commands/session_end_intercept.rs) ─
  {
    // HQ-DESKTOP r3. Setting the durable session-end latch is the FIRST thing the
    // shared teardown does, so a watcher capture racing the one-shot drop sweep
    // still sees positive OS evidence at resolution and suppresses. It must
    // precede the drop sweep, the child teardown and the bounded flush.
    label: "teardown durable latch set",
    file: "sessionEndIntercept",
    hook: "crate::commands::session_end_latch::note_windows_session_end();",
    startMarker: "pub fn windows_session_end_teardown(app: Option<&tauri::AppHandle>) {",
    endMarker: "fn session_end_intercept() {",
    beforeMarkers: [
      "crate::commands::daemon::drop_pending_session_end_captures();",
      "crate::commands::process::terminate_all_for_exit(",
      "hq_telemetry::flush_within(",
    ],
  },
  {
    label: "teardown exit seam",
    file: "sessionEndIntercept",
    hook: "NativePanicSeam::AppSessionEndExit",
    startMarker: "pub fn windows_session_end_teardown(app: Option<&tauri::AppHandle>) {",
    endMarker: "fn session_end_intercept() {",
    afterMarkers: ["crate::commands::session_end_latch::note_windows_session_end();"],
    beforeMarkers: ["crate::commands::process::terminate_all_for_exit("],
  },
  {
    label: "teardown deferred capture drop",
    file: "sessionEndIntercept",
    hook: "crate::commands::daemon::drop_pending_session_end_captures();",
    startMarker: "pub fn windows_session_end_teardown(app: Option<&tauri::AppHandle>) {",
    endMarker: "fn session_end_intercept() {",
    beforeMarkers: ["crate::commands::process::terminate_all_for_exit("],
  },
  {
    label: "teardown deferred fault flush",
    file: "sessionEndIntercept",
    hook: 'crate::commands::daemon::flush_pending_watcher_fault_captures("session_end_flush");',
    startMarker: "pub fn windows_session_end_teardown(app: Option<&tauri::AppHandle>) {",
    endMarker: "fn session_end_intercept() {",
    afterMarkers: ["crate::commands::daemon::drop_pending_session_end_captures();"],
    beforeMarkers: ["crate::commands::process::terminate_all_for_exit("],
  },
  {
    // Read while the observer can still affirm: `shutdown` moves its readiness to
    // `Stopped`, which `attribution_now` reports as `ObserverFailed`.
    label: "teardown observer corroboration seam",
    file: "sessionEndIntercept",
    hook: "NativePanicSeam::AppSessionEndObserved",
    startMarker: "pub fn windows_session_end_teardown(app: Option<&tauri::AppHandle>) {",
    endMarker: "fn session_end_intercept() {",
    afterMarkers: ["NativePanicSeam::AppSessionEndExit"],
    beforeMarkers: ["crate::commands::process::report_session_end_owned_pids();"],
  },
  {
    // The ownership report is what the live artifact proof asserts against: it
    // must be emitted BEFORE the children are terminated, or the registry has
    // already emptied and the proof passes vacuously.
    label: "teardown owned-pid report",
    file: "sessionEndIntercept",
    hook: "crate::commands::process::report_session_end_owned_pids();",
    startMarker: "pub fn windows_session_end_teardown(app: Option<&tauri::AppHandle>) {",
    endMarker: "fn session_end_intercept() {",
    beforeMarkers: ["crate::commands::process::terminate_all_for_exit("],
  },
  {
    // Children first: at shutdown the network may already be gone, and an
    // orphaned sync daemon is worse than a dropped report.
    label: "teardown bounded sentry flush",
    file: "sessionEndIntercept",
    hook: "hq_telemetry::flush_within(",
    startMarker: "pub fn windows_session_end_teardown(app: Option<&tauri::AppHandle>) {",
    endMarker: "fn session_end_intercept() {",
    afterMarkers: ["crate::commands::process::terminate_all_for_exit("],
  },
  // ── The WH_CALLWNDPROC intercept entry (commands/session_end_intercept.rs) ──
  {
    label: "intercept seam",
    file: "sessionEndIntercept",
    hook: "NativePanicSeam::AppSessionEndIntercepted",
    startMarker: "fn session_end_intercept() {",
    endMarker: 'unsafe extern "system" fn call_wnd_proc_hook(',
    beforeMarkers: ["crate::handle_run_event_exit("],
  },
  {
    // The intercept reuses the SAME app-initiated discriminator + exit path as
    // the RunEvent::Exit arm, so a coincident app-initiated quit is a no-op.
    label: "intercept routes through handle_run_event_exit",
    file: "sessionEndIntercept",
    hook: "crate::handle_run_event_exit(",
    startMarker: "fn session_end_intercept() {",
    endMarker: 'unsafe extern "system" fn call_wnd_proc_hook(',
    beforeMarkers: ["|| std::process::exit(0),"],
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
    afterMarkers: [
      "let should_hide = should_hide_popover_on_blur(BlurHideInputs {",
      "modal_open: is_modal_open()",
    ],
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
  return { main, tray, windowFocus, sessionEndIntercept };
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
          ],
        ],
      ],
      // HQ-DESKTOP-44 (re-entrant path): the session-end teardown and the
      // WH_CALLWNDPROC intercept moved into this module, taking their seam
      // recorders with them and adding the new intercept seam.
      [
        "commands/session_end_intercept.rs",
        [
          sessionEndIntercept,
          ["AppSessionEndExit", "AppSessionEndObserved", "AppSessionEndIntercepted"],
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
      (candidate) => candidate.label === "teardown owned-pid report",
    );
    if (!contract) {
      throw new Error("the teardown owned-pid report contract is missing");
    }

    expect(countOccurrences(sessionEndIntercept, contract.hook)).toBe(1);
    expect(countOccurrences(sessionEndIntercept, "hq_telemetry::flush_within(")).toBe(
      1,
    );

    // Move the report past the teardown, to just before the bounded flush.
    const reordered = sessionEndIntercept
      .replace(`${contract.hook}\n`, "")
      .replace(
        "hq_telemetry::flush_within(",
        `${contract.hook}\n            hq_telemetry::flush_within(`,
      );

    const errors = productionBoundaryErrors(
      withSource(sources, "sessionEndIntercept", reordered),
    );

    // Still present exactly once — so this fails on ORDER, not on absence.
    expect(errors).not.toContain(boundaryError(contract, 0));
    expect(errors).toContain(
      precedenceError(
        contract,
        "crate::commands::process::terminate_all_for_exit(",
      ),
    );
  });

  // The WH_CALLWNDPROC intercept carries the second process exit of the fix. It
  // must be Windows-gated exactly like the RunEvent::Exit fast path, route
  // through the same `handle_run_event_exit`, and the deterministic re-entrancy
  // probe must be double-gated (e2e-automation feature AND the marker env var) so
  // it can never park the main thread of a shipped build.
  it("confines the intercept to Windows and double-gates the re-entrancy probe", () => {
    // The module's whole Win32 surface — including its process exit — is gated.
    expect(sessionEndIntercept).toContain('#[cfg(target_os = "windows")]\nmod win {');
    expect(countOccurrences(sessionEndIntercept, "std::process::exit")).toBe(1);
    expect(sessionEndIntercept).toContain("crate::handle_run_event_exit(");

    // The install call in main() is Windows-gated at its call site.
    expect(main).toContain(
      '#[cfg(target_os = "windows")]\n    commands::session_end_intercept::install_session_end_intercept();',
    );

    // Double gate: compiled only under e2e-automation AND armed only by the env
    // var. Dropping either would risk shipping a build that can park its main
    // thread in the probe's nested pump.
    expect(sessionEndIntercept).toContain(
      '#[cfg(all(target_os = "windows", feature = "e2e-automation"))]\npub use win::maybe_arm_reentrancy_probe;',
    );
    expect(sessionEndIntercept).toContain('#[cfg(feature = "e2e-automation")]');
    expect(sessionEndIntercept).toContain(
      'std::env::var_os("HQ_SYNC_SESSION_END_REENTRANCY_PROBE")',
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
