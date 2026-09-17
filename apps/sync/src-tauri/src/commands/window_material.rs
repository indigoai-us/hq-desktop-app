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
