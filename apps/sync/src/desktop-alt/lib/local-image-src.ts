/**
 * Keep image sources compatible with the packaged app's strict `img-src`
 * policy. Server-provided http(s) URLs are deliberately excluded: callers
 * should show a useful fallback until an authorized native fetcher has turned
 * the image into a size-capped raster data URL.
 */
export function safeLocalImageSrc(raw: string | null | undefined): string | null {
  const src = raw?.trim() ?? '';
  if (src === '' || /[\u0000-\u001f\u007f]/.test(src)) return null;

  // Native image previews/proxies emit raster-only base64 data. SVG remains
  // excluded because it is active XML, not a passive bitmap.
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(src)) return src;

  // Keep ordinary Vite/app-origin assets. Reject protocol-relative URLs and
  // every explicit scheme (http(s), file, asset, blob, and anything future).
  if (/^(?:\/\/|\\\\|#)/.test(src) || /^[a-z][a-z0-9+.-]*:/i.test(src)) {
    return null;
  }
  return src;
}
