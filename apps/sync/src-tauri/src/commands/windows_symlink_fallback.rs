//! Pure selection rules for Windows content symlink recovery.
//!
//! Keep these decisions independent of Tauri so they can be exercised on the
//! Linux development host while the full binary tests run in CI.

use std::path::Path;

pub(crate) const WINDOWS_ERROR_INVALID_FUNCTION: i32 = 1;
pub(crate) const WINDOWS_ERROR_ALREADY_EXISTS: i32 = 183;
pub(crate) const WINDOWS_ERROR_PRIVILEGE_NOT_HELD: i32 = 1314;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsSymlinkFallback {
    CopyFile,
    Junction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SymlinkTargetKind {
    File,
    Directory,
    Missing,
}

/// Select a safe fallback for a failed Windows symlink creation.
///
/// The shipped 1314 behavior and supported recoverable errors use a safe
/// fallback when the target is known to exist as a file or directory.
pub(crate) fn choose_windows_symlink_fallback(
    error_code: Option<i32>,
    target_kind: SymlinkTargetKind,
) -> Option<WindowsSymlinkFallback> {
    if error_code == Some(WINDOWS_ERROR_PRIVILEGE_NOT_HELD) {
        return match target_kind {
            SymlinkTargetKind::File => Some(WindowsSymlinkFallback::CopyFile),
            SymlinkTargetKind::Directory | SymlinkTargetKind::Missing => {
                Some(WindowsSymlinkFallback::Junction)
            }
        };
    }

    if !matches!(
        error_code,
        Some(WINDOWS_ERROR_INVALID_FUNCTION) | Some(WINDOWS_ERROR_ALREADY_EXISTS)
    ) {
        return None;
    }

    match target_kind {
        SymlinkTargetKind::File => Some(WindowsSymlinkFallback::CopyFile),
        SymlinkTargetKind::Directory => Some(WindowsSymlinkFallback::Junction),
        SymlinkTargetKind::Missing => None,
    }
}

/// Return true only when an existing link already carries the requested target.
/// Windows paths are case-insensitive and callers can observe either slash
/// style from a reparse point, so normalize separators before comparing.
pub(crate) fn existing_symlink_matches_target(
    existing_target: &Path,
    requested_target: &Path,
) -> bool {
    let existing = existing_target.to_string_lossy().replace('/', "\\");
    let requested = requested_target.to_string_lossy().replace('/', "\\");
    existing.eq_ignore_ascii_case(&requested)
}

pub(crate) fn should_reuse_existing_symlink(
    error_code: Option<i32>,
    existing_target: &Path,
    requested_target: &Path,
) -> bool {
    error_code == Some(WINDOWS_ERROR_ALREADY_EXISTS)
        && existing_symlink_matches_target(existing_target, requested_target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privilege_failure_keeps_the_existing_copy_and_junction_fallbacks() {
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_PRIVILEGE_NOT_HELD),
                SymlinkTargetKind::File,
            ),
            Some(WindowsSymlinkFallback::CopyFile)
        );
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_PRIVILEGE_NOT_HELD),
                SymlinkTargetKind::Missing,
            ),
            Some(WindowsSymlinkFallback::Junction)
        );
    }

    #[test]
    fn invalid_function_uses_fallback_only_for_known_target_types() {
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_INVALID_FUNCTION),
                SymlinkTargetKind::File,
            ),
            Some(WindowsSymlinkFallback::CopyFile)
        );
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_INVALID_FUNCTION),
                SymlinkTargetKind::Directory,
            ),
            Some(WindowsSymlinkFallback::Junction)
        );
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_INVALID_FUNCTION),
                SymlinkTargetKind::Missing,
            ),
            None
        );
    }

    #[test]
    fn already_exists_uses_fallback_only_for_known_target_types() {
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_ALREADY_EXISTS),
                SymlinkTargetKind::File,
            ),
            Some(WindowsSymlinkFallback::CopyFile)
        );
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_ALREADY_EXISTS),
                SymlinkTargetKind::Directory,
            ),
            Some(WindowsSymlinkFallback::Junction)
        );
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_ALREADY_EXISTS),
                SymlinkTargetKind::Missing,
            ),
            None
        );
    }

    #[test]
    fn existing_link_is_reusable_only_for_the_requested_target() {
        assert!(should_reuse_existing_symlink(
            Some(WINDOWS_ERROR_ALREADY_EXISTS),
            Path::new("../.claude/CLAUDE.md"),
            Path::new("../.claude/CLAUDE.md")
        ));
        assert!(should_reuse_existing_symlink(
            Some(WINDOWS_ERROR_ALREADY_EXISTS),
            Path::new("../.claude/claude.md"),
            Path::new("..\\.claude\\CLAUDE.md")
        ));
        assert!(!should_reuse_existing_symlink(
            Some(WINDOWS_ERROR_INVALID_FUNCTION),
            Path::new("../.claude/CLAUDE.md"),
            Path::new("../.claude/CLAUDE.md")
        ));
        assert!(!should_reuse_existing_symlink(
            Some(WINDOWS_ERROR_ALREADY_EXISTS),
            Path::new("../.claude/AGENTS.md"),
            Path::new("../.claude/CLAUDE.md")
        ));
    }
}
