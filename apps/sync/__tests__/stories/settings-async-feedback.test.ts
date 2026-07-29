import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const settings = readFileSync(
  new URL('../../src/desktop-alt/pages/SettingsPage.svelte', import.meta.url),
  'utf8',
);

describe('Settings async interaction feedback', () => {
  it('guards each persisted preference while its own save is pending', () => {
    expect(settings).toContain(
      'let pendingSettingsControls = $state<SettingsControlKey[]>([])',
    );
    expect(settings).toContain('async function persistSettingsControl(');
    expect(settings).toContain('if (isSettingsControlPending(control)) return false');
    expect(settings).toContain('endSettingsControl(control);');
    expect(settings).toContain(
      "isSettingsControlPending('meeting-detection') ||\n      isSettingsControlPending('meeting-platforms')",
    );

    const controls = [
      'sync-on-launch',
      'realtime-sync',
      'instant-sync',
      'personal-sync',
      'sync-notifications',
      'share-notifications',
      'dm-notifications',
      'auto-update',
      'start-at-login',
      'telemetry',
      'meeting-detection',
      'meeting-platforms',
      'default-recording-company',
    ];

    for (const control of controls) {
      expect(settings).toContain(`aria-busy={isSettingsControlPending('${control}')}`);
      expect(settings).toContain(`disabled={isSettingsControlPending('${control}')`);
    }

    // The builder-only staging switch also stays blocked throughout a core
    // install, and it remains disabled for callers outside the Indigo gate.
    expect(settings).toContain(
      "disabled={isSettingsControlPending('staging-channel') || !isIndigoBuilder || coreInstalling}",
    );
    expect(settings).toContain(
      "aria-busy={isSettingsControlPending('staging-channel') || coreInstalling}",
    );
    expect(settings).toContain(
      "disabled={isSettingsControlPending('release-channel') || availableChannels.length <= 1 || coreInstalling}",
    );
    expect(settings).toContain(
      "aria-busy={isSettingsControlPending('release-channel') || coreInstalling}",
    );
  });

  it('gives folder, external-window, clipboard, and app-lifecycle actions feedback', () => {
    const actions = [
      'hqFolderChanging',
      'notifRequesting',
      'meetingPermissionsOpening',
      'hqCliCmdCopying',
      'signingOut',
      'quitting',
    ];

    for (const action of actions) {
      expect(settings).toContain(`aria-busy={${action}}`);
    }

    expect(settings).toContain("hqFolderChanging ? 'Choosing…' : 'Change…'");
    expect(settings).toContain("notifPermission === 'denied' ? 'Opening…' : 'Requesting…'");
    expect(settings).toContain(
      "meetingPermissionsOpening ? 'Opening…' : 'Manage'",
    );
    // Opening drift details must also stay inert while the underlying report is
    // loading, refreshing, or changing channel; otherwise the user can open a
    // stale snapshot.
    expect(settings).toContain(
      'disabled={driftDetailOpening || coreStateLoading || coreRefreshing || coreChannelPending}',
    );
    expect(settings).toContain(
      'aria-busy={driftDetailOpening || coreStateLoading || coreRefreshing || coreChannelPending}',
    );
    expect(settings).toMatch(
      /\{coreChannelPending[\s\S]*?\? 'Saving channel…'[\s\S]*?: coreStateLoading \|\| coreRefreshing[\s\S]*?\? 'Checking…'[\s\S]*?: driftDetailOpening[\s\S]*?\? 'Opening…'[\s\S]*?: `\$\{coreState\?\.driftReport\.count\} drifted`/,
    );
    expect(settings).toContain('if (hqCliCmdCopying) return');
    expect(settings).toContain("? 'Copying…'");
    expect(settings).toContain("signingOut ? 'Signing out…' : 'Sign out'");
    expect(settings).toContain("quitting ? 'Quitting…' : 'Quit HQ'");
  });
});
