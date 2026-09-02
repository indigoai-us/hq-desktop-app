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
    OpenRecovery { trigger: RecoveryTrigger },
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
            WatchdogPhase::Waiting | WatchdogPhase::Idle | WatchdogPhase::TimedOut => {
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
            WatchdogEvent::StartTimer | WatchdogEvent::CancelTimer => {
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
        runtime.apply(|dog| dog.on_window_created());
        let after_start = runtime.generation();
        assert!(after_start > 0);
        runtime.apply(|dog| dog.on_shell_ready());
        assert!(runtime.generation() > after_start);
        assert_eq!(runtime.phase(), WatchdogPhase::Ready);
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
}
