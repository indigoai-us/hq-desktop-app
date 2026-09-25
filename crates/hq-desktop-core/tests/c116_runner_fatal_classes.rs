use hq_desktop_core::sync_outcome::classify_runner_fatal_diagnostic_class;

#[test]
fn windows_node_fatal_stderr_uses_content_safe_diagnostic_classes() {
    let cases = [
        ("FATAL ERROR: V8 failed to create a context", "v8_fatal"),
        ("FATAL ERROR: JavaScript heap out of memory", "heap_oom"),
        ("process.abort() called", "abort"),
        ("__fastfail(FAST_FAIL_FATAL_APP_EXIT)", "fastfail"),
    ];

    for (stderr, expected) in cases {
        let actual = classify_runner_fatal_diagnostic_class(stderr).as_str();
        assert_eq!(
            actual, expected,
            "unexpected class for a fixed stderr shape"
        );
        assert!(!actual.contains(stderr));
    }
}
