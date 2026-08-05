use std::cell::Cell;
use std::sync::Arc;

use hq_desktop_core::hq_cli_update::{
    apply_post_install_effects, decide_post_install, report_install_failure,
    report_non_convergent_install, report_unreadable_version, BinaryAnchorShape,
    LocalVersionProbeDiagnostics, NonConvergentReport, PostInstallCoreEffects, VersionProbeOutcome,
    NON_CONVERGENT_ERROR_PREFIX,
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

fn fingerprint(event: &sentry::protocol::Event<'_>) -> Vec<String> {
    event.fingerprint.iter().map(ToString::to_string).collect()
}

fn composed_non_convergent_events(
    hq_bin: &str,
    npm_prefix: Option<&str>,
    already_blocked: bool,
    durable_record: bool,
) -> (Vec<sentry::protocol::Event<'static>>, usize, usize, usize) {
    let records = Cell::new(0usize);
    let captures = Cell::new(0usize);
    let record_failures = Cell::new(0usize);
    let events = captured_events(|| {
        let outcome = decide_post_install(
            hq_bin,
            hq_bin,
            Some("5.77.14"),
            Some("5.77.14"),
            "5.84.0",
            npm_prefix,
            "/opt/homebrew/bin/npm",
            already_blocked,
        );
        let record = |version: String| {
            records.set(records.get() + 1);
            assert_eq!(version, "5.84.0");
            if durable_record {
                Ok(())
            } else {
                Err("fixture marker write failed".to_string())
            }
        };
        let clear = || panic!("non-convergence must not clear the marker");
        let capture = |report: NonConvergentReport| {
            captures.set(captures.get() + 1);
            report_non_convergent_install(
                &report.latest,
                report.local.as_deref(),
                &report.hq_bin,
                report.npm_prefix.as_deref(),
                &report.npm_bin,
                report.hq_bin_changed,
                report.kind,
            );
        };
        let record_failure = |_error: String| {
            record_failures.set(record_failures.get() + 1);
        };
        let result = apply_post_install_effects(
            &outcome,
            &PostInstallCoreEffects {
                record: &record,
                clear: &clear,
                capture: &capture,
                record_failure: &record_failure,
            },
        );
        assert!(matches!(
            result,
            Err(ref detail) if detail.starts_with(NON_CONVERGENT_ERROR_PREFIX)
        ));
    });

    (events, records.get(), captures.get(), record_failures.get())
}

fn assert_non_convergent_event(
    event: &sentry::protocol::Event<'_>,
    expected_kind: &str,
    expected_hq_source: &str,
    expected_hq_bin: &str,
    expected_prefix: &str,
) {
    assert_eq!(event.level, sentry::Level::Warning);
    assert_eq!(
        event.message.as_deref(),
        Some("[hq-cli-update] install completed but the detected CLI version did not change")
    );
    assert_eq!(
        fingerprint(event),
        ["hq-cli-update", "install-non-convergent"]
    );
    let expected_npm_source = if cfg!(target_os = "windows") {
        "unknown"
    } else {
        "homebrew"
    };
    let expected_prefix_known = if expected_prefix == "npm default prefix" {
        "false"
    } else {
        "true"
    };
    for (tag, expected) in [
        ("hq_cli_update_kind", "install-non-convergent"),
        ("non_convergence_kind", expected_kind),
        ("latest", "5.84.0"),
        ("local", "5.77.14"),
        ("hq_bin_source", expected_hq_source),
        ("npm_bin_source", expected_npm_source),
        ("hq_bin_changed", "false"),
        ("prefix_known", expected_prefix_known),
    ] {
        assert_eq!(
            event.tags.get(tag).map(String::as_str),
            Some(expected),
            "unexpected {tag} tag"
        );
    }
    assert_eq!(
        event.extra.get("hq_bin").and_then(Value::as_str),
        Some(expected_hq_bin)
    );
    assert_eq!(
        event.extra.get("npm_prefix").and_then(Value::as_str),
        Some(expected_prefix)
    );
}

#[test]
fn foreign_managed_first_episodes_capture_only_after_a_durable_record() {
    let home = hq_desktop_core::paths::home_dir().expect("test home directory");
    let home_text = home.to_string_lossy().to_string();
    let expected_sources = if cfg!(target_os = "windows") {
        ["unknown", "unknown"]
    } else {
        ["pnpm", "login-shell"]
    };
    for (relative, expected_extra, expected_source) in [
        ("Library/pnpm/hq", "~/Library/pnpm/hq", expected_sources[0]),
        (".asdf/shims/hq", "~/.asdf/shims/hq", expected_sources[1]),
    ] {
        let hq_bin = home.join(relative).to_string_lossy().to_string();
        let (events, records, captures, record_failures) =
            composed_non_convergent_events(&hq_bin, None, false, true);
        assert_eq!(records, 1);
        assert_eq!(captures, 1);
        assert_eq!(record_failures, 0);
        assert_eq!(events.len(), 1);
        assert_non_convergent_event(
            &events[0],
            "foreign-managed",
            expected_source,
            expected_extra,
            "npm default prefix",
        );
        let serialized = serde_json::to_string(&events[0]).expect("serialize event");
        assert!(!serialized.contains(&home_text));

        let (events, records, captures, record_failures) =
            composed_non_convergent_events(&hq_bin, None, false, false);
        assert!(events.is_empty(), "a failed marker write must fail closed");
        assert_eq!(records, 1);
        assert_eq!(captures, 0);
        assert_eq!(record_failures, 1);
    }
}

#[test]
fn foreign_managed_repeat_episodes_stay_suppressed_through_the_executor() {
    let home = hq_desktop_core::paths::home_dir().expect("test home directory");
    for relative in ["Library/pnpm/hq", ".asdf/shims/hq"] {
        let hq_bin = home.join(relative).to_string_lossy().to_string();
        let (events, records, captures, record_failures) =
            composed_non_convergent_events(&hq_bin, None, true, true);
        assert!(events.is_empty());
        assert_eq!(records, 0);
        assert_eq!(captures, 0);
        assert_eq!(record_failures, 0);
    }
}

#[test]
fn npm_targeted_non_convergence_stays_loud_for_an_already_marked_episode() {
    let home = hq_desktop_core::paths::home_dir().expect("test home directory");
    let home_text = home.to_string_lossy().to_string();
    let prefix = home.join(".npm-global").to_string_lossy().to_string();
    let hq_bin = home
        .join(".npm-global/bin/hq")
        .to_string_lossy()
        .to_string();
    let expected_hq_source = if cfg!(target_os = "windows") {
        "unknown"
    } else {
        "npm-global"
    };

    let (events, records, captures, record_failures) =
        composed_non_convergent_events(&hq_bin, Some(&prefix), true, true);
    assert_eq!(records, 1);
    assert_eq!(captures, 1);
    assert_eq!(record_failures, 0);
    assert_eq!(events.len(), 1);
    assert_non_convergent_event(
        &events[0],
        "npm-targeted",
        expected_hq_source,
        "~/.npm-global/bin/hq",
        "~/.npm-global",
    );
    let serialized = serde_json::to_string(&events[0]).expect("serialize event");
    assert!(!serialized.contains(&home_text));
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
        event.tags.get("npm_errno").map(String::as_str),
        Some("unknown")
    );
    assert_eq!(
        event.extra.get("npm_diagnostics"),
        Some(&Value::String(
            format!(
                "error_code=EACCES syscall=mkdir path_shape=other prefix_known=false eacces=true exit_code=1 errno=unknown stderr_len={unexpected_eacces_len}"
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
