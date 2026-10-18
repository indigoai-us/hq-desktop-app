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

/** True when both destinations are the same open thread. */
function isSameOpenThread(
  destination: NavigationDestination,
  thread: NavigationDestination,
): boolean {
  const reply = threadReplyRoot(thread);
  if (!reply || threadReplyRoot(destination) !== reply) return false;
  const wanted = threadConversationOf(thread);
  const current = threadConversationOf(destination);
  return (
    wanted !== null &&
    current !== null &&
    current.kind === wanted.kind &&
    current.id === wanted.id
  );
}

/**
 * Finish a thread-sidebar close against history.
 *
 * `closingThread` is the history destination captured when close started.
 * When navigation committed, the current entry is already `closed` and this
 * only drops the stack. When it did not (superseded, rejected, or still
 * unavailable), the open thread would stay current and Back could show the
 * previous thread. The fallback replaces that entry only when it is still
 * `closingThread`. A thread opened in the same conversation after close
 * started is left as it is, stack included. Any other newer destination is
 * left in place, and the closed conversation's thread stack is still dropped.
 */
export function settleThreadSidebarClose(
  history: NavigationHistory,
  closed: NavigationDestination,
  committed: boolean,
  closingThread: NavigationDestination | null,
): void {
  const current = history.current();
  const stillThatThread =
    closingThread !== null &&
    current !== null &&
    isSameOpenThread(current.destination, closingThread);
  if (!committed && stillThatThread && !threadReplyRoot(closed)) {
    history.replace({ ...current, destination: closed });
  }
  const after = history.current();
  const conversation = threadConversationOf(closed);
  if (
    !committed &&
    !stillThatThread &&
    closingThread !== null &&
    after !== null &&
    conversation !== null &&
    isStackedThreadDestination(after.destination, conversation)
  ) {
    return;
  }
  dropStackedThreadEntries(history, closed);
}
