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

use crate::commands::install_directory::resolve_hq_path;
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
pub const MAX_FORWARDED_LINES: usize = 20_000;
/// The line types this version of the stream has.
const KNOWN_TYPES: [&str; 7] = ["start", "source", "count", "company", "project", "error", "done"];
/// How much stderr is kept to recognise an `hq` without the command.
const STDERR_KEEP: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportScanEnd {
    /// "done" | "failed" | "cancelled" | "timeout" | "unavailable"
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
/// the deadline passes. Nothing after a `done` line is forwarded.
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
                if stats.saw_done || stats.lines >= MAX_FORWARDED_LINES {
                    stats.dropped += 1;
                    continue;
                }
                match validate_line(&line) {
                    Some(value) => {
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
    cancel: oneshot::Sender<()>,
}

fn active() -> &'static Mutex<Option<Active>> {
    static ACTIVE: OnceLock<Mutex<Option<Active>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

/// Make this the running scan, cancelling any other. Returns its cancel signal.
pub fn register_scan(scan_id: &str) -> oneshot::Receiver<()> {
    let (tx, rx) = oneshot::channel();
    let previous = {
        let mut slot = active().lock().unwrap_or_else(|e| e.into_inner());
        slot.replace(Active { scan_id: scan_id.to_string(), cancel: tx })
    };
    if let Some(previous) = previous {
        let _ = previous.cancel.send(());
    }
    rx
}

/// Cancel the scan with this id, if it is the one running. True if it was.
pub fn cancel_scan(scan_id: &str) -> bool {
    let taken = {
        let mut slot = active().lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().map(|a| a.scan_id.as_str()) == Some(scan_id) {
            slot.take()
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

fn unregister_scan(scan_id: &str) {
    let mut slot = active().lock().unwrap_or_else(|e| e.into_inner());
    if slot.as_ref().map(|a| a.scan_id.as_str()) == Some(scan_id) {
        slot.take();
    }
}

/// Ask `hq` to stop (SIGTERM, which it forwards to the scanner), then kill
/// its whole process group if it is still there after a grace period.
async fn stop_child(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(id) = child.id() {
        let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(id as i32), nix::sys::signal::Signal::SIGTERM);
        if tokio::time::timeout(Duration::from_secs(3), child.wait()).await.is_ok() {
            return;
        }
        // The CLI runs in its own process group, never the app's.
        let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(id as i32), nix::sys::signal::Signal::SIGKILL);
    }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
}

async fn run_scan(app: &AppHandle, target: &str, scan_id: &str, cancel: &mut oneshot::Receiver<()>) -> ImportScanEnd {
    let unavailable = ImportScanEnd { status: "unavailable", lines: 0, dropped: 0 };
    let hq_root = match resolve_hq_path() {
        Ok(root) => root,
        Err(_) => {
            log(LOG_TAG, "import scan unavailable: no HQ folder");
            return unavailable;
        }
    };
    let hq = paths::resolve_bin("hq");
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
        // A cancelled or panicking caller never leaves an orphan scan behind.
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            log(LOG_TAG, "import scan unavailable: could not start hq");
            return unavailable;
        }
    };
    let Some(stdout) = child.stdout.take() else {
        stop_child(&mut child).await;
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
    let (outcome, stats) = drive_lines(BufReader::new(stdout), cancel, deadline, |event| {
        // Only the window that asked hears the lines (a broadcast would wake every webview).
        let _ = app.emit_to(target, IMPORT_SCAN_EVENT, ImportScanEventPayload { scan_id, event });
    })
    .await;

    let mut exit_code = None;
    match outcome {
        DriveOutcome::Ended => match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(Ok(status)) => exit_code = status.code(),
            _ => stop_child(&mut child).await,
        },
        DriveOutcome::Cancelled | DriveOutcome::TimedOut => stop_child(&mut child).await,
    }
    let stderr = match stderr_task {
        Some(task) => tokio::time::timeout(Duration::from_secs(2), task).await.ok().and_then(Result::ok).unwrap_or_default(),
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
    let mut cancel = register_scan(&scan_id);
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
        let mut first = register_scan("test-scan-a");
        // A second scan cancels the first.
        let mut second = register_scan("test-scan-b");
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
}
