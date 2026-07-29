//! macOS WKWebView cache hygiene for bundled frontend assets.
//!
//! Release builds serve the embedded UI from Tauri's stable
//! `tauri://localhost` custom-protocol origin. WebKit can retain disk or memory
//! cache entries for that origin across an app-bundle replacement, leaving a
//! newly updated binary rendering the previous release's JavaScript or CSS.
//!
//! Do not use Tauri's `clear_all_browsing_data` here: WebKit implements it with
//! `allWebsiteDataTypes`, which also removes localStorage, cookies, IndexedDB,
//! and other user state. This module removes only the two HTTP-style cache
//! classes, once per installed app version across launches. After WebKit
//! confirms eviction, only hidden webviews may reload. Startup surfaces are
//! released through a one-shot callback afterward, so visible onboarding and
//! input state is never reset.
//! WebKit applies data-type removal across the selected website data store, so
//! other response caches may also be cold afterward; persistent site data is
//! deliberately untouched.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use tauri::Manager;

use crate::util::logfile::log;

const LOG_TAG: &str = "webview-cache";
const COMPLETED_VERSION_MARKER: &str = "frontend-asset-cache-version";
const STARTUP_GATE_TIMEOUT: Duration = Duration::from_secs(8);

static EVICTED_VERSIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static STARTUP_GATE: OnceLock<Mutex<StartupGateCoordinator>> = OnceLock::new();
static STARTUP_READINESS: OnceLock<StartupReadiness> = OnceLock::new();

type ReadyCallback = Arc<Mutex<Option<Box<dyn FnOnce() + Send + 'static>>>>;

/// Process-lifetime readiness signal for native callers that can create or
/// reveal webviews outside the startup-surface callback.
///
/// This is intentionally a sticky watch value rather than a one-shot
/// `Notify`: notification callbacks can arrive in the check-to-wait race, and
/// late subscribers must return immediately after readiness has been reached.
struct StartupReadiness {
    sender: tokio::sync::watch::Sender<bool>,
}

impl StartupReadiness {
    fn new() -> Self {
        let (sender, _receiver) = tokio::sync::watch::channel(false);
        Self { sender }
    }

    #[cfg(test)]
    fn is_ready(&self) -> bool {
        *self.sender.borrow()
    }

    fn mark_ready(&self) {
        self.sender.send_replace(true);
    }

    async fn wait(&self) {
        let mut receiver = self.sender.subscribe();
        if *receiver.borrow() {
            return;
        }
        while receiver.changed().await.is_ok() {
            if *receiver.borrow() {
                return;
            }
        }
    }
}

impl Default for StartupReadiness {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CacheEvictionPlan {
    Evict,
    SkipAlreadyCompleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReloadEvent {
    Started,
    Finished,
}

#[derive(Debug, Default)]
struct ReloadBarrier {
    targets: HashSet<String>,
    started: HashSet<String>,
    finished: HashSet<String>,
}

impl ReloadBarrier {
    fn new(targets: impl IntoIterator<Item = String>) -> Self {
        Self {
            targets: targets.into_iter().collect(),
            started: HashSet::new(),
            finished: HashSet::new(),
        }
    }

    fn observe(&mut self, label: &str, event: ReloadEvent) -> bool {
        if !self.targets.contains(label) {
            return false;
        }
        match event {
            ReloadEvent::Started => {
                self.started.insert(label.to_string());
            }
            ReloadEvent::Finished if self.started.contains(label) => {
                self.finished.insert(label.to_string());
            }
            ReloadEvent::Finished => {}
        }
        self.finished == self.targets
    }
}

#[derive(Debug, Default)]
enum StartupGatePhase {
    #[default]
    Initializing,
    Ready,
    Evicting {
        generation: u64,
    },
    Reloading {
        generation: u64,
        barrier: ReloadBarrier,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateTransition {
    Stale,
    Pending,
    Complete,
}

#[derive(Debug, Default)]
struct StartupGateState {
    next_generation: u64,
    phase: StartupGatePhase,
    deferred_activation: bool,
}

impl StartupGateState {
    fn finish_initializing(&mut self) -> GateTransition {
        if matches!(self.phase, StartupGatePhase::Initializing) {
            self.phase = StartupGatePhase::Ready;
            GateTransition::Complete
        } else {
            GateTransition::Stale
        }
    }

    fn begin(&mut self) -> u64 {
        self.next_generation = self.next_generation.wrapping_add(1).max(1);
        let generation = self.next_generation;
        self.phase = StartupGatePhase::Evicting { generation };
        generation
    }

    fn is_evicting(&self, generation: u64) -> bool {
        matches!(
            self.phase,
            StartupGatePhase::Evicting {
                generation: active
            } if active == generation
        )
    }

    fn arm_reloads(
        &mut self,
        generation: u64,
        labels: impl IntoIterator<Item = String>,
    ) -> GateTransition {
        if !self.is_evicting(generation) {
            return GateTransition::Stale;
        }
        let barrier = ReloadBarrier::new(labels);
        if barrier.targets.is_empty() {
            self.phase = StartupGatePhase::Ready;
            GateTransition::Complete
        } else {
            self.phase = StartupGatePhase::Reloading {
                generation,
                barrier,
            };
            GateTransition::Pending
        }
    }

    fn observe_page_load(&mut self, label: &str, event: ReloadEvent) -> GateTransition {
        let StartupGatePhase::Reloading { barrier, .. } = &mut self.phase else {
            return if matches!(self.phase, StartupGatePhase::Ready) {
                GateTransition::Stale
            } else {
                GateTransition::Pending
            };
        };
        if barrier.observe(label, event) {
            self.phase = StartupGatePhase::Ready;
            GateTransition::Complete
        } else {
            GateTransition::Pending
        }
    }

    fn timeout(&mut self, generation: u64) -> GateTransition {
        let matches_generation = match self.phase {
            StartupGatePhase::Evicting { generation: active }
            | StartupGatePhase::Reloading {
                generation: active, ..
            } => active == generation,
            StartupGatePhase::Initializing | StartupGatePhase::Ready => false,
        };
        if matches_generation {
            self.phase = StartupGatePhase::Ready;
            GateTransition::Complete
        } else {
            GateTransition::Stale
        }
    }

    fn defer_activation_while_pending(&mut self) -> bool {
        if matches!(self.phase, StartupGatePhase::Ready) {
            false
        } else {
            self.deferred_activation = true;
            true
        }
    }

    fn take_deferred_activation(&mut self) -> bool {
        if matches!(self.phase, StartupGatePhase::Ready) {
            std::mem::take(&mut self.deferred_activation)
        } else {
            false
        }
    }
}

struct PendingGate {
    version: String,
    marker_path: PathBuf,
    marker_eligible: bool,
    ready: ReadyCallback,
}

#[derive(Default)]
struct StartupGateCoordinator {
    state: StartupGateState,
    pending: Option<PendingGate>,
}

fn startup_gate() -> &'static Mutex<StartupGateCoordinator> {
    STARTUP_GATE.get_or_init(|| Mutex::new(StartupGateCoordinator::default()))
}

fn startup_readiness() -> &'static StartupReadiness {
    STARTUP_READINESS.get_or_init(StartupReadiness::new)
}

fn signal_startup_gate_ready() {
    startup_readiness().mark_ready();
}

fn mark_startup_gate_ready_without_eviction() {
    let mut coordinator = startup_gate()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = coordinator.state.finish_initializing();
}

fn begin_startup_gate(version: String, marker_path: PathBuf, ready: ReadyCallback) -> u64 {
    let mut coordinator = startup_gate()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let generation = coordinator.state.begin();
    coordinator.pending = Some(PendingGate {
        version,
        marker_path,
        marker_eligible: true,
        ready,
    });
    generation
}

fn startup_gate_is_evicting(generation: u64) -> bool {
    startup_gate()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .state
        .is_evicting(generation)
}

fn arm_startup_reloads(
    generation: u64,
    labels: impl IntoIterator<Item = String>,
    marker_eligible: bool,
) -> (GateTransition, Option<PendingGate>) {
    let (transition, pending) = {
        let mut coordinator = startup_gate()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let transition = coordinator.state.arm_reloads(generation, labels);
        if transition != GateTransition::Stale {
            if let Some(pending) = coordinator.pending.as_mut() {
                pending.marker_eligible &= marker_eligible;
            }
        }
        let pending = if transition == GateTransition::Complete {
            coordinator.pending.take()
        } else {
            None
        };
        (transition, pending)
    };
    (transition, pending)
}

fn take_gate_for_fallback(generation: u64) -> Option<PendingGate> {
    let mut coordinator = startup_gate()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if coordinator.state.timeout(generation) == GateTransition::Complete {
        coordinator.pending.take()
    } else {
        None
    }
}

fn complete_successful_gate(pending: PendingGate, reason: &str) {
    if !pending.marker_eligible {
        complete_gate_without_marker(
            pending,
            &format!("{reason}; at least one startup surface was preserved"),
        );
        return;
    }

    let marker_result = if pending.marker_path.as_os_str().is_empty() {
        Err("app data directory was unavailable".to_string())
    } else {
        persist_completed_version(&pending.marker_path, &pending.version)
    };
    if let Err(error) = marker_result {
        release_version(&pending.version);
        log(
            LOG_TAG,
            &format!(
                "{reason}, but the completion marker was not saved for {}: {error}",
                pending.version
            ),
        );
    } else {
        log(
            LOG_TAG,
            &format!("{reason}; cache gate complete for {}", pending.version),
        );
    }
    release_startup_gate(&pending.ready);
}

fn complete_gate_without_marker(pending: PendingGate, reason: &str) {
    release_version(&pending.version);
    log(
        LOG_TAG,
        &format!(
            "{reason}; startup released without recording cache completion for {}",
            pending.version
        ),
    );
    release_startup_gate(&pending.ready);
}

fn schedule_startup_gate_watchdog(app: &tauri::AppHandle, generation: u64) {
    let watchdog_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_GATE_TIMEOUT).await;
        if let Err(error) = watchdog_app.run_on_main_thread(move || {
            if let Some(pending) = take_gate_for_fallback(generation) {
                complete_gate_without_marker(
                    pending,
                    "startup cache gate timed out before eviction/reload completion",
                );
            }
        }) {
            log(
                LOG_TAG,
                &format!("could not dispatch startup cache watchdog fallback: {error}"),
            );
        }
    });
}

pub fn handle_page_load(label: &str, event: tauri::webview::PageLoadEvent) {
    let event = match event {
        tauri::webview::PageLoadEvent::Started => ReloadEvent::Started,
        tauri::webview::PageLoadEvent::Finished => ReloadEvent::Finished,
    };
    let pending = {
        let mut coordinator = startup_gate()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if coordinator.state.observe_page_load(label, event) == GateTransition::Complete {
            coordinator.pending.take()
        } else {
            None
        }
    };
    if let Some(pending) = pending {
        complete_successful_gate(pending, "all hidden startup webviews finished reloading");
    }
}

/// Wait until macOS cache eviction/reload has reached a terminal ready state.
///
/// Notification entry points use this before creating, revealing, or routing
/// user-visible webviews. Development, already-completed versions, and every
/// fallback path publish readiness after their startup callback has established
/// the tray, widget, and notification producers.
pub async fn wait_until_ready() {
    startup_readiness().wait().await;
}

pub fn defer_activation_while_pending() -> bool {
    startup_gate()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .state
        .defer_activation_while_pending()
}

pub fn take_deferred_activation() -> bool {
    startup_gate()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .state
        .take_deferred_activation()
}

#[link(name = "WebKit", kind = "framework")]
extern "C" {
    static WKWebsiteDataTypeDiskCache: *mut objc2::runtime::AnyObject;
    static WKWebsiteDataTypeMemoryCache: *mut objc2::runtime::AnyObject;
}

/// Evict stale bundled-asset responses without touching persistent site data.
///
/// This is called near the beginning of Tauri's setup hook, after the
/// config-created `main` WKWebView exists but before auxiliary webviews are
/// built. WebKit performs removal asynchronously; on completion we reload any
/// hidden startup webviews, record the completed installed version, and invoke
/// `on_ready` exactly once so gated startup surfaces can be created or shown.
pub fn evict_frontend_asset_cache_once(
    app: &tauri::AppHandle,
    app_version: &str,
    on_ready: impl FnOnce() + Send + 'static,
) {
    let ready = pending_ready_callback(on_ready);

    // Development loads Vite over HTTP and benefits from its normal cache/HMR
    // behavior. The stale-origin bug applies only to bundled custom-protocol
    // release assets.
    if tauri::is_dev() {
        log(
            LOG_TAG,
            "skip: development webview does not use bundled assets",
        );
        mark_startup_gate_ready_without_eviction();
        release_startup_gate(&ready);
        return;
    }

    let Some(main_window) = app.get_webview_window("main") else {
        log(LOG_TAG, "skip: main WKWebView is unavailable during setup");
        mark_startup_gate_ready_without_eviction();
        release_startup_gate(&ready);
        return;
    };

    let marker_path = match completed_version_marker_path(app) {
        Ok(path) => path,
        Err(error) => {
            log(
                LOG_TAG,
                &format!("cache marker path unavailable; eviction will be process-local: {error}"),
            );
            PathBuf::new()
        }
    };
    let completed_version = if marker_path.as_os_str().is_empty() {
        None
    } else {
        read_completed_version(&marker_path)
    };
    if eviction_plan(completed_version.as_deref(), app_version)
        == CacheEvictionPlan::SkipAlreadyCompleted
    {
        log(
            LOG_TAG,
            &format!("skip: cache already evicted for installed app version {app_version}"),
        );
        mark_startup_gate_ready_without_eviction();
        release_startup_gate(&ready);
        return;
    }

    if !claim_version(app_version) {
        log(
            LOG_TAG,
            &format!("skip: cache eviction already scheduled for app version {app_version}"),
        );
        mark_startup_gate_ready_without_eviction();
        release_startup_gate(&ready);
        return;
    }

    let generation = begin_startup_gate(app_version.to_owned(), marker_path, ready.clone());
    schedule_startup_gate_watchdog(app, generation);

    let app_for_completion = app.clone();
    if let Err(error) = main_window.with_webview(move |webview| {
        use block2::RcBlock;
        use objc2::{class, msg_send, runtime::AnyObject};

        let reload_app = app_for_completion.clone();
        let completion = RcBlock::new(move || {
            let app_on_main = reload_app.clone();
            if let Err(error) = reload_app.run_on_main_thread(move || {
                if !startup_gate_is_evicting(generation) {
                    log(
                        LOG_TAG,
                        &format!(
                            "ignoring late WebKit eviction completion for generation {generation}"
                        ),
                    );
                    return;
                }

                let mut reload_windows = Vec::new();
                let mut preserved_labels = Vec::new();
                for (label, window) in app_on_main.webview_windows() {
                    let visibility = match window.is_visible() {
                        Ok(visible) => Some(visible),
                        Err(error) => {
                            log(
                                LOG_TAG,
                                &format!("visibility unavailable for {label}: {error}"),
                            );
                            None
                        }
                    };

                    if should_reload_after_eviction(visibility) {
                        reload_windows.push((label, window));
                    } else {
                        if visibility.is_none() {
                            log(
                                LOG_TAG,
                                &format!(
                                    "preserving {label} because its visibility is unknown"
                                ),
                            );
                        }
                        preserved_labels.push(label);
                    }
                }
                preserved_labels.sort();

                let mut reloaded_labels: Vec<String> = reload_windows
                    .iter()
                    .map(|(label, _)| label.clone())
                    .collect();
                reloaded_labels.sort();
                let marker_eligible =
                    marker_may_record_completed_version(0, preserved_labels.len());
                let (transition, pending) = arm_startup_reloads(
                    generation,
                    reloaded_labels.iter().cloned(),
                    marker_eligible,
                );
                match transition {
                    GateTransition::Stale => {
                        log(
                            LOG_TAG,
                            &format!(
                                "ignoring stale reload dispatch for generation {generation}"
                            ),
                        );
                        return;
                    }
                    GateTransition::Complete => {
                        if let Some(pending) = pending {
                            complete_successful_gate(
                                pending,
                                "WebKit cache eviction completed with no hidden startup reloads",
                            );
                        }
                        return;
                    }
                    GateTransition::Pending => {}
                }

                let mut reload_failures = Vec::new();
                for (label, window) in reload_windows {
                    if let Err(error) = window.reload() {
                        reload_failures.push(label.clone());
                        log(LOG_TAG, &format!("reload failed for {label}: {error}"));
                    }
                }
                if !reload_failures.is_empty() {
                    reload_failures.sort();
                    if let Some(pending) = take_gate_for_fallback(generation) {
                        complete_gate_without_marker(
                            pending,
                            &format!(
                                "required startup reload dispatch failed for [{}]",
                                reload_failures.join(", ")
                            ),
                        );
                    }
                    return;
                }

                log(
                    LOG_TAG,
                    &format!(
                        "evicted disk/memory cache; waiting for hidden reloads [{}]; preserved visible/unknown [{}]",
                        reloaded_labels.join(", "),
                        preserved_labels.join(", ")
                    ),
                );
            }) {
                if let Some(pending) = take_gate_for_fallback(generation) {
                    complete_gate_without_marker(
                        pending,
                        &format!("cache eviction completed but reload dispatch failed: {error}"),
                    );
                }
            }
        });

        // SAFETY: `with_webview` runs on the UI thread with a live WKWebView.
        // The configuration owns its WKWebsiteDataStore. The two imported
        // NSString constants are WebKit's public disk/memory cache data types;
        // the mutable set and NSDate are autoreleased for this run-loop turn.
        // WebKit copies the completion block for the asynchronous operation.
        unsafe {
            let wk = webview.inner() as *mut AnyObject;
            let configuration: *mut AnyObject = msg_send![wk, configuration];
            let data_store: *mut AnyObject = msg_send![configuration, websiteDataStore];
            let cache_types: *mut AnyObject =
                msg_send![class!(NSMutableSet), setWithCapacity: 2_usize];
            let disk_cache = WKWebsiteDataTypeDiskCache;
            let memory_cache = WKWebsiteDataTypeMemoryCache;
            let _: () = msg_send![cache_types, addObject: disk_cache];
            let _: () = msg_send![cache_types, addObject: memory_cache];
            let since: *mut AnyObject = msg_send![class!(NSDate), distantPast];
            let _: () = msg_send![
                data_store,
                removeDataOfTypes: cache_types,
                modifiedSince: since,
                completionHandler: &*completion
            ];
        }
    }) {
        if let Some(pending) = take_gate_for_fallback(generation) {
            complete_gate_without_marker(
                pending,
                &format!("failed to schedule cache eviction for {app_version}: {error}"),
            );
        }
    }
}

fn completed_version_marker_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(COMPLETED_VERSION_MARKER))
        .map_err(|error| format!("could not resolve app data directory: {error}"))
}

fn completed_version_from_marker(contents: &str) -> Option<&str> {
    let version = contents.trim();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

fn read_completed_version(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| completed_version_from_marker(&contents).map(str::to_owned))
}

fn eviction_plan(completed_version: Option<&str>, installed_version: &str) -> CacheEvictionPlan {
    if completed_version == Some(installed_version) {
        CacheEvictionPlan::SkipAlreadyCompleted
    } else {
        CacheEvictionPlan::Evict
    }
}

fn persist_completed_version(path: &Path, app_version: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "cache marker has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create cache marker directory: {error}"))?;

    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temporary, format!("{app_version}\n"))
        .map_err(|error| format!("could not stage cache marker: {error}"))?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("could not commit cache marker: {error}"));
    }
    Ok(())
}

fn should_reload_after_eviction(visibility: Option<bool>) -> bool {
    visibility == Some(false)
}

fn marker_may_record_completed_version(
    reload_failure_count: usize,
    preserved_surface_count: usize,
) -> bool {
    reload_failure_count == 0 && preserved_surface_count == 0
}

fn pending_ready_callback(callback: impl FnOnce() + Send + 'static) -> ReadyCallback {
    Arc::new(Mutex::new(Some(Box::new(callback))))
}

fn run_ready_callback(callback: &ReadyCallback) {
    let pending = callback
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(pending) = pending {
        pending();
    }
}

/// Finish startup surface setup before waking notification entry points.
///
/// The cache state itself transitions to `Ready` before this point, but the
/// callback creates the widget/tray and arms notification producers. Publishing
/// the sticky readiness signal afterward prevents a just-unblocked banner from
/// racing widget takeover initialization.
fn release_startup_gate(callback: &ReadyCallback) {
    run_ready_callback(callback);
    signal_startup_gate_ready();
}

fn claim_version(app_version: &str) -> bool {
    let mut versions = EVICTED_VERSIONS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if versions.contains(app_version) {
        false
    } else {
        versions.insert(app_version.to_owned());
        true
    }
}

fn release_version(app_version: &str) {
    let mut versions = EVICTED_VERSIONS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    versions.remove(app_version);
}

#[cfg(test)]
mod tests {
    use super::{
        claim_version, completed_version_from_marker, eviction_plan,
        marker_may_record_completed_version, pending_ready_callback, persist_completed_version,
        read_completed_version, release_version, run_ready_callback, should_reload_after_eviction,
        CacheEvictionPlan, GateTransition, ReloadBarrier, ReloadEvent, StartupGateState,
        StartupReadiness,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn cache_eviction_claim_is_once_per_version() {
        let version = format!("test-{}", std::process::id());
        release_version(&version);
        assert!(claim_version(&version));
        assert!(!claim_version(&version));
        release_version(&version);
        assert!(claim_version(&version));
        release_version(&version);
    }

    #[test]
    fn completed_version_marker_skips_only_the_installed_version() {
        assert_eq!(
            eviction_plan(Some("0.10.35-beta.5"), "0.10.35-beta.5"),
            CacheEvictionPlan::SkipAlreadyCompleted
        );
        assert_eq!(
            eviction_plan(Some("0.10.35-beta.4"), "0.10.35-beta.5"),
            CacheEvictionPlan::Evict
        );
        assert_eq!(
            eviction_plan(None, "0.10.35-beta.5"),
            CacheEvictionPlan::Evict
        );
        assert_eq!(completed_version_from_marker("  \n"), None);
        assert_eq!(
            completed_version_from_marker(" 0.10.35-beta.5\n"),
            Some("0.10.35-beta.5")
        );
    }

    #[test]
    fn completed_version_persists_across_process_state() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("frontend-asset-cache-version");

        assert_eq!(read_completed_version(&marker), None);
        persist_completed_version(&marker, "0.10.35-beta.5").unwrap();
        assert_eq!(
            read_completed_version(&marker).as_deref(),
            Some("0.10.35-beta.5")
        );
        assert_eq!(
            eviction_plan(read_completed_version(&marker).as_deref(), "0.10.35-beta.5"),
            CacheEvictionPlan::SkipAlreadyCompleted
        );
    }

    #[test]
    fn asynchronous_completion_reloads_only_hidden_surfaces() {
        assert!(should_reload_after_eviction(Some(false)));
        assert!(!should_reload_after_eviction(Some(true)));
        assert!(!should_reload_after_eviction(None));
    }

    #[test]
    fn completion_marker_waits_for_required_startup_reloads() {
        assert!(marker_may_record_completed_version(0, 0));
        assert!(!marker_may_record_completed_version(1, 0));
        assert!(
            !marker_may_record_completed_version(0, 1),
            "a visible or unknown-visibility surface was not refreshed and must force a retry next launch"
        );
    }

    #[test]
    fn startup_ready_callback_runs_exactly_once() {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_from_callback = calls.clone();
        let callback = pending_ready_callback(move || {
            calls_from_callback.fetch_add(1, Ordering::SeqCst);
        });

        run_ready_callback(&callback);
        run_ready_callback(&callback);

        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn reload_barrier_ignores_finished_until_started_after_arm() {
        let mut barrier = ReloadBarrier::new(["main".to_string()]);

        assert!(!barrier.observe("main", ReloadEvent::Finished));
        assert!(!barrier.observe("other", ReloadEvent::Started));
        assert!(!barrier.observe("main", ReloadEvent::Started));
        assert!(barrier.observe("main", ReloadEvent::Finished));
    }

    #[test]
    fn reload_barrier_requires_every_armed_hidden_webview() {
        let mut barrier = ReloadBarrier::new(["main".to_string(), "detail".to_string()]);

        assert!(!barrier.observe("main", ReloadEvent::Started));
        assert!(!barrier.observe("main", ReloadEvent::Finished));
        assert!(!barrier.observe("detail", ReloadEvent::Finished));
        assert!(!barrier.observe("detail", ReloadEvent::Started));
        assert!(barrier.observe("detail", ReloadEvent::Finished));
    }

    #[test]
    fn startup_gate_rejects_initial_finish_and_completes_post_arm_reload() {
        let mut gate = StartupGateState::default();
        let generation = gate.begin();

        assert!(gate.is_evicting(generation));
        assert_eq!(
            gate.arm_reloads(generation, ["main".to_string()]),
            GateTransition::Pending
        );
        assert_eq!(
            gate.observe_page_load("main", ReloadEvent::Finished),
            GateTransition::Pending,
            "the config-created webview's initial Finished event must not release startup"
        );
        assert_eq!(
            gate.observe_page_load("main", ReloadEvent::Started),
            GateTransition::Pending
        );
        assert_eq!(
            gate.observe_page_load("main", ReloadEvent::Finished),
            GateTransition::Complete
        );
    }

    #[test]
    fn startup_gate_watchdog_wins_once_and_late_events_are_stale() {
        let mut gate = StartupGateState::default();
        let generation = gate.begin();
        assert_eq!(
            gate.arm_reloads(generation, ["main".to_string()]),
            GateTransition::Pending
        );

        assert_eq!(gate.timeout(generation), GateTransition::Complete);
        assert_eq!(gate.timeout(generation), GateTransition::Stale);
        assert_eq!(
            gate.observe_page_load("main", ReloadEvent::Started),
            GateTransition::Stale
        );
        assert_eq!(
            gate.observe_page_load("main", ReloadEvent::Finished),
            GateTransition::Stale
        );
        assert!(!gate.is_evicting(generation));
    }

    #[test]
    fn startup_gate_defers_and_consumes_second_instance_activation() {
        let mut gate = StartupGateState::default();
        assert!(
            gate.defer_activation_while_pending(),
            "the plugin is live before setup begins, so the default phase must defer activation"
        );

        let generation = gate.begin();
        assert!(gate.defer_activation_while_pending());
        assert!(gate.defer_activation_while_pending());
        assert_eq!(gate.timeout(generation), GateTransition::Complete);
        assert!(gate.take_deferred_activation());
        assert!(!gate.take_deferred_activation());
    }

    #[test]
    fn startup_gate_skip_path_releases_pre_setup_activation() {
        let mut gate = StartupGateState::default();
        assert!(gate.defer_activation_while_pending());
        assert_eq!(gate.finish_initializing(), GateTransition::Complete);
        assert!(gate.take_deferred_activation());
        assert!(!gate.defer_activation_while_pending());
    }

    #[test]
    fn startup_gate_without_hidden_reloads_completes_after_eviction() {
        let mut gate = StartupGateState::default();
        let generation = gate.begin();

        assert_eq!(
            gate.arm_reloads(generation, std::iter::empty()),
            GateTransition::Complete
        );
        assert_eq!(gate.timeout(generation), GateTransition::Stale);
    }

    #[tokio::test]
    async fn startup_readiness_waits_until_marked_ready() {
        let readiness = Arc::new(StartupReadiness::default());
        assert!(!readiness.is_ready());

        let waiting = readiness.clone();
        let waiter = tokio::spawn(async move {
            waiting.wait().await;
        });
        tokio::task::yield_now().await;
        assert!(
            !waiter.is_finished(),
            "notification surfaces must stay blocked while cache startup is pending"
        );

        readiness.mark_ready();
        tokio::time::timeout(std::time::Duration::from_millis(100), waiter)
            .await
            .expect("all readiness waiters should be released")
            .expect("readiness waiter should not panic");
        assert!(readiness.is_ready());
    }

    #[tokio::test]
    async fn startup_readiness_is_sticky_and_releases_every_waiter() {
        let readiness = Arc::new(StartupReadiness::default());
        let first = {
            let readiness = readiness.clone();
            tokio::spawn(async move { readiness.wait().await })
        };
        let second = {
            let readiness = readiness.clone();
            tokio::spawn(async move { readiness.wait().await })
        };
        tokio::task::yield_now().await;
        assert!(!first.is_finished());
        assert!(!second.is_finished());

        readiness.mark_ready();
        for waiter in [first, second] {
            tokio::time::timeout(std::time::Duration::from_millis(100), waiter)
                .await
                .expect("mark_ready should release every current waiter")
                .expect("readiness waiter should not panic");
        }

        tokio::time::timeout(std::time::Duration::from_millis(100), readiness.wait())
            .await
            .expect("future callers should observe sticky readiness immediately");
    }
}
