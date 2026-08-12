/**
 * In-window handoff for opening a channel from the chat sidebar into the
 * embedded Messages shell. Mirrors lib/pendingConversation for DMs.
 */

export const OPEN_CHANNEL_EVENT = 'hq:open-channel';

/** Open the connection-requests surface (shared DmRequestCard) from the sidebar. */
export const OPEN_DM_REQUESTS_EVENT = 'hq:open-dm-requests';

export interface OpenChannelOptions {
  /** Optional message id to scroll/focus near when the shell supports it. */
  messageId?: string | null;
  /** Optional ISO timestamp of the hit for near-message navigation. */
  createdAt?: string | null;
}

let pendingChannelId: string | null = null;
let pendingChannelMessageId: string | null = null;
let pendingChannelCreatedAt: string | null = null;
let pendingDmRequests = false;
/** Optional pairKey to open a specific request; null opens the first pending. */
let pendingDmRequestPairKey: string | null = null;

export function requestChannelOpen(
  channelId: string,
  options: OpenChannelOptions = {},
): void {
  pendingChannelId = channelId;
  pendingChannelMessageId = options.messageId?.trim() || null;
  pendingChannelCreatedAt = options.createdAt?.trim() || null;
  try {
    window.dispatchEvent(
      new CustomEvent(OPEN_CHANNEL_EVENT, {
        detail: {
          channelId,
          messageId: pendingChannelMessageId,
          createdAt: pendingChannelCreatedAt,
        },
      }),
    );
  } catch {
    // Non-browser (unit tests) — stash alone is enough.
  }
}

export function takePendingChannel(): string | null {
  const id = pendingChannelId;
  pendingChannelId = null;
  pendingChannelMessageId = null;
  pendingChannelCreatedAt = null;
  return id;
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
