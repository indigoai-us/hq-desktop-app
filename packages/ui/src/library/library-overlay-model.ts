/**
 * Pure model for the Marketplace page (OWNER-R33; was the Library overlay,
 * US-017): left-list rows, tab resolution from the library route tabs, and
 * marketplace badge derivation. No Svelte / Tauri.
 */

import {
  filterListings,
  listingAuthorHandle,
  listingDisplayName,
  type MarketplaceListing,
} from "../marketplace/marketplace.js";
import { packIdentity } from "./packages-model.js";
import type { Capabilities } from "@hq/platform";
/**
 * Route tab values (PORT NOTE: mirrored from desktop-alt `route.ts`, which is
 * app-shell-owned; the host passes/receives these as plain strings).
 */
export type LibraryTab =
  | "skills"
  | "workers"
  | "installed"
  | "marketplace"
  | "submit"
  | "profile";

/**
 * OWNER-R33: the page is the Marketplace. Its left list is Browse, Installed
 * and Submit; Skills and Workers live in each company's Brain panes, and the
 * creator profile in Settings. Legacy `skills` / `workers` route tabs land on
 * Browse.
 */
export type LibraryOverlayTab = "marketplace" | "installed" | "submit";

/**
 * Installed packs and publishing need a host that installs locally (desktop).
 * Browse reads the shared listings API on every host.
 */
export function libraryOverlayCapabilities(
  capabilities: Pick<Capabilities, "canInstallLocally">,
): {
  marketplace: boolean;
} {
  return { marketplace: capabilities.canInstallLocally };
}

export type MarketplaceBadge = "installed" | "update" | "get";

export interface InstalledPackRef {
  /** Pack name or source slug used for identity matching. */
  name: string;
  source?: string | null;
  version?: string | null;
  /** True when a newer version is available. */
  updateAvailable?: boolean | null;
}

export interface LibraryNavRow {
  id: LibraryOverlayTab;
  label: string;
  /** Count badge text, or null when the row carries no count. */
  count: number | null;
}

/**
 * Map a routed LibraryTab onto the Marketplace page's tabs. Installed and
 * Submit are account-management surfaces; everything else is Browse.
 */
export function resolveOverlayTab(
  tab: LibraryTab | undefined | null,
  opts?: { marketplace?: boolean },
): LibraryOverlayTab {
  if (opts?.marketplace !== false) {
    if (tab === "installed") return "installed";
    if (tab === "submit") return "submit";
  }
  return "marketplace";
}

/** Inverse: overlay tab → route LibraryTab for navigation. */
export function overlayTabToLibraryTab(tab: LibraryOverlayTab): LibraryTab {
  return tab;
}

/** Left-list rows: Browse first (the default), then Installed and Submit. */
export function buildLibraryNavRows(
  opts?: { marketplace?: boolean },
): LibraryNavRow[] {
  const rows: LibraryNavRow[] = [{ id: "marketplace", label: "Browse", count: null }];
  if (opts?.marketplace !== false) {
    rows.push({ id: "installed", label: "Installed", count: null });
    rows.push({ id: "submit", label: "Submit", count: null });
  }
  return rows;
}

export function formatNavLabel(row: LibraryNavRow): string {
  if (row.count == null) return row.label;
  return `${row.label} ${row.count}`;
}

/** Build a lookup of installed pack identity → update flag. */
export function indexInstalledPacks(
  installed: InstalledPackRef[] | null | undefined,
): Map<string, InstalledPackRef> {
  const map = new Map<string, InstalledPackRef>();
  for (const pack of installed ?? []) {
    const ids = [
      packIdentity(pack.name),
      packIdentity(pack.source ?? undefined),
    ].filter(Boolean);
    for (const id of ids) {
      if (!map.has(id)) map.set(id, pack);
    }
  }
  return map;
}

/**
 * Marketplace card badge:
 * - installed — already installed, no update
 * - update — installed with a newer version available
 * - get — not installed (primary install action)
 */
export function marketplaceBadgeForListing(
  listing: Pick<MarketplaceListing, "slug" | "name">,
  installedByIdentity: Map<string, InstalledPackRef>,
): MarketplaceBadge {
  const candidates = [
    packIdentity(listing.slug),
    packIdentity(listing.name),
    packIdentity(`hq-pack-${listing.slug}`),
  ].filter(Boolean);

  let matched: InstalledPackRef | undefined;
  for (const id of candidates) {
    matched = installedByIdentity.get(id);
    if (matched) break;
  }
  if (!matched) return "get";
  if (matched.updateAvailable === true) return "update";
  return "installed";
}

export interface MarketplaceCardModel {
  id: string;
  name: string;
  displayName: string;
  slug: string;
  version: string;
  author: string;
  summary: string;
  badge: MarketplaceBadge;
}

export function toMarketplaceCards(
  listings: MarketplaceListing[],
  installed: InstalledPackRef[] | null | undefined,
  query = "",
): MarketplaceCardModel[] {
  const index = indexInstalledPacks(installed);
  const filtered = filterListings(listings, query);
  return filtered.map((listing) => ({
    id: listing.id,
    name: listing.name,
    displayName: listingDisplayName(listing),
    slug: listing.slug,
    version: listing.version,
    author: listingAuthorHandle(listing),
    summary: (listing.summary ?? listing.contributes ?? "").trim(),
    badge: marketplaceBadgeForListing(listing, index),
  }));
}

export { filterListings };
