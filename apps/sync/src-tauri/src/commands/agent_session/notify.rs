//! "Needs you" notifications for in-app agent sessions.
//!
//! # Why this is its own module
//!
//! The drivers ([`super::claude`], [`super::codex`]) already know when a
//! session parks on the human — they emit `agent-session:needs-you` and the
//! `needsYou` phase edge. What they must NOT grow is knowledge of banners,
//! Cocoa notifications, or the tray. This module owns all three, and the
//! drivers reach it through exactly two one-line hooks in
//! `AppSink::emit_needs_you` / `AppSink::emit_phase` — the single emit site
//! both CLIs share.
//!
//! # One banner per parking, not per request
//!
//! A single turn can produce a burst of `can_use_tool` requests, and the
//! registry emits one `NeedsYou` for each. The phase, however, only *changes*
//! on the first — `Working → NeedsYou` — and stays put until the human answers.
//! [`NeedsYouDebounce`] rides that edge: the first `NeedsYou` after entering the
//! phase fires, the rest are swallowed, and the arm resets when the phase LEAVES
//! `needsYou` (answered, interrupted, ended). So the user gets one banner per
//! time a session actually stops and waits for them.
//!
//! # The badge is derived, never accumulated
//!
//! `set_session_badge` is recomputed from a registry snapshot on every phase
//! change rather than incremented/decremented. A counter would drift the first
//! time a session ended while parked, or a phase event was dropped; a
//! recomputed count cannot.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use hq_desktop_core::agent_session::registry::{NeedsYou, PhaseChange, SessionSummary};
use hq_desktop_core::agent_session::types::{SessionPhase, SessionTool};
use hq_desktop_core::banner::BannerPayload;
use tauri::AppHandle;

use crate::util::logfile::log;

const LOG_TAG: &str = "agent-session-notify";

/// Banner `kind`, routed by `App.svelte`'s banner-action router.
pub const BANNER_KIND: &str = "session";

/// Body-click and chip both do the same thing: open the session.
const ACTION_OPEN: &str = "open";

/// System-source avatar glyph, matching the meeting/update banners.
const ICON_TEXT: &str = "●";

// ─────────────────────────────────────────────────────────────────────────────
// The event
// ─────────────────────────────────────────────────────────────────────────────

/// One session parked on the human, enriched with the session properties the
/// notification copy needs (which [`NeedsYou`] alone does not carry).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionNeedsYou {
    pub session_id: String,
    pub request_id: String,
    /// `permission` or `question`.
    pub reason: String,
    pub summary: String,
    pub company: Option<String>,
    pub tool: SessionTool,
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure payload construction
// ─────────────────────────────────────────────────────────────────────────────

/// `"Claude needs you"`, plus ` · {company}` when the session is bound to one.
pub fn banner_title(tool: SessionTool, company: Option<&str>) -> String {
    let base = match tool {
        SessionTool::Claude => "Claude needs you",
        SessionTool::Codex => "Codex needs you",
    };
    match company.map(str::trim).filter(|c| !c.is_empty()) {
        Some(company) => format!("{base} · {company}"),
        None => base.to_string(),
    }
}

/// The registry's one-line summary, or a reason-shaped fallback. A blank body
/// would render an empty banner row, which reads as a bug rather than a prompt.
pub fn banner_body(needs: &SessionNeedsYou) -> String {
    let summary = needs.summary.trim();
    if !summary.is_empty() {
        return summary.to_string();
    }
    match needs.reason.as_str() {
        "question" => "Waiting on your answer.".to_string(),
        _ => "Waiting on your permission decision.".to_string(),
    }
}

/// The neutral banner payload. `data` carries only the two ids the click needs;
/// unlike DM/share there is no server event to echo back, and the session's
/// live state is read from the registry when the window opens.
pub fn build_payload(needs: &SessionNeedsYou) -> BannerPayload {
    BannerPayload {
        kind: BANNER_KIND.to_string(),
        title: banner_title(needs.tool, needs.company.as_deref()),
        body: banner_body(needs),
        icon_text: Some(ICON_TEXT.to_string()),
        action_label: Some("Answer".to_string()),
        action_id: Some(ACTION_OPEN.to_string()),
        click_action_id: ACTION_OPEN.to_string(),
        data: serde_json::json!({
            "sessionId": needs.session_id,
            "requestId": needs.request_id,
        }),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Debounce
// ─────────────────────────────────────────────────────────────────────────────

/// Which sessions have already had a banner for their CURRENT stay in
/// `needsYou`. Membership means "already fired, stay quiet".
#[derive(Debug, Default)]
pub struct NeedsYouDebounce {
    fired: HashSet<String>,
}

impl NeedsYouDebounce {
    pub fn new() -> Self {
        Self::default()
    }

    /// True exactly once per entry into `needsYou`.
    pub fn should_fire(&mut self, session_id: &str) -> bool {
        self.fired.insert(session_id.to_string())
    }

    /// Re-arm on the phase edge that LEAVES `needsYou`, and forget a session
    /// entirely once it ends so a long-lived app does not retain dead ids.
    pub fn note_phase(&mut self, session_id: &str, change: PhaseChange) {
        if change.from == SessionPhase::NeedsYou || change.to == SessionPhase::Ended {
            self.fired.remove(session_id);
        }
    }

    /// Drop a session outright (ended, removed).
    pub fn forget(&mut self, session_id: &str) {
        self.fired.remove(session_id);
    }

    #[cfg(test)]
    fn is_armed(&self, session_id: &str) -> bool {
        !self.fired.contains(session_id)
    }
}

fn debounce() -> &'static Mutex<NeedsYouDebounce> {
    static DEBOUNCE: OnceLock<Mutex<NeedsYouDebounce>> = OnceLock::new();
    DEBOUNCE.get_or_init(|| Mutex::new(NeedsYouDebounce::new()))
}

// ─────────────────────────────────────────────────────────────────────────────
// Badge derivation
// ─────────────────────────────────────────────────────────────────────────────

/// How many sessions are parked on the human right now. Derived from the
/// registry snapshot so it cannot drift out of sync with the session list.
pub fn needs_you_count(rows: &[SessionSummary]) -> usize {
    rows.iter()
        .filter(|row| row.phase == SessionPhase::NeedsYou)
        .count()
}

// ─────────────────────────────────────────────────────────────────────────────
// Surfaces
// ─────────────────────────────────────────────────────────────────────────────

/// Raise the in-app banner for a parked session. Widget takeover forwarding is
/// inherited from [`crate::commands::banner::show_banner`].
pub async fn show_session_banner(app: AppHandle, needs: SessionNeedsYou) -> Result<(), String> {
    crate::commands::banner::show_banner(app, build_payload(&needs)).await
}

/// True when the desktop shell that hosts the Sessions surface is focused — in
/// which case the user is already looking at the session and a system
/// notification would be noise on top of the in-app banner.
fn desktop_window_focused(app: &AppHandle) -> bool {
    use tauri::Manager;
    app.get_webview_window(crate::commands::desktop_alt::WINDOW_LABEL)
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false)
}

/// Best-effort system notification, mirroring the banner's title/body. Skipped
/// when the desktop window is focused. Never fails the caller: a denied or
/// unavailable notification centre is not a reason to lose the banner.
fn notify_native(app: &AppHandle, needs: &SessionNeedsYou) {
    if desktop_window_focused(app) {
        return;
    }
    let title = banner_title(needs.tool, needs.company.as_deref());
    let body = banner_body(needs);

    #[cfg(target_os = "macos")]
    {
        // Same lazy bundle registration as dm_notify: without it the first send
        // pops a macOS "Choose Application" picker.
        static NOTIFICATION_APP_INIT: OnceLock<()> = OnceLock::new();
        NOTIFICATION_APP_INIT.get_or_init(|| {
            const BUNDLE_ID: &str = "ai.indigo.hq-sync-menubar";
            if let Err(e) = mac_notification_sys::set_application(BUNDLE_ID) {
                log(LOG_TAG, &format!("bundle set failed: {e}"));
            }
        });
        let session_id = needs.session_id.clone();
        tauri::async_runtime::spawn(async move {
            let sent = tokio::task::spawn_blocking(move || {
                // Fire-and-forget: the banner owns the interactive path, and
                // waiting on a native click would busy-spin a Cocoa run loop.
                let mut notification = mac_notification_sys::Notification::default();
                notification.title(&title).message(&body).asynchronous(true);
                notification.send()
            })
            .await;
            match sent {
                Ok(Ok(_)) => {}
                Ok(Err(e)) => log(
                    LOG_TAG,
                    &format!("session={session_id} native notify failed: {e}"),
                ),
                Err(e) => log(
                    LOG_TAG,
                    &format!("session={session_id} native notify worker failed: {e}"),
                ),
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        if let Err(e) = app
            .notification()
            .builder()
            .title(&title)
            .body(&body)
            .show()
        {
            log(LOG_TAG, &format!("native notify failed: {e}"));
        }
    }
}

/// Recompute the tray badge from the registry. Spawned rather than awaited:
/// the emit sites are synchronous and some of them still hold the session lock.
pub fn refresh_badge(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = super::state();
        let count = {
            let guard = state.lock().await;
            needs_you_count(&guard.registry.snapshot())
        };
        crate::tray::set_session_badge(&app, count);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver hooks
// ─────────────────────────────────────────────────────────────────────────────

/// Hook for `AppSink::emit_needs_you`. Debounced; enriches from the registry
/// off-thread because the sink is synchronous and the registry lock is async.
pub fn on_needs_you(app: &AppHandle, session_id: &str, needs: &NeedsYou) {
    let fire = debounce()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .should_fire(session_id);
    if !fire {
        return;
    }

    let app = app.clone();
    let session_id = session_id.to_string();
    let request_id = needs.request_id.clone();
    let reason = needs.reason.clone();
    let summary = needs.summary.clone();

    tauri::async_runtime::spawn(async move {
        let state = super::state();
        let session = {
            let guard = state.lock().await;
            guard
                .registry
                .get(&session_id)
                .map(|session| (session.spec.tool, session.spec.company.clone()))
        };
        // Gone between the emit and this lookup — nothing to open, so nothing
        // to announce. Re-arm so a later parking is not silently swallowed.
        let Some((tool, company)) = session else {
            debounce()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .forget(&session_id);
            return;
        };

        let needs = SessionNeedsYou {
            session_id,
            request_id,
            reason,
            summary,
            company,
            tool,
        };
        notify_native(&app, &needs);
        if let Err(e) = show_session_banner(app.clone(), needs.clone()).await {
            log(
                LOG_TAG,
                &format!("session={} banner failed: {e}", needs.session_id),
            );
        }
    });
}

/// Hook for `AppSink::emit_phase`. Owns both the debounce re-arm and the badge.
pub fn on_phase(app: &AppHandle, session_id: &str, change: PhaseChange) {
    debounce()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .note_phase(session_id, change);
    refresh_badge(app);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use hq_desktop_core::agent_session::types::PermissionMode;

    fn needs(session_id: &str) -> SessionNeedsYou {
        SessionNeedsYou {
            session_id: session_id.to_string(),
            request_id: "req-1".to_string(),
            reason: "permission".to_string(),
            summary: "Bash".to_string(),
            company: None,
            tool: SessionTool::Claude,
        }
    }

    fn change(from: SessionPhase, to: SessionPhase) -> PhaseChange {
        PhaseChange { from, to }
    }

    fn row(session_id: &str, phase: SessionPhase) -> SessionSummary {
        SessionSummary {
            session_id: session_id.to_string(),
            tool: SessionTool::Claude,
            phase,
            company: None,
            model: None,
            requested_model: None,
            effort: None,
            permission_mode: PermissionMode::Prompt,
            cwd: "/tmp".to_string(),
            started_at: "2026-01-01T00:00:00.000Z".to_string(),
            last_activity_at: "2026-01-01T00:00:00.000Z".to_string(),
            last_seq: 0,
            pending_count: 0,
        }
    }

    // ── Debounce ────────────────────────────────────────────────────────────

    #[test]
    fn fires_once_per_needs_you_entry() {
        let mut debounce = NeedsYouDebounce::new();
        assert!(debounce.should_fire("s1"));
        // A burst of permission requests inside the same parking is one banner.
        assert!(!debounce.should_fire("s1"));
        assert!(!debounce.should_fire("s1"));
    }

    #[test]
    fn re_fires_after_leaving_and_re_entering_needs_you() {
        let mut debounce = NeedsYouDebounce::new();
        assert!(debounce.should_fire("s1"));
        assert!(!debounce.should_fire("s1"));

        // Answering moves the session back to working — that is the re-arm.
        debounce.note_phase("s1", change(SessionPhase::NeedsYou, SessionPhase::Working));
        assert!(debounce.is_armed("s1"));
        assert!(debounce.should_fire("s1"));
        assert!(!debounce.should_fire("s1"));
    }

    #[test]
    fn entering_needs_you_does_not_re_arm_mid_parking() {
        let mut debounce = NeedsYouDebounce::new();
        // The phase edge INTO needsYou arrives before the first NeedsYou emit.
        debounce.note_phase("s1", change(SessionPhase::Working, SessionPhase::NeedsYou));
        assert!(debounce.should_fire("s1"));
        // A redundant/duplicate inbound edge must not unlock a second banner.
        debounce.note_phase("s1", change(SessionPhase::Working, SessionPhase::NeedsYou));
        assert!(!debounce.should_fire("s1"));
    }

    #[test]
    fn debounce_is_per_session() {
        let mut debounce = NeedsYouDebounce::new();
        assert!(debounce.should_fire("s1"));
        assert!(debounce.should_fire("s2"));
        assert!(!debounce.should_fire("s1"));
    }

    #[test]
    fn ending_a_session_forgets_it() {
        let mut debounce = NeedsYouDebounce::new();
        assert!(debounce.should_fire("s1"));
        debounce.note_phase("s1", change(SessionPhase::NeedsYou, SessionPhase::Ended));
        assert!(debounce.is_armed("s1"));
        // Also from a non-parked phase — a session can end while working.
        assert!(debounce.should_fire("s2"));
        debounce.note_phase("s2", change(SessionPhase::Working, SessionPhase::Ended));
        assert!(debounce.is_armed("s2"));
    }

    // ── Badge ───────────────────────────────────────────────────────────────

    #[test]
    fn badge_counts_only_needs_you_rows() {
        let rows = vec![
            row("a", SessionPhase::NeedsYou),
            row("b", SessionPhase::Working),
            row("c", SessionPhase::NeedsYou),
            row("d", SessionPhase::Idle),
            row("e", SessionPhase::Ended),
            row("f", SessionPhase::Starting),
        ];
        assert_eq!(needs_you_count(&rows), 2);
    }

    #[test]
    fn badge_is_zero_when_nothing_is_parked() {
        assert_eq!(needs_you_count(&[]), 0);
        assert_eq!(needs_you_count(&[row("a", SessionPhase::Working)]), 0);
    }

    // ── Payload ─────────────────────────────────────────────────────────────

    #[test]
    fn title_names_the_tool_and_company() {
        assert_eq!(banner_title(SessionTool::Claude, None), "Claude needs you");
        assert_eq!(banner_title(SessionTool::Codex, None), "Codex needs you");
        assert_eq!(
            banner_title(SessionTool::Claude, Some("indigo")),
            "Claude needs you · indigo"
        );
        // A blank company must not leave a dangling separator.
        assert_eq!(
            banner_title(SessionTool::Claude, Some("   ")),
            "Claude needs you"
        );
    }

    #[test]
    fn body_falls_back_by_reason_when_summary_is_blank() {
        let mut n = needs("s1");
        n.summary = "  ".to_string();
        assert_eq!(banner_body(&n), "Waiting on your permission decision.");
        n.reason = "question".to_string();
        assert_eq!(banner_body(&n), "Waiting on your answer.");
        n.summary = "Pick a branch".to_string();
        assert_eq!(banner_body(&n), "Pick a branch");
    }

    #[test]
    fn payload_shape_is_pinned() {
        let mut n = needs("s1");
        n.company = Some("indigo".to_string());
        n.request_id = "req-42".to_string();
        let payload = build_payload(&n);

        assert_eq!(payload.kind, "session");
        assert_eq!(payload.title, "Claude needs you · indigo");
        assert_eq!(payload.body, "Bash");
        assert_eq!(payload.icon_text.as_deref(), Some("●"));
        assert_eq!(payload.action_label.as_deref(), Some("Answer"));
        assert_eq!(payload.action_id.as_deref(), Some("open"));
        assert_eq!(payload.click_action_id, "open");
        assert_eq!(payload.data["sessionId"], "s1");
        assert_eq!(payload.data["requestId"], "req-42");
    }

    #[test]
    fn payload_serializes_camel_case_for_the_webview() {
        let payload = build_payload(&needs("s1"));
        let json = serde_json::to_value(&payload).expect("serialize");
        assert_eq!(json["kind"], "session");
        assert_eq!(json["clickActionId"], "open");
        assert_eq!(json["actionLabel"], "Answer");
        assert_eq!(json["iconText"], "●");
        assert_eq!(json["data"]["sessionId"], "s1");
    }
}
