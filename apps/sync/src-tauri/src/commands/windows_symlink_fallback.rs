//! Pure selection rules for Windows content symlink recovery.
//!
//! Keep these decisions independent of Tauri so they can be exercised on the
//! Linux development host while the full binary tests run in CI.

use std::path::Path;

pub(crate) const WINDOWS_CONTENT_SYMLINK_FALLBACK_FLAG: &str =
    "desktop.windows-content-symlink-fallback-v1";

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
/// The shipped 1314 behavior stays available without a rollout flag. Other
/// errors are recoverable only behind the hq-flags gate and only when the
/// target is known to exist as a file or directory.
pub(crate) fn choose_windows_symlink_fallback(
    error_code: Option<i32>,
    target_kind: SymlinkTargetKind,
    extended_fallback_enabled: bool,
) -> Option<WindowsSymlinkFallback> {
    if error_code == Some(WINDOWS_ERROR_PRIVILEGE_NOT_HELD) {
        return match target_kind {
            SymlinkTargetKind::File => Some(WindowsSymlinkFallback::CopyFile),
            SymlinkTargetKind::Directory | SymlinkTargetKind::Missing => {
                Some(WindowsSymlinkFallback::Junction)
            }
        };
    }

    if !extended_fallback_enabled
        || !matches!(
            error_code,
            Some(WINDOWS_ERROR_INVALID_FUNCTION) | Some(WINDOWS_ERROR_ALREADY_EXISTS)
        )
    {
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
    extended_fallback_enabled: bool,
    existing_target: &Path,
    requested_target: &Path,
) -> bool {
    extended_fallback_enabled
        && error_code == Some(WINDOWS_ERROR_ALREADY_EXISTS)
        && existing_symlink_matches_target(existing_target, requested_target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches_hq_flags_key_pattern(key: &str) -> bool {
        let mut segments = key.split('.');
        let is_segment = |segment: &str| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-'))
        };

        matches!(segments.next(), Some(segment) if is_segment(segment))
            && matches!(segments.next(), Some(segment) if is_segment(segment))
            && segments.all(is_segment)
    }

    #[test]
    fn hq_flags_key_matches_registry_regex() {
        const REGISTRY_KEY_PATTERN: &str = r"^[a-z0-9-]+(\.[a-z0-9-]+)+$";
        assert!(
            matches_hq_flags_key_pattern(WINDOWS_CONTENT_SYMLINK_FALLBACK_FLAG),
            "hq-flags key {:?} must match {}",
            WINDOWS_CONTENT_SYMLINK_FALLBACK_FLAG,
            REGISTRY_KEY_PATTERN,
        );
    }

    #[test]
    fn privilege_failure_keeps_the_existing_copy_and_junction_fallbacks() {
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_PRIVILEGE_NOT_HELD),
                SymlinkTargetKind::File,
                false,
            ),
            Some(WindowsSymlinkFallback::CopyFile)
        );
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_PRIVILEGE_NOT_HELD),
                SymlinkTargetKind::Missing,
                false,
            ),
            Some(WindowsSymlinkFallback::Junction)
        );
    }

    #[test]
    fn invalid_function_uses_a_flagged_fallback_only_for_known_target_types() {
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_INVALID_FUNCTION),
                SymlinkTargetKind::File,
                true,
            ),
            Some(WindowsSymlinkFallback::CopyFile)
        );
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_INVALID_FUNCTION),
                SymlinkTargetKind::Directory,
                true,
            ),
            Some(WindowsSymlinkFallback::Junction)
        );
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_INVALID_FUNCTION),
                SymlinkTargetKind::Missing,
                true,
            ),
            None
        );
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_INVALID_FUNCTION),
                SymlinkTargetKind::File,
                false,
            ),
            None
        );
    }

    #[test]
    fn already_exists_uses_a_flagged_fallback_only_for_known_target_types() {
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_ALREADY_EXISTS),
                SymlinkTargetKind::File,
                true,
            ),
            Some(WindowsSymlinkFallback::CopyFile)
        );
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_ALREADY_EXISTS),
                SymlinkTargetKind::Directory,
                true,
            ),
            Some(WindowsSymlinkFallback::Junction)
        );
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_ALREADY_EXISTS),
                SymlinkTargetKind::Missing,
                true,
            ),
            None
        );
        assert_eq!(
            choose_windows_symlink_fallback(
                Some(WINDOWS_ERROR_ALREADY_EXISTS),
                SymlinkTargetKind::File,
                false,
            ),
            None
        );
    }

    #[test]
    fn existing_link_is_reusable_only_for_the_requested_target_behind_the_flag() {
        assert!(should_reuse_existing_symlink(
            Some(WINDOWS_ERROR_ALREADY_EXISTS),
            true,
            Path::new("../.claude/CLAUDE.md"),
            Path::new("../.claude/CLAUDE.md")
        ));
        assert!(should_reuse_existing_symlink(
            Some(WINDOWS_ERROR_ALREADY_EXISTS),
            true,
            Path::new("../.claude/claude.md"),
            Path::new("..\\.claude\\CLAUDE.md")
        ));
        assert!(!should_reuse_existing_symlink(
            Some(WINDOWS_ERROR_ALREADY_EXISTS),
            false,
            Path::new("../.claude/CLAUDE.md"),
            Path::new("../.claude/CLAUDE.md")
        ));
        assert!(!should_reuse_existing_symlink(
            Some(WINDOWS_ERROR_INVALID_FUNCTION),
            true,
            Path::new("../.claude/CLAUDE.md"),
            Path::new("../.claude/CLAUDE.md")
        ));
        assert!(!should_reuse_existing_symlink(
            Some(WINDOWS_ERROR_ALREADY_EXISTS),
            true,
            Path::new("../.claude/AGENTS.md"),
            Path::new("../.claude/CLAUDE.md")
        ));
    }
}
