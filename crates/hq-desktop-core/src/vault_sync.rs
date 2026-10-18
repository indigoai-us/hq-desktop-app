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
}

impl VaultSyncSwitches {
    /// Read every switch from the settings file. Missing values mean on.
    pub fn read() -> Self {
        Self {
            all_off: crate::daemon::is_cloud_paused(),
            personal_enabled: crate::daemon::is_personal_sync_enabled(),
            companies: crate::workspaces::read_workspace_sync_enabled_map(),
        }
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
        Some(vault_off_message(vault))
    }
}

/// Slug match is case-insensitive, like the runner's `HQ_SYNC_SKIP_COMPANIES`.
fn company_enabled(map: &BTreeMap<String, bool>, slug: &str) -> bool {
    if let Some(enabled) = map.get(slug) {
        return *enabled;
    }
    map.iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(slug))
        .map(|(_, enabled)| *enabled)
        .unwrap_or(true)
}

/// "Sync is off for <vault> on this computer." plus how to turn it back on.
pub fn vault_off_message(vault: &SyncVault) -> String {
    let name = match vault {
        SyncVault::Personal => "your personal vault".to_string(),
        SyncVault::Company(slug) => slug.clone(),
    };
    format!(
        "Sync is off for {name} on this computer. To sync it again, turn it back on in Settings › Sync."
    )
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
pub fn vault_for_hq_relative_path(relative: &str) -> SyncVault {
    let normalized = relative.trim_start_matches(['/', '\\']).replace('\\', "/");
    let mut parts = normalized.split('/');
    if parts.next() == Some("companies") {
        if let Some(slug) = parts.next().filter(|s| !s.is_empty()) {
            return SyncVault::Company(slug.to_string());
        }
    }
    SyncVault::Personal
}

#[cfg(test)]
mod tests {
    use super::*;

    fn switches(all_off: bool, personal: bool, companies: &[(&str, bool)]) -> VaultSyncSwitches {
        VaultSyncSwitches {
            all_off,
            personal_enabled: personal,
            companies: companies
                .iter()
                .map(|(slug, on)| (slug.to_string(), *on))
                .collect(),
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
        assert!(s
            .refusal(&SyncVault::Company("acme".into()))
            .unwrap()
            .starts_with("Sync is off for acme on this computer."));
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
}
