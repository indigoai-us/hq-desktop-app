/**
 * Pure model for the Library full-screen overlay (US-017).
 *
 * Nav counts, search filtering, marketplace badge derivation, and tab
 * resolution from the existing library route tabs. No Svelte / Tauri.
 */

import {
  filterLibraryItems,
  libraryItemHaystack,
  toLibraryItems,
  type LibraryItem,
  type LibraryItems,
  type LibrarySkill,
  type LibraryWorker,
} from "./library.js";
import {
  filterListings,
  listingDisplayName,
  type MarketplaceListing,
} from "../marketplace/marketplace.js";
import { packIdentity } from "./packages-model.js";
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

/** Every supported Library destination has its own overlay tab. */
export type LibraryOverlayTab =
  | "skills"
  | "workers"
  | "installed"
  | "marketplace"
  | "submit"
  | "profile";

export type MarketplaceBadge = "installed" | "update" | "get";

export interface InstalledPackRef {
  /** Pack name or source slug used for identity matching. */
  name: string;
  source?: string | null;
  version?: string | null;
  /** True when a newer version is available. */
  updateAvailable?: boolean | null;
}

export interface LibraryNavCounts {
  skills: number;
  workers: number;
}

export interface LibraryNavRow {
  id: LibraryOverlayTab;
  label: string;
  /** Count badge text (skills/workers) or null for Marketplace. */
  count: number | null;
}

/**
 * Map a routed LibraryTab onto the overlay's visible tabs.
 * Installed packs, publishing, and creator profile are account-management
 * surfaces, never aliases for Marketplace discovery.
 */
export function resolveOverlayTab(
  tab: LibraryTab | undefined | null,
  opts?: { workers?: boolean; marketplace?: boolean },
): LibraryOverlayTab {
  if (tab === "workers") return opts?.workers === false ? "skills" : "workers";
  if (tab === "installed") return "installed";
  if (tab === "submit") return "submit";
  if (tab === "profile") return "profile";
  if (tab === "marketplace") {
    return opts?.marketplace === false ? "skills" : "marketplace";
  }
  return "skills";
}

/** Inverse: overlay tab → route LibraryTab for navigation. */
export function overlayTabToLibraryTab(tab: LibraryOverlayTab): LibraryTab {
  if (tab === "workers") return "workers";
  if (tab === "installed") return "installed";
  if (tab === "marketplace") return "marketplace";
  if (tab === "submit") return "submit";
  if (tab === "profile") return "profile";
  return "skills";
}

export function libraryNavCounts(
  items: LibraryItems | null | undefined,
): LibraryNavCounts {
  return {
    skills: items?.skills?.length ?? 0,
    workers: items?.workers?.length ?? 0,
  };
}

/** Left-nav rows with live counts. */
export function buildLibraryNavRows(
  items: LibraryItems | null | undefined,
  opts?: { workers?: boolean; marketplace?: boolean },
): LibraryNavRow[] {
  const counts = libraryNavCounts(items);
  const rows: LibraryNavRow[] = [
    { id: "skills", label: "Skills", count: counts.skills },
  ];
  if (opts?.workers !== false) {
    rows.push({ id: "workers", label: "Workers", count: counts.workers });
  }
  if (opts?.marketplace !== false) {
    rows.push({ id: "installed", label: "Installed", count: null });
    rows.push({ id: "marketplace", label: "Marketplace", count: null });
    rows.push({ id: "submit", label: "Submit", count: null });
    rows.push({ id: "profile", label: "Profile", count: null });
  }
  return rows;
}

export function formatNavLabel(row: LibraryNavRow): string {
  if (row.count == null) return row.label;
  return `${row.label} ${row.count}`;
}

/** Skills as card view-models (name, slug-ish path tail, tag). */
export interface SkillCardModel {
  key: string;
  name: string;
  slug: string;
  tag: string;
  description: string;
  path: string;
}

export function skillSlug(skill: LibrarySkill): string {
  const parts = skill.path?.split(/[/\\]/).filter(Boolean) ?? [];
  let candidate = skill.name || "skill";
  if (parts.length >= 2 && /^SKILL\.md$/i.test(parts[parts.length - 1]!)) {
    // Prefer the skill directory name over the SKILL.md filename.
    candidate = parts[parts.length - 2]!;
  } else if (parts.length > 0) {
    candidate = parts[parts.length - 1]!.replace(/\.md$/i, "");
  }
  const raw = candidate.trim().toLowerCase();
  return (
    raw
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "skill"
  );
}

export function skillTag(skill: LibrarySkill): string {
  if (skill.pack?.trim()) return skill.pack.trim();
  if (skill.scope === "personal") return "personal";
  if (skill.scope === "company") return skill.company?.trim() || "company";
  return "core";
}

export function toSkillCards(skills: LibrarySkill[]): SkillCardModel[] {
  return (skills ?? []).map((skill) => ({
    key: skill.path || skill.name,
    name: skill.name,
    slug: skillSlug(skill),
    tag: skillTag(skill),
    description: skill.description ?? "",
    path: skill.path,
  }));
}

export interface WorkerCardModel {
  key: string;
  name: string;
  type: string;
  description: string;
  status: string;
  path: string;
  team: string | null;
}

export function toWorkerCards(workers: LibraryWorker[]): WorkerCardModel[] {
  return (workers ?? []).map((worker) => ({
    key: worker.path || worker.id,
    name: worker.name,
    type: worker.type,
    description: worker.description ?? "",
    status: worker.status,
    path: worker.path,
    team: worker.team ?? null,
  }));
}

/** Filter skill cards by free-text query. */
export function filterSkillCards(
  cards: SkillCardModel[],
  query: string,
): SkillCardModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return cards;
  return cards.filter((c) =>
    [c.name, c.slug, c.tag, c.description].join(" ").toLowerCase().includes(q),
  );
}

/** Filter worker cards by free-text query. */
export function filterWorkerCards(
  cards: WorkerCardModel[],
  query: string,
): WorkerCardModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return cards;
  return cards.filter((c) =>
    [c.name, c.type, c.description, c.status, c.team ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}

/**
 * Filter library items for the active overlay tab + search query.
 * Skills/workers use library helpers; empty query returns full slice.
 */
export function filterOverlayLibraryItems(
  items: LibraryItems,
  tab: LibraryOverlayTab,
  query: string,
): LibraryItem[] {
  const all = toLibraryItems(items);
  const byKind =
    tab === "skills"
      ? all.filter((i) => i.kind === "skill")
      : tab === "workers"
        ? all.filter((i) => i.kind === "worker")
        : all;
  return filterLibraryItems(byKind, query);
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
    author: listing.author,
    summary: (listing.summary ?? listing.contributes ?? "").trim(),
    badge: marketplaceBadgeForListing(listing, index),
  }));
}

/** Re-export haystack for tests that assert search composition. */
export { libraryItemHaystack, filterListings };
