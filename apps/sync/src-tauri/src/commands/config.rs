use serde::{Deserialize, Serialize};

use crate::util::paths;

pub use hq_desktop_core::config::{
    ensure_machine_id, migrate_legacy_config_stub, read_hq_config_lenient, record_sync_version,
    HqConfig, MeetingDetectNotifyPrefs, MenubarPrefs,
};

/// Response returned to the frontend from get_config.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigState {
    pub configured: bool,
    pub company_slug: Option<String>,
    pub company_uid: Option<String>,
    pub person_uid: Option<String>,
    pub role: Option<String>,
    pub bucket_name: Option<String>,
    pub vault_api_url: Option<String>,
    pub hq_folder_path: String,
    pub error: Option<String>,
}

/// Read ~/.hq/config.json and ~/.hq/menubar.json, resolve HQ folder path,
/// and return a ConfigState for the frontend.
///
/// If config.json is missing, returns configured=false with an error message
/// directing the user to install hq-installer first.
#[tauri::command]
pub async fn get_config() -> Result<ConfigState, String> {
    let config_path = paths::config_json_path()?;
    let menubar_path = paths::menubar_json_path()?;

    // Read menubar.json (optional — may not exist)
    let menubar_prefs: Option<MenubarPrefs> = if menubar_path.exists() {
        let contents = std::fs::read_to_string(&menubar_path)
            .map_err(|e| format!("Failed to read menubar.json: {}", e))?;
        serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse menubar.json: {}", e))
            .ok()
    } else {
        None
    };

    // Read config.json (required for configured state)
    if !config_path.exists() {
        let hq_folder = paths::resolve_hq_folder(
            None,
            menubar_prefs.as_ref().and_then(|p| p.hq_path.as_deref()),
        );
        return Ok(ConfigState {
            configured: false,
            company_slug: None,
            company_uid: None,
            person_uid: None,
            role: None,
            bucket_name: None,
            vault_api_url: None,
            hq_folder_path: hq_folder.to_string_lossy().to_string(),
            error: Some(
                "HQ is not configured. Please run hq-installer to complete setup. \
                 Download at https://github.com/indigoai-us/hq-installer/releases"
                    .to_string(),
            ),
        });
    }

    // Lenient parse: a legacy `{"defaultOrg":"…"}` stub (or any
    // non-HqConfig JSON) surfaces as `configured=false` rather than a
    // Rust Err, so the frontend can route the user to SetupNeeded
    // instead of seeing an opaque parse error.
    let config = match read_hq_config_lenient()? {
        Some(c) => c,
        None => {
            let hq_folder = paths::resolve_hq_folder(
                None,
                menubar_prefs.as_ref().and_then(|p| p.hq_path.as_deref()),
            );
            return Ok(ConfigState {
                configured: false,
                company_slug: None,
                company_uid: None,
                person_uid: None,
                role: None,
                bucket_name: None,
                vault_api_url: None,
                hq_folder_path: hq_folder.to_string_lossy().to_string(),
                error: Some(
                    "~/.hq/config.json is present but doesn't match HqConfig. \
                     Re-run hq-installer to repair, or restart HQ — the \
                     launch-time migration recovers personal-vault installs \
                     automatically when ~/.hq/person-entity.json is present."
                        .to_string(),
                ),
            });
        }
    };

    let hq_folder = paths::resolve_hq_folder(
        config.hq_folder_path.as_deref(),
        menubar_prefs.as_ref().and_then(|p| p.hq_path.as_deref()),
    );

    Ok(ConfigState {
        configured: true,
        company_slug: Some(config.company_slug),
        company_uid: Some(config.company_uid),
        person_uid: Some(config.person_uid),
        role: Some(config.role),
        bucket_name: Some(config.bucket_name),
        vault_api_url: Some(config.vault_api_url),
        hq_folder_path: hq_folder.to_string_lossy().to_string(),
        error: None,
    })
}

/// HQ Work desktop-view handoff. Absent prefs / absent key → false.
pub fn hq_work_handoff_enabled(prefs: Option<&MenubarPrefs>) -> bool {
    prefs.and_then(|p| p.hq_work_handoff).unwrap_or(false)
}

/// Parse `hqWorkHandoff` from menubar.json text. Typed prefs first; untyped
/// fallback so unrelated schema drift cannot hide the flag. Never a setup trigger.
pub fn hq_work_handoff_from_json(contents: &str) -> bool {
    if let Ok(prefs) = serde_json::from_str::<MenubarPrefs>(contents) {
        return hq_work_handoff_enabled(Some(&prefs));
    }
    serde_json::from_str::<serde_json::Value>(contents)
        .ok()
        .and_then(|v| v.get("hqWorkHandoff").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

/// Missing file or missing key = false. Parse failure is not a setup trigger.
#[tauri::command]
pub fn get_hq_work_handoff() -> Result<bool, String> {
    let path = paths::menubar_json_path()?;
    if !path.exists() {
        return Ok(false);
    }
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return Ok(false);
    };
    Ok(hq_work_handoff_from_json(&contents))
}

/// Persist the handoff flag via untyped merge so unrelated keys survive.
#[tauri::command]
pub fn set_hq_work_handoff(enabled: bool) -> Result<(), String> {
    let path = paths::menubar_json_path()?;
    hq_desktop_core::first_run::merge_menubar_flags(
        &path,
        &[("hqWorkHandoff", serde_json::json!(enabled))],
    )
}

#[cfg(test)]
mod hq_work_handoff_tests {
    use super::*;

    fn prefs_with(flag: Option<bool>) -> MenubarPrefs {
        let mut prefs: MenubarPrefs = serde_json::from_str("{}").unwrap();
        prefs.hq_work_handoff = flag;
        prefs
    }

    #[test]
    fn hq_work_handoff_enabled_none_prefs_is_false() {
        assert!(!hq_work_handoff_enabled(None));
    }

    #[test]
    fn hq_work_handoff_enabled_absent_field_is_false() {
        assert!(!hq_work_handoff_enabled(Some(&prefs_with(None))));
    }

    #[test]
    fn hq_work_handoff_enabled_explicit_false() {
        assert!(!hq_work_handoff_enabled(Some(&prefs_with(Some(false)))));
    }

    #[test]
    fn hq_work_handoff_enabled_explicit_true() {
        assert!(hq_work_handoff_enabled(Some(&prefs_with(Some(true)))));
    }

    #[test]
    fn hq_work_handoff_from_json_reads_typed_true() {
        assert!(hq_work_handoff_from_json(r#"{"hqWorkHandoff":true}"#));
    }

    #[test]
    fn hq_work_handoff_from_json_absent_is_false() {
        assert!(!hq_work_handoff_from_json(r#"{"hqPath":"/tmp/HQ"}"#));
        assert!(!hq_work_handoff_from_json("not-json"));
    }

    #[test]
    fn hq_work_handoff_from_json_survives_unrelated_schema_drift() {
        // meetingDetectNotify.platforms as a string is invalid for MenubarPrefs,
        // but the untyped fallback still sees hqWorkHandoff.
        let drifted = r#"{"hqWorkHandoff":true,"meetingDetectNotify":{"platforms":"zoom"}}"#;
        assert!(hq_work_handoff_from_json(drifted));
    }
}
