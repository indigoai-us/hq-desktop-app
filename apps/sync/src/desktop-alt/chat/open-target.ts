/**
 * In-window handoff for opening a channel from the chat sidebar into the
 * embedded Messages shell. Mirrors lib/pendingConversation for DMs.
 */

export const OPEN_CHANNEL_EVENT = 'hq:open-channel';

let pendingChannelId: string | null = null;

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
