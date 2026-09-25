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

/// Measured gap between `traffic_light_position.y` and where macOS draws
/// the centre of the lights. tao sizes the title-bar container to
/// `button_height + y` and leaves the AppKit button origin alone, so the
/// visual centre lands `y + offset` below the window top. Measured
/// 2026-09-22 on macOS 26 against v0.10.302 (y=24 drew the lights at ~29px
/// while the content centre was 24px). Re-measure if macOS moves the
/// default button origin; never compensate through the titlebar height.
pub const MACOS_TRAFFIC_LIGHT_CENTER_OFFSET_PX: f64 = 5.0;

/// Vertical centre of the titlebar content (flex `align-items: center`).
pub fn titlebar_content_center_px(titlebar_height: f64) -> f64 {
    titlebar_height / 2.0
}

/// Tauri 2 / wry `traffic_light_position` y inset.
///
/// The lights render `MACOS_TRAFFIC_LIGHT_CENTER_OFFSET_PX` below `y`, so
/// subtract it from the titlebar content centre to put their visual centre
/// on the wordmark / date / sub-page Back line.
pub fn traffic_light_y_px(titlebar_height: f64) -> f64 {
    titlebar_content_center_px(titlebar_height) - MACOS_TRAFFIC_LIGHT_CENTER_OFFSET_PX
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
        assert_eq!(MACOS_TRAFFIC_LIGHT_CENTER_OFFSET_PX, 5.0);
        assert_eq!(titlebar_content_center_px(TITLEBAR_HEIGHT_PX), 24.0);
        assert_eq!(traffic_light_y_px(TITLEBAR_HEIGHT_PX), 19.0);
        assert_eq!(
            traffic_light_y_px(TITLEBAR_HEIGHT_PX) + MACOS_TRAFFIC_LIGHT_CENTER_OFFSET_PX,
            titlebar_content_center_px(TITLEBAR_HEIGHT_PX)
        );
        assert_eq!(traffic_light_position(TITLEBAR_HEIGHT_PX), (20.0, 19.0));
    }

    #[test]
    fn follows_titlebar_height() {
        assert_eq!(traffic_light_y_px(56.0), 23.0);
        assert_eq!(traffic_light_y_px(40.0), 15.0);
        assert_eq!(
            traffic_light_y_px(56.0) + MACOS_TRAFFIC_LIGHT_CENTER_OFFSET_PX,
            titlebar_content_center_px(56.0)
        );
    }
}
