import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

describe('LaunchAgent bundle-rename heal (source contracts)', () => {
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const autostart = readRepoFile('src-tauri/src/commands/autostart.rs');
  const main = readRepoFile('src-tauri/src/main.rs');
  const updater = readRepoFile('src-tauri/src/updater.rs');

  it('launches reconciliation before default-on autostart and after an update install', () => {
    expect(main).toContain('commands::autostart::reconcile_launch_agent_on_launch()');
    expect(main.indexOf('reconcile_launch_agent_on_launch()')).toBeLessThan(
      main.indexOf('commands::autostart::ensure_autostart_on_launch()'),
    );
    expect(updater).toContain('reconcile_launch_agent_after_update()');
    expect(autostart).toContain('hq_platform::launchagent::reconcile_installed(true)');
  });

  it('surfaces a one-time non-blocking note when the agent was healed', () => {
    expect(desktopApp).toContain("invoke<string | null>('take_launch_agent_repoint_notice')");
    expect(desktopApp).toContain('flashToast(note, \'neutral\')');
    expect(desktopApp).toContain('data-testid={actionToast.text === \'HQ updated its launch settings; the old copy was retired\'');
    expect(autostart).toContain('take_launch_agent_repoint_notice');
    expect(autostart).toContain(
      '"HQ updated its launch settings; the old copy was retired"',
    );
    expect(main).toContain('commands::autostart::take_launch_agent_repoint_notice');
  });
});
