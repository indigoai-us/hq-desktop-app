//! Post-sync git mirror — implementation lives in hq-desktop-core (Phase 4 extraction).
//! Thin facade so existing `crate::commands::git_mirror::*` call sites are unchanged.

use std::time::Duration;

/// Reuse the native startup watchdog bound while waiting for the frontend's
/// asynchronous hq-flags snapshot before the first mirror pass.
const MIRROR_FLAG_SNAPSHOT_TIMEOUT: Duration = crate::boot_watchdog::DEFAULT_WATCHDOG_TIMEOUT;

/// Post-sync entry point used by both manual sync and the daemon. The
/// implementation waits for the first feature-flag snapshot before capturing
/// the mirror image, falling back to the historical default-off behavior at
/// the bounded startup deadline.
pub fn mirror_after_sync(hq_folder: &str) {
    hq_desktop_core::git_mirror::mirror_after_sync_with_flag_snapshot_timeout(
        hq_folder,
        MIRROR_FLAG_SNAPSHOT_TIMEOUT,
    );
}

/// Keep the AllComplete handlers fire-and-forget so a slow `git push` cannot
/// stall the sync reader.
pub fn spawn_mirror_after_sync(hq_folder: &str) {
    let hq_folder = hq_folder.to_string();
    std::thread::spawn(move || mirror_after_sync(&hq_folder));
}

/// Cache the current hq-flags snapshot for mirrors launched by either sync
/// event path. A missing registry row or failed read is sent as `false`.
#[tauri::command]
pub fn set_mirror_quarantine_move_not_deletion(enabled: bool) {
    hq_desktop_core::git_mirror::set_scope_quarantine_move_not_deletion_enabled(enabled);
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::Path,
        process::{Command, Output},
        sync::mpsc,
        thread,
        time::Duration,
    };

    use super::{mirror_after_sync, set_mirror_quarantine_move_not_deletion};

    fn git(dir: &Path, args: &[&str]) -> Output {
        Command::new("git")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env_remove("GIT_DIR")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_WORK_TREE")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git available in test env")
    }

    fn git_ok(dir: &Path, args: &[&str]) -> Output {
        let out = git(dir, args);
        assert!(
            out.status.success(),
            "git {args:?} failed in {dir:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        out
    }

    fn revision_count(dir: &Path) -> usize {
        let out = git_ok(dir, &["rev-list", "--count", "HEAD"]);
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .expect("revision count")
    }

    fn seed_scope_shrink_repo(dir: &Path) {
        git_ok(dir, &["init", "-q", "-b", "main", "--template="]);
        git_ok(dir, &["config", "core.hooksPath", "/dev/null"]);
        git_ok(dir, &["config", "user.email", "test@example.com"]);
        git_ok(dir, &["config", "user.name", "hq-sync-test"]);
        git_ok(dir, &["config", "commit.gpgsign", "false"]);
        fs::write(dir.join(".gitignore"), ".hq/\n").unwrap();
        for index in 0..100 {
            let path = dir.join(format!("companies/retained/file-{index:04}.md"));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, format!("retained {index}\n")).unwrap();
        }
        let source = dir.join("companies/indigo/shrunk.md");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "preserve this in quarantine\n").unwrap();
        git_ok(dir, &["add", "-A"]);
        git_ok(dir, &["commit", "-q", "-m", "seed scope tree"]);

        let destination =
            dir.join(".hq/scope-quarantine/journal-startup/companies/indigo/shrunk.md");
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::rename(source, destination).unwrap();
    }

    #[test]
    fn first_mirror_waits_for_flag_snapshot_before_committing_scope_deletion() {
        let tmp = tempfile::tempdir().unwrap();
        seed_scope_shrink_repo(tmp.path());
        let before = revision_count(tmp.path());
        let hq_folder = tmp.path().to_str().unwrap().to_string();
        let (started_tx, started_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let mirror = thread::spawn(move || {
            started_tx.send(()).unwrap();
            mirror_after_sync(&hq_folder);
            finished_tx.send(()).unwrap();
        });

        started_rx.recv().expect("mirror worker started");
        assert!(
            matches!(
                finished_rx.recv_timeout(Duration::from_millis(500)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ),
            "the first mirror pass must wait while the hq-flags snapshot is pending"
        );
        assert_eq!(
            revision_count(tmp.path()),
            before,
            "a pending flag read must not let the first mirror pass commit the scope shrink"
        );

        set_mirror_quarantine_move_not_deletion(true);
        finished_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the first pass continues when the snapshot resolves");
        mirror.join().expect("mirror worker completes");
        assert_eq!(
            revision_count(tmp.path()),
            before,
            "the resolved enabled snapshot keeps the quarantine move out of the deletion commit"
        );
    }
}
