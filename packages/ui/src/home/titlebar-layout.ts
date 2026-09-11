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
 * AppKit `NSWindowButton` frame `origin.y` inside the title-bar container,
 * measured from the container's BOTTOM edge (AppKit is bottom-left origin).
 * tao resizes the container but never touches this origin, so it is the
 * offset that turns the `y` inset into a visual centre. Measured on macOS
 * with the desktop-alt style mask (`.titled | .closable | .miniaturizable |
 * .resizable | .fullSizeContentView`, transparent titlebar, hidden title).
 */
export const MACOS_TRAFFIC_LIGHT_ORIGIN_Y_PX = 9;

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

/** Vertical centre of the titlebar content (flex `align-items: center`). */
export function titlebarContentCenterPx(
  titleBarHeightPx: number = TITLEBAR_HEIGHT_PX,
): number {
  return titleBarHeightPx / 2;
}

/**
 * Tauri 2 / wry `trafficLightPosition.y`.
 *
 * tao sizes the overlay title-bar container to `buttonHeight + y`, pins it
 * to the window top, and leaves each button's AppKit `origin.y` alone. The
 * button therefore ends up at
 *
 *   centreFromWindowTop = (buttonHeight + y) - originY - buttonHeight / 2
 *                       = y - (originY - buttonHeight / 2)
 *
 * and `originY` is 9 against a 14pt button, so a raw `y` lands the lights
 * 2px ABOVE where it reads. Add that back so `y` really is the visual
 * centre and the lights share the wordmark / date centre line. If the
 * titlebar height changes, this follows it.
 */
export function trafficLightYPx(
  titleBarHeightPx: number = TITLEBAR_HEIGHT_PX,
): number {
  return (
    titlebarContentCenterPx(titleBarHeightPx) +
    MACOS_TRAFFIC_LIGHT_ORIGIN_Y_PX -
    MACOS_TRAFFIC_LIGHT_BUTTON_HEIGHT_PX / 2
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
