use std::sync::Arc;

use hq_desktop_core::hq_cli_update::{
    report_non_convergent_marker_unpersisted,
    reset_non_convergent_marker_unpersisted_capture_for_tests,
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
            report_non_convergent_marker_unpersisted();
        }
    });

    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.level, sentry::Level::Warning);
    assert_eq!(
        event.fingerprint.iter().map(ToString::to_string).collect::<Vec<_>>(),
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
}
