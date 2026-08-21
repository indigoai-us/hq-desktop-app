//! Sync bandwidth policy — the desktop side of the sync bandwidth governor.
//!
//! The actual byte pacing lives in the `@indigoai-us/hq-cloud` sync runner,
//! which honors `HQ_SYNC_BANDWIDTH_PERCENT` (adaptive: pace transfers to
//! N% of the observed link capacity, floored so sync always progresses) and
//! `HQ_SYNC_MAX_BYTES_PER_SEC` (absolute cap). This module owns only the
//! policy resolution on the app side: which percent, if any, the spawned
//! runner should be told to hold itself to.
//!
//! Resolution order (first hit wins):
//! 1. `HQ_MAX_BANDWIDTH_PERCENT` env — machine-wide operator override,
//!    sibling of `HQ_MAX_CPU_PERCENT` in `cpu_throttle`.
//! 2. `MenubarPrefs.sync_bandwidth_percent` — the user's persisted setting.
//! 3. `DEFAULT_BANDWIDTH_PERCENT` — default-on, so customers on slow links
//!    get relief without discovering a knob.
//!
//! A resolved value of 0 or ≥100 means "unlimited": no env var is exported
//! and the runner runs unthrottled, which is the pre-governor behavior.

use std::collections::HashMap;

/// Default share of the observed link capacity the sync runner may consume.
/// Chosen so a background sync never starves interactive use of the same
/// link, while a mostly-idle link still syncs at meaningful speed.
pub const DEFAULT_BANDWIDTH_PERCENT: u8 = 60;

/// Machine-wide operator override (sibling of `HQ_MAX_CPU_PERCENT`).
pub const ENV_OVERRIDE: &str = "HQ_MAX_BANDWIDTH_PERCENT";

/// The env var the hq-cloud sync runner reads (see `bandwidth` in hq-cloud).
pub const RUNNER_ENV: &str = "HQ_SYNC_BANDWIDTH_PERCENT";

/// Resolve the effective bandwidth percent for a spawned sync runner.
/// `None` means unlimited (export nothing).
pub fn effective_bandwidth_percent(prefs_percent: Option<u8>) -> Option<u8> {
    let env_value = std::env::var(ENV_OVERRIDE)
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok());
    let chosen = match env_value {
        // An unparsable override is ignored rather than treated as 0 —
        // a typo in an env var must not silently lift the limit.
        Some(v) => v,
        None => prefs_percent
            .map(i64::from)
            .unwrap_or(i64::from(DEFAULT_BANDWIDTH_PERCENT)),
    };
    if chosen <= 0 || chosen >= 100 {
        return None;
    }
    Some(chosen as u8)
}

/// Insert the runner's bandwidth env var into a spawn env map, if a limit
/// applies. Call sites: `build_sync_spawn_args` (Sync Now) and
/// `build_watch_runner_args` (auto-sync watch daemon).
pub fn apply_bandwidth_env(env: &mut HashMap<String, String>, prefs_percent: Option<u8>) {
    if let Some(percent) = effective_bandwidth_percent(prefs_percent) {
        env.insert(RUNNER_ENV.to_string(), percent.to_string());
    }
}

/// Read the user's persisted setting from menubar.json (same lenient read
/// posture as `daemon::read_menubar_bool`: any read/parse failure = unset).
pub fn prefs_bandwidth_percent() -> Option<u8> {
    let path = crate::paths::menubar_json_path().ok()?;
    if !path.exists() {
        return None;
    }
    let prefs: crate::config::MenubarPrefs =
        serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
    prefs.sync_bandwidth_percent
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Env-var tests share process state; serialize them.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_env<R>(value: Option<&str>, f: impl FnOnce() -> R) -> R {
        let _guard = ENV_LOCK.lock().unwrap();
        match value {
            Some(v) => std::env::set_var(ENV_OVERRIDE, v),
            None => std::env::remove_var(ENV_OVERRIDE),
        }
        let out = f();
        std::env::remove_var(ENV_OVERRIDE);
        out
    }

    #[test]
    fn default_is_on_at_the_default_percent() {
        with_env(None, || {
            assert_eq!(
                effective_bandwidth_percent(None),
                Some(DEFAULT_BANDWIDTH_PERCENT)
            );
        });
    }

    #[test]
    fn prefs_value_wins_over_default() {
        with_env(None, || {
            assert_eq!(effective_bandwidth_percent(Some(25)), Some(25));
        });
    }

    #[test]
    fn zero_and_hundred_mean_unlimited() {
        with_env(None, || {
            assert_eq!(effective_bandwidth_percent(Some(0)), None);
            assert_eq!(effective_bandwidth_percent(Some(100)), None);
        });
    }

    #[test]
    fn env_override_beats_prefs() {
        with_env(Some("15"), || {
            assert_eq!(effective_bandwidth_percent(Some(80)), Some(15));
        });
    }

    #[test]
    fn env_override_can_disable_the_limit() {
        with_env(Some("100"), || {
            assert_eq!(effective_bandwidth_percent(Some(30)), None);
        });
        with_env(Some("0"), || {
            assert_eq!(effective_bandwidth_percent(Some(30)), None);
        });
    }

    #[test]
    fn unparsable_env_override_is_ignored() {
        with_env(Some("plenty"), || {
            assert_eq!(effective_bandwidth_percent(Some(40)), Some(40));
        });
    }

    #[test]
    fn apply_inserts_only_when_limited() {
        with_env(None, || {
            let mut env = HashMap::new();
            apply_bandwidth_env(&mut env, Some(45));
            assert_eq!(env.get(RUNNER_ENV).map(String::as_str), Some("45"));

            let mut env = HashMap::new();
            apply_bandwidth_env(&mut env, Some(100));
            assert!(env.get(RUNNER_ENV).is_none());
        });
    }
}
