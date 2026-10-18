import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Owner, 2026-10-16: "when you open the hq app, the desktop view should
 * appear". A plain open used to start only the menu-bar item. The decision
 * itself is unit-tested in hq-desktop-core (`should_open_desktop_on_launch`);
 * this pins the startup wiring that acts on it.
 */

const root = (rel: string) =>
  fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const main = readFileSync(root('src-tauri/src/main.rs'), 'utf8');

describe('opening HQ shows the desktop view', () => {
  it('decides from the setup verdict, the login-item marker and the launch target', () => {
    expect(main).toMatch(
      /let open_desktop_on_launch = commands::first_run::should_open_desktop_on_launch\(\s*first_run,\s*launched_by_login_item\(&startup_args\),\s*launch_carries_target\(&startup_args\),\s*\);/,
    );
  });

  it('treats the macOS login item as a quiet launch', () => {
    const helper = main.slice(main.indexOf('fn launched_by_login_item('));
    expect(helper).toContain(
      'hq_platform::launchagent::argv_is_launch_agent_relaunch(argv)',
    );
  });

  it('opens the primary surface once the macOS startup gate is done', () => {
    expect(main).toMatch(
      /if webview_asset_cache::take_deferred_activation\(\) \{\s*surface_existing_instance\(&startup_app\);\s*\} else if open_desktop_on_launch \{\s*open_desktop_on_cold_launch\(&startup_app\);\s*\}/,
    );
  });

  it('opens it after the startup surfaces on other platforms', () => {
    expect(main).toMatch(
      /setup_startup_surfaces\(app\.handle\(\), first_run\)\?;\s*#\[cfg\(not\(target_os = "macos"\)\)\]\s*if open_desktop_on_launch \{\s*open_desktop_on_cold_launch\(app\.handle\(\)\);\s*\}/,
    );
  });

  it('goes through the same surface a second launch or Dock click uses', () => {
    const body = main.slice(
      main.indexOf('fn open_desktop_on_cold_launch('),
      main.indexOf('fn launched_by_login_item('),
    );
    expect(body).toContain('tray::activate_primary_surface(app);');
  });
});
