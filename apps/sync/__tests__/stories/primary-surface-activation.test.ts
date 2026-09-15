import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const tray = readFileSync('src-tauri/src/tray.rs', 'utf8');

it('keeps the installer card while setup owns main, and opens desktop once HQ is installed', () => {
  // Run the actual Rust dispatcher with recording adapters, without a GUI.
  const start = tray.indexOf('pub fn activate_primary_surface(');
  const end = tray.indexOf('\n}\n', start) + 2;
  expect(start).toBeGreaterThan(-1);
  const dir = mkdtempSync(join(tmpdir(), 'hq-primary-activation-'));
  try {
    const source = join(dir, 'activation.rs');
    const binary = join(dir, 'activation');
    writeFileSync(source, `
use std::cell::RefCell;
pub struct AppHandle { pinned: bool, calls: RefCell<Vec<&'static str>> }
fn onboarding_window_requires_blur_suppression(app: &AppHandle) -> bool { app.pinned }
fn show_popover_window(app: &AppHandle) { app.calls.borrow_mut().push("popover"); }
fn show_desktop_window(app: &AppHandle) { app.calls.borrow_mut().push("desktop"); }
${tray.slice(start, end)}
fn main() {
    for pinned in [false, true] {
        let app = AppHandle { pinned, calls: RefCell::new(vec![]) };
        activate_primary_surface(&app);
        activate_primary_surface(&app);
        let expected = if pinned { vec!["popover", "popover"] } else { vec!["desktop", "desktop"] };
        assert_eq!(*app.calls.borrow(), expected, "setup owns main: {pinned}");
    }
}
`);
    const compile = spawnSync('rustc', ['--edition=2021', source, '-o', binary], { encoding: 'utf8' });
    expect(compile.status, compile.stderr).toBe(0);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Compiles the dispatcher with rustc, which takes several seconds on CI runners.
}, 60_000);

it('does not substitute the popover if desktop opening fails', () => {
  const show = tray.slice(tray.indexOf('pub fn show_desktop_window('), tray.indexOf('pub fn activate_primary_surface('));
  expect(show).toContain('open_desktop_alt_window_inner');
  expect(show).not.toContain('show_popover_window(');
});
