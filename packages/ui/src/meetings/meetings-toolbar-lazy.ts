/**
 * Doors for the Meetings toolbar popovers (US-042). The panel and paste box
 * bodies load on first click; the toolbar paints a skeleton in the meantime.
 */

let calendar: Promise<typeof import("./CalendarPanel.svelte")> | null = null;
let paste: Promise<typeof import("./PasteLinkBox.svelte")> | null = null;

export function loadCalendarPanel(): Promise<typeof import("./CalendarPanel.svelte")> {
  calendar ??= import("./CalendarPanel.svelte").catch((err) => {
    calendar = null;
    throw err;
  });
  return calendar;
}

export function loadPasteLinkBox(): Promise<typeof import("./PasteLinkBox.svelte")> {
  paste ??= import("./PasteLinkBox.svelte").catch((err) => {
    paste = null;
    throw err;
  });
  return paste;
}
