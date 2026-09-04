use serde::{Deserialize, Serialize};

/// Neutral notification payload rendered by `BannerNotification.svelte`. Every
/// source maps its event onto this shape; `data` carries the original event
/// (a `DmEvent`, `ShareEvent`, or update info) echoed back on action.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BannerPayload {
    /// `"dm" | "share" | "update"` — routes the action in `App.svelte`.
    pub kind: String,
    /// Secondary label shown after "HQ Sync ·" (sender / source).
    pub title: String,
    /// Body line (clamped to two lines in the UI).
    pub body: String,
    /// Avatar text — initials for people, a glyph for system sources.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_text: Option<String>,
    /// Primary action chip label, e.g. "Copy prompt" / "Update now". None → no chip.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_label: Option<String>,
    /// Action id dispatched when the chip is clicked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    /// Action id dispatched on a body click (the discoverable default).
    pub click_action_id: String,
    /// Opaque source event echoed back on action (DmEvent / ShareEvent / update info).
    pub data: serde_json::Value,
}

/// `menubar.json` key holding the user's explicit surface choice.
pub const KEY_NOTIFICATION_SURFACE: &str = "notificationSurface";
/// Explicit choice: native OS banners (Notification Center).
pub const SURFACE_SYSTEM: &str = "system";
/// Explicit choice: HQ's in-app custom banner.
pub const SURFACE_CUSTOM: &str = "custom";
/// Legacy boolean key (see [`custom_banner_enabled_from`]).
pub const KEY_CUSTOM_BANNER: &str = "customBanner";

/// The surface used when the user has never made an explicit choice.
///
/// macOS: **system notifications** — real Notification Center banners that are
/// clickable and respect Focus / Do Not Disturb. This is the owner-decided
/// default; it replaced the in-app custom banner, which shipped default-ON and
/// meant native notifications never fired for anyone who didn't find the
/// Settings toggle.
///
/// Windows / Linux: unchanged — the in-app custom banner stays the default
/// there, because the native paths on those platforms (and the vendored Windows
/// fork's own banner code) were not part of the macOS decision.
pub const fn default_custom_banner() -> bool {
    !cfg!(target_os = "macos")
}

/// True when DMs / shares / meetings / updates should route through HQ's in-app
/// custom banner instead of the native OS notification path.
///
/// Reads `~/.hq/menubar.json` directly on every call so the Settings control is
/// picked up live on the next event (no restart). Shared by `dm_notify`,
/// `share_notify`, `meetings`, and `updater`.
pub fn custom_banner_enabled() -> bool {
    let contents = crate::paths::hq_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("menubar.json")).ok());
    custom_banner_enabled_from(contents.as_deref(), default_custom_banner())
}

/// Pure surface decision from `menubar.json` contents, in priority order:
///
/// 1. `notificationSurface` — the explicit-choice key. `"custom"` → in-app
///    banner, `"system"` → native OS banners. Nothing else ever writes it, so
///    its presence *is* the record of a deliberate choice.
/// 2. `customBanner: false` — the legacy opt-in to native banners. Only the old
///    Settings toggle ever wrote `false`, so it is unambiguous and honored.
/// 3. `default_custom` — the platform default (see [`default_custom_banner`]).
///
/// A legacy `customBanner: true` is deliberately NOT treated as a choice: every
/// `get_settings` before this change coerced the field to `true`, and the
/// frontend re-persists the full prefs object on any unrelated save, so `true`
/// on disk carries no information about user intent.
///
/// Missing file, unreadable file, malformed JSON, an unrecognised
/// `notificationSurface` string, and non-bool `customBanner` values all fall
/// through to `default_custom`.
pub fn custom_banner_enabled_from(contents: Option<&str>, default_custom: bool) -> bool {
    let json = contents.and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok());
    let json = match json {
        Some(j) => j,
        None => return default_custom,
    };
    match json.get(KEY_NOTIFICATION_SURFACE).and_then(|v| v.as_str()) {
        Some(SURFACE_CUSTOM) => return true,
        Some(SURFACE_SYSTEM) => return false,
        _ => {}
    }
    if json.get(KEY_CUSTOM_BANNER).and_then(|v| v.as_bool()) == Some(false) {
        return false;
    }
    default_custom
}

/// Up-to-two-letter initials from a display name, for the avatar.
pub fn initials(name: &str) -> String {
    let parts: Vec<&str> = name.split_whitespace().filter(|s| !s.is_empty()).collect();
    match parts.as_slice() {
        [] => "?".to_string(),
        [one] => one.chars().take(2).collect::<String>().to_uppercase(),
        [first, .., last] => {
            let a = first.chars().next().unwrap_or('?');
            let b = last.chars().next().unwrap_or('?');
            format!("{a}{b}").to_uppercase()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// macOS is the platform whose default flipped: an install that never
    /// recorded a choice must route to SYSTEM notifications.
    #[test]
    fn unset_resolves_to_system_notifications_on_macos() {
        for contents in [
            None,
            Some("{}"),
            Some("not json"),
            Some(r#"{"other":true}"#),
            // A legacy default-written `customBanner: true` is NOT a choice.
            Some(r#"{"customBanner":true}"#),
        ] {
            assert!(
                !custom_banner_enabled_from(contents, false),
                "expected system notifications for {contents:?}"
            );
        }
    }

    /// Windows / Linux keep the in-app banner when nothing was chosen.
    #[test]
    fn unset_keeps_custom_banner_off_macos() {
        for contents in [None, Some("{}"), Some(r#"{"customBanner":true}"#)] {
            assert!(custom_banner_enabled_from(contents, true));
        }
    }

    #[test]
    fn explicit_custom_choice_wins_over_the_system_default() {
        let c = Some(r#"{"notificationSurface":"custom"}"#);
        assert!(custom_banner_enabled_from(c, false));
        assert!(custom_banner_enabled_from(c, true));
        // Even when the legacy flag disagrees, the explicit key decides.
        assert!(custom_banner_enabled_from(
            Some(r#"{"notificationSurface":"custom","customBanner":false}"#),
            false
        ));
    }

    #[test]
    fn explicit_system_choice_resolves_to_system_everywhere() {
        let c = Some(r#"{"notificationSurface":"system"}"#);
        assert!(!custom_banner_enabled_from(c, false));
        assert!(!custom_banner_enabled_from(c, true));
        assert!(!custom_banner_enabled_from(
            Some(r#"{"notificationSurface":"system","customBanner":true}"#),
            true
        ));
    }

    #[test]
    fn legacy_custom_banner_false_still_means_system() {
        // Nothing ever wrote `false` by default, so it is an unambiguous
        // pre-existing opt-in to native banners and must survive on every
        // platform, including the ones whose default did not change.
        assert!(!custom_banner_enabled_from(
            Some(r#"{"customBanner":false}"#),
            true
        ));
        assert!(!custom_banner_enabled_from(
            Some(r#"{"customBanner":false}"#),
            false
        ));
    }

    #[test]
    fn unrecognised_values_fall_through_to_the_default() {
        // Unknown surface string and non-bool legacy flag are both ignored.
        assert!(!custom_banner_enabled_from(
            Some(r#"{"notificationSurface":"holographic"}"#),
            false
        ));
        assert!(!custom_banner_enabled_from(
            Some(r#"{"customBanner":"false"}"#),
            false
        ));
        assert!(custom_banner_enabled_from(
            Some(r#"{"customBanner":"false"}"#),
            true
        ));
    }

    #[test]
    fn macos_default_is_system_and_other_platforms_keep_the_in_app_banner() {
        assert_eq!(default_custom_banner(), !cfg!(target_os = "macos"));
        #[cfg(target_os = "macos")]
        assert!(!default_custom_banner());
    }

    #[test]
    fn initials_handles_names() {
        assert_eq!(initials("Corey Epstein"), "CE");
        assert_eq!(initials("Alice"), "AL");
        assert_eq!(initials(""), "?");
    }
}
