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
  OPEN_SETTINGS_EVENT,
  requestChannelOpen,
  requestConversation,
  type Channel,
  type ChannelsResponse,
  type ChatSidebarApi,
  type ContactsResponse,
  type MessageSearchResult,
  type RequestsResponse,
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
    listChannels: async (args) => {
      const channels = await call<unknown>(adapter.messaging.listChannels(args));
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
    searchMessages: async (args) => ({
      results: await call<MessageSearchResult['results']>(
        adapter.messaging.searchMessages(args.q, {
          ...(args.companyUid ? { companyUid: args.companyUid } : {}),
          ...(args.limit != null ? { limit: args.limit } : {}),
        }),
      ),
    }),
    sendChannelMessage: async ({ channelId, body }) => {
      await call<unknown>(adapter.messaging.sendChannelMessage(channelId, body));
    },
    sendDm: async ({ toPersonUid, body }) => {
      await call<unknown>(adapter.messaging.sendDm(toPersonUid, body));
    },
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

/** Map a desktop-alt pending route onto the embedded DesktopApp. */
export function applyDesktopAltRoute(route: string | null | undefined): void {
  const trimmed = route?.trim() ?? '';
  if (!trimmed) return;
  // hqwork:// must be handled before slash→colon (otherwise `://` becomes `:::`).
  if (trimmed.startsWith('hqwork://')) {
    const target = parseHqWorkOpenUrl(trimmed);
    if (!target) return;
    requestDeepLinkOpen(target);
    return;
  }
  const normalized = trimmed.replace(/\//g, ':');
  const kind = normalized.split(':')[0] ?? '';
  if (kind === 'settings') {
    window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));
  }
}
