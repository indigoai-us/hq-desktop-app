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

/// Apply the Appearance window-transparency setting to the calling window's
/// native backdrop. macOS toggles the Liquid Glass / vibrancy backing view;
/// other platforms report `material = none` and keep their surfaces
/// near-opaque in CSS, so there is nothing native to change.
#[tauri::command]
pub fn set_window_backdrop_transparency(window: tauri::WebviewWindow, transparency: u8) {
    let visible = backdrop_visible_for(transparency.min(100));
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
