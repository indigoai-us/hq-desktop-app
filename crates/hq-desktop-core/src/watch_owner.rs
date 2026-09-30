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
        "hq-desktop" if pid_is_child_of_app => BusyOwnerDisposition::DesktopChild,
        "hq-desktop" => BusyOwnerDisposition::DesktopOrphan,
        // Older runners did not receive --owner. A live unknown runner may be
        // a manual invocation or another client, so its ancestry alone cannot
        // prove that a previous desktop session owns it.
        "unknown" => BusyOwnerDisposition::Other,
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

/// The one-shot orphan recovery uses the same settings and cloud-pause gates
/// as an ordinary supervisor respawn.
pub fn takeover_respawn_should_run(
    auto_sync_enabled: bool,
    autostart_enabled: bool,
    daemon_alive: bool,
    cloud_paused: bool,
) -> bool {
    crate::daemon::should_respawn_daemon_gated(
        auto_sync_enabled,
        autostart_enabled,
        daemon_alive,
        cloud_paused,
    )
}

/// A live lease owner the exit planner will not replace must suppress regular
/// supervisor respawns until the next bounded lease recheck.
pub fn supervisor_should_defer_for_live_owner(
    plan: &WatchOwnerExitPlan,
    holder_is_live_runner: bool,
) -> bool {
    holder_is_live_runner && !plan.take_over_orphan
}

/// Inspect a watch-owner lease only when the app runner is not already alive
/// and the normal supervisor path would otherwise respawn it. The closure is
/// deliberately lazy so a healthy registered child makes no process query.
pub fn inspect_owner_before_respawn<T, ShouldRespawn, Inspect>(
    daemon_alive: bool,
    should_respawn: ShouldRespawn,
    inspect: Inspect,
) -> Result<Option<T>, String>
where
    ShouldRespawn: FnOnce() -> bool,
    Inspect: FnOnce() -> Result<Option<T>, String>,
{
    if daemon_alive || !should_respawn() {
        return Ok(None);
    }
    inspect()
}

#[cfg(test)]
mod supervisor_preflight_tests {
    use std::cell::Cell;

    use super::inspect_owner_before_respawn;

    #[test]
    fn healthy_registered_runner_skips_owner_snapshot() {
        let calls = Cell::new(0);
        let result = inspect_owner_before_respawn(
            true,
            || true,
            || {
                calls.set(calls.get() + 1);
                Ok::<_, String>(Some(()))
            },
        )
        .unwrap();

        assert_eq!(result, None);
        assert_eq!(calls.get(), 0);
    }
}

/// Return whether a process command names the same canonical HQ root as the
/// lease lookup. This accepts symlink aliases while rejecting unrelated roots.
pub fn command_matches_hq_root(command: &str, hq_root: &Path) -> bool {
    let expected_raw = hq_root.to_string_lossy();
    if exact_hq_root_occurrence(command, &expected_raw) {
        return true;
    }
    if let Ok(canonical) = std::fs::canonicalize(hq_root) {
        if exact_hq_root_occurrence(command, &canonical.to_string_lossy()) {
            return true;
        }
    }
    let Some(root_argument) = hq_root_argument(command) else {
        return false;
    };
    let (Ok(expected), Ok(actual)) = (
        std::fs::canonicalize(hq_root),
        std::fs::canonicalize(root_argument),
    ) else {
        return false;
    };
    #[cfg(target_os = "windows")]
    {
        expected
            .to_string_lossy()
            .eq_ignore_ascii_case(&actual.to_string_lossy())
    }
    #[cfg(not(target_os = "windows"))]
    {
        expected == actual
    }
}

fn exact_hq_root_occurrence(command: &str, expected_root: &str) -> bool {
    command.match_indices("--hq-root").any(|(index, flag)| {
        let flag_is_bounded = index == 0
            || command[..index]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
        if !flag_is_bounded {
            return false;
        }
        let after_flag = index + flag.len();
        let Some(first) = command[after_flag..].chars().next() else {
            return false;
        };
        let value_start = if first == '=' {
            after_flag + 1
        } else if first.is_whitespace() {
            after_flag + command[after_flag..].len() - command[after_flag..].trim_start().len()
        } else {
            return false;
        };
        let Some(value_end) = value_start.checked_add(expected_root.len()) else {
            return false;
        };
        let Some(value) = command.get(value_start..value_end) else {
            return false;
        };
        let value_matches = {
            #[cfg(target_os = "windows")]
            {
                value.eq_ignore_ascii_case(expected_root)
            }
            #[cfg(not(target_os = "windows"))]
            {
                value == expected_root
            }
        };
        value_matches
            && command[value_end..]
                .chars()
                .next()
                .map_or(true, char::is_whitespace)
    })
}

fn hq_root_argument(command: &str) -> Option<&str> {
    let (flag_start, _) = command.match_indices("--hq-root").find(|(start, flag)| {
        let after_flag = command
            .get(start + flag.len()..)
            .and_then(|rest| rest.chars().next());
        after_flag.is_some_and(|character| character.is_whitespace() || character == '=')
    })?;
    let start = flag_start + "--hq-root".len();
    let mut rest = command.get(start..)?.trim_start();
    if let Some(value) = rest.strip_prefix('=') {
        rest = value.trim_start();
    }
    let first = rest.chars().next()?;
    if first == '"' || first == '\'' {
        let value = &rest[first.len_utf8()..];
        let end = value.find(first)?;
        Some(&value[..end])
    } else {
        rest.split_whitespace().next()
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
            BusyOwnerDisposition::Other
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
        let plan = plan_busy_watch_exit(Some(20), Some(&status("hq-desktop")), true, false);
        assert_eq!(plan.classification, "orphan_takeover");
        assert!(plan.take_over_orphan);
        assert!(plan.respawn_once);
        assert!(!plan.record_failure);
    }

    #[test]
    fn exit_20_unknown_nonchild_without_desktop_evidence_is_deferred() {
        let plan = plan_busy_watch_exit(Some(20), Some(&status("unknown")), true, false);
        assert_eq!(plan.classification, "live_owner_deferral");
        assert!(!plan.take_over_orphan);
        assert!(!plan.respawn_once);
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

    #[test]
    fn orphan_takeover_respawn_obeys_the_normal_supervisor_gates() {
        assert!(!takeover_respawn_should_run(false, false, false, false));
        assert!(!takeover_respawn_should_run(true, true, false, true));
        assert!(!takeover_respawn_should_run(true, false, true, false));
        assert!(takeover_respawn_should_run(true, true, false, false));
    }

    #[test]
    fn supervisor_defers_for_live_owners_the_exit_planner_does_not_replace() {
        let unknown = status("unknown");
        let other_plan = plan_busy_watch_exit(Some(20), Some(&unknown), true, false);
        assert!(supervisor_should_defer_for_live_owner(&other_plan, true));

        let daemon = status("hq-daemon");
        let daemon_plan = plan_busy_watch_exit(Some(20), Some(&daemon), true, false);
        assert!(supervisor_should_defer_for_live_owner(&daemon_plan, true));

        let desktop = status("hq-desktop");
        let orphan_plan = plan_busy_watch_exit(Some(20), Some(&desktop), true, false);
        assert!(!supervisor_should_defer_for_live_owner(&orphan_plan, true));
        assert!(!supervisor_should_defer_for_live_owner(&other_plan, false));
    }

    #[cfg(unix)]
    #[test]
    fn command_root_validation_accepts_a_symlink_alias_of_the_canonical_root() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = dir.path().join("real-hq");
        let alias = dir.path().join("hq-link");
        std::fs::create_dir(&canonical).unwrap();
        std::os::unix::fs::symlink(&canonical, &alias).unwrap();

        let command = format!("node sync-runner.js --hq-root {} --watch", alias.display());
        assert!(command_matches_hq_root(&command, &canonical));
        assert!(command_matches_hq_root(&command, &alias));
        assert!(!command_matches_hq_root(
            &command.replace("--hq-root", "--hq-root-other"),
            &canonical
        ));
        assert!(!command_matches_hq_root(
            &command,
            &dir.path().join("other")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn command_root_validation_rejects_hq_root_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("HQ");
        let sibling = dir.path().join("HQ2");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&sibling).unwrap();

        let command = format!(
            "node sync-runner.js --hq-root {} --watch",
            sibling.display()
        );
        assert!(!command_matches_hq_root(&command, &root));
    }

    #[cfg(unix)]
    #[test]
    fn command_root_validation_handles_spaces_and_rejects_prefix_matches() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("My HQ");
        std::fs::create_dir(&root).unwrap();

        let command = format!("node sync-runner.js --hq-root {} --watch", root.display());
        assert!(command_matches_hq_root(&command, &root));
        let equals_command = format!("node sync-runner.js --hq-root={} --watch", root.display());
        assert!(command_matches_hq_root(&equals_command, &root));

        let sibling = dir.path().join("My HQ2");
        std::fs::create_dir(&sibling).unwrap();
        let sibling_command = format!(
            "node sync-runner.js --hq-root {} --watch",
            sibling.display()
        );
        assert!(!command_matches_hq_root(&sibling_command, &root));
    }
}
