/**
 * Shared view state for the Meetings rail destination (console-rail US-021).
 *
 * The sidepane and the canvas live in different shell slots, so the selected
 * meeting, the filter, and agenda mode sit in one module-level rune both
 * hosts read. Pure state; no timers or fetches.
 */

import { EMPTY_MEETINGS_FILTER, type MeetingsFilter } from "./meetings-rail-model";
import type { MeetingEvent } from "./meetings-model";

let selectedId = $state<string | null>(null);
let filter = $state<MeetingsFilter>(EMPTY_MEETINGS_FILTER);
/** True while the classic agenda (notetaker, calendars) replaces the canvas. */
let agenda = $state(false);
/** New meeting sheet. Local until a calendar write API exists. */
let sheetOpen = $state(false);
let localMeetings = $state<MeetingEvent[]>([]);
/** Link handed to the New meeting sheet by "New meeting with this link". */
let sheetLink = $state<string | null>(null);
/** Pasted rooms attached to calendar events (US-042). In memory only. */
let attachedLinks = $state<Map<string, string>>(new Map());

export const meetingsRailState = {
  get selectedId() {
    return selectedId;
  },
  get filter() {
    return filter;
  },
  get agenda() {
    return agenda;
  },
  get sheetOpen() {
    return sheetOpen;
  },
  get localMeetings() {
    return localMeetings;
  },
  select(id: string | null): void {
    selectedId = id;
    agenda = false;
  },
  get sheetLink() {
    return sheetLink;
  },
  get attachedLinks() {
    return attachedLinks;
  },
  openSheet(on = true, link: string | null = null): void {
    sheetOpen = on;
    sheetLink = on ? link : null;
  },
  /** Attach a pasted room to a meeting and select it. */
  attachLink(id: string, url: string): void {
    const local = localMeetings.find((row) => row.id === id);
    if (local) {
      localMeetings = localMeetings.map((row) => (row.id === id ? { ...row, meetingUrl: url } : row));
    } else {
      attachedLinks = new Map(attachedLinks).set(id, url);
    }
    selectedId = id;
    agenda = false;
  },
  addLocalMeeting(event: MeetingEvent): void {
    localMeetings = [event, ...localMeetings.filter((row) => row.id !== event.id)];
    selectedId = event.id;
    agenda = false;
    sheetOpen = false;
    sheetLink = null;
  },
  setFilter(next: MeetingsFilter): void {
    filter = next;
  },
  showAgenda(on = true): void {
    agenda = on;
  },
  reset(): void {
    selectedId = null;
    filter = EMPTY_MEETINGS_FILTER;
    agenda = false;
    sheetOpen = false;
    localMeetings = [];
    sheetLink = null;
    attachedLinks = new Map();
  },
};
