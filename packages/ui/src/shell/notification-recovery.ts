/**
 * Native-notification action recovery, as it crosses windows (PL-03).
 *
 * The controller window (`apps/sync/src/App.svelte`) is the only renderer that
 * can execute a notification action — it owns the routing for
 * `notification:dm-action` / `notification:share-action`. When the compact
 * native retry banner cannot be created it keeps an App-owned recovery record
 * instead, which used to be visible only inside the tray popover.
 *
 * The controller now broadcasts that record on `RECOVERY_EVENT` and listens for
 * `RETRY_EVENT`, so the desktop shell can render the banner and ask for the
 * retry without duplicating the action routing.
 */

export type NativeNotificationActionKind = "dm" | "share";

export interface NativeNotificationRecovery {
  kind: NativeNotificationActionKind;
  action: string;
  data: unknown;
  message: string;
}

/** Controller → shell: the current recovery record (or `null` once cleared). */
export const RECOVERY_EVENT = "notification:action-recovery";
/** Shell → controller: re-run the action the recovery record describes. */
export const RETRY_EVENT = "notification:action-retry";

export interface RecoveryEventPayload {
  recovery: NativeNotificationRecovery | null;
  retrying: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse a `RECOVERY_EVENT` payload defensively: an event bus is an untyped
 * seam, and a half-formed record must read as "nothing to recover" rather than
 * render a banner whose Retry cannot describe an action.
 */
export function recoveryFromEvent(
  payload: unknown,
): RecoveryEventPayload | null {
  if (!isRecord(payload)) return null;
  const retrying = payload.retrying === true;
  const raw = payload.recovery;
  if (!isRecord(raw)) return { recovery: null, retrying };

  const kind = raw.kind;
  const action = raw.action;
  const message = raw.message;
  if (kind !== "dm" && kind !== "share") return { recovery: null, retrying };
  if (typeof action !== "string" || action.trim() === "") {
    return { recovery: null, retrying };
  }
  const text =
    typeof message === "string" && message.trim() !== ""
      ? message
      : kind === "dm"
        ? "Couldn’t finish the message action. Retry it here."
        : "Couldn’t finish the shared-item action. Retry it here.";

  return {
    recovery: { kind, action, data: raw.data, message: text },
    retrying,
  };
}
