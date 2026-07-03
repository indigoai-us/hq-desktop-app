//! User-facing "Report a problem" pathway.
//!
//! Blocked surfaces funnel into the canonical HQ feedback command rather than
//! inventing a parallel reporting channel. The body is written to a temp file
//! and submitted via `--body-file` so multi-line diagnostic context never has
//! to survive shell quoting.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::process::Command;

use crate::commands::config::{read_hq_config_lenient, MenubarPrefs};
use crate::util::logfile::log;
use crate::util::paths;

static FEEDBACK_SEQ: AtomicU64 = AtomicU64::new(0);

fn resolve_hq_folder() -> PathBuf {
    let menubar_prefs: Option<MenubarPrefs> = paths::menubar_json_path()
        .ok()
        .filter(|p| p.exists())
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .and_then(|s| serde_json::from_str(&s).ok());
    let config = read_hq_config_lenient().ok().flatten();
    paths::resolve_hq_folder(
        config.as_ref().and_then(|c| c.hq_folder_path.as_deref()),
        menubar_prefs.as_ref().and_then(|p| p.hq_path.as_deref()),
    )
}

fn feedback_body_path(seq: u64) -> PathBuf {
    let mut body_path = std::env::temp_dir();
    body_path.push(format!(
        "hq-sync-feedback-{}-{}.md",
        std::process::id(),
        seq
    ));
    body_path
}

fn bug_report_args(title: &str, body_path: &Path) -> Vec<OsString> {
    vec![
        OsString::from("feedback"),
        OsString::from("bug"),
        OsString::from("--title"),
        OsString::from(title),
        OsString::from("--body-file"),
        body_path.as_os_str().to_os_string(),
    ]
}

/// Submit a bug report via `hq feedback bug --title <title> --body-file <file>`.
#[tauri::command]
pub async fn submit_bug_report(title: String, body: String) -> Result<(), String> {
    let hq = paths::resolve_bin("hq");
    let folder = resolve_hq_folder();

    let seq = FEEDBACK_SEQ.fetch_add(1, Ordering::Relaxed);
    let body_path = feedback_body_path(seq);
    std::fs::write(&body_path, &body).map_err(|e| format!("write feedback body: {e}"))?;

    log("feedback", &format!("submitting bug report: {title}"));

    let args = bug_report_args(&title, &body_path);
    let mut cmd = Command::new(&hq);
    paths::no_window_tokio(&mut cmd);
    let result = cmd
        .args(&args)
        .env("PATH", paths::child_path())
        .current_dir(&folder)
        .env("HQ_NO_UPDATE_CHECK", "1")
        .env("HQ_ROOT", &folder)
        .output()
        .await;

    let _ = std::fs::remove_file(&body_path);

    let output = result.map_err(|e| format!("spawn `hq feedback`: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = format!(
            "`hq feedback` exited {}: {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        );
        log("feedback", &format!("bug report failed: {msg}"));
        return Err(msg);
    }
    log("feedback", "bug report submitted");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bug_report_args_shape_uses_title_and_body_file() {
        let body_path = std::env::temp_dir().join("hq-sync-feedback-test.md");
        let args = bug_report_args("Meetings stuck", &body_path);
        let rendered: Vec<String> = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert_eq!(rendered[0], "feedback");
        assert_eq!(rendered[1], "bug");
        assert_eq!(rendered[2], "--title");
        assert_eq!(rendered[3], "Meetings stuck");
        assert_eq!(rendered[4], "--body-file");
        assert_eq!(rendered[5], body_path.to_string_lossy().as_ref());
        assert_eq!(rendered.len(), 6);
    }

    #[test]
    fn feedback_body_path_is_unique_per_sequence() {
        let first = feedback_body_path(1);
        let second = feedback_body_path(2);

        assert_ne!(first, second);
        assert!(first
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("hq-sync-feedback-")));
    }
}
