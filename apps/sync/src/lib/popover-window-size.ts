export const POPOVER_WIDTH = 296;
export const POPOVER_MIN_HEIGHT = 226;
export const POPOVER_MAX_HEIGHT = 480;

export function clampPopoverHeight(
  height: number,
  min = POPOVER_MIN_HEIGHT,
  max = POPOVER_MAX_HEIGHT,
): number {
  if (!Number.isFinite(height)) return min;
  return Math.max(min, Math.min(max, Math.ceil(height)));
}

export function measuredSurfaceContentHeight({
  contentScrollHeight,
  floatingBottom = 0,
}: {
  contentScrollHeight: number;
  floatingBottom?: number;
}): number {
  const content = Number.isFinite(contentScrollHeight) ? Math.ceil(contentScrollHeight) : 0;
  const floating = Number.isFinite(floatingBottom) ? Math.ceil(floatingBottom) : 0;
  return Math.max(0, content, floating);
}

export function shouldResizePopoverWindow(nextHeight: number, lastHeight: number, threshold = 2): boolean {
  return Math.abs(nextHeight - lastHeight) >= threshold;
}

/**
 * The menubar popover ('main') is the only window that resizes itself to fit
 * its content. Secondary windows (new-files-detail, messages, …) reuse the
 * Popover via the App fallback route in main.ts but are fixed / natively
 * decorated windows whose capability does NOT grant core:window:allow-set-size,
 * so calling setSize there is rejected by the Tauri ACL (Sentry HQ-DESKTOP-38).
 */
export function isPopoverResizeWindow(label: string): boolean {
  return label === 'main';
}
