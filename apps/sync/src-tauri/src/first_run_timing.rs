//! First-run timing lines in the hq-sync log (`~/.hq/logs/hq-sync.log`).
//!
//! Every line uses the `first-run` tag and space-separated `key=value` pairs,
//! after the usual logfile timestamp prefix:
//!
//! ```text
//! [first-run] kind=screen event=enter surface=<welcome|takeover> id=<step id>
//! [first-run] kind=screen event=leave surface=<welcome|takeover> id=<step id> elapsed_ms=<n>
//! [first-run] kind=install event=start id=<item>
//! [first-run] kind=install event=end id=<item> outcome=<ok|failed|skipped|cancelled> elapsed_ms=<n>
//! [first-run] kind=probe tool=<claude|codex|...> result=<passed|signed-out|failed|timeout> elapsed_ms=<n>
//! ```
//!
//! Install ids: node, git, hq-cli, qmd, claude-code, codex, gh, yq, jq (logged
//! here, from Rust), and content, initial-sync, indexing (logged from the
//! renderer through `frontend_log`). Screen and probe lines also come from the
//! renderer; `packages/ui/src/chat/first-run/first-run-timing.ts` formats them
//! with the same rules. Values never contain whitespace or `=`: both are
//! replaced with `_`, and an empty value becomes `unknown`, so a reader can
//! split a line on spaces and then on the first `=`.
//! `companies/indigo/projects/install-flow-rethink/scripts/first-run-timeline.sh`
//! in HQ parses these lines into a per-step table. Change the format there and
//! in the TS helper together.

use std::future::Future;
use std::time::Instant;

pub const TAG: &str = "first-run";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallOutcome {
    Ok,
    Failed,
    Skipped,
    Cancelled,
}

impl InstallOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            InstallOutcome::Ok => "ok",
            InstallOutcome::Failed => "failed",
            InstallOutcome::Skipped => "skipped",
            InstallOutcome::Cancelled => "cancelled",
        }
    }
}

/// Make a value safe for the space-separated `key=value` format.
pub fn sanitize_value(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| if c.is_whitespace() || c == '=' { '_' } else { c })
        .collect();
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

pub fn format_install_start(id: &str) -> String {
    format!("kind=install event=start id={}", sanitize_value(id))
}

pub fn format_install_end(id: &str, outcome: InstallOutcome, elapsed_ms: u128) -> String {
    format!(
        "kind=install event=end id={} outcome={} elapsed_ms={}",
        sanitize_value(id),
        outcome.as_str(),
        elapsed_ms
    )
}

/// Logs the start line on creation and the end line on `finish`. A timer
/// dropped without `finish` (its install future was dropped mid-flight)
/// logs `outcome=cancelled`, so every start line gets an end line.
pub struct InstallTimer {
    id: String,
    started: Instant,
    finished: bool,
}

impl InstallTimer {
    pub fn start(id: &str) -> Self {
        crate::util::logfile::log(TAG, &format_install_start(id));
        Self {
            id: id.to_string(),
            started: Instant::now(),
            finished: false,
        }
    }

    pub fn finish(mut self, outcome: InstallOutcome) {
        self.log_end(outcome);
    }

    fn log_end(&mut self, outcome: InstallOutcome) {
        self.finished = true;
        crate::util::logfile::log(
            TAG,
            &format_install_end(&self.id, outcome, self.started.elapsed().as_millis()),
        );
    }
}

impl Drop for InstallTimer {
    fn drop(&mut self) {
        if !self.finished {
            self.log_end(InstallOutcome::Cancelled);
        }
    }
}

/// Time one install. Logs start, awaits `install`, logs end with `ok` or
/// `failed`, and returns the install result unchanged.
pub async fn time_install<T, F>(id: &str, install: F) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    let timer = InstallTimer::start(id);
    let result = install.await;
    timer.finish(if result.is_ok() {
        InstallOutcome::Ok
    } else {
        InstallOutcome::Failed
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use hq_desktop_core::logfile::LogOverrideGuard;

    fn first_run_lines(path: &std::path::Path) -> Vec<String> {
        std::fs::read_to_string(path)
            .expect("log file is written")
            .lines()
            .filter_map(|line| line.split_once(" [first-run] ").map(|(_, rest)| rest.to_string()))
            .collect()
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime builds")
    }

    fn strip_elapsed(line: &str) -> (String, u128) {
        let (head, ms) = line
            .rsplit_once(" elapsed_ms=")
            .expect("end line carries elapsed_ms");
        (head.to_string(), ms.parse().expect("elapsed_ms is an integer"))
    }

    #[test]
    fn install_lines_match_the_documented_format() {
        assert_eq!(format_install_start("qmd"), "kind=install event=start id=qmd");
        assert_eq!(
            format_install_end("claude-code", InstallOutcome::Ok, 1234),
            "kind=install event=end id=claude-code outcome=ok elapsed_ms=1234"
        );
        assert_eq!(
            format_install_end("node", InstallOutcome::Failed, 0),
            "kind=install event=end id=node outcome=failed elapsed_ms=0"
        );
        assert_eq!(
            format_install_end("gh", InstallOutcome::Skipped, 7),
            "kind=install event=end id=gh outcome=skipped elapsed_ms=7"
        );
        assert_eq!(
            format_install_end("hq-cli", InstallOutcome::Cancelled, 9),
            "kind=install event=end id=hq-cli outcome=cancelled elapsed_ms=9"
        );
    }

    #[test]
    fn sanitize_value_removes_spaces_and_equals() {
        assert_eq!(sanitize_value("hq cli"), "hq_cli");
        assert_eq!(sanitize_value("a=b\tc\nd"), "a_b_c_d");
        assert_eq!(sanitize_value("  "), "unknown");
        assert_eq!(sanitize_value(""), "unknown");
        assert_eq!(
            format_install_start("bad id=x"),
            "kind=install event=start id=bad_id_x"
        );
    }

    #[test]
    fn time_install_logs_start_and_ok_end_and_returns_the_value() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = dir.path().join("hq-sync.log");
        let _guard = LogOverrideGuard::new(log.clone());

        let result = runtime().block_on(time_install("git", async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            Ok::<_, String>("git installed".to_string())
        }));

        assert_eq!(result, Ok("git installed".to_string()));
        let lines = first_run_lines(&log);
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert_eq!(lines[0], "kind=install event=start id=git");
        let (head, ms) = strip_elapsed(&lines[1]);
        assert_eq!(head, "kind=install event=end id=git outcome=ok");
        assert!(ms >= 20, "elapsed_ms {ms} must cover the 20 ms install");
    }

    #[test]
    fn time_install_logs_failed_end_and_propagates_the_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = dir.path().join("hq-sync.log");
        let _guard = LogOverrideGuard::new(log.clone());

        let result: Result<String, String> =
            runtime().block_on(time_install("qmd", async { Err("qmd broke".to_string()) }));

        assert_eq!(result, Err("qmd broke".to_string()));
        let lines = first_run_lines(&log);
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert_eq!(lines[0], "kind=install event=start id=qmd");
        let (head, _) = strip_elapsed(&lines[1]);
        assert_eq!(head, "kind=install event=end id=qmd outcome=failed");
    }

    #[test]
    fn timer_finish_logs_the_given_outcome_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = dir.path().join("hq-sync.log");
        let _guard = LogOverrideGuard::new(log.clone());

        InstallTimer::start("yq").finish(InstallOutcome::Skipped);

        let lines = first_run_lines(&log);
        assert_eq!(lines.len(), 2, "{lines:?}");
        let (head, _) = strip_elapsed(&lines[1]);
        assert_eq!(head, "kind=install event=end id=yq outcome=skipped");
    }

    #[test]
    fn dropped_timer_logs_cancelled_end() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = dir.path().join("hq-sync.log");
        let _guard = LogOverrideGuard::new(log.clone());

        let pending = time_install("node", std::future::pending::<Result<(), String>>());
        let rt = runtime();
        rt.block_on(async {
            let timed_out =
                tokio::time::timeout(std::time::Duration::from_millis(10), pending).await;
            assert!(timed_out.is_err(), "the pending install never resolves");
        });

        let lines = first_run_lines(&log);
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert_eq!(lines[0], "kind=install event=start id=node");
        let (head, _) = strip_elapsed(&lines[1]);
        assert_eq!(head, "kind=install event=end id=node outcome=cancelled");
    }
}
