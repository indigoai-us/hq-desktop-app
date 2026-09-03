//! User-facing gate for **native** (OS) notification banners.
//!
//! The app fires OS banners for three event kinds the notification code already
//! distinguishes — direct messages (`"dm"`), file shares (`"share"`), and
//! meeting detections / recaps (`"meeting"`). This module layers the Settings
//! → Notifications controls over the native delivery decision so the user can:
//!
//!   * turn every OS banner off with one master switch (`systemNotifications`),
//!   * mute an individual event kind (`nativeNotifyDirectMessages` /
//!     `nativeNotifyShares` / `nativeNotifyMeetings`), and
//!   * suppress banners while an HQ window is focused
//!     (`nativeNotifyOnlyWhenUnfocused`).
//!
//! These keys live in `~/.hq/menubar.json` and are read **untyped** on every
//! delivery — the same live-read posture as `banner::custom_banner_enabled` and
//! `dm_notify::dm_notifications_enabled` — so a toggle takes effect on the next
//! event without an app restart. The typed `MenubarPrefs` fields exist only so
//! the Settings round-trip (get/save_settings) doesn't wipe them.
//!
//! The decision is intentionally split into a pure `should_native_notify_from`
//! (unit-tested exhaustively below) and a thin filesystem wrapper.
//!
//! This gate governs only the **native** (UN / osascript / legacy) delivery
//! path — it runs downstream of the in-app custom banner (which is HQ's own
//! surface) and downstream of the per-channel poll gates (`dmNotifications`,
//! `shareNotifications`). It never touches the in-app NotificationFeed panel.

/// The `menubar.json` key for the master OS-banner switch. Default ON.
const KEY_SYSTEM: &str = "systemNotifications";
/// Per-kind key for direct-message banners. Default ON.
const KEY_DM: &str = "nativeNotifyDirectMessages";
/// Per-kind key for file-share banners. Default ON.
const KEY_SHARE: &str = "nativeNotifyShares";
/// Per-kind key for meeting-detection / recap banners. Default ON.
const KEY_MEETING: &str = "nativeNotifyMeetings";
/// "Only when the app is not focused" key. Default ON — don't banner while the
/// user is already looking at an HQ window.
const KEY_ONLY_UNFOCUSED: &str = "nativeNotifyOnlyWhenUnfocused";

/// Map an event kind (`"dm"` / `"share"` / `"meeting"`) to its per-event
/// `menubar.json` key. An unknown kind has no dedicated toggle, so it returns
/// `None` and is treated as always-allowed by that stage (still subject to the
/// master switch and focus rule).
fn per_event_key(kind: &str) -> Option<&'static str> {
    match kind {
        "dm" => Some(KEY_DM),
        "share" => Some(KEY_SHARE),
        "meeting" => Some(KEY_MEETING),
        _ => None,
    }
}

/// Read a boolean key out of parsed `menubar.json`, defaulting to `default`
/// when the file is missing/unreadable, the JSON is malformed, the key is
/// absent, or the value isn't a bool.
fn read_bool(json: Option<&serde_json::Value>, key: &str, default: bool) -> bool {
    json.and_then(|j| j.get(key))
        .and_then(|v| v.as_bool())
        .unwrap_or(default)
}

/// Pure native-banner gate. Returns `true` when a banner of `kind` should fire
/// given the persisted settings in `contents` and whether an HQ window is
/// currently focused.
///
/// Decision order (any failing stage suppresses the banner):
///   1. **Master switch** — `systemNotifications` (default ON). Off → no banner.
///   2. **Per-event switch** — the kind's toggle (default ON). Off → no banner.
///      An unrecognised kind has no toggle and passes this stage.
///   3. **Focus rule** — when `nativeNotifyOnlyWhenUnfocused` (default ON) and
///      an HQ window is focused, suppress. This is uniform across kinds: the
///      existing native path had no focus suppression, so we don't invent a
///      per-kind exception here.
///
/// Split out so the whole truth table is testable without the filesystem.
pub fn should_native_notify_from(contents: Option<&str>, kind: &str, app_focused: bool) -> bool {
    let json = contents.and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok());
    let json_ref = json.as_ref();

    // 1. Master switch.
    if !read_bool(json_ref, KEY_SYSTEM, true) {
        return false;
    }

    // 2. Per-event switch.
    if let Some(key) = per_event_key(kind) {
        if !read_bool(json_ref, key, true) {
            return false;
        }
    }

    // 3. Focus rule.
    if app_focused && read_bool(json_ref, KEY_ONLY_UNFOCUSED, true) {
        return false;
    }

    true
}

/// Filesystem wrapper over [`should_native_notify_from`]. Reads
/// `~/.hq/menubar.json` fresh on every call (missing/unreadable → defaults, so
/// a brand-new install banners on DMs/shares/meetings while unfocused).
pub fn should_native_notify(kind: &str, app_focused: bool) -> bool {
    let contents = crate::paths::hq_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("menubar.json")).ok());
    should_native_notify_from(contents.as_deref(), kind, app_focused)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_on_for_known_kinds_while_unfocused() {
        // Missing file, empty object, and unrelated keys all default ON.
        for contents in [
            None,
            Some("{}"),
            Some("not json"),
            Some(r#"{"other":true}"#),
        ] {
            assert!(should_native_notify_from(contents, "dm", false));
            assert!(should_native_notify_from(contents, "share", false));
            assert!(should_native_notify_from(contents, "meeting", false));
        }
    }

    #[test]
    fn master_switch_off_suppresses_every_kind() {
        let c = Some(r#"{"systemNotifications":false}"#);
        assert!(!should_native_notify_from(c, "dm", false));
        assert!(!should_native_notify_from(c, "share", false));
        assert!(!should_native_notify_from(c, "meeting", false));
        // Even an unknown kind is suppressed by the master switch.
        assert!(!should_native_notify_from(c, "mystery", false));
    }

    #[test]
    fn per_event_switch_off_suppresses_only_that_kind() {
        let c = Some(r#"{"nativeNotifyDirectMessages":false}"#);
        assert!(!should_native_notify_from(c, "dm", false));
        // Other kinds keep their default-ON behaviour.
        assert!(should_native_notify_from(c, "share", false));
        assert!(should_native_notify_from(c, "meeting", false));
    }

    #[test]
    fn shares_and_meetings_have_independent_toggles() {
        assert!(!should_native_notify_from(
            Some(r#"{"nativeNotifyShares":false}"#),
            "share",
            false
        ));
        assert!(!should_native_notify_from(
            Some(r#"{"nativeNotifyMeetings":false}"#),
            "meeting",
            false
        ));
    }

    #[test]
    fn only_when_unfocused_suppresses_while_focused_by_default() {
        // Default (key absent) is ON → focused suppresses.
        assert!(!should_native_notify_from(None, "dm", true));
        assert!(!should_native_notify_from(Some("{}"), "meeting", true));
        // Unfocused always allowed at this stage.
        assert!(should_native_notify_from(None, "dm", false));
    }

    #[test]
    fn only_when_unfocused_disabled_allows_banner_while_focused() {
        let c = Some(r#"{"nativeNotifyOnlyWhenUnfocused":false}"#);
        assert!(should_native_notify_from(c, "dm", true));
        assert!(should_native_notify_from(c, "share", true));
    }

    #[test]
    fn master_off_beats_focus_rule_disabled() {
        // Master switch dominates even when the focus rule is turned off.
        let c = Some(r#"{"systemNotifications":false,"nativeNotifyOnlyWhenUnfocused":false}"#);
        assert!(!should_native_notify_from(c, "dm", true));
        assert!(!should_native_notify_from(c, "dm", false));
    }

    #[test]
    fn unknown_kind_follows_master_and_focus_only() {
        // No per-event toggle for an unknown kind, but master + focus still apply.
        assert!(should_native_notify_from(Some("{}"), "unknown", false));
        assert!(!should_native_notify_from(Some("{}"), "unknown", true));
    }
}
