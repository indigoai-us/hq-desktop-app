/**
 * Remote avatar-pack gallery. Pack list + item thumbs come from hq-pro
 * (`GET /v1/avatar-packs` + `GET /v1/avatar-packs/{id}`). Generated marks stay
 * client-side.
 */

import type {
  AvatarPackDetailPayload,
  AvatarPackListPayload,
  IdentityApi,
} from "@hq/platform";
import { generatedMarksPack } from "./generated-marks.js";
import { GALLERY_CACHE_STORAGE_KEY, type AvatarPack } from "./types.js";

export interface GalleryApi {
  listAvatarPacks: IdentityApi["listAvatarPacks"];
  getAvatarPack: IdentityApi["getAvatarPack"];
}

export interface LoadedGallery {
  packs: AvatarPack[];
  expiresAt: number;
  source: "network" | "cache";
}

interface GalleryCache {
  list: AvatarPackListPayload;
  details: Record<string, AvatarPackDetailPayload>;
  expiresAt: number;
}

let memoryCache: GalleryCache | null = null;

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readStoredCache(
  storage: Pick<Storage, "getItem"> | null,
): GalleryCache | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(GALLERY_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GalleryCache;
    if (!parsed || typeof parsed.expiresAt !== "number") return null;
    if (!parsed.list || !parsed.details) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredCache(
  cache: GalleryCache,
  storage: Pick<Storage, "setItem"> | null,
): void {
  try {
    storage?.setItem(GALLERY_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* private mode */
  }
}

export function packFromDetail(detail: AvatarPackDetailPayload): AvatarPack {
  return {
    id: detail.id,
    name: detail.name,
    version: detail.version,
    author: detail.author.displayName,
    baseUrl: "",
    expiresAt: detail.expiresAt,
    items: detail.items.map((item) => ({
      id: item.id,
      name: item.name,
      tags: item.tags ?? [],
      src: item.thumbUrl,
      fullUrl: item.fullUrl,
    })),
  };
}

function cacheStillValid(cache: GalleryCache, now: number): boolean {
  return cache.expiresAt > now;
}

export function clearAvatarGalleryCache(
  storage: { removeItem?: (key: string) => void } | null = defaultStorage(),
): void {
  memoryCache = null;
  try {
    storage?.removeItem?.(GALLERY_CACHE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export async function loadAvatarGallery(
  api: GalleryApi,
  opts: {
    storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
    now?: number;
    generated?: AvatarPack;
  } = {},
): Promise<LoadedGallery> {
  const now = opts.now ?? Date.now();
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const generated = opts.generated ?? generatedMarksPack();

  const cached = memoryCache ?? readStoredCache(storage);
  if (cached && cacheStillValid(cached, now)) {
    memoryCache = cached;
    return {
      packs: [
        generated,
        ...cached.list.packs
          .map((row) => cached.details[row.id])
          .filter((row): row is AvatarPackDetailPayload => Boolean(row))
          .map(packFromDetail),
      ],
      expiresAt: cached.expiresAt,
      source: "cache",
    };
  }

  const listRes = await api.listAvatarPacks();
  if (!listRes.ok) {
    throw new Error(listRes.message?.trim() || "Could not load avatar packs.");
  }
  const list = listRes.value;
  const details: Record<string, AvatarPackDetailPayload> = {};
  const fetched = await Promise.all(
    list.packs.map(async (row) => {
      const detail = await api.getAvatarPack(row.id);
      if (!detail.ok) return null;
      details[row.id] = detail.value;
      return detail.value;
    }),
  );
  const remote = fetched.filter((row): row is AvatarPackDetailPayload => row !== null);
  const expiresAt = Math.min(
    list.expiresAt,
    ...remote.map((row) => row.expiresAt),
  );
  const next: GalleryCache = { list, details, expiresAt };
  memoryCache = next;
  writeStoredCache(next, storage);
  return {
    packs: [generated, ...remote.map(packFromDetail)],
    expiresAt,
    source: "network",
  };
}
