const RESCUE_CLONE_FAILED: &str = "error: clone failed";
const APPLE_GIT_LICENSE_UNACCEPTED: &str = "you have not agreed to the xcode license agreements";
const GIT_REMOTE_HTTPS_MISSING: &str = "git: 'remote-https' is not a git command";
const GIT_REMOTE_HTTPS_ABORTED: &str = "fatal: remote helper 'https' aborted session";
const GIT_CLONE_USAGE: &str = "usage: git clone";
const GIT_CLONE_UNKNOWN_SHALLOW_EXCLUDE: &str = "error: unknown option 'shallow-exclude'";
const GIT_CLONE_UNKNOWN_PARTIAL_FILTER: &str = "unknown option `filter=blob:none'";
const RESCUE_CLONE_FAILURE_CLASS: &str = "HQ_RESCUE_CLONE_FAILURE_CLASS=";

pub(crate) fn rescue_clone_failure_class(rescue_stderr: &str) -> Option<&'static str> {
    rescue_stderr.lines().find_map(|line| {
        let class = line.trim().strip_prefix(RESCUE_CLONE_FAILURE_CLASS)?;
        match class {
            "network" => Some("network"),
            "auth" => Some("auth"),
            "filter_unsupported" => Some("filter_unsupported"),
            "git_unusable" => Some("git_unusable"),
            "path" => Some("path"),
            "exists" => Some("exists"),
            "unknown" => Some("unknown"),
            _ => None,
        }
    })
}

pub(crate) fn rescue_needs_managed_git_retry(exit_code: i32, rescue_stderr: &str) -> bool {
    if exit_code == 0 {
        return false;
    }

    if let Some(class) = rescue_clone_failure_class(rescue_stderr) {
        return matches!(class, "filter_unsupported" | "git_unusable" | "network");
    }

    let rescue_stderr = rescue_stderr.to_ascii_lowercase();
    rescue_stderr.contains(RESCUE_CLONE_FAILED)
        && (rescue_stderr.contains(APPLE_GIT_LICENSE_UNACCEPTED)
            || (rescue_stderr.contains(GIT_REMOTE_HTTPS_MISSING)
                && rescue_stderr.contains(GIT_REMOTE_HTTPS_ABORTED))
            || (rescue_stderr.contains(GIT_CLONE_USAGE)
                && (rescue_stderr.contains(GIT_CLONE_UNKNOWN_SHALLOW_EXCLUDE)
                    || rescue_stderr.contains(GIT_CLONE_UNKNOWN_PARTIAL_FILTER))))
}

pub(crate) fn rescue_retry_requires_managed_git(rescue_stderr: &str) -> bool {
    rescue_clone_failure_class(rescue_stderr) != Some("network")
}

#[cfg(test)]
mod tests {
    use super::rescue_needs_managed_git_retry;

    #[test]
    fn captured_git_2_15_filter_option_failure_requests_managed_git_retry() {
        let stderr = concat!(
            "error: unknown option `filter=blob:none'\n",
            "usage: git clone [<options>] [--] <repo> [<dir>]\n",
            "    --depth <depth>       create a shallow clone of that depth\n",
            "error: clone failed",
        );

        assert!(rescue_needs_managed_git_retry(5, stderr));
    }

    #[test]
    fn unrelated_unknown_clone_option_does_not_request_managed_git_retry() {
        let stderr = concat!(
            "error: unknown option 'filter'\n",
            "usage: git clone [<options>] [--] <repo> [<dir>]\n",
            "    --single-branch       clone only one branch, HEAD or --branch\n",
            "error: clone failed",
        );

        assert!(!rescue_needs_managed_git_retry(5, stderr));
    }

    #[test]
    fn classified_network_and_partial_filter_clone_failures_request_managed_git_retry() {
        for class in ["network", "filter_unsupported"] {
            let stderr = format!("error: clone failed\nHQ_RESCUE_CLONE_FAILURE_CLASS={class}");
            assert!(
                rescue_needs_managed_git_retry(5, &stderr),
                "clone failure class {class} must request one managed Git retry"
            );
        }
    }

    #[test]
    fn classified_auth_and_existing_target_failures_do_not_retry() {
        for class in ["auth", "exists"] {
            let stderr = format!("error: clone failed\nHQ_RESCUE_CLONE_FAILURE_CLASS={class}");
            assert!(
                !rescue_needs_managed_git_retry(5, &stderr),
                "clone failure class {class} must not request a managed Git retry"
            );
        }
    }

    #[test]
    fn only_known_clone_failure_classes_are_accepted() {
        for class in [
            "network",
            "auth",
            "filter_unsupported",
            "git_unusable",
            "path",
            "exists",
            "unknown",
        ] {
            let stderr = format!("HQ_RESCUE_CLONE_FAILURE_CLASS={class}");
            assert_eq!(super::rescue_clone_failure_class(&stderr), Some(class));
        }
        assert_eq!(
            super::rescue_clone_failure_class("HQ_RESCUE_CLONE_FAILURE_CLASS=anything-else"),
            None
        );
    }

    #[test]
    fn only_network_clone_retries_use_the_current_git_binary() {
        assert!(!super::rescue_retry_requires_managed_git(
            "HQ_RESCUE_CLONE_FAILURE_CLASS=network"
        ));
        assert!(super::rescue_retry_requires_managed_git(
            "HQ_RESCUE_CLONE_FAILURE_CLASS=filter_unsupported"
        ));
        assert!(super::rescue_retry_requires_managed_git(
            "HQ_RESCUE_CLONE_FAILURE_CLASS=git_unusable"
        ));
    }
}

#[cfg(all(test, unix))]
mod rescue_script_integration_tests {
    use super::rescue_needs_managed_git_retry;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestFixture(PathBuf);

    impl Drop for TestFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn repository_root() -> PathBuf {
        let script = Path::new("imports/hq-sync-win/scripts/replace-rescue.sh");
        std::env::current_dir()
            .expect("current directory")
            .ancestors()
            .find(|candidate| candidate.join(script).is_file())
            .expect("find repository root from test working directory")
            .to_path_buf()
    }

    fn real_git() -> PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").expect("PATH"))
            .map(|directory| directory.join("git"))
            .find(|candidate| candidate.is_file())
            .expect("find real Git before installing the fake Git fixture")
    }

    fn assert_script_failure_requests_retry(expected_class: &str, fake_stderr: &str) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let fixture = TestFixture(std::env::temp_dir().join(format!(
            "hq-sc013-clone-integration-{}-{nonce}",
            std::process::id()
        )));
        let fake_bin = fixture.0.join("bin");
        let hq_root = fixture.0.join("hq");
        fs::create_dir_all(&fake_bin).expect("create fake Git directory");
        for directory in ["core", "companies", "personal"] {
            fs::create_dir_all(hq_root.join(directory)).expect("create HQ fixture directory");
        }

        let fake_git = fake_bin.join("git");
        fs::write(
            &fake_git,
            "#!/bin/sh\nif [ \"${1:-}\" = \"clone\" ]; then\n  printf '%s\\n' \"$FAKE_GIT_STDERR\" >&2\n  exit 128\nfi\nexec \"$REAL_GIT\" \"$@\"\n",
        )
        .expect("write fake Git executable");
        fs::set_permissions(&fake_git, fs::Permissions::from_mode(0o755))
            .expect("make fake Git executable");

        let mut path_entries = vec![fake_bin];
        path_entries.extend(std::env::split_paths(
            &std::env::var_os("PATH").expect("PATH"),
        ));
        let path = std::env::join_paths(path_entries).expect("join fixture PATH");
        let script = repository_root().join("imports/hq-sync-win/scripts/replace-rescue.sh");
        let output = Command::new("bash")
            .arg(script)
            .arg("--hq-root")
            .arg(&hq_root)
            .arg("--dry-run")
            .arg("--yes")
            .env("PATH", path)
            .env("REAL_GIT", real_git())
            .env("FAKE_GIT_STDERR", fake_stderr)
            .env("GH_TOKEN", "sc013-test-token-do-not-leak")
            .output()
            .expect("run rescue script against fake Git");
        assert_eq!(output.status.code(), Some(5), "unexpected rescue status");

        let diagnostic = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let requests_retry = rescue_needs_managed_git_retry(5, &diagnostic);
        assert!(
            requests_retry,
            "script class {expected_class} must request managed Git retry; output: {diagnostic}"
        );
        assert!(
            diagnostic.contains(&format!("HQ_RESCUE_CLONE_FAILURE_CLASS={expected_class}")),
            "script must emit class {expected_class}; output: {diagnostic}"
        );
    }

    #[test]
    fn clone_script_xcode_license_failure_requests_managed_git_retry() {
        assert_script_failure_requests_retry(
            "git_unusable",
            "You have not agreed to the Xcode license agreements.\nerror: clone failed",
        );
    }

    #[test]
    fn clone_script_remote_https_failure_requests_managed_git_retry() {
        assert_script_failure_requests_retry(
            "git_unusable",
            "git: 'remote-https' is not a git command. See 'git --help'.\nfatal: remote helper 'https' aborted session\nerror: clone failed",
        );
    }

    #[test]
    fn clone_script_shallow_exclude_failure_requests_managed_git_retry() {
        assert_script_failure_requests_retry(
            "git_unusable",
            "error: unknown option 'shallow-exclude'\nusage: git clone [<options>] [--] <repo> [<dir>]\nerror: clone failed",
        );
    }

    #[test]
    fn clone_script_partial_filter_failure_requests_managed_git_retry() {
        assert_script_failure_requests_retry(
            "filter_unsupported",
            "error: unknown option `filter=blob:none'\nusage: git clone [<options>] [--] <repo> [<dir>]\nerror: clone failed",
        );
    }
}
