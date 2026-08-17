//! Thin desktop trigger for the hq-cloud V2 first-push boundary.
//!
//! The desktop observes a local file change and sends only its canonical path,
//! operation, and (for upserts) bytes to `hq-cloud sync mutation --stdin-json`.
//! Enrollment, rollout scope, leases, revision checks, and durable retry state
//! all remain inside hq-cloud. Exit 3 is the documented closed result for an
//! unenrolled principal and permanently disables this process-local trigger.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use hq_desktop_core::hq_cloud::{
    HQ_CLOUD_PACKAGE, HQ_CLOUD_RUNNER_CAPABILITIES, HQ_CLOUD_VERSION, MUTATION_BIN,
};
use hq_desktop_core::ignore::IgnoreFilter;
use hq_desktop_core::workspaces::disabled_workspace_sync_slugs;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;
use tokio::time::timeout;

use crate::commands::daemon::resolve_hq_folder_path;
use crate::util::logfile::log;
use crate::util::paths;

const NOT_ENROLLED_EXIT: i32 = 3;
const MUTATION_TIMEOUT: Duration = Duration::from_secs(120);
const MUTATION_RETRY_DELAY: Duration = Duration::from_secs(2);

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct MutationInput {
    canonical_path: String,
    op: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_base64: Option<String>,
}

fn local_controls_allow_mutations() -> bool {
    !hq_desktop_core::daemon::is_cloud_paused()
        && hq_desktop_core::daemon::is_realtime_sync_enabled()
        && hq_desktop_core::daemon::is_instant_sync_enabled()
}

fn scope_allows_path(relative: &Path) -> bool {
    let mut components = relative.components();
    match components
        .next()
        .and_then(|component| component.as_os_str().to_str())
    {
        Some("personal") => hq_desktop_core::daemon::is_personal_sync_enabled(),
        Some("companies") => {
            let Some(slug) = components
                .next()
                .and_then(|component| component.as_os_str().to_str())
            else {
                return true;
            };
            !disabled_workspace_sync_slugs()
                .iter()
                .any(|disabled| disabled == slug)
        }
        _ => true,
    }
}

fn mutation_input(root: &Path, path: &Path) -> Option<MutationInput> {
    let relative = path.strip_prefix(root).ok()?;
    let ignore = IgnoreFilter::for_hq_root(root).ok()?;
    if relative.as_os_str().is_empty()
        || relative.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
        || relative.starts_with(".hq/realtime-mutation-state")
        || relative.starts_with(".hq/realtime-sync-state")
        || !scope_allows_path(relative)
        || !ignore.should_sync(path)
    {
        return None;
    }
    let canonical_path = relative.to_string_lossy().replace('\\', "/");
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && IgnoreFilter::within_size_limit(path) => {
            let bytes = std::fs::read(path).ok()?;
            Some(MutationInput {
                canonical_path,
                op: "upsert",
                content_base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            })
        }
        Ok(_) => None,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(MutationInput {
            canonical_path,
            op: "delete",
            content_base64: None,
        }),
        Err(_) => None,
    }
}

fn mutation_args() -> Vec<String> {
    vec![
        "-y".to_string(),
        format!("--package={}@{}", HQ_CLOUD_PACKAGE, HQ_CLOUD_VERSION),
        MUTATION_BIN.to_string(),
        "sync".to_string(),
        "mutation".to_string(),
        "--stdin-json".to_string(),
    ]
}

#[derive(Clone, Copy)]
enum MutationOutcome {
    Completed,
    Disabled,
    Retry,
}

async fn invoke_mutation(input: MutationInput) -> MutationOutcome {
    let payload = match serde_json::to_vec(&input) {
        Ok(payload) => payload,
        Err(error) => {
            log(
                "realtime-mutation",
                &format!("serialize realtime mutation: {error}"),
            );
            return MutationOutcome::Retry;
        }
    };
    let npx = paths::resolve_bin("npx");
    let mut command = paths::tokio_spawn_command(&npx, &[]);
    command
        .args(mutation_args())
        .env("PATH", paths::child_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            log(
                "realtime-mutation",
                &format!("spawn hq-cloud realtime mutation: {error}"),
            );
            return MutationOutcome::Retry;
        }
    };
    let Some(mut stdin) = child.stdin.take() else {
        log("realtime-mutation", "realtime mutation stdin pipe missing");
        return MutationOutcome::Retry;
    };
    if let Err(error) = stdin.write_all(&payload).await {
        log(
            "realtime-mutation",
            &format!("write realtime mutation stdin: {error}"),
        );
        return MutationOutcome::Retry;
    }
    drop(stdin);
    let status = match timeout(MUTATION_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            log(
                "realtime-mutation",
                &format!("wait for realtime mutation: {error}"),
            );
            return MutationOutcome::Retry;
        }
        Err(_) => {
            let _ = child.kill().await;
            log("realtime-mutation", "hq-cloud realtime mutation timed out");
            return MutationOutcome::Retry;
        }
    };
    if status.code() == Some(NOT_ENROLLED_EXIT) {
        MutationOutcome::Disabled
    } else {
        MutationOutcome::Completed
    }
}

struct MutationTrigger {
    state: Mutex<MutationTriggerState>,
    runner: Arc<Semaphore>,
}

struct MutationTriggerState {
    enabled: bool,
    in_flight: HashSet<PathBuf>,
    pending: HashSet<PathBuf>,
}

impl MutationTrigger {
    fn new() -> Self {
        Self {
            state: Mutex::new(MutationTriggerState {
                enabled: true,
                in_flight: HashSet::new(),
                pending: HashSet::new(),
            }),
            // The CLI is intentionally heavyweight. One process at a time
            // bounds Node processes and payload memory during bulk changes.
            runner: Arc::new(Semaphore::new(1)),
        }
    }

    fn try_start(&self, path: PathBuf) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !state.enabled {
            return false;
        }
        let started = state.in_flight.insert(path.clone());
        if !started {
            state.pending.insert(path);
        }
        started
    }

    fn is_enabled(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .enabled
    }

    /// Complete one submission and return whether a newer local event arrived
    /// while it was in flight. That event is re-read and submitted next, so a
    /// write cannot be lost merely because filesystem notifications coalesced.
    fn finish(&self, path: &Path, outcome: MutationOutcome) -> bool {
        let mut state = self.state.lock().expect("mutation trigger lock poisoned");
        if matches!(outcome, MutationOutcome::Disabled) {
            state.enabled = false;
            state.pending.remove(path);
            state.in_flight.remove(path);
            return false;
        }
        // Another path may have received the fail-closed exit while this
        // process was in flight. Never start its pending follow-up runner.
        if !state.enabled {
            state.pending.remove(path);
            state.in_flight.remove(path);
            return false;
        }
        if matches!(outcome, MutationOutcome::Retry) {
            return true;
        }
        if state.pending.remove(path) {
            return true;
        }
        state.in_flight.remove(path);
        false
    }

    fn cancel(&self, path: &Path) {
        let mut state = self.state.lock().expect("mutation trigger lock poisoned");
        state.pending.remove(path);
        state.in_flight.remove(path);
    }
}

static WATCHER: OnceLock<Mutex<Option<RecommendedWatcher>>> = OnceLock::new();

/// Start the local-change trigger once. The callback reads local controls for
/// every event, so Settings toggles take effect without an app restart.
/// hq-cloud makes the authoritative per-principal rollout decision.
pub fn setup_realtime_mutation_watcher(_app: &AppHandle) {
    if !HQ_CLOUD_RUNNER_CAPABILITIES.v2_mutation {
        return;
    }
    let Ok(root) = resolve_hq_folder_path().map(PathBuf::from) else {
        return;
    };
    let slot = WATCHER.get_or_init(|| Mutex::new(None));
    if slot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_some()
    {
        return;
    }

    let trigger = Arc::new(MutationTrigger::new());
    let callback_root = root.clone();
    let callback_trigger = Arc::clone(&trigger);
    let watcher = RecommendedWatcher::new(
        move |event: notify::Result<Event>| {
            let Ok(event) = event else { return };
            if !matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                return;
            }
            for path in event.paths {
                if !local_controls_allow_mutations() {
                    continue;
                }
                if !callback_trigger.try_start(path.clone()) {
                    continue;
                }
                let root = callback_root.clone();
                let trigger = Arc::clone(&callback_trigger);
                tauri::async_runtime::spawn(async move {
                    loop {
                        if !trigger.is_enabled() || !local_controls_allow_mutations() {
                            trigger.cancel(&path);
                            break;
                        }
                        // Keep this permit until after `finish`: if another
                        // mutation gets exit 3, it closes the latch before the
                        // next path can spawn its runner.
                        let Ok(permit) = trigger.runner.clone().acquire_owned().await else {
                            trigger.cancel(&path);
                            break;
                        };
                        if !trigger.is_enabled() || !local_controls_allow_mutations() {
                            trigger.cancel(&path);
                            break;
                        }
                        let outcome = match mutation_input(&root, &path) {
                            Some(input) => invoke_mutation(input).await,
                            None => MutationOutcome::Completed,
                        };
                        let retry = matches!(outcome, MutationOutcome::Retry);
                        let continue_running = trigger.finish(&path, outcome);
                        drop(permit);
                        if !continue_running {
                            break;
                        }
                        if retry {
                            tokio::time::sleep(MUTATION_RETRY_DELAY).await;
                        }
                    }
                });
            }
        },
        Config::default(),
    );
    let Ok(mut watcher) = watcher else {
        log(
            "realtime-mutation",
            "failed to create local mutation watcher",
        );
        return;
    };
    if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
        log(
            "realtime-mutation",
            "failed to watch HQ root for local mutations",
        );
        return;
    }
    *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(watcher);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn upsert_is_exact_stdin_contract() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("notes/a.md");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"hello\0").unwrap();
        let input = mutation_input(root.path(), &path).unwrap();
        assert_eq!(
            serde_json::to_string(&input).unwrap(),
            r#"{"canonicalPath":"notes/a.md","op":"upsert","contentBase64":"aGVsbG8A"}"#
        );
    }

    #[test]
    fn rereads_ignore_rules_for_each_change() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("notes/private.md");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "private").unwrap();
        assert!(mutation_input(root.path(), &path).is_some());
        std::fs::write(root.path().join(".hqignore"), "notes/private.md\n").unwrap();
        assert!(mutation_input(root.path(), &path).is_none());
    }

    #[test]
    fn skips_oversized_files_without_reading_them() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("notes/large.bin");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(hq_desktop_core::ignore::MAX_FILE_BYTES + 1)
            .unwrap();
        assert!(mutation_input(root.path(), &path).is_none());
    }

    #[test]
    fn delete_omits_content_and_closed_exit_stops_followups() {
        let trigger = MutationTrigger::new();
        let path = PathBuf::from("notes/a.md");
        assert!(trigger.try_start(path.clone()));
        assert!(!trigger.finish(&path, MutationOutcome::Disabled));
        assert!(!trigger.try_start(path));
    }

    #[test]
    fn coalesced_write_is_resubmitted_after_the_in_flight_snapshot() {
        let trigger = MutationTrigger::new();
        let path = PathBuf::from("notes/a.md");
        assert!(trigger.try_start(path.clone()));
        assert!(!trigger.try_start(path.clone()));
        assert!(trigger.finish(&path, MutationOutcome::Completed));
        assert!(!trigger.finish(&path, MutationOutcome::Completed));
    }

    #[test]
    fn exit_three_blocks_a_pending_runner_on_another_path() {
        let trigger = MutationTrigger::new();
        let first = PathBuf::from("notes/a.md");
        let second = PathBuf::from("notes/b.md");
        assert!(trigger.try_start(first.clone()));
        assert!(trigger.try_start(second.clone()));
        assert!(!trigger.try_start(second.clone()));
        assert!(!trigger.finish(&first, MutationOutcome::Disabled));
        assert!(!trigger.finish(&second, MutationOutcome::Completed));
        assert!(!trigger.try_start(second));
    }

    #[test]
    fn command_is_pinned_to_mutation_boundary() {
        assert_eq!(&mutation_args()[3..], ["sync", "mutation", "--stdin-json"]);
        assert!(mutation_args()[1].contains(&format!("@{HQ_CLOUD_VERSION}")));
    }
}
