//! Tauri-facing update gate: managed state, commands, and focus tracking.
//!
//! The pure decision logic lives in `hq_desktop_core::update_gate`. This
//! module owns the Tauri managed state wrappers and the window-focus tracker.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use hq_desktop_core::update_gate::{
    decide, AppFocus, DeferReason, HoldReason, UpdateDecision, UpdateHolds, UpdateTrigger,
};

use crate::util::logfile::log;

const LOG_TAG: &str = "update-gate";

// ── Managed state ─────────────────────────────────────────────────────────────

/// Managed state carrying the shared hold registry.
pub struct UpdateHoldsState(pub UpdateHolds);

impl Default for UpdateHoldsState {
    fn default() -> Self {
        Self(UpdateHolds::new())
    }
}

/// Managed state carrying the app-wide focus flag.
/// `true` = at least one window is focused.
pub struct AppFocusState(pub Arc<AtomicBool>);

impl Default for AppFocusState {
    fn default() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
}

impl AppFocusState {
    pub fn is_focused(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    pub fn set_focused(&self, focused: bool) {
        self.0.store(focused, Ordering::Relaxed);
    }

    pub fn app_focus(&self) -> AppFocus {
        if self.is_focused() {
            AppFocus::Focused
        } else {
            AppFocus::Unfocused
        }
    }
}

// ── Gate status payload ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGateStatus {
    pub pending_version: Option<String>,
    pub decision: UpdateDecision,
    pub reasons: Vec<HoldReason>,
    pub focused: bool,
}

// ── Helper: read current gate status (no app handle needed for decision) ──────

pub fn current_gate_status(
    holds: &UpdateHoldsState,
    focus: &AppFocusState,
    pending_version: Option<String>,
    trigger: UpdateTrigger,
) -> UpdateGateStatus {
    let app_focus = focus.app_focus();
    let decision = decide(trigger, app_focus, &holds.0);
    let reasons = holds.0.active();
    UpdateGateStatus {
        pending_version,
        decision,
        reasons,
        focused: focus.is_focused(),
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn update_hold_acquire(
    reason: HoldReason,
    holds: State<'_, UpdateHoldsState>,
) {
    log(LOG_TAG, &format!("acquire hold: {reason}"));
    holds.0.acquire(reason);
}

#[tauri::command]
pub fn update_hold_release(
    reason: HoldReason,
    holds: State<'_, UpdateHoldsState>,
) {
    log(LOG_TAG, &format!("release hold: {reason}"));
    holds.0.release(reason);
}

#[tauri::command]
pub fn update_gate_status(
    holds: State<'_, UpdateHoldsState>,
    focus: State<'_, AppFocusState>,
) -> UpdateGateStatus {
    // pending_version omitted: frontend can read it from get_update_status.
    current_gate_status(&holds, &focus, None, UpdateTrigger::Automatic)
}

// ── Focus tracking ─────────────────────────────────────────────────────────────

/// Called from main.rs `on_window_event` for every window's focus events.
pub fn on_window_focus_changed(app: &AppHandle, focused: bool) {
    if let Some(focus_state) = app.try_state::<AppFocusState>() {
        // If gaining focus: set to true immediately.
        // If losing focus: scan all windows to confirm none are focused
        // (another window may still be focused on this platform).
        let new_val = if focused {
            true
        } else {
            // Any window still focused?
            app.webview_windows()
                .values()
                .any(|w| w.is_focused().unwrap_or(false))
        };
        let old = focus_state.is_focused();
        if old != new_val {
            focus_state.set_focused(new_val);
            log(LOG_TAG, &format!("app focus changed: {old} -> {new_val}"));
        }
    }
}

// ── App-side integration tests ─────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use hq_desktop_core::update_gate::{AppFocus, HoldReason, UpdateDecision, UpdateTrigger};

    #[test]
    fn meeting_hold_blocks_automatic_install() {
        let holds = UpdateHoldsState::default();
        let focus = AppFocusState::default();
        holds.0.acquire(HoldReason::MeetingRecording);

        let d = decide(UpdateTrigger::Automatic, focus.app_focus(), &holds.0);
        assert!(
            matches!(d, UpdateDecision::Defer { .. }),
            "expected Defer, got {d:?}"
        );
    }

    #[test]
    fn releasing_meeting_hold_allows_unfocused_automatic_install() {
        let holds = UpdateHoldsState::default();
        let focus = AppFocusState::default();
        holds.0.acquire(HoldReason::MeetingRecording);
        holds.0.release(HoldReason::MeetingRecording);

        let d = decide(UpdateTrigger::Automatic, AppFocus::Unfocused, &holds.0);
        assert_eq!(d, UpdateDecision::InstallNow);
    }

    #[test]
    fn focused_automatic_defers_without_hold() {
        let holds = UpdateHoldsState::default();
        let d = decide(UpdateTrigger::Automatic, AppFocus::Focused, &holds.0);
        assert!(matches!(
            d,
            UpdateDecision::Defer {
                reason: hq_desktop_core::update_gate::DeferReason::Focused
            }
        ));
    }

    #[test]
    fn manual_install_while_focused_succeeds_with_no_holds() {
        let holds = UpdateHoldsState::default();
        let d = decide(UpdateTrigger::Manual, AppFocus::Focused, &holds.0);
        assert_eq!(d, UpdateDecision::InstallNow);
    }

    #[test]
    fn manual_install_blocked_by_hold_even_unfocused() {
        let holds = UpdateHoldsState::default();
        holds.0.acquire(HoldReason::CoreUpdateInProgress);
        let d = decide(UpdateTrigger::Manual, AppFocus::Unfocused, &holds.0);
        assert!(matches!(d, UpdateDecision::Defer { .. }));
    }
}
