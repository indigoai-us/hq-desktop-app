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
            None,
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
            delivered_version: None,
            installer_bin: "/opt/homebrew/bin/pnpm",
            already_blocked: false,
            pnpm: Some(PnpmRunDiagnostics {
                // Underivable home => foreign-managed => capture is gated on a
                // durable marker, exactly as for the npm path.
                home_source: PnpmHomeSource::Undetermined,
                home_env_present: false,
                path_has_shim_dir: false,
                // Not aimed => never probed.
                global_bin_dir_matches_shim_dir: None,
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

/// The pnpm >=11 nested field layout, varying only the two evidence signals the
/// r2 classifier observes. `'static` so the fixtures need no caller-side locals.
fn pnpm_marker_ctx(
    matches: Option<bool>,
    delivered: Option<&'static str>,
) -> PostInstallContext<'static> {
    PostInstallContext {
        executor: InstallExecutor::Pnpm,
        before_bin: "/Users/reviewer/Library/pnpm/bin/hq",
        after_bin: "/Users/reviewer/Library/pnpm/bin/hq",
        before_version: None,
        after_version: Some("5.93.0"),
        latest: "5.97.2",
        npm_prefix_passed: None,
        delivered_version: delivered,
        installer_bin: "/opt/homebrew/bin/pnpm",
        already_blocked: false,
        pnpm: Some(PnpmRunDiagnostics {
            home_source: PnpmHomeSource::NestedBinDir,
            home_env_present: false,
            path_has_shim_dir: true,
            global_bin_dir_matches_shim_dir: matches,
            exit_status: "0".to_string(),
            output_len: 96,
        }),
    }
}

/// Drive the real decision seam and effects executor on the SUCCESS path (the
/// marker write, if any, succeeds) and return `(record_attempts, captures)`.
fn drive_success_path(ctx: &PostInstallContext<'_>) -> (usize, usize) {
    let records = std::cell::Cell::new(0usize);
    let captures = std::cell::Cell::new(0usize);
    let outcome = decide_post_install(ctx);
    let record = |_version: String| {
        records.set(records.get() + 1);
        Ok(())
    };
    let clear = || panic!("non-convergence must not clear the marker");
    let capture = |_report: hq_desktop_core::hq_cli_update::NonConvergentReport| {
        captures.set(captures.get() + 1);
    };
    let record_failure = |_error: String| panic!("record must succeed on this path");
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
    (records.get(), captures.get())
}

/// The r2 contract at the marker layer: a misdirected or undelivered pnpm install
/// writes NO durable `cliUpdateNonConvergentVersion` marker — the decision never
/// even attempts the record — while a genuine shadowing install still writes one.
/// This is what keeps a mis-aimed install (a pnpm build that ignored the forced
/// global-bin-dir) from permanently wedging auto-update while a real defect keeps
/// its block.
#[test]
fn a_misdirected_or_undelivered_pnpm_install_writes_no_durable_marker() {
    // Misdirected: pnpm delivered to its store but wrote the shim to the wrong
    // dir. No marker attempted, but still captured loudly.
    let (records, captures) = drive_success_path(&pnpm_marker_ctx(Some(false), Some("5.97.2")));
    assert_eq!(
        records, 0,
        "a misdirected install must write no durable marker"
    );
    assert_eq!(captures, 1, "but it stays loud on every occurrence");

    // Undelivered (aimed at the right dir, store still N-1): a shortfall.
    let (records, captures) = drive_success_path(&pnpm_marker_ctx(Some(true), Some("5.93.0")));
    assert_eq!(
        records, 0,
        "an undelivered target must write no durable marker"
    );
    assert_eq!(captures, 1);

    // Genuine shadowing (aimed right AND delivered): the durable block IS written.
    let (records, captures) = drive_success_path(&pnpm_marker_ctx(Some(true), Some("5.97.2")));
    assert_eq!(records, 1, "genuine shadowing keeps its durable marker");
    assert_eq!(captures, 1);
}
