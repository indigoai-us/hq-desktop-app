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
  type DmThreadResponse,
  type MessageSearchResult,
  type RequestsResponse,
  type EmbeddedNavigationTarget,
  type ChatWakeBus,
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
 * Native notification-poller events are authenticated by Sync. A host still
 * rejects explicitly scoped payloads outside the mounted account/company
 * before forwarding them to shared UI state; unscoped payloads are accepted
 * only while this authenticated native session is mounted.
 */
export interface HqWorkRealtimeScope {
  personUid: string;
  companyUids: ReadonlySet<string>;
}

export interface HqWorkNativeWakesConfig {
  listen: TauriEventListener;
  wakes: ChatWakeBus;
  scope: () => HqWorkRealtimeScope | null;
  onNotificationWake: () => void;
}

type NativeRecord = Record<string, unknown>;

const NATIVE_WAKE_DEDUPE_MS = 5_000;

function nativeRecord(value: unknown): NativeRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as NativeRecord)
    : null;
}

function nativeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nativeRecords(payload: unknown): NativeRecord[] {
  if (Array.isArray(payload)) return payload.map(nativeRecord).filter(Boolean) as NativeRecord[];
  const record = nativeRecord(payload);
  if (!record) return [];
  if (Array.isArray(record.events)) {
    return record.events.map(nativeRecord).filter(Boolean) as NativeRecord[];
  }
  return [record];
}

function scopedNativePayload(
  payload: unknown,
  scope: HqWorkRealtimeScope,
): boolean {
  const envelope = nativeRecord(payload);
  const records = [
    ...(envelope && Array.isArray(envelope.events) ? [envelope] : []),
    ...nativeRecords(payload),
  ];
  if (records.length === 0) return false;
  for (const record of records) {
    const companyUid = nativeString(record.companyUid ?? record.company_uid);
    if (companyUid && !scope.companyUids.has(companyUid)) return false;
    // `personUid` on a message identifies its sender, never use it for account
    // checks. These fields, when present, explicitly identify the recipient.
    const recipient = nativeString(
      record.recipientPersonUid ?? record.recipient_person_uid ?? record.ownerPersonUid,
    );
    if (recipient && recipient !== scope.personUid) return false;
  }
  return true;
}

/** Only stable backend event IDs are safe dedupe identities. */
function nativeWakeKey(payload: unknown): string | null {
  const records = nativeRecords(payload);
  const ids = records
    .map((record) => {
      const reply = nativeRecord(record.reply);
      return nativeString(
        record.eventId ??
          record.event_id ??
          record.id ??
          reply?.eventId ??
          reply?.event_id,
      );
    })
    .filter(Boolean)
    .sort();
  return ids.length > 0 ? `event:${ids.join(',')}` : null;
}

function asPairUnreads(payload: unknown): {
  pairUnreads?: Array<{ withPersonUid: string; lastReadAt?: string | null; unreadCount: number }>;
  delta?: boolean;
} | null {
  const record = nativeRecord(payload);
  if (!record || !Array.isArray(record.pairUnreads)) return null;
  const pairUnreads = record.pairUnreads.flatMap((value) => {
    const row = nativeRecord(value);
    const withPersonUid = nativeString(row?.withPersonUid ?? row?.with_person_uid);
    const unreadCount = row?.unreadCount ?? row?.unread_count;
    if (!withPersonUid || typeof unreadCount !== 'number') return [];
    return [{
      withPersonUid,
      unreadCount,
      ...(typeof row?.lastReadAt === 'string' ? { lastReadAt: row.lastReadAt } : {}),
    }];
  });
  return {
    pairUnreads,
    ...(record.delta === true ? { delta: true } : {}),
  };
}

/**
 * Bridge Sync's authenticated poll/MQTT results into the platform-pure chat
 * bus. The MQTT receiver remains a wake-only source; Sync's singleton poller
 * owns reconciliation, account-epoch checks, and reconnect dedupe.
 */
export async function subscribeHqWorkNativeWakes(
  config: HqWorkNativeWakesConfig,
): Promise<() => void> {
  let disposed = false;
  const unlisteners: Array<() => void> = [];
  const delivered = new Map<string, number>();

  function accept(name: string, payload: unknown): boolean {
    if (disposed) return false;
    const scope = config.scope();
    if (!scope || !scopedNativePayload(payload, scope)) return false;
    const key = nativeWakeKey(payload);
    if (!key) return true;
    const now = Date.now();
    for (const [seen, at] of delivered) {
      if (now - at > NATIVE_WAKE_DEDUPE_MS) delivered.delete(seen);
    }
    if (delivered.has(key)) return false;
    delivered.set(key, now);
    return true;
  }

  async function register(
    name: string,
    handler: (payload: unknown) => void,
  ): Promise<void> {
    try {
      const unlisten = await config.listen<unknown>(name, ({ payload }) => {
        if (accept(name, payload)) handler(payload);
      });
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    } catch {
      // A missing native event is disconnected-state fallback territory. Do
      // not install a partial, unauthenticated alternative transport here.
    }
  }

  await Promise.all([
    register('dm:new-events', (payload) => {
      for (const row of nativeRecords(payload)) {
        const fromPersonUid = nativeString(row.fromPersonUid ?? row.from_person_uid);
        if (!fromPersonUid) continue;
        config.wakes.emit?.('dm:new-message', {
          fromPersonUid,
          ...(nativeString(row.eventId ?? row.event_id)
            ? { eventId: nativeString(row.eventId ?? row.event_id) }
            : {}),
          ...(nativeString(row.createdAt ?? row.created_at)
            ? { createdAt: nativeString(row.createdAt ?? row.created_at) }
            : {}),
          direction: 'in',
          // Rust emits the exact per-pair counts before these fresh rows. Keep
          // this event as a timeline/contact wake, never a second badge delta.
          absoluteUnread: true,
        });
      }
      config.onNotificationWake();
    }),
    register('share:new-events', () => config.onNotificationWake()),
    register('channel:new-message', (payload) => {
      const row = nativeRecords(payload)[0];
      const channelId = nativeString(row?.channelId ?? row?.channel_id);
      if (!channelId) return;
      config.wakes.emit?.('channel:new-message', {
        channelId,
        ...(nativeString(row?.eventId ?? row?.event_id)
          ? { eventId: nativeString(row?.eventId ?? row?.event_id) }
          : {}),
        ...(nativeString(row?.createdAt ?? row?.created_at)
          ? { createdAt: nativeString(row?.createdAt ?? row?.created_at) }
          : {}),
        ...(typeof row?.unread === 'number' ? { unread: row.unread } : {}),
        // The native channel poll coalesces multiple messages into the current
        // absolute unread total; it is not a single-message increment.
        ...(typeof row?.unread === 'number' ? { absoluteUnread: true } : {}),
      });
      config.onNotificationWake();
    }),
    register('thread:new-reply', (payload) => {
      const row = nativeRecords(payload)[0];
      const reply = nativeRecord(row?.reply);
      const rootEventId = nativeString(row?.rootEventId ?? row?.root_event_id);
      const eventId = nativeString(
        row?.eventId ?? row?.event_id ?? reply?.eventId ?? reply?.event_id,
      );
      const scope = nativeString(row?.scope);
      if (!rootEventId || !eventId || (scope !== 'channel' && scope !== 'dm')) return;
      const channelId = nativeString(row?.channelId ?? row?.channel_id);
      const withPersonUid = nativeString(row?.withPersonUid ?? row?.with_person_uid);
      if ((scope === 'channel' && !channelId) || (scope === 'dm' && !withPersonUid)) return;
      config.wakes.emit?.('reply:new', {
        rootEventId,
        eventId,
        scope,
        ...(channelId ? { channelId } : {}),
        ...(withPersonUid ? { withPersonUid } : {}),
      });
      config.onNotificationWake();
    }),
    register('dm:pair-unreads', (payload) => {
      const pairUnreads = asPairUnreads(payload);
      if (pairUnreads) config.wakes.emit?.('dm:pair-unreads', pairUnreads);
    }),
    register('channel:unread-changed', () => {
      config.wakes.emit?.('channel:unread-changed', undefined);
    }),
  ]);

  return () => {
    disposed = true;
    delivered.clear();
    for (const unlisten of unlisteners.splice(0)) {
      try {
        unlisten();
      } catch {
        // Tauri listener teardown is best-effort during a session transition.
      }
    }
  };
}

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

/** `list_company_members` answers `{ contacts: [...] }`; older stubs a bare array. */
function asContacts(value: unknown): ContactsResponse['contacts'] {
  if (Array.isArray(value)) return value as ContactsResponse['contacts'];
  const rows = asRecord(value)?.contacts;
  return Array.isArray(rows) ? (rows as ContactsResponse['contacts']) : [];
}

/**
 * @deprecated Retired production host. DesktopApp now mounts
 * `createChatSidebarApi` from apps/work; this remains only for legacy
 * handoff-test compatibility until that suite is retired.
 */
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
    // `list_company_members` (GET /v1/notify/contacts?companyUid=…). The
    // unscoped contacts feed carries no companyUid, so this is the only source
    // that can decide whether an invitee is outside the channel's workspace.
    // NOT `adapter.company.listMembers` — that interface takes a company SLUG,
    // so handing it a companyUid fetched the wrong roster on the Tauri/web
    // adapters and silently disabled the cross-company confirm.
    listCompanyMembers: async (companyUid) => ({
      contacts: asContacts(
        await call<unknown>(adapter.messaging.listContacts({ companyUid })),
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
    fetchDmThread: async (args) => {
      const raw = await call<unknown>(adapter.messaging.fetchDmThread(args));
      const rec = asRecord(raw);
      const messages = Array.isArray(raw)
        ? raw
        : Array.isArray(rec?.messages)
          ? rec.messages
          : [];
      return { messages: messages as DmThreadResponse['messages'] };
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
    ...(adapter.messaging.sendDmToEmail
      ? {
          sendDmToEmail: async (args: {
            toEmail?: string;
            toPersonUid?: string;
            body: string;
          }) => {
            const value = await call<unknown>(
              adapter.messaging.sendDmToEmail!(args),
            );
            const rec = asRecord(value) ?? {};
            return {
              state:
                rec.state === 'connectionRequested'
                  ? ('connectionRequested' as const)
                  : ('delivered' as const),
            };
          },
        }
      : {}),
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
  if (route.startsWith('hq-desktop://')) {
    const parsed = parseHqDesktopSetupUrl(route);
    if (!parsed) {
      return {
        kind: 'unsupported',
        route,
        reason: 'Invalid hq-desktop deep link',
      };
    }
    return {
      kind: 'setup-checkout',
      companyUid: parsed.companyUid,
      checkout: parsed.checkout,
    };
  }

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
    case 'atlas':
      if (!detail) return { kind: 'atlas' };
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

export function parseHqDesktopSetupUrl(
  raw: string,
): { companyUid: string; checkout: string } | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'hq-desktop:') return null;
    const host = url.hostname;
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    if (host !== 'setup' && path !== 'setup') return null;
    const companyUid = url.searchParams.get('company')?.trim() ?? '';
    if (!companyUid) return null;
    return {
      companyUid,
      checkout: url.searchParams.get('checkout')?.trim() ?? '',
    };
  } catch {
    return null;
  }
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
  if (target.kind === 'setup-checkout') {
    requestChannelOpen('setup', { companyUid: target.companyUid });
    dispatchEmbeddedNavigation(target);
    return;
  }
  dispatchEmbeddedNavigation(target);
}

/** Map a native pending/live route onto the embedded DesktopApp. */
export function applyDesktopAltRoute(
  route: string | null | undefined,
  controller?: EmbeddedNavigationController,
): EmbeddedNavigationTarget | null {
  const trimmed = route?.trim() ?? '';
  if (!trimmed) return null;
  const target = routeTarget(trimmed);
  if (controller) controller.navigate(target);
  else deliverImmediately(target);
  return target;
}
