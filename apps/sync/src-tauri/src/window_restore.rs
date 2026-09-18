//! Desktop-window frame recovery after a display sleeps, disconnects, or
//! changes scale factor.
//!
//! macOS moves a window off a vanished display on its own, but it can land it
//! at a size far below the window's declared minimum (QA measured 133x164
//! points for the 960x600-minimum desktop window) and at a position outside
//! the surviving monitor's work area. Nothing in the app persists that size, so
//! the only durable fix is to re-derive a sane frame whenever the window is
//! shown or its monitor changes.
//!
//! The geometry lives here as pure arithmetic in logical points so it can be
//! unit-tested without a window server. `commands::desktop_alt` reads the live
//! window plus monitor and applies the result.

/// Default desktop-window size, matching `tauri.conf.json` and the builder in
/// `commands::desktop_alt`.
pub const DESKTOP_DEFAULT_WIDTH: f64 = 1400.0;
pub const DESKTOP_DEFAULT_HEIGHT: f64 = 920.0;

/// Declared minimum size for the desktop window.
pub const DESKTOP_MIN_WIDTH: f64 = 960.0;
pub const DESKTOP_MIN_HEIGHT: f64 = 600.0;

/// Sub-point differences are rounding noise, not a frame change.
const EPSILON: f64 = 0.5;

/// A window or work-area rectangle in logical points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    fn approx_eq(&self, other: &Rect) -> bool {
        (self.x - other.x).abs() < EPSILON
            && (self.y - other.y).abs() < EPSILON
            && (self.width - other.width).abs() < EPSILON
            && (self.height - other.height).abs() < EPSILON
    }
}

/// The frame the desktop window should occupy on `work_area`, or `None` when
/// `current` is already fine.
///
/// Rules, in order:
/// 1. A frame under the declared minimum in either axis is not recoverable by
///    clamping — it is reset to the default size and centred.
/// 2. A frame larger than the work area is shrunk to fit, but never below the
///    minimum (a work area smaller than the minimum wins over the minimum, so
///    the window still fits the screen).
/// 3. Whatever size survives is moved fully inside the work area.
pub fn resolve_desktop_frame(current: Rect, work_area: Rect) -> Option<Rect> {
    let collapsed = current.width < DESKTOP_MIN_WIDTH - EPSILON
        || current.height < DESKTOP_MIN_HEIGHT - EPSILON;

    let (mut width, mut height) = if collapsed {
        (DESKTOP_DEFAULT_WIDTH, DESKTOP_DEFAULT_HEIGHT)
    } else {
        (current.width, current.height)
    };

    width = fit_axis(width, work_area.width, DESKTOP_MIN_WIDTH);
    height = fit_axis(height, work_area.height, DESKTOP_MIN_HEIGHT);

    let (x, y) = if collapsed {
        (
            work_area.x + (work_area.width - width) / 2.0,
            work_area.y + (work_area.height - height) / 2.0,
        )
    } else {
        (
            clamp_origin(current.x, width, work_area.x, work_area.width),
            clamp_origin(current.y, height, work_area.y, work_area.height),
        )
    };

    let resolved = Rect::new(x, y, width, height);
    if resolved.approx_eq(&current) {
        None
    } else {
        Some(resolved)
    }
}

/// Shrink `size` to the available extent, holding the minimum unless the
/// screen itself is smaller than the minimum.
fn fit_axis(size: f64, available: f64, minimum: f64) -> f64 {
    let floor = minimum.min(available);
    size.min(available).max(floor)
}

/// Slide an origin so a `size`-wide span sits inside `[start, start + extent)`.
fn clamp_origin(origin: f64, size: f64, start: f64, extent: f64) -> f64 {
    let max_origin = start + extent - size;
    if max_origin <= start {
        return start;
    }
    origin.clamp(start, max_origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 1512x945 laptop work area, origin at the menu bar.
    fn laptop() -> Rect {
        Rect::new(0.0, 37.0, 1512.0, 945.0)
    }

    fn big_display() -> Rect {
        Rect::new(0.0, 37.0, 2560.0, 1400.0)
    }

    #[test]
    fn leaves_a_healthy_frame_alone() {
        let current = Rect::new(120.0, 100.0, 1400.0, 920.0);
        assert_eq!(resolve_desktop_frame(current, big_display()), None);
    }

    #[test]
    fn resets_the_collapsed_frame_qa_measured_to_the_default_size() {
        // F1: 133x164 at (16, 823) after the external display slept.
        let collapsed = Rect::new(16.0, 823.0, 133.0, 164.0);
        let resolved = resolve_desktop_frame(collapsed, big_display())
            .expect("a sub-minimum frame must be corrected");
        assert_eq!(resolved.width, DESKTOP_DEFAULT_WIDTH);
        assert_eq!(resolved.height, DESKTOP_DEFAULT_HEIGHT);
        assert_eq!(resolved.x, (2560.0 - 1400.0) / 2.0);
        assert_eq!(resolved.y, 37.0 + (1400.0 - 920.0) / 2.0);
    }

    #[test]
    fn a_frame_one_point_under_the_minimum_is_reset_too() {
        let current = Rect::new(0.0, 37.0, DESKTOP_MIN_WIDTH - 1.0, DESKTOP_MIN_HEIGHT);
        let resolved = resolve_desktop_frame(current, big_display()).expect("under minimum");
        assert_eq!(resolved.width, DESKTOP_DEFAULT_WIDTH);
        assert_eq!(resolved.height, DESKTOP_DEFAULT_HEIGHT);
    }

    #[test]
    fn a_frame_exactly_at_the_minimum_keeps_its_size() {
        let current = Rect::new(40.0, 60.0, DESKTOP_MIN_WIDTH, DESKTOP_MIN_HEIGHT);
        assert_eq!(resolve_desktop_frame(current, big_display()), None);
    }

    #[test]
    fn pulls_an_offscreen_window_back_onto_the_surviving_monitor() {
        // Window kept its size but sits where the second display used to be.
        let current = Rect::new(2600.0, 120.0, 1400.0, 920.0);
        let resolved = resolve_desktop_frame(current, laptop()).expect("offscreen");
        assert_eq!(resolved.width, 1400.0);
        assert_eq!(resolved.height, 920.0);
        assert_eq!(resolved.x, 1512.0 - 1400.0);
        // 920 tall on a 945-tall work area starting at 37: the bottom edge
        // pins it 62 points down, above the requested 120.
        assert_eq!(resolved.y, 37.0 + 945.0 - 920.0);
    }

    #[test]
    fn a_window_hanging_off_the_top_is_pushed_below_the_menu_bar() {
        let current = Rect::new(40.0, -300.0, 1400.0, 920.0);
        let resolved = resolve_desktop_frame(current, laptop()).expect("above work area");
        assert_eq!(resolved.y, 37.0);
        assert_eq!(resolved.x, 40.0);
    }

    #[test]
    fn shrinks_a_window_larger_than_the_new_work_area() {
        let current = Rect::new(0.0, 37.0, 2400.0, 1300.0);
        let resolved = resolve_desktop_frame(current, laptop()).expect("oversized");
        assert_eq!(resolved.width, 1512.0);
        assert_eq!(resolved.height, 945.0);
        assert_eq!(resolved.x, 0.0);
        assert_eq!(resolved.y, 37.0);
    }

    #[test]
    fn never_shrinks_below_the_minimum_on_a_roomy_display() {
        let current = Rect::new(0.0, 37.0, 3000.0, 2000.0);
        let work_area = Rect::new(0.0, 37.0, 1100.0, 700.0);
        let resolved = resolve_desktop_frame(current, work_area).expect("oversized");
        assert!(resolved.width >= DESKTOP_MIN_WIDTH);
        assert!(resolved.height >= DESKTOP_MIN_HEIGHT);
    }

    #[test]
    fn a_work_area_smaller_than_the_minimum_still_fits_the_screen() {
        let work_area = Rect::new(0.0, 0.0, 800.0, 500.0);
        let resolved = resolve_desktop_frame(Rect::new(0.0, 0.0, 100.0, 100.0), work_area)
            .expect("collapsed on a tiny screen");
        assert_eq!(resolved.width, 800.0);
        assert_eq!(resolved.height, 500.0);
    }

    #[test]
    fn sub_point_drift_is_not_a_change() {
        let current = Rect::new(120.0, 100.2, 1400.0, 920.0);
        assert_eq!(resolve_desktop_frame(current, big_display()), None);
    }
}
