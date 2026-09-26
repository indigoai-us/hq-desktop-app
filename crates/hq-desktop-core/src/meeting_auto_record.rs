//! "Record meetings automatically" preference.
//!
//! When `autoRecordMeetings` is `true` in `~/.hq/menubar.json`, every meeting
//! the Recall Desktop SDK detects (Slack huddles, Zoom, Meet, Teams, Webex, …)
//! starts recording as soon as it is detected, instead of waiting for the user
//! to click Record on the detected-meeting prompt. Default OFF.
//!
//! The key is read **untyped** on every detection, the same live-read posture
//! as `native_notify`, so flipping the Settings switch takes effect on the next
//! meeting without a restart. The typed `MenubarPrefs::auto_record_meetings`
//! field exists only so the Settings round-trip doesn't wipe it.
//!
//! This preference is independent of the detected-meeting alert controls
//! (`meetingDetectNotify`, `notifications`, `nativeNotifyMeetings`): those only
//! decide whether a banner is shown.

/// The `menubar.json` key for the auto-record switch.
pub const KEY_AUTO_RECORD_MEETINGS: &str = "autoRecordMeetings";

/// Pure decision. `true` only when `contents` parses and carries an explicit
/// boolean `true` under [`KEY_AUTO_RECORD_MEETINGS`]; a missing file, malformed
/// JSON, absent key, or non-bool value all resolve OFF.
pub fn auto_record_enabled_from(contents: Option<&str>) -> bool {
    contents
        .and_then(|c| serde_json::from_str::<serde_json::Value>(c).ok())
        .and_then(|json| json.get(KEY_AUTO_RECORD_MEETINGS).and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

/// Filesystem wrapper over [`auto_record_enabled_from`]. Reads
/// `~/.hq/menubar.json` fresh on every call.
pub fn auto_record_enabled() -> bool {
    let contents = crate::paths::hq_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("menubar.json")).ok());
    auto_record_enabled_from(contents.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_when_menubar_json_is_missing() {
        // Brand-new install: no settings file yet. Auto-record ships OFF.
        assert!(!auto_record_enabled_from(None));
    }

    #[test]
    fn off_when_key_is_absent() {
        assert!(!auto_record_enabled_from(Some(r#"{"notifications":true}"#)));
    }

    #[test]
    fn on_only_when_explicitly_true() {
        assert!(auto_record_enabled_from(Some(
            r#"{"autoRecordMeetings":true}"#
        )));
        assert!(!auto_record_enabled_from(Some(
            r#"{"autoRecordMeetings":false}"#
        )));
    }

    #[test]
    fn off_when_value_is_not_a_bool() {
        assert!(!auto_record_enabled_from(Some(
            r#"{"autoRecordMeetings":"true"}"#
        )));
        assert!(!auto_record_enabled_from(Some(
            r#"{"autoRecordMeetings":1}"#
        )));
        assert!(!auto_record_enabled_from(Some(
            r#"{"autoRecordMeetings":null}"#
        )));
    }

    #[test]
    fn off_when_json_is_malformed() {
        assert!(!auto_record_enabled_from(Some("{not json")));
    }

    #[test]
    fn independent_of_the_detected_meeting_alert_settings() {
        // Alerts off + an empty alert-source list must not stop auto-record:
        // those controls only decide whether a banner shows.
        let contents = r#"{
            "autoRecordMeetings": true,
            "notifications": false,
            "nativeNotifyMeetings": false,
            "meetingDetectNotify": {"enabled": false, "platforms": []}
        }"#;
        assert!(auto_record_enabled_from(Some(contents)));
    }
}
