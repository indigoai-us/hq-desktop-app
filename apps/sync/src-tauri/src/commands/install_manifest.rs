//! Resumable onboarding install manifest.
//!
//! The old standalone installer journaled setup state into an
//! `install-manifest.json` file under the selected HQ tree. In the unified app
//! the durable resume state belongs to the app-owned config dir instead:
//! `~/.hq/install-manifest.json`.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::commands::install_directory::resolve_hq_path;
use crate::util::paths;

const SCHEMA_VERSION: u8 = 1;
const MANIFEST_FILE: &str = "install-manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ItemStatus {
    Pending,
    Running,
    Ok,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StepRecord {
    pub status: ItemStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DependencyRecord {
    pub status: ItemStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackRecord {
    pub status: ItemStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportRecord {
    pub codex_applied: bool,
    pub discovery_ok: bool,
    pub claude_counts: Option<BTreeMap<String, u64>>,
    pub total_claude_artifacts: Option<u64>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FailureRecord {
    pub stage: String,
    pub message: String,
    pub ts: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallManifest {
    pub schema_version: u8,
    pub installer_version: String,
    pub install_path: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub steps: BTreeMap<String, StepRecord>,
    pub dependencies: BTreeMap<String, DependencyRecord>,
    pub packs: BTreeMap<String, PackRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import: Option<ImportRecord>,
    pub failures: Vec<FailureRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyInput {
    pub status: ItemStatus,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInput {
    pub status: ItemStatus,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInput {
    pub codex_applied: bool,
    pub discovery_ok: bool,
    #[serde(default)]
    pub claude_counts: Option<BTreeMap<String, u64>>,
    #[serde(default)]
    pub total_claude_artifacts: Option<u64>,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn installer_version() -> String {
    env!("APP_VERSION").to_string()
}

fn manifest_path() -> Result<PathBuf, String> {
    Ok(paths::hq_config_dir()?.join(MANIFEST_FILE))
}

fn empty_manifest(install_path: String, installer_version: String) -> InstallManifest {
    InstallManifest {
        schema_version: SCHEMA_VERSION,
        installer_version,
        install_path,
        started_at: now_iso(),
        completed_at: None,
        steps: BTreeMap::new(),
        dependencies: BTreeMap::new(),
        packs: BTreeMap::new(),
        import: None,
        failures: Vec::new(),
    }
}

fn resolved_install_path() -> Result<String, String> {
    resolve_hq_path()
}

fn read_manifest_from_path(
    path: &Path,
    install_path: String,
    installer_version: String,
) -> InstallManifest {
    let Ok(raw) = fs::read_to_string(path) else {
        return empty_manifest(install_path, installer_version);
    };
    let Ok(parsed) = serde_json::from_str::<InstallManifest>(&raw) else {
        return empty_manifest(install_path, installer_version);
    };
    if parsed.schema_version != SCHEMA_VERSION {
        return empty_manifest(install_path, installer_version);
    }
    parsed
}

fn read_current_manifest() -> Result<InstallManifest, String> {
    let path = manifest_path()?;
    Ok(read_manifest_from_path(
        &path,
        resolved_install_path()?,
        installer_version(),
    ))
}

fn write_manifest_to_path(path: &Path, manifest: &InstallManifest) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create manifest dir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("serialize install manifest: {e}"))?
        + "\n";
    let mut file = fs::File::create(&tmp).map_err(|e| format!("stage manifest: {e}"))?;
    file.write_all(body.as_bytes())
        .map_err(|e| format!("write manifest: {e}"))?;
    file.sync_all().ok();
    fs::rename(&tmp, path).map_err(|e| format!("commit manifest: {e}"))
}

fn update_manifest<F>(mut mutate: F) -> Result<InstallManifest, String>
where
    F: FnMut(&mut InstallManifest),
{
    let path = manifest_path()?;
    let install_path = resolved_install_path()?;
    let version = installer_version();
    let mut manifest = read_manifest_from_path(&path, install_path.clone(), version.clone());
    manifest.install_path = install_path;
    manifest.installer_version = version;
    mutate(&mut manifest);
    write_manifest_to_path(&path, &manifest)?;
    Ok(manifest)
}

fn append_failure_once(manifest: &mut InstallManifest, stage: &str, message: &str) {
    let duplicate = manifest
        .failures
        .last()
        .map(|last| last.stage == stage && last.message == message)
        .unwrap_or(false);
    if duplicate {
        return;
    }
    manifest.failures.push(FailureRecord {
        stage: stage.to_string(),
        message: message.to_string(),
        ts: now_iso(),
        detail: None,
    });
}

pub fn manifest_indicates_install_in_progress(manifest: &InstallManifest) -> bool {
    manifest.completed_at.is_none()
        && manifest
            .steps
            .values()
            .any(|step| matches!(step.status, ItemStatus::Running | ItemStatus::Failed))
}

pub fn install_in_progress_from_disk() -> bool {
    let Ok(path) = manifest_path() else {
        return false;
    };
    let manifest = read_manifest_from_path(&path, String::new(), installer_version());
    manifest_indicates_install_in_progress(&manifest)
}

#[cfg(test)]
pub fn resume_start_stage(manifest: &InstallManifest, stage_order: &[&str]) -> Option<String> {
    if manifest.completed_at.is_some() {
        return None;
    }
    for stage_id in stage_order {
        match manifest.steps.get(*stage_id).map(|step| &step.status) {
            Some(ItemStatus::Ok) => {}
            _ => return Some((*stage_id).to_string()),
        }
    }
    None
}

#[tauri::command]
pub fn read_install_manifest() -> Result<InstallManifest, String> {
    read_current_manifest()
}

#[tauri::command]
pub fn record_step_start(step_id: String) -> Result<InstallManifest, String> {
    update_manifest(|manifest| {
        let now = now_iso();
        let entry = manifest.steps.entry(step_id.clone()).or_insert(StepRecord {
            status: ItemStatus::Pending,
            started_at: None,
            completed_at: None,
            error: None,
        });
        if !matches!(entry.status, ItemStatus::Running) {
            entry.started_at = Some(now);
        } else if entry.started_at.is_none() {
            entry.started_at = Some(now);
        }
        entry.status = ItemStatus::Running;
        entry.completed_at = None;
        entry.error = None;
    })
}

#[tauri::command]
pub fn record_step_ok(step_id: String) -> Result<InstallManifest, String> {
    update_manifest(|manifest| {
        let now = now_iso();
        let entry = manifest.steps.entry(step_id.clone()).or_insert(StepRecord {
            status: ItemStatus::Pending,
            started_at: None,
            completed_at: None,
            error: None,
        });
        if entry.started_at.is_none() {
            entry.started_at = Some(now.clone());
        }
        if !matches!(entry.status, ItemStatus::Ok) || entry.completed_at.is_none() {
            entry.completed_at = Some(now);
        }
        entry.status = ItemStatus::Ok;
        entry.error = None;
    })
}

#[tauri::command]
pub fn record_step_failure(step_id: String, error: String) -> Result<InstallManifest, String> {
    update_manifest(|manifest| {
        let now = now_iso();
        let entry = manifest.steps.entry(step_id.clone()).or_insert(StepRecord {
            status: ItemStatus::Pending,
            started_at: None,
            completed_at: None,
            error: None,
        });
        if entry.started_at.is_none() {
            entry.started_at = Some(now.clone());
        }
        entry.status = ItemStatus::Failed;
        entry.completed_at = Some(now);
        entry.error = Some(error.clone());
        append_failure_once(manifest, &step_id, &error);
    })
}

#[tauri::command]
pub fn record_dependencies(
    dependencies: BTreeMap<String, DependencyInput>,
) -> Result<InstallManifest, String> {
    update_manifest(|manifest| {
        for (name, record) in dependencies.clone() {
            manifest.dependencies.insert(
                name,
                DependencyRecord {
                    status: record.status,
                    version: record.version,
                    error: record.error,
                    updated_at: now_iso(),
                },
            );
        }
    })
}

#[tauri::command]
pub fn record_packs(packs: BTreeMap<String, PackInput>) -> Result<InstallManifest, String> {
    update_manifest(|manifest| {
        for (name, record) in packs.clone() {
            manifest.packs.insert(
                name,
                PackRecord {
                    status: record.status,
                    error: record.error,
                    updated_at: now_iso(),
                },
            );
        }
    })
}

#[tauri::command]
pub fn record_import(import: ImportInput) -> Result<InstallManifest, String> {
    update_manifest(|manifest| {
        manifest.import = Some(ImportRecord {
            codex_applied: import.codex_applied,
            discovery_ok: import.discovery_ok,
            claude_counts: import.claude_counts.clone(),
            total_claude_artifacts: import.total_claude_artifacts,
            updated_at: now_iso(),
        });
    })
}

#[tauri::command]
pub fn record_install_complete() -> Result<InstallManifest, String> {
    update_manifest(|manifest| {
        if manifest.completed_at.is_none() {
            manifest.completed_at = Some(now_iso());
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::test_support::ENV_MUTEX;
    use hq_desktop_core::lifecycle::{classify_lifecycle, LifecycleInputs, LifecycleState};
    use tempfile::TempDir;

    fn fresh_home() -> TempDir {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        tmp
    }

    fn with_home<F: FnOnce(&Path)>(f: F) {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let previous_home = std::env::var_os("HOME");
        let tmp = fresh_home();
        std::env::set_var("HOME", tmp.path());
        f(tmp.path());
        if let Some(home) = previous_home {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
    }

    #[test]
    fn corrupt_manifest_falls_back_to_fresh_manifest() {
        with_home(|home| {
            fs::write(home.join(".hq").join(MANIFEST_FILE), b"not-json").unwrap();

            let manifest = read_install_manifest().unwrap();

            assert_eq!(manifest.schema_version, SCHEMA_VERSION);
            assert!(manifest.steps.is_empty());
            assert!(manifest.completed_at.is_none());
        });
    }

    #[test]
    fn step_updates_are_idempotent_and_preserve_one_record() {
        with_home(|_home| {
            record_step_start("content".to_string()).unwrap();
            let started_twice = record_step_start("content".to_string()).unwrap();
            assert_eq!(started_twice.steps.len(), 1);
            assert_eq!(started_twice.steps["content"].status, ItemStatus::Running);

            let ok_once = record_step_ok("content".to_string()).unwrap();
            let completed_at = ok_once.steps["content"].completed_at.clone();
            let ok_twice = record_step_ok("content".to_string()).unwrap();

            assert_eq!(ok_twice.steps.len(), 1);
            assert_eq!(ok_twice.steps["content"].status, ItemStatus::Ok);
            assert_eq!(ok_twice.steps["content"].completed_at, completed_at);
        });
    }

    #[test]
    fn resume_start_selects_first_incomplete_stage() {
        let mut manifest = empty_manifest("/tmp/HQ".to_string(), "test".to_string());
        manifest.steps.insert(
            "content".to_string(),
            StepRecord {
                status: ItemStatus::Ok,
                started_at: Some("t1".to_string()),
                completed_at: Some("t2".to_string()),
                error: None,
            },
        );
        manifest.steps.insert(
            "deps".to_string(),
            StepRecord {
                status: ItemStatus::Failed,
                started_at: Some("t3".to_string()),
                completed_at: Some("t4".to_string()),
                error: Some("boom".to_string()),
            },
        );

        assert_eq!(
            resume_start_stage(&manifest, &["content", "deps", "packages"]),
            Some("deps".to_string())
        );

        manifest.completed_at = Some("done".to_string());
        assert_eq!(
            resume_start_stage(&manifest, &["content", "deps", "packages"]),
            None
        );
    }

    #[test]
    fn partial_manifest_drives_lifecycle_install_resume() {
        let mut manifest = empty_manifest("/tmp/HQ".to_string(), "test".to_string());
        manifest.steps.insert(
            "deps".to_string(),
            StepRecord {
                status: ItemStatus::Running,
                started_at: Some("t1".to_string()),
                completed_at: None,
                error: None,
            },
        );

        let verdict = classify_lifecycle(LifecycleInputs {
            install_completed: false,
            first_run_completed: false,
            had_machine_id: false,
            config_valid: false,
            hq_root_valid: false,
            has_auth: true,
            install_in_progress: manifest_indicates_install_in_progress(&manifest),
        });

        assert_eq!(verdict.state, LifecycleState::InstallResume);
        assert!(!verdict.needs_install_backfill);
    }
}
