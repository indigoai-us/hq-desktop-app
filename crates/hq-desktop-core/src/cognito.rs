use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tokio::sync::Mutex;

#[cfg(test)]
pub(crate) static HQ_TEST_HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

mod expires_at_flexible {
    use serde::{self, Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &i64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_i64(*value)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<i64, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum FlexibleExpiresAt {
            Number(i64),
            Text(String),
        }

        match FlexibleExpiresAt::deserialize(deserializer)? {
            FlexibleExpiresAt::Number(n) => Ok(n),
            FlexibleExpiresAt::Text(s) => chrono::DateTime::parse_from_rfc3339(&s)
                .map(|dt| dt.timestamp_millis())
                .map_err(serde::de::Error::custom),
        }
    }
}

static TOKEN_CACHE: std::sync::OnceLock<Mutex<Option<CachedTokens>>> = std::sync::OnceLock::new();

fn cache() -> &'static Mutex<Option<CachedTokens>> {
    TOKEN_CACHE.get_or_init(|| Mutex::new(None))
}

const COGNITO_ENDPOINT: &str = "https://cognito-idp.us-east-1.amazonaws.com/";
/// 2-minute buffer before expiry (in milliseconds)
const EXPIRY_BUFFER_MS: i64 = 120_000;
const REFRESH_ATTEMPTS: usize = 3;
const REFRESH_RETRY_DELAY_BASE_MS: u64 = 150;
const REFRESH_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
const VALID_TOKEN_RESOLUTION_ATTEMPTS: usize = 3;

/// Positive, user-facing copy shared by startup and sync surfaces after the
/// bounded automatic refresh attempts have been exhausted.
pub const REAUTH_MESSAGE: &str =
    "Your HQ session needs a quick refresh. Sign in again to keep sync moving.";

/// Structured refresh failure so callers can distinguish a stale refresh
/// token (clear it) from a temporary transport/service failure (preserve it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CognitoRefreshError {
    pub message: String,
    pub requires_reauth: bool,
    pub status_code: Option<u16>,
    pub error_code: Option<String>,
    pub failure_class: CognitoRefreshFailureClass,
}

/// Stable, low-cardinality classification for refresh diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CognitoRefreshFailureClass {
    Network,
    Timeout,
    Http4xx,
    Http5xx,
    HttpOther,
    ResponseDecode,
    Unknown,
}

impl CognitoRefreshFailureClass {
    pub const fn as_tag(self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Timeout => "timeout",
            Self::Http4xx => "http_4xx",
            Self::Http5xx => "http_5xx",
            Self::HttpOther => "http_other",
            Self::ResponseDecode => "response_decode",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CognitoTokenResolutionError {
    pub message: String,
    pub refresh_failure_class: Option<CognitoRefreshFailureClass>,
    pub requires_reauth: bool,
}

impl CognitoTokenResolutionError {
    fn plain(message: String) -> Self {
        Self {
            message,
            refresh_failure_class: None,
            requires_reauth: false,
        }
    }

    fn refresh(
        message: String,
        failure_class: CognitoRefreshFailureClass,
        requires_reauth: bool,
    ) -> Self {
        Self {
            message,
            refresh_failure_class: Some(failure_class),
            requires_reauth,
        }
    }
}

impl fmt::Display for CognitoRefreshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CognitoRefreshError {}

async fn wait_before_refresh_retry(attempt: usize) {
    let delay_ms = REFRESH_RETRY_DELAY_BASE_MS.saturating_mul(attempt as u64 + 1);
    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
}

fn refresh_status_is_retryable(status: u16) -> bool {
    status == 401 || status == 408 || status == 429 || status >= 500
}

fn refresh_status_requires_reauth(status: u16) -> bool {
    (400..500).contains(&status) && status != 408 && status != 429
}

fn refresh_failure_class_from_status(status: u16) -> CognitoRefreshFailureClass {
    match status {
        400..=499 => CognitoRefreshFailureClass::Http4xx,
        500..=599 => CognitoRefreshFailureClass::Http5xx,
        _ => CognitoRefreshFailureClass::HttpOther,
    }
}

fn cognito_error_code(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    ["__type", "code", "Code", "error"]
        .iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_str))
        .and_then(|raw| raw.rsplit(['#', ':']).next())
        .map(str::to_string)
}

fn classify_refresh_failure(status: u16, body: &str) -> (bool, bool) {
    let code_refusal = matches!(
        cognito_error_code(body).as_deref(),
        Some("NotAuthorizedException" | "invalid_grant" | "invalid_client")
    );
    let definitive_refusal = status == 401 || code_refusal;
    (!definitive_refusal, definitive_refusal)
}

fn redact_refresh_message(message: &str) -> String {
    let words = message.split_whitespace().collect::<Vec<_>>();
    let mut redacted = Vec::with_capacity(words.len());
    let mut skip_words = 0;
    for word in words {
        if skip_words > 0 {
            skip_words -= 1;
            continue;
        }
        let clean = word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-' && c != '_' && c != '@');
        let credential_key = word
            .split_once(['=', ':'])
            .map(|(key, value)| (key, !value.is_empty()))
            .or_else(|| {
                let key = clean.trim_matches(['"', '\'', '`']);
                is_credential_key(key).then_some((key, false))
            });
        if let Some((key, has_inline_value)) = credential_key.filter(|(key, _)| is_credential_key(key)) {
            redacted.push(format!("{}=[redacted]", key.trim_matches(['"', '\'', '`'])));
            if !has_inline_value {
                skip_words = if key.eq_ignore_ascii_case("authorization") { 2 } else { 1 };
            }
            continue;
        }
        if word.contains('@') {
            redacted.push(word.replace(clean, "[redacted email]"));
        } else if clean.matches('.').count() >= 2 && clean.len() > 30 {
            redacted.push(word.replace(clean, "[redacted token]"));
        } else if clean.matches('-').count() == 4 && clean.len() >= 32 {
            redacted.push(word.replace(clean, "[redacted id]"));
        } else {
            redacted.push(word.to_string());
        }
    }
    redacted.join(" ")
}

fn is_credential_key(key: &str) -> bool {
    matches!(
        key.trim_matches(['"', '\'', '`']).to_ascii_lowercase().as_str(),
        "refresh_token" | "access_token" | "id_token" | "token" | "user_id" | "sub"
            | "authorization" | "client_secret" | "password" | "secret" | "credential"
    )
}

fn refresh_diagnostic(status: u16, body: &str, refresh_token: &str) -> (Option<String>, String) {
    let code = cognito_error_code(body);
    let message = cognito_error_message(body);
    let message = if refresh_token.is_empty() {
        message
    } else {
        message.replace(refresh_token, "[redacted token]")
    };
    let diagnostic = format!(
        "Cognito refresh failed status={status} code={} message={message}",
        code.as_deref().unwrap_or("unknown")
    );
    (code, diagnostic)
}

fn cognito_error_message(body: &str) -> String {
    let value: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => return "Cognito returned an unstructured error response".to_string(),
    };
    value.get("message").or_else(|| value.get("Message"))
        .or_else(|| value.get("error_description"))
        .and_then(serde_json::Value::as_str)
        .map(redact_refresh_message)
        .unwrap_or_else(|| "Cognito returned an error response without a message".to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CognitoTokens {
    pub access_token: String,
    pub id_token: Option<String>,
    pub refresh_token: String,
    /// Unix epoch milliseconds. Accepts both i64 and ISO 8601 string on deserialization.
    #[serde(with = "expires_at_flexible")]
    pub expires_at: i64,
}

/// Result of attempting to publish refreshed Cognito tokens.
///
/// A refresh is persisted only while the exact token generation it started
/// from is still current. If another process signs in, refreshes, invalidates,
/// or signs out first, that newer state wins and is returned to the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshPersistenceOutcome {
    Persisted(CognitoTokens),
    Superseded(Option<CognitoTokens>),
}

impl RefreshPersistenceOutcome {
    /// The token generation callers should use after the persistence attempt.
    ///
    /// `None` means the winning state is signed out or invalidated.
    pub fn current_tokens(&self) -> Option<&CognitoTokens> {
        match self {
            Self::Persisted(tokens) | Self::Superseded(Some(tokens)) => Some(tokens),
            Self::Superseded(None) => None,
        }
    }

    pub fn into_current_tokens(self) -> Option<CognitoTokens> {
        match self {
            Self::Persisted(tokens) | Self::Superseded(Some(tokens)) => Some(tokens),
            Self::Superseded(None) => None,
        }
    }

    pub fn was_persisted(&self) -> bool {
        matches!(self, Self::Persisted(_))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
    pub authenticated: bool,
    pub expires_at: Option<String>,
    /// Stable local account partition for client-side state. Never telemetry.
    pub account_id: Option<String>,
    /// Non-secret identity claims used by the embedded Profile surface.
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    /// The initial native token read for this auth probe, forwarded only to
    /// the matching startup diagnostic command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_token_read_result: Option<String>,
}

/// Native auth classification shared by startup routing and diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthSessionStatus {
    Active,
    CredentialsAbsent,
    CredentialsReadError,
    CredentialsInvalid,
    RefreshTemporarilyUnavailable,
    /// Usable credentials that belong to a fleet agent or outpost, not a person.
    NonHumanPrincipal,
}

/// Classify a missing token-store result after startup resolution fails.
/// A failed read is not evidence that the store is empty.
pub fn startup_token_store_status(read_failed: bool) -> AuthSessionStatus {
    if read_failed {
        AuthSessionStatus::CredentialsReadError
    } else {
        AuthSessionStatus::CredentialsAbsent
    }
}

/// Convert the authoritative native session classification into the startup
/// command result. Only a transient refresh failure is unresolved; a
/// definitively invalid credential remains a signed-out verdict.
pub fn startup_auth_state_result(
    state: AuthState,
    status: &AuthSessionStatus,
) -> Result<AuthState, String> {
    if *status == AuthSessionStatus::RefreshTemporarilyUnavailable {
        return Err("HQ Work could not refresh credentials while offline or unavailable.".into());
    }
    Ok(state)
}

#[derive(Debug)]
struct CachedTokens {
    tokens: CognitoTokens,
    path: PathBuf,
    file_mtime: SystemTime,
}

fn tokens_file_path() -> Result<PathBuf, String> {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(home) = std::env::var_os("HQ_TEST_HOME") {
        return Ok(PathBuf::from(home).join(".hq").join("cognito-tokens.json"));
    }
    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    Ok(home.join(".hq").join("cognito-tokens.json"))
}

fn file_mtime(path: &PathBuf) -> Result<SystemTime, String> {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map_err(|e| format!("Failed to read file mtime: {}", e))
}

fn token_file_lock_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".lock");
    path.with_file_name(name)
}

struct TokenFileLock {
    lock_path: PathBuf,
    candidate_path: PathBuf,
    owner_pid: u32,
}

impl Drop for TokenFileLock {
    fn drop(&mut self) {
        if std::fs::read_to_string(&self.lock_path)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            == Some(self.owner_pid)
        {
            let _ = std::fs::remove_file(&self.lock_path);
        }
        let _ = std::fs::remove_file(&self.candidate_path);
    }
}

fn lock_owner_pid(lock_path: &Path) -> Option<u32> {
    std::fs::read_to_string(lock_path).ok()?.trim().parse().ok()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LockFileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    volume_serial_number: Option<u32>,
    #[cfg(windows)]
    file_index: Option<u64>,
    #[cfg(not(any(unix, windows)))]
    length: u64,
    #[cfg(not(any(unix, windows)))]
    modified: Option<SystemTime>,
}

fn lock_file_identity(path: &Path) -> Option<LockFileIdentity> {
    let metadata = std::fs::metadata(path).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(LockFileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Some(LockFileIdentity {
            volume_serial_number: metadata.volume_serial_number(),
            file_index: metadata.file_index(),
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        Some(LockFileIdentity {
            length: metadata.len(),
            modified: metadata.modified().ok(),
        })
    }
}

fn remove_stale_lock_if_unchanged(
    lock_path: &Path,
    observed_owner: Option<u32>,
    observed_identity: &LockFileIdentity,
) -> bool {
    if lock_owner_pid(lock_path) != observed_owner
        || lock_file_identity(lock_path).as_ref() != Some(observed_identity)
        || observed_owner.is_some_and(lock_owner_is_alive)
    {
        return false;
    }
    std::fs::remove_file(lock_path).is_ok()
}

fn lock_owner_is_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        return result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    }
    #[cfg(windows)]
    {
        return std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(true);
    }
    #[allow(unreachable_code)]
    true
}

fn lock_token_file_at(path: &Path) -> Result<TokenFileLock, String> {
    lock_token_file_with_timeout(path, std::time::Duration::from_secs(20))
}

fn lock_token_file_with_timeout(path: &Path, timeout: std::time::Duration) -> Result<TokenFileLock, String> {
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create token directory: {e}"))?;
    }
    let lock_path = token_file_lock_path(path);
    let owner_pid = std::process::id();
    static NEXT_CANDIDATE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let candidate_nonce = uuid::Uuid::new_v4().simple().to_string();
    let candidate_path = token_lock_candidate_path(
        &lock_path,
        owner_pid,
        &candidate_nonce,
        NEXT_CANDIDATE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    );
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut candidate = options
        .open(&candidate_path)
        .map_err(|e| format!("Failed to create token lock candidate: {e}"))?;
    write!(candidate, "{owner_pid}")
        .map_err(|e| format!("Failed to write token lock candidate: {e}"))?;
    candidate.sync_all()
        .map_err(|e| format!("Failed to flush token lock candidate: {e}"))?;
    drop(candidate);

    let deadline = std::time::Instant::now() + timeout;
    loop {
        match std::fs::hard_link(&candidate_path, &lock_path) {
            Ok(()) => return Ok(TokenFileLock { lock_path, candidate_path, owner_pid }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing_owner = lock_owner_pid(&lock_path);
                if existing_owner.is_none_or(|pid| !lock_owner_is_alive(pid)) {
                    let removed = lock_file_identity(&lock_path).is_some_and(|identity| {
                        remove_stale_lock_if_unchanged(
                            &lock_path,
                            existing_owner,
                            &identity,
                        )
                    });
                    if removed {
                        continue;
                    }
                    if std::time::Instant::now() >= deadline {
                        let _ = std::fs::remove_file(&candidate_path);
                        return Err(format!("Timed out waiting for token lock {}", lock_path.display()));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    continue;
                }
                if std::time::Instant::now() >= deadline {
                    let _ = std::fs::remove_file(&candidate_path);
                    return Err(format!("Timed out waiting for token lock {}", lock_path.display()));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(error) => {
                let _ = std::fs::remove_file(&candidate_path);
                return Err(format!("Failed to acquire token lock {}: {error}", lock_path.display()));
            }
        }
    }
}

fn token_lock_candidate_path(lock_path: &Path, owner_pid: u32, nonce: &str, counter: u64) -> PathBuf {
    let mut name = lock_path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".candidate.{owner_pid}.{nonce}.{counter}"));
    lock_path.with_file_name(name)
}

#[derive(Debug)]
enum TokenReadError {
    Io(std::io::Error),
    Parse(serde_json::Error),
}

pub fn access_token_fingerprint(access_token: &str) -> String {
    format!("{:x}", Sha256::digest(access_token.as_bytes()))
}

fn invalidation_path_for_token(path: &Path, access_token: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".invalid.");
    name.push(access_token_fingerprint(access_token));
    path.with_file_name(name)
}

fn token_is_invalidated_at(path: &Path, access_token: &str) -> bool {
    invalidation_path_for_token(path, access_token).exists()
}

fn invalidate_token_at_unlocked(path: &Path, access_token: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .hq directory: {e}"))?;
    }
    let marker = invalidation_path_for_token(path, access_token);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(marker) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(format!("Failed to invalidate token: {e}")),
    }
}

fn invalidate_token_at(path: &Path, access_token: &str) -> Result<(), String> {
    let _lock = lock_token_file_at(path)?;
    invalidate_token_at_unlocked(path, access_token)
}

fn remove_invalidation_marker_at(path: &Path, access_token: &str) -> Result<(), String> {
    match std::fs::remove_file(invalidation_path_for_token(path, access_token)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to clear token invalidation: {e}")),
    }
}

fn record_rejected_refresh_at(path: &Path, access_token: &str, error_code: Option<&str>) -> Result<(), String> {
    let _lock = lock_token_file_at(path)?;
    invalidate_token_at_unlocked(path, access_token)?;
    std::fs::write(
        invalidation_path_for_token(path, access_token),
        format!("refresh-rejected:{}", error_code.unwrap_or("unknown")),
    )
    .map_err(|e| format!("Failed to record rejected token refresh: {e}"))
}

fn refresh_rejection_recorded_at(path: &Path, access_token: &str) -> Result<bool, String> {
    match std::fs::read(invalidation_path_for_token(path, access_token)) {
        Ok(contents) => Ok(contents == b"refresh-rejected" || contents.starts_with(b"refresh-rejected:")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("Failed to read rejected token marker: {e}")),
    }
}

fn read_tokens_from_path_raw(path: &Path) -> Result<Option<CognitoTokens>, TokenReadError> {
    if !path.exists() {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(path).map_err(TokenReadError::Io)?;
    let tokens: CognitoTokens = serde_json::from_str(&contents).map_err(TokenReadError::Parse)?;
    Ok(Some(tokens))
}

fn read_tokens_from_path(path: &Path) -> Result<Option<CognitoTokens>, TokenReadError> {
    let tokens = read_tokens_from_path_raw(path)?;
    Ok(tokens.filter(|tokens| !token_is_invalidated_at(path, &tokens.access_token)))
}

fn read_tokens_marked_invalidated_from_path(
    path: &Path,
) -> Result<Option<CognitoTokens>, TokenReadError> {
    let tokens = read_tokens_from_path_raw(path)?;
    Ok(tokens.filter(|tokens| token_is_invalidated_at(path, &tokens.access_token)))
}

/// Bounded, non-secret observations used by the unexpected startup surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartupTokenStoreDiagnostics {
    pub invalidation_marker_present: bool,
    pub first_read_result: &'static str,
    pub recheck_read_result: &'static str,
}

fn token_read_result_label(result: Result<Option<CognitoTokens>, TokenReadError>) -> &'static str {
    match result {
        Ok(Some(_)) => "ok_some",
        Ok(None) => "ok_none",
        Err(TokenReadError::Io(_)) => "err_io",
        Err(TokenReadError::Parse(_)) => "err_parse",
    }
}

fn startup_token_store_diagnostics_at(path: &Path) -> StartupTokenStoreDiagnostics {
    let first_read_result = token_read_result_label(read_tokens_from_path(path));
    startup_token_store_diagnostics_after_first_at(path, first_read_result)
}

fn startup_token_store_diagnostics_after_first_at(
    path: &Path,
    first_read_result: &'static str,
) -> StartupTokenStoreDiagnostics {
    let raw_tokens = read_tokens_from_path_raw(path);
    let invalidation_marker_present = raw_tokens
        .as_ref()
        .ok()
        .and_then(Option::as_ref)
        .filter(|tokens| !tokens.access_token.is_empty())
        .is_some_and(|tokens| token_is_invalidated_at(path, &tokens.access_token));
    let recheck_read_result = token_read_result_label(read_tokens_from_path(path));
    StartupTokenStoreDiagnostics {
        invalidation_marker_present,
        first_read_result,
        recheck_read_result,
    }
}

/// Read the token store twice for startup diagnostics without returning token
/// contents or free-form filesystem errors. This does not affect auth state.
pub fn startup_token_store_diagnostics() -> StartupTokenStoreDiagnostics {
    match tokens_file_path() {
        Ok(path) => startup_token_store_diagnostics_at(&path),
        Err(_) => StartupTokenStoreDiagnostics {
            invalidation_marker_present: false,
            first_read_result: "err_io",
            recheck_read_result: "err_io",
        },
    }
}

/// Pair the auth resolver's original token-read result with one immediate
/// filtered reread and a raw-token invalidation-marker check.
pub fn startup_token_store_diagnostics_after_first(
    first_read_result: &'static str,
) -> StartupTokenStoreDiagnostics {
    match tokens_file_path() {
        Ok(path) => startup_token_store_diagnostics_after_first_at(&path, first_read_result),
        Err(_) => StartupTokenStoreDiagnostics {
            invalidation_marker_present: false,
            first_read_result,
            recheck_read_result: "err_io",
        },
    }
}

pub fn read_tokens_from_file() -> Result<Option<CognitoTokens>, String> {
    let path = tokens_file_path()?;
    read_tokens_from_path(&path).map_err(|e| match e {
        TokenReadError::Io(e) => format!("Failed to read token file: {}", e),
        TokenReadError::Parse(e) => format!("Failed to parse token file: {}", e),
    })
}

/// Returns true when `path` exists and its `accessToken` is non-empty.
/// Reads raw storage (including an invalidated token) because this is only a
/// friendly-copy hint. Malformed JSON is logged and
/// reported as "not signed in" so a half-written file can't trap a user on
/// the login step; I/O errors still bubble. This is only a presence hint for
/// choosing reauth copy — `get_auth_state` remains the freshness authority.
///
/// Production uses `has_non_empty_stored_token` (async, cache-backed);
/// this path-parameterized variant is kept so tests can exercise the
/// malformed-file / empty-token edges without touching `~/.hq`.
#[allow(dead_code)]
pub fn has_non_empty_token_at(path: &Path) -> Result<bool, String> {
    match read_tokens_from_path_raw(path) {
        Ok(Some(tokens)) => Ok(!tokens.access_token.is_empty()),
        Ok(None) => Ok(false),
        Err(TokenReadError::Parse(e)) => {
            eprintln!(
                "[cognito] has_non_empty_token_at: unreadable token file, treating as absent: {}",
                e
            );
            Ok(false)
        }
        Err(TokenReadError::Io(e)) => Err(format!("Failed to read token file: {}", e)),
    }
}

/// Whether the raw token store could be read, and whether it held a token.
///
/// `has_non_empty_stored_token` collapses an unreadable store to "absent",
/// which is right for choosing reauth copy and wrong for the launch install
/// gate: "could not read" is not "never signed in". The lifecycle classifier
/// uses this variant so an unreadable store is carried as unknown evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoredTokenPresence {
    /// A non-empty access token is on disk.
    Present,
    /// The store was read and holds no usable token (absent, empty, malformed).
    Absent,
    /// The store could not be read at all (permission denied, I/O error).
    Unreadable,
}

/// Read the raw token store, distinguishing "no token" from "could not read".
pub fn stored_token_presence_at(path: &Path) -> StoredTokenPresence {
    match read_tokens_from_path_raw(path) {
        Ok(Some(tokens)) if !tokens.access_token.is_empty() => StoredTokenPresence::Present,
        Ok(_) => StoredTokenPresence::Absent,
        // A half-written file is a real (recoverable) "no usable token".
        Err(TokenReadError::Parse(e)) => {
            eprintln!("[cognito] stored_token_presence: malformed token file: {e}");
            StoredTokenPresence::Absent
        }
        Err(TokenReadError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            StoredTokenPresence::Absent
        }
        Err(TokenReadError::Io(e)) => {
            eprintln!("[cognito] stored_token_presence: token store unreadable: {e}");
            StoredTokenPresence::Unreadable
        }
    }
}

/// Production variant of [`stored_token_presence_at`] over `~/.hq`.
pub async fn stored_token_presence() -> StoredTokenPresence {
    match tokens_file_path() {
        Ok(path) => stored_token_presence_at(&path),
        Err(e) => {
            eprintln!("[cognito] stored_token_presence: token path unavailable: {e}");
            StoredTokenPresence::Unreadable
        }
    }
}

/// Async production variant of the raw-storage presence hint. Any upstream
/// failure is logged and collapsed to `Ok(false)` for this UX signal only.
pub async fn has_non_empty_stored_token() -> Result<bool, String> {
    let path = tokens_file_path()?;
    match read_tokens_from_path_raw(&path) {
        Ok(Some(tokens)) => Ok(!tokens.access_token.is_empty()),
        Ok(None) => Ok(false),
        Err(e) => {
            eprintln!(
                "[cognito] has_non_empty_stored_token: treating unreadable token as absent: {:?}",
                e
            );
            Ok(false)
        }
    }
}

fn write_tokens_to_path_unlocked(path: &Path, tokens: &CognitoTokens) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .hq directory: {}", e))?;
    }
    let contents = serde_json::to_string_pretty(tokens)
        .map_err(|e| format!("Failed to serialize tokens: {}", e))?;

    // A successful login/refresh for this exact token generation is
    // authoritative. Remove its old rejection marker before publishing it.
    remove_invalidation_marker_at(path, &tokens.access_token)?;

    let file_name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp_path = path.with_file_name(format!(".{file_name}.tmp.{}", std::process::id()));
    std::fs::write(&tmp_path, &contents)
        .map_err(|e| format!("Failed to write temp token file: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&tmp_path, perms)
            .map_err(|e| format!("Failed to set temp file permissions: {}", e))?;
    }

    std::fs::rename(&tmp_path, &path)
        .map_err(|e| format!("Failed to rename temp token file: {}", e))?;
    Ok(())
}

fn write_tokens_to_path(path: &Path, tokens: &CognitoTokens) -> Result<(), String> {
    let _lock = lock_token_file_at(path)?;
    write_tokens_to_path_unlocked(path, tokens)
}

fn persist_refreshed_tokens_if_current_unlocked(
    path: &Path,
    started_from: &CognitoTokens,
    refreshed: &CognitoTokens,
    accept_matching_invalidation: bool,
) -> Result<RefreshPersistenceOutcome, String> {
    let current_raw = read_tokens_from_path_raw(path).map_err(|error| match error {
        TokenReadError::Io(error) => format!("Failed to read token file: {error}"),
        TokenReadError::Parse(error) => format!("Failed to parse token file: {error}"),
    })?;
    let current = current_raw
        .clone()
        .filter(|tokens| !token_is_invalidated_at(path, &tokens.access_token));
    let started_generation_is_usable = current.as_ref() == Some(started_from);
    let started_generation_is_marked = accept_matching_invalidation
        && current_raw.as_ref() == Some(started_from)
        && token_is_invalidated_at(path, &started_from.access_token);
    if !started_generation_is_usable && !started_generation_is_marked {
        return Ok(RefreshPersistenceOutcome::Superseded(current));
    }

    write_tokens_to_path_unlocked(path, refreshed)?;
    Ok(RefreshPersistenceOutcome::Persisted(refreshed.clone()))
}

fn persist_refreshed_tokens_if_current_at(
    path: &Path,
    started_from: &CognitoTokens,
    refreshed: &CognitoTokens,
) -> Result<RefreshPersistenceOutcome, String> {
    let _lock = lock_token_file_at(path)?;
    persist_refreshed_tokens_if_current_unlocked(path, started_from, refreshed, false)
}

pub fn write_tokens_to_file(tokens: &CognitoTokens) -> Result<(), String> {
    let path = tokens_file_path()?;
    write_tokens_to_path(&path, tokens)
}

/// Get tokens and the bounded class of the initial file read, using the same
/// in-memory cache and invalidation behavior as `get_tokens`.
pub async fn get_tokens_with_read_result() -> (Result<Option<CognitoTokens>, String>, &'static str)
{
    let path = match tokens_file_path() {
        Ok(path) => path,
        Err(error) => return (Err(error), "err_io"),
    };

    // Get mtime — treat NotFound as "no file" (avoids TOCTOU with path.exists())
    let current_mtime = match std::fs::metadata(&path).and_then(|m| m.modified()) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut guard = cache().lock().await;
            *guard = None;
            return (Ok(None), "ok_none");
        }
        Err(e) => return (Err(format!("Failed to read file mtime: {}", e)), "err_io"),
    };
    let mut guard = cache().lock().await;

    if let Some(ref cached) = *guard {
        if cached.path == path && cached.file_mtime == current_mtime {
            if token_is_invalidated_at(&path, &cached.tokens.access_token) {
                *guard = None;
                return (Ok(None), "ok_none");
            }
            return (Ok(Some(cached.tokens.clone())), "ok_some");
        }
    }

    // Cache miss or mtime changed — re-read
    drop(guard);
    let tokens = match read_tokens_from_path(&path) {
        Ok(tokens) => tokens,
        Err(TokenReadError::Io(error)) => {
            return (Err(format!("Failed to read token file: {error}")), "err_io");
        }
        Err(TokenReadError::Parse(error)) => {
            return (
                Err(format!("Failed to parse token file: {error}")),
                "err_parse",
            );
        }
    };
    if let Some(ref tokens) = tokens {
        let mut guard = cache().lock().await;
        *guard = Some(CachedTokens {
            tokens: tokens.clone(),
            path: path.clone(),
            file_mtime: current_mtime,
        });
    } else {
        let mut guard = cache().lock().await;
        *guard = None;
    }
    let result = if tokens.is_some() {
        "ok_some"
    } else {
        "ok_none"
    };
    (Ok(tokens), result)
}

/// Get tokens, using in-memory cache with mtime invalidation.
pub async fn get_tokens() -> Result<Option<CognitoTokens>, String> {
    get_tokens_with_read_result().await.0
}

/// Update both the file and the in-memory cache.
pub async fn set_tokens(tokens: &CognitoTokens) -> Result<(), String> {
    let mut guard = cache().lock().await;
    write_tokens_to_file(tokens)?;
    let path = tokens_file_path()?;
    let mtime = file_mtime(&path)?;
    *guard = Some(CachedTokens {
        tokens: tokens.clone(),
        path,
        file_mtime: mtime,
    });
    crate::feature_gate::clear_cached_gate();
    Ok(())
}

async fn persist_refreshed_tokens_if_current_with_invalidation(
    started_from: &CognitoTokens,
    refreshed: &CognitoTokens,
    accept_matching_invalidation: bool,
) -> Result<RefreshPersistenceOutcome, String> {
    let path = tokens_file_path()?;
    let mut guard = cache().lock().await;
    let _file_lock = lock_token_file_at(&path)?;
    let outcome = persist_refreshed_tokens_if_current_unlocked(
        &path,
        started_from,
        refreshed,
        accept_matching_invalidation,
    )?;

    *guard = match outcome.current_tokens() {
        Some(tokens) => Some(CachedTokens {
            tokens: tokens.clone(),
            path: path.clone(),
            file_mtime: file_mtime(&path)?,
        }),
        None => None,
    };
    crate::feature_gate::clear_cached_gate();
    Ok(outcome)
}

/// Publish a refresh result only if the exact token generation it started from
/// is still the current, usable on-disk generation.
///
/// The comparison and atomic token-file replacement share a cross-process
/// sidecar lock with login, sign-out, and invalidation writes. A newer login or
/// refresh is returned as `Superseded(Some(tokens))`; sign-out or invalidation
/// is returned as `Superseded(None)`.
pub async fn persist_refreshed_tokens_if_current(
    started_from: &CognitoTokens,
    refreshed: &CognitoTokens,
) -> Result<RefreshPersistenceOutcome, String> {
    persist_refreshed_tokens_if_current_with_invalidation(started_from, refreshed, false).await
}

/// Mark one rejected token generation unusable without deleting the shared
/// credential file. A concurrent login/refresh that writes a different token
/// remains valid, and the raw file stays available for friendly reauth copy.
pub async fn invalidate_tokens(tokens: &CognitoTokens) -> Result<(), String> {
    let path = tokens_file_path()?;
    invalidate_token_at(&path, &tokens.access_token)?;
    let mut guard = cache().lock().await;
    if guard
        .as_ref()
        .is_some_and(|cached| cached.tokens.access_token == tokens.access_token)
    {
        *guard = None;
    }
    crate::feature_gate::clear_cached_gate();
    Ok(())
}

/// Sign out locally: delete the on-disk token file and drop the in-memory
/// cache so a relaunch (and any in-session token read) sees no identity. Without
/// this, flipping a frontend `authenticated` flag leaves
/// `~/.hq/cognito-tokens.json` in place and the app silently re-authenticates on
/// next launch. A missing file is treated as already-signed-out (not an error).
/// The cache is cleared regardless so an in-session sign-out takes effect even
/// if the file delete races. Also clears the cached feature gate, mirroring
/// `set_tokens`. This is a local sign-out (this device) — it does not revoke the
/// refresh token server-side, so other signed-in devices are unaffected.
pub async fn clear_tokens() -> Result<(), String> {
    let path = tokens_file_path()?;
    let mut guard = cache().lock().await;
    remove_token_file_at(&path)?;
    *guard = None;
    crate::feature_gate::clear_cached_gate();
    Ok(())
}

/// Delete a token file. A missing file is success (already signed out), so this
/// is idempotent. Path-parameterized (mirrors `has_non_empty_token_at`) so the
/// deletion contract is unit-testable without `$HOME` or the async cache.
fn remove_token_file_at_unlocked(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Failed to delete token file: {}", e)),
    }
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    let marker_prefix = format!(
        "{}.invalid.",
        path.file_name().unwrap_or_default().to_string_lossy()
    );
    let entries = match std::fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Failed to list token invalidations: {e}")),
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read token invalidation: {e}"))?;
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(&marker_prefix)
        {
            std::fs::remove_file(entry.path())
                .map_err(|e| format!("Failed to delete token invalidation: {e}"))?;
        }
    }
    Ok(())
}

fn remove_token_file_at(path: &Path) -> Result<(), String> {
    let _lock = lock_token_file_at(path)?;
    remove_token_file_at_unlocked(path)
}

pub fn is_expired(tokens: &CognitoTokens) -> bool {
    if tokens.expires_at <= 0 {
        return true; // treat corrupt/zero timestamps as expired
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    tokens.expires_at - now_ms < EXPIRY_BUFFER_MS
}

pub fn expires_at_iso(tokens: &CognitoTokens) -> String {
    format_unix_ms_as_iso(tokens.expires_at.max(0))
}

/// Classify the principal `tokens` authenticate, returning `None` for a human.
///
/// `~/.hq/cognito-tokens.json` is shared with the `hq` CLI and with machine
/// identities: anything running as this user can replace its contents, and the
/// desktop app re-reads it whenever the mtime changes. So the app cannot treat
/// "there are tokens on disk" as "a person signed in here" — it has to look at
/// who the tokens actually belong to, on every read.
///
/// Both tokens are inspected because the custom attributes are projected onto
/// the id_token; the access token is the fallback for a generation that
/// predates it. A token that will not decode at all yields `None` (human) —
/// that is the existing behaviour for malformed tokens everywhere else in this
/// module, and the server still rejects them independently.
pub fn non_human_principal_from_tokens(tokens: &CognitoTokens) -> Option<NonHumanPrincipal> {
    [
        tokens.id_token.as_deref(),
        Some(tokens.access_token.as_str()),
    ]
    .into_iter()
    .flatten()
    .filter_map(|token| decode_id_token_claims(token).ok())
    .find_map(|claims| claims.non_human_principal())
}

/// Get a non-expired token generation, refreshing + persisting if needed.
///
/// Centralises the "read tokens → check expiry → refresh + persist"
/// pattern that `auth.rs::get_auth_state` implements inline so other
/// callers (meetings commands, any future vault wrapper) don't each
/// re-derive it and silently skip the refresh — which is the bug that
/// caused the meetings window to "lose auth" after the 1-hour Cognito
/// access-token TTL: its old `auth_header()` used the stored token
/// verbatim, with no expiry check.
///
/// Returns `Err` when the user isn't signed in (no tokens on disk) or
/// when the refresh itself fails — callers should treat both as
/// "need to re-auth".
///
/// Concurrent callers can still make duplicate Cognito refresh requests, but
/// persistence is compare-and-swap: only a refresh of the current generation
/// can publish. A newer login/refresh is returned as the winner. If another
/// expired generation wins, resolution retries from that generation rather
/// than returning an already-expired access token.
pub async fn get_valid_tokens() -> Result<CognitoTokens, String> {
    resolve_tokens(false, COGNITO_ENDPOINT).await
}

/// Return the same validated tokens as `get_valid_tokens`, preserving only a
/// bounded refresh-failure class for startup diagnostics.
pub async fn get_valid_tokens_classified() -> Result<CognitoTokens, CognitoTokenResolutionError> {
    resolve_tokens_classified(false, COGNITO_ENDPOINT).await
}

/// Refresh Cognito tokens even when the current access token has not expired.
/// Use this when a token claim may have changed after a server-side account
/// update, such as email verification.
pub async fn refresh_tokens() -> Result<CognitoTokens, String> {
    resolve_tokens(true, COGNITO_ENDPOINT).await
}

async fn resolve_tokens(
    force_refresh: bool,
    cognito_endpoint: &str,
) -> Result<CognitoTokens, String> {
    resolve_tokens_classified(force_refresh, cognito_endpoint)
        .await
        .map_err(|error| error.message)
}

async fn get_tokens_for_resolution() -> Result<Option<(CognitoTokens, bool)>, String> {
    if let Some(tokens) = get_tokens().await? {
        return Ok(Some((tokens, false)));
    }

    let path = tokens_file_path()?;
    let marked = read_tokens_marked_invalidated_from_path(&path).map_err(|error| match error {
        TokenReadError::Io(error) => format!("Failed to read token file: {error}"),
        TokenReadError::Parse(error) => format!("Failed to parse token file: {error}"),
    })?;
    if let Some(tokens) = marked {
        // The marker rejects this access-token generation, not necessarily its
        // refresh token. Verify the stored refresh token before showing sign-in.
        return Ok(Some((tokens, true)));
    }

    // A concurrent successful write may have cleared a marker or installed a
    // newer generation between the first read and the raw marker check.
    Ok(get_tokens().await?.map(|tokens| (tokens, false)))
}

async fn resolve_tokens_classified(
    force_refresh: bool,
    cognito_endpoint: &str,
) -> Result<CognitoTokens, CognitoTokenResolutionError> {
    for _ in 0..VALID_TOKEN_RESOLUTION_ATTEMPTS {
        let (tokens, matching_invalidation) = get_tokens_for_resolution()
            .await
            .map_err(CognitoTokenResolutionError::plain)?
            .ok_or_else(|| CognitoTokenResolutionError::plain("Not signed in".to_string()))?;
        let path = tokens_file_path().map_err(CognitoTokenResolutionError::plain)?;
        if refresh_rejection_recorded_at(&path, &tokens.access_token)
            .map_err(CognitoTokenResolutionError::plain)?
        {
            return Err(CognitoTokenResolutionError::refresh(
                REAUTH_MESSAGE.to_string(),
                CognitoRefreshFailureClass::Http4xx,
                true,
            ));
        }
        if !force_refresh && !matching_invalidation && !is_expired(&tokens) {
            return Ok(tokens);
        }

        let refreshed =
            match refresh_access_token_classified_at(cognito_endpoint, &tokens.refresh_token).await
            {
                Ok(tokens) => tokens,
                Err(err) => {
                    let failure_class = err.failure_class;
                    let requires_reauth = err.requires_reauth;
                    let error_code = if err.status_code == Some(401)
                        && !matches!(err.error_code.as_deref(), Some("NotAuthorizedException" | "invalid_grant" | "invalid_client"))
                    {
                        Some("HTTP401".to_string())
                    } else {
                        err.error_code.clone()
                    };
                    if err.requires_reauth {
                        invalidate_tokens(&tokens).await.map_err(|message| {
                            CognitoTokenResolutionError::refresh(
                                message,
                                failure_class,
                                requires_reauth,
                            )
                        })?;
                        let path =
                            tokens_file_path().map_err(CognitoTokenResolutionError::plain)?;
                        record_rejected_refresh_at(&path, &tokens.access_token, error_code.as_deref()).map_err(
                            |message| {
                                CognitoTokenResolutionError::refresh(
                                    message,
                                    failure_class,
                                    requires_reauth,
                                )
                            },
                        )?;
                    }
                    match get_tokens().await.map_err(|message| {
                        CognitoTokenResolutionError::refresh(
                            message,
                            failure_class,
                            requires_reauth,
                        )
                    })? {
                        Some(current) if current != tokens => {
                            if !is_expired(&current) {
                                return Ok(current);
                            }
                            continue;
                        }
                        _ => {
                            return Err(CognitoTokenResolutionError::refresh(
                                REAUTH_MESSAGE.to_string(),
                                failure_class,
                                requires_reauth,
                            ))
                        }
                    }
                }
            };

        match persist_refreshed_tokens_if_current_with_invalidation(
            &tokens,
            &refreshed,
            matching_invalidation,
        )
        .await
        .map_err(CognitoTokenResolutionError::plain)?
        .into_current_tokens()
        {
            Some(current) if !is_expired(&current) => return Ok(current),
            Some(_) => continue,
            None => {
                return Err(CognitoTokenResolutionError::plain(
                    "Not signed in".to_string(),
                ))
            }
        }
    }

    Err(CognitoTokenResolutionError::plain(
        REAUTH_MESSAGE.to_string(),
    ))
}

/// Get a non-expired access token, refreshing with CAS-safe persistence if
/// needed. Callers that also need identity claims should use
/// [`get_valid_tokens`] instead.
pub async fn get_valid_access_token() -> Result<String, String> {
    get_valid_tokens().await.map(|tokens| tokens.access_token)
}

/// Subset of Cognito ID-token claims we actually use. The token is signed
/// by Cognito and already-validated when it was minted; we don't re-verify
/// the signature here (the API endpoints will reject anything that fails
/// real verification on the server). Just decode + parse the middle JWT
/// segment as JSON. Mirrors the TS `decodeJwtClaims` in sync-runner.ts.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct IdTokenClaims {
    pub sub: Option<String>,
    pub email: Option<String>,
    /// Whether Cognito verified the email address on this identity.
    ///
    /// ID tokens carry this as a JSON bool. Access tokens minted since the
    /// hq-pro pre-token-generation change carry it as the string `"true"` /
    /// `"false"`, so accept both; a strict `bool` here made every
    /// access-token decode fail and held sign-in receipts forever.
    #[serde(default, deserialize_with = "deserialize_bool_or_string")]
    pub email_verified: Option<bool>,
    pub name: Option<String>,
    pub given_name: Option<String>,
    pub family_name: Option<String>,
    /// Echo of the `nonce` the authorize request sent.
    ///
    /// Browser continuation binds the token it receives back to the attempt
    /// that asked for it: a token whose nonce does not match, or which carries
    /// none at all, is discarded rather than held. Absent on tokens minted by
    /// the older provider-button flow, which does not send a nonce — hence
    /// `Option`, and hence continuation treating `None` as a mismatch rather
    /// than as permission.
    #[serde(default)]
    pub nonce: Option<String>,
    /// Cognito custom attribute marking a non-human principal. People never
    /// carry it, so its presence is the authoritative "this is not a person"
    /// signal. Fleet agents set `agent`; outposts set `outpost`.
    #[serde(default, rename = "custom:entityType")]
    pub entity_type: Option<String>,
    /// The `agt_…` / `otp_…` uid the principal is bound to. Only present
    /// alongside `entity_type`.
    #[serde(default, rename = "custom:entityUid")]
    pub entity_uid: Option<String>,
}

/// Why a decoded principal was classified as non-human. Carried into the
/// signed-out reason so support can tell an agent token apart from an
/// outpost token without asking for the raw claims.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NonHumanPrincipal {
    /// `custom:entityType=agent`, an `agt_`/`agt-` uid, or an agent-shaped
    /// `@agents.<domain>` address.
    Agent,
    /// `custom:entityType=outpost`, or an `otp_`/`otp-` uid.
    Outpost,
}

impl NonHumanPrincipal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Outpost => "outpost",
        }
    }
}

/// True when `value` begins with `prefix` followed by `_` or `-`.
///
/// Both separators are load-bearing. Canonical uids minted server-side use
/// the underscore form (`agt_01M2…`), but the Cognito *username* derived from
/// them uses a dash (`agt-01m2…@agents.getindigo.ai`) because `@` addresses
/// cannot carry an underscore in that position. A guard that checks only one
/// form misses half the real tokens.
fn has_entity_prefix(value: &str, prefix: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with(&format!("{prefix}_")) || lower.starts_with(&format!("{prefix}-"))
}

impl IdTokenClaims {
    /// Classify the principal these claims describe, returning `None` for a
    /// human.
    ///
    /// Deliberately over-inclusive: three independent signals are checked and
    /// any one of them is disqualifying. A human account can never satisfy
    /// them (people carry no `custom:entityType`, hold `prs_` entities, and
    /// cannot register an `@agents.` address — that domain is minted only by
    /// server-side agent provisioning), so a false positive here is not
    /// reachable, while a false *negative* signs a machine in as a person.
    pub fn non_human_principal(&self) -> Option<NonHumanPrincipal> {
        if let Some(entity_type) = self.entity_type.as_deref() {
            match entity_type.trim().to_ascii_lowercase().as_str() {
                "agent" => return Some(NonHumanPrincipal::Agent),
                "outpost" => return Some(NonHumanPrincipal::Outpost),
                // An unrecognized entityType is still, definitionally, not a
                // person: only non-humans carry the attribute at all. Treat a
                // future value as an agent rather than waving it through.
                other if !other.is_empty() => return Some(NonHumanPrincipal::Agent),
                _ => {}
            }
        }

        if let Some(uid) = self.entity_uid.as_deref() {
            if has_entity_prefix(uid, "agt") {
                return Some(NonHumanPrincipal::Agent);
            }
            if has_entity_prefix(uid, "otp") {
                return Some(NonHumanPrincipal::Outpost);
            }
        }

        // Last line of defence: the email shape. Covers a token minted before
        // the custom attributes were set, and the `conn-…@agents.` external
        // connection identities, which carry no entityUid at all.
        if let Some(email) = self.email.as_deref() {
            let lower = email.trim().to_ascii_lowercase();
            if let Some((local, domain)) = lower.split_once('@') {
                if domain == "agents.getindigo.ai" || domain.starts_with("agents.") {
                    return Some(NonHumanPrincipal::Agent);
                }
                if has_entity_prefix(local, "agt") || has_entity_prefix(local, "conn") {
                    return Some(NonHumanPrincipal::Agent);
                }
                if has_entity_prefix(local, "otp") {
                    return Some(NonHumanPrincipal::Outpost);
                }
            }
        }

        None
    }
}

impl IdTokenClaims {
    /// Best-effort display name: `name` first, then `given_name family_name`,
    /// then `email`, else empty. Matches the TS runner's claim-dance fallback.
    pub fn display_name(&self) -> String {
        if let Some(n) = self.name.as_deref().filter(|s| !s.is_empty()) {
            return n.to_string();
        }
        let given = self.given_name.as_deref().unwrap_or("").trim();
        let family = self.family_name.as_deref().unwrap_or("").trim();
        if !given.is_empty() || !family.is_empty() {
            return [given, family]
                .iter()
                .filter(|s| !s.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join(" ");
        }
        self.email.clone().unwrap_or_default()
    }
}

/// Decode the middle segment of a JWT and parse it as the claims struct.
/// JWT format: `header.payload.signature` (base64url-encoded segments).
/// Deserialize a claim that Cognito emits either as a JSON bool or as the
/// string `"true"` / `"false"` (custom-attribute style). Any other value is a
/// parse error so a malformed token still fails loudly.
fn deserialize_bool_or_string<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error as _;
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    match value {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::Bool(flag)) => Ok(Some(flag)),
        Some(serde_json::Value::String(text)) => match text.trim() {
            "true" => Ok(Some(true)),
            "false" => Ok(Some(false)),
            other => Err(D::Error::custom(format!(
                "expected \"true\" or \"false\", got {other:?}"
            ))),
        },
        Some(other) => Err(D::Error::custom(format!(
            "expected bool or bool-string, got {other}"
        ))),
    }
}

pub fn decode_id_token_claims(id_token: &str) -> Result<IdTokenClaims, String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let payload = id_token
        .split('.')
        .nth(1)
        .ok_or_else(|| "id_token: missing payload segment".to_string())?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|e| format!("id_token: base64 decode failed: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("id_token: claims json parse failed: {e}"))
}

fn format_unix_ms_as_iso(ms: i64) -> String {
    let total_secs = ms / 1000;
    let millis = ms % 1000;

    // Days since epoch
    let days = total_secs / 86400;
    let day_secs = total_secs % 86400;
    let hours = day_secs / 3600;
    let minutes = (day_secs % 3600) / 60;
    let seconds = day_secs % 60;

    // Convert days since epoch to year-month-day
    // Algorithm from Howard Hinnant
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, m, d, hours, minutes, seconds, millis
    )
}

/// Cognito InitiateAuth response shape (partial)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InitiateAuthResponse {
    authentication_result: AuthenticationResult,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct AuthenticationResult {
    access_token: String,
    id_token: Option<String>,
    expires_in: i64,
    // Cognito does not return a new refresh token on REFRESH_TOKEN_AUTH
}

pub async fn refresh_access_token_classified(
    refresh_token: &str,
) -> Result<CognitoTokens, CognitoRefreshError> {
    refresh_access_token_classified_at(COGNITO_ENDPOINT, refresh_token).await
}

async fn refresh_access_token_classified_at(
    cognito_endpoint: &str,
    refresh_token: &str,
) -> Result<CognitoTokens, CognitoRefreshError> {
    let client = crate::client_info::build_client();

    let body = serde_json::json!({
        "AuthFlow": "REFRESH_TOKEN_AUTH",
        "ClientId": crate::oauth::cognito_client_id(),
        "AuthParameters": {
            "REFRESH_TOKEN": refresh_token
        }
    });

    for attempt in 0..REFRESH_ATTEMPTS {
        let response = match client
            .post(cognito_endpoint)
            .timeout(REFRESH_REQUEST_TIMEOUT)
            .header("Content-Type", "application/x-amz-json-1.1")
            .header(
                "X-Amz-Target",
                "AWSCognitoIdentityProviderService.InitiateAuth",
            )
            .json(&body)
            .send()
            .await
        {
            Ok(response) => response,
            Err(err) => {
                let failure = CognitoRefreshError {
                    message: format!("Cognito refresh request failed: {err}"),
                    requires_reauth: false,
                    status_code: None,
                    error_code: None,
                    failure_class: if err.is_timeout() {
                        CognitoRefreshFailureClass::Timeout
                    } else {
                        CognitoRefreshFailureClass::Network
                    },
                };
                if attempt + 1 < REFRESH_ATTEMPTS {
                    wait_before_refresh_retry(attempt).await;
                    continue;
                }
                return Err(failure);
            }
        };

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body_text = response
                .text()
                .await
                .unwrap_or_else(|_| "unknown".to_string());
            let (error_code, diagnostic) = refresh_diagnostic(status, &body_text, refresh_token);
            let (retryable, requires_reauth) = classify_refresh_failure(status, &body_text);
            eprintln!("{diagnostic}");
            let failure = CognitoRefreshError {
                message: diagnostic,
                requires_reauth,
                status_code: Some(status),
                error_code,
                failure_class: refresh_failure_class_from_status(status),
            };
            if retryable && attempt + 1 < REFRESH_ATTEMPTS {
                wait_before_refresh_retry(attempt).await;
                continue;
            }
            return Err(failure);
        }

        let result: InitiateAuthResponse = match response.json().await {
            Ok(result) => result,
            Err(err) => {
                let timed_out = err.is_timeout();
                let failure = CognitoRefreshError {
                    message: format!("Failed to parse Cognito response: {err}"),
                    requires_reauth: false,
                    status_code: None,
                    error_code: None,
                    failure_class: if timed_out {
                        CognitoRefreshFailureClass::Timeout
                    } else {
                        CognitoRefreshFailureClass::ResponseDecode
                    },
                };
                if timed_out && attempt + 1 < REFRESH_ATTEMPTS {
                    wait_before_refresh_retry(attempt).await;
                    continue;
                }
                return Err(failure);
            }
        };

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        return Ok(CognitoTokens {
            access_token: result.authentication_result.access_token,
            id_token: result.authentication_result.id_token,
            refresh_token: refresh_token.to_string(),
            expires_at: now_ms + (result.authentication_result.expires_in * 1000),
        });
    }

    Err(CognitoRefreshError {
        message: REAUTH_MESSAGE.to_string(),
        requires_reauth: false,
        status_code: None,
        error_code: None,
        failure_class: CognitoRefreshFailureClass::Unknown,
    })
}

pub async fn refresh_access_token(refresh_token: &str) -> Result<CognitoTokens, String> {
    refresh_access_token_classified(refresh_token)
        .await
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporary_refresh_failure_is_not_a_signed_out_startup_verdict() {
        let result = startup_auth_state_result(
            AuthState {
                authenticated: false,
                expires_at: None,
                account_id: None,
                email: None,
                display_name: None,
                startup_token_read_result: None,
            },
            &AuthSessionStatus::RefreshTemporarilyUnavailable,
        );

        assert!(
            result.is_err(),
            "temporary refresh failure with saved credentials must stay unresolved"
        );
    }

    #[test]
    fn invalid_credentials_remain_a_signed_out_startup_verdict() {
        let result = startup_auth_state_result(
            AuthState {
                authenticated: false,
                expires_at: None,
                account_id: None,
                email: None,
                display_name: None,
                startup_token_read_result: None,
            },
            &AuthSessionStatus::CredentialsInvalid,
        )
        .expect("invalid credentials must route to sign-in");

        assert!(!result.authenticated);
    }

    #[test]
    fn startup_token_store_read_error_is_not_classified_as_absent() {
        assert_eq!(
            startup_token_store_status(true),
            AuthSessionStatus::CredentialsReadError
        );
        assert_eq!(
            startup_token_store_status(false),
            AuthSessionStatus::CredentialsAbsent
        );
        assert_eq!(
            serde_json::to_string(&AuthSessionStatus::CredentialsReadError).unwrap(),
            "\"credentials_read_error\""
        );
        let signed_out = startup_auth_state_result(
            AuthState {
                authenticated: false,
                expires_at: None,
                account_id: None,
                email: None,
                display_name: None,
                startup_token_read_result: None,
            },
            &AuthSessionStatus::CredentialsReadError,
        )
        .expect("read errors preserve the existing signed-out startup route");
        assert!(!signed_out.authenticated);
    }

    #[test]
    fn refresh_failure_statuses_map_to_low_cardinality_buckets() {
        assert_eq!(refresh_failure_class_from_status(401).as_tag(), "http_4xx");
        assert_eq!(refresh_failure_class_from_status(503).as_tag(), "http_5xx");
        assert_eq!(CognitoRefreshFailureClass::Timeout.as_tag(), "timeout");
        assert_eq!(CognitoRefreshFailureClass::Network.as_tag(), "network");
    }
    use std::sync::mpsc;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };
    use std::time::{Duration, Instant};
    use tempfile;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn read_test_request(stream: &mut tokio::net::TcpStream) {
        let read_request = async {
            let mut received = Vec::new();
            for _ in 0..16 {
                let mut chunk = [0_u8; 1024];
                let count = stream.read(&mut chunk).await.expect("read test request");
                if count == 0 {
                    return false;
                }
                received.extend_from_slice(&chunk[..count]);

                let Some(headers_end) = received
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|index| index + 4)
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&received[..headers_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if received.len() >= headers_end + content_length {
                    return true;
                }
            }
            false
        };
        assert!(
            tokio::time::timeout(Duration::from_secs(2), read_request)
                .await
                .expect("test request stays within its deadline"),
            "test server receives the full request"
        );
    }

    struct TestHome {
        previous: Option<std::ffi::OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl TestHome {
        fn set(path: &std::path::Path) -> Self {
            let lock = HQ_TEST_HOME_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let previous = std::env::var_os("HQ_TEST_HOME");
            std::env::set_var("HQ_TEST_HOME", path);
            Self {
                previous,
                _lock: lock,
            }
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.take() {
                std::env::set_var("HQ_TEST_HOME", previous);
            } else {
                std::env::remove_var("HQ_TEST_HOME");
            }
        }
    }

    #[tokio::test]
    async fn get_tokens_read_result_uses_typed_path_free_classes() {
        let home = tempfile::tempdir().expect("temp home");
        let _test_home = TestHome::set(home.path());
        let token_dir = home.path().join(".hq");
        std::fs::create_dir_all(&token_dir).expect("token directory");
        let token_path = token_dir.join("cognito-tokens.json");

        std::fs::write(&token_path, "{").expect("invalid token json");
        let (parse_result, parse_class) = get_tokens_with_read_result().await;
        let parse_error = parse_result.expect_err("malformed token json is rejected");
        assert_eq!(parse_class, "err_parse");
        assert!(parse_error.starts_with("Failed to parse token file:"));
        assert!(!parse_error.contains(home.path().to_string_lossy().as_ref()));

        std::fs::remove_file(&token_path).expect("remove malformed token file");
        std::fs::create_dir(&token_path).expect("directory at token-file path");
        let (io_result, io_class) = get_tokens_with_read_result().await;
        let io_error = io_result.expect_err("directory cannot be read as a token file");
        assert_eq!(io_class, "err_io");
        assert!(io_error.starts_with("Failed to read token file:"));
        assert!(!io_error.contains(home.path().to_string_lossy().as_ref()));
    }

    fn claims_jwt(payload: serde_json::Value) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        let encoded =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("claims serialize"));
        format!("header.{encoded}.signature")
    }

    fn tokens_with_id_claims(payload: serde_json::Value) -> CognitoTokens {
        CognitoTokens {
            access_token: claims_jwt(serde_json::json!({ "sub": "access-sub" })),
            id_token: Some(claims_jwt(payload)),
            refresh_token: "refresh".to_string(),
            expires_at: i64::MAX,
        }
    }

    #[test]
    fn decode_id_token_claims_preserves_email_verification_status() {
        let claims = decode_id_token_claims(&claims_jwt(serde_json::json!({
            "email_verified": false
        })))
        .expect("valid claims");

        assert_eq!(claims.email_verified, Some(false));
    }

    #[test]
    fn decode_claims_accepts_access_token_email_verified_string_true() {
        // Cognito access tokens (post hq-pro pre-token-generation change)
        // carry `email_verified` as the string "true", not a JSON bool.
        let claims = decode_id_token_claims(&claims_jwt(serde_json::json!({
            "sub": "person-a",
            "email_verified": "true"
        })))
        .expect("string-form email_verified must decode");

        assert_eq!(claims.sub.as_deref(), Some("person-a"));
        assert_eq!(claims.email_verified, Some(true));
    }

    #[test]
    fn decode_claims_accepts_access_token_email_verified_string_false() {
        let claims = decode_id_token_claims(&claims_jwt(serde_json::json!({
            "sub": "person-a",
            "email_verified": "false"
        })))
        .expect("string-form email_verified must decode");

        assert_eq!(claims.email_verified, Some(false));
    }

    #[test]
    fn decode_claims_still_accepts_bool_and_absent_email_verified() {
        let claims = decode_id_token_claims(&claims_jwt(serde_json::json!({
            "sub": "person-a",
            "email_verified": true
        })))
        .expect("bool email_verified must decode");
        assert_eq!(claims.email_verified, Some(true));

        let claims = decode_id_token_claims(&claims_jwt(serde_json::json!({
            "sub": "person-a"
        })))
        .expect("absent email_verified must decode");
        assert_eq!(claims.email_verified, None);
    }

    #[test]
    fn decode_claims_rejects_non_bool_email_verified() {
        let error = decode_id_token_claims(&claims_jwt(serde_json::json!({
            "sub": "person-a",
            "email_verified": "yes"
        })))
        .expect_err("unrecognised email_verified string must fail");
        assert!(error.contains("claims json parse failed"), "{error}");
    }

    #[tokio::test]
    async fn resolve_tokens_force_refreshes_and_recovers_from_transient_unavailability() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let home = tempfile::tempdir().expect("temporary token home");
        let _test_home = TestHome::set(home.path());
        let cached_tokens = CognitoTokens {
            access_token: "still-valid-access-token".into(),
            id_token: None,
            refresh_token: "refresh-token".into(),
            expires_at: i64::MAX,
        };
        set_tokens(&cached_tokens)
            .await
            .expect("store unexpired tokens");

        let cognito = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "AuthenticationResult": {
                    "AccessToken": "refreshed-access-token",
                    "ExpiresIn": 3600
                }
            })))
            .expect(1)
            .mount(&cognito)
            .await;

        let refreshed = resolve_tokens(true, &cognito.uri())
            .await
            .expect("forced refresh succeeds");
        assert_eq!(refreshed.access_token, "refreshed-access-token");

        let reused = resolve_tokens(false, &cognito.uri())
            .await
            .expect("unexpired token is reused without refresh");
        assert_eq!(reused, refreshed);
        cognito.verify().await;

        let expired_tokens = CognitoTokens {
            access_token: "expired-access-token".into(),
            id_token: None,
            refresh_token: "refresh-token".into(),
            expires_at: 1,
        };
        set_tokens(&expired_tokens)
            .await
            .expect("store expired tokens for launch refresh");

        let warming = MockServer::start().await;
        let retry_count = Arc::new(AtomicUsize::new(0));
        let retry_times = Arc::new(Mutex::new(Vec::new()));
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with({
                let retry_count = Arc::clone(&retry_count);
                let retry_times = Arc::clone(&retry_times);
                move |_request: &wiremock::Request| {
                    retry_times
                        .lock()
                        .expect("retry timestamps lock")
                        .push(Instant::now());
                    if retry_count.fetch_add(1, Ordering::SeqCst) < 2 {
                        ResponseTemplate::new(503)
                    } else {
                        ResponseTemplate::new(200).set_body_json(serde_json::json!({
                            "AuthenticationResult": {
                                "AccessToken": "startup-refreshed-access-token",
                                "ExpiresIn": 3600
                            }
                        }))
                    }
                }
            })
            .expect(3)
            .mount(&warming)
            .await;

        let restored = resolve_tokens(false, &warming.uri())
            .await
            .expect("expired access token is restored after Cognito becomes available");
        assert_eq!(restored.access_token, "startup-refreshed-access-token");
        let retry_times = retry_times.lock().expect("retry timestamps lock");
        assert_eq!(retry_times.len(), 3);
        assert!(retry_times[1].duration_since(retry_times[0]) >= Duration::from_millis(100));
        assert!(retry_times[2].duration_since(retry_times[1]) >= Duration::from_millis(250));
        drop(retry_times);
        warming.verify().await;

        set_tokens(&expired_tokens)
            .await
            .expect("restore the expired generation for the offline case");
        let unavailable = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(503))
            .expect(3)
            .mount(&unavailable)
            .await;

        let failure = resolve_tokens_classified(false, &unavailable.uri())
            .await
            .expect_err("offline refresh exhaustion stays classified");
        assert_eq!(
            failure.refresh_failure_class,
            Some(CognitoRefreshFailureClass::Http5xx)
        );
        assert!(get_tokens()
            .await
            .expect("read preserved offline token")
            .is_some());
        unavailable.verify().await;

        set_tokens(&expired_tokens)
            .await
            .expect("restore the expired generation for the response-body timeout case");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local Cognito response test server");
        let endpoint = format!("http://{}", listener.local_addr().expect("local address"));
        let body_timeout_server = tokio::spawn(async move {
            let (mut stalled, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
                .await
                .expect("first refresh request arrives")
                .expect("accept first refresh request");
            read_test_request(&mut stalled).await;
            stalled
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 128\r\nConnection: close\r\n\r\n{\"AuthenticationResult\":",
                )
                .await
                .expect("send partial Cognito response");
            tokio::time::sleep(Duration::from_secs(3)).await;
            drop(stalled);

            let (mut retry, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
                .await
                .expect("refresh retries after the response-body timeout")
                .expect("accept retried refresh request");
            read_test_request(&mut retry).await;
            let body = serde_json::json!({
                "AuthenticationResult": {
                    "AccessToken": "body-timeout-refreshed-access-token",
                    "ExpiresIn": 3600
                }
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            retry
                .write_all(response.as_bytes())
                .await
                .expect("send complete Cognito response");
        });

        let restored_after_body_timeout = resolve_tokens(false, &endpoint)
            .await
            .expect("response-body timeout retries the refresh request");
        assert_eq!(
            restored_after_body_timeout.access_token,
            "body-timeout-refreshed-access-token"
        );
        body_timeout_server
            .await
            .expect("Cognito response test server completes");
    }

    #[test]
    fn stored_token_presence_separates_absent_from_unreadable() {
        let dir = tempfile::tempdir().expect("tempdir");

        let missing = dir.path().join("cognito-tokens.json");
        assert_eq!(
            stored_token_presence_at(&missing),
            StoredTokenPresence::Absent
        );

        let malformed = dir.path().join("malformed.json");
        std::fs::write(&malformed, "{ not json").expect("write");
        assert_eq!(
            stored_token_presence_at(&malformed),
            StoredTokenPresence::Absent
        );

        let good = dir.path().join("good.json");
        std::fs::write(
            &good,
            serde_json::to_string(&CognitoTokens {
                access_token: "at".into(),
                id_token: None,
                refresh_token: "rt".into(),
                expires_at: i64::MAX,
            })
            .expect("serialize"),
        )
        .expect("write");
        assert_eq!(
            stored_token_presence_at(&good),
            StoredTokenPresence::Present
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let denied = dir.path().join("denied.json");
            std::fs::write(&denied, "{}").expect("write");
            std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o000))
                .expect("chmod");
            let presence = stored_token_presence_at(&denied);
            std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o644))
                .expect("chmod back");
            if unsafe { libc::geteuid() } != 0 {
                assert_eq!(presence, StoredTokenPresence::Unreadable);
            }
        }
    }

    #[test]
    fn person_claims_are_not_classified_as_non_human() {
        let claims = IdTokenClaims {
            sub: Some("cognito-sub".into()),
            email: Some("ben@yoprettyboy.com".into()),
            name: Some("Ben".into()),
            ..Default::default()
        };
        assert_eq!(claims.non_human_principal(), None);
    }

    #[test]
    fn entity_type_attribute_classifies_agents_and_outposts() {
        let agent = IdTokenClaims {
            entity_type: Some("agent".into()),
            ..Default::default()
        };
        assert_eq!(agent.non_human_principal(), Some(NonHumanPrincipal::Agent));

        let outpost = IdTokenClaims {
            entity_type: Some("OUTPOST".into()),
            ..Default::default()
        };
        assert_eq!(
            outpost.non_human_principal(),
            Some(NonHumanPrincipal::Outpost)
        );
    }

    /// Only non-humans carry `custom:entityType` at all, so an entityType we
    /// have never seen must still fail closed rather than sign in as a person.
    #[test]
    fn unrecognized_entity_type_fails_closed() {
        let claims = IdTokenClaims {
            entity_type: Some("some-future-machine-kind".into()),
            ..Default::default()
        };
        assert_eq!(claims.non_human_principal(), Some(NonHumanPrincipal::Agent));
    }

    /// Canonical uids use `agt_`; the derived Cognito username uses `agt-`.
    /// Both must be caught — this is the exact pair that produced the incident.
    #[test]
    fn both_underscore_and_dash_uid_forms_are_caught() {
        for uid in [
            "agt_01M2JYGTFSSYG85057NWVSKTH6",
            "agt-01m2jygtfssyg85057nwvskth6",
        ] {
            let claims = IdTokenClaims {
                entity_uid: Some(uid.into()),
                ..Default::default()
            };
            assert_eq!(
                claims.non_human_principal(),
                Some(NonHumanPrincipal::Agent),
                "uid {uid} should classify as an agent"
            );
        }
    }

    /// Regression for the reported incident: a token carrying only the agent
    /// email shape, with no custom attributes projected, must still be refused.
    #[test]
    fn agent_email_domain_is_caught_without_custom_attributes() {
        let claims = IdTokenClaims {
            sub: Some("cognito-sub".into()),
            email: Some("agt-01m2jygtfssyg85057nwvskth6@agents.getindigo.ai".into()),
            ..Default::default()
        };
        assert_eq!(claims.non_human_principal(), Some(NonHumanPrincipal::Agent));
    }

    #[test]
    fn external_connection_identities_are_caught() {
        let claims = IdTokenClaims {
            email: Some("conn-7f3a@agents.getindigo.ai".into()),
            ..Default::default()
        };
        assert_eq!(claims.non_human_principal(), Some(NonHumanPrincipal::Agent));
    }

    /// A human whose address merely *contains* an agent-ish substring is still
    /// a human. The guard keys on prefixes and the domain, not on substrings.
    #[test]
    fn human_addresses_resembling_agent_names_are_allowed() {
        for email in [
            "agatha@getindigo.ai",
            "management@getindigo.ai",
            "ben@agentsofchange.com",
            "otto@getindigo.ai",
        ] {
            let claims = IdTokenClaims {
                email: Some(email.into()),
                ..Default::default()
            };
            assert_eq!(
                claims.non_human_principal(),
                None,
                "{email} should be treated as a person"
            );
        }
    }

    #[test]
    fn token_level_classification_reads_the_id_token() {
        let tokens = tokens_with_id_claims(serde_json::json!({
            "sub": "cognito-sub",
            "email": "agt-01m2jygtfssyg85057nwvskth6@agents.getindigo.ai",
            "custom:entityType": "agent",
            "custom:entityUid": "agt_01M2JYGTFSSYG85057NWVSKTH6",
        }));
        assert_eq!(
            non_human_principal_from_tokens(&tokens),
            Some(NonHumanPrincipal::Agent)
        );
    }

    #[test]
    fn token_level_classification_passes_a_person_through() {
        let tokens = tokens_with_id_claims(serde_json::json!({
            "sub": "cognito-sub",
            "email": "ben@yoprettyboy.com",
            "name": "Ben",
        }));
        assert_eq!(non_human_principal_from_tokens(&tokens), None);
    }

    fn token_generation(name: &str) -> CognitoTokens {
        CognitoTokens {
            access_token: format!("{name}-access"),
            id_token: Some(format!("{name}-id")),
            refresh_token: format!("{name}-refresh"),
            expires_at: 999,
        }
    }

    #[test]
    fn test_is_expired_future_token() {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let tokens = CognitoTokens {
            access_token: "test".to_string(),
            id_token: Some("test".to_string()),
            refresh_token: "test".to_string(),
            expires_at: now_ms + 300_000, // 5 minutes from now
        };
        assert!(!is_expired(&tokens));
    }

    #[test]
    fn test_is_expired_within_buffer() {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let tokens = CognitoTokens {
            access_token: "test".to_string(),
            id_token: Some("test".to_string()),
            refresh_token: "test".to_string(),
            expires_at: now_ms + 60_000, // 1 minute from now (within 2-min buffer)
        };
        assert!(is_expired(&tokens));
    }

    #[test]
    fn test_is_expired_past_token() {
        let tokens = CognitoTokens {
            access_token: "test".to_string(),
            id_token: Some("test".to_string()),
            refresh_token: "test".to_string(),
            expires_at: 1000, // long past
        };
        assert!(is_expired(&tokens));
    }

    #[test]
    fn test_refresh_failure_classification() {
        assert!(refresh_status_is_retryable(401));
        assert!(refresh_status_is_retryable(503));
        assert!(refresh_status_is_retryable(429));
        assert!(!refresh_status_is_retryable(400));

        assert!(refresh_status_requires_reauth(400));
        assert!(refresh_status_requires_reauth(401));
        assert!(!refresh_status_requires_reauth(408));
        assert!(!refresh_status_requires_reauth(429));
        assert!(!refresh_status_requires_reauth(503));
    }

    #[test]
    fn test_too_many_requests_400_is_retryable_without_reauth() {
        let (retryable, requires_reauth) = classify_refresh_failure(
            400,
            r#"{"__type":"TooManyRequestsException","message":"slow down"}"#,
        );
        assert!(retryable);
        assert!(!requires_reauth);
    }

    #[test]
    fn refresh_rejection_is_classified_by_cognito_code() {
        assert_eq!(
            classify_refresh_failure(400, r#"{"__type":"NotAuthorizedException"}"#),
            (false, true),
        );
        assert_eq!(
            classify_refresh_failure(400, r#"{"error":"invalid_grant"}"#),
            (false, true),
        );
        assert_eq!(
            classify_refresh_failure(400, r#"{"__type":"InternalErrorException"}"#),
            (true, false),
        );
        assert_eq!(
            classify_refresh_failure(400, r#"{"error":"invalid_request"}"#),
            (true, false),
        );
        assert_eq!(classify_refresh_failure(401, r#"{"error":"invalid_client"}"#), (false, true));
        assert_eq!(classify_refresh_failure(503, "{}"), (true, false));
    }

    #[test]
    fn refresh_failure_branches_are_exclusive_and_only_definitive_codes_reauth() {
        for body in [r#"{"error":"invalid_client"}"#, r#"{"error":"invalid_grant"}"#, r#"{"__type":"NotAuthorizedException"}"#] {
            assert_eq!(classify_refresh_failure(400, body), (false, true));
        }
        assert_eq!(classify_refresh_failure(401, r#"{"error":"unknown"}"#), (false, true));
        for (status, body) in [
            (400, r#"{"error":"unknown"}"#),
            (400, "{}"),
            (403, r#"{"__type":"ForbiddenException"}"#),
            (400, r#"{"__type":"TooManyRequestsException"}"#),
            (400, r#"{"__type":"InternalErrorException"}"#),
            (500, r#"{"__type":"InternalErrorException"}"#),
        ] {
            assert_eq!(classify_refresh_failure(status, body), (true, false));
        }
    }

    #[tokio::test]
    async fn refresh_diagnostic_includes_status_and_code_but_redacts_tokens_emails_and_ids() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let body = r#"{"__type":"aws#NotAuthorizedException","message":"Refresh rejected for alice@example.com user_id=12345678-1234-1234-1234-123456789012 token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMiLCJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIn0.signature refresh_token: secret-value token secret-value refresh_token=\"quoted-secret\" refresh-secret"}"#;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(400).set_body_raw(body, "application/json"))
            .mount(&server)
            .await;
        let error = refresh_access_token_classified_at(&server.uri(), "refresh-secret")
            .await
            .expect_err("the mocked Cognito refusal must be returned");
        let diagnostic = error.to_string();
        assert!(diagnostic.contains("status=400"));
        assert!(diagnostic.contains("NotAuthorizedException"));
        assert!(!diagnostic.contains("alice@example.com"));
        assert!(!diagnostic.contains("12345678-1234-1234-1234-123456789012"));
        assert!(!diagnostic.contains("eyJhbGci"));
        assert!(!diagnostic.contains("refresh-secret"));
        assert!(!diagnostic.contains("secret-value"));
        assert!(!diagnostic.contains("quoted-secret"));
    }

    #[test]
    fn stale_lock_reclaimer_leaves_a_replacement_owner_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("cognito-tokens.json.lock");
        let observed_path = dir.path().join("observed-stale-lock");
        let stale_owner = u32::MAX - 1;
        assert!(!lock_owner_is_alive(stale_owner));
        std::fs::write(&lock_path, stale_owner.to_string()).unwrap();
        let observed_identity = lock_file_identity(&lock_path).unwrap();
        std::fs::hard_link(&lock_path, &observed_path).unwrap();

        std::fs::remove_file(&lock_path).unwrap();
        std::fs::write(&lock_path, std::process::id().to_string()).unwrap();

        assert!(!remove_stale_lock_if_unchanged(
            &lock_path,
            Some(stale_owner),
            &observed_identity,
        ));
        assert_eq!(lock_owner_pid(&lock_path), Some(std::process::id()));
    }

    #[test]
    fn token_lock_candidate_preserves_non_utf8_parent_and_uses_restart_nonce() {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::{OsStrExt, OsStringExt};
            let parent = PathBuf::from(std::ffi::OsString::from_vec(vec![b'd', b'-', 0xff]));
            let lock_path = parent.join("cognito-tokens.json.lock");
            let first = token_lock_candidate_path(&lock_path, 123, "nonce-a", 0);
            let second = token_lock_candidate_path(&lock_path, 123, "nonce-b", 0);
            assert_eq!(first.parent(), Some(parent.as_path()));
            assert_ne!(first, second);
            assert!(first.as_os_str().as_bytes().contains(&0xff));
        }
    }

    #[test]
    fn stale_lock_reclamation_failure_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let tokens_path = dir.path().join("cognito-tokens.json");
        std::fs::create_dir(token_file_lock_path(&tokens_path)).unwrap();
        let started = std::time::Instant::now();
        let result = lock_token_file_with_timeout(
            &tokens_path,
            std::time::Duration::from_millis(100),
        );
        assert!(result.is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn refresh_rejection_marker_accepts_legacy_and_code_formats() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        let access = "marker-access";
        let marker = invalidation_path_for_token(&path, access);
        record_rejected_refresh_at(&path, access, Some("NotAuthorizedException")).unwrap();
        assert_eq!(std::fs::read(&marker).unwrap(), b"refresh-rejected:NotAuthorizedException");
        assert!(refresh_rejection_recorded_at(&path, access).unwrap());
        std::fs::write(&marker, b"refresh-rejected").unwrap();
        assert!(refresh_rejection_recorded_at(&path, access).unwrap());
    }

    #[test]
    fn test_token_invalidation_is_generation_specific() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        let newer = CognitoTokens {
            access_token: "new-access".to_string(),
            id_token: Some("new-id".to_string()),
            refresh_token: "new-refresh".to_string(),
            expires_at: 999,
        };
        std::fs::write(&path, serde_json::to_string(&newer).unwrap()).unwrap();

        invalidate_token_at(&path, "old-access").unwrap();

        assert_eq!(
            read_tokens_from_path(&path)
                .unwrap()
                .expect("newer token must remain usable")
                .access_token,
            "new-access"
        );
    }

    #[test]
    fn test_matching_invalidation_marker_hides_stored_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        let tokens = CognitoTokens {
            access_token: "rejected-access".to_string(),
            id_token: Some("id".to_string()),
            refresh_token: "refresh".to_string(),
            expires_at: 999,
        };
        std::fs::write(&path, serde_json::to_string(&tokens).unwrap()).unwrap();

        invalidate_token_at(&path, &tokens.access_token).unwrap();

        assert!(read_tokens_from_path(&path).unwrap().is_none());
        assert!(has_non_empty_token_at(&path).unwrap());

        std::fs::write(
            invalidation_path_for_token(&path, &tokens.access_token),
            b"refresh-rejected",
        )
        .unwrap();
        write_tokens_to_path(&path, &tokens).unwrap();
        assert!(!invalidation_path_for_token(&path, &tokens.access_token).exists());
    }

    #[tokio::test]
    async fn resolve_tokens_refreshes_matching_invalidated_generation_before_sign_in() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let home = tempfile::tempdir().expect("temporary token home");
        let _test_home = TestHome::set(home.path());
        let mut cached_tokens = token_generation("marked");
        cached_tokens.expires_at = i64::MAX;
        set_tokens(&cached_tokens)
            .await
            .expect("store refreshable tokens");
        let tokens_path = home.path().join(".hq/cognito-tokens.json");
        invalidate_token_at(&tokens_path, &cached_tokens.access_token).unwrap();

        let cognito = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "AuthenticationResult": {
                    "AccessToken": "recovered-access",
                    "ExpiresIn": 3600
                }
            })))
            .expect(1)
            .mount(&cognito)
            .await;

        let result = resolve_tokens_classified(false, &cognito.uri()).await;
        assert!(
            result.is_ok(),
            "a matching access-token marker must try the still-available refresh token"
        );
        let resolved = result.unwrap();
        assert_eq!(resolved.access_token, "recovered-access");
        assert_eq!(get_tokens().await.unwrap(), Some(resolved));
        cognito.verify().await;
    }

    #[tokio::test]
    async fn resolve_tokens_keeps_rejected_refresh_on_sign_in_after_marker() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let home = tempfile::tempdir().expect("temporary token home");
        let _test_home = TestHome::set(home.path());
        let mut cached_tokens = token_generation("rejected");
        cached_tokens.expires_at = i64::MAX;
        set_tokens(&cached_tokens)
            .await
            .expect("store tokens for rejected refresh");
        let tokens_path = home.path().join(".hq/cognito-tokens.json");
        invalidate_token_at(&tokens_path, &cached_tokens.access_token).unwrap();

        let cognito = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "__type": "NotAuthorizedException",
                "message": "Invalid Refresh Token"
            })))
            .expect(1)
            .mount(&cognito)
            .await;

        let failure = resolve_tokens_classified(false, &cognito.uri())
            .await
            .expect_err("rejected refresh must remain a sign-in condition");
        assert!(failure.requires_reauth);

        let repeated_failure = resolve_tokens_classified(false, &cognito.uri())
            .await
            .expect_err("the rejected token generation must stay signed out");
        assert!(repeated_failure.requires_reauth);
        assert!(get_tokens().await.unwrap().is_none());
        cognito.verify().await;
    }

    #[test]
    fn test_format_unix_ms_as_iso() {
        // 2024-01-15T12:30:45.123Z
        let iso = format_unix_ms_as_iso(1705321845123);
        assert_eq!(iso, "2024-01-15T12:30:45.123Z");
    }

    #[test]
    fn test_format_unix_ms_as_iso_epoch() {
        let iso = format_unix_ms_as_iso(0);
        assert_eq!(iso, "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn test_expires_at_iso() {
        let tokens = CognitoTokens {
            access_token: "test".to_string(),
            id_token: None,
            refresh_token: "test".to_string(),
            expires_at: 1705321845123,
        };
        let iso = expires_at_iso(&tokens);
        assert_eq!(iso, "2024-01-15T12:30:45.123Z");
    }

    #[test]
    fn test_cognito_tokens_serialize_deserialize() {
        let tokens = CognitoTokens {
            access_token: "acc".to_string(),
            id_token: Some("id".to_string()),
            refresh_token: "ref".to_string(),
            expires_at: 1705321845123,
        };
        let json = serde_json::to_string(&tokens).unwrap();
        let parsed: CognitoTokens = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.access_token, "acc");
        assert_eq!(parsed.refresh_token, "ref");
        assert_eq!(parsed.expires_at, 1705321845123);
        assert_eq!(parsed.id_token, Some("id".to_string()));
    }

    #[test]
    fn test_cognito_tokens_deserialize_without_id_token() {
        let json = r#"{"accessToken":"acc","refreshToken":"ref","expiresAt":123}"#;
        let tokens: CognitoTokens = serde_json::from_str(json).unwrap();
        assert_eq!(tokens.access_token, "acc");
        assert_eq!(tokens.id_token, None);
    }

    #[test]
    fn test_write_and_read_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        let tokens = CognitoTokens {
            access_token: "a".to_string(),
            id_token: Some("i".to_string()),
            refresh_token: "r".to_string(),
            expires_at: 999,
        };
        let contents = serde_json::to_string_pretty(&tokens).unwrap();
        std::fs::write(&path, &contents).unwrap();

        let read_back: CognitoTokens =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(read_back.access_token, "a");
        assert_eq!(read_back.expires_at, 999);
    }

    #[test]
    fn test_auth_state_serialization() {
        let state = AuthState {
            authenticated: true,
            expires_at: Some("2024-01-15T12:30:45.123Z".to_string()),
            account_id: Some("sub-a".to_string()),
            email: Some("a@b.c".to_string()),
            display_name: Some("Ada".to_string()),
            startup_token_read_result: Some("ok_none".to_string()),
        };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("\"authenticated\":true"));
        assert!(json.contains("\"expiresAt\""));
        assert!(json.contains("\"accountId\":\"sub-a\""));
        assert!(json.contains("\"email\":\"a@b.c\""));
        assert!(json.contains("\"displayName\":\"Ada\""));
        assert!(json.contains("\"startupTokenReadResult\":\"ok_none\""));
    }

    #[test]
    fn test_auth_state_unauthenticated() {
        let state = AuthState {
            authenticated: false,
            expires_at: None,
            account_id: None,
            email: None,
            display_name: None,
            startup_token_read_result: None,
        };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("\"authenticated\":false"));
        assert!(json.contains("\"expiresAt\":null"));
        assert!(json.contains("\"accountId\":null"));
    }

    #[test]
    fn test_deserialize_expires_at_as_number() {
        let json = r#"{"accessToken":"a","refreshToken":"r","expiresAt":1705321845123}"#;
        let tokens: CognitoTokens = serde_json::from_str(json).unwrap();
        assert_eq!(tokens.expires_at, 1705321845123);
    }

    #[test]
    fn test_deserialize_expires_at_as_iso_string() {
        let json =
            r#"{"accessToken":"a","refreshToken":"r","expiresAt":"2024-01-15T12:30:45.123Z"}"#;
        let tokens: CognitoTokens = serde_json::from_str(json).unwrap();
        assert_eq!(tokens.expires_at, 1705321845123);
    }

    #[test]
    fn test_deserialize_expires_at_invalid_string_fails() {
        let json = r#"{"accessToken":"a","refreshToken":"r","expiresAt":"not-a-date"}"#;
        let result: Result<CognitoTokens, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn test_serialize_expires_at_always_number() {
        let tokens = CognitoTokens {
            access_token: "a".to_string(),
            id_token: None,
            refresh_token: "r".to_string(),
            expires_at: 1705321845123,
        };
        let json = serde_json::to_string(&tokens).unwrap();
        assert!(json.contains("\"expiresAt\":1705321845123"));
    }

    #[test]
    fn test_has_non_empty_token_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        assert!(!has_non_empty_token_at(&path).unwrap());
    }

    #[test]
    fn test_remove_token_file_deletes_existing() {
        // Sign-out must actually delete the token file — a frontend-only flag
        // left it on disk and the app re-authenticated on next launch.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        let tokens = CognitoTokens {
            access_token: "abc123".to_string(),
            id_token: Some("id".to_string()),
            refresh_token: "r".to_string(),
            expires_at: 1,
        };
        std::fs::write(&path, serde_json::to_string(&tokens).unwrap()).unwrap();
        invalidate_token_at(&path, &tokens.access_token).unwrap();
        let marker = invalidation_path_for_token(&path, &tokens.access_token);
        std::fs::write(&marker, b"refresh-rejected").unwrap();
        assert!(marker.exists());
        assert!(has_non_empty_token_at(&path).unwrap());

        remove_token_file_at(&path).unwrap();
        assert!(!path.exists());
        assert!(!marker.exists());
        // And the onboarding "is logged in" signal flips to false post-removal.
        assert!(!has_non_empty_token_at(&path).unwrap());
    }

    #[test]
    fn test_remove_token_file_missing_is_ok() {
        // Idempotent: deleting an already-absent token file is success, not an
        // error (signing out twice, or when never signed in, must not throw).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        assert!(!path.exists());
        remove_token_file_at(&path).unwrap();
        remove_token_file_at(&path).unwrap();
    }

    #[test]
    fn test_has_non_empty_token_with_real_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        let tokens = CognitoTokens {
            access_token: "abc123".to_string(),
            id_token: Some("id".to_string()),
            refresh_token: "r".to_string(),
            expires_at: 1,
        };
        std::fs::write(&path, serde_json::to_string(&tokens).unwrap()).unwrap();
        assert!(has_non_empty_token_at(&path).unwrap());
    }

    #[test]
    fn test_has_non_empty_token_empty_access_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        let json = r#"{"accessToken":"","refreshToken":"r","expiresAt":1}"#;
        std::fs::write(&path, json).unwrap();
        assert!(!has_non_empty_token_at(&path).unwrap());
    }

    #[test]
    fn test_has_non_empty_token_malformed_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        std::fs::write(&path, "{not valid json").unwrap();
        // Malformed content → treat as not-logged-in rather than bubbling an error.
        assert!(!has_non_empty_token_at(&path).unwrap());
    }

    #[test]
    fn test_has_non_empty_token_with_expired_token_still_true() {
        // Freshness is not validated here — an expired but non-empty token
        // still counts as "logged in" for the onboarding skip signal.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        let tokens = CognitoTokens {
            access_token: "still-here".to_string(),
            id_token: None,
            refresh_token: "r".to_string(),
            expires_at: 1, // ancient
        };
        std::fs::write(&path, serde_json::to_string(&tokens).unwrap()).unwrap();
        assert!(has_non_empty_token_at(&path).unwrap());
    }

    #[test]
    fn test_atomic_write_no_leftover_tmp() {
        let dir = tempfile::tempdir().unwrap();
        let hq_dir = dir.path().join(".hq");
        std::fs::create_dir_all(&hq_dir).unwrap();

        let path = hq_dir.join("cognito-tokens.json");
        let tokens = CognitoTokens {
            access_token: "a".to_string(),
            id_token: Some("i".to_string()),
            refresh_token: "r".to_string(),
            expires_at: 999,
        };
        let contents = serde_json::to_string_pretty(&tokens).unwrap();

        let tmp_path =
            path.with_file_name(format!(".cognito-tokens.json.tmp.{}", std::process::id()));
        std::fs::write(&tmp_path, &contents).unwrap();
        std::fs::rename(&tmp_path, &path).unwrap();

        assert!(path.exists());
        assert!(!tmp_path.exists());

        let read_back: CognitoTokens =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(read_back.access_token, "a");
        assert_eq!(read_back.expires_at, 999);
    }

    #[test]
    fn test_refresh_persistence_replaces_matching_generation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        let started_from = token_generation("expired");
        let refreshed = token_generation("refreshed");
        write_tokens_to_path(&path, &started_from).unwrap();

        let outcome =
            persist_refreshed_tokens_if_current_at(&path, &started_from, &refreshed).unwrap();

        assert!(matches!(
            outcome,
            RefreshPersistenceOutcome::Persisted(ref tokens)
                if tokens.access_token == refreshed.access_token
        ));
        assert_eq!(
            read_tokens_from_path(&path)
                .unwrap()
                .expect("refreshed tokens should be stored")
                .access_token,
            refreshed.access_token
        );
    }

    #[test]
    fn test_refresh_persistence_preserves_newer_login() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        let started_from = token_generation("expired");
        let refreshed = token_generation("stale-refresh");
        let newer_login = token_generation("new-login");
        write_tokens_to_path(&path, &newer_login).unwrap();

        let outcome =
            persist_refreshed_tokens_if_current_at(&path, &started_from, &refreshed).unwrap();

        assert!(matches!(
            outcome,
            RefreshPersistenceOutcome::Superseded(Some(ref tokens))
                if tokens.access_token == newer_login.access_token
        ));
        assert_eq!(
            read_tokens_from_path(&path)
                .unwrap()
                .expect("newer login must remain stored")
                .access_token,
            newer_login.access_token
        );
    }

    #[test]
    fn test_refresh_persistence_does_not_recreate_signed_out_session() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        let started_from = token_generation("expired");
        let refreshed = token_generation("late-refresh");

        let outcome =
            persist_refreshed_tokens_if_current_at(&path, &started_from, &refreshed).unwrap();

        assert!(matches!(
            outcome,
            RefreshPersistenceOutcome::Superseded(None)
        ));
        assert!(!path.exists(), "late refresh must not undo sign-out");
    }

    #[test]
    fn test_refresh_persistence_does_not_revive_invalidated_generation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        let started_from = token_generation("rejected");
        let refreshed = token_generation("late-refresh");
        write_tokens_to_path(&path, &started_from).unwrap();
        invalidate_token_at(&path, &started_from.access_token).unwrap();

        let outcome =
            persist_refreshed_tokens_if_current_at(&path, &started_from, &refreshed).unwrap();

        assert!(matches!(
            outcome,
            RefreshPersistenceOutcome::Superseded(None)
        ));
        assert!(
            read_tokens_from_path(&path).unwrap().is_none(),
            "invalidated generation must stay unusable"
        );
    }

    #[test]
    fn rust_token_lock_blocks_node_pid_lock_until_release() {
        use std::process::{Command, Stdio};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        let lock = lock_token_file_at(&path).unwrap();
        let script = r#"
const fs=require('fs'), path=process.argv[1], candidate=path+'.candidate.'+process.pid;
fs.writeFileSync(candidate,String(process.pid),{flag:'wx',mode:0o600});
const end=Date.now()+1500; let held=false;
try { while(Date.now()<end) { try { fs.linkSync(candidate,path); held=true; break; } catch(e) { if(e.code!=='EEXIST') throw e; let pid=null; try { pid=Number(fs.readFileSync(path,'utf8').trim()); } catch {} let alive=false; if(Number.isInteger(pid)&&pid>0) { try { process.kill(pid,0); alive=true; } catch(e) { alive=e.code==='EPERM'; } } if(!alive) { try { fs.unlinkSync(path); } catch {} } else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); } } console.log(held?'acquired':'timeout'); } finally { if(held) { try { if(fs.readFileSync(path,'utf8').trim()===String(process.pid)) fs.unlinkSync(path); } catch {} } try { fs.unlinkSync(candidate); } catch {} }
"#;
        let mut child = Command::new("node")
            .arg("-e")
            .arg(script)
            .arg(token_file_lock_path(&path))
            .stdout(Stdio::piped())
            .spawn()
            .expect("node is installed for the desktop app toolchain");
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(child.try_wait().unwrap().is_none(), "Node acquired the shared lock while Rust held it");
        drop(lock);
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "acquired");
    }

    #[test]
    fn test_refresh_persistence_compares_after_cross_process_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cognito-tokens.json");
        let started_from = token_generation("expired");
        let refreshed = token_generation("stale-refresh");
        let newer_login = token_generation("new-login");
        write_tokens_to_path(&path, &started_from).unwrap();

        let lock = lock_token_file_at(&path).unwrap();
        let worker_path = path.clone();
        let worker_started_from = started_from.clone();
        let worker_refreshed = refreshed.clone();
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            let outcome = persist_refreshed_tokens_if_current_at(
                &worker_path,
                &worker_started_from,
                &worker_refreshed,
            );
            send.send(outcome).unwrap();
        });

        assert!(
            receive.recv_timeout(Duration::from_millis(50)).is_err(),
            "refresh persistence must wait for the shared file lock"
        );
        write_tokens_to_path_unlocked(&path, &newer_login).unwrap();
        drop(lock);

        let outcome = receive
            .recv_timeout(Duration::from_secs(2))
            .expect("refresh persistence should finish after unlock")
            .unwrap();
        assert!(matches!(
            outcome,
            RefreshPersistenceOutcome::Superseded(Some(ref tokens))
                if tokens.access_token == newer_login.access_token
        ));
        assert_eq!(
            read_tokens_from_path(&path)
                .unwrap()
                .expect("newer login must win")
                .access_token,
            newer_login.access_token
        );
    }
}
