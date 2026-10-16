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

use std::cell::RefCell;
use std::collections::HashSet;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Once, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use hq_desktop_core::install_queue::{
    self as core_queue, is_settled, plan_next, ItemOutcome, ItemState, LoadOutcome, Presence,
    QueueChoices, QueueItemId, QueueManifest, QueueStatus, INSTALL_ITEMS, SKIP_ALREADY_PRESENT,
};
#[cfg(any(not(windows), test))]
use hq_desktop_core::install_queue::SKIP_NO_HOMEBREW;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use crate::commands::install_deps::{self, OrchestratedDepRun, QueueItemCancelScope};
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

/// Overall time limit for one queue item, by item class. Without it a hung
/// npm or brew child never settles, the queue stays "running" and the
/// wizard's ready scene waits forever (PR 1656 review).
///
/// - Node, yq, jq are verified downloads: 3 attempts of at most 180 s each
///   (`DOWNLOAD_ATTEMPTS`, `DOWNLOAD_ATTEMPT_TIMEOUT`) plus backoff, extract
///   and verify. 15 minutes covers that worst case with room to spare.
/// - hq-cli, Claude Code, Codex, qmd are npm installs and gh is a Homebrew
///   install, which can start with a `brew update`. These normally take one
///   to three minutes; 20 minutes allows a slow network.
/// - Runtime hooks write settings files and read the login shell PATH. That
///   takes seconds, so 5 minutes only catches a hung login shell.
/// - Embeddings install node-llama-cpp and download the local models, several
///   hundred MB. 45 minutes allows a slow connection.
/// - The search index and the first vault upload scale with the size of the
///   owner's HQ. They normally run as wizard stages; here they run only on a
///   resume or a retry. 60 minutes.
fn item_time_limit(id: QueueItemId) -> Duration {
    const MINUTE: u64 = 60;
    let minutes = match id {
        QueueItemId::Node | QueueItemId::Yq | QueueItemId::Jq => 15,
        QueueItemId::HqCli
        | QueueItemId::Gh
        | QueueItemId::ClaudeCode
        | QueueItemId::Codex
        | QueueItemId::Qmd => 20,
        QueueItemId::RuntimeHooks => 5,
        QueueItemId::Embeddings => 45,
        QueueItemId::SearchIndex | QueueItemId::VaultUpload => 60,
    };
    Duration::from_secs(minutes * MINUTE)
}

/// After a timeout the item's children get SIGTERM, then SIGKILL 2 s later
/// from the streaming loop. This is how long the queue waits for the item's
/// task to end before it records the timeout and moves on without it.
const TIMEOUT_STOP_GRACE: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
struct ItemDeadline {
    limit: Duration,
    stop_grace: Duration,
}

fn timeout_reason(limit: Duration) -> String {
    format!("installer timed out after {} min", limit.as_secs() / 60)
}

/// Items whose timed-out task has not ended yet. A new attempt of the same
/// item waits for the old one to end, so an item never runs twice at once.
fn lingering_items() -> &'static watch::Sender<HashSet<QueueItemId>> {
    static LINGERING: OnceLock<watch::Sender<HashSet<QueueItemId>>> = OnceLock::new();
    LINGERING.get_or_init(|| watch::channel(HashSet::new()).0)
}

thread_local! {
    /// The panic flag of the queue item this thread is polling, if any.
    static POLLING_ITEM_PANIC: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) };
}

/// Chain a panic hook that marks the polling item as panicked before the
/// existing hook runs. The existing hook can be slow (a backtrace capture can
/// take longer than a short deadline), and the item's task only ends after
/// it returns. The mark lets the deadline see that the item panicked.
fn install_item_panic_hook() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let _ = POLLING_ITEM_PANIC.try_with(|slot| {
                if let Ok(slot) = slot.try_borrow() {
                    if let Some(flag) = slot.as_ref() {
                        flag.store(true, Ordering::SeqCst);
                    }
                }
            });
            previous(info);
        }));
    });
}

/// Serializes tests that replace the process-wide panic hook.
///
/// A test that takes the hook, sets its own and later restores what it took
/// drops the item hook if `install_item_panic_hook` chains itself on top in
/// between: the `Once` has run, so the item hook is never installed again and
/// a panicking item settles as a timeout. Holding this guard installs the item
/// hook first, so the swap takes it and restores it, and keeps two swapping
/// tests from interleaving.
#[cfg(test)]
static PANIC_HOOK_SWAP: std::sync::RwLock<()> = std::sync::RwLock::new(());

#[cfg(test)]
fn panic_hook_swap_guard_for_test() -> std::sync::RwLockWriteGuard<'static, ()> {
    install_item_panic_hook();
    PANIC_HOOK_SWAP.write().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Held by a test whose item panics, so no hook swap runs during it.
///
/// Replacing the hook takes the standard library's hook lock for writing.
/// While another test's panic is still in its hook (a backtrace print), the
/// replacement waits, and a panic that starts after it waits too, before any
/// hook runs. The item is not marked in time and settles as a timeout.
#[cfg(test)]
fn item_panic_test_guard() -> std::sync::RwLockReadGuard<'static, ()> {
    install_item_panic_hook();
    PANIC_HOOK_SWAP.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
type PanicHook = Box<dyn Fn(&std::panic::PanicHookInfo<'_>) + Sync + Send + 'static>;

/// A test's replacement of the process-wide panic hook. It runs `observe`,
/// then the hook it replaced, and puts that hook back when dropped.
///
/// PR 1656 Windows CI: the swaps used to call the replaced hook through a
/// `Mutex`. Every panic in the test binary runs the hook, and with
/// RUST_BACKTRACE set the replaced hook prints a backtrace, which takes
/// hundreds of milliseconds. A panicking item in another test then waited
/// on that lock before the item hook could mark it, and its deadline settled
/// it as "installer timed out". This swap calls the replaced hook without a
/// lock.
#[cfg(test)]
pub(crate) struct PanicHookSwapForTest {
    previous: Option<Arc<PanicHook>>,
    _guard: std::sync::RwLockWriteGuard<'static, ()>,
}

#[cfg(test)]
pub(crate) fn swap_panic_hook_for_test(
    observe: impl Fn(&std::panic::PanicHookInfo<'_>) + Sync + Send + 'static,
) -> PanicHookSwapForTest {
    let guard = panic_hook_swap_guard_for_test();
    let previous: Arc<PanicHook> = Arc::new(std::panic::take_hook());
    let chained = Arc::clone(&previous);
    std::panic::set_hook(Box::new(move |info| {
        observe(info);
        chained(info);
    }));
    PanicHookSwapForTest { previous: Some(previous), _guard: guard }
}

#[cfg(test)]
impl Drop for PanicHookSwapForTest {
    fn drop(&mut self) {
        // Dropping the test hook releases its copy of the replaced hook.
        drop(std::panic::take_hook());
        let Some(previous) = self.previous.take() else { return };
        match Arc::try_unwrap(previous) {
            Ok(previous) => std::panic::set_hook(previous),
            Err(_) => panic!("the replaced panic hook is still shared"),
        }
    }
}

/// Polls `inner` with the item's panic flag published to the panic hook.
struct PanicMarked<F> {
    inner: Pin<Box<F>>,
    panicked: Arc<AtomicBool>,
}

impl<F: Future> Future for PanicMarked<F> {
    type Output = F::Output;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<F::Output> {
        struct Restore(Option<Arc<AtomicBool>>);
        impl Drop for Restore {
            fn drop(&mut self) {
                let previous = self.0.take();
                let _ = POLLING_ITEM_PANIC.try_with(|slot| {
                    if let Ok(mut slot) = slot.try_borrow_mut() {
                        *slot = previous;
                    }
                });
            }
        }
        let flag = Arc::clone(&self.panicked);
        let _restore = Restore(POLLING_ITEM_PANIC.with(|slot| slot.borrow_mut().replace(flag)));
        let poll = self.inner.as_mut().poll(cx);
        // Returning from poll means any panic inside it was caught there.
        self.panicked.store(false, Ordering::SeqCst);
        poll
    }
}

/// Wait until no timed-out attempt of `id` is still alive, so an item never
/// runs twice at once. Both the queue and the wizard's own run of an item
/// wait here.
async fn wait_for_previous_attempt(id: QueueItemId, mut lingering: watch::Receiver<HashSet<QueueItemId>>) {
    if lingering.borrow().contains(&id) {
        log(LOG_TAG, &format!("{} waits for its timed-out attempt to stop", id.as_str()));
    }
    let _ = lingering.wait_for(|items| !items.contains(&id)).await;
}

/// Run `work` for item `id` on its own task, bounded by `deadline.limit`.
///
/// On timeout every child process the item registered is cancelled through
/// the install cancel path and the task is aborted. The caller records the
/// returned `Failed` outcome, which is the only queue state write for this
/// attempt: the task's own result is dropped, so a late finish cannot
/// overwrite it. If the task outlives `stop_grace`, it is detached and the
/// item stays in `lingering` until it ends.
async fn run_with_deadline<F>(
    id: QueueItemId,
    deadline: ItemDeadline,
    lingering: &'static watch::Sender<HashSet<QueueItemId>>,
    work: F,
) -> ItemOutcome
where
    F: Future<Output = ItemOutcome> + Send + 'static,
{
    install_item_panic_hook();
    let cancel_scope = QueueItemCancelScope::default();
    let task_scope = cancel_scope.clone();
    let previous_attempt = lingering.subscribe();
    let panicked = Arc::new(AtomicBool::new(false));
    let mut task = tokio::spawn(PanicMarked {
        inner: Box::pin(async move {
            wait_for_previous_attempt(id, previous_attempt).await;
            task_scope.scope(work).await
        }),
        panicked: Arc::clone(&panicked),
    });

    match tokio::time::timeout(deadline.limit, &mut task).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(err)) if err.is_panic() => ItemOutcome::Failed("installer panicked".to_string()),
        Ok(Err(err)) => ItemOutcome::Failed(format!("installer task ended: {err}")),
        Err(_) => {
            let cancelled = cancel_scope.expire();
            log(
                LOG_TAG,
                &format!(
                    "{} timed out after {} s; cancelled {cancelled} running process(es)",
                    id.as_str(),
                    deadline.limit.as_secs()
                ),
            );
            task.abort();
            let ended_in_panic = match tokio::time::timeout(deadline.stop_grace, &mut task).await {
                Ok(Err(err)) => err.is_panic(),
                Ok(Ok(_)) => false,
                Err(_) => {
                    log(
                        LOG_TAG,
                        &format!("{} did not stop within {} s; detached", id.as_str(), deadline.stop_grace.as_secs()),
                    );
                    lingering.send_modify(|items| {
                        items.insert(id);
                    });
                    tokio::spawn(async move {
                        let _ = task.await;
                        lingering.send_modify(|items| {
                            items.remove(&id);
                        });
                        log(LOG_TAG, &format!("{} timed-out attempt stopped", id.as_str()));
                    });
                    false
                }
            };
            // A panic that began before or during the stop wait is the cause,
            // even when the panic hook or unwinding outlasts the deadline.
            if ended_in_panic || panicked.load(Ordering::SeqCst) {
                ItemOutcome::Failed("installer panicked".to_string())
            } else {
                ItemOutcome::Failed(timeout_reason(deadline.limit))
            }
        }
    }
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
    let work_app = app.clone();
    let work = install_deps::with_onboarding_failure_scope(scope.clone(), async move {
        install_deps::emit_install_line(&work_app, &format!("[queue] {} started", id.as_str()));
        // A panic ends the item's task; run_with_deadline maps it to Failed.
        execute_item(&work_app, id, scope, hq_path).await
    });
    let deadline = ItemDeadline {
        limit: item_time_limit(id),
        stop_grace: TIMEOUT_STOP_GRACE,
    };
    let outcome = run_with_deadline(id, deadline, lingering_items(), work).await;
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

/// How the wizard's run of a queue item found the item.
#[derive(Debug, PartialEq, Eq)]
enum ExternalClaim {
    /// The queue is running the item; the wizard waits for its result.
    AlreadyRunning,
    /// The wizard marked the item running and runs it.
    Claimed,
}

/// Check and mark the item in one step, under the caller's runtime lock, so
/// the queue and a second wizard run cannot both start it in between.
fn claim_external_item(manifest: &mut QueueManifest, id: QueueItemId) -> ExternalClaim {
    if manifest.state(id) == ItemState::Running {
        return ExternalClaim::AlreadyRunning;
    }
    manifest.release(id);
    manifest.mark_running(id);
    ExternalClaim::Claimed
}

/// The wizard's run of a queue item, bounded like the queue's own run: a hung
/// run fails with the timeout reason and its processes are cancelled.
async fn run_external_work<F>(id: QueueItemId, deadline: ItemDeadline, lingering: &'static watch::Sender<HashSet<QueueItemId>>, fut: F) -> ItemOutcome
where
    F: Future<Output = Result<(), String>> + Send + 'static,
{
    run_with_deadline(id, deadline, lingering, async move {
        match fut.await {
            Ok(()) => ItemOutcome::Done,
            Err(err) => ItemOutcome::Failed(err),
        }
    })
    .await
}

/// Run a wizard stage that is also a queue item. The queue records it like
/// its own items, so the stage and the queue never run the same work at the
/// same time, and the chip and manifest stay accurate. With no queue on
/// disk (setup that predates the queue), `fut` runs as before.
pub(crate) async fn track_external_item<F>(app: &AppHandle, id: QueueItemId, fut: F) -> Result<(), String>
where
    F: Future<Output = Result<(), String>> + Send + 'static,
{
    // A timed-out queue attempt of this item may still be stopping. Starting
    // the wizard's run beside it would run the item twice at once.
    wait_for_previous_attempt(id, lingering_items().subscribe()).await;
    if !ensure_manifest_ready(false).await {
        return fut.await;
    }

    let (claim, status) = {
        let mut rt = lock_runtime();
        let claim = match rt.manifest.as_mut() {
            Some(manifest) => {
                let claim = claim_external_item(manifest, id);
                if claim == ExternalClaim::Claimed {
                    persist(manifest);
                }
                claim
            }
            None => ExternalClaim::Claimed,
        };
        (claim, current_status(&rt))
    };
    if claim == ExternalClaim::AlreadyRunning {
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

    notify();
    emit_status(app, &status);

    let timer = InstallTimer::start(&id.timing_id());
    let started = Instant::now();
    let deadline = ItemDeadline {
        limit: item_time_limit(id),
        stop_grace: TIMEOUT_STOP_GRACE,
    };
    let outcome = run_external_work(id, deadline, lingering_items(), fut).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let result = match &outcome {
        ItemOutcome::Failed(err) => Err(err.clone()),
        ItemOutcome::Done | ItemOutcome::Skipped(_) => Ok(()),
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

    // ── Per-item deadline (PR 1656 review: a hung install must settle) ──

    fn test_lingering() -> &'static watch::Sender<HashSet<QueueItemId>> {
        Box::leak(Box::new(watch::channel(HashSet::new()).0))
    }

    fn short_deadline() -> ItemDeadline {
        ItemDeadline {
            limit: Duration::from_millis(50),
            stop_grace: Duration::from_millis(20),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn item_that_finishes_in_time_keeps_its_outcome() {
        let outcome =
            run_with_deadline(QueueItemId::Node, short_deadline(), test_lingering(), async { ItemOutcome::Done }).await;
        assert_eq!(outcome, ItemOutcome::Done);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn hung_item_fails_with_a_timeout_and_cancels_only_its_own_processes() {
        let own = uuid::Uuid::new_v4().to_string();
        let unrelated = uuid::Uuid::new_v4().to_string();
        install_deps::register_cancel_handle(unrelated.clone());
        let registered = own.clone();
        let started = Instant::now();
        let outcome = run_with_deadline(QueueItemId::HqCli, short_deadline(), test_lingering(), async move {
            install_deps::register_cancel_handle(registered);
            std::future::pending::<ItemOutcome>().await
        })
        .await;
        assert_eq!(outcome, ItemOutcome::Failed(timeout_reason(Duration::from_millis(50))));
        assert!(started.elapsed() < Duration::from_secs(5), "the deadline must end the wait");
        assert!(install_deps::is_cancelled_for_test(&own), "the item's child process gets the cancel request");
        assert!(!install_deps::is_cancelled_for_test(&unrelated), "items running beside it are untouched");
        install_deps::deregister_handle_for_test(&own);
        install_deps::deregister_handle_for_test(&unrelated);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn late_finish_after_a_timeout_cannot_replace_the_failed_outcome() {
        let lingering = test_lingering();
        let late_handle = uuid::Uuid::new_v4().to_string();
        let registered = late_handle.clone();
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
        // Blocking work ignores the abort, like an installer stuck in a
        // synchronous wait. It keeps running past the deadline, then tries to
        // start another process and reports success.
        let outcome = run_with_deadline(QueueItemId::Qmd, short_deadline(), lingering, async move {
            std::thread::sleep(Duration::from_millis(200));
            install_deps::register_cancel_handle(registered);
            let _ = finished_tx.send(());
            ItemOutcome::Done
        })
        .await;
        assert_eq!(outcome, ItemOutcome::Failed(timeout_reason(Duration::from_millis(50))));
        assert!(lingering.borrow().contains(&QueueItemId::Qmd), "the detached attempt is tracked");

        finished_rx.await.expect("the detached work runs to its end");
        assert!(
            install_deps::is_cancelled_for_test(&late_handle),
            "a process started after the deadline is cancelled at once"
        );
        let mut changes = lingering.subscribe();
        tokio::time::timeout(
            Duration::from_secs(5),
            changes.wait_for(|items| !items.contains(&QueueItemId::Qmd)),
        )
        .await
        .expect("the attempt leaves the lingering set when it ends")
        .expect("channel open");
        install_deps::deregister_handle_for_test(&late_handle);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retry_waits_for_a_timed_out_attempt_so_the_item_never_runs_twice() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let lingering = test_lingering();
        let first_running = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&first_running);
        let first = run_with_deadline(QueueItemId::Codex, short_deadline(), lingering, async move {
            flag.store(true, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(300));
            flag.store(false, Ordering::SeqCst);
            ItemOutcome::Done
        })
        .await;
        assert!(matches!(first, ItemOutcome::Failed(_)));
        assert!(first_running.load(Ordering::SeqCst), "the first attempt is still stuck");

        let observed = Arc::clone(&first_running);
        let retry = ItemDeadline {
            limit: Duration::from_secs(5),
            stop_grace: Duration::from_millis(20),
        };
        let second = run_with_deadline(QueueItemId::Codex, retry, lingering, async move {
            if observed.load(Ordering::SeqCst) {
                ItemOutcome::Failed("ran beside the stuck attempt".to_string())
            } else {
                ItemOutcome::Done
            }
        })
        .await;
        assert_eq!(second, ItemOutcome::Done);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn item_panic_still_settles_as_failed() {
        let _hook = item_panic_test_guard();
        let outcome = run_with_deadline(QueueItemId::Jq, short_deadline(), test_lingering(), async {
            panic!("boom");
        })
        .await;
        assert_eq!(outcome, ItemOutcome::Failed("installer panicked".to_string()));
    }

    /// Held by an item's work; dropping it during unwinding blocks the
    /// thread, like a panic hook capturing a backtrace or a slow cleanup.
    struct SlowDrop(Duration);

    impl Drop for SlowDrop {
        fn drop(&mut self) {
            std::thread::sleep(self.0);
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn panic_that_outlasts_the_deadline_still_settles_as_panicked() {
        let _hook = item_panic_test_guard();
        let lingering = test_lingering();
        // The panic starts at once, but unwinding takes longer than the limit
        // and the stop wait together.
        let outcome = run_with_deadline(QueueItemId::Yq, short_deadline(), lingering, async {
            let _slow = SlowDrop(Duration::from_millis(300));
            panic!("boom");
        })
        .await;
        assert_eq!(outcome, ItemOutcome::Failed("installer panicked".to_string()));
        let mut changes = lingering.subscribe();
        tokio::time::timeout(Duration::from_secs(5), changes.wait_for(|items| !items.contains(&QueueItemId::Yq)))
            .await
            .expect("the unwinding attempt leaves the lingering set when it ends")
            .expect("channel open");
    }

    /// PR 1656 CI: a test in install_deps.rs swaps the global panic hook. When
    /// the item hook was first installed inside that swap, the restore dropped
    /// it and a panicking item settled as "installer timed out".
    #[test]
    fn item_hook_survives_a_test_that_swaps_the_panic_hook() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("runtime");
        {
            let _swap = swap_panic_hook_for_test(|_| {});
            // An item runs while the swap is in place.
            let during = runtime.block_on(run_with_deadline(
                QueueItemId::RuntimeHooks,
                short_deadline(),
                test_lingering(),
                async { ItemOutcome::Done },
            ));
            assert_eq!(during, ItemOutcome::Done);
        }
        let _hook = item_panic_test_guard();
        let lingering = test_lingering();
        let outcome = runtime.block_on(run_with_deadline(QueueItemId::RuntimeHooks, short_deadline(), lingering, async {
            let _slow = SlowDrop(Duration::from_millis(300));
            panic!("boom");
        }));
        assert_eq!(outcome, ItemOutcome::Failed("installer panicked".to_string()));
    }

    /// PR 1656 Windows CI: a test's hook swap called the replaced hook under a
    /// lock, so a panicking item waited behind another test's backtrace print
    /// and settled as "installer timed out".
    #[test]
    fn item_panic_is_marked_while_another_panic_is_still_in_its_hook() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("runtime");
        let (in_hook_tx, in_hook_rx) = std::sync::mpsc::channel();
        let in_hook_tx = std::sync::Mutex::new(in_hook_tx);
        let _swap = swap_panic_hook_for_test(move |info| {
            if info.to_string().contains("slow hook") {
                let _ = in_hook_tx.lock().unwrap().send(());
                std::thread::sleep(Duration::from_millis(500));
            }
        });
        let slow = std::thread::spawn(|| panic!("slow hook"));
        in_hook_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the other panic reaches its hook");
        let outcome = runtime.block_on(run_with_deadline(QueueItemId::Embeddings, short_deadline(), test_lingering(), async {
            let _slow = SlowDrop(Duration::from_millis(300));
            panic!("boom");
        }));
        assert_eq!(outcome, ItemOutcome::Failed("installer panicked".to_string()));
        assert!(slow.join().is_err());
    }

    /// PR 1656 review: the queue's state check and the wizard's mark ran under
    /// two locks, so a second run could start the item in between.
    #[test]
    fn wizard_claim_checks_and_marks_the_item_in_one_step() {
        let mut m = manifest();
        assert_eq!(claim_external_item(&mut m, QueueItemId::SearchIndex), ExternalClaim::Claimed);
        assert_eq!(m.state(QueueItemId::SearchIndex), ItemState::Running);
        // A second run that arrives after the claim waits for the first.
        assert_eq!(claim_external_item(&mut m, QueueItemId::SearchIndex), ExternalClaim::AlreadyRunning);
        assert_eq!(m.state(QueueItemId::SearchIndex), ItemState::Running);
    }

    /// PR 1656 review: the wizard's run of the search index and the vault
    /// upload had no deadline, so a hang kept the ready screen waiting.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wizard_run_of_a_queue_item_fails_at_its_deadline() {
        let handle = uuid::Uuid::new_v4().to_string();
        let registered = handle.clone();
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            run_external_work(QueueItemId::VaultUpload, short_deadline(), test_lingering(), async move {
                install_deps::register_cancel_handle(registered);
                std::future::pending::<Result<(), String>>().await
            }),
        )
        .await
        .expect("the deadline ends the wizard's run");
        assert_eq!(outcome, ItemOutcome::Failed(timeout_reason(Duration::from_millis(50))));
        assert!(install_deps::is_cancelled_for_test(&handle), "the run's process is cancelled");
        install_deps::deregister_handle_for_test(&handle);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wizard_run_of_a_queue_item_keeps_its_result() {
        let ok = run_external_work(QueueItemId::SearchIndex, short_deadline(), test_lingering(), async { Ok(()) }).await;
        assert_eq!(ok, ItemOutcome::Done);
        let failed = run_external_work(QueueItemId::SearchIndex, short_deadline(), test_lingering(), async {
            Err("reindex failed".to_string())
        })
        .await;
        assert_eq!(failed, ItemOutcome::Failed("reindex failed".to_string()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn panic_during_the_stop_wait_settles_as_panicked() {
        let _hook = item_panic_test_guard();
        let deadline = ItemDeadline {
            limit: Duration::from_millis(50),
            stop_grace: Duration::from_secs(2),
        };
        // Blocking work ignores the abort and panics inside the stop wait.
        let outcome = run_with_deadline(QueueItemId::Gh, deadline, test_lingering(), async {
            std::thread::sleep(Duration::from_millis(150));
            panic!("boom");
        })
        .await;
        assert_eq!(outcome, ItemOutcome::Failed("installer panicked".to_string()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn caught_panic_followed_by_a_hang_settles_as_a_timeout() {
        let _hook = item_panic_test_guard();
        // The limit leaves the caught panic's hook (a backtrace capture when
        // RUST_BACKTRACE is set) time to finish before the deadline fires.
        let deadline = ItemDeadline {
            limit: Duration::from_secs(3),
            stop_grace: Duration::from_millis(20),
        };
        let outcome = run_with_deadline(QueueItemId::ClaudeCode, deadline, test_lingering(), async {
            let caught = std::panic::catch_unwind(|| panic!("handled inside the installer"));
            assert!(caught.is_err());
            std::future::pending::<ItemOutcome>().await
        })
        .await;
        assert_eq!(outcome, ItemOutcome::Failed(timeout_reason(Duration::from_secs(3))));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn item_timing_out_while_another_item_panics_keeps_both_causes() {
        let _hook = item_panic_test_guard();
        let lingering = test_lingering();
        let hung_handle = uuid::Uuid::new_v4().to_string();
        let panicking_handle = uuid::Uuid::new_v4().to_string();
        let (hung_registered, panic_registered) = (hung_handle.clone(), panicking_handle.clone());
        let deadline = ItemDeadline {
            limit: Duration::from_millis(100),
            stop_grace: Duration::from_millis(20),
        };
        let hung = run_with_deadline(QueueItemId::HqCli, deadline, lingering, async move {
            install_deps::register_cancel_handle(hung_registered);
            std::future::pending::<ItemOutcome>().await
        });
        let panicking = run_with_deadline(QueueItemId::Node, short_deadline(), lingering, async move {
            install_deps::register_cancel_handle(panic_registered);
            let _slow = SlowDrop(Duration::from_millis(300));
            panic!("boom");
        });
        let (hung, panicking) = tokio::join!(hung, panicking);

        assert_eq!(hung, ItemOutcome::Failed(timeout_reason(Duration::from_millis(100))));
        assert_eq!(panicking, ItemOutcome::Failed("installer panicked".to_string()));
        assert!(install_deps::is_cancelled_for_test(&hung_handle), "the hung item's process is cancelled");
        install_deps::deregister_handle_for_test(&hung_handle);
        install_deps::deregister_handle_for_test(&panicking_handle);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn deadline_cancel_during_a_panic_cancels_the_item_and_reports_the_panic() {
        let _hook = item_panic_test_guard();
        let lingering = test_lingering();
        let handle = uuid::Uuid::new_v4().to_string();
        let registered = handle.clone();
        // The item registers a child process and panics. The deadline fires
        // while it unwinds, so the cancel request and the panic overlap.
        let outcome = run_with_deadline(QueueItemId::Embeddings, short_deadline(), lingering, async move {
            install_deps::register_cancel_handle(registered);
            let _slow = SlowDrop(Duration::from_millis(200));
            panic!("boom");
        })
        .await;
        assert_eq!(outcome, ItemOutcome::Failed("installer panicked".to_string()));
        assert!(install_deps::is_cancelled_for_test(&handle), "the panicking item's process still gets the cancel");
        let mut changes = lingering.subscribe();
        tokio::time::timeout(
            Duration::from_secs(5),
            changes.wait_for(|items| !items.contains(&QueueItemId::Embeddings)),
        )
        .await
        .expect("the panicking attempt leaves the lingering set when it ends")
        .expect("channel open");
        install_deps::deregister_handle_for_test(&handle);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wizard_run_waits_while_a_timed_out_attempt_is_alive() {
        let lingering = test_lingering();
        lingering.send_modify(|items| {
            items.insert(QueueItemId::Qmd);
        });
        let waiter = tokio::spawn(wait_for_previous_attempt(QueueItemId::Qmd, lingering.subscribe()));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!waiter.is_finished(), "the run does not start beside the stuck attempt");

        lingering.send_modify(|items| {
            items.insert(QueueItemId::Gh);
            items.remove(&QueueItemId::Qmd);
        });
        tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("the run starts once the old attempt ends")
            .expect("waiter task");
    }

    /// A fake `hq` that starts a long-running grandchild, records both pids,
    /// and waits, like `hq reindex` driving its own worker processes.
    #[cfg(unix)]
    fn fake_hq_with_grandchild(dir: &std::path::Path) -> String {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("hq");
        std::fs::write(
            &script,
            "#!/bin/sh\necho started > started\nsleep 30 &\necho $! > grandchild.pid\nwait\n",
        )
        .expect("write fake hq");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod fake hq");
        script.to_string_lossy().into_owned()
    }

    #[cfg(unix)]
    fn process_alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn timed_out_hq_command_is_stopped_with_its_children() {
        use crate::commands::install_stages::run_hq_output_with_invocation;
        use hq_desktop_core::hq_resolver::HqInvocation;

        let dir = tempfile::tempdir().expect("tempdir");
        let hq = fake_hq_with_grandchild(dir.path());
        let root = dir.path().to_path_buf();
        let lingering = test_lingering();
        // The limit must cover the fake hq starting its worker. At 500 ms a
        // loaded test run could time out before the worker existed, and the
        // test then failed reading grandchild.pid.
        let limit = Duration::from_secs(3);
        let deadline = ItemDeadline {
            limit,
            stop_grace: Duration::from_secs(2),
        };
        let outcome = run_with_deadline(QueueItemId::SearchIndex, deadline, lingering, async move {
            match run_hq_output_with_invocation(&["reindex"], &root, HqInvocation::Local(hq)).await {
                Ok(_) => ItemOutcome::Done,
                Err(failure) => ItemOutcome::Failed(failure.message),
            }
        })
        .await;
        assert_eq!(outcome, ItemOutcome::Failed(timeout_reason(limit)));
        assert!(!lingering.borrow().contains(&QueueItemId::SearchIndex), "the attempt ended inside the stop wait");

        let pid: i32 = std::fs::read_to_string(dir.path().join("grandchild.pid"))
            .expect("the fake hq started its worker")
            .trim()
            .parse()
            .expect("pid");
        let stopped_by = Instant::now() + Duration::from_secs(5);
        while process_alive(pid) && Instant::now() < stopped_by {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!process_alive(pid), "the timed-out command's worker process keeps running");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn hq_command_is_not_started_once_the_item_is_out_of_time() {
        use crate::commands::install_stages::run_hq_output_with_invocation;
        use hq_desktop_core::hq_resolver::HqInvocation;

        let dir = tempfile::tempdir().expect("tempdir");
        let hq = fake_hq_with_grandchild(dir.path());
        let scope = QueueItemCancelScope::default();
        scope.expire();
        let result = scope
            .scope(run_hq_output_with_invocation(&["reindex"], dir.path(), HqInvocation::Local(hq)))
            .await;
        let failure = result.expect_err("an out-of-time item must not start hq");
        assert_eq!(failure.error_category, crate::commands::install_stages::OnboardingErrorCategory::Timeout);
        assert!(!dir.path().join("started").exists(), "hq was spawned after the deadline");
    }

    #[test]
    fn every_item_class_has_its_stated_time_limit() {
        let minutes = |id| item_time_limit(id).as_secs() / 60;
        for id in [QueueItemId::Node, QueueItemId::Yq, QueueItemId::Jq] {
            assert_eq!(minutes(id), 15, "{}", id.as_str());
        }
        for id in [
            QueueItemId::HqCli,
            QueueItemId::Gh,
            QueueItemId::ClaudeCode,
            QueueItemId::Codex,
            QueueItemId::Qmd,
        ] {
            assert_eq!(minutes(id), 20, "{}", id.as_str());
        }
        assert_eq!(minutes(QueueItemId::RuntimeHooks), 5);
        assert_eq!(minutes(QueueItemId::Embeddings), 45);
        assert_eq!(minutes(QueueItemId::SearchIndex), 60);
        assert_eq!(minutes(QueueItemId::VaultUpload), 60);
        // A download item must outlast every retry the downloader itself makes.
        assert!(item_time_limit(QueueItemId::Node) > Duration::from_secs(3 * 180));
    }

    #[test]
    fn timeout_reason_names_the_limit_in_minutes() {
        assert_eq!(timeout_reason(Duration::from_secs(20 * 60)), "installer timed out after 20 min");
    }
}
