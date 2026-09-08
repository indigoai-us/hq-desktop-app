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

use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Emitter, Manager, Runtime};

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

/// Event-driven wake (perf) — a `notify` watcher on the local session stores so
/// a changed transcript refreshes the snapshot in ~300ms instead of waiting for
/// the safety poll. Impure wiring only; the filter/debounce/root policy is pure
/// in [`hq_desktop_core::sessions::watch`].
pub mod watch;

pub use hq_desktop_core::sessions::{
    merge_sessions, plan_poll, resolve_poll_interval, AgentOrigin, AgentSession, AgentTool,
    SessionStatus, SESSIONS_LIVENESS_TICK_SECS,
};

use hq_desktop_core::sessions::liveness::RunningAgents;

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
pub(crate) const LOG_TAG: &str = "sessions";

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot assembly (async, real I/O)
// ─────────────────────────────────────────────────────────────────────────────

/// Assemble a fresh [`MissionControlSnapshot`]: run both local readers, apply
/// liveness, and derive the history feed. Best-effort — a reader that errors
/// contributes an empty list rather than failing the whole snapshot, so one bad
/// store can't blank the fleet.
///
/// Every reader is blocking filesystem/process work (thousands of `stat`s plus
/// a `pgrep` fork), so the whole assembly runs on a blocking thread via
/// `spawn_blocking` rather than stalling a tokio worker.
async fn collect_snapshot() -> MissionControlSnapshot {
    match tauri::async_runtime::spawn_blocking(collect_snapshot_blocking).await {
        Ok(snapshot) => snapshot,
        Err(e) => {
            log(LOG_TAG, &format!("SESSIONS_SNAPSHOT_TASK_FAILED {e}"));
            MissionControlSnapshot {
                sessions: Vec::new(),
                history: Vec::new(),
                outpost: None,
            }
        }
    }
}

/// Synchronous body of [`collect_snapshot`]. Must not run on a tokio worker.
fn collect_snapshot_blocking() -> MissionControlSnapshot {
    let now = SystemTime::now();
    let claude = claude::scan_local_claude_sessions();
    let codex = codex::scan_local_codex_sessions();
    let agents = scan_running_agents();
    let local = merge_sessions(claude, codex, agents, now);

    // Fold in the outpost fleet (US-011): the realtime subscriber + S3 fallback
    // keep a stale-aware cache; `outpost_view` returns FRESH outpost sessions
    // (empty past the stale timeout) plus the box-status card. Outpost sessions
    // carry the emitter's own liveness — we do NOT re-run the local process scan
    // against them (their processes live on the VM, not this box).
    let outpost_view = outpost::outpost_view(now);
    let sessions = append_outpost_sessions(local, outpost_view.sessions);

    let history = history::derive_local_session_history();

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
///
/// ## Visibility gating (idle-energy fix)
///
/// A snapshot is not cheap: it `stat`s every local Claude transcript and Codex
/// rollout (thousands of files on a working machine) and forks `pgrep`. Running
/// that on the interactive cadence while every window is hidden was measured as
/// the dominant contributor to the app's Activity Monitor energy impact, and all
/// of it was wasted — the snapshot is emitted to a frontend nobody can see.
///
/// So the loop asks [`plan_poll`] what to do on each wake-up: the interactive
/// cadence while a window is visible, a slow heartbeat while everything is hidden,
/// and an immediate catch-up emit the moment a window becomes visible. Freshness
/// while the user is looking is unchanged.
///
/// ## Live watch roots
///
/// Every emitting tick also re-resolves the watcher's roots
/// ([`watch::refresh_sessions_watch_roots`]). Root resolution is otherwise a
/// one-shot at startup, which leaves the watcher permanently blind to a session
/// directory created afterwards — the fresh-install case, where
/// `~/.claude/projects` does not exist until Claude Code first runs. This is the
/// only place that recovery happens, and it is why [`SESSIONS_POLL_INTERVAL_SECS`]
/// bounds how long the blindness can last.
///
/// This function also spawns the cheap process-only liveness ticker
/// ([`setup_sessions_liveness_ticker`]), so `main.rs` keeps one setup call.
pub fn setup_sessions_poller<R: Runtime>(app: AppHandle<R>) {
    let interval =
        resolve_poll_interval(std::env::var("HQ_SYNC_SESSIONS_POLL_SECS").ok().as_deref());
    setup_sessions_liveness_ticker(app.clone());
    tauri::async_runtime::spawn(async move {
        // Launch delay — give the app a moment to finish setup before the first
        // scan (mirrors the share/updater pollers' settle delay).
        tokio::time::sleep(Duration::from_secs(3)).await;
        refresh_and_emit(&app).await;

        let mut last_emit = Instant::now();
        let mut was_visible = any_window_visible(&app);
        loop {
            let visible = any_window_visible(&app);
            let plan = plan_poll(visible, was_visible, last_emit.elapsed(), interval);
            was_visible = visible;

            if plan.emit {
                // Re-resolve before the scan: a root that just appeared is
                // registered now, and the snapshot below already reflects it.
                // Cheap (a handful of `is_dir` calls) and a no-op when nothing
                // changed, so it rides the emitting ticks rather than the
                // 2-second visibility checks.
                watch::refresh_sessions_watch_roots();
                refresh_and_emit(&app).await;
                last_emit = Instant::now();
            }
            tokio::time::sleep(plan.sleep).await;
        }
    });
}

/// Spawn the process-only liveness ticker.
///
/// A session **ending** is the one Mission Control change that writes no file:
/// the transcript is simply never appended to again, so the filesystem watcher
/// has nothing to deliver and only the `pgrep` scan can see it. Before this,
/// that signal rode the safety poll, which means moving the poll 15s → 90s
/// would have made "this session ended" up to six times slower to appear.
///
/// So exits get their own timer at [`SESSIONS_LIVENESS_TICK_SECS`] that does the
/// cheap half only — one `pgrep` fork, no filesystem walk — and escalates to the
/// shared [`refresh_and_emit`] (and therefore the same dedup and the same typed
/// event) *only* when the live-process set actually changed. On a quiet machine
/// the steady-state cost is one fork every 15 seconds and no emit at all.
///
/// [`RunningAgents`] is exactly the input `merge_sessions` uses to decide
/// `Ended`, so "liveness changed" is precisely the condition under which a
/// process event can alter the snapshot — this cannot miss an exit the full poll
/// would have caught, and it cannot fire spuriously either.
///
/// Visibility-gated like every other refresh path: while all windows are hidden
/// we skip even the fork, and [`plan_poll`]'s hidden→visible catch-up emit covers
/// anything that changed in the meantime.
pub fn setup_sessions_liveness_ticker<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let tick = Duration::from_secs(SESSIONS_LIVENESS_TICK_SECS);
        let mut last: Option<RunningAgents> = None;
        loop {
            tokio::time::sleep(tick).await;
            if !any_window_visible(&app) {
                continue;
            }
            // `pgrep` is a fork — off the tokio workers like every other
            // blocking call in this module.
            let Ok(agents) = tauri::async_runtime::spawn_blocking(scan_running_agents).await else {
                continue;
            };
            let previous = last.replace(agents);
            if liveness_refresh_needed(previous, agents) {
                refresh_and_emit(&app).await;
            }
        }
    });
}

/// Pure policy for the liveness ticker: refresh only when the live-process set
/// changed relative to a previous observation.
///
/// The first observation (`previous == None`) never refreshes — the poller's
/// launch snapshot already covered it, and re-running a full snapshot 15s into
/// startup for a set we have never compared against would be pure waste.
fn liveness_refresh_needed(previous: Option<RunningAgents>, current: RunningAgents) -> bool {
    match previous {
        None => false,
        Some(before) => before != current,
    }
}

/// Is any app window currently visible?
///
/// A full snapshot is thousands of `stat`s plus a `pgrep` fork; doing that on the
/// interactive cadence while every window is hidden was the app's largest source
/// of idle CPU. This reads Tauri's in-memory window state only — no I/O — so it is
/// safe to call on every wake-up. A window we cannot query counts as hidden.
///
/// Always-on HUD windows (the desktop widget, the DM banner) are excluded: the
/// widget is `always_on_top` + visible on every workspace and shown at startup,
/// so counting it would make this permanently true and the idle gating would
/// never engage. Only windows a user actually opens (`main` popover,
/// `desktop-alt`, `messages`, ...) count.
pub(crate) fn any_window_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.webview_windows()
        .iter()
        .filter(|(label, _)| counts_as_user_window(label))
        .any(|(_, window)| window.is_visible().unwrap_or(false))
}

/// Window labels that are always-on HUD surfaces rather than user-opened
/// windows. They never drive the interactive poll cadence.
const HUD_WINDOW_LABELS: &[&str] = &[
    crate::commands::widget::WINDOW_LABEL,
    crate::commands::banner::WINDOW_LABEL,
];

/// Does a visible window with this label mean a user is looking at the app?
fn counts_as_user_window(label: &str) -> bool {
    !HUD_WINDOW_LABELS.contains(&label)
}

/// The last snapshot emitted, shared by the safety poll and the filesystem
/// watcher.
///
/// Both refresh paths must dedup against the *same* baseline: if the watcher
/// kept its own, a poll tick right after a watcher wake would re-emit an
/// identical payload (and vice-versa), which is exactly the serialisation + IPC
/// + Svelte reconciliation waste the dedup exists to avoid.
///
/// A tokio mutex (not `std`) because the guard is held across
/// [`emit_snapshot_if_changed`]'s `.await`; contention is nil (two writers, both
/// rare) so this is purely about `Send`-ness inside the spawned tasks. It also
/// serialises the two refresh paths, so a poll tick and a watcher wake can never
/// interleave and emit the same snapshot twice.
static LAST_SNAPSHOT: OnceLock<tokio::sync::Mutex<Option<MissionControlSnapshot>>> =
    OnceLock::new();

fn last_snapshot_slot() -> &'static tokio::sync::Mutex<Option<MissionControlSnapshot>> {
    LAST_SNAPSHOT.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// The single refresh path: assemble a snapshot and emit it only if it differs
/// from the last one anyone emitted.
///
/// Both the safety-poll timer ([`setup_sessions_poller`]) and the filesystem
/// watcher ([`watch::setup_sessions_watcher`]) call this, so there is exactly one
/// definition of "collect and emit" and the unchanged-snapshot skip applies
/// identically to both.
///
/// Note this always runs the *full* [`collect_snapshot_blocking`], including the
/// `pgrep` liveness fork. On a watcher wake that fork is not strictly needed
/// (a file changed, not a process list), but keeping it means an event-driven
/// refresh is exactly as correct as a polled one, and the watcher's ~300ms
/// debounce bounds it to at most one fork per burst.
///
/// Visibility gating lives at the *call sites*, not here: the poll decides via
/// [`plan_poll`] (which still wants a slow hidden heartbeat), while the watcher
/// checks [`any_window_visible`] and drops the wake outright — nobody can see a
/// snapshot pushed to a hidden window.
pub(crate) async fn refresh_and_emit<R: Runtime>(app: &AppHandle<R>) {
    let mut last = last_snapshot_slot().lock().await;
    emit_snapshot_if_changed(app, &mut last).await;
}

/// Assemble one snapshot and emit it to the frontend as [`EVENT_SESSIONS_UPDATED`].
/// Best-effort: a failed emit (e.g. no webview yet) is logged, never fatal.
async fn emit_snapshot<R: Runtime>(app: &AppHandle<R>) {
    let snapshot = collect_snapshot().await;
    emit_snapshot_payload(app, &snapshot);
}

/// Assemble one snapshot and emit it only when it differs from the last one
/// this poller sent. The frontend store keeps the previous payload, so an
/// identical re-emit is pure serialisation + IPC + Svelte reconciliation waste
/// on every tick of a quiet machine.
async fn emit_snapshot_if_changed<R: Runtime>(
    app: &AppHandle<R>,
    last: &mut Option<MissionControlSnapshot>,
) {
    let snapshot = collect_snapshot().await;
    if !snapshot_changed(last.as_ref(), &snapshot) {
        return;
    }
    emit_snapshot_payload(app, &snapshot);
    *last = Some(snapshot);
}

/// Pure dedup predicate: emit when there is no previous snapshot or the new one
/// differs structurally (`MissionControlSnapshot: PartialEq`).
fn snapshot_changed(last: Option<&MissionControlSnapshot>, next: &MissionControlSnapshot) -> bool {
    last != Some(next)
}

fn emit_snapshot_payload<R: Runtime>(app: &AppHandle<R>, snapshot: &MissionControlSnapshot) {
    if let Err(e) = app.emit(EVENT_SESSIONS_UPDATED, snapshot) {
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

    // ── Idle gating: HUD windows never count as "visible" ───────────────────

    #[test]
    fn hud_window_labels_do_not_count_as_user_windows() {
        // The always-on widget and the DM banner must not keep the interactive
        // cadence alive — that was the bug that stopped idle gating engaging.
        assert!(!counts_as_user_window("widget"));
        assert!(!counts_as_user_window("dm-banner"));
        // Real user surfaces do count.
        for label in ["main", "desktop-alt", "messages", "drift-detail"] {
            assert!(counts_as_user_window(label), "{label} should count");
        }
    }

    #[test]
    fn any_window_visible_ignores_hud_windows_on_a_mock_app() {
        // The mock app has no windows at all, so nothing is visible — this pins
        // the "no window → hidden" default rather than the HUD filter alone.
        let app = tauri::test::mock_app();
        assert!(!any_window_visible(app.handle()));
    }

    // ── Process-only liveness tick ──────────────────────────────────────────

    #[test]
    fn liveness_tick_refreshes_only_when_the_live_process_set_changes() {
        let none = RunningAgents::default();
        let claude = RunningAgents { claude: true, codex: false };
        let both = RunningAgents { claude: true, codex: true };

        // First observation is a baseline, not a reason to re-snapshot.
        assert!(!liveness_refresh_needed(None, claude));
        // Steady state on a quiet machine: no emit, just a fork.
        assert!(!liveness_refresh_needed(Some(claude), claude));
        assert!(!liveness_refresh_needed(Some(none), none));
        // A session ENDING — the signal no file records, and the whole reason
        // this ticker exists.
        assert!(liveness_refresh_needed(Some(claude), none));
        // …and a session starting, or the other tool appearing.
        assert!(liveness_refresh_needed(Some(none), claude));
        assert!(liveness_refresh_needed(Some(claude), both));
    }

    #[test]
    fn liveness_tick_is_faster_than_the_safety_poll() {
        // The point of the ticker: exit latency must not follow the poll to 90s.
        assert!(
            SESSIONS_LIVENESS_TICK_SECS < hq_desktop_core::sessions::SESSIONS_POLL_INTERVAL_SECS
        );
        assert_eq!(SESSIONS_LIVENESS_TICK_SECS, 15);
    }

    // ── Emit dedup ──────────────────────────────────────────────────────────

    fn empty_snapshot() -> MissionControlSnapshot {
        MissionControlSnapshot {
            sessions: Vec::new(),
            history: Vec::new(),
            outpost: None,
        }
    }

    #[test]
    fn snapshot_changed_only_when_payload_differs() {
        let a = empty_snapshot();
        // First emit always goes out.
        assert!(snapshot_changed(None, &a));
        // Identical → skip.
        assert!(!snapshot_changed(Some(&a), &a));
        // Any structural difference → emit.
        let mut b = empty_snapshot();
        b.outpost = Some(outpost::OutpostStatus {
            up: false,
            runtime: "claude".to_string(),
            relay_connected: false,
            ip: String::new(),
            region: String::new(),
            last_seen_at: String::new(),
            stale: true,
        });
        assert!(snapshot_changed(Some(&a), &b));
    }

    #[tokio::test]
    async fn emit_snapshot_if_changed_skips_identical_payloads() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tauri::Listener;

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let count = Arc::new(AtomicUsize::new(0));
        let count_w = count.clone();
        handle.listen(EVENT_SESSIONS_UPDATED, move |_| {
            count_w.fetch_add(1, Ordering::SeqCst);
        });

        // Seed `last` with exactly what the collector will produce on a box with
        // no sessions is not deterministic, so instead drive two back-to-back
        // cycles: the first must emit, the second (same fleet, nothing changed
        // in a few ms) must not.
        let mut last = None;
        emit_snapshot_if_changed(&handle, &mut last).await;
        assert!(last.is_some(), "first cycle records the emitted snapshot");
        let first = last.clone();
        emit_snapshot_if_changed(&handle, &mut last).await;
        tokio::time::sleep(Duration::from_millis(50)).await;

        if last == first {
            assert_eq!(
                count.load(Ordering::SeqCst),
                1,
                "an unchanged snapshot must not be re-emitted"
            );
        } else {
            // A session mutated between the two scans on this machine; the
            // second emit is then legitimately required.
            assert_eq!(count.load(Ordering::SeqCst), 2);
        }
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
