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
 * `closed` itself must be that conversation with no thread. Filtering also
 * collapses the adjacent no-thread copy that replace leaves behind, and
 * leaves the cursor on the surviving current entry.
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

/**
 * Finish a thread-sidebar close against history.
 *
 * When navigation committed, the current entry is already `closed` and this
 * only drops the stack. When it did not (superseded, rejected, or still
 * unavailable), the open thread would stay current and Back could show the
 * previous thread. In that case, if the current entry is still that
 * conversation's thread, replace it with `closed` before dropping the stack.
 * A newer committed destination is left where it is.
 */
export function settleThreadSidebarClose(
  history: NavigationHistory,
  closed: NavigationDestination,
  committed: boolean,
): void {
  if (!committed) {
    const conversation = threadConversationOf(closed);
    const current = history.current();
    if (
      conversation &&
      !threadReplyRoot(closed) &&
      current &&
      isStackedThreadDestination(current.destination, conversation)
    ) {
      history.replace({ ...current, destination: closed });
    }
  }
  dropStackedThreadEntries(history, closed);
}
