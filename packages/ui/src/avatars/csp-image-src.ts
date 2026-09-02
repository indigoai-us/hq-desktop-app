/**
 * Packaged-app image sources. The Tauri CSP allowlists one remote origin
 * (`MARKETPLACE_COVER_HOST`) plus local/blob/data. Keep this module free of
 * asset imports so chat/messaging can reuse it without pulling marketplace
 * cover JPEGs into the message bundle.
 */

import { cspSafeAvatarSrc } from "./parse-pack.js";

/**
 * Virtual-hosted S3 origin hq-pro mints cover + member-avatar presigned URLs
 * against in production (`hq-marketplace-assets-${stage}` with stage
 * `hq-prod`). Keep in lockstep with `apps/sync/src-tauri/tauri.conf.json`
 * `img-src`.
 */
export const MARKETPLACE_COVER_HOST =
  "hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com";

function marketplaceHttpsSrc(
  raw: string | null | undefined,
  pathOk: (pathname: string) => boolean,
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
  if (!pathOk(url.pathname)) return null;
  return src;
}

/**
 * Accept a hq-pro-minted marketplace cover URL, or `null` when the value is not
 * a https URL on the allowlisted assets host. Tracking-pixel hosts, http, and
 * credentialed URLs are rejected so a listing cannot load arbitrary images.
 */
export function marketplaceCoverSrc(
  raw: string | null | undefined,
): string | null {
  return marketplaceHttpsSrc(raw, (pathname) =>
    pathname.startsWith("/listings/"),
  );
}

/**
 * Accept a hq-pro-minted person/creator avatar URL on the same marketplace
 * assets host. Paths are `/members/…` (HQ profile photos) or `/creators/…`
 * (creator-directory avatars). Arbitrary hosts stay blocked.
 */
export function marketplaceAvatarSrc(
  raw: string | null | undefined,
): string | null {
  return marketplaceHttpsSrc(
    raw,
    (pathname) =>
      pathname.startsWith("/members/") || pathname.startsWith("/creators/"),
  );
}

/**
 * `<img src>` that the packaged CSP will actually paint: bundled/local
 * assets, raster data URLs, blob object URLs, or an hq-pro profile photo on
 * the one allowlisted marketplace assets host. Arbitrary http(s) stays out
 * so a message/roster URL cannot become a tracking pixel — widen img-src
 * and the avatar-pack / tauri-conf CSP pins fail on purpose.
 */
export function paintableAvatarSrc(
  raw: string | null | undefined,
): string | null {
  return cspSafeAvatarSrc(raw) ?? marketplaceAvatarSrc(raw);
}
