/**
 * AppRail model (console-rail US-003).
 *
 * The 56 px rail on the left of the shell owns top-level navigation. This
 * module is the single source of truth for its order, its ⌘1–⌘9 mapping, the
 * placeholder pages for personal destinations not built yet, and which item
 * is selected for the current shell state. DesktopApp turns an item into a
 * NavigationDestination and sends it through the navigation controller.
 */

import type { NavigationDestination } from "./navigation-history.js";
import { companyRowDestination, companyRowForPage } from "./company-pane.js";

/** Pinned company tiles beyond this count live in More companies (US-004). */
export const MAX_PINNED_COMPANY_TILES = 6;

/** Extra-page ids for rail destinations whose real page is a later story. */
export const RAIL_PLACEHOLDER_PREFIX = "rail-";

export type RailPersonalId =
  | "deployments"
  | "telemetry"
  | "secrets"
  | "connections"
  | "outpost";

export type RailPlaceholderId = RailPersonalId | "more-companies" | "library";

export interface RailPlaceholder {
  id: RailPlaceholderId;
  title: string;
  /** Story that replaces the placeholder with the real page. */
  story: string;
  summary: string;
}

export const RAIL_PLACEHOLDERS: Record<RailPlaceholderId, RailPlaceholder> = {
  "more-companies": {
    id: "more-companies",
    title: "More companies",
    story: "US-005",
    summary: "Search, pin, and switch between all of your companies.",
  },
  library: {
    id: "library",
    title: "Library",
    story: "US-031",
    summary: "Your personal files and what has been shared with you.",
  },
  deployments: {
    id: "deployments",
    title: "Deployments",
    story: "US-031",
    summary: "Everything you have deployed or shared from HQ.",
  },
  telemetry: {
    id: "telemetry",
    title: "Telemetry",
    story: "US-032",
    summary: "Your personal usage and session telemetry.",
  },
  secrets: {
    id: "secrets",
    title: "Secrets",
    story: "US-033",
    summary: "Your personal secrets.",
  },
  connections: {
    id: "connections",
    title: "Connections",
    story: "US-033",
    summary: "Your personal integrations.",
  },
  outpost: {
    id: "outpost",
    title: "Outpost",
    story: "US-034",
    summary: "Your Outpost machine and scheduled jobs.",
  },
};

export function railPlaceholderPage(id: RailPlaceholderId): string {
  return `${RAIL_PLACEHOLDER_PREFIX}${id}`;
}

export function railPlaceholderForPage(
  page: string | null | undefined,
): RailPlaceholder | null {
  if (!page || !page.startsWith(RAIL_PLACEHOLDER_PREFIX)) return null;
  const id = page.slice(RAIL_PLACEHOLDER_PREFIX.length) as RailPlaceholderId;
  return Object.prototype.hasOwnProperty.call(RAIL_PLACEHOLDERS, id)
    ? RAIL_PLACEHOLDERS[id]
    : null;
}

export interface RailCompany {
  uid: string;
  label: string;
  iconUrl?: string | null;
  /** Online people or bots already in the presence snapshot. */
  liveCount?: number;
  /** Unread company-channel messages, rolled up onto the tile. */
  unreadCount?: number;
}

export type RailItem =
  | { kind: "home"; id: "home"; label: "Home" }
  | { kind: "meetings"; id: "meetings"; label: "Meetings" }
  | {
      kind: "company";
      id: `company:${string}`;
      label: string;
      companyUid: string;
      iconUrl: string | null;
      liveCount: number;
      unreadCount: number;
    }
  | { kind: "more-companies"; id: "more-companies"; label: "More companies" }
  | { kind: "library"; id: "library"; label: "Library" }
  | { kind: "personal"; id: RailPersonalId; label: string }
  | { kind: "you"; id: "you"; label: string };

export type RailItemId = RailItem["id"];

const PERSONAL_ORDER: readonly RailPersonalId[] = [
  "deployments",
  "telemetry",
  "secrets",
  "connections",
  "outpost",
];

/**
 * The decided order: Home, Meetings, pinned company tiles (max six), More
 * companies, Library, Deployments, Telemetry, Secrets, Connections, Outpost,
 * then (after the spacer) the You avatar.
 */
export function railItems(
  companies: readonly RailCompany[],
  youLabel: string,
): RailItem[] {
  const tiles: RailItem[] = companies
    .filter((c) => c.uid.trim())
    .slice(0, MAX_PINNED_COMPANY_TILES)
    .map((c) => ({
      kind: "company",
      id: `company:${c.uid}`,
      label: c.label || c.uid,
      companyUid: c.uid,
      iconUrl: c.iconUrl?.trim() || null,
      liveCount: Math.max(0, c.liveCount ?? 0),
      unreadCount: Math.max(0, c.unreadCount ?? 0),
    }));
  return [
    { kind: "home", id: "home", label: "Home" },
    { kind: "meetings", id: "meetings", label: "Meetings" },
    ...tiles,
    { kind: "more-companies", id: "more-companies", label: "More companies" },
    { kind: "library", id: "library", label: "Library" },
    ...PERSONAL_ORDER.map(
      (id): RailItem => ({ kind: "personal", id, label: RAIL_PLACEHOLDERS[id].title }),
    ),
    { kind: "you", id: "you", label: youLabel || "You" },
  ];
}

/**
 * Destination a rail item opens. Company tiles also switch tenant scope.
 * Library opens the Files explorer; hosts without local files (web) get the
 * Library overlay instead.
 */
export function railDestination(
  item: RailItem,
  options: { localFiles?: boolean } = {},
): NavigationDestination {
  switch (item.kind) {
    case "home":
      return { kind: "messages" };
    case "company":
      // US-009: Atlas is the company landing page.
      return companyRowDestination("atlas", item.companyUid);
    case "meetings":
      return { kind: "meetings" };
    case "library":
      // US-031: the rail opens personal files and Shared with me.
      // The skills overlay stays available as { kind: "library" }.
      void options;
      return { kind: "extra", page: railPlaceholderPage("library") };
    case "more-companies":
      return { kind: "extra", page: railPlaceholderPage("more-companies") };
    case "personal":
      return { kind: "extra", page: railPlaceholderPage(item.id) };
    case "you":
      return { kind: "settings", section: "profile" };
  }
}

/** Right-side tooltip: the destination plus a live count where one exists. */
export function railTooltip(item: RailItem, counts: { unread?: number } = {}): string {
  if (item.kind === "home") {
    const unread = counts.unread ?? 0;
    return unread > 0 ? `Home · ${unread} unread` : "Home · Messages & Inbox";
  }
  if (item.kind === "company") {
    const unread = item.unreadCount > 0 ? `${item.unreadCount} unread` : null;
    const live = item.liveCount > 0 ? `${item.liveCount} live` : null;
    const extra = [unread, live].filter(Boolean).join(" · ");
    return extra ? `${item.label} · ${extra}` : item.label;
  }
  if (item.kind === "library") return "Library · your files & vault";
  if (item.kind === "you") return `${item.label} · Profile`;
  return item.label;
}

export interface RailSelectionState {
  view: string;
  tenantCompanyId: string | null;
  extraPageId: string | null;
  settingsSection: string | null;
}

/** Which rail item is selected (background highlight only). */
export function activeRailItemId(state: RailSelectionState): RailItemId | null {
  switch (state.view) {
    case "meetings":
      return "meetings";
    case "explorer":
    case "library":
      return "library";
    case "settings":
      return state.settingsSection === "profile" ? "you" : null;
    case "extra": {
      if (state.extraPageId?.startsWith("account-")) return "you";
      const placeholder = railPlaceholderForPage(state.extraPageId);
      if (placeholder) return placeholder.id;
      // US-007: company sidepane pages keep their company tile selected.
      return state.tenantCompanyId && companyRowForPage(state.extraPageId)
        ? `company:${state.tenantCompanyId}`
        : null;
    }
    case "conversation":
    case "notifications":
    case "dm-requests":
      return state.tenantCompanyId ? `company:${state.tenantCompanyId}` : "home";
    default:
      return null;
  }
}

/** ⌘1–⌘9 select the rail item at that position. */
export const RAIL_SHORTCUT_COUNT = 9;
