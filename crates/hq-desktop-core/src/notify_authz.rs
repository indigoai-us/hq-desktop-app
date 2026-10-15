//! One-time macOS notification-authorization request for the system-notification
//! default.
//!
//! With native OS banners now the default surface (see
//! [`crate::banner::default_custom_banner`]), a fresh install reaches the native
//! delivery path before macOS has ever asked the user for notification
//! permission. `UNUserNotificationCenter` only shows its system dialog while the
//! authorization status is `notDetermined`, so someone had to trigger it — and
//! before this module the *only* trigger was the "Enable" button in
//! Settings > Notifications, which a user who never opens Settings never finds.
//!
//! So the first notification-worthy event asks — exactly once. The rules:
//!
//!   * Ask only when the status is `"prompt"` (macOS `notDetermined`). `granted`
//!     needs nothing; `denied` is terminal — macOS will not re-show the dialog,
//!     so asking again is a guaranteed no-op.
//!   * Ask at most once per machine, ever. The attempt is recorded in a marker
//!     file next to `menubar.json`, so a restart does not re-ask. This is the
//!     no-nagging contract: HQ gets one dialog, and after that remediation lives
//!     in Settings > Notifications (permission row + System Settings deep link).
//!   * A `denied` or still-not-granted outcome means no OS banner for DM,
//!     share and mention notifications. There is no `osascript display
//!     notification` fallback for them: macOS credits those banners to Script
//!     Editor, shows its icon, and a click launches Script Editor instead of
//!     opening the DM (feedback_97e1771c). The in-app bell still lists the
//!     message, and Settings > Notifications carries the remediation.
//!
//! The decision is a pure function so the whole truth table is unit-tested; the
//! marker file is the only side effect and it is deliberately separate from
//! `menubar.json` (it is machine state, not a user preference, and must never be
//! round-tripped through the Settings prefs object).

/// Marker file recording that HQ has already shown its one system dialog.
/// Lives in `~/.hq/` beside `menubar.json`.
const MARKER_FILE: &str = "notification-authz-requested";

/// True when HQ should show the OS authorization dialog now.
///
/// `status` is the tri-state from `hq_platform::notifications` —
/// `"granted" | "denied" | "prompt" | "unknown"`. `already_requested` is whether
/// the marker below has been written.
///
/// `"unknown"` (unbundled binary, or the status read timed out) never prompts:
/// we would be guessing, and a spurious dialog is worse than a missing one.
pub fn should_request_authorization(status: &str, already_requested: bool) -> bool {
    !already_requested && status == "prompt"
}

/// How a DM / share / mention notification reaches the OS.
///
/// There is deliberately no fallback variant: every OS banner HQ shows for
/// these goes through `UNUserNotificationCenter`, so it carries the HQ icon and
/// a click handler that opens the DM or thread it came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeDelivery {
    /// Authorized: deliver through `UNUserNotificationCenter` now.
    Deliver,
    /// Not yet determined and never asked: ask once, then deliver this
    /// notification only if the answer is "granted".
    RequestThenDeliver,
    /// Denied, already asked, or unknown: no OS banner. The notification stays
    /// in the in-app list.
    Suppress,
}

/// Pick the delivery for one notification from the authorization status and
/// whether HQ has already used its one dialog.
pub fn native_delivery(status: &str, already_requested: bool) -> NativeDelivery {
    if status == "granted" {
        NativeDelivery::Deliver
    } else if should_request_authorization(status, already_requested) {
        NativeDelivery::RequestThenDeliver
    } else {
        NativeDelivery::Suppress
    }
}

/// Path of the one-time marker, or `None` when `~/.hq` can't be resolved.
pub fn marker_path() -> Option<std::path::PathBuf> {
    crate::paths::hq_config_dir()
        .ok()
        .map(|dir| dir.join(MARKER_FILE))
}

/// True when the one-time request has already been made on this machine. An
/// unresolvable config dir reads as "already requested" so we fail closed and
/// never nag in a loop.
pub fn already_requested() -> bool {
    match marker_path() {
        Some(path) => path.exists(),
        None => true,
    }
}

/// Record that the one-time request has been made. Best-effort: a write failure
/// only means the marker is missing, which the caller treats as "may ask once
/// more" — it can never suppress a notification.
pub fn mark_requested() {
    if let Some(path) = marker_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, b"requested\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_once_when_permission_is_not_yet_determined() {
        assert!(should_request_authorization("prompt", false));
    }

    #[test]
    fn never_asks_twice() {
        // The marker is the no-nagging contract: one dialog per machine.
        assert!(!should_request_authorization("prompt", true));
    }

    #[test]
    fn never_asks_when_already_granted_or_denied() {
        for status in ["granted", "denied"] {
            assert!(
                !should_request_authorization(status, false),
                "should not prompt for {status}"
            );
            assert!(!should_request_authorization(status, true));
        }
    }

    #[test]
    fn never_asks_on_an_unknown_status() {
        // Unbundled binary / timed-out read — guessing would show a dialog we
        // can't justify.
        assert!(!should_request_authorization("unknown", false));
        assert!(!should_request_authorization("", false));
    }

    #[test]
    fn granted_delivers_through_the_notification_center() {
        assert_eq!(native_delivery("granted", false), NativeDelivery::Deliver);
        assert_eq!(native_delivery("granted", true), NativeDelivery::Deliver);
    }

    #[test]
    fn first_undetermined_event_asks_then_delivers() {
        assert_eq!(
            native_delivery("prompt", false),
            NativeDelivery::RequestThenDeliver
        );
    }

    #[test]
    fn every_unauthorized_state_suppresses_the_os_banner() {
        // feedback_97e1771c: no state may fall back to another sender. Denied,
        // already-asked and unknown all mean "no OS banner", never osascript.
        for (status, asked) in [
            ("denied", false),
            ("denied", true),
            ("prompt", true),
            ("unknown", false),
            ("unknown", true),
            ("", false),
        ] {
            assert_eq!(
                native_delivery(status, asked),
                NativeDelivery::Suppress,
                "status={status} asked={asked}"
            );
        }
    }

    #[test]
    fn marker_round_trips_through_the_config_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(MARKER_FILE);
        assert!(!path.exists());
        std::fs::write(&path, b"requested\n").expect("write marker");
        assert!(path.exists());
    }
}
