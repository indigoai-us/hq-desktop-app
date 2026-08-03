use std::sync::Arc;

use hq_desktop_core::hq_cli_update::{
    apply_post_install_effects, decide_post_install, report_non_convergent_install,
    report_non_convergent_marker_unpersisted,
    reset_non_convergent_marker_unpersisted_capture_for_tests, PostInstallCoreEffects,
    NON_CONVERGENT_ERROR_PREFIX,
};
use sentry::test::with_captured_events_options;

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
fn failed_marker_persistence_is_reported_once_per_process_without_paths() {
    reset_non_convergent_marker_unpersisted_capture_for_tests();
    let events = captured_events(|| {
        for _ in 0..5 {
            let outcome = decide_post_install(
                "/Users/reviewer/Library/pnpm/hq",
                "/Users/reviewer/Library/pnpm/hq",
                Some("5.77.14"),
                Some("5.77.14"),
                "5.84.0",
                None,
                "/opt/homebrew/bin/npm",
                false,
            );
            let record = |_version: String| Err("config directory is unwritable".to_string());
            let clear = || panic!("non-convergence must not clear the marker");
            let capture = |report: hq_desktop_core::hq_cli_update::NonConvergentReport| {
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
            let record_failure = |_error: String| report_non_convergent_marker_unpersisted();
            let effects = PostInstallCoreEffects {
                record: &record,
                clear: &clear,
                capture: &capture,
                record_failure: &record_failure,
            };

            let result = apply_post_install_effects(&outcome, &effects);
            assert!(matches!(
                result,
                Err(ref detail) if detail.starts_with(NON_CONVERGENT_ERROR_PREFIX)
            ));
        }
    });

    let non_convergent = events
        .iter()
        .filter(|event| {
            event
                .fingerprint
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                == ["hq-cli-update", "install-non-convergent"]
        })
        .count();
    assert_eq!(non_convergent, 0, "a failed marker write must fail closed");
    let marker_events = events
        .iter()
        .filter(|event| {
            event
                .fingerprint
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                == ["hq-cli-update", "non-convergent-marker-unpersisted"]
        })
        .collect::<Vec<_>>();
    assert_eq!(marker_events.len(), 1);
    let event = marker_events[0];
    assert_eq!(event.level, sentry::Level::Warning);
    assert_eq!(
        event
            .fingerprint
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        ["hq-cli-update", "non-convergent-marker-unpersisted"]
    );
    assert_eq!(
        event.tags.get("marker_error_class").map(String::as_str),
        Some("persistence")
    );
    let serialized = serde_json::to_string(event).expect("serialize event");
    for forbidden in ["/Users/", "reviewer", "npm error", "_cacache"] {
        assert!(
            !serialized.contains(forbidden),
            "marker persistence event leaked {forbidden:?}"
        );
    }

    reset_non_convergent_marker_unpersisted_capture_for_tests();
    let after_reset = captured_events(report_non_convergent_marker_unpersisted);
    assert_eq!(after_reset.len(), 1, "the test-only reset must re-arm once");
    reset_non_convergent_marker_unpersisted_capture_for_tests();
}
