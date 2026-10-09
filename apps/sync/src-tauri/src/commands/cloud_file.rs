//! Opening `.hqcloud` placeholders (big files moved to HQ cloud storage).
//!
//! `hq storage offload` replaces a big idle file `x.mp4` with a small text
//! placeholder `x.mp4.hqcloud`. The bundle registers the `hqcloud` extension
//! so double-clicking one in Finder or Explorer opens HQ. HQ then runs
//! `hq storage fetch <placeholder>`, which downloads and verifies the original
//! and puts it back at `x.mp4`, and opens it with the default app.
//!
//! How the path arrives:
//! - macOS: `RunEvent::Opened { urls }` with `file://` URLs, cold or warm.
//! - Windows/Linux: the path is in argv. Cold start reads `std::env::args`,
//!   a second launch reaches the single-instance callback.
//!
//! Progress and errors go to the desktop window as `CLOUD_FILE_EVENT` so it
//! can show a toast; on an error HQ comes forward so the toast is seen. Errors carry a short code (`offline`, `no-access`, `update-hq`,
//! `failed`), never raw CLI output. Only file names are logged.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::commands::storage::{run_hq, UPDATE_HQ_ERROR};
use crate::util::logfile::log;

pub const PLACEHOLDER_EXT: &str = "hqcloud";
pub const CLOUD_FILE_EVENT: &str = "cloud-file://fetch";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudFileEvent {
    /// File name of the original (e.g. `promo.mp4`), for the toast.
    pub name: String,
    /// `fetching` | `opened` | `error`.
    pub phase: &'static str,
    /// Error code when `phase == "error"`.
    pub error: Option<&'static str>,
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

/// Where `hq storage fetch` puts the original: the placeholder minus `.hqcloud`.
pub fn restored_path(placeholder: &Path) -> Option<PathBuf> {
    is_placeholder(placeholder).then(|| placeholder.with_extension(""))
}

/// `hq storage fetch <placeholder>`. Only absolute `.hqcloud` paths, so a
/// crafted argument can never be read as a flag.
pub fn fetch_args(placeholder: &Path) -> Result<Vec<OsString>, String> {
    if !placeholder.is_absolute() || !is_placeholder(placeholder) {
        return Err("not-a-placeholder".to_string());
    }
    Ok(vec![
        "storage".into(),
        "fetch".into(),
        placeholder.as_os_str().to_owned(),
    ])
}

/// Map a failed fetch to a short code the UI turns into plain copy.
pub fn classify_fetch_error(message: &str) -> &'static str {
    if message.contains(UPDATE_HQ_ERROR) {
        return UPDATE_HQ_ERROR;
    }
    let m = message.to_ascii_lowercase();
    if ["access denied", "forbidden", "not authorized", "unauthorized", "403"]
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
    return (
        "explorer",
        vec![path.as_os_str().to_owned()],
    );
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return ("xdg-open", vec![path.as_os_str().to_owned()]);
}

fn display_name(placeholder: &Path) -> String {
    restored_path(placeholder)
        .as_deref()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Only the desktop window shows the toast; a broadcast would wake every webview.
fn emit(app: &AppHandle, name: &str, phase: &'static str, error: Option<&'static str>) {
    let _ = app.emit_to(
        crate::commands::desktop_alt::WINDOW_LABEL,
        CLOUD_FILE_EVENT,
        CloudFileEvent {
            name: name.to_string(),
            phase,
            error,
        },
    );
}

/// Download the original behind `placeholder` and return its restored path.
pub async fn fetch(placeholder: &Path) -> Result<PathBuf, &'static str> {
    let args = fetch_args(placeholder).map_err(|_| "failed")?;
    let restored = restored_path(placeholder).ok_or("failed")?;
    run_hq(args).await.map_err(|e| classify_fetch_error(&e))?;
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
    emit(&app, &name, "fetching", None);
    let restored = match fetch(&placeholder).await {
        Ok(p) => p,
        Err(code) => {
            log("cloud-file", &format!("fetch {name} failed: {code}"));
            // Bring HQ forward so the person sees why nothing opened.
            crate::tray::activate_primary_surface(&app);
            emit(&app, &name, "error", Some(code));
            return Err(code);
        }
    };
    let (program, args) = open_command(&restored);
    if let Err(e) = std::process::Command::new(program).args(&args).spawn() {
        log("cloud-file", &format!("open {name} failed: {e}"));
        crate::tray::activate_primary_surface(&app);
        emit(&app, &name, "error", Some("open-failed"));
        return Err("open-failed");
    }
    emit(&app, &name, "opened", None);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    const PH: &str = "/Users/me/HQ/companies/acme/media/promo.mp4.hqcloud";
    #[cfg(windows)]
    const PH: &str = r"C:\Users\me\HQ\companies\acme\media\promo.mp4.hqcloud";

    #[test]
    fn detects_placeholders_case_insensitively() {
        assert!(is_placeholder(Path::new("a/promo.mp4.hqcloud")));
        assert!(is_placeholder(Path::new("a/promo.mp4.HQCLOUD")));
        assert!(!is_placeholder(Path::new("a/promo.mp4")));
        assert!(!is_placeholder(Path::new("a/hqcloud")));
    }

    #[test]
    fn restored_path_drops_only_the_placeholder_extension() {
        let r = restored_path(Path::new(PH)).unwrap();
        assert_eq!(r.file_name().unwrap(), "promo.mp4");
        assert_eq!(r.parent(), Path::new(PH).parent());
        assert!(restored_path(Path::new("promo.mp4")).is_none());
    }

    #[test]
    fn fetch_args_shape_and_guard() {
        let args: Vec<String> = fetch_args(Path::new(PH))
            .unwrap()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, ["storage", "fetch", PH]);
        assert!(fetch_args(Path::new("-rf.hqcloud")).is_err());
        assert!(fetch_args(Path::new("relative/x.hqcloud")).is_err());
        assert!(fetch_args(Path::new("/abs/x.mp4")).is_err());
    }

    #[test]
    fn argv_keeps_only_absolute_placeholders() {
        let argv = ["/Applications/HQ.app/Contents/MacOS/hq", "--flag", PH, "x.hqcloud", "/a/b.mp4"];
        assert_eq!(placeholders_from_argv(&argv), vec![PathBuf::from(PH)]);
        assert!(placeholders_from_argv(&[PH]).is_empty(), "argv[0] is the binary");
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
        assert_eq!(classify_fetch_error("hq storage failed: AccessDenied: Access Denied"), "no-access");
        assert_eq!(classify_fetch_error("hq storage failed: getaddrinfo ENOTFOUND s3.amazonaws.com"), "offline");
        assert_eq!(classify_fetch_error("hq storage failed: request timed out"), "offline");
        assert_eq!(classify_fetch_error("hq storage failed: checksum mismatch"), "failed");
    }

    #[test]
    fn open_command_passes_the_path_as_one_argument() {
        let (_, args) = open_command(Path::new(PH));
        assert_eq!(args, vec![OsString::from(PH)]);
    }

    #[test]
    fn event_serializes_camel_case() {
        let v = serde_json::to_value(CloudFileEvent {
            name: "promo.mp4".into(),
            phase: "error",
            error: Some("offline"),
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({"name":"promo.mp4","phase":"error","error":"offline"}));
    }
}
