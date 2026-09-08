//! Feature-flag gate for the in-app agent sessions surface (Phase 0).
//!
//! One reader so every call site — Tauri commands, window setup, the renderer's
//! capability probe — agrees on whether the surface exists. Default OFF: the
//! flag must be opted into per install, and shipping it dark means an
//! unfinished surface can never appear on an existing user's machine just
//! because a build went out.
//!
//! Two independent sources, either of which enables it:
//!   * `HQ_DEV_IN_APP_SESSIONS=1` — process-scoped developer override, so a dev
//!     build can exercise the surface without writing the user's real
//!     `~/.hq/menubar.json` (the same file the installed app reads).
//!   * `inAppSessions: true` in `~/.hq/menubar.json` — the durable opt-in,
//!     read exactly like every other menubar bool (see
//!     `daemon::is_autostart_enabled`).

use crate::daemon::read_menubar_bool;

/// Process-scoped developer override. Truthy = `1` or `true`, trimmed and
/// case-insensitive, matching `daemon::is_dev_no_sync`.
fn dev_override_enabled() -> bool {
    std::env::var("HQ_DEV_IN_APP_SESSIONS")
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true"
        })
        .unwrap_or(false)
}

/// Whether the in-app agent sessions surface is enabled on this device.
///
/// Defaults to false when `~/.hq/menubar.json` is missing, unreadable, or has
/// no `inAppSessions` key.
pub fn in_app_sessions_enabled() -> bool {
    dev_override_enabled() || read_menubar_bool(|p| p.in_app_sessions, false)
}

/// Message every gated in-app-sessions entry point returns while the flag is
/// off. One constant so the commands and the renderer agree.
pub const IN_APP_SESSIONS_DISABLED_MESSAGE: &str =
    "In-app sessions are not enabled on this device.";

/// Common preflight for in-app-sessions entry points:
/// `Err(IN_APP_SESSIONS_DISABLED_MESSAGE)` while the flag is off, `Ok(())`
/// otherwise. Mirrors `daemon::ensure_cloud_sync_allowed` so both gates read
/// the same way at their call sites.
pub fn ensure_in_app_sessions_allowed() -> Result<(), String> {
    if in_app_sessions_enabled() {
        Ok(())
    } else {
        Err(IN_APP_SESSIONS_DISABLED_MESSAGE.to_string())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Restores `HQ_DEV_IN_APP_SESSIONS` on drop so a panicking assertion can
    /// never leak the override into a later test in this binary.
    struct ScopedDevFlag(Option<std::ffi::OsString>);

    impl ScopedDevFlag {
        fn set(value: &str) -> Self {
            let prev = std::env::var_os("HQ_DEV_IN_APP_SESSIONS");
            std::env::set_var("HQ_DEV_IN_APP_SESSIONS", value);
            Self(prev)
        }

        fn unset() -> Self {
            let prev = std::env::var_os("HQ_DEV_IN_APP_SESSIONS");
            std::env::remove_var("HQ_DEV_IN_APP_SESSIONS");
            Self(prev)
        }
    }

    impl Drop for ScopedDevFlag {
        fn drop(&mut self) {
            match self.0.take() {
                Some(v) => std::env::set_var("HQ_DEV_IN_APP_SESSIONS", v),
                None => std::env::remove_var("HQ_DEV_IN_APP_SESSIONS"),
            }
        }
    }

    #[test]
    fn test_in_app_sessions_defaults_off_and_reads_menubar() {
        let _g = crate::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        let old_home = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.path());
        let _e = ScopedDevFlag::unset();

        // No menubar.json at all -> dark, and the gate refuses.
        assert!(!in_app_sessions_enabled());
        assert_eq!(
            ensure_in_app_sessions_allowed(),
            Err(IN_APP_SESSIONS_DISABLED_MESSAGE.to_string())
        );

        // File present but the key absent -> still dark (pre-flag installs).
        std::fs::write(tmp.path().join(".hq/menubar.json"), r#"{}"#).unwrap();
        assert!(!in_app_sessions_enabled());

        // Explicit opt-in -> enabled.
        std::fs::write(
            tmp.path().join(".hq/menubar.json"),
            r#"{"inAppSessions":true}"#,
        )
        .unwrap();
        assert!(in_app_sessions_enabled());
        assert!(ensure_in_app_sessions_allowed().is_ok());

        // Explicit opt-out -> dark again.
        std::fs::write(
            tmp.path().join(".hq/menubar.json"),
            r#"{"inAppSessions":false}"#,
        )
        .unwrap();
        assert!(!in_app_sessions_enabled());

        match old_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn test_dev_env_override_enables_without_touching_menubar() {
        let _g = crate::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        let old_home = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.path());

        // The override wins over an explicitly-off menubar.json, so a dev build
        // never has to edit the file the installed app also reads.
        std::fs::write(
            tmp.path().join(".hq/menubar.json"),
            r#"{"inAppSessions":false}"#,
        )
        .unwrap();

        for truthy in ["1", "true", " TRUE ", "True"] {
            let _e = ScopedDevFlag::set(truthy);
            assert!(in_app_sessions_enabled(), "{truthy:?} must enable");
            assert!(ensure_in_app_sessions_allowed().is_ok());
        }

        for falsy in ["0", "", "  ", "false", "no", "2"] {
            let _e = ScopedDevFlag::set(falsy);
            assert!(!in_app_sessions_enabled(), "{falsy:?} must NOT enable");
        }

        match old_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }
}
