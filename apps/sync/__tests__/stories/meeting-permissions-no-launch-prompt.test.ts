import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/**
 * Regression guard: HQ Sync must NOT request any macOS permission when it is
 * installed or opened. Asking for Accessibility / Screen Recording /
 * Microphone / Notifications now lives exclusively behind desktop Settings
 * (SettingsPage → Meeting permissions / "Enable notifications"). A clean-room
 * VM opening the app for the first time should see zero permission dialogs.
 *
 * These are source-contract assertions (same style as the US-* story tests):
 * the launch path is wiring inside Tauri `.setup()` + the App `$effect`, which
 * can't be exercised headlessly without a real signed bundle, so we lock the
 * contract at the source level instead.
 */

const mainRs = source(resolve(process.cwd(), 'src-tauri/src/main.rs'));
const recallSdkRs = source(resolve(process.cwd(), 'src-tauri/src/commands/recall_sdk.rs'));
const appSvelte = source(resolve(process.cwd(), 'src/App.svelte'));
// Canonical settings surface after US-005 (popover Settings.svelte retired).
const settingsPageSvelte = source(
  resolve(process.cwd(), 'src/desktop-alt/pages/SettingsPage.svelte'),
);
const wizardSvelte = source(
  resolve(process.cwd(), 'src/components/MeetingPermissionsWindow.svelte'),
);

describe('No permission prompts on install / open', () => {
  it('does not fire the native TCC prompt (permissions_force_native_register) on launch', () => {
    // The prompting call (with parens) must not appear anywhere in main.rs —
    // it now belongs to the Settings wizard only. The command may still be
    // REGISTERED in the invoke_handler list (a bare path + comma, no parens).
    expect(mainRs).not.toContain('permissions_force_native_register()');
    expect(mainRs).toContain(
      'commands::permissions::permissions_force_native_register,',
    );
  });

  it('does not auto-open the meeting-permissions wizard on launch', () => {
    // No invocation of the wizard opener in main.rs's setup path. It remains
    // registered for the Settings button to call.
    expect(mainRs).not.toContain('open_meeting_permissions_window(');
    expect(mainRs).toContain(
      'commands::permissions::open_meeting_permissions_window,',
    );
  });

  it('only starts the Recall SDK on launch once required permissions are already granted', () => {
    // The launch path reads TCC status (prompt-less) and only starts the SDK
    // when all_required_granted — so the SDK never triggers prompts on a fresh
    // open.
    expect(mainRs).toContain('commands::permissions::meetings_permissions_state()');
    expect(mainRs).toContain('state.all_required_granted');
    expect(mainRs).toContain('commands::recall_sdk::start_recall_sdk(handle.clone())');
    // The gate must be evaluated before the SDK is started.
    const gateIdx = mainRs.indexOf('state.all_required_granted');
    const startIdx = mainRs.indexOf('start_recall_sdk(handle.clone())');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(gateIdx);
  });

  it('exposes start_recall_sdk as a Tauri command so Settings can start it after grant', () => {
    expect(recallSdkRs).toContain('#[tauri::command]\npub async fn start_recall_sdk');
    expect(mainRs).toContain('commands::recall_sdk::start_recall_sdk,');
  });

  it('does not request notification permission from App.svelte on mount', () => {
    expect(appSvelte).not.toContain('requestNotificationPermissionOnce');
    expect(appSvelte).not.toContain("'notification_request_permission'");
  });
});

describe('SettingsPage remains the only place permissions are requested', () => {
  it('loads meeting + notification permission state non-prompting on mount', () => {
    // Non-prompting reads only — loadMeetingPermissions + notification_permission_state.
    expect(settingsPageSvelte).toContain('loadMeetingPermissions');
    expect(settingsPageSvelte).toContain("'notification_permission_state'");
    // Mount effect must not call the prompting notification request.
    // notification_request_permission is only in handleEnableNotifications.
    const mountEffectIdx = settingsPageSvelte.indexOf('void loadMeetingPermissions()');
    expect(mountEffectIdx).toBeGreaterThan(-1);
    // The prompting invoke lives only inside handleEnableNotifications.
    expect(settingsPageSvelte).toContain('async function handleEnableNotifications');
    const handlerIdx = settingsPageSvelte.indexOf('async function handleEnableNotifications');
    const requestIdx = settingsPageSvelte.indexOf("'notification_request_permission'");
    expect(requestIdx).toBeGreaterThan(handlerIdx);
    // And the mount path before the handler must not contain the request.
    const beforeHandler = settingsPageSvelte.slice(0, handlerIdx);
    expect(beforeHandler).not.toContain("'notification_request_permission'");
  });

  it('keeps the user-initiated notification request only in handleEnableNotifications', () => {
    expect(settingsPageSvelte).toContain("'notification_request_permission'");
    // Exactly one call site (user click), not on load.
    const matches = settingsPageSvelte.match(/'notification_request_permission'/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('keeps the Settings entry point to the meeting-permissions wizard', () => {
    expect(settingsPageSvelte).toContain('open_meeting_permissions_window');
  });

  it('lets the wizard fire the native prompts on explicit user action', () => {
    expect(wizardSvelte).toContain("invoke('permissions_force_native_register')");
  });

  it('starts the SDK from the wizard once all required permissions are granted', () => {
    expect(wizardSvelte).toContain("invoke('start_recall_sdk')");
    expect(wizardSvelte).toContain('if (allGranted && !sdkStartAttempted)');
  });
});
