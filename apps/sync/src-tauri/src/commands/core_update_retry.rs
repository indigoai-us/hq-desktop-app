const RESCUE_CLONE_FAILED: &str = "error: clone failed";
const APPLE_GIT_LICENSE_UNACCEPTED: &str = "you have not agreed to the xcode license agreements";
const GIT_REMOTE_HTTPS_MISSING: &str = "git: 'remote-https' is not a git command";
const GIT_REMOTE_HTTPS_ABORTED: &str = "fatal: remote helper 'https' aborted session";
const GIT_CLONE_USAGE: &str = "usage: git clone";
const GIT_CLONE_UNKNOWN_SHALLOW_EXCLUDE: &str = "error: unknown option 'shallow-exclude'";
const GIT_CLONE_UNKNOWN_PARTIAL_FILTER: &str = "unknown option `filter=blob:none'";

pub(crate) fn rescue_needs_managed_git_retry(exit_code: i32, rescue_stderr: &str) -> bool {
    if exit_code == 0 {
        return false;
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
}
