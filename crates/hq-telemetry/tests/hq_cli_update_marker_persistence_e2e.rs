use std::sync::Arc;

use hq_desktop_core::hq_cli_update::{
    apply_post_install_effects, decide_post_install, report_non_convergent_install,
    report_non_convergent_marker_unpersisted,
    reset_non_convergent_marker_unpersisted_capture_for_tests, InstallExecutor, PnpmHomeSource,
    PnpmRunDiagnostics, PostInstallContext, PostInstallCoreEffects, NON_CONVERGENT_ERROR_PREFIX,
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

fn fingerprint(event: &sentry::protocol::Event<'_>) -> Vec<String> {
    event.fingerprint.iter().map(ToString::to_string).collect()
}

/// Drive the real decision seam and the real effects executor `rounds` times
/// with a marker write that always fails, and return the post-scrub events.
fn drive_failed_marker_writes(
    ctx: &PostInstallContext<'_>,
    rounds: usize,
) -> Vec<sentry::protocol::Event<'static>> {
    captured_events(|| {
        for _ in 0..rounds {
            let outcome = decide_post_install(ctx);
            let record = |_version: String| Err("config directory is unwritable".to_string());
            let clear = || panic!("non-convergence must not clear the marker");
            let capture = |report: hq_desktop_core::hq_cli_update::NonConvergentReport| {
                report_non_convergent_install(&report);
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
    })
}

fn assert_fails_closed_with_one_marker_event(events: &[sentry::protocol::Event<'static>]) {
    let non_convergent = events
        .iter()
        .filter(|event| fingerprint(event) == ["hq-cli-update", "install-non-convergent"])
        .count();
    assert_eq!(non_convergent, 0, "a failed marker write must fail closed");
    let marker_events = events
        .iter()
        .filter(|event| {
            fingerprint(event) == ["hq-cli-update", "non-convergent-marker-unpersisted"]
        })
        .collect::<Vec<_>>();
    assert_eq!(marker_events.len(), 1);
    let event = marker_events[0];
    assert_eq!(event.level, sentry::Level::Warning);
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
}

/// Both executors are asserted in ONE test on purpose. The capture bound this
/// file exercises is a process-lifetime `AtomicBool`, so two `#[test]` fns
/// would run on parallel threads and race each other's reset — which is exactly
/// how a green Linux run turned red on macOS. Phases run in sequence instead.
#[test]
fn failed_marker_persistence_is_reported_once_per_process_without_paths() {
    // npm executor, foreign-managed layout.
    reset_non_convergent_marker_unpersisted_capture_for_tests();
    let events = drive_failed_marker_writes(
        &PostInstallContext::npm(
            "/Users/reviewer/Library/pnpm/hq",
            "/Users/reviewer/Library/pnpm/hq",
            Some("5.77.14"),
            Some("5.77.14"),
            "5.84.0",
            None,
            "/opt/homebrew/bin/npm",
            false,
        ),
        5,
    );
    assert_fails_closed_with_one_marker_event(&events);

    // The pnpm executor now shares that fail-closed ordering. Before this, the
    // pnpm branch called `record_non_convergent_version` and
    // `report_non_convergent_install` unconditionally, so an unwritable config
    // directory produced a capture with no durable marker behind it — and
    // turned every six-hour retry into another apparent first episode.
    reset_non_convergent_marker_unpersisted_capture_for_tests();
    let hq_bin = "/Users/reviewer/.asdf/shims/hq";
    let events = drive_failed_marker_writes(
        &PostInstallContext {
            executor: InstallExecutor::Pnpm,
            before_bin: hq_bin,
            after_bin: hq_bin,
            before_version: None,
            after_version: Some("5.77.14"),
            latest: "5.84.0",
            npm_prefix_passed: None,
            npm_prefix_manifest_version: None,
            requested_version: Some("5.84.0"),
            installer_bin: "/opt/homebrew/bin/pnpm",
            already_blocked: false,
            pnpm: Some(PnpmRunDiagnostics {
                // Underivable home => foreign-managed => capture is gated on a
                // durable marker, exactly as for the npm path.
                home_source: PnpmHomeSource::Undetermined,
                home_env_present: false,
                path_has_shim_dir: false,
                exit_status: "0".to_string(),
                output_len: 64,
            }),
        },
        5,
    );
    assert_fails_closed_with_one_marker_event(&events);

    reset_non_convergent_marker_unpersisted_capture_for_tests();
    let after_reset = captured_events(report_non_convergent_marker_unpersisted);
    assert_eq!(after_reset.len(), 1, "the test-only reset must re-arm once");
    reset_non_convergent_marker_unpersisted_capture_for_tests();
}
