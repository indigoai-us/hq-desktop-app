use std::sync::Arc;

use hq_desktop_core::hq_cli_update::{report_install_failure, report_npm_cache_setup_failure};
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
    assert!(
        event.extra.is_empty(),
        "unexpected extras: {:?}",
        event.extra
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
    let events =
        captured_events(|| report_install_failure(Some(1), cache_eacces, Some("/usr/local")));
    assert_eq!(events.len(), 1);
    assert_unexpected_install_event(&events[0], "EACCES", "true", "cache");
    assert_path_safe(&events[0], &["/Users/", "alice", "_cacache", "npm error"]);

    let unknown = "npm error code ELIFECYCLE\n\
        npm error command failed\n\
        npm error path /Users/carol/project/package.json";
    let events = captured_events(|| report_install_failure(Some(1), unknown, Some("/usr/local")));
    assert_eq!(events.len(), 1);
    assert_unexpected_install_event(&events[0], "unknown", "false", "other");
    assert_path_safe(&events[0], &["/Users/", "carol", "npm error"]);
}

#[test]
fn lifecycle_output_with_transient_tokens_remains_captured() {
    let lifecycle = "npm error code 1\n\
        npm error command failed\n\
        npm error command sh -c node postinstall.js\n\
        application output: ETARGET ECONNRESET npm error network\n\
        application path: /Users/reviewer/project";
    let events = captured_events(|| report_install_failure(Some(1), lifecycle, Some("/usr/local")));

    assert_eq!(
        events.len(),
        1,
        "lifecycle failure was incorrectly suppressed"
    );
    assert_unexpected_install_event(&events[0], "unknown", "false", "other");
    assert_path_safe(
        &events[0],
        &["/Users/", "reviewer", "ETARGET", "ECONNRESET", "npm error"],
    );
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
