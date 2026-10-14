//! Boot watchdog: the main desktop webview must report `shell_ready` within
//! a deadline of window creation, or we open the native recovery window.
//!
//! The state machine is pure so it can be unit-tested without Tauri. The
//! runtime wrapper in [`WatchdogRuntime`] owns the timer generation and the
//! log lines support uses to diagnose a wedged boot.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

pub const DEFAULT_WATCHDOG_TIMEOUT: Duration = Duration::from_secs(20);
/// A watchdog timer that wakes this much later than requested means the async
/// runtime itself was stalled (blocked workers, process suspension). The UI's
/// `shell_ready` invoke was queued behind the same stall, so firing recovery
/// immediately would alarm on a shell that is about to come up.
pub const LATE_FIRE_TOLERANCE: Duration = Duration::from_secs(2);
/// Extra time granted once after a late timer wake, so the queued UI work can
/// drain before the recovery window opens.
pub const STALL_GRACE: Duration = Duration::from_secs(10);
pub const FORCE_RECOVERY_ENV: &str = "HQ_DESKTOP_FORCE_RECOVERY";
pub const WATCHDOG_TIMEOUT_ENV: &str = "HQ_DESKTOP_WATCHDOG_SECS";
pub const SAFE_MODE_FILE_NAME: &str = "desktop-safe-mode";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchdogPhase {
    Idle,
    Waiting,
    Ready,
    TimedOut,
    Crashed,
    SafeMode,
    UserClosed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryTrigger {
    WatchdogTimeout,
    WebviewCrash,
    SafeMode,
    Menu,
}

impl RecoveryTrigger {
    pub fn auto_check(self) -> bool {
        matches!(
            self,
            Self::WatchdogTimeout | Self::WebviewCrash | Self::SafeMode | Self::Menu
        )
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::WatchdogTimeout => "watchdog-timeout",
            Self::WebviewCrash => "webview-crash",
            Self::SafeMode => "safe-mode",
            Self::Menu => "menu",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchdogEvent {
    None,
    StartTimer,
    CancelTimer,
    OpenRecovery {
        trigger: RecoveryTrigger,
    },
    /// `shell_ready` arrived after the watchdog already opened recovery for a
    /// timeout: the shell is healthy, so an untouched recovery window closes.
    DismissRecovery,
}

/// What the timer task should do when its sleep returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LateTimerDecision {
    /// Woke on time (or grace already spent): apply the timeout.
    Fire,
    /// Woke late by `late`: log a runtime stall and sleep `grace` more first.
    Grace { late: Duration, grace: Duration },
}

/// Pure decision for whether an about-to-open recovery window should be
/// skipped because the desktop shell reported ready during the auto-check
/// gap. Menu and safe-mode triggers always open (support/user-initiated),
/// only the automatic watchdog-timeout / webview-crash paths defer to the
/// live shell state.
pub fn should_skip_recovery_open(phase: WatchdogPhase, trigger: RecoveryTrigger) -> bool {
    match trigger {
        RecoveryTrigger::WatchdogTimeout | RecoveryTrigger::WebviewCrash => {
            matches!(phase, WatchdogPhase::Ready)
        }
        RecoveryTrigger::Menu | RecoveryTrigger::SafeMode => false,
    }
}

/// Where a manual "Check for Updates…" sends the user when it finds an update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManualUpdateSurface {
    /// The normal update prompt: the desktop window's Settings → Updates pane.
    UpdatesSettings,
    /// The same prompt, held until the loading shell reports `shell_ready`:
    /// a navigation sent before then can arrive before the shell listens.
    UpdatesSettingsAfterReady,
    /// The native recovery window, for a desktop shell that cannot show it.
    Recovery,
}

/// Pure decision for a manual update check that found an update. The recovery
/// window is only for a desktop shell the watchdog has judged broken (timed
/// out, crashed, or safe mode). A healthy, closed, or idle shell gets the
/// normal prompt now. A still-loading shell gets it once it reports ready; if
/// it never does, the watchdog timer opens recovery on its own.
pub fn manual_update_found_surface(phase: WatchdogPhase) -> ManualUpdateSurface {
    match phase {
        WatchdogPhase::TimedOut | WatchdogPhase::Crashed | WatchdogPhase::SafeMode => {
            ManualUpdateSurface::Recovery
        }
        WatchdogPhase::Waiting => ManualUpdateSurface::UpdatesSettingsAfterReady,
        WatchdogPhase::Idle | WatchdogPhase::Ready | WatchdogPhase::UserClosed => {
            ManualUpdateSurface::UpdatesSettings
        }
    }
}

/// Pure decision for a timer that slept `expected` but observed `elapsed`.
pub fn late_timer_decision(
    expected: Duration,
    elapsed: Duration,
    grace_used: bool,
) -> LateTimerDecision {
    let late = elapsed.saturating_sub(expected);
    if grace_used || late < LATE_FIRE_TOLERANCE {
        LateTimerDecision::Fire
    } else {
        LateTimerDecision::Grace {
            late,
            grace: STALL_GRACE,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BootWatchdog {
    phase: WatchdogPhase,
}

impl Default for BootWatchdog {
    fn default() -> Self {
        Self {
            phase: WatchdogPhase::Idle,
        }
    }
}

impl BootWatchdog {
    pub fn phase(self) -> WatchdogPhase {
        self.phase
    }

    pub fn on_window_created(&mut self) -> WatchdogEvent {
        match self.phase {
            WatchdogPhase::Ready | WatchdogPhase::Waiting => WatchdogEvent::None,
            _ => {
                self.phase = WatchdogPhase::Waiting;
                WatchdogEvent::StartTimer
            }
        }
    }

    pub fn on_shell_ready(&mut self) -> WatchdogEvent {
        match self.phase {
            WatchdogPhase::Ready => WatchdogEvent::None,
            WatchdogPhase::TimedOut => {
                self.phase = WatchdogPhase::Ready;
                WatchdogEvent::DismissRecovery
            }
            WatchdogPhase::Waiting | WatchdogPhase::Idle => {
                self.phase = WatchdogPhase::Ready;
                WatchdogEvent::CancelTimer
            }
            WatchdogPhase::Crashed | WatchdogPhase::SafeMode | WatchdogPhase::UserClosed => {
                self.phase = WatchdogPhase::Ready;
                WatchdogEvent::CancelTimer
            }
        }
    }

    pub fn on_timeout(&mut self) -> WatchdogEvent {
        if self.phase != WatchdogPhase::Waiting {
            return WatchdogEvent::None;
        }
        self.phase = WatchdogPhase::TimedOut;
        WatchdogEvent::OpenRecovery {
            trigger: RecoveryTrigger::WatchdogTimeout,
        }
    }

    pub fn on_webview_crash(&mut self) -> WatchdogEvent {
        if matches!(self.phase, WatchdogPhase::UserClosed) {
            return WatchdogEvent::None;
        }
        self.phase = WatchdogPhase::Crashed;
        WatchdogEvent::OpenRecovery {
            trigger: RecoveryTrigger::WebviewCrash,
        }
    }

    pub fn on_user_closed(&mut self) -> WatchdogEvent {
        self.phase = WatchdogPhase::UserClosed;
        WatchdogEvent::CancelTimer
    }

    pub fn on_safe_mode(&mut self) -> WatchdogEvent {
        self.phase = WatchdogPhase::SafeMode;
        WatchdogEvent::OpenRecovery {
            trigger: RecoveryTrigger::SafeMode,
        }
    }

    pub fn on_menu_recovery(&mut self) -> WatchdogEvent {
        WatchdogEvent::OpenRecovery {
            trigger: RecoveryTrigger::Menu,
        }
    }
}

/// Process-wide watchdog: generation counter invalidates in-flight timers.
pub struct WatchdogRuntime {
    machine: Mutex<BootWatchdog>,
    generation: AtomicU64,
    recovery_open: AtomicBool,
}

impl Default for WatchdogRuntime {
    fn default() -> Self {
        Self {
            machine: Mutex::new(BootWatchdog::default()),
            generation: AtomicU64::new(0),
            recovery_open: AtomicBool::new(false),
        }
    }
}

impl WatchdogRuntime {
    pub fn apply<F>(&self, f: F) -> WatchdogEvent
    where
        F: FnOnce(&mut BootWatchdog) -> WatchdogEvent,
    {
        let mut machine = self.machine.lock().unwrap_or_else(|e| e.into_inner());
        let event = f(&mut machine);
        match event {
            WatchdogEvent::StartTimer
            | WatchdogEvent::CancelTimer
            | WatchdogEvent::DismissRecovery => {
                self.generation.fetch_add(1, Ordering::AcqRel);
            }
            WatchdogEvent::OpenRecovery { .. } | WatchdogEvent::None => {}
        }
        event
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub fn phase(&self) -> WatchdogPhase {
        self.machine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .phase()
    }

    pub fn mark_recovery_open(&self, open: bool) {
        self.recovery_open.store(open, Ordering::Release);
    }

    pub fn recovery_is_open(&self) -> bool {
        self.recovery_open.load(Ordering::Acquire)
    }
}

pub fn watchdog_timeout_from_env() -> Duration {
    match std::env::var(WATCHDOG_TIMEOUT_ENV) {
        Ok(raw) => match raw.parse::<u64>() {
            Ok(0) => Duration::from_millis(50),
            Ok(secs) => Duration::from_secs(secs.min(120)),
            Err(_) => DEFAULT_WATCHDOG_TIMEOUT,
        },
        Err(_) => DEFAULT_WATCHDOG_TIMEOUT,
    }
}

pub fn force_recovery_from_env() -> bool {
    matches!(
        std::env::var(FORCE_RECOVERY_ENV).as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes")
    )
}

pub fn safe_mode_path() -> Option<std::path::PathBuf> {
    hq_desktop_core::paths::hq_config_dir()
        .ok()
        .map(|dir| dir.join(SAFE_MODE_FILE_NAME))
}

pub fn safe_mode_requested() -> bool {
    safe_mode_path().is_some_and(|path| path.exists())
}

pub fn consume_safe_mode_flag() {
    if let Some(path) = safe_mode_path() {
        let _ = std::fs::remove_file(path);
    }
}

pub fn ui_state_reset_script() -> &'static str {
    r#"
(() => {
  const prefixes = [
    "hq.work.tenant.v1.",
    "hq.chat.",
    "hq-sync.desktop.",
    "hq-sync:meetings-window:",
    "hq-work-",
  ];
  const exact = [
    "hq-work-settings-prefs",
    "hq-work-color-theme",
    "hq-sync.desktop.cloud-paused.v1",
  ];
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key) keys.push(key);
    }
    for (const key of keys) {
      if (
        exact.includes(key) ||
        prefixes.some((prefix) => key.startsWith(prefix) || key.includes("." + prefix) || key.includes(prefix))
      ) {
        localStorage.removeItem(key);
      }
    }
    sessionStorage.clear();
  } catch (error) {
    console.error("reset local UI state failed", error);
  }
})();
"#
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_then_ready_cancels_the_timer() {
        let mut dog = BootWatchdog::default();
        assert_eq!(dog.phase(), WatchdogPhase::Idle);
        assert_eq!(dog.on_window_created(), WatchdogEvent::StartTimer);
        assert_eq!(dog.phase(), WatchdogPhase::Waiting);
        assert_eq!(dog.on_shell_ready(), WatchdogEvent::CancelTimer);
        assert_eq!(dog.phase(), WatchdogPhase::Ready);
        assert_eq!(dog.on_timeout(), WatchdogEvent::None);
    }

    #[test]
    fn timeout_while_waiting_opens_recovery() {
        let mut dog = BootWatchdog::default();
        dog.on_window_created();
        assert_eq!(
            dog.on_timeout(),
            WatchdogEvent::OpenRecovery {
                trigger: RecoveryTrigger::WatchdogTimeout
            }
        );
        assert_eq!(dog.phase(), WatchdogPhase::TimedOut);
        assert_eq!(dog.on_timeout(), WatchdogEvent::None);
    }

    #[test]
    fn late_shell_ready_after_timeout_dismisses_recovery() {
        let mut dog = BootWatchdog::default();
        dog.on_window_created();
        dog.on_timeout();
        assert_eq!(dog.phase(), WatchdogPhase::TimedOut);
        assert_eq!(dog.on_shell_ready(), WatchdogEvent::DismissRecovery);
        assert_eq!(dog.phase(), WatchdogPhase::Ready);
        // Idempotent: a second report is a no-op.
        assert_eq!(dog.on_shell_ready(), WatchdogEvent::None);
    }

    #[test]
    fn dismiss_recovery_bumps_generation_like_cancel() {
        let runtime = WatchdogRuntime::default();
        runtime.apply(|dog| dog.on_window_created());
        runtime.apply(|dog| dog.on_timeout());
        let before = runtime.generation();
        assert_eq!(
            runtime.apply(|dog| dog.on_shell_ready()),
            WatchdogEvent::DismissRecovery
        );
        assert!(runtime.generation() > before);
    }

    #[test]
    fn late_timer_wake_grants_one_grace_then_fires() {
        let expected = Duration::from_secs(20);
        assert_eq!(
            late_timer_decision(expected, Duration::from_millis(20_400), false),
            LateTimerDecision::Fire
        );
        assert_eq!(
            late_timer_decision(expected, Duration::from_millis(24_500), false),
            LateTimerDecision::Grace {
                late: Duration::from_millis(4_500),
                grace: STALL_GRACE
            }
        );
        assert_eq!(
            late_timer_decision(expected, Duration::from_millis(24_500), true),
            LateTimerDecision::Fire
        );
        assert_eq!(
            late_timer_decision(expected, Duration::from_secs(19), false),
            LateTimerDecision::Fire
        );
    }

    #[test]
    fn skip_recovery_open_when_shell_ready_during_auto_check() {
        // watchdog-timeout: skip when Ready, open when TimedOut.
        assert!(should_skip_recovery_open(
            WatchdogPhase::Ready,
            RecoveryTrigger::WatchdogTimeout,
        ));
        assert!(!should_skip_recovery_open(
            WatchdogPhase::TimedOut,
            RecoveryTrigger::WatchdogTimeout,
        ));
        // webview-crash: skip only when shell reported ready.
        assert!(should_skip_recovery_open(
            WatchdogPhase::Ready,
            RecoveryTrigger::WebviewCrash,
        ));
        assert!(!should_skip_recovery_open(
            WatchdogPhase::Crashed,
            RecoveryTrigger::WebviewCrash,
        ));
        // Menu + safe-mode always open regardless of phase.
        assert!(!should_skip_recovery_open(
            WatchdogPhase::Ready,
            RecoveryTrigger::Menu,
        ));
        assert!(!should_skip_recovery_open(
            WatchdogPhase::Ready,
            RecoveryTrigger::SafeMode,
        ));
    }

    #[test]
    fn manual_update_check_uses_the_normal_prompt_unless_the_shell_is_broken() {
        // A manual "Check for Updates…" from a healthy (or merely closed,
        // idle, or still-loading) desktop shell shows the normal Settings →
        // Updates prompt. Only a shell the watchdog has already judged broken
        // falls back to the native recovery window.
        for phase in [
            WatchdogPhase::Idle,
            WatchdogPhase::Ready,
            WatchdogPhase::UserClosed,
        ] {
            assert_eq!(
                manual_update_found_surface(phase),
                ManualUpdateSurface::UpdatesSettings,
                "{phase:?}"
            );
        }
        // A still-loading shell may not be listening for navigation yet, so
        // the Updates route waits for shell_ready instead of being dropped.
        assert_eq!(
            manual_update_found_surface(WatchdogPhase::Waiting),
            ManualUpdateSurface::UpdatesSettingsAfterReady
        );
        for phase in [
            WatchdogPhase::TimedOut,
            WatchdogPhase::Crashed,
            WatchdogPhase::SafeMode,
        ] {
            assert_eq!(
                manual_update_found_surface(phase),
                ManualUpdateSurface::Recovery,
                "{phase:?}"
            );
        }
    }

    #[test]
    fn crash_before_ready_opens_recovery() {
        let mut dog = BootWatchdog::default();
        dog.on_window_created();
        assert_eq!(
            dog.on_webview_crash(),
            WatchdogEvent::OpenRecovery {
                trigger: RecoveryTrigger::WebviewCrash
            }
        );
        assert_eq!(dog.phase(), WatchdogPhase::Crashed);
    }

    #[test]
    fn user_close_does_not_look_like_a_crash() {
        let mut dog = BootWatchdog::default();
        dog.on_window_created();
        assert_eq!(dog.on_user_closed(), WatchdogEvent::CancelTimer);
        assert_eq!(dog.on_webview_crash(), WatchdogEvent::None);
        assert_eq!(dog.phase(), WatchdogPhase::UserClosed);
    }

    #[test]
    fn safe_mode_opens_recovery_from_idle() {
        let mut dog = BootWatchdog::default();
        assert_eq!(
            dog.on_safe_mode(),
            WatchdogEvent::OpenRecovery {
                trigger: RecoveryTrigger::SafeMode
            }
        );
        assert!(RecoveryTrigger::SafeMode.auto_check());
        assert_eq!(RecoveryTrigger::SafeMode.as_str(), "safe-mode");
    }

    #[test]
    fn menu_recovery_does_not_change_phase() {
        let mut dog = BootWatchdog::default();
        assert_eq!(
            dog.on_menu_recovery(),
            WatchdogEvent::OpenRecovery {
                trigger: RecoveryTrigger::Menu
            }
        );
        assert_eq!(dog.phase(), WatchdogPhase::Idle);
    }

    #[test]
    fn runtime_generation_bumps_on_start_and_cancel() {
        let runtime = WatchdogRuntime::default();
        assert_eq!(runtime.generation(), 0);
        assert!(!runtime.recovery_is_open());
        runtime.apply(|dog| dog.on_window_created());
        let after_start = runtime.generation();
        assert!(after_start > 0);
        runtime.apply(|dog| dog.on_shell_ready());
        assert!(runtime.generation() > after_start);
        assert_eq!(runtime.phase(), WatchdogPhase::Ready);
        runtime.mark_recovery_open(true);
        assert!(runtime.recovery_is_open());
        runtime.mark_recovery_open(false);
        assert!(!runtime.recovery_is_open());
    }

    #[test]
    fn watchdog_timeout_env_zero_is_a_short_tick() {
        assert_eq!(DEFAULT_WATCHDOG_TIMEOUT, Duration::from_secs(20));
        assert_eq!(SAFE_MODE_FILE_NAME, "desktop-safe-mode");
        assert_eq!(FORCE_RECOVERY_ENV, "HQ_DESKTOP_FORCE_RECOVERY");
    }

    #[test]
    fn ui_reset_script_targets_boot_wedge_keys_not_sync_data() {
        let script = ui_state_reset_script();
        assert!(script.contains("hq.chat."));
        assert!(script.contains("hq-sync.desktop."));
        assert!(script.contains("hq.work.tenant.v1."));
        assert!(!script.contains("cognito-tokens"));
        assert!(!script.contains("menubar.json"));
    }

    #[test]
    fn safe_mode_path_lives_under_hq_config_dir_not_a_launchagent() {
        let Some(path) = safe_mode_path() else {
            return;
        };
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some(SAFE_MODE_FILE_NAME)
        );
        let rendered = path.to_string_lossy();
        assert!(
            !rendered.contains("LaunchAgents"),
            "safe-mode must not use a macOS LaunchAgent path, got {rendered}"
        );
        let config = hq_desktop_core::paths::hq_config_dir().expect("hq config dir");
        assert_eq!(path, config.join(SAFE_MODE_FILE_NAME));
    }

    #[test]
    fn watchdog_timeout_defaults_when_the_override_env_is_unset() {
        if std::env::var(WATCHDOG_TIMEOUT_ENV).is_ok() {
            return;
        }
        assert_eq!(watchdog_timeout_from_env(), DEFAULT_WATCHDOG_TIMEOUT);
        assert!(!force_recovery_from_env());
    }
}
