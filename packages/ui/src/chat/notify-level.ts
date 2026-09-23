/**
 * Per-channel notification levels (hq-pro `membership.notifyLevel`).
 *
 * Pure helpers for the channel-header bell and the sidebar muted indicator.
 * The server resolves a level for every joined member and sends `null` for
 * browse-only rows; `PUT /v1/notify/channels/{id}/notify-level` changes it.
 */

export type NotifyLevel = "all" | "mentions" | "files" | "muted";

export interface NotifyLevelOption {
  level: NotifyLevel;
  label: string;
  description: string;
}

/** Menu order, most to least notifications. */
export const NOTIFY_LEVEL_OPTIONS: readonly NotifyLevelOption[] = [
  {
    level: "all",
    label: "All messages",
    description: "Every new message, file, and mention",
  },
  {
    level: "files",
    label: "Files and mentions",
    description: "Shared files and messages that mention you",
  },
  {
    level: "mentions",
    label: "Mentions only",
    description: "Only messages that mention you",
  },
  {
    level: "muted",
    label: "Muted",
    description: "Nothing, not even mentions",
  },
];

export function isNotifyLevel(value: unknown): value is NotifyLevel {
  return (
    value === "all" ||
    value === "mentions" ||
    value === "files" ||
    value === "muted"
  );
}

/** Coerce a wire value; anything unknown (including null) is `null`. */
export function normalizeNotifyLevel(value: unknown): NotifyLevel | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return isNotifyLevel(trimmed) ? trimmed : null;
}

/**
 * Read a channel row's level: the flat `notifyLevel` the desktop serializes,
 * else the server's nested `membership.notifyLevel`.
 */
export function notifyLevelFromWire(row: unknown): NotifyLevel | null {
  if (!row || typeof row !== "object") return null;
  const rec = row as Record<string, unknown>;
  const flat = normalizeNotifyLevel(rec.notifyLevel ?? rec.notify_level);
  if (flat) return flat;
  const membership = rec.membership;
  if (membership && typeof membership === "object") {
    return normalizeNotifyLevel(
      (membership as Record<string, unknown>).notifyLevel,
    );
  }
  return null;
}

export function notifyLevelLabel(level: NotifyLevel | null | undefined): string {
  return (
    NOTIFY_LEVEL_OPTIONS.find((option) => option.level === level)?.label ??
    "Default"
  );
}

export function isMutedLevel(level: NotifyLevel | null | undefined): boolean {
  return level === "muted";
}

/** Accessible name for the header bell. */
export function notifyBellLabel(level: NotifyLevel | null | undefined): string {
  return level
    ? `Notifications: ${notifyLevelLabel(level)}`
    : "Notifications";
}

/** Human copy for a failed level change. */
export function notifyLevelErrorMessage(failure: {
  code?: string;
  message?: string;
}): string {
  switch (failure.code) {
    case "CHANNEL_NOT_JOINED":
      return "Join this channel to change its notifications.";
    case "INVALID_NOTIFY_LEVEL":
      return "That notification level isn't supported.";
    case "http-404":
      return "This server doesn't support channel notification settings yet.";
    default:
      return failure.message?.trim() || "Couldn't update notifications.";
  }
}

export type NotifyLevelResult =
  | { ok: true }
  | { ok: false; code?: string; message?: string };

/**
 * Optimistic level change with rollback. `apply` paints a level (the header
 * and the sidebar row); `persist` calls the server. On failure the previous
 * level is painted back and the error copy is returned.
 */
export async function changeNotifyLevel(args: {
  previous: NotifyLevel | null;
  next: NotifyLevel;
  apply: (level: NotifyLevel | null) => void;
  persist: (level: NotifyLevel) => Promise<NotifyLevelResult>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (args.previous === args.next) return { ok: true };
  args.apply(args.next);
  let result: NotifyLevelResult;
  try {
    result = await args.persist(args.next);
  } catch (err) {
    result = {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (result.ok) return { ok: true };
  args.apply(args.previous);
  return { ok: false, error: notifyLevelErrorMessage(result) };
}
