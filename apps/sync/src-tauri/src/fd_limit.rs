//! Open-file limit for the menubar process.
//!
//! macOS launches GUI apps with a soft `RLIMIT_NOFILE` of 256 while the hard
//! limit is effectively unlimited. The menubar app holds a webview per
//! surface (main popover, widget, notification banner), each with its own
//! renderer handle set, plus log files, sockets, MQTT sessions, and every
//! `hq-cloud` child it spawns. On one dogfood machine the process sat at
//! ~300 handles against the 256 cap and every spawn, git mirror, manifest
//! read, and journal write failed with `Too many open files (os error 24)`.
//!
//! Raise the soft limit toward the hard limit before Tauri starts so ordinary
//! operation never trips the cap. This is a floor, not a fix for leaks; the
//! banner window lifecycle no longer leaks, and this keeps a future one from
//! taking realtime sync down with it.

/// Soft limit we ask for when the hard limit allows it. Matches macOS's
/// `OPEN_MAX`; Rust's std and the OS both cope with it.
pub const TARGET_SOFT_LIMIT: u64 = 10_240;

/// The soft limit to request, or `None` when the current one is already at
/// least as high as we would set. Never lowers, never exceeds the hard limit.
pub fn desired_soft_limit(current_soft: u64, hard: u64) -> Option<u64> {
    let target = TARGET_SOFT_LIMIT.min(hard);
    (target > current_soft).then_some(target)
}

/// Outcome of [`raise_open_file_limit`], for the startup log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RaiseOutcome {
    /// Soft limit moved from `.0` to `.1`.
    Raised(u64, u64),
    /// Soft limit was already at or above the target (`.0`).
    AlreadySufficient(u64),
    /// Not a Unix platform; nothing to do.
    #[cfg_attr(unix, allow(dead_code))]
    Unsupported,
}

#[cfg(unix)]
pub fn raise_open_file_limit() -> Result<RaiseOutcome, String> {
    // SAFETY: plain getrlimit/setrlimit on a zeroed, properly sized struct.
    unsafe {
        let mut lim = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) != 0 {
            return Err(format!("getrlimit: {}", std::io::Error::last_os_error()));
        }
        // `rlim_t` is `u64` on every Unix target this app builds for.
        let soft: u64 = lim.rlim_cur;
        let hard: u64 = lim.rlim_max;
        let Some(target) = desired_soft_limit(soft, hard) else {
            return Ok(RaiseOutcome::AlreadySufficient(soft));
        };
        lim.rlim_cur = target;
        if libc::setrlimit(libc::RLIMIT_NOFILE, &lim) != 0 {
            return Err(format!(
                "setrlimit({soft} -> {target}, hard {hard}): {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(RaiseOutcome::Raised(soft, target))
    }
}

#[cfg(not(unix))]
pub fn raise_open_file_limit() -> Result<RaiseOutcome, String> {
    Ok(RaiseOutcome::Unsupported)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desired_soft_limit_raises_the_macos_default_toward_open_max() {
        // macOS GUI default: soft 256, hard unlimited.
        assert_eq!(desired_soft_limit(256, u64::MAX), Some(TARGET_SOFT_LIMIT));
    }

    #[test]
    fn desired_soft_limit_never_exceeds_the_hard_limit() {
        assert_eq!(desired_soft_limit(256, 4096), Some(4096));
        assert_eq!(desired_soft_limit(256, 256), None);
    }

    #[test]
    fn desired_soft_limit_never_lowers_an_already_generous_limit() {
        assert_eq!(desired_soft_limit(TARGET_SOFT_LIMIT, u64::MAX), None);
        assert_eq!(desired_soft_limit(65_536, u64::MAX), None);
    }

    #[cfg(unix)]
    #[test]
    fn raise_open_file_limit_leaves_the_process_at_or_above_the_target() {
        let outcome = raise_open_file_limit().expect("raise must not fail on unix");
        // SAFETY: getrlimit on a zeroed struct.
        let (soft, hard) = unsafe {
            let mut lim = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            assert_eq!(libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim), 0);
            (lim.rlim_cur, lim.rlim_max)
        };
        assert!(
            soft >= TARGET_SOFT_LIMIT.min(hard),
            "soft {soft} below min(target, hard {hard}) after {outcome:?}"
        );
        // Calling it again is a no-op, not an error.
        assert_eq!(
            raise_open_file_limit().expect("second raise"),
            RaiseOutcome::AlreadySufficient(soft)
        );
    }
}
