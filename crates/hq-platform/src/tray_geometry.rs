//! Pure popover positioning geometry for the system tray UI.
//!
//! This module is intentionally tauri-free. All inputs and outputs are plain
//! numeric coordinates in physical pixels unless otherwise noted.

/// A monitor's geometry reduced to the fields the macOS popover positioner
/// needs.
///
/// All values are physical pixels in tao's global coordinate space (primary
/// monitor's top-left at the origin), except `scale` (points to px).
#[derive(Clone, Copy, Debug)]
pub struct MonitorBox {
    /// Work-area left edge (physical px), usable region.
    pub work_x: f64,
    /// Work-area top edge (physical px), usually just below the menu bar.
    pub work_y: f64,
    /// Work-area width (physical px).
    pub work_w: f64,
    /// Backing scale factor (Retina = 2.0). Converts Cocoa points to px.
    pub scale: f64,
}

/// Center `win_w`-wide window horizontally under the tray icon, `gap_px`
/// below it. All inputs are physical pixels.
#[cfg(not(target_os = "windows"))]
pub fn compute_popover_position(
    tray_x: f64,
    tray_y: f64,
    tray_w: f64,
    tray_h: f64,
    win_w: f64,
    gap_px: f64,
) -> (i32, i32) {
    let pop_x = (tray_x + tray_w / 2.0 - win_w / 2.0).round() as i32;
    let pop_y = (tray_y + tray_h + gap_px).round() as i32;
    (pop_x, pop_y)
}

#[cfg(target_os = "windows")]
pub fn compute_popover_position(
    tray_x: f64,
    tray_y: f64,
    tray_w: f64,
    _tray_h: f64,
    win_w: f64,
    win_h: f64,
    gap_px: f64,
) -> (i32, i32) {
    let pop_x = (tray_x + tray_w - win_w).round() as i32;
    let pop_y = (tray_y - win_h - gap_px).round() as i32;
    (pop_x, pop_y)
}

#[cfg(not(target_os = "windows"))]
pub fn compute_clamped_popover_position(
    tray_x: f64,
    tray_y: f64,
    tray_w: f64,
    tray_h: f64,
    win_w: f64,
    win_h: f64,
    gap_px: f64,
    work_x: f64,
    work_y: f64,
    work_w: f64,
    work_h: f64,
) -> (i32, i32) {
    let (raw_x, raw_y) = compute_popover_position(tray_x, tray_y, tray_w, tray_h, win_w, gap_px);
    let min_x = work_x;
    let max_x = (work_x + work_w - win_w).max(min_x);
    let min_y = work_y;
    let max_y = (work_y + work_h - win_h).max(min_y);
    let pop_x = (raw_x as f64).clamp(min_x, max_x).round() as i32;
    let pop_y = (raw_y as f64).clamp(min_y, max_y).round() as i32;
    (pop_x, pop_y)
}

/// Place the popover under the menu-bar icon, on the monitor it was clicked on.
///
/// `anchor_x_points` is the icon's on-screen horizontal center in Cocoa screen
/// points, which span all displays. Returns `None` when no monitor contains the
/// anchor.
pub fn position_popover_under_anchor(
    monitors: &[MonitorBox],
    anchor_x_points: f64,
    win_w: f64,
    gap_px: f64,
) -> Option<(i32, i32)> {
    for m in monitors {
        if m.scale <= 0.0 {
            continue;
        }
        let span_left_pts = m.work_x / m.scale;
        let span_right_pts = (m.work_x + m.work_w) / m.scale;
        if anchor_x_points >= span_left_pts && anchor_x_points <= span_right_pts {
            let center_px = anchor_x_points * m.scale;
            let min_x = m.work_x;
            let max_x = (m.work_x + m.work_w - win_w).max(min_x);
            let pop_x = (center_px - win_w / 2.0).clamp(min_x, max_x).round() as i32;
            let pop_y = (m.work_y + gap_px).round() as i32;
            return Some((pop_x, pop_y));
        }
    }
    None
}

pub fn compute_popover_position_from_work_area(
    work: (i32, i32, i32, i32),
    win_w: i32,
    win_h: i32,
    gap_px: i32,
    right_inset_px: i32,
) -> (i32, i32) {
    let (work_l, work_t, work_r, work_b) = work;
    let pop_x = (work_r - win_w - right_inset_px).max(work_l);
    let pop_y = (work_b - win_h - gap_px).max(work_t);
    (pop_x, pop_y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_popover_position_centers_under_tray() {
        // tray icon at x=1000, y=0, 24x24px; window 320px wide; 4px gap.
        let (x, y) = compute_popover_position(1000.0, 0.0, 24.0, 24.0, 320.0, 4.0);
        assert_eq!(x, 1000 + 12 - 160); // = 852
        assert_eq!(y, 0 + 24 + 4); // = 28
    }

    #[test]
    fn test_compute_popover_position_handles_off_screen_left() {
        // The raw helper remains pure anchor math; clamping is layered below
        // once monitor work-area bounds are known.
        let (x, _) = compute_popover_position(10.0, 0.0, 24.0, 24.0, 320.0, 4.0);
        assert_eq!(x, 10 + 12 - 160); // = -138
    }

    #[test]
    fn test_compute_clamped_popover_position_keeps_left_edge_on_screen() {
        let (x, y) = compute_clamped_popover_position(
            10.0, 0.0, 24.0, 24.0, 320.0, 480.0, 4.0, 0.0, 0.0, 1440.0, 900.0,
        );
        assert_eq!(x, 0);
        assert_eq!(y, 28);
    }

    #[test]
    fn test_compute_clamped_popover_position_keeps_right_edge_on_screen() {
        let (x, y) = compute_clamped_popover_position(
            1428.0, 0.0, 24.0, 24.0, 320.0, 480.0, 4.0, 0.0, 0.0, 1440.0, 900.0,
        );
        assert_eq!(x, 1120);
        assert_eq!(y, 28);
    }

    // Multi-monitor popover anchoring regression: the macOS popover used to
    // always open on the primary display, ignoring the monitor the menu-bar
    // icon was clicked on. Two 2x Retina displays arranged side-by-side.
    fn primary_box() -> MonitorBox {
        MonitorBox {
            work_x: 0.0,
            work_y: 50.0,
            work_w: 2880.0,
            scale: 2.0,
        }
    }

    fn secondary_box() -> MonitorBox {
        // Cocoa points span [1440, 3360]; physical px span [2880, 6720].
        MonitorBox {
            work_x: 2880.0,
            work_y: 50.0,
            work_w: 3840.0,
            scale: 2.0,
        }
    }

    #[test]
    fn test_popover_anchors_on_secondary_monitor() {
        let mons = [primary_box(), secondary_box()];
        // Icon center at 2000 points: inside the secondary's span [1440, 3360].
        let (x, y) = position_popover_under_anchor(&mons, 2000.0, 360.0, 4.0).unwrap();
        // center_px = 2000*2 = 4000; minus win_w/2 (180) = 3820.
        assert_eq!(x, 3820);
        assert_eq!(y, 54); // work_y (50) + gap (4)
        assert!(x as f64 >= secondary_box().work_x);
    }

    #[test]
    fn test_popover_anchors_on_primary_monitor() {
        let mons = [primary_box(), secondary_box()];
        // Icon center at 700 points: inside the primary's span [0, 1440].
        let (x, _) = position_popover_under_anchor(&mons, 700.0, 360.0, 4.0).unwrap();
        // center_px = 1400; minus 180 = 1220.
        assert_eq!(x, 1220);
        assert!((x as f64) < secondary_box().work_x);
    }

    #[test]
    fn test_popover_clamps_to_secondary_right_edge() {
        let mons = [secondary_box()];
        // Icon near the far right of the secondary (3340 points).
        let (x, _) = position_popover_under_anchor(&mons, 3340.0, 360.0, 4.0).unwrap();
        // center_px = 6680; minus 180 = 6500; clamped to 6360.
        assert_eq!(x, 6360);
    }

    #[test]
    fn test_popover_anchor_outside_all_monitors_returns_none() {
        let mons = [primary_box()];
        // 5000 points is past the primary's [0, 1440] span.
        assert!(position_popover_under_anchor(&mons, 5000.0, 360.0, 4.0).is_none());
    }

    #[test]
    fn test_popover_single_monitor_centers_under_icon() {
        let mons = [primary_box()];
        // Icon at 720 points (center of the 1440pt-wide display).
        let (x, y) = position_popover_under_anchor(&mons, 720.0, 360.0, 4.0).unwrap();
        assert_eq!(x, 1260); // 720*2 = 1440; minus 180 = 1260
        assert_eq!(y, 54);
    }

    #[test]
    fn test_popover_mixed_dpi_picks_by_each_monitors_own_scale() {
        // Primary 2x; secondary 1x to the right. Selecting by each monitor's
        // own scale is what keeps a secondary-display click off the primary.
        let primary = MonitorBox {
            work_x: 0.0,
            work_y: 50.0,
            work_w: 2880.0,
            scale: 2.0,
        };
        let secondary = MonitorBox {
            work_x: 2880.0,
            work_y: 25.0,
            work_w: 1920.0,
            scale: 1.0,
        };
        let mons = [primary, secondary];
        // Primary points span [0, 1440], secondary points span [2880, 4800].
        // 2000 points falls in the gap.
        assert!(position_popover_under_anchor(&mons, 2000.0, 360.0, 4.0).is_none());
        // A point genuinely on the 1x secondary lands there.
        let (x, _) = position_popover_under_anchor(&mons, 3000.0, 360.0, 4.0).unwrap();
        // center_px = 3000*1 = 3000; minus 180 = 2820; clamped to min 2880.
        assert_eq!(x, 2880);
        assert!(x as f64 >= secondary.work_x);
    }
}
