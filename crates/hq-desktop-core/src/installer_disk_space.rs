use std::io;
use std::path::Path;

pub const SETUP_MIN_FREE_SPACE_BYTES: u64 = 1024 * 1024 * 1024;

pub fn install_disk_space_message() -> String {
    "HQ could not install this tool because the disk holding HQ's managed Node/npm files and cache has no space available. Keep at least 1 GiB free on that disk. Empty Trash or move/delete large downloads and other files on that disk, then retry setup.".to_string()
}

pub fn is_disk_full_output(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.contains("enospc")
        || lower.contains("no space left on device")
        || lower.contains("os error 28")
}

pub fn user_facing_install_error(program: &str, error_output: &str, fallback: &str) -> String {
    let executable = Path::new(program)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(program);
    if executable.eq_ignore_ascii_case("npm") && is_disk_full_output(error_output) {
        install_disk_space_message()
    } else {
        fallback.to_string()
    }
}

pub fn ensure_setup_disk_space_at_with(
    path: &Path,
    mut available_space: impl FnMut(&Path) -> io::Result<u64>,
) -> Result<(), String> {
    let mut existing = path;
    while !existing.exists() {
        existing = existing.parent().ok_or_else(install_disk_space_message)?;
    }
    match available_space(existing) {
        Ok(bytes) if bytes < SETUP_MIN_FREE_SPACE_BYTES => Err(install_disk_space_message()),
        Ok(_) | Err(_) => Ok(()),
    }
}

pub fn ensure_setup_disk_space_at(path: &Path) -> Result<(), String> {
    ensure_setup_disk_space_at_with(path, crate::client_diagnostics::available_space)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_disk_full_is_actionable_and_non_npm_errors_keep_existing_copy() {
        let user_error = user_facing_install_error(
            "/managed/toolchain/bin/npm",
            "npm error code ENOSPC: no space left on device",
            "Process exited with code 1: npm error code ENOSPC",
        );
        assert!(user_error.contains("1 GiB"));
        assert!(user_error.contains("no space"));
        assert!(user_error.contains("managed Node/npm files and cache"));
        assert!(user_error.contains("large downloads and other files"));
        assert!(!user_error.contains("ENOSPC"));

        assert_eq!(
            user_facing_install_error(
                "git",
                "npm error code ENOSPC: no space left on device",
                "Process exited with code 1: git failed",
            ),
            "Process exited with code 1: git failed",
        );
    }

    #[test]
    fn setup_preflight_rejects_a_volume_below_one_gib() {
        let temp_dir = std::env::temp_dir();
        let path = temp_dir.join("not-created-install-prefix");
        let mut checked_path = None;
        let result = ensure_setup_disk_space_at_with(&path, |existing| {
            checked_path = Some(existing.to_path_buf());
            Ok(0)
        });

        assert_eq!(checked_path.as_deref(), Some(temp_dir.as_path()));
        let error = result.expect_err("zero free bytes must stop before npm starts");
        assert!(error.contains("1 GiB"));
        assert!(error.contains("managed Node/npm files and cache"));
        assert!(error.contains("move/delete large downloads"));
    }

    #[test]
    fn setup_preflight_allows_a_volume_at_the_minimum() {
        ensure_setup_disk_space_at_with(Path::new("/some/not-yet-created/prefix"), |_| {
            Ok(SETUP_MIN_FREE_SPACE_BYTES)
        })
        .expect("the minimum available-space threshold should pass");
    }
}
