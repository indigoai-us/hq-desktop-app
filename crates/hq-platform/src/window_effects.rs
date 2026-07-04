use hq_desktop_core::logfile::log;
use raw_window_handle::HasWindowHandle;

/// Apply the platform-native translucent window backdrop used by HQ popovers.
pub fn apply_popover_vibrancy(window: &impl HasWindowHandle) {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

        // window-vibrancy's apply_vibrancy returns Result<(), Error>. Earlier we
        // swallowed the error with `let _ =`, which made silent failures
        // indistinguishable from "vibrancy applied but visually subtle." Log on
        // both success and failure so the persistent diagnostic log can answer
        // "is vibrancy actually being applied?" without a debugger attached.
        match apply_vibrancy(
            window,
            NSVisualEffectMaterial::Popover,
            Some(NSVisualEffectState::Active),
            Some(18.0),
        ) {
            Ok(()) => log(
                "ui",
                "apply_vibrancy: success (Popover material, blur 18, active)",
            ),
            Err(e) => log("ui", &format!("apply_vibrancy FAILED: {e}")),
        }
    }

    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{apply_acrylic, apply_mica};

        match apply_mica(window, Some(true)) {
            Ok(()) => {
                log("ui", "apply_mica: success (dark variant)");
                return;
            }
            Err(e) => {
                log(
                    "ui",
                    &format!("apply_mica failed: {e}; trying Acrylic fallback"),
                );
            }
        }

        match apply_acrylic(window, Some((18, 18, 18, 180))) {
            Ok(()) => log("ui", "apply_acrylic: success (Win 10 fallback)"),
            Err(e) => log(
                "ui",
                &format!(
                    "apply_acrylic failed: {e}; popover will render with the Svelte solid-background fallback"
                ),
            ),
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = window;
    }
}

/// Remove the translucent window backdrop so a `transparent` window shows the
/// desktop behind it (used while the first-run onboarding floating card is up —
/// the popover vibrancy is re-applied on the tray handoff).
pub fn clear_popover_vibrancy(window: &impl HasWindowHandle) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        match window_vibrancy::clear_vibrancy(window) {
            Ok(_) => log("ui", "clear_vibrancy: success"),
            Err(e) => log("ui", &format!("clear_vibrancy FAILED: {e}")),
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = window;
    }
}

#[cfg(target_os = "windows")]
pub fn set_small_corner(hwnd_raw: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUNDSMALL,
    };

    let hwnd = HWND(hwnd_raw as *mut _);
    let pref: u32 = DWMWCP_ROUNDSMALL.0 as u32;
    let pref_ptr = &pref as *const u32 as *const std::ffi::c_void;
    let size = std::mem::size_of::<u32>() as u32;
    let result =
        unsafe { DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, pref_ptr, size) };
    if let Err(e) = result {
        log(
            "ui",
            &format!("DwmSetWindowAttribute(DWMWCP_ROUNDSMALL) failed: {e}"),
        );
    } else {
        log("ui", "DWMWCP_ROUNDSMALL applied — small corner radius");
    }
}
