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

/// True when DMs/shares/updates should route through the custom banner instead
/// of `mac-notification-sys`. **Default ON** as of v0.3.0 — custom notifications
/// are the default surface for everyone; set `"customBanner": false` in
/// `~/.hq/menubar.json` to fall back to native. Read directly so the toggle is
/// additive and picked up live on the next poll (no restart). Shared by
/// `dm_notify`, `share_notify`, and `updater`.
pub fn custom_banner_enabled() -> bool {
    let contents = crate::paths::hq_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("menubar.json")).ok());
    custom_banner_enabled_from(contents.as_deref())
}

/// Pure gate decision from `menubar.json` contents — ON unless `customBanner` is
/// explicitly `false`. Missing file, unreadable, malformed JSON, or absent key
/// all default ON. Split out so the routing rule (shared by DM / share / meeting
/// / update) is unit-testable without the filesystem.
fn custom_banner_enabled_from(contents: Option<&str>) -> bool {
    contents
        .and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok())
        .and_then(|j| j.get("customBanner").and_then(|v| v.as_bool()))
        .unwrap_or(true)
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

    #[test]
    fn gate_defaults_on_when_absent_or_unreadable() {
        assert!(custom_banner_enabled_from(None));
        assert!(custom_banner_enabled_from(Some("not json")));
        assert!(custom_banner_enabled_from(Some("{}")));
        assert!(custom_banner_enabled_from(Some(r#"{"other":true}"#)));
    }

    #[test]
    fn gate_on_when_explicitly_true() {
        assert!(custom_banner_enabled_from(Some(r#"{"customBanner":true}"#)));
    }

    #[test]
    fn gate_off_only_when_explicitly_false() {
        assert!(!custom_banner_enabled_from(Some(
            r#"{"customBanner":false}"#
        )));
        // Non-bool values are ignored → default ON.
        assert!(custom_banner_enabled_from(Some(
            r#"{"customBanner":"false"}"#
        )));
    }

    #[test]
    fn initials_handles_names() {
        assert_eq!(initials("Corey Epstein"), "CE");
        assert_eq!(initials("Alice"), "AL");
        assert_eq!(initials(""), "?");
    }
}
