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
pub fn merge_menubar_flags(path: &Path, updates: &[(&str, Value)]) -> Result<(), String> {
    let mut obj = read_menubar_obj(path);
    for (k, v) in updates {
        obj.insert((*k).to_string(), v.clone());
    }

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

/// The telemetry consent cached in `menubar.json`: the answer (tri-state) and
/// the account that gave it.
///
/// `None` for the answer means "we hold no answer" — deliberately DISTINCT from
/// `Some(false)`, which is a real opt-out. Anything replaying this record must
/// not conflate the two: it replays an answer the user gave, it never invents
/// one.
///
/// `telemetryOptInPersonUid` binds the answer to the `prs_*` that gave it.
/// `menubar.json` is a per-MACHINE file, so when two people sign in under the
/// same OS user it holds whoever answered LAST — without the binding, replaying
/// it could opt in an account that never consented.
///
/// Lives here rather than in the Tauri crate so it is testable on any host: the
/// desktop crate needs the full GTK/WebKit stack to build, this does not.
pub fn read_menubar_consent(path: &Path) -> (Option<bool>, Option<String>) {
    let obj = read_menubar_obj(path);
    let enabled = obj.get("telemetryEnabled").and_then(|v| v.as_bool());
    let person = obj
        .get("telemetryOptInPersonUid")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    (enabled, person)
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
    // that decides whether it should act, and on whose behalf.

    fn write_menubar_json(dir: &TempDir, body: &str) -> std::path::PathBuf {
        let path = dir.path().join("menubar.json");
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn consent_record_reads_answer_and_binding() {
        let dir = TempDir::new().unwrap();
        let path = write_menubar_json(
            &dir,
            r#"{"telemetryEnabled":true,"telemetryOptInPersonUid":"prs_01ABC"}"#,
        );

        let (enabled, person) = read_menubar_consent(&path);
        assert_eq!(enabled, Some(true));
        assert_eq!(person.as_deref(), Some("prs_01ABC"));
    }

    #[test]
    fn consent_record_distinguishes_opt_out_from_no_answer() {
        let dir = TempDir::new().unwrap();

        // An explicit opt-out is an ANSWER. Conflating it with "unanswered" is
        // how a real opt-out gets silently overwritten by a replay.
        let path = write_menubar_json(&dir, r#"{"telemetryEnabled":false}"#);
        assert_eq!(read_menubar_consent(&path).0, Some(false));

        // No key at all: we hold no answer and must not invent one.
        let path = write_menubar_json(&dir, r#"{"machineId":"mid"}"#);
        assert_eq!(read_menubar_consent(&path).0, None);
    }

    #[test]
    fn consent_record_ignores_unusable_values() {
        let dir = TempDir::new().unwrap();
        let path = write_menubar_json(
            &dir,
            r#"{"telemetryEnabled":"yes","telemetryOptInPersonUid":""}"#,
        );

        let (enabled, person) = read_menubar_consent(&path);
        assert_eq!(enabled, None);
        assert_eq!(person, None);
    }

    #[test]
    fn consent_record_survives_a_missing_or_corrupt_file() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            read_menubar_consent(&dir.path().join("nope.json")),
            (None, None)
        );

        let path = write_menubar_json(&dir, "{not json");
        assert_eq!(read_menubar_consent(&path), (None, None));
    }

    #[test]
    fn consent_binding_merges_without_disturbing_other_keys() {
        // The binding is what lets the hq-cloud sync runner safely replay this
        // answer later — it refuses to replay one not bound to the signed-in
        // account. Writing it must leave the rest of the file intact.
        let dir = TempDir::new().unwrap();
        let path = write_menubar_json(
            &dir,
            r#"{"machineId":"mid-keep","telemetryEnabled":true,"someFutureKey":42}"#,
        );

        merge_menubar_flags(
            &path,
            &[(
                "telemetryOptInPersonUid",
                Value::String("prs_01ABC".to_string()),
            )],
        )
        .unwrap();

        let (enabled, person) = read_menubar_consent(&path);
        assert_eq!(enabled, Some(true));
        assert_eq!(person.as_deref(), Some("prs_01ABC"));

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
