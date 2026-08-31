/**
 * Sync host seams for the embedded @hq/ui DesktopApp (US-103).
 *
 * Bridges PlatformAdapter results onto ChatSidebarApi and maps desktop-alt
 * pending routes onto in-window HQ Work events (US-104 pending-open).
 * Never launches HQ Work.
 */

import type { AdapterResult, PlatformAdapter } from '@hq/platform';
import {
  normalizeDirectoryFeed,
  dispatchEmbeddedNavigation,
  isEmbeddedSettingsSection,
  OPEN_SETTINGS_EVENT,
  requestChannelOpen,
  requestConversation,
  type Channel,
  type ChannelsResponse,
  type ChatSidebarApi,
  type ContactsResponse,
  type MessageSearchResult,
  type RequestsResponse,
  type EmbeddedNavigationTarget,
  type PackagesDone,
  type PackagesEvents,
  type PackagesProgress,
  type PackagesView,
} from '@hq/ui';
import { parseHqWorkOpenUrl, type HqWorkOpenTarget } from '../lib/hq-work';

function unwrap<T>(result: AdapterResult<T>): T {
  if (result.ok) return result.value;
  const detail = result.message ?? result.reason;
  throw new Error(result.code ? `[${result.code}] ${detail}` : detail);
}

async function call<T>(p: Promise<AdapterResult<unknown>>): Promise<T> {
  return unwrap(await p) as T;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Minimal Tauri event seam so the shared UI never imports Tauri directly. */
export type TauriEventListener = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>;

/**
 * Bridge the native package lifecycle onto Library → Installed.
 *
 * Every handler is guarded after disposal and every late subscription is
 * immediately unregistered. That keeps a prior account's package results out
 * of a replacement DesktopApp during sign-out/reauth hydration.
 */
export function createHqWorkPackagesEvents(
  listen: TauriEventListener,
): PackagesEvents {
  return {
    async subscribe(handlers) {
      let disposed = false;
      const unlisteners: Array<() => void> = [];
      const register = async <T>(
        event: string,
        handle: (payload: T) => void,
      ): Promise<void> => {
        const unlisten = await listen<T>(event, ({ payload }) => {
          if (!disposed) handle(payload);
        });
        if (disposed) {
          try {
            unlisten();
          } catch {
            // A native listener teardown must never escape a UI lifecycle.
          }
        } else {
          unlisteners.push(unlisten);
        }
      };

      await Promise.all([
        register<PackagesProgress>('packages:progress', handlers.onProgress),
        register<PackagesDone>('packages:complete', handlers.onComplete),
        register<PackagesDone>('packages:error', handlers.onError),
        register<PackagesView>('packages:updates', handlers.onUpdates),
      ]);

      return () => {
        disposed = true;
        for (const unlisten of unlisteners.splice(0)) {
          try {
            unlisten();
          } catch {
            // Tauri unlisten is best-effort during component teardown.
          }
        }
      };
    },
  };
}

export function createHqWorkSidebarApi(adapter: PlatformAdapter): ChatSidebarApi {
  return {
    fetchChannelDirectory: async (cursor) => {
      const raw = await call<unknown>(
        adapter.messaging.fetchChannelDirectory(cursor ?? undefined),
      );
      return normalizeDirectoryFeed(raw);
    },
    listContacts: async () => ({
      contacts: await call<ContactsResponse['contacts']>(
        adapter.messaging.listContacts(),
      ),
    }),
    listDmRequests: async () => ({
      requests: await call<NonNullable<RequestsResponse['requests']>>(
        adapter.messaging.listDmRequests(),
      ),
    }),
    listChannels: async () => {
      const channels = await call<unknown>(adapter.messaging.listChannels());
      if (Array.isArray(channels)) {
        return { channels: channels as Channel[] } satisfies ChannelsResponse;
      }
      const rec = asRecord(channels);
      if (Array.isArray(rec?.channels)) {
        return { channels: rec.channels as Channel[] };
      }
      return { channels: [] };
    },
    markDmThreadRead: (withPersonUid) =>
      call<void>(adapter.messaging.markDmThreadRead(withPersonUid)),
    markChannelRead: (channelId) =>
      call<void>(adapter.messaging.markChannelRead(channelId)),
    searchMessages: (args) =>
      call<MessageSearchResult>(
        adapter.messaging.searchMessages(args.q, {
          ...(args.companyUid ? { companyUid: args.companyUid } : {}),
          ...(args.limit != null ? { limit: args.limit } : {}),
        }),
      ),
    createChannel: async (args) => {
      const value = await call<Record<string, unknown>>(
        adapter.messaging.createChannel(args as never),
      );
      const rec = asRecord(value) ?? {};
      const nested = asRecord(rec.channel);
      const channelId =
        (typeof nested?.channelId === 'string' && nested.channelId) ||
        (typeof nested?.id === 'string' && nested.id) ||
        (typeof rec.channelId === 'string' && rec.channelId) ||
        (typeof rec.id === 'string' && rec.id) ||
        '';
      if (!channelId) throw new Error('Channel created without an id');
      return { channelId };
    },
    addChannelMember: async (channelId, toPersonUid) => {
      await call<unknown>(
        adapter.messaging.addChannelMember(channelId, toPersonUid),
      );
    },
  };
}

/**
 * Feed a validated deep-link target into DesktopApp's pending-open path.
 *
 * @hq/ui deliberately exposes two narrower stashes — `requestChannelOpen` for
 * channels and `requestConversation` for 1:1 DMs — so this host owns the
 * channel-wins-over-person precedence rather than adding a Sync-shaped helper
 * to the platform-pure package.
 *
 * A deep link only carries a person uid, so `email` / `displayName` are left
 * empty: MessagesShell resolves the peer from the directory by uid, and the
 * empty-email path is the same one the sidebar uses for an unresolved peer.
 */
export function requestDeepLinkOpen(target: HqWorkOpenTarget): void {
  if (target.channelId) {
    requestChannelOpen(target.channelId, {
      replyRootEventId: target.replyRootEventId,
    });
    return;
  }
  if (target.personUid) {
    requestConversation({
      personUid: target.personUid,
      email: '',
      displayName: '',
      replyRootEventId: target.replyRootEventId,
    });
  }
}

/**
 * Stateful delivery boundary between native desktop routes and the mounted
 * shared shell. `attach` is called by `DesktopApp` only after its listeners
 * exist, so a cold pending route cannot disappear in the mount gap.
 */
export class EmbeddedNavigationController {
  #pending: EmbeddedNavigationTarget | null = null;
  #deliver: ((target: EmbeddedNavigationTarget) => void) | null = null;
  #pendingMeetingId: string | null = null;

  navigate(target: EmbeddedNavigationTarget): void {
    if (target.kind === 'meetings') {
      const meetingId = target.meetingId?.trim() || null;
      if (meetingId) this.#pendingMeetingId = meetingId;
      else if (this.#pendingMeetingId) {
        target = { ...target, meetingId: this.#pendingMeetingId };
      }
    }
    if (this.#deliver) {
      this.#deliver(target);
      if (target.kind === 'meetings' && target.meetingId) {
        this.#pendingMeetingId = null;
      }
      return;
    }
    this.#pending = target;
  }

  attach(deliver: (target: EmbeddedNavigationTarget) => void): () => void {
    this.#deliver = deliver;
    const pending = this.#pending;
    this.#pending = null;
    if (pending) {
      deliver(pending);
      if (pending.kind === 'meetings' && pending.meetingId) {
        this.#pendingMeetingId = null;
      }
    }
    return () => {
      if (this.#deliver === deliver) this.#deliver = null;
    };
  }

  clear(): void {
    this.#pending = null;
    this.#pendingMeetingId = null;
  }
}

export function createEmbeddedNavigationController(): EmbeddedNavigationController {
  return new EmbeddedNavigationController();
}

function routeTarget(route: string): EmbeddedNavigationTarget {
  // hqwork:// must be handled before slash→colon (otherwise `://` becomes `:::`).
  if (route.startsWith('hqwork://')) {
    const target = parseHqWorkOpenUrl(route);
    if (!target) {
      return {
        kind: 'unsupported',
        route,
        reason: 'Invalid HQ Work deep link',
      };
    }
    if (target.channelId) {
      return {
        kind: 'channel',
        channelId: target.channelId,
        replyRootEventId: target.replyRootEventId,
      };
    }
    return {
      kind: 'dm',
      personUid: target.personUid!,
      replyRootEventId: target.replyRootEventId,
    };
  }

  const normalized = route.replace(/\//g, ':');
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
      break;
    case 'messages':
      if (!detail) return { kind: 'messages' };
      break;
    case 'meetings':
      if (!detail) return { kind: 'meetings' };
      break;
    case 'library':
      if (!hasExtraSegments && (!detail || detail === 'skills')) {
        return { kind: 'library', tab: 'skills' };
      }
      if (
        !hasExtraSegments &&
        (detail === 'workers' ||
          detail === 'installed' ||
          detail === 'marketplace' ||
          detail === 'submit' ||
          detail === 'profile')
      ) {
        return { kind: 'library', tab: detail };
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
    route,
    reason: 'Unsupported embedded destination',
  };
}

function deliverImmediately(target: EmbeddedNavigationTarget): void {
  // Preserve the public helper's existing unit-test seam. The real embedded
  // shell supplies a controller and therefore only delivers after mount.
  if (target.kind === 'channel') {
    requestDeepLinkOpen({
      channelId: target.channelId,
      personUid: null,
      replyRootEventId: target.replyRootEventId ?? null,
    });
    return;
  }
  if (target.kind === 'dm') {
    requestDeepLinkOpen({
      channelId: null,
      personUid: target.personUid,
      replyRootEventId: target.replyRootEventId ?? null,
    });
    return;
  }
  if (target.kind === 'settings' && !target.section) {
    window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));
    return;
  }
  dispatchEmbeddedNavigation(target);
}

/** Map a native pending/live route onto the embedded DesktopApp. */
export function applyDesktopAltRoute(
  route: string | null | undefined,
  controller?: EmbeddedNavigationController,
): void {
  const trimmed = route?.trim() ?? '';
  if (!trimmed) return;
  const target = routeTarget(trimmed);
  if (controller) controller.navigate(target);
  else deliverImmediately(target);
}
