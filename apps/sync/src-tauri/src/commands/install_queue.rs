//! Background install queue runner.
//!
//! The pure ordering, gating and manifest rules live in
//! `hq_desktop_core::install_queue`. This module runs the items: one npm
//! install at a time, network downloads beside it, a manifest write after
//! every transition, an `install-queue:progress` event for the titlebar chip,
//! a US-001 timing line and one `desktop_onboarding_step` telemetry event per
//! item.
//!
//! The onboarding deps stage calls `start_install_queue` and waits only for
//! the tool installs. The wizard's indexing and initial-sync stages run the
//! gated `search-index` and `vault-upload` items through
//! [`track_external_item`]. Embeddings run last, after the wizard is done.
//! On relaunch, [`resume_on_launch`] picks up whatever is still pending.

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Instant;

use futures_util::FutureExt;
use hq_desktop_core::install_queue::{
    self as core_queue, is_settled, plan_next, ItemOutcome, ItemState, LoadOutcome, Presence,
    QueueChoices, QueueItemId, QueueManifest, QueueStatus, INSTALL_ITEMS, SKIP_ALREADY_PRESENT,
};
#[cfg(any(not(windows), test))]
use hq_desktop_core::install_queue::SKIP_NO_HOMEBREW;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use crate::commands::install_deps::{self, OrchestratedDepRun};
use crate::commands::install_stages::OnboardingFailureScope;
use crate::first_run_timing::{InstallOutcome, InstallTimer};
use crate::util::logfile::log;

pub const PROGRESS_EVENT: &str = "install-queue:progress";
const LOG_TAG: &str = "install-queue";
const TELEMETRY_EVENT: &str = "desktop_onboarding_step";

/// Items whose failure fails the onboarding deps stage. The rest (runtime
/// hooks, Claude Code, Codex, gh) surface in the chip's attention state.
pub const REQUIRED_ITEMS: [QueueItemId; 5] = [
    QueueItemId::Node,
    QueueItemId::HqCli,
    QueueItemId::Yq,
    QueueItemId::Jq,
    QueueItemId::Qmd,
];

#[derive(Default)]
struct QueueRuntime {
    manifest: Option<QueueManifest>,
    /// True while the runner task is alive.
    active: bool,
    /// Resume reconciliation runs once per process.
    reconciled: bool,
    failure_scope: Option<OnboardingFailureScope>,
    hq_path: Option<String>,
}

fn runtime() -> &'static Mutex<QueueRuntime> {
    static RUNTIME: OnceLock<Mutex<QueueRuntime>> = OnceLock::new();
    RUNTIME.get_or_init(|| Mutex::new(QueueRuntime::default()))
}

fn lock_runtime() -> MutexGuard<'static, QueueRuntime> {
    match runtime().lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log(LOG_TAG, "queue state lock was poisoned by a panic; continuing with its last state");
            poisoned.into_inner()
        }
    }
}

fn change_sender() -> &'static watch::Sender<u64> {
    static CHANGES: OnceLock<watch::Sender<u64>> = OnceLock::new();
    CHANGES.get_or_init(|| watch::channel(0u64).0)
}

fn notify() {
    change_sender().send_modify(|counter| *counter = counter.wrapping_add(1));
}

/// Wait until `pred` holds. The lock is never held across an await.
async fn wait_until(pred: impl Fn(&QueueRuntime) -> bool) {
    let mut changes = change_sender().subscribe();
    loop {
        let ready = {
            let rt = lock_runtime();
            pred(&rt)
        };
        if ready {
            return;
        }
        if changes.changed().await.is_err() {
            log(LOG_TAG, "queue change channel closed while waiting");
            return;
        }
    }
}

fn manifest_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        Some(core_queue::manifest_path_in(&install_deps::managed_toolchain_dir()))
    }
    #[cfg(not(windows))]
    {
        let home = dirs::home_dir()?;
        Some(core_queue::manifest_path_in(&install_deps::queue_managed_toolchain_dir_in(&home)))
    }
}

fn persist(manifest: &QueueManifest) {
    let Some(path) = manifest_path() else {
        log(LOG_TAG, "manifest not saved: no home folder");
        return;
    };
    if let Err(err) = core_queue::save_manifest(&path, manifest) {
        log(LOG_TAG, &format!("manifest save failed: {err}"));
    }
}

fn read_manifest_from_disk() -> Option<QueueManifest> {
    let path = manifest_path()?;
    match core_queue::load_manifest(&path) {
        LoadOutcome::Loaded(manifest) => Some(manifest),
        // The core loader already logged why the file was unusable.
        LoadOutcome::Fresh | LoadOutcome::Corrupt(_) => None,
    }
}

fn emit_status(app: &AppHandle, status: &QueueStatus) {
    if let Err(err) = app.emit(PROGRESS_EVENT, status) {
        log(LOG_TAG, &format!("progress event emit failed: {err}"));
    }
}

fn current_status(rt: &QueueRuntime) -> QueueStatus {
    match rt.manifest.as_ref() {
        Some(manifest) => core_queue::status(manifest, rt.active),
        None => core_queue::idle_status(),
    }
}

fn presence(found: bool) -> Presence {
    if found {
        Presence::Present
    } else {
        Presence::Missing
    }
}

/// Resume probe for a `done` item. Spawns processes, so callers run it on a
/// blocking thread.
fn probe_presence(id: QueueItemId) -> Presence {
    let binary = |tool: &str| presence(install_deps::check_dep_impl(tool, None).installed);
    match id {
        QueueItemId::Node => binary("node"),
        QueueItemId::HqCli => binary("hq"),
        QueueItemId::Gh => binary("gh"),
        QueueItemId::Yq => binary("yq"),
        QueueItemId::Jq => binary("jq"),
        QueueItemId::Qmd => binary("qmd"),
        QueueItemId::ClaudeCode => presence(install_deps::claude_code_already_present().is_some()),
        QueueItemId::Codex => presence(install_deps::codex_already_present().is_some()),
        #[cfg(not(windows))]
        QueueItemId::Embeddings => match dirs::home_dir() {
            Some(home) => presence(install_deps::embeddings_runtime_present_in(&home)),
            None => Presence::Unknown,
        },
        _ => Presence::Unknown,
    }
}

/// Load the manifest into memory and reconcile it once per process. With
/// `create`, a missing or corrupt manifest starts a fresh queue. Returns
/// false when there is no queue to work with.
async fn ensure_manifest_ready(create: bool) -> bool {
    let needs_load = lock_runtime().manifest.is_none();
    if needs_load {
        let loaded = read_manifest_from_disk();
        let mut rt = lock_runtime();
        if rt.manifest.is_none() {
            match loaded {
                Some(manifest) => rt.manifest = Some(manifest),
                None if create => {
                    rt.manifest = Some(core_queue::new_manifest(QueueChoices::default()));
                    // A fresh queue has nothing to reconcile.
                    rt.reconciled = true;
                }
                None => return false,
            }
        }
    }

    let done_items: Vec<QueueItemId> = {
        let rt = lock_runtime();
        if rt.reconciled {
            return true;
        }
        match rt.manifest.as_ref() {
            Some(manifest) => manifest
                .items
                .iter()
                .filter(|record| record.state == ItemState::Done)
                .map(|record| record.id)
                .collect(),
            None => return create,
        }
    };
    let probes = match tokio::task::spawn_blocking(move || {
        done_items
            .into_iter()
            .map(|id| (id, probe_presence(id)))
            .collect::<Vec<_>>()
    })
    .await
    {
        Ok(probes) => probes,
        Err(err) => {
            log(LOG_TAG, &format!("resume probe task failed, treating done items as present: {err}"));
            Vec::new()
        }
    };

    let mut rt = lock_runtime();
    if rt.reconciled {
        return true;
    }
    rt.reconciled = true;
    let Some(manifest) = rt.manifest.as_mut() else {
        return create;
    };
    let reset = core_queue::reconcile_on_resume(manifest, |id| {
        probes
            .iter()
            .find(|(probed, _)| *probed == id)
            .map(|(_, presence)| *presence)
            .unwrap_or(Presence::Unknown)
    });
    if !reset.is_empty() {
        let ids: Vec<&str> = reset.iter().map(|id| id.as_str()).collect();
        log(LOG_TAG, &format!("resume reset {} item(s) to pending: {}", ids.len(), ids.join(", ")));
        persist(manifest);
    }
    true
}

/// Start the runner task unless one is already alive.
fn spawn_runner(app: &AppHandle) {
    {
        let mut rt = lock_runtime();
        if rt.active || rt.manifest.is_none() {
            return;
        }
        rt.active = true;
    }
    notify();
    let app = app.clone();
    tauri::async_runtime::spawn(run_queue(app));
}

async fn run_queue(app: AppHandle) {
    crate::commands::lifecycle::set_first_run_background_setup(app.clone(), true).await;
    log(LOG_TAG, "runner started");
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        let launch = {
            let mut rt = lock_runtime();
            let scope = rt.failure_scope.clone();
            let hq_path = rt.hq_path.clone();
            let next = match rt.manifest.as_mut() {
                Some(manifest) => {
                    let next = plan_next(manifest);
                    for &id in &next {
                        manifest.mark_running(id);
                    }
                    if !next.is_empty() {
                        persist(manifest);
                    }
                    next
                }
                None => Vec::new(),
            };
            if next.is_empty() && tasks.is_empty() {
                // Cleared under the same lock as the last plan, so a finish
                // recorded after this point always sees an inactive runner
                // and starts a new one.
                rt.active = false;
                None
            } else {
                Some((next, scope, hq_path, current_status(&rt)))
            }
        };
        let Some((next, scope, hq_path, status)) = launch else {
            break;
        };
        if !next.is_empty() {
            notify();
            emit_status(&app, &status);
        }
        for id in next {
            tasks.spawn(run_item(app.clone(), id, scope.clone(), hq_path.clone()));
        }
        if let Some(Err(err)) = tasks.join_next().await {
            log(LOG_TAG, &format!("queue item task ended abnormally: {err}"));
        }
    }
    notify();
    let status = current_status(&lock_runtime());
    emit_status(&app, &status);
    log(LOG_TAG, &format!("runner stopped: {} of {} settled", status.done, status.total));
    crate::commands::lifecycle::set_first_run_background_setup(app, false).await;
}

async fn run_item(
    app: AppHandle,
    id: QueueItemId,
    scope: Option<OnboardingFailureScope>,
    hq_path: Option<String>,
) {
    let timer = InstallTimer::start(&id.timing_id());
    let started = Instant::now();
    // Refresh the CLI-updater hold for every item.
    crate::commands::lifecycle::set_first_run_background_setup(app.clone(), true).await;
    let outcome = install_deps::with_onboarding_failure_scope(scope.clone(), async {
        install_deps::emit_install_line(&app, &format!("[queue] {} started", id.as_str()));
        match AssertUnwindSafe(execute_item(&app, id, scope.clone(), hq_path))
            .catch_unwind()
            .await
        {
            Ok(outcome) => outcome,
            Err(_) => ItemOutcome::Failed("installer panicked".to_string()),
        }
    })
    .await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    finish_item(&app, id, timer, &outcome, elapsed_ms);
    record_finish(&app, id, &outcome, elapsed_ms);
}

/// Timing line, log line, install line and telemetry for a finished item.
fn finish_item(app: &AppHandle, id: QueueItemId, timer: InstallTimer, outcome: &ItemOutcome, elapsed_ms: u64) {
    timer.finish(timing_outcome(outcome));
    let line = match outcome {
        ItemOutcome::Done => format!("[queue] {} done in {elapsed_ms} ms", id.as_str()),
        ItemOutcome::Skipped(reason) => format!("[queue] {} skipped ({reason})", id.as_str()),
        ItemOutcome::Failed(error) => format!("[queue] {} failed: {error}", id.as_str()),
    };
    log(LOG_TAG, &line);
    install_deps::emit_install_line(app, &line);
    crate::commands::telemetry::emit_desktop_operational_telemetry_best_effort(
        TELEMETRY_EVENT,
        telemetry_properties(id, outcome, elapsed_ms),
    );
}

fn record_finish(app: &AppHandle, id: QueueItemId, outcome: &ItemOutcome, elapsed_ms: u64) {
    let status = {
        let mut rt = lock_runtime();
        if let Some(manifest) = rt.manifest.as_mut() {
            manifest.mark_finished(id, outcome, elapsed_ms);
            persist(manifest);
        }
        current_status(&rt)
    };
    notify();
    emit_status(app, &status);
}

fn bundled_hq_cli_version() -> Option<&'static str> {
    crate::commands::bundled_hq_cli::status().and_then(|status| status.satisfied_version())
}

async fn execute_item(
    app: &AppHandle,
    id: QueueItemId,
    scope: Option<OnboardingFailureScope>,
    hq_path: Option<String>,
) -> ItemOutcome {
    match id {
        // US-006: the hq-cli bundled in the app was verified and installed at
        // launch. A missing or bad bundle leaves no status and the registry
        // install below runs.
        QueueItemId::HqCli if core_queue::hq_cli_bundled_outcome(bundled_hq_cli_version()).is_some() => {
            core_queue::hq_cli_bundled_outcome(bundled_hq_cli_version()).expect("checked by the guard")
        }
        // The GitHub CLI is optional and only installs through Homebrew. With
        // no Homebrew there is nothing to run, so the item ends as skipped and
        // nobody is told about a failure (owner feedback 14, 2026-10-15).
        #[cfg(not(windows))]
        QueueItemId::Gh if install_deps::homebrew_present().is_none() => {
            ItemOutcome::Skipped(SKIP_NO_HOMEBREW.to_string())
        }
        QueueItemId::Node | QueueItemId::HqCli | QueueItemId::Gh | QueueItemId::Yq | QueueItemId::Jq => {
            let dep_id = id.as_str();
            let required = id != QueueItemId::Gh;
            dependency_outcome(install_deps::run_queue_dependency(app, dep_id, scope, required).await)
        }
        QueueItemId::RuntimeHooks => {
            let path = match hq_path {
                Some(path) => Ok(path),
                None => crate::commands::install_directory::resolve_hq_path(),
            };
            match path {
                Ok(path) => match install_deps::configure_claude_settings_path(app.clone(), path).await {
                    Ok(_) => ItemOutcome::Done,
                    Err(err) => ItemOutcome::Failed(err),
                },
                Err(err) => ItemOutcome::Failed(err),
            }
        }
        QueueItemId::ClaudeCode => {
            if install_deps::claude_code_already_present().is_some() {
                return ItemOutcome::Skipped(SKIP_ALREADY_PRESENT.to_string());
            }
            dependency_outcome(install_deps::run_queue_dependency(app, "claude-code", scope, false).await)
        }
        QueueItemId::Codex => {
            if install_deps::codex_already_present().is_some() {
                return ItemOutcome::Skipped(SKIP_ALREADY_PRESENT.to_string());
            }
            match install_deps::install_codex(app.clone()).await {
                Ok(_) => ItemOutcome::Done,
                Err(err) => ItemOutcome::Failed(err),
            }
        }
        QueueItemId::Qmd => {
            #[cfg(not(windows))]
            {
                let _ = scope;
                match dirs::home_dir() {
                    Some(home) => unit_outcome(install_deps::install_lean_qmd(app, &home).await),
                    None => ItemOutcome::Failed("no home folder for the qmd install".to_string()),
                }
            }
            #[cfg(windows)]
            {
                dependency_outcome(install_deps::run_queue_dependency(app, "qmd", scope, true).await)
            }
        }
        QueueItemId::Embeddings => {
            #[cfg(not(windows))]
            {
                match dirs::home_dir() {
                    Some(home) => unit_outcome(install_deps::install_embeddings_runtime(app, &home).await),
                    None => ItemOutcome::Failed("no home folder for the embeddings install".to_string()),
                }
            }
            #[cfg(windows)]
            {
                ItemOutcome::Skipped("unsupported-platform".to_string())
            }
        }
        QueueItemId::SearchIndex => unit_outcome(
            crate::commands::install_stages::run_register_search_index(app.clone(), scope, Some(true)).await,
        ),
        QueueItemId::VaultUpload => {
            unit_outcome(crate::commands::install_stages::run_initial_cloud_sync(app.clone()).await)
        }
    }
}

fn dependency_outcome(result: Result<OrchestratedDepRun, String>) -> ItemOutcome {
    match result {
        Ok(OrchestratedDepRun::Installed) => ItemOutcome::Done,
        Ok(OrchestratedDepRun::AlreadySatisfied) => ItemOutcome::Skipped(SKIP_ALREADY_PRESENT.to_string()),
        Err(err) => ItemOutcome::Failed(err),
    }
}

fn unit_outcome(result: Result<(), String>) -> ItemOutcome {
    match result {
        Ok(()) => ItemOutcome::Done,
        Err(err) => ItemOutcome::Failed(err),
    }
}

fn timing_outcome(outcome: &ItemOutcome) -> InstallOutcome {
    match outcome {
        ItemOutcome::Done => InstallOutcome::Ok,
        ItemOutcome::Skipped(_) => InstallOutcome::Skipped,
        ItemOutcome::Failed(_) => InstallOutcome::Failed,
    }
}

/// Telemetry carries the step, outcome, duration and skip reason. Error
/// text stays in the local log, never in telemetry.
fn telemetry_properties(id: QueueItemId, outcome: &ItemOutcome, elapsed_ms: u64) -> Value {
    let mut properties = json!({
        "step": id.telemetry_step(),
        "outcome": match outcome {
            ItemOutcome::Done => "ok",
            ItemOutcome::Skipped(_) => "skipped",
            ItemOutcome::Failed(_) => "failed",
        },
        "durationMs": elapsed_ms,
    });
    if let ItemOutcome::Skipped(reason) = outcome {
        properties["skipReason"] = Value::String(reason.clone());
    }
    properties
}

/// Error for the deps stage when a required item among `ids` failed, is
/// blocked by a failure, or never settled. `None` means the stage passed.
fn wait_failure_message(manifest: &QueueManifest, ids: &[QueueItemId]) -> Option<String> {
    let problems: Vec<String> = ids
        .iter()
        .copied()
        .filter(|id| REQUIRED_ITEMS.contains(id))
        .filter_map(|id| {
            let record = manifest.item(id)?;
            match record.state {
                ItemState::Done | ItemState::Skipped => None,
                ItemState::Failed => Some(format!(
                    "{} failed: {}",
                    id.label(),
                    record.error.as_deref().unwrap_or("no error recorded")
                )),
                ItemState::Pending if core_queue::is_blocked(manifest, id) => {
                    Some(format!("{} waits on an install that failed", id.label()))
                }
                ItemState::Pending | ItemState::Running => Some(format!("{} did not finish", id.label())),
            }
        })
        .collect();
    if problems.is_empty() {
        None
    } else {
        Some(format!("Setup could not finish installing: {}", problems.join("; ")))
    }
}

fn parse_wait_for(wait_for: Option<Vec<String>>) -> Result<Vec<QueueItemId>, String> {
    match wait_for {
        None => Ok(INSTALL_ITEMS.to_vec()),
        Some(ids) => ids
            .iter()
            .map(|raw| QueueItemId::parse(raw).ok_or_else(|| format!("unknown install queue item: {raw}")))
            .collect(),
    }
}

/// Run a wizard stage that is also a queue item. The queue records it like
/// its own items, so the stage and the queue never run the same work at the
/// same time, and the chip and manifest stay accurate. With no queue on
/// disk (setup that predates the queue), `fut` runs as before.
pub(crate) async fn track_external_item<F>(app: &AppHandle, id: QueueItemId, fut: F) -> Result<(), String>
where
    F: Future<Output = Result<(), String>>,
{
    if !ensure_manifest_ready(false).await {
        return fut.await;
    }

    let running_now = {
        let rt = lock_runtime();
        rt.manifest.as_ref().map(|m| m.state(id) == ItemState::Running).unwrap_or(false)
    };
    if running_now {
        log(LOG_TAG, &format!("{} already running in the queue; waiting for it", id.as_str()));
        wait_until(|rt| {
            rt.manifest
                .as_ref()
                .map(|m| m.state(id) != ItemState::Running)
                .unwrap_or(true)
        })
        .await;
        let rt = lock_runtime();
        return match rt.manifest.as_ref().and_then(|m| m.item(id)) {
            Some(record) if record.state == ItemState::Failed => {
                Err(record.error.clone().unwrap_or_else(|| format!("{} failed", id.label())))
            }
            _ => Ok(()),
        };
    }

    let status = {
        let mut rt = lock_runtime();
        if let Some(manifest) = rt.manifest.as_mut() {
            manifest.release(id);
            manifest.mark_running(id);
            persist(manifest);
        }
        current_status(&rt)
    };
    notify();
    emit_status(app, &status);

    let timer = InstallTimer::start(&id.timing_id());
    let started = Instant::now();
    let result = match AssertUnwindSafe(fut).catch_unwind().await {
        Ok(result) => result,
        Err(_) => Err(format!("{} panicked", id.label())),
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let outcome = match &result {
        Ok(()) => ItemOutcome::Done,
        Err(err) => ItemOutcome::Failed(err.clone()),
    };
    finish_item(app, id, timer, &outcome, elapsed_ms);
    record_finish(app, id, &outcome, elapsed_ms);

    let more = {
        let rt = lock_runtime();
        rt.manifest.as_ref().map(|m| !plan_next(m).is_empty()).unwrap_or(false)
    };
    if more {
        spawn_runner(app);
    }
    result
}

/// Start (or join) the background install queue and wait for `wait_for`
/// (default: every tool install up to qmd) to settle. Returns an error only
/// when a required tool failed; optional items show in the chip instead.
#[tauri::command]
pub async fn start_install_queue(
    app: AppHandle,
    choices: Option<QueueChoices>,
    wait_for: Option<Vec<String>>,
    failure_scope: Option<OnboardingFailureScope>,
    hq_path: Option<String>,
) -> Result<(), String> {
    crate::scratch_build::refuse_install("start_install_queue")?;
    let wait_ids = parse_wait_for(wait_for)?;
    {
        let mut rt = lock_runtime();
        if failure_scope.is_some() {
            rt.failure_scope = failure_scope;
        }
        if hq_path.is_some() {
            rt.hq_path = hq_path;
        }
    }
    ensure_manifest_ready(true).await;
    {
        let mut rt = lock_runtime();
        if let Some(manifest) = rt.manifest.as_mut() {
            let choices = choices.unwrap_or_else(|| manifest.choices.clone());
            core_queue::apply_choices(manifest, choices);
            persist(manifest);
        }
    }
    spawn_runner(&app);

    let ids = wait_ids.clone();
    wait_until(move |rt| match rt.manifest.as_ref() {
        Some(manifest) => !rt.active || ids.iter().all(|&id| is_settled(manifest, id)),
        None => true,
    })
    .await;

    let rt = lock_runtime();
    match rt.manifest.as_ref() {
        Some(manifest) => match wait_failure_message(manifest, &wait_ids) {
            Some(message) => Err(message),
            None => Ok(()),
        },
        None => Err("install queue has no manifest".to_string()),
    }
}

/// Status for the titlebar chip. Reads the manifest from disk when the
/// queue has not run in this process yet.
#[tauri::command]
pub async fn get_install_queue_status() -> Result<QueueStatus, String> {
    {
        let rt = lock_runtime();
        if rt.manifest.is_some() {
            return Ok(current_status(&rt));
        }
    }
    let loaded = tokio::task::spawn_blocking(read_manifest_from_disk)
        .await
        .map_err(|err| format!("install queue status read failed: {err}"))?;
    Ok(match loaded {
        Some(manifest) => core_queue::status(&manifest, false),
        None => core_queue::idle_status(),
    })
}

/// Retry failed items. Gated items are released too, since the wizard that
/// would have run them may be gone.
#[tauri::command]
pub async fn retry_install_queue(app: AppHandle) -> Result<(), String> {
    crate::scratch_build::refuse_install("retry_install_queue")?;
    if !ensure_manifest_ready(false).await {
        return Err("there is no install queue to retry".to_string());
    }
    let status = {
        let mut rt = lock_runtime();
        let Some(manifest) = rt.manifest.as_mut() else {
            return Err("there is no install queue to retry".to_string());
        };
        let reset = manifest.retry_failed();
        manifest.release_all_gated();
        persist(manifest);
        let ids: Vec<&str> = reset.iter().map(|id| id.as_str()).collect();
        log(LOG_TAG, &format!("retry requested for: {}", ids.join(", ")));
        current_status(&rt)
    };
    notify();
    emit_status(&app, &status);
    spawn_runner(&app);
    Ok(())
}

/// Called once at launch. Resumes an unfinished queue in the background
/// without the setup card.
pub(crate) fn resume_on_launch(app: &AppHandle) {
    if let Err(reason) = crate::scratch_build::refuse_install("resume_install_queue") {
        log(LOG_TAG, &format!("install queue resume skipped: {reason}"));
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if !ensure_manifest_ready(false).await {
            return;
        }
        let unfinished = {
            let mut rt = lock_runtime();
            match rt.manifest.as_mut() {
                Some(manifest) if core_queue::has_unfinished_items(manifest) => {
                    manifest.release_all_gated();
                    persist(manifest);
                    true
                }
                _ => false,
            }
        };
        if unfinished {
            log(LOG_TAG, "resuming unfinished install queue after launch");
            spawn_runner(&app);
        }
    });
}

/// Startup gate helper: true when every missing core binary is still owed
/// by the queue, so launch opens the app and the queue installs it.
pub(crate) fn queue_owes_missing_tools(hq_resolved: bool, node_resolved: bool) -> bool {
    let in_memory = lock_runtime()
        .manifest
        .as_ref()
        .map(|m| core_queue::queue_owes_missing_tools(m, hq_resolved, node_resolved));
    match in_memory {
        Some(owed) => owed,
        None => read_manifest_from_disk()
            .map(|m| core_queue::queue_owes_missing_tools(&m, hq_resolved, node_resolved))
            .unwrap_or(false),
    }
}

/// The startup gate keeps a set-up verdict when the queue owes the missing
/// tools. An install that has not finished its blocking stages still gets
/// the existing NeedsInstall / InstallResume path.
pub(crate) fn startup_gate_defers_to_queue(
    state: hq_desktop_core::lifecycle::LifecycleState,
    queue_owes_missing: bool,
) -> bool {
    use hq_desktop_core::lifecycle::LifecycleState;
    queue_owes_missing
        && matches!(
            state,
            LifecycleState::SteadyState
                | LifecycleState::InstalledFirstRun
                | LifecycleState::InstalledLegacyUpdate
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_gate_defers_only_for_set_up_states_the_queue_owes() {
        use hq_desktop_core::lifecycle::LifecycleState;
        assert!(startup_gate_defers_to_queue(LifecycleState::SteadyState, true));
        assert!(startup_gate_defers_to_queue(LifecycleState::InstalledFirstRun, true));
        assert!(startup_gate_defers_to_queue(LifecycleState::InstalledLegacyUpdate, true));
        assert!(!startup_gate_defers_to_queue(LifecycleState::SteadyState, false));
        assert!(!startup_gate_defers_to_queue(LifecycleState::NeedsInstall, true));
        assert!(!startup_gate_defers_to_queue(LifecycleState::InstallResume, true));
    }

    fn manifest() -> QueueManifest {
        core_queue::new_manifest(QueueChoices::default())
    }

    #[test]
    fn status_payload_uses_camel_case_wire_keys() {
        let mut m = manifest();
        m.mark_running(QueueItemId::Node);
        let value = serde_json::to_value(core_queue::status(&m, true)).unwrap();
        assert_eq!(value["state"], "running");
        assert_eq!(value["currentId"], "node");
        assert!(value.get("current").is_some());
        assert!(value.get("done").is_some());
        assert!(value.get("total").is_some());
        assert!(value.get("failed").is_some());
        assert!(value.get("current_id").is_none());
    }

    #[test]
    fn start_args_deserialize_from_the_frontend_wire_shape() {
        // Tauri maps camelCase JS args onto these types; the queue choices and
        // failure scope must pass through unchanged.
        let choices: QueueChoices = serde_json::from_value(json!({ "tool": "codex", "codex": true })).unwrap();
        assert_eq!(choices, QueueChoices { tool: "codex".to_string(), codex: true });
        let defaulted: QueueChoices = serde_json::from_value(json!({})).unwrap();
        assert_eq!(defaulted, QueueChoices::default());

        let scope: OnboardingFailureScope = serde_json::from_value(json!({
            "setupRunId": "run-1",
            "attemptCount": 2,
            "flow": "first-run",
            "frontendSessionId": "session-1",
        }))
        .unwrap();
        assert_eq!(scope.setup_run_id, "run-1");

        let wait = parse_wait_for(Some(vec!["node".to_string(), "qmd".to_string()])).unwrap();
        assert_eq!(wait, vec![QueueItemId::Node, QueueItemId::Qmd]);
        assert_eq!(parse_wait_for(None).unwrap(), INSTALL_ITEMS.to_vec());
        assert!(parse_wait_for(Some(vec!["../etc".to_string()])).is_err());
    }

    #[test]
    fn dependency_results_map_to_queue_outcomes() {
        assert_eq!(dependency_outcome(Ok(OrchestratedDepRun::Installed)), ItemOutcome::Done);
        assert_eq!(
            dependency_outcome(Ok(OrchestratedDepRun::AlreadySatisfied)),
            ItemOutcome::Skipped(SKIP_ALREADY_PRESENT.to_string())
        );
        assert_eq!(
            dependency_outcome(Err("npm exited 1".to_string())),
            ItemOutcome::Failed("npm exited 1".to_string())
        );
        assert_eq!(timing_outcome(&ItemOutcome::Done), InstallOutcome::Ok);
        assert_eq!(timing_outcome(&ItemOutcome::Skipped("x".into())), InstallOutcome::Skipped);
        assert_eq!(timing_outcome(&ItemOutcome::Failed("x".into())), InstallOutcome::Failed);
    }

    #[test]
    fn telemetry_rows_carry_step_outcome_and_duration_without_error_text() {
        let skipped = telemetry_properties(
            QueueItemId::ClaudeCode,
            &ItemOutcome::Skipped(SKIP_ALREADY_PRESENT.to_string()),
            12,
        );
        assert_eq!(skipped["step"], "install-queue:claude-code");
        assert_eq!(skipped["outcome"], "skipped");
        assert_eq!(skipped["skipReason"], "already-present");
        assert_eq!(skipped["durationMs"], 12);

        let failed = telemetry_properties(
            QueueItemId::Qmd,
            &ItemOutcome::Failed("EACCES /Users/someone/.npm".to_string()),
            40,
        );
        assert_eq!(failed["outcome"], "failed");
        assert!(!failed.to_string().contains("/Users/someone"));
        assert!(failed.get("skipReason").is_none());

        // The sanitizer keeps every key the queue sends.
        let sanitized = crate::commands::telemetry::sanitize_desktop_properties(Some(skipped.clone()));
        assert_eq!(sanitized, skipped);
    }

    #[test]
    fn deps_stage_fails_only_for_required_items() {
        let mut m = manifest();
        for id in INSTALL_ITEMS {
            m.mark_finished(id, &ItemOutcome::Done, 1);
        }
        assert_eq!(wait_failure_message(&m, &INSTALL_ITEMS), None);

        // An optional failure (gh) leaves the stage green; the assistant reports it.
        m.mark_finished(QueueItemId::Gh, &ItemOutcome::Failed("gh download failed".into()), 1);
        assert_eq!(wait_failure_message(&m, &INSTALL_ITEMS), None);

        // gh with no Homebrew ends as skipped, with its reason in telemetry and
        // nothing in the failed list the assistant is told about.
        m.mark_finished(QueueItemId::Gh, &ItemOutcome::Skipped(SKIP_NO_HOMEBREW.to_string()), 1);
        assert_eq!(m.item(QueueItemId::Gh).unwrap().state, ItemState::Skipped);
        let props = telemetry_properties(QueueItemId::Gh, &ItemOutcome::Skipped(SKIP_NO_HOMEBREW.to_string()), 1);
        assert_eq!(props["outcome"], "skipped");
        assert_eq!(props["skipReason"], "no-homebrew");
        assert!(core_queue::status(&m, false).failed.is_empty());

        m.mark_finished(QueueItemId::Qmd, &ItemOutcome::Failed("npm exited 1".into()), 1);
        let message = wait_failure_message(&m, &INSTALL_ITEMS).unwrap();
        assert!(message.contains("npm exited 1"), "{message}");

        // A required item stuck behind a failed prerequisite is named too.
        let mut blocked = manifest();
        blocked.mark_finished(QueueItemId::Node, &ItemOutcome::Failed("download failed".into()), 1);
        let message = wait_failure_message(&blocked, &[QueueItemId::HqCli]).unwrap();
        assert!(message.contains("waits on an install that failed"), "{message}");
    }

    #[cfg(not(windows))]
    #[test]
    fn resume_probe_reports_unknown_for_items_without_a_binary() {
        assert_eq!(probe_presence(QueueItemId::SearchIndex), Presence::Unknown);
        assert_eq!(probe_presence(QueueItemId::VaultUpload), Presence::Unknown);
        assert_eq!(probe_presence(QueueItemId::RuntimeHooks), Presence::Unknown);
    }
}
