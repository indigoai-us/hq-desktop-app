/**
 * Avatar image preparation for PUT /v1/profile.
 *
 * The server (policy indigo-slack-app-icon-min-512-jpeg-ok) requires the
 * uploaded avatar to be raw base64 (no `data:` prefix), decode to ≤192KB, and
 * be at least 512×512px. We normalise any picked image to a 512×512 JPEG via a
 * center-crop on a canvas, which guarantees the dimension floor and keeps the
 * encoded size well under the byte ceiling — then hand back both the raw base64
 * to send and a data-URL for an inline preview.
 */

/** Target square edge in px — the server's minimum, which is plenty for a UI avatar. */
export const AVATAR_EDGE = 512;

/** Server ceiling on the decoded avatar. */
export const AVATAR_MAX_BYTES = 192 * 1024;

export interface PreparedAvatar {
  /** Raw base64 (no `data:` prefix) — the PUT /v1/profile `avatarBase64` field. */
  base64: string;
  /** Full data URL for an inline <img> preview. */
  previewDataUrl: string;
}

/** Split a `data:*;base64,XXXX` URL into its raw base64 tail. */
export function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/** Approximate decoded byte length of a base64 string (ignoring padding math slack). */
export function base64ByteLength(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file isn't a readable image."));
    img.src = dataUrl;
  });
}

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

/**
 * Read a picked file, center-crop-cover to AVATAR_EDGE², and JPEG-encode under
 * the server byte ceiling (stepping quality down if a photo runs large).
 */
export async function avatarBase64FromFile(
  file: Blob,
): Promise<PreparedAvatar> {
  if (typeof document === "undefined") {
    throw new Error("Image editing is only available in the app window.");
  }
  const sourceUrl = await readFileAsDataUrl(file);
  const img = await loadImage(sourceUrl);

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_EDGE;
  canvas.height = AVATAR_EDGE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't prepare the image.");

  // Center-crop cover: scale the shorter edge to fill the square.
  const scale = Math.max(AVATAR_EDGE / img.width, AVATAR_EDGE / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  ctx.drawImage(
    img,
    (AVATAR_EDGE - drawW) / 2,
    (AVATAR_EDGE - drawH) / 2,
    drawW,
    drawH,
  );

  let previewDataUrl = "";
  let base64 = "";
  for (const quality of [0.85, 0.75, 0.6, 0.45]) {
    previewDataUrl = canvas.toDataURL("image/jpeg", quality);
    base64 = stripDataUrlPrefix(previewDataUrl);
    if (base64ByteLength(base64) <= AVATAR_MAX_BYTES) break;
  }
  if (base64ByteLength(base64) > AVATAR_MAX_BYTES) {
    throw new Error("That image is too large even after compression.");
  }
  return { base64, previewDataUrl };
}
