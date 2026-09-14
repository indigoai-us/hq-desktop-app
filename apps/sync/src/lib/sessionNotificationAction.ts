/**
 * "Needs you" banner → the Sessions surface.
 *
 * Rust raises a `kind: 'session'` banner when an in-app agent session parks on
 * the human (`commands/agent_session/notify.rs`). Clicking it has to land on
 * THAT session, not the session list, so the action resolves the deep-link
 * route `sessions:<id>` — the same grammar `resolvePendingDesktopRoute` already
 * understands — and hands it to `open_desktop_alt_window`, which focuses an
 * open desktop window (pushing `desktop:navigate`) or queues the route for a
 * cold build.
 *
 * Kept out of `App.svelte` so the routing rule is executable in the node test
 * environment, where Svelte components cannot be mounted.
 */

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** The banner's `data` payload: the two ids `build_payload` puts on the wire. */
export interface SessionBannerData {
  sessionId?: unknown;
  requestId?: unknown;
}

/**
 * The desktop route for a session banner, or `null` when the payload carries no
 * usable session id. Null is a real outcome, not a fallback to the session
 * list: a banner that cannot name its session is a malformed payload, and
 * silently landing the user on a list would read as the click having worked.
 */
export function sessionBannerRoute(data: unknown): string | null {
  const sessionId = (data as SessionBannerData | null | undefined)?.sessionId;
  if (typeof sessionId !== 'string') return null;
  const trimmed = sessionId.trim();
  return trimmed ? `sessions:${trimmed}` : null;
}

/**
 * Execute a `kind: 'session'` banner action. Both the body click and the
 * "Answer" chip dispatch `open` — there is no second destination, and a chip
 * that answered the prompt from a banner would be a permission decision made
 * without the tool input in view.
 */
export async function executeSessionNotificationAction(
  action: string,
  data: unknown,
  invoke: Invoke,
): Promise<void> {
  if (action !== 'open') {
    throw new Error('Unsupported notification action');
  }
  const route = sessionBannerRoute(data);
  if (!route) {
    throw new Error('Session is unavailable');
  }
  await invoke('open_desktop_alt_window', { route });
}
