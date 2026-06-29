//! Mission Control — the shared `AgentSession` contract (US-001).
//!
//! This module is the Rust half of a cross-language contract. The TypeScript
//! half lives in `src/desktop-alt/lib/sessions.ts` and declares the same shape;
//! both sides serialise to camelCase JSON so the local readers, the outpost
//! heartbeat, and the desktop UI all speak one shape.
//!
//! Contract-first by design (PRD US-001): the cross-repo pieces (the on-box
//! outpost emitter and the desktop subscriber) serialise/deserialise the *same*
//! [`AgentSession`], so the wire payloads map 1:1 across the boundary. Later
//! stories (US-002+) populate these records from on-disk Claude/Codex artifacts;
//! this module owns only the type definitions and the status taxonomy.

use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter, Runtime};

use crate::util::logfile::log;

use self::history::HistoryEvent;
use self::liveness::scan_running_agents;

// ─────────────────────────────────────────────────────────────────────────────
// Readers (per-tool submodules)
// ─────────────────────────────────────────────────────────────────────────────

/// Local Claude Code session reader (US-002) — enumerates
/// `~/.claude/projects/**/<uuid>.jsonl` and maps to [`AgentSession`].
pub mod claude;

/// Local Codex session reader (US-003) — enumerates
/// `~/.codex/session_index.jsonl` + `sessions/**/rollout-*.jsonl` (and
/// `archived_sessions`) and maps to [`AgentSession`].
pub mod codex;

/// Liveness engine (US-004) — refines the readers' coarse mtime status into the
/// [`SessionStatus`] taxonomy via a last-activity window cross-checked against
/// running `claude`/`codex` processes (no live process → [`SessionStatus::Ended`]).
pub mod liveness;

/// Session history derivation (US-004) — builds the chronological Mission Control
/// history feed from `workspace/metrics/audit-log.jsonl` and
/// `workspace/threads/*.json` (dispatches, completions, checkpoints, handoffs).
pub mod history;

/// Desktop outpost subscriber + box-level status + merge (US-011) — subscribes
/// to the outpost sessions topic (reusing the `dm_mqtt.rs` pattern), merges the
/// remote `AgentSession[]` (origin=outpost) into this snapshot, and surfaces the
/// box-level status card sourced from `GET /outpost/status`. S3-heartbeat fallback
/// + a stale-after timeout keep it honest when the box stops reporting.
pub mod outpost;

pub use hq_desktop_core::sessions::{
    merge_sessions, resolve_poll_interval, AgentOrigin, AgentSession, AgentTool, SessionStatus,
};

pub type MissionControlSnapshot =
    hq_desktop_core::sessions::MissionControlSnapshot<HistoryEvent, outpost::OutpostStatus>;

/// Event name the polling loop emits on each re-scan (US-005).
///
/// Follows the established `<domain>:<event>` convention used across the app
/// (`sync:*`, `share:*`, `meeting:*`) — see `events.rs`. The frontend store
/// `listen`s for this to stay fresh without a manual refresh, mirroring how the
/// share/sync surfaces consume their typed events.
pub const EVENT_SESSIONS_UPDATED: &str = "sessions:updated";

/// Diagnostic-log tag for the sessions polling loop.
const LOG_TAG: &str = "sessions";

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot assembly (async, real I/O)
// ─────────────────────────────────────────────────────────────────────────────

/// Assemble a fresh [`MissionControlSnapshot`]: run both local readers, apply
/// liveness, and derive the history feed. Best-effort — a reader that errors
/// contributes an empty list rather than failing the whole snapshot, so one bad
/// store can't blank the fleet.
async fn collect_snapshot() -> MissionControlSnapshot {
    let now = SystemTime::now();
    let claude = claude::list_local_claude_sessions()
        .await
        .unwrap_or_default();
    let codex = codex::list_local_codex_sessions().await.unwrap_or_default();
    let agents = scan_running_agents();
    let local = merge_sessions(claude, codex, agents, now);

    // Fold in the outpost fleet (US-011): the realtime subscriber + S3 fallback
    // keep a stale-aware cache; `outpost_view` returns FRESH outpost sessions
    // (empty past the stale timeout) plus the box-status card. Outpost sessions
    // carry the emitter's own liveness — we do NOT re-run the local process scan
    // against them (their processes live on the VM, not this box).
    let outpost_view = outpost::outpost_view(now);
    let sessions = append_outpost_sessions(local, outpost_view.sessions);

    let history = history::list_session_history().await.unwrap_or_default();

    MissionControlSnapshot {
        sessions,
        history,
        outpost: outpost_view.status,
    }
}

/// Append the outpost fleet onto the local fleet for the merged snapshot
/// (US-011). Pure over its inputs so the merge ordering (local first, then
/// outpost) is unit-testable. Each outpost session is defensively re-stamped
/// `origin=outpost` so the UI's origin grouping never mis-buckets a remote
/// session as local, regardless of what the wire claimed.
fn append_outpost_sessions(
    mut local: Vec<AgentSession>,
    outpost: Vec<AgentSession>,
) -> Vec<AgentSession> {
    local.extend(outpost.into_iter().map(|mut s| {
        s.origin = AgentOrigin::Outpost;
        s
    }));
    local
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri command
// ─────────────────────────────────────────────────────────────────────────────

/// List the merged local agent sessions plus the history feed (US-005).
///
/// Returns the merged local `AgentSession[]` (Claude + Codex readers, with the
/// US-004 liveness engine applied) and the derived history feed in one
/// [`MissionControlSnapshot`]. Registered in `main.rs`'s `invoke_handler`; the
/// frontend store calls this on mount and the polling loop re-emits the same
/// shape on every tick.
#[tauri::command]
pub async fn list_agent_sessions() -> Result<MissionControlSnapshot, String> {
    Ok(collect_snapshot().await)
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling loop (mirrors the sync-stats / share-notify poller pattern)
// ─────────────────────────────────────────────────────────────────────────────

/// Spawn the Mission Control polling loop. Called from `main.rs` setup.
///
/// Mirrors `share_notify::setup_share_notify_poller`: a launch poll after a short
/// delay (lets the app finish initialising), then a re-scan on an independent
/// interval timer. Each cycle assembles a fresh [`MissionControlSnapshot`] and
/// emits it to the frontend as a typed [`EVENT_SESSIONS_UPDATED`] event — the
/// same event-name convention and `app.emit` payload-typing approach the
/// sync/share surfaces use — so the UI stays fresh without a manual refresh.
///
/// The cadence is configurable via `HQ_SYNC_SESSIONS_POLL_SECS`
/// (see [`resolve_poll_interval`]); the outpost emitter (US-009) is documented to
/// match it.
pub fn setup_sessions_poller<R: Runtime>(app: AppHandle<R>) {
    let interval =
        resolve_poll_interval(std::env::var("HQ_SYNC_SESSIONS_POLL_SECS").ok().as_deref());
    tauri::async_runtime::spawn(async move {
        // Launch delay — give the app a moment to finish setup before the first
        // scan (mirrors the share/updater pollers' settle delay).
        tokio::time::sleep(Duration::from_secs(3)).await;
        emit_snapshot(&app).await;

        let mut ticker = tokio::time::interval(interval);
        // The first tick fires immediately; consume it so the launch emit above
        // isn't double-counted, then emit once per interval thereafter.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            emit_snapshot(&app).await;
        }
    });
}

/// Assemble one snapshot and emit it to the frontend as [`EVENT_SESSIONS_UPDATED`].
/// Best-effort: a failed emit (e.g. no webview yet) is logged, never fatal.
async fn emit_snapshot<R: Runtime>(app: &AppHandle<R>) {
    let snapshot = collect_snapshot().await;
    if let Err(e) = app.emit(EVENT_SESSIONS_UPDATED, &snapshot) {
        log(LOG_TAG, &format!("SESSIONS_EMIT_FAILED {e}"));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn session(id: &str, tool: AgentTool, last_activity_at: &str) -> AgentSession {
        AgentSession {
            id: id.to_string(),
            tool,
            origin: AgentOrigin::Local,
            cwd: "/tmp".to_string(),
            project: "p".to_string(),
            company: "indigo".to_string(),
            model: "m".to_string(),
            // Deliberately a *stale* coarse status so we can prove the merge
            // re-derives it rather than trusting the reader's value.
            status: SessionStatus::Ended,
            started_at: "2026-06-15T18:00:00Z".to_string(),
            last_activity_at: last_activity_at.to_string(),
            source: "test".to_string(),
        }
    }

    /// RFC-3339 string for `now - age_secs` (seconds precision, `Z` suffix).
    fn iso_ago(now: SystemTime, age_secs: u64) -> String {
        let secs = now
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
            - age_secs as i64;
        chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    }

    // ── US-011: outpost merge into the same snapshot ────────────────────────

    fn outpost_session(id: &str) -> AgentSession {
        let mut s = session(id, AgentTool::Claude, "2026-06-15T18:43:20Z");
        // Wire says LOCAL — `append_outpost_sessions` must force it to outpost.
        s.origin = AgentOrigin::Local;
        s.source = "outpost-heartbeat".to_string();
        s
    }

    #[test]
    fn append_outpost_sessions_merges_into_one_fleet_with_outpost_origin() {
        let now = SystemTime::now();
        let local = vec![session("c1", AgentTool::Claude, &iso_ago(now, 5))];
        let outpost = vec![outpost_session("o1")];

        let merged = append_outpost_sessions(local, outpost);

        // Local first, then outpost — stable order.
        assert_eq!(
            merged.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["c1", "o1"]
        );
        // The local session stays local…
        assert_eq!(merged[0].origin, AgentOrigin::Local);
        // …and the outpost session is forced to origin=outpost (so the UI groups
        // it under the outpost group), even though the wire said local.
        assert_eq!(merged[1].origin, AgentOrigin::Outpost);
    }

    #[test]
    fn append_outpost_sessions_with_no_outpost_is_identity() {
        let now = SystemTime::now();
        let local = vec![session("c1", AgentTool::Claude, &iso_ago(now, 5))];
        let merged = append_outpost_sessions(local.clone(), Vec::new());
        assert_eq!(merged, local);
    }

    #[test]
    fn snapshot_carries_outpost_card_when_present() {
        let snapshot = MissionControlSnapshot {
            sessions: Vec::new(),
            history: Vec::new(),
            outpost: Some(outpost::OutpostStatus {
                up: true,
                runtime: "claude".to_string(),
                relay_connected: true,
                ip: "203.0.113.7".to_string(),
                region: "us-east-1".to_string(),
                last_seen_at: "2026-06-15T18:43:20Z".to_string(),
                stale: false,
            }),
        };
        let value = serde_json::to_value(&snapshot).unwrap();
        let outpost = value
            .get("outpost")
            .expect("outpost card present")
            .as_object()
            .unwrap();
        // camelCase keys on the wire, matching the TS card type.
        assert_eq!(outpost.get("up").unwrap(), true);
        assert_eq!(outpost.get("relayConnected").unwrap(), true);
        assert_eq!(outpost.get("lastSeenAt").unwrap(), "2026-06-15T18:43:20Z");
    }

    // ── US-005: command + event integration ─────────────────────────────────

    #[tokio::test]
    async fn list_agent_sessions_returns_a_snapshot_shape() {
        // The command never errors (best-effort readers) and returns the merged
        // snapshot shape. On a CI box with no Claude/Codex dirs this is empty,
        // which is a valid empty fleet — the shape is what we assert here.
        let snapshot = list_agent_sessions().await.unwrap();
        // Round-trips through camelCase JSON with the documented top-level keys.
        let value = serde_json::to_value(&snapshot).unwrap();
        let obj = value.as_object().unwrap();
        assert!(obj.contains_key("sessions"));
        assert!(obj.contains_key("history"));
    }

    #[tokio::test]
    async fn emit_snapshot_fires_the_typed_event() {
        use std::sync::{Arc, Mutex};
        use tauri::Listener;

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();

        // Register a listener for the typed poll event BEFORE emitting, capturing
        // the payload so we assert both that the event fired and that it carries
        // the snapshot shape.
        let seen: Arc<Mutex<Option<MissionControlSnapshot>>> = Arc::new(Mutex::new(None));
        let seen_w = seen.clone();
        handle.listen(EVENT_SESSIONS_UPDATED, move |event| {
            let parsed: MissionControlSnapshot = serde_json::from_str(event.payload()).unwrap();
            *seen_w.lock().unwrap() = Some(parsed);
        });

        // Drive one poll cycle directly (the loop body), then let the listener run.
        emit_snapshot(&handle).await;
        tokio::time::sleep(Duration::from_millis(50)).await;

        let captured = seen.lock().unwrap();
        assert!(
            captured.is_some(),
            "expected an {EVENT_SESSIONS_UPDATED} event to be emitted"
        );
    }
}
