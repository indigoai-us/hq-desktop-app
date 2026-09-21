/**
 * Native pending-route / `desktop:navigate` grammar for the desktop shell.
 *
 * Wire strings are colon-separated (slashes normalize to colons). Inbox
 * conversation deep links are:
 *   inbox
 *   inbox:dm:<personUid>
 *   inbox:channel:<channelId>[:<messageId>]
 *
 * URL schemes (`hq://`, `hqwork://`, `hq-desktop://`) are handled by the
 * host before this parser runs. `hq://` maps onto these wire strings:
 *   inbox:dm:<personUid>
 *   inbox:channel:<channelId>[:<messageId>]
 *   files:<slug>:<path>
 *   company:<slug>[:<tab>]
 *   meetings
 */

import {
  isEmbeddedSettingsSection,
  type EmbeddedNavigationTarget,
  type EmbeddedSettingsSection,
} from '@hq/ui';

export type DesktopLibraryTab =
  | 'skills'
  | 'workers'
  | 'installed'
  | 'marketplace'
  | 'submit'
  | 'profile';

export type DesktopRoute =
  | { kind: 'home' }
  | {
      kind: 'inbox';
      dm?: string;
      channelId?: string;
      messageId?: string;
    }
  | { kind: 'messages' }
  | { kind: 'meetings' }
  | { kind: 'files'; slug: string; path: string }
  | { kind: 'company'; slug: string; tab?: string }
  | { kind: 'atlas' }
  | { kind: 'library'; tab: DesktopLibraryTab }
  | { kind: 'settings'; section?: EmbeddedSettingsSection }
  | { kind: 'sessions'; param?: string | null }
  | { kind: 'unsupported'; route: string; reason: string };

const LIBRARY_TABS = new Set<string>([
  'skills',
  'workers',
  'installed',
  'marketplace',
  'submit',
  'profile',
]);

function isLibraryTab(value: string): value is DesktopLibraryTab {
  return LIBRARY_TABS.has(value);
}

function trimSegment(value: string | undefined): string {
  return value?.trim() ?? '';
}

/** Parse a native route string. Empty input is `null` (keep the current screen). */
export function parseDesktopRoute(
  raw: string | null | undefined,
): DesktopRoute | null {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return null;

  const normalized = trimmed.replace(/\//g, ':');
  const [kind, detail, ...rest] = normalized.split(':');
  const hasExtraSegments = rest.length > 0;

  switch (kind) {
    case 'home':
    case 'sync':
    case 'activity':
    case 'core-drift':
    case 'drift':
      if (!detail) return { kind: 'home' };
      break;
    case 'inbox':
    case 'notifications':
      if (!detail) return { kind: 'inbox' };
      if (detail === 'dm') {
        const dm = rest.join(':').trim();
        return dm ? { kind: 'inbox', dm } : { kind: 'inbox' };
      }
      if (detail === 'channel') {
        const channelId = trimSegment(rest[0]);
        const messageId = rest.slice(1).join(':').trim();
        if (!channelId) return { kind: 'inbox' };
        return messageId
          ? { kind: 'inbox', channelId, messageId }
          : { kind: 'inbox', channelId };
      }
      break;
    case 'messages':
      if (!detail) return { kind: 'messages' };
      break;
    case 'meetings':
      if (!detail) return { kind: 'meetings' };
      break;
    case 'files': {
      const slug = trimSegment(detail);
      const path = rest.join(':').trim();
      if (slug && path) return { kind: 'files', slug, path };
      break;
    }
    case 'company': {
      const slug = trimSegment(detail);
      if (slug && rest.length <= 1) {
        const tab = trimSegment(rest[0]);
        return tab ? { kind: 'company', slug, tab } : { kind: 'company', slug };
      }
      break;
    }
    case 'atlas':
      if (!detail) return { kind: 'home' };
      break;
    case 'library':
      if (!hasExtraSegments && (!detail || detail === 'skills')) {
        return { kind: 'library', tab: 'skills' };
      }
      if (!hasExtraSegments && detail && isLibraryTab(detail)) {
        return { kind: 'library', tab: detail };
      }
      break;
    case 'sessions':
      if (!hasExtraSegments) {
        return { kind: 'sessions', param: detail || null };
      }
      break;
    case 'settings':
      if (!detail) return { kind: 'settings' };
      if (!hasExtraSegments && isEmbeddedSettingsSection(detail)) {
        return { kind: 'settings', section: detail };
      }
      break;
  }

  return {
    kind: 'unsupported',
    route: trimmed,
    reason: 'Unsupported embedded destination',
  };
}

/** Serialize a parsed route back to the native wire string. */
export function serializeDesktopRoute(route: DesktopRoute): string {
  switch (route.kind) {
    case 'home':
      return 'home';
    case 'inbox':
      if (route.channelId) {
        return route.messageId
          ? `inbox:channel:${route.channelId}:${route.messageId}`
          : `inbox:channel:${route.channelId}`;
      }
      if (route.dm) return `inbox:dm:${route.dm}`;
      return 'inbox';
    case 'messages':
      return 'messages';
    case 'meetings':
      return 'meetings';
    case 'files':
      return `files:${route.slug}:${route.path}`;
    case 'company':
      return route.tab ? `company:${route.slug}:${route.tab}` : `company:${route.slug}`;
    case 'atlas':
      return 'home';
    case 'library':
      return route.tab === 'skills' ? 'library' : `library:${route.tab}`;
    case 'settings':
      return route.section ? `settings:${route.section}` : 'settings';
    case 'sessions':
      return route.param ? `sessions:${route.param}` : 'sessions';
    case 'unsupported':
      return route.route;
  }
}

/** Map the native grammar onto the embedded-shell navigation target. */
export function desktopRouteToEmbeddedTarget(
  route: DesktopRoute,
): EmbeddedNavigationTarget {
  switch (route.kind) {
    case 'home':
      return { kind: 'home' };
    case 'inbox': {
      const target: Extract<EmbeddedNavigationTarget, { kind: 'inbox' }> = {
        kind: 'inbox',
      };
      if (route.dm) target.dm = route.dm;
      if (route.channelId) target.channelId = route.channelId;
      if (route.messageId) target.messageId = route.messageId;
      return target;
    }
    case 'messages':
      return { kind: 'messages' };
    case 'meetings':
      return { kind: 'meetings' };
    case 'files':
      return {
        kind: 'extra',
        page: 'files',
        param: route.path,
        companyUid: route.slug,
      };
    case 'company':
      return {
        kind: 'extra',
        page: 'company',
        param: route.tab ?? null,
        companyUid: route.slug,
      };
    case 'atlas':
      return { kind: 'home' };
    case 'library':
      return { kind: 'library', tab: route.tab };
    case 'settings':
      return route.section
        ? { kind: 'settings', section: route.section }
        : { kind: 'settings' };
    case 'sessions':
      return { kind: 'extra', page: 'sessions', param: route.param ?? null };
    case 'unsupported':
      return {
        kind: 'unsupported',
        route: route.route,
        reason: route.reason,
      };
  }
}
