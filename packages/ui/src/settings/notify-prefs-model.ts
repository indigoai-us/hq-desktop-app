/**
 * Settings > Notifications: server-backed notification preferences
 * (`GET/PUT /v1/notify/prefs`). Pure helpers so the pause math, toggle list,
 * and 404 handling are testable without a DOM.
 */

import type { NotifyPrefs, NotifyPrefsPatch } from "@hq/platform";

export type PauseChoice = "off" | "1h" | "8h" | "tomorrow" | "forever";

export const PAUSE_CHOICES: ReadonlyArray<{ id: PauseChoice; label: string }> = [
  { id: "off", label: "Off" },
  { id: "1h", label: "1 hour" },
  { id: "8h", label: "8 hours" },
  { id: "tomorrow", label: "Until tomorrow 8am" },
  { id: "forever", label: "Indefinitely" },
];

export type PrefToggleKey =
  | "dms"
  | "mentions"
  | "files"
  | "allActivity"
  | "addedToChannel"
  | "dmsDuringPause";

export const PREF_TOGGLES: ReadonlyArray<{
  key: PrefToggleKey;
  label: string;
  description: string;
}> = [
  { key: "dms", label: "Direct messages", description: "New messages sent only to you" },
  { key: "mentions", label: "Mentions", description: "Messages that @mention you, unless the channel is muted" },
  { key: "files", label: "Files shared", description: "Files posted in channels set to all messages or files" },
  { key: "allActivity", label: "All activity", description: "Every message in channels set to all messages" },
  { key: "addedToChannel", label: "Added to a channel", description: "When someone adds you to a channel" },
  { key: "dmsDuringPause", label: "Let DMs through while paused", description: "Direct messages still notify during a pause" },
];

/** Local 8:00 tomorrow, as an instant. */
export function tomorrowAtEight(now: Date): Date {
  const next = new Date(now.getTime());
  next.setDate(next.getDate() + 1);
  next.setHours(8, 0, 0, 0);
  return next;
}

/**
 * The `pausedUntil` value for a choice: an ISO-8601 instant in UTC ("Z"),
 * "forever", or null to clear.
 */
export function pausedUntilFor(choice: PauseChoice, now: Date = new Date()): string | null {
  switch (choice) {
    case "off":
      return null;
    case "1h":
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    case "8h":
      return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();
    case "tomorrow":
      return tomorrowAtEight(now).toISOString();
    case "forever":
      return "forever";
  }
}

/** True while `pausedUntil` is in the future (or "forever"). */
export function isPauseActive(pausedUntil: string | null | undefined, now: Date = new Date()): boolean {
  if (!pausedUntil) return false;
  if (pausedUntil === "forever") return true;
  const ts = Date.parse(pausedUntil);
  return Number.isFinite(ts) && ts > now.getTime();
}

/** One-line status for the pause row. */
export function describePause(pausedUntil: string | null | undefined, now: Date = new Date()): string {
  if (!isPauseActive(pausedUntil, now)) return "Notifications are on";
  if (pausedUntil === "forever") return "Paused until you turn it off";
  const until = new Date(Date.parse(pausedUntil!));
  const time = until.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = until.toDateString() === now.toDateString();
  if (sameDay) return `Paused until ${time}`;
  const tomorrow = new Date(now.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (until.toDateString() === tomorrow.toDateString()) {
    return `Paused until tomorrow at ${time}`;
  }
  const day = until.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `Paused until ${day} at ${time}`;
}

/** Merge a patch onto the current prefs (optimistic paint). */
export function applyPrefsPatch(prefs: NotifyPrefs, patch: NotifyPrefsPatch): NotifyPrefs {
  return { ...prefs, ...patch };
}

/** Coerce a prefs payload (`{ prefs }` envelope or bare object) with server defaults. */
export function normalizeNotifyPrefs(raw: unknown): NotifyPrefs | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const body =
    rec.prefs && typeof rec.prefs === "object" && !Array.isArray(rec.prefs)
      ? (rec.prefs as Record<string, unknown>)
      : rec;
  const bool = (key: string, fallback: boolean): boolean =>
    typeof body[key] === "boolean" ? (body[key] as boolean) : fallback;
  return {
    pausedUntil: typeof body.pausedUntil === "string" ? body.pausedUntil : null,
    dmsDuringPause: bool("dmsDuringPause", false),
    dms: bool("dms", true),
    mentions: bool("mentions", true),
    files: bool("files", true),
    allActivity: bool("allActivity", true),
    addedToChannel: bool("addedToChannel", true),
    updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : null,
  };
}

export type PrefsLoadState =
  | { kind: "loading" }
  | { kind: "ready"; prefs: NotifyPrefs }
  /** The server predates the route (404) or the host has no prefs seam. */
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

/** Map a failed adapter result to a load state. 404 is "not available yet". */
export function prefsFailureState(failure: { code?: string; message?: string }): PrefsLoadState {
  if (failure.code === "http-404") return { kind: "unavailable" };
  return {
    kind: "error",
    message: failure.message?.trim() || "Couldn't load notification settings.",
  };
}

/** Error copy for a failed save. */
export function prefsSaveErrorMessage(failure: { code?: string; message?: string }): string {
  if (failure.code === "http-404") {
    return "This server doesn't support notification settings yet.";
  }
  if (failure.code === "INVALID_NOTIFY_PREFS") {
    return "That setting wasn't accepted. Try again.";
  }
  return failure.message?.trim() || "Couldn't save notification settings.";
}
