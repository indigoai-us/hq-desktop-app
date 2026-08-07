use std::sync::Arc;

use hq_desktop_core::hq_cli_update::{
    report_install_failure, report_install_failure_with_final_attempt,
    report_npm_cache_setup_failure,
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
    assert_eq!(
        event.extra.get("npm_diagnostics"),
        Some(&Value::String(
            format!(
                "error_code={expected_error_code} syscall=unknown path_shape={expected_path_shape} prefix_known=true eacces={expected_eacces} exit_code=1 stderr_len={expected_stderr_len}"
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

/// Reproduce the production stderr shape behind HQ-DESKTOP-4G / HQ-DESKTOP-4H:
/// a third-party dependency's build script failing under the selected prefix.
/// npm reports that script's own exit status as its `code`, which is the only
/// thing that differed between the two Sentry issues.
fn lifecycle_stderr(script_status: &str, package: &str) -> String {
    format!(
        "npm error code {script_status}\n\
         npm error path {SELECTED_PREFIX}/lib/node_modules/{package}\n\
         npm error command failed\n\
         npm error command sh -c prebuild-install || node-gyp rebuild"
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
            "lifecycle:better-sqlite3"
        ]
    );
    assert_eq!(
        exit_one.message.as_deref(),
        Some("[hq-cli-update] install failed (lifecycle:better-sqlite3)")
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
            "lifecycle:node-llama-cpp"
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
        "EEXIST:unknown:bin-hq",
    );
}

#[test]
fn third_party_lifecycle_failure_is_separately_grouped_while_owned_and_unknown_are_loud() {
    let third_party = "npm error code 1\n\
        npm error command failed\n\
        npm error path /Users/alice/toolchain/lib/node_modules/better-sqlite3\n\
        npm error command sh -c prebuild-install || node-gyp rebuild";
    let events = captured_events(|| {
        report_install_failure(Some(1), third_party, Some("/Users/alice/toolchain"))
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
            "lifecycle:better-sqlite3"
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
    assert_path_safe(event, &["/Users/", "alice", "toolchain", "npm error"]);

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
