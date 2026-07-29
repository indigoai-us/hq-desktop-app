/**
 * macOS Dock icon — default-on, with a Settings opt-out.
 *
 * Source-contract coverage for the wiring that cannot be exercised from a
 * Linux/CI vitest run: the launch-time activation policy, the live re-apply
 * command, the Dock-click (Reopen) route, and the Settings toggle's
 * save-then-apply contract. The pure default semantics (`absent → shown`,
 * `explicit false → hidden`) are covered by Rust unit tests in
 * `src-tauri/src/commands/dock.rs`, which run under `cargo test --workspace`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(process.cwd());

function readRepo(...parts: string[]): string {
  const path = join(repoRoot, ...parts);
  expect(existsSync(path), `missing ${parts.join('/')}`).toBe(true);
  return readFileSync(path, 'utf8');
}

const readDock = () => readRepo('src-tauri/src/commands/dock.rs');
const readMain = () => readRepo('src-tauri/src/main.rs');
const readSettingsRs = () => readRepo('src-tauri/src/commands/settings.rs');
const readSettingsPage = () => readRepo('src/desktop-alt/pages/SettingsPage.svelte');

describe('Dock icon: default-on with a Settings opt-out', () => {
  describe('preference plumbing', () => {
    it('types dockIcon on MenubarPrefs so the toggle round-trips instead of being wiped', () => {
      const src = readRepo('../../crates/hq-desktop-core/src/config.rs');
      expect(src).toMatch(/pub dock_icon: Option<bool>/);
      // `skip_serializing_if` keeps "never chosen" distinguishable from
      // "explicitly enabled" on disk.
      expect(src).toMatch(
        /#\[serde\(default, skip_serializing_if = "Option::is_none"\)\]\s*\n\s*pub dock_icon/,
      );
    });

    it('defaults dockIcon ON in get_settings for both the no-file and on-disk branches', () => {
      const src = readSettingsRs();
      expect(src).toMatch(/dock_icon: Some\(true\)/);
      expect(src).toMatch(/dock_icon: Some\(prefs\.dock_icon\.unwrap_or\(true\)\)/);
    });

    it('resolves the pref default-on in Rust, so an upgrade gains the icon untouched', () => {
      const src = readDock();
      expect(src).toMatch(/fn\s+effective_dock_icon/);
      expect(src).toMatch(/prefs\.and_then\(\|p\| p\.dock_icon\)\.unwrap_or\(true\)/);
    });

    it('logs unreadable prefs rather than silently presenting as never-configured', () => {
      const src = readDock();
      expect(src).toMatch(/menubar\.json read failed/);
      expect(src).toMatch(/menubar\.json parse failed/);
      expect(src).toMatch(/menubar\.json path unresolved/);
    });
  });

  describe('activation policy', () => {
    it('maps the pref to Regular / Accessory in one pure helper', () => {
      const src = readDock();
      expect(src).toMatch(/fn\s+policy_for/);
      expect(src).toMatch(/tauri::ActivationPolicy::Regular/);
      expect(src).toMatch(/tauri::ActivationPolicy::Accessory/);
    });

    it('applies the pref at launch instead of hardcoding Accessory', () => {
      const src = readMain();
      expect(src).toMatch(/commands::dock::apply_at_launch\(app, commands::dock::dock_icon_pref\(\)\)/);
      // The old unconditional demotion must be gone — it would pin every user
      // to the menubar-only posture regardless of the preference.
      expect(src).not.toMatch(/app\.set_activation_policy\(tauri::ActivationPolicy::Accessory\)/);
    });

    // REGRESSION GUARD. tao's `AppState::launched` re-applies the policy it has
    // STORED when applicationDidFinishLaunching fires — which is after
    // `.setup()`. So the launch path must use `App::set_activation_policy`
    // (&mut App → stores it); the AppHandle setter calls NSApp immediately and
    // is silently overwritten, pinning every launch to tao's `Regular` default
    // and breaking the opt-out. The two paths must stay distinct.
    it('uses the &mut App setter at launch and the AppHandle setter at runtime', () => {
      const src = readDock();
      expect(src).toMatch(/pub fn apply_at_launch\(app: &mut tauri::App, show_dock_icon: bool\)/);
      expect(src).toMatch(/app\.set_activation_policy\(policy_for\(show_dock_icon\)\);/);
      expect(src).toMatch(
        /pub fn apply_at_runtime\(app: &tauri::AppHandle, show_dock_icon: bool\) -> Result<\(\), String>/,
      );
      // The launch helper must not route through the AppHandle/runtime path.
      const launchBody = src.slice(src.indexOf('pub fn apply_at_launch'));
      expect(launchBody.slice(0, launchBody.indexOf('\n}\n'))).not.toMatch(/apply_at_runtime|AppHandle/);
    });

    it('never applies the launch policy via app.handle()', () => {
      expect(readMain()).not.toMatch(/set_activation_policy\(app\.handle\(\)/);
    });

    it('keeps LSUIElement so an opted-out user never sees a Dock icon flash at login', () => {
      const plist = readRepo('src-tauri/Info.plist');
      expect(plist).toMatch(/<key>LSUIElement<\/key>\s*\n\s*<true\/>/);
    });

    it('exposes apply_dock_icon and registers it as an invokable command', () => {
      expect(readDock()).toMatch(/pub async fn apply_dock_icon/);
      expect(readMain()).toMatch(/commands::dock::apply_dock_icon/);
    });
  });

  describe('Dock click', () => {
    it('routes Reopen to the desktop window, not the compact popover', () => {
      const src = readMain();
      expect(src).toMatch(/tauri::RunEvent::Reopen/);
      expect(src).toMatch(/ActivationSource::DockIconClick/);
      expect(src).toMatch(/tray::show_desktop_window\(_app_handle\)/);
      expect(src).not.toMatch(/RunEvent::Reopen[\s\S]{0,900}?show_window_at_tray/);
    });

    it('declares DockIconClick as its own activation source mapping to ShowDesktop', () => {
      const src = readRepo('src-tauri/src/commands/desktop_alt.rs');
      expect(src).toMatch(/DockIconClick/);
      // Grouped with the other desktop-opening sources in the match arm.
      expect(src).toMatch(
        /ActivationSource::OpenHqMenu\s*\|\s*ActivationSource::DesktopShortcut\s*\|\s*ActivationSource::DockIconClick\s*=>\s*ActivationAction::ShowDesktop/,
      );
    });

    it('shows the desktop window without toggling it back off', () => {
      const src = readRepo('src-tauri/src/tray.rs');
      expect(src).toMatch(/pub fn show_desktop_window/);
      // The show-only helper must not carry toggle_desktop_window's hide branch.
      const body = src.slice(src.indexOf('pub fn show_desktop_window'));
      expect(body.slice(0, body.indexOf('\n}\n'))).not.toMatch(/\.hide\(\)/);
    });

    it('falls back to the popover sign-in surface when the desktop gate rejects', () => {
      const src = readRepo('src-tauri/src/tray.rs');
      const body = src.slice(src.indexOf('pub fn show_desktop_window'));
      expect(body.slice(0, body.indexOf('\n}\n'))).toMatch(/show_popover_window/);
    });

    it('ignores has_visible_windows — the always-on-top widget would mask it', () => {
      // Destructuring the flag would make the Dock icon a no-op for every user
      // running the floating widget (the macOS default).
      expect(readMain()).not.toMatch(/RunEvent::Reopen\s*\{\s*has_visible_windows/);
    });
  });

  describe('Settings toggle', () => {
    it('renders a macOS-only Show in Dock row', () => {
      const src = readSettingsPage();
      expect(src).toMatch(/Show in Dock/);
      expect(src).toMatch(/data-testid="dock-icon-toggle"/);
      expect(src).toMatch(/\{#if isMacOS\}/);
    });

    it('hydrates the toggle default-on, matching the Rust resolver', () => {
      expect(readSettingsPage()).toMatch(/dockIcon = settings\.dockIcon \?\? true;/);
    });

    it('persists first, then re-applies live so the change is not deferred to relaunch', () => {
      const src = readSettingsPage();
      expect(src).toMatch(/async function applyDockIcon/);
      expect(src).toMatch(/saveSettings\(\{ dockIcon \}\)/);
      expect(src).toMatch(/invoke\('apply_dock_icon'\)/);
    });

    it('reverts the optimistic checkbox when the save fails', () => {
      const src = readSettingsPage();
      expect(src).toMatch(/const previous = !dockIcon;/);
      expect(src).toMatch(/dockIcon = previous;/);
    });
  });
});
