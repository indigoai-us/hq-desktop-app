//! Exercise a large readable-root deletion through the public mirror entry
//! point and the production Sentry scrubber. Deletions now commit in the first
//! pass and the removed bulk-refusal event is no longer emitted.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use hq_desktop_core::git_mirror::mirror_after_sync;

fn git(directory: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(directory)
        .args(args)
        .output()
        .expect("git must start");
    assert!(
        output.status.success(),
        "git command failed with exit {:?}",
        output.status.code()
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn seeded_repo() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after the epoch")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "hq-git-mirror-deletion-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).expect("create isolated git fixture");
    git(&directory, &["init", "-q"]);
    git(&directory, &["config", "user.name", "Mirror Test"]);
    git(
        &directory,
        &["config", "user.email", "mirror-test@example.invalid"],
    );

    for index in 0..100 {
        fs::write(directory.join(format!("file-{index}.md")), "fixture\n")
            .expect("seed tracked file");
    }
    git(&directory, &["add", "-A"]);
    git(&directory, &["commit", "-q", "-m", "seed fixture"]);

    for index in 0..60 {
        fs::remove_file(directory.join(format!("file-{index}.md"))).expect("remove fixture file");
    }
    directory
}

#[test]
fn large_deletion_commits_in_one_pass_without_a_bulk_refusal_event() {
    let directory = seeded_repo();
    let before = git(&directory, &["rev-parse", "HEAD"]);

    let events = sentry::test::with_captured_events_options(
        || mirror_after_sync(directory.to_str().expect("fixture path is UTF-8")),
        sentry::ClientOptions {
            before_send: Some(Arc::new(hq_telemetry::before_send)),
            ..Default::default()
        },
    );

    let after = git(&directory, &["rev-parse", "HEAD"]);
    assert_ne!(after, before, "the first mirror pass commits the deletion");
    let files = git(&directory, &["ls-tree", "-r", "--name-only", "HEAD"]);
    assert_eq!(
        files.lines().count(),
        40,
        "the committed snapshot keeps 40 files"
    );
    assert!(
        events.is_empty(),
        "the removed bulk-refusal reporting path emits no event"
    );

    fs::remove_dir_all(directory).expect("remove isolated git fixture");
}
