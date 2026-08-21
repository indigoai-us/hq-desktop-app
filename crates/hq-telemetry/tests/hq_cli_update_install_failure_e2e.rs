use std::sync::Arc;

use hq_desktop_core::hq_cli_update::{
    report_install_failure, report_install_failure_episode,
    report_install_failure_with_environment, report_install_failure_with_final_attempt,
    report_non_convergent_install, report_npm_cache_setup_failure, InstallEnvironment,
    InstallExecutor, InstallFailureEpisode, NonConvergenceKind, NonConvergentReport,
    NpmToolchainSource,
};
use sentry::protocol::Value;
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
    event
        .fingerprint
        .iter()
        .map(|value| value.to_string())
        .collect()
}

fn assert_path_safe(event: &sentry::protocol::Event<'_>, forbidden: &[&str]) {
    let message = event.message.as_deref().unwrap_or_default();
    let fingerprint = fingerprint(event);
    let tags = serde_json::to_string(&event.tags).expect("serialize event tags");
    let extra = serde_json::to_string(&event.extra).expect("serialize event extras");

    for token in forbidden {
        assert!(
            !message.contains(token),
            "event message leaked {token:?}: {message:?}"
        );
        assert!(
            fingerprint.iter().all(|value| !value.contains(token)),
            "event fingerprint leaked {token:?}: {fingerprint:?}"
        );
        assert!(!tags.contains(token), "event tags leaked {token:?}: {tags}");
        assert!(
            !extra.contains(token),
            "event extras leaked {token:?}: {extra}"
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn assert_unexpected_install_event(
    event: &sentry::protocol::Event<'_>,
    expected_error_code: &str,
    expected_eacces: &str,
    expected_failure_site: &str,
    expected_path_shape: &str,
    expected_stderr_len: &str,
    expected_lifecycle_package: Option<&str>,
    expected_lifecycle_cause: &str,
    expected_signature: &str,
) {
    assert_eq!(event.level, sentry::Level::Error);
    assert_eq!(
        event.message.as_deref(),
        Some(format!("[hq-cli-update] install failed ({expected_signature})").as_str())
    );
    assert_eq!(
        fingerprint(event),
        [
            "hq-cli-update",
            "install-failed",
            "unexpected",
            expected_signature
        ]
    );
    assert_eq!(
        event.tags.get("hq_cli_update_kind").map(String::as_str),
        Some("install-failed")
    );
    assert_eq!(
        event.tags.get("install_failure_kind").map(String::as_str),
        Some("unexpected")
    );
    assert_eq!(event.tags.get("exit_code").map(String::as_str), Some("1"));
    assert_eq!(
        event.tags.get("eacces").map(String::as_str),
        Some(expected_eacces)
    );
    assert_eq!(
        event.tags.get("npm_failure_site").map(String::as_str),
        Some(expected_failure_site)
    );
    assert_eq!(
        event.tags.get("npm_error_code").map(String::as_str),
        Some(expected_error_code)
    );
    assert!(event.tags.get("npm_syscall").map(String::as_str) == Some("unknown"));
    assert_eq!(
        event.tags.get("npm_path_shape").map(String::as_str),
        Some(expected_path_shape)
    );
    assert_eq!(
        event.tags.get("npm_prefix_known").map(String::as_str),
        Some("true")
    );
    assert_eq!(
        event.tags.get("npm_stderr_len").map(String::as_str),
        Some(expected_stderr_len)
    );
    assert_eq!(
        event.tags.get("npm_errno").map(String::as_str),
        Some("unknown")
    );
    assert_eq!(
        event.tags.get("npm_lifecycle_failed").map(String::as_str),
        Some(if expected_lifecycle_package.is_some() {
            "true"
        } else {
            "false"
        })
    );
    assert_eq!(
        event.tags.get("npm_lifecycle_package").map(String::as_str),
        expected_lifecycle_package
    );
    // The lifecycle-cause tag is present exactly when npm reported a lifecycle
    // failure (parallel to npm_lifecycle_package); its value is the diagnosed
    // cause. A non-lifecycle failure carries no such tag.
    assert_eq!(
        event.tags.get("npm_lifecycle_cause").map(String::as_str),
        expected_lifecycle_package.map(|_| expected_lifecycle_cause)
    );
    // Toolchain provenance. Through these legacy entrypoints it is always the
    // "unknown" fallback (the app-side probes feed the environment-aware path),
    // but the tags must always be present so an event is never missing them.
    for (tag_key, expected) in [
        ("node_version", "unknown"),
        ("node_abi", "unknown"),
        ("npm_version", "unknown"),
        ("npm_toolchain_source", "unknown"),
        ("npm_managed_toolchain_retry", "false"),
    ] {
        assert_eq!(
            event.tags.get(tag_key).map(String::as_str),
            Some(expected),
            "unexpected {tag_key} tag"
        );
    }
    assert_eq!(
        event.extra.get("npm_diagnostics"),
        Some(&Value::String(
            format!(
                "error_code={expected_error_code} syscall=unknown path_shape={expected_path_shape} prefix_known=true eacces={expected_eacces} exit_code=1 errno=unknown stderr_len={expected_stderr_len} lifecycle_cause={expected_lifecycle_cause} node_version=unknown node_abi=unknown npm_version=unknown toolchain_source=unknown"
            )
            .into()
        ))
    );
    assert!(
        !event.extra.contains_key("npm_stderr"),
        "raw npm stderr must never reach Sentry"
    );
}

/// The npm global prefix the app selected on the machines that produced
/// HQ-DESKTOP-4G and HQ-DESKTOP-4H (both events carry
/// `npm_path_shape=selected-prefix-node-modules` and `npm_prefix_known=true`).
const SELECTED_PREFIX: &str = "/Users/alice/.npm-global";

/// Reproduce the production stderr shape behind HQ-DESKTOP-4R / HQ-DESKTOP-4S:
/// a third-party native dependency's build script failing under the selected
/// prefix because the machine's Node ABI has no published prebuild. npm reports
/// that script's own exit status as its `code`, which is the only thing that
/// differed between the historic exit-1 / exit-7 issues; the diagnosed cause is
/// `prebuild-unavailable`, carried by prebuild-install's own miss message.
fn lifecycle_stderr(script_status: &str, package: &str) -> String {
    format!(
        "npm error code {script_status}\n\
         npm error path {SELECTED_PREFIX}/lib/node_modules/{package}\n\
         npm error command failed\n\
         npm error command sh -c prebuild-install || node-gyp rebuild\n\
         prebuild-install warn install No prebuilt binaries found (target=23.0.0 runtime=node arch=arm64)"
    )
}

/// Reproduce HQ-DESKTOP-4J: npm's `mkdir` hitting `ENOTDIR` at the global
/// install target with no prefix known. npm surfaces that errno as exit
/// `256 - 20 = 236`, which is a lossy restatement of tags the event already
/// carries symbolically.
const ENOTDIR_STDERR: &str = "npm error code ENOTDIR\n\
    npm error syscall mkdir\n\
    npm error errno -20\n\
    npm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli";

/// Reproduce HQ-DESKTOP-53: a full disk. npm surfaces its own `ENOSPC` code with
/// a `write` syscall and no `npm error path` line (npm_path_shape=none), exit 1.
/// This is a local-machine condition, not an updater defect, so it must emit NO
/// Sentry event through the real `before_send` pipeline.
const DISK_FULL_STDERR: &str = "npm error code ENOSPC\n\
    npm error syscall write\n\
    npm error errno -28\n\
    npm error ENOSPC: no space left on device, write";

fn single_event(events: Vec<sentry::protocol::Event<'static>>) -> sentry::protocol::Event<'static> {
    assert_eq!(events.len(), 1, "expected exactly one capture: {events:?}");
    events.into_iter().next().expect("captured event")
}

fn tag<'a>(event: &'a sentry::protocol::Event<'_>, key: &str) -> Option<&'a str> {
    event.tags.get(key).map(String::as_str)
}

/// HQ-DESKTOP-4G (exit 1) and HQ-DESKTOP-4H (exit 7) are the same better-sqlite3
/// build failure split into two Sentry issues purely by npm's echo of the failed
/// script's status. The grouping key must be the cause, not that number.
#[test]
fn the_same_lifecycle_failure_groups_identically_across_npm_exit_statuses() {
    let stderr = lifecycle_stderr("1", "better-sqlite3");
    let exit_one = single_event(captured_events(|| {
        report_install_failure(Some(1), &stderr, Some(SELECTED_PREFIX))
    }));

    // HQ-DESKTOP-4H: npm echoed the same build script's status as 7.
    let stderr_seven = lifecycle_stderr("7", "better-sqlite3");
    let exit_seven = single_event(captured_events(|| {
        report_install_failure(Some(7), &stderr_seven, Some(SELECTED_PREFIX))
    }));

    assert_eq!(
        fingerprint(&exit_one),
        fingerprint(&exit_seven),
        "the same cause must not open a second Sentry issue per exit status"
    );
    assert_eq!(
        exit_one.message, exit_seven.message,
        "the issue title must not drift with the exit status"
    );
    assert_eq!(
        fingerprint(&exit_one),
        [
            "hq-cli-update",
            "install-failed",
            "unexpected-lifecycle",
            "lifecycle:better-sqlite3:prebuild-unavailable"
        ]
    );
    assert_eq!(
        exit_one.message.as_deref(),
        Some("[hq-cli-update] install failed (lifecycle:better-sqlite3:prebuild-unavailable)")
    );

    // Fixture fidelity: these are the tags Sentry actually recorded on 4G/4H.
    for event in [&exit_one, &exit_seven] {
        assert_eq!(event.level, sentry::Level::Error);
        assert_eq!(
            tag(event, "install_failure_kind"),
            Some("unexpected-lifecycle")
        );
        assert_eq!(tag(event, "npm_lifecycle_failed"), Some("true"));
        assert_eq!(tag(event, "npm_lifecycle_package"), Some("better-sqlite3"));
        assert_eq!(
            tag(event, "npm_path_shape"),
            Some("selected-prefix-node-modules")
        );
        assert_eq!(tag(event, "npm_prefix_known"), Some("true"));
        assert_eq!(tag(event, "npm_failure_site"), Some("other"));
        assert_eq!(tag(event, "npm_syscall"), Some("unknown"));
        assert_eq!(tag(event, "eacces"), Some("false"));
        assert_path_safe(event, &["/Users/", "alice", ".npm-global", "npm error"]);
    }

    // No diagnostic is lost: the raw status stays searchable on the tag and in
    // the normalized extra, it simply no longer decides the group.
    assert_eq!(tag(&exit_one, "exit_code"), Some("1"));
    assert_eq!(tag(&exit_seven, "exit_code"), Some("7"));
    for (event, expected_exit) in [(&exit_one, "1"), (&exit_seven, "7")] {
        let diagnostics = match event.extra.get("npm_diagnostics") {
            Some(Value::String(value)) => value.clone(),
            other => panic!("missing npm_diagnostics: {other:?}"),
        };
        assert!(
            diagnostics.contains(&format!("exit_code={expected_exit}")),
            "npm_diagnostics dropped the exit status: {diagnostics}"
        );
    }
}

/// The general anti-regression guard: whatever the process exit status is, it
/// must never become a fingerprint component again.
#[test]
fn no_fingerprint_component_is_ever_a_raw_exit_status() {
    let stderr = lifecycle_stderr("1", "better-sqlite3");
    let mut seen: Option<Vec<String>> = None;

    for exit_code in [1, 7, 190, 202, 236] {
        let event = single_event(captured_events(|| {
            report_install_failure(Some(exit_code), &stderr, Some(SELECTED_PREFIX))
        }));
        let components = fingerprint(&event);
        assert!(
            components
                .iter()
                .all(|value| value != &exit_code.to_string()),
            "exit {exit_code} leaked into the fingerprint: {components:?}"
        );
        assert!(
            !event
                .message
                .as_deref()
                .unwrap_or_default()
                .contains(&exit_code.to_string()),
            "exit {exit_code} leaked into the issue title"
        );
        match &seen {
            None => seen = Some(components),
            Some(first) => assert_eq!(
                first, &components,
                "exit {exit_code} split the group for an identical cause"
            ),
        }
    }

    // -4048 is the Windows locked-binary condition, which stays fully
    // suppressed — so it cannot reach a fingerprint at all.
    assert!(
        captured_events(|| report_install_failure(Some(-4048), &stderr, Some(SELECTED_PREFIX)))
            .is_empty(),
        "the Windows locked-binary exit must remain suppressed"
    );
}

/// The exit-status key also UNDER-grouped: HQ-DESKTOP-4G merged better-sqlite3
/// and node-llama-cpp because both happened to exit 1. Genuinely different
/// causes must stay apart, and the ENOTDIR shape must not be swallowed either.
#[test]
fn genuinely_different_causes_keep_distinct_fingerprints() {
    let better_sqlite3 = single_event(captured_events(|| {
        report_install_failure(
            Some(1),
            &lifecycle_stderr("1", "better-sqlite3"),
            Some(SELECTED_PREFIX),
        )
    }));
    let node_llama_cpp = single_event(captured_events(|| {
        report_install_failure(
            Some(1),
            &lifecycle_stderr("1", "node-llama-cpp"),
            Some(SELECTED_PREFIX),
        )
    }));
    assert_ne!(
        fingerprint(&better_sqlite3),
        fingerprint(&node_llama_cpp),
        "two different broken dependencies must not share one issue"
    );
    assert_eq!(
        fingerprint(&node_llama_cpp),
        [
            "hq-cli-update",
            "install-failed",
            "unexpected-lifecycle",
            "lifecycle:node-llama-cpp:prebuild-unavailable"
        ]
    );

    // HQ-DESKTOP-4J stays its own issue on its structured classification alone.
    let enotdir = single_event(captured_events(|| {
        report_install_failure(Some(236), ENOTDIR_STDERR, None)
    }));
    assert_eq!(tag(&enotdir, "install_failure_kind"), Some("unexpected"));
    assert_eq!(tag(&enotdir, "npm_error_code"), Some("ENOTDIR"));
    assert_eq!(tag(&enotdir, "npm_syscall"), Some("mkdir"));
    assert_eq!(
        tag(&enotdir, "npm_path_shape"),
        Some("global-lib-node-modules")
    );
    assert_eq!(tag(&enotdir, "npm_prefix_known"), Some("false"));
    assert_eq!(tag(&enotdir, "exit_code"), Some("236"));
    assert_eq!(
        fingerprint(&enotdir),
        [
            "hq-cli-update",
            "install-failed",
            "unexpected",
            "ENOTDIR:mkdir:global-lib-node-modules"
        ]
    );
    assert_ne!(fingerprint(&enotdir), fingerprint(&better_sqlite3));
    assert_path_safe(&enotdir, &["/usr/local", "npm error"]);
}

#[test]
fn transient_registry_failures_do_not_capture() {
    let etarget = "npm error code ETARGET\n\
        npm error notarget No matching version found for @aws-sdk/core@^3.977.4";
    let econnreset = "npm error code ECONNRESET\n\
        npm error network request to https://registry.npmjs.org failed";

    for detail in [etarget, econnreset] {
        let events =
            captured_events(|| report_install_failure(Some(1), detail, Some("/usr/local")));
        assert!(
            events.is_empty(),
            "transient registry failure captured: {detail}"
        );
    }
}

/// Pinning the exact version can turn a previously-silent stale-tag install into
/// a visible ETARGET during the post-publish propagation window: npm finds no
/// matching version for the pinned spec and exits non-zero. That is already an
/// expected transient registry failure, so it emits NO Sentry event. And because
/// it is an install FAILURE (non-zero exit), it never reaches the exit-0-only
/// non-convergent marker path — so no blocking marker is written and auto-update
/// stays armed to retry once the publish propagates. This is the low-risk
/// landing spot the pin relies on, asserted end to end rather than assumed.
#[test]
fn a_pinned_install_etarget_during_propagation_emits_no_event_and_leaves_auto_update_armed() {
    // The exact pinned spec the app now asks npm for, not yet propagated here.
    let pinned_etarget = "npm error code ETARGET\n\
        npm error notarget No matching version found for @indigoai-us/hq-cli@5.97.1\n\
        npm error notarget In most cases you or one of your dependencies are requesting\n\
        npm error notarget a package version that doesn't exist.";

    // Across the prefixes the installer may pass, and whether or not npm's own
    // retry ladder forced a final attempt, a pinned-install ETARGET stays quiet.
    for prefix in [None, Some("/usr/local")] {
        let events = captured_events(|| report_install_failure(Some(1), pinned_etarget, prefix));
        assert!(
            events.is_empty(),
            "a pinned-install ETARGET must not page (prefix={prefix:?}): {events:?}"
        );
        let events = captured_events(|| {
            report_install_failure_with_final_attempt(Some(1), pinned_etarget, prefix, true)
        });
        assert!(
            events.is_empty(),
            "a forced-final pinned-install ETARGET must not page either: {events:?}"
        );
    }
}

#[test]
fn unexpected_install_failures_keep_stable_envelopes_and_path_safe_diagnostics() {
    let cache_eacces = "npm error code EACCES\n\
        npm error path /Users/alice/.npm/_cacache/content-v2/sha512";
    let cache_eacces_len = cache_eacces.len().to_string();
    let events =
        captured_events(|| report_install_failure(Some(1), cache_eacces, Some("/usr/local")));
    assert_eq!(events.len(), 1);
    assert_unexpected_install_event(
        &events[0],
        "EACCES",
        "true",
        "cache",
        "npm-cache",
        cache_eacces_len.as_str(),
        None,
        "none",
        "EACCES:unknown:npm-cache",
    );
    assert_path_safe(&events[0], &["/Users/", "alice", "_cacache", "npm error"]);

    let unknown = "npm error code ELIFECYCLE\n\
        npm error command failed\n\
        npm error path /Users/carol/project/package.json";
    let unknown_len = unknown.len().to_string();
    let events = captured_events(|| report_install_failure(Some(1), unknown, Some("/usr/local")));
    assert_eq!(events.len(), 1);
    assert_unexpected_install_event(
        &events[0],
        "ELIFECYCLE",
        "false",
        "other",
        "other",
        unknown_len.as_str(),
        Some("unrecognized"),
        "unknown",
        // A symbolic npm code is a real discriminator, so it is kept.
        "ELIFECYCLE:unknown:other",
    );
    assert_path_safe(&events[0], &["/Users/", "carol", "npm error"]);
}

#[test]
fn lifecycle_output_with_transient_tokens_remains_captured() {
    let lifecycle = "npm error code 1\n\
        npm error command failed\n\
        npm error command sh -c node postinstall.js\n\
        application output: ETARGET ECONNRESET npm error network\n\
        application path: /Users/reviewer/project";
    let lifecycle_len = lifecycle.len().to_string();
    let events = captured_events(|| report_install_failure(Some(1), lifecycle, Some("/usr/local")));

    assert_eq!(
        events.len(),
        1,
        "lifecycle failure was incorrectly suppressed"
    );
    assert_unexpected_install_event(
        &events[0],
        "1",
        "false",
        "other",
        "none",
        lifecycle_len.as_str(),
        Some("unrecognized"),
        // `node postinstall.js` failed with no native-builder output, so the
        // cause is now the first-class `postinstall-script` rather than the old
        // `unknown` catch-all — a strict diagnostic improvement. The failure is
        // still captured, still Unexpected (no attributable third-party package),
        // and still path-safe.
        "postinstall-script",
        // npm echoed the build script's own status as its code; a bare number
        // must collapse instead of re-keying the group on the exit status.
        "none:unknown:none",
    );
    assert_path_safe(
        &events[0],
        &["/Users/", "reviewer", "ETARGET", "ECONNRESET", "npm error"],
    );
}

#[test]
fn errno_backed_exit_without_npm_evidence_stays_captured_for_diagnosis() {
    #[cfg(target_os = "macos")]
    let econnreset_exit = 202;
    #[cfg(target_os = "linux")]
    let econnreset_exit = 152;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let econnreset_exit = 202;

    let events = captured_events(|| report_install_failure(Some(econnreset_exit), "", None));
    assert_eq!(
        events.len(),
        1,
        "an unexplained errno-backed exit was incorrectly suppressed"
    );

    let event = &events[0];
    assert_eq!(event.level, sentry::Level::Error);
    // Grouping stays on the bounded failure signature. The decoded errno is a
    // tag, deliberately NOT a fingerprint component: the same registry reset
    // arriving as a different libuv status must not open a new Sentry issue.
    assert_eq!(
        fingerprint(event),
        vec![
            "hq-cli-update".to_string(),
            "install-failed".to_string(),
            "unexpected".to_string(),
            "none:unknown:none".to_string(),
        ]
    );
    // HQ-DESKTOP-45 verbatim: exit 202, eacces=false, install_failure_kind
    // "unexpected", and an `npm_stderr` the org scrubber replaced with
    // [Filtered]. The decoded errno is the one diagnostic that reaches Sentry
    // through a channel the scrubber does not touch, and it must not be used to
    // downgrade or suppress the event — the assertions above keep it Error.
    for (tag, expected) in [
        ("hq_cli_update_kind", "install-failed"),
        ("install_failure_kind", "unexpected"),
        ("exit_code", econnreset_exit.to_string().as_str()),
        ("eacces", "false"),
    ] {
        assert_eq!(
            event.tags.get(tag).map(String::as_str),
            Some(expected),
            "unexpected {tag} tag"
        );
    }
    assert_eq!(
        event.tags.get("npm_errno").map(String::as_str),
        if cfg!(any(target_os = "macos", target_os = "linux")) {
            Some("ECONNRESET")
        } else {
            Some("unknown")
        }
    );
    assert!(
        event
            .extra
            .get("npm_diagnostics")
            .and_then(|value| value.as_str())
            .is_some_and(|summary| summary.contains("errno=")),
        "the fixed diagnostics summary must carry the closed errno value"
    );
    assert_path_safe(event, &["/Users/", "reviewer", "npm error"]);
}

#[test]
fn non_convergent_capture_uses_closed_source_tags_and_redacts_the_home_path() {
    let home = hq_desktop_core::paths::home_dir().expect("test home directory");
    let hq_bin = home.join(".asdf/shims/hq").to_string_lossy().to_string();
    let home = home.to_string_lossy().to_string();

    let events = captured_events(|| {
        report_non_convergent_install(&NonConvergentReport {
            executor: InstallExecutor::Npm,
            kind: NonConvergenceKind::ForeignManaged,
            latest: "5.83.0".to_string(),
            local: Some("5.77.14".to_string()),
            hq_bin: hq_bin.clone(),
            npm_prefix: None,
            installer_bin: "/opt/homebrew/bin/npm".to_string(),
            hq_bin_changed: true,
            delivered_version: None,
            pnpm: None,
            managed_shadow_repair: None,
        })
    });
    assert_eq!(events.len(), 1);

    let event = &events[0];
    assert_eq!(event.level, sentry::Level::Warning);
    assert_eq!(
        fingerprint(event),
        ["hq-cli-update", "install-non-convergent"]
    );
    let (hq_source, npm_source) = if cfg!(target_os = "windows") {
        ("unknown", "unknown")
    } else {
        ("login-shell", "homebrew")
    };
    for (tag, expected) in [
        ("install_executor", "npm"),
        ("hq_bin_source", hq_source),
        ("npm_bin_source", npm_source),
        ("installer_bin_source", npm_source),
        ("hq_bin_changed", "true"),
        ("prefix_known", "false"),
        ("non_convergence_kind", "foreign-managed"),
    ] {
        assert_eq!(event.tags.get(tag).map(String::as_str), Some(expected));
    }
    assert_eq!(
        event.extra.get("hq_bin").and_then(|value| value.as_str()),
        Some("~/.asdf/shims/hq")
    );
    assert_eq!(
        event
            .extra
            .get("npm_prefix")
            .and_then(|value| value.as_str()),
        Some("npm default prefix")
    );
    assert_path_safe(event, &[home.as_str(), "/Users/"]);
}

#[test]
fn force_exhausted_structured_bin_collision_stays_visible_as_a_warning() {
    let bin_collision = "npm error code EEXIST\n\
        npm error path /usr/local/bin/hq";
    let events = captured_events(|| {
        report_install_failure_with_final_attempt(Some(1), bin_collision, Some("/usr/local"), true)
    });
    assert_eq!(events.len(), 1, "forced bin collision must capture once");
    let event = &events[0];
    assert_eq!(event.level, sentry::Level::Warning);
    assert_eq!(
        event.message.as_deref(),
        Some("[hq-cli-update] hq shim collision survived npm --force")
    );
    assert_eq!(
        fingerprint(event),
        [
            "hq-cli-update",
            "install-failed",
            "expected-bin-collision",
            "EEXIST:unknown:bin-hq"
        ]
    );
    assert_eq!(
        event.tags.get("install_failure_kind").map(String::as_str),
        Some("expected-bin-collision")
    );
    assert_eq!(
        event
            .tags
            .get("npm_final_attempt_forced")
            .map(String::as_str),
        Some("true")
    );
    assert_eq!(
        event.tags.get("npm_path_shape").map(String::as_str),
        Some("bin-hq")
    );
    assert_path_safe(event, &["/usr/local", "npm error"]);

    // The warning path shares the fingerprint array, so it was fragmenting by
    // exit status too. One collision, one issue, whatever npm exited with.
    let other_status = single_event(captured_events(|| {
        report_install_failure_with_final_attempt(
            Some(217),
            bin_collision,
            Some("/usr/local"),
            true,
        )
    }));
    assert_eq!(fingerprint(&other_status), fingerprint(event));
    assert_eq!(other_status.message, event.message);
    assert_eq!(tag(&other_status, "exit_code"), Some("217"));

    let events =
        captured_events(|| report_install_failure(Some(1), bin_collision, Some("/usr/local")));
    assert_eq!(events.len(), 1, "unforced collision must remain loud");
    assert_unexpected_install_event(
        &events[0],
        "EEXIST",
        "false",
        "other",
        "bin-hq",
        bin_collision.len().to_string().as_str(),
        None,
        "none",
        "EEXIST:unknown:bin-hq",
    );
}

#[test]
fn second_shim_collision_is_recognized_and_names_the_shim() {
    // HQ-DESKTOP-4Y reported `install failed (EEXIST:unknown:other)` with
    // npm_final_attempt_forced=false because the collision was on the package's
    // SECOND declared shim, `hq-auth-refresh`, which the updater did not
    // recognize. The emitted artifact must now be the RECOGNIZED collision, and
    // the new npm_bin_target tag must name which shim collided — without leaking
    // the path.
    let second_shim = "npm error code EEXIST\n\
        npm error path /usr/local/bin/hq-auth-refresh";

    // Unforced: still loud (Error), but titled on the recognized `bin-hq`
    // signature — no longer the reported `EEXIST:unknown:other`.
    let unforced = single_event(captured_events(|| {
        report_install_failure(Some(1), second_shim, Some("/usr/local"))
    }));
    assert_unexpected_install_event(
        &unforced,
        "EEXIST",
        "false",
        "other",
        "bin-hq",
        second_shim.len().to_string().as_str(),
        None,
        "none",
        "EEXIST:unknown:bin-hq",
    );
    assert_eq!(tag(&unforced, "npm_bin_target"), Some("hq-auth-refresh"));
    assert_eq!(tag(&unforced, "npm_final_attempt_forced"), Some("false"));
    assert_path_safe(&unforced, &["/usr/local", "npm error"]);

    // Forced survivor: the same visible-at-Warning collision as the `hq` shim,
    // sharing its fingerprint so both shims consolidate into one issue while
    // npm_bin_target keeps them discriminable inside it.
    let forced = single_event(captured_events(|| {
        report_install_failure_with_final_attempt(Some(1), second_shim, Some("/usr/local"), true)
    }));
    assert_eq!(forced.level, sentry::Level::Warning);
    assert_eq!(
        forced.message.as_deref(),
        Some("[hq-cli-update] hq shim collision survived npm --force")
    );
    assert_eq!(
        fingerprint(&forced),
        [
            "hq-cli-update",
            "install-failed",
            "expected-bin-collision",
            "EEXIST:unknown:bin-hq"
        ]
    );
    assert_eq!(
        tag(&forced, "install_failure_kind"),
        Some("expected-bin-collision")
    );
    assert_eq!(tag(&forced, "npm_final_attempt_forced"), Some("true"));
    assert_eq!(tag(&forced, "npm_path_shape"), Some("bin-hq"));
    assert_eq!(tag(&forced, "npm_bin_target"), Some("hq-auth-refresh"));
    assert_path_safe(&forced, &["/usr/local", "npm error"]);
}

#[test]
fn third_party_lifecycle_failure_is_separately_grouped_while_owned_and_unknown_are_loud() {
    let third_party = "npm error code 1\n\
        npm error command failed\n\
        npm error path /Users/alice/workroot/lib/node_modules/better-sqlite3\n\
        npm error command sh -c prebuild-install || node-gyp rebuild";
    let events = captured_events(|| {
        report_install_failure(Some(1), third_party, Some("/Users/alice/workroot"))
    });
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.level, sentry::Level::Error);
    assert_eq!(
        fingerprint(event),
        [
            "hq-cli-update",
            "install-failed",
            "unexpected-lifecycle",
            "lifecycle:better-sqlite3:unknown"
        ]
    );
    assert_eq!(
        event.tags.get("install_failure_kind").map(String::as_str),
        Some("unexpected-lifecycle")
    );
    assert_eq!(
        event.tags.get("npm_lifecycle_failed").map(String::as_str),
        Some("true")
    );
    assert_eq!(
        event.tags.get("npm_lifecycle_package").map(String::as_str),
        Some("better-sqlite3")
    );
    assert_eq!(
        event
            .tags
            .get("npm_final_attempt_forced")
            .map(String::as_str),
        Some("false")
    );
    assert_path_safe(event, &["/Users/", "alice", "workroot", "npm error"]);

    // An HQ-owned package and an unattributable build both stay on the
    // `unexpected` path, and each keeps its own bounded signature rather than
    // merging on the shared exit status they used to be keyed by.
    for (detail, expected_signature) in [
        (
            "npm error code 1\nnpm error command failed\nnpm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli",
            "none:unknown:selected-prefix-node-modules",
        ),
        (
            "npm error code 1\nnpm error command failed\nnpm error path /usr/local/build/work",
            "none:unknown:other",
        ),
    ] {
        let events = captured_events(|| report_install_failure(Some(1), detail, Some("/usr/local")));
        assert_eq!(events.len(), 1, "owned or unattributable failure must remain visible");
        assert_eq!(events[0].level, sentry::Level::Error);
        assert_eq!(
            fingerprint(&events[0]),
            [
                "hq-cli-update",
                "install-failed",
                "unexpected",
                expected_signature
            ]
        );
        assert_ne!(
            fingerprint(&events[0]),
            fingerprint(event),
            "an owned or unattributable build must not merge into the third-party group"
        );
    }
}

#[test]
fn cache_setup_failures_capture_stable_path_safe_envelopes() {
    for category in ["resolve", "create"] {
        let events = captured_events(|| report_npm_cache_setup_failure(category));
        assert_eq!(events.len(), 1, "missing {category} cache setup event");

        let event = &events[0];
        assert_eq!(event.level, sentry::Level::Error);
        assert_eq!(
            event.message.as_deref(),
            Some("[hq-cli-update] app-owned npm cache could not be prepared")
        );
        assert_eq!(
            fingerprint(event),
            ["hq-cli-update", "cache-setup-failed", category]
        );
        assert_eq!(
            event.tags.get("hq_cli_update_kind").map(String::as_str),
            Some("cache-setup-failed")
        );
        assert_eq!(
            event
                .tags
                .get("npm_cache_setup_failure")
                .map(String::as_str),
            Some(category)
        );
        assert!(
            event.extra.is_empty(),
            "unexpected extras: {:?}",
            event.extra
        );
        assert_path_safe(event, &["/Users/", "alice", "_cacache", "npm error"]);
    }
}

/// The core of the fix for HQ-DESKTOP-4R / HQ-DESKTOP-4S: the environment-aware
/// capture carries the diagnosed cause and the toolchain provenance the original
/// events never had, in the exact serialized event, scrub-safely.
#[test]
fn environment_aware_capture_carries_the_previously_missing_provenance() {
    let stderr = lifecycle_stderr("1", "better-sqlite3");
    let env = InstallEnvironment {
        node_version: Some("v22.17.0".to_string()),
        node_abi: Some("127".to_string()),
        npm_version: Some("10.9.2".to_string()),
        toolchain_source: NpmToolchainSource::Managed,
        managed_toolchain_retry: true,
    };
    let event = single_event(captured_events(|| {
        report_install_failure_with_environment(
            Some(1),
            &stderr,
            Some(SELECTED_PREFIX),
            false,
            &env,
        )
    }));

    assert_eq!(event.level, sentry::Level::Error);
    assert_eq!(
        event.message.as_deref(),
        Some("[hq-cli-update] install failed (lifecycle:better-sqlite3:prebuild-unavailable)")
    );
    assert_eq!(
        fingerprint(&event),
        [
            "hq-cli-update",
            "install-failed",
            "unexpected-lifecycle",
            "lifecycle:better-sqlite3:prebuild-unavailable"
        ]
    );
    for (key, value) in [
        ("npm_lifecycle_package", "better-sqlite3"),
        ("npm_lifecycle_cause", "prebuild-unavailable"),
        ("node_version", "22.17.0"),
        ("node_abi", "127"),
        ("npm_version", "10.9.2"),
        ("npm_toolchain_source", "managed"),
        ("npm_managed_toolchain_retry", "true"),
    ] {
        assert_eq!(tag(&event, key), Some(value), "tag {key}");
    }
    let diagnostics = match event.extra.get("npm_diagnostics") {
        Some(Value::String(value)) => value.clone(),
        other => panic!("missing npm_diagnostics: {other:?}"),
    };
    assert!(
        diagnostics.contains(
            "lifecycle_cause=prebuild-unavailable node_version=22.17.0 node_abi=127 npm_version=10.9.2 toolchain_source=managed"
        ),
        "npm_diagnostics missing provenance suffix: {diagnostics}"
    );
    assert_path_safe(
        &event,
        &[
            "/Users/",
            "alice",
            ".npm-global",
            "npm error",
            "No prebuilt",
        ],
    );
}

/// The version/ABI strings are caller-probed, so a malformed one must never
/// reach Sentry: it is rejected to `unknown` before tagging.
#[test]
fn malformed_probe_values_are_rejected_to_unknown_before_tagging() {
    let stderr = lifecycle_stderr("1", "better-sqlite3");
    let env = InstallEnvironment {
        node_version: Some("22.x-nightly; rm -rf /".to_string()),
        node_abi: Some("/Users/alice/toolchain".to_string()),
        npm_version: Some(String::new()),
        toolchain_source: NpmToolchainSource::UserPath,
        managed_toolchain_retry: false,
    };
    let event = single_event(captured_events(|| {
        report_install_failure_with_environment(
            Some(1),
            &stderr,
            Some(SELECTED_PREFIX),
            false,
            &env,
        )
    }));
    for (key, value) in [
        ("node_version", "unknown"),
        ("node_abi", "unknown"),
        ("npm_version", "unknown"),
        ("npm_toolchain_source", "user-path"),
        ("npm_managed_toolchain_retry", "false"),
    ] {
        assert_eq!(tag(&event, key), Some(value), "tag {key}");
    }
    assert_path_safe(&event, &["/Users/", "alice", "rm -rf", "nightly"]);
}

/// HQ-DESKTOP-4S, node-llama-cpp's cmake-js build failing because the compiler
/// toolchain is missing: a distinct cause, a distinct group, an actionable tag.
#[test]
fn node_llama_cpp_missing_compiler_groups_by_toolchain_missing_cause() {
    let stderr = format!(
        "npm error code 1\n\
         npm error path {SELECTED_PREFIX}/lib/node_modules/node-llama-cpp\n\
         npm error command failed\n\
         npm error command sh -c node ./dist/cli/cli.js postinstall\n\
         Error: Cannot find cmake, please install cmake and try again"
    );
    let event = single_event(captured_events(|| {
        report_install_failure(Some(1), &stderr, Some(SELECTED_PREFIX))
    }));
    assert_eq!(event.level, sentry::Level::Error);
    assert_eq!(
        event.message.as_deref(),
        Some("[hq-cli-update] install failed (lifecycle:node-llama-cpp:toolchain-missing)")
    );
    assert_eq!(
        fingerprint(&event),
        [
            "hq-cli-update",
            "install-failed",
            "unexpected-lifecycle",
            "lifecycle:node-llama-cpp:toolchain-missing"
        ]
    );
    assert_eq!(tag(&event, "npm_lifecycle_package"), Some("node-llama-cpp"));
    assert_eq!(
        tag(&event, "npm_lifecycle_cause"),
        Some("toolchain-missing")
    );
    assert_path_safe(
        &event,
        &["/Users/", "alice", ".npm-global", "npm error", "cmake"],
    );
}

/// Instrumentation must not weaken scrub-safety: raw node-gyp output, a home
/// directory, and the absolute prefix in the fixture reach neither the message,
/// tags, extras, nor fingerprint of the emitted event.
#[test]
fn provenance_instrumentation_never_weakens_scrub_safety() {
    let raw = format!(
        "npm error code 1\n\
         npm error path {SELECTED_PREFIX}/lib/node_modules/better-sqlite3\n\
         npm error command failed\n\
         gyp ERR! build error\n\
         gyp ERR! stack Error: not found: make\n\
         gyp ERR! cwd /Users/alice/secret-project\n\
         gyp ERR! node -v v23.1.0"
    );
    let env = InstallEnvironment {
        node_version: Some("23.1.0".to_string()),
        node_abi: Some("131".to_string()),
        npm_version: Some("10.9.2".to_string()),
        toolchain_source: NpmToolchainSource::UserPath,
        managed_toolchain_retry: false,
    };
    let event = single_event(captured_events(|| {
        report_install_failure_with_environment(Some(1), &raw, Some(SELECTED_PREFIX), false, &env)
    }));
    assert_eq!(
        tag(&event, "npm_lifecycle_cause"),
        Some("toolchain-missing")
    );
    assert_eq!(tag(&event, "node_abi"), Some("131"));
    assert_path_safe(
        &event,
        &[
            "/Users/",
            "alice",
            ".npm-global",
            "secret-project",
            "npm error",
            "gyp ERR!",
            "not found: make",
        ],
    );
}

/// The repeat-guard: a permanent per-machine build failure reports once per
/// `(version × package × cause)` key and pages again only when that key changes.
/// Critically for this two-package cluster, it retains a SET of keys, so an
/// A/B/A interleave of two different failing native modules (which a single-slot
/// marker would let re-page every check) stays suppressed.
#[test]
fn repeat_guard_reports_once_per_key_and_survives_multi_package_interleave() {
    let bs3 = lifecycle_stderr("1", "better-sqlite3"); // -> prebuild-unavailable
    let nllama = format!(
        // node-llama-cpp with cmake missing -> toolchain-missing
        "npm error code 1\n\
         npm error path {SELECTED_PREFIX}/lib/node_modules/node-llama-cpp\n\
         npm error command failed\n\
         npm error command sh -c node ./dist/cli/cli.js postinstall\n\
         Error: Cannot find cmake, please install cmake and try again"
    );
    let env = InstallEnvironment::default();
    // Reports `detail` at `latest` against the current key set; returns how many
    // events it captured (0 = suppressed, 1 = reported) and the updated set.
    let run = |reported: &[String], detail: &str, latest: &str| -> (usize, Vec<String>) {
        let mut updated = reported.to_vec();
        let events = captured_events(|| {
            match report_install_failure_episode(
                Some(1),
                detail,
                Some(SELECTED_PREFIX),
                false,
                &env,
                latest,
                reported,
            ) {
                InstallFailureEpisode::Reported {
                    persist_keys: Some(set),
                } => updated = set,
                InstallFailureEpisode::SuppressedRepeat => {}
                other => panic!("unexpected outcome {other:?}"),
            }
        });
        (events.len(), updated)
    };

    // A (better-sqlite3): first occurrence pages, set = {A}.
    let (n, persisted) = run(&[], &bs3, "5.97.0");
    assert_eq!(n, 1, "first better-sqlite3 failure must page");
    assert!(persisted.contains(&"5.97.0|better-sqlite3|prebuild-unavailable".to_string()));
    // B (node-llama-cpp): a different package pages, set = {A, B}.
    let (n, persisted) = run(&persisted, &nllama, "5.97.0");
    assert_eq!(n, 1, "a different package must page");
    assert!(persisted.contains(&"5.97.0|node-llama-cpp|toolchain-missing".to_string()));
    // A again: still in the set, so it is suppressed even though B was the most
    // recent report -- the exact case a single-slot marker got wrong.
    let (n, persisted) = run(&persisted, &bs3, "5.97.0");
    assert_eq!(n, 0, "an A/B/A interleave must stay suppressed");
    // A bumped target version resets the set and pages again.
    let (n, persisted) = run(&persisted, &bs3, "5.98.0");
    assert_eq!(n, 1, "a new target version must page again");
    assert_eq!(
        persisted,
        vec!["5.98.0|better-sqlite3|prebuild-unavailable".to_string()],
        "a new version resets the set to the current version's keys"
    );
}

/// HQ-DESKTOP-4V / HQ-DESKTOP-4W: after HQ self-heals its managed Node and the
/// pinned install STILL fails under it, the single reported event carries the
/// managed provenance (`npm_managed_toolchain_retry=true`,
/// `npm_toolchain_source=managed`) AND the new `npm_lifecycle_builder`
/// attribution — a strictly more diagnostic event than today's user-path one,
/// still scrub-safe. This is the exact artifact a healed-but-still-broken
/// machine would produce.
#[test]
fn managed_toolchain_retry_failure_carries_managed_provenance_and_builder() {
    let stderr = lifecycle_stderr("1", "better-sqlite3");
    let env = InstallEnvironment {
        node_version: Some("v22.17.0".to_string()),
        node_abi: Some("127".to_string()),
        npm_version: Some("10.9.2".to_string()),
        toolchain_source: NpmToolchainSource::Managed,
        managed_toolchain_retry: true,
    };
    let event = single_event(captured_events(|| {
        report_install_failure_with_environment(
            Some(1),
            &stderr,
            Some(SELECTED_PREFIX),
            false,
            &env,
        )
    }));
    assert_eq!(event.level, sentry::Level::Error);
    for (key, value) in [
        ("npm_lifecycle_package", "better-sqlite3"),
        ("npm_lifecycle_cause", "prebuild-unavailable"),
        ("npm_lifecycle_builder", "prebuild-install"),
        ("npm_toolchain_source", "managed"),
        ("npm_managed_toolchain_retry", "true"),
        ("node_abi", "127"),
    ] {
        assert_eq!(tag(&event, key), Some(value), "tag {key}");
    }
    assert_path_safe(
        &event,
        &[
            "/Users/",
            "alice",
            ".npm-global",
            "npm error",
            "No prebuilt",
        ],
    );
}

/// The builder attribution is a closed enumeration derived from each builder's
/// own output, so a future node-llama-cpp occurrence no longer degrades to an
/// un-attributable `unknown` group. Each fixture reports at Error (third-party
/// lifecycle) and names which builder ran, from builder-emitted tokens only.
#[test]
fn lifecycle_builder_tag_names_which_builder_ran() {
    let base = |package: &str, builder_output: &str| {
        format!(
            "npm error code 1\n\
             npm error path {SELECTED_PREFIX}/lib/node_modules/{package}\n\
             npm error command failed\n\
             {builder_output}"
        )
    };

    let node_gyp = base(
        "better-sqlite3",
        "gyp ERR! build error\ngyp ERR! stack Error: `make` failed with exit code 2",
    );
    let event = single_event(captured_events(|| {
        report_install_failure(Some(1), &node_gyp, Some(SELECTED_PREFIX))
    }));
    assert_eq!(tag(&event, "npm_lifecycle_builder"), Some("node-gyp"));

    let cmake = base(
        "node-llama-cpp",
        "CMake Error: could not find a suitable generator",
    );
    let event = single_event(captured_events(|| {
        report_install_failure(Some(1), &cmake, Some(SELECTED_PREFIX))
    }));
    assert_eq!(tag(&event, "npm_lifecycle_builder"), Some("cmake-js"));
    // The builder value `cmake-js` is a static classification, not leaked stderr;
    // the raw home path and npm output still never reach the event.
    assert_path_safe(&event, &["/Users/", "alice", ".npm-global", "npm error"]);

    let prebuild = base(
        "better-sqlite3",
        "prebuild-install warn install No prebuilt binaries found (target=23.0.0)",
    );
    let event = single_event(captured_events(|| {
        report_install_failure(Some(1), &prebuild, Some(SELECTED_PREFIX))
    }));
    assert_eq!(
        tag(&event, "npm_lifecycle_builder"),
        Some("prebuild-install")
    );

    let postinstall = base(
        "node-llama-cpp",
        "npm error command sh -c node ./dist/cli/cli.js postinstall\nError: postinstall step failed",
    );
    let event = single_event(captured_events(|| {
        report_install_failure(Some(1), &postinstall, Some(SELECTED_PREFIX))
    }));
    assert_eq!(
        tag(&event, "npm_lifecycle_builder"),
        Some("postinstall-script")
    );

    // The truncated echo names builders in the failing command but shows no builder
    // output and no postinstall stage, so it is attributed to NO builder —
    // `unknown`, never the postinstall residual (the P2 the review flagged). The
    // builder value is a static classification, so the event stays path-safe.
    let echo_only = base(
        "better-sqlite3",
        "npm error command sh -c prebuild-install || node-gyp rebuild",
    );
    let event = single_event(captured_events(|| {
        report_install_failure(Some(1), &echo_only, Some(SELECTED_PREFIX))
    }));
    assert_eq!(tag(&event, "npm_lifecycle_builder"), Some("unknown"));
    assert_path_safe(&event, &["/Users/", "alice", ".npm-global", "npm error"]);
}

/// HQ-DESKTOP-53: a full disk emits NO Sentry event. Proven through the real
/// `before_send` pipeline on the legacy entrypoints AND on the environment
/// entrypoint that actually emitted the reported event, across the prefixes the
/// installer may pass and whether or not npm's retry ladder forced a final
/// attempt.
#[test]
fn a_disk_full_install_failure_emits_no_event() {
    for prefix in [None, Some("/usr/local")] {
        let events = captured_events(|| report_install_failure(Some(1), DISK_FULL_STDERR, prefix));
        assert!(
            events.is_empty(),
            "a full disk must not page (prefix={prefix:?}): {events:?}"
        );
        let events = captured_events(|| {
            report_install_failure_with_final_attempt(Some(1), DISK_FULL_STDERR, prefix, true)
        });
        assert!(
            events.is_empty(),
            "a forced-final full disk must not page either (prefix={prefix:?}): {events:?}"
        );
    }

    // The reported event came through `report_install_failure_with_environment`
    // with the production toolchain provenance (Node 24.14.1 / ABI 137 / npm
    // 11.11.0, user-path, no managed retry), so the suppression must hold there —
    // that is the entrypoint that actually emitted HQ-DESKTOP-53.
    let env = InstallEnvironment {
        node_version: Some("24.14.1".to_string()),
        node_abi: Some("137".to_string()),
        npm_version: Some("11.11.0".to_string()),
        toolchain_source: NpmToolchainSource::UserPath,
        managed_toolchain_retry: false,
    };
    for prefix in [None, Some("/usr/local")] {
        let events = captured_events(|| {
            report_install_failure_with_environment(Some(1), DISK_FULL_STDERR, prefix, false, &env)
        });
        assert!(
            events.is_empty(),
            "the reported environment entrypoint must not page a full disk (prefix={prefix:?}): {events:?}"
        );
    }
}

/// Negative control: a THIRD-PARTY build script that ran out of disk space is a
/// lifecycle failure, not the top-level disk-full case, so it STILL captures
/// exactly one Error event with its per-package `disk-space` signature. The new
/// suppression must not have widened at the real envelope boundary.
#[test]
fn a_lifecycle_failure_carrying_enospc_still_captures() {
    let lifecycle = format!(
        "npm error code 1\n\
         npm error path {SELECTED_PREFIX}/lib/node_modules/better-sqlite3\n\
         npm error command failed\n\
         npm error command sh -c prebuild-install || node-gyp rebuild\n\
         gyp ERR! stack Error: ENOSPC: no space left on device"
    );
    let event = single_event(captured_events(|| {
        report_install_failure(Some(1), &lifecycle, Some(SELECTED_PREFIX))
    }));
    assert_eq!(event.level, sentry::Level::Error);
    assert_eq!(
        event.message.as_deref(),
        Some("[hq-cli-update] install failed (lifecycle:better-sqlite3:disk-space)")
    );
    assert_eq!(
        fingerprint(&event),
        [
            "hq-cli-update",
            "install-failed",
            "unexpected-lifecycle",
            "lifecycle:better-sqlite3:disk-space"
        ]
    );
    assert_eq!(tag(&event, "npm_lifecycle_cause"), Some("disk-space"));
    assert_eq!(
        tag(&event, "install_failure_kind"),
        Some("unexpected-lifecycle")
    );
    assert_path_safe(&event, &["/Users/", "alice", ".npm-global", "npm error"]);
}

/// The same negative control for the LEGACY `npm ERR!` spelling: an old-npm build
/// that ran out of disk space must still capture at the real envelope boundary,
/// not be swallowed by the disk-full suppression. The disk-full predicate gates on
/// npm_lifecycle_failure (which recognizes both `npm error` and `npm ERR!`), so
/// this stays an UnexpectedLifecycle event with its per-package disk-space signature.
#[test]
fn a_legacy_npm_err_lifecycle_failure_carrying_enospc_still_captures() {
    let lifecycle = format!(
        "npm ERR! code 1\n\
         npm ERR! path {SELECTED_PREFIX}/lib/node_modules/better-sqlite3\n\
         npm ERR! command failed\n\
         npm ERR! command sh -c prebuild-install || node-gyp rebuild\n\
         gyp ERR! stack Error: ENOSPC: no space left on device"
    );
    let event = single_event(captured_events(|| {
        report_install_failure(Some(1), &lifecycle, Some(SELECTED_PREFIX))
    }));
    assert_eq!(event.level, sentry::Level::Error);
    assert_eq!(
        event.message.as_deref(),
        Some("[hq-cli-update] install failed (lifecycle:better-sqlite3:disk-space)")
    );
    assert_eq!(tag(&event, "npm_lifecycle_cause"), Some("disk-space"));
    assert_eq!(
        tag(&event, "install_failure_kind"),
        Some("unexpected-lifecycle")
    );
    assert_path_safe(&event, &["/Users/", "alice", ".npm-global"]);
}
