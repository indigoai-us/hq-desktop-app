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
//!   the hq CLI / pack / HQ Core / qmd / HQ Work auto-installers, every
//!   `install_*` command (dependency and coding tool installs), the login
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

/// Who this process is, for launch-time side effects: whether it was built
/// with `HQ_SCRATCH_BUILD`, and the bundle identifier it runs as.
///
/// Only the shipped HQ bundle (stable, beta and alpha share one identifier)
/// may run launch-time paths that change the owner's installed tools or
/// global runtime setup: `hq install|uninstall --global`, the Work Mesh unit,
/// the updater, the login LaunchAgent and the background auto-installers. A
/// locally built bundle with any other identifier (scratch, Lane Check,
/// worktree, HQ New Bot Test, side-by-side Rail builds) shares the owner's
/// home folder and HQ root, so it skips them. On 2026-10-10 a bundle built as
/// `ai.indigo.hq-lane-check.conflict-toast` ran
/// `hq uninstall --global --runtime claude` at startup this way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchIdentity {
    pub scratch_flag: bool,
    pub bundle_identifier: Option<String>,
}

impl LaunchIdentity {
    /// This process. The bundle identifier is read once and cached.
    pub fn current() -> Self {
        Self {
            scratch_flag: active(),
            bundle_identifier: running_bundle_identifier().map(str::to_string),
        }
    }

    /// The one production predicate: not a scratch build, and the shipped
    /// bundle identifier (`hq_platform::autostart::is_production_bundle_identifier`).
    pub fn is_production(&self) -> bool {
        !self.scratch_flag
            && hq_platform::autostart::is_production_bundle_identifier(
                self.bundle_identifier.as_deref(),
            )
    }

    /// Whether the launch-time side effect `what` may run. Logs one line when
    /// it is skipped.
    pub fn allows(&self, what: &str) -> bool {
        if self.is_production() {
            return true;
        }
        if self.scratch_flag {
            skip(what);
        } else {
            crate::util::logfile::log(
                "scratch-build",
                &format!(
                    "{what} skipped: non-production bundle {}",
                    self.bundle_identifier.as_deref().unwrap_or("<unknown>")
                ),
            );
        }
        false
    }
}

/// The bundle identifier this process runs as. macOS reads the enclosing
/// `.app`'s Info.plist. Windows and Linux builds have no bundle identifier to
/// read and ship one identity per platform, so they count as the shipped one
/// (the same rule launch-time autostart has always used on Windows).
pub fn running_bundle_identifier() -> Option<&'static str> {
    static ID: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    ID.get_or_init(|| {
        #[cfg(target_os = "macos")]
        {
            hq_platform::autostart::running_bundle_identifier()
        }
        #[cfg(not(target_os = "macos"))]
        {
            Some(hq_platform::autostart::PRODUCTION_BUNDLE_IDENTIFIER.to_string())
        }
    })
    .as_deref()
}

/// True only for the shipped HQ bundle without `HQ_SCRATCH_BUILD`.
pub fn production_bundle() -> bool {
    LaunchIdentity::current().is_production()
}

/// Launch-time gate for paths that install, uninstall or reconfigure the
/// owner's tools. Logs one skip line and returns false outside production.
pub fn launch_side_effect_allowed(what: &str) -> bool {
    LaunchIdentity::current().allows(what)
}

pub const UPDATES_OFF_MESSAGE: &str = "Updates are turned off for this test build";
pub const INSTALLS_OFF_MESSAGE: &str = "Installs are turned off for this test build";

/// The `install_*` commands refuse in a scratch build: they would change
/// tools the installed HQ shares with this bundle.
pub fn refuse_install(what: &str) -> Result<(), String> {
    refuse_install_with(active(), what)
}

fn refuse_install_with(scratch: bool, what: &str) -> Result<(), String> {
    if scratch {
        skip(what);
        return Err(INSTALLS_OFF_MESSAGE.to_string());
    }
    Ok(())
}

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
            assert_eq!(
                crate::updater::updater_disabled(),
                std::env::var("HQ_UPDATER_DISABLED").is_ok() || !production_bundle()
            );
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

    /// Every gate answers off for a scratch build and on otherwise, tested
    /// through the pure forms so it runs in any build.
    #[test]
    fn a_scratch_build_turns_updates_and_installs_off() {
        assert!(crate::updater::updater_disabled_with(false, true));
        assert!(crate::updater::updater_disabled_with(true, false));
        assert!(!crate::updater::updater_disabled_with(false, false));
        assert_eq!(
            crate::ui_hot_update::scratch_mode_override(true).map(|m| m.as_str()),
            Some("off")
        );
        assert!(crate::ui_hot_update::scratch_mode_override(false).is_none());
        let refused = crate::commands::hq_core_state::try_begin_core_update_with(true)
            .err()
            .expect("a scratch build refuses a Core update");
        assert_eq!(refused.kind().label(), "unavailable");
        assert_eq!(refuse_install_with(true, "install_hq_cli"), Err(INSTALLS_OFF_MESSAGE.to_string()));
        assert_eq!(refuse_install_with(false, "install_hq_cli"), Ok(()));
    }

    const SCRATCH_ID: &str = "ai.indigo.hq-lane-check.conflict-toast";

    fn identity(scratch_flag: bool, id: Option<&str>) -> LaunchIdentity {
        LaunchIdentity { scratch_flag, bundle_identifier: id.map(str::to_string) }
    }

    #[test]
    fn only_the_shipped_bundle_without_the_scratch_flag_is_production() {
        let shipped = hq_platform::autostart::PRODUCTION_BUNDLE_IDENTIFIER;
        assert!(identity(false, Some(shipped)).is_production());
        assert!(identity(false, Some(shipped)).allows("test side effect"));
        assert!(!identity(true, Some(shipped)).is_production());
        for id in [
            SCRATCH_ID,
            "ai.indigo.hq-lane-check",
            "ai.indigo.hq-sync-menubar-dev",
            "ai.indigo.hq-new-bot-test",
            "ai.indigo.hq-rail-newbot",
        ] {
            assert!(!identity(false, Some(id)).is_production(), "{id}");
            assert!(!identity(false, Some(id)).allows("test side effect"), "{id}");
        }
        assert!(!identity(false, None).is_production());
    }

    /// The live answer comes from the same predicate as autostart's gate.
    #[test]
    fn the_live_identity_matches_the_autostart_gate() {
        let live = LaunchIdentity::current();
        let gate = hq_platform::autostart::launch_ensure_gate(live.bundle_identifier.as_deref(), None);
        assert_eq!(
            live.is_production(),
            !live.scratch_flag && gate == hq_platform::autostart::LaunchEnsureGate::Proceed
        );
        assert_eq!(production_bundle(), live.is_production());
    }

    /// The updater and launch-time autostart use the same predicate: for a
    /// scratch bundle id both stand down, for the shipped id both run.
    #[test]
    fn updater_and_autostart_follow_the_same_bundle_predicate() {
        use hq_platform::autostart::{launch_ensure_gate, LaunchEnsureGate, PRODUCTION_BUNDLE_IDENTIFIER};
        for (id, production) in [(Some(PRODUCTION_BUNDLE_IDENTIFIER), true), (Some(SCRATCH_ID), false), (None, false)] {
            let who = identity(false, id);
            assert_eq!(who.is_production(), production, "{id:?}");
            assert_eq!(crate::updater::updater_disabled_with(false, !who.is_production()), !production, "{id:?}");
            assert_eq!(launch_ensure_gate(id, None) == LaunchEnsureGate::Proceed, production, "{id:?}");
        }
    }

    /// The compiled-in answer matches the build: on only when built with
    /// `HQ_SCRATCH_BUILD=1 cargo test scratch_build`.
    #[test]
    fn this_build_answers_by_its_switch() {
        assert_eq!(crate::updater::updater_disabled(), crate::updater::updater_disabled_with(
            std::env::var("HQ_UPDATER_DISABLED").map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes")).unwrap_or(false),
            !production_bundle(),
        ));
        assert_eq!(refuse_install("x").is_err(), active());
    }
}
