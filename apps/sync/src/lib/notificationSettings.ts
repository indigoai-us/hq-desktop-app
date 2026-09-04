/**
 * Native (OS) notification settings — the frontend mirror of the Rust gate in
 * `crates/hq-desktop-core/src/native_notify.rs`.
 *
 * The Settings → Notifications pane persists these keys into `menubar.json`
 * (via the shared settings queue), and the Rust delivery path reads them back
 * to decide whether an OS banner fires. This module keeps the same decision as
 * a pure function so the UI can preview it and so the contract is unit-tested
 * on the JS side without a live Tauri backend.
 *
 * The app only distinguishes three native event kinds today — direct messages,
 * file shares, and meeting detections / recaps — so those are the per-event
 * toggles. (The notification code carries no mention/channel distinction, so we
 * don't invent one here.)
 */

/** A native notification event kind the app distinguishes. */
export type NativeNotificationKind = 'dm' | 'share' | 'meeting';

/** User-controllable native-notification settings, as stored in menubar.json. */
export interface NativeNotificationSettings {
  /** Master switch: when false, no OS banner fires for any kind. */
  systemNotifications: boolean;
  /** Per-event: direct messages. */
  directMessages: boolean;
  /** Per-event: file shares. */
  shares: boolean;
  /** Per-event: meeting detections / recaps. */
  meetings: boolean;
  /** Suppress OS banners while an HQ window is focused. */
  onlyWhenUnfocused: boolean;
}

/**
 * Sensible defaults — every banner on, focus-suppression on. Matches the Rust
 * `get_settings` defaults so a fresh install agrees on both sides.
 */
export const DEFAULT_NATIVE_NOTIFICATION_SETTINGS: NativeNotificationSettings = {
  systemNotifications: true,
  directMessages: true,
  shares: true,
  meetings: true,
  onlyWhenUnfocused: true,
};

/** The camelCase menubar.json keys these settings serialize to. */
export const NATIVE_NOTIFICATION_KEYS = {
  systemNotifications: 'systemNotifications',
  directMessages: 'nativeNotifyDirectMessages',
  shares: 'nativeNotifyShares',
  meetings: 'nativeNotifyMeetings',
  onlyWhenUnfocused: 'nativeNotifyOnlyWhenUnfocused',
} as const;

/** Read a boolean field from a loosely-typed settings blob, defaulting when absent/non-bool. */
function readBool(source: Record<string, unknown> | null | undefined, key: string, fallback: boolean): boolean {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Hydrate `NativeNotificationSettings` from a persisted settings wire object
 * (the `get_settings` result). Missing or malformed fields fall back to the
 * defaults, mirroring the Rust `unwrap_or(true)` behaviour.
 */
export function readNativeNotificationSettings(
  wire: Record<string, unknown> | null | undefined,
): NativeNotificationSettings {
  return {
    systemNotifications: readBool(wire, NATIVE_NOTIFICATION_KEYS.systemNotifications, true),
    directMessages: readBool(wire, NATIVE_NOTIFICATION_KEYS.directMessages, true),
    shares: readBool(wire, NATIVE_NOTIFICATION_KEYS.shares, true),
    meetings: readBool(wire, NATIVE_NOTIFICATION_KEYS.meetings, true),
    onlyWhenUnfocused: readBool(wire, NATIVE_NOTIFICATION_KEYS.onlyWhenUnfocused, true),
  };
}

/** Whether the per-event toggle for a given kind is on. */
function eventEnabled(settings: NativeNotificationSettings, kind: NativeNotificationKind): boolean {
  switch (kind) {
    case 'dm':
      return settings.directMessages;
    case 'share':
      return settings.shares;
    case 'meeting':
      return settings.meetings;
  }
}

/**
 * Pure native-banner decision, matching `native_notify::should_native_notify_from`
 * in Rust. Returns true when a banner of `kind` should fire.
 *
 * Order (any failing stage suppresses): master switch → per-event switch →
 * focus rule (suppress while focused when `onlyWhenUnfocused`).
 */
export function shouldNativeNotify(
  settings: NativeNotificationSettings,
  event: { kind: NativeNotificationKind; appFocused: boolean },
): boolean {
  if (!settings.systemNotifications) return false;
  if (!eventEnabled(settings, event.kind)) return false;
  if (event.appFocused && settings.onlyWhenUnfocused) return false;
  return true;
}

/** OS notification authorization states surfaced by the Rust permission probe. */
export type NotificationPermissionState = 'granted' | 'denied' | 'prompt' | 'unknown';

/**
 * How the permission row should render for a given OS authorization state.
 * Pure so the state → UI mapping is unit-tested.
 *
 *   * `granted`  → subtle confirmation, no button.
 *   * `denied`   → explanation that macOS is blocking HQ + an "Open System
 *                  Settings" deep-link button.
 *   * `prompt`   (notDetermined) → an "Enable notifications" button that
 *                  triggers requestAuthorization.
 *   * `unknown`  → hidden (the caller doesn't render the row until resolved).
 */
export interface PermissionControl {
  /** Whether to render the permission row at all. */
  visible: boolean;
  /** Confirmation vs. actionable. */
  variant: 'confirmation' | 'action' | 'hidden';
  /** True when the primary control is a button (prompt / open-settings). */
  showButton: boolean;
  /** Which command the button should invoke. */
  buttonAction: 'request' | 'open-settings' | null;
  /** Button label. */
  buttonLabel: string | null;
  /** True when the state is a hard denial (open System Settings, not prompt). */
  isDenied: boolean;
}

export function permissionControl(state: NotificationPermissionState): PermissionControl {
  switch (state) {
    case 'granted':
      return {
        visible: true,
        variant: 'confirmation',
        showButton: false,
        buttonAction: null,
        buttonLabel: null,
        isDenied: false,
      };
    case 'denied':
      return {
        visible: true,
        variant: 'action',
        showButton: true,
        buttonAction: 'open-settings',
        buttonLabel: 'Open System Settings',
        isDenied: true,
      };
    case 'prompt':
      return {
        visible: true,
        variant: 'action',
        showButton: true,
        buttonAction: 'request',
        buttonLabel: 'Enable notifications',
        isDenied: false,
      };
    case 'unknown':
    default:
      return {
        visible: false,
        variant: 'hidden',
        showButton: false,
        buttonAction: null,
        buttonLabel: null,
        isDenied: false,
      };
  }
}
