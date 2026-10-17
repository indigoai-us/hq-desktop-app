/**
 * Waiting for the welcome window to take the screen.
 *
 * `set_welcome_window(true)` queues the resize on the native main thread and
 * returns before the window has its new size. The welcome flow's scenes read
 * the window size when they are built, so the renderer waits for the webview
 * to report the new size before it mounts them. Built at the heads-up card's
 * 440x380, the intro's particles started in the top-left corner of the screen
 * (owner run 2026-10-16).
 */

/** How long to wait for the resize before showing the flow anyway. */
export const WELCOME_RESIZE_TIMEOUT_MS = 1000;

/** Slack for rounding between the native work area and the webview's size. */
const FILL_TOLERANCE_PX = 2;

export interface ViewportSize {
  width: number;
  height: number;
}

export function viewportSize(): ViewportSize {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** The window already covers the screen's work area. */
export function fillsWorkArea(): boolean {
  const screen = window.screen;
  if (!screen || !(screen.availWidth > 0) || !(screen.availHeight > 0)) return false;
  return (
    window.innerWidth >= screen.availWidth - FILL_TOLERANCE_PX &&
    window.innerHeight >= screen.availHeight - FILL_TOLERANCE_PX
  );
}

/**
 * Resolves once the window has a size other than `before`, or already covers
 * the work area. Resolves `'timeout'` after `timeoutMs` when neither happens,
 * so a resize that never lands still shows the flow.
 */
export function waitForWelcomeSize(
  before: ViewportSize,
  timeoutMs = WELCOME_RESIZE_TIMEOUT_MS,
): Promise<'ready' | 'timeout'> {
  const resized = () =>
    fillsWorkArea() || window.innerWidth !== before.width || window.innerHeight !== before.height;
  if (resized()) return Promise.resolve('ready');
  return new Promise((resolve) => {
    const finish = (result: 'ready' | 'timeout') => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', onResize);
      resolve(result);
    };
    const onResize = () => {
      if (resized()) finish('ready');
    };
    const timer = window.setTimeout(() => finish('timeout'), timeoutMs);
    window.addEventListener('resize', onResize);
  });
}
