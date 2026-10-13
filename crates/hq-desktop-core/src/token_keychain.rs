//! Keychain mirror of the person Cognito token cache (step 2 of the move off
//! `~/.hq/cognito-tokens.json`).
//!
//! Step 2 rules, while the hq CLI, hq-cloud and HQ scripts still read and
//! write only the file:
//! - Every desktop write goes to the file AND to the Keychain item.
//! - Every desktop sign-out removes both.
//! - Reads prefer the Keychain value, but the file decides any conflict,
//!   because another tool may have written or removed it since the desktop's
//!   last write:
//!   * file and Keychain agree: the Keychain value is used;
//!   * file present and different (or Keychain empty): the file wins and the
//!     Keychain is re-synced;
//!   * file absent, Keychain present: another tool signed out; the Keychain
//!     item is removed;
//!   * file unreadable (I/O or parse error), Keychain present: the Keychain
//!     value is used. This is the fallback the Keychain adds in step 2.
//! - The file is never deleted for migration here. That is step 3, after the
//!   supported CLI versions read the Keychain.
//!
//! The item is a generic password in the login keychain:
//! service [`KEYCHAIN_SERVICE`], account [`KEYCHAIN_ACCOUNT`], value = the
//! same camelCase JSON as the file. On macOS the login keychain scopes
//! no-prompt access by the signer's partition (`teamid:HWFZ2QDTMR`), so the
//! signing Team ID must stay unchanged.
//!
//! The real Keychain is used only in signed release builds on macOS. Debug
//! builds, unit tests (`HQ_TEST_HOME`), scratch builds (`HQ_SCRATCH_BUILD`)
//! and `HQ_TOKEN_KEYCHAIN=0` never touch it, so a local test app cannot
//! overwrite the owner's signed-in item. `HQ_TOKEN_KEYCHAIN=1` opts a debug
//! build in. Values are never logged.

use std::sync::{Arc, Mutex, OnceLock};

/// Shared item name. Proposed for the CLI lane to use as well.
pub const KEYCHAIN_SERVICE: &str = "ai.indigo.hq.cognito-tokens";
/// Shared item account: the person session (machine/agent mints stay in their
/// own state dirs and are out of scope).
pub const KEYCHAIN_ACCOUNT: &str = "person";
/// Apple Team ID whose partition owns the item. Informational; the OS takes it
/// from the code signature.
pub const KEYCHAIN_TEAM_ID: &str = "HWFZ2QDTMR";

/// A single secret slot. Implementations must not log the value.
pub trait SecretStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, value: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

#[cfg(target_os = "macos")]
struct MacLoginKeychain;

#[cfg(target_os = "macos")]
impl SecretStore for MacLoginKeychain {
    fn get(&self) -> Result<Option<String>, String> {
        use security_framework::passwords::get_generic_password;
        match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "Keychain token item is not UTF-8".to_string()),
            Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(err) => Err(format!("Keychain read failed: OSStatus {}", err.code())),
        }
    }

    fn set(&self, value: &str) -> Result<(), String> {
        security_framework::passwords::set_generic_password(
            KEYCHAIN_SERVICE,
            KEYCHAIN_ACCOUNT,
            value.as_bytes(),
        )
        .map_err(|err| format!("Keychain write failed: OSStatus {}", err.code()))
    }

    fn delete(&self) -> Result<(), String> {
        match security_framework::passwords::delete_generic_password(
            KEYCHAIN_SERVICE,
            KEYCHAIN_ACCOUNT,
        ) {
            Ok(()) => Ok(()),
            Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(err) => Err(format!("Keychain delete failed: OSStatus {}", err.code())),
        }
    }
}

#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

type StoreOverride = Mutex<Option<Arc<dyn SecretStore>>>;
static STORE_OVERRIDE: OnceLock<StoreOverride> = OnceLock::new();

fn store_override() -> &'static StoreOverride {
    STORE_OVERRIDE.get_or_init(|| Mutex::new(None))
}

/// Replace the store (tests only). `None` restores the default selection.
#[cfg(any(test, feature = "test-support"))]
pub fn set_store_for_tests(store: Option<Arc<dyn SecretStore>>) {
    *store_override().lock().unwrap_or_else(|p| p.into_inner()) = store;
}

fn env_flag(name: &str) -> Option<bool> {
    match std::env::var(name).ok()?.trim() {
        "1" | "true" | "yes" => Some(true),
        "0" | "false" | "no" => Some(false),
        _ => None,
    }
}

/// Whether the real Keychain may be used in this process.
fn real_keychain_enabled() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    if std::env::var_os("HQ_TEST_HOME").is_some() || std::env::var_os("HQ_SCRATCH_BUILD").is_some()
    {
        return false;
    }
    match env_flag("HQ_TOKEN_KEYCHAIN") {
        Some(explicit) => explicit,
        None => !cfg!(debug_assertions),
    }
}

/// The active store, or `None` when the Keychain mirror is off.
pub fn active_store() -> Option<Arc<dyn SecretStore>> {
    if let Some(store) = store_override()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
    {
        return Some(store);
    }
    if !real_keychain_enabled() {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        Some(Arc::new(MacLoginKeychain))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// What the file read produced, reduced to what reconciliation needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileState<T> {
    Present(T),
    Absent,
    Unreadable,
}

/// Follow-up work on the Keychain after a read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeychainAction {
    None,
    /// Write the file value into the Keychain.
    Resync,
    /// Remove the Keychain item.
    Delete,
}

/// Decide which value a read returns and what to do with the Keychain. See the
/// module docs for the rules. `keychain` is `None` when the item is missing,
/// unreadable, or does not parse.
pub fn reconcile<T: PartialEq + Clone>(
    file: FileState<T>,
    keychain: Option<T>,
) -> (Option<T>, KeychainAction) {
    match (file, keychain) {
        (FileState::Present(f), Some(k)) if f == k => (Some(k), KeychainAction::None),
        (FileState::Present(f), _) => (Some(f), KeychainAction::Resync),
        (FileState::Absent, Some(_)) => (None, KeychainAction::Delete),
        (FileState::Absent, None) => (None, KeychainAction::None),
        (FileState::Unreadable, Some(k)) => (Some(k), KeychainAction::None),
        (FileState::Unreadable, None) => (None, KeychainAction::None),
    }
}

/// Set once this process has confirmed the item is gone, so repeated
/// signed-out reads do not hit the Keychain each time.
static KNOWN_EMPTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Best-effort mirror write. Failures are logged without values and never
/// fail the file write that the other tools depend on.
pub fn mirror_write(json: &str) {
    if let Some(store) = active_store() {
        KNOWN_EMPTY.store(false, std::sync::atomic::Ordering::SeqCst);
        if let Err(err) = store.set(json) {
            eprintln!("[token-keychain] mirror write skipped: {err}");
        }
    }
}

/// Best-effort mirror delete (sign-out).
pub fn mirror_delete() {
    if let Some(store) = active_store() {
        match store.delete() {
            Ok(()) => KNOWN_EMPTY.store(true, std::sync::atomic::Ordering::SeqCst),
            Err(err) => eprintln!("[token-keychain] mirror delete skipped: {err}"),
        }
    }
}

/// Mirror delete for a read that found no file. Skips the Keychain call when
/// this process already removed the item.
pub fn mirror_delete_if_not_known_empty() {
    if !KNOWN_EMPTY.load(std::sync::atomic::Ordering::SeqCst) {
        mirror_delete();
    }
}

/// Reset the known-empty flag (tests swap stores between cases).
#[cfg(any(test, feature = "test-support"))]
pub fn reset_known_empty_for_tests() {
    KNOWN_EMPTY.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// Read the mirror value. `None` when off, missing, or unreadable.
pub fn mirror_read() -> Option<String> {
    let store = active_store()?;
    match store.get() {
        Ok(value) => value,
        Err(err) => {
            eprintln!("[token-keychain] mirror read skipped: {err}");
            None
        }
    }
}

/// In-memory store for tests.
#[cfg(any(test, feature = "test-support"))]
#[derive(Default)]
pub struct MemoryStore {
    pub value: Mutex<Option<String>>,
    pub fail: std::sync::atomic::AtomicBool,
}

#[cfg(any(test, feature = "test-support"))]
impl MemoryStore {
    fn check(&self) -> Result<(), String> {
        if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
            Err("Keychain unavailable (test)".to_string())
        } else {
            Ok(())
        }
    }
    pub fn current(&self) -> Option<String> {
        self.value.lock().unwrap().clone()
    }
}

#[cfg(any(test, feature = "test-support"))]
impl SecretStore for MemoryStore {
    fn get(&self) -> Result<Option<String>, String> {
        self.check()?;
        Ok(self.value.lock().unwrap().clone())
    }
    fn set(&self, value: &str) -> Result<(), String> {
        self.check()?;
        *self.value.lock().unwrap() = Some(value.to_string());
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        self.check()?;
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_values_prefer_the_keychain() {
        assert_eq!(
            reconcile(FileState::Present(1), Some(1)),
            (Some(1), KeychainAction::None)
        );
    }

    #[test]
    fn a_different_file_wins_and_resyncs_the_keychain() {
        // Another tool (hq login, hq-cloud refresh) wrote the file.
        assert_eq!(
            reconcile(FileState::Present(2), Some(1)),
            (Some(2), KeychainAction::Resync)
        );
    }

    #[test]
    fn a_file_without_a_keychain_item_is_migrated_into_it() {
        assert_eq!(
            reconcile(FileState::Present(2), None),
            (Some(2), KeychainAction::Resync)
        );
    }

    #[test]
    fn a_removed_file_means_signed_out_and_clears_the_keychain() {
        // `hq logout` deletes the file; the Keychain must not revive it.
        assert_eq!(
            reconcile::<i32>(FileState::Absent, Some(1)),
            (None, KeychainAction::Delete)
        );
        assert_eq!(
            reconcile::<i32>(FileState::Absent, None),
            (None, KeychainAction::None)
        );
    }

    #[test]
    fn an_unreadable_file_falls_back_to_the_keychain() {
        assert_eq!(
            reconcile(FileState::Unreadable, Some(3)),
            (Some(3), KeychainAction::None)
        );
        assert_eq!(
            reconcile::<i32>(FileState::Unreadable, None),
            (None, KeychainAction::None)
        );
    }

    #[test]
    fn real_keychain_is_off_under_test_home_and_scratch_builds() {
        let _lock = crate::cognito::HQ_TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let previous = std::env::var_os("HQ_TEST_HOME");
        std::env::set_var("HQ_TEST_HOME", "/nonexistent-test-home");
        assert!(!real_keychain_enabled());
        match previous {
            Some(v) => std::env::set_var("HQ_TEST_HOME", v),
            None => std::env::remove_var("HQ_TEST_HOME"),
        }
        // Debug test binaries never use the real Keychain by default either.
        if std::env::var_os("HQ_TOKEN_KEYCHAIN").is_none() {
            assert!(!real_keychain_enabled());
        }
    }

    #[test]
    fn proposed_item_name_is_stable() {
        assert_eq!(KEYCHAIN_SERVICE, "ai.indigo.hq.cognito-tokens");
        assert_eq!(KEYCHAIN_ACCOUNT, "person");
        assert_eq!(KEYCHAIN_TEAM_ID, "HWFZ2QDTMR");
    }
}
