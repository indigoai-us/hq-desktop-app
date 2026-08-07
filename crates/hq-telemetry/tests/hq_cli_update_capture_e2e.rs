use std::cell::Cell;
use std::sync::Arc;

use hq_desktop_core::hq_cli_update::{
    apply_post_install_effects, decide_post_install, report_install_failure,
    report_non_convergent_install, report_unreadable_version, BinaryAnchorShape, InstallExecutor,
    LocalVersionProbeDiagnostics, NonConvergentReport, PnpmHomeSource, PnpmRunDiagnostics,
    PostInstallContext, PostInstallCoreEffects, VersionProbeOutcome, NON_CONVERGENT_ERROR_PREFIX,
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
    )
}

/// The pnpm-executor fixture context. `home_source`/`path_has_shim_dir` are the
/// two knobs that decide whether pnpm was aimed at the shim we resolved.
fn pnpm_context<'a>(
    hq_bin: &'a str,
    pnpm_bin: &'a str,
    home_source: PnpmHomeSource,
    path_has_shim_dir: bool,
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
        installer_bin: pnpm_bin,
        already_blocked,
        pnpm: Some(PnpmRunDiagnostics {
            home_source,
            home_env_present: false,
            path_has_shim_dir,
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
/// shim's directory) is a foreign layout: bounded to one capture per episode,
/// and it says so rather than claiming pnpm was targeted.
#[test]
fn undetermined_pnpm_home_is_reported_as_foreign_managed_and_stays_bounded() {
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
            false,
        ),
        true,
    );
    assert_eq!(records, 1);
    assert_eq!(captures, 1);
    assert_eq!(record_failures, 0);
    assert_eq!(events.len(), 1);
    assert_non_convergent_shape(
        &events[0],
        "pnpm",
        "foreign-managed",
        expected_hq_source,
        "~/.asdf/shims/hq",
    );
    assert_eq!(
        events[0].tags.get("pnpm_home_source").map(String::as_str),
        Some("undetermined")
    );

    // Repeat episode: suppressed, exactly like the npm foreign-managed path.
    let (events, records, captures, record_failures) = composed_non_convergent_events(
        &pnpm_context(
            &hq_bin,
            "/opt/homebrew/bin/pnpm",
            PnpmHomeSource::Undetermined,
            false,
            true,
        ),
        true,
    );
    assert!(events.is_empty());
    assert_eq!(records, 0);
    assert_eq!(captures, 0);
    assert_eq!(record_failures, 0);
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
        Some("none")
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
