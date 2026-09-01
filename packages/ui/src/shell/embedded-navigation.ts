/**
 * Typed in-window navigation contract for embedded desktop hosts.
 *
 * Native hosts may receive a route before `DesktopApp` has mounted.  The host
 * owns queuing; this module owns the narrow event payload consumed by the
 * mounted shared UI. Keeping the union explicit prevents a new native route
 * from becoming an accidental silent no-op in the webview.
 */

export const EMBEDDED_NAVIGATION_EVENT = 'hq:embedded-navigation';

export const EMBEDDED_SETTINGS_SECTIONS = [
  'profile',
  'companies',
  'general',
  'appearance',
  'notifications',
  'sync',
  'meetings',
  'updates',
] as const;

export type EmbeddedSettingsSection =
  (typeof EMBEDDED_SETTINGS_SECTIONS)[number];

export type EmbeddedNavigationTarget =
  | { kind: 'home' }
  | { kind: 'inbox' }
  | { kind: 'messages' }
  | { kind: 'meetings'; meetingId?: string | null }
  | {
      kind: 'library';
      tab: 'skills' | 'workers' | 'installed' | 'marketplace' | 'submit' | 'profile';
    }
  | { kind: 'settings'; section?: EmbeddedSettingsSection | null }
  | {
      kind: 'channel';
      channelId: string;
      replyRootEventId?: string | null;
    }
  | {
      kind: 'dm';
      personUid: string;
      replyRootEventId?: string | null;
    }
  | { kind: 'unsupported'; route: string; reason: string };

/** Deliver a target only after the mounted DesktopApp has registered its listener. */
export function dispatchEmbeddedNavigation(target: EmbeddedNavigationTarget): void {
  window.dispatchEvent(
    new CustomEvent<EmbeddedNavigationTarget>(EMBEDDED_NAVIGATION_EVENT, {
      detail: target,
    }),
  );
}

export function isEmbeddedSettingsSection(
  value: string | null | undefined,
): value is EmbeddedSettingsSection {
  return EMBEDDED_SETTINGS_SECTIONS.includes(value as EmbeddedSettingsSection);
}
