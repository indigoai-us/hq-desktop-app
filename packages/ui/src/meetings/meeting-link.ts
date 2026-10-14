/**
 * Meetings calendar chip and paste-a-link model (console-rail US-042,
 * storyboard revision 10). Pure: no stores, no fetches.
 */

import {
  eventMeetingUrl,
  eventEnd,
  eventStart,
  isPlausibleMeetingUrl,
  normalizeMeetingUrl,
  type GoogleAccount,
  type MeetingEvent,
} from "./meetings-model";

export type MeetingProvider = "zoom" | "meet" | "teams";

export const PROVIDER_LABEL: Record<MeetingProvider, string> = {
  zoom: "Zoom",
  meet: "Meet",
  teams: "Teams",
};

/** Zoom, Meet, or Teams for a pasted join link; null for anything else. */
export function detectMeetingProvider(raw: string | null | undefined): MeetingProvider | null {
  const url = (raw ?? "").trim();
  if (!isPlausibleMeetingUrl(url)) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/(?:^|\.)zoom\.us$/.test(host)) return "zoom";
  if (host === "meet.google.com") return "meet";
  if (host === "teams.microsoft.com") return "teams";
  return null;
}

/** "Meeting 884 1229 0117" for Zoom links, else null. */
export function zoomMeetingLabel(raw: string): string | null {
  const m = /\/j\/(\d{9,11})/.exec(raw);
  if (!m) return null;
  const id = m[1];
  const parts = id.length === 11 ? [id.slice(0, 3), id.slice(3, 7), id.slice(7)] : [id.slice(0, 3), id.slice(3, 6), id.slice(6)];
  return `Meeting ${parts.join(" ")}`;
}

/** Upcoming (not yet ended) events, soonest first. */
export function upcomingMeetings(events: readonly MeetingEvent[], now: Date, limit = 6): MeetingEvent[] {
  return events
    .filter((e) => {
      const start = eventStart(e);
      const end = eventEnd(e) ?? start;
      return !!start && !!end && end.getTime() > now.getTime();
    })
    .sort((a, b) => eventStart(a)!.getTime() - eventStart(b)!.getTime())
    .slice(0, limit);
}

/** The upcoming event whose own link is the pasted room, if any. */
export function matchUpcomingMeeting(
  raw: string,
  events: readonly MeetingEvent[],
  now: Date,
): MeetingEvent | null {
  const pasted = normalizeMeetingUrl(raw);
  if (!pasted) return null;
  return (
    upcomingMeetings(events, now, Number.POSITIVE_INFINITY).find(
      (e) => normalizeMeetingUrl(eventMeetingUrl(e)) === pasted,
    ) ?? null
  );
}

/** Toolbar chip text: "No calendar" or "Google · 1 account". */
export function calendarChipLabel(accounts: readonly GoogleAccount[]): {
  connected: boolean;
  provider: string;
  count: string;
} {
  const n = accounts.filter((a) => a.accountId).length;
  if (n === 0) return { connected: false, provider: "No calendar", count: "" };
  return { connected: true, provider: "Google", count: `${n} ${n === 1 ? "account" : "accounts"}` };
}

/** "synced 2 min ago" from a ms timestamp; "not synced yet" when 0. */
export function syncedAgo(at: number, now: number): string {
  if (!at) return "not synced yet";
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  if (mins < 1) return "synced just now";
  if (mins < 60) return `synced ${mins} min ago`;
  return `synced ${Math.round(mins / 60)} h ago`;
}
