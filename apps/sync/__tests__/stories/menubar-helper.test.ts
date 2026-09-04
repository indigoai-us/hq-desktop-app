import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The macOS menu-bar "HQ" item is provided by a SEPARATE native AppKit helper
// process (src-tauri/helper/hq-tray-helper.swift), spawned by the main app.
//
// WHY: on macOS Tahoe, Tauri's tao runtime parks any in-process NSStatusItem
// off-screen — verified on-device across v0.7.25, v0.7.33, beta.14, and a
// hand-written in-process native item, all at x=1693 (off the visible strip),
// while a bare AppKit process places its item at x≈1237. The helper is that
// clean process. Source-contract assertions lock the whole wiring chain
// (compile → bundle → SIGN → spawn → poll) so a dropped link — most dangerously
// the signing phase, whose absence fails notarization / yields no icon — fails
// fast in CI instead of shipping a release with no menu-bar icon again.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const readIfExists = (p: string) => {
  try {
    return read(p);
  } catch {
    return '';
  }
};

describe('macOS menu-bar helper process (HQ status item)', () => {
  it('ships a native Swift helper that shows the "HQ" item + relays clicks', () => {
    const swift = read('src-tauri/helper/hq-tray-helper.swift');
    expect(swift).toContain('NSStatusBar.system.statusItem');
    expect(swift).toContain('"HQ"');
    expect(swift).toContain('makeHQTemplateImage');
    expect(swift).toContain('image.isTemplate = true');
    expect(swift).toContain('item.button?.image = mark');
    expect(swift).toContain('item.button?.imagePosition = .imageOnly');
    expect(swift).toContain('setAccessibilityLabel("HQ")');
    // Relays actions to the main app via the command file it polls. The "show"
    // command carries the icon's on-screen x so the popover anchors under it.
    expect(swift).toContain('.hq/.tray-cmd');
    expect(swift).toContain('writeCommand("show ');
    expect(swift).toContain('writeCommand("quit")');
    expect(swift).toContain('writeCommand("hide-notifications")');
    expect(swift).toContain('Hide notifications');
    expect(swift).toContain('writeCommand("widget-peek")');
    expect(swift).toContain('writeCommand("updates")');
    expect(swift).toContain('writeCommand("recovery")');
    expect(swift).toContain('Check for updates…');
    expect(swift).toContain('Recovery…');
    // Self-exits when the main app (argv[1] PID) dies — no orphan icon.
    expect(swift).toContain('kill(hqPid, 0)');
  });

  it('opens the popover on LEFT-click (menu on right-click) and activates the app', () => {
    const swift = read('src-tauri/helper/hq-tray-helper.swift');
    // Left-click handled via the button action (NOT item.menu, which would make
    // a plain click open the menu instead of the popover).
    expect(swift).toContain('item.button?.action = #selector(statusItemClicked)');
    expect(swift).toContain('sendAction(on: [.leftMouseUp, .rightMouseUp])');
    expect(swift).toContain('.rightMouseUp');
    // Left-click activates the main app so the background-launched popover
    // reliably comes to the front (the bug the user hit: click did nothing).
    expect(swift).toContain('func activateHQ()');
    expect(swift).toContain('NSRunningApplication(processIdentifier: hqPid)');
    expect(swift).toContain('activateHQ()');
  });

  it('reports the icon position so the popover anchors under it (not top-right)', () => {
    const swift = read('src-tauri/helper/hq-tray-helper.swift');
    // The helper reads the status button window's centre and ships it with "show".
    expect(swift).toContain('frame.midX');
    const helper = read('src-tauri/src/tray_helper.rs');
    // The poller parses "show <x>" and records the anchor before toggling.
    expect(helper).toContain('strip_prefix("show")');
    expect(helper).toContain('set_tray_anchor_x');
    const tray =
      readIfExists('src-tauri/src/tray.rs') +
      '\n' +
      readIfExists('../../crates/hq-platform/src/tray_geometry.rs');
    // The positioner uses the anchor (centre − half width) to place the popover
    // on the monitor the icon was clicked on, and only falls back to the primary
    // corner when the icon position is unknown / off every display.
    expect(tray).toContain('pub fn set_tray_anchor_x');
    expect(tray).toContain('tray_anchor_x_points()');
    // Picks the monitor whose span contains the anchor (multi-monitor fix) —
    // never hard-codes the primary display.
    expect(tray).toContain('position_popover_under_anchor');
    expect(tray).toMatch(/available_monitors\(\)/);
    expect(tray).toMatch(/center_px - win_w \/ 2/);
  });

  it('builds a verified universal helper on macOS and fails loud if any tool breaks', () => {
    const build = read('src-tauri/build.rs');
    const support = read('src-tauri/build_support/tray_helper.rs');
    expect(build).toContain('CARGO_CFG_TARGET_OS');
    expect(build).toContain('helper/hq-tray-helper.swift');
    expect(build).toContain('tray_helper_build::build_universal_helper');
    expect(build).toMatch(
      /\.unwrap_or_else\(\|error\| panic!\("build\.rs: failed to build hq-tray-helper:/,
    );

    // Compile both promised architectures at the app's macOS floor, merge
    // them, then verify architecture and deployment metadata before the
    // resource is atomically published into the bundle.
    expect(support).toContain('MACOS_DEPLOYMENT_TARGET: &str = "13.0"');
    expect(support).toContain('["arm64", "x86_64"]');
    expect(support).toContain('.arg("swiftc")');
    expect(support).toContain('.arg("lipo").arg("-create")');
    expect(support).toContain('.arg("vtool")');
    expect(support).toContain('validate_architectures(');
    expect(support).toContain('validate_minimum_versions(');
    expect(support).toContain('publish_verified_helper(');

    // Every native command returns an error on a non-zero status; build.rs
    // converts that Result into a panic, so CI cannot silently ship no icon.
    expect(support).toContain('if output.status.success()');
    expect(support).toMatch(/Err\(format!\(\s*"failed to \{description\}/);
  });

  it('bundles the compiled helper into Contents/Resources', () => {
    const conf =
      readIfExists('src-tauri/tauri.conf.json') +
      '\n' +
      readIfExists('src-tauri/tauri.macos.conf.json');
    expect(conf).toContain('"helper/hq-tray-helper": "hq-tray-helper"');
  });

  it('SIGNS the helper before sealing the bundle (notarization-critical)', () => {
    const sign = read('scripts/sign-bundle.sh');
    expect(sign).toContain('Contents/Resources/hq-tray-helper');
    // Signed in Phase 5b — before Phase 8 seals the .app.
    expect(sign).toMatch(/Phase 5b[\s\S]*sign_file "\$APP\/Contents\/Resources\/hq-tray-helper"/);
  });

  it('main.rs spawns the helper on macOS and skips the off-screen tao tray', () => {
    const main = read('src-tauri/src/main.rs');
    expect(main).toContain('tray_helper::spawn_and_poll');
    const tray = read('src-tauri/src/tray.rs');
    // On macOS the tao tray is NOT built (it lands off-screen); only non-macOS
    // builds the tao TrayIcon.
    expect(tray).toContain('#[cfg(not(target_os = "macos"))]');
    expect(tray).toContain('menu-bar item provided by native helper');
  });

  it('tray_helper polls the command file and dispatches show/sync/quit', () => {
    const helper = read('src-tauri/src/tray_helper.rs');
    expect(helper).toContain('.tray-cmd');
    // US-004 retarget: menu-bar click toggles the COMPACT popover. Full desktop
    // is reserved for the right-click "desktop" command. The "show" command
    // still carries the icon anchor for popover positioning.
    expect(helper).toContain('strip_prefix("show")');
    expect(helper).toContain('set_tray_anchor_x');
    expect(helper).toContain('activate_primary_surface');
    expect(helper).not.toMatch(
      /strip_prefix\("show"\)[\s\S]*?toggle_desktop_window/,
    );
    expect(helper).toContain('"quit" => app.exit(0)');
    expect(helper).toContain('"hide-notifications" =>');
    expect(helper).toContain('"widget-peek" =>');
    expect(helper).toContain('"updates" =>');
    expect(helper).toContain('"recovery" =>');
    expect(helper).toContain('spawn_tray_check_for_updates');
    expect(helper).toContain('spawn_tray_open_recovery');
    expect(helper).toContain('set_tray_message_badge_is_a_noop_off_macos');
  });

  it('popover toggle shows on-screen, suppresses auto-hide, and is single-window', () => {
    const tray = read('src-tauri/src/tray.rs');
    // The popover is repositioned on-screen (the off-screen tao rect dragged it
    // off the right edge) and the spurious auto-hide is suppressed.
    expect(tray).toContain('pub fn show_popover_window');
    expect(tray).toContain('suppress_blur_hide_briefly');
    expect(tray).toContain('set_position');
    // Toggle: hide if already visible, else show.
    expect(tray).toContain('pub fn toggle_popover_window');
    expect(tray).toMatch(/is_visible\(\)\.unwrap_or\(false\)[\s\S]*?\.hide\(\)/);
    // Single-window: showing the popover hides the desktop window.
    expect(tray).toContain('pub fn hide_desktop_alt');
    expect(tray).toContain('get_webview_window("desktop-alt")');
  });

  it('the two global shortcuts toggle their window (single-window enforced)', () => {
    const main = read('src-tauri/src/main.rs');
    // Both shortcuts marshal their window ops onto the main thread (the
    // is_visible toggle query deadlocks AppKit off-main) and toggle.
    expect(main).toContain('run_on_main_thread');
    expect(main).toContain('tray::toggle_popover_window(&app_main)');
    // Opt+Shift+O toggles the desktop window (hide if visible, else open).
    expect(main).toContain('tray::hide_desktop_alt(&app_main)');
    expect(main).toMatch(/desktop_visible[\s\S]*?open_desktop_alt_window_inner/);
    // Opening the desktop hides the popover (single-window) at the canonical path.
    const desktop = read('src-tauri/src/commands/desktop_alt.rs');
    expect(desktop).toMatch(/get_webview_window\("main"\)[\s\S]*?\.hide\(\)/);
  });

  it('marshals the menu-bar click toggle onto the main thread (no poll-thread deadlock)', () => {
    const helper = read('src-tauri/src/tray_helper.rs');
    // The poll thread must NOT call window ops directly — it marshals them.
    expect(helper).toMatch(/run_on_main_thread\([\s\S]*?activate_primary_surface/);
  });
});
