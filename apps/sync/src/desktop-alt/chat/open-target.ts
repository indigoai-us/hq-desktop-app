/**
 * In-window handoff for opening a channel from the chat sidebar into the
 * embedded Messages shell. Mirrors lib/pendingConversation for DMs.
 */

export const OPEN_CHANNEL_EVENT = 'hq:open-channel';

/** Open the connection-requests surface (shared DmRequestCard) from the sidebar. */
export const OPEN_DM_REQUESTS_EVENT = 'hq:open-dm-requests';

let pendingChannelId: string | null = null;
let pendingDmRequests = false;
/** Optional pairKey to open a specific request; null opens the first pending. */
let pendingDmRequestPairKey: string | null = null;

export function requestChannelOpen(channelId: string): void {
  pendingChannelId = channelId;
  try {
    window.dispatchEvent(
      new CustomEvent(OPEN_CHANNEL_EVENT, { detail: { channelId } }),
    );
  } catch {
    // Non-browser (unit tests) — stash alone is enough.
  }
}

export function takePendingChannel(): string | null {
  const id = pendingChannelId;
  pendingChannelId = null;
  return id;
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
