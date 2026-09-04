/**
 * The channel list is a fixed 260px column. On a phone that permanently
 * reserves two thirds of the screen and leaves the conversation ~130px, which
 * is what the first mobile build rendered. Below this width the list overlays
 * the conversation instead, and the shell starts it closed.
 *
 * Mirrors the `reply-layout` module deliberately: one named breakpoint, one
 * pure function, so the CSS, the shell state and the tests all agree on a
 * single number.
 */
export const SIDEBAR_OVERLAY_MAX_PX = 640;

export function sidebarLayout(widthPx: number): "overlay" | "column" {
  return widthPx <= SIDEBAR_OVERLAY_MAX_PX ? "overlay" : "column";
}
