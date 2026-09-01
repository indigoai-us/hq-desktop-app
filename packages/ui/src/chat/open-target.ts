/**
 * In-window handoff for opening a channel from the chat sidebar into the
 * embedded Messages shell. Mirrors lib/pendingConversation for DMs.
 *
 * Conversation deep-links use `?reply=<rootEventId>` — never `?thread=`,
 * which collides with work-mesh thread ids.
 */

import type { ConversationRow } from "./sidebar-model";

export const OPEN_CHANNEL_EVENT = "hq:open-channel";
/** Window event asking the shell to open Settings (menu ⌘, on desktop). */
export const OPEN_SETTINGS_EVENT = "hq:open-settings";

/** Open the connection-requests surface (shared DmRequestCard) from the sidebar. */
export const OPEN_DM_REQUESTS_EVENT = "hq:open-dm-requests";

/** Conversation URL query for a channel id (`/?channel=<id>&reply=<root>`). */
export const CHANNEL_QUERY_KEY = "channel";
/** Conversation URL query for a 1:1 DM person uid. */
export const DM_QUERY_KEY = "dm";
/** Reply-thread root. Must stay `reply` — never `thread`. */
export const REPLY_QUERY_KEY = "reply";

export interface OpenChannelOptions {
  /** Optional message id to scroll/focus near when the shell supports it. */
  messageId?: string | null;
  /** Optional ISO timestamp of the hit for near-message navigation. */
  createdAt?: string | null;
  /** Optional reply-thread root so a later host can open ReplyPanel. */
  replyRootEventId?: string | null;
  /** True only for the sidebar's initial automatic directory selection. */
  automatic?: boolean;
  /**
   * Display name to paint while the directory has not caught up yet. A
   * just-created channel is opened before any row list contains it; without
   * this the stub row (and the header) shows the raw `chn_…` id until the
   * user navigates away and back.
   */
  title?: string | null;
  /** Workspace of the channel, for the same stub. */
  companyUid?: string | null;
}

export interface PendingChannelOpen {
  channelId: string;
  messageId: string | null;
  createdAt: string | null;
  replyRootEventId: string | null;
  automatic: boolean;
  title: string | null;
  companyUid: string | null;
}

export interface ConversationDeepLink {
  channelId: string | null;
  personUid: string | null;
  replyRootEventId: string | null;
  /** Optional display hints for a channel the row list does not have yet. */
  title?: string | null;
  companyUid?: string | null;
}

let pendingChannelId: string | null = null;
let pendingChannelMessageId: string | null = null;
let pendingChannelCreatedAt: string | null = null;
let pendingReplyRootEventId: string | null = null;
let pendingChannelAutomatic = false;
let pendingChannelTitle: string | null = null;
let pendingChannelCompanyUid: string | null = null;
let pendingDmRequests = false;
/** Optional pairKey to open a specific request; null opens the first pending. */
let pendingDmRequestPairKey: string | null = null;

function trimOrNull(value: string | null | undefined): string | null {
  const next = value?.trim() ?? "";
  return next || null;
}

export function requestChannelOpen(
  channelId: string,
  options: OpenChannelOptions = {},
): void {
  pendingChannelId = channelId;
  pendingChannelMessageId = trimOrNull(options.messageId);
  pendingChannelCreatedAt = trimOrNull(options.createdAt);
  pendingReplyRootEventId = trimOrNull(options.replyRootEventId);
  pendingChannelAutomatic = options.automatic === true;
  pendingChannelTitle = trimOrNull(options.title);
  pendingChannelCompanyUid = trimOrNull(options.companyUid);
  try {
    window.dispatchEvent(
      new CustomEvent(OPEN_CHANNEL_EVENT, {
        detail: {
          channelId,
          messageId: pendingChannelMessageId,
          createdAt: pendingChannelCreatedAt,
          replyRootEventId: pendingReplyRootEventId,
          automatic: pendingChannelAutomatic,
          title: pendingChannelTitle,
          companyUid: pendingChannelCompanyUid,
        },
      }),
    );
  } catch {
    // Non-browser (unit tests) — stash alone is enough.
  }
}

/** Take (and clear) the full pending channel open, including optional reply. */
export function takePendingChannelOpen(): PendingChannelOpen | null {
  const channelId = pendingChannelId;
  if (!channelId) return null;
  const snapshot: PendingChannelOpen = {
    channelId,
    messageId: pendingChannelMessageId,
    createdAt: pendingChannelCreatedAt,
    replyRootEventId: pendingReplyRootEventId,
    automatic: pendingChannelAutomatic,
    title: pendingChannelTitle,
    companyUid: pendingChannelCompanyUid,
  };
  pendingChannelId = null;
  pendingChannelMessageId = null;
  pendingChannelCreatedAt = null;
  pendingReplyRootEventId = null;
  pendingChannelAutomatic = false;
  pendingChannelTitle = null;
  pendingChannelCompanyUid = null;
  return snapshot;
}

export function takePendingChannel(): string | null {
  return takePendingChannelOpen()?.channelId ?? null;
}

/** Take (and clear) optional near-hit metadata for the last channel open. */
export function takePendingChannelFocus(): {
  messageId: string | null;
  createdAt: string | null;
} | null {
  if (!pendingChannelMessageId && !pendingChannelCreatedAt) return null;
  const messageId = pendingChannelMessageId;
  const createdAt = pendingChannelCreatedAt;
  pendingChannelMessageId = null;
  pendingChannelCreatedAt = null;
  return { messageId, createdAt };
}

/**
 * Stash + announce that the sidebar wants the connection-requests pane open.
 * MessagesShell consumes via `takePendingDmRequests` and selects the first
 * (or matching) pending request into the shared `<DmRequestCard/>`.
 */
export function requestDmRequestsOpen(pairKey?: string | null): void {
  pendingDmRequests = true;
  pendingDmRequestPairKey = pairKey?.trim() || null;
  try {
    window.dispatchEvent(
      new CustomEvent(OPEN_DM_REQUESTS_EVENT, {
        detail: { pairKey: pendingDmRequestPairKey },
      }),
    );
  } catch {
    // Non-browser (unit tests) — stash alone is enough.
  }
}

/** Take (and clear) a pending connection-requests open request. */
export function takePendingDmRequests(): { pairKey: string | null } | null {
  if (!pendingDmRequests) return null;
  pendingDmRequests = false;
  const pairKey = pendingDmRequestPairKey;
  pendingDmRequestPairKey = null;
  return { pairKey };
}

function firstQueryValue(params: URLSearchParams, key: string): string | null {
  return trimOrNull(params.get(key));
}

/**
 * Parse a conversation URL / desktop deep-link search string.
 * Honors `channel`, `dm`, and `reply`. Never reads `thread`.
 */
function searchParamsFrom(
  search: string | URLSearchParams | null | undefined,
): URLSearchParams {
  if (search instanceof URLSearchParams) return search;
  if (!search) return new URLSearchParams();
  const q = search.includes("?")
    ? search.slice(search.indexOf("?") + 1)
    : search;
  return new URLSearchParams(q);
}

export function parseConversationDeepLink(
  search: string | URLSearchParams | null | undefined,
): ConversationDeepLink {
  const params = searchParamsFrom(search);
  return {
    channelId: firstQueryValue(params, CHANNEL_QUERY_KEY),
    personUid: firstQueryValue(params, DM_QUERY_KEY),
    replyRootEventId: firstQueryValue(params, REPLY_QUERY_KEY),
  };
}

export function conversationDeepLinkFromLocation(
  loc: { search?: string } | null | undefined = typeof window === "undefined"
    ? null
    : window.location,
): ConversationDeepLink {
  return parseConversationDeepLink(loc?.search ?? "");
}

/** Resolve a directory/search row (or a stub) for a parsed deep-link. */
export function conversationRowForDeepLink(
  link: ConversationDeepLink,
  rows: readonly ConversationRow[] = [],
): ConversationRow | null {
  if (link.channelId) {
    const hit = rows.find((row) => row.channelId === link.channelId);
    if (hit) return hit;
    return {
      id: `ch:${link.channelId}`,
      kind: "channel",
      // Prefer the caller's display hint: a raw `chn_…` id is a last resort.
      title: trimOrNull(link.title) ?? link.channelId,
      companyUid: trimOrNull(link.companyUid),
      unreadDot: false,
      lastActivityAt: 0,
      pinned: false,
      channelId: link.channelId,
    };
  }
  if (link.personUid) {
    const hit = rows.find(
      (row) => row.personUid === link.personUid && !row.channelId,
    );
    if (hit) return hit;
    return {
      id: `dm:${link.personUid}`,
      kind: "dm",
      title: link.personUid,
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 0,
      pinned: false,
      personUid: link.personUid,
    };
  }
  return null;
}

/**
 * Open ReplyPanel only when GET /threads returned the requested root.
 * Missing / unauthorized / mismatched roots stay closed — no enumeration.
 */
export function shouldOpenReplyDeepLink(
  requestedRootEventId: string | null | undefined,
  thread: { root?: { eventId?: string | null } | null } | null | undefined,
): boolean {
  const requested = trimOrNull(requestedRootEventId);
  const actual = trimOrNull(thread?.root?.eventId);
  return Boolean(requested && actual && requested === actual);
}
