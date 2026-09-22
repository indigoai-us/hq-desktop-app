/**
 * Meeting detection must be reachable and honest.
 *
 * Background (2026-09-18, Slack report from a teammate on a fresh install):
 * the desktop meeting detector only starts once macOS Accessibility, Screen
 * Recording, and Microphone are granted (main.rs gate), the app never asks
 * for them on launch (by design — see meeting-permissions-no-launch-prompt),
 * and the only screen that asks — the Meeting Permissions window — lost its
 * last caller in #826. Result: detection silently off for every new install,
 * with no hint anywhere. These are source contracts over the real files so
 * the entry point cannot vanish again without a test going red.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const source = (...parts: string[]) => readFileSync(root(...parts), 'utf8').replace(/\r\n/g, '\n');
const ui = (...parts: string[]) => source('..', '..', 'packages', 'ui', 'src', ...parts);
const platform = (...parts: string[]) => source('..', '..', 'packages', 'platform', 'src', ...parts);

describe('Meeting Permissions setup is reachable from the live Settings surface', () => {
  const mainRs = source('src-tauri/src/main.rs');
  const syncAdapter = platform('tauri', 'sync-adapter.ts');
  const settingsPane = ui('settings', 'PrototypeSettingsPanes.svelte');
  const meetingsPage = ui('meetings', 'MeetingsPage.svelte');

  it('the Rust commands the setup needs stay registered', () => {
    expect(mainRs).toContain('commands::permissions::open_meeting_permissions_window,');
    expect(mainRs).toContain('commands::permissions::meetings_permissions_state,');
  });

  it('the desktop adapter maps the setup window and the prompt-less state read', () => {
    expect(syncAdapter).toContain("openPermissionsSetup: () => call('open_meeting_permissions_window')");
    expect(syncAdapter).toContain("permissionsState: () => call('meetings_permissions_state')");
  });

  it('Settings → Meetings shows the detection status and a Set up button', () => {
    // The live desktop Settings is @hq/ui's ShellSettings → PrototypeSettingsPanes,
    // not the desktop-alt SettingsPage (see local-bots-US-009).
    expect(settingsPane).toContain('data-testid="settings-meeting-permissions"');
    expect(settingsPane).toContain('data-testid="settings-meeting-permissions-setup"');
    expect(settingsPane).toContain('adapter.meetings.openPermissionsSetup()');
    // The row re-reads after the person returns from System Settings.
    expect(settingsPane).toContain('void refreshMeetingPermissions();');
  });

  it('the Meetings screen says when detection is off and links to the setup', () => {
    expect(meetingsPage).toContain('data-testid="meetings-detection-setup"');
    expect(meetingsPage).toContain('data-testid="meetings-detection-setup-open"');
    expect(meetingsPage).toContain('adapter.meetings.openPermissionsSetup()');
  });

  it('the setup window still starts the detector the moment permissions are granted', () => {
    const wizard = source('src/components/MeetingPermissionsWindow.svelte');
    expect(wizard).toContain("await invoke('start_recall_sdk')");
    expect(wizard).toContain("await invoke('permissions_force_native_register')");
  });
});

describe('A "Meeting detected" banner click records that meeting', () => {
  const unNotify = source('src-tauri/src/commands/un_notify.rs');
  const recallSdk = source('src-tauri/src/commands/recall_sdk.rs');

  it('the UN delegate emits the record action for the clicked window', () => {
    expect(unNotify).toContain('fn click_action_for_kind(kind: &str, window_id: &str)');
    expect(unNotify).toContain('response_user_info_string(response, "windowId")');
    expect(unNotify).toContain('app.emit(crate::events::EVENT_NOTIFICATION_MEETING_ACTION, &payload)');
  });

  it('start_recording is idempotent per window so two listeners cannot double-record', () => {
    expect(recallSdk).toContain('ledger.get(&window_id).cloned()');
    expect(recallSdk).toContain('return Ok(existing.recording_id);');
  });
});
