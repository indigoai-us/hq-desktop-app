/**
 * Profile photo editing: load a picked or saved photo, crop it, and encode it
 * for upload. Shared by Settings › Profile and Settings › Public profile.
 *
 * The crop is kept as numbers against the original image so re-adjusting in
 * the same session never loses detail. Output is a 512×512 JPEG under the
 * member-profile byte ceiling, which also satisfies the public profile upload.
 */

import {
  AVATAR_MAX_BYTES,
  base64ByteLength,
  stripDataUrlPrefix,
  type PreparedAvatar,
} from "./avatar-image.js";

/** Output edge in px — the member profile's minimum, plenty for a UI avatar. */
export const PHOTO_EDGE = 512;
export const MAX_ZOOM = 3;

/**
 * Where the square crop sits. `zoom` ≥ 1 shrinks the square below the image's
 * shorter side. `x`/`y` move its center away from the image center, measured
 * in multiples of the shorter side so the numbers don't depend on resolution.
 */
/** An error whose message is app-written copy, safe to show to the user. */
export class PhotoError extends Error {
  override name = "PhotoError";
}

export interface PhotoCrop {
  x: number;
  y: number;
  zoom: number;
}

export const CENTER_CROP: PhotoCrop = { x: 0, y: 0, zoom: 1 };

export type PhotoSaveResult = { ok: true; url?: string | null } | { ok: false };

export interface OtherProfileCopy {
  emptyText: string;
  emptyAction: string;
  emptyDone: string;
  diffText: string;
  diffAction: string;
  diffDone: string;
}

export interface OtherProfile {
  /** The other profile's photo URL; null = no photo, undefined = no such profile. */
  current: () => Promise<string | null | undefined>;
  /** Put this photo on the other profile. */
  apply: (photo: PreparedAvatar) => Promise<boolean>;
  copy: OtherProfileCopy;
}


/** A loaded photo the editor can draw: an object or data URL plus its size. */
export interface PhotoSource {
  url: string;
  width: number;
  height: number;
}

export interface CropRect {
  sx: number;
  sy: number;
  side: number;
}

/** Keep zoom in range and the crop square inside the image. */
export function clampCrop(width: number, height: number, crop: PhotoCrop): PhotoCrop {
  const short = Math.min(width, height);
  if (!(short > 0)) return { ...CENTER_CROP };
  const zoom = Math.min(MAX_ZOOM, Math.max(1, Number.isFinite(crop.zoom) ? crop.zoom : 1));
  const side = short / zoom;
  const maxX = (width - side) / 2 / short;
  const maxY = (height - side) / 2 / short;
  const clamp = (v: number, max: number) => Math.min(max, Math.max(-max, Number.isFinite(v) ? v : 0));
  return { x: clamp(crop.x, maxX), y: clamp(crop.y, maxY), zoom };
}

/** The source-pixel square a crop selects. */
export function cropRect(width: number, height: number, crop: PhotoCrop): CropRect {
  const c = clampCrop(width, height, crop);
  const short = Math.min(width, height);
  const side = short / c.zoom;
  return {
    sx: width / 2 + c.x * short - side / 2,
    sy: height / 2 + c.y * short - side / 2,
    side,
  };
}

/**
 * CSS for showing a crop through a round window of `viewport` px: the image's
 * rendered size and its offset from the window's center.
 */
export function cropView(
  source: Pick<PhotoSource, "width" | "height">,
  crop: PhotoCrop,
  viewport: number,
): { width: number; height: number; dx: number; dy: number } {
  const rect = cropRect(source.width, source.height, crop);
  const scale = viewport / rect.side;
  const centerX = rect.sx + rect.side / 2;
  const centerY = rect.sy + rect.side / 2;
  return {
    width: source.width * scale,
    height: source.height * scale,
    dx: (source.width / 2 - centerX) * scale,
    dy: (source.height / 2 - centerY) * scale,
  };
}

/** Move a crop by a drag of (dx, dy) screen px seen through a `viewport`-px window. */
export function panCrop(
  source: Pick<PhotoSource, "width" | "height">,
  crop: PhotoCrop,
  dx: number,
  dy: number,
  viewport: number,
): PhotoCrop {
  const rect = cropRect(source.width, source.height, crop);
  const short = Math.min(source.width, source.height);
  const perPx = rect.side / viewport / short;
  return clampCrop(source.width, source.height, {
    ...crop,
    x: crop.x - dx * perPx,
    y: crop.y - dy * perPx,
  });
}

/** Mean absolute difference between two grayscale fingerprints (0–255). */
export function fingerprintDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i]! - b[i]!);
  return total / a.length;
}

/** Same picture, allowing for JPEG re-encoding and resizing. */
export function sameFingerprint(a: readonly number[], b: readonly number[]): boolean {
  return fingerprintDistance(a, b) <= 10;
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new PhotoError("That file isn't a readable image."));
    img.src = url;
  });
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new PhotoError("Couldn't read that file."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Fetch a saved photo's bytes. The photo bucket allows read-only CORS for the
 * app origins, so this works in the desktop app and HQ Work. `no-store` skips
 * any copy an <img> tag cached before the bucket sent CORS headers.
 */
async function fetchPhotoBlob(url: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" });
  } catch {
    throw new PhotoError("Couldn't load this photo. Pick it again to edit it.");
  }
  if (!res.ok) throw new PhotoError("Couldn't load this photo. Pick it again to edit it.");
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new PhotoError("That file isn't a readable image.");
  return blob;
}

/**
 * Load a picked file, a locally held photo (data: or blob: URL), or a saved
 * photo (https: URL) into a drawable source. Saved photos are fetched and
 * turned into a data: URL so drawing them never taints the canvas.
 */
export async function loadPhotoSource(input: Blob | string): Promise<PhotoSource> {
  let url: string;
  if (typeof input === "string") {
    if (/^https:/i.test(input)) url = await readBlobAsDataUrl(await fetchPhotoBlob(input));
    else if (/^(data|blob):/i.test(input)) url = input;
    else throw new PhotoError("Pick the photo again to edit it.");
  } else {
    url = await readBlobAsDataUrl(input);
  }
  const img = await loadImageElement(url);
  return { url, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
}

/** Crop a source to a 512×512 JPEG under the upload byte ceiling. */
export async function renderPhoto(source: PhotoSource, crop: PhotoCrop): Promise<PreparedAvatar> {
  if (typeof document === "undefined") {
    throw new PhotoError("Image editing is only available in the app window.");
  }
  const img = await loadImageElement(source.url);
  const rect = cropRect(source.width, source.height, crop);
  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_EDGE;
  canvas.height = PHOTO_EDGE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new PhotoError("Couldn't prepare the image.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, rect.sx, rect.sy, rect.side, rect.side, 0, 0, PHOTO_EDGE, PHOTO_EDGE);
  let previewDataUrl = "";
  let base64 = "";
  for (const quality of [0.88, 0.78, 0.65, 0.5]) {
    previewDataUrl = canvas.toDataURL("image/jpeg", quality);
    base64 = stripDataUrlPrefix(previewDataUrl);
    if (base64ByteLength(base64) <= AVATAR_MAX_BYTES) break;
  }
  if (base64ByteLength(base64) > AVATAR_MAX_BYTES) {
    throw new PhotoError("That image is too large even after compression.");
  }
  return { base64, previewDataUrl };
}

/** A 16×16 grayscale fingerprint of a photo's center square. */
export async function photoFingerprint(source: PhotoSource): Promise<number[]> {
  const img = await loadImageElement(source.url);
  const rect = cropRect(source.width, source.height, CENTER_CROP);
  const n = 16;
  const canvas = document.createElement("canvas");
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new PhotoError("Couldn't read the image.");
  ctx.drawImage(img, rect.sx, rect.sy, rect.side, rect.side, 0, 0, n, n);
  const data = ctx.getImageData(0, 0, n, n).data;
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    out.push(0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!);
  }
  return out;
}

/** Raw base64 → bytes, for adapters that upload binary. */
export function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
