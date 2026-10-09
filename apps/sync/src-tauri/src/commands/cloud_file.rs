//! Opening `.hqcloud` placeholders (big files moved to HQ cloud storage).
//!
//! `hq storage offload` replaces a big file `x.mp4` with a small text
//! placeholder `x.mp4.hqcloud`. The bundle registers the `hqcloud` extension
//! so double-clicking one in Finder or Explorer opens HQ. HQ then runs
//! `hq storage fetch <placeholder> --json`, which downloads and verifies the
//! original and restores it at the path written inside the placeholder, and
//! opens the file at the path the CLI reports.
//!
//! How the path arrives:
//! - macOS: `RunEvent::Opened { urls }` with `file://` URLs, cold or warm.
//! - Windows/Linux: the path is in argv. Cold start reads `std::env::args`,
//!   a second launch reaches the single-instance callback.
//!
//! Progress and errors go to the desktop window as `CLOUD_FILE_EVENT` so it
//! can show a toast; on an error HQ comes forward so the toast is seen.
//! On a cold start the window (or its listener) may not exist yet, so events
//! are held until the UI calls `cloud_file_ui_ready`, which hands them over.
//! Errors carry a short code (`offline`, `no-access`, `update-hq`, `failed`),
//! never raw CLI output. Only file names are logged.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::feedback::resolve_hq_folder;
use crate::commands::storage::{run_hq, UPDATE_HQ_ERROR};
use crate::util::logfile::log;

pub const PLACEHOLDER_EXT: &str = "hqcloud";
pub const CLOUD_FILE_EVENT: &str = "cloud-file://fetch";
const POINTER_HEADER: &str = "HQ-CLOUD-FILE v1";
/// Placeholders are under 1 KB; anything much bigger is not one.
const POINTER_MAX_BYTES: u64 = 64 * 1024;
const PENDING_MAX: usize = 32;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudFileEvent {
    /// File name of the original (e.g. `promo.mp4`), for the toast.
    pub name: String,
    /// Full placeholder path; keys the toast so two `promo.mp4`s stay apart.
    pub path: String,
    /// `fetching` | `opened` | `error`.
    pub phase: &'static str,
    /// Error code when `phase == "error"`.
    pub error: Option<&'static str>,
}

/// Events held until the desktop UI says it is listening.
struct Pending {
    ui_ready: bool,
    events: Vec<CloudFileEvent>,
}

static PENDING: Mutex<Pending> = Mutex::new(Pending {
    ui_ready: false,
    events: Vec::new(),
});

/// Keep only the latest step per file, oldest files dropped past the cap.
fn queue_event(events: &mut Vec<CloudFileEvent>, ev: CloudFileEvent) {
    events.retain(|e| e.path != ev.path);
    events.push(ev);
    if events.len() > PENDING_MAX {
        let extra = events.len() - PENDING_MAX;
        events.drain(..extra);
    }
}

pub fn is_placeholder(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(PLACEHOLDER_EXT))
}

/// A `file://` URL that points at a placeholder.
pub fn placeholder_from_url(url: &url::Url) -> Option<PathBuf> {
    if url.scheme() != "file" {
        return None;
    }
    let path = url.to_file_path().ok()?;
    is_placeholder(&path).then_some(path)
}

/// Placeholder paths in a launch argv (argv[0] is the binary and skipped).
pub fn placeholders_from_argv<S: AsRef<str>>(argv: &[S]) -> Vec<PathBuf> {
    argv.iter()
        .skip(1)
        .map(|a| PathBuf::from(a.as_ref()))
        .filter(|p| p.is_absolute() && is_placeholder(p))
        .collect()
}

/// The `path:` line of a placeholder: where the CLI restores the original,
/// relative to the HQ folder. `None` when the text is not a placeholder.
pub fn pointer_path(text: &str) -> Option<String> {
    let mut lines = text.lines();
    if lines.next()?.trim() != POINTER_HEADER {
        return None;
    }
    lines
        .find_map(|l| l.strip_prefix("path:"))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
}

fn read_pointer_path(placeholder: &Path) -> Option<String> {
    let meta = std::fs::metadata(placeholder).ok()?;
    if meta.len() > POINTER_MAX_BYTES {
        return None;
    }
    pointer_path(&std::fs::read_to_string(placeholder).ok()?)
}

/// `path` from `hq storage fetch --json` output, when it printed JSON.
pub fn fetch_json_path(stdout: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    v.get("path")?
        .as_str()
        .map(str::to_string)
        .filter(|p| !p.is_empty())
}

/// Where the original now is: the CLI's reported path, else the placeholder's
/// own `path:` line. Relative paths are inside the HQ folder.
pub fn restored_path(
    root: &Path,
    reported: Option<&str>,
    pointer: Option<&str>,
) -> Option<PathBuf> {
    let rel = reported.or(pointer)?;
    let p = Path::new(rel);
    Some(if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    })
}

/// `hq storage fetch <placeholder> [--json]`. Only absolute `.hqcloud`
/// paths, so a crafted argument can never be read as a flag.
pub fn fetch_args(placeholder: &Path, json: bool) -> Result<Vec<OsString>, String> {
    if !placeholder.is_absolute() || !is_placeholder(placeholder) {
        return Err("not-a-placeholder".to_string());
    }
    let mut args: Vec<OsString> = vec![
        "storage".into(),
        "fetch".into(),
        placeholder.as_os_str().to_owned(),
    ];
    if json {
        args.push("--json".into());
    }
    Ok(args)
}

/// True when the CLI predates `fetch --json`.
fn rejects_json_flag(message: &str) -> bool {
    message
        .to_ascii_lowercase()
        .contains("unknown option '--json'")
}

/// Map a failed fetch to a short code the UI turns into plain copy.
pub fn classify_fetch_error(message: &str) -> &'static str {
    if message.contains(UPDATE_HQ_ERROR) {
        return UPDATE_HQ_ERROR;
    }
    let m = message.to_ascii_lowercase();
    if [
        "access denied",
        "forbidden",
        "not authorized",
        "unauthorized",
        "403",
    ]
    .iter()
    .any(|s| m.contains(s))
    {
        return "no-access";
    }
    if [
        "offline",
        "network",
        "enotfound",
        "eai_again",
        "econnrefused",
        "econnreset",
        "timed out",
        "timeout",
        "could not resolve",
    ]
    .iter()
    .any(|s| m.contains(s))
    {
        return "offline";
    }
    "failed"
}

/// Program and args that open `path` with the default app.
pub fn open_command(path: &Path) -> (&'static str, Vec<OsString>) {
    #[cfg(target_os = "macos")]
    return ("open", vec![path.as_os_str().to_owned()]);
    #[cfg(target_os = "windows")]
    return ("explorer", vec![path.as_os_str().to_owned()]);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return ("xdg-open", vec![path.as_os_str().to_owned()]);
}

/// Original file name for the toast: the placeholder name minus `.hqcloud`.
fn display_name(placeholder: &Path) -> String {
    placeholder
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Only the desktop window shows the toast; a broadcast would wake every
/// webview. Held until the UI is listening (cold start).
fn emit(app: &AppHandle, placeholder: &Path, phase: &'static str, error: Option<&'static str>) {
    let ev = CloudFileEvent {
        name: display_name(placeholder),
        path: placeholder.to_string_lossy().into_owned(),
        phase,
        error,
    };
    let window_open = app
        .get_webview_window(crate::commands::desktop_alt::WINDOW_LABEL)
        .is_some();
    {
        let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        if !window_open {
            pending.ui_ready = false;
        }
        if !pending.ui_ready {
            queue_event(&mut pending.events, ev);
            return;
        }
    }
    let _ = app.emit_to(
        crate::commands::desktop_alt::WINDOW_LABEL,
        CLOUD_FILE_EVENT,
        ev,
    );
}

/// Download the original behind `placeholder` and return its restored path.
pub async fn fetch(placeholder: &Path) -> Result<PathBuf, &'static str> {
    // Read before fetching: the CLI deletes the placeholder once restored.
    let pointer = read_pointer_path(placeholder);
    let stdout = match run_hq(fetch_args(placeholder, true).map_err(|_| "failed")?).await {
        Ok(out) => out,
        Err(e) if rejects_json_flag(&e) => {
            run_hq(fetch_args(placeholder, false).map_err(|_| "failed")?)
                .await
                .map_err(|e| classify_fetch_error(&e))?
        }
        Err(e) => return Err(classify_fetch_error(&e)),
    };
    let reported = fetch_json_path(&stdout);
    let restored = restored_path(
        &resolve_hq_folder(),
        reported.as_deref(),
        pointer.as_deref(),
    )
    .ok_or_else(|| {
        log("cloud-file", "fetch finished but reported no path");
        "failed"
    })?;
    if !restored.exists() {
        log("cloud-file", "fetch finished but the original is missing");
        return Err("failed");
    }
    Ok(restored)
}

/// Fetch, then open with the default app, reporting each step to the UI.
pub async fn fetch_and_open(app: AppHandle, placeholder: PathBuf) -> Result<PathBuf, &'static str> {
    let name = display_name(&placeholder);
    log("cloud-file", &format!("opening cloud file {name}"));
    emit(&app, &placeholder, "fetching", None);
    let restored = match fetch(&placeholder).await {
        Ok(p) => p,
        Err(code) => {
            log("cloud-file", &format!("fetch {name} failed: {code}"));
            // Bring HQ forward so the person sees why nothing opened.
            crate::tray::activate_primary_surface(&app);
            emit(&app, &placeholder, "error", Some(code));
            return Err(code);
        }
    };
    let (program, args) = open_command(&restored);
    if let Err(e) = std::process::Command::new(program).args(&args).spawn() {
        log("cloud-file", &format!("open {name} failed: {e}"));
        crate::tray::activate_primary_surface(&app);
        emit(&app, &placeholder, "error", Some("open-failed"));
        return Err("open-failed");
    }
    emit(&app, &placeholder, "opened", None);
    Ok(restored)
}

pub fn spawn_fetch_and_open(app: &AppHandle, placeholder: PathBuf) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = fetch_and_open(app, placeholder).await;
    });
}

/// UI entry point: open a placeholder the person picked inside HQ.
#[tauri::command]
pub async fn open_cloud_file(app: AppHandle, path: String) -> Result<String, String> {
    fetch_and_open(app, PathBuf::from(path))
        .await
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(str::to_string)
}

/// The desktop UI is listening: hand over anything that happened before
/// (e.g. a cold start from a Finder double-click) and send live from now on.
#[tauri::command]
pub fn cloud_file_ui_ready() -> Vec<CloudFileEvent> {
    let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    pending.ui_ready = true;
    std::mem::take(&mut pending.events)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    const PH: &str = "/Users/me/HQ/companies/acme/media/promo.mp4.hqcloud";
    #[cfg(windows)]
    const PH: &str = r"C:\Users\me\HQ\companies\acme\media\promo.mp4.hqcloud";
    #[cfg(unix)]
    const ROOT: &str = "/Users/me/HQ";
    #[cfg(windows)]
    const ROOT: &str = r"C:\Users\me\HQ";

    // Placeholder text as written by hq-cli `renderPointer` (storage-offload.ts).
    const POINTER: &str = "HQ-CLOUD-FILE v1
path: companies/acme/media/promo.mp4
size: 524288000
sha256: 2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae
git-blob: 3b18e512dba79e4c8300dd08aeb37f8e728b8dad
vault: personal
key: .hq-offload/blobs/3b18e512dba79e4c8300dd08aeb37f8e728b8dad
offloaded-at: 2026-10-09T18:00:00Z
retrieve: hq storage fetch \"companies/acme/media/promo.mp4\"
This file is stored in HQ cloud storage. Open it in HQ, or run the command above to download it.
";

    #[test]
    fn detects_placeholders_case_insensitively() {
        assert!(is_placeholder(Path::new("a/promo.mp4.hqcloud")));
        assert!(is_placeholder(Path::new("a/promo.mp4.HQCLOUD")));
        assert!(!is_placeholder(Path::new("a/promo.mp4")));
        assert!(!is_placeholder(Path::new("a/hqcloud")));
    }

    #[test]
    fn reads_the_restore_path_from_the_placeholder() {
        assert_eq!(
            pointer_path(POINTER).as_deref(),
            Some("companies/acme/media/promo.mp4")
        );
        assert!(pointer_path("just some text\npath: x").is_none());
        assert!(pointer_path("HQ-CLOUD-FILE v1\nsize: 1\n").is_none());
    }

    #[test]
    fn reads_the_path_fetch_json_reports() {
        // `hq storage fetch --json` prints FetchResult { path, bytes, sha256 }.
        let out =
            r#"{"path": "companies/acme/media/renamed.mp4", "bytes": 524288000, "sha256": "ab"}"#;
        assert_eq!(
            fetch_json_path(out).as_deref(),
            Some("companies/acme/media/renamed.mp4")
        );
        assert!(
            fetch_json_path("Restored companies/acme/x.mp4 (500 MB), checksum verified.").is_none()
        );
    }

    #[test]
    fn restored_path_prefers_the_cli_report_over_the_pointer() {
        let root = Path::new(ROOT);
        let from_cli = restored_path(
            root,
            Some("companies/acme/media/renamed.mp4"),
            Some("companies/acme/media/promo.mp4"),
        )
        .unwrap();
        assert_eq!(from_cli, root.join("companies/acme/media/renamed.mp4"));
        let from_pointer =
            restored_path(root, None, Some("companies/acme/media/promo.mp4")).unwrap();
        assert_eq!(from_pointer, root.join("companies/acme/media/promo.mp4"));
        assert_eq!(
            restored_path(root, Some(PH), None).unwrap(),
            PathBuf::from(PH)
        );
        assert!(restored_path(root, None, None).is_none());
    }

    #[test]
    fn fetch_args_shape_and_guard() {
        let render = |json| -> Vec<String> {
            fetch_args(Path::new(PH), json)
                .unwrap()
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect()
        };
        assert_eq!(render(true), ["storage", "fetch", PH, "--json"]);
        assert_eq!(render(false), ["storage", "fetch", PH]);
        assert!(fetch_args(Path::new("-rf.hqcloud"), true).is_err());
        assert!(fetch_args(Path::new("relative/x.hqcloud"), true).is_err());
        assert!(fetch_args(Path::new("/abs/x.mp4"), true).is_err());
    }

    #[test]
    fn detects_a_cli_without_fetch_json() {
        assert!(rejects_json_flag(
            "hq storage failed: error: unknown option '--json'"
        ));
        assert!(!rejects_json_flag("hq storage failed: checksum mismatch"));
    }

    #[test]
    fn argv_keeps_only_absolute_placeholders() {
        let argv = [
            "/Applications/HQ.app/Contents/MacOS/hq",
            "--flag",
            PH,
            "x.hqcloud",
            "/a/b.mp4",
        ];
        assert_eq!(placeholders_from_argv(&argv), vec![PathBuf::from(PH)]);
        assert!(
            placeholders_from_argv(&[PH]).is_empty(),
            "argv[0] is the binary"
        );
    }

    #[cfg(unix)]
    #[test]
    fn file_urls_map_to_placeholders() {
        let url = url::Url::parse("file:///Users/me/HQ/My%20Movies/promo.mp4.hqcloud").unwrap();
        assert_eq!(
            placeholder_from_url(&url),
            Some(PathBuf::from("/Users/me/HQ/My Movies/promo.mp4.hqcloud"))
        );
        let other = url::Url::parse("file:///Users/me/notes.md").unwrap();
        assert!(placeholder_from_url(&other).is_none());
        let web = url::Url::parse("https://example.com/x.hqcloud").unwrap();
        assert!(placeholder_from_url(&web).is_none());
    }

    #[test]
    fn classifies_fetch_errors() {
        assert_eq!(classify_fetch_error(UPDATE_HQ_ERROR), UPDATE_HQ_ERROR);
        assert_eq!(
            classify_fetch_error("hq storage failed: AccessDenied: Access Denied"),
            "no-access"
        );
        assert_eq!(
            classify_fetch_error("hq storage failed: getaddrinfo ENOTFOUND s3.amazonaws.com"),
            "offline"
        );
        assert_eq!(
            classify_fetch_error("hq storage failed: request timed out"),
            "offline"
        );
        assert_eq!(
            classify_fetch_error("hq storage failed: checksum mismatch"),
            "failed"
        );
    }

    #[test]
    fn open_command_passes_the_path_as_one_argument() {
        let (_, args) = open_command(Path::new(PH));
        assert_eq!(args, vec![OsString::from(PH)]);
    }

    fn ev(path: &str, phase: &'static str) -> CloudFileEvent {
        CloudFileEvent {
            name: "promo.mp4".into(),
            path: path.into(),
            phase,
            error: None,
        }
    }

    #[test]
    fn pending_queue_keeps_the_latest_step_per_file() {
        let mut q = Vec::new();
        queue_event(&mut q, ev("/a/promo.mp4.hqcloud", "fetching"));
        queue_event(&mut q, ev("/b/promo.mp4.hqcloud", "fetching"));
        queue_event(&mut q, ev("/a/promo.mp4.hqcloud", "opened"));
        assert_eq!(q.len(), 2, "same name, different folders stay apart");
        assert_eq!(q[1], ev("/a/promo.mp4.hqcloud", "opened"));
        for i in 0..(PENDING_MAX + 5) {
            queue_event(&mut q, ev(&format!("/c/{i}.hqcloud"), "fetching"));
        }
        assert_eq!(q.len(), PENDING_MAX);
        assert_eq!(
            q.last().unwrap().path,
            format!("/c/{}.hqcloud", PENDING_MAX + 4)
        );
    }

    #[test]
    fn ui_ready_drains_held_events() {
        {
            let mut p = PENDING.lock().unwrap();
            p.ui_ready = false;
            queue_event(&mut p.events, ev("/a/promo.mp4.hqcloud", "error"));
        }
        let drained = cloud_file_ui_ready();
        assert!(drained.iter().any(|e| e.path == "/a/promo.mp4.hqcloud"));
        assert!(cloud_file_ui_ready().is_empty());
    }

    #[test]
    fn event_serializes_camel_case() {
        let v = serde_json::to_value(CloudFileEvent {
            name: "promo.mp4".into(),
            path: PH.into(),
            phase: "error",
            error: Some("offline"),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"name":"promo.mp4","path":PH,"phase":"error","error":"offline"})
        );
    }
}
