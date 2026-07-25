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

// hq-prod stack (canonical post-2026-04-25 cutover). MUST stay in sync with
// oauth.rs's COGNITO_CLIENT_ID — drift between the two breaks token refresh
// (sign-in succeeds against one client but refresh hits InvalidClient).
const COGNITO_CLIENT_ID: &str = "7acei2c8v870enheptb1j5foln";
const COGNITO_ENDPOINT: &str = "https://cognito-idp.us-east-1.amazonaws.com/";
/// 2-minute buffer before expiry (in milliseconds)
const EXPIRY_BUFFER_MS: i64 = 120_000;
const REFRESH_ATTEMPTS: usize = 2;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CognitoTokens {
    pub access_token: String,
    pub id_token: Option<String>,
    pub refresh_token: String,
    /// Unix epoch milliseconds. Accepts both i64 and ISO 8601 string on deserialization.
    #[serde(with = "expires_at_flexible")]
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
    pub authenticated: bool,
    pub expires_at: Option<String>,
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

fn invalidate_token_at(path: &Path, access_token: &str) -> Result<(), String> {
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

pub fn write_tokens_to_file(tokens: &CognitoTokens) -> Result<(), String> {
    let path = tokens_file_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .hq directory: {}", e))?;
    }
    let contents = serde_json::to_string_pretty(tokens)
        .map_err(|e| format!("Failed to serialize tokens: {}", e))?;

    // A successful login/refresh for this exact token generation is
    // authoritative. Remove its old rejection marker before publishing the
    // token file; a failure observed after this point will recreate it.
    remove_invalidation_marker_at(&path, &tokens.access_token)?;

    let tmp_path = path.with_file_name(format!(".cognito-tokens.json.tmp.{}", std::process::id()));
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
fn remove_token_file_at(path: &Path) -> Result<(), String> {
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

/// Get a non-expired access token, refreshing + persisting if needed.
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
/// Not race-safe across concurrent callers: two concurrent expired
/// calls may both hit Cognito's refresh endpoint with the same
/// refresh_token. Cognito tolerates this (REFRESH_TOKEN_AUTH is
/// idempotent on its side) and the token file is last-write-wins —
/// one extra Cognito round-trip in the worst case, no auth corruption.
pub async fn get_valid_access_token() -> Result<String, String> {
    let tokens = get_tokens()
        .await?
        .ok_or_else(|| "Not signed in".to_string())?;
    if !is_expired(&tokens) {
        return Ok(tokens.access_token);
    }
    let refreshed = match refresh_access_token_classified(&tokens.refresh_token).await {
        Ok(tokens) => tokens,
        Err(err) => {
            if err.requires_reauth {
                invalidate_tokens(&tokens).await?;
            }
            return Err(REAUTH_MESSAGE.to_string());
        }
    };
    set_tokens(&refreshed).await?;
    Ok(refreshed.access_token)
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
        "ClientId": COGNITO_CLIENT_ID,
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
    use tempfile;

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
        };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("\"authenticated\":true"));
        assert!(json.contains("\"expiresAt\""));
    }

    #[test]
    fn test_auth_state_unauthenticated() {
        let state = AuthState {
            authenticated: false,
            expires_at: None,
        };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("\"authenticated\":false"));
        assert!(json.contains("\"expiresAt\":null"));
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
}
