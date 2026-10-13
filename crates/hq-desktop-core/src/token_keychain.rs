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
impl MacLoginKeychain {
    /// Fail fast instead of prompting. With no default keychain (an isolated
    /// HOME, as in the release artifact smoke) a write makes macOS show the
    /// modal "Keychain Not Found" dialog and block until someone answers it,
    /// which stalled v0.11.8-beta.1 before its window opened. The returned
    /// guard turns any other prompt (locked keychain, ACL) into an error.
    fn non_interactive(
    ) -> Result<security_framework::os::macos::keychain::KeychainUserInteractionLock, String> {
        use security_framework::os::macos::keychain::SecKeychain;
        SecKeychain::default()
            .map_err(|err| format!("no default keychain: OSStatus {}", err.code()))?;
        SecKeychain::disable_user_interaction()
            .map_err(|err| format!("Keychain interaction lock failed: OSStatus {}", err.code()))
    }
}

#[cfg(target_os = "macos")]
impl SecretStore for MacLoginKeychain {
    fn get(&self) -> Result<Option<String>, String> {
        use security_framework::passwords::get_generic_password;
        let _no_prompt = Self::non_interactive()?;
        match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "Keychain token item is not UTF-8".to_string()),
            Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(err) => Err(format!("Keychain read failed: OSStatus {}", err.code())),
        }
    }

    fn set(&self, value: &str) -> Result<(), String> {
        let _no_prompt = Self::non_interactive()?;
        security_framework::passwords::set_generic_password(
            KEYCHAIN_SERVICE,
            KEYCHAIN_ACCOUNT,
            value.as_bytes(),
        )
        .map_err(|err| format!("Keychain write failed: OSStatus {}", err.code()))
    }

    fn delete(&self) -> Result<(), String> {
        let _no_prompt = Self::non_interactive()?;
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
    let wanted = match env_flag("HQ_TOKEN_KEYCHAIN") {
        Some(explicit) => explicit,
        None => !cfg!(debug_assertions),
    };
    wanted && real_login_keychain_reachable()
}

/// The user's own login keychain is reachable only when HOME is the account's
/// real home and that home has a login keychain. An isolated HOME (release
/// smoke, sandboxed launches) has no default keychain, and touching the
/// Keychain there prompts and blocks.
fn real_login_keychain_reachable() -> bool {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let account_home = account_home_dir();
    login_keychain_reachable(home.as_deref(), account_home.as_deref(), |path| path.exists())
}

/// Pure rule behind [`real_login_keychain_reachable`].
pub(crate) fn login_keychain_reachable(
    home: Option<&std::path::Path>,
    account_home: Option<&std::path::Path>,
    exists: impl Fn(&std::path::Path) -> bool,
) -> bool {
    let (Some(home), Some(account_home)) = (home, account_home) else {
        return false;
    };
    if home != account_home {
        return false;
    }
    let keychains = home.join("Library").join("Keychains");
    exists(&keychains.join("login.keychain-db")) || exists(&keychains.join("login.keychain"))
}

#[cfg(unix)]
fn account_home_dir() -> Option<std::path::PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    // SAFETY: getpwuid returns a pointer into static storage or null; the
    // directory string is copied out before any other passwd call.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_dir.is_null() {
            return None;
        }
        let dir = CStr::from_ptr((*pw).pw_dir);
        Some(std::path::PathBuf::from(std::ffi::OsStr::from_bytes(dir.to_bytes())))
    }
}

#[cfg(not(unix))]
fn account_home_dir() -> Option<std::path::PathBuf> {
    None
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

/// One queued Keychain mutation. Writes and deletes run on a background
/// thread, in order, so no token write (boot refresh, sign-in, sign-out) ever
/// waits on the Keychain. Reads tolerate the lag: the file decides conflicts.
enum MirrorOp {
    Set(Arc<dyn SecretStore>, String),
    Delete(Arc<dyn SecretStore>),
    Flush(std::sync::mpsc::Sender<()>),
}

fn mirror_queue() -> &'static Mutex<std::sync::mpsc::Sender<MirrorOp>> {
    static QUEUE: OnceLock<Mutex<std::sync::mpsc::Sender<MirrorOp>>> = OnceLock::new();
    QUEUE.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<MirrorOp>();
        std::thread::Builder::new()
            .name("token-keychain".into())
            .spawn(move || {
                for op in rx {
                    match op {
                        MirrorOp::Set(store, json) => {
                            if let Err(err) = store.set(&json) {
                                eprintln!("[token-keychain] mirror write skipped: {err}");
                            }
                        }
                        MirrorOp::Delete(store) => match store.delete() {
                            Ok(()) => KNOWN_EMPTY.store(true, std::sync::atomic::Ordering::SeqCst),
                            Err(err) => eprintln!("[token-keychain] mirror delete skipped: {err}"),
                        },
                        MirrorOp::Flush(done) => {
                            let _ = done.send(());
                        }
                    }
                }
            })
            .expect("spawn token-keychain thread");
        Mutex::new(tx)
    })
}

fn enqueue(op: MirrorOp) {
    let sent = mirror_queue()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .send(op);
    if sent.is_err() {
        eprintln!("[token-keychain] mirror queue closed; skipped");
    }
}

/// Wait until every queued mirror operation has run (tests).
#[cfg(any(test, feature = "test-support"))]
pub fn flush_for_tests() {
    let (tx, rx) = std::sync::mpsc::channel();
    enqueue(MirrorOp::Flush(tx));
    let _ = rx.recv_timeout(std::time::Duration::from_secs(5));
}

/// Best-effort mirror write. Queued in the background; failures are logged
/// without values and never fail or delay the file write that the other
/// tools depend on.
pub fn mirror_write(json: &str) {
    if let Some(store) = active_store() {
        KNOWN_EMPTY.store(false, std::sync::atomic::Ordering::SeqCst);
        enqueue(MirrorOp::Set(store, json.to_string()));
    }
}

/// Best-effort mirror delete (sign-out). Queued in the background.
pub fn mirror_delete() {
    if let Some(store) = active_store() {
        enqueue(MirrorOp::Delete(store));
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
        // Mirror writes are queued; observe the value after they have run.
        flush_for_tests();
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
    fn login_keychain_needs_the_account_home_and_a_login_keychain() {
        use std::path::Path;
        let real = Path::new("/Users/someone");
        let db = Path::new("/Users/someone/Library/Keychains/login.keychain-db");
        let has_db = |p: &Path| p == db;
        assert!(login_keychain_reachable(Some(real), Some(real), has_db));
        // Isolated HOME (release artifact smoke): never touch the Keychain.
        let sandbox = Path::new("/private/tmp/hq-smoke-home");
        assert!(!login_keychain_reachable(Some(sandbox), Some(real), |_| true));
        // Real home without a login keychain.
        assert!(!login_keychain_reachable(Some(real), Some(real), |_| false));
        assert!(!login_keychain_reachable(None, Some(real), has_db));
        assert!(!login_keychain_reachable(Some(real), None, has_db));
    }

    #[test]
    fn mirror_writes_never_block_the_caller() {
        struct SlowStore(std::sync::atomic::AtomicBool);
        impl SecretStore for SlowStore {
            fn get(&self) -> Result<Option<String>, String> {
                Ok(None)
            }
            fn set(&self, _value: &str) -> Result<(), String> {
                // Stands in for a Keychain call stuck on a modal prompt.
                std::thread::sleep(std::time::Duration::from_millis(500));
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            }
            fn delete(&self) -> Result<(), String> {
                std::thread::sleep(std::time::Duration::from_millis(500));
                Ok(())
            }
        }
        let _lock = crate::cognito::HQ_TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let store = Arc::new(SlowStore(std::sync::atomic::AtomicBool::new(false)));
        set_store_for_tests(Some(store.clone()));
        let started = std::time::Instant::now();
        mirror_write("{}");
        mirror_delete();
        assert!(started.elapsed() < std::time::Duration::from_millis(200));
        flush_for_tests();
        assert!(store.0.load(std::sync::atomic::Ordering::SeqCst));
        set_store_for_tests(None);
        reset_known_empty_for_tests();
    }

    #[test]
    fn proposed_item_name_is_stable() {
        assert_eq!(KEYCHAIN_SERVICE, "ai.indigo.hq.cognito-tokens");
        assert_eq!(KEYCHAIN_ACCOUNT, "person");
        assert_eq!(KEYCHAIN_TEAM_ID, "HWFZ2QDTMR");
    }
}
