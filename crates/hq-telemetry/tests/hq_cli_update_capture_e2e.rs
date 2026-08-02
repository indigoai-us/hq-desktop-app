use std::sync::Arc;

use hq_desktop_core::hq_cli_update::{
    report_install_failure, report_unreadable_version, BinaryAnchorShape,
    LocalVersionProbeDiagnostics, VersionProbeOutcome,
};
use sentry::protocol::Value;
use sentry::test::with_captured_events_options;

const GLOBAL_EACCES: &str = "npm error code EACCES\n\
    npm error syscall mkdir\n\
    npm error path /usr/local/lib/node_modules/@indigoai-us\n\
    npm error errno -13\n\
    npm error Error: EACCES: permission denied, mkdir \
    '/usr/local/lib/node_modules/@indigoai-us'";

const UNMATCHED_GLOBAL_EACCES: &str = "npm error code EACCES\n\
    npm error syscall mkdir\n\
    npm error path /opt/homebrew/lib/node_modules/@indigoai-us\n\
    npm error errno -13\n\
    npm error Error: EACCES: permission denied, mkdir \
    '/opt/homebrew/lib/node_modules/@indigoai-us'";

fn captured_events(f: impl FnOnce()) -> Vec<sentry::protocol::Event<'static>> {
    with_captured_events_options(
        f,
        sentry::ClientOptions {
            before_send: Some(Arc::new(hq_telemetry::before_send)),
            ..Default::default()
        },
    )
}

#[test]
fn unreadable_version_capture_keeps_only_closed_diagnostics_and_stable_grouping_after_scrubbing() {
    let probes = LocalVersionProbeDiagnostics {
        binary_anchor: VersionProbeOutcome::PackageNotFound,
        npm_root: VersionProbeOutcome::NonzeroExit,
        hq_version: VersionProbeOutcome::InterpreterNotFound,
        binary_anchor_shape: BinaryAnchorShape::FlatGlobalBin,
    };

    let events = captured_events(|| report_unreadable_version("5.88.3", &probes));
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.level, sentry::Level::Warning);
    assert_eq!(
        event.message.as_deref(),
        Some(
            "[hq-cli-update] hq is installed but its version could not be read \
             (binary-anchor, npm root, and hq --version all failed)"
        )
    );
    assert_eq!(
        event
            .fingerprint
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>(),
        ["{{ default }}"],
        "the event must retain Sentry's default message grouping"
    );
    assert_eq!(
        event.tags.get("hq_cli_update_kind").map(String::as_str),
        Some("version-unreadable")
    );
    assert_eq!(event.tags.get("latest").map(String::as_str), Some("5.88.3"));
    assert_eq!(
        event.extra.get("hq_cli_version_probes"),
        Some(&Value::Object(
            serde_json::json!({
                "binary_anchor": "package_not_found",
                "npm_root": "nonzero_exit",
                "hq_version": "interpreter_not_found",
                "binary_anchor_shape": "flat_global_bin",
            })
            .as_object()
            .unwrap()
            .clone()
        ))
    );
    assert!(
        event.extra.values().all(|value| match value {
            Value::String(value) => !value.contains("/Users/") && !value.contains("fixture"),
            Value::Object(value) => value.values().all(|value| match value {
                Value::String(value) => !value.contains("/Users/") && !value.contains("fixture"),
                _ => true,
            }),
            _ => true,
        }),
        "unreadable-version diagnostics must remain closed enum values: {:?}",
        event.extra
    );
}

#[test]
fn install_failure_capture_is_suppressed_or_tagged_after_the_real_scrubber() {
    let suppressed = captured_events(|| report_install_failure(Some(243), GLOBAL_EACCES, None));
    assert!(
        suppressed.is_empty(),
        "expected global no-prefix EACCES to be suppressed, got {suppressed:?}"
    );

    let suppressed = captured_events(|| {
        report_install_failure(Some(243), UNMATCHED_GLOBAL_EACCES, Some("/usr/local"))
    });
    assert!(
        suppressed.is_empty(),
        "expected unmatched global-prefix EACCES to be suppressed, got {suppressed:?}"
    );

    let unexpected_eacces = "npm error code EACCES\n\
        npm error syscall mkdir\n\
        npm error path /Users/alice/project/.cache/hq";
    let unexpected_eacces_len = unexpected_eacces.len().to_string();
    let events = captured_events(|| report_install_failure(Some(1), unexpected_eacces, None));
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.level, sentry::Level::Error);
    assert_eq!(
        event.message.as_deref(),
        Some("[hq-cli-update] install failed (exit 1)")
    );
    assert_eq!(event.tags.get("eacces").map(String::as_str), Some("true"));
    assert_eq!(
        event.tags.get("npm_error_code").map(String::as_str),
        Some("EACCES")
    );
    assert_eq!(
        event.tags.get("npm_syscall").map(String::as_str),
        Some("mkdir")
    );
    assert_eq!(
        event.tags.get("npm_path_shape").map(String::as_str),
        Some("other")
    );
    assert_eq!(
        event.tags.get("npm_prefix_known").map(String::as_str),
        Some("false")
    );
    assert_eq!(
        event.tags.get("npm_stderr_len").map(String::as_str),
        Some(unexpected_eacces_len.as_str())
    );
    assert_eq!(
        event.extra.get("npm_diagnostics"),
        Some(&Value::String(
            format!(
                "error_code=EACCES syscall=mkdir path_shape=other prefix_known=false eacces=true exit_code=1 stderr_len={unexpected_eacces_len}"
            )
            .into()
        ))
    );
    assert!(
        !event.extra.contains_key("npm_stderr"),
        "raw npm stderr must not reach Sentry"
    );
    assert!(
        event
            .tags
            .values()
            .all(|value| !value.contains("/Users/alice")),
        "diagnostic tags must never carry raw paths: {:?}",
        event.tags
    );
    assert!(
        event.extra.values().all(|value| match value {
            Value::String(value) => !value.contains("/Users/alice"),
            _ => true,
        }),
        "diagnostic extras must never carry raw paths: {:?}",
        event.extra
    );

    let unstructured_permission = "npm error syscall open\n\
        npm error path /Users/alice/project/.cache/hq\n\
        npm error Error: permission denied, open '/Users/alice/project/.cache/hq'";
    let events = captured_events(|| report_install_failure(Some(1), unstructured_permission, None));
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].tags.get("eacces").map(String::as_str),
        Some("true")
    );
    assert_eq!(
        events[0].tags.get("npm_error_code").map(String::as_str),
        Some("unknown")
    );

    let transient_network = "npm error code ECONNRESET\nnpm error network request reset";
    let events = captured_events(|| report_install_failure(Some(1), transient_network, None));
    assert!(
        events.is_empty(),
        "the current transient-registry classifier must stay suppressed"
    );

    let storage = "npm error code ENOSPC\nnpm error path /usr/local/lib/node_modules/@indigoai-us";
    let events = captured_events(|| report_install_failure(Some(1), storage, None));
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].tags.get("eacces").map(String::as_str),
        Some("false")
    );
    assert_eq!(
        events[0].tags.get("npm_error_code").map(String::as_str),
        Some("ENOSPC")
    );
    assert_eq!(
        events[0].tags.get("npm_path_shape").map(String::as_str),
        Some("global-lib-node-modules")
    );
}
