/**
 * In-window handoff of a "conversation to open" between desktop-alt surfaces
 * (e.g. the Notifications page's "Message the sharer" action) and the
 * MessagesShell mounted on the Messages destination.
 *
 * The standalone Messages window gets its target via the Rust ready-handshake
 * (`open_messages_window(target)` → `messages:open-conversation` Tauri event);
 * inside ONE desktop window a Rust round-trip is unnecessary — the sender
 * stashes the target here, dispatches `hq:message-person`, and the host
 * navigates to Messages. The shell consumes the stash on mount (it wasn't
 * mounted yet) or on the window event (it was).
 */

export interface ConversationTarget {
  /** Canonical person uid; empty for a not-yet-provisioned peer (the shell
   *  then uses the email-addressed send path). */
  personUid: string;
  email: string;
  displayName: string;
}

/** Window event dispatched alongside the stash so live hosts react. */
export const MESSAGE_PERSON_EVENT = 'hq:message-person';

let pending: ConversationTarget | null = null;

/** Stash the target and announce it. The desktop host (DesktopApp) listens to
 *  navigate to the Messages destination; a mounted MessagesShell listens to
 *  open the conversation immediately. */
export function requestConversation(target: ConversationTarget): void {
  pending = target;
  try {
    window.dispatchEvent(new CustomEvent(MESSAGE_PERSON_EVENT, { detail: target }));
  } catch {
    // Non-browser context (unit tests) — the stash alone still works.
  }
}

/** Take (and clear) the pending target. */
export function takePendingConversation(): ConversationTarget | null {
  const t = pending;
  pending = null;
  return t;
}
