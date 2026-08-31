/**
 * In-window handoff of a "conversation to open" between desktop-alt surfaces
 * and a mounted MessagesShell.
 *
 * The standalone Messages window gets its target via the Rust ready-handshake
 * (`open_messages_window(target)` → `messages:open-conversation` Tauri event);
 * inside ONE window a Rust round-trip is unnecessary — the sender stashes the
 * target here and dispatches `hq:message-person`. DesktopApp routes to the
 * desktop Messages destination without consuming the target; the mounted
 * MessagesShell then takes it and opens the requested conversation. The
 * standalone Messages window uses the same take-on-mount/event behavior.
 */

export interface ConversationTarget {
  /** Canonical person uid; empty for a not-yet-provisioned peer (the shell
   *  then uses the email-addressed send path). */
  personUid: string;
  email: string;
  displayName: string;
  /** Optional reply-thread root so a later host can open ReplyPanel. */
  replyRootEventId?: string | null;
  /** True only for the sidebar's initial automatic directory selection. */
  automatic?: boolean;
}

/** Window event dispatched alongside the stash so live hosts react. */
export const MESSAGE_PERSON_EVENT = "hq:message-person";

let pending: ConversationTarget | null = null;

/** Stash the target and announce it. The desktop host (DesktopApp) listens to
 *  navigate to the Messages destination; a mounted MessagesShell listens to
 *  open the conversation immediately. */
export function requestConversation(target: ConversationTarget): void {
  const replyRootEventId = target.replyRootEventId?.trim() || null;
  pending = { ...target, replyRootEventId, automatic: target.automatic === true };
  try {
    window.dispatchEvent(
      new CustomEvent(MESSAGE_PERSON_EVENT, { detail: pending }),
    );
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
