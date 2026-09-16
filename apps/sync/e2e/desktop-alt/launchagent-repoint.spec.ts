import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

describe('LaunchAgent bundle-rename heal (source contracts)', () => {
  const autostart = readRepoFile('src-tauri/src/commands/autostart.rs');
  const main = readRepoFile('src-tauri/src/main.rs');
  const updater = readRepoFile('src-tauri/src/updater.rs');

  it('launches reconciliation before default-on autostart and after an update install', () => {
    expect(main).toContain('commands::autostart::reconcile_launch_agent_on_launch()');
    expect(main.indexOf('reconcile_launch_agent_on_launch()')).toBeLessThan(
      main.indexOf('commands::autostart::ensure_autostart_on_launch()'),
    );
    expect(updater).toContain('reconcile_launch_agent_after_update()');
    expect(updater).toContain('restart_preferring_launch_agent(app)');
    expect(autostart).toContain('hq_platform::launchagent::reconcile_installed(true)');
    expect(autostart).toContain('schedule_handoff_after_exit()');
    expect(autostart).toContain('exiting without GUI relaunch');
    expect(autostart).toContain(
      'pub fn restart_preferring_launch_agent(app: &tauri::AppHandle) -> !',
    );
  });

  it('does not steal focus when launchd KeepAlive starts a second copy', () => {
    expect(main).toContain('argv_is_launch_agent_relaunch(&argv)');
    expect(main).toContain('ignored launchd KeepAlive relaunch (no focus steal)');
    expect(main.indexOf('argv_is_launch_agent_relaunch(&argv)')).toBeLessThan(
      main.indexOf('surface_existing_instance(app);'),
    );
  });

  /**
   * KNOWN GAP, pre-existing and NOT introduced by the Sessions removal: the
   * healed-agent note is produced but never shown. The only consumer of
   * `take_launch_agent_repoint_notice` was the desktop-alt DesktopApp.svelte
   * tree, which had been unreachable for some time and went with the removal;
   * nothing in the @hq/ui shell drains it. The command stays registered, so
   * the note is minted and discarded.
   *
   * The backend half is asserted below so the message and its command cannot
   * drift while that is fixed. The frontend assertions are not re-pointed at
   * a surface that does not exist — that would be a test asserting nothing.
   * Tracked alongside #830 (same cause: coverage anchored to the dead shell).
   */
  it('mints a one-time non-blocking note when the agent was healed', () => {
    expect(autostart).toContain('take_launch_agent_repoint_notice');
    expect(autostart).toContain(
      '"HQ updated its launch settings; the old copy was retired"',
    );
    expect(main).toContain('commands::autostart::take_launch_agent_repoint_notice');
  });
});
