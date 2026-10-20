//! Compile-time switch for walk and demo builds: `HQ_CORE_PRERELEASE`.
//!
//! Read with `option_env!`, like the switches in `scratch_build.rs`, so a
//! bundle opened from Finder keeps it and a build made without it can never
//! turn it on. The release workflows never set it
//! (`scripts/demo-core-prerelease-contract.test.ts` pins that). Docs:
//! `docs/dev-switches.md`.
//!
//! When it is on, first-run setup (`commands/content.rs`) and the HQ Core
//! update check and install (`commands/hq_core_state.rs`,
//! `commands/hq_core_update.rs`) accept hq-core prereleases, and refuse any
//! release below [`MIN_CORE_VERSION`]. When it is off, every caller keeps
//! the stable-only rule it had before the switch existed.
//!
//! It also reads every flag in [`DEMO_FLAG_DEFAULTS_ON`] as on when hq-flags
//! answers false, has no answer, or cannot be read: in Rust through
//! `commands::hq_pro::feature_flag_read`, and in the desktop shell through
//! the [`demo_flag_defaults_on`] command, which the Tauri adapter's
//! `hasFeature` consults. Off, the list is empty and every read is unchanged.

use std::cmp::Ordering;

/// The oldest hq-core a demo build installs or offers.
pub const MIN_CORE_VERSION: &str = "16.0.31-beta.6";

fn prerelease_flag() -> Option<&'static str> {
    option_env!("HQ_CORE_PRERELEASE")
}

/// True only in a bundle built with `HQ_CORE_PRERELEASE=1`.
pub fn core_prerelease() -> bool {
    crate::scratch_build::switch_on(prerelease_flag())
}

/// Feature flags a demo build reads as on whatever hq-flags says. Only flags
/// a walk or demo needs belong here: the first-run "Your apps" step and the
/// visual first-run takeover it sits in.
pub const DEMO_FLAG_DEFAULTS_ON: &[&str] = &[
    "desktop.first-run-found-apps-v1",
    "desktop.visual-first-run",
];

/// The flags read as on for a build whose switch is `on`: empty when off.
pub fn flag_defaults_on(on: bool) -> Vec<String> {
    if on {
        DEMO_FLAG_DEFAULTS_ON
            .iter()
            .map(|f| f.to_string())
            .collect()
    } else {
        Vec::new()
    }
}

/// Apply the demo default to one flag read (`Ok(None)`: no answer;
/// `Err(())`: unreadable). On and listed: `Ok(Some(true))`. Otherwise the
/// read unchanged.
pub fn apply_flag_default(
    on: bool,
    flag: &str,
    read: Result<Option<bool>, ()>,
) -> Result<Option<bool>, ()> {
    if on && DEMO_FLAG_DEFAULTS_ON.contains(&flag) {
        Ok(Some(true))
    } else {
        read
    }
}

/// [`apply_flag_default`] for this build's switch.
pub fn flag_default(flag: &str, read: Result<Option<bool>, ()>) -> Result<Option<bool>, ()> {
    apply_flag_default(core_prerelease(), flag, read)
}

/// The flags this build reads as on. Empty in any build made without
/// `HQ_CORE_PRERELEASE`.
#[tauri::command]
pub fn demo_flag_defaults_on() -> Vec<String> {
    flag_defaults_on(core_prerelease())
}

/// One entry of the GitHub releases list.
pub trait CoreRelease {
    fn tag(&self) -> &str;
    fn prerelease(&self) -> bool;
    fn draft(&self) -> bool;
}

fn parse_version(tag: &str) -> Option<semver::Version> {
    semver::Version::parse(tag.trim().trim_start_matches('v')).ok()
}

/// Whether `tag` is at or above [`MIN_CORE_VERSION`]. An unparseable tag is
/// refused.
pub fn meets_minimum(tag: &str) -> bool {
    let min = parse_version(MIN_CORE_VERSION).expect("MIN_CORE_VERSION is valid semver");
    parse_version(tag).is_some_and(|v| v >= min)
}

/// Whether a release may be installed or offered.
///
/// Off: the shipped rule, any non-draft stable. On: any non-draft release at
/// or above [`MIN_CORE_VERSION`], prerelease or not.
pub fn accepts(allow_prerelease: bool, tag: &str, prerelease: bool, draft: bool) -> bool {
    !draft
        && if allow_prerelease {
            meets_minimum(tag)
        } else {
            !prerelease
        }
}

/// Pick the hq-core release to install or offer from a releases list (newest
/// first, as GitHub returns it).
///
/// Off: the first non-draft stable, exactly as before. On: the highest
/// accepted version, because GitHub orders the list by creation date and a
/// stable hotfix cut after a beta would otherwise win.
pub fn select_core_release<T: CoreRelease>(releases: Vec<T>, allow_prerelease: bool) -> Option<T> {
    if !allow_prerelease {
        return releases.into_iter().find(|r| !r.draft() && !r.prerelease());
    }
    releases
        .into_iter()
        .filter(|r| accepts(true, r.tag(), r.prerelease(), r.draft()))
        .filter_map(|r| parse_version(r.tag()).map(|v| (v, r)))
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(_, r)| r)
}

/// `Some(local < latest)` with full semver ordering, prereleases included
/// (`16.0.31-beta.6 < 16.0.31-beta.7 < 16.0.31`). `None` when either side
/// does not parse.
pub fn version_lt(local: &str, latest: &str) -> Option<bool> {
    Some(parse_version(local)?.cmp(&parse_version(latest)?) == Ordering::Less)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Fixture {
        tag: &'static str,
        prerelease: bool,
        draft: bool,
    }

    impl CoreRelease for Fixture {
        fn tag(&self) -> &str {
            self.tag
        }
        fn prerelease(&self) -> bool {
            self.prerelease
        }
        fn draft(&self) -> bool {
            self.draft
        }
    }

    fn stable(tag: &'static str) -> Fixture {
        Fixture {
            tag,
            prerelease: false,
            draft: false,
        }
    }
    fn beta(tag: &'static str) -> Fixture {
        Fixture {
            tag,
            prerelease: true,
            draft: false,
        }
    }
    fn draft(tag: &'static str, prerelease: bool) -> Fixture {
        Fixture {
            tag,
            prerelease,
            draft: true,
        }
    }

    fn pick(list: &[Fixture], allow: bool) -> Option<&'static str> {
        select_core_release(list.to_vec(), allow).map(|r| r.tag)
    }

    /// The rule every caller used before the switch existed.
    fn shipped_rule(list: &[Fixture]) -> Option<&'static str> {
        list.iter()
            .find(|r| !r.prerelease && !r.draft)
            .map(|r| r.tag)
    }

    fn stable_only() -> Vec<Fixture> {
        vec![stable("v16.0.30"), stable("v16.0.29")]
    }
    fn beta_newer_than_stable() -> Vec<Fixture> {
        vec![
            beta("v16.0.31-beta.7"),
            beta("v16.0.31-beta.6"),
            stable("v16.0.30"),
        ]
    }
    fn beta_below_minimum() -> Vec<Fixture> {
        vec![
            beta("v16.0.31-beta.5"),
            beta("v16.0.31-beta.1"),
            stable("v16.0.30"),
        ]
    }
    fn with_drafts() -> Vec<Fixture> {
        vec![
            draft("v16.0.32", false),
            draft("v16.0.32-beta.1", true),
            beta("v16.0.31-beta.6"),
            stable("v16.0.30"),
        ]
    }

    #[test]
    fn switch_off_keeps_the_stable_only_rule_for_every_fixture() {
        for (name, list) in [
            ("stable only", stable_only()),
            ("beta newer than stable", beta_newer_than_stable()),
            ("beta below the minimum", beta_below_minimum()),
            ("draft", with_drafts()),
            ("empty", vec![]),
        ] {
            assert_eq!(pick(&list, false), shipped_rule(&list), "{name}");
        }
        assert_eq!(pick(&stable_only(), false), Some("v16.0.30"));
        assert_eq!(pick(&beta_newer_than_stable(), false), Some("v16.0.30"));
        assert_eq!(pick(&with_drafts(), false), Some("v16.0.30"));
        // Off means no minimum either: an old stable is still taken.
        assert_eq!(pick(&[stable("v15.0.0")], false), Some("v15.0.0"));
        assert!(accepts(false, "v15.0.0", false, false));
        assert!(!accepts(false, "v16.0.31-beta.7", true, false));
    }

    #[test]
    fn switch_on_refuses_a_stable_only_list_below_the_minimum() {
        assert_eq!(pick(&stable_only(), true), None);
        assert_eq!(
            pick(&[stable("v16.0.31"), stable("v16.0.30")], true),
            Some("v16.0.31")
        );
    }

    #[test]
    fn switch_on_takes_a_beta_newer_than_stable() {
        assert_eq!(
            pick(&beta_newer_than_stable(), true),
            Some("v16.0.31-beta.7")
        );
    }

    #[test]
    fn switch_on_refuses_betas_below_the_minimum() {
        assert_eq!(pick(&beta_below_minimum(), true), None);
        assert!(!meets_minimum("v16.0.31-beta.5"));
        assert!(meets_minimum("v16.0.31-beta.6"));
        assert!(meets_minimum("16.0.31-beta.10"));
        assert!(meets_minimum("v16.0.31"));
        assert!(!meets_minimum("v16.0.30"));
        assert!(!meets_minimum("not-a-version"));
    }

    #[test]
    fn switch_on_never_takes_a_draft() {
        assert_eq!(pick(&with_drafts(), true), Some("v16.0.31-beta.6"));
        assert_eq!(pick(&[draft("v17.0.0", false)], true), None);
        assert!(!accepts(true, "v17.0.0", false, true));
        assert!(!accepts(false, "v17.0.0", false, true));
    }

    #[test]
    fn switch_on_picks_the_highest_version_not_the_newest_entry() {
        // A stable hotfix cut after a beta is listed first but is older.
        let list = [
            stable("v16.0.30"),
            beta("v16.0.32-beta.1"),
            beta("v16.0.31-beta.9"),
        ];
        assert_eq!(pick(&list, true), Some("v16.0.32-beta.1"));
        assert_eq!(pick(&list, false), Some("v16.0.30"));
    }

    /// An accepted, lower version listed first must not win. "Take the first
    /// accepted entry" fails both lists.
    #[test]
    fn switch_on_skips_a_lower_accepted_entry_listed_first() {
        let stable_first = [stable("v16.0.31"), beta("v16.0.32-beta.1")];
        assert_eq!(pick(&stable_first, true), Some("v16.0.32-beta.1"));
        assert_eq!(pick(&stable_first, false), Some("v16.0.31"));

        let beta6_first = [beta("v16.0.31-beta.6"), beta("v16.0.31-beta.10")];
        assert_eq!(pick(&beta6_first, true), Some("v16.0.31-beta.10"));
        assert_eq!(pick(&beta6_first, false), None);
    }

    #[test]
    fn version_lt_orders_prereleases() {
        assert_eq!(version_lt("16.0.31-beta.6", "16.0.31-beta.7"), Some(true));
        assert_eq!(version_lt("16.0.31-beta.9", "16.0.31-beta.10"), Some(true));
        assert_eq!(version_lt("16.0.31-beta.6", "16.0.31"), Some(true));
        assert_eq!(version_lt("v16.0.31-beta.6", "v16.0.30"), Some(false));
        assert_eq!(version_lt("16.0.31", "16.0.31"), Some(false));
        assert_eq!(version_lt("garbage", "16.0.31"), None);
    }

    #[test]
    fn this_build_answers_by_its_switch() {
        assert_eq!(
            core_prerelease(),
            crate::scratch_build::switch_on(option_env!("HQ_CORE_PRERELEASE"))
        );
        if option_env!("HQ_CORE_PRERELEASE").is_none() {
            assert!(
                !core_prerelease(),
                "a build without HQ_CORE_PRERELEASE never takes prereleases"
            );
        }
    }

    const FOUND_APPS: &str = "desktop.first-run-found-apps-v1";
    const VISUAL_FIRST_RUN: &str = "desktop.visual-first-run";
    const LISTED: [&str; 2] = [FOUND_APPS, VISUAL_FIRST_RUN];

    #[test]
    fn defaults_on_lists_only_the_found_apps_and_visual_first_run_flags() {
        assert_eq!(DEMO_FLAG_DEFAULTS_ON, &LISTED);
    }

    #[test]
    fn switch_on_server_false_reads_true() {
        for flag in LISTED {
            assert_eq!(
                apply_flag_default(true, flag, Ok(Some(false))),
                Ok(Some(true)),
                "{flag}"
            );
            assert_eq!(
                apply_flag_default(true, flag, Ok(Some(true))),
                Ok(Some(true)),
                "{flag}"
            );
        }
    }

    #[test]
    fn switch_on_server_error_or_none_reads_true() {
        for flag in LISTED {
            assert_eq!(
                apply_flag_default(true, flag, Err(())),
                Ok(Some(true)),
                "{flag}"
            );
            assert_eq!(
                apply_flag_default(true, flag, Ok(None)),
                Ok(Some(true)),
                "{flag}"
            );
        }
    }

    #[test]
    fn switch_off_server_false_reads_false() {
        for flag in LISTED {
            assert_eq!(
                apply_flag_default(false, flag, Ok(Some(false))),
                Ok(Some(false)),
                "{flag}"
            );
        }
    }

    #[test]
    fn switch_off_server_none_reads_none() {
        for flag in LISTED {
            assert_eq!(
                apply_flag_default(false, flag, Ok(None)),
                Ok(None),
                "{flag}"
            );
            assert_eq!(apply_flag_default(false, flag, Err(())), Err(()), "{flag}");
            assert_eq!(
                apply_flag_default(false, flag, Ok(Some(true))),
                Ok(Some(true)),
                "{flag}"
            );
        }
    }

    #[test]
    fn other_flags_are_never_affected() {
        for on in [true, false] {
            for flag in [
                "desktop.first-folder-sync-step-v1",
                "desktop.hq-daemon",
                "",
                "desktop.first-run-found-apps",
                "desktop.visual-first-run-v2",
            ] {
                assert!(!DEMO_FLAG_DEFAULTS_ON.contains(&flag), "{flag}");
                for read in [Ok(Some(false)), Ok(Some(true)), Ok(None), Err(())] {
                    assert_eq!(apply_flag_default(on, flag, read), read, "{on} {flag}");
                }
            }
        }
    }

    #[test]
    fn defaults_on_list_is_empty_when_the_switch_is_off() {
        assert!(flag_defaults_on(false).is_empty());
        assert_eq!(
            flag_defaults_on(true),
            vec![FOUND_APPS.to_string(), VISUAL_FIRST_RUN.to_string()]
        );
    }

    #[test]
    fn this_build_applies_defaults_by_its_switch() {
        assert_eq!(demo_flag_defaults_on(), flag_defaults_on(core_prerelease()));
        for flag in LISTED {
            assert_eq!(
                flag_default(flag, Ok(Some(false))),
                apply_flag_default(core_prerelease(), flag, Ok(Some(false))),
                "{flag}"
            );
        }
    }
}
