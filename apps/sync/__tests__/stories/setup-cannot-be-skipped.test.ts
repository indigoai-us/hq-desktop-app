import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const desktopAlt = read('src-tauri/src/commands/desktop_alt.rs');
const mainRs = read('src-tauri/src/main.rs');
const tray = read('src-tauri/src/tray.rs');

/** Body of `open_desktop_alt_window_inner`, the one place the window is built. */
const openInner = desktopAlt.slice(
  desktopAlt.indexOf('pub async fn open_desktop_alt_window_inner'),
  desktopAlt.indexOf('tauri::WebviewWindowBuilder::new('),
);

/**
 * Regression: the first-run intro teaches Opt+Shift+O, and that shortcut opened
 * the desktop workspace while HQ was not installed. The person left setup with
 * nothing on disk. The pure predicate is unit-tested in `tray.rs`; this pins
 * the wiring, which is what was missing.
 */
describe('setup cannot be skipped by opening the desktop window', () => {
  it('guards the single window-open chokepoint', () => {
    expect(openInner).not.toBe('');
    expect(openInner).toContain('crate::tray::redirect_to_setup_if_unfinished(&app)');
  });

  it('checks setup before it hides the installer card or touches the window', () => {
    const guard = openInner.indexOf('redirect_to_setup_if_unfinished');
    const hideMain = openInner.indexOf('popover.hide()');
    const reuseWindow = openInner.indexOf('get_webview_window(WINDOW_LABEL)');
    expect(hideMain).toBeGreaterThan(-1);
    expect(reuseWindow).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(hideMain);
    expect(guard).toBeLessThan(reuseWindow);
  });

  it('does not let the global shortcut hide the installer card on its own', () => {
    const handler = mainRs.slice(
      mainRs.indexOf('shortcut == &desktop_shortcut'),
      mainRs.indexOf('global shortcut Opt+Shift+O open desktop FAILED'),
    );
    expect(handler).not.toBe('');
    expect(handler).toContain('open_desktop_alt_window_inner');
    expect(handler).not.toContain('main.hide()');
  });

  it('brings the installer card back when it refuses', () => {
    const guard = tray.slice(
      tray.indexOf('pub fn redirect_to_setup_if_unfinished'),
      tray.indexOf('/// Last-known horizontal centre'),
    );
    expect(guard).toContain('setup_blocks_desktop_window(first_run_launch, lifecycle)');
    expect(guard).toContain('show_onboarding_window(&handle)');
  });
});
