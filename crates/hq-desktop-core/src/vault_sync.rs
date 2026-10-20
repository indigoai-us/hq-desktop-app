//! Per-vault sync switches (usage-only-pricing US-016).
//!
//! Settings › Sync has one switch per vault (the personal vault and each
//! company vault) plus one "Turn off all cloud sync" switch. All three live in
//! the desktop settings file (`menubar.json` under the HQ state directory),
//! outside the app bundle, so they survive restarts and app updates, and the
//! HQ CLI reads the same keys:
//!
//! - `cloudPaused: true` turns sync off for every vault;
//! - `personalSyncEnabled: false` turns the personal vault off;
//! - `workspaceSyncEnabled: { "<slug>": false }` turns one company vault off.
//!
//! The switches only affect this computer. Teammates keep syncing.
//!
//! The background runner already skips off vaults through
//! `HQ_SYNC_SKIP_PERSONAL` / `HQ_SYNC_SKIP_COMPANIES`
//! ([`crate::daemon::sync_child_env`]). This module is the one place the
//! one-off paths (personal first push, conflict resolve, placeholder fetch)
//! ask whether a single vault may sync.

use serde::Serialize;
use std::collections::BTreeMap;

/// One vault a sync path is about to touch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncVault {
    Personal,
    Company(String),
}

/// A snapshot of every switch, as Settings reads it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSyncSwitches {
    /// "Turn off all cloud sync" is on.
    pub all_off: bool,
    /// The personal vault's own switch.
    pub personal_enabled: bool,
    /// Company slugs with an explicit switch value. Missing means on.
    pub companies: BTreeMap<String, bool>,
    /// Company display names by slug, for the "Sync is off for" refusal.
    /// Not sent to the UI, which has its own names.
    #[serde(skip)]
    pub company_names: BTreeMap<String, String>,
}

impl VaultSyncSwitches {
    /// Read every switch from the settings file. Missing values mean on.
    pub fn read() -> Self {
        Self {
            all_off: crate::daemon::is_cloud_paused(),
            personal_enabled: crate::daemon::is_personal_sync_enabled(),
            companies: crate::workspaces::read_workspace_sync_enabled_map(),
            company_names: read_company_display_names(),
        }
    }

    /// True when at least one vault (or every vault) is switched off.
    pub fn any_off(&self) -> bool {
        self.all_off || !self.personal_enabled || self.companies.values().any(|on| !*on)
    }

    /// Whether `vault` may upload or download right now.
    pub fn allows(&self, vault: &SyncVault) -> bool {
        if self.all_off {
            return false;
        }
        match vault {
            SyncVault::Personal => self.personal_enabled,
            SyncVault::Company(slug) => company_enabled(&self.companies, slug),
        }
    }

    /// The plain-language refusal for `vault`, or None when it may sync.
    pub fn refusal(&self, vault: &SyncVault) -> Option<String> {
        if self.all_off {
            return Some(crate::daemon::CLOUD_PAUSED_MESSAGE.to_string());
        }
        if self.allows(vault) {
            return None;
        }
        let name = match vault {
            SyncVault::Personal => None,
            SyncVault::Company(slug) => lookup_ci(&self.company_names, slug).map(String::as_str),
        };
        Some(vault_off_message_named(vault, name))
    }
}

/// Case-insensitive slug lookup, exact match first.
fn lookup_ci<'a, V>(map: &'a BTreeMap<String, V>, slug: &str) -> Option<&'a V> {
    map.get(slug).or_else(|| {
        map.iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(slug))
            .map(|(_, value)| value)
    })
}

/// Slug match is case-insensitive, like the runner's `HQ_SYNC_SKIP_COMPANIES`.
fn company_enabled(map: &BTreeMap<String, bool>, slug: &str) -> bool {
    lookup_ci(map, slug).copied().unwrap_or(true)
}

/// "Sync is off for <vault> on this computer." plus how to turn it back on.
/// A company is named by its display name from the saved company names, or
/// by its slug when no name is known.
pub fn vault_off_message(vault: &SyncVault) -> String {
    let names = match vault {
        SyncVault::Personal => BTreeMap::new(),
        SyncVault::Company(_) => read_company_display_names(),
    };
    let name = match vault {
        SyncVault::Personal => None,
        SyncVault::Company(slug) => lookup_ci(&names, slug).map(String::as_str),
    };
    vault_off_message_named(vault, name)
}

/// [`vault_off_message`] with the company's display name given. A missing or
/// blank name falls back to the slug.
pub fn vault_off_message_named(vault: &SyncVault, company_name: Option<&str>) -> String {
    let name = match vault {
        SyncVault::Personal => "your personal vault".to_string(),
        SyncVault::Company(slug) => company_name
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(slug)
            .to_string(),
    };
    format!(
        "Sync is off for {name} on this computer. To sync it again, turn it back on in Settings › Sync."
    )
}

// ── Company display names ─────────────────────────────────────────────────
//
// The refusal names a company by its display name. The one-off sync paths only
// know the slug, and a switched-off company may have no local folder, so the
// workspace list (local folders plus cloud memberships) saves slug -> name
// here each time it is built, and the refusal reads it back.

const COMPANY_NAMES_FILE: &str = "company-display-names.json";

fn company_names_path() -> Option<std::path::PathBuf> {
    crate::paths::hq_config_dir()
        .ok()
        .map(|dir| dir.join(COMPANY_NAMES_FILE))
}

/// Saved company display names by slug. Missing or unreadable means none.
pub fn read_company_display_names() -> BTreeMap<String, String> {
    company_names_path()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<BTreeMap<String, String>>(&bytes).ok())
        .unwrap_or_default()
}

/// Merge `names` (slug -> display name) into the saved names. Blank names are
/// ignored. Writes only when something changed, through a temp file renamed
/// over the original.
pub fn save_company_display_names<'a>(
    names: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Result<(), String> {
    let path = company_names_path().ok_or("no HQ config directory")?;
    let mut saved = read_company_display_names();
    let mut changed = false;
    for (slug, name) in names {
        let (slug, name) = (slug.trim(), name.trim());
        if slug.is_empty() || name.is_empty() {
            continue;
        }
        if saved.get(slug).map(String::as_str) != Some(name) {
            saved.insert(slug.to_string(), name.to_string());
            changed = true;
        }
    }
    if !changed {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_vec_pretty(&saved).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// `Err(message)` when `vault` may not sync; `Ok(())` otherwise.
pub fn ensure_vault_sync_allowed(vault: &SyncVault) -> Result<(), String> {
    match VaultSyncSwitches::read().refusal(vault) {
        Some(message) => Err(message),
        None => Ok(()),
    }
}

/// The vault an HQ-relative path belongs to: `companies/<slug>/…` is that
/// company's vault; anything else is the personal vault.
///
/// The path is normalized lexically first, so `./companies/acme`,
/// `//companies/acme`, `companies//acme`, `x/../companies/acme` and Windows
/// separators all name the acme vault. `companies` matches case-insensitively
/// because the default macOS and Windows file systems do. A path whose `..`
/// climbs above the HQ root belongs to no vault inside it; callers validate
/// and reject such paths separately, and here it maps to the personal vault.
pub fn vault_for_hq_relative_path(relative: &str) -> SyncVault {
    let mut parts: Vec<&str> = Vec::new();
    for part in relative.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return SyncVault::Personal;
                }
            }
            other => parts.push(other),
        }
    }
    match parts.as_slice() {
        [root, slug, ..] if root.eq_ignore_ascii_case("companies") => {
            SyncVault::Company((*slug).to_string())
        }
        _ => SyncVault::Personal,
    }
}

/// Why "Move to cloud" refuses while any vault is off. `hq storage offload`
/// has no per-vault scope, and a file moved out of an off vault could not be
/// opened again (the placeholder fetch refuses for an off vault).
pub const OFFLOAD_VAULT_OFF_MESSAGE: &str = "Move to cloud is not available while sync is off for one or more vaults on this computer, because files moved from an off vault could not be opened again until it syncs. Turn those vaults back on in Settings › Sync first.";

/// `Err` when "Move to cloud" must not run: all sync off, or any vault off.
pub fn ensure_offload_allowed() -> Result<(), String> {
    offload_refusal(&VaultSyncSwitches::read()).map_or(Ok(()), Err)
}

/// The "Move to cloud" refusal for `switches`, or None when it may run.
pub fn offload_refusal(switches: &VaultSyncSwitches) -> Option<String> {
    if switches.all_off {
        Some(crate::daemon::CLOUD_PAUSED_MESSAGE.to_string())
    } else if switches.any_off() {
        Some(OFFLOAD_VAULT_OFF_MESSAGE.to_string())
    } else {
        None
    }
}

// ── HQ CLI support for the switches ───────────────────────────────────────
//
// The app runs a managed HQ CLI. CLIs before hq-cli#1862 ignore the per-vault
// switches: their `hq sync` (used by /handoff, /startwork, /delegate) and
// their `hq daemon` background sync keep syncing a vault that Settings shows
// as off. There is no version number to compare against until #1862 ships, so
// the app checks for the module that release adds.

/// File present in every hq-cli release that honours the switches.
pub const CLI_VAULT_SWITCH_MODULE: &str = "dist/lib/vault-sync-switches.js";

const CLI_PACKAGE: &str = "@indigoai-us/hq-cli";

fn is_cli_package_dir(dir: &std::path::Path) -> bool {
    std::fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|pkg| {
            pkg.get("name")
                .and_then(|n| n.as_str())
                .map(|n| n == CLI_PACKAGE)
        })
        .unwrap_or(false)
}

/// The hq-cli package directory behind an `hq` executable: the package the
/// symlinked bin points into, or the npm-global layout next to a Windows
/// `.cmd` shim. None when it cannot be found.
pub fn cli_package_dir_for_bin(bin: &std::path::Path) -> Option<std::path::PathBuf> {
    let real = std::fs::canonicalize(bin).unwrap_or_else(|_| bin.to_path_buf());
    for dir in real.ancestors().skip(1).take(6) {
        if is_cli_package_dir(dir) {
            return Some(dir.to_path_buf());
        }
    }
    let bin_dir = bin.parent()?;
    for candidate in [
        bin_dir.join("node_modules").join(CLI_PACKAGE),
        bin_dir
            .join("..")
            .join("lib")
            .join("node_modules")
            .join(CLI_PACKAGE),
    ] {
        if is_cli_package_dir(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Whether the hq-cli package at `package_dir` honours the switches.
pub fn cli_package_honours_vault_switches(package_dir: &std::path::Path) -> bool {
    package_dir.join(CLI_VAULT_SWITCH_MODULE).is_file()
}

/// Whether the HQ CLI this app runs honours the per-vault switches. None when
/// it cannot tell (no local CLI, or the npx fallback). May probe the CLI the
/// first time; call it off the main thread.
pub fn cli_honours_vault_switches() -> Option<bool> {
    match crate::hq_resolver::resolve_hq() {
        crate::hq_resolver::HqInvocation::Local(path) => {
            cli_package_dir_for_bin(std::path::Path::new(&path))
                .map(|dir| cli_package_honours_vault_switches(&dir))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_cli(root: &std::path::Path, with_module: bool) -> std::path::PathBuf {
        let pkg = root.join("lib/node_modules/@indigoai-us/hq-cli");
        std::fs::create_dir_all(pkg.join("dist/lib")).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"@indigoai-us/hq-cli"}"#,
        )
        .unwrap();
        std::fs::write(pkg.join("dist/index.js"), "").unwrap();
        if with_module {
            std::fs::write(pkg.join(CLI_VAULT_SWITCH_MODULE), "").unwrap();
        }
        pkg
    }

    #[test]
    fn finds_the_cli_package_behind_a_symlinked_bin_and_checks_the_module() {
        let tmp = tempfile::TempDir::new().unwrap();
        let pkg = fake_cli(tmp.path(), true);
        std::fs::create_dir_all(tmp.path().join("bin")).unwrap();
        let bin = tmp.path().join("bin/hq");
        #[cfg(unix)]
        std::os::unix::fs::symlink(pkg.join("dist/index.js"), &bin).unwrap();
        #[cfg(not(unix))]
        std::fs::write(&bin, "").unwrap();
        let dir = cli_package_dir_for_bin(&bin).expect("package dir");
        assert!(cli_package_honours_vault_switches(&dir));
    }

    #[test]
    fn an_older_cli_without_the_module_does_not_honour_the_switches() {
        let tmp = tempfile::TempDir::new().unwrap();
        let pkg = fake_cli(tmp.path(), false);
        assert!(!cli_package_honours_vault_switches(&pkg));
        // npm-global layout next to a shim: <prefix>/bin/hq -> ../lib/node_modules/...
        std::fs::create_dir_all(tmp.path().join("bin")).unwrap();
        let shim = tmp.path().join("bin/hq.cmd");
        std::fs::write(&shim, "").unwrap();
        let dir = cli_package_dir_for_bin(&shim).expect("package dir via npm layout");
        assert!(!cli_package_honours_vault_switches(&dir));
    }

    #[test]
    fn move_to_cloud_refuses_while_any_vault_is_off() {
        let mut s = VaultSyncSwitches {
            all_off: false,
            personal_enabled: true,
            companies: BTreeMap::new(),
            company_names: BTreeMap::new(),
        };
        assert_eq!(offload_refusal(&s), None);
        s.companies.insert("acme".into(), false);
        assert_eq!(
            offload_refusal(&s).as_deref(),
            Some(OFFLOAD_VAULT_OFF_MESSAGE)
        );
        s.companies.insert("acme".into(), true);
        s.personal_enabled = false;
        assert_eq!(
            offload_refusal(&s).as_deref(),
            Some(OFFLOAD_VAULT_OFF_MESSAGE)
        );
        s.all_off = true;
        assert_eq!(
            offload_refusal(&s).as_deref(),
            Some(crate::daemon::CLOUD_PAUSED_MESSAGE)
        );
    }

    #[test]
    fn any_off_reports_whether_a_switch_is_off() {
        let mut s = VaultSyncSwitches {
            all_off: false,
            personal_enabled: true,
            companies: BTreeMap::new(),
            company_names: BTreeMap::new(),
        };
        assert!(!s.any_off());
        s.companies.insert("acme".into(), true);
        assert!(!s.any_off());
        s.companies.insert("zeta".into(), false);
        assert!(s.any_off());
    }

    fn switches(all_off: bool, personal: bool, companies: &[(&str, bool)]) -> VaultSyncSwitches {
        VaultSyncSwitches {
            all_off,
            personal_enabled: personal,
            companies: companies
                .iter()
                .map(|(slug, on)| (slug.to_string(), *on))
                .collect(),
            company_names: BTreeMap::new(),
        }
    }

    #[test]
    fn all_off_refuses_every_vault() {
        let s = switches(true, true, &[]);
        assert!(!s.allows(&SyncVault::Personal));
        assert!(!s.allows(&SyncVault::Company("acme".into())));
        assert_eq!(
            s.refusal(&SyncVault::Personal).as_deref(),
            Some(crate::daemon::CLOUD_PAUSED_MESSAGE)
        );
    }

    #[test]
    fn personal_off_leaves_companies_syncing() {
        let s = switches(false, false, &[]);
        assert!(!s.allows(&SyncVault::Personal));
        assert!(s.allows(&SyncVault::Company("acme".into())));
        assert_eq!(
            s.refusal(&SyncVault::Personal).unwrap(),
            "Sync is off for your personal vault on this computer. To sync it again, turn it back on in Settings › Sync."
        );
    }

    #[test]
    fn one_company_off_leaves_personal_and_other_companies_syncing() {
        let s = switches(false, true, &[("acme", false), ("zeta", true)]);
        assert!(!s.allows(&SyncVault::Company("acme".into())));
        assert!(!s.allows(&SyncVault::Company("ACME".into())));
        assert!(s.allows(&SyncVault::Company("zeta".into())));
        assert!(s.allows(&SyncVault::Company("other".into())));
        assert!(s.allows(&SyncVault::Personal));
        assert_eq!(
            s.refusal(&SyncVault::Company("acme".into())).unwrap(),
            "Sync is off for acme on this computer. To sync it again, turn it back on in Settings › Sync."
        );
    }

    #[test]
    fn a_company_refusal_uses_its_display_name() {
        let mut s = switches(false, true, &[("acme", false)]);
        s.company_names.insert("acme".into(), "Acme Corp".into());
        assert_eq!(
            s.refusal(&SyncVault::Company("acme".into())).unwrap(),
            "Sync is off for Acme Corp on this computer. To sync it again, turn it back on in Settings › Sync."
        );
        // The name lookup matches slugs case-insensitively, like the switch.
        assert_eq!(
            s.refusal(&SyncVault::Company("ACME".into())).unwrap(),
            "Sync is off for Acme Corp on this computer. To sync it again, turn it back on in Settings › Sync."
        );
    }

    #[test]
    fn a_company_refusal_falls_back_to_the_slug_without_a_display_name() {
        let mut s = switches(false, true, &[("acme", false)]);
        s.company_names.insert("zeta".into(), "Zeta Inc".into());
        assert_eq!(
            s.refusal(&SyncVault::Company("acme".into())).unwrap(),
            "Sync is off for acme on this computer. To sync it again, turn it back on in Settings › Sync."
        );
        // A blank saved name also falls back to the slug.
        assert_eq!(
            vault_off_message_named(&SyncVault::Company("acme".into()), Some("  ")),
            "Sync is off for acme on this computer. To sync it again, turn it back on in Settings › Sync."
        );
        assert_eq!(
            vault_off_message_named(&SyncVault::Company("acme".into()), None),
            "Sync is off for acme on this computer. To sync it again, turn it back on in Settings › Sync."
        );
    }

    #[test]
    fn saved_company_names_round_trip_and_feed_the_refusal() {
        let _g = crate::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::TempDir::new().unwrap();
        let _home = crate::test_support::ScopedEnv::set("HOME", tmp.path());
        assert!(read_company_display_names().is_empty());
        assert_eq!(
            vault_off_message(&SyncVault::Company("acme".into())),
            "Sync is off for acme on this computer. To sync it again, turn it back on in Settings › Sync."
        );
        save_company_display_names([("acme", "Acme Corp"), ("blank", "  ")]).unwrap();
        save_company_display_names([("zeta", "Zeta Inc")]).unwrap();
        let names = read_company_display_names();
        assert_eq!(names.get("acme").map(String::as_str), Some("Acme Corp"));
        assert_eq!(names.get("zeta").map(String::as_str), Some("Zeta Inc"));
        assert!(!names.contains_key("blank"));
        assert_eq!(
            vault_off_message(&SyncVault::Company("acme".into())),
            "Sync is off for Acme Corp on this computer. To sync it again, turn it back on in Settings › Sync."
        );
        std::fs::write(
            tmp.path().join(".hq/menubar.json"),
            r#"{"workspaceSyncEnabled":{"acme":false}}"#,
        )
        .unwrap();
        assert_eq!(
            ensure_vault_sync_allowed(&SyncVault::Company("acme".into())),
            Err("Sync is off for Acme Corp on this computer. To sync it again, turn it back on in Settings › Sync.".to_string())
        );
    }

    #[test]
    fn hq_relative_paths_map_to_their_vault() {
        assert_eq!(
            vault_for_hq_relative_path("companies/acme/knowledge/a.md"),
            SyncVault::Company("acme".into())
        );
        assert_eq!(
            vault_for_hq_relative_path("/companies/acme"),
            SyncVault::Company("acme".into())
        );
        assert_eq!(
            vault_for_hq_relative_path("knowledge/a.md"),
            SyncVault::Personal
        );
        assert_eq!(
            vault_for_hq_relative_path("companies/"),
            SyncVault::Personal
        );
    }

    /// Review finding: `./` and `//` prefixes used to skip the company check.
    #[test]
    fn dot_double_slash_and_parent_segments_still_name_the_company_vault() {
        let acme = SyncVault::Company("acme".into());
        for path in [
            "./companies/acme/notes.md",
            "//companies/acme/notes.md",
            ".//companies/acme/notes.md",
            "companies//acme/notes.md",
            "companies/./acme/notes.md",
            "knowledge/../companies/acme/notes.md",
            "companies/zeta/../acme/notes.md",
            ".\\companies\\acme\\notes.md",
            "Companies/acme/notes.md",
        ] {
            assert_eq!(vault_for_hq_relative_path(path), acme, "{path}");
        }
        assert_eq!(
            vault_for_hq_relative_path("companies/acme/../../knowledge/a.md"),
            SyncVault::Personal
        );
        // `..` above the HQ root is not inside any vault.
        assert_eq!(
            vault_for_hq_relative_path("../companies/acme/notes.md"),
            SyncVault::Personal
        );
        assert_eq!(
            vault_for_hq_relative_path("./knowledge/a.md"),
            SyncVault::Personal
        );
    }
}
