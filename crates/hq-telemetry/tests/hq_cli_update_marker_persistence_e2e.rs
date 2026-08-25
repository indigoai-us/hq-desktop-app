use std::sync::Arc;

use hq_desktop_core::hq_cli_update::{
    apply_post_install_effects, decide_post_install, report_non_convergent_install,
    report_non_convergent_marker_unpersisted,
    reset_non_convergent_marker_unpersisted_capture_for_tests, InstallExecutor,
    ManagedShadowRepairOutcome, NonConvergenceKind, PnpmHomeSource, PnpmRunDiagnostics,
    PnpmStoreFamily, PostInstallContext, PostInstallCoreEffects, NON_CONVERGENT_ERROR_PREFIX,
};
use std::path::PathBuf;
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

/// The fail-closed ordering is a property of the DURABLE-marker path — a
/// foreign-managed first episode captures only after the marker write succeeds.
/// The npm executor still reaches it (a genuinely foreign npm layout with no
/// prefix to aim at). The pnpm executor no longer has a foreign-managed path:
/// an unaimed pnpm run is now the non-blocking `InstallerUnaimed` kind, which
/// writes no marker at all (proved by `an_unaimed_pnpm_run_persists_no_marker`),
/// so there is no marker write for it to fail closed on. Both marker-unpersisted
/// phases run in ONE test because the capture bound is a process-lifetime
/// `AtomicBool` that two parallel `#[test]` fns would race.
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

    reset_non_convergent_marker_unpersisted_capture_for_tests();
    let after_reset = captured_events(report_non_convergent_marker_unpersisted);
    assert_eq!(after_reset.len(), 1, "the test-only reset must re-arm once");
    reset_non_convergent_marker_unpersisted_capture_for_tests();
}

/// The Kurts marker contract: an unaimed pnpm run (home_source=Undetermined,
/// path_has_shim_dir=false) is `InstallerUnaimed` — it persists NO durable
/// `cliUpdateNonConvergentVersion` marker (so `should_auto_install` stays true
/// and the next check retries), and it never clears a pre-existing marker
/// either (the injected `clear` panics if called). It stays observable once.
#[test]
fn an_unaimed_pnpm_run_persists_no_marker() {
    let hq_bin = "/opt/homebrew/bin/hq";
    let ctx = PostInstallContext {
        executor: InstallExecutor::Pnpm,
        before_bin: hq_bin,
        after_bin: hq_bin,
        before_version: None,
        after_version: Some("5.95.0"),
        latest: "5.103.18",
        npm_prefix_passed: None,
        delivered_version: None,
        installer_bin: "/opt/homebrew/bin/pnpm",
        already_blocked: false,
        nonblocking_episode_keys: &[],
        managed_roots: &[],
        managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
        pnpm: Some(PnpmRunDiagnostics {
            home_source: PnpmHomeSource::Undetermined,
            home_env_present: false,
            path_has_shim_dir: false,
            global_bin_dir_matches_shim_dir: None,
            store_family: PnpmStoreFamily::Unknown,
            authoritative_query_ok: false,
            exit_status: "0".to_string(),
            output_len: 64,
        }),
    };
    assert_eq!(
        decide_post_install(&ctx).non_convergence_kind,
        Some(NonConvergenceKind::InstallerUnaimed)
    );
    let (records, captures) = drive_success_path(&ctx);
    assert_eq!(records, 0, "an unaimed pnpm run must write no durable marker");
    assert_eq!(captures, 1, "it stays observable once");
}

/// The Zekes marker contract: the app resolves an npx-cache copy npm can never
/// move. It is `InstallerUnaimed`, persists NO durable marker, and stays
/// observable once — so auto-update is never wedged on an un-updatable copy.
#[test]
fn an_npx_cache_run_persists_no_marker() {
    let npx_hq = "/Users/reviewer/.npm/_npx/91dc460cc0784cc8/node_modules/.bin/hq";
    let ctx = PostInstallContext::npm(
        npx_hq,
        npx_hq,
        Some("5.103.1"),
        Some("5.103.1"),
        "5.103.18",
        Some("/Users/reviewer/Library/Application Support/Indigo HQ/toolchain/npm-global"),
        "/opt/homebrew/bin/npm",
        false,
        Some("5.103.18"),
    );
    assert_eq!(
        decide_post_install(&ctx).non_convergence_kind,
        Some(NonConvergenceKind::InstallerUnaimed)
    );
    let (records, captures) = drive_success_path(&ctx);
    assert_eq!(records, 0, "an npx-cache copy must write no durable marker");
    assert_eq!(captures, 1, "it stays observable once");
}

/// The Kevins-MacBook-Pro marker contract: a FIRST install where nothing
/// resolved leaves `hq` as the bare sentinel, npm exits 0 into its own ambient
/// default prefix, and there is no prefix to read delivery from. It is
/// `InstallerUnaimed` — it persists NO durable `cliUpdateNonConvergentVersion`
/// marker (so `should_auto_install` stays true and the next check retries) and
/// never clears a pre-existing one (the injected `clear` panics if called). On the
/// base commit the npm arm falls through to `ForeignManaged`, which writes the
/// pinned marker and wedges auto-update for a copy HQ could not even name.
#[test]
fn an_unresolved_hq_run_persists_no_marker() {
    let ctx = PostInstallContext::npm(
        "hq",
        "hq",
        None,
        None,
        "5.103.20",
        None,
        "/usr/local/bin/npm",
        false,
        None,
    );
    assert_eq!(
        decide_post_install(&ctx).non_convergence_kind,
        Some(NonConvergenceKind::InstallerUnaimed)
    );
    let (records, captures) = drive_success_path(&ctx);
    assert_eq!(
        records, 0,
        "an unresolved first install must write no durable marker"
    );
    assert_eq!(captures, 1, "it stays observable once");
}

/// The pnpm >=11 nested field layout. `matches` is now a native-resolution
/// diagnostic only; the marker decision turns on delivery evidence. `'static` so
/// the fixtures need no caller-side locals.
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
        nonblocking_episode_keys: &[],
        managed_roots: &[],
        managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
        pnpm: Some(PnpmRunDiagnostics {
            home_source: PnpmHomeSource::NestedBinDir,
            home_env_present: false,
            path_has_shim_dir: true,
            global_bin_dir_matches_shim_dir: matches,
            store_family: PnpmStoreFamily::V11,
            authoritative_query_ok: delivered.is_some(),
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

/// The r3 contract at the marker layer: the durable `cliUpdateNonConvergentVersion`
/// marker is gated on DELIVERY EVIDENCE alone, never on the native `pnpm bin -g`
/// direction. An undelivered pnpm install (a registry shortfall) writes no marker;
/// a delivered-but-shadowed install writes one — and it does so whether or not
/// pnpm's native global bin dir happens to match the shim dir, which on a pnpm >=11
/// nested layout it never does. That is exactly the tautology the base defect gated
/// blocking on.
#[test]
fn the_durable_marker_is_gated_on_delivery_evidence_not_the_direction_probe() {
    // Undelivered (store still N-1): a shortfall — no marker, still captured.
    let (records, captures) = drive_success_path(&pnpm_marker_ctx(Some(true), Some("5.93.0")));
    assert_eq!(
        records, 0,
        "an undelivered target must write no durable marker"
    );
    assert_eq!(captures, 1);
    // Undelivered entirely (pnpm's own answer returned nothing): still no marker.
    let (records, captures) = drive_success_path(&pnpm_marker_ctx(Some(false), None));
    assert_eq!(records, 0, "no delivery evidence must write no durable marker");
    assert_eq!(captures, 1);

    // Genuine shadowing (delivered == target) writes the durable block — and the
    // direction diagnostic does NOT change that: both a matching AND a mismatching
    // native dir keep the block, proving blocking no longer depends on the probe.
    for matches in [Some(true), Some(false), None] {
        let (records, captures) = drive_success_path(&pnpm_marker_ctx(matches, Some("5.97.2")));
        assert_eq!(
            records, 1,
            "genuine shadowing keeps its durable marker for direction {matches:?}"
        );
        assert_eq!(captures, 1);
    }
}

/// The managed-shadow marker contract (HQ-DESKTOP-46): a repairable first episode
/// (the pre-repair decision, or a caller that does not repair) persists NO durable
/// non-convergent marker — so `should_auto_install` stays true for that version and
/// the next check self-heals — while a repair that could not converge persists
/// exactly one, bounded like a foreign layout. On the base commit this same
/// same-root shape is classified foreign-managed and ALWAYS persists the marker.
#[test]
fn a_repairable_managed_shadow_persists_no_marker_but_a_failed_repair_persists_one() {
    let roots = [PathBuf::from("/opt/IndigoHQ/toolchain")];
    let npm_prefix = "/opt/IndigoHQ/toolchain/npm-prefix";
    let node_shim = "/opt/IndigoHQ/toolchain/node/hq.cmd";
    let base = PostInstallContext::npm(
        node_shim,
        node_shim,
        Some("5.101.0"),
        Some("5.101.0"),
        "5.101.7",
        Some(npm_prefix),
        node_shim,
        false,
        Some("5.101.7"),
    );

    // Not-attempted: classified managed-shadowed, captured once, but NO marker.
    let (records, captures) = drive_success_path(
        &base
            .clone()
            .with_managed_roots(&roots)
            .with_managed_shadow_repair(ManagedShadowRepairOutcome::NotAttempted),
    );
    assert_eq!(
        records, 0,
        "a repairable first episode must write no durable marker"
    );
    assert_eq!(captures, 1);

    // Repair-failed: still shadowed, so it persists exactly one durable marker.
    let (records, captures) = drive_success_path(
        &base
            .with_managed_roots(&roots)
            .with_managed_shadow_repair(ManagedShadowRepairOutcome::RepairFailed),
    );
    assert_eq!(
        records, 1,
        "a repair that did not converge persists exactly one marker"
    );
    assert_eq!(captures, 1);
}

/// The classification underneath the marker contract, pinned directly: the same
/// same-root shape decides `ManagedShadowed`, never `ForeignManaged`.
#[test]
fn the_same_root_shape_classifies_managed_shadowed_not_foreign_managed() {
    let roots = [PathBuf::from("/opt/IndigoHQ/toolchain")];
    let outcome = decide_post_install(
        &PostInstallContext::npm(
            "/opt/IndigoHQ/toolchain/node/hq.cmd",
            "/opt/IndigoHQ/toolchain/node/hq.cmd",
            Some("5.101.0"),
            Some("5.101.0"),
            "5.101.7",
            Some("/opt/IndigoHQ/toolchain/npm-prefix"),
            "/opt/IndigoHQ/toolchain/node/hq.cmd",
            false,
            Some("5.101.7"),
        )
        .with_managed_roots(&roots),
    );
    assert_eq!(
        outcome.non_convergence_kind,
        Some(NonConvergenceKind::ManagedShadowed)
    );
}
