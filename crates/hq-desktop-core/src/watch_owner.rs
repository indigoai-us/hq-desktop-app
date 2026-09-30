//! Read-only helpers for hq-cloud's per-root watch-owner lease.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha1::{Digest, Sha1};

/// First hq-cloud release that accepts the `sync-runner --owner` option (#685).
pub const OWNER_ARGUMENT_MIN_VERSION: &str = "6.18.13";

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatchOwnerStatus {
    pub owner: String,
    pub pid: u32,
    pub version: String,
    pub started_at: String,
    #[serde(default)]
    pub heartbeat_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BusyOwnerDisposition {
    DesktopOrphan,
    DesktopChild,
    Daemon,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchOwnerExitPlan {
    pub owner_label: String,
    pub classification: &'static str,
    pub take_over_orphan: bool,
    pub defer_to_daemon: bool,
    pub record_failure: bool,
    pub respawn_once: bool,
}

pub fn runner_supports_owner_argument(version: &str) -> bool {
    let version = version.strip_prefix('v').unwrap_or(version);
    let (Ok(version), Ok(minimum)) = (
        semver::Version::parse(version),
        semver::Version::parse(OWNER_ARGUMENT_MIN_VERSION),
    ) else {
        return false;
    };
    version >= minimum
}

pub fn append_desktop_owner_argument(args: &mut Vec<String>, runner_version: &str) -> bool {
    if !runner_supports_owner_argument(runner_version) {
        return false;
    }
    args.extend(["--owner".to_string(), "hq-desktop".to_string()]);
    true
}

pub fn classify_busy_owner(owner: &str, pid_is_child_of_app: bool) -> BusyOwnerDisposition {
    match owner {
        "hq-daemon" => BusyOwnerDisposition::Daemon,
        "hq-desktop" | "unknown" if pid_is_child_of_app => BusyOwnerDisposition::DesktopChild,
        "hq-desktop" | "unknown" => BusyOwnerDisposition::DesktopOrphan,
        _ => BusyOwnerDisposition::Other,
    }
}

pub fn plan_busy_watch_exit(
    exit_code: Option<i32>,
    status: Option<&WatchOwnerStatus>,
    holder_is_live_runner: bool,
    holder_is_child_of_app: bool,
) -> WatchOwnerExitPlan {
    let owner_label = status.map_or_else(|| "unknown".to_string(), |status| status.owner.clone());
    let is_busy_exit = matches!(exit_code, Some(20 | 21));
    if !is_busy_exit || !holder_is_live_runner {
        return WatchOwnerExitPlan {
            owner_label,
            classification: if is_busy_exit {
                "status_unavailable"
            } else {
                "not_lease_busy"
            },
            take_over_orphan: false,
            defer_to_daemon: false,
            record_failure: true,
            respawn_once: false,
        };
    }

    match classify_busy_owner(&owner_label, holder_is_child_of_app) {
        BusyOwnerDisposition::DesktopOrphan => WatchOwnerExitPlan {
            owner_label,
            classification: "orphan_takeover",
            take_over_orphan: true,
            defer_to_daemon: false,
            record_failure: false,
            respawn_once: true,
        },
        BusyOwnerDisposition::Daemon => WatchOwnerExitPlan {
            owner_label,
            classification: "daemon_deferral",
            take_over_orphan: false,
            defer_to_daemon: true,
            record_failure: false,
            respawn_once: false,
        },
        BusyOwnerDisposition::DesktopChild | BusyOwnerDisposition::Other => WatchOwnerExitPlan {
            owner_label,
            classification: "live_owner_deferral",
            take_over_orphan: false,
            defer_to_daemon: false,
            record_failure: false,
            respawn_once: false,
        },
    }
}

/// Match hq-cloud's `watchOwnerStatusPathFor`: `<stateDir>/locks/watch-owner-<sha1>.json`.
pub fn watch_owner_status_path(hq_root: &Path, state_dir: &Path) -> PathBuf {
    let canonical_root = std::fs::canonicalize(hq_root).unwrap_or_else(|_| hq_root.to_path_buf());
    let digest = Sha1::digest(canonical_root.to_string_lossy().as_bytes());
    let key = format!("{:x}", digest);
    state_dir
        .join("locks")
        .join(format!("watch-owner-{}.json", &key[..16]))
}

pub fn read_watch_owner_status(path: &Path) -> Result<Option<WatchOwnerStatus>, String> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read watch-owner status: {error}")),
    };
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| format!("parse watch-owner status: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_argument_is_gated_at_first_released_runner_version() {
        let mut old = vec!["--watch".to_string()];
        assert!(!append_desktop_owner_argument(&mut old, "6.18.12"));
        assert_eq!(old, ["--watch"]);

        let mut supported = vec!["--watch".to_string()];
        assert!(append_desktop_owner_argument(&mut supported, "6.18.13"));
        assert_eq!(supported, ["--watch", "--owner", "hq-desktop"]);
        assert!(runner_supports_owner_argument("6.18.21"));
        assert!(!runner_supports_owner_argument("unknown"));
    }

    #[test]
    fn live_holder_actions_distinguish_orphan_desktop_and_daemon_owners() {
        assert_eq!(
            classify_busy_owner("hq-desktop", false),
            BusyOwnerDisposition::DesktopOrphan
        );
        assert_eq!(
            classify_busy_owner("unknown", false),
            BusyOwnerDisposition::DesktopOrphan
        );
        assert_eq!(
            classify_busy_owner("hq-desktop", true),
            BusyOwnerDisposition::DesktopChild
        );
        assert_eq!(
            classify_busy_owner("hq-daemon", false),
            BusyOwnerDisposition::Daemon
        );
        assert_eq!(
            classify_busy_owner("other", false),
            BusyOwnerDisposition::Other
        );
    }

    #[test]
    fn status_reader_distinguishes_missing_malformed_and_valid_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("watch-owner.json");
        assert_eq!(read_watch_owner_status(&path).unwrap(), None);
        std::fs::write(&path, "not-json").unwrap();
        assert!(read_watch_owner_status(&path).is_err());
        std::fs::write(
            &path,
            r#"{"owner":"hq-daemon","pid":42,"version":"6.18.21","startedAt":"2026-09-30T00:00:00Z"}"#,
        )
        .unwrap();
        assert_eq!(
            read_watch_owner_status(&path).unwrap().unwrap().owner,
            "hq-daemon"
        );
    }

    #[test]
    fn status_path_matches_hq_cloud_lock_projection() {
        let dir = tempfile::tempdir().unwrap();
        let hq_root = dir.path().join("HQ");
        std::fs::create_dir(&hq_root).unwrap();
        let path = watch_owner_status_path(&hq_root, dir.path());
        assert_eq!(
            path.file_name().unwrap().to_string_lossy().len(),
            "watch-owner-".len() + 16 + ".json".len()
        );
        assert!(path.starts_with(dir.path().join("locks")));
    }

    fn status(owner: &str) -> WatchOwnerStatus {
        WatchOwnerStatus {
            owner: owner.to_string(),
            pid: 42,
            version: "6.18.21".to_string(),
            started_at: "2026-09-30T00:00:00Z".to_string(),
            heartbeat_at: None,
        }
    }

    #[test]
    fn exit_20_orphan_takes_over_without_recording_failure_and_respawns_once() {
        let plan = plan_busy_watch_exit(Some(20), Some(&status("unknown")), true, false);
        assert_eq!(plan.classification, "orphan_takeover");
        assert!(plan.take_over_orphan);
        assert!(plan.respawn_once);
        assert!(!plan.record_failure);
    }

    #[test]
    fn exit_20_hq_daemon_defers_without_failure_or_respawn() {
        let plan = plan_busy_watch_exit(Some(20), Some(&status("hq-daemon")), true, false);
        assert_eq!(plan.classification, "daemon_deferral");
        assert!(plan.defer_to_daemon);
        assert!(!plan.record_failure);
        assert!(!plan.respawn_once);
    }

    #[test]
    fn exit_20_unreadable_status_records_a_normal_failure() {
        let plan = plan_busy_watch_exit(Some(20), None, false, false);
        assert_eq!(plan.classification, "status_unavailable");
        assert!(plan.record_failure);
        assert!(!plan.respawn_once);
    }

    #[test]
    fn exit_21_live_app_child_is_deferred_without_takeover() {
        let plan = plan_busy_watch_exit(Some(21), Some(&status("hq-desktop")), true, true);
        assert_eq!(plan.classification, "live_owner_deferral");
        assert!(!plan.record_failure);
        assert!(!plan.take_over_orphan);
        assert!(!plan.respawn_once);
    }
}
