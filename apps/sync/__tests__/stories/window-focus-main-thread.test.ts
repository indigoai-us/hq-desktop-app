/**
 * AppKit activation never runs off the main thread.
 *
 * HQ 0.10.35 crashed when a user clicked **Update**. `show_main_window` is an
 * `async` `#[tauri::command]`, so its body runs on a tokio worker, and it called
 * straight through to `makeKeyAndOrderFront:`. macOS 26 hard-traps AppKit window
 * calls off the main thread — `EXC_BREAKPOINT`, "Must only be used from the main
 * thread" — so the process died rather than misbehaving.
 *
 * The guard lives in `util/window_focus.rs` at the one function that genuinely
 * requires the main thread, so all async callers are covered and a new one
 * cannot reintroduce the crash. These are source-contract assertions: the
 * threading behaviour itself is only observable on a real Mac, and this repo's
 * vitest suites run on Linux/CI.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(process.cwd());
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

const WINDOW_FOCUS = 'src-tauri/src/util/window_focus.rs';

describe('window focus: AppKit activation is main-thread guarded', () => {
  it('routes raise_webview through the main-thread guard, not the raw AppKit fn', () => {
    const src = read(WINDOW_FOCUS);
    expect(src).toMatch(/fn\s+force_foreground_macos_on_main\(window: &WebviewWindow\)/);
    // raise_webview must call the guarded wrapper. If it calls the raw function
    // directly again, the crash is back.
    const raise = src.slice(src.indexOf('fn raise_webview'));
    const body = raise.slice(0, raise.indexOf('\n}\n'));
    expect(body).toMatch(/force_foreground_macos_on_main\(window\)/);
    expect(body).not.toMatch(/force_foreground_macos\(window\)/);
  });

  it('checks the thread and hops instead of assuming it is on main', () => {
    const src = read(WINDOW_FOCUS);
    expect(src).toMatch(/fn\s+is_main_thread\(\)\s*->\s*bool/);
    expect(src).toMatch(/isMainThread/);
    const guard = src.slice(src.indexOf('fn force_foreground_macos_on_main'));
    const body = guard.slice(0, guard.indexOf('\n}\n'));
    expect(body).toMatch(/if is_main_thread\(\)/);
    expect(body).toMatch(/run_on_main_thread/);
  });

  it('degrades to a logged no-op rather than killing the process', () => {
    const guard = read(WINDOW_FOCUS);
    const body = guard.slice(guard.indexOf('fn force_foreground_macos_on_main'));
    expect(body.slice(0, body.indexOf('\n}\n'))).toMatch(/logfile::log/);
  });

  it('keeps a debug assertion on the raw AppKit function', () => {
    const src = read(WINDOW_FOCUS);
    const raw = src.slice(src.indexOf('fn force_foreground_macos(window'));
    expect(raw.slice(0, raw.indexOf('\n}\n'))).toMatch(/debug_assert!\(\s*is_main_thread\(\)/);
  });

  it('documents the three async commands that made this reachable', () => {
    const src = read(WINDOW_FOCUS);
    for (const name of [
      'show_main_window',
      'launch_menubar_app',
      'open_notification_history',
    ]) {
      expect(src).toContain(name);
    }
  });
});
