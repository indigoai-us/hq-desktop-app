//! Tests for the HQ-Fingerprint trailer on mirror commits (US-011).
//!
//! Included from `git_mirror.rs` via `#[path = "git_mirror_fingerprint_test.rs"]`
//! so the tests share that module's private items. Every repo, stub `hq` and
//! settings file lives in a temp dir; nothing touches the real HOME or HQ root.

use super::*;
use tempfile::TempDir;

const FP: &str = "hqfp1:indigo:prs_ABCDEFGH:laptop.0123abcd:-";

// ── argv construction ────────────────────────────────────────────────────

#[test]
fn commit_args_carry_the_trailer_when_a_value_is_present() {
    assert_eq!(
        mirror_commit_args("hq-sync: now", Some(FP)),
        vec![
            "commit",
            "--no-gpg-sign",
            "--no-verify",
            "-m",
            "hq-sync: now",
            "--trailer",
            &format!("HQ-Fingerprint: {FP}"),
        ]
    );
}

#[test]
fn commit_args_are_unchanged_when_the_value_is_null() {
    assert_eq!(
        mirror_commit_args("hq-sync: now", None),
        vec![
            "commit",
            "--no-gpg-sign",
            "--no-verify",
            "-m",
            "hq-sync: now"
        ]
    );
}

#[test]
fn commit_args_reject_a_malformed_value() {
    for bad in [
        "",
        "hqfp1",
        "hqfp1:a:b:c",
        "hqfp1:a:b:c:d:e",
        "hqfp2:a:b:c:d",
        "HQFP1:a:b:c:d",
        " hqfp1:a:b:c:d",
        "hqfp1:a:b:c:d\nSigned-off-by: someone",
        "hqfp1:a:b:c:d\r",
    ] {
        assert_eq!(
            mirror_commit_args("m", Some(bad)),
            vec!["commit", "--no-gpg-sign", "--no-verify", "-m", "m"],
            "{bad:?} must not become a trailer"
        );
    }
}

#[test]
fn empty_segments_still_match_the_pattern() {
    assert!(is_valid_fingerprint("hqfp1::::"));
    assert!(is_valid_fingerprint(FP));
}

#[test]
fn parse_reads_only_a_valid_fingerprint_string() {
    let ok = format!("{{\"fingerprint\":\"{FP}\",\"other\":1}}\n");
    assert_eq!(
        parse_fingerprint_output(ok.as_bytes()),
        Some(FP.to_string())
    );
    assert_eq!(parse_fingerprint_output(br#"{"fingerprint":null}"#), None);
    assert_eq!(parse_fingerprint_output(br#"{"fingerprint":42}"#), None);
    assert_eq!(parse_fingerprint_output(br#"{"fingerprint":"nope"}"#), None);
    assert_eq!(parse_fingerprint_output(br#"{}"#), None);
    assert_eq!(parse_fingerprint_output(b""), None);
    assert_eq!(parse_fingerprint_output(FP.as_bytes()), None);
    let noisy = format!("warning: something\n{{\"fingerprint\":\"{FP}\"}}");
    assert_eq!(parse_fingerprint_output(noisy.as_bytes()), None);
}

#[test]
fn fingerprint_command_strips_session_ids_and_uses_the_documented_argv() {
    let tmp = TempDir::new().unwrap();
    let cmd = fingerprint_command("/opt/hq/bin/hq", tmp.path());
    assert_eq!(cmd.get_program(), "/opt/hq/bin/hq");
    let args: Vec<_> = cmd.get_args().collect();
    assert_eq!(
        args,
        [
            "fingerprint",
            "self",
            "--json",
            "--offline",
            "--no-register"
        ]
    );
    assert_eq!(cmd.get_current_dir(), Some(tmp.path()));
    let envs: HashMap<_, _> = cmd.get_envs().collect();
    for var in FINGERPRINT_SESSION_ENV {
        assert_eq!(
            envs.get(std::ffi::OsStr::new(var)),
            Some(&None),
            "{var} must be removed from the child env"
        );
    }
    // Hardening: the autosave child never runs the hq self-update check and
    // never reads or writes the owner's keychain token item.
    assert_eq!(
        envs.get(std::ffi::OsStr::new("HQ_NO_UPDATE_CHECK")),
        Some(&Some(std::ffi::OsStr::new("1"))),
        "HQ_NO_UPDATE_CHECK=1 must be set on the child env"
    );
    assert_eq!(
        envs.get(std::ffi::OsStr::new("HQ_TOKEN_KEYCHAIN")),
        Some(&Some(std::ffi::OsStr::new("0"))),
        "HQ_TOKEN_KEYCHAIN=0 must be set on the child env"
    );
}

// ── kill switch ──────────────────────────────────────────────────────────

fn write_setting(root: &Path, layer: &str, body: &str) {
    let dir = root.join(layer).join("settings");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("fingerprint.yaml"), body).unwrap();
}

#[test]
fn fingerprint_is_enabled_when_no_settings_exist() {
    let tmp = TempDir::new().unwrap();
    assert!(fingerprint_enabled(tmp.path()));
}

#[test]
fn fingerprint_kill_switch_values() {
    for (body, enabled) in [
        ("enabled: false\n", false),
        ("enabled: False  # off for now\n", false),
        ("enabled: \"no\"\n", false),
        ("enabled: 'off'\n", false),
        ("enabled: 0\r\n", false),
        ("enabled: true\n", true),
        ("enabled:\n", true),
        ("other: 1\n", true),
        ("  enabled: false\n", true),
    ] {
        let tmp = TempDir::new().unwrap();
        write_setting(tmp.path(), "personal", body);
        assert_eq!(fingerprint_enabled(tmp.path()), enabled, "{body:?}");
    }
}

#[test]
fn personal_setting_overrides_core() {
    let tmp = TempDir::new().unwrap();
    write_setting(tmp.path(), "core", "enabled: false\n");
    assert!(!fingerprint_enabled(tmp.path()), "core alone can disable");
    write_setting(tmp.path(), "personal", "enabled: true\n");
    assert!(fingerprint_enabled(tmp.path()), "personal wins over core");
    write_setting(tmp.path(), "personal", "note: no key here\n");
    assert!(
        !fingerprint_enabled(tmp.path()),
        "personal without the key falls back to core"
    );
}

// ── mirror integration (stub hq) ─────────────────────────────────────────

#[cfg(unix)]
mod integration {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Restores the thread's hq override even when an assertion panics.
    struct HqOverride;

    impl HqOverride {
        fn set(program: Option<PathBuf>) -> Self {
            TEST_HQ_PROGRAM.with(|slot| *slot.borrow_mut() = program);
            HqOverride
        }
    }

    impl Drop for HqOverride {
        fn drop(&mut self) {
            TEST_HQ_PROGRAM.with(|slot| *slot.borrow_mut() = None);
        }
    }

    /// Hermetic fixture git: host global and system config are ignored, and
    /// any inherited git location variables are scrubbed.
    fn git(dir: &Path, args: &[&str]) -> Output {
        let out = Command::new("git")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env_remove("GIT_DIR")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_WORK_TREE")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git available in test env");
        assert!(
            out.status.success(),
            "git {args:?} failed in {dir:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        out
    }

    /// A repo with one seed commit and one new file for the mirror to commit.
    fn repo_with_pending_change() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-q", "-b", "main", "--template="]);
        git(dir, &["config", "core.hooksPath", "/dev/null"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        git(dir, &["config", "user.name", "hq-sync-test"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
        fs::write(dir.join("README"), "seed").unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", "seed"]);
        fs::write(dir.join("new.txt"), "x").unwrap();
        tmp
    }

    fn stub_hq(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("hq");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn mirror(dir: &Path) {
        let hq = dir.to_str().unwrap();
        let git_dir = resolve_git_dir(hq).expect("git dir");
        run_mirror(hq, &git_dir, false).expect("mirror ok");
    }

    fn head_message(dir: &Path) -> String {
        String::from_utf8(git(dir, &["log", "-1", "--format=%B"]).stdout).unwrap()
    }

    fn head_trailers(dir: &Path) -> String {
        let out = git(
            dir,
            &[
                "log",
                "-1",
                "--format=%(trailers:key=HQ-Fingerprint,valueonly)",
            ],
        );
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    fn rev_count(dir: &Path) -> usize {
        let out = git(dir, &["rev-list", "--count", "HEAD"]);
        String::from_utf8(out.stdout)
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    #[test]
    fn stub_hq_fingerprint_lands_as_exactly_one_trailer() {
        let repo = repo_with_pending_change();
        let bin = TempDir::new().unwrap();
        let record = bin.path().join("argv");
        let stub = stub_hq(
            bin.path(),
            &format!(
                "echo \"$@\" > '{}'\npwd >> '{}'\nprintf '{{\"fingerprint\":\"{FP}\"}}\\n'",
                record.display(),
                record.display()
            ),
        );
        let _hq = HqOverride::set(Some(stub));

        mirror(repo.path());

        assert_eq!(head_trailers(repo.path()), FP);
        let message = head_message(repo.path());
        assert!(message.starts_with("hq-sync: "), "{message}");
        assert_eq!(
            message.matches(&format!("HQ-Fingerprint: {FP}\n")).count(),
            1,
            "{message}"
        );
        let recorded = fs::read_to_string(&record).unwrap();
        let mut lines = recorded.lines();
        assert_eq!(
            lines.next(),
            Some("fingerprint self --json --offline --no-register")
        );
        let cwd = lines.next().unwrap();
        assert_eq!(
            fs::canonicalize(cwd).unwrap(),
            fs::canonicalize(repo.path()).unwrap(),
            "hq runs from the HQ root"
        );
    }

    #[test]
    fn no_hq_commits_without_a_trailer() {
        let repo = repo_with_pending_change();
        let _hq = HqOverride::set(None);
        let before = rev_count(repo.path());

        mirror(repo.path());

        assert_eq!(rev_count(repo.path()), before + 1, "commit still lands");
        assert_eq!(head_trailers(repo.path()), "");
        assert!(!head_message(repo.path()).contains("HQ-Fingerprint"));
    }

    #[test]
    fn missing_hq_binary_commits_without_a_trailer() {
        let repo = repo_with_pending_change();
        let bin = TempDir::new().unwrap();
        let _hq = HqOverride::set(Some(bin.path().join("does-not-exist")));
        let before = rev_count(repo.path());

        mirror(repo.path());

        assert_eq!(rev_count(repo.path()), before + 1);
        assert_eq!(head_trailers(repo.path()), "");
    }

    #[test]
    fn null_failing_or_malformed_hq_output_commits_without_a_trailer() {
        for body in [
            "echo '{\"fingerprint\":null}'",
            "echo '{\"fingerprint\":\"not-a-fingerprint\"}'",
            "echo 'hello'",
            &format!("echo '{{\"fingerprint\":\"{FP}\"}}'; exit 1"),
        ] {
            let repo = repo_with_pending_change();
            let bin = TempDir::new().unwrap();
            let _hq = HqOverride::set(Some(stub_hq(bin.path(), body)));
            let before = rev_count(repo.path());

            mirror(repo.path());

            assert_eq!(rev_count(repo.path()), before + 1, "{body}");
            assert_eq!(head_trailers(repo.path()), "", "{body}");
        }
    }

    #[test]
    fn kill_switch_skips_the_hq_call_entirely() {
        let repo = repo_with_pending_change();
        write_setting(repo.path(), "personal", "enabled: false\n");
        let bin = TempDir::new().unwrap();
        let marker = bin.path().join("called");
        let stub = stub_hq(
            bin.path(),
            &format!(
                "touch '{}'\necho '{{\"fingerprint\":\"{FP}\"}}'",
                marker.display()
            ),
        );
        let _hq = HqOverride::set(Some(stub));
        let before = rev_count(repo.path());

        mirror(repo.path());

        assert_eq!(rev_count(repo.path()), before + 1);
        assert!(
            !marker.exists(),
            "hq must not run when fingerprints are off"
        );
        assert_eq!(head_trailers(repo.path()), "");
    }

    #[test]
    fn slow_hq_is_killed_at_the_timeout() {
        let tmp = TempDir::new().unwrap();
        let bin = TempDir::new().unwrap();
        let stub = stub_hq(
            bin.path(),
            &format!("sleep 30\necho '{{\"fingerprint\":\"{FP}\"}}'"),
        );
        let started = Instant::now();
        let value = run_hq_fingerprint(
            stub.to_str().unwrap(),
            tmp.path(),
            Duration::from_millis(300),
        );
        assert_eq!(value, None);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn result_is_cached_per_hq_and_root() {
        let root = TempDir::new().unwrap();
        let bin = TempDir::new().unwrap();
        let count = bin.path().join("count");
        let stub = stub_hq(
            bin.path(),
            &format!(
                "echo x >> '{}'\necho '{{\"fingerprint\":\"{FP}\"}}'",
                count.display()
            ),
        );
        let _hq = HqOverride::set(Some(stub));
        let hq_root = root.path().to_str().unwrap();

        assert_eq!(mirror_fingerprint(hq_root).as_deref(), Some(FP));
        assert_eq!(mirror_fingerprint(hq_root).as_deref(), Some(FP));
        assert_eq!(fs::read_to_string(&count).unwrap().lines().count(), 1);
    }
}
