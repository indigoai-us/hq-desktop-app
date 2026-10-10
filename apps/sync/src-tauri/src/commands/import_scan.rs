//! First-run "Bring in your context" (visual first run, slice 4).
//!
//! `import_scan_start` runs `hq import scan --json --stream --hq-root <hq>`
//! (contract: hq-cli docs/import-scan-stream.md) through the same
//! launch boundary as the local-bot commands (bots.rs): the resolved `hq`
//! binary, the child PATH and the configured HQ root. The CLI prints one JSON
//! object per line, each with `"v": 1` and a `"type"`. Each line is checked
//! here (size, shape, version, known type) and forwarded to the webview as an
//! `import-scan://event` with the scan's id, to the window that started the
//! scan only; anything else is dropped. The
//! command resolves when the scan ends: done, failed, cancelled, timed out,
//! or unavailable (an `hq` without the command, or no HQ folder).
//!
//! Only one scan runs at a time. Starting a new one cancels the old one, and
//! `import_scan_cancel` stops it when the person leaves the screen. Cancel and
//! timeout send SIGTERM to `hq` (it forwards the signal to the scanner), then
//! kill its whole process group if it has not exited within a few seconds.
//!
//! Nothing a line carries is ever logged: the log gets the outcome and line
//! counts only. stderr is free-form diagnostics and is never parsed for scan
//! data; its head is only checked for the CLI's "unknown command/option"
//! usage error, which means an `hq` from before the scan existed.

use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::commands::install_directory::existing_hq_path;
use crate::util::logfile::log;
use crate::util::paths;

const LOG_TAG: &str = "import-scan";

/// The event every forwarded line goes out on.
pub const IMPORT_SCAN_EVENT: &str = "import-scan://event";
/// The whole scan's bound. The screen gives up a minute later.
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(300);
/// A line longer than this is dropped whole.
pub const MAX_LINE_BYTES: usize = 64 * 1024;
/// Lines forwarded per scan at most; a runaway stream stops being forwarded.
/// The `done` line is always forwarded, and `error` lines get a small allowance
/// past the cap, so a very large HQ still ends the scan on screen.
pub const MAX_FORWARDED_LINES: usize = 20_000;
/// `error` lines still forwarded once the cap is reached.
const ERROR_LINES_PAST_CAP: usize = 64;
/// Scan ids cancelled before their scan registered (the webview's cancel can
/// beat the start); remembered so that start never runs unattended.
const MAX_PRECANCELLED: usize = 16;
/// The line types this version of the stream has.
const KNOWN_TYPES: [&str; 7] = ["start", "source", "count", "company", "project", "error", "done"];
/// How much stderr is kept to recognise an `hq` without the command.
const STDERR_KEEP: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportScanEnd {
    /// "done" | "failed" | "cancelled" | "timeout" | "unavailable" | "no_hq"
    pub status: &'static str,
    pub lines: usize,
    pub dropped: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportScanEventPayload<'a> {
    scan_id: &'a str,
    event: Value,
}

/// The webview's scan id: 1 to 64 letters, digits, `-` or `_` (a UUID fits).
pub fn validate_scan_id(scan_id: &str) -> Result<String, String> {
    let id = scan_id.trim();
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Invalid scan id.".to_string());
    }
    Ok(id.to_string())
}

/// One stream line as the webview may see it: a JSON object of version 1 with
/// a known type, within the size bound. The UI validates the fields again.
pub fn validate_line(line: &str) -> Option<Value> {
    let text = line.trim();
    if text.is_empty() || text.len() > MAX_LINE_BYTES || !text.starts_with('{') {
        return None;
    }
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    if object.get("v").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let kind = object.get("type")?.as_str()?;
    if !KNOWN_TYPES.contains(&kind) {
        return None;
    }
    Some(value)
}

fn is_done_line(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("done")
}

fn is_error_line(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("error")
}

fn is_absolute_like(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || path.starts_with('\\')
        || path.starts_with('~')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
}

/// The `done` line's report path, relative to the HQ folder: the absolute
/// path names the person's home folder, and this path ends up in the setup
/// bot's handoff. A path outside the HQ folder (or one that climbs out with
/// `..`) becomes null.
pub fn relativize_report(value: &mut Value, hq_root: &str) {
    let Some(object) = value.as_object_mut() else { return };
    let Some(report) = object.get("report").and_then(Value::as_str).map(str::to_string) else { return };
    let root = hq_root.trim_end_matches(['/', '\\']);
    let relative = if !root.is_empty() && report.len() > root.len() + 1 && report.starts_with(root) {
        let rest = &report[root.len()..];
        rest.strip_prefix('/').or_else(|| rest.strip_prefix('\\')).map(str::to_string)
    } else if is_absolute_like(&report) {
        None
    } else {
        Some(report)
    };
    let safe = relative.filter(|r| !r.is_empty() && !is_absolute_like(r) && !r.split(['/', '\\']).any(|part| part == ".."));
    object.insert("report".to_string(), safe.map(Value::String).unwrap_or(Value::Null));
}

/// How reading the stream ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriveOutcome {
    /// The stream closed (the CLI exited or closed stdout).
    Ended,
    Cancelled,
    TimedOut,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DriveStats {
    pub lines: usize,
    pub dropped: usize,
    pub saw_done: bool,
}

/// Read one line of at most `MAX_LINE_BYTES`. Returns `Ok(None)` at the end of
/// the stream and `Ok(Some(None))` for a line that was too long (it is read
/// to its end and thrown away).
async fn read_bounded_line<R: AsyncBufRead + Unpin>(reader: &mut R, buf: &mut Vec<u8>) -> std::io::Result<Option<Option<String>>> {
    buf.clear();
    let n = (&mut *reader).take(MAX_LINE_BYTES as u64 + 1).read_until(b'\n', buf).await?;
    if n == 0 {
        return Ok(None);
    }
    if buf.last() != Some(&b'\n') && buf.len() > MAX_LINE_BYTES {
        // Too long: skip to the end of this line.
        loop {
            buf.clear();
            let m = (&mut *reader).take(MAX_LINE_BYTES as u64).read_until(b'\n', buf).await?;
            if m == 0 || buf.last() == Some(&b'\n') {
                break;
            }
        }
        return Ok(Some(None));
    }
    Ok(Some(Some(String::from_utf8_lossy(buf).into_owned())))
}

/// Forward the stream's valid lines until it ends, the scan is cancelled, or
/// the deadline passes. Nothing after a `done` line is forwarded. Past
/// `MAX_FORWARDED_LINES` only `done` and a few `error` lines still go out.
pub async fn drive_lines<R, F>(
    reader: R,
    cancel: &mut oneshot::Receiver<()>,
    deadline: Instant,
    mut emit: F,
) -> (DriveOutcome, DriveStats)
where
    R: AsyncBufRead + Unpin,
    F: FnMut(Value),
{
    let mut reader = reader;
    let mut stats = DriveStats::default();
    let mut buf = Vec::with_capacity(1024);
    loop {
        let next = tokio::select! {
            biased;
            _ = &mut *cancel => return (DriveOutcome::Cancelled, stats),
            _ = tokio::time::sleep_until(deadline) => return (DriveOutcome::TimedOut, stats),
            line = read_bounded_line(&mut reader, &mut buf) => line,
        };
        match next {
            Ok(None) | Err(_) => return (DriveOutcome::Ended, stats),
            Ok(Some(None)) => stats.dropped += 1,
            Ok(Some(Some(line))) => {
                if line.trim().is_empty() {
                    continue;
                }
                if stats.saw_done {
                    stats.dropped += 1;
                    continue;
                }
                match validate_line(&line) {
                    Some(value) => {
                        let over_cap = stats.lines >= MAX_FORWARDED_LINES;
                        let allowed_past_cap = is_done_line(&value)
                            || (is_error_line(&value) && stats.lines < MAX_FORWARDED_LINES + ERROR_LINES_PAST_CAP);
                        if over_cap && !allowed_past_cap {
                            stats.dropped += 1;
                            continue;
                        }
                        if is_done_line(&value) {
                            stats.saw_done = true;
                        }
                        stats.lines += 1;
                        emit(value);
                    }
                    None => stats.dropped += 1,
                }
            }
        }
    }
}

/// The CLI said it has no such command or flag (an `hq` older than the scan).
pub fn is_unknown_command(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("unknown command") || lower.contains("unknown option")
}

/// What the webview hears. A `done` line wins (hq-cli prints one even when the
/// scanner failed, exit 1). Without one, exit 2 (a usage error) or an
/// "unknown command" means this `hq` cannot scan yet.
pub fn end_status(outcome: DriveOutcome, saw_done: bool, exit_code: Option<i32>, stderr: &str) -> &'static str {
    match outcome {
        DriveOutcome::Cancelled => "cancelled",
        DriveOutcome::TimedOut => "timeout",
        DriveOutcome::Ended if saw_done => "done",
        DriveOutcome::Ended if exit_code == Some(2) || is_unknown_command(stderr) => "unavailable",
        DriveOutcome::Ended => "failed",
    }
}

// ── the one running scan ────────────────────────────────────────────────────

struct Active {
    scan_id: String,
    /// The window that started it (its Destroyed event cancels it).
    window: String,
    cancel: oneshot::Sender<()>,
}

#[derive(Default)]
struct Registry {
    active: Option<Active>,
    /// Ids cancelled before they started, oldest first.
    precancelled: Vec<String>,
    /// Windows whose Destroyed event is already watched (one listener each).
    watched_windows: Vec<String>,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

/// Make this the running scan, cancelling any other. Returns its cancel
/// signal, or None when this id was cancelled before it got here (the scan
/// must not start).
pub fn register_scan(scan_id: &str, window: &str) -> Option<oneshot::Receiver<()>> {
    let (tx, rx) = oneshot::channel();
    let previous = {
        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(at) = reg.precancelled.iter().position(|id| id == scan_id) {
            reg.precancelled.remove(at);
            return None;
        }
        reg.active.replace(Active { scan_id: scan_id.to_string(), window: window.to_string(), cancel: tx })
    };
    if let Some(previous) = previous {
        let _ = previous.cancel.send(());
    }
    Some(rx)
}

/// Cancel the scan with this id. True if it was running; otherwise the id is
/// remembered, so a start that arrives later does nothing.
pub fn cancel_scan(scan_id: &str) -> bool {
    let taken = {
        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        if reg.active.as_ref().map(|a| a.scan_id.as_str()) == Some(scan_id) {
            reg.active.take()
        } else {
            if !reg.precancelled.iter().any(|id| id == scan_id) {
                if reg.precancelled.len() >= MAX_PRECANCELLED {
                    reg.precancelled.remove(0);
                }
                reg.precancelled.push(scan_id.to_string());
            }
            None
        }
    };
    match taken {
        Some(active) => {
            let _ = active.cancel.send(());
            true
        }
        None => false,
    }
}

fn unregister_scan(scan_id: &str) {
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    if reg.active.as_ref().map(|a| a.scan_id.as_str()) == Some(scan_id) {
        reg.active.take();
    }
}

/// True the first time a window is seen, so its Destroyed listener is added once.
fn watch_window_once(window: &str) -> bool {
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    if reg.watched_windows.iter().any(|w| w == window) {
        return false;
    }
    reg.watched_windows.push(window.to_string());
    true
}

fn unwatch_window(window: &str) {
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    reg.watched_windows.retain(|w| w != window);
}

/// The window closed: cancel the scan it started, if one is running. Never
/// remembers anything (a closed window has no scan still to start).
pub fn cancel_window_scan(window: &str) -> bool {
    let taken = {
        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        if reg.active.as_ref().map(|a| a.window.as_str()) == Some(window) {
            reg.active.take()
        } else {
            None
        }
    };
    match taken {
        Some(active) => {
            let _ = active.cancel.send(());
            true
        }
        None => false,
    }
}

/// Where hq (the group leader) is, read without reaping it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaderState {
    Running,
    /// Exited but not reaped: its zombie still pins the group id, so a
    /// signal to the group cannot reach a process that reused the id.
    Exited,
    /// Already reaped (or never ours): the group id may be reused.
    Gone,
}

/// Peek at the leader with `waitid(WNOWAIT)`, which leaves a zombie in place.
#[cfg(unix)]
pub fn leader_state(pid: i32) -> LeaderState {
    // SAFETY: waitid only writes into `info`, a zeroed siginfo_t we own.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let flags = libc::WEXITED | libc::WNOWAIT | libc::WNOHANG;
    let rc = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, flags) };
    if rc != 0 {
        return LeaderState::Gone;
    }
    #[cfg(target_os = "linux")]
    let exited_pid = unsafe { info.si_pid() };
    #[cfg(not(target_os = "linux"))]
    let exited_pid = info.si_pid;
    if exited_pid == 0 {
        LeaderState::Running
    } else {
        LeaderState::Exited
    }
}

/// Wait up to `limit` for the leader to exit, without reaping it.
#[cfg(unix)]
async fn wait_leader_exit(pid: i32, limit: Duration) -> LeaderState {
    let until = Instant::now() + limit;
    loop {
        let state = leader_state(pid);
        if state != LeaderState::Running || Instant::now() >= until {
            return state;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Stop the scan's whole process group: SIGTERM to the group (hq and the
/// scanner it started), up to 3 s for hq to exit, then SIGKILL to the group
/// in every case, since a scanner can outlive hq. The SIGKILL goes out before
/// hq is reaped, while its zombie still holds the group id, so it can never
/// reach a process that later reused that id. `pgid` is hq's pid, taken at
/// spawn (hq leads its own group); ESRCH (nothing left) is ignored.
pub async fn stop_child(child: &mut tokio::process::Child, pgid: Option<i32>) {
    #[cfg(unix)]
    if let Some(pgid) = pgid {
        let group = nix::unistd::Pid::from_raw(pgid);
        let _ = nix::sys::signal::killpg(group, nix::sys::signal::Signal::SIGTERM);
        let state = wait_leader_exit(pgid, Duration::from_secs(3)).await;
        if state != LeaderState::Gone {
            kill_group(Some(pgid));
        }
    }
    #[cfg(not(unix))]
    let _ = pgid;
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
}

/// After a normal end: once hq has exited (still unreaped), clear anything it
/// left in its group, then reap it. Returns hq's exit code, or None when it
/// did not exit in time (the caller then stops it).
async fn reap_after_end(child: &mut tokio::process::Child, pgid: Option<i32>) -> Option<Option<i32>> {
    #[cfg(unix)]
    if let Some(pgid) = pgid {
        match wait_leader_exit(pgid, Duration::from_secs(5)).await {
            LeaderState::Running => return None,
            LeaderState::Exited => kill_group(Some(pgid)),
            LeaderState::Gone => {}
        }
    }
    match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(Ok(status)) => Some(status.code()),
        _ => None,
    }
}

/// SIGKILL whatever is left of the scan's process group. Never the app's own
/// group: hq is spawned with `process_group(0)`. Callers send it only while
/// hq is unreaped.
fn kill_group(pgid: Option<i32>) {
    #[cfg(unix)]
    if let Some(pgid) = pgid.filter(|p| *p > 1) {
        let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pgid), nix::sys::signal::Signal::SIGKILL);
    }
    #[cfg(not(unix))]
    let _ = pgid;
}

async fn run_scan(app: &AppHandle, target: &str, scan_id: &str, cancel: &mut oneshot::Receiver<()>) -> ImportScanEnd {
    let unavailable = ImportScanEnd { status: "unavailable", lines: 0, dropped: 0 };
    let Some(hq_root) = existing_hq_path() else {
        log(LOG_TAG, "import scan not run: no HQ folder");
        return ImportScanEnd { status: "no_hq", lines: 0, dropped: 0 };
    };
    // A scratch build may bake in a local hq and scanner (scratch_build.rs);
    // every other build runs the installed hq with its own scanner.
    let hq = crate::scratch_build::import_hq_bin()
        .map(str::to_string)
        .unwrap_or_else(|| paths::resolve_bin("hq"));
    let mut command =
        paths::tokio_spawn_command(&hq, &["import", "scan", "--json", "--stream", "--hq-root", hq_root.as_str()]);
    command
        .current_dir(&hq_root)
        .env("PATH", paths::child_path())
        .env("HQ_NO_UPDATE_CHECK", "1")
        .env("HQ_ROOT", &hq_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Kills hq (not its group) if this future is dropped, which happens
        // only when the app shuts down. A closed window cancels the scan through
        // its Destroyed event instead (see import_scan_start).
        .kill_on_drop(true);
    if let Some(scanner) = crate::scratch_build::import_scanner() {
        command.env("HQ_IMPORT_SCANNER_OVERRIDE", scanner);
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            log(LOG_TAG, "import scan unavailable: could not start hq");
            return unavailable;
        }
    };
    // hq leads its own process group; its id is the group's id.
    let pgid = child.id().map(|id| id as i32);
    let Some(stdout) = child.stdout.take() else {
        stop_child(&mut child, pgid).await;
        return ImportScanEnd { status: "failed", lines: 0, dropped: 0 };
    };
    // Keep the head of stderr (to recognise an hq without the command), drain the rest.
    let stderr_task = child.stderr.take().map(|mut stderr| {
        tokio::spawn(async move {
            let mut kept = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match stderr.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if kept.len() < STDERR_KEEP {
                            let room = STDERR_KEEP - kept.len();
                            kept.extend_from_slice(&chunk[..n.min(room)]);
                        }
                    }
                }
            }
            String::from_utf8_lossy(&kept).into_owned()
        })
    });

    let deadline = Instant::now() + SCAN_TIMEOUT;
    let (outcome, stats) = drive_lines(BufReader::new(stdout), cancel, deadline, |mut event| {
        if is_done_line(&event) {
            relativize_report(&mut event, &hq_root);
        }
        // Only the window that asked hears the lines (a broadcast would wake every webview).
        let _ = app.emit_to(target, IMPORT_SCAN_EVENT, ImportScanEventPayload { scan_id, event });
    })
    .await;

    let mut exit_code = None;
    match outcome {
        // Anything hq left running in its group (a scanner that outlived it)
        // goes too, before hq is reaped.
        DriveOutcome::Ended => match reap_after_end(&mut child, pgid).await {
            Some(code) => exit_code = code,
            None => stop_child(&mut child, pgid).await,
        },
        DriveOutcome::Cancelled | DriveOutcome::TimedOut => stop_child(&mut child, pgid).await,
    }
    let stderr = match stderr_task {
        Some(mut task) => match tokio::time::timeout(Duration::from_secs(2), &mut task).await {
            Ok(Ok(text)) => text,
            Ok(Err(_)) => String::new(),
            Err(_) => {
                // Something still holds stderr open: stop draining it.
                task.abort();
                String::new()
            }
        },
        None => String::new(),
    };
    let status = end_status(outcome, stats.saw_done, exit_code, &stderr);
    log(LOG_TAG, &format!("import scan {status}: {} lines forwarded, {} dropped", stats.lines, stats.dropped));
    ImportScanEnd { status, lines: stats.lines, dropped: stats.dropped }
}

/// Run `hq import scan --json --stream`, forwarding each valid line as an
/// `import-scan://event`. Resolves when the scan ends, however it ends.
#[tauri::command]
pub async fn import_scan_start(
    app: AppHandle,
    window: tauri::WebviewWindow,
    scan_id: String,
) -> Result<ImportScanEnd, String> {
    let scan_id = validate_scan_id(&scan_id)?;
    let target = window.label().to_string();
    let Some(mut cancel) = register_scan(&scan_id, &target) else {
        // The webview cancelled before this start arrived.
        return Ok(ImportScanEnd { status: "cancelled", lines: 0, dropped: 0 });
    };
    // A command future is not dropped when its window closes, so the window's
    // Destroyed event cancels the scan that window is running. One listener
    // per window, added the first time it starts a scan.
    if watch_window_once(&target) {
        let label = target.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                cancel_window_scan(&label);
                // A window made later under the same label gets its own listener.
                unwatch_window(&label);
            }
        });
    }
    let end = run_scan(&app, &target, &scan_id, &mut cancel).await;
    unregister_scan(&scan_id);
    Ok(end)
}

/// Stop the running scan with this id (the person left the screen).
#[tauri::command]
pub async fn import_scan_cancel(scan_id: String) -> Result<bool, String> {
    let scan_id = validate_scan_id(&scan_id)?;
    Ok(cancel_scan(&scan_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    fn far() -> Instant {
        Instant::now() + Duration::from_secs(60)
    }

    #[test]
    fn scan_ids_are_short_slugs() {
        assert_eq!(validate_scan_id("2f1c9a4e-0b7d-4c55-9f3a-0d8f5e1b2a77").unwrap(), "2f1c9a4e-0b7d-4c55-9f3a-0d8f5e1b2a77");
        assert_eq!(validate_scan_id(" scan_1 ").unwrap(), "scan_1");
        assert!(validate_scan_id("").is_err());
        assert!(validate_scan_id("../etc").is_err());
        assert!(validate_scan_id("a b").is_err());
        assert!(validate_scan_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn lines_must_be_version_1_objects_of_a_known_type() {
        let ok = validate_line(r#"{"v":1,"type":"count","source":"claude-code","key":"sessions","value":120}"#).unwrap();
        assert_eq!(ok["value"], 120);
        assert!(validate_line(r#"  {"v":1,"type":"done","report":"/tmp/r.json","summary":{}}  "#).is_some());
        // wrong or missing version
        assert!(validate_line(r#"{"v":2,"type":"count"}"#).is_none());
        assert!(validate_line(r#"{"type":"count"}"#).is_none());
        assert!(validate_line(r#"{"v":"1","type":"count"}"#).is_none());
        // unknown or missing type
        assert!(validate_line(r#"{"v":1,"type":"telemetry"}"#).is_none());
        assert!(validate_line(r#"{"v":1}"#).is_none());
        // not an object, not JSON, empty
        assert!(validate_line(r#"[{"v":1,"type":"done"}]"#).is_none());
        assert!(validate_line("Scanning Claude Code…").is_none());
        assert!(validate_line("{not json").is_none());
        assert!(validate_line("").is_none());
        // too long
        let long = format!(r#"{{"v":1,"type":"error","message":"{}"}}"#, "x".repeat(MAX_LINE_BYTES));
        assert!(validate_line(&long).is_none());
    }

    #[tokio::test]
    async fn drive_forwards_valid_lines_and_stops_after_done() {
        let input = concat!(
            "{\"v\":1,\"type\":\"start\",\"sources\":[]}\n",
            "debug noise\n",
            "\n",
            "{\"v\":1,\"type\":\"count\",\"source\":\"codex\",\"key\":\"sessions\",\"value\":3}\n",
            "{\"v\":9,\"type\":\"count\"}\n",
            "{\"v\":1,\"type\":\"done\",\"report\":null,\"summary\":{}}\n",
            "{\"v\":1,\"type\":\"count\",\"source\":\"codex\",\"key\":\"sessions\",\"value\":4}\n",
        );
        let (_tx, mut rx) = oneshot::channel::<()>();
        let mut seen = Vec::new();
        let (outcome, stats) = drive_lines(BufReader::new(input.as_bytes()), &mut rx, far(), |v| seen.push(v)).await;
        assert_eq!(outcome, DriveOutcome::Ended);
        assert_eq!(seen.len(), 3);
        assert_eq!(seen[2]["type"], "done");
        assert!(stats.saw_done);
        assert_eq!(stats.lines, 3);
        // noise, wrong version, and the line after done
        assert_eq!(stats.dropped, 3);
    }

    #[tokio::test]
    async fn drive_drops_an_oversized_line_and_keeps_going() {
        let big = format!("{{\"v\":1,\"type\":\"error\",\"message\":\"{}\"}}\n", "y".repeat(MAX_LINE_BYTES * 2));
        let input = format!("{big}{{\"v\":1,\"type\":\"done\",\"report\":null,\"summary\":{{}}}}\n");
        let (_tx, mut rx) = oneshot::channel::<()>();
        let mut seen = Vec::new();
        let (outcome, stats) = drive_lines(BufReader::new(input.as_bytes()), &mut rx, far(), |v| seen.push(v)).await;
        assert_eq!(outcome, DriveOutcome::Ended);
        assert_eq!(seen.len(), 1);
        assert_eq!(stats.dropped, 1);
        assert!(stats.saw_done);
    }

    #[tokio::test]
    async fn cancel_stops_a_stream_that_is_still_open() {
        let (mut writer, reader) = tokio::io::duplex(1024);
        let (tx, mut rx) = oneshot::channel::<()>();
        writer.write_all(b"{\"v\":1,\"type\":\"start\",\"sources\":[]}\n").await.unwrap();
        let drive = tokio::spawn(async move {
            let mut n = 0;
            let result = drive_lines(BufReader::new(reader), &mut rx, Instant::now() + Duration::from_secs(30), |_| n += 1).await;
            (result, n)
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        tx.send(()).unwrap();
        let ((outcome, stats), n) = tokio::time::timeout(Duration::from_secs(5), drive).await.unwrap().unwrap();
        assert_eq!(outcome, DriveOutcome::Cancelled);
        assert_eq!(n, 1);
        assert!(!stats.saw_done);
        drop(writer);
    }

    #[tokio::test]
    async fn a_silent_stream_times_out() {
        let (_writer, reader) = tokio::io::duplex(64);
        let (_tx, mut rx) = oneshot::channel::<()>();
        let (outcome, stats) =
            drive_lines(BufReader::new(reader), &mut rx, Instant::now() + Duration::from_millis(40), |_| {}).await;
        assert_eq!(outcome, DriveOutcome::TimedOut);
        assert_eq!(stats.lines, 0);
    }

    #[test]
    fn one_scan_at_a_time_and_cancel_by_id() {
        let _serial = registry_test_lock();
        let mut first = register_scan("test-scan-a", "test-window").unwrap();
        // A second scan cancels the first.
        let mut second = register_scan("test-scan-b", "test-window").unwrap();
        assert!(first.try_recv().is_ok());
        // Only the running scan's id cancels it.
        assert!(!cancel_scan("test-scan-a"));
        assert!(second.try_recv().is_err());
        assert!(cancel_scan("test-scan-b"));
        assert!(second.try_recv().is_ok());
        // Already gone.
        assert!(!cancel_scan("test-scan-b"));
        unregister_scan("test-scan-b");
    }

    #[test]
    fn end_status_tells_an_old_hq_from_a_failure() {
        assert_eq!(end_status(DriveOutcome::Ended, true, Some(0), ""), "done");
        assert_eq!(
            end_status(DriveOutcome::Ended, false, Some(1), "error: unknown command 'import'\n(Did you mean report?)"),
            "unavailable"
        );
        // exit 2 is a usage error: an hq that does not know the flags yet
        assert_eq!(end_status(DriveOutcome::Ended, false, Some(2), ""), "unavailable");
        assert_eq!(end_status(DriveOutcome::Ended, false, Some(1), "boom"), "failed");
        assert_eq!(end_status(DriveOutcome::Cancelled, false, None, ""), "cancelled");
        assert_eq!(end_status(DriveOutcome::TimedOut, false, None, ""), "timeout");
        // A done line wins (hq-cli prints one even when the scanner failed, exit 1).
        assert_eq!(end_status(DriveOutcome::Ended, true, Some(1), "unknown command"), "done");
    }

    #[test]
    fn a_cancel_that_beats_the_start_stops_it_from_running() {
        let _serial = registry_test_lock();
        assert!(!cancel_scan("test-scan-early"));
        assert!(register_scan("test-scan-early", "test-window").is_none(), "a cancelled id must not start");
        // Remembered once: the same id can run later.
        let rx = register_scan("test-scan-early", "test-window");
        assert!(rx.is_some());
        unregister_scan("test-scan-early");
    }

    #[test]
    fn a_closed_window_cancels_only_its_own_running_scan() {
        let _serial = registry_test_lock();
        let mut rx = register_scan("test-scan-win", "window-a").unwrap();
        // Another window closing leaves it running.
        assert!(!cancel_window_scan("window-b"));
        assert!(rx.try_recv().is_err());
        assert!(cancel_window_scan("window-a"));
        assert!(rx.try_recv().is_ok());
        // Nothing left to cancel, and nothing remembered: the id can still start.
        assert!(!cancel_window_scan("window-a"));
        let again = register_scan("test-scan-win", "window-a");
        assert!(again.is_some(), "a window close must not block a later start");
        unregister_scan("test-scan-win");
    }

    #[test]
    fn a_window_gets_one_destroyed_listener() {
        let _serial = registry_test_lock();
        assert!(watch_window_once("test-window-once"));
        assert!(!watch_window_once("test-window-once"));
        assert!(!watch_window_once("test-window-once"));
        // Once that window is gone, a new window under the label is watched again.
        unwatch_window("test-window-once");
        assert!(watch_window_once("test-window-once"));
        unwatch_window("test-window-once");
    }

    /// The registry is process-wide; tests that touch it take turns.
    fn registry_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_leader_is_read_without_reaping_it() {
        let mut child = tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 3")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap() as i32;
        let state = wait_leader_exit(pid, Duration::from_secs(5)).await;
        assert_eq!(state, LeaderState::Exited);
        // Still unreaped: reading again says the same, and the exit code is intact.
        assert_eq!(leader_state(pid), LeaderState::Exited);
        let status = child.wait().await.unwrap();
        assert_eq!(status.code(), Some(3));
        assert_eq!(leader_state(pid), LeaderState::Gone);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn after_a_normal_end_the_group_is_cleared_before_hq_is_reaped() {
        // hq exits at once, leaving a scanner child that ignores SIGTERM.
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("/bin/sh -c 'trap \"\" TERM; echo $$; exec sleep 30' & read _ignored; exit 0")
            .stdout(Stdio::piped())
            .stdin(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = command.spawn().unwrap();
        let pgid = child.id().map(|id| id as i32);
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(5), out.read_line(&mut line)).await.unwrap().unwrap();
        let grandchild: i32 = line.trim().parse().unwrap();
        drop(child.stdin.take());

        let code = reap_after_end(&mut child, pgid).await;
        assert_eq!(code, Some(Some(0)));

        let pid = nix::unistd::Pid::from_raw(grandchild);
        let mut gone = false;
        for _ in 0..50 {
            if nix::sys::signal::kill(pid, None).is_err() {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if !gone {
            let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGKILL);
        }
        assert!(gone, "a scanner left behind by hq must not outlive the scan");
    }

    #[test]
    fn the_report_path_becomes_relative_to_the_hq_folder() {
        let mut done = serde_json::json!({"v":1,"type":"done","report":"/Users/pat/hq/workspace/imports/2026-10-08/report.json","summary":{}});
        relativize_report(&mut done, "/Users/pat/hq");
        assert_eq!(done["report"], "workspace/imports/2026-10-08/report.json");

        let mut trailing = serde_json::json!({"type":"done","report":"/Users/pat/hq/r.json"});
        relativize_report(&mut trailing, "/Users/pat/hq/");
        assert_eq!(trailing["report"], "r.json");

        for outside in ["/tmp/report.json", "/Users/pat/hqx/report.json", "~/hq/report.json", "C:\\Users\\pat\\r.json", "/Users/pat/hq/../secret.json"] {
            let mut v = serde_json::json!({"type":"done","report": outside});
            relativize_report(&mut v, "/Users/pat/hq");
            assert!(v["report"].is_null(), "{outside} must not leave the machine");
        }
        let mut climbing = serde_json::json!({"type":"done","report":"../report.json"});
        relativize_report(&mut climbing, "/Users/pat/hq");
        assert!(climbing["report"].is_null());
        let mut relative = serde_json::json!({"type":"done","report":"workspace/r.json"});
        relativize_report(&mut relative, "/Users/pat/hq");
        assert_eq!(relative["report"], "workspace/r.json");
        let mut none = serde_json::json!({"type":"done","report":null});
        relativize_report(&mut none, "/Users/pat/hq");
        assert!(none["report"].is_null());
    }

    #[tokio::test]
    async fn done_and_errors_still_go_out_past_the_line_cap() {
        let mut input = String::new();
        for i in 0..(MAX_FORWARDED_LINES + 10) {
            input.push_str(&format!("{{\"v\":1,\"type\":\"count\",\"source\":\"codex\",\"key\":\"sessions\",\"value\":{i}}}\n"));
        }
        input.push_str("{\"v\":1,\"type\":\"error\",\"source\":\"codex\",\"message\":\"late\"}\n");
        input.push_str("{\"v\":1,\"type\":\"done\",\"report\":null,\"summary\":{}}\n");
        let (_tx, mut rx) = oneshot::channel::<()>();
        let mut seen = Vec::new();
        let (outcome, stats) = drive_lines(BufReader::new(input.as_bytes()), &mut rx, far(), |v| seen.push(v)).await;
        assert_eq!(outcome, DriveOutcome::Ended);
        assert!(stats.saw_done);
        assert_eq!(seen.len(), MAX_FORWARDED_LINES + 2);
        assert_eq!(seen[seen.len() - 2]["type"], "error");
        assert_eq!(seen[seen.len() - 1]["type"], "done");
        assert_eq!(stats.dropped, 10);
    }

    /// A fake hq that exits on SIGTERM, with a scanner child that ignores it.
    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_kills_a_scanner_that_ignores_the_signal() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("/bin/sh -c 'trap \"\" TERM; echo $$; exec sleep 30' & trap 'exit 0' TERM; wait")
            .stdout(Stdio::piped())
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = command.spawn().unwrap();
        let pgid = child.id().map(|id| id as i32);
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(5), out.read_line(&mut line)).await.unwrap().unwrap();
        let grandchild: i32 = line.trim().parse().unwrap();
        // Let the leader reach `wait` so its trap is armed.
        tokio::time::sleep(Duration::from_millis(200)).await;

        stop_child(&mut child, pgid).await;

        let pid = nix::unistd::Pid::from_raw(grandchild);
        let mut gone = false;
        for _ in 0..50 {
            if nix::sys::signal::kill(pid, None).is_err() {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if !gone {
            let _ = nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGKILL);
        }
        assert!(gone, "the scanner grandchild outlived stop_child");
    }
}
