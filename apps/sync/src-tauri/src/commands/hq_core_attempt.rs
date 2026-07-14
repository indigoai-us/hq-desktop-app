//! Durable admission state for heavyweight hq-core rescue transitions.
//!
//! A rescue is keyed by its exact `repo@target_sha` transition. The command
//! boundary records `running`, `succeeded`, or `failed` before deciding whether
//! another invocation may allocate a safety snapshot. This keeps a hidden or
//! stale caller from silently retrying an unchanged failed target while still
//! permitting an explicit user retry from the Update pill.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

const STATE_VERSION: u32 = 1;
const RUNNING_STALE_AFTER_SECONDS: i64 = 2 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptStatus {
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttemptRecord {
    pub repo: String,
    pub target_sha: String,
    pub status: AttemptStatus,
    pub attempt_id: String,
    pub owner_pid: u32,
    pub attempt_count: u32,
    pub started_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttemptLedger {
    pub version: u32,
    #[serde(default)]
    pub attempts: BTreeMap<String, AttemptRecord>,
}

impl Default for AttemptLedger {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            attempts: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeginOutcome {
    Started(AttemptRecord),
    AlreadySucceeded(AttemptRecord),
    Blocked(String),
}

pub struct BeginRequest<'a> {
    pub repo: &'a str,
    pub target_sha: &'a str,
    pub explicit_retry: bool,
    pub reason: &'a str,
    pub attempt_id: &'a str,
    pub owner_pid: u32,
    pub now: &'a str,
}

static LEDGER_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn ledger_lock() -> &'static Mutex<()> {
    LEDGER_LOCK.get_or_init(|| Mutex::new(()))
}

fn transition_key(repo: &str, target_sha: &str) -> String {
    format!("{repo}@{target_sha}")
}

fn read_ledger(path: &Path) -> Result<AttemptLedger, String> {
    if !path.exists() {
        return Ok(AttemptLedger::default());
    }
    let body = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let ledger: AttemptLedger =
        serde_json::from_slice(&body).map_err(|e| format!("parse {}: {e}", path.display()))?;
    if ledger.version != STATE_VERSION {
        return Err(format!(
            "unsupported rescue-attempt state version {} in {}",
            ledger.version,
            path.display()
        ));
    }
    Ok(ledger)
}

fn write_ledger(path: &Path, ledger: &AttemptLedger) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create attempt-state dir {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let body = serde_json::to_vec_pretty(ledger)
        .map_err(|e| format!("serialize rescue-attempt state: {e}"))?;
    let mut file = fs::File::create(&tmp)
        .map_err(|e| format!("create attempt-state temp {}: {e}", tmp.display()))?;
    if let Err(e) = file.write_all(&body).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("write attempt-state temp {}: {e}", tmp.display()));
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!(
            "rename attempt-state temp {} to {}: {e}",
            tmp.display(),
            path.display()
        )
    })
}

fn running_attempt_is_stale(record: &AttemptRecord, now: &str) -> bool {
    let Ok(started_at) = chrono::DateTime::parse_from_rfc3339(&record.started_at) else {
        // A malformed timestamp cannot safely prove staleness. Fail closed.
        return false;
    };
    let Ok(now) = chrono::DateTime::parse_from_rfc3339(now) else {
        return false;
    };
    now.signed_duration_since(started_at).num_seconds() >= RUNNING_STALE_AFTER_SECONDS
}

/// Decide admission and persist a new `running` record when allowed.
///
/// `owner_is_alive` is injected so the state machine is deterministic in unit
/// tests. Production passes a PID liveness check.
pub fn begin_attempt<F>(
    path: &Path,
    request: BeginRequest<'_>,
    owner_is_alive: F,
) -> Result<BeginOutcome, String>
where
    F: Fn(u32) -> bool,
{
    let _guard = ledger_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut ledger = read_ledger(path)?;
    let key = transition_key(request.repo, request.target_sha);
    let previous = ledger.attempts.get(&key).cloned();

    if let Some(record) = previous.as_ref() {
        match record.status {
            AttemptStatus::Succeeded => {
                return Ok(BeginOutcome::AlreadySucceeded(record.clone()));
            }
            AttemptStatus::Failed if !request.explicit_retry => {
                return Ok(BeginOutcome::Blocked(format!(
                    "rescue for {}@{} previously failed (exit {:?}); an explicit user retry is required",
                    request.repo, request.target_sha, record.exit_code
                )));
            }
            AttemptStatus::Running => {
                let stale = running_attempt_is_stale(record, request.now);
                if owner_is_alive(record.owner_pid) && !stale {
                    return Ok(BeginOutcome::Blocked(format!(
                        "rescue for {}@{} is already running (pid {}, attempt {})",
                        request.repo, request.target_sha, record.owner_pid, record.attempt_id
                    )));
                }
                if !request.explicit_retry {
                    let state = if stale { "stale" } else { "interrupted" };
                    return Ok(BeginOutcome::Blocked(format!(
                        "rescue for {}@{} is {state}; an explicit user retry is required",
                        request.repo, request.target_sha
                    )));
                }
            }
            AttemptStatus::Failed => {}
        }
    }

    let record = AttemptRecord {
        repo: request.repo.to_string(),
        target_sha: request.target_sha.to_string(),
        status: AttemptStatus::Running,
        attempt_id: request.attempt_id.to_string(),
        owner_pid: request.owner_pid,
        attempt_count: previous
            .as_ref()
            .map(|record| record.attempt_count.saturating_add(1))
            .unwrap_or(1),
        started_at: request.now.to_string(),
        updated_at: request.now.to_string(),
        finished_at: None,
        exit_code: None,
        log_path: None,
        reason: request.reason.to_string(),
    };
    ledger.attempts.insert(key, record.clone());
    write_ledger(path, &ledger)?;
    Ok(BeginOutcome::Started(record))
}

/// Mark the matching running attempt terminal without allowing an older
/// invocation to overwrite a newer retry for the same target.
pub fn finish_attempt(
    path: &Path,
    repo: &str,
    target_sha: &str,
    attempt_id: &str,
    exit_code: i32,
    log_path: &str,
    now: &str,
) -> Result<AttemptRecord, String> {
    let _guard = ledger_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut ledger = read_ledger(path)?;
    let key = transition_key(repo, target_sha);
    let record = ledger
        .attempts
        .get_mut(&key)
        .ok_or_else(|| format!("no running rescue attempt found for {repo}@{target_sha}"))?;
    if record.attempt_id != attempt_id {
        return Err(format!(
            "attempt id mismatch for {repo}@{target_sha}: current={} finisher={attempt_id}",
            record.attempt_id
        ));
    }
    if record.status != AttemptStatus::Running {
        return Err(format!(
            "attempt {attempt_id} for {repo}@{target_sha} is already {:?}",
            record.status
        ));
    }
    record.status = if exit_code == 0 {
        AttemptStatus::Succeeded
    } else {
        AttemptStatus::Failed
    };
    record.updated_at = now.to_string();
    record.finished_at = Some(now.to_string());
    record.exit_code = Some(exit_code);
    record.log_path = Some(log_path.to_string());
    let finished = record.clone();
    write_ledger(path, &ledger)?;
    Ok(finished)
}

/// True when `pid` still identifies a live process. Production admission uses
/// this to distinguish a concurrent run from an interrupted prior app process.
pub fn owner_pid_is_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    matches!(
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
        Ok(()) | Err(nix::errno::Errno::EPERM)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request<'a>(
        repo: &'a str,
        sha: &'a str,
        explicit_retry: bool,
        id: &'a str,
        pid: u32,
        now: &'a str,
    ) -> BeginRequest<'a> {
        BeginRequest {
            repo,
            target_sha: sha,
            explicit_retry,
            reason: if explicit_retry {
                "user_update_pill"
            } else {
                "unspecified"
            },
            attempt_id: id,
            owner_pid: pid,
            now,
        }
    }

    fn read(path: &Path) -> AttemptLedger {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn first_target_is_admitted_and_persisted_running() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("attempts.json");
        let outcome = begin_attempt(
            &path,
            request(
                "indigoai-us/hq-core-staging",
                "sha-a",
                false,
                "id-1",
                10,
                "t1",
            ),
            |_| false,
        )
        .unwrap();

        let BeginOutcome::Started(record) = outcome else {
            panic!("first target must start");
        };
        assert_eq!(record.status, AttemptStatus::Running);
        assert_eq!(record.attempt_count, 1);
        assert_eq!(read(&path).attempts.len(), 1);
    }

    #[test]
    fn failed_target_blocks_implicit_retry_but_allows_explicit_user_retry() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("attempts.json");
        begin_attempt(
            &path,
            request("repo", "sha-a", false, "id-1", 10, "t1"),
            |_| false,
        )
        .unwrap();
        finish_attempt(&path, "repo", "sha-a", "id-1", 7, "/tmp/one.log", "t2").unwrap();

        let implicit = begin_attempt(
            &path,
            request("repo", "sha-a", false, "id-2", 20, "t3"),
            |_| false,
        )
        .unwrap();
        let BeginOutcome::Blocked(message) = implicit else {
            panic!("failed target must block an implicit retry");
        };
        assert!(message.contains("failed"));
        assert!(message.contains("explicit"));

        let explicit = begin_attempt(
            &path,
            request("repo", "sha-a", true, "id-3", 20, "t4"),
            |_| false,
        )
        .unwrap();
        let BeginOutcome::Started(record) = explicit else {
            panic!("explicit retry must start");
        };
        assert_eq!(record.attempt_count, 2);
        assert_eq!(record.reason, "user_update_pill");
    }

    #[test]
    fn live_running_target_blocks_even_explicit_retry() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("attempts.json");
        begin_attempt(
            &path,
            request("repo", "sha-a", false, "id-1", 10, "t1"),
            |_| false,
        )
        .unwrap();

        let outcome = begin_attempt(
            &path,
            request("repo", "sha-a", true, "id-2", 20, "t2"),
            |pid| pid == 10,
        )
        .unwrap();
        let BeginOutcome::Blocked(message) = outcome else {
            panic!("live running transition must remain single-flight");
        };
        assert!(message.contains("already running"));
        assert_eq!(
            read(&path).attempts.values().next().unwrap().attempt_id,
            "id-1"
        );
    }

    #[test]
    fn interrupted_running_target_requires_explicit_retry() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("attempts.json");
        begin_attempt(
            &path,
            request("repo", "sha-a", false, "id-1", 10, "t1"),
            |_| false,
        )
        .unwrap();

        let implicit = begin_attempt(
            &path,
            request("repo", "sha-a", false, "id-2", 20, "t2"),
            |_| false,
        )
        .unwrap();
        assert!(matches!(implicit, BeginOutcome::Blocked(_)));

        let explicit = begin_attempt(
            &path,
            request("repo", "sha-a", true, "id-3", 20, "t3"),
            |_| false,
        )
        .unwrap();
        let BeginOutcome::Started(record) = explicit else {
            panic!("explicit retry must recover an interrupted attempt");
        };
        assert_eq!(record.attempt_count, 2);
        assert_eq!(record.attempt_id, "id-3");
    }

    #[test]
    fn succeeded_target_is_an_idempotent_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("attempts.json");
        begin_attempt(
            &path,
            request("repo", "sha-a", false, "id-1", 10, "t1"),
            |_| false,
        )
        .unwrap();
        finish_attempt(&path, "repo", "sha-a", "id-1", 0, "/tmp/one.log", "t2").unwrap();

        let outcome = begin_attempt(
            &path,
            request("repo", "sha-a", true, "id-2", 20, "t3"),
            |_| false,
        )
        .unwrap();
        let BeginOutcome::AlreadySucceeded(record) = outcome else {
            panic!("succeeded target must not spawn twice");
        };
        assert_eq!(record.attempt_id, "id-1");
        assert_eq!(record.attempt_count, 1);
    }

    #[test]
    fn a_new_target_sha_is_independent() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("attempts.json");
        begin_attempt(
            &path,
            request("repo", "sha-a", false, "id-1", 10, "t1"),
            |_| false,
        )
        .unwrap();

        let outcome = begin_attempt(
            &path,
            request("repo", "sha-b", false, "id-2", 20, "t2"),
            |_| false,
        )
        .unwrap();
        assert!(matches!(outcome, BeginOutcome::Started(_)));
        assert_eq!(read(&path).attempts.len(), 2);
    }

    #[test]
    fn stale_finisher_cannot_overwrite_a_newer_retry() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("attempts.json");
        begin_attempt(
            &path,
            request("repo", "sha-a", false, "id-1", 10, "t1"),
            |_| false,
        )
        .unwrap();
        begin_attempt(
            &path,
            request("repo", "sha-a", true, "id-2", 20, "t2"),
            |_| false,
        )
        .unwrap();

        let error =
            finish_attempt(&path, "repo", "sha-a", "id-1", 0, "/tmp/stale.log", "t3").unwrap_err();
        assert!(error.contains("attempt id mismatch"));
        assert_eq!(
            read(&path).attempts.values().next().unwrap().attempt_id,
            "id-2"
        );
    }

    #[test]
    fn malformed_state_fails_closed_without_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("attempts.json");
        std::fs::write(&path, b"{not json").unwrap();

        let error = begin_attempt(
            &path,
            request("repo", "sha-a", false, "id-1", 10, "t1"),
            |_| false,
        )
        .unwrap_err();
        assert!(error.contains("parse"));
        assert_eq!(std::fs::read(&path).unwrap(), b"{not json");
    }

    #[test]
    fn rescue_attempt_contract_current_process_is_live() {
        assert!(owner_pid_is_alive(std::process::id()));
    }

    #[test]
    fn rescue_attempt_regression_stale_running_can_retry_while_app_pid_is_live() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("attempts.json");
        begin_attempt(
            &path,
            request("repo", "sha-a", false, "id-1", 10, "2026-07-14T10:00:00Z"),
            |_| false,
        )
        .unwrap();

        let outcome = begin_attempt(
            &path,
            request("repo", "sha-a", true, "id-2", 20, "2026-07-14T13:00:01Z"),
            |pid| pid == 10,
        )
        .unwrap();
        let BeginOutcome::Started(record) = outcome else {
            panic!("a stale attempt must be explicitly recoverable even while the app PID lives");
        };
        assert_eq!(record.attempt_id, "id-2");
        assert_eq!(record.attempt_count, 2);
    }
}
