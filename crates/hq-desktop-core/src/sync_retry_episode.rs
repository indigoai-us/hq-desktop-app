//! Per-root recovery episodes for the legacy desktop sync launcher.
//! No runner output is persisted. Permanent npm resolution failures require a
//! deliberate retry; transient failures retain existing backoff for five retries.
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use fs2::FileExt;
use serde::{Deserialize, Serialize};

/// Six failed launches permit the initial attempt plus five automatic retries.
/// The caller's exponential backoff covers roughly half an hour before a person
/// is asked to retry; a process/window restart must not reset this budget.
pub const MAX_FAILURES: u32 = 6;
pub const RETRY_REQUIRED: &str =
    "Automatic sync recovery stopped after a setup failure. Fix the problem, then try Sync Now again.";
pub const TERMINAL_RESOLUTION: &str = "HQ Sync could not start its sync engine because npm reported a setup or access problem. Correct the npm registry, credentials or permissions, then try Sync Now again.";
pub const TERMINAL_PERMISSION: &str = "HQ Sync cannot update its npm cache because this account cannot write to it. Fix the npm cache permissions, then try Sync Now again.";
const FILE: &str = ".hq-sync-retry.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct Episode {
    version: String,
    failures: u32,
    terminal_resolution: bool,
    // Preserve forward-compatible recovery metadata without interpreting or
    // logging its contents. The complete record remains bounded to 4096 bytes.
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

impl Episode {
    fn held(&self) -> bool {
        self.terminal_resolution || self.failures >= MAX_FAILURES
    }
}

/// Accept only npm's exact diagnostic prefix, never a bare token in a path or
/// arbitrary message. A registry/cache correction still needs an explicit retry.
pub fn terminal_resolution_failure(message: &str) -> bool {
    message == TERMINAL_RESOLUTION
        || message == TERMINAL_PERMISSION
        || terminal_npm_code(message).is_some()
}

/// Return only an authoritative permanent code on npm's diagnostic line.
pub fn terminal_npm_code(message: &str) -> Option<&str> {
    message.lines().find_map(|line| {
        let line = line.trim();
        ["npm error code ", "npm ERR! code "]
            .iter()
            .find_map(|prefix| {
                line.strip_prefix(prefix)
                    .and_then(|rest| rest.split_whitespace().next())
                    .filter(|code| {
                        matches!(
                            *code,
                            "ETARGET"
                                | "E404"
                                | "EINVALIDPACKAGENAME"
                                | "EUNSUPPORTEDPROTOCOL"
                                | "EBADENGINE"
                                | "EACCES"
                                | "E401"
                                | "E403"
                                | "ENEEDAUTH"
                        )
                    })
            })
    })
}

fn update<T>(
    root: &Path,
    version: &str,
    manual_repair: bool,
    action: impl FnOnce(&mut Episode) -> T,
) -> Result<T, String> {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join(".hq-sync-retry.lock"))
        .map_err(|e| e.to_string())?;
    // Contention is a bounded refusal, not an unbounded event-loop wait.
    lock.try_lock_exclusive()
        .map_err(|e| format!("Sync recovery state is busy: {e}"))?;
    let file = root.join(FILE);
    let mut episode = match fs::File::open(&file) {
        Ok(source) => {
            let mut bytes = Vec::new();
            source
                .take(4097)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 4096 {
                return Err("Sync recovery state exceeds the safe size limit. Preserve .hq-sync-retry.json and contact support to reset it.".into());
            }
            match (bytes.len() <= 4096).then(|| serde_json::from_slice::<Episode>(&bytes).ok()).flatten() {
                Some(episode) => episode,
                None if manual_repair => {
                    // Preserve the original bytes under the same lock. Only an
                    // explicit retry can repair unreadable state; automation fails closed.
                    let backup = tempfile::Builder::new().prefix(".hq-sync-retry-invalid-")
                        .tempfile_in(root).map_err(|e| e.to_string())?;
                    let backup_path = backup.path().to_path_buf();
                    fs::copy(&file, &backup_path).map_err(|e| e.to_string())?;
                    backup.as_file().sync_all().map_err(|e| e.to_string())?;
                    backup.keep().map_err(|e| e.to_string())?;
                    #[cfg(unix)]
                    fs::File::open(root).and_then(|dir| dir.sync_all()).map_err(|e| e.to_string())?;
                    Episode::default()
                }
                None => return Err("Sync recovery state is invalid. Try Sync Now to preserve it and start a new recovery episode.".into()),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Episode::default(),
        Err(e) => return Err(e.to_string()),
    };
    let before = serde_json::to_vec(&episode).map_err(|e| e.to_string())?;
    if episode.version != version {
        episode.version = version.to_string();
        episode.failures = 0;
        episode.terminal_resolution = false;
    }
    let result = action(&mut episode);
    let after = serde_json::to_vec(&episode).map_err(|e| e.to_string())?;
    if after == before {
        return Ok(result);
    }
    if after.len() > 4096 {
        return Err("Sync recovery metadata exceeds the safe size limit; existing state was preserved. Contact support to reset it.".into());
    }
    let mut temp = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
    temp.write_all(&after).map_err(|e| e.to_string())?;
    temp.flush().map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(&file).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    fs::File::open(root)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(result)
}

/// Check before any materialization or child launch. An explicit renderer start
/// may reset the episode, after the caller has ruled out an existing live runner.
pub fn allow_start(root: &Path, version: &str, manual_retry: bool) -> Result<bool, String> {
    update(root, version, manual_retry, |episode| {
        if manual_retry {
            episode.failures = 0;
            episode.terminal_resolution = false;
        }
        !episode.held()
    })
}

/// Content-safe reason for a persisted hold, including after process restart.
pub fn hold_reason(root: &Path, version: &str) -> Result<Option<&'static str>, String> {
    update(root, version, false, |episode| {
        if episode.terminal_resolution {
            Some(TERMINAL_RESOLUTION)
        } else if episode.held() {
            Some(RETRY_REQUIRED)
        } else {
            None
        }
    })
}

/// Read a persisted hold for a newly opened renderer, without creating a lock,
/// resetting the episode, or relying on this app process having seen the failure.
pub fn persisted_hold_reason(root: &Path, version: &str) -> Result<Option<&'static str>, String> {
    let source = match fs::File::open(root.join(FILE)) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Sync recovery state could not be read. Try Sync Now, or contact support if sync cannot restart.".into()),
    };
    let mut bytes = Vec::new();
    source.take(4097).read_to_end(&mut bytes)
        .map_err(|_| "Sync recovery state could not be read. Try Sync Now, or contact support if sync cannot restart.".to_string())?;
    if bytes.len() > 4096 {
        return Err("Sync recovery state exceeds the safe size limit. Preserve .hq-sync-retry.json and contact support to reset it.".into());
    }
    let episode: Episode = serde_json::from_slice(&bytes)
        .map_err(|_| "Sync recovery state is invalid. Try Sync Now to preserve it and start a new recovery episode.".to_string())?;
    if episode.version != version {
        return Ok(None);
    }
    Ok(if episode.terminal_resolution {
        Some(TERMINAL_RESOLUTION)
    } else if episode.held() {
        Some(RETRY_REQUIRED)
    } else {
        None
    })
}
/// Record each failed materialization/unexpected child exit, once per attempt.
pub fn record_failure(root: &Path, version: &str, message: &str) -> Result<bool, String> {
    update(root, version, false, |episode| {
        episode.failures = episode.failures.saturating_add(1);
        episode.terminal_resolution |= terminal_resolution_failure(message);
        episode.held()
    })
}

/// Only a healthy running generation clears a transient failure episode.
pub fn healthy(root: &Path, version: &str) -> Result<(), String> {
    update(root, version, false, |episode| {
        episode.failures = 0;
        episode.terminal_resolution = false;
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authoritative_npm_codes_match_only_exact_diagnostic_lines() {
        for code in [
            "ETARGET",
            "E404",
            "EINVALIDPACKAGENAME",
            "EUNSUPPORTEDPROTOCOL",
            "EBADENGINE",
            "EACCES",
            "E401",
            "E403",
            "ENEEDAUTH",
        ] {
            for prefix in ["npm error code ", "npm ERR! code "] {
                assert!(
                    terminal_resolution_failure(&format!("{prefix}{code}")),
                    "{prefix}{code}"
                );
                assert!(!terminal_resolution_failure(&format!(
                    "{prefix}{code}_OTHER"
                )));
            }
            assert!(!terminal_resolution_failure(code));
            assert!(!terminal_resolution_failure(&format!(
                "/tmp/npm error code {code}"
            )));
        }
        for code in [
            "ECONNRESET",
            "ETIMEDOUT",
            "ENOTFOUND",
            "EAI_AGAIN",
            "ECONNREFUSED",
            "EINTEGRITY",
            "EPERM",
            "EBUSY",
            "ENOSPC",
        ] {
            for prefix in ["npm error code ", "npm ERR! code "] {
                assert!(
                    !terminal_resolution_failure(&format!("{prefix}{code}")),
                    "{prefix}{code}"
                );
            }
        }
    }

    #[test]
    fn optional_and_unknown_metadata_survive_updates_and_version_reset() {
        let dir = tempfile::tempdir().unwrap();
        let metadata = serde_json::json!({"reason":"npm_setup", "detail":"safe owner detail",
            "window_started_at":1, "held_at":2, "updated_at":3,
            "future_metadata":{"schema":2}});
        let mut record = metadata.as_object().unwrap().clone();
        record.extend(
            serde_json::json!({"version":"v1", "failures":6,
            "terminal_resolution":true})
            .as_object()
            .unwrap()
            .clone(),
        );
        fs::write(dir.path().join(FILE), serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(!allow_start(dir.path(), "v1", false).unwrap());
        assert!(allow_start(dir.path(), "v1", true).unwrap());
        record_failure(dir.path(), "v1", "temporary timeout").unwrap();
        healthy(dir.path(), "v1").unwrap();
        assert!(allow_start(dir.path(), "v2", false).unwrap());
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join(FILE)).unwrap()).unwrap();
        for (key, value) in metadata.as_object().unwrap() {
            assert_eq!(&saved[key], value, "metadata key {key}");
        }
        assert_eq!(saved["version"], "v2");
        assert_eq!(saved["failures"], 0);
    }

    #[test]
    fn explicit_retry_preserves_invalid_state_before_repair() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"invalid old recovery state";
        fs::write(dir.path().join(FILE), bytes).unwrap();
        assert!(allow_start(dir.path(), "v1", false).is_err());
        assert_eq!(fs::read(dir.path().join(FILE)).unwrap(), bytes);
        assert!(allow_start(dir.path(), "v1", true).unwrap());
        let backup = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".hq-sync-retry-invalid-")
            })
            .unwrap();
        assert_eq!(fs::read(backup.path()).unwrap(), bytes);
        assert!(allow_start(dir.path(), "v1", false).unwrap());
        let oversized = vec![b'x'; 4097];
        fs::write(dir.path().join(FILE), &oversized).unwrap();
        assert!(allow_start(dir.path(), "v1", false).is_err());
        assert!(allow_start(dir.path(), "v1", true).is_err());
        assert_eq!(fs::read(dir.path().join(FILE)).unwrap(), oversized);
    }

    /// Runs the named lock-owning scenario after exec, outside the shared test
    /// process, so concurrent fork-based tests cannot inherit its lock files.
    /// Returns true in the parent once the child passed; false in the child.
    fn run_isolated(name: &str) -> bool {
        const CHILD: &str = "HQ_SYNC_RETRY_EPISODE_ISOLATED_TEST";
        if std::env::var_os(CHILD).is_some_and(|value| value == name) {
            return false;
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &format!("sync_retry_episode::tests::{name}")])
            .env(CHILD, name)
            .status()
            .unwrap();
        assert!(status.success(), "isolated {name} failed: {status}");
        true
    }

    #[test]
    fn permanent_npm_failure_stops_the_next_attempt_and_survives_reopening() {
        if run_isolated("permanent_npm_failure_stops_the_next_attempt_and_survives_reopening") {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        assert!(allow_start(dir.path(), "v1", false).unwrap());
        assert!(record_failure(dir.path(), "v1", "npm error code ETARGET\nlog path").unwrap());
        assert_eq!(
            hold_reason(dir.path(), "v1").unwrap(),
            Some(TERMINAL_RESOLUTION)
        );
        for _ in 0..100 {
            assert!(!allow_start(dir.path(), "v1", false).unwrap());
        }
        assert!(!fs::read_to_string(dir.path().join(FILE))
            .unwrap()
            .contains("log path"));
        assert!(allow_start(dir.path(), "v1", true).unwrap());
        assert!(record_failure(dir.path(), "v1", "npm ERR! code E404").unwrap());
        assert!(!allow_start(dir.path(), "v1", false).unwrap());
    }

    #[test]
    fn transient_recovery_is_bounded_and_healthy_generation_resets_the_episode() {
        let dir = tempfile::tempdir().unwrap();
        for i in 1..MAX_FAILURES {
            assert!(!record_failure(dir.path(), "v1", "network timeout").unwrap());
            assert!(allow_start(dir.path(), "v1", false).unwrap(), "attempt {i}");
        }
        healthy(dir.path(), "v1").unwrap();
        for _ in 0..MAX_FAILURES - 1 {
            assert!(!record_failure(dir.path(), "v1", "HTTP503").unwrap());
        }
        assert!(record_failure(dir.path(), "v1", "HTTP503").unwrap());
        assert!(!allow_start(dir.path(), "v1", false).unwrap());
        assert!(allow_start(dir.path(), "v2", false).unwrap());
    }

    #[test]
    fn one_permanent_failure_cannot_spawn_487_npm_attempts() {
        if run_isolated("one_permanent_failure_cannot_spawn_487_npm_attempts") {
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        assert!(allow_start(dir.path(), "v1", false).unwrap());
        assert!(record_failure(dir.path(), "v1", TERMINAL_RESOLUTION).unwrap());
        for _ in 1..487 {
            assert!(!allow_start(dir.path(), "v1", false).unwrap());
        }
    }

    #[test]
    fn subprocess_observes_persisted_hold() {
        let dir = tempfile::tempdir().unwrap();
        record_failure(dir.path(), "v1", TERMINAL_RESOLUTION).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "sync_retry_episode::tests::child_reads_hold"])
            .env("HQ_SYNC_RETRY_TEST_ROOT", dir.path())
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn child_reads_hold() {
        if let Some(root) = std::env::var_os("HQ_SYNC_RETRY_TEST_ROOT") {
            assert!(!allow_start(Path::new(&root), "v1", false).unwrap());
        }
    }

    #[test]
    fn unrelated_output_is_not_a_terminal_npm_failure() {
        for text in [
            "ETARGET",
            "/tmp/npm error code ETARGET",
            "npm error code E500",
            "npm error code E404x",
            "npm error code ECONNRESET",
        ] {
            assert!(!terminal_resolution_failure(text), "{text}");
        }
    }

    #[test]
    fn corrupt_or_locked_state_refuses_without_spawning_or_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE), "invalid").unwrap();
        assert!(allow_start(dir.path(), "v1", false).is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join(FILE)).unwrap(),
            "invalid"
        );
        fs::remove_file(dir.path().join(FILE)).unwrap();
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.path().join(".hq-sync-retry.lock"))
            .unwrap();
        lock.try_lock_exclusive().unwrap();
        assert!(allow_start(dir.path(), "v1", false).is_err());
    }
}
