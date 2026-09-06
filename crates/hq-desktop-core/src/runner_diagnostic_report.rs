//! Pure, content-safe parser for a Node `--report-on-fatalerror` diagnostic
//! report (HQ-DESKTOP-5W / HQ-DESKTOP-5X).
//!
//! Node writes this JSON file synchronously at fatal-error time, BEFORE the
//! abort — so it survives the Windows fail-fast (`0xC0000409`) that the runner's
//! stderr fatal-error line is lost to (the child's stdio is an async libuv pipe
//! that never drains when the process dies). It is the third, crash-surviving
//! channel that can finally name WHY a Windows sync child died, where the WER
//! Application-Error channel and the stderr channel both come up empty.
//!
//! The report itself is DENSE with user content — `cwd`, `commandLine`/argv, the
//! full `environmentVariables` map, `sharedObjects` and `libuv` handle paths.
//! NONE of that may ever leave this crate. This parser therefore reads ONLY two
//! narrow, content-safe channels and returns ONLY fixed-vocabulary tokens and a
//! digest:
//!
//!   1. the fatal MESSAGE (`javascriptStack.message` / `header.event`), fed to
//!      [`classify_runner_fatal_class`], which returns a fixed `RunnerFatalClass`
//!      token and never copies a byte of its input; and
//!   2. the NATIVE FRAME SYMBOLS (`nativeStack[].symbol`), normalized to drop any
//!      address and `[module]` path, then mapped through the SAME frame allow-list
//!      the macOS heap-OOM stderr path uses ([`runner_report_stack_shape`]) so the
//!      shape is a `>`-joined set of fixed tokens and the signature a 16-hex digest.
//!
//! The parser reads no other field. A truncated, oversized, hostile, or
//! schema-drifted report degrades to an honesty verdict ([`RunnerReportParse::Unparseable`]),
//! never to a fabricated class.

use serde_json::Value;

use crate::sync_outcome::{
    classify_runner_fatal_class, normalize_report_native_symbol, runner_report_stack_shape,
    RunnerFatalClass, RunnerStackShape,
};

/// Hard cap on the report bytes the parser will accept. `--report-compact`
/// reports are a few KiB; 1 MiB is generous headroom while bounding a hostile or
/// runaway file so a machine that faults on a corrupt/huge report cannot make the
/// reader allocate without limit.
pub const MAX_REPORT_BYTES: usize = 1024 * 1024;

/// Hard cap on native-stack symbols the parser will read. Real V8 fatal stacks
/// are well under this; the cap bounds a hostile report stuffed with frames.
pub const MAX_NATIVE_FRAMES: usize = 64;

/// The fixed-vocabulary attribution a parsed report yielded. Both fields are
/// content-safe by construction: `fatal_class` is an enum token and `stack`
/// carries only allow-listed frame tokens plus a one-way digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerReportAttribution {
    pub fatal_class: RunnerFatalClass,
    pub stack: RunnerStackShape,
}

/// The verdict of parsing a report's text. `Named` carries a recognised fatal
/// class; `Unnamed` means a valid report was parsed but named no known cause;
/// `Unparseable` means the bytes were oversized, not JSON, or not a Node report
/// (schema drift) — an honesty token, never a guess.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerReportParse {
    Named(RunnerReportAttribution),
    Unnamed,
    Unparseable,
}

/// Parse a Node diagnostic report's JSON `text` into a fixed-vocabulary verdict.
/// Pure: reads no environment, touches no filesystem, and copies no observed byte
/// into its output.
pub fn parse_runner_diagnostic_report(text: &str) -> RunnerReportParse {
    // Oversized or empty input is never trusted.
    if text.len() > MAX_REPORT_BYTES || text.trim().is_empty() {
        return RunnerReportParse::Unparseable;
    }
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(text) else {
        return RunnerReportParse::Unparseable;
    };
    // A genuine Node report always carries a `header` object. Requiring it keeps
    // arbitrary JSON that happens to parse (a config file, an API body) from being
    // mistaken for a report and mapped to a class.
    if !root.get("header").is_some_and(Value::is_object) {
        return RunnerReportParse::Unparseable;
    }

    // Channel 1 — the fatal MESSAGE. Try the JS-stack message first, then the
    // header event; the FIRST that classifies to a non-`none` class wins. Each
    // string is fed only to the fixed-vocabulary classifier and never retained.
    let fatal_class = message_candidates(&root)
        .into_iter()
        .map(|candidate| classify_runner_fatal_class(&candidate))
        .find(|class| class.seen())
        .unwrap_or(RunnerFatalClass::None);

    // Channel 2 — the NATIVE FRAME SYMBOLS, normalized then tokenised through the
    // shared allow-list. Only ever fixed tokens + a digest escape.
    let symbols = native_symbols(&root);
    let stack = runner_report_stack_shape(&symbols);

    if fatal_class.seen() {
        RunnerReportParse::Named(RunnerReportAttribution { fatal_class, stack })
    } else {
        // A valid report that named no known cause: read, but not attributed.
        RunnerReportParse::Unnamed
    }
}

/// The fatal-message strings the parser will classify, most specific first. Each
/// is passed ONLY to [`classify_runner_fatal_class`]; none is stored or emitted.
fn message_candidates(root: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(message) = root
        .get("javascriptStack")
        .and_then(Value::as_object)
        .and_then(|stack| stack.get("message"))
        .and_then(Value::as_str)
    {
        candidates.push(message.to_string());
    }
    if let Some(event) = root
        .get("header")
        .and_then(Value::as_object)
        .and_then(|header| header.get("event"))
        .and_then(Value::as_str)
    {
        candidates.push(event.to_string());
    }
    candidates
}

/// Extract and normalize the report's native-stack symbols, bounded by
/// [`MAX_NATIVE_FRAMES`]. Handles both the modern `[{ "symbol": "…" }]` shape and
/// an older bare-string array. Empty entries are dropped; the return is the
/// content-safe normalized function names, never raw report bytes.
fn native_symbols(root: &serde_json::Map<String, Value>) -> Vec<String> {
    let Some(frames) = root.get("nativeStack").and_then(Value::as_array) else {
        return Vec::new();
    };
    frames
        .iter()
        .take(MAX_NATIVE_FRAMES)
        .filter_map(|frame| match frame {
            Value::Object(object) => object.get("symbol").and_then(Value::as_str),
            Value::String(symbol) => Some(symbol.as_str()),
            _ => None,
        })
        .map(normalize_report_native_symbol)
        .filter(|symbol| !symbol.is_empty())
        .collect()
}

/// The final five runner-fatal axes both exit seams emit, decided in ONE pure
/// place so the watcher and manual routes cannot drift.
///
/// Invariant: a report-derived class NEVER overrides a stderr-named class — the
/// macOS heap-OOM stderr path keeps priority AND its signature; the crash-surviving
/// report only fills the blank the Windows fail-fast leaves (where stderr is lost).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerFatalAxes {
    pub fatal_class: String,
    pub stack_shape: String,
    pub stack_signature: String,
    /// Where the named class came from: `stderr`, `node_report`, or `none`.
    pub fatal_source: &'static str,
    /// The `runner_report_read` provenance token (passed through unchanged).
    pub report_read: &'static str,
}

/// Decide the final runner-fatal axes from the stderr-derived class/shape and the
/// report read outcome. Pure. `report_read_token` is one of the fixed
/// `runner_report_read` tokens; `report_attribution` is `Some` only when a report
/// was read AND named a class.
pub fn runner_fatal_axes(
    stderr_fatal_class: &str,
    stderr_stack_shape: &str,
    stderr_stack_signature: &str,
    report_read_token: &'static str,
    report_attribution: Option<&RunnerReportAttribution>,
) -> RunnerFatalAxes {
    // stderr already named the cause → keep it verbatim; the report never
    // overrides it (macOS heap_oom keeps its class + signature).
    if stderr_fatal_class != "none" {
        return RunnerFatalAxes {
            fatal_class: stderr_fatal_class.to_string(),
            stack_shape: stderr_stack_shape.to_string(),
            stack_signature: stderr_stack_signature.to_string(),
            fatal_source: "stderr",
            report_read: report_read_token,
        };
    }
    // stderr was silent (the Windows fail-fast case) → fill the blank from the
    // crash-surviving report when it named a class.
    if let Some(attribution) = report_attribution {
        return RunnerFatalAxes {
            fatal_class: attribution.fatal_class.as_str().to_string(),
            stack_shape: attribution.stack.shape.clone(),
            stack_signature: attribution.stack.signature.clone(),
            fatal_source: "node_report",
            report_read: report_read_token,
        };
    }
    // Neither channel named a cause → honestly `none`, stderr shape retained.
    RunnerFatalAxes {
        fatal_class: "none".to_string(),
        stack_shape: stderr_stack_shape.to_string(),
        stack_signature: stderr_stack_signature.to_string(),
        fatal_source: "none",
        report_read: report_read_token,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal but schema-faithful compact Node fatal report for a V8 heap OOM,
    /// with the DANGEROUS fields (cwd, argv, env, shared-object paths) populated so
    /// content-safety can be asserted against real leak surfaces.
    fn heap_oom_report() -> String {
        serde_json::json!({
            "header": {
                "event": "Allocation failed - JavaScript heap out of memory",
                "trigger": "FatalError",
                "cwd": "/Users/secret-person/HQ/companies/acme",
                "commandLine": ["node", "--max-old-space-size=3584", "/Users/secret-person/.npm/_npx/hq-sync-runner"]
            },
            "javascriptStack": {
                "message": "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
                "stack": ["at Object.<anonymous> (/Users/secret-person/HQ/app.js:1:1)"]
            },
            "nativeStack": [
                { "pc": "0x0001", "symbol": "v8::internal::V8::FatalProcessOutOfMemory(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [/Users/secret-person/.nvm/node]" },
                { "pc": "0x0002", "symbol": "v8::internal::Heap::CollectGarbage() [/Users/secret-person/.nvm/node]" },
                { "pc": "0x0003", "symbol": "0xdeadbeef node::OnFatalError(char const*, char const*)" }
            ],
            "environmentVariables": {
                "AWS_SECRET_ACCESS_KEY": "AKIAIOSFODNN7EXAMPLE",
                "HOME": "/Users/secret-person"
            },
            "sharedObjects": ["/Users/secret-person/.nvm/versions/node/lib/libnode.dylib"]
        })
        .to_string()
    }

    #[test]
    fn heap_oom_report_names_the_class_and_a_v8_shape() {
        let RunnerReportParse::Named(attribution) = parse_runner_diagnostic_report(&heap_oom_report())
        else {
            panic!("a heap-OOM report must name a class");
        };
        assert_eq!(attribution.fatal_class, RunnerFatalClass::HeapOom);
        // The shape is built through the shared frame allow-list; the leading V8
        // OOM frames must tokenise, not collapse to `anon`.
        assert!(
            attribution.stack.shape.contains("v8_fatal_process_oom"),
            "shape must tokenise the V8 OOM frame: {}",
            attribution.stack.shape
        );
        assert!(
            attribution.stack.shape.contains("node_abort"),
            "shape must tokenise the node::OnFatalError frame: {}",
            attribution.stack.shape
        );
        assert_eq!(attribution.stack.signature.len(), 16);
    }

    #[test]
    fn content_safety_no_observed_byte_escapes() {
        let RunnerReportParse::Named(attribution) = parse_runner_diagnostic_report(&heap_oom_report())
        else {
            panic!("expected a named attribution");
        };
        // No path, argv token, env value, company slug, secret, or module path may
        // appear in ANY output field. Only allow-listed tokens + a hex digest.
        let observed = [
            "secret-person",
            "/Users",
            "AKIAIOSFODNN7EXAMPLE",
            "AWS_SECRET_ACCESS_KEY",
            "acme",
            "libnode.dylib",
            ".nvm",
            "app.js",
            "--max-old-space-size",
            "0xdeadbeef",
        ];
        let emitted = format!(
            "{}|{}|{}",
            attribution.fatal_class.as_str(),
            attribution.stack.shape,
            attribution.stack.signature
        );
        for needle in observed {
            assert!(
                !emitted.contains(needle),
                "observed byte {needle:?} leaked into output: {emitted}"
            );
        }
    }

    #[test]
    fn hostile_unicode_and_paths_in_message_still_yield_only_a_token() {
        let report = serde_json::json!({
            "header": { "event": "\u{202e}/etc/passwd\u{202d} secret", "trigger": "FatalError" },
            "javascriptStack": { "message": "FATAL ERROR: \u{202e} /Users/x/../../secret 💥 heap" },
            "nativeStack": [{ "symbol": "definitely_not_a_v8_symbol_/Users/x [/lib/evil]" }]
        })
        .to_string();
        match parse_runner_diagnostic_report(&report) {
            RunnerReportParse::Named(attribution) => {
                // "fatal error" classifies to node_fatal; the unknown native frame
                // collapses to `anon` — no observed byte in either output.
                assert_eq!(attribution.fatal_class, RunnerFatalClass::NodeFatal);
                assert!(!attribution.stack.shape.contains("passwd"));
                assert!(!attribution.stack.shape.contains("secret"));
                assert!(!attribution.stack.shape.contains("Users"));
            }
            other => panic!("expected a named node_fatal, got {other:?}"),
        }
    }

    #[test]
    fn absent_empty_truncated_and_non_report_json_all_degrade_to_unparseable() {
        assert_eq!(parse_runner_diagnostic_report(""), RunnerReportParse::Unparseable);
        assert_eq!(
            parse_runner_diagnostic_report("   \n  "),
            RunnerReportParse::Unparseable
        );
        // Valid JSON but not a Node report (no `header`): schema drift.
        assert_eq!(
            parse_runner_diagnostic_report(r#"{"hello":"world"}"#),
            RunnerReportParse::Unparseable
        );
        // Truncated JSON.
        assert_eq!(
            parse_runner_diagnostic_report(r#"{"header":{"event":"FATAL ERROR"#),
            RunnerReportParse::Unparseable
        );
        // Oversized input.
        let huge = format!(
            r#"{{"header":{{"event":"x"}},"pad":"{}"}}"#,
            "a".repeat(MAX_REPORT_BYTES)
        );
        assert_eq!(parse_runner_diagnostic_report(&huge), RunnerReportParse::Unparseable);
    }

    #[test]
    fn a_valid_report_with_no_recognised_cause_is_unnamed_not_fabricated() {
        let report = serde_json::json!({
            "header": { "event": "JavaScript API", "trigger": "GetReport" },
            "javascriptStack": { "message": "nothing fatal here" }
        })
        .to_string();
        assert_eq!(
            parse_runner_diagnostic_report(&report),
            RunnerReportParse::Unnamed
        );
    }

    #[test]
    fn a_report_that_names_a_class_but_carries_no_frames_degrades_the_shape() {
        let report = serde_json::json!({
            "header": { "event": "Allocation failed - JavaScript heap out of memory", "trigger": "FatalError" }
        })
        .to_string();
        let RunnerReportParse::Named(attribution) = parse_runner_diagnostic_report(&report) else {
            panic!("expected a named heap_oom");
        };
        assert_eq!(attribution.fatal_class, RunnerFatalClass::HeapOom);
        assert_eq!(attribution.stack.shape, "all_redacted");
        assert_eq!(attribution.stack.signature, "unknown");
    }

    #[test]
    fn native_frame_count_is_bounded() {
        let frames: Vec<Value> = (0..(MAX_NATIVE_FRAMES + 50))
            .map(|_| serde_json::json!({ "symbol": "v8::internal::Heap::x() [/p]" }))
            .collect();
        let report = serde_json::json!({
            "header": { "event": "FATAL ERROR: heap", "trigger": "FatalError" },
            "javascriptStack": { "message": "FATAL ERROR: x" },
            "nativeStack": frames
        })
        .to_string();
        // Parsing must succeed and stay bounded (no panic, no unbounded work).
        assert!(matches!(
            parse_runner_diagnostic_report(&report),
            RunnerReportParse::Named(_)
        ));
    }

    fn heap_oom_attribution() -> RunnerReportAttribution {
        let RunnerReportParse::Named(attribution) = parse_runner_diagnostic_report(&heap_oom_report())
        else {
            panic!("fixture must name a class");
        };
        attribution
    }

    #[test]
    fn axes_report_never_overrides_a_stderr_named_class() {
        // stderr already named a class (macOS heap_oom): the report is ignored and
        // the stderr class + signature are kept verbatim, source=stderr.
        let report = heap_oom_attribution();
        let axes = runner_fatal_axes(
            "heap_oom",
            "node_oom_handler>v8_fatal_process_oom",
            "abc123def4567890",
            "report_read",
            Some(&report),
        );
        assert_eq!(axes.fatal_class, "heap_oom");
        assert_eq!(axes.stack_shape, "node_oom_handler>v8_fatal_process_oom");
        assert_eq!(axes.stack_signature, "abc123def4567890");
        assert_eq!(axes.fatal_source, "stderr");
        assert_eq!(axes.report_read, "report_read");
    }

    #[test]
    fn axes_report_fills_the_blank_when_stderr_is_silent() {
        // The Windows fail-fast case: stderr named nothing (`none`), so the report
        // supplies the class, shape, and signature, source=node_report.
        let report = heap_oom_attribution();
        let axes = runner_fatal_axes(
            "none",
            "all_redacted",
            "unknown",
            "report_read",
            Some(&report),
        );
        assert_eq!(axes.fatal_class, "heap_oom");
        assert_eq!(axes.stack_shape, report.stack.shape);
        assert_eq!(axes.stack_signature, report.stack.signature);
        assert_eq!(axes.fatal_source, "node_report");
        assert_eq!(axes.report_read, "report_read");
    }

    #[test]
    fn axes_neither_channel_names_a_cause_stays_none_and_honest() {
        let axes = runner_fatal_axes("none", "all_redacted", "unknown", "report_absent", None);
        assert_eq!(axes.fatal_class, "none");
        assert_eq!(axes.stack_shape, "all_redacted");
        assert_eq!(axes.stack_signature, "unknown");
        assert_eq!(axes.fatal_source, "none");
        assert_eq!(axes.report_read, "report_absent");
    }
}
