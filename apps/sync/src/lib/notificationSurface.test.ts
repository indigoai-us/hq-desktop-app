import { describe, expect, it } from 'vitest';
import {
  defaultNotificationSurface,
  notificationSurfacePatch,
  resolveNotificationSurface,
  resolveUseSystemBanners,
} from './notificationSurface';

describe('notification surface default resolution', () => {
  it('resolves an unset preference to system notifications on macOS', () => {
    // The whole point of the flip: a user who never touched the control gets
    // real Notification Center banners.
    for (const settings of [
      undefined,
      null,
      {},
      { notificationSurface: null, customBanner: null },
      // A legacy `customBanner: true` is a default-write artifact, not a
      // choice — every get_settings used to coerce it.
      { customBanner: true },
      { notificationSurface: undefined, customBanner: true },
    ]) {
      expect(resolveNotificationSurface(settings, true)).toBe('system');
      expect(resolveUseSystemBanners(settings, true)).toBe(true);
    }
  });

  it('keeps the in-app banner as the unset default off macOS', () => {
    expect(resolveNotificationSurface({}, false)).toBe('custom');
    expect(resolveUseSystemBanners({ customBanner: true }, false)).toBe(false);
  });

  it('honors an explicit custom choice over the system default', () => {
    const settings = { notificationSurface: 'custom' };
    expect(resolveNotificationSurface(settings, true)).toBe('custom');
    expect(resolveUseSystemBanners(settings, true)).toBe(false);
    // Explicit key beats the legacy flag either way round.
    expect(
      resolveNotificationSurface({ notificationSurface: 'custom', customBanner: false }, true),
    ).toBe('custom');
  });

  it('honors an explicit system choice', () => {
    for (const isMacOS of [true, false]) {
      expect(resolveNotificationSurface({ notificationSurface: 'system' }, isMacOS)).toBe('system');
      expect(
        resolveNotificationSurface({ notificationSurface: 'system', customBanner: true }, isMacOS),
      ).toBe('system');
    }
  });

  it('treats a legacy customBanner:false as a pre-existing system opt-in', () => {
    // Nothing ever wrote `false` by default, so it is unambiguous and must
    // survive on every platform.
    expect(resolveNotificationSurface({ customBanner: false }, true)).toBe('system');
    expect(resolveNotificationSurface({ customBanner: false }, false)).toBe('system');
  });

  it('falls through to the default for an unrecognised surface string', () => {
    expect(resolveNotificationSurface({ notificationSurface: 'holographic' }, true)).toBe('system');
    expect(resolveNotificationSurface({ notificationSurface: '' }, false)).toBe('custom');
  });

  it('exposes the platform default directly', () => {
    expect(defaultNotificationSurface(true)).toBe('system');
    expect(defaultNotificationSurface(false)).toBe('custom');
  });
});

describe('notification surface persistence', () => {
  it('records the explicit choice and keeps the legacy key in sync', () => {
    expect(notificationSurfacePatch(true)).toEqual({
      notificationSurface: 'system',
      customBanner: false,
    });
    expect(notificationSurfacePatch(false)).toEqual({
      notificationSurface: 'custom',
      customBanner: true,
    });
  });

  it('round-trips the persisted patch back to the same toggle state', () => {
    for (const useSystemBanners of [true, false]) {
      const patch = notificationSurfacePatch(useSystemBanners);
      expect(resolveUseSystemBanners(patch, true)).toBe(useSystemBanners);
      expect(resolveUseSystemBanners(patch, false)).toBe(useSystemBanners);
    }
  });
});
