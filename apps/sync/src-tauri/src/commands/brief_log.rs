//! The Daily Brief's event log: one JSON line per thing the person did with a
//! brief (shown, dismiss, launch, pin, hide), appended to
//! `personal/brief/brief-log.jsonl` in the HQ folder. The writer skill reads it
//! in its weekly fold to move `brief-prefs.yaml`; nothing else reads it.
//!
//! The command appends to exactly that one file. The renderer never names a
//! path; it hands over one line, which must be a single-line JSON object with
//! a string `event`, under a size cap. The file is created on first use, is
//! never rewritten, and is refused when something put a symlink in its place.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

/// HQ-relative path of the log. The only file this module writes.
pub const BRIEF_LOG_PATH: &str = "personal/brief/brief-log.jsonl";
/// One event is a few hundred bytes; this leaves room for a long prompt label.
pub const MAX_LINE_BYTES: usize = 4096;

/// Accept one event line: trimmed, single line, within the cap, and a JSON
/// object carrying a non-empty string `event`. Returns the line to write.
pub fn validate_brief_log_line(line: &str) -> Result<String, String> {
    let line = line.trim();
    if line.is_empty() {
        return Err("brief log line is empty".to_string());
    }
    if line.len() > MAX_LINE_BYTES {
        return Err(format!("brief log line is over {MAX_LINE_BYTES} bytes"));
    }
    if line.contains('\n') || line.contains('\r') {
        return Err("brief log line must be a single line".to_string());
    }
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("brief log line is not JSON: {e}"))?;
    let event = value
        .as_object()
        .and_then(|o| o.get("event"))
        .and_then(|e| e.as_str())
        .map(str::trim)
        .filter(|e| !e.is_empty());
    if event.is_none() {
        return Err("brief log line must be a JSON object with a string `event`".to_string());
    }
    Ok(line.to_string())
}

/// Append one validated line (plus a newline) to the log under `hq_root`,
/// creating `personal/brief/` when it is missing.
pub fn append_brief_log_line_to(hq_root: &Path, line: &str) -> Result<PathBuf, String> {
    let line = validate_brief_log_line(line)?;
    let path = hq_root.join(BRIEF_LOG_PATH);
    let dir = path
        .parent()
        .ok_or_else(|| "brief log path has no parent".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() {
            return Err("brief log is a symlink; refusing to write through it".to_string());
        }
        if !meta.is_file() {
            return Err("brief log path is not a regular file".to_string());
        }
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("could not open brief log: {e}"))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| format!("could not append to brief log: {e}"))?;
    Ok(path)
}

/// Append one event line to `personal/brief/brief-log.jsonl` in the HQ folder.
#[tauri::command]
pub async fn append_brief_log_line(line: String) -> Result<(), String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("brief log requires a signed-in user".to_string());
    }
    let hq_root = hq_desktop_core::library_local::resolve_hq_folder();
    tauri::async_runtime::spawn_blocking(move || {
        append_brief_log_line_to(&hq_root, &line).map(|_| ())
    })
    .await
    .map_err(|e| format!("brief log task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hq-brief-log-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn accepts_a_single_line_json_object_with_an_event() {
        let ok = validate_brief_log_line("  {\"event\":\"launch\",\"kind\":\"needs\"}  \n").unwrap();
        assert_eq!(ok, "{\"event\":\"launch\",\"kind\":\"needs\"}");
    }

    #[test]
    fn rejects_empty_multiline_non_json_and_eventless_lines() {
        assert!(validate_brief_log_line("").is_err());
        assert!(validate_brief_log_line("{\"event\":\"a\"}\n{\"event\":\"b\"}").is_err());
        assert!(validate_brief_log_line("event=launch").is_err());
        assert!(validate_brief_log_line("[\"event\"]").is_err());
        assert!(validate_brief_log_line("{\"kind\":\"needs\"}").is_err());
        assert!(validate_brief_log_line("{\"event\":\"\"}").is_err());
        let long = format!("{{\"event\":\"x\",\"pad\":\"{}\"}}", "a".repeat(MAX_LINE_BYTES));
        assert!(validate_brief_log_line(&long).is_err());
    }

    #[test]
    fn appends_lines_in_order_and_creates_the_folder() {
        let root = temp_root("append");
        let path =
            append_brief_log_line_to(&root, "{\"event\":\"shown\",\"run_id\":\"r1\"}").unwrap();
        append_brief_log_line_to(&root, "{\"event\":\"launch\",\"item_id\":\"d1\"}").unwrap();
        assert_eq!(path, root.join(BRIEF_LOG_PATH));
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            "{\"event\":\"shown\",\"run_id\":\"r1\"}\n{\"event\":\"launch\",\"item_id\":\"d1\"}\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bad_line_leaves_the_file_untouched() {
        let root = temp_root("bad");
        append_brief_log_line_to(&root, "{\"event\":\"shown\"}").unwrap();
        assert!(append_brief_log_line_to(&root, "not json").is_err());
        let text = std::fs::read_to_string(root.join(BRIEF_LOG_PATH)).unwrap();
        assert_eq!(text, "{\"event\":\"shown\"}\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_write_through_a_symlink() {
        let root = temp_root("symlink");
        let elsewhere = root.join("elsewhere.jsonl");
        std::fs::write(&elsewhere, "").unwrap();
        let path = root.join(BRIEF_LOG_PATH);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &path).unwrap();
        let err = append_brief_log_line_to(&root, "{\"event\":\"shown\"}").unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        assert_eq!(std::fs::read_to_string(&elsewhere).unwrap(), "");
        let _ = std::fs::remove_dir_all(&root);
    }
}
