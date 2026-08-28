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

/// The user's explicit choice, or `None` when they have not made one.
///
/// [`hq_work_handoff_from_json`] collapses "absent" and "explicitly false"
/// into `false`, which is right for the two-app readers that still use it but
/// cannot express default-on: the cohort default and an opt-out would be
/// indistinguishable. Typed prefs first, untyped fallback second, so unrelated
/// schema drift cannot hide the key. Unparseable input is "no choice", never a
/// silent opt-out.
pub fn hq_work_handoff_choice(contents: &str) -> Option<bool> {
    if let Ok(prefs) = serde_json::from_str::<MenubarPrefs>(contents) {
        if let Some(explicit) = prefs.hq_work_handoff {
            return Some(explicit);
        }
    }
    serde_json::from_str::<serde_json::Value>(contents)
        .ok()
        .and_then(|v| v.get("hqWorkHandoff").and_then(|b| b.as_bool()))
}

/// Compose the user's choice with cohort membership.
///
/// **On by default inside the `@getindigo.ai` cohort.** The embed is the
/// product direction, and the alpha cohort should not have to hand-edit
/// `~/.hq/menubar.json` to see it — there is deliberately no Settings toggle.
///
/// Outside the cohort it is off no matter what the file says. `menubar.json`
/// is a plain user-writable file, so the key is a preference, never an
/// authorisation: writing `"hqWorkHandoff": true` outside the cohort still
/// gets nothing, and default-on does not leak past the cohort either.
///
/// An explicit `false` remains an opt-out for cohort members. Without that
/// there would be no way back to the legacy window short of signing out, and
/// the US-107 rollback scenario would have nothing to exercise.
///
/// Pure, so the composition is unit-testable without a Cognito fixture.
pub fn hq_work_handoff_visible(choice: Option<bool>, is_indigo: bool) -> bool {
    is_indigo && choice.unwrap_or(true)
}

/// On by default for `@getindigo.ai`; off for everyone else, whatever the
/// file says. An explicit `false` opts a cohort member out.
///
/// A missing or unreadable `menubar.json` is "no explicit choice", not an
/// opt-out — a fresh install by a cohort member gets the embed, same as an
/// existing one that has never touched the key.
///
/// Every consumer of the flag — the desktop-alt boot in `main.ts`, the
/// `hqwork://` internal route, and the retained two-app probe — reads it
/// through this one command, so this is the whole policy. Uses the same
/// `feature_gate` the updater's pre-release channels use, so "who is Indigo"
/// has exactly one definition.
#[tauri::command]
pub async fn get_hq_work_handoff() -> Result<bool, String> {
    let path = paths::menubar_json_path()?;
    let choice = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|contents| hq_work_handoff_choice(&contents))
    } else {
        None
    };
    // Short-circuit an explicit opt-out: no gate evaluation, no token read.
    if choice == Some(false) {
        return Ok(false);
    }
    Ok(hq_work_handoff_visible(
        choice,
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

    fn visible_for(choice: Option<bool>, email: Option<&str>) -> bool {
        hq_work_handoff_visible(
            choice,
            hq_desktop_core::feature_gate::is_allowed_email(email),
        )
    }

    #[test]
    fn handoff_is_on_for_indigo_accounts_by_default() {
        // The cohort gets the embed without touching menubar.json — an
        // explicit `true` and no key at all mean the same thing for them.
        assert!(visible_for(None, Some("hassaan@getindigo.ai")));
        assert!(visible_for(None, Some("HASSAAN@GETINDIGO.AI")));
        assert!(visible_for(Some(true), Some("hassaan@getindigo.ai")));
    }

    #[test]
    fn explicit_false_still_opts_an_indigo_account_out() {
        // Default-on must stay overridable, or there is no way back to the
        // legacy window without signing out — and Scenario 4 of the US-107
        // checklist (flag-off rollback) would have nothing to exercise.
        assert!(!visible_for(Some(false), Some("hassaan@getindigo.ai")));
    }

    #[test]
    fn handoff_never_admits_a_non_indigo_account() {
        // The escalation this gate exists to stop: someone outside the cohort
        // writes `"hqWorkHandoff": true` into their own menubar.json. Default-on
        // must not leak past the cohort either, so absent is false for them too.
        for email in [Some("someone@gmail.com"), Some("qa@example.com"), None, Some("")] {
            assert!(!visible_for(Some(true), email), "explicit true: {email:?}");
            assert!(!visible_for(None, email), "default: {email:?}");
        }
    }

    #[test]
    fn handoff_rejects_look_alike_domains() {
        for email in [
            Some("attacker@forgetindigo.ai"),
            Some("attacker@notgetindigo.ai"),
            Some("getindigo.ai"),
        ] {
            assert!(!visible_for(Some(true), email), "explicit true: {email:?}");
            assert!(!visible_for(None, email), "default: {email:?}");
        }
    }

    #[test]
    fn choice_distinguishes_absent_from_explicit_false() {
        // The whole default-on behaviour rests on telling these apart, which
        // the bool-returning readers cannot do.
        assert_eq!(hq_work_handoff_choice(r#"{"hqWorkHandoff":true}"#), Some(true));
        assert_eq!(hq_work_handoff_choice(r#"{"hqWorkHandoff":false}"#), Some(false));
        assert_eq!(hq_work_handoff_choice(r#"{"hqPath":"/tmp/HQ"}"#), None);
        assert_eq!(hq_work_handoff_choice("{}"), None);
        // Unparseable is "no explicit choice", never a silent opt-out.
        assert_eq!(hq_work_handoff_choice("not-json"), None);
        // Untyped fallback, so unrelated schema drift cannot hide the key.
        assert_eq!(
            hq_work_handoff_choice(r#"{"hqWorkHandoff":false,"unknownFuture":{"x":1}}"#),
            Some(false)
        );
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
