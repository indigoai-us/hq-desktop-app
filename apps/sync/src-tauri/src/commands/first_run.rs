//! First-run / first-update onboarding classification + persisted flags.
//!
//! Three launch kinds, classified once at app `.setup()` time and cached in
//! Tauri managed state so the verdict is stable for the whole process:
//!
//!   - **FirstRun**       brand-new install — never run this app before.
//!   - **ExistingUpdate** a legacy user who updated to a build that has the
//!                        new onboarding flags (and so hasn't seen the
//!                        auto-sync notice yet).
//!   - **Normal**         everything after the first-run sequence completes.
//!
//! ## Why classification must run BEFORE `ensure_machine_id`
//!
//! Both FirstRun and ExistingUpdate lack the new `firstRunCompleted` flag, so
//! that flag alone can't tell them apart. The tiebreaker is `machineId`:
//! `config::ensure_machine_id` writes it to `menubar.json` on the *first ever*
//! launch, so an existing user already has it while a brand-new install does
//! not (the installer writes `hqPath` but never `machineId`). We therefore
//! snapshot the classification at the very top of `.setup()` — before
//! `ensure_machine_id` runs and populates `machineId` for everyone — and stash
//! the result in managed state.
//!
//! All writes use the same untyped-merge + atomic-rename algorithm as
//! `config::ensure_machine_id`: read `menubar.json` as an untyped `Map`, mutate
//! only the target keys, atomic-rename back. The typed `MenubarPrefs` is
//! deliberately NOT used for writes here — a typed round-trip would silently
//! drop unknown / future top-level keys.

use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::util::{logfile::log, paths};

pub use hq_desktop_core::first_run::{
    classify_from_map, classify_from_menubar_read, ensure_install_attempt_id, merge_menubar_flags,
    notice_shown_in_map, read_menubar, read_menubar_obj, should_autoshow_on_launch,
    should_open_desktop_on_launch, should_sync_after_first_run_handoff, LaunchKind, MenubarRead,
};

pub const FIRST_LAUNCH_SYNC_FLAG: &str = "desktop.first-launch-sync-v1";

const FIRST_LAUNCH_SYNC_START_FAILURE_MESSAGE: &str = "first-launch sync start failed";
const FIRST_LAUNCH_SYNC_START_FAILURE_FINGERPRINT: &str = "first-launch-sync-start-failed";

fn first_launch_sync_start_error_category(error: &str) -> &'static str {
    match error {
        "Sync is already running" => "already_running",
        hq_desktop_core::daemon::CLOUD_PAUSED_MESSAGE => "cloud_paused",
        _ => "other",
    }
}

fn report_first_launch_sync_start_failure(error: &str) {
    crate::commands::sync::capture_sync_error_with_fingerprint_and_context(
        None,
        "(first-launch)",
        FIRST_LAUNCH_SYNC_START_FAILURE_MESSAGE,
        &["sync", FIRST_LAUNCH_SYNC_START_FAILURE_FINGERPRINT],
        &[(
            "failure_category",
            first_launch_sync_start_error_category(error).to_string(),
        )],
        &[],
    );
}

/// `ensure_install_attempt_id` reads and, on the first call, writes the shared
/// menubar settings file. Serialize this wrapper because receipt preparation
/// intentionally runs several blocking workers concurrently.
static INSTALL_ATTEMPT_ID_IO: Mutex<()> = Mutex::new(());

/// Stable, path-free marker for settings files that prove this is not a fresh
/// install but cannot safely supply their contents.
const SETTINGS_FILE_READ_WARNING_MARKER: &str =
    "hq_desktop.settings_file_present_but_unreadable_or_unparseable";

fn settings_file_read_failure_kind(read: &MenubarRead) -> Option<&'static str> {
    match read {
        MenubarRead::Unreadable => Some("unreadable"),
        MenubarRead::Unparseable | MenubarRead::PreservedCorrupt => Some("unparseable"),
        MenubarRead::Absent | MenubarRead::Object(_) => None,
    }
}

/// Record a closed-vocabulary warning without sending a path, file contents,
/// or operating-system error text to Sentry.
fn report_settings_file_read_failure(read: &MenubarRead) {
    let Some(kind) = settings_file_read_failure_kind(read) else {
        return;
    };
    let fingerprint = [SETTINGS_FILE_READ_WARNING_MARKER, kind];
    log(
        "first-run",
        &format!("{SETTINGS_FILE_READ_WARNING_MARKER}: {kind}"),
    );
    sentry::with_scope(
        |scope| {
            scope.set_fingerprint(Some(&fingerprint));
            scope.set_tag("marker", SETTINGS_FILE_READ_WARNING_MARKER);
            scope.set_tag("settingsReadFailure", kind);
            scope.set_tag("platform", crate::commands::version_gate::platform_tag());
            scope.set_extra(
                "settingsReadFailure",
                sentry::protocol::Value::String(kind.to_string()),
            );
        },
        || sentry::capture_message(SETTINGS_FILE_READ_WARNING_MARKER, sentry::Level::Warning),
    );
}

/// This installation's attempt identifier, minted on first read.
///
/// The join key between the website's signup funnel and the desktop's
/// onboarding events, which is the whole reason the funnel analysis could see
/// 101 signups and 43 app opens but not say whether they were the same people.
///
/// Returns `None` when there is no resolvable home directory. That is not a
/// reason to invent an id: an unstable one would put every launch on its own
/// partition and quietly inflate the counts. The caller treats absence as "do
/// not report", which is honest.
pub fn install_attempt_id_at(path: &std::path::Path) -> Option<String> {
    let _guard = INSTALL_ATTEMPT_ID_IO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ensure_install_attempt_id(path, || uuid::Uuid::new_v4().to_string()).ok()
}

pub fn install_attempt_id() -> Option<String> {
    let path = paths::menubar_json_path().ok()?;
    install_attempt_id_at(&path)
}

/// Managed-state wrapper so the launch verdict survives the rest of the
/// process even after `machineId` gets written this launch.
pub struct LaunchKindState(pub LaunchKind);

/// Cheap, side-effect-free launch hint for painting the first-run surface
/// before lifecycle probes. The final, managed classification still happens
/// after lifecycle has had a chance to backfill older setup markers.
pub fn early_launch_hint() -> LaunchKind {
    match paths::menubar_json_path() {
        Ok(path) => classify_from_menubar_read(&read_menubar(&path)),
        Err(_) => LaunchKind::Normal,
    }
}

/// Classify this launch and stash the verdict in managed state. MUST be called
/// at the top of `.setup()`, before `config::ensure_machine_id` populates
/// `machineId`.
pub fn classify_launch<R: Runtime>(app: &AppHandle<R>) -> LaunchKind {
    let mut settings_prove_writable = false;
    let kind = match paths::menubar_json_path() {
        Ok(path) => {
            let read = read_menubar(&path);
            report_settings_file_read_failure(&read);
            settings_prove_writable = matches!(
                &read,
                MenubarRead::Absent | MenubarRead::Object(_)
            );
            classify_from_menubar_read(&read)
        }
        // Without a resolvable home directory, we cannot prove this is a
        // first launch. Keep setup closed rather than risking a destructive
        // first-run write against an unknown settings location.
        Err(_) => LaunchKind::Normal,
    };
    // Publish the same verdict process-wide so the HQ root resolver treats a
    // fresh install as onboarding even after `ensure_machine_id` writes
    // `machineId` later in `.setup()`.
    hq_desktop_core::first_run::set_setup_launch_kind(kind);
    // Mint and persist the stable join key before onboarding can emit setup or
    // sign-in telemetry, but only when the initial read proved that settings
    // are absent or valid JSON. A damaged existing settings file must remain
    // untouched. Receipt builders still read the same store, so this does not
    // change the event contract or create another identity source.
    if settings_prove_writable && install_attempt_id().is_none() {
        log(
            "first-run",
            "install attempt ID unavailable before onboarding telemetry",
        );
    }
    app.manage(LaunchKindState(kind));
    kind
}

/// True only on a brand-new install's first launch.
#[tauri::command]
pub fn is_first_run(state: State<'_, LaunchKindState>) -> bool {
    state.0 == LaunchKind::FirstRun
}

/// Read the stable installation identity for anonymous first-launch joins.
#[tauri::command]
pub async fn desktop_install_attempt_id() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| install_attempt_id())
        .await
        .ok()
        .flatten()
}

/// True when a legacy user updated to this build, hasn't seen the auto-sync
/// notice yet, AND still has auto-sync on. A user who explicitly turned
/// auto-sync off (`realtimeSync: false`) made a deliberate choice and gets no
/// "auto-sync is on" notice — notify-only, respect opt-outs.
#[tauri::command]
pub fn should_show_auto_sync_notice(state: State<'_, LaunchKindState>) -> bool {
    if state.0 != LaunchKind::ExistingUpdate {
        return false;
    }
    let notice_shown = paths::menubar_json_path()
        .map(|p| notice_shown_in_map(&read_menubar_obj(&p)))
        .unwrap_or(false);
    if notice_shown {
        return false;
    }
    // Respect an explicit opt-out (default-on when the field is absent).
    crate::commands::daemon::is_realtime_sync_enabled()
}

/// Mark the brand-new-install onboarding as finished. Persists
/// `firstRunCompleted` + `autoSyncNoticeShown` (new users got the carousel, so
/// skip the separate notice) and makes "sync is on" explicit by writing
/// `realtimeSync` + `personalSyncEnabled` true.
#[tauri::command]
pub fn mark_first_run_complete(app: AppHandle) -> Result<(), String> {
    let path = paths::menubar_json_path()?;
    let menubar = read_menubar_obj(&path);
    let mut flags = vec![
        ("firstRunCompleted", Value::Bool(true)),
        ("autoSyncNoticeShown", Value::Bool(true)),
        ("realtimeSync", Value::Bool(true)),
        ("personalSyncEnabled", Value::Bool(true)),
    ];
    // A brand-new install is owed the welcome channel's guided setup.
    // An updating user (`mark_auto_sync_notice_shown`, the lifecycle
    // backfill) is not: they were set up before this flow existed.
    // Re-running the installer after a misclassified launch must not
    // reset a finished welcome (feedback #2290).
    if hq_desktop_core::lifecycle::should_arm_welcome_setup_pending(&menubar) {
        flags.push(("welcomeSetupPending", Value::Bool(true)));
    }
    merge_menubar_flags(&path, &flags)?;
    // Setup is done for this process too: window routing must stop treating
    // `main` as the setup card, or the next Dock / tray click reopens it.
    crate::commands::lifecycle::set_lifecycle_state(
        &app,
        hq_desktop_core::lifecycle::LifecycleState::SteadyState,
    );
    Ok(())
}

/// Toggle the main window's translucent popover backdrop. The onboarding is a
/// transparent floating card over the real desktop, so while it is up we clear
/// the vibrancy (otherwise the frosted popover material shows through the
/// transparent webview as a panel around the card). The tray handoff re-applies
/// it when the window becomes the compact popover.
#[tauri::command]
pub fn set_main_window_vibrancy(app: AppHandle, enabled: bool) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if let Some(window) = app.get_webview_window("main") {
        if enabled {
            hq_platform::window_effects::apply_popover_vibrancy(&window);
        } else {
            hq_platform::window_effects::clear_popover_vibrancy(&window);
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, enabled);
    }
}

/// Pending-route prefix that marks a first-run handoff hint. The desktop shell
/// parses it in `parseFirstRunHandoffHint`
/// (`packages/ui/src/chat/first-run/first-run-handoff.ts`).
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub const FIRST_RUN_HANDOFF_PREFIX: &str = "first-run-handoff:";

/// The flags the desktop shell's first-run route needs before it can choose
/// between the takeover and the ordinary shell.
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub const FIRST_RUN_HINT_FLAGS: [&str; 2] =
    ["desktop.visual-first-run", "desktop.first-run-found-apps-v1"];

/// Upper bound on the flag reads the handoff makes before it opens the
/// desktop window. A flag still unanswered goes out as `null` and the shell
/// reads it itself, as it did before the hint existed.
#[cfg(not(target_os = "windows"))]
const FIRST_RUN_HINT_FLAG_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

/// The handoff hint queued as the desktop window's pending route, so the shell
/// knows on its first frame whether it owes the first-run takeover instead of
/// waiting up to 2 s for its own setup-status and flag reads. `None` flags are
/// unknown (sent as `null`).
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub fn first_run_handoff_hint(
    visual_first_run: Option<bool>,
    found_apps: Option<bool>,
    welcome_setup_owed: bool,
    welcome_tour_shown: bool,
) -> String {
    let payload = serde_json::json!({
        "route": Value::Null,
        "flags": {
            FIRST_RUN_HINT_FLAGS[0]: visual_first_run,
            FIRST_RUN_HINT_FLAGS[1]: found_apps,
        },
        "welcomeSetupOwed": welcome_setup_owed,
        "welcomeTourShown": welcome_tour_shown,
    });
    format!("{FIRST_RUN_HANDOFF_PREFIX}{payload}")
}

#[cfg(not(target_os = "windows"))]
fn handoff_flag_value(read: Result<Option<bool>, ()>) -> Option<bool> {
    read.ok().flatten()
}

#[cfg(not(target_os = "windows"))]
async fn first_run_handoff_hint_now() -> String {
    async fn bounded(flag: &str) -> Option<bool> {
        tokio::time::timeout(
            FIRST_RUN_HINT_FLAG_TIMEOUT,
            crate::commands::hq_pro::feature_flag_read(flag),
        )
        .await
        .ok()
        .and_then(handoff_flag_value)
    }
    let (visual, found_apps) = tokio::join!(
        bounded(FIRST_RUN_HINT_FLAGS[0]),
        bounded(FIRST_RUN_HINT_FLAGS[1])
    );
    let status = crate::commands::lifecycle::get_setup_status();
    first_run_handoff_hint(
        visual,
        found_apps,
        status.welcome_setup_owed,
        status.welcome_tour_shown,
    )
}

/// Hand first-run off to the desktop workspace: open the desktop window, then
/// hide the installer card in `main` (on macOS and Linux, only once the
/// desktop window has painted its first-run view; see
/// `desktop_alt::open_desktop_alt_for_first_run`).
///
/// The command keeps its historical name (the onboarding renderer invokes
/// `show_main_window_at_tray` when the wizard finishes). Onboarding is done at
/// that point, so `main` goes back to being the hidden controller and the user
/// lands in the desktop window.
///
/// The order matters: the card is only dismissed once the desktop window has
/// actually opened. If opening fails, the error is returned with the card
/// still on screen rather than leaving the user with no window at all.
#[tauri::command]
pub async fn show_main_window_at_tray(
    app: AppHandle,
    state: State<'_, LaunchKindState>,
) -> Result<(), String> {
    // macOS and Linux (US-010): the desktop window is built hidden with the
    // handoff hint queued, shown once its first-run takeover has painted, and
    // only then is the welcome window hidden. Windows keeps the original
    // open-then-hide order.
    #[cfg(not(target_os = "windows"))]
    {
        // The flag reads start now and run while the desktop window builds.
        let hint = tauri::async_runtime::spawn(first_run_handoff_hint_now());
        crate::commands::desktop_alt::open_desktop_alt_for_first_run(app.clone(), hint).await?;
    }
    #[cfg(target_os = "windows")]
    {
        crate::commands::desktop_alt::open_desktop_alt_window_inner(app.clone(), None).await?;
        crate::tray::hide_onboarding_window(&app);
    }
    let launch_kind = state.0;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let flag_enabled =
            crate::commands::hq_pro::feature_flag_enabled(FIRST_LAUNCH_SYNC_FLAG).await;
        if !should_sync_after_first_run_handoff(
            flag_enabled,
            launch_kind,
            crate::commands::daemon::is_realtime_sync_enabled(),
        ) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        if let Err(error) = crate::commands::sync::start_sync_with_trigger(
            handle,
            None,
            crate::commands::cdp_mirror::SyncTrigger::First,
        )
        .await
        {
            crate::util::logfile::log(
                "first-run",
                &format!("first-launch sync did not start: {error}"),
            );
            report_first_launch_sync_start_failure(&error);
        }
    });
    Ok(())
}

/// Mark the one-time auto-sync notice as shown for an updating user. Also sets
/// `firstRunCompleted` so the next launch classifies as `Normal`. Deliberately
/// does NOT touch `realtimeSync` — opt-outs are respected.
#[tauri::command]
pub fn mark_auto_sync_notice_shown() -> Result<(), String> {
    let path = paths::menubar_json_path()?;
    merge_menubar_flags(
        &path,
        &[
            ("autoSyncNoticeShown", Value::Bool(true)),
            ("firstRunCompleted", Value::Bool(true)),
        ],
    )
}

#[cfg(test)]
mod first_launch_sync_start_capture_tests {
    use super::*;

    #[test]
    fn first_launch_sync_start_failure_is_captured_with_bounded_content() {
        let captures = sentry::test::with_captured_events(|| {
            report_first_launch_sync_start_failure(
                "first-run user-specific path and token-bearing server detail",
            );
        });

        assert_eq!(captures.len(), 1, "start failure creates one Sentry event");
        let event = captures.into_iter().next().expect("capture exists");
        assert_eq!(
            event.message.as_deref(),
            Some("[sync] first-launch sync start failed")
        );
        assert_eq!(
            event.tags.get("path").map(String::as_str),
            Some("(first-launch)")
        );
        assert_eq!(
            event.tags.get("failure_category").map(String::as_str),
            Some("other")
        );
        assert_eq!(
            event.fingerprint,
            vec!["sync", FIRST_LAUNCH_SYNC_START_FAILURE_FINGERPRINT]
        );
        let serialized = serde_json::to_string(&event).expect("serialize event");
        assert!(!serialized.contains("first-run user-specific path"));
        assert!(!serialized.contains("token-bearing server detail"));
    }

    #[test]
    fn first_launch_sync_start_error_categories_are_closed() {
        assert_eq!(
            first_launch_sync_start_error_category("Sync is already running"),
            "already_running"
        );
        assert_eq!(
            first_launch_sync_start_error_category(hq_desktop_core::daemon::CLOUD_PAUSED_MESSAGE),
            "cloud_paused"
        );
        assert_eq!(
            first_launch_sync_start_error_category("untrusted detail"),
            "other"
        );
    }
}

#[cfg(test)]
mod first_run_handoff_hint_tests {
    use super::*;

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn failed_flag_read_stays_unknown_in_the_handoff_payload() {
        let hint = first_run_handoff_hint(handoff_flag_value(Err(())), Some(false), true, false);
        assert_eq!(payload(&hint)["flags"][FIRST_RUN_HINT_FLAGS[0]], Value::Null);
        assert_eq!(handoff_flag_value(Ok(Some(false))), Some(false));
        assert_eq!(handoff_flag_value(Ok(Some(true))), Some(true));
        assert_eq!(handoff_flag_value(Ok(None)), None);
    }

    fn payload(hint: &str) -> Value {
        let json = hint
            .strip_prefix(FIRST_RUN_HANDOFF_PREFIX)
            .expect("hint carries the handoff prefix");
        serde_json::from_str(json).expect("hint payload is JSON")
    }

    #[test]
    fn hint_carries_route_flags_and_setup_status() {
        let hint = first_run_handoff_hint(Some(true), Some(false), true, false);
        assert_eq!(
            payload(&hint),
            serde_json::json!({
                "route": null,
                "flags": {
                    "desktop.visual-first-run": true,
                    "desktop.first-run-found-apps-v1": false,
                },
                "welcomeSetupOwed": true,
                "welcomeTourShown": false,
            })
        );
    }

    #[test]
    fn unanswered_flags_go_out_as_null() {
        let hint = first_run_handoff_hint(None, None, false, true);
        let value = payload(&hint);
        assert_eq!(value["flags"]["desktop.visual-first-run"], Value::Null);
        assert_eq!(value["flags"]["desktop.first-run-found-apps-v1"], Value::Null);
        assert_eq!(value["welcomeSetupOwed"], Value::Bool(false));
        assert_eq!(value["welcomeTourShown"], Value::Bool(true));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn hint_flag_reads_are_bounded_below_the_shells_status_wait() {
        // The shell's own status wait is WELCOME_OWED_TIMEOUT_MS (2000).
        assert!(FIRST_RUN_HINT_FLAG_TIMEOUT < std::time::Duration::from_millis(2000));
    }
}
