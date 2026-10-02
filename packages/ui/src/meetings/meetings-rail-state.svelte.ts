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
  openSheet(on = true): void {
    sheetOpen = on;
  },
  addLocalMeeting(event: MeetingEvent): void {
    localMeetings = [event, ...localMeetings.filter((row) => row.id !== event.id)];
    selectedId = event.id;
    agenda = false;
    sheetOpen = false;
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
  },
};
