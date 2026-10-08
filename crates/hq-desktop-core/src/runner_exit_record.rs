/// The runner's closed, content-safe explanation for a non-zero exit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerExitReason {
    ArgumentsInvalid,
    OwnerBusy,
    OperationLock,
    HeapRecycle,
    OwnerLeaseLost,
    WatchLoopReturn,
    HeapHardExit,
    Other,
}

impl RunnerExitReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ArgumentsInvalid => "arguments-invalid",
            Self::OwnerBusy => "owner-busy",
            Self::OperationLock => "operation-lock",
            Self::HeapRecycle => "heap-recycle",
            Self::OwnerLeaseLost => "owner-lease-lost",
            Self::WatchLoopReturn => "watch-loop-return",
            Self::HeapHardExit => "heap-hard-exit",
            Self::Other => "other",
        }
    }

    fn from_wire(value: &str) -> Self {
        match value {
            "arguments-invalid" => Self::ArgumentsInvalid,
            "owner-busy" => Self::OwnerBusy,
            "operation-lock" => Self::OperationLock,
            "heap-recycle" => Self::HeapRecycle,
            "owner-lease-lost" => Self::OwnerLeaseLost,
            "watch-loop-return" => Self::WatchLoopReturn,
            "heap-hard-exit" => Self::HeapHardExit,
            _ => Self::Other,
        }
    }
}

/// Parsed runner exit data. The integer code is retained as an integer; reason
/// is reduced to the closed vocabulary above, and no input line is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunnerExitRecord {
    pub code: i32,
    pub reason: RunnerExitReason,
}

/// Parse only the runner's diagnostic exit record. A missing, non-integer, or
/// out-of-range code means the line is not a valid record. Unrecognised reasons
/// map to `other` and never retain producer text.
pub fn parse_runner_exit_line(line: &str) -> Option<RunnerExitRecord> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type")?.as_str()? != "runner-exit" {
        return None;
    }
    let code = i32::try_from(value.get("code")?.as_i64()?).ok()?;
    let reason = value
        .get("reason")
        .and_then(serde_json::Value::as_str)
        .map(RunnerExitReason::from_wire)
        .unwrap_or(RunnerExitReason::Other);
    Some(RunnerExitRecord { code, reason })
}

#[cfg(test)]
mod tests {
    use super::{parse_runner_exit_line, RunnerExitReason};

    #[test]
    fn parses_each_closed_runner_exit_reason_and_integer_code() {
        let cases = [
            ("arguments-invalid", RunnerExitReason::ArgumentsInvalid),
            ("owner-busy", RunnerExitReason::OwnerBusy),
            ("operation-lock", RunnerExitReason::OperationLock),
            ("heap-recycle", RunnerExitReason::HeapRecycle),
            ("owner-lease-lost", RunnerExitReason::OwnerLeaseLost),
            ("watch-loop-return", RunnerExitReason::WatchLoopReturn),
            ("heap-hard-exit", RunnerExitReason::HeapHardExit),
        ];

        for (wire_reason, expected_reason) in cases {
            let line = format!(
                r#"{{"type":"runner-exit","code":18,"reason":"{wire_reason}"}}"#
            );
            let parsed = parse_runner_exit_line(&line).expect("valid runner exit record");
            assert_eq!(parsed.code, 18);
            assert_eq!(parsed.reason, expected_reason);
        }
    }

    #[test]
    fn maps_unknown_runner_exit_reason_to_other_without_retaining_it() {
        let parsed = parse_runner_exit_line(
            r#"{"type":"runner-exit","code":7,"reason":"private producer detail"}"#,
        )
        .expect("valid record with unknown reason");

        assert_eq!(parsed.code, 7);
        assert_eq!(parsed.reason, RunnerExitReason::Other);
        assert_eq!(parsed.reason.as_str(), "other");
    }

    #[test]
    fn rejects_malformed_json_and_runner_exit_without_code() {
        assert_eq!(parse_runner_exit_line(r#"{"type":"runner-exit""#), None);
        assert_eq!(
            parse_runner_exit_line(r#"{"type":"runner-exit","reason":"operation-lock"}"#),
            None
        );
        assert_eq!(
            parse_runner_exit_line(r#"{"type":"runner-exit","code":"18"}"#),
            None
        );
    }

    #[test]
    fn run_totals_retains_the_parsed_record_for_exit_capture() {
        let mut totals = crate::sync_outcome::RunTotals::default();
        totals.record_stderr_line(
            r#"{"type":"runner-exit","code":18,"reason":"operation-lock"}"#,
        );

        let record = totals.runner_exit_record().expect("parsed exit record");
        assert_eq!(record.code, 18);
        assert_eq!(record.reason, RunnerExitReason::OperationLock);
    }
}
