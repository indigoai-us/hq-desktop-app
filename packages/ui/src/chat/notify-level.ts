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

/** Accessible name for the header mute toggle. */
export function muteToggleLabel(level: NotifyLevel | null | undefined): string {
  return level === "muted" ? "Unmute channel" : "Mute channel";
}

/**
 * The level a one-click unmute restores: the channel's last non-muted level,
 * else "mentions" (the server's default for a member).
 */
export function unmuteLevel(remembered: NotifyLevel | null | undefined): NotifyLevel {
  return remembered && remembered !== "muted" ? remembered : "mentions";
}

/**
 * The server's default level for a member without an explicit choice
 * (hq-pro `resolveNotifyLevel`): "all" for a group DM or a channel the caller
 * created, else "mentions". A one-click unmute with nothing remembered
 * restores this.
 */
export function defaultNotifyLevel(args: {
  scope?: string | null;
  kind?: string | null;
  createdBy?: string | null;
  selfUid?: string | null;
}): NotifyLevel {
  if (args.scope === "group" || args.kind === "group") return "all";
  const creator = args.createdBy?.trim();
  const self = args.selfUid?.trim();
  if (creator && self && creator === self) return "all";
  return "mentions";
}

/** localStorage key for the per-channel pre-mute levels. */
export const REMEMBERED_NOTIFY_LEVELS_KEY = "hq.chat.notify-level.remembered.v1";

type LevelStorage = Pick<Storage, "getItem" | "setItem">;

/** Read the persisted channelId → last non-muted level map. */
export function loadRememberedNotifyLevels(
  storage: LevelStorage | null | undefined,
): Record<string, NotifyLevel> {
  try {
    const raw = storage?.getItem(REMEMBERED_NOTIFY_LEVELS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, NotifyLevel> = {};
    for (const [id, value] of Object.entries(parsed)) {
      const level = normalizeNotifyLevel(value);
      if (level && level !== "muted") out[id] = level;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the map; storage failures are ignored (memory copy still works). */
export function saveRememberedNotifyLevels(
  storage: LevelStorage | null | undefined,
  levels: Record<string, NotifyLevel>,
): void {
  try {
    storage?.setItem(REMEMBERED_NOTIFY_LEVELS_KEY, JSON.stringify(levels));
  } catch {
    /* private mode / quota: keep the in-memory copy */
  }
}

/** Target of a one-click toggle: mute, or restore the remembered level. */
export function toggledMuteLevel(
  current: NotifyLevel | null | undefined,
  remembered: NotifyLevel | null | undefined,
): NotifyLevel {
  return current === "muted" ? unmuteLevel(remembered) : "muted";
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
