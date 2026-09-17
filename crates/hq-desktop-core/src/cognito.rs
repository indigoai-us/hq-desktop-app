use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tokio::sync::Mutex;

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
const REFRESH_ATTEMPTS: usize = 2;
const VALID_TOKEN_RESOLUTION_ATTEMPTS: usize = 3;

/// Positive, user-facing copy shared by startup and sync surfaces after the
/// one automatic refresh retry has been exhausted.
pub const REAUTH_MESSAGE: &str =
    "Your HQ session needs a quick refresh. Sign in again to keep sync moving.";

/// Structured refresh failure so callers can distinguish a stale refresh
/// token (clear it) from a temporary transport/service failure (preserve it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CognitoRefreshError {
    pub message: String,
    pub requires_reauth: bool,
    pub status_code: Option<u16>,
}

impl fmt::Display for CognitoRefreshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CognitoRefreshError {}

fn refresh_status_is_retryable(status: u16) -> bool {
    status == 401 || status == 408 || status == 429 || status >= 500
}

fn refresh_status_requires_reauth(status: u16) -> bool {
    (400..500).contains(&status) && status != 408 && status != 429
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
    if matches!(
        cognito_error_code(body).as_deref(),
        Some("TooManyRequestsException")
    ) {
        return (true, false);
    }
    (
        refresh_status_is_retryable(status),
        refresh_status_requires_reauth(status),
    )
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

struct TokenFileLock(std::fs::File);

impl Drop for TokenFileLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

fn lock_token_file_at(path: &Path) -> Result<TokenFileLock, String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create token directory: {e}"))?;
    }
    let lock_path = token_file_lock_path(path);
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(&lock_path)
        .map_err(|e| format!("Failed to open token lock {}: {e}", lock_path.display()))?;
    file.lock_exclusive()
        .map_err(|e| format!("Failed to lock token file {}: {e}", path.display()))?;
    Ok(TokenFileLock(file))
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
    // authoritative. Remove its old rejection marker before publishing the
    // token file; a failure observed after this point will recreate it.
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
) -> Result<RefreshPersistenceOutcome, String> {
    let current = read_tokens_from_path(path).map_err(|error| match error {
        TokenReadError::Io(error) => format!("Failed to read token file: {error}"),
        TokenReadError::Parse(error) => format!("Failed to parse token file: {error}"),
    })?;
    if current.as_ref() != Some(started_from) {
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
    persist_refreshed_tokens_if_current_unlocked(path, started_from, refreshed)
}

pub fn write_tokens_to_file(tokens: &CognitoTokens) -> Result<(), String> {
    let path = tokens_file_path()?;
    write_tokens_to_path(&path, tokens)
}

/// Get tokens, using in-memory cache with mtime invalidation.
pub async fn get_tokens() -> Result<Option<CognitoTokens>, String> {
    let path = tokens_file_path()?;

    // Get mtime — treat NotFound as "no file" (avoids TOCTOU with path.exists())
    let current_mtime = match std::fs::metadata(&path).and_then(|m| m.modified()) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut guard = cache().lock().await;
            *guard = None;
            return Ok(None);
        }
        Err(e) => return Err(format!("Failed to read file mtime: {}", e)),
    };
    let mut guard = cache().lock().await;

    if let Some(ref cached) = *guard {
        if cached.path == path && cached.file_mtime == current_mtime {
            if token_is_invalidated_at(&path, &cached.tokens.access_token) {
                *guard = None;
                return Ok(None);
            }
            return Ok(Some(cached.tokens.clone()));
        }
    }

    // Cache miss or mtime changed — re-read
    drop(guard);
    let tokens = read_tokens_from_file()?;
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
    Ok(tokens)
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
    let path = tokens_file_path()?;
    let mut guard = cache().lock().await;
    let _file_lock = lock_token_file_at(&path)?;
    let outcome = persist_refreshed_tokens_if_current_unlocked(&path, started_from, refreshed)?;

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
    for _ in 0..VALID_TOKEN_RESOLUTION_ATTEMPTS {
        let tokens = get_tokens()
            .await?
            .ok_or_else(|| "Not signed in".to_string())?;
        if !is_expired(&tokens) {
            return Ok(tokens);
        }

        let refreshed = match refresh_access_token_classified(&tokens.refresh_token).await {
            Ok(tokens) => tokens,
            Err(err) => {
                if err.requires_reauth {
                    invalidate_tokens(&tokens).await?;
                }
                match get_tokens().await? {
                    Some(current) if current != tokens => {
                        if !is_expired(&current) {
                            return Ok(current);
                        }
                        continue;
                    }
                    _ => return Err(REAUTH_MESSAGE.to_string()),
                }
            }
        };

        match persist_refreshed_tokens_if_current(&tokens, &refreshed)
            .await?
            .into_current_tokens()
        {
            Some(current) if !is_expired(&current) => return Ok(current),
            Some(_) => continue,
            None => return Err("Not signed in".to_string()),
        }
    }

    Err(REAUTH_MESSAGE.to_string())
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
            .post(COGNITO_ENDPOINT)
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
                };
                if attempt + 1 < REFRESH_ATTEMPTS {
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
            let (retryable, requires_reauth) = classify_refresh_failure(status, &body_text);
            let failure = CognitoRefreshError {
                message: format!("Cognito refresh failed ({status}): {body_text}"),
                requires_reauth,
                status_code: Some(status),
            };
            if retryable && attempt + 1 < REFRESH_ATTEMPTS {
                continue;
            }
            return Err(failure);
        }

        let result: InitiateAuthResponse =
            response.json().await.map_err(|err| CognitoRefreshError {
                message: format!("Failed to parse Cognito response: {err}"),
                requires_reauth: false,
                status_code: None,
            })?;

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
    use std::sync::mpsc;
    use std::time::Duration;
    use tempfile;

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
        assert_eq!(
            agent.non_human_principal(),
            Some(NonHumanPrincipal::Agent)
        );

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
        assert_eq!(
            claims.non_human_principal(),
            Some(NonHumanPrincipal::Agent)
        );
    }

    /// Canonical uids use `agt_`; the derived Cognito username uses `agt-`.
    /// Both must be caught — this is the exact pair that produced the incident.
    #[test]
    fn both_underscore_and_dash_uid_forms_are_caught() {
        for uid in ["agt_01M2JYGTFSSYG85057NWVSKTH6", "agt-01m2jygtfssyg85057nwvskth6"] {
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
        assert_eq!(
            claims.non_human_principal(),
            Some(NonHumanPrincipal::Agent)
        );
    }

    #[test]
    fn external_connection_identities_are_caught() {
        let claims = IdTokenClaims {
            email: Some("conn-7f3a@agents.getindigo.ai".into()),
            ..Default::default()
        };
        assert_eq!(
            claims.non_human_principal(),
            Some(NonHumanPrincipal::Agent)
        );
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
        };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("\"authenticated\":true"));
        assert!(json.contains("\"expiresAt\""));
        assert!(json.contains("\"accountId\":\"sub-a\""));
        assert!(json.contains("\"email\":\"a@b.c\""));
        assert!(json.contains("\"displayName\":\"Ada\""));
    }

    #[test]
    fn test_auth_state_unauthenticated() {
        let state = AuthState {
            authenticated: false,
            expires_at: None,
            account_id: None,
            email: None,
            display_name: None,
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
