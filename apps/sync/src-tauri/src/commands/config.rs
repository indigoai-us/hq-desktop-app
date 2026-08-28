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

/// Compose the on-disk flag with cohort membership.
///
/// `~/.hq/menubar.json` is a plain user-writable file, so the flag on its own
/// is an opt-in, never an authorisation. The embedded HQ Work window is alpha
/// and stays inside the `@getindigo.ai` cohort until it graduates, so both
/// have to be true. Pure so the composition is unit-testable without a
/// Cognito fixture.
pub fn hq_work_handoff_visible(flag: bool, is_indigo: bool) -> bool {
    flag && is_indigo
}

/// Missing file or missing key = false. Parse failure is not a setup trigger.
///
/// Also false for anyone outside the `@getindigo.ai` cohort, whatever the file
/// says. Every consumer of the flag — the desktop-alt boot in `main.ts`, the
/// `hqwork://` internal route, and the retained two-app probe — reads it
/// through this one command, so gating here covers all of them. Uses the same
/// `feature_gate` the updater's pre-release channels use, so "who is Indigo"
/// has exactly one definition.
#[tauri::command]
pub async fn get_hq_work_handoff() -> Result<bool, String> {
    let path = paths::menubar_json_path()?;
    if !path.exists() {
        return Ok(false);
    }
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return Ok(false);
    };
    let flag = hq_work_handoff_from_json(&contents);
    // Short-circuit: a user with the flag off costs no gate evaluation.
    if !flag {
        return Ok(false);
    }
    Ok(hq_work_handoff_visible(
        flag,
        hq_desktop_core::feature_gate::is_indigo_user().await,
    ))
}

/// Persist the handoff flag via untyped merge so unrelated keys survive.
///
/// Refuses outside the cohort rather than writing a flag that
/// [`get_hq_work_handoff`] would then ignore — a toggle that silently does
/// nothing is worse than one that says why.
#[tauri::command]
pub async fn set_hq_work_handoff(enabled: bool) -> Result<(), String> {
    if enabled && !hq_desktop_core::feature_gate::is_indigo_user().await {
        return Err("The embedded HQ Work window is limited to @getindigo.ai accounts.".into());
    }
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

    // ── Indigo-only cohort gate ────────────────────────────────────────────
    //
    // The embedded HQ Work window is alpha and must stay inside the
    // @getindigo.ai cohort. The menubar.json flag alone is NOT sufficient:
    // any user can hand-edit that file. The effective answer is
    // `flag AND is_indigo_user()`, composed by `hq_work_handoff_visible`.
    //
    // The async gate itself needs a Cognito fixture, so — mirroring
    // `feature_gate`'s own tests — the composition is proved here over the
    // canonical `is_allowed_email` helper, and the wiring of the real command
    // onto it is source-contracted in the US-108 story test.

    fn visible_for(flag: bool, email: Option<&str>) -> bool {
        hq_work_handoff_visible(
            flag,
            hq_desktop_core::feature_gate::is_allowed_email(email),
        )
    }

    #[test]
    fn handoff_needs_both_the_flag_and_an_indigo_account() {
        assert!(visible_for(true, Some("hassaan@getindigo.ai")));
        assert!(visible_for(true, Some("HASSAAN@GETINDIGO.AI")));
    }

    #[test]
    fn handoff_flag_alone_does_not_admit_a_non_indigo_account() {
        // The exact escalation this gate exists to stop: a user outside the
        // cohort writes `"hqWorkHandoff": true` into their own menubar.json.
        assert!(!visible_for(true, Some("someone@gmail.com")));
        assert!(!visible_for(true, Some("qa@example.com")));
        // Signed out — no claim at all.
        assert!(!visible_for(true, None));
        assert!(!visible_for(true, Some("")));
    }

    #[test]
    fn handoff_rejects_look_alike_domains_even_with_the_flag_on() {
        assert!(!visible_for(true, Some("attacker@forgetindigo.ai")));
        assert!(!visible_for(true, Some("attacker@notgetindigo.ai")));
        assert!(!visible_for(true, Some("getindigo.ai")));
    }

    #[test]
    fn handoff_stays_off_for_indigo_accounts_until_the_flag_is_set() {
        // Cohort membership must not silently enable the alpha; the flag is
        // still the opt-in, and it still defaults off.
        assert!(!visible_for(false, Some("hassaan@getindigo.ai")));
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
