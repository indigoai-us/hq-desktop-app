/**
 * Notification-surface resolution for Settings > Notifications.
 *
 * macOS system notifications are the DEFAULT surface. The mirror of this logic
 * lives in Rust (`hq_desktop_core::banner::custom_banner_enabled_from`), which is
 * what actually routes each delivery; this module exists so the Settings toggle
 * renders the same answer the backend will act on.
 *
 * Two keys in `menubar.json` are involved:
 *
 *   * `notificationSurface` — `'system' | 'custom'`. The EXPLICIT choice. Only
 *     the toggle below ever writes it, and `get_settings` passes it through
 *     without defaulting, so its presence is a durable record of user intent.
 *   * `customBanner` — the legacy boolean. `false` was only ever written by the
 *     old toggle, so it is honored as a pre-existing opt-in to system banners.
 *     `true`, however, was written unconditionally by every `get_settings`
 *     before this change and re-persisted on every unrelated save, so it carries
 *     no intent and must NOT keep a user on the in-app banner.
 */

/** The explicit surface choice as persisted in `menubar.json`. */
export type NotificationSurface = 'system' | 'custom';

/** The subset of persisted settings this decision reads. */
export type NotificationSurfaceSettings = {
  notificationSurface?: string | null;
  customBanner?: boolean | null;
};

/**
 * The surface used when the user has never chosen. macOS gets system
 * notifications; other platforms keep the in-app banner, matching
 * `banner::default_custom_banner` in Rust.
 */
export function defaultNotificationSurface(isMacOS: boolean): NotificationSurface {
  return isMacOS ? 'system' : 'custom';
}

/**
 * Resolve the surface to render in Settings, in the same priority order the Rust
 * gate uses: explicit key, then a legacy `customBanner: false`, then the
 * platform default.
 */
export function resolveNotificationSurface(
  settings: NotificationSurfaceSettings | null | undefined,
  isMacOS: boolean,
): NotificationSurface {
  const explicit = settings?.notificationSurface;
  if (explicit === 'system' || explicit === 'custom') return explicit;
  if (settings?.customBanner === false) return 'system';
  return defaultNotificationSurface(isMacOS);
}

/** True when the "macOS system notifications" toggle should render checked. */
export function resolveUseSystemBanners(
  settings: NotificationSurfaceSettings | null | undefined,
  isMacOS: boolean,
): boolean {
  return resolveNotificationSurface(settings, isMacOS) === 'system';
}

/**
 * The patch the toggle persists. Both keys are written: `notificationSurface` is
 * the record of the choice, and `customBanner` is kept in sync so the vendored
 * Windows fork (which still reads only that key) agrees with the choice.
 */
export function notificationSurfacePatch(useSystemBanners: boolean): {
  notificationSurface: NotificationSurface;
  customBanner: boolean;
} {
  return {
    notificationSurface: useSystemBanners ? 'system' : 'custom',
    customBanner: !useSystemBanners,
  };
}
