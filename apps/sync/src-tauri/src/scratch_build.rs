//! Dev-only switches for a local owner test build ("scratch build").
//!
//! Every switch here is read at COMPILE time with `option_env!`, so a bundle
//! launched from Finder (no shell environment) still has them, and a build
//! made without them can never turn them on. The release workflow never sets
//! them (`scripts/dev-switches-contract.test.ts` pins that). Docs:
//! `docs/dev-switches.md`.
//!
//! - `HQ_SCRATCH_BUILD=1` turns off every path that can change the owner's
//!   installed HQ from a test bundle that shares their profile: the app
//!   updater (it implies the runtime `HQ_UPDATER_DISABLED` switch, so the
//!   background checker, channel resolver, manual check/download/install,
//!   hard version gate and autostart ensure all stand down), UI hot updates,
//!   the hq CLI / pack / HQ Core / qmd / HQ Work auto-installers, the login
//!   LaunchAgent (launch reconcile, Start at login, launchd restart handoff)
//!   and the sync-version marker.
//! - `HQ_SCRATCH_IMPORT_HQ_BIN=<absolute path>` runs this `hq` for the
//!   first-run context scan instead of the installed one.
//! - `HQ_SCRATCH_IMPORT_SCANNER=<absolute path to scan.sh>` hands that
//!   scanner to the scan (`HQ_IMPORT_SCANNER_OVERRIDE`), so a local hq CLI
//!   build does not need the release-owned scanner in the HQ folder.
//!
//! The two import switches only apply in a scratch build: without
//! `HQ_SCRATCH_BUILD` they are ignored even when compiled in.

/// Truthy values, the same as the runtime `HQ_UPDATER_DISABLED` switch.
fn switch_on(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes")
    )
}

/// An absolute path, or nothing. Relative paths would resolve against
/// whatever folder the app was started from.
fn absolute_path(value: Option<&'static str>) -> Option<&'static str> {
    value.map(str::trim).filter(|v| v.starts_with('/') && !v.contains('\0'))
}

fn scratch_flag() -> Option<&'static str> {
    option_env!("HQ_SCRATCH_BUILD")
}

/// True only in a bundle built with `HQ_SCRATCH_BUILD=1`.
pub fn active() -> bool {
    switch_on(scratch_flag())
}

/// Log that a side-effecting path was skipped because this is a scratch build.
pub fn skip(what: &str) {
    crate::util::logfile::log("scratch-build", &format!("{what} skipped (HQ_SCRATCH_BUILD)"));
}

pub const UPDATES_OFF_MESSAGE: &str = "Updates are turned off for this test build";

fn import_hq_bin_for(scratch: bool, value: Option<&'static str>) -> Option<&'static str> {
    if scratch { absolute_path(value) } else { None }
}

fn import_scanner_for(scratch: bool, value: Option<&'static str>) -> Option<&'static str> {
    if scratch { absolute_path(value) } else { None }
}

/// The `hq` the first-run context scan runs in a scratch build, if one was baked in.
pub fn import_hq_bin() -> Option<&'static str> {
    import_hq_bin_for(active(), option_env!("HQ_SCRATCH_IMPORT_HQ_BIN"))
}

/// The scanner the first-run context scan uses in a scratch build, if one was baked in.
pub fn import_scanner() -> Option<&'static str> {
    import_scanner_for(active(), option_env!("HQ_SCRATCH_IMPORT_SCANNER"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switches_follow_the_build_env_and_are_off_by_default() {
        assert_eq!(active(), switch_on(option_env!("HQ_SCRATCH_BUILD")));
        if option_env!("HQ_SCRATCH_BUILD").is_none() {
            assert!(!active(), "a build without HQ_SCRATCH_BUILD is never a scratch build");
            assert!(import_hq_bin().is_none());
            assert!(import_scanner().is_none());
            assert!(!crate::updater::updater_disabled() || std::env::var("HQ_UPDATER_DISABLED").is_ok());
        }
    }

    #[test]
    fn only_truthy_values_turn_a_switch_on() {
        for value in ["1", "true", "TRUE", " yes "] {
            assert!(switch_on(Some(value)), "{value}");
        }
        for value in ["", "0", "false", "no", "off"] {
            assert!(!switch_on(Some(value)), "{value}");
        }
        assert!(!switch_on(None));
    }

    #[test]
    fn import_overrides_need_a_scratch_build_and_an_absolute_path() {
        assert_eq!(import_hq_bin_for(false, Some("/opt/hq/bin/hq")), None);
        assert_eq!(import_hq_bin_for(true, Some("/opt/hq/bin/hq")), Some("/opt/hq/bin/hq"));
        assert_eq!(import_hq_bin_for(true, Some("bin/hq")), None);
        assert_eq!(import_hq_bin_for(true, Some("")), None);
        assert_eq!(import_hq_bin_for(true, None), None);
        assert_eq!(import_scanner_for(false, Some("/tmp/scan.sh")), None);
        assert_eq!(import_scanner_for(true, Some("/tmp/scan.sh")), Some("/tmp/scan.sh"));
        assert_eq!(import_scanner_for(true, Some("~/scan.sh")), None);
    }

    /// Build with `HQ_SCRATCH_BUILD=1 cargo test scratch_build` to prove the
    /// switch is compiled in and the update paths report off.
    #[test]
    fn a_scratch_build_turns_updates_off() {
        if !active() {
            return;
        }
        assert!(crate::updater::updater_disabled());
        assert!(crate::updater::background_updates_disabled());
        assert_eq!(crate::ui_hot_update::mode().as_str(), "off");
        assert!(crate::commands::hq_core_state::try_begin_core_update().is_err());
    }
}
