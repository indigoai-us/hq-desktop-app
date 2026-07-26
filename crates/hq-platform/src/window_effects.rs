use hq_desktop_core::logfile::log;
use raw_window_handle::HasWindowHandle;

/// Semantic OS appearance used to pick Mica / Acrylic fallbacks on Windows.
///
/// Callers resolve this from the live Tauri window theme (preferred) or the
/// system AppsUseLightTheme preference. Never hard-code dark.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowAppearance {
    Light,
    Dark,
}

impl WindowAppearance {
    pub fn from_dark(is_dark: bool) -> Self {
        if is_dark {
            Self::Dark
        } else {
            Self::Light
        }
    }

    pub fn is_dark(self) -> bool {
        matches!(self, Self::Dark)
    }

    /// Mica dark-variant flag: `Some(true)` dark, `Some(false)` light.
    /// Always explicit so the effect tracks the live theme rather than
    /// silently locking to dark.
    pub fn mica_dark(self) -> Option<bool> {
        Some(self.is_dark())
    }

    /// Win10 Acrylic RGBA tint matched to light / dark semantic surfaces.
    pub fn acrylic_rgba(self) -> (u8, u8, u8, u8) {
        match self {
            // ≈ light popover frost (~78% opacity)
            Self::Light => (248, 248, 250, 200),
            // ≈ dark popover frost (~70% opacity)
            Self::Dark => (18, 18, 18, 180),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

/// Apply the platform-native translucent window backdrop used by HQ popovers.
///
/// On Windows, resolves the system AppsUseLightTheme preference when no live
/// Tauri theme is available. Prefer [`apply_windows_window_style`] when the
/// caller already holds a resolved theme (including ThemeChanged).
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
        apply_windows_window_style(window, resolve_windows_appearance(None));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = window;
    }
}

/// Apply Windows Mica (Win 11) or Acrylic (Win 10) matched to `appearance`.
///
/// Re-call this from `WindowEvent::ThemeChanged` so live OS theme switches
/// update the native backdrop. Does nothing on non-Windows targets.
pub fn apply_windows_window_style(window: &impl HasWindowHandle, appearance: WindowAppearance) {
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{apply_acrylic, apply_mica};

        let dark = appearance.mica_dark();
        match apply_mica(window, dark) {
            Ok(()) => {
                log(
                    "ui",
                    &format!(
                        "apply_mica: success ({} variant)",
                        appearance.label()
                    ),
                );
                return;
            }
            Err(e) => {
                log(
                    "ui",
                    &format!("apply_mica failed: {e}; trying Acrylic fallback"),
                );
            }
        }

        let tint = appearance.acrylic_rgba();
        match apply_acrylic(window, Some(tint)) {
            Ok(()) => log(
                "ui",
                &format!(
                    "apply_acrylic: success ({} Win 10 fallback rgba{:?})",
                    appearance.label(),
                    tint
                ),
            ),
            Err(e) => log(
                "ui",
                &format!(
                    "apply_acrylic failed: {e}; popover will render with the Svelte solid-background fallback"
                ),
            ),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, appearance);
    }
}

/// Map an optional dark-flag (e.g. from Tauri `Theme`) to a resolved appearance.
/// `None` falls back to the system AppsUseLightTheme preference on Windows,
/// and Light elsewhere.
pub fn resolve_windows_appearance(theme_is_dark: Option<bool>) -> WindowAppearance {
    match theme_is_dark {
        Some(true) => WindowAppearance::Dark,
        Some(false) => WindowAppearance::Light,
        None => {
            #[cfg(target_os = "windows")]
            {
                return WindowAppearance::from_dark(system_apps_use_dark());
            }
            #[cfg(not(target_os = "windows"))]
            {
                WindowAppearance::Light
            }
        }
    }
}

/// Read Windows "Apps use light theme" (0 = dark). Best-effort; defaults to
/// dark only when the key is missing so a failed registry read does not flash
/// light Mica over a dark WebView mid-migration. Prefer live Tauri theme.
#[cfg(target_os = "windows")]
fn system_apps_use_dark() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = hkcu.open_subkey(
        r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
    ) else {
        return true;
    };
    let value: u32 = key.get_value("AppsUseLightTheme").unwrap_or(0);
    value == 0
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appearance_maps_live_theme_to_mica_and_acrylic() {
        let light = WindowAppearance::Light;
        assert_eq!(light.mica_dark(), Some(false));
        assert_eq!(light.acrylic_rgba(), (248, 248, 250, 200));
        assert!(!light.is_dark());

        let dark = WindowAppearance::Dark;
        assert_eq!(dark.mica_dark(), Some(true));
        assert_eq!(dark.acrylic_rgba(), (18, 18, 18, 180));
        assert!(dark.is_dark());
    }

    #[test]
    fn resolve_explicit_theme_never_forces_dark_for_light() {
        assert_eq!(
            resolve_windows_appearance(Some(false)),
            WindowAppearance::Light
        );
        assert_eq!(
            resolve_windows_appearance(Some(true)),
            WindowAppearance::Dark
        );
    }

    #[test]
    fn from_dark_round_trips() {
        assert_eq!(WindowAppearance::from_dark(true), WindowAppearance::Dark);
        assert_eq!(WindowAppearance::from_dark(false), WindowAppearance::Light);
    }
}
