//! First-run / first-update onboarding classification + persisted flags.
//!
//! Three launch kinds, classified once at app `.setup()` time and cached in
//! Tauri managed state so the verdict is stable for the whole process:
//!
//!   - **FirstRun**       brand-new install — never run this app before.
//!   - **ExistingUpdate** a legacy user who updated to a build that has the
//!                        new onboarding flags (and so hasn't seen the
//!                        auto-sync notice yet).
//!   - **Normal**         everything after the first-run sequence completes.
//!
//! ## Why classification must run BEFORE `ensure_machine_id`
//!
//! Both FirstRun and ExistingUpdate lack the new `firstRunCompleted` flag, so
//! that flag alone can't tell them apart. The tiebreaker is `machineId`:
//! `config::ensure_machine_id` writes it to `menubar.json` on the *first ever*
//! launch, so an existing user already has it while a brand-new install does
//! not (the installer writes `hqPath` but never `machineId`). We therefore
//! snapshot the classification at the very top of `.setup()` — before
//! `ensure_machine_id` runs and populates `machineId` for everyone — and stash
//! the result in managed state.
//!
//! All writes use the same untyped-merge + atomic-rename algorithm as
//! `config::ensure_machine_id`: read `menubar.json` as an untyped `Map`, mutate
//! only the target keys, atomic-rename back. The typed `MenubarPrefs` is
//! deliberately NOT used for writes here — a typed round-trip would silently
//! drop unknown / future top-level keys.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde_json::{Map, Value};

/// How this launch was classified. Cached in managed state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchKind {
    /// Brand-new install — never run before.
    FirstRun,
    /// Legacy user updating to an onboarding-aware build.
    ExistingUpdate,
    /// First-run sequence already completed on a prior launch.
    Normal,
}

/// Pure classifier over an already-parsed `menubar.json` object. Kept
/// filesystem-free so it's directly unit-testable.
pub fn classify_from_map(obj: &Map<String, Value>) -> LaunchKind {
    let first_run_done = obj
        .get("firstRunCompleted")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if first_run_done {
        return LaunchKind::Normal;
    }
    let had_machine_id = obj
        .get("machineId")
        .and_then(Value::as_str)
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    if had_machine_id {
        LaunchKind::ExistingUpdate
    } else {
        LaunchKind::FirstRun
    }
}

/// Whether the launch should surface the main window automatically.
///
/// Fresh installs need the installer/onboarding window immediately; existing
/// users keep the tray-only launch behavior.
pub fn should_autoshow_on_launch(kind: LaunchKind) -> bool {
    kind == LaunchKind::FirstRun
}

/// True when `autoSyncNoticeShown` is explicitly `true`.
pub fn notice_shown_in_map(obj: &Map<String, Value>) -> bool {
    obj.get("autoSyncNoticeShown")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Read `menubar.json` at `path` as an untyped object. Missing / malformed /
/// non-object files degrade to an empty map (same leniency as
/// `ensure_machine_id`).
pub fn read_menubar_obj(path: &Path) -> Map<String, Value> {
    if !path.exists() {
        return Map::new();
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Untyped-merge `updates` into the `menubar.json` at `path` and atomic-rename
/// it back. Unknown / future top-level keys pass through unchanged. Mirrors the
/// `config::ensure_machine_id` write algorithm exactly.
///
/// `pub(crate)` so sibling commands (e.g. `hq_cli_update`'s per-version
/// dismissal flag) write through the same untyped-merge path instead of the
/// typed `save_settings` round-trip, which would drop any key not in
/// `MenubarPrefs`.
fn write_menubar_obj(path: &Path, obj: Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().ok();
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn merge_menubar_flags(path: &Path, updates: &[(&str, Value)]) -> Result<(), String> {
    let mut obj = read_menubar_obj(path);
    for (k, v) in updates {
        obj.insert((*k).to_string(), v.clone());
    }
    write_menubar_obj(path, obj)
}

/// Retired menubar.json key that used to pick the embedded HQ Work shell
/// versus the classic popover chat. The desktop workspace is now the only UI,
/// so an upgraded install carrying `"hqWorkHandoff": false` must not keep the
/// old surface.
pub const RETIRED_HQ_WORK_HANDOFF_KEY: &str = "hqWorkHandoff";

/// Remove top-level keys from `menubar.json`. Missing file / missing keys are
/// success (idempotent). Returns whether any named key was actually present.
pub fn remove_menubar_keys(path: &Path, keys: &[&str]) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let mut obj = read_menubar_obj(path);
    let mut changed = false;
    for key in keys {
        if obj.remove(*key).is_some() {
            changed = true;
        }
    }
    if !changed {
        return Ok(false);
    }
    write_menubar_obj(path, obj)?;
    Ok(true)
}

/// Strip the retired `hqWorkHandoff` preference so upgraded installs switch
/// to the desktop workspace even if they had opted out.
pub fn migrate_retired_hq_work_handoff(path: &Path) -> Result<bool, String> {
    remove_menubar_keys(path, &[RETIRED_HQ_WORK_HANDOFF_KEY])
}

/// A telemetry consent answer we can PROVE the user gave.
///
/// Deliberately not just `telemetryEnabled`. That key is also a settings field:
/// `get_settings` supplies `true` when it is absent, and the settings mutation
/// queue then persists the whole defaulted object the next time any unrelated
/// preference changes. So its mere presence proves nothing — replaying it would
/// manufacture consent out of a default.
///
/// `telemetryOptInAnsweredAt` is the provenance marker, written only at the
/// moment the user actually answers (the onboarding prompt or the settings
/// toggle, both of which funnel through `write_menubar_telemetry_pref`). No
/// marker, no answer, no replay.
///
/// `subject` binds the answer to the Cognito `sub` that gave it.
/// `menubar.json` is a per-MACHINE file and sign-out does NOT clear it, so if
/// one person signs out and another signs in it still holds the first person's
/// answer. Replaying an answer for a different account would opt that person in
/// without them ever seeing the prompt.
///
/// The binding is the Cognito subject rather than the `prs_*` person uid
/// specifically because the subject is known the instant the user answers — the
/// person entity may not exist yet, which is the whole reason this repair
/// exists. Binding on something unknowable at answer time would make every new
/// record unbound, and "unbound" cannot be treated as replayable: unbound
/// records are produced routinely, not just by legacy versions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenubarConsent {
    /// The recorded answer. `None` when the user has not answered.
    pub enabled: Option<bool>,
    /// Present only when the answer has provenance (was actually given).
    pub answered_at: Option<String>,
    /// Cognito `sub` of the account that gave the answer.
    pub subject: Option<String>,
    /// The `prs_*` this record has been reconciled to, once known. Consumed by
    /// the hq-cloud sync runner, which does its own account check.
    pub person_uid: Option<String>,
    /// The surface that produced the answer (`onboarding` / `settings`). Cached
    /// so an OFFLINE replay can carry the same provenance it was given with,
    /// rather than posting a version-less record that the server would read as
    /// stale and re-prompt against the very wording the person already answered.
    pub surface: Option<String>,
    /// The consent version whose wording the person was shown when they
    /// answered. Cached alongside `surface` for the same reason.
    pub consent_version: Option<u32>,
}

impl MenubarConsent {
    /// Whether this record may be replayed on behalf of the Cognito `subject`.
    ///
    /// Requires all three: a recorded answer, proof it was actually given, and
    /// a binding that names EXACTLY this account. An unbound record is not
    /// replayable — see the type docs.
    pub fn replayable_for(&self, subject: &str) -> Option<bool> {
        let enabled = self.enabled?;
        self.answered_at.as_ref()?;
        if self.subject.as_deref()? != subject {
            return None;
        }
        Some(enabled)
    }
}

/// Read the consent record out of `menubar.json`.
///
/// Lives here rather than in the Tauri crate so it is testable on any host: the
/// desktop crate needs the full GTK/WebKit stack to build, this does not.
pub fn read_menubar_consent(path: &Path) -> MenubarConsent {
    let obj = read_menubar_obj(path);
    let str_field = |key: &str| {
        obj.get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };
    MenubarConsent {
        enabled: obj.get("telemetryEnabled").and_then(|v| v.as_bool()),
        answered_at: str_field("telemetryOptInAnsweredAt"),
        subject: str_field("telemetryOptInSub"),
        person_uid: str_field("telemetryOptInPersonUid"),
        surface: str_field("telemetryOptInSurface"),
        consent_version: obj
            .get("telemetryConsentVersion")
            .and_then(|v| v.as_u64())
            .and_then(|n| u32::try_from(n).ok()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    // ── Telemetry consent record ────────────────────────────────────────────
    //
    // Onboarding posts the consent right after sign-in, before the caller's
    // person entity exists, so `/v1/usage/opt-in` 404s and the answer is lost —
    // in production that left 22 of 33 active Indigo members with no consent
    // attribute at all, against only 2 genuine opt-outs. The desktop app
    // repairs it once the entity is provisioned; these pin the record parsing
    // and the guards that decide whether a replay is allowed at all.

    fn write_menubar_json(dir: &TempDir, body: &str) -> std::path::PathBuf {
        let path = dir.path().join("menubar.json");
        fs::write(&path, body).unwrap();
        path
    }

    const ME: &str = "sub-me";

    #[test]
    fn consent_record_reads_answer_provenance_and_binding() {
        let dir = TempDir::new().unwrap();
        let path = write_menubar_json(
            &dir,
            r#"{"telemetryEnabled":true,"telemetryOptInAnsweredAt":"2026-07-27T10:00:00Z","telemetryOptInSub":"sub-me"}"#,
        );

        let c = read_menubar_consent(&path);
        assert_eq!(c.enabled, Some(true));
        assert_eq!(c.answered_at.as_deref(), Some("2026-07-27T10:00:00Z"));
        assert_eq!(c.subject.as_deref(), Some(ME));
        assert_eq!(c.replayable_for(ME), Some(true));
    }

    #[test]
    fn consent_record_reads_cached_surface_and_version_for_offline_replay() {
        // Finding #7: the cached record must carry the surface + consent version
        // so an offline replay can restate the provenance it was given against,
        // instead of posting a version-less record the server reads as stale.
        let dir = TempDir::new().unwrap();
        let path = write_menubar_json(
            &dir,
            r#"{"telemetryEnabled":true,"telemetryOptInAnsweredAt":"2026-07-27T10:00:00Z","telemetryOptInSub":"sub-me","telemetryOptInSurface":"onboarding","telemetryConsentVersion":1}"#,
        );

        let c = read_menubar_consent(&path);
        assert_eq!(c.surface.as_deref(), Some("onboarding"));
        assert_eq!(c.consent_version, Some(1));
    }

    #[test]
    fn an_explicit_opt_out_is_an_answer_and_replays_as_false() {
        // Conflating "opted out" with "unanswered" is how a real opt-out gets
        // silently converted into an opt-in.
        let dir = TempDir::new().unwrap();
        let path = write_menubar_json(
            &dir,
            r#"{"telemetryEnabled":false,"telemetryOptInAnsweredAt":"2026-07-27T10:00:00Z","telemetryOptInSub":"sub-me"}"#,
        );

        let c = read_menubar_consent(&path);
        assert_eq!(c.enabled, Some(false));
        assert_eq!(c.replayable_for(ME), Some(false));
    }

    #[test]
    fn a_defaulted_setting_without_provenance_is_not_consent() {
        // `telemetryEnabled` is ALSO a settings field: `get_settings` defaults
        // it to true and the settings queue persists the whole object on any
        // unrelated change. Without the answered-at marker its presence proves
        // nothing, and replaying it would manufacture consent from a default.
        let dir = TempDir::new().unwrap();
        let path = write_menubar_json(&dir, r#"{"telemetryEnabled":true,"syncOnLaunch":false}"#);

        let c = read_menubar_consent(&path);
        assert_eq!(c.enabled, Some(true));
        assert_eq!(c.answered_at, None);
        assert_eq!(c.replayable_for(ME), None);
    }

    #[test]
    fn an_answer_bound_to_another_account_is_never_replayable() {
        // Sign-out does not clear menubar.json, so after A signs out and B
        // signs in this file still holds A's answer. Replaying it would opt B
        // in without B ever seeing the prompt.
        let dir = TempDir::new().unwrap();
        let path = write_menubar_json(
            &dir,
            r#"{"telemetryEnabled":true,"telemetryOptInAnsweredAt":"2026-07-27T10:00:00Z","telemetryOptInSub":"sub-someone-else"}"#,
        );

        assert_eq!(read_menubar_consent(&path).replayable_for(ME), None);
    }

    #[test]
    fn an_unbound_answer_is_not_replayable() {
        let dir = TempDir::new().unwrap();
        let path = write_menubar_json(
            &dir,
            r#"{"telemetryEnabled":true,"telemetryOptInAnsweredAt":"2026-07-27T10:00:00Z"}"#,
        );

        // Unbound records are produced routinely (an answer is stamped before
        // the person entity exists), so "unbound" proves nothing about WHOSE
        // answer it is and must never be replayed.
        assert_eq!(read_menubar_consent(&path).replayable_for(ME), None);
    }

    // ── replayable_for guards, exercised directly ──────────────────────────
    //
    // AC5 of US-002: reconciliation refuses to replay an answer belonging to a
    // different account, and (via the server-side onlyIfUnset guard, checked in
    // the app crate) refuses to overwrite an answer already recorded
    // server-side. These pin the client-side half — the account-match and
    // provenance guards — directly on `replayable_for`, independent of the JSON
    // parsing above, so a refactor of one cannot silently loosen the other.

    fn answer(enabled: bool, answered_at: Option<&str>, subject: Option<&str>) -> MenubarConsent {
        MenubarConsent {
            enabled: Some(enabled),
            answered_at: answered_at.map(str::to_string),
            subject: subject.map(str::to_string),
            person_uid: None,
            surface: None,
            consent_version: None,
        }
    }

    #[test]
    fn replayable_for_matches_only_the_binding_account() {
        // Bound to A: replayable for A, refused for B. Replaying A's answer for
        // B would opt B in without B ever seeing the prompt.
        let a = answer(true, Some("2026-07-27T10:00:00Z"), Some("sub-A"));
        assert_eq!(a.replayable_for("sub-A"), Some(true));
        assert_eq!(a.replayable_for("sub-B"), None);
    }

    #[test]
    fn replayable_for_refuses_an_unbound_answer() {
        // No subject: unbound records are produced routinely (the answer is
        // stamped before the person entity exists), so "unbound" proves nothing
        // about WHOSE answer it is and must never be replayed for anyone.
        let unbound = answer(false, Some("2026-07-27T10:00:00Z"), None);
        assert_eq!(unbound.replayable_for("sub-A"), None);
    }

    #[test]
    fn replayable_for_refuses_an_answer_without_provenance() {
        // No answered_at: `telemetryEnabled` may just be a persisted settings
        // default, not a choice the person made — replaying it would manufacture
        // consent out of a default.
        let no_provenance = answer(true, None, Some("sub-A"));
        assert_eq!(no_provenance.replayable_for("sub-A"), None);
    }

    #[test]
    fn replayable_for_refuses_when_no_answer_recorded() {
        // No `enabled` at all — nothing to replay.
        let empty = MenubarConsent {
            enabled: None,
            answered_at: Some("2026-07-27T10:00:00Z".to_string()),
            subject: Some("sub-A".to_string()),
            person_uid: None,
            surface: None,
            consent_version: None,
        };
        assert_eq!(empty.replayable_for("sub-A"), None);
    }

    #[test]
    fn replayable_for_preserves_an_explicit_opt_out() {
        // A real opt-out is an answer and must replay as `false`, never be
        // conflated with "unanswered" (which would silently convert it to an
        // opt-in).
        let opt_out = answer(false, Some("2026-07-27T10:00:00Z"), Some("sub-A"));
        assert_eq!(opt_out.replayable_for("sub-A"), Some(false));
        assert_eq!(opt_out.replayable_for("sub-B"), None);
    }

    #[test]
    fn consent_record_ignores_unusable_values() {
        let dir = TempDir::new().unwrap();
        let path = write_menubar_json(
            &dir,
            r#"{"telemetryEnabled":"yes","telemetryOptInSub":"","telemetryOptInAnsweredAt":""}"#,
        );

        let c = read_menubar_consent(&path);
        assert_eq!(c.enabled, None);
        assert_eq!(c.answered_at, None);
        assert_eq!(c.subject, None);
        assert_eq!(c.replayable_for(ME), None);
    }

    #[test]
    fn consent_record_survives_a_missing_or_corrupt_file() {
        let dir = TempDir::new().unwrap();
        let empty = MenubarConsent {
            enabled: None,
            answered_at: None,
            subject: None,
            person_uid: None,
            surface: None,
            consent_version: None,
        };
        assert_eq!(read_menubar_consent(&dir.path().join("nope.json")), empty);

        let path = write_menubar_json(&dir, "{not json");
        assert_eq!(read_menubar_consent(&path), empty);
    }

    #[test]
    fn consent_binding_merges_without_disturbing_other_keys() {
        // The binding is what lets the hq-cloud sync runner safely replay this
        // answer later — it refuses to replay one not bound to the signed-in
        // account. Writing it must leave the rest of the file intact.
        let dir = TempDir::new().unwrap();
        let path = write_menubar_json(
            &dir,
            r#"{"machineId":"mid-keep","telemetryEnabled":true,"telemetryOptInAnsweredAt":"2026-07-27T10:00:00Z","telemetryOptInSub":"sub-me","someFutureKey":42}"#,
        );

        merge_menubar_flags(
            &path,
            &[("telemetryOptInPersonUid", Value::String(ME.to_string()))],
        )
        .unwrap();

        assert_eq!(read_menubar_consent(&path).replayable_for(ME), Some(true));

        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["machineId"], "mid-keep");
        assert_eq!(v["someFutureKey"], 42);
    }

    #[test]
    fn classify_fresh_install_is_first_run() {
        // No machineId, no firstRunCompleted.
        assert_eq!(classify_from_map(&Map::new()), LaunchKind::FirstRun);
        // Installer wrote hqPath but app never ran (no machineId).
        let obj = map(json!({ "hqPath": "/Users/x/HQ" }));
        assert_eq!(classify_from_map(&obj), LaunchKind::FirstRun);
    }

    #[test]
    fn classify_existing_user_update() {
        // machineId present (app ran before), but no firstRunCompleted yet.
        let obj = map(json!({ "machineId": "abc-123" }));
        assert_eq!(classify_from_map(&obj), LaunchKind::ExistingUpdate);
    }

    #[test]
    fn classify_empty_machine_id_is_first_run() {
        let obj = map(json!({ "machineId": "" }));
        assert_eq!(classify_from_map(&obj), LaunchKind::FirstRun);
    }

    #[test]
    fn classify_completed_is_normal() {
        // Once firstRunCompleted is set, always Normal regardless of machineId.
        let obj = map(json!({ "machineId": "abc", "firstRunCompleted": true }));
        assert_eq!(classify_from_map(&obj), LaunchKind::Normal);
        let obj2 = map(json!({ "firstRunCompleted": true }));
        assert_eq!(classify_from_map(&obj2), LaunchKind::Normal);
    }

    #[test]
    fn autoshow_only_on_first_run_launches() {
        assert!(should_autoshow_on_launch(LaunchKind::FirstRun));
        assert!(!should_autoshow_on_launch(LaunchKind::ExistingUpdate));
        assert!(!should_autoshow_on_launch(LaunchKind::Normal));
    }

    #[test]
    fn notice_shown_reads_flag() {
        assert!(!notice_shown_in_map(&Map::new()));
        assert!(notice_shown_in_map(&map(
            json!({ "autoSyncNoticeShown": true })
        )));
        assert!(!notice_shown_in_map(&map(
            json!({ "autoSyncNoticeShown": false })
        )));
    }

    #[test]
    fn merge_preserves_unknown_keys_and_sets_flags() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("menubar.json");
        // Seed with a machineId + an unrelated future key.
        fs::write(&path, r#"{"machineId":"keep-me","futureKey":{"nested":1}}"#).unwrap();

        merge_menubar_flags(
            &path,
            &[
                ("firstRunCompleted", Value::Bool(true)),
                ("autoSyncNoticeShown", Value::Bool(true)),
            ],
        )
        .unwrap();

        let obj = read_menubar_obj(&path);
        // Flags written.
        assert_eq!(obj.get("firstRunCompleted"), Some(&Value::Bool(true)));
        assert_eq!(obj.get("autoSyncNoticeShown"), Some(&Value::Bool(true)));
        // Unknown keys preserved untouched.
        assert_eq!(obj.get("machineId"), Some(&Value::String("keep-me".into())));
        assert_eq!(obj.get("futureKey"), Some(&json!({ "nested": 1 })));
    }

    #[test]
    fn migrate_retired_hq_work_handoff_strips_false_and_true() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("menubar.json");
        fs::write(
            &path,
            r#"{"machineId":"keep-me","hqWorkHandoff":false,"futureKey":1}"#,
        )
        .unwrap();

        assert!(migrate_retired_hq_work_handoff(&path).unwrap());
        let obj = read_menubar_obj(&path);
        assert!(obj.get("hqWorkHandoff").is_none());
        assert_eq!(obj.get("machineId"), Some(&Value::String("keep-me".into())));
        assert_eq!(obj.get("futureKey"), Some(&json!(1)));
        // Idempotent: a second pass is a no-op.
        assert!(!migrate_retired_hq_work_handoff(&path).unwrap());
    }

    #[test]
    fn migrate_retired_hq_work_handoff_missing_file_is_ok() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("menubar.json");
        assert!(!migrate_retired_hq_work_handoff(&path).unwrap());
        assert!(!path.exists());
    }

    #[test]
    fn merge_creates_file_when_absent() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("menubar.json");
        assert!(!path.exists());
        merge_menubar_flags(&path, &[("autoSyncNoticeShown", Value::Bool(true))]).unwrap();
        assert!(notice_shown_in_map(&read_menubar_obj(&path)));
    }

    #[test]
    fn merge_then_classify_roundtrip_is_normal() {
        // After mark_first_run_complete-style write, classification flips to
        // Normal even on a fresh map.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("menubar.json");
        merge_menubar_flags(
            &path,
            &[
                ("firstRunCompleted", Value::Bool(true)),
                ("autoSyncNoticeShown", Value::Bool(true)),
                ("realtimeSync", Value::Bool(true)),
                ("personalSyncEnabled", Value::Bool(true)),
            ],
        )
        .unwrap();
        assert_eq!(
            classify_from_map(&read_menubar_obj(&path)),
            LaunchKind::Normal
        );
    }
}
