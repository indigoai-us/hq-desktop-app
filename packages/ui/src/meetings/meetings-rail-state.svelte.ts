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
/** Pasted rooms attached to calendar events (US-042). In memory only. */
let attachedLinks = $state<Map<string, string>>(new Map());
/** Mounted canvas hosts. While one is mounted and agenda mode is off, the
 *  host renders the desktop-detected live card; the hidden agenda must not. */
let canvasHosts = $state(0);

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
  /** True when the canvas host, not the agenda, owns the live card. */
  get hostOwnsLiveCard() {
    return canvasHosts > 0 && !agenda;
  },
  /** Register a mounted canvas host. Returns the unregister function. */
  registerCanvasHost(): () => void {
    canvasHosts += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      canvasHosts -= 1;
    };
  },
  select(id: string | null): void {
    selectedId = id;
    agenda = false;
  },
  get attachedLinks() {
    return attachedLinks;
  },
  /** Attach a pasted room to a meeting and select it. */
  attachLink(id: string, url: string): void {
    attachedLinks = new Map(attachedLinks).set(id, url);
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
    attachedLinks = new Map();
  },
};
