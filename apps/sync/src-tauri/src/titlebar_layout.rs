//! Shared overlay-titlebar metrics for the desktop window.
//!
//! Keep these numbers in lockstep with
//! `packages/ui/src/home/titlebar-layout.ts`. The JS source-contract
//! `apps/sync/e2e/desktop-alt/titlebar-traffic-lights.spec.ts` pins both
//! copies plus `tauri.conf.json`.

/// Compact overlay titlebar height (`V4TitleBar` `.v4-titlebar`).
pub const TITLEBAR_HEIGHT_PX: f64 = 48.0;

/// Leading gutter that clears the native traffic-light cluster on macOS.
pub const TITLEBAR_TRAFFIC_LIGHT_GUTTER_PX: f64 = 78.0;

/// Leading inset of the close button. Matches the other overlay windows.
pub const TITLEBAR_TRAFFIC_LIGHT_X_PX: f64 = 20.0;

/// AppKit `NSWindowButton` frame height in logical pixels.
pub const MACOS_TRAFFIC_LIGHT_BUTTON_HEIGHT_PX: f64 = 14.0;

/// AppKit `NSWindowButton` frame `origin.y` inside the title-bar container,
/// measured from the container's BOTTOM edge. tao resizes the container but
/// never touches this origin, so it is what turns the `y` inset into a
/// visual centre. Measured on macOS with the desktop-alt style mask.
pub const MACOS_TRAFFIC_LIGHT_ORIGIN_Y_PX: f64 = 9.0;

/// Vertical centre of the titlebar content (flex `align-items: center`).
pub fn titlebar_content_center_px(titlebar_height: f64) -> f64 {
    titlebar_height / 2.0
}

/// Tauri 2 / wry `traffic_light_position` y inset.
///
/// tao sizes the overlay title-bar container to `buttonHeight + y`, pins it
/// to the window top, and leaves each button's AppKit `origin.y` alone, so
/// the button lands at
/// `(buttonHeight + y) - originY - buttonHeight / 2`. With `originY` at 9
/// against a 14pt button that is 2px ABOVE the raw `y`. Add it back so `y`
/// is the true visual centre and the lights share the wordmark / date
/// centre line.
pub fn traffic_light_y_px(titlebar_height: f64) -> f64 {
    titlebar_content_center_px(titlebar_height) + MACOS_TRAFFIC_LIGHT_ORIGIN_Y_PX
        - MACOS_TRAFFIC_LIGHT_BUTTON_HEIGHT_PX / 2.0
}

pub fn traffic_light_position(titlebar_height: f64) -> (f64, f64) {
    (
        TITLEBAR_TRAFFIC_LIGHT_X_PX,
        traffic_light_y_px(titlebar_height),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centres_traffic_lights_on_the_titlebar_midline() {
        assert_eq!(TITLEBAR_HEIGHT_PX, 48.0);
        assert_eq!(TITLEBAR_TRAFFIC_LIGHT_GUTTER_PX, 78.0);
        assert_eq!(MACOS_TRAFFIC_LIGHT_BUTTON_HEIGHT_PX, 14.0);
        assert_eq!(MACOS_TRAFFIC_LIGHT_ORIGIN_Y_PX, 9.0);
        assert_eq!(titlebar_content_center_px(TITLEBAR_HEIGHT_PX), 24.0);
        // +2 compensates tao leaving the button origin at 9 in a 14pt button.
        assert_eq!(traffic_light_y_px(TITLEBAR_HEIGHT_PX), 26.0);
        assert_eq!(
            traffic_light_y_px(TITLEBAR_HEIGHT_PX) - 2.0,
            titlebar_content_center_px(TITLEBAR_HEIGHT_PX)
        );
        assert_eq!(traffic_light_position(TITLEBAR_HEIGHT_PX), (20.0, 26.0));
    }

    #[test]
    fn follows_titlebar_height() {
        assert_eq!(traffic_light_y_px(56.0), 30.0);
        assert_eq!(traffic_light_y_px(40.0), 22.0);
        assert_eq!(
            traffic_light_y_px(56.0) - 2.0,
            titlebar_content_center_px(56.0)
        );
    }
}
