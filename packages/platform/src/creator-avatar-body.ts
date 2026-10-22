/**
 * Request body for POST /v1/creators/me/avatar, shared by the desktop and web
 * adapters so both send what the server (and the native upload command) expect:
 * `{ contentType, data }` with the image bytes base64-encoded.
 */

export const MAX_CREATOR_AVATAR_BYTES = 2 * 1024 * 1024;

/** Image type from magic bytes, limited to what the avatar route accepts. */
export function imageContentType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export type CreatorAvatarBody =
  | { ok: true; body: { contentType: string; data: string } }
  | { ok: false; message: string };

export function creatorAvatarBody(data: Uint8Array): CreatorAvatarBody {
  const contentType = imageContentType(data);
  if (!contentType) return { ok: false, message: "Avatar must be a PNG, JPEG, WebP, or GIF image." };
  if (data.byteLength > MAX_CREATOR_AVATAR_BYTES) return { ok: false, message: "Avatar must be 2 MiB or smaller." };
  return { ok: true, body: { contentType, data: bytesToBase64(data) } };
}
