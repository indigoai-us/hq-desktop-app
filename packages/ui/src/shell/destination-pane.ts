/**
 * Which sidepane a committed navigation entry shows (QA-047, QA-045).
 *
 * The sidepane is derived from the destination being applied, never from
 * the state the shell was in before. Rail clicks, the command palette, deep
 * links, and Back/Forward all commit an entry, and the shell applies this
 * result in the same step as the canvas, so canvas and pane cannot diverge.
 */

import { companyRowForPage } from "./company-pane.js";
import type { NavigationEntry } from "./navigation-history.js";

export type DestinationPane =
  /** Company sections for `companyKey` (membership uid or slug). */
  | { pane: "company"; companyKey: string }
  /** The Meetings list. Tenant scope is left as it is. */
  | { pane: "meetings" }
  /**
   * The Home chat sidepane. `companyKey` is the scope it lists: null for
   * the cross-company Home list, or the company a conversation belongs to.
   */
  | { pane: "home"; companyKey: string | null }
  /** Full-page or personal destinations; the company pane is closed. */
  | { pane: "none" };

function trimmed(value: string | null | undefined): string | null {
  const next = value?.trim() ?? "";
  return next ? next : null;
}

export function paneForEntry(entry: NavigationEntry): DestinationPane {
  const destination = entry.destination;
  switch (destination.kind) {
    case "extra": {
      if (companyRowForPage(destination.page)) {
        const companyKey =
          trimmed(destination.companyUid) ?? trimmed(entry.companyUid);
        if (companyKey) return { pane: "company", companyKey };
      }
      return { pane: "none" };
    }
    case "meetings":
      return { pane: "meetings" };
    case "messages":
    case "channel":
    case "dm":
    case "notifications":
    case "dm-requests":
    case "setup-checkout":
      // Restore the scope the entry was recorded under.
      return { pane: "home", companyKey: trimmed(entry.companyUid) };
    default:
      return { pane: "none" };
  }
}

/**
 * The company scope a newly committed entry is recorded under.
 *
 * Home's chat sidepane lists the scope its entry carries. The rail Home
 * button always lands on the cross-company list, and the company picker in
 * the sidepane header is the only control that narrows it to one company
 * (which also adds that company's Activity section). Opening a conversation,
 * Notifications, or connection requests from anywhere outside Home (a company
 * page's Bots / Team / Atlas "Message", a notification, ⌘K over a company
 * page) used to carry that page's company into Home, so the same sidebar
 * showed an Activity section on one path and not on another. Those entries
 * now record the cross-company scope, exactly what the Home button shows.
 * Opening a conversation while already on Home keeps the scope the person
 * picked. `messages` is left alone: it is how an explicit scope pick lands.
 */
export function entryCompanyUidForCommit(
  destination: NavigationEntry["destination"],
  companyUid: string | null,
  from: NavigationEntry | null,
): string | null {
  switch (destination.kind) {
    case "channel":
    case "dm":
    case "notifications":
    case "dm-requests":
      if (from && paneForEntry(from).pane !== "home") return null;
      return companyUid;
    default:
      return companyUid;
  }
}
