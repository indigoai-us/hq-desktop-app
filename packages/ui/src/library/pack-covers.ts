/**
 * Pack cover art for the Marketplace cards.
 *
 * Each listing gets a unique, on-brand piece of cover art (the Indigo Midjourney
 * "moodboard" style shared with getindigo.ai + the email headers) so a card reads
 * as a distinct object, not a row of text.
 *
 * Precedence: a presigned `coverImageUrl` from the marketplace assets bucket
 * (the only remote host the packaged CSP allowlists) wins, then a CSP-safe
 * local/data URL, then bundled-by-slug art. Arbitrary https hosts stay blocked
 * so a listing cannot become a tracking pixel. Packs with none of the above
 * get the deterministic branded gradient placeholder.
 *
 * Kept rune-free + asset-import-only so it's trivially unit-testable.
 */

import type { MarketplaceListing } from "../marketplace/marketplace.js";
import { safeLocalImageSrc } from "../common/local-image-src.js";
// Vite resolves each import to a hashed asset URL string at build time.
import engineeringCover from "./assets/pack-covers/engineering.jpg";
import gstackCover from "./assets/pack-covers/gstack.jpg";
import pocockCover from "./assets/pack-covers/pocock-skills.jpg";
import impeccableCover from "./assets/pack-covers/impeccable.jpg";
import magicpathCover from "./assets/pack-covers/magicpath-agent-skills.jpg";

/**
 * Virtual-hosted S3 origin hq-pro mints cover presigned URLs against in
 * production (`hq-marketplace-assets-${stage}` with stage `hq-prod`). Keep in
 * lockstep with `apps/sync/src-tauri/tauri.conf.json` `img-src`.
 */
export const MARKETPLACE_COVER_HOST =
  "hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com";

/**
 * Bundled cover art, keyed by pack slug. Add an entry here (and the asset under
 * `assets/pack-covers/`) when a new pack ships with first-party art; everything
 * else falls back to the branded gradient placeholder when the listing has no
 * hosted `coverImageUrl`.
 */
export const BUNDLED_PACK_COVERS: Readonly<Record<string, string>> = {
  engineering: engineeringCover,
  gstack: gstackCover,
  "pocock-skills": pocockCover,
  impeccable: impeccableCover,
  "magicpath-agent-skills": magicpathCover,
};

/**
 * Accept a hq-pro-minted marketplace cover URL, or `null` when the value is not
 * a https URL on the allowlisted assets host. Tracking-pixel hosts, http, and
 * credentialed URLs are rejected so a listing cannot load arbitrary images.
 */
export function marketplaceCoverSrc(
  raw: string | null | undefined,
): string | null {
  const src = raw?.trim() ?? "";
  if (src === "" || /[\u0000-\u001f\u007f]/.test(src)) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hostname !== MARKETPLACE_COVER_HOST) return null;
  if (!url.pathname.startsWith("/listings/")) return null;
  return src;
}

/**
 * Resolve the cover-art URL for a listing, or `null` when none is available.
 *
 * Precedence: an allowlisted marketplace `coverImageUrl` (presigned S3 GET),
 * then a CSP-compatible local/data URL, then bundled-by-slug art. Arbitrary
 * http(s) URLs are ignored and fall through to bundled or generated art.
 */
export function coverForListing(listing: MarketplaceListing): string | null {
  const hosted = marketplaceCoverSrc(listing.coverImageUrl);
  if (hosted) return hosted;
  const local = safeLocalImageSrc(listing.coverImageUrl);
  if (local) return local;
  return BUNDLED_PACK_COVERS[listing.slug] ?? null;
}

/**
 * Pick one of six restrained palettes for a generated fallback cover.
 *
 * Hosted and bundled artwork always keeps its original colors. Listings without
 * artwork use this stable slug-derived palette so their fallback identity does
 * not jump when search results reorder.
 */
export function coverTone(listing: MarketplaceListing): number {
  return hashString(listing.slug || listing.name || listing.id || "") % 6;
}

/**
 * A deterministic, branded fallback for a listing with no cover art: neutral
 * theme-token proportions derived from the slug plus the pack's leading initial.
 * Pure + DOM-free so it is unit-testable.
 */
export interface CoverFallback {
  /** A CSS `linear-gradient(...)` background derived from the slug. */
  gradient: string;
  /** A short monogram (uppercased first letter of the name/slug). */
  monogram: string;
}

/** FNV-1a-ish string hash → stable non-negative integer (for shade selection). */
function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Build the deterministic gradient + monogram placeholder for a listing. */
export function coverFallback(listing: MarketplaceListing): CoverFallback {
  const key = listing.slug || listing.name || "";
  const hash = hashString(key);
  const lightMix = 14 + (hash % 9);
  const darkMix = 4 + ((hash >>> 4) % 8);
  const gradient = `linear-gradient(135deg, color-mix(in srgb, var(--v4-text-2) ${lightMix}%, var(--v4-ground)), color-mix(in srgb, var(--v4-text-2) ${darkMix}%, var(--v4-ground)))`;
  const source = (listing.name || listing.slug || "?").trim();
  const monogram = (source.charAt(0) || "?").toUpperCase();
  return { gradient, monogram };
}
