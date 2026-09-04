import { describe, it, expect } from 'vitest';
import {
  DEFAULT_NATIVE_NOTIFICATION_SETTINGS,
  NATIVE_NOTIFICATION_KEYS,
  readNativeNotificationSettings,
  shouldNativeNotify,
  permissionControl,
  type NativeNotificationSettings,
} from './notificationSettings';

function settings(overrides: Partial<NativeNotificationSettings> = {}): NativeNotificationSettings {
  return { ...DEFAULT_NATIVE_NOTIFICATION_SETTINGS, ...overrides };
}

describe('readNativeNotificationSettings', () => {
  it('defaults everything on when the wire is empty or missing', () => {
    expect(readNativeNotificationSettings(null)).toEqual(DEFAULT_NATIVE_NOTIFICATION_SETTINGS);
    expect(readNativeNotificationSettings({})).toEqual(DEFAULT_NATIVE_NOTIFICATION_SETTINGS);
  });

  it('hydrates persisted camelCase menubar keys', () => {
    const wire = {
      [NATIVE_NOTIFICATION_KEYS.systemNotifications]: false,
      [NATIVE_NOTIFICATION_KEYS.directMessages]: false,
      [NATIVE_NOTIFICATION_KEYS.shares]: true,
      [NATIVE_NOTIFICATION_KEYS.meetings]: false,
      [NATIVE_NOTIFICATION_KEYS.onlyWhenUnfocused]: false,
    };
    expect(readNativeNotificationSettings(wire)).toEqual({
      systemNotifications: false,
      directMessages: false,
      shares: true,
      meetings: false,
      onlyWhenUnfocused: false,
    });
  });

  it('ignores non-boolean values and falls back to defaults', () => {
    const hydrated = readNativeNotificationSettings({
      [NATIVE_NOTIFICATION_KEYS.directMessages]: 'nope',
      [NATIVE_NOTIFICATION_KEYS.shares]: 1,
    });
    expect(hydrated.directMessages).toBe(true);
    expect(hydrated.shares).toBe(true);
  });
});

describe('shouldNativeNotify', () => {
  it('fires for every kind by default while unfocused', () => {
    for (const kind of ['dm', 'share', 'meeting'] as const) {
      expect(shouldNativeNotify(settings(), { kind, appFocused: false })).toBe(true);
    }
  });

  it('master switch off suppresses every kind', () => {
    const s = settings({ systemNotifications: false });
    expect(shouldNativeNotify(s, { kind: 'dm', appFocused: false })).toBe(false);
    expect(shouldNativeNotify(s, { kind: 'share', appFocused: false })).toBe(false);
    expect(shouldNativeNotify(s, { kind: 'meeting', appFocused: false })).toBe(false);
  });

  it('per-event off suppresses only that kind', () => {
    const s = settings({ directMessages: false });
    expect(shouldNativeNotify(s, { kind: 'dm', appFocused: false })).toBe(false);
    expect(shouldNativeNotify(s, { kind: 'share', appFocused: false })).toBe(true);
    expect(shouldNativeNotify(s, { kind: 'meeting', appFocused: false })).toBe(true);
  });

  it('suppresses while focused when onlyWhenUnfocused is on (default)', () => {
    expect(shouldNativeNotify(settings(), { kind: 'dm', appFocused: true })).toBe(false);
    expect(shouldNativeNotify(settings(), { kind: 'meeting', appFocused: true })).toBe(false);
  });

  it('fires while focused when onlyWhenUnfocused is off', () => {
    const s = settings({ onlyWhenUnfocused: false });
    expect(shouldNativeNotify(s, { kind: 'dm', appFocused: true })).toBe(true);
  });

  it('master switch dominates the focus rule', () => {
    const s = settings({ systemNotifications: false, onlyWhenUnfocused: false });
    expect(shouldNativeNotify(s, { kind: 'dm', appFocused: false })).toBe(false);
    expect(shouldNativeNotify(s, { kind: 'dm', appFocused: true })).toBe(false);
  });
});

describe('permissionControl', () => {
  it('granted shows a confirmation and no button', () => {
    const c = permissionControl('granted');
    expect(c.visible).toBe(true);
    expect(c.variant).toBe('confirmation');
    expect(c.showButton).toBe(false);
    expect(c.isDenied).toBe(false);
  });

  it('prompt (notDetermined) shows an Enable button wired to request', () => {
    const c = permissionControl('prompt');
    expect(c.showButton).toBe(true);
    expect(c.buttonAction).toBe('request');
    expect(c.buttonLabel).toBe('Enable notifications');
    expect(c.isDenied).toBe(false);
  });

  it('denied shows an Open System Settings button wired to the deep link', () => {
    const c = permissionControl('denied');
    expect(c.showButton).toBe(true);
    expect(c.buttonAction).toBe('open-settings');
    expect(c.buttonLabel).toBe('Open System Settings');
    expect(c.isDenied).toBe(true);
  });

  it('unknown hides the row', () => {
    const c = permissionControl('unknown');
    expect(c.visible).toBe(false);
    expect(c.variant).toBe('hidden');
  });
});
