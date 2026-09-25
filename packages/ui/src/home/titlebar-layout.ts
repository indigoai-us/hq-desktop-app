/**
 * Shared titlebar chrome metrics.
 *
 * The overlay traffic lights and the titlebar CSS both read these so the
 * native close/minimise/zoom buttons sit on the same vertical centre line
 * as the sidebar toggle, HQ wordmark, and DAY · DATE. Full-window sub-page
 * headers (Library, Settings, …) consume the same CSS variables so their
 * Back control clears the lights instead of sitting under them.
 *
 * Keep the Rust copy in `apps/sync/src-tauri/src/titlebar_layout.rs` and the
 * desktop-alt window `trafficLightPosition` in lockstep — pinned by the
 * source-contract test in
 * `apps/sync/e2e/desktop-alt/titlebar-traffic-lights.spec.ts`.
 */

/** Compact overlay titlebar height (`V4TitleBar` `.v4-titlebar`). */
export const TITLEBAR_HEIGHT_PX = 48;

/**
 * Leading gutter that clears the native traffic-light cluster on macOS.
 * Windows overrides this to 12px (native caption buttons live in the OS
 * title bar above the HQ toolbar).
 */
export const TITLEBAR_TRAFFIC_LIGHT_GUTTER_PX = 78;

/** Leading inset of the close button. Matches the other overlay windows. */
export const TITLEBAR_TRAFFIC_LIGHT_X_PX = 20;

/**
 * AppKit `NSWindowButton` frame height in logical pixels. wry/tao size the
 * overlay title-bar container as `buttonHeight + y`.
 */
export const MACOS_TRAFFIC_LIGHT_BUTTON_HEIGHT_PX = 14;

/**
 * Windows caption buttons live in the native decorated title bar, so HQ
 * chrome only needs a tight leading gutter (existing V4TitleBar value).
 */
export const TITLEBAR_WINDOWS_LEADING_INSET_PX = 12;

/**
 * Leading padding when the host does not overlay window controls (web).
 * Matches `.v4-titlebar-leading.no-window-controls`.
 */
export const TITLEBAR_NO_WINDOW_CONTROLS_LEADING_INSET_PX = 16;

/** CSS custom property for overlay titlebar / sub-page header height. */
export const TITLEBAR_HEIGHT_CSS_VAR = "--titlebar-height";

/**
 * CSS custom property for the leading gutter that clears window controls.
 * Sub-page headers and the titlebar both consume this; Windows / web
 * override the same variable rather than inventing a second inset.
 */
export const TITLEBAR_LEADING_INSET_CSS_VAR = "--titlebar-leading-inset";

/**
 * Measured gap between `trafficLightPosition.y` and where macOS actually
 * draws the centre of the lights. tao sizes the overlay title-bar container
 * to `buttonHeight + y` and leaves each button's AppKit origin alone, so the
 * visual centre lands `y + offset` below the window top, not at `y`.
 * Measured 2026-09-22 on macOS 26 against v0.10.302: y=24 drew the lights at
 * ~29px while the wordmark and sub-page Back pill sat at 24px. If a macOS
 * release moves the default button origin, re-measure this constant; do not
 * compensate through the titlebar height or the CSS.
 */
export const MACOS_TRAFFIC_LIGHT_CENTER_OFFSET_PX = 5;

/** Vertical centre of the titlebar content (flex `align-items: center`). */
export function titlebarContentCenterPx(
  titleBarHeightPx: number = TITLEBAR_HEIGHT_PX,
): number {
  return titleBarHeightPx / 2;
}

/**
 * Tauri 2 / wry `trafficLightPosition.y`.
 *
 * The lights render `MACOS_TRAFFIC_LIGHT_CENTER_OFFSET_PX` below `y`, so
 * subtract that from the titlebar content centre to put their visual centre
 * on the same line as the wordmark, date, and sub-page Back control. If the
 * titlebar height changes, this value follows it.
 */
export function trafficLightYPx(
  titleBarHeightPx: number = TITLEBAR_HEIGHT_PX,
): number {
  return (
    titlebarContentCenterPx(titleBarHeightPx) -
    MACOS_TRAFFIC_LIGHT_CENTER_OFFSET_PX
  );
}

export function trafficLightPosition(
  titleBarHeightPx: number = TITLEBAR_HEIGHT_PX,
): { x: number; y: number } {
  return {
    x: TITLEBAR_TRAFFIC_LIGHT_X_PX,
    y: trafficLightYPx(titleBarHeightPx),
  };
}
