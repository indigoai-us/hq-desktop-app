use std::cell::Cell;
use std::sync::Arc;

use hq_desktop_core::hq_cli_update::{
    apply_post_install_effects, decide_post_install, non_convergent_episode_key,
    report_install_failure, report_non_convergent_install, report_unreadable_version,
    BinaryAnchorShape, ConvergenceVerdict, InstallExecutor, LocalVersionProbeDiagnostics,
    ManagedShadowRepairOutcome, NonConvergenceKind, NonConvergentReport, PnpmHomeSource,
    PnpmRunDiagnostics, PnpmStoreFamily, PostInstallContext, PostInstallCoreEffects,
    ResolvedProgramKind, VersionProbeOutcome, NON_CONVERGENT_ERROR_PREFIX,
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

/// The npm-executor fixture context every pre-existing case in this file uses.
fn npm_context<'a>(
    hq_bin: &'a str,
    npm_prefix: Option<&'a str>,
    already_blocked: bool,
) -> PostInstallContext<'a> {
    PostInstallContext::npm(
        hq_bin,
        hq_bin,
        Some("5.77.14"),
        Some("5.77.14"),
        "5.84.0",
        npm_prefix,
        "/opt/homebrew/bin/npm",
        already_blocked,
        // Delivery evidence == the target: a matching-prefix non-convergence is
        // genuine shadowing (loud), not a resolution shortfall. Foreign-managed
        // fixtures pass no prefix, so this flag is moot for them.
        Some("5.84.0"),
    )
}

/// The pnpm-executor fixture context. `home_source`/`path_has_shim_dir` decide
/// whether pnpm was aimed at the shim we resolved; `matches`/`delivered` are the
/// installer-output evidence that now decides the pnpm class (aimed + delivered
/// => shadowing/blocking; aimed + undelivered => shortfall; unaimed => the
/// non-blocking `installer-unaimed` shape, bounded per episode).
#[allow(clippy::too_many_arguments)]
fn pnpm_context<'a>(
    hq_bin: &'a str,
    pnpm_bin: &'a str,
    home_source: PnpmHomeSource,
    path_has_shim_dir: bool,
    matches: Option<bool>,
    delivered: Option<&'a str>,
    already_blocked: bool,
) -> PostInstallContext<'a> {
    PostInstallContext {
        executor: InstallExecutor::Pnpm,
        before_bin: hq_bin,
        after_bin: hq_bin,
        before_version: None,
        after_version: Some("5.77.14"),
        latest: "5.84.0",
        npm_prefix_passed: None,
        delivered_version: delivered,
        installer_bin: pnpm_bin,
        already_blocked,
        // Default fixtures are first-occurrence (empty episode set); tests that
        // exercise the non-blocking episode bound pass their own set.
        nonblocking_episode_keys: &[],
        managed_roots: &[],
        managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
        pnpm: Some(PnpmRunDiagnostics {
            home_source,
            home_env_present: false,
            path_has_shim_dir,
            global_bin_dir_matches_shim_dir: matches,
            store_family: PnpmStoreFamily::V11,
            authoritative_query_ok: delivered.is_some(),
            exit_status: "0".to_string(),
            output_len: 128,
        }),
    }
}

/// Drive the real decision seam, the real effects executor, and the real
/// reporter through `hq_telemetry::before_send`, exactly as production does.
fn composed_non_convergent_events(
    ctx: &PostInstallContext<'_>,
    durable_record: bool,
) -> (Vec<sentry::protocol::Event<'static>>, usize, usize, usize) {
    let records = Cell::new(0usize);
    let captures = Cell::new(0usize);
    let record_failures = Cell::new(0usize);
    let events = captured_events(|| {
        let outcome = decide_post_install(ctx);
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
            report_non_convergent_install(&report);
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
    assert_non_convergent_shape(
        event,
        "npm",
        expected_kind,
        expected_hq_source,
        expected_hq_bin,
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
        ("npm_bin_source", expected_npm_source),
        ("prefix_known", expected_prefix_known),
    ] {
        assert_eq!(
            event.tags.get(tag).map(String::as_str),
            Some(expected),
            "unexpected {tag} tag"
        );
    }
    assert_eq!(
        event.extra.get("npm_prefix").and_then(Value::as_str),
        Some(expected_prefix)
    );
}

/// The executor-neutral shape every non-convergent event must have, whichever
/// package manager produced it. The fingerprint assertion is load-bearing: new
/// tags must never split the existing Sentry group.
fn assert_non_convergent_shape(
    event: &sentry::protocol::Event<'_>,
    expected_executor: &str,
    expected_kind: &str,
    expected_hq_source: &str,
    expected_hq_bin: &str,
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
    let expected_installer_source = if cfg!(target_os = "windows") {
        "unknown"
    } else {
        "homebrew"
    };
    for (tag, expected) in [
        ("hq_cli_update_kind", "install-non-convergent"),
        ("install_executor", expected_executor),
        ("non_convergence_kind", expected_kind),
        ("latest", "5.84.0"),
        ("local", "5.77.14"),
        ("hq_bin_source", expected_hq_source),
        ("installer_bin_source", expected_installer_source),
        ("hq_bin_changed", "false"),
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
            composed_non_convergent_events(&npm_context(&hq_bin, None, false), true);
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
            composed_non_convergent_events(&npm_context(&hq_bin, None, false), false);
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
            composed_non_convergent_events(&npm_context(&hq_bin, None, true), true);
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
        composed_non_convergent_events(&npm_context(&hq_bin, Some(&prefix), true), true);
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

/// HQ-DESKTOP-46, era 2. The three live 2026-08-06 events came from the pnpm
/// executor but rendered as npm runs against npm's default prefix, because the
/// pnpm branch hardcoded `prefix = None` into the npm-shaped reporter and no
/// tag said which package manager had run. This is the artifact-level proof
/// that a pnpm run is now self-identifying.
#[test]
fn pnpm_non_convergence_names_its_executor_and_drops_the_npm_prefix_placeholder() {
    let home = hq_desktop_core::paths::home_dir().expect("test home directory");
    let home_text = home.to_string_lossy().to_string();
    // The exact layout from the live events: pnpm >=11 nests its shims one
    // level below the pnpm home.
    let hq_bin = home
        .join("Library/pnpm/bin/hq")
        .to_string_lossy()
        .to_string();
    let expected_hq_source = if cfg!(target_os = "windows") {
        "unknown"
    } else {
        "pnpm"
    };

    let (events, records, captures, record_failures) = composed_non_convergent_events(
        &pnpm_context(
            &hq_bin,
            "/opt/homebrew/bin/pnpm",
            PnpmHomeSource::NestedBinDir,
            true,
            // Genuine shadowing: pnpm aimed at the right dir AND delivered the
            // target, yet the shim is stale — the loud, blocking class.
            Some(true),
            Some("5.84.0"),
            false,
        ),
        true,
    );
    assert_eq!(records, 1);
    assert_eq!(captures, 1);
    assert_eq!(record_failures, 0);
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_non_convergent_shape(
        event,
        "pnpm",
        "pnpm-targeted",
        expected_hq_source,
        "~/Library/pnpm/bin/hq",
    );
    // The lie the live events told. A pnpm run passes no npm prefix, so it must
    // not borrow npm's "npm default prefix" placeholder — nor its prefix_known
    // tag, which is meaningless for pnpm.
    assert!(
        !event.extra.contains_key("npm_prefix"),
        "a pnpm run must not carry an npm_prefix extra: {:?}",
        event.extra
    );
    assert!(
        !event.tags.contains_key("prefix_known"),
        "a pnpm run must not carry npm's prefix_known tag: {:?}",
        event.tags
    );
    // The instrumentation that makes the remaining sub-cause decidable on the
    // next occurrence, as closed categories that survive the scrubber.
    for (tag, expected) in [
        ("pnpm_home_source", "nested-bin-dir"),
        ("pnpm_home_env_present", "false"),
        ("pnpm_path_has_shim_dir", "true"),
        // The native-direction diagnostic (now informational only).
        ("pnpm_global_bin_dir_matches_shim_dir", "true"),
        // The r3 self-diagnosing tokens: which store family we saw and whether
        // pnpm's own delivery answer was available.
        ("pnpm_store_family", "v11"),
        ("pnpm_authoritative_query_ok", "true"),
        // A pnpm run now names its requested and delivered versions too.
        ("requested_version", "5.84.0"),
        ("delivered_version", "5.84.0"),
    ] {
        assert_eq!(
            event.tags.get(tag).map(String::as_str),
            Some(expected),
            "unexpected {tag} tag"
        );
    }
    assert_eq!(
        event.extra.get("pnpm_diagnostics").and_then(Value::as_str),
        Some(
            "home_source=nested-bin-dir home_env_present=false path_has_shim_dir=true \
             global_bin_dir_matches_shim_dir=true store_family=v11 authoritative_query_ok=true \
             exit_status=0 output_len=128"
        )
    );
    let serialized = serde_json::to_string(event).expect("serialize event");
    assert!(
        !serialized.contains(&home_text),
        "no absolute home path may reach the captured event"
    );
    for forbidden in ["/Users/", "/home/"] {
        assert!(
            !serialized.contains(forbidden),
            "pnpm non-convergence event leaked {forbidden:?}"
        );
    }
}

/// A pnpm run we could NOT aim (no derivable home, or a child PATH without the
/// shim's directory) is the non-blocking `installer-unaimed` shape: it writes NO
/// durable marker, stays observable, and is bounded to one capture per episode.
/// On the base commit this was `foreign-managed` — it wrote the pinned marker
/// and wedged auto-update. The episode is keyed on `(latest, executor, kind,
/// home_source)`, so the second occurrence (with that key already recorded) is
/// suppressed.
#[test]
fn undetermined_pnpm_home_is_reported_as_installer_unaimed_and_stays_bounded() {
    let home = hq_desktop_core::paths::home_dir().expect("test home directory");
    let hq_bin = home.join(".asdf/shims/hq").to_string_lossy().to_string();
    let expected_hq_source = if cfg!(target_os = "windows") {
        "unknown"
    } else {
        "login-shell"
    };

    let (events, records, captures, record_failures) = composed_non_convergent_events(
        &pnpm_context(
            &hq_bin,
            "/opt/homebrew/bin/pnpm",
            PnpmHomeSource::Undetermined,
            false,
            // Unaimed: no direction probe, no delivery evidence.
            None,
            None,
            false,
        ),
        true,
    );
    assert_eq!(records, 0, "an unaimed run writes no durable marker");
    assert_eq!(captures, 1);
    assert_eq!(record_failures, 0);
    assert_eq!(events.len(), 1);
    assert_non_convergent_shape(
        &events[0],
        "pnpm",
        "installer-unaimed",
        expected_hq_source,
        "~/.asdf/shims/hq",
    );
    assert_eq!(
        events[0].tags.get("pnpm_home_source").map(String::as_str),
        Some("undetermined")
    );

    // Repeat episode: the non-blocking bound suppresses it once its key is known.
    let key = non_convergent_episode_key(
        "5.84.0",
        InstallExecutor::Pnpm,
        NonConvergenceKind::InstallerUnaimed,
        Some(PnpmHomeSource::Undetermined),
    );
    let seen = [key];
    let (events, records, captures, record_failures) = composed_non_convergent_events(
        &pnpm_context(
            &hq_bin,
            "/opt/homebrew/bin/pnpm",
            PnpmHomeSource::Undetermined,
            false,
            None,
            None,
            false,
        )
        .with_nonblocking_episode_keys(&seen),
        true,
    );
    assert!(events.is_empty());
    assert_eq!(records, 0);
    assert_eq!(captures, 0);
    assert_eq!(record_failures, 0);
}

/// The live Zekes envelope: the app resolves an npx-cache `hq` npm can never
/// move. The captured event names its own mechanism — `installer-unaimed` +
/// `hq_bin_source=npx-cache` + `managed_shadow_repair=not-attempted` — carries
/// the requested/delivered/local versions, keeps the existing Sentry group, and
/// ships NO raw home path (the hq_bin extra is home-redacted).
#[test]
fn the_npx_cache_shape_captures_installer_unaimed_with_no_raw_home_path() {
    let home = hq_desktop_core::paths::home_dir().expect("test home directory");
    let home_text = home.to_string_lossy().to_string();
    let hq_bin = home
        .join(".npm/_npx/91dc460cc0784cc8/node_modules/.bin/hq")
        .to_string_lossy()
        .to_string();
    let managed_prefix = home
        .join("Library/Application Support/Indigo HQ/toolchain/npm-global")
        .to_string_lossy()
        .to_string();
    let ctx = PostInstallContext::npm(
        &hq_bin,
        &hq_bin,
        Some("5.103.1"),
        Some("5.103.1"),
        "5.103.18",
        Some(&managed_prefix),
        "/opt/homebrew/bin/npm",
        false,
        Some("5.103.18"),
    );
    let (events, records, captures, record_failures) = composed_non_convergent_events(&ctx, true);
    assert_eq!(records, 0, "an npx-cache copy writes no durable marker");
    assert_eq!(captures, 1);
    assert_eq!(record_failures, 0);
    assert_eq!(events.len(), 1);
    let event = &events[0];
    // The group must not split — new tags/values ride the existing fingerprint.
    assert_eq!(
        fingerprint(event),
        ["hq-cli-update", "install-non-convergent"]
    );
    for (tag, expected) in [
        ("install_executor", "npm"),
        ("non_convergence_kind", "installer-unaimed"),
        ("managed_shadow_repair", "not-attempted"),
        ("hq_bin_source", "npx-cache"),
        ("latest", "5.103.18"),
        ("requested_version", "5.103.18"),
        ("delivered_version", "5.103.18"),
        ("local", "5.103.1"),
    ] {
        assert_eq!(
            event.tags.get(tag).map(String::as_str),
            Some(expected),
            "unexpected {tag} tag"
        );
    }
    assert_eq!(
        event.extra.get("hq_bin").and_then(Value::as_str),
        Some("~/.npm/_npx/91dc460cc0784cc8/node_modules/.bin/hq")
    );
    let serialized = serde_json::to_string(event).expect("serialize event");
    assert!(
        !serialized.contains(&home_text),
        "npx-cache event leaked a raw home path"
    );
}

/// The volume guarantee: two consecutive runs of the SAME npx-cache episode emit
/// exactly ONE envelope. The second run already sees the episode key, so it
/// captures nothing — the fix cannot increase Sentry volume over the base.
#[test]
fn the_npx_cache_episode_emits_exactly_one_envelope_across_two_runs() {
    let hq_bin = "/Users/z/.npm/_npx/91dc460cc0784cc8/node_modules/.bin/hq";
    let managed_prefix = "/Users/z/Library/Application Support/Indigo HQ/toolchain/npm-global";
    let base = || {
        PostInstallContext::npm(
            hq_bin,
            hq_bin,
            Some("5.103.1"),
            Some("5.103.1"),
            "5.103.18",
            Some(managed_prefix),
            "/opt/homebrew/bin/npm",
            false,
            Some("5.103.18"),
        )
    };

    // First run: empty episode set => captures once.
    let (events, _records, captures, _rf) = composed_non_convergent_events(&base(), true);
    assert_eq!(captures, 1);
    assert_eq!(events.len(), 1);

    // Second run with the recorded key => suppressed. `install_executor=npm`, so
    // the episode home_source is `None` (no pnpm diagnostics).
    let key = non_convergent_episode_key(
        "5.103.18",
        InstallExecutor::Npm,
        NonConvergenceKind::InstallerUnaimed,
        None,
    );
    let seen = [key];
    let (events, _records, captures, _rf) =
        composed_non_convergent_events(&base().with_nonblocking_episode_keys(&seen), true);
    assert!(events.is_empty(), "a repeat episode must emit nothing");
    assert_eq!(captures, 0);
}

#[test]
fn unreadable_version_capture_keeps_only_closed_diagnostics_and_stable_grouping_after_scrubbing() {
    let probes = LocalVersionProbeDiagnostics {
        binary_anchor: VersionProbeOutcome::PackageNotFound,
        npm_root: VersionProbeOutcome::NonzeroExit,
        hq_version: VersionProbeOutcome::InterpreterNotFound,
        binary_anchor_shape: BinaryAnchorShape::FlatGlobalBin,
        resolved_program_kind: ResolvedProgramKind::Exe,
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
                "resolved_program_kind": "exe",
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

/// HQ-DESKTOP-3P: replay the exact production probe quadruple the Windows field
/// events carried and prove the widened payload names the resolver's program
/// classification. `resolved_program_kind` is absent from the emitted extras on
/// the base commit, so this fails there and passes on the candidate.
#[test]
fn production_field_quadruple_capture_carries_the_resolved_program_kind() {
    let probes = LocalVersionProbeDiagnostics {
        binary_anchor: VersionProbeOutcome::PackageNotFound,
        npm_root: VersionProbeOutcome::PackageNotFound,
        hq_version: VersionProbeOutcome::SpawnNotExecutable,
        binary_anchor_shape: BinaryAnchorShape::NpmPrefix,
        resolved_program_kind: ResolvedProgramKind::Extensionless,
    };

    let events = captured_events(|| report_unreadable_version("5.94.1", &probes));
    assert_eq!(events.len(), 1);
    let event = &events[0];

    let Some(Value::Object(recorded)) = event.extra.get("hq_cli_version_probes") else {
        panic!(
            "the probe diagnostics extra must be an object: {:?}",
            event.extra
        );
    };
    assert_eq!(
        recorded.get("resolved_program_kind"),
        Some(&Value::String("extensionless".into())),
        "a resolution Windows cannot execute must be named in the event"
    );
    assert_eq!(
        recorded.get("hq_version"),
        Some(&Value::String("spawn_not_executable".into())),
        "the split spawn classes must survive serialization"
    );

    // Grouping and message are untouched, so HQ-DESKTOP-3P does not split.
    assert_eq!(
        event
            .fingerprint
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>(),
        ["{{ default }}"]
    );
    assert_eq!(
        event.message.as_deref(),
        Some(
            "[hq-cli-update] hq is installed but its version could not be read \
             (binary-anchor, npm root, and hq --version all failed)"
        )
    );

    // Still path-free: no filesystem path, home directory, account name, or
    // command output may ride along with the widened payload.
    let serialized = serde_json::to_string(&event).unwrap();
    for leak in ["/Users/", "C:\\\\", "\\\\Users", "AppData", "fixture"] {
        assert!(
            !serialized.contains(leak),
            "unreadable-version telemetry must stay path-free, found {leak}: {serialized}"
        );
    }
}

/// The anti-silencing counterpart, end to end: a marked-non-spawnable
/// resolution with every probe failed must still emit EXACTLY ONE
/// version-unreadable event. The signal is what tells the team a user's CLI is
/// installed but unusable; dropping the resolution to "not installed" would
/// make this zero.
#[test]
fn no_spawnable_sibling_shape_still_emits_exactly_one_unreadable_event() {
    let probes = LocalVersionProbeDiagnostics {
        binary_anchor: VersionProbeOutcome::PackageNotFound,
        npm_root: VersionProbeOutcome::PackageNotFound,
        hq_version: VersionProbeOutcome::SpawnNotExecutable,
        binary_anchor_shape: BinaryAnchorShape::NpmPrefix,
        resolved_program_kind: ResolvedProgramKind::Extensionless,
    };

    let events = captured_events(|| report_unreadable_version("5.94.1", &probes));

    assert_eq!(
        events.len(),
        1,
        "an installed-but-unusable CLI must keep producing its warning"
    );
    assert_eq!(events[0].level, sentry::Level::Warning);
    assert_eq!(
        events[0].tags.get("hq_cli_update_kind").map(String::as_str),
        Some("version-unreadable")
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
    // The title carries the bounded grouping signature, not npm's exit status.
    assert_eq!(
        event.message.as_deref(),
        Some("[hq-cli-update] install failed (EACCES:mkdir:other)")
    );
    assert_eq!(
        event
            .fingerprint
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>(),
        [
            "hq-cli-update",
            "install-failed",
            "unexpected",
            "EACCES:mkdir:other"
        ]
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
                "error_code=EACCES syscall=mkdir path_shape=other prefix_known=false eacces=true exit_code=1 errno=unknown stderr_len={unexpected_eacces_len} lifecycle_cause=none node_version=unknown node_abi=unknown npm_version=unknown toolchain_source=unknown"
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
        Some("none")
    );

    let transient_network = "npm error code ECONNRESET\nnpm error network request reset";
    let events = captured_events(|| report_install_failure(Some(1), transient_network, None));
    assert!(
        events.is_empty(),
        "the current transient-registry classifier must stay suppressed"
    );

    // A full disk (ENOSPC) is a local-machine condition, not an updater defect,
    // so it is now suppressed as an expected disk-full failure (HQ-DESKTOP-53) —
    // the same treatment as the EACCES/transient cases above. It previously fell
    // through to Unexpected and paged once at Error with npm_error_code=ENOSPC.
    let storage = "npm error code ENOSPC\nnpm error path /usr/local/lib/node_modules/@indigoai-us";
    let events = captured_events(|| report_install_failure(Some(1), storage, None));
    assert!(
        events.is_empty(),
        "a full disk (ENOSPC) must be suppressed as an expected disk-full failure, got {events:?}"
    );
}

/// The registry-race capture, end to end: npm was aimed at the resolved
/// binary's own prefix but delivered N-1 (the target never propagated). Driven
/// through the real decision seam, effects executor, and reporter and scrubbed
/// by `hq_telemetry::before_send`, it must (1) write NO blocking marker, (2)
/// name itself as a resolution shortfall carrying delivered-vs-requested version
/// tags, (3) keep the stable fingerprint so it does not split the group, and
/// (4) stay path-free.
#[test]
fn a_resolution_shortfall_names_itself_and_does_not_render_as_a_targeted_layout_defect() {
    let home = hq_desktop_core::paths::home_dir().expect("test home directory");
    let home_text = home.to_string_lossy().to_string();
    let prefix = home.join(".npm-global").to_string_lossy().to_string();
    let hq_bin = home
        .join(".npm-global/bin/hq")
        .to_string_lossy()
        .to_string();
    let ctx = PostInstallContext::npm(
        &hq_bin,
        &hq_bin,
        Some("5.83.0"),
        Some("5.83.0"),
        "5.84.0",
        Some(&prefix),
        "/opt/homebrew/bin/npm",
        false,
        Some("5.83.0"), // delivered short of the 5.84.0 target
    );

    let (events, records, captures, record_failures) = composed_non_convergent_events(&ctx, true);
    assert_eq!(
        records, 0,
        "a resolution shortfall must write no blocking marker"
    );
    assert_eq!(captures, 1);
    assert_eq!(record_failures, 0);
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.level, sentry::Level::Warning);
    // Grouping does NOT split: the fingerprint is unchanged.
    assert_eq!(
        fingerprint(event),
        ["hq-cli-update", "install-non-convergent"]
    );
    assert_eq!(
        event.tags.get("non_convergence_kind").map(String::as_str),
        Some("resolution-shortfall"),
        "it must name its own mechanism, not a targeted layout defect"
    );
    assert_eq!(
        event.tags.get("requested_version").map(String::as_str),
        Some("5.84.0")
    );
    assert_eq!(
        event.tags.get("delivered_version").map(String::as_str),
        Some("5.83.0")
    );
    // Path-free after the real scrubber.
    let serialized = serde_json::to_string(event).expect("serialize event");
    assert!(!serialized.contains(&home_text));
    for forbidden in ["/Users/", "/home/"] {
        assert!(
            !serialized.contains(forbidden),
            "resolution-shortfall event leaked {forbidden:?}: {serialized}"
        );
    }
}

/// Genuine shadowing (the installer delivered the target INTO the prefix but a
/// copy earlier on PATH still wins) is a real defect. It must remain loud on
/// EVERY occurrence — even an already-blocked episode — and keep its durable
/// block, unchanged by this change.
#[test]
fn true_shadowing_still_captures_loudly_on_every_occurrence_with_a_durable_block() {
    let home = hq_desktop_core::paths::home_dir().expect("test home directory");
    let prefix = home.join(".npm-global").to_string_lossy().to_string();
    let hq_bin = home
        .join(".npm-global/bin/hq")
        .to_string_lossy()
        .to_string();
    let ctx = PostInstallContext::npm(
        &hq_bin,
        &hq_bin,
        Some("5.77.14"),
        Some("5.77.14"),
        "5.84.0",
        Some(&prefix),
        "/opt/homebrew/bin/npm",
        true,           // already blocked — a real defect stays loud anyway
        Some("5.84.0"), // delivered == target: genuine shadowing
    );

    let (events, records, captures, record_failures) = composed_non_convergent_events(&ctx, true);
    assert_eq!(records, 1, "genuine shadowing keeps the durable block");
    assert_eq!(captures, 1);
    assert_eq!(record_failures, 0);
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(
        event.tags.get("non_convergence_kind").map(String::as_str),
        Some("npm-targeted")
    );
    assert_eq!(
        event.tags.get("delivered_version").map(String::as_str),
        Some("5.84.0")
    );
    assert_eq!(
        fingerprint(event),
        ["hq-cli-update", "install-non-convergent"]
    );
}

/// Replay the exact tag shape captured on 2026-08-09T00:47:11Z (npm executor,
/// prefix known, hq_bin unchanged, managed-toolchain hq bin, delivered 5.97.0
/// against target 5.97.1). Under the old contract it was npm-targeted and
/// blocking; under the delivery-evidence contract it must reclassify as a
/// non-blocking resolution shortfall.
#[test]
fn the_2026_08_09_field_event_shape_reclassifies_under_the_new_contract() {
    let home = hq_desktop_core::paths::home_dir().expect("test home directory");
    // The managed-toolchain npm-global layout the field event carried.
    let prefix = home
        .join("Library/Application Support/Indigo HQ/toolchain/npm-global")
        .to_string_lossy()
        .to_string();
    let hq_bin = format!("{prefix}/bin/hq");
    let ctx = PostInstallContext::npm(
        &hq_bin,
        &hq_bin, // hq_bin_changed = false, as in the field event
        Some("5.97.0"),
        Some("5.97.0"),
        "5.97.1",
        Some(&prefix),
        "/usr/local/bin/npm",
        false,
        Some("5.97.0"), // delivered N-1
    );

    let (events, records, captures, _record_failures) = composed_non_convergent_events(&ctx, true);
    assert_eq!(
        records, 0,
        "the field event must no longer wedge auto-update"
    );
    assert_eq!(captures, 1);
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(
        event.tags.get("non_convergence_kind").map(String::as_str),
        Some("resolution-shortfall")
    );
    assert_eq!(
        event.tags.get("requested_version").map(String::as_str),
        Some("5.97.1")
    );
    assert_eq!(
        event.tags.get("delivered_version").map(String::as_str),
        Some("5.97.0")
    );
    assert_eq!(
        event.tags.get("hq_bin_changed").map(String::as_str),
        Some("false")
    );
}

/// HQ-DESKTOP-46, era 3 (the r2 reopen) — the recurrence closed at the reporting
/// boundary. Replay the exact 2026-08-10 pnpm >=11 field shape with the
/// candidate's store fix in effect: the package IS delivered into
/// `<home>/global/v11/<hash>/node_modules`, so both the delivery read AND the
/// executed-shim reading now reach `latest`. The run therefore CONVERGES and
/// produces NO Sentry event — where the base commit (blind to the v11 store) read
/// delivered/executed as stale and captured an install-non-convergent event on
/// every check. pnpm's native `pnpm bin -g` direction is `Some(false)` here (the
/// flat home, not the forced nested bin dir) and no longer changes the outcome.
#[test]
fn the_2026_08_10_pnpm_field_event_now_converges_and_captures_nothing() {
    let home = hq_desktop_core::paths::home_dir().expect("test home directory");
    let hq_bin = home
        .join("Library/pnpm/bin/hq")
        .to_string_lossy()
        .to_string();
    let ctx = PostInstallContext {
        executor: InstallExecutor::Pnpm,
        before_bin: &hq_bin,
        after_bin: &hq_bin,
        before_version: None,
        // The executed shim now resolves the v11 store, reaching latest.
        after_version: Some("5.97.2"),
        latest: "5.97.2",
        npm_prefix_passed: None,
        delivered_version: Some("5.97.2"),
        installer_bin: "/opt/homebrew/bin/pnpm",
        already_blocked: false,
        nonblocking_episode_keys: &[],
        managed_roots: &[],
        managed_shadow_repair: ManagedShadowRepairOutcome::NotAttempted,
        pnpm: Some(PnpmRunDiagnostics {
            home_source: PnpmHomeSource::NestedBinDir,
            home_env_present: false,
            path_has_shim_dir: true,
            // The native direction legitimately differs on a nested layout; it is
            // a diagnostic only and no longer forces a non-convergent class.
            global_bin_dir_matches_shim_dir: Some(false),
            store_family: PnpmStoreFamily::V11,
            authoritative_query_ok: true,
            exit_status: "0".to_string(),
            output_len: 96,
        }),
    };

    let clears = Cell::new(0usize);
    let events = captured_events(|| {
        let outcome = decide_post_install(&ctx);
        assert_eq!(
            outcome.verdict,
            ConvergenceVerdict::Converged,
            "the fixed field shape converges"
        );
        assert!(outcome.clear_non_convergent);
        assert!(outcome.capture.is_none());
        assert!(outcome.record_non_convergent.is_none());
        assert!(outcome.record_nonblocking_episode.is_none());
        let record = |_v: String| panic!("a converged field event must not record a marker");
        let clear = || clears.set(clears.get() + 1);
        let capture = |_r: NonConvergentReport| panic!("a converged field event must not capture");
        let record_failure = |_e: String| panic!("no marker failure on a converged run");
        let result = apply_post_install_effects(
            &outcome,
            &PostInstallCoreEffects {
                record: &record,
                clear: &clear,
                capture: &capture,
                record_failure: &record_failure,
            },
        );
        assert!(result.is_ok(), "the fixed field shape is a success");
    });
    assert!(
        events.is_empty(),
        "the recurrence is closed: no Sentry event for the fixed field shape"
    );
    assert_eq!(
        clears.get(),
        1,
        "a converged install clears any stale non-convergent marker"
    );
}

/// The 16:13:33 (0.10.94) / 16:14:27 (0.10.95) double-fire — a persistent,
/// genuinely-undelivered pnpm shortfall reported twice across an app self-update —
/// collapses to ONE event under the non-blocking episode bound. Same environment
/// shape and same `latest`; the second occurrence carries the persisted episode
/// key the first produced, so it captures nothing and still never blocks.
#[test]
fn a_persistent_pnpm_shortfall_captures_once_across_checks_and_an_app_restart() {
    let hq_bin = "/Users/t/Library/pnpm/bin/hq";
    // First occurrence, empty episode set: captures once, writes no durable block.
    let first_ctx = pnpm_context(
        hq_bin,
        "/opt/homebrew/bin/pnpm",
        PnpmHomeSource::NestedBinDir,
        true,
        Some(false),    // native direction differs on a nested layout — diagnostic only
        Some("5.83.0"), // pnpm's own answer: the store still holds N-1
        false,
    );
    let (events1, records1, captures1, _) = composed_non_convergent_events(&first_ctx, true);
    assert_eq!(captures1, 1, "the first occurrence is reported");
    assert_eq!(records1, 0, "a shortfall never wedges auto-update");
    assert_eq!(events1.len(), 1);
    let key = decide_post_install(&first_ctx)
        .record_nonblocking_episode
        .expect("the first capture yields an episode key to persist");
    assert_eq!(
        key,
        non_convergent_episode_key(
            "5.84.0",
            InstallExecutor::Pnpm,
            NonConvergenceKind::ResolutionShortfall,
            Some(PnpmHomeSource::NestedBinDir),
        )
    );

    // Second occurrence (a later check or the 16:14 app-restart event) with the
    // key already persisted: not captured, still not blocking.
    let keys = [key];
    let mut second_ctx = pnpm_context(
        hq_bin,
        "/opt/homebrew/bin/pnpm",
        PnpmHomeSource::NestedBinDir,
        true,
        Some(false),
        Some("5.83.0"),
        false,
    );
    second_ctx.nonblocking_episode_keys = &keys;
    let (events2, records2, captures2, _) = composed_non_convergent_events(&second_ctx, true);
    assert_eq!(captures2, 0, "the double-fire collapses to a single event");
    assert_eq!(records2, 0);
    assert!(events2.is_empty());
}

/// The pnpm executor no longer hardcodes `delivered_version: None`. A
/// non-convergence aimed at the right dir but delivered N-1 (the registry had not
/// propagated the target) renders as a resolution shortfall that names both its
/// requested and delivered versions plus the bounded bin-dir-match boolean, with
/// no absolute path in any tag and home redaction intact.
#[test]
fn a_pnpm_non_convergence_names_its_requested_and_delivered_versions() {
    let home = hq_desktop_core::paths::home_dir().expect("test home directory");
    let home_text = home.to_string_lossy().to_string();
    let hq_bin = home
        .join("Library/pnpm/bin/hq")
        .to_string_lossy()
        .to_string();
    let (events, records, captures, _record_failures) = composed_non_convergent_events(
        &pnpm_context(
            &hq_bin,
            "/opt/homebrew/bin/pnpm",
            PnpmHomeSource::NestedBinDir,
            true,
            Some(true),     // aimed at the right dir
            Some("5.83.0"), // but the store still holds N-1
            false,
        ),
        true,
    );
    assert_eq!(records, 0, "a shortfall must not wedge auto-update");
    assert_eq!(captures, 1);
    assert_eq!(events.len(), 1);
    let event = &events[0];
    for (tag, expected) in [
        ("non_convergence_kind", "resolution-shortfall"),
        ("requested_version", "5.84.0"),
        ("delivered_version", "5.83.0"),
        ("pnpm_global_bin_dir_matches_shim_dir", "true"),
    ] {
        assert_eq!(
            event.tags.get(tag).map(String::as_str),
            Some(expected),
            "unexpected {tag} tag"
        );
    }
    // Path-free after the real scrubber; home redaction intact on extras.
    let serialized = serde_json::to_string(event).expect("serialize event");
    assert!(!serialized.contains(&home_text));
    for forbidden in ["/Users/", "/home/"] {
        assert!(
            !serialized.contains(forbidden),
            "pnpm shortfall event leaked {forbidden:?}"
        );
    }
}

/// The invariant the fix must never break, end to end: a genuine pnpm shadowing
/// defect — pnpm's effective global bin dir IS the dir holding the executed shim
/// AND the target WAS delivered into the store, yet the shim still reports the old
/// version — survives `before_send` unchanged and still writes its durable block,
/// on every occurrence including an already-blocked episode.
#[test]
fn true_pnpm_shadowing_still_captures_loudly_on_every_occurrence_with_a_durable_block() {
    let home = hq_desktop_core::paths::home_dir().expect("test home directory");
    let hq_bin = home
        .join("Library/pnpm/bin/hq")
        .to_string_lossy()
        .to_string();
    let (events, records, captures, _record_failures) = composed_non_convergent_events(
        &pnpm_context(
            &hq_bin,
            "/opt/homebrew/bin/pnpm",
            PnpmHomeSource::NestedBinDir,
            true,
            Some(true),     // pnpm aimed at the right dir
            Some("5.84.0"), // and delivered the target
            true,           // already blocked — a real defect stays loud anyway
        ),
        true,
    );
    assert_eq!(records, 1, "genuine pnpm shadowing keeps the durable block");
    assert_eq!(captures, 1);
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(
        event.tags.get("non_convergence_kind").map(String::as_str),
        Some("pnpm-targeted")
    );
    assert_eq!(
        event.tags.get("delivered_version").map(String::as_str),
        Some("5.84.0")
    );
    assert_eq!(
        event
            .tags
            .get("pnpm_global_bin_dir_matches_shim_dir")
            .map(String::as_str),
        Some("true")
    );
    assert_eq!(
        fingerprint(event),
        ["hq-cli-update", "install-non-convergent"]
    );
}

/// The managed-shadow artifact contract (HQ-DESKTOP-46): a run whose self-repair
/// CONVERGES emits NO event, while a run whose repair could not converge emits
/// exactly one event tagged `non_convergence_kind=managed-shadowed` plus the
/// closed `managed_shadow_repair` outcome, with `hq_bin` and `npm_prefix`
/// home-redacted. Production discards the pre-repair decision and applies only
/// the re-decide, so this mirrors that: only the second decision's effects run.
/// On the base commit this same input is tagged `foreign-managed`, always writes
/// the marker, and carries no repair tag.
#[test]
fn managed_shadow_repair_outcomes_drive_the_captured_envelope() {
    let home = hq_desktop_core::paths::home_dir().expect("test home directory");
    let home_text = home.to_string_lossy().to_string();
    let root = home
        .join("AppData")
        .join("Local")
        .join("IndigoHQ")
        .join("toolchain");
    let roots = [root.clone()];
    let npm_prefix = root.join("npm-prefix").to_string_lossy().to_string();
    let node_shim = root
        .join("node")
        .join("hq.cmd")
        .to_string_lossy()
        .to_string();
    let prefix_shim = root
        .join("npm-prefix")
        .join("hq.cmd")
        .to_string_lossy()
        .to_string();
    let latest = "5.101.7";

    // A converged repair: the app now resolves the prefix copy at latest, so the
    // re-decide is a plain success — no event, marker cleared.
    let clears = Cell::new(0usize);
    let converged_events = captured_events(|| {
        let ctx = PostInstallContext::npm(
            &node_shim,
            &prefix_shim,
            Some("5.101.0"),
            Some(latest),
            latest,
            Some(&npm_prefix),
            &node_shim,
            false,
            Some(latest),
        )
        .with_managed_roots(&roots)
        .with_managed_shadow_repair(ManagedShadowRepairOutcome::Converged);
        let outcome = decide_post_install(&ctx);
        assert!(outcome.capture.is_none());
        assert!(outcome.non_convergence_kind.is_none());
        let record = |_v: String| panic!("a converged repair must not record a marker");
        let clear = || clears.set(clears.get() + 1);
        let capture = |_r: NonConvergentReport| panic!("a converged repair must not capture");
        let record_failure = |_e: String| panic!("no marker failure on a converged repair");
        let _ = apply_post_install_effects(
            &outcome,
            &PostInstallCoreEffects {
                record: &record,
                clear: &clear,
                capture: &capture,
                record_failure: &record_failure,
            },
        );
    });
    assert!(
        converged_events.is_empty(),
        "a converged repair emits no event"
    );
    assert_eq!(clears.get(), 1);

    // A repair that could not converge: still shadowed, so it falls back to the
    // foreign-managed policy — one event, tagged managed-shadowed + repair-failed.
    let events = captured_events(|| {
        let ctx = PostInstallContext::npm(
            &node_shim,
            &node_shim,
            Some("5.101.0"),
            Some("5.101.0"),
            latest,
            Some(&npm_prefix),
            &node_shim,
            false,
            Some(latest),
        )
        .with_managed_roots(&roots)
        .with_managed_shadow_repair(ManagedShadowRepairOutcome::RepairFailed);
        let outcome = decide_post_install(&ctx);
        assert_eq!(
            outcome.non_convergence_kind,
            Some(NonConvergenceKind::ManagedShadowed)
        );
        let record = |_v: String| Ok(());
        let clear = || panic!("a non-convergent repair must not clear the marker");
        let capture = |report: NonConvergentReport| report_non_convergent_install(&report);
        let record_failure = |_e: String| panic!("the marker write succeeds on this path");
        let _ = apply_post_install_effects(
            &outcome,
            &PostInstallCoreEffects {
                record: &record,
                clear: &clear,
                capture: &capture,
                record_failure: &record_failure,
            },
        );
    });
    assert_eq!(
        events.len(),
        1,
        "a repair that did not converge captures once"
    );
    let event = &events[0];
    assert_eq!(
        event.tags.get("install_executor").map(String::as_str),
        Some("npm")
    );
    assert_eq!(
        event.tags.get("non_convergence_kind").map(String::as_str),
        Some("managed-shadowed")
    );
    assert_eq!(
        event.tags.get("managed_shadow_repair").map(String::as_str),
        Some("repair-failed")
    );
    // Home-redacted: neither the hq_bin nor the npm_prefix extra leaks the home
    // directory, exactly like every other non-convergent event.
    let hq_bin_extra = event
        .extra
        .get("hq_bin")
        .and_then(Value::as_str)
        .expect("hq_bin extra");
    assert!(hq_bin_extra.starts_with('~'), "hq_bin is home-redacted");
    assert!(hq_bin_extra.contains("hq.cmd"));
    let npm_prefix_extra = event
        .extra
        .get("npm_prefix")
        .and_then(Value::as_str)
        .expect("npm_prefix extra");
    assert!(
        npm_prefix_extra.starts_with('~'),
        "npm_prefix is home-redacted"
    );
    let serialized = serde_json::to_string(event).expect("serialize event");
    assert!(
        !serialized.contains(&home_text),
        "the managed-shadow event leaked the home directory"
    );
    assert_eq!(
        fingerprint(event),
        ["hq-cli-update", "install-non-convergent"],
        "the managed-shadow event never splits the existing Sentry group"
    );
}
