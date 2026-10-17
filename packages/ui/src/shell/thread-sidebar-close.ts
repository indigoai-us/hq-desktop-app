/**
 * Closing the thread sidebar.
 *
 * Opening a thread pushes a history entry. Opening a second thread pushes
 * another. The close control must not step back through those entries: that
 * shows the previous thread, so the sidebar looks like it never closes.
 * Close replaces the open thread with the same conversation and drops every
 * earlier thread entry for that conversation.
 */

import type {
  NavigationDestination,
  NavigationHistory,
} from "./navigation-history.js";

export interface ThreadConversation {
  kind: "channel" | "dm";
  id: string;
}

export function threadConversationOf(
  destination: NavigationDestination,
): ThreadConversation | null {
  if (destination.kind === "channel") {
    const id = destination.channelId.trim();
    return id ? { kind: "channel", id } : null;
  }
  if (destination.kind === "dm") {
    const id = destination.personUid.trim();
    return id ? { kind: "dm", id } : null;
  }
  return null;
}

export function threadReplyRoot(
  destination: NavigationDestination,
): string | null {
  if (destination.kind !== "channel" && destination.kind !== "dm") return null;
  const id = destination.replyRootEventId?.trim() ?? "";
  return id ? id : null;
}

/** True when `destination` is an open thread in `conversation`. */
export function isStackedThreadDestination(
  destination: NavigationDestination,
  conversation: ThreadConversation,
): boolean {
  const reply = threadReplyRoot(destination);
  if (!reply) return false;
  const current = threadConversationOf(destination);
  return current?.kind === conversation.kind && current.id === conversation.id;
}

/**
 * Remove open-thread entries for the conversation `closed` lands on.
 * `closed` itself must be that conversation with no thread. The current
 * entry is kept when it is already the closed conversation. Call this only
 * after that entry has been committed, so the cursor does not fall through
 * onto an older thread.
 */
export function dropStackedThreadEntries(
  history: NavigationHistory,
  closed: NavigationDestination,
): void {
  const conversation = threadConversationOf(closed);
  if (!conversation || threadReplyRoot(closed)) return;
  history.filter(
    (entry) => !isStackedThreadDestination(entry.destination, conversation),
  );
}
