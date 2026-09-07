//! Content-safe parser for a Node diagnostic report (this reopen, HQ-DESKTOP-5W).
//!
//! On Windows a sync child that fails fast (V8's `OS::Abort` raises
//! `STATUS_STACK_BUFFER_OVERRUN` / 0xC0000409) leaves BOTH existing "why"
//! channels empty: Windows Error Reporting binds no usable Application-Error
//! record for this class, and the runner's own fatal stderr is queued on an
//! asynchronous libuv pipe and lost when the process dies. Node ships exactly one
//! channel that survives that abort: `--report-on-fatalerror` writes a JSON
//! diagnostic report SYNCHRONOUSLY at fatal-error time, before aborting. This
//! module turns that report — which is DENSE with `cwd`, `argv`, the full
//! environment, and libuv handle paths — into ONLY fixed-vocabulary attribution.
//!
//! Content safety is absolute. This parser returns nothing but a fixed
//! [`RunnerFatalClass`], a content-safe [`RunnerStackShape`] built through the
//! EXISTING macOS heap-OOM frame allow-list, and a read-provenance token. No free
//! text, path, symbol, argv, env value, company slug, or raw report byte ever
//! leaves it. Input is size-capped and frame-capped; a truncated, oversized,
//! hostile, or unparseable report degrades to an honesty token, never a guess.

use serde_json::Value;

use crate::sync_outcome::{
    classify_runner_fatal_class, runner_stack_shape_from_native_symbols, RunnerFatalClass,
    RunnerStackShape,
};

/// Hard cap on report bytes parsed. A `--report-compact` report is a few KB;
/// anything larger is treated as oversized/hostile and degrades to `Unreadable`
/// WITHOUT building a serde tree over it. Also bounds worst-case parse cost on a
/// machine that faults repeatedly.
pub const RUNNER_REPORT_MAX_BYTES: usize = 512 * 1024;

/// Hard cap on native frames consulted, mirroring the heap-OOM frame discipline
/// so a runaway or hostile `nativeStack` cannot drive unbounded work.
const RUNNER_REPORT_NATIVE_FRAME_CAP: usize = 64;

/// Fixed-vocabulary read provenance for a runner diagnostic report at exit.
/// Mirrors the `runner_report_read` egress vocabulary in `hq-telemetry`; the
/// telemetry crate keeps its own local mirror so the two stay independent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerReportRead {
    /// The report was present and parsed. A cause may or may not have been named.
    Read,
    /// A report was requested at spawn but no file was present at exit — the flag
    /// never reached the child, or the abort path wrote none.
    Absent,
    /// A report file was present but too large, truncated, non-JSON, or not a Node
    /// diagnostic report (schema drift). Refused rather than guessed.
    Unreadable,
    /// No report was requested for this generation (no report directory).
    NotRequested,
    /// The child's inherited NODE_OPTIONS already set a `--report-*` option, so
    /// ours were withheld; the user's report configuration wins and we read none.
    DisabledByUserOptions,
}

impl RunnerReportRead {
    /// Every variant, so content-safety tests enumerate the emitter's own token
    /// set instead of a hand-copied list.
    pub const ALL: [RunnerReportRead; 5] = [
        Self::Read,
        Self::Absent,
        Self::Unreadable,
        Self::NotRequested,
        Self::DisabledByUserOptions,
    ];

    /// Fixed vocabulary, safe for a Sentry tag.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "report_read",
            Self::Absent => "report_absent",
            Self::Unreadable => "report_unreadable",
            Self::NotRequested => "report_not_requested",
            Self::DisabledByUserOptions => "report_disabled_by_user_options",
        }
    }
}

/// The content-safe result of parsing (or failing to parse) a Node diagnostic
/// report. Every field is fixed vocabulary, a bounded stack shape, or a digest —
/// there is no channel for a raw report byte to escape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerDiagnosticReport {
    /// The fatal class the report named, or `None` when it named none / was not read.
    pub fatal_class: RunnerFatalClass,
    /// The content-safe stack shape + 16-hex signature built from the report's
    /// native stack through the existing allow-list; `all_redacted`/`unknown` when
    /// no frame matched or none was read.
    pub stack: RunnerStackShape,
    /// How the report read resolved.
    pub read: RunnerReportRead,
}

impl RunnerDiagnosticReport {
    fn with_read(read: RunnerReportRead) -> Self {
        Self {
            fatal_class: RunnerFatalClass::None,
            // The honest empty shape, byte-identical to the base Windows-fault
            // envelope (`all_redacted` / `unknown`).
            stack: runner_stack_shape_from_native_symbols(&[]),
            read,
        }
    }

    /// A report that was requested but absent at exit.
    pub fn absent() -> Self {
        Self::with_read(RunnerReportRead::Absent)
    }

    /// A report file present but oversized/truncated/non-JSON/schema-drifted.
    pub fn unreadable() -> Self {
        Self::with_read(RunnerReportRead::Unreadable)
    }

    /// No report was requested for this generation.
    pub fn not_requested() -> Self {
        Self::with_read(RunnerReportRead::NotRequested)
    }

    /// The user's own `--report-*` options suppressed ours; we read none.
    pub fn disabled_by_user_options() -> Self {
        Self::with_read(RunnerReportRead::DisabledByUserOptions)
    }

    /// True when the report was read AND named a genuine (non-`none`) fatal class
    /// the exit seam may adopt. A report that named nothing never overrides the
    /// existing attribution.
    pub fn named_cause(&self) -> bool {
        self.read == RunnerReportRead::Read && self.fatal_class != RunnerFatalClass::None
    }

    /// The `runner_fatal_source` token this report justifies: `node_report` when it
    /// named a genuine cause, else `none`. (The `stderr` source is owned by the
    /// exit seam, which prefers a stderr-derived class when one already exists.)
    pub fn fatal_source(&self) -> &'static str {
        if self.named_cause() {
            "node_report"
        } else {
            "none"
        }
    }
}

/// Map a Node diagnostic report's Node-emitted `trigger` + `event` summary to a
/// fixed [`RunnerFatalClass`]. Reuses the existing stderr fatal classifier
/// (content-safe: it returns a fixed enum and never copies input) on the summary,
/// then falls back to the trigger keyword — a Node OOM/fatal/exception trigger is
/// a genuine fatal even when the event summary matched no specific stderr marker.
/// Deliberately consults ONLY the Node-emitted trigger/event, never the free-form
/// error message, so a user-controlled message cannot spoof a class.
fn classify_report_fatal(trigger: &str, event: &str) -> RunnerFatalClass {
    let probe = format!("{trigger} {event}");
    let class = classify_runner_fatal_class(&probe);
    if class != RunnerFatalClass::None {
        return class;
    }
    let trigger = trigger.to_ascii_lowercase();
    if trigger.contains("oom") || trigger.contains("out of memory") {
        RunnerFatalClass::HeapOom
    } else if trigger.contains("fatalerror")
        || trigger.contains("fatal")
        || trigger.contains("exception")
    {
        RunnerFatalClass::NodeFatal
    } else {
        RunnerFatalClass::None
    }
}

/// Extract native-frame symbols from a report's `nativeStack`, robust to BOTH
/// shapes Node has emitted: an array of frame strings, or an array of objects
/// with a `symbol` field. Bounded by [`RUNNER_REPORT_NATIVE_FRAME_CAP`]. The raw
/// strings are consumed only by [`runner_stack_shape_from_native_symbols`], which
/// emits fixed tokens + a digest and never the strings themselves.
fn native_symbols(native: &[Value]) -> Vec<String> {
    native
        .iter()
        .take(RUNNER_REPORT_NATIVE_FRAME_CAP)
        .filter_map(|frame| match frame {
            Value::String(symbol) => Some(symbol.clone()),
            Value::Object(_) => frame
                .get("symbol")
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
        .collect()
}

/// Parse a Node diagnostic report's raw bytes into fixed-vocabulary attribution.
/// Pure and content-safe. A truncated, oversized, hostile, or unparseable report,
/// or a JSON document that is not a Node diagnostic report, degrades to
/// [`RunnerReportRead::Unreadable`] — never a fabricated cause.
pub fn parse_runner_diagnostic_report(bytes: &[u8]) -> RunnerDiagnosticReport {
    if bytes.is_empty() || bytes.len() > RUNNER_REPORT_MAX_BYTES {
        return RunnerDiagnosticReport::unreadable();
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes[..]) else {
        return RunnerDiagnosticReport::unreadable();
    };

    let header = value.get("header");
    let trigger = header
        .and_then(|h| h.get("trigger"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let event = header
        .and_then(|h| h.get("event"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let native = value.get("nativeStack").and_then(Value::as_array);

    // Schema-drift guard: a JSON document that carries neither a header
    // trigger/event NOR a native stack is not a Node diagnostic report. Refuse it
    // rather than emit a `none`/`all_redacted` that looks like a real read.
    if trigger.is_empty() && event.is_empty() && native.is_none() {
        return RunnerDiagnosticReport::unreadable();
    }

    let fatal_class = classify_report_fatal(trigger, event);
    let symbols = native
        .map(|frames| native_symbols(frames))
        .unwrap_or_default();
    let stack = runner_stack_shape_from_native_symbols(&symbols);

    RunnerDiagnosticReport {
        fatal_class,
        stack,
        read: RunnerReportRead::Read,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A realistic Node 22 heap-OOM `--report-compact` report, DENSE with the
    /// user content a careless parser would leak: absolute paths, argv, the full
    /// environment (including a secret-shaped token), a company slug, and hostile
    /// Unicode — all in fields the parser must never emit.
    fn poisoned_oom_report() -> String {
        serde_json::json!({
            "header": {
                "reportVersion": 3,
                "event": "Allocation failed - JavaScript heap out of memory",
                "trigger": "FatalError",
                "cwd": "/Users/ada/Company Secrets/indigo-acme",
                "commandLine": ["node", "--max-old-space-size=3584", "/Users/ada/.npm/_npx/deadbeef/hq-sync-runner"],
                "host": "DESKTOP-53H1N93",
                "\u{202e}evil": "\u{202e}\u{0000}payload"
            },
            "javascriptStack": {
                "message": "FATAL ERROR /Users/ada/secret/path AKIAIOSFODNN7EXAMPLE",
                "stack": ["at Object.<anonymous> (/Users/ada/secret/app.js:42:7)"]
            },
            "nativeStack": [
                { "pc": "0x0001", "symbol": "v8::internal::OnFatalError(/Users/ada/v8) [/opt/node]" },
                { "pc": "0x0002", "symbol": "v8::internal::V8::FatalProcessOutOfMemory(char const*)" },
                { "pc": "0x0003", "symbol": "v8::internal::Heap::CollectGarbage [/Users/ada/node]" },
                { "pc": "0x0004", "symbol": "node::OOMErrorHandler(char const*, bool)" }
            ],
            "environmentVariables": {
                "AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
                "HQ_ROOT": "/Users/ada/Company Secrets/indigo-acme"
            },
            "libuv": [ { "type": "pipe", "fd": 17, "handle": "0x0", "peername": "/Users/ada/.pipe" } ]
        })
        .to_string()
    }

    #[test]
    fn parses_a_heap_oom_report_to_a_named_cause() {
        let report = parse_runner_diagnostic_report(poisoned_oom_report().as_bytes());
        assert_eq!(report.read, RunnerReportRead::Read);
        assert_eq!(report.fatal_class, RunnerFatalClass::HeapOom);
        assert!(report.named_cause());
        assert_eq!(report.fatal_source(), "node_report");
        // The native OOM stack produced a real, content-safe shape from the
        // allow-list (never all_redacted here) with a 16-hex signature.
        assert_ne!(report.stack.shape, "all_redacted");
        assert_eq!(report.stack.signature.len(), 16);
        assert!(report
            .stack
            .signature
            .bytes()
            .all(|b| b.is_ascii_hexdigit()));
        // The shape is built ONLY from allow-list tokens.
        for token in report.stack.shape.split('>') {
            assert!(
                matches!(
                    token,
                    "node_oom_handler"
                        | "node_abort"
                        | "v8_report_oom"
                        | "v8_fatal_process_oom"
                        | "v8_heap_allocator"
                        | "v8_heap"
                        | "v8_factory"
                        | "v8_runtime"
                        | "v8_builtin"
                        | "v8_other"
                        | "node_native"
                        | "anon"
                ),
                "unexpected non-allow-list shape token {token:?}"
            );
        }
    }

    #[test]
    fn no_observed_report_byte_ever_escapes() {
        // Every output field of a poison-stuffed report must be fixed vocabulary,
        // a bounded shape, or a digest — never a path, argv, env value, company
        // slug, secret, or hostile byte the report carried.
        let report = parse_runner_diagnostic_report(poisoned_oom_report().as_bytes());
        let observed = [
            "/Users/ada",
            "Company Secrets",
            "indigo-acme",
            "DESKTOP-53H1N93",
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI",
            "AWS_SECRET_ACCESS_KEY",
            "secret",
            "app.js",
            ".npm",
            ".pipe",
            "\u{202e}",
            "\u{0000}",
        ];
        let outputs = [
            report.fatal_class.as_str().to_string(),
            report.stack.shape.clone(),
            report.stack.signature.clone(),
            report.read.as_str().to_string(),
            report.fatal_source().to_string(),
        ];
        for field in &outputs {
            for poison in observed {
                assert!(
                    !field.contains(poison),
                    "observed byte {poison:?} leaked into output {field:?}"
                );
            }
        }
    }

    #[test]
    fn robustness_degrades_to_honesty_tokens_never_a_guess() {
        // Empty, non-JSON, and a valid JSON document that is not a Node report all
        // refuse — Unreadable, fatal_class none, all_redacted — never a fabricated
        // cause.
        for bytes in [
            b"".as_slice(),
            b"not json at all".as_slice(),
            b"{\"unrelated\":true}".as_slice(),
            b"{\"header\":{}}".as_slice(),
            br#"{"header":{"trigger":"FatalError","event":"boom"#.as_slice(), // truncated
        ] {
            let report = parse_runner_diagnostic_report(bytes);
            assert_eq!(
                report.read,
                RunnerReportRead::Unreadable,
                "expected Unreadable for {:?}",
                String::from_utf8_lossy(bytes)
            );
            assert_eq!(report.fatal_class, RunnerFatalClass::None);
            assert_eq!(report.stack.shape, "all_redacted");
            assert_eq!(report.stack.signature, "unknown");
            assert!(!report.named_cause());
            assert_eq!(report.fatal_source(), "none");
        }

        // Oversized input is refused WITHOUT parsing.
        let oversized = vec![b'{'; RUNNER_REPORT_MAX_BYTES + 1];
        assert_eq!(
            parse_runner_diagnostic_report(&oversized).read,
            RunnerReportRead::Unreadable
        );
    }

    #[test]
    fn a_report_with_no_named_cause_reads_but_names_nothing() {
        // A well-formed report whose trigger/event name no fatal class, and whose
        // native stack matches nothing, reads successfully but adopts no cause —
        // so it can never override an existing stderr-derived attribution.
        let report_json = serde_json::json!({
            "header": { "trigger": "Signal", "event": "SIGUSR2" },
            "nativeStack": [ { "pc": "0x1", "symbol": "some_app_frame_only" } ]
        })
        .to_string();
        let report = parse_runner_diagnostic_report(report_json.as_bytes());
        assert_eq!(report.read, RunnerReportRead::Read);
        assert_eq!(report.fatal_class, RunnerFatalClass::None);
        assert!(!report.named_cause());
        assert_eq!(report.fatal_source(), "none");
        assert_eq!(report.stack.shape, "all_redacted");
    }

    #[test]
    fn trigger_alone_names_a_fatal_when_the_event_summary_is_opaque() {
        // A FatalError trigger with an opaque event still names a node_fatal.
        let report_json = serde_json::json!({
            "header": { "trigger": "FatalError", "event": "v8 internal inconsistency 0x2a" },
        })
        .to_string();
        let report = parse_runner_diagnostic_report(report_json.as_bytes());
        assert_eq!(report.read, RunnerReportRead::Read);
        assert_eq!(report.fatal_class, RunnerFatalClass::NodeFatal);
        assert!(report.named_cause());
    }

    #[test]
    fn native_stack_string_and_object_shapes_are_both_handled() {
        // Node has emitted nativeStack as an array of strings AND as an array of
        // objects; both must produce the same content-safe shape.
        let as_strings = serde_json::json!({
            "header": { "trigger": "FatalError", "event": "Allocation failed - JavaScript heap out of memory" },
            "nativeStack": [
                " 1: 0x0 node::OOMErrorHandler(char const*) [/opt/node]",
                " 2: 0x0 v8::internal::V8::FatalProcessOutOfMemory(char const*)"
            ]
        })
        .to_string();
        let report = parse_runner_diagnostic_report(as_strings.as_bytes());
        assert_eq!(report.fatal_class, RunnerFatalClass::HeapOom);
        assert_ne!(report.stack.shape, "all_redacted");
        assert!(report.stack.shape.contains("node_oom_handler"));
    }

    #[test]
    fn read_provenance_tokens_are_a_fixed_content_safe_vocabulary() {
        for read in RunnerReportRead::ALL {
            let token = read.as_str();
            assert!(token.starts_with("report_"));
            assert!(token.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'));
        }
        assert_eq!(
            RunnerDiagnosticReport::absent().read,
            RunnerReportRead::Absent
        );
        assert_eq!(
            RunnerDiagnosticReport::not_requested().read,
            RunnerReportRead::NotRequested
        );
        assert_eq!(
            RunnerDiagnosticReport::disabled_by_user_options().read,
            RunnerReportRead::DisabledByUserOptions
        );
        // A non-Read provenance never names a cause.
        for report in [
            RunnerDiagnosticReport::absent(),
            RunnerDiagnosticReport::not_requested(),
            RunnerDiagnosticReport::disabled_by_user_options(),
            RunnerDiagnosticReport::unreadable(),
        ] {
            assert!(!report.named_cause());
            assert_eq!(report.fatal_source(), "none");
            assert_eq!(report.stack.shape, "all_redacted");
        }
    }
}
