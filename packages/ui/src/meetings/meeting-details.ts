/**
 * Event details for the meeting canvas: agenda from the calendar description,
 * attendees with their response, organizer, and venue. Pure helpers so the
 * mapping stays testable and out of the boot graph (only the lazy states body
 * imports this file).
 */
import type { MeetingAttendee, MeetingEvent, MeetingOutlineEntry } from "./meetings-model";

const MAX_AGENDA_ITEMS = 12;
const MAX_ATTENDEES = 24;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** Google sends HTML descriptions; turn them into plain lines. */
export function descriptionLines(description: string | null | undefined): string[] {
  if (!description) return [];
  const text = description
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•–])\s*/, "").trim())
    .filter(Boolean);
}

/** Notetaker outline when present, otherwise the calendar description. */
export function agendaItems(event: MeetingEvent): MeetingOutlineEntry[] {
  if (event.outline?.length) return event.outline;
  return descriptionLines(event.description)
    .slice(0, MAX_AGENDA_ITEMS)
    .map((title, i) => ({ id: `desc-${i}`, title }));
}

const RESPONSE_LABEL: Record<string, string> = {
  accepted: "Accepted",
  declined: "Declined",
  tentative: "Maybe",
  needsAction: "Invited",
};

export function responseLabel(status: string | null | undefined): string {
  return status ? (RESPONSE_LABEL[status] ?? "") : "";
}

export interface AttendeeView {
  key: string;
  name: string;
  email: string;
  response: string;
  organizer: boolean;
  self: boolean;
}

/** Real people on the invite (rooms dropped), organizer first, capped. */
export function attendeeViews(event: MeetingEvent): AttendeeView[] {
  const organizerEmail = event.organizer?.email?.toLowerCase() ?? "";
  const people = (event.attendees ?? []).filter((a: MeetingAttendee) => !a.resource && (a.email || a.displayName));
  const views = people.map((a, i) => {
    const email = a.email ?? "";
    const organizer = Boolean(a.organizer) || (!!email && email.toLowerCase() === organizerEmail);
    return {
      key: email || `${a.displayName}-${i}`,
      name: a.displayName?.trim() || email,
      email,
      response: responseLabel(a.responseStatus),
      organizer,
      self: Boolean(a.self),
    };
  });
  views.sort((a, b) => Number(b.organizer) - Number(a.organizer));
  return views.slice(0, MAX_ATTENDEES);
}

export function organizerLabel(event: MeetingEvent): string {
  const o = event.organizer;
  if (!o) return "";
  return o.displayName?.trim() || o.email || "";
}

/** Join URL from the event, its conference entry points, or a URL in the location. */
export function meetingJoinUrl(event: MeetingEvent): string {
  const direct = (event.meetingUrl || event.hangoutLink || "").trim();
  if (direct) return direct;
  const video = event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video" && e.uri);
  if (video?.uri) return video.uri;
  const match = event.location?.match(/https?:\/\/\S+/);
  return match ? match[0] : "";
}

/** Location text worth showing: not empty and not just the join URL. */
export function locationLabel(event: MeetingEvent): string {
  const loc = event.location?.trim() ?? "";
  if (!loc || /^https?:\/\/\S+$/.test(loc)) return "";
  return loc;
}

