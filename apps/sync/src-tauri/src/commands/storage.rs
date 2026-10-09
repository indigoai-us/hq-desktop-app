//! Settings › Storage: how much disk HQ backups use, and pruning old ones.
//!
//! Shells out to `hq storage status --json` and `hq storage prune ... --json`.
//! The CLI owns the git and S3 work; this module only builds argv, runs the
//! command off the main thread, and parses the JSON into typed structs.
//!
//! A missing `hq` binary or a CLI that predates the `storage` command maps to
//! the `update-hq` error code so the UI can say "Update HQ to manage storage"
//! instead of showing raw CLI output.

use std::ffi::OsString;

use serde::{Deserialize, Serialize};

use crate::commands::feedback::resolve_hq_folder;
use crate::util::logfile::log;
use crate::util::paths;

/// Error code the UI maps to "Update HQ to manage storage".
pub const UPDATE_HQ_ERROR: &str = "update-hq";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct LocalTranche {
    pub id: String,
    pub label: String,
    pub from: Option<String>,
    pub to: Option<String>,
    pub commit_count: u64,
    pub est_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct LocalStorage {
    pub available: bool,
    pub reason: Option<String>,
    pub root: Option<String>,
    pub git_dir_bytes: u64,
    pub working_tree_bytes: u64,
    pub commit_count: u64,
    pub oldest_commit_at: Option<String>,
    pub newest_commit_at: Option<String>,
    pub tranches: Vec<LocalTranche>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct CloudTranche {
    pub id: String,
    pub label: String,
    pub count: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct CloudStorage {
    pub company: String,
    pub available: bool,
    pub error: Option<String>,
    pub current_bytes: u64,
    pub noncurrent_bytes: u64,
    pub noncurrent_count: u64,
    pub delete_markers: u64,
    pub tranches: Vec<CloudTranche>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct StorageStatus {
    pub local: LocalStorage,
    pub cloud: Vec<CloudStorage>,
    pub generated_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct LocalPruneResult {
    pub freed_bytes: u64,
    pub commits_removed: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct CloudPruneResult {
    pub company: String,
    pub freed_bytes: u64,
    pub deleted_count: u64,
    pub delete_markers_removed: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct PruneResult {
    pub dry_run: bool,
    pub local: Option<LocalPruneResult>,
    pub cloud: Vec<CloudPruneResult>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PruneRequest {
    /// `YYYY-MM-DD`; local snapshots older than this go.
    pub local_before: Option<String>,
    /// `YYYY-MM-DD`; old cloud file versions older than this go.
    pub cloud_before: Option<String>,
    /// Limit cloud pruning to one company.
    pub company: Option<String>,
}

fn is_iso_date(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

pub fn status_args() -> Vec<OsString> {
    ["storage", "status", "--json"]
        .iter()
        .map(OsString::from)
        .collect()
}

pub fn prune_args(req: &PruneRequest, dry_run: bool) -> Result<Vec<OsString>, String> {
    if req.local_before.is_none() && req.cloud_before.is_none() {
        return Err("nothing-selected".to_string());
    }
    let mut args: Vec<OsString> = vec!["storage".into(), "prune".into()];
    for (flag, value) in [
        ("--local-before", &req.local_before),
        ("--cloud-before", &req.cloud_before),
    ] {
        if let Some(date) = value {
            if !is_iso_date(date) {
                return Err(format!("invalid-date: {date}"));
            }
            args.push(flag.into());
            args.push(date.into());
        }
    }
    if let Some(company) = &req.company {
        args.push("--company".into());
        args.push(company.into());
    }
    args.push(if dry_run { "--dry-run" } else { "--yes" }.into());
    args.push("--json".into());
    Ok(args)
}

/// True when stderr says the CLI does not know the `storage` command.
fn is_old_cli(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("unknown command") || s.contains("unknown subcommand")
}

pub fn parse_status(stdout: &str) -> Result<StorageStatus, String> {
    serde_json::from_str(stdout.trim()).map_err(|e| format!("parse storage status: {e}"))
}

pub fn parse_prune(stdout: &str) -> Result<PruneResult, String> {
    serde_json::from_str(stdout.trim()).map_err(|e| format!("parse storage prune: {e}"))
}

async fn run_hq(args: Vec<OsString>) -> Result<String, String> {
    let hq = paths::resolve_bin("hq");
    let folder = resolve_hq_folder();
    let mut cmd = paths::tokio_spawn_command(&hq, &[]);
    let output = cmd
        .args(&args)
        .env("PATH", paths::child_path())
        .current_dir(&folder)
        .env("HQ_NO_UPDATE_CHECK", "1")
        .env("HQ_ROOT", &folder)
        .output()
        .await
        .map_err(|e| {
            log("storage", &format!("spawn hq failed: {e}"));
            UPDATE_HQ_ERROR.to_string()
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log(
            "storage",
            &format!(
                "hq storage exited {}: {}",
                output.status.code().unwrap_or(-1),
                stderr.trim()
            ),
        );
        if is_old_cli(&stderr) {
            return Err(UPDATE_HQ_ERROR.to_string());
        }
        // Prune can exit non-zero on partial failure but still report per-company
        // errors as JSON; let the caller parse it when stdout has JSON.
        if stdout.trim_start().starts_with('{') {
            return Ok(stdout);
        }
        return Err(format!("hq storage failed: {}", stderr.trim()));
    }
    Ok(stdout)
}

/// `hq storage status --json`.
#[tauri::command]
pub async fn get_storage_status() -> Result<StorageStatus, String> {
    let stdout = run_hq(status_args()).await?;
    parse_status(&stdout)
}

/// `hq storage prune ... --dry-run --json`: what would be deleted.
#[tauri::command]
pub async fn preview_storage_prune(request: PruneRequest) -> Result<PruneResult, String> {
    let stdout = run_hq(prune_args(&request, true)?).await?;
    parse_prune(&stdout)
}

/// `hq storage prune ... --yes --json`: deletes for real.
#[tauri::command]
pub async fn run_storage_prune(request: PruneRequest) -> Result<PruneResult, String> {
    log("storage", &format!("prune requested: {request:?}"));
    let stdout = run_hq(prune_args(&request, false)?).await?;
    parse_prune(&stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendered(args: &[OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    const STATUS: &str = r#"{
      "local": {"available": true, "root": "/p", "git_dir_bytes": 81927340032,
        "working_tree_bytes": 1200, "commit_count": 4200,
        "oldest_commit_at": "2025-01-01T00:00:00Z", "newest_commit_at": "2026-10-09T00:00:00Z",
        "tranches": [
          {"id": "7d", "label": "Last 7 days", "from": "2026-10-02T00:00:00Z", "to": "2026-10-09T00:00:00Z", "commit_count": 40, "est_bytes": 1000},
          {"id": "older", "label": "Older than a year", "from": "2025-01-01T00:00:00Z", "to": "2025-10-09T00:00:00Z", "commit_count": 3000, "est_bytes": 50000}
        ]},
      "cloud": [
        {"company": "indigo", "available": true, "current_bytes": 10, "noncurrent_bytes": 20,
         "noncurrent_count": 3, "delete_markers": 2,
         "tranches": [{"id": "7d", "label": "Last 7 days", "count": 1, "bytes": 5}]},
        {"company": "acme", "available": false, "error": "access denied"}
      ],
      "generated_at": "2026-10-09T12:00:00Z"
    }"#;

    #[test]
    fn parses_full_status() {
        let s = parse_status(STATUS).unwrap();
        assert!(s.local.available);
        assert_eq!(s.local.git_dir_bytes, 81_927_340_032);
        assert_eq!(s.local.tranches.len(), 2);
        assert_eq!(s.local.tranches[1].id, "older");
        assert_eq!(s.local.tranches[1].commit_count, 3000);
        assert_eq!(s.cloud.len(), 2);
        assert_eq!(s.cloud[0].delete_markers, 2);
        assert_eq!(s.cloud[0].tranches[0].bytes, 5);
        assert!(!s.cloud[1].available);
        assert_eq!(s.cloud[1].error.as_deref(), Some("access denied"));
        assert!(s.cloud[1].tranches.is_empty());
    }

    #[test]
    fn parses_unavailable_local() {
        let s = parse_status(
            r#"{"local":{"available":false,"reason":"HQ is too old"},"cloud":[],"generated_at":"x"}"#,
        )
        .unwrap();
        assert!(!s.local.available);
        assert_eq!(s.local.reason.as_deref(), Some("HQ is too old"));
        assert!(s.local.tranches.is_empty());
    }

    #[test]
    fn rejects_non_json_status() {
        assert!(parse_status("Usage: hq storage").is_err());
    }

    #[test]
    fn parses_prune_result_with_errors() {
        let r = parse_prune(
            r#"{"dry_run":false,"local":{"freed_bytes":100,"commits_removed":4},
                "cloud":[{"company":"indigo","freed_bytes":7,"deleted_count":2},
                         {"company":"acme","error":"denied"}]}"#,
        )
        .unwrap();
        assert_eq!(r.local.unwrap().freed_bytes, 100);
        assert_eq!(r.cloud[0].deleted_count, 2);
        assert_eq!(r.cloud[1].error.as_deref(), Some("denied"));
    }

    #[test]
    fn status_args_shape() {
        assert_eq!(rendered(&status_args()), ["storage", "status", "--json"]);
    }

    #[test]
    fn prune_args_preview_and_run() {
        let req = PruneRequest {
            local_before: Some("2026-09-01".into()),
            cloud_before: Some("2026-07-01".into()),
            company: Some("indigo".into()),
        };
        assert_eq!(
            rendered(&prune_args(&req, true).unwrap()),
            [
                "storage", "prune", "--local-before", "2026-09-01", "--cloud-before",
                "2026-07-01", "--company", "indigo", "--dry-run", "--json"
            ]
        );
        let run = rendered(&prune_args(&req, false).unwrap());
        assert!(run.contains(&"--yes".to_string()));
        assert!(!run.contains(&"--dry-run".to_string()));
    }

    #[test]
    fn prune_args_requires_a_cutoff_and_valid_dates() {
        assert!(prune_args(&PruneRequest::default(), true).is_err());
        let bad = PruneRequest {
            local_before: Some("2026-9-1; rm".into()),
            ..Default::default()
        };
        assert!(prune_args(&bad, true).is_err());
        let local_only = PruneRequest {
            local_before: Some("2026-09-01".into()),
            ..Default::default()
        };
        let args = rendered(&prune_args(&local_only, false).unwrap());
        assert!(!args.contains(&"--cloud-before".to_string()));
    }

    #[test]
    fn old_cli_detection() {
        assert!(is_old_cli("error: unknown command 'storage'"));
        assert!(!is_old_cli("network timeout"));
    }
}
