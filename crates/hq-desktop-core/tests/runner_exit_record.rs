use hq_desktop_core::watcher_fault::UnmatchedStderrShapeRollup;

#[test]
fn runner_exit_record_is_not_counted_as_unmatched_stderr() {
    let mut rollup = UnmatchedStderrShapeRollup::default();
    rollup.record_if_unmatched(
        r#"{"type":"runner-exit","code":1,"reason":"operation-lock"}"#,
    );

    assert_eq!(rollup.tag_value(), None);
}
