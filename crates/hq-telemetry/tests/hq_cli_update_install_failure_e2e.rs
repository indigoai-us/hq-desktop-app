use std::sync::Arc;

use hq_desktop_core::hq_cli_update::report_install_failure;
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
fn transient_registry_failures_do_not_capture_but_unexpected_cache_failures_are_tagged() {
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

    let cache_eacces = "npm error code EACCES\n\
        npm error path /Users/alice/.npm/_cacache/content-v2/sha512";
    let events =
        captured_events(|| report_install_failure(Some(1), cache_eacces, Some("/usr/local")));
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.level, sentry::Level::Error);
    assert_eq!(
        event.message.as_deref(),
        Some("[hq-cli-update] install failed (exit 1)")
    );
    assert_eq!(
        event.tags.get("install_failure_kind").map(String::as_str),
        Some("unexpected")
    );
    assert_eq!(event.tags.get("eacces").map(String::as_str), Some("true"));
    assert_eq!(
        event.tags.get("npm_failure_site").map(String::as_str),
        Some("cache")
    );
    assert_eq!(
        event.tags.get("npm_error_code").map(String::as_str),
        Some("EACCES")
    );
    assert!(
        event
            .tags
            .values()
            .all(|value| !value.contains("/Users/alice")),
        "diagnostic tags must never carry filesystem paths: {:?}",
        event.tags
    );
}
