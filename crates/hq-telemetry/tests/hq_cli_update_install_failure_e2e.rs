use std::sync::Arc;

use hq_desktop_core::hq_cli_update::{
    report_install_failure, report_install_failure_with_final_attempt,
    report_non_convergent_install, report_npm_cache_setup_failure, NonConvergenceKind,
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

fn assert_unexpected_install_event(
    event: &sentry::protocol::Event<'_>,
    expected_error_code: &str,
    expected_eacces: &str,
    expected_failure_site: &str,
    expected_path_shape: &str,
    expected_stderr_len: &str,
    expected_lifecycle_package: Option<&str>,
) {
    assert_eq!(event.level, sentry::Level::Error);
    assert_eq!(
        event.message.as_deref(),
        Some("[hq-cli-update] install failed (exit 1)")
    );
    assert_eq!(
        fingerprint(event),
        ["hq-cli-update", "install-failed", "unexpected", "1"]
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
    assert_eq!(
        event.extra.get("npm_diagnostics"),
        Some(&Value::String(
            format!(
                "error_code={expected_error_code} syscall=unknown path_shape={expected_path_shape} prefix_known=true eacces={expected_eacces} exit_code=1 errno=unknown stderr_len={expected_stderr_len}"
            )
            .into()
        ))
    );
    assert!(
        !event.extra.contains_key("npm_stderr"),
        "raw npm stderr must never reach Sentry"
    );
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
    assert_eq!(
        fingerprint(event),
        vec![
            "hq-cli-update".to_string(),
            "install-failed".to_string(),
            "unexpected".to_string(),
            econnreset_exit.to_string(),
        ]
    );
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
        report_non_convergent_install(
            "5.83.0",
            Some("5.77.14"),
            &hq_bin,
            None,
            "/opt/homebrew/bin/npm",
            true,
            NonConvergenceKind::ForeignManaged,
        )
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
        ("hq_bin_source", hq_source),
        ("npm_bin_source", npm_source),
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
            "1"
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
            "1"
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

    for detail in [
        "npm error code 1\nnpm error command failed\nnpm error path /usr/local/lib/node_modules/@indigoai-us/hq-cli",
        "npm error code 1\nnpm error command failed\nnpm error path /usr/local/build/work",
    ] {
        let events = captured_events(|| report_install_failure(Some(1), detail, Some("/usr/local")));
        assert_eq!(events.len(), 1, "owned or unattributable failure must remain visible");
        assert_eq!(events[0].level, sentry::Level::Error);
        assert_eq!(
            fingerprint(&events[0]),
            ["hq-cli-update", "install-failed", "unexpected", "1"]
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
