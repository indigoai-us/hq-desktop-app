//! Standalone, bounded diagnostics for Core-update failures.
//!
//! Kept independent of Tauri so its classification and telemetry dimensions
//! can be tested with `rustc --test` on hosts without WebKitGTK.

use std::io::ErrorKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CoreUpdateFailureMarker {
    NpmEnoent,
    RestoreSymlinkRace,
}

/// Recognize only the two observed, actionable rescue-output shapes. The raw
/// text is inspected in memory; only the closed marker leaves this function.
pub(crate) fn classify_core_update_failure_marker(raw: &str) -> Option<CoreUpdateFailureMarker> {
    raw.lines().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        let trimmed = lower.trim_start();
        let diagnostic_line = trimmed.starts_with("error")
            || trimmed.starts_with("fatal")
            || trimmed.starts_with("npm err")
            || trimmed.starts_with("hq_rescue_failure_kind=");
        if !diagnostic_line {
            return None;
        }

        if lower.contains("changed from missing to symlink")
            && lower.contains("after classification")
        {
            Some(CoreUpdateFailureMarker::RestoreSymlinkRace)
        } else if lower.contains("enoent") {
            Some(CoreUpdateFailureMarker::NpmEnoent)
        } else {
            None
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CoreUpdateLogFailureOperation {
    Create,
    Duplicate,
}

impl CoreUpdateLogFailureOperation {
    pub(crate) const fn step(self) -> &'static str {
        match self {
            Self::Create => "log-create",
            Self::Duplicate => "log-duplicate",
        }
    }
}

/// Closed tags for a failure before the rescue child process starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CoreUpdateLogFailureDiagnostic {
    pub(crate) rescue_step: &'static str,
    pub(crate) rescue_error_class: &'static str,
}

pub(crate) fn core_update_log_failure_diagnostic(
    operation: CoreUpdateLogFailureOperation,
    error_kind: ErrorKind,
) -> CoreUpdateLogFailureDiagnostic {
    let rescue_error_class = match error_kind {
        ErrorKind::NotFound => "io_not_found",
        ErrorKind::PermissionDenied => "io_permission_denied",
        ErrorKind::AlreadyExists => "io_already_exists",
        ErrorKind::InvalidInput => "io_invalid_input",
        ErrorKind::InvalidData => "io_invalid_data",
        ErrorKind::TimedOut => "io_timed_out",
        ErrorKind::Unsupported => "io_unsupported",
        ErrorKind::Interrupted => "io_interrupted",
        ErrorKind::WouldBlock => "io_would_block",
        ErrorKind::WriteZero => "io_write_zero",
        ErrorKind::BrokenPipe => "io_broken_pipe",
        ErrorKind::ConnectionRefused => "io_connection_refused",
        ErrorKind::ConnectionReset => "io_connection_reset",
        ErrorKind::ConnectionAborted => "io_connection_aborted",
        ErrorKind::NotConnected => "io_not_connected",
        ErrorKind::AddrInUse => "io_addr_in_use",
        ErrorKind::AddrNotAvailable => "io_addr_not_available",
        ErrorKind::OutOfMemory => "io_out_of_memory",
        ErrorKind::UnexpectedEof => "io_unexpected_eof",
        ErrorKind::Other => "io_other",
        _ => "io_other",
    };

    CoreUpdateLogFailureDiagnostic {
        rescue_step: operation.step(),
        rescue_error_class,
    }
}

pub(crate) fn core_update_sentry_exit_code_tag(
    exit_code: Option<i32>,
    rescue_step: &'static str,
) -> &'static str {
    if matches!(rescue_step, "log-create" | "log-duplicate") {
        return "not_started";
    }
    match exit_code {
        Some(1) => "1",
        Some(2) => "2",
        Some(3) => "3",
        Some(4) => "4",
        Some(5) => "5",
        Some(23) => "23",
        Some(126) => "126",
        Some(127) => "127",
        Some(-1) => "signal_or_unknown",
        Some(_) => "other",
        None => "not_available",
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_core_update_failure_marker, core_update_log_failure_diagnostic,
        core_update_sentry_exit_code_tag, CoreUpdateFailureMarker, CoreUpdateLogFailureOperation,
    };
    use std::io::ErrorKind;

    #[test]
    fn verify_settings_path_enoent_is_classified_as_not_found_marker() {
        let stderr = "Error: ENOENT: no such file or directory, open '[Filtered]'";
        assert_eq!(
            classify_core_update_failure_marker(stderr),
            Some(CoreUpdateFailureMarker::NpmEnoent)
        );
    }

    #[test]
    fn restore_symlink_race_has_a_dedicated_marker() {
        let stderr = "Error: path changed from missing to symlink after classification; rescue stopped before mutation";
        assert_eq!(
            classify_core_update_failure_marker(stderr),
            Some(CoreUpdateFailureMarker::RestoreSymlinkRace)
        );
    }

    #[test]
    fn pre_spawn_log_failures_have_bounded_step_exit_and_error_class() {
        let create = core_update_log_failure_diagnostic(
            CoreUpdateLogFailureOperation::Create,
            ErrorKind::NotFound,
        );
        assert_eq!(create.rescue_step, "log-create");
        assert_eq!(create.rescue_error_class, "io_not_found");
        assert_eq!(
            core_update_sentry_exit_code_tag(None, create.rescue_step),
            "not_started"
        );

        let duplicate = core_update_log_failure_diagnostic(
            CoreUpdateLogFailureOperation::Duplicate,
            ErrorKind::PermissionDenied,
        );
        assert_eq!(duplicate.rescue_step, "log-duplicate");
        assert_eq!(duplicate.rescue_error_class, "io_permission_denied");
        assert_eq!(
            core_update_sentry_exit_code_tag(None, duplicate.rescue_step),
            "not_started"
        );
        assert_eq!(core_update_sentry_exit_code_tag(Some(23), "rsync"), "23");
    }

    #[test]
    fn diagnostic_parser_does_not_classify_unrelated_enoent_text() {
        assert_eq!(
            classify_core_update_failure_marker("info: unrelated ENOENT example"),
            None
        );
        assert_eq!(
            classify_core_update_failure_marker("Error: unrelated permission failure"),
            None
        );
    }
}
