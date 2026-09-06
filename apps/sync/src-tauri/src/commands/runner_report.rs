//! Shared reader for the runner's Node fatal diagnostic report (HQ-DESKTOP-5W /
//! HQ-DESKTOP-5X, Leg 3).
//!
//! ONE reader for BOTH exit seams — the watcher's deferred fault-read worker and
//! the manual route's exit — so they cannot drift. It reads the per-generation
//! report file, hands the text to the pure content-safe parser in
//! `hq_desktop_core::runner_diagnostic_report`, DELETES the file (and the
//! generation directory) so a repeatedly faulting machine cannot accumulate disk,
//! and returns a fixed-vocabulary `runner_report_read` token plus an optional
//! attribution. The pure `runner_fatal_axes` (in hq-desktop-core) then decides the
//! final five axes both seams emit.
//!
//! The report directory lives under the SYSTEM TEMP DIR — app-owned and OUTSIDE
//! the synced HQ tree, so a crash report (which is dense with cwd/argv/env) can
//! never be uploaded to a vault.

use std::path::{Path, PathBuf};

use hq_desktop_core::daemon::{RunnerReportRequest, RUNNER_DIAGNOSTIC_REPORT_FILENAME};
use hq_desktop_core::runner_diagnostic_report::{
    parse_runner_diagnostic_report, RunnerReportAttribution, RunnerReportParse, MAX_REPORT_BYTES,
};

/// Subdirectory under the system temp dir that holds per-generation runner report
/// directories.
const RUNNER_REPORT_ROOT: &str = "hq-sync-runner-reports";

/// Keep at most this many stale per-generation report directories; older ones are
/// pruned at spawn so a machine that faults-and-shuts-down (never reaching the
/// reader) cannot accumulate directories without bound.
const RUNNER_REPORT_MAX_DIRS: usize = 16;

/// Result of reading a generation's Node diagnostic report.
#[derive(Debug, Clone)]
pub struct RunnerReportRead {
    /// The `runner_report_read` token (fixed vocabulary).
    pub read_token: &'static str,
    /// The attribution, present ONLY when a report was read and named a class.
    pub attribution: Option<RunnerReportAttribution>,
}

impl RunnerReportRead {
    fn token_only(read_token: &'static str) -> Self {
        Self {
            read_token,
            attribution: None,
        }
    }
}

/// The app-owned per-generation report directory: creates it (and prunes old
/// sibling dirs) and returns the path. `None` if the directory could not be
/// created, in which case the caller passes `None` to the spawn composer and the
/// report is `NotRequested`.
pub fn runner_report_dir_for(generation: u64) -> Option<PathBuf> {
    let root = std::env::temp_dir().join(RUNNER_REPORT_ROOT);
    // Best-effort prune BEFORE creating this generation's dir.
    prune_report_root(&root, RUNNER_REPORT_MAX_DIRS);
    let dir = root.join(format!("gen-{}-{}", std::process::id(), generation));
    std::fs::create_dir_all(&dir).ok().map(|()| dir)
}

/// Read + parse + DELETE a generation's Node diagnostic report. Bounded (file-size
/// cap) and content-safe (delegates to the pure parser). Always removes the
/// generation's report directory afterward, whatever the outcome. `request`
/// carries whether spawn asked for a report at all, so a user override or a
/// non-request renders its own token rather than a misleading `report_absent`.
pub fn read_runner_diagnostic_report(
    report_dir: Option<&Path>,
    request: RunnerReportRequest,
) -> RunnerReportRead {
    // Nothing was requested (or the user's own --report-* suppressed ours): no file.
    if request != RunnerReportRequest::Requested {
        return RunnerReportRead::token_only(request.seed_report_read_token());
    }
    let Some(dir) = report_dir else {
        return RunnerReportRead::token_only("report_absent");
    };
    let result = read_report_file(dir);
    // Always clean up the generation directory, regardless of the read outcome.
    let _ = std::fs::remove_dir_all(dir);
    result
}

fn read_report_file(dir: &Path) -> RunnerReportRead {
    let file = dir.join(RUNNER_DIAGNOSTIC_REPORT_FILENAME);
    let Ok(metadata) = std::fs::metadata(&file) else {
        return RunnerReportRead::token_only("report_absent");
    };
    if metadata.len() > MAX_REPORT_BYTES as u64 {
        return RunnerReportRead::token_only("report_unreadable");
    }
    let Ok(text) = std::fs::read_to_string(&file) else {
        return RunnerReportRead::token_only("report_unreadable");
    };
    match parse_runner_diagnostic_report(&text) {
        RunnerReportParse::Named(attribution) => RunnerReportRead {
            read_token: "report_read",
            attribution: Some(attribution),
        },
        RunnerReportParse::Unnamed => RunnerReportRead::token_only("report_read"),
        RunnerReportParse::Unparseable => RunnerReportRead::token_only("report_unreadable"),
    }
}

/// Best-effort prune: keep at most `keep` per-generation dirs under `root`,
/// removing the oldest by modified time. Silent on any error — housekeeping,
/// never load-bearing.
fn prune_report_root(root: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|entry| {
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (modified, entry.path())
        })
        .collect();
    if dirs.len() <= keep {
        return;
    }
    dirs.sort_by_key(|(modified, _)| *modified);
    let remove_count = dirs.len() - keep;
    for (_, path) in dirs.into_iter().take(remove_count) {
        let _ = std::fs::remove_dir_all(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hq-runner-report-test-{}-{}-{:?}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_report(dir: &Path, body: &str) {
        std::fs::write(dir.join(RUNNER_DIAGNOSTIC_REPORT_FILENAME), body).unwrap();
    }

    #[test]
    fn request_not_requested_and_disabled_render_their_own_tokens() {
        assert_eq!(
            read_runner_diagnostic_report(None, RunnerReportRequest::NotRequested).read_token,
            "report_not_requested"
        );
        assert_eq!(
            read_runner_diagnostic_report(None, RunnerReportRequest::DisabledByUserOptions)
                .read_token,
            "report_disabled_by_user_options"
        );
    }

    #[test]
    fn requested_but_absent_file_reports_absent() {
        let dir = unique_dir("absent");
        let read = read_runner_diagnostic_report(Some(&dir), RunnerReportRequest::Requested);
        assert_eq!(read.read_token, "report_absent");
        assert!(read.attribution.is_none());
        // The generation dir is removed even when the file was absent.
        assert!(!dir.exists());
    }

    #[test]
    fn requested_named_report_is_read_and_deleted() {
        let dir = unique_dir("named");
        write_report(
            &dir,
            &serde_json::json!({
                "header": { "event": "Allocation failed - JavaScript heap out of memory", "trigger": "FatalError" },
                "javascriptStack": { "message": "FATAL ERROR: JavaScript heap out of memory" },
                "nativeStack": [{ "symbol": "v8::internal::V8::FatalProcessOutOfMemory() [/node]" }]
            })
            .to_string(),
        );
        let read = read_runner_diagnostic_report(Some(&dir), RunnerReportRequest::Requested);
        assert_eq!(read.read_token, "report_read");
        assert_eq!(
            read.attribution.as_ref().map(|a| a.fatal_class.as_str()),
            Some("heap_oom")
        );
        // File + directory are removed after the read (no disk accumulation).
        assert!(!dir.exists());
    }

    #[test]
    fn requested_unparseable_report_is_unreadable() {
        let dir = unique_dir("garbage");
        write_report(&dir, "this is not a node report");
        let read = read_runner_diagnostic_report(Some(&dir), RunnerReportRequest::Requested);
        assert_eq!(read.read_token, "report_unreadable");
        assert!(read.attribution.is_none());
        assert!(!dir.exists());
    }

    #[test]
    fn oversized_report_is_unreadable_not_read() {
        let dir = unique_dir("oversized");
        let huge = format!("{}{}", "{".repeat(1), "a".repeat(MAX_REPORT_BYTES + 1));
        write_report(&dir, &huge);
        let read = read_runner_diagnostic_report(Some(&dir), RunnerReportRequest::Requested);
        assert_eq!(read.read_token, "report_unreadable");
        assert!(!dir.exists());
    }

    #[test]
    fn report_dir_for_generation_is_outside_the_hq_tree_and_unique() {
        let dir = runner_report_dir_for(42).expect("temp dir must be creatable");
        assert!(dir.starts_with(std::env::temp_dir()));
        assert!(dir.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
