//! Outpost machine identity for the desktop app.
//!
//! An outpost host carries machine credentials at
//! `~/.hq-agent/machine-creds.json` (or `$HQ_MACHINE_CREDS_FILE`). The desktop
//! app never reads that file. It asks the `hq` CLI to mint a short-lived
//! session (`hq auth machine-session --output <path>`) into a private file
//! under the app's own data directory, and reads only that output:
//! `{accessToken, idToken, expiresAt}`, no refresh token.
//!
//! Rules this module enforces:
//!
//! - a person session always wins; callers consult this module only after the
//!   person token store reported "not signed in";
//! - machine tokens are never written into `~/.hq/cognito-tokens.json`;
//! - there is no `REFRESH_TOKEN_AUTH` and no revoke for a machine session.
//!   A session that has less than [`REMINT_WINDOW_MS`] left is minted again;
//!   a sign-out records a local opt-out and deletes nothing;
//! - token contents are never logged. Log lines carry the exit status and the
//!   token source only.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::cognito::CognitoTokens;

/// Set to `off` to disable the machine identity fallback. Default on.
pub const MACHINE_IDENTITY_ENV: &str = "HQ_DESKTOP_MACHINE_IDENTITY";
/// Overrides the machine credentials file the `hq` CLI reads.
pub const MACHINE_CREDS_FILE_ENV: &str = "HQ_MACHINE_CREDS_FILE";
/// `menubar.json` key recorded by a sign-out in machine mode.
pub const MACHINE_IDENTITY_OPT_OUT_KEY: &str = "machineIdentityOptOut";
/// File name of the minted session under the app data directory.
pub const MACHINE_SESSION_FILE_NAME: &str = "machine-session.json";
/// Mint again when the session has less than this long left (30 minutes).
pub const REMINT_WINDOW_MS: i64 = 30 * 60 * 1000;
const MINT_TIMEOUT: Duration = Duration::from_secs(60);

/// Why no machine session could be produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MachineSessionError {
    /// `HQ_DESKTOP_MACHINE_IDENTITY=off`.
    Disabled,
    /// The person signed out of the machine identity on this device.
    OptedOut,
    /// No machine credentials file exists or it cannot be opened.
    CredentialsAbsent,
    /// The mint failed, timed out, or produced an unreadable file. The string
    /// is a closed-set, non-secret reason for diagnostics.
    Unavailable(String),
}

impl MachineSessionError {
    /// True when the caller should fall through to its ordinary signed-out
    /// handling: the machine identity is not in play at all.
    pub fn is_not_applicable(&self) -> bool {
        !matches!(self, Self::Unavailable(_))
    }
}

/// A minted machine session. `expires_at` is unix epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineSession {
    pub access_token: String,
    pub id_token: String,
    #[serde(with = "crate::cognito::expires_at_flexible")]
    pub expires_at: i64,
}

impl MachineSession {
    /// Convert to the shared token shape. The refresh token is empty on
    /// purpose: nothing may ever refresh or revoke a machine session.
    pub fn into_tokens(self) -> CognitoTokens {
        CognitoTokens {
            access_token: self.access_token,
            id_token: Some(self.id_token),
            refresh_token: String::new(),
            expires_at: self.expires_at,
        }
    }

    /// True when the session must be minted again before use.
    pub fn needs_remint_at(&self, now_ms: i64) -> bool {
        self.expires_at - now_ms < REMINT_WINDOW_MS
    }

    pub fn needs_remint(&self) -> bool {
        self.needs_remint_at(now_ms())
    }
}

/// Produces a machine session file at `output`. The production minter runs
/// the `hq` CLI; tests substitute a fake.
pub trait MachineSessionMinter: Send + Sync {
    fn mint<'a>(
        &'a self,
        output: &'a Path,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>;
}

/// Runs `hq auth machine-session --output <path>` with the app's own `hq`
/// resolution and child PATH. Output streams are discarded so a token can
/// never reach a log through this path.
pub struct CliMachineSessionMinter;

impl MachineSessionMinter for CliMachineSessionMinter {
    fn mint<'a>(
        &'a self,
        output: &'a Path,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            let bin = crate::paths::resolve_bin("hq");
            let output_arg = output.to_string_lossy().into_owned();
            let mut command = crate::paths::tokio_spawn_command(
                &bin,
                &["auth", "machine-session", "--output", &output_arg],
            );
            command
                .env("HQ_NO_UPDATE_CHECK", "1")
                .env("PATH", crate::paths::child_path())
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            let mut child = command
                .spawn()
                .map_err(|error| format!("hq could not be started: {}", error.kind()))?;
            let status = match tokio::time::timeout(MINT_TIMEOUT, child.wait()).await {
                Ok(Ok(status)) => status,
                Ok(Err(error)) => {
                    return Err(format!("hq auth machine-session failed: {}", error.kind()))
                }
                Err(_) => {
                    let _ = child.kill().await;
                    return Err("hq auth machine-session timed out".to_string());
                }
            };
            if status.success() {
                Ok(())
            } else {
                Err(format!(
                    "hq auth machine-session exited with status {}",
                    status.code().unwrap_or(-1)
                ))
            }
        })
    }
}

#[cfg(any(test, feature = "test-support"))]
static TEST_MINTER: std::sync::Mutex<Option<std::sync::Arc<dyn MachineSessionMinter>>> =
    std::sync::Mutex::new(None);

/// Replace the minter for tests. `None` restores the CLI minter.
#[cfg(any(test, feature = "test-support"))]
pub fn set_test_minter(minter: Option<std::sync::Arc<dyn MachineSessionMinter>>) {
    *TEST_MINTER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = minter;
}

fn minter() -> std::sync::Arc<dyn MachineSessionMinter> {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(minter) = TEST_MINTER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
    {
        return minter;
    }
    std::sync::Arc::new(CliMachineSessionMinter)
}

/// True unless `HQ_DESKTOP_MACHINE_IDENTITY` is `off` (case-insensitive).
pub fn machine_identity_enabled() -> bool {
    !matches!(
        std::env::var(MACHINE_IDENTITY_ENV)
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Ok("off")
    )
}

/// Where the `hq` CLI reads machine credentials from. The app never opens
/// this file for reading; it only checks that it exists.
pub fn machine_creds_path() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os(MACHINE_CREDS_FILE_ENV) {
        let trimmed = value.to_string_lossy().trim().to_string();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    crate::paths::home_dir().map(|home| home.join(".hq-agent").join("machine-creds.json"))
}

/// True when a machine credentials file exists and this process may open it.
/// The contents are never read here.
pub fn machine_creds_readable() -> bool {
    let Some(path) = machine_creds_path() else {
        return false;
    };
    std::fs::File::open(&path)
        .and_then(|file| file.metadata())
        .map(|meta| meta.is_file())
        .unwrap_or(false)
}

/// Per-platform application data root: the parent of the managed toolchain.
fn app_data_root() -> Result<PathBuf, String> {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(home) = std::env::var_os("HQ_TEST_HOME") {
        return Ok(PathBuf::from(home).join("IndigoHQ"));
    }
    if cfg!(target_os = "windows") {
        let local_app = std::env::var_os("LOCALAPPDATA")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Cannot determine the local application data directory".to_string())?;
        return Ok(PathBuf::from(local_app).join("IndigoHQ"));
    }
    let home =
        crate::paths::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    if cfg!(target_os = "macos") {
        return Ok(home
            .join("Library")
            .join("Application Support")
            .join("Indigo HQ"));
    }
    let data_home = match std::env::var_os("XDG_DATA_HOME") {
        Some(value) if !value.is_empty() && Path::new(&value).is_absolute() => PathBuf::from(value),
        _ => home.join(".local").join("share"),
    };
    Ok(data_home.join("IndigoHQ"))
}

/// Private file the minted session is written to.
pub fn machine_session_path() -> Result<PathBuf, String> {
    Ok(app_data_root()?.join(MACHINE_SESSION_FILE_NAME))
}

fn menubar_path() -> Result<PathBuf, String> {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(home) = std::env::var_os("HQ_TEST_HOME") {
        return Ok(PathBuf::from(home).join(".hq").join("menubar.json"));
    }
    crate::paths::menubar_json_path()
}

/// True when a sign-out in machine mode was recorded on this device.
pub fn opted_out() -> bool {
    let Ok(path) = menubar_path() else {
        return false;
    };
    crate::first_run::read_menubar_obj(&path)
        .get(MACHINE_IDENTITY_OPT_OUT_KEY)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Record (or clear) the local opt-out. Writes only `menubar.json`; the
/// machine credentials and the minted session are left untouched.
pub fn set_opted_out(opted_out: bool) -> Result<(), String> {
    let path = menubar_path()?;
    crate::first_run::merge_menubar_flags(
        &path,
        &[(MACHINE_IDENTITY_OPT_OUT_KEY, Value::Bool(opted_out))],
    )
}

/// Whether the fallback may run at all on this device right now.
pub fn machine_identity_available() -> Result<(), MachineSessionError> {
    if !machine_identity_enabled() {
        return Err(MachineSessionError::Disabled);
    }
    if opted_out() {
        return Err(MachineSessionError::OptedOut);
    }
    if !machine_creds_readable() {
        return Err(MachineSessionError::CredentialsAbsent);
    }
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn read_session_file(path: &Path) -> Result<Option<MachineSession>, String> {
    let body = match std::fs::read(path) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("machine session file unreadable: {}", error.kind())),
    };
    let session: MachineSession = serde_json::from_slice(&body)
        .map_err(|_| "machine session file is not valid".to_string())?;
    if session.access_token.trim().is_empty() || session.id_token.trim().is_empty() {
        return Err("machine session file is missing a token".to_string());
    }
    Ok(Some(session))
}

fn restrict_to_owner(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn ensure_private_parent(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("machine session directory unavailable: {}", error.kind()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Serialises mints and file reads so concurrent callers share one mint.
fn mint_gate() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Return a usable machine session, minting one when none is on disk, when
/// the stored one has under [`REMINT_WINDOW_MS`] left, or when `force` is set
/// (a caller saw a 401 against a token that still looked valid).
pub async fn resolve_machine_session(force: bool) -> Result<MachineSession, MachineSessionError> {
    machine_identity_available()?;
    let path = machine_session_path().map_err(MachineSessionError::Unavailable)?;
    let _gate = mint_gate().lock().await;

    if !force {
        match read_session_file(&path) {
            Ok(Some(session)) if !session.needs_remint() => return Ok(session),
            Ok(_) => {}
            Err(reason) => {
                eprintln!("[auth] machine session: {reason}; minting again source=machine");
            }
        }
    }

    ensure_private_parent(&path).map_err(MachineSessionError::Unavailable)?;
    match minter().mint(&path).await {
        Ok(()) => {
            restrict_to_owner(&path);
            eprintln!("[auth] machine session minted source=machine");
        }
        Err(reason) => {
            eprintln!("[auth] machine session mint failed: {reason} source=machine");
            return Err(MachineSessionError::Unavailable(reason));
        }
    }
    match read_session_file(&path) {
        Ok(Some(session)) if !session.needs_remint() => Ok(session),
        Ok(Some(_)) => Err(MachineSessionError::Unavailable(
            "hq auth machine-session produced a session that expires too soon".to_string(),
        )),
        Ok(None) => Err(MachineSessionError::Unavailable(
            "hq auth machine-session wrote no session file".to_string(),
        )),
        Err(reason) => Err(MachineSessionError::Unavailable(reason)),
    }
}

/// Remove the minted session file. Used only by tests and by a forced
/// re-mint path that wants a clean slate; a sign-out never calls this.
#[cfg(any(test, feature = "test-support"))]
pub fn remove_session_file_for_tests() -> Result<(), String> {
    let path = machine_session_path()?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::sync::Arc;

    /// Writes a fixed session file; counts invocations; can be told to fail.
    pub struct FakeMinter {
        pub body: std::sync::Mutex<Option<String>>,
        pub fail_with: Option<String>,
        pub calls: std::sync::atomic::AtomicUsize,
    }

    impl FakeMinter {
        pub fn writing(body: String) -> Arc<Self> {
            Arc::new(Self {
                body: std::sync::Mutex::new(Some(body)),
                fail_with: None,
                calls: std::sync::atomic::AtomicUsize::new(0),
            })
        }

        pub fn failing(reason: &str) -> Arc<Self> {
            Arc::new(Self {
                body: std::sync::Mutex::new(None),
                fail_with: Some(reason.to_string()),
                calls: std::sync::atomic::AtomicUsize::new(0),
            })
        }

        pub fn calls(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl MachineSessionMinter for FakeMinter {
        fn mint<'a>(
            &'a self,
            output: &'a Path,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>
        {
            Box::pin(async move {
                self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if let Some(reason) = &self.fail_with {
                    return Err(reason.clone());
                }
                let body = self
                    .body
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone()
                    .unwrap_or_default();
                std::fs::write(output, body).map_err(|error| error.to_string())
            })
        }
    }

    /// Installs a fake minter and removes it on drop.
    pub struct MinterGuard;

    impl MinterGuard {
        pub fn install(minter: Arc<dyn MachineSessionMinter>) -> Self {
            set_test_minter(Some(minter));
            Self
        }
    }

    impl Drop for MinterGuard {
        fn drop(&mut self) {
            set_test_minter(None);
        }
    }

    /// Scoped environment override that restores the previous value on drop.
    pub struct EnvGuard {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        pub fn set(key: &'static str, value: Option<&str>) -> Self {
            let previous = std::env::var_os(key);
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(previous) => std::env::set_var(self.key, previous),
                None => std::env::remove_var(self.key),
            }
        }
    }

    /// Test home with a readable machine credentials file. The file holds a
    /// placeholder, never real credentials.
    pub struct MachineHome {
        pub dir: tempfile::TempDir,
        _home: crate::cognito::test_support::TestHome,
        _creds: EnvGuard,
        _enabled: EnvGuard,
    }

    impl MachineHome {
        pub fn new() -> Self {
            let dir = tempfile::tempdir().expect("temp home");
            let home = crate::cognito::test_support::TestHome::set(dir.path());
            let creds_path = dir.path().join("machine-creds.json");
            std::fs::write(&creds_path, "{}").expect("placeholder creds file");
            let creds = EnvGuard::set(
                MACHINE_CREDS_FILE_ENV,
                Some(creds_path.to_string_lossy().as_ref()),
            );
            let enabled = EnvGuard::set(MACHINE_IDENTITY_ENV, None);
            Self {
                dir,
                _home: home,
                _creds: creds,
                _enabled: enabled,
            }
        }

        pub fn remove_creds(&self) {
            let _ = std::fs::remove_file(self.dir.path().join("machine-creds.json"));
        }
    }

    pub fn session_body(id_token: &str, expires_at: i64) -> String {
        serde_json::json!({
            "accessToken": "access.token.value",
            "idToken": id_token,
            "expiresAt": expires_at,
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    fn far_future() -> i64 {
        now_ms() + 10 * 60 * 60 * 1000
    }

    #[test]
    fn env_switch_disables_only_on_off() {
        let _home = MachineHome::new();
        let _on = EnvGuard::set(MACHINE_IDENTITY_ENV, Some(" OFF "));
        assert!(!machine_identity_enabled());
        let _other = EnvGuard::set(MACHINE_IDENTITY_ENV, Some("false"));
        assert!(machine_identity_enabled());
        let _unset = EnvGuard::set(MACHINE_IDENTITY_ENV, None);
        assert!(machine_identity_enabled());
    }

    #[test]
    fn creds_path_prefers_env_override_then_home() {
        let home = MachineHome::new();
        assert_eq!(
            machine_creds_path(),
            Some(home.dir.path().join("machine-creds.json"))
        );
        let _blank = EnvGuard::set(MACHINE_CREDS_FILE_ENV, Some("   "));
        let expected = crate::paths::home_dir()
            .expect("home")
            .join(".hq-agent")
            .join("machine-creds.json");
        assert_eq!(machine_creds_path(), Some(expected));
    }

    #[test]
    fn availability_reports_each_gate() {
        let home = MachineHome::new();
        assert_eq!(machine_identity_available(), Ok(()));
        set_opted_out(true).expect("write opt-out");
        assert_eq!(
            machine_identity_available(),
            Err(MachineSessionError::OptedOut)
        );
        set_opted_out(false).expect("clear opt-out");
        assert_eq!(machine_identity_available(), Ok(()));
        {
            let _off = EnvGuard::set(MACHINE_IDENTITY_ENV, Some("off"));
            assert_eq!(
                machine_identity_available(),
                Err(MachineSessionError::Disabled)
            );
        }
        home.remove_creds();
        assert_eq!(
            machine_identity_available(),
            Err(MachineSessionError::CredentialsAbsent)
        );
    }

    #[test]
    fn opt_out_write_preserves_other_menubar_keys() {
        let home = MachineHome::new();
        let menubar = home.dir.path().join(".hq").join("menubar.json");
        std::fs::create_dir_all(menubar.parent().unwrap()).unwrap();
        std::fs::write(&menubar, r#"{"hqPath":"/x","futureKey":1}"#).unwrap();
        set_opted_out(true).expect("write opt-out");
        let obj = crate::first_run::read_menubar_obj(&menubar);
        assert_eq!(obj.get("hqPath").and_then(Value::as_str), Some("/x"));
        assert_eq!(obj.get("futureKey").and_then(Value::as_i64), Some(1));
        assert!(opted_out());
    }

    #[tokio::test]
    async fn mints_when_no_session_file_exists_and_reuses_it() {
        let home = MachineHome::new();
        let minter = FakeMinter::writing(session_body("id.token.value", far_future()));
        let _guard = MinterGuard::install(minter.clone());

        let session = resolve_machine_session(false)
            .await
            .expect("minted session");
        assert_eq!(session.id_token, "id.token.value");
        assert_eq!(minter.calls(), 1);
        let path = machine_session_path().unwrap();
        assert!(path.starts_with(home.dir.path()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let again = resolve_machine_session(false)
            .await
            .expect("cached session");
        assert_eq!(again, session);
        assert_eq!(minter.calls(), 1, "a valid session file is reused");
    }

    #[tokio::test]
    async fn remints_when_under_thirty_minutes_remain() {
        let _home = MachineHome::new();
        let path = machine_session_path().unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            session_body("stale.id.token", now_ms() + REMINT_WINDOW_MS - 1000),
        )
        .unwrap();
        let minter = FakeMinter::writing(session_body("fresh.id.token", far_future()));
        let _guard = MinterGuard::install(minter.clone());

        let session = resolve_machine_session(false).await.expect("re-minted");
        assert_eq!(session.id_token, "fresh.id.token");
        assert_eq!(minter.calls(), 1);
    }

    #[tokio::test]
    async fn force_remints_even_with_a_valid_file() {
        let _home = MachineHome::new();
        let path = machine_session_path().unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, session_body("old.id.token", far_future())).unwrap();
        let minter = FakeMinter::writing(session_body("new.id.token", far_future()));
        let _guard = MinterGuard::install(minter.clone());

        let session = resolve_machine_session(true).await.expect("forced re-mint");
        assert_eq!(session.id_token, "new.id.token");
        assert_eq!(minter.calls(), 1);
    }

    #[tokio::test]
    async fn mint_failure_is_unavailable_and_keeps_nothing() {
        let _home = MachineHome::new();
        let minter = FakeMinter::failing("hq auth machine-session exited with status 1");
        let _guard = MinterGuard::install(minter);

        let error = resolve_machine_session(false)
            .await
            .expect_err("mint failed");
        assert!(matches!(error, MachineSessionError::Unavailable(_)));
        assert!(!error.is_not_applicable());
        assert!(!machine_session_path().unwrap().exists());
    }

    #[tokio::test]
    async fn malformed_session_file_is_minted_again() {
        let _home = MachineHome::new();
        let path = machine_session_path().unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{").unwrap();
        let minter = FakeMinter::writing(session_body("fresh.id.token", far_future()));
        let _guard = MinterGuard::install(minter.clone());

        let session = resolve_machine_session(false).await.expect("re-minted");
        assert_eq!(session.id_token, "fresh.id.token");
    }

    #[tokio::test]
    async fn gates_are_checked_before_any_mint() {
        let home = MachineHome::new();
        let minter = FakeMinter::writing(session_body("id", far_future()));
        let _guard = MinterGuard::install(minter.clone());
        home.remove_creds();
        assert_eq!(
            resolve_machine_session(false).await,
            Err(MachineSessionError::CredentialsAbsent)
        );
        assert_eq!(minter.calls(), 0);
    }

    #[test]
    fn session_file_accepts_iso_expiry_and_converts_to_tokens() {
        let session: MachineSession = serde_json::from_str(
            r#"{"accessToken":"a","idToken":"b","expiresAt":"2030-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        assert!(session.expires_at > 0);
        let tokens = session.into_tokens();
        assert_eq!(tokens.refresh_token, "");
        assert_eq!(tokens.id_token.as_deref(), Some("b"));
    }
}
