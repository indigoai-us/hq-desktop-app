//! What backs HQ's transparent windows on this machine — answered on every
//! platform (the `glass` module itself is macOS-only, so the command that
//! reports the material must live where Windows and Linux builds can see it).

/// `glass`: macOS 26+ `NSGlassEffectView`. `vibrancy`: the pre-Tahoe
/// `NSVisualEffectView` fallback, which is far more see-through than glass
/// and reads as a washed-out grey under the translucent CSS surfaces tuned
/// for glass. `none`: no native material (other platforms). The frontend uses
/// this to keep surfaces near-opaque wherever real glass is unavailable.
pub fn material_capability_from(glass_available: bool, macos: bool) -> &'static str {
    if !macos {
        "none"
    } else if glass_available {
        "glass"
    } else {
        "vibrancy"
    }
}

#[tauri::command]
pub fn window_material_capability() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyClass;
        let glass = AnyClass::get(c"NSGlassEffectView").is_some();
        let material = material_capability_from(glass, true);
        crate::util::logfile::log("ui", &format!("liquid-glass: window material reported to UI = {material}"));
        material
    }
    #[cfg(not(target_os = "macos"))]
    {
        material_capability_from(false, false)
    }
}

/// Whether the native backdrop should be visible for a persisted
/// `windowTransparency` (0..=100, the inverse of the Settings opacity slider).
/// 0 is the explicit fully-solid endpoint: the web surfaces are opaque, so the
/// material is hidden. Any other value keeps the material behind the
/// translucent web layer, whose alpha scales with the setting.
pub fn backdrop_visible_for(transparency: u8) -> bool {
    transparency > 0
}

/// Backdrop visibility the web layer last requested, per window label.
///
/// The frontend applies the persisted transparency while the page script
/// boots, which is BEFORE the reveal path inserts the glass backing view. At
/// that moment `set_liquid_glass_backing_visible` finds no view and is a
/// no-op; the backing view is then inserted visible, and the frontend never
/// re-sends the same value. So a 100%-opaque preference still showed glass on
/// first launch while the slider read 100%. Remember the request here and
/// apply it when the backing view is inserted (see `glass.rs`).
static REQUESTED_BACKDROP_VISIBLE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, bool>>,
> = std::sync::OnceLock::new();

fn requested_backdrop_store() -> &'static std::sync::Mutex<std::collections::HashMap<String, bool>> {
    REQUESTED_BACKDROP_VISIBLE.get_or_init(Default::default)
}

/// Record the requested visibility for `label`.
pub fn remember_backdrop_visible(label: &str, visible: bool) {
    if let Ok(mut map) = requested_backdrop_store().lock() {
        map.insert(label.to_string(), visible);
    }
}

/// The requested visibility for `label`, if the web layer has asked yet.
pub fn requested_backdrop_visible(label: &str) -> Option<bool> {
    requested_backdrop_store()
        .lock()
        .ok()
        .and_then(|map| map.get(label).copied())
}

/// Apply the Appearance window-transparency setting to the calling window's
/// native backdrop. macOS toggles the Liquid Glass / vibrancy backing view;
/// other platforms report `material = none` and keep their surfaces
/// near-opaque in CSS, so there is nothing native to change.
#[tauri::command]
pub fn set_window_backdrop_transparency(window: tauri::WebviewWindow, transparency: u8) {
    let visible = backdrop_visible_for(transparency.min(100));
    remember_backdrop_visible(window.label(), visible);
    #[cfg(target_os = "macos")]
    {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            crate::glass::set_liquid_glass_backing_visible(&target, visible);
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, visible);
    }
}

#[cfg(test)]
mod backdrop_tests {
    use super::backdrop_visible_for;

    #[test]
    fn solid_endpoint_hides_backdrop_and_every_other_level_keeps_it() {
        assert!(!backdrop_visible_for(0));
        assert!(backdrop_visible_for(1));
        assert!(backdrop_visible_for(65));
        assert!(backdrop_visible_for(100));
    }
}

#[cfg(test)]
mod requested_backdrop_tests {
    use super::{remember_backdrop_visible, requested_backdrop_visible};

    #[test]
    fn a_request_made_before_the_backing_exists_is_remembered_per_window() {
        assert_eq!(requested_backdrop_visible("test-unrequested"), None);
        remember_backdrop_visible("test-desktop", false);
        remember_backdrop_visible("test-other", true);
        assert_eq!(requested_backdrop_visible("test-desktop"), Some(false));
        assert_eq!(requested_backdrop_visible("test-other"), Some(true));
        remember_backdrop_visible("test-desktop", true);
        assert_eq!(requested_backdrop_visible("test-desktop"), Some(true));
    }
}

#[cfg(test)]
mod material_capability_tests {
    use super::material_capability_from;

    #[test]
    fn pre_tahoe_macs_report_vibrancy_so_surfaces_stay_opaque() {
        assert_eq!(material_capability_from(false, true), "vibrancy");
        assert_eq!(material_capability_from(true, true), "glass");
        assert_eq!(material_capability_from(false, false), "none");
        assert_eq!(material_capability_from(true, false), "none");
    }
}
