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

/// Vertical centre of the titlebar content (flex `align-items: center`).
pub fn titlebar_content_center_px(titlebar_height: f64) -> f64 {
    titlebar_height / 2.0
}

/// Tauri 2 / wry `traffic_light_position` y inset.
///
/// wry sizes the overlay title-bar container to `buttonHeight + y` and
/// leaves each button's AppKit `origin.y` alone. With Overlay + hidden
/// title, that leftover origin is half the button, so `y` is the visual
/// centre of the lights. Setting it to the titlebar content centre
/// middle-aligns them with the wordmark and date.
pub fn traffic_light_y_px(titlebar_height: f64) -> f64 {
    titlebar_content_center_px(titlebar_height)
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
        assert_eq!(titlebar_content_center_px(TITLEBAR_HEIGHT_PX), 24.0);
        assert_eq!(traffic_light_y_px(TITLEBAR_HEIGHT_PX), 24.0);
        assert_eq!(
            traffic_light_y_px(TITLEBAR_HEIGHT_PX),
            titlebar_content_center_px(TITLEBAR_HEIGHT_PX)
        );
        assert_eq!(traffic_light_position(TITLEBAR_HEIGHT_PX), (20.0, 24.0));
    }

    #[test]
    fn follows_titlebar_height() {
        assert_eq!(traffic_light_y_px(56.0), 28.0);
        assert_eq!(traffic_light_y_px(40.0), 20.0);
        assert_eq!(traffic_light_y_px(56.0), titlebar_content_center_px(56.0));
    }
}
