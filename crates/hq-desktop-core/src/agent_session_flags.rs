//! Compatibility entry points for the retired sessions rollout flag.
//!
//! Sessions are generally available. Neither legacy `inAppSessions` preferences
//! nor `HQ_DEV_IN_APP_SESSIONS` can hide them or reject a session command.
//! Provider authentication and project access checks remain in their callers.

pub fn in_app_sessions_enabled() -> bool {
    true
}

pub fn ensure_in_app_sessions_allowed() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_are_available_without_a_rollout_opt_in() {
        assert!(in_app_sessions_enabled());
        assert!(ensure_in_app_sessions_allowed().is_ok());
    }
}
