import type { AvatarPack, AvatarPackItem } from "./types.js";

export type ParsePackResult =
  | { ok: true; pack: AvatarPack }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim();
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

function isAllowedSrc(src: string): boolean {
  if (/^https?:\/\//i.test(src)) return true;
  if (src.startsWith("builtin:")) return true;
  if (src.includes("://") || src.startsWith("//")) return false;
  // Reject any other URI scheme (javascript:, data:, file:, …).
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) return false;
  return true;
}

function parseItem(
  value: unknown,
  index: number,
): { item: AvatarPackItem } | { error: string } {
  if (!isRecord(value)) {
    return { error: `items[${index}] must be an object` };
  }
  const id = nonEmptyString(value.id);
  const name = nonEmptyString(value.name);
  const src = nonEmptyString(value.src);
  if (!id) return { error: `items[${index}].id is required` };
  if (!name) return { error: `items[${index}].name is required` };
  if (!src) return { error: `items[${index}].src is required` };
  if (!isAllowedSrc(src)) {
    return { error: `items[${index}].src must be a relative path or http(s) URL` };
  }
  return { item: { id, name, src, tags: parseTags(value.tags) } };
}

/** Validate a pack.json body. Unknown fields are ignored. */
export function parseAvatarPack(raw: unknown): ParsePackResult {
  if (!isRecord(raw)) return { ok: false, error: "pack must be an object" };
  const id = nonEmptyString(raw.id);
  const name = nonEmptyString(raw.name);
  const version = nonEmptyString(raw.version);
  const author = nonEmptyString(raw.author);
  const baseUrl = nonEmptyString(raw.baseUrl);
  if (!id) return { ok: false, error: "id is required" };
  if (!name) return { ok: false, error: "name is required" };
  if (!version) return { ok: false, error: "version is required" };
  if (!author) return { ok: false, error: "author is required" };
  if (!baseUrl) return { ok: false, error: "baseUrl is required" };
  if (!Array.isArray(raw.items)) {
    return { ok: false, error: "items must be an array" };
  }
  const items: AvatarPackItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.items.length; i++) {
    const parsed = parseItem(raw.items[i], i);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    if (seen.has(parsed.item.id)) {
      return { ok: false, error: `duplicate item id "${parsed.item.id}"` };
    }
    seen.add(parsed.item.id);
    items.push(parsed.item);
  }
  return {
    ok: true,
    pack: { id, name, version, author, baseUrl, items },
  };
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** True when `src` is already a complete URL/path and must not be joined. */
export function isResolvedPackItemSrc(src: string): boolean {
  const value = src.trim();
  if (!value) return false;
  if (/^https?:\/\//i.test(value)) return true;
  if (/^(blob|data|builtin):/i.test(value)) return true;
  // Vite hashed/dev asset URLs: `/assets/foo.png`, `/src/...`.
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  return false;
}

/**
 * Pack-tile `src` that the packaged CSP will actually paint.
 * Allows bundled same-origin assets, raster data URLs, and blob: object URLs.
 * Rejects http(s) (tracking-pixel contract) and any other scheme.
 */
export function cspSafeAvatarSrc(src: string | null | undefined): string | null {
  const value = src?.trim() ?? "";
  if (!value) return null;
  if (value.startsWith("blob:")) return value;
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(value)) {
    return value;
  }
  if (/^(?:\/\/|\\\\|#)/.test(value) || /^[a-z][a-zA-Z0-9+.-]*:/i.test(value)) {
    return null;
  }
  return value;
}

/** Resolve an item `src` against the pack base URL. */
export function resolvePackItemSrc(pack: AvatarPack, item: AvatarPackItem): string {
  const src = item.src.trim();
  if (isResolvedPackItemSrc(src)) return src;
  const base = trimSlash(pack.baseUrl);
  const path = src.replace(/^\/+/, "");
  if (!base) return path;
  // builtin: packs already carry Vite URLs on each item. Joining them
  // produces `builtin:generated-marks/assets/...` which no <img> can load.
  if (base.startsWith("builtin:")) return src;
  return `${base}/${path}`;
}

export function packJsonUrl(baseUrl: string): string {
  return `${trimSlash(baseUrl)}/pack.json`;
}
