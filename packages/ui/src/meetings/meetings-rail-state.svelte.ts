/**
 * Shared view state for the Meetings rail destination (console-rail US-021).
 *
 * The sidepane and the canvas live in different shell slots, so the selected
 * meeting, the filter, and agenda mode sit in one module-level rune both
 * hosts read. Pure state; no timers or fetches.
 */

import { EMPTY_MEETINGS_FILTER, type MeetingsFilter } from "./meetings-rail-model";

let selectedId = $state<string | null>(null);
let filter = $state<MeetingsFilter>(EMPTY_MEETINGS_FILTER);
/** True while the classic agenda (notetaker, calendars) replaces the canvas. */
let agenda = $state(false);

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
  select(id: string | null): void {
    selectedId = id;
    agenda = false;
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
  },
};
