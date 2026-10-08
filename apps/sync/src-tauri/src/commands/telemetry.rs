//! Telemetry collector — scan ~/.claude/projects/**/*.jsonl on each sync,
//! apply the KEEP/REMOVE allowlist, batch up to 1 MB, POST to /v1/usage.
//!
//! Dispatched from the `AllComplete` arm of `handle_sync_line` via
//! `tauri::async_runtime::spawn`. Does NOT block the sync loop.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::{Receiver, SyncSender};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use hq_desktop_core::agent_usage_scan::{
    enumerate_rollout_files, resolve_claude_projects_dirs, RolloutFile,
};
use hq_desktop_core::usage_upload_plan::{
    AddUsageEvent, UsageUploadBatch, UsageUploadPlanner, UsageUploadSource,
};

use crate::commands::sync::resolve_vault_api_url;
use crate::commands::vault_client::{
    RawTelemetryEvent, TelemetryEventsBatch, UsageBatch, VaultClient, VaultClientError,
};
use crate::util::client_info::build_client;
use crate::util::paths;

// All telemetry cycles share one persisted cursor. Serialize the read/modify/
// write interval so overlapping fire-and-forget sync tasks cannot overwrite
// newer backoff or source progress with a stale cursor snapshot.
static TELEMETRY_CURSOR_CYCLE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ── Cursor schema ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CursorEntry {
    offset: u64,
    mtime: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context: Option<CodexUsageContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TelemetryCursor {
    version: String,
    files: HashMap<String, CursorEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    codex_next_rollout: Option<String>,
    #[serde(default)]
    consecutive_unaccepted_flushes: u8,
    #[serde(default)]
    retry_after_unix_secs: u64,
}

impl Default for TelemetryCursor {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            files: HashMap::new(),
            codex_next_rollout: None,
            consecutive_unaccepted_flushes: 0,
            retry_after_unix_secs: 0,
        }
    }
}

fn telemetry_home_dir() -> Option<std::path::PathBuf> {
    #[cfg(test)]
    if let Some(home) = std::env::var_os("HQ_TEST_HOME") {
        if !home.is_empty() {
            return Some(home.into());
        }
    }
    paths::home_dir()
}

fn cursor_path() -> Option<std::path::PathBuf> {
    telemetry_home_dir().map(|h| h.join(".hq/telemetry-cursor.json"))
}

fn normalize_cursor_key_with_separator(raw: &str, separator: char) -> String {
    if separator == '\\' {
        raw.replace('/', "\\")
    } else {
        raw.to_string()
    }
}

fn normalize_cursor_file_key(path: &std::path::Path) -> String {
    let native = path
        .components()
        .collect::<std::path::PathBuf>()
        .to_string_lossy()
        .to_string();
    normalize_cursor_key_with_separator(&native, std::path::MAIN_SEPARATOR)
}

fn normalize_cursor_files(files: HashMap<String, CursorEntry>) -> HashMap<String, CursorEntry> {
    let mut normalized = HashMap::new();
    for (path, entry) in files {
        let key = normalize_cursor_file_key(std::path::Path::new(&path));
        normalized
            .entry(key)
            .and_modify(|existing: &mut CursorEntry| {
                if entry.offset > existing.offset {
                    existing.offset = entry.offset;
                    existing.context = entry.context.clone();
                } else if entry.offset == existing.offset && existing.context.is_none() {
                    existing.context = entry.context.clone();
                }
                if entry.mtime > existing.mtime {
                    existing.mtime = entry.mtime;
                }
            })
            .or_insert(entry);
    }
    normalized
}

fn load_cursor() -> TelemetryCursor {
    cursor_path()
        .and_then(|p| fs::read_to_string(&p).ok())
        .and_then(|s| serde_json::from_str::<TelemetryCursor>(&s).ok())
        .map(|mut cursor| {
            cursor.files = normalize_cursor_files(cursor.files);
            cursor
        })
        .unwrap_or_default()
}

fn save_cursor(cursor: &TelemetryCursor) -> Result<(), String> {
    use std::io::Write;
    let path = cursor_path().ok_or("home dir unavailable")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(cursor).map_err(|e| e.to_string())?;
    let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().ok();
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Sanitizer ─────────────────────────────────────────────────────────────────

/// Build an outgoing event row matching the server's KEEP allowlist
/// (hq-pro vault-service /v1/usage). Any field outside this set is rejected
/// by the server with `unexpected-event-field`, so we emit ONLY those fields.
const MAX_ID_BYTES: usize = 256;
const MAX_TIMESTAMP_BYTES: usize = 128;
const MAX_PATH_BYTES: usize = 4 * 1024;
const MAX_MODEL_BYTES: usize = 256;

fn bounded_scalar(value: Option<&Value>, max_bytes: usize) -> Option<Value> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= max_bytes)
        .map(|value| Value::String(value.to_string()))
}

fn bounded_u64(value: Option<&Value>) -> Option<Value> {
    value.and_then(Value::as_u64).map(Value::from)
}

fn sanitize_row(row: &Value) -> Option<Value> {
    let obj = row.as_object()?;
    let mut out = serde_json::Map::new();

    macro_rules! copy_string {
        ($key:expr, $limit:expr) => {
            if let Some(v) = bounded_scalar(obj.get($key), $limit) {
                out.insert($key.to_string(), v);
            }
        };
    }

    copy_string!("sessionId", MAX_ID_BYTES);
    copy_string!("timestamp", MAX_TIMESTAMP_BYTES);
    copy_string!("uuid", MAX_ID_BYTES);
    copy_string!("cwd", MAX_PATH_BYTES);
    copy_string!("gitBranch", MAX_PATH_BYTES);
    copy_string!("userType", MAX_ID_BYTES);

    // Promote message.model and flatten message.usage.* into top-level
    // camelCase fields the server expects.
    if let Some(msg) = obj.get("message").and_then(|v| v.as_object()) {
        if let Some(v) = bounded_scalar(msg.get("model"), MAX_MODEL_BYTES) {
            out.insert("model".to_string(), v);
        }
        if let Some(usage) = msg.get("usage").and_then(|v| v.as_object()) {
            if let Some(v) = bounded_u64(usage.get("input_tokens")) {
                out.insert("inputTokens".to_string(), v);
            }
            if let Some(v) = bounded_u64(usage.get("output_tokens")) {
                out.insert("outputTokens".to_string(), v);
            }
            if let Some(v) = bounded_u64(usage.get("cache_creation_input_tokens")) {
                out.insert("cacheCreationInputTokens".to_string(), v);
            }
            if let Some(v) = bounded_u64(usage.get("cache_read_input_tokens")) {
                out.insert("cacheReadInputTokens".to_string(), v);
            }
        }
    }

    Some(Value::Object(out))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// The offline-cache answer for the request's authenticated caller, or `None`.
///
/// This is deliberately NOT a bare read of `telemetryEnabled`, and it never
/// defaults a missing answer to `true`. Two properties matter, and the old
/// `unwrap_or(true)` had neither:
///
///   1. Provenance. `telemetryEnabled` alone is also a settings default —
///      `get_settings` supplies `true` when it is absent — so its mere presence
///      proves nothing. Only a record carrying `telemetryOptInAnsweredAt` (the
///      provenance marker written the moment the user actually answers) counts.
///   2. Account scope. `menubar.json` is a per-MACHINE file and sign-out does
///      NOT clear it. Without the Cognito-subject binding, account B would
///      inherit account A's cached answer on any server-read failure. The
///      binding check (via `replayable_for`) refuses an answer that belongs to a
///      different account, and refuses an unbound one.
///
/// `None` means "this account has no genuine cached answer" — the caller must
/// treat that as no-collection, never as opted-in.
fn read_local_telemetry_enabled(caller_subject: Option<&str>) -> Option<bool> {
    let path = crate::util::paths::menubar_json_path().ok()?;
    let record = hq_desktop_core::first_run::read_menubar_consent(&path);
    record.replayable_for(caller_subject?)
}

fn write_menubar_telemetry_pref_to(
    path: &Path,
    enabled: bool,
    surface: Option<&str>,
    consent_version: Option<u32>,
) -> Result<(), String> {
    // `telemetryOptInAnsweredAt` is the PROVENANCE marker. `telemetryEnabled`
    // alone cannot stand in for an answer: it is also a settings field that
    // `get_settings` defaults to `true` when absent, and the settings mutation
    // queue then persists the whole defaulted object the next time any
    // unrelated preference changes. Replaying that would manufacture consent
    // out of a default.
    //
    // This function is the single chokepoint a real answer flows through — both
    // the onboarding prompt and the settings toggle call it — so stamping here
    // means exactly "the user answered, at this moment".
    // The Cognito `sub` binds the answer to the account giving it. It is
    // available the instant the user answers, unlike the `prs_*` person entity,
    // which may not exist yet — that gap is the whole reason the repair below
    // exists.
    //
    // Writing it here also INVALIDATES any previous account's binding: if A
    // answered on this machine and B later toggles the setting, B's answer
    // overwrites the subject and the stale `prs_*` from A, so B's own answer is
    // never rejected as someone else's.
    //
    // `surface` and `consent_version` are cached alongside the answer so an
    // OFFLINE self-heal replay can restate the SAME provenance the person
    // answered with (finding #7). Without them the replay posts a version-less
    // record, which the server's own contract reads as stale — re-prompting the
    // person against the exact wording they already answered.
    let subject = current_cognito_subject();
    hq_desktop_core::first_run::merge_menubar_flags(
        path,
        &[
            ("telemetryEnabled", Value::Bool(enabled)),
            (
                "telemetryOptInAnsweredAt",
                Value::String(chrono::Utc::now().to_rfc3339()),
            ),
            (
                "telemetryOptInSub",
                subject.map(Value::String).unwrap_or(Value::Null),
            ),
            (
                "telemetryOptInSurface",
                surface
                    .map(|s| Value::String(s.to_string()))
                    .unwrap_or(Value::Null),
            ),
            (
                "telemetryConsentVersion",
                consent_version.map(Value::from).unwrap_or(Value::Null),
            ),
            // Cleared, not carried over: this record now belongs to whoever is
            // signed in, and the person uid is re-established by the repair.
            ("telemetryOptInPersonUid", Value::Null),
        ],
    )
}

/// Cognito `sub` of the signed-in account, if one can be read.
///
/// Best-effort: with no readable token the answer is stored unbound, which the
/// replay guard treats as non-replayable — the safe direction.
fn current_cognito_subject() -> Option<String> {
    hq_desktop_core::cognito::read_tokens_from_file()
        .ok()
        .flatten()
        .and_then(|t| t.id_token)
        .and_then(|tok| hq_desktop_core::cognito::decode_id_token_claims(&tok).ok())
        .and_then(|c| c.sub)
        .filter(|s| !s.is_empty())
}

/// Re-send the onboarding consent once the caller's person entity exists, and
/// record which account it belongs to.
///
/// THE RACE THIS FIXES: onboarding posts the consent immediately after
/// `oauth_exchange_code` succeeds (`OnboardingWizard.svelte`), but
/// `/v1/usage/opt-in` resolves the caller's `prs_*` person entity and 404s with
/// `no-person-entity` when none exists yet. On a fresh install that entity is
/// only created later, during personal provisioning — so the early POST
/// reliably fails, its error is only `console.error`'d, and the consent is
/// never persisted. The server then reads absence as "opted out", the telemetry
/// collector goes quiet, and the person shows as "not opted in" forever.
///
/// Measured in production before this fix: 22 of 33 active Indigo members had
/// NO `telemetryOptIn` attribute at all, against only 2 genuine opt-outs.
///
/// Runs at most once per (machine, person): once the local record names this
/// person, there is nothing left to repair and this returns immediately, so the
/// steady-state sync path pays nothing. Entirely best-effort — a failure here
/// must never disturb provisioning or sync.
///
/// FOUR guards, each closing a way this could otherwise create consent the user
/// never gave:
///   1. A recorded answer must exist (`enabled`).
///   2. It must carry provenance (`telemetryOptInAnsweredAt`) — a bare
///      `telemetryEnabled` may just be a persisted settings default.
///   3. It must be bound to EXACTLY this account. Sign-out does not clear
///      `menubar.json`, so after A signs out and B signs in it still holds A's
///      answer; replaying that would opt B in without B ever being asked. An
///      UNBOUND record is not replayable either — unbound records are produced
///      routinely, not just by older versions, so "unbound" proves nothing.
///   4. The write must be safe against the server's recorded state:
///      - server has NO answer → replay conditionally (`onlyIfUnset`);
///      - server has an OLDER answer than our local one → replay
///        UNCONDITIONALLY, because a newer offline decision (notably a
///        withdrawal) must win, never be dropped;
///      - server has a same-or-newer answer → the server is authoritative, do
///        not replay;
///      - server predates the `unset` field (and so ignores `onlyIfUnset`) → do
///        not write at all.
///      The replay carries the cached surface + consent version so an offline
///      answer is not re-read as stale against its own wording.
pub async fn reassert_consent_for_person(vault: &VaultClient, person_uid: &str) {
    let Ok(path) = crate::util::paths::menubar_json_path() else {
        return;
    };
    let record = hq_desktop_core::first_run::read_menubar_consent(&path);

    // Already repaired for this account — nothing to do.
    if record.person_uid.as_deref() == Some(person_uid) {
        return;
    }

    // Guards 1-3. Keyed on the Cognito subject the answer was bound to when it
    // was given — and read from the VAULT CLIENT'S OWN token, not from whatever
    // is on disk right now. Signing out does not cancel an in-flight sync, so
    // this code can run holding account A's token after account B has signed in
    // and answered; checking against B's on-disk record while POSTing as A
    // would apply B's choice to A.
    let Some(subject) = vault.caller_subject() else {
        return;
    };
    let Some(enabled) = record.replayable_for(&subject) else {
        return;
    };

    // Whether to replay conditionally (`onlyIfUnset`) or unconditionally.
    //
    //   - Server has NO answer (`unset: true`)  → replay conditionally. The
    //     `onlyIfUnset` guard is belt-and-braces against a concurrent write.
    //   - Server HAS an answer, but the LOCAL answer is strictly NEWER than the
    //     server's → replay UNCONDITIONALLY. This is finding #3: an offline
    //     withdrawal (a genuine, account-bound `false` recorded after the server
    //     last saw `true`) must WIN, not be dropped because "the server already
    //     has an answer". A conditional write here would no-op and the stale
    //     server value would turn the toggle back on at the next read.
    //   - Server HAS an answer at least as new as the local one → the server is
    //     authoritative; do not replay. Just bind and stop re-checking.
    //   - `unset: None` (server predates the field, and therefore also ignores
    //     `onlyIfUnset`) → do not write at all; we cannot reason about its
    //     conditional semantics.
    let resp = match vault.get_telemetry_opt_in().await {
        Ok(resp) => resp,
        Err(err) => {
            eprintln!("[telemetry] consent state unreadable, skipping re-assert: {err}");
            return;
        }
    };

    let only_if_unset = match resp.unset {
        Some(true) => true,
        Some(false) => {
            // The server holds an answer. Replay ONLY when our local answer is a
            // genuinely newer decision that never reached the server — a
            // withdrawal must never be lost or reversed.
            if !local_answer_is_newer(record.answered_at.as_deref(), resp.updated_at.as_deref()) {
                // Server is authoritative (same-or-newer). Bind so this stops
                // re-checking, only when the server names the same person.
                if resp.person_uid.as_deref() == Some(person_uid) {
                    let _ = hq_desktop_core::first_run::merge_menubar_flags(
                        &path,
                        &[(
                            "telemetryOptInPersonUid",
                            Value::String(person_uid.to_string()),
                        )],
                    );
                }
                return;
            }
            // A newer local decision (e.g. an offline withdrawal). Overwrite the
            // stale server value unconditionally so it cannot be resurrected.
            false
        }
        None => {
            // Server predates the `unset`/conditional-write rollout — do not
            // write, we cannot trust its `onlyIfUnset` handling.
            return;
        }
    };

    // This is a self-heal REPLAY of a cached answer. Carry the SAME provenance
    // the person answered with (finding #7) so the server does not read the
    // replayed record as version-less/stale and re-prompt against wording the
    // person already answered.
    let surface = record.surface.as_deref();
    let consent_version = record.consent_version;
    match vault
        .post_telemetry_opt_in_opts(enabled, only_if_unset, surface, consent_version)
        .await
    {
        Ok(()) => {
            // Bind the record to this account so we do not repeat the work, and
            // so the hq-cloud sync runner can safely replay it later (it refuses
            // to replay an answer that is not bound to the signed-in account).
            let _ = hq_desktop_core::first_run::merge_menubar_flags(
                &path,
                &[(
                    "telemetryOptInPersonUid",
                    Value::String(person_uid.to_string()),
                )],
            );
        }
        Err(err) => {
            eprintln!("[telemetry] consent re-assert failed (non-fatal): {err}");
        }
    }
}

/// Whether the LOCAL answer (`local`) was recorded strictly after the server's
/// last write (`server`).
///
/// Both are RFC 3339 timestamps. A local answer that is newer is an offline
/// decision the server has not yet seen and must win over the server's stale
/// value (finding #3). Missing/unparseable inputs fail SAFE — we treat the
/// answer as NOT newer, so we never clobber a server answer we cannot prove is
/// older than ours.
fn local_answer_is_newer(local: Option<&str>, server: Option<&str>) -> bool {
    let (Some(local), Some(server)) = (local, server) else {
        return false;
    };
    let (Ok(local), Ok(server)) = (
        chrono::DateTime::parse_from_rfc3339(local),
        chrono::DateTime::parse_from_rfc3339(server),
    ) else {
        return false;
    };
    local > server
}

#[tauri::command]
pub fn write_menubar_telemetry_pref(
    enabled: bool,
    surface: Option<String>,
    consent_version: Option<u32>,
) -> Result<(), String> {
    let path = crate::util::paths::menubar_json_path()?;
    write_menubar_telemetry_pref_to(&path, enabled, surface.as_deref(), consent_version)
}

const OPT_IN_RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(3)];

async fn post_telemetry_opt_in_with_retry(
    api_url: &str,
    access_token: &str,
    enabled: bool,
    surface: Option<&str>,
    consent_version: Option<u32>,
) -> Result<(), String> {
    let vault = VaultClient::new(api_url, access_token);
    let mut last_error = None;

    for attempt in 0..3 {
        match vault
            .post_telemetry_opt_in_opts(enabled, false, surface, consent_version)
            .await
        {
            Ok(()) => return Ok(()),
            Err(err) => last_error = Some(err.to_string()),
        }

        if let Some(delay) = OPT_IN_RETRY_DELAYS.get(attempt) {
            tokio::time::sleep(*delay).await;
        }
    }

    Err(format!(
        "post telemetry opt-in failed after 3 attempts: {}",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    ))
}

/// Persist an explicit telemetry answer with its provenance.
///
/// `surface` (`onboarding`/`settings`) and `consent_version` accompany the
/// answer so the server can record which surface produced it and which wording
/// the person was shown; both are optional and forward-compatible.
#[tauri::command]
pub async fn post_telemetry_opt_in(
    enabled: bool,
    surface: Option<String>,
    consent_version: Option<u32>,
) -> Result<(), String> {
    let access_token = crate::commands::cognito::get_valid_access_token().await?;
    let api_url = resolve_vault_api_url()?;
    post_telemetry_opt_in_with_retry(
        &api_url,
        &access_token,
        enabled,
        surface.as_deref(),
        consent_version,
    )
    .await
}

async fn resolve_telemetry_enabled(vault: &VaultClient) -> bool {
    match vault.get_telemetry_opt_in().await {
        Ok(resp) => resp.enabled,
        Err(_) => {
            eprintln!("[telemetry] telemetry-opt-in-fallback-local");
            // A missing (or account-mismatched) local answer resolves to
            // NO collection. Defaulting to `true` here is exactly the
            // account-unscoped, opt-in-by-omission bug this story removes: on a
            // server-read failure it would collect for someone who never
            // answered, or inherit another account's answer.
            let caller_subject = vault.caller_subject();
            read_local_telemetry_enabled(caller_subject.as_deref()).unwrap_or(false)
        }
    }
}

/// What the Settings screen renders the telemetry toggle from.
///
/// `source` is deliberately `"server"` or `"local-cache"` rather than a boolean
/// flag: the screen must be able to say honestly WHERE the value came from. When
/// the server is reachable, `enabled` is the server-authoritative answer and the
/// provenance fields (`updated_at`, `consent_version`, `answered_by`) accompany
/// it. When the server is unreachable, `enabled` is the local cache — displayed,
/// but labelled as an offline value rather than presented as current truth.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryConsentStatus {
    /// The effective answer to render the toggle from.
    pub enabled: bool,
    /// `"server"` when the value is server-authoritative, `"local-cache"` when
    /// the server was unreachable and this is the offline fallback.
    pub source: TelemetryConsentSource,
    /// When the answer was recorded (ISO 8601). Provenance for AC5; absent on
    /// records that predate the field or on the local-cache path.
    pub updated_at: Option<String>,
    /// The consent version the person was shown when they answered. Provenance
    /// for AC5; absent when the record predates versioning.
    pub consent_version: Option<u32>,
    /// The server has a row but no recorded answer for this caller.
    pub unset: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TelemetryConsentSource {
    Server,
    LocalCache,
}

/// Read the server-authoritative telemetry consent state for the Settings
/// toggle (AC1/AC2/AC5).
///
/// The local `menubar.json` file is a cache for OFFLINE display only. It is
/// never the source of truth while the server is reachable — reading the toggle
/// from the local file was the whole defect this story fixes, because the file
/// can say "on" while the server holds a refusal (and vice versa), so the screen
/// could contradict what collection actually does.
///
/// On a server error the local cache is returned WITH `source: LocalCache`, so
/// the caller can label it honestly as an offline value rather than passing it
/// off as the current answer.
#[tauri::command]
pub async fn get_telemetry_consent_status() -> Result<TelemetryConsentStatus, String> {
    let access_token = crate::commands::cognito::get_valid_access_token().await?;
    let api_url = resolve_vault_api_url()?;
    let vault = VaultClient::new(&api_url, &access_token);
    match vault.get_telemetry_opt_in().await {
        Ok(resp) => Ok(TelemetryConsentStatus {
            enabled: resp.enabled,
            source: TelemetryConsentSource::Server,
            updated_at: resp.updated_at,
            consent_version: resp.consent_version,
            unset: resp.unset == Some(true),
        }),
        Err(err) => {
            eprintln!("[telemetry] consent-status-fallback-local: {err}");
            // The local cache is account-scoped and provenance-gated. When it
            // holds no genuine answer for THIS account, render the toggle from
            // no-collection with `unset: true` rather than fabricating an
            // opted-in default — a missing answer must never appear pre-ticked,
            // and account B must never inherit account A's cached value.
            let caller_subject = vault.caller_subject();
            let cached = read_local_telemetry_enabled(caller_subject.as_deref());
            Ok(TelemetryConsentStatus {
                enabled: cached.unwrap_or(false),
                source: TelemetryConsentSource::LocalCache,
                updated_at: None,
                consent_version: None,
                unset: cached.is_none(),
            })
        }
    }
}

// ── US-005: re-prompt a stale/administrative/pre-versioned consent record ──────

/// Keys under which the "we already re-prompted this person at this version"
/// guard is persisted in `menubar.json`. The pair is what makes the re-prompt
/// fire AT MOST ONCE per consent version per person: a bump of the version, or a
/// different signed-in person, both make the stored pair no longer match and so
/// re-open the prompt. A dismissal writes this pair WITHOUT posting any answer,
/// so dismissing is remembered but never counts as an answer.
const REPROMPT_VERSION_KEY: &str = "telemetryRepromptedConsentVersion";
const REPROMPT_PERSON_KEY: &str = "telemetryRepromptedPersonUid";

/// Whether the launch-time telemetry re-prompt should be shown, and the identity
/// it is keyed to.
///
/// `should_reprompt` is the only field the caller acts on; the rest are returned
/// so the frontend can pass the same `person_uid` back to
/// `mark_consent_reprompt_shown` without a second server round-trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentRepromptStatus {
    /// Show the blocking consent step exactly once this launch when true.
    pub should_reprompt: bool,
    /// The `prs_*` the server attributes the record to. `None` when the server
    /// did not name one (older server / no entity yet) — in which case we never
    /// re-prompt, because the guard could not be keyed to a person and would
    /// re-fire every launch.
    pub person_uid: Option<String>,
}

/// Decide, from the server response and the locally-persisted guard, whether the
/// launch-time re-prompt should be shown.
///
/// Pure so it is unit-testable without a live server or a real `menubar.json`.
///
/// The rules, matching the story's acceptance criteria and the cross-repo
/// contract:
///   - The SERVER is the authority on staleness (`stale`). We do not re-derive
///     the staleness rule on the client.
///   - A record is only re-promptable when the server both marks it `stale` AND
///     names the `person_uid` it belongs to (so the "shown once" guard can be
///     keyed to that person).
///   - It is shown at most once per (consent version, person): if the stored
///     guard already names this person at the current version, do not re-prompt.
///   - A record that is NOT stale (a current, self-given answer) is never
///     re-prompted.
fn decide_reprompt(
    resp: &crate::commands::vault_client::TelemetryOptInResponse,
    current_version: u32,
    prompted_version: Option<u32>,
    prompted_person_uid: Option<&str>,
) -> ConsentRepromptStatus {
    let person_uid = resp.person_uid.clone();

    // Not stale → the person holds a current, self-given answer. Nothing to ask.
    // The server owns this decision; `stale != Some(true)` (including a server
    // that predates the field, `None`) means "do not re-prompt".
    let stale = resp.stale == Some(true);

    // Without a person to key the guard to, a re-prompt would re-fire every
    // launch (we could never record that it was shown for THIS person). Fail
    // safe: do not re-prompt.
    let Some(ref uid) = person_uid else {
        return ConsentRepromptStatus {
            should_reprompt: false,
            person_uid,
        };
    };

    // Already shown for this exact (version, person) — dismissal or answer both
    // record it, and neither should re-open the prompt.
    let already_shown =
        prompted_version == Some(current_version) && prompted_person_uid == Some(uid.as_str());

    ConsentRepromptStatus {
        should_reprompt: stale && !already_shown,
        person_uid,
    }
}

/// Read the persisted re-prompt guard `(version, person_uid)` from `menubar.json`.
fn read_reprompt_guard(path: &Path) -> (Option<u32>, Option<String>) {
    let obj = hq_desktop_core::first_run::read_menubar_obj(path);
    let version = obj
        .get(REPROMPT_VERSION_KEY)
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok());
    let person = obj
        .get(REPROMPT_PERSON_KEY)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    (version, person)
}

/// Whether the launch-time telemetry consent re-prompt is due (US-005).
///
/// Server-authoritative and FAIL-QUIET: if the server is unreachable, or does
/// not report the record as stale, or does not name the person, this returns
/// `should_reprompt: false` and the app is never blocked. Collection is
/// unaffected — staleness means "ask again", not "stop collecting" — and the
/// caller simply tries again on the next launch.
#[tauri::command]
pub async fn consent_reprompt_status(
    consent_version: u32,
) -> Result<ConsentRepromptStatus, String> {
    let access_token = crate::commands::cognito::get_valid_access_token().await?;
    let api_url = resolve_vault_api_url()?;
    let vault = VaultClient::new(&api_url, &access_token);

    let resp = match vault.get_telemetry_opt_in().await {
        Ok(resp) => resp,
        Err(err) => {
            // Fail quiet: an unreachable/erroring server must never block the app
            // or provoke a re-prompt. Try again next launch.
            eprintln!("[telemetry] consent-reprompt-status server unreachable: {err}");
            return Ok(ConsentRepromptStatus {
                should_reprompt: false,
                person_uid: None,
            });
        }
    };

    let path = crate::util::paths::menubar_json_path()?;
    let (prompted_version, prompted_person) = read_reprompt_guard(&path);

    Ok(decide_reprompt(
        &resp,
        consent_version,
        prompted_version,
        prompted_person.as_deref(),
    ))
}

/// Record that the launch-time re-prompt has been SHOWN for this person at this
/// consent version, so it is not shown again for the same pair.
///
/// Called on dismissal (which must NOT post an answer) and — harmlessly — after
/// an answer (which already makes the record non-stale). Persisted via the same
/// untyped-merge + atomic-rename path every other menubar flag uses, so unknown
/// keys survive.
#[tauri::command]
pub fn mark_consent_reprompt_shown(consent_version: u32, person_uid: String) -> Result<(), String> {
    if person_uid.is_empty() {
        // Nothing to key the guard to — refuse rather than write a useless pair.
        return Err("mark_consent_reprompt_shown requires a person_uid".to_string());
    }
    let path = crate::util::paths::menubar_json_path()?;
    hq_desktop_core::first_run::merge_menubar_flags(
        &path,
        &[
            (REPROMPT_VERSION_KEY, Value::from(consent_version)),
            (REPROMPT_PERSON_KEY, Value::String(person_uid)),
        ],
    )
}

fn is_safe_event_name(event_name: &str) -> bool {
    !event_name.is_empty()
        && event_name.len() <= 96
        && event_name
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

fn is_safe_label_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-' | b'.'))
}

const ALLOWED_DESKTOP_PROPERTY_KEYS: &[&str] = &[
    "provider",
    "surface",
    "source",
    "result",
    "errorKind",
    "channel",
    "stage",
    "fromVersion",
    "toVersion",
    "desktopVersion",
    "appVersion",
    "localCoreVersion",
    "targetCoreVersion",
    "autoUpdateEnabled",
    "autoUpdate",
    "eligible",
    "versionBehind",
    "durationMs",
    "exitCode",
    "skipReason",
    "enabled",
    "registered",
    "companiesAttempted",
    "filesDownloaded",
    "bytesDownloaded",
    "filesSkipped",
    "errorCount",
    "stageCount",
    "failedStageCount",
    "failedStages",
    "detectedToolCount",
    "detectedSourceSet",
    "step",
    "component",
    "action",
    "flow",
    "outcome",
    "platform",
    "attemptCount",
    "failedDependency",
    "retryAttempted",
    "retryResult",
    "depsOperation",
    "errorCategory",
    "failureStage",
    "setupRunId",
    "npxResolved",
    "npxResolution",
    "errorOperation",
    "errorIoKind",
    "errorCode",
    "statusCode",
    "deferralCount",
    "firstDeferralAgeSeconds",
    "lockTimeoutSeconds",
    "holdReason",
    "requiredGitVersion",
    "detectedGitVersion",
    "found",
    "companyUidMissing",
    "invitesSent",
    // Company step route decision + provisioning + self-heal (look before create).
    "existingCompanies",
    "paidCompany",
    "pendingInvites",
    "decision",
    "provisioningStep",
    "selfHeal",
    // Funnel rows mirrored to the CDP (cdp_mirror::OPERATIONAL_MIRRORS).
    "isFirstLaunch",
    "userHash",
    "companyHash",
    "success",
    "errorClass",
    "trigger",
    "downloadedCount",
    "count",
    "route",
    "plan",
];

const DEPS_RETRY_RESULT_VALUES: &[&str] = &[
    "not-eligible",
    "recovered",
    "failed-again",
    "skipped-flag-off",
    "skipped-flag-unreadable",
];

const DEPS_OPERATION_VALUES: &[&str] = &[
    "node", "yq", "qmd", "hq-cli", "git", "jq", "gh", "claude-code", "homebrew", "unknown",
];

const SYMLINK_ERROR_OPERATION_VALUES: &[&str] = &[
    "create_junction",
    "copy_file_fallback",
    "create_symlink_parent",
    "remove_existing_link",
    "create_symlink",
];

const SYMLINK_ERROR_IO_KIND_VALUES: &[&str] = &[
    "not_found",
    "permission_denied",
    "already_exists",
    "invalid_input",
    "invalid_data",
    "timed_out",
    "unsupported",
    "interrupted",
    "would_block",
    "write_zero",
    "broken_pipe",
    "connection_refused",
    "connection_reset",
    "connection_aborted",
    "not_connected",
    "addr_in_use",
    "addr_not_available",
    "out_of_memory",
    "unexpected_eof",
    "other",
];

const FAILED_DEPENDENCY_VALUES: &[&str] = &[
    "node",
    "yq",
    "jq",
    "git",
    "qmd",
    "hq-cli",
    "path-write",
    "unknown",
];

pub(crate) const ERROR_CATEGORY_VALUES: &[&str] = &[
    "missing-dependency",
    "snapshot-unreadable",
    "snapshot-external-symlink",
    "snapshot-failed",
    "outdated-dependency",
    "auth",
    "network",
    "dns",
    "tls",
    "checksum",
    "disk-full",
    "permission",
    "not-found",
    "npx-resolve-failed",
    "timeout",
    "lock-contention",
    "snapshot-recovery-required",
    "rsync-partial-transfer",
    "directory-not-empty",
    "rsync-broken",
    "preserve-restore-failed",
    "restore-symlink-race",
    "update-deferred-hq-change",
    "clone-failed",
    "spawn-failed",
    "exit-nonzero",
    "unsupported-platform",
    "disk",
    "concurrent-install",
    "cancelled",
    "cancel-cleanup-failed",
    "unknown",
];

const NPX_RESOLUTION_VALUES: &[&str] = &[
    "managed_toolchain",
    "settings_path",
    "user_prefix",
    "system_prefix",
    "login_shell",
    "not_resolved",
    "unknown",
];

const CONNECTOR_IMPORT_OUTCOME_VALUES: &[&str] = &[
    "tool_not_installed",
    "config_path_unavailable",
    "config_missing",
    "config_unreadable",
    "config_invalid",
    "zero_servers",
    "imported",
    "import_failed",
    "command_failed",
    "user_skipped",
    "unknown",
];

const CONNECTOR_IMPORT_SOURCE_SET_VALUES: &[&str] = &["claude_desktop_config", "unknown"];

// Keep all nine identifiers for historical rows; packages, import, and menubar
// are no longer emitted by setup, but readers must still normalize them.
const ONBOARDING_STAGE_IDS: &[&str] = &[
    "content",
    "deps",
    "initial-sync",
    "packages",
    "git-init",
    "personalize",
    "import",
    "indexing",
    "menubar",
];

const MAX_FAILED_STAGES: usize = ONBOARDING_STAGE_IDS.len();

fn allowed_desktop_property_key(key: &str) -> bool {
    ALLOWED_DESKTOP_PROPERTY_KEYS.contains(&key)
}

fn normalize_closed_label(value: &str, vocabulary: &[&str]) -> String {
    if vocabulary.contains(&value) {
        value.to_string()
    } else {
        "unknown".to_string()
    }
}

fn normalize_failed_stages(values: &[Value]) -> Vec<Value> {
    let mut stages = Vec::new();
    for value in values {
        let Some(stage) = value.as_str() else {
            continue;
        };
        if ONBOARDING_STAGE_IDS.contains(&stage)
            && !stages
                .iter()
                .any(|value: &Value| value.as_str() == Some(stage))
        {
            stages.push(Value::String(stage.to_string()));
        }
        if stages.len() == MAX_FAILED_STAGES {
            break;
        }
    }
    stages
}

fn sanitize_desktop_properties(properties: Option<Value>) -> Value {
    let Some(Value::Object(input)) = properties else {
        return Value::Object(Map::new());
    };

    let connector_import = input.get("step").and_then(Value::as_str) == Some("connector-import");
    let deps_setup_failure = input.get("step").and_then(Value::as_str) == Some("setup")
        && input.get("action").and_then(Value::as_str) == Some("failed")
        && input.get("component").and_then(Value::as_str) == Some("deps");
    let mut out = Map::new();

    for (key, value) in input {
        if !allowed_desktop_property_key(&key) {
            continue;
        }

        let sanitized_value =
            match (key.as_str(), &value) {
                ("failedDependency", Value::String(value)) => Some(Value::String(
                    normalize_closed_label(&value, FAILED_DEPENDENCY_VALUES),
                )),
                ("retryAttempted", Value::Bool(_)) if deps_setup_failure => Some(value),
                ("retryResult", Value::String(value)) if deps_setup_failure => DEPS_RETRY_RESULT_VALUES
                    .contains(&value.as_str())
                    .then_some(Value::String(value.clone())),
                ("depsOperation", Value::String(value)) if deps_setup_failure => DEPS_OPERATION_VALUES
                    .contains(&value.as_str())
                    .then_some(Value::String(value.clone())),
                ("retryAttempted", _) | ("retryResult", _) | ("depsOperation", _) => None,
                ("errorCategory", Value::String(value)) => Some(Value::String(
                    normalize_closed_label(&value, ERROR_CATEGORY_VALUES),
                )),
                ("failureStage", Value::String(value)) => Some(Value::String(
                    normalize_closed_label(&value, ONBOARDING_STAGE_IDS),
                )),
                ("npxResolution", Value::String(value)) => Some(Value::String(
                    normalize_closed_label(&value, NPX_RESOLUTION_VALUES),
                )),
                ("errorOperation", Value::String(value))
                    if SYMLINK_ERROR_OPERATION_VALUES.contains(&value.as_str()) =>
                {
                    Some(Value::String(value.clone()))
                }
                ("errorIoKind", Value::String(value))
                    if SYMLINK_ERROR_IO_KIND_VALUES.contains(&value.as_str()) =>
                {
                    Some(Value::String(value.clone()))
                }
                ("errorCode", Value::Number(number)) => number
                    .as_u64()
                    .filter(|code| *code <= 65_535)
                    .map(|_| Value::Number(number.clone())),
                ("statusCode", Value::Number(number)) => number
                    .as_u64()
                    .filter(|status| (100..=599).contains(status))
                    .map(|_| Value::Number(number.clone())),
                ("statusCode", _) => None,
                ("detectedSourceSet", Value::String(value)) => Some(Value::String(
                    normalize_closed_label(&value, CONNECTOR_IMPORT_SOURCE_SET_VALUES),
                )),
                ("outcome", Value::String(value)) if connector_import => Some(Value::String(
                    normalize_closed_label(&value, CONNECTOR_IMPORT_OUTCOME_VALUES),
                )),
                ("failedStages", Value::Array(values)) => {
                    Some(Value::Array(normalize_failed_stages(&values)))
                }
                (_, Value::Bool(_)) => matches!(
                    key.as_str(),
                    "enabled"
                        | "autoUpdateEnabled"
                        | "autoUpdate"
                        | "eligible"
                        | "registered"
                        | "versionBehind"
                        | "npxResolved"
                        | "found"
                        | "paidCompany"
                        | "success"
                        | "isFirstLaunch"
                        | "companyUidMissing"
                )
                .then_some(value),
                ("invitesSent", Value::Number(number)) => number
                    .as_u64()
                    .filter(|count| *count <= 20)
                    .map(|_| Value::Number(number.clone())),
                (_, Value::Number(n)) => {
                    (n.as_i64().is_some() || n.as_u64().is_some()).then_some(value)
                }
                (_, Value::String(s)) => is_safe_label_value(s).then_some(value),
                _ => None,
            };
        if let Some(value) = sanitized_value {
            out.insert(key, value);
        }
    }

    Value::Object(out)
}

/// Onboarding rows that may name their company: company and invite-teammate
/// steps, plus the missing-bucket self-heal (any step).
fn properties_company_scoped(input: Option<&Map<String, Value>>) -> bool {
    let Some(input) = input else {
        return false;
    };
    matches!(
        input.get("step").and_then(Value::as_str),
        Some("company" | "invite-teammate")
    )
        || input.get("selfHeal").and_then(Value::as_str).is_some()
}

const POST_READY_ACTION_VALUES: &[&str] = &[
    "open_folder",
    "start_sync",
    "open_cli",
    "invite",
    "ready_first_action_shown",
    "ready_first_action_clicked",
    "close_window",
];

const POST_READY_ACTION_DROP_REASON_VALUES: &[&str] = &[
    "not_ready",
    "already_sent",
    "session_ended",
    "flag_off",
    "flag_error",
    "identity_error",
    "identity_missing",
];

fn sanitize_post_ready_action_properties(properties: Option<Value>) -> Value {
    let Some(Value::Object(input)) = properties else {
        return Value::Object(Map::new());
    };
    let mut out = Map::new();
    for (key, prefix) in [
        ("personUid", "prs_"),
        ("companyUid", "cmp_"),
        ("idempotencyKey", "post-ready."),
    ] {
        let Some(value) = input.get(key).and_then(Value::as_str) else {
            continue;
        };
        if value.starts_with(prefix) && is_safe_label_value(value) {
            out.insert(key.to_string(), Value::String(value.to_string()));
        }
    }
    if let Some(action) = input
        .get("action")
        .and_then(Value::as_str)
        .filter(|action| POST_READY_ACTION_VALUES.contains(action))
    {
        out.insert("action".to_string(), Value::String(action.to_string()));
    }
    if let Some(return_nudge) = input
        .get("returnNudge")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "shown" | "clicked" | "dismissed"))
    {
        out.insert("returnNudge".to_string(), Value::String(return_nudge.to_string()));
    }
    Value::Object(out)
}

fn sanitize_post_ready_action_dropped_properties(properties: Option<Value>) -> Value {
    let Some(Value::Object(input)) = properties else {
        return Value::Object(Map::new());
    };
    let mut out = Map::new();
    if let Some(reason) = input
        .get("reason")
        .and_then(Value::as_str)
        .filter(|reason| POST_READY_ACTION_DROP_REASON_VALUES.contains(reason))
    {
        out.insert("reason".to_string(), Value::String(reason.to_string()));
    }
    if let Some(action) = input
        .get("action")
        .and_then(Value::as_str)
        .filter(|action| POST_READY_ACTION_VALUES.contains(action))
    {
        out.insert("action".to_string(), Value::String(action.to_string()));
    }
    Value::Object(out)
}

/// Tag every hq-pro desktop row with the website visitor id the CDP mirror
/// uses, so the web→desktop funnel joins on one id. Only a safe label is
/// attached; a caller-supplied `anonId` is never trusted.
fn attach_anon_id(properties: &mut Value, anon_id: Option<String>) {
    let Some(object) = properties.as_object_mut() else {
        return;
    };
    object.remove("anonId");
    if let Some(anon) = anon_id.filter(|id| is_safe_label_value(id)) {
        object.insert("anonId".to_string(), Value::String(anon));
    }
}

fn build_desktop_telemetry_event(
    event_name: String,
    properties: Option<Value>,
    session_id: Option<String>,
    occurred_at: Option<String>,
    consent_basis: &str,
) -> RawTelemetryEvent {
    let is_content_setup_failure = event_name == "desktop_onboarding_step"
        && properties
            .as_ref()
            .and_then(Value::as_object)
            .map(|input| {
                input.get("step").and_then(Value::as_str) == Some("setup")
                    && input.get("action").and_then(Value::as_str) == Some("failed")
                    && input.get("component").and_then(Value::as_str) == Some("content")
            })
            .unwrap_or(false);
    let is_post_ready_action = event_name == "desktop_post_ready_action";
    let is_post_ready_action_dropped = event_name == "desktop_post_ready_action_dropped";
    let is_desktop_quit = event_name == "desktop_app_quit";
    let raw_company_scope = properties.as_ref().and_then(Value::as_object).cloned();
    let mut properties = if is_post_ready_action {
        sanitize_post_ready_action_properties(properties)
    } else if is_post_ready_action_dropped {
        sanitize_post_ready_action_dropped_properties(properties)
    } else if is_desktop_quit {
        sanitize_desktop_quit_properties(properties)
    } else {
        sanitize_desktop_properties(properties)
    };
    // The company step (route decision, provisioning, join) and the first-sync
    // self-heal carry the company they are about; hq-pro takes it as the
    // event-level `companyUid` (and checks the caller is a member).
    let company_scoped_onboarding_row = event_name == "desktop_onboarding_step"
        && properties_company_scoped(raw_company_scope.as_ref());
    let company_uid = if is_post_ready_action {
        properties
            .get("companyUid")
            .and_then(Value::as_str)
            .filter(|value| value.starts_with("cmp_") && value.len() <= 128)
            .map(str::to_string)
    } else if company_scoped_onboarding_row
        || (event_name == crate::commands::cdp_mirror::OP_SYNC_COMPLETED
            && raw_company_scope
                .as_ref()
                .and_then(|input| input.get("trigger"))
                .and_then(Value::as_str)
                == Some("first"))
    {
        raw_company_scope
            .as_ref()
            .and_then(|input| input.get("companyUid"))
            .and_then(Value::as_str)
            .filter(|value| {
                value.starts_with("cmp_") && value.len() <= 128 && is_safe_label_value(value)
            })
            .map(str::to_string)
    } else {
        None
    };
    let idempotency_key = if is_post_ready_action {
        properties
            .get("idempotencyKey")
            .and_then(Value::as_str)
            .filter(|value| is_safe_label_value(value))
            .map(str::to_string)
    } else if event_name == crate::commands::cdp_mirror::OP_APP_OPENED
        && properties["isFirstLaunch"].as_bool() == Some(true)
    {
        crate::commands::first_run::install_attempt_id()
            .filter(|id| is_safe_label_value(id))
            .map(|id| crate::commands::cdp_mirror::first_open_idempotency_key(&id))
    } else {
        None
    };
    if is_post_ready_action {
        if let Some(properties) = properties.as_object_mut() {
            properties.remove("idempotencyKey");
        }
    }
    if !is_content_setup_failure {
        if let Some(properties) = properties.as_object_mut() {
            properties.remove("errorOperation");
            properties.remove("errorIoKind");
            properties.remove("errorCode");
        }
    }
    if event_name == "desktop_onboarding_step"
        && properties["step"].as_str() == Some("connector-import")
        && properties.get("outcome").is_some()
    {
        let outcome = properties["outcome"].as_str().unwrap_or_default();
        properties["outcome"] = Value::String(normalize_closed_label(
            outcome,
            CONNECTOR_IMPORT_OUTCOME_VALUES,
        ));
    }
    if matches!(
        event_name.as_str(),
        "desktop_onboarding_step"
            | "desktop_setup_completed"
            | "desktop_post_ready_action"
            | "desktop_post_ready_action_dropped"
            | "desktop_update_outcome"
            | "desktop_autostart_state"
    ) || crate::commands::cdp_mirror::is_funnel_operational_row(&event_name)
    {
        properties["appVersion"] = Value::String(crate::app_version::current().to_string());
    }
    if is_post_ready_action || is_post_ready_action_dropped {
        properties["os"] = Value::String(std::env::consts::OS.to_string());
    }
    attach_anon_id(
        &mut properties,
        crate::commands::cdp_mirror::current_anon_id(),
    );
    let schema_version = if event_name == "desktop_update_outcome" { 2 } else { 1 };
    let install_attempt_id = matches!(
        event_name.as_str(),
        "desktop_setup_completed"
            | "desktop_onboarding_step"
            | "desktop_update_outcome"
            | "desktop_autostart_state"
            | "desktop_auth_progress"
    )
    .then(crate::commands::first_run::install_attempt_id)
    .flatten();
    RawTelemetryEvent {
        event_name,
        app: "hq-desktop-app".to_string(),
        source: "desktop".to_string(),
        occurred_at: occurred_at
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
            .map(|value| {
                value
                    .with_timezone(&chrono::Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
            .unwrap_or_else(|| {
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            }),
        consent_basis: consent_basis.to_string(),
        schema_version,
        idempotency_key,
        session_id: session_id.filter(|value| is_safe_label_value(value)),
        company_uid,
        install_attempt_id,
        properties,
    }
}

async fn emit_desktop_telemetry_with_vault(
    vault: &VaultClient,
    event_name: String,
    properties: Option<Value>,
    session_id: Option<String>,
    occurred_at: Option<String>,
) -> Result<(), String> {
    if !is_safe_event_name(&event_name) {
        return Err(format!("invalid telemetry event name: {event_name}"));
    }

    if !resolve_telemetry_enabled(vault).await {
        return Ok(());
    }

    let event = build_desktop_telemetry_event(
        event_name,
        properties,
        session_id,
        occurred_at,
        "desktop-opt-in",
    );
    let batch = TelemetryEventsBatch {
        events: vec![event],
    };

    vault
        .post_telemetry_events(&batch)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn emit_desktop_telemetry_if_opted_in(
    event_name: String,
    properties: Option<Value>,
    session_id: Option<String>,
    occurred_at: Option<String>,
) -> Result<(), String> {
    let access_token = crate::commands::cognito::get_valid_access_token().await?;
    let api_url = resolve_vault_api_url()?;
    let vault = VaultClient::new(&api_url, &access_token);
    emit_desktop_telemetry_with_vault(&vault, event_name, properties, session_id, occurred_at).await
}

async fn emit_desktop_operational_telemetry_with_vault(
    vault: &VaultClient,
    event_name: String,
    properties: Option<Value>,
    session_id: Option<String>,
    occurred_at: Option<String>,
) -> Result<(), String> {
    if !is_operational_desktop_event_name(&event_name) {
        return Err(format!(
            "event is not approved operational telemetry: {event_name}"
        ));
    }

    let event = build_desktop_telemetry_event(
        event_name,
        properties,
        session_id,
        occurred_at,
        "no-consent",
    );
    let batch = TelemetryEventsBatch {
        events: vec![event],
    };

    vault
        .post_telemetry_events(&batch)
        .await
        .map_err(|e| e.to_string())
}

const OPERATIONAL_DESKTOP_EVENT_NAMES: &[&str] = &[
    "desktop_app_daily_active",
    "desktop_app_quit",
    "desktop_onboarding_step",
    "desktop_post_ready_action",
    "desktop_post_ready_action_dropped",
    "desktop_setup_completed",
    "desktop_auto_update_post_cap_outcome",
    "desktop_update_outcome",
    "oauth_signin_succeeded",
    "telemetry_preference_changed",
    "install_tag_read",
    crate::commands::cdp_mirror::OP_APP_OPENED,
    crate::commands::cdp_mirror::OP_ACCOUNT_LINKED,
    crate::commands::cdp_mirror::OP_AGENT_SESSION_LAUNCHED,
    crate::commands::cdp_mirror::OP_SYNC_STARTED,
    crate::commands::cdp_mirror::OP_SYNC_COMPLETED,
    crate::commands::cdp_mirror::OP_SYNC_FAILED,
    crate::commands::cdp_mirror::OP_INVITE_SENT,
    crate::commands::cdp_mirror::OP_INVITE_FAILED,
    crate::commands::cdp_mirror::OP_COMPANY_JOINED,
    crate::commands::cdp_mirror::OP_PLAN_SELECTED,
    crate::commands::cdp_mirror::OP_AUTH_PROGRESS,
    crate::commands::cdp_mirror::OP_AUTH_FAILURE,
];

fn is_operational_desktop_event_name(event_name: &str) -> bool {
    OPERATIONAL_DESKTOP_EVENT_NAMES.contains(&event_name)
}

/// Token file that belongs to the install whose `menubar.json` is `menubar`.
fn tokens_path_for_menubar(menubar: &Path) -> std::path::PathBuf {
    menubar.with_file_name("cognito-tokens.json")
}

/// File `get_valid_access_token` reads. `tokens_file_path` is private, and
/// `cognito.rs` is left unchanged. App tests compile that crate with
/// `test-support`, so `HQ_TEST_HOME` wins there; a production build ignores
/// it and uses `dirs::home_dir`, matching the private resolver.
fn auth_resolver_tokens_path() -> Option<std::path::PathBuf> {
    #[cfg(test)]
    if let Some(home) = std::env::var_os("HQ_TEST_HOME") {
        return Some(
            std::path::PathBuf::from(home)
                .join(".hq")
                .join("cognito-tokens.json"),
        );
    }
    dirs::home_dir().map(|home| home.join(".hq").join("cognito-tokens.json"))
}

/// Access token stored beside a captured menubar path, with no refresh.
/// Refresh persists through the resolver and would write another home's file.
fn unexpired_access_token_at(path: &Path) -> Result<String, String> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("Not signed in".to_string());
        }
        Err(error) => return Err(format!("Failed to read token file: {error}")),
    };
    let tokens: crate::commands::cognito::CognitoTokens = serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse token file: {error}"))?;
    if tokens.access_token.is_empty() || crate::commands::cognito::is_expired(&tokens) {
        return Err("Not signed in".to_string());
    }
    Ok(tokens.access_token)
}

/// Token for the install that owns `menubar`. The resolver is used only when
/// it names that same file, so refresh and invalidation stay on one home.
async fn access_token_for_captured_home(menubar: &Path) -> Result<String, String> {
    let captured = tokens_path_for_menubar(menubar);
    if auth_resolver_tokens_path().as_ref() == Some(&captured) {
        crate::commands::cognito::get_valid_access_token().await
    } else {
        unexpired_access_token_at(&captured)
    }
}

async fn access_token_for_optional_home(
    menubar: Option<std::path::PathBuf>,
) -> Result<String, String> {
    match menubar {
        Some(path) => access_token_for_captured_home(&path).await,
        None => crate::commands::cognito::get_valid_access_token().await,
    }
}

/// Emit an installation or delivery-health record. Operational telemetry is
/// intentionally independent of the skill-telemetry opt-in.
#[tauri::command]
pub async fn emit_desktop_operational_telemetry(
    event_name: String,
    properties: Option<Value>,
    session_id: Option<String>,
    occurred_at: Option<String>,
) -> Result<(), String> {
    // Mirror the funnel stage to the CDP before any auth work: a queue push
    // only, and independent of whether hq-pro accepts the row.
    crate::commands::cdp_mirror::note_operational_event(&event_name, properties.as_ref());
    // Capture once, before the token await. HOME and HQ_TEST_HOME are
    // process-global and can diverge while this future is pending; the hold
    // path and a later flush must keep using this install's menubar file.
    let menubar_path = paths::menubar_json_path().ok();
    let Some(access_token) = access_token_or_hold_auth_event(
        &event_name,
        properties.as_ref(),
        session_id.as_deref(),
        menubar_path.clone(),
        access_token_for_optional_home(menubar_path.clone()),
    )
    .await?
    else {
        return Ok(());
    };
    let api_url = resolve_vault_api_url()?;
    let vault = VaultClient::new(&api_url, &access_token);
    emit_desktop_operational_telemetry_with_vault(
        &vault,
        event_name,
        properties,
        session_id,
        occurred_at,
    )
    .await?;
    if let Some(path) = menubar_path {
        crate::commands::cdp_mirror::flush_held_auth_rows_at(path).await;
    } else {
        crate::commands::cdp_mirror::flush_held_auth_rows_now().await;
    }
    Ok(())
}

async fn access_token_or_hold_auth_event<F>(
    event_name: &str,
    properties: Option<&Value>,
    session_id: Option<&str>,
    menubar_path: Option<std::path::PathBuf>,
    access_token: F,
) -> Result<Option<String>, String>
where
    F: std::future::Future<Output = Result<String, String>>,
{
    // Resolve the destination before awaiting auth: HOME is process-global, so
    // a concurrent profile/test-home change must not redirect a held receipt.
    // Callers that already captured the install path pass it in; a missing
    // path is resolved here, still before the token future runs.
    let held_path = if crate::commands::cdp_mirror::is_held_auth_event(event_name) {
        menubar_path.or_else(|| paths::menubar_json_path().ok())
    } else {
        None
    };
    match access_token.await {
        Ok(token) => Ok(Some(token)),
        // A first sign-in has no session until the token exchange, so its
        // progress and failure rows wait on disk for the next session.
        Err(_) if crate::commands::cdp_mirror::is_held_auth_event(event_name) => {
            let result = held_path
                .ok_or_else(|| "Cannot determine home directory".to_string())
                .and_then(|path| {
                    crate::commands::cdp_mirror::hold_auth_row_at(
                        &path,
                        event_name,
                        properties,
                        session_id,
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|elapsed| elapsed.as_millis() as u64)
                            .unwrap_or(0),
                    )
                });
            if result.is_err() {
                crate::util::logfile::log("cdp", "WARN auth_held hold_write_failed");
            }
            Ok(None)
        }
        Err(err) => Err(err),
    }
}

/// Send one row held by `cdp_mirror::hold_auth_row` with its own timestamp
/// and idempotencyKey. `menubar_path` is the file the row was held on; the
/// access token is read from that install, not from a later resolver home.
pub async fn post_held_auth_row(row: &Value, menubar_path: &Path) -> Result<(), String> {
    let event_name = row
        .get("eventName")
        .and_then(Value::as_str)
        .filter(|name| crate::commands::cdp_mirror::is_held_auth_event(name))
        .ok_or("held row has no sign-in event name")?;
    let access_token = access_token_for_captured_home(menubar_path).await?;
    let api_url = resolve_vault_api_url()?;
    let vault = VaultClient::new(&api_url, &access_token);
    let mut event = build_desktop_telemetry_event(
        event_name.to_string(),
        row.get("properties").cloned(),
        row.get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string),
        row.get("occurredAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        "no-consent",
    );
    event.idempotency_key = row
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(install_attempt_id) = row
        .get("installAttemptId")
        .and_then(Value::as_str)
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
    {
        event.install_attempt_id = Some(install_attempt_id.to_string());
    }
    vault
        .post_telemetry_events(&TelemetryEventsBatch {
            events: vec![event],
        })
        .await
        .map_err(|e| e.to_string())
}

/// hq-pro only, for a row whose CDP copy was queued earlier.
pub async fn emit_desktop_operational_telemetry_unmirrored(
    event_name: &str,
    properties: Value,
) -> Result<(), String> {
    let access_token = crate::commands::cognito::get_valid_access_token().await?;
    let api_url = resolve_vault_api_url()?;
    let vault = VaultClient::new(&api_url, &access_token);
    emit_desktop_operational_telemetry_with_vault(
        &vault,
        event_name.to_string(),
        Some(properties),
        None,
        None,
    )
    .await
}

/// Queue consent-free updater outcome telemetry without delaying installation.
pub fn emit_desktop_operational_telemetry_best_effort(event_name: &'static str, properties: Value) {
    tauri::async_runtime::spawn(async move {
        if emit_desktop_operational_telemetry(event_name.to_string(), Some(properties), None, None)
            .await
            .is_err()
        {
            crate::util::logfile::log(
                "telemetry",
                &format!("best-effort operational event failed: {event_name}"),
            );
        }
    });
}

/// Queue a consent-gated desktop event without delaying the updater path.
/// Errors are deliberately reduced to a local category-only log line: update
/// telemetry must never break a check or rescue, and raw server/auth errors do
/// not belong in another telemetry channel.
pub fn emit_desktop_telemetry_best_effort(event_name: &'static str, properties: Value) {
    tauri::async_runtime::spawn(async move {
        if emit_desktop_telemetry_if_opted_in(event_name.to_string(), Some(properties), None, None)
            .await
            .is_err()
        {
            crate::util::logfile::log(
                "telemetry",
                &format!("best-effort event failed: {event_name}"),
            );
        }
    });
}

/// `occurredAt` is the send time. The once-per-day guarantee comes from the
/// day in `idempotencyKey` (hq-pro keeps one row per subject, event and key);
/// a midnight timestamp would put every row outside any daytime query window.
const APP_LIVENESS_TELEMETRY_FLAG: &str = "desktop.app-liveness-telemetry-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopQuitReason {
    TrayQuit,
    AppMenuQuit,
    OsShutdown,
    UpdateRestart,
    Unknown,
}

impl DesktopQuitReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::TrayQuit => "tray_quit",
            Self::AppMenuQuit => "app_menu_quit",
            Self::OsShutdown => "os_shutdown",
            Self::UpdateRestart => "update_restart",
            Self::Unknown => "unknown",
        }
    }
}

static DESKTOP_QUIT_REASON: AtomicU8 = AtomicU8::new(0);

const LIVENESS_FLAG_UNKNOWN: u8 = 0;
const LIVENESS_FLAG_RESOLVING: u8 = 1;
const LIVENESS_FLAG_OFF: u8 = 2;
const LIVENESS_FLAG_ON: u8 = 3;
static LIVENESS_FLAG_CACHE: AtomicU8 = AtomicU8::new(LIVENESS_FLAG_UNKNOWN);

pub fn note_desktop_quit_reason(reason: DesktopQuitReason) {
    let value = match reason {
        DesktopQuitReason::Unknown => 0,
        DesktopQuitReason::TrayQuit => 1,
        DesktopQuitReason::AppMenuQuit => 2,
        DesktopQuitReason::OsShutdown => 3,
        DesktopQuitReason::UpdateRestart => 4,
    };
    DESKTOP_QUIT_REASON.store(value, Ordering::Release);
}

fn desktop_quit_reason() -> DesktopQuitReason {
    match DESKTOP_QUIT_REASON.load(Ordering::Acquire) {
        1 => DesktopQuitReason::TrayQuit,
        2 => DesktopQuitReason::AppMenuQuit,
        3 => DesktopQuitReason::OsShutdown,
        4 => DesktopQuitReason::UpdateRestart,
        _ => DesktopQuitReason::Unknown,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopLivenessContext {
    pub launch_source: &'static str,
    pub start_at_login: &'static str,
}

pub fn classify_desktop_launch_source(
    from_updater_restart: bool,
    from_login_item: bool,
    source_is_observable: bool,
) -> &'static str {
    if from_updater_restart {
        "update_restart"
    } else if from_login_item {
        "login_item"
    } else if source_is_observable {
        "user"
    } else {
        "unknown"
    }
}

pub fn classify_start_at_login(
    preference_enabled: Option<bool>,
    registered: Option<bool>,
) -> &'static str {
    match (preference_enabled, registered) {
        (_, Some(true)) => "registered",
        (Some(false), Some(false)) => "opted_out",
        (Some(true), Some(false)) => "registration_failed",
        _ => "unknown",
    }
}

fn days_since_setup_bucket(
    setup_at: Option<chrono::DateTime<chrono::Utc>>,
    now: chrono::DateTime<chrono::Utc>,
) -> &'static str {
    let Some(setup_at) = setup_at.filter(|setup_at| *setup_at <= now) else {
        return "unknown";
    };
    match (now - setup_at).num_days() {
        0 => "0",
        1..=7 => "1-7",
        8.. => "8+",
        _ => "unknown",
    }
}

fn read_setup_completed_at() -> Option<chrono::DateTime<chrono::Utc>> {
    let path = paths::menubar_json_path().ok()?;
    let contents = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&contents).ok()?;
    let timestamp = value.get("welcomeSetupCompletedAt")?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|timestamp| timestamp.with_timezone(&chrono::Utc))
}

fn build_daily_active_event_with_liveness(
    now: chrono::DateTime<chrono::Utc>,
    liveness: Option<DesktopLivenessContext>,
) -> RawTelemetryEvent {
    let mut event = build_daily_active_event(now);
    if let Some(liveness) = liveness {
        if let Some(properties) = event.properties.as_object_mut() {
            properties.insert("launch_source".into(), json!(liveness.launch_source));
            properties.insert("start_at_login".into(), json!(liveness.start_at_login));
        }
    }
    event
}

fn sanitize_desktop_quit_properties(properties: Option<Value>) -> Value {
    let Some(Value::Object(input)) = properties else {
        return json!({ "reason": "unknown", "days_since_setup": "unknown" });
    };
    let reason = match input.get("reason").and_then(Value::as_str) {
        Some("tray_quit" | "app_menu_quit" | "os_shutdown" | "update_restart") => {
            input["reason"].as_str().unwrap_or("unknown")
        }
        _ => "unknown",
    };
    let days_since_setup = match input.get("days_since_setup").and_then(Value::as_str) {
        Some("0" | "1-7" | "8+") => input["days_since_setup"].as_str().unwrap_or("unknown"),
        _ => "unknown",
    };
    json!({ "reason": reason, "days_since_setup": days_since_setup })
}

fn build_desktop_quit_event(
    now: chrono::DateTime<chrono::Utc>,
    reason: DesktopQuitReason,
    setup_at: Option<chrono::DateTime<chrono::Utc>>,
) -> RawTelemetryEvent {
    let occurred_at = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    build_desktop_telemetry_event(
        "desktop_app_quit".to_string(),
        Some(json!({
            "reason": reason.as_str(),
            "days_since_setup": days_since_setup_bucket(setup_at, now),
        })),
        None,
        Some(occurred_at),
        "no-consent",
    )
}

fn quit_event_when_enabled(
    enabled: bool,
    now: chrono::DateTime<chrono::Utc>,
    reason: DesktopQuitReason,
    setup_at: Option<chrono::DateTime<chrono::Utc>>,
) -> Option<RawTelemetryEvent> {
    enabled.then(|| build_desktop_quit_event(now, reason, setup_at))
}

fn liveness_flag_is_enabled(read: Result<Option<bool>, ()>) -> bool {
    matches!(read, Ok(Some(true)))
}

fn liveness_flag_cache_value(read: Result<Option<bool>, ()>) -> u8 {
    if liveness_flag_is_enabled(read) {
        LIVENESS_FLAG_ON
    } else {
        LIVENESS_FLAG_OFF
    }
}

async fn resolve_liveness_flag_once_with<F, Fut>(cache: &AtomicU8, read: F) -> bool
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Option<bool>, ()>>,
{
    match cache.compare_exchange(
        LIVENESS_FLAG_UNKNOWN,
        LIVENESS_FLAG_RESOLVING,
        Ordering::AcqRel,
        Ordering::Acquire,
    ) {
        Ok(_) => {
            let value = liveness_flag_cache_value(read().await);
            cache.store(value, Ordering::Release);
            value == LIVENESS_FLAG_ON
        }
        Err(state) => state == LIVENESS_FLAG_ON,
    }
}

fn daily_active_liveness_context(
    enabled: bool,
    context: DesktopLivenessContext,
) -> Option<DesktopLivenessContext> {
    enabled.then_some(context)
}

fn with_cached_liveness_on(cache: &AtomicU8, attempt: impl FnOnce()) -> bool {
    if cache.load(Ordering::Acquire) != LIVENESS_FLAG_ON {
        return false;
    }
    attempt();
    true
}

fn quit_event_for_cached_liveness(
    cache: &AtomicU8,
    now: chrono::DateTime<chrono::Utc>,
    reason: DesktopQuitReason,
    setup_at: Option<chrono::DateTime<chrono::Utc>>,
) -> Option<RawTelemetryEvent> {
    (cache.load(Ordering::Acquire) == LIVENESS_FLAG_ON)
        .then(|| build_desktop_quit_event(now, reason, setup_at))
}

fn wait_for_quit_telemetry_attempt(receiver: Receiver<Result<(), String>>) {
    let _ = receiver.recv_timeout(Duration::from_millis(480));
}

fn report_quit_telemetry_attempt(sender: SyncSender<Result<(), String>>, result: Result<(), String>) {
    let _ = sender.send(result);
}

/// Cached-off/unknown exits immediately. Cached-on telemetry gets at most 480ms.
pub fn emit_desktop_quit_before_exit(reason: DesktopQuitReason) {
    with_cached_liveness_on(&LIVENESS_FLAG_CACHE, || {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        tauri::async_runtime::spawn(async move {
            let result = tokio::time::timeout(Duration::from_millis(450), async move {
                let now = chrono::Utc::now();
                let setup_at = read_setup_completed_at();
                if let Some(event) = quit_event_for_cached_liveness(
                    &LIVENESS_FLAG_CACHE,
                    now,
                    reason,
                    setup_at,
                ) {
                    emit_desktop_operational_telemetry(
                        event.event_name,
                        Some(event.properties),
                        None,
                        Some(event.occurred_at),
                    )
                    .await
                } else {
                    Ok(())
                }
            })
            .await
            .map_err(|_| "desktop quit telemetry exceeded its send budget".to_string())
            .and_then(|result| result);
            report_quit_telemetry_attempt(sender, result);
        });
        wait_for_quit_telemetry_attempt(receiver);
    });
}

pub fn emit_noted_desktop_quit_before_exit() {
    emit_desktop_quit_before_exit(desktop_quit_reason());
}

fn build_daily_active_event(now: chrono::DateTime<chrono::Utc>) -> RawTelemetryEvent {
    let day = now.date_naive().format("%Y-%m-%d");
    let occurred_at = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    RawTelemetryEvent {
        event_name: "desktop_app_daily_active".to_string(),
        app: "hq-desktop-app".to_string(),
        source: "desktop".to_string(),
        occurred_at,
        consent_basis: "no-consent".to_string(),
        schema_version: 1,
        idempotency_key: Some(format!("hq-desktop-app:daily-active:{day}")),
        session_id: None,
        company_uid: None,
        install_attempt_id: None,
        properties: json!({
            "platform": crate::commands::version_gate::platform_tag(),
            "appVersion": crate::app_version::current(),
        }),
    }
}

async fn emit_daily_active_with_vault(
    vault: &VaultClient,
    now: chrono::DateTime<chrono::Utc>,
    liveness: Option<DesktopLivenessContext>,
) -> Result<(), String> {
    let batch = TelemetryEventsBatch {
        events: vec![build_daily_active_event_with_liveness(now, liveness)],
    };
    vault
        .post_telemetry_events(&batch)
        .await
        .map_err(|e| e.to_string())
}

async fn emit_daily_active_at(
    now: chrono::DateTime<chrono::Utc>,
    liveness: DesktopLivenessContext,
) {
    let result = async {
        let enabled = resolve_liveness_flag_once_with(&LIVENESS_FLAG_CACHE, || {
            crate::commands::hq_pro::feature_flag_read(APP_LIVENESS_TELEMETRY_FLAG)
        })
        .await;
        let liveness = daily_active_liveness_context(enabled, liveness);
        let access_token = crate::commands::cognito::get_valid_access_token().await?;
        let api_url = resolve_vault_api_url()?;
        let vault = VaultClient::new(&api_url, &access_token);
        emit_daily_active_with_vault(&vault, now, liveness).await
    }
    .await;

    if result.is_err() {
        eprintln!("[telemetry] desktop-app-daily-active-failed");
    }
}

/// How often a running app re-sends daily-active. hq-pro keeps the first row
/// per UTC day, so repeats cost one request and cover a launch that had no
/// session yet and an app left running past midnight.
const DAILY_ACTIVE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Start best-effort daily-active emits without delaying application startup.
pub fn setup_daily_active_emit(liveness: DesktopLivenessContext) {
    tauri::async_runtime::spawn(async move {
        loop {
            emit_daily_active_at(chrono::Utc::now(), liveness).await;
            tokio::time::sleep(DAILY_ACTIVE_INTERVAL).await;
        }
    });
}

// ── Version heartbeat (GTM last-seen / running desktop build) ─────────────────
//
// hq-pro persists per-machine app/CLI versions on POST /v1/usage
// (`recordClientVersions` in usage.ts, hq-pro #2784). An empty `events` array
// is accepted and still refreshes `clientVersions.lastSeenAt` *before* the
// skill-consent gate, so a signed-in user who launches and does nothing still
// shows up on GTM People. `GET /membership/me` `lastObservedClients` is
// change-only and is not this feed.
//
// Consent: this is version/presence, not skill telemetry (hq-pro #2877). Skill
// event collection is untouched.

const VERSION_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const VERSION_HEARTBEAT_SESSION_RETRY: Duration = Duration::from_secs(30);
const VERSION_HEARTBEAT_MACHINE_PREFIX_CHARS: usize = 8;
/// GTM #142 treats `hq-desktop-app` as an App client. hq-pro's
/// `lastObservedClients` stores the raw `x-hq-client-name` with no allowlist
/// (it would not drop this name). Sourced from the shared client-attribution
/// constant so this heartbeat can never drift back to the sync runner's
/// `hq-sync` name — the drift that made the desktop fleet unmeasurable.
const VERSION_HEARTBEAT_CLIENT_NAME: &str = hq_desktop_core::client_info::CLIENT_NAME;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VersionHeartbeatTrigger {
    Launch,
    Interval,
    PostUpdate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VersionHeartbeatOutcome {
    Sent,
    NoSession,
    Failed,
}

fn version_heartbeat_delay(trigger: VersionHeartbeatTrigger) -> Duration {
    match trigger {
        VersionHeartbeatTrigger::Launch | VersionHeartbeatTrigger::PostUpdate => Duration::ZERO,
        VersionHeartbeatTrigger::Interval => VERSION_HEARTBEAT_INTERVAL,
    }
}

fn next_version_heartbeat_delay(outcome: VersionHeartbeatOutcome) -> Duration {
    match outcome {
        VersionHeartbeatOutcome::NoSession => VERSION_HEARTBEAT_SESSION_RETRY,
        VersionHeartbeatOutcome::Sent | VersionHeartbeatOutcome::Failed => {
            VERSION_HEARTBEAT_INTERVAL
        }
    }
}

fn heartbeat_error_is_retryable(err: &VaultClientError) -> bool {
    matches!(err, VaultClientError::Request(_))
}

fn machine_id_log_prefix(machine_id: &str) -> &str {
    if machine_id.is_empty() {
        return "-";
    }
    let end = machine_id
        .char_indices()
        .nth(VERSION_HEARTBEAT_MACHINE_PREFIX_CHARS)
        .map(|(i, _)| i)
        .unwrap_or(machine_id.len());
    &machine_id[..end]
}

fn log_version_heartbeat(version: &str, machine_id: &str, ok: bool) {
    let status = if ok { "ok" } else { "failed" };
    eprintln!(
        "[heartbeat] version={version} machine={} {status}",
        machine_id_log_prefix(machine_id)
    );
}

fn build_version_heartbeat_batch(
    machine_id: &str,
    installer_version: &str,
    cli_version: Option<&str>,
) -> UsageBatch {
    UsageBatch {
        machine_id: machine_id.to_string(),
        installer_version: installer_version.to_string(),
        cli_version: cli_version.map(str::to_string),
        events: Vec::new(),
    }
}

fn heartbeat_app_version() -> String {
    crate::app_version::current().to_string()
}

#[cfg(test)]
async fn post_heartbeat_attempts<F, Fut>(mut post: F) -> Result<(), VaultClientError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<(), VaultClientError>>,
{
    match post().await {
        Ok(()) => Ok(()),
        Err(err) if heartbeat_error_is_retryable(&err) => post().await,
        Err(err) => Err(err),
    }
}

async fn post_version_heartbeat_request(
    api_url: &str,
    jwt: &str,
    batch: &UsageBatch,
) -> Result<(), VaultClientError> {
    let resp = build_client()
        .post(format!("{}/v1/usage", api_url.trim_end_matches('/')))
        .header("x-hq-client-name", VERSION_HEARTBEAT_CLIENT_NAME)
        .bearer_auth(jwt)
        .json(batch)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(VaultClientError::Http {
            status: status.as_u16(),
            body,
        });
    }
    Ok(())
}

async fn post_version_heartbeat_with_retry(
    api_url: &str,
    jwt: &str,
    batch: &UsageBatch,
) -> Result<(), VaultClientError> {
    match post_version_heartbeat_request(api_url, jwt, batch).await {
        Ok(()) => Ok(()),
        Err(err) if heartbeat_error_is_retryable(&err) => {
            post_version_heartbeat_request(api_url, jwt, batch).await
        }
        Err(err) => Err(err),
    }
}

async fn emit_version_heartbeat_once(installed_version: Option<&str>) -> VersionHeartbeatOutcome {
    let machine_id = read_machine_id();
    let version = installed_version
        .map(str::to_string)
        .unwrap_or_else(heartbeat_app_version);

    let access_token = match crate::commands::cognito::get_valid_access_token().await {
        Ok(token) => token,
        Err(_) => return VersionHeartbeatOutcome::NoSession,
    };
    let api_url = match resolve_vault_api_url() {
        Ok(url) => url,
        Err(_) => {
            log_version_heartbeat(&version, &machine_id, false);
            return VersionHeartbeatOutcome::Failed;
        }
    };

    let cli_version = crate::commands::hq_cli_update::get_hq_cli_version().await;
    let batch = build_version_heartbeat_batch(&machine_id, &version, cli_version.as_deref());

    match post_version_heartbeat_with_retry(&api_url, &access_token, &batch).await {
        Ok(()) => {
            log_version_heartbeat(&version, &machine_id, true);
            VersionHeartbeatOutcome::Sent
        }
        Err(_) => {
            log_version_heartbeat(&version, &machine_id, false);
            VersionHeartbeatOutcome::Failed
        }
    }
}

/// Fire-and-forget launch + 6h version heartbeat. Returns immediately so
/// startup is never blocked on network or auth.
pub fn setup_version_heartbeat() {
    let launch_delay = version_heartbeat_delay(VersionHeartbeatTrigger::Launch);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(launch_delay).await;
        loop {
            let outcome = emit_version_heartbeat_once(None).await;
            tokio::time::sleep(next_version_heartbeat_delay(outcome)).await;
        }
    });
}

/// Best-effort heartbeat immediately after an update installs, sending the
/// *new* version so GTM does not wait for the relaunched process. Awaited by
/// the updater so the request can land before restart/exit; failures are
/// swallowed.
pub async fn emit_version_heartbeat_after_update(installed_version: &str) {
    let _ = emit_version_heartbeat_once(Some(installed_version)).await;
}

fn read_machine_id() -> String {
    let home = telemetry_home_dir().unwrap_or_default();
    let path = home.join(".hq/menubar.json");
    if let Ok(contents) = fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<Value>(&contents) {
            if let Some(id) = v.get("machineId").and_then(|v| v.as_str()) {
                if !id.is_empty() && id.len() <= MAX_ID_BYTES {
                    return id.to_string();
                }
            }
        }
    }
    // Bootstrap via ensure_machine_id
    crate::commands::config::ensure_machine_id().unwrap_or_default()
}

fn mtime_secs(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Per-row tracking: which file + byte-end-offset contributed this row.
fn system_time_secs(time: std::time::SystemTime) -> u64 {
    time.duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn candidate_cursor_entry(
    stored: Option<&CursorEntry>,
    current_size: u64,
    current_mtime: u64,
) -> CursorEntry {
    let stored = stored.cloned().unwrap_or_default();
    let rotated =
        current_size < stored.offset || (stored.mtime > 0 && current_mtime < stored.mtime);
    // Pre-context Codex cursors cannot safely resume without replaying an
    // unbounded prefix. Reset once and rebuild context through bounded reads;
    // server-side event dedupe keeps this at-least-once migration safe.
    let legacy_without_context = stored.offset > 0 && stored.context.is_none();
    let reset = rotated || legacy_without_context;

    CursorEntry {
        offset: if reset { 0 } else { stored.offset },
        mtime: current_mtime,
        context: if reset { None } else { stored.context },
    }
}

fn codex_candidate_entries(
    codex_dir: &std::path::Path,
    cursor: &TelemetryCursor,
) -> HashMap<String, CursorEntry> {
    enumerate_rollout_files(codex_dir)
        .into_values()
        .map(|rollout| {
            let path = normalize_cursor_file_key(&rollout.path);
            let entry = candidate_cursor_entry(
                cursor.files.get(&path),
                rollout.size,
                system_time_secs(rollout.mtime),
            );
            (path, entry)
        })
        .collect()
}

fn codex_rollouts_freshest_first(codex_dir: &Path) -> Vec<(String, RolloutFile)> {
    let mut rollouts: Vec<_> = enumerate_rollout_files(codex_dir).into_iter().collect();
    sort_rollouts_freshest_first(&mut rollouts);
    rollouts
}

fn sort_rollouts_freshest_first(rollouts: &mut [(String, RolloutFile)]) {
    rollouts.sort_by(|left, right| {
        right
            .1
            .mtime
            .cmp(&left.1.mtime)
            .then_with(|| left.0.cmp(&right.0))
    });
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CodexUsageContext {
    session_id: Option<String>,
    cwd: Option<String>,
    git_branch: Option<String>,
    session_model: Option<String>,
    collaboration_model: Option<String>,
    turn_model: Option<String>,
    #[serde(default)]
    discarding_partial_line: bool,
}

impl CodexUsageContext {
    fn new(filename_session_id: &str) -> Self {
        Self {
            session_id: (!filename_session_id.is_empty()).then(|| filename_session_id.to_string()),
            ..Self::default()
        }
    }

    fn model(&self) -> Option<&str> {
        self.turn_model
            .as_deref()
            .or(self.collaboration_model.as_deref())
            .or(self.session_model.as_deref())
    }
}

fn bounded_string(value: Option<&Value>, max_bytes: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= max_bytes)
        .map(str::to_string)
}

fn session_meta_git_branch(payload: &serde_json::Map<String, Value>) -> Option<String> {
    bounded_string(payload.get("gitBranch"), MAX_PATH_BYTES)
        .or_else(|| bounded_string(payload.get("git_branch"), MAX_PATH_BYTES))
        .or_else(|| {
            payload
                .get("git")
                .and_then(Value::as_object)
                .and_then(|git| bounded_string(git.get("branch"), MAX_PATH_BYTES))
        })
}

fn stable_codex_event_id(rollout_identity: &str, start_offset: u64, end_offset: u64) -> String {
    let mut digest = Sha256::new();
    digest.update(rollout_identity.as_bytes());
    digest.update([0]);
    digest.update(start_offset.to_be_bytes());
    digest.update(end_offset.to_be_bytes());
    format!("codex-{:x}", digest.finalize())
}

/// Parse one Codex rollout record, updating the current model/session context and
/// returning an allowlisted row only for event_msg/token_count records.
fn codex_usage_row_at(
    record: &Value,
    context: &mut CodexUsageContext,
    rollout_identity: &str,
    start_offset: u64,
    end_offset: u64,
) -> Option<Value> {
    let obj = record.as_object()?;
    let kind = obj.get("type").and_then(Value::as_str)?;
    let payload = obj.get("payload").and_then(Value::as_object);

    match kind {
        "session_meta" => {
            let payload = payload?;
            if let Some(id) = bounded_string(payload.get("id"), MAX_ID_BYTES) {
                context.session_id = Some(id);
            }
            context.cwd = bounded_string(payload.get("cwd"), MAX_PATH_BYTES);
            context.git_branch = session_meta_git_branch(payload);
            context.session_model = bounded_string(payload.get("model"), MAX_MODEL_BYTES);
            return None;
        }
        "turn_context" => {
            context.turn_model =
                payload.and_then(|p| bounded_string(p.get("model"), MAX_MODEL_BYTES));
            if let Some(model) = payload
                .and_then(|p| p.get("collaboration_mode"))
                .and_then(Value::as_object)
                .and_then(|mode| mode.get("settings"))
                .and_then(Value::as_object)
                .and_then(|settings| bounded_string(settings.get("model"), MAX_MODEL_BYTES))
            {
                context.collaboration_model = Some(model);
            }
            return None;
        }
        "collaboration_mode" => {
            context.collaboration_model = payload
                .and_then(|p| p.get("settings"))
                .and_then(Value::as_object)
                .and_then(|settings| bounded_string(settings.get("model"), MAX_MODEL_BYTES));
            return None;
        }
        "event_msg" => {}
        _ => return None,
    }

    let payload = payload?;
    if payload.get("type").and_then(Value::as_str) == Some("collaboration_mode") {
        context.collaboration_model = payload
            .get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| bounded_string(settings.get("model"), MAX_MODEL_BYTES));
        return None;
    }
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }

    let usage = payload
        .get("info")
        .and_then(Value::as_object)?
        .get("last_token_usage")
        .and_then(Value::as_object)?;
    let input_tokens = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_add(
            usage
                .get("reasoning_output_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        );

    let mut row = serde_json::Map::new();
    if let Some(value) = context.session_id.as_ref() {
        row.insert("sessionId".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = bounded_scalar(obj.get("timestamp"), MAX_TIMESTAMP_BYTES) {
        row.insert("timestamp".to_string(), value);
    }
    let event_id = bounded_scalar(obj.get("uuid"), MAX_ID_BYTES).unwrap_or_else(|| {
        Value::String(stable_codex_event_id(
            rollout_identity,
            start_offset,
            end_offset,
        ))
    });
    row.insert("uuid".to_string(), event_id);
    if let Some(value) = context.cwd.as_ref() {
        row.insert("cwd".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = context.git_branch.as_ref() {
        row.insert("gitBranch".to_string(), Value::String(value.clone()));
    }

    // Reuse the shared server allowlist gate by representing Codex's flat
    // counters as the same intermediate message shape used by Claude rows.
    let mut message = serde_json::Map::new();
    if let Some(model) = context.model() {
        message.insert("model".to_string(), Value::String(model.to_string()));
    }
    let mut normalized_usage = serde_json::Map::new();
    normalized_usage.insert("input_tokens".to_string(), Value::from(input_tokens));
    normalized_usage.insert("output_tokens".to_string(), Value::from(output_tokens));
    if let Some(value) = usage.get("cached_input_tokens").and_then(Value::as_u64) {
        normalized_usage.insert("cache_read_input_tokens".to_string(), Value::from(value));
    }
    message.insert("usage".to_string(), Value::Object(normalized_usage));
    row.insert("message".to_string(), Value::Object(message));
    sanitize_row(&Value::Object(row))
}

#[cfg(test)]
fn codex_usage_row(record: &Value, context: &mut CodexUsageContext) -> Option<Value> {
    codex_usage_row_at(record, context, "test-rollout", 0, 0)
}
/// Scanner over rollout lines. Each bounded read carries optional usage plus
/// byte progress and context, without retaining previously parsed records.
struct CodexRolloutScanner {
    reader: BufReader<fs::File>,
    context: CodexUsageContext,
    rollout_identity: String,
    line: Vec<u8>,
}

impl CodexRolloutScanner {
    fn open(
        path: &Path,
        start_offset: u64,
        filename_session_id: &str,
        saved_context: Option<CodexUsageContext>,
    ) -> Result<Self, String> {
        let file = fs::File::open(path).map_err(|error| error.to_string())?;
        let has_saved_context = saved_context.is_some();
        let mut scanner = Self {
            reader: BufReader::new(file),
            context: saved_context.unwrap_or_else(|| CodexUsageContext::new(filename_session_id)),
            rollout_identity: filename_session_id.to_string(),
            line: Vec::new(),
        };

        if has_saved_context {
            scanner
                .reader
                .seek(SeekFrom::Start(start_offset))
                .map_err(|error| error.to_string())?;
            return Ok(scanner);
        }

        // Missing-context cursors are reset to zero before opening, so all
        // context reconstruction happens through bounded reads.
        Ok(scanner)
    }
}

impl CodexRolloutScanner {
    fn next_bounded(&mut self, max_bytes: u64) -> Option<(Option<Value>, u64, CodexUsageContext)> {
        if max_bytes == 0 {
            return None;
        }
        let start_offset = self.reader.stream_position().ok()?;
        let continuing_oversized_line = self.context.discarding_partial_line;
        let read_limit = if continuing_oversized_line {
            max_bytes
        } else {
            max_bytes.min(MAX_CODEX_LINE_BYTES)
        };
        self.line.clear();
        let bytes_read = self
            .reader
            .by_ref()
            .take(read_limit)
            .read_until(b'\n', &mut self.line)
            .ok()?;
        if bytes_read == 0 {
            return None;
        }
        let end_offset = self.reader.stream_position().ok()?;
        let reached_eof = self.reader.fill_buf().ok()?.is_empty();
        let ended_line = self.line.last() == Some(&b'\n') || reached_eof;

        if !ended_line {
            if continuing_oversized_line || bytes_read as u64 >= MAX_CODEX_LINE_BYTES {
                self.context.discarding_partial_line = true;
                return Some((None, end_offset, self.context.clone()));
            }
            self.reader.seek(SeekFrom::Start(start_offset)).ok()?;
            return None;
        }
        if continuing_oversized_line {
            self.context.discarding_partial_line = false;
            return Some((None, end_offset, self.context.clone()));
        }

        let parsed = serde_json::from_slice::<Value>(&self.line);
        if reached_eof && self.line.last() != Some(&b'\n') && parsed.is_err() {
            // A live rollout may be observed mid-write. Retain the fragment
            // start so the next sync can parse the completed JSON record.
            self.reader.seek(SeekFrom::Start(start_offset)).ok()?;
            return None;
        }
        let row = parsed.ok().and_then(|record| {
            codex_usage_row_at(
                &record,
                &mut self.context,
                &self.rollout_identity,
                start_offset,
                end_offset,
            )
        });
        Some((row, end_offset, self.context.clone()))
    }
}

#[derive(Debug, Deserialize)]
struct UsageAck {
    ok: bool,
    written: usize,
    #[serde(default)]
    deduped: usize,
    #[serde(default)]
    skipped: Vec<Value>,
}

fn usage_ack_is_complete(ack: &UsageAck, event_count: usize) -> bool {
    if !ack.ok {
        return false;
    }

    let Some(skipped_indices) = ack
        .skipped
        .iter()
        .map(|entry| {
            entry
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|index| usize::try_from(index).ok())
        })
        .collect::<Option<Vec<_>>>()
    else {
        return false;
    };
    let unique_skipped_indices = skipped_indices
        .iter()
        .copied()
        .collect::<std::collections::HashSet<_>>();
    if unique_skipped_indices.len() != skipped_indices.len()
        || skipped_indices.iter().any(|index| *index >= event_count)
    {
        return false;
    }

    ack.written
        .checked_add(ack.deduped)
        .and_then(|settled| settled.checked_add(skipped_indices.len()))
        == Some(event_count)
}

fn usage_retry_delay_secs(consecutive_failures: u8) -> u64 {
    if consecutive_failures < 3 {
        return 0;
    }
    let exponent = u32::from(consecutive_failures.saturating_sub(3)).min(4);
    (5 * 60 * 2u64.pow(exponent)).min(60 * 60)
}

fn upload_backoff_remaining_secs(cursor: &TelemetryCursor, now_unix_secs: u64) -> Option<u64> {
    (cursor.consecutive_unaccepted_flushes >= 3 && now_unix_secs < cursor.retry_after_unix_secs)
        .then(|| cursor.retry_after_unix_secs - now_unix_secs)
}

fn record_unaccepted_flush(cursor: &mut TelemetryCursor, now_unix_secs: u64) {
    cursor.consecutive_unaccepted_flushes = cursor.consecutive_unaccepted_flushes.saturating_add(1);
    let delay_secs = usage_retry_delay_secs(cursor.consecutive_unaccepted_flushes);
    cursor.retry_after_unix_secs = if delay_secs == 0 {
        0
    } else {
        now_unix_secs.saturating_add(delay_secs)
    };
}

fn reset_unaccepted_flushes(cursor: &mut TelemetryCursor) {
    cursor.consecutive_unaccepted_flushes = 0;
    cursor.retry_after_unix_secs = 0;
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

#[derive(Debug, PartialEq, Eq)]
enum FlushOutcome {
    Accepted,
    Unaccepted { reason: &'static str },
    ConsentRevoked,
    BudgetReached,
}

impl FlushOutcome {
    fn is_accepted(&self) -> bool {
        matches!(self, Self::Accepted)
    }
}
const MAX_BATCH_BYTES: usize = 1_000_000;
const MAX_CODEX_BATCHES_PER_SYNC: usize = 4;
const MAX_CODEX_SCAN_BYTES_PER_SYNC: u64 = 4 * 1024 * 1024;
const MAX_CODEX_LINE_BYTES: u64 = 64 * 1024;

fn per_rollout_scan_budget(pending_count: usize) -> u64 {
    if pending_count == 0 {
        return 0;
    }
    (MAX_CODEX_SCAN_BYTES_PER_SYNC / pending_count as u64)
        .clamp(MAX_CODEX_LINE_BYTES, MAX_CODEX_SCAN_BYTES_PER_SYNC)
}

fn rollout_batch_allowance(index: usize, pending_count: usize) -> usize {
    if pending_count == 0 {
        return 0;
    }
    if pending_count > MAX_CODEX_BATCHES_PER_SYNC {
        return 1;
    }
    let base = MAX_CODEX_BATCHES_PER_SYNC / pending_count;
    base + usize::from(index < MAX_CODEX_BATCHES_PER_SYNC % pending_count)
}

fn rotate_rollouts_to_saved_start(
    rollouts: &mut [(String, RolloutFile)],
    saved_start: Option<&str>,
) {
    let Some(saved_start) = saved_start else {
        return;
    };
    if let Some(index) = rollouts
        .iter()
        .position(|(_, rollout)| normalize_cursor_file_key(&rollout.path) == saved_start)
    {
        rollouts.rotate_left(index);
    }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/// Scan ~/.claude/projects/**/*.jsonl, sanitize, and POST new events.
///
/// Dispatched from `handle_sync_line`'s AllComplete arm via
/// `tauri::async_runtime::spawn`. Errors are logged and swallowed — telemetry
/// must never abort or delay sync.
pub async fn send_telemetry_if_opted_in<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _hq_folder: &str,
    jwt: &str,
) -> Result<(), String> {
    send_telemetry_if_opted_in_at(_app, _hq_folder, jwt).await
}

async fn send_telemetry_if_opted_in_at<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _hq_folder: &str,
    jwt: &str,
) -> Result<(), String> {
    // 1. Build VaultClient
    let api_url = resolve_vault_api_url()?;
    let vault = VaultClient::new(&api_url, jwt);

    // 2. Opt-in check. Resolve server-first with the account-bound local fallback.
    if !resolve_telemetry_enabled(&vault).await {
        return Ok(());
    }

    // 3. Load cursor and schedule Codex rollouts only after opt-in succeeds.
    let home = telemetry_home_dir().ok_or("home dir unavailable")?;
    let _cursor_cycle_guard = TELEMETRY_CURSOR_CYCLE_LOCK.lock().await;
    let mut cursor = load_cursor();
    if let Some(remaining_secs) = upload_backoff_remaining_secs(&cursor, unix_now_secs()) {
        eprintln!(
            "[telemetry] usage upload skipped during backoff: consecutive_unaccepted_flushes={} retry_in_secs={remaining_secs}",
            cursor.consecutive_unaccepted_flushes
        );
        return Ok(());
    }
    let loaded_files = cursor.files.clone();
    let codex_candidates = codex_candidate_entries(&home.join(".codex"), &cursor);
    let mut newly_committed: HashMap<String, CursorEntry> = HashMap::new();
    let mut rotation_resets: HashMap<String, CursorEntry> = HashMap::new();

    // 4. Enumerate standard and named Claude activity folders.
    let claude_projects_roots = resolve_claude_projects_dirs(
        &home,
        &home.join(".hq/menubar.json"),
        std::env::var("CLAUDE_PROJECTS_DIR").ok().as_deref(),
        std::env::var("CLAUDE_CONFIG_DIR").ok().as_deref(),
    );
    let mut file_paths: Vec<_> = claude_projects_roots
        .into_iter()
        .flat_map(|root| {
            let pattern = format!(
                "{}/**/*.jsonl",
                glob::Pattern::escape(&root.to_string_lossy())
            );
            glob::glob(&pattern)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|path| path.is_file())
                .collect::<Vec<_>>()
        })
        .collect();
    file_paths.sort();
    file_paths.dedup();

    let machine_id = read_machine_id();
    let installer_version = crate::app_version::current().to_string();
    // Resolved once per collection run — a login-shell probe, not worth
    // repeating per batch. None (CLI absent/unresolvable) omits the field.
    let cli_version = crate::commands::hq_cli_update::get_hq_cli_version().await;
    let empty_batch_bytes = serde_json::to_vec(&json!({
        "machineId": machine_id,
        "installerVersion": installer_version,
        "events": []
    }))
    .expect("empty usage batch serializes")
    .len();
    let batch_overhead_bytes = empty_batch_bytes.saturating_sub(2); // remove `[]`
    let mut upload_plan =
        UsageUploadPlanner::for_desktop_usage(batch_overhead_bytes, MAX_BATCH_BYTES);
    let mut upload_failed = false;
    let mut sync_budget_reached = false;

    'claude_files: for file_path in &file_paths {
        let path_str = normalize_cursor_file_key(file_path);

        let metadata = match fs::metadata(file_path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let current_size = metadata.len();
        let current_mtime = mtime_secs(&metadata);

        let stored = cursor.files.get(&path_str).cloned().unwrap_or_default();
        let mut offset = stored.offset;

        // File-rotation safety: if file shrank or mtime went backwards
        let rotated = current_size < offset || (stored.mtime > 0 && current_mtime < stored.mtime);
        if rotated {
            offset = 0;
            // Mark the reset so we persist it even if there are 0 rows
            rotation_resets.insert(
                path_str.clone(),
                CursorEntry {
                    offset: 0,
                    mtime: current_mtime,
                    context: None,
                },
            );
        }

        if offset >= current_size && !rotated {
            // Nothing new to read
            continue;
        }

        // Open and seek
        let mut file = match fs::File::open(file_path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        if offset > 0 && file.seek(SeekFrom::Start(offset)).is_err() {
            continue;
        }
        let mut content = String::new();
        if file.read_to_string(&mut content).is_err() {
            continue;
        }

        if content.is_empty() {
            continue;
        }

        // Compute line end-offsets within the file
        let segments: Vec<&str> = content.split('\n').collect();
        let n = segments.len();
        let mut cumulative: u64 = 0;
        let line_end_offsets: Vec<u64> = segments
            .iter()
            .enumerate()
            .map(|(i, seg)| {
                cumulative += seg.len() as u64;
                if i < n - 1 {
                    cumulative += 1; // account for the '\n' separator
                }
                offset + cumulative
            })
            .collect();

        for (i, seg) in segments.iter().enumerate() {
            let trimmed = seg.trim();
            if trimmed.is_empty() {
                continue;
            }
            let parsed: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let sanitized = match sanitize_row(&parsed) {
                Some(v) => v,
                None => continue,
            };

            if !single_event_fits(&machine_id, &installer_version, &sanitized) {
                upload_plan.record_source(UsageUploadSource {
                    file_path: path_str.clone(),
                    end_offset: line_end_offsets[i],
                    mtime: current_mtime,
                    context: None,
                });
                continue;
            }

            let source = UsageUploadSource {
                file_path: path_str.clone(),
                end_offset: line_end_offsets[i],
                mtime: current_mtime,
                context: None,
            };
            loop {
                match upload_plan.add_event(sanitized.clone(), source.clone()) {
                    Ok(AddUsageEvent::Added) => break,
                    Ok(AddUsageEvent::TooLarge) => {
                        eprintln!("[telemetry] usage row exceeds batch cap; leaving source offset uncommitted");
                        upload_failed = true;
                        break 'claude_files;
                    }
                    Ok(AddUsageEvent::FlushCurrentBatch) => {
                        let batch = upload_plan.take_batch().expect("planner requested a flush");
                        match flush_batch(
                            &vault,
                            &api_url,
                            jwt,
                            &machine_id,
                            &installer_version,
                            cli_version.as_deref(),
                            &mut cursor,
                            unix_now_secs(),
                            &mut upload_plan,
                            batch,
                            &mut newly_committed,
                        )
                        .await
                        {
                            FlushOutcome::Accepted if upload_plan.budget_exhausted() => {
                                sync_budget_reached = true;
                                break 'claude_files;
                            }
                            FlushOutcome::Accepted => continue,
                            FlushOutcome::BudgetReached => {
                                sync_budget_reached = true;
                                break 'claude_files;
                            }
                            FlushOutcome::Unaccepted { .. } | FlushOutcome::ConsentRevoked => {
                                upload_failed = true;
                                break 'claude_files;
                            }
                        }
                    }
                    Err(_) => {
                        upload_failed = true;
                        break 'claude_files;
                    }
                }
            }
        }
    }

    // Stream Codex token-count events through the same size cap and commit
    // tracking as Claude rows. Enumeration includes every rollout regardless of
    // originator or thread source.
    let mut codex_batches_sent = 0usize;
    let mut codex_bytes_scanned = 0u64;
    let mut codex_next_rollout = cursor.codex_next_rollout.clone();
    if !upload_failed && !sync_budget_reached {
        let rollouts = codex_rollouts_freshest_first(&home.join(".codex"));
        let mut pending_rollouts: Vec<_> = rollouts
            .into_iter()
            .filter(|(_, rollout)| {
                let path = normalize_cursor_file_key(&rollout.path);
                codex_candidates
                    .get(&path)
                    .is_some_and(|entry| entry.offset < rollout.size)
            })
            .collect();
        rotate_rollouts_to_saved_start(&mut pending_rollouts, cursor.codex_next_rollout.as_deref());
        let pending_count = pending_rollouts.len();
        let pending_paths: Vec<_> = pending_rollouts
            .iter()
            .map(|(_, rollout)| normalize_cursor_file_key(&rollout.path))
            .collect();
        let per_rollout_scan_budget = per_rollout_scan_budget(pending_count);
        let mut hit_sync_limit = false;
        codex_next_rollout = None;
        'codex_files: for (rollout_index, (filename_session_id, rollout)) in
            pending_rollouts.into_iter().enumerate()
        {
            let path_str = normalize_cursor_file_key(&rollout.path);
            let Some(candidate) = codex_candidates.get(&path_str) else {
                continue;
            };
            if candidate.offset >= rollout.size {
                continue;
            }

            let Ok(mut scanner) = CodexRolloutScanner::open(
                &rollout.path,
                candidate.offset,
                &filename_session_id,
                candidate.context.clone(),
            ) else {
                continue;
            };
            let mut previous_offset = candidate.offset;

            let mut rollout_bytes_scanned = 0u64;
            let mut rollout_batches_sent = 0usize;
            let rollout_batch_allowance = rollout_batch_allowance(rollout_index, pending_count);
            'rollout_records: loop {
                let global_remaining =
                    MAX_CODEX_SCAN_BYTES_PER_SYNC.saturating_sub(codex_bytes_scanned);
                if global_remaining == 0 {
                    hit_sync_limit = true;
                    codex_next_rollout = pending_paths.get(rollout_index).cloned();
                    break 'codex_files;
                }
                let file_remaining = per_rollout_scan_budget.saturating_sub(rollout_bytes_scanned);
                if file_remaining == 0 {
                    break;
                }
                let remaining = global_remaining.min(file_remaining);
                let Some((sanitized, end_offset, context)) = scanner.next_bounded(remaining) else {
                    if global_remaining < MAX_CODEX_LINE_BYTES && previous_offset < rollout.size {
                        hit_sync_limit = true;
                        codex_next_rollout = pending_paths.get(rollout_index).cloned();
                        break 'codex_files;
                    }
                    break;
                };
                let scanned = end_offset.saturating_sub(previous_offset);
                codex_bytes_scanned = codex_bytes_scanned.saturating_add(scanned);
                rollout_bytes_scanned = rollout_bytes_scanned.saturating_add(scanned);
                previous_offset = end_offset;

                let source = UsageUploadSource {
                    file_path: path_str.clone(),
                    end_offset,
                    mtime: system_time_secs(rollout.mtime),
                    context: Some(
                        serde_json::to_value(&context).expect("Codex context serializes"),
                    ),
                };
                if let Some(sanitized) = sanitized {
                    loop {
                        match upload_plan.add_event(sanitized.clone(), source.clone()) {
                            Ok(AddUsageEvent::Added) => break,
                            Ok(AddUsageEvent::TooLarge) => {
                                eprintln!("[telemetry] usage row exceeds batch cap; leaving source offset uncommitted");
                                upload_failed = true;
                                break 'codex_files;
                            }
                            Ok(AddUsageEvent::FlushCurrentBatch) => {
                                let batch =
                                    upload_plan.take_batch().expect("planner requested a flush");
                                let batch_contains_codex = batch.contains_codex();
                                match flush_batch(
                                    &vault,
                                    &api_url,
                                    jwt,
                                    &machine_id,
                                    &installer_version,
                                    cli_version.as_deref(),
                                    &mut cursor,
                                    unix_now_secs(),
                                    &mut upload_plan,
                                    batch,
                                    &mut newly_committed,
                                )
                                .await
                                {
                                    FlushOutcome::Accepted => {
                                        if batch_contains_codex {
                                            codex_batches_sent += 1;
                                            rollout_batches_sent += 1;
                                            if codex_batches_sent >= MAX_CODEX_BATCHES_PER_SYNC {
                                                hit_sync_limit = true;
                                                codex_next_rollout = pending_paths
                                                    .get((rollout_index + 1) % pending_count)
                                                    .cloned();
                                                break 'codex_files;
                                            }
                                            if rollout_batches_sent >= rollout_batch_allowance {
                                                hit_sync_limit = true;
                                                codex_next_rollout = pending_paths
                                                    .get((rollout_index + 1) % pending_count)
                                                    .cloned();
                                                break 'rollout_records;
                                            }
                                        }
                                        if upload_plan.budget_exhausted() {
                                            hit_sync_limit = true;
                                            codex_next_rollout =
                                                pending_paths.get(rollout_index).cloned();
                                            sync_budget_reached = true;
                                            break 'codex_files;
                                        }
                                        continue;
                                    }
                                    FlushOutcome::BudgetReached => {
                                        hit_sync_limit = true;
                                        codex_next_rollout =
                                            pending_paths.get(rollout_index).cloned();
                                        sync_budget_reached = true;
                                        break 'codex_files;
                                    }
                                    FlushOutcome::Unaccepted { .. }
                                    | FlushOutcome::ConsentRevoked => {
                                        upload_failed = true;
                                        break 'codex_files;
                                    }
                                }
                            }
                            Err(_) => {
                                upload_failed = true;
                                break 'codex_files;
                            }
                        }
                    }
                }
                upload_plan.record_source(source);

                if codex_bytes_scanned >= MAX_CODEX_SCAN_BYTES_PER_SYNC {
                    hit_sync_limit = true;
                    codex_next_rollout = pending_paths
                        .get((rollout_index + 1) % pending_count)
                        .cloned();
                    break 'codex_files;
                }
                if rollout_bytes_scanned >= per_rollout_scan_budget {
                    break;
                }
            }
        }
        if !hit_sync_limit && !upload_failed && !sync_budget_reached {
            codex_next_rollout = None;
        }
    }

    // POST pending emitted rows before committing their scanned-line progress.
    // A zero-event scan slice can advance locally without making a request.
    if !upload_failed && !sync_budget_reached {
        if let Some(batch) = upload_plan.take_batch() {
            let _ = flush_batch(
                &vault,
                &api_url,
                jwt,
                &machine_id,
                &installer_version,
                cli_version.as_deref(),
                &mut cursor,
                unix_now_secs(),
                &mut upload_plan,
                batch,
                &mut newly_committed,
            )
            .await;
        } else if let Some(sources) = upload_plan.take_zero_event_sources() {
            commit_acknowledged_sources(&sources, &mut newly_committed);
        }
    }

    // Build final cursor: loaded < Codex candidates < rotation resets < commits
    let mut final_files = loaded_files;
    for (fp, entry) in codex_candidates {
        final_files.insert(fp, entry);
    }
    for (fp, entry) in rotation_resets {
        final_files.insert(fp, entry);
    }
    for (fp, entry) in newly_committed {
        final_files.insert(fp, entry);
    }

    // 7. Atomic cursor write
    let final_cursor = TelemetryCursor {
        version: "1".to_string(),
        files: final_files,
        codex_next_rollout,
        consecutive_unaccepted_flushes: cursor.consecutive_unaccepted_flushes,
        retry_after_unix_secs: cursor.retry_after_unix_secs,
    };
    save_cursor(&final_cursor)?;

    Ok(())
}

/// Build the existing batch-size estimate used by the collector.
fn build_wire_payload(
    machine_id: &str,
    installer_version: &str,
    existing: &[Value],
    candidate: &Value,
) -> Vec<u8> {
    let mut events = existing.to_vec();
    events.push(candidate.clone());
    let payload = json!({
        "machineId": machine_id,
        "installerVersion": installer_version,
        "events": events,
    });
    serde_json::to_vec(&payload).unwrap_or_default()
}

fn single_event_fits(machine_id: &str, installer_version: &str, event: &Value) -> bool {
    build_wire_payload(machine_id, installer_version, &[], event).len() <= MAX_BATCH_BYTES
}

fn commit_acknowledged_sources(
    sources: &[UsageUploadSource],
    newly_committed: &mut HashMap<String, CursorEntry>,
) {
    let mut max_per_file: HashMap<String, CursorEntry> = HashMap::new();
    for src in sources {
        let entry = CursorEntry {
            offset: src.end_offset,
            mtime: src.mtime,
            context: src.context.as_ref().map(|context| {
                serde_json::from_value(context.clone())
                    .expect("Codex context from the rollout scanner must round-trip")
            }),
        };
        max_per_file
            .entry(src.file_path.clone())
            .and_modify(|current| {
                if entry.offset > current.offset {
                    *current = entry.clone();
                }
            })
            .or_insert(entry);
    }
    newly_committed.extend(max_per_file);
}

async fn flush_batch(
    vault: &VaultClient,
    api_url: &str,
    jwt: &str,
    machine_id: &str,
    installer_version: &str,
    cli_version: Option<&str>,
    cursor: &mut TelemetryCursor,
    cycle_started_at_unix_secs: u64,
    planner: &mut UsageUploadPlanner,
    plan_batch: UsageUploadBatch,
    newly_committed: &mut HashMap<String, CursorEntry>,
) -> FlushOutcome {
    // Consent is checked at the request boundary, including the first and only
    // batch in a cycle. A withdrawal while files are being scanned must prevent
    // the pending payload from ever leaving the machine.
    if !resolve_telemetry_enabled(vault).await {
        return FlushOutcome::ConsentRevoked;
    }
    let wire_batch = UsageBatch {
        machine_id: machine_id.to_string(),
        installer_version: installer_version.to_string(),
        cli_version: cli_version.map(str::to_string),
        events: plan_batch.events.clone(),
    };
    let event_count = wire_batch.events.len();
    let body = match serde_json::to_vec(&wire_batch) {
        Ok(body) => body,
        Err(_) => {
            eprintln!("[telemetry] usage flush not accepted: serialization_failed");
            record_unaccepted_flush(cursor, unix_now_secs().max(cycle_started_at_unix_secs));
            return FlushOutcome::Unaccepted {
                reason: "serialization_failed",
            };
        }
    };
    if !planner.reserve_request(body.len()) {
        return FlushOutcome::BudgetReached;
    }

    let response = match build_client()
        .post(format!("{}/v1/usage", api_url.trim_end_matches('/')))
        .bearer_auth(jwt)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => {
            eprintln!("[telemetry] usage flush not accepted: request_failed");
            record_unaccepted_flush(cursor, unix_now_secs().max(cycle_started_at_unix_secs));
            return FlushOutcome::Unaccepted {
                reason: "request_failed",
            };
        }
    };

    let status = response.status();
    if !status.is_success() {
        eprintln!(
            "[telemetry] usage flush not accepted: http_status={}",
            status.as_u16()
        );
        record_unaccepted_flush(cursor, unix_now_secs().max(cycle_started_at_unix_secs));
        return FlushOutcome::Unaccepted {
            reason: "http_status",
        };
    }

    let ack = match response.json::<UsageAck>().await {
        Ok(ack) => ack,
        Err(_) => {
            eprintln!(
                "[telemetry] usage flush not accepted: http_status={} unparseable_ack",
                status.as_u16()
            );
            record_unaccepted_flush(cursor, unix_now_secs().max(cycle_started_at_unix_secs));
            return FlushOutcome::Unaccepted {
                reason: "unparseable_ack",
            };
        }
    };

    let skipped_count = ack.skipped.len();
    if usage_ack_is_complete(&ack, event_count) {
        let sources = UsageUploadPlanner::committable_sources(&plan_batch, true);
        commit_acknowledged_sources(&sources, newly_committed);
        reset_unaccepted_flushes(cursor);
        if skipped_count > 0 {
            eprintln!(
                "[telemetry] usage flush settled with skipped rows: http_status={} ok={} written={} deduped={} skipped={skipped_count}",
                status.as_u16(),
                ack.ok,
                ack.written,
                ack.deduped
            );
        }
        FlushOutcome::Accepted
    } else {
        let reason = if ack.ok {
            "ack_count_mismatch"
        } else {
            "ack_not_ok"
        };
        eprintln!(
            "[telemetry] usage flush not accepted: http_status={} ok={} written={} deduped={} skipped={} reason={reason}",
            status.as_u16(),
            ack.ok,
            ack.written,
            ack.deduped,
            skipped_count
        );
        // Any partial/malformed acknowledgment retains the whole source range.
        // Continuing could acknowledge a later batch from the same file and
        // advance its cursor across this unacknowledged gap.
        record_unaccepted_flush(cursor, unix_now_secs().max(cycle_started_at_unix_secs));
        FlushOutcome::Unaccepted { reason }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod codex_telemetry_tests {
    use super::*;
    use crate::util::test_support::{scoped_home, ENV_MUTEX};
    use serde_json::json;
    use std::fs;
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn post_ready_return_nudge_outcome_is_bounded() {
        let shown = sanitize_post_ready_action_properties(Some(json!({
            "action": "start_sync",
            "returnNudge": "shown",
        })));
        assert_eq!(shown["returnNudge"], "shown");
        for value in ["free text", "opened", "clicked elsewhere"] {
            let sanitized = sanitize_post_ready_action_properties(Some(json!({
                "action": "start_sync",
                "returnNudge": value,
            })));
            assert!(sanitized.get("returnNudge").is_none(), "{value}");
        }
    }

    #[test]
    fn post_ready_action_sanitizer_keeps_all_supported_actions_and_drops_unknown() {
        for action in ["ready_first_action_shown", "ready_first_action_clicked"] {
            let sanitized = sanitize_post_ready_action_properties(Some(json!({
                "action": action,
            })));
            assert_eq!(sanitized["action"], action);
        }

        let sanitized = sanitize_post_ready_action_properties(Some(json!({
            "action": "unknown_action",
        })));
        assert!(sanitized.get("action").is_none());
    }

    #[test]
    fn post_ready_drop_reason_sanitizer_keeps_only_bounded_reason_and_action() {
        let accepted = sanitize_post_ready_action_dropped_properties(Some(json!({
            "reason": "identity_missing",
            "action": "ready_first_action_clicked",
            "privateDetail": "discard me",
        })));
        assert_eq!(accepted, json!({
            "reason": "identity_missing",
            "action": "ready_first_action_clicked",
        }));

        let session_ended = sanitize_post_ready_action_dropped_properties(Some(json!({
            "reason": "session_ended",
            "action": "open_folder",
        })));
        assert_eq!(session_ended, json!({
            "reason": "session_ended",
            "action": "open_folder",
        }));

        for (properties, expected) in [
            (
                json!({ "reason": "free text", "action": "open_folder" }),
                json!({ "action": "open_folder" }),
            ),
            (
                json!({ "reason": "flag_off", "action": "free text" }),
                json!({ "reason": "flag_off" }),
            ),
            (
                json!({ "reason": 7, "action": "open_folder" }),
                json!({ "action": "open_folder" }),
            ),
        ] {
            let sanitized = sanitize_post_ready_action_dropped_properties(Some(properties));
            assert_eq!(sanitized, expected);
        }
    }

    #[test]
    fn first_sync_completion_lifts_company_uid_without_exposing_it_as_a_property() {
        let event = build_desktop_telemetry_event(
            crate::commands::cdp_mirror::OP_SYNC_COMPLETED.to_string(),
            Some(json!({
                "trigger": "first",
                "flow": "runner",
                "companyUid": "cmp_first-sync",
            })),
            None,
            None,
            "no-consent",
        );
        assert_eq!(event.company_uid.as_deref(), Some("cmp_first-sync"));
        assert!(event.properties.get("companyUid").is_none());

        let unrelated = build_desktop_telemetry_event(
            crate::commands::cdp_mirror::OP_SYNC_STARTED.to_string(),
            Some(json!({
                "trigger": "first",
                "flow": "runner",
                "companyUid": "cmp_first-sync",
            })),
            None,
            None,
            "no-consent",
        );
        assert!(unrelated.company_uid.is_none());
    }

    #[test]
    fn company_step_route_row_keeps_decision_counts_and_lifts_company_uid() {
        let event = build_desktop_telemetry_event(
            "desktop_onboarding_step".to_string(),
            Some(json!({
                "step": "company",
                "action": "started",
                "outcome": "joined_invite",
                "decision": "joined_invite",
                "existingCompanies": 0,
                "paidCompany": false,
                "pendingInvites": 1,
                "companyUid": "cmp_company-1",
                "email": "ada@example.com",
            })),
            Some("session-1".to_string()),
            None,
            "no-consent",
        );
        assert_eq!(event.company_uid.as_deref(), Some("cmp_company-1"));
        assert_eq!(event.properties["decision"], "joined_invite");
        assert_eq!(event.properties["existingCompanies"], 0);
        assert_eq!(event.properties["paidCompany"], false);
        assert_eq!(event.properties["pendingInvites"], 1);
        assert!(event.properties.get("email").is_none());
        assert!(event.properties.get("companyUid").is_none());
    }

    #[test]
    fn invite_teammate_outcomes_lift_company_uid_and_missing_company_is_explicit() {
        for action in ["entered", "completed", "skipped", "failed"] {
            let event = build_desktop_telemetry_event(
                "desktop_onboarding_step".to_string(),
                Some(json!({
                    "step": "invite-teammate",
                    "action": action,
                    "companyUid": "cmp_company-1",
                })),
                Some("session-1".to_string()),
                None,
                "no-consent",
            );
            assert_eq!(event.company_uid.as_deref(), Some("cmp_company-1"), "{action}");
        }

        let missing = build_desktop_telemetry_event(
            "desktop_onboarding_step".to_string(),
            Some(json!({
                "step": "invite-teammate",
                "action": "entered",
                "companyUidMissing": true,
            })),
            Some("session-2".to_string()),
            None,
            "no-consent",
        );
        assert!(missing.company_uid.is_none());
        assert_eq!(missing.properties["companyUidMissing"], true);
    }

    #[test]
    fn invite_step_sent_count_is_bounded_to_twenty() {
        let valid = sanitize_desktop_properties(Some(json!({
            "step": "invite-teammate",
            "action": "completed",
            "invitesSent": 20,
        })));
        assert_eq!(valid["invitesSent"], 20);

        let too_large = sanitize_desktop_properties(Some(json!({
            "step": "invite-teammate",
            "action": "completed",
            "invitesSent": 21,
        })));
        assert!(too_large.get("invitesSent").is_none());
    }

    #[test]
    fn self_heal_row_lifts_company_uid_but_other_steps_do_not() {
        let heal = build_desktop_telemetry_event(
            "desktop_onboarding_step".to_string(),
            Some(json!({
                "step": "first-folder-sync",
                "action": "started",
                "selfHeal": "triggered",
                "companyUid": "cmp_company-2",
            })),
            None,
            None,
            "no-consent",
        );
        assert_eq!(heal.company_uid.as_deref(), Some("cmp_company-2"));
        assert_eq!(heal.properties["selfHeal"], "triggered");

        let other = build_desktop_telemetry_event(
            "desktop_onboarding_step".to_string(),
            Some(json!({"step": "welcome-signin", "action": "entered", "companyUid": "cmp_x"})),
            None,
            None,
            "no-consent",
        );
        assert!(other.company_uid.is_none());
    }

    #[test]
    fn post_ready_action_event_keeps_only_join_fields_and_server_environment() {
        let event = build_desktop_telemetry_event(
            "desktop_post_ready_action".to_string(),
            Some(json!({
                "action": "open_folder",
                "personUid": "prs_person-1",
                "companyUid": "cmp_company-1",
                "idempotencyKey": "post-ready.session-1.open_folder",
                "folderName": "Private Project",
                "path": "/Users/ada/Private Project",
            })),
            Some("session-1".to_string()),
            None,
            "no-consent",
        );

        assert_eq!(event.company_uid.as_deref(), Some("cmp_company-1"));
        assert_eq!(
            event.idempotency_key.as_deref(),
            Some("post-ready.session-1.open_folder")
        );
        assert_eq!(event.properties["action"], "open_folder");
        assert_eq!(event.properties["personUid"], "prs_person-1");
        assert_eq!(event.properties["companyUid"], "cmp_company-1");
        assert_eq!(
            event.properties["appVersion"],
            crate::app_version::current()
        );
        assert_eq!(event.properties["os"], std::env::consts::OS);
        assert!(event.properties.get("folderName").is_none());
        assert!(event.properties.get("path").is_none());
    }

    #[test]
    fn core_update_lifecycle_properties_survive_sanitization_without_paths_or_errors() {
        let sanitized = sanitize_desktop_properties(Some(json!({
            "source": "automatic",
            "result": "failed",
            "errorKind": "rescue_exit",
            "channel": "release",
            "desktopVersion": "0.10.167",
            "localCoreVersion": "15.0.4",
            "targetCoreVersion": "15.0.117",
            "autoUpdateEnabled": true,
            "eligible": true,
            "versionBehind": true,
            "durationMs": 4200,
            "exitCode": 1,
            "skipReason": "automatic_updates_disabled",
            "platform": "macos-aarch64",
            "errorCategory": "dns",
            "deferralCount": 10,
            "firstDeferralAgeSeconds": 21600,
            "lockTimeoutSeconds": 900,
            "holdReason": "timeout",
            "requiredGitVersion": "2.19.0",
            "detectedGitVersion": "2.15.0",
            "npxResolved": false,
            "npxResolution": "not_resolved",
            "logPath": "/Users/alice/private/core-update.log",
            "error": "raw subprocess output must not leave the client"
        })));

        assert_eq!(sanitized["source"], "automatic");
        assert_eq!(sanitized["result"], "failed");
        assert_eq!(sanitized["errorKind"], "rescue_exit");
        assert_eq!(sanitized["channel"], "release");
        assert_eq!(sanitized["desktopVersion"], "0.10.167");
        assert_eq!(sanitized["localCoreVersion"], "15.0.4");
        assert_eq!(sanitized["targetCoreVersion"], "15.0.117");
        assert_eq!(sanitized["autoUpdateEnabled"], true);
        assert_eq!(sanitized["eligible"], true);
        assert_eq!(sanitized["versionBehind"], true);
        assert_eq!(sanitized["durationMs"], 4200);
        assert_eq!(sanitized["exitCode"], 1);
        assert_eq!(sanitized["skipReason"], "automatic_updates_disabled");
        assert_eq!(sanitized["platform"], "macos-aarch64");
        assert_eq!(sanitized["errorCategory"], "dns");
        assert_eq!(sanitized["deferralCount"], 10);
        assert_eq!(sanitized["firstDeferralAgeSeconds"], 21600);
        assert_eq!(sanitized["lockTimeoutSeconds"], 900);
        assert_eq!(sanitized["holdReason"], "timeout");
        assert_eq!(sanitized["requiredGitVersion"], "2.19.0");
        assert_eq!(sanitized["detectedGitVersion"], "2.15.0");
        assert_eq!(sanitized["npxResolved"], false);
        assert_eq!(sanitized["npxResolution"], "not_resolved");
        assert!(sanitized.get("logPath").is_none());
        assert!(sanitized.get("error").is_none());
    }

    #[test]
    fn setup_symlink_failure_diagnostics_survive_only_as_bounded_values() {
        let sanitized = sanitize_desktop_properties(Some(json!({
            "step": "setup",
            "errorOperation": "remove_existing_link",
            "errorIoKind": "permission_denied",
            "errorCode": 5,
            "path": "C:\\Users\\person\\HQ"
        })));

        assert_eq!(sanitized["errorOperation"], "remove_existing_link");
        assert_eq!(sanitized["errorIoKind"], "permission_denied");
        assert_eq!(sanitized["errorCode"], 5);
        assert!(sanitized.get("path").is_none());

        let unsafe_values = sanitize_desktop_properties(Some(json!({
            "errorOperation": "C:\\Users\\person\\HQ",
            "errorIoKind": "/Users/person/HQ",
            "errorCode": 65_536
        })));
        assert!(unsafe_values.get("errorOperation").is_none());
        assert!(unsafe_values.get("errorIoKind").is_none());
        assert!(unsafe_values.get("errorCode").is_none());
    }

    #[test]
    fn cdp_funnel_rows_are_operational_and_keep_their_props() {
        let samples = json!({
            "isFirstLaunch": true,
            "userHash": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "companyHash": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "provider": "claude",
            "surface": "terminal",
            "success": false,
            "errorClass": "not_found",
            "trigger": "manual",
            "flow": "runner",
            "downloadedCount": 12,
            "count": 1,
            "route": "onboarding",
            "plan": "workforce",
        });
        for (op, _, keys) in crate::commands::cdp_mirror::OPERATIONAL_MIRRORS {
            assert!(is_operational_desktop_event_name(op), "{op} not approved");
            let input: Map<String, Value> = keys
                .iter()
                .map(|key| ((*key).to_string(), samples[*key].clone()))
                .collect();
            let out = sanitize_desktop_properties(Some(Value::Object(input)));
            for key in keys.iter() {
                assert_eq!(out[*key], samples[*key], "{op}.{key} dropped");
            }
        }
        // Identifiers and emails never pass, whatever the row.
        let leaky = sanitize_desktop_properties(Some(json!({
            "userHash": "prs_01ABC@example.com",
            "personUid": "prs_01ABC",
            "inviteeEmail": "a@b.c",
        })));
        assert!(leaky.as_object().unwrap().is_empty(), "{leaky}");
    }

    #[test]
    fn invite_step_failure_keeps_error_kind_and_bounded_http_status() {
        let sanitized = sanitize_desktop_properties(Some(json!({
            "step": "invite-teammate",
            "action": "failed",
            "errorKind": "plan_limit",
            "statusCode": 402,
            "inviteeEmail": "person@example.com"
        })));
        assert_eq!(sanitized["errorKind"], "plan_limit");
        assert_eq!(sanitized["statusCode"], 402);
        assert!(sanitized.get("inviteeEmail").is_none());

        for bad in [json!(99), json!(600), json!(-1), json!("409")] {
            let sanitized = sanitize_desktop_properties(Some(json!({
                "step": "invite-teammate",
                "statusCode": bad
            })));
            assert!(sanitized.get("statusCode").is_none());
        }
    }

    #[test]
    fn deps_retry_diagnostics_survive_only_as_closed_failed_setup_values() {
        let event = build_desktop_telemetry_event(
            "desktop_onboarding_step".to_string(),
            Some(json!({
                "step": "setup",
                "action": "failed",
                "component": "deps",
                "retryAttempted": true,
                "retryResult": "failed-again",
                "depsOperation": "git",
                "shellOutput": "private command output",
            })),
            Some("session-1".to_string()),
            None,
            "no-consent",
        );
        assert_eq!(event.properties["retryAttempted"], true);
        assert_eq!(event.properties["retryResult"], "failed-again");
        assert_eq!(event.properties["depsOperation"], "git");
        assert!(event.properties.get("shellOutput").is_none());

        let invalid = build_desktop_telemetry_event(
            "desktop_onboarding_step".to_string(),
            Some(json!({
                "step": "setup",
                "action": "failed",
                "component": "deps",
                "retryAttempted": "yes",
                "retryResult": "ran npm install from /private/path",
                "depsOperation": "/private/path/git",
            })),
            Some("session-2".to_string()),
            None,
            "no-consent",
        );
        assert!(invalid.properties.get("retryAttempted").is_none());
        assert!(invalid.properties.get("retryResult").is_none());
        assert!(invalid.properties.get("depsOperation").is_none());

        let wrong_scope = build_desktop_telemetry_event(
            "desktop_onboarding_step".to_string(),
            Some(json!({
                "step": "setup",
                "action": "completed",
                "component": "deps",
                "retryAttempted": true,
                "retryResult": "recovered",
                "depsOperation": "git",
            })),
            Some("session-3".to_string()),
            None,
            "no-consent",
        );
        assert!(wrong_scope.properties.get("retryAttempted").is_none());
        assert!(wrong_scope.properties.get("retryResult").is_none());
        assert!(wrong_scope.properties.get("depsOperation").is_none());
    }

    #[test]
    fn symlink_diagnostics_are_only_emitted_for_failed_content_setup_steps() {
        let failed_content = json!({
            "step": "setup",
            "action": "failed",
            "component": "content",
            "errorOperation": "remove_existing_link",
            "errorIoKind": "permission_denied",
            "errorCode": 5
        });
        let event = build_desktop_telemetry_event(
            "desktop_onboarding_step".to_string(),
            Some(failed_content.clone()),
            None,
            None,
            "no-consent",
        );
        assert_eq!(event.properties["errorOperation"], "remove_existing_link");
        assert_eq!(event.properties["errorIoKind"], "permission_denied");
        assert_eq!(event.properties["errorCode"], 5);

        let succeeded = build_desktop_telemetry_event(
            "desktop_onboarding_step".to_string(),
            Some(json!({
                "step": "setup",
                "action": "completed",
                "component": "content",
                "errorOperation": "remove_existing_link",
                "errorIoKind": "permission_denied",
                "errorCode": 5
            })),
            None,
            None,
            "no-consent",
        );
        assert!(succeeded.properties.get("errorOperation").is_none());
        assert!(succeeded.properties.get("errorIoKind").is_none());
        assert!(succeeded.properties.get("errorCode").is_none());

        let other_event = build_desktop_telemetry_event(
            "desktop_setup_completed".to_string(),
            Some(failed_content),
            None,
            None,
            "no-consent",
        );
        assert!(other_event.properties.get("errorOperation").is_none());
        assert!(other_event.properties.get("errorIoKind").is_none());
        assert!(other_event.properties.get("errorCode").is_none());
    }

    #[test]
    fn core_update_failure_drops_raw_rescue_diagnostics_from_telemetry() {
        let event = build_desktop_telemetry_event(
            "core_update_failed".to_string(),
            Some(json!({
                "errorKind": "rescue_exit",
                "exitCode": 5,
                "errorCategory": "dns",
                "rescueStderrTail": "fatal: could not clone hq-core"
            })),
            None,
            None,
            "consent",
        );

        assert_eq!(event.properties["exitCode"], 5);
        assert_eq!(event.properties["errorCategory"], "dns");
        assert!(event.properties.get("rescueStderrTail").is_none());
    }

    #[test]
    fn core_update_failure_preserves_missing_dependency_category() {
        let event = build_desktop_telemetry_event(
            "core_update_failed".to_string(),
            Some(json!({
                "errorCategory": "missing-dependency",
            })),
            None,
            None,
            "consent",
        );

        assert_eq!(event.properties["errorCategory"], "missing-dependency");
    }

    #[test]
    fn npx_resolution_is_limited_to_its_closed_vocabulary() {
        for value in NPX_RESOLUTION_VALUES {
            let sanitized = sanitize_desktop_properties(Some(json!({
                "npxResolution": value,
            })));
            assert_eq!(sanitized["npxResolution"], *value);
        }

        let sanitized = sanitize_desktop_properties(Some(json!({
            "npxResolution": "/Users/alice/.npm/bin/npx",
        })));
        assert_eq!(sanitized["npxResolution"], "unknown");
    }

    #[test]
    fn desktop_property_allowlist_keeps_existing_setup_and_core_update_keys() {
        assert_eq!(
            ALLOWED_DESKTOP_PROPERTY_KEYS,
            &[
                "provider",
                "surface",
                "source",
                "result",
                "errorKind",
                "channel",
                "stage",
                "fromVersion",
                "toVersion",
                "desktopVersion",
                "appVersion",
                "localCoreVersion",
                "targetCoreVersion",
                "autoUpdateEnabled",
                "autoUpdate",
                "eligible",
                "versionBehind",
                "durationMs",
                "exitCode",
                "skipReason",
                "enabled",
                "registered",
                "companiesAttempted",
                "filesDownloaded",
                "bytesDownloaded",
                "filesSkipped",
                "errorCount",
                "stageCount",
                "failedStageCount",
                "failedStages",
                "detectedToolCount",
                "detectedSourceSet",
                "step",
                "component",
                "action",
                "flow",
                "outcome",
                "platform",
                "attemptCount",
                "failedDependency",
                "retryAttempted",
                "retryResult",
                "depsOperation",
                "errorCategory",
                "failureStage",
                "setupRunId",
                "npxResolved",
                "npxResolution",
                "errorOperation",
                "errorIoKind",
                "errorCode",
                "statusCode",
                "deferralCount",
                "firstDeferralAgeSeconds",
                "lockTimeoutSeconds",
                "holdReason",
                "requiredGitVersion",
                "detectedGitVersion",
                "found",
                "companyUidMissing",
                "invitesSent",
                "existingCompanies",
                "paidCompany",
                "pendingInvites",
                "decision",
                "provisioningStep",
                "selfHeal",
                "isFirstLaunch",
                "userHash",
                "companyHash",
                "success",
                "errorClass",
                "trigger",
                "downloadedCount",
                "count",
                "route",
                "plan",
            ]
        );
        for key in ALLOWED_DESKTOP_PROPERTY_KEYS {
            assert!(allowed_desktop_property_key(key));
        }
    }

    #[test]
    fn setup_failure_labels_survive_only_when_in_the_closed_vocabularies() {
        for dependency in FAILED_DEPENDENCY_VALUES {
            let sanitized = sanitize_desktop_properties(Some(json!({
                "failedDependency": dependency,
            })));
            assert_eq!(sanitized["failedDependency"], *dependency);
        }
        for category in ERROR_CATEGORY_VALUES {
            let sanitized = sanitize_desktop_properties(Some(json!({
                "errorCategory": category,
            })));
            assert_eq!(sanitized["errorCategory"], *category);
        }

        let sanitized = sanitize_desktop_properties(Some(json!({
            "failedDependency": "private-package",
            "errorCategory": "C:\\\\Users\\\\alice\\\\HQ\\\\error.txt",
        })));
        assert_eq!(sanitized["failedDependency"], "unknown");
        assert_eq!(sanitized["errorCategory"], "unknown");
        assert!(!sanitized.to_string().contains("alice"));
    }

    #[test]
    fn rescue_snapshot_error_categories_survive_desktop_telemetry_normalization() {
        for category in [
            "snapshot-unreadable",
            "snapshot-external-symlink",
            "snapshot-failed",
            "outdated-dependency",
        ] {
            let sanitized = sanitize_desktop_properties(Some(json!({
                "errorCategory": category,
            })));
            assert_eq!(sanitized["errorCategory"], category);
        }
    }

    #[test]
    fn onboarding_events_attach_the_trusted_build_version_after_property_redaction() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|error| error.into_inner());
        let home = setup_home();
        write_menubar(home.path(), "{}");
        let _home = scoped_home(home.path());
        let install_attempt_id = crate::commands::first_run::install_attempt_id()
            .expect("the persisted install attempt id is available");

        let event = build_desktop_telemetry_event(
            "desktop_onboarding_step".to_string(),
            Some(json!({
                "appVersion": "renderer-controlled-version",
                "step": "connector-import",
            })),
            None,
            None,
            "no-consent",
        );

        assert_eq!(
            event.properties["appVersion"],
            crate::app_version::current()
        );
        assert_eq!(event.properties["step"], "connector-import");
        assert_eq!(
            serde_json::to_value(&event).unwrap()["installAttemptId"],
            install_attempt_id
        );

        let progress_session_id = "22222222-2222-4222-8222-222222222222";
        let progress = build_desktop_telemetry_event(
            "desktop_auth_progress".to_string(),
            Some(json!({"provider": "google", "step": "sign_in_started"})),
            Some(progress_session_id.to_string()),
            None,
            "no-consent",
        );
        let progress_envelope = serde_json::to_value(&progress).unwrap();
        assert_eq!(progress_envelope["installAttemptId"], install_attempt_id);
        assert_eq!(progress_envelope["sessionId"], progress_session_id);

        let completed = build_desktop_telemetry_event(
            "desktop_setup_completed".to_string(),
            Some(json!({"stageCount": 6})),
            None,
            None,
            "no-consent",
        );
        assert_eq!(
            completed.properties["appVersion"],
            crate::app_version::current()
        );
        assert_eq!(
            serde_json::to_value(&completed).unwrap()["installAttemptId"],
            install_attempt_id
        );

        let (event_name, properties) =
            crate::commands::autostart::autostart_state_event_after_reconciliation();
        let expected_enabled = properties["enabled"].clone();
        let expected_platform = properties["platform"].clone();
        let expected_registered = properties.get("registered").cloned();
        let autostart = build_desktop_telemetry_event(
            event_name.to_string(),
            Some(properties),
            None,
            None,
            "desktop-opt-in",
        );
        assert_eq!(autostart.event_name, "desktop_autostart_state");
        assert_eq!(autostart.properties["enabled"], expected_enabled);
        assert_eq!(autostart.properties["platform"], expected_platform);
        if let Some(expected_registered) = expected_registered {
            assert_eq!(autostart.properties["registered"], expected_registered);
        }
        assert_eq!(
            serde_json::to_value(&autostart).unwrap()["installAttemptId"],
            install_attempt_id
        );
    }

    #[test]
    fn launch_classification_preserves_damaged_settings_before_attempt_id_initialization() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|error| error.into_inner());
        let home = setup_home();
        let _home = scoped_home(home.path());
        let settings_path = home.path().join(".hq/menubar.json");
        let damaged_contents = b"{malformed settings";
        fs::write(&settings_path, damaged_contents).expect("write damaged settings fixture");

        let app = tauri::test::mock_app();
        assert_eq!(
            crate::commands::first_run::classify_launch(&app.handle().clone()),
            crate::commands::first_run::LaunchKind::Normal
        );

        assert_eq!(
            fs::read(&settings_path).expect("damaged settings remain in place"),
            damaged_contents,
            "attempt-ID initialization must not move or replace damaged settings"
        );
    }

    #[test]
    fn first_run_attempt_id_is_persisted_before_setup_telemetry_and_reused() {
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|error| error.into_inner());

        let home = setup_home();
        let _home = scoped_home(home.path());
        let app = tauri::test::mock_app();
        assert_eq!(
            crate::commands::first_run::classify_launch(&app.handle().clone()),
            crate::commands::first_run::LaunchKind::FirstRun
        );

        let menubar_path = home.path().join(".hq/menubar.json");
        let stored: Value = serde_json::from_slice(
            &fs::read(&menubar_path).expect("launch classification persists first-run settings"),
        )
        .expect("persisted menubar settings are JSON");
        let attempt_id = stored["installAttemptId"]
            .as_str()
            .expect("first-run initialization persists an attempt ID")
            .to_string();
        uuid::Uuid::parse_str(&attempt_id).expect("attempt ID is a UUID");

        let step = build_desktop_telemetry_event(
            "desktop_onboarding_step".to_string(),
            Some(json!({"step": "welcome-signin", "action": "entered"})),
            None,
            None,
            "no-consent",
        );
        assert_eq!(
            serde_json::to_value(step).unwrap()["installAttemptId"],
            attempt_id
        );

        let event = build_desktop_telemetry_event(
            "desktop_setup_completed".to_string(),
            Some(json!({"stageCount": 6})),
            None,
            None,
            "no-consent",
        );
        assert_eq!(
            serde_json::to_value(event).unwrap()["installAttemptId"],
            attempt_id
        );
        assert_eq!(
            crate::commands::first_run::install_attempt_id().as_deref(),
            Some(attempt_id.as_str()),
            "later setup events reuse the ID persisted during first-run classification"
        );

        drop(_home);
        let existing_home = setup_home();
        write_menubar(
            existing_home.path(),
            r#"{"installAttemptId":"11111111-1111-4111-8111-111111111111"}"#,
        );
        let _existing_home_scope = scoped_home(existing_home.path());
        let existing_app = tauri::test::mock_app();
        crate::commands::first_run::classify_launch(&existing_app.handle().clone());
        let existing_event = build_desktop_telemetry_event(
            "desktop_setup_completed".to_string(),
            Some(json!({"stageCount": 6})),
            None,
            None,
            "no-consent",
        );
        assert_eq!(
            serde_json::to_value(existing_event).unwrap()["installAttemptId"],
            "11111111-1111-4111-8111-111111111111",
            "an existing attempt ID is reused rather than replaced"
        );
    }

    #[test]
    fn connector_import_outcome_and_source_set_are_closed_at_the_native_boundary() {
        let event = build_desktop_telemetry_event(
            "desktop_onboarding_step".to_string(),
            Some(json!({
                "step": "connector-import",
                "outcome": "read /Users/alice/Library/Application Support/Claude",
                "detectedSourceSet": "unbounded-source",
            })),
            None,
            None,
            "no-consent",
        );

        assert_eq!(event.properties["outcome"], "unknown");
        assert_eq!(event.properties["detectedSourceSet"], "unknown");
        assert!(!event.properties.to_string().contains("alice"));
    }

    #[test]
    fn onboarding_failure_properties_never_retain_paths_hosts_usernames_or_raw_errors() {
        let sanitized = sanitize_desktop_properties(Some(json!({
            "failedDependency": "C:\\\\Users\\\\alice\\\\hq",
            "errorCategory": "import failed for alice@host.example under /Users/alice/hq",
            "failureStage": "/Users/alice/hq",
            "failedStages": ["deps", "/Users/alice/hq"],
            "detectedSourceSet": "C:\\\\Users\\\\alice\\\\AppData",
            "path": "/Users/alice/hq",
            "hostname": "host.example",
            "homeDirectory": "/Users/alice",
            "message": "raw importer error",
        })));
        let serialized = sanitized.to_string();

        assert_eq!(sanitized["failedDependency"], "unknown");
        assert_eq!(sanitized["errorCategory"], "unknown");
        assert_eq!(sanitized["failureStage"], "unknown");
        assert_eq!(sanitized["failedStages"], json!(["deps"]));
        assert_eq!(sanitized["detectedSourceSet"], "unknown");
        for forbidden in [
            "alice",
            "host.example",
            "importer error",
            "Users",
            "AppData",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "{forbidden} must not leave the app"
            );
        }
    }

    #[test]
    fn setup_failure_properties_drop_raw_errors_and_bound_failed_stages() {
        let sanitized = sanitize_desktop_properties(Some(json!({
            "failedStages": [
                "content",
                "deps",
                "deps",
                "indexing",
                "not-a-stage",
                "/Users/alice/HQ",
            ],
            "failureStage": "deps",
            "error": "permission denied at /Users/alice/HQ",
            "logPath": "/Users/alice/HQ/logs/setup.log",
        })));
        assert_eq!(
            sanitized["failedStages"],
            json!(["content", "deps", "indexing"])
        );
        assert!(sanitized["failedStages"].as_array().unwrap().len() <= MAX_FAILED_STAGES);
        assert_eq!(sanitized["failureStage"], "deps");
        assert!(sanitized.get("error").is_none());
        assert!(sanitized.get("logPath").is_none());
        assert!(!sanitized.to_string().contains("alice"));
    }

    // ── Test helpers ─────────────────────────────────────────────────────────
    fn complete_ack(request: &wiremock::Request) -> ResponseTemplate {
        let event_count = serde_json::from_slice::<Value>(&request.body)
            .ok()
            .and_then(|body| body.get("events").and_then(Value::as_array).map(Vec::len))
            .unwrap_or(0);
        ResponseTemplate::new(200).set_body_json(json!({
            "ok": true, "written": event_count, "deduped": 0, "skipped": []
        }))
    }

    fn test_upload_batch(
        machine_id: &str,
        installer_version: &str,
        cli_version: Option<&str>,
        events: Vec<Value>,
        sources: Vec<UsageUploadSource>,
    ) -> (UsageUploadPlanner, UsageUploadBatch) {
        assert_eq!(events.len(), sources.len());
        let empty = UsageBatch {
            machine_id: machine_id.to_string(),
            installer_version: installer_version.to_string(),
            cli_version: cli_version.map(str::to_string),
            events: Vec::new(),
        };
        let overhead = serde_json::to_vec(&empty).unwrap().len() - 2;
        let mut planner = UsageUploadPlanner::new(overhead, MAX_BATCH_BYTES, None);
        for (event, source) in events.into_iter().zip(sources) {
            assert_eq!(
                planner.add_event(event, source).unwrap(),
                AddUsageEvent::Added
            );
        }
        let batch = planner.take_batch().unwrap();
        (planner, batch)
    }

    fn test_source(path: &str, offset: u64) -> UsageUploadSource {
        UsageUploadSource {
            file_path: path.to_string(),
            end_offset: offset,
            mtime: 1,
            context: Some(serde_json::to_value(CodexUsageContext::default()).unwrap()),
        }
    }

    /// Create a temp HOME with ~/.hq/ and ~/.claude/projects/ structure.
    fn setup_home() -> TempDir {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".hq")).unwrap();
        fs::create_dir_all(tmp.path().join(".claude/projects")).unwrap();
        tmp
    }

    /// Write a JSONL file under ~/.claude/projects/<subdir>/<name>.jsonl.
    fn write_jsonl(
        home: &std::path::Path,
        subdir: &str,
        name: &str,
        lines: &[&str],
    ) -> std::path::PathBuf {
        let dir = home.join(".claude/projects").join(subdir);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let content: String = lines.iter().map(|l| format!("{}\n", l)).collect();
        fs::write(&p, &content).unwrap();
        p
    }

    fn write_menubar(home: &std::path::Path, content: &str) {
        fs::write(home.join(".hq/menubar.json"), content).unwrap();
    }

    fn write_valid_access_token(home: &std::path::Path) {
        fs::write(
            home.join(".hq/cognito-tokens.json"),
            serde_json::to_string(&json!({
                "accessToken": "test-access-token",
                "refreshToken": "test-refresh-token",
                "expiresAt": 4_102_444_800_000_i64,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    /// Build an unsigned JWT whose payload carries `sub`. `decode_id_token_claims`
    /// only base64url-decodes the middle segment, so the signature is irrelevant.
    fn id_token_for_subject(sub: &str) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"sub":"{sub}"}}"#).as_bytes());
        format!("{header}.{payload}.sig")
    }

    /// Write a cognito token file whose id_token names `sub`, so
    /// `current_cognito_subject` resolves to that account.
    fn write_tokens_for_subject(home: &std::path::Path, sub: &str) {
        fs::write(
            home.join(".hq/cognito-tokens.json"),
            serde_json::to_string(&json!({
                "accessToken": "test-access-token",
                "idToken": id_token_for_subject(sub),
                "refreshToken": "test-refresh-token",
                "expiresAt": 4_102_444_800_000_i64,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn read_cursor(home: &std::path::Path) -> TelemetryCursor {
        let body = fs::read_to_string(home.join(".hq/telemetry-cursor.json")).unwrap();
        serde_json::from_str(&body).unwrap()
    }

    const USER_ROW: &str = r#"{"type":"user","timestamp":"2026-04-25T10:00:00Z","sessionId":"s1","uuid":"u1","parentUuid":null,"userType":"human","entrypoint":"cli","cwd":"/Users/x/proj","gitBranch":"main","version":"1.0","message":{"role":"user","content":[{"type":"text","text":"hello world"}],"id":"msg_1"}}"#;
    const ASST_ROW: &str = r#"{"type":"assistant","timestamp":"2026-04-25T10:00:01Z","sessionId":"s1","uuid":"u2","parentUuid":"u1","message":{"role":"assistant","model":"claude-opus","content":[{"type":"text","text":"hi"},{"type":"thinking","thinking":"hmm"}],"stop_sequence":"</end>","usage":{"input_tokens":42,"output_tokens":7},"id":"msg_2"},"toolUseIds":["t1"],"toolResults":[{"id":"t1","output":"x"}],"requestId":"req_1"}"#;

    fn make_app_handle() -> tauri::AppHandle<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.handle().clone()
    }

    #[test]
    fn normalize_cursor_key_preserves_current_platform_path() {
        let path = std::path::PathBuf::from("root")
            .join(".claude")
            .join("projects")
            .join("proj")
            .join("session.jsonl");
        let expected = path
            .components()
            .collect::<std::path::PathBuf>()
            .to_string_lossy()
            .to_string();

        assert_eq!(normalize_cursor_file_key(&path), expected);
    }

    #[test]
    fn normalize_cursor_key_hardens_windows_mixed_separators() {
        let raw = r"C:\Users\me/.claude/projects\proj/session.jsonl";
        let normalized = normalize_cursor_key_with_separator(raw, '\\');

        assert_eq!(
            normalized,
            r"C:\Users\me\.claude\projects\proj\session.jsonl"
        );
        assert!(!normalized.contains('/'));
    }

    #[test]
    fn test_write_menubar_telemetry_pref_preserves_other_keys() {
        let home = setup_home();
        write_menubar(
            home.path(),
            r#"{"machineId":"mid-keep","hqPath":"/foo","syncOnLaunch":false}"#,
        );
        let path = home.path().join(".hq/menubar.json");

        write_menubar_telemetry_pref_to(&path, true, Some("onboarding"), Some(1)).unwrap();

        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["machineId"], "mid-keep");
        assert_eq!(v["hqPath"], "/foo");
        assert_eq!(v["syncOnLaunch"], false);
        assert_eq!(v["telemetryEnabled"], true);
        // Provenance is cached for an offline replay (finding #7).
        assert_eq!(v["telemetryOptInSurface"], "onboarding");
        assert_eq!(v["telemetryConsentVersion"], 1);
    }

    #[test]
    fn test_write_menubar_telemetry_pref_creates_file_when_missing() {
        let home = TempDir::new().unwrap();
        let path = home.path().join(".hq/menubar.json");

        write_menubar_telemetry_pref_to(&path, false, Some("settings"), Some(1)).unwrap();

        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["telemetryEnabled"], false);
        assert_eq!(v["telemetryOptInSurface"], "settings");
        assert!(!path.with_extension("json.tmp").exists());
    }

    // ── US-003 AC / finding #4: the local cache is account-scoped, provenance-
    //    gated, and never defaults a missing answer to enabled. ────────────────

    #[test]
    fn test_missing_local_telemetry_answer_resolves_to_no_collection() {
        // A menubar with no recorded answer must NOT default to opted-in. The
        // old `unwrap_or(true)` here was the account-unscoped, opt-in-by-omission
        // bug: on a server-read failure it collected for a person who never
        // answered.
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-default"}"#);
        write_tokens_for_subject(home.path(), "sub-a");
        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());

        let answer = read_local_telemetry_enabled(Some("sub-a"));

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_TEST_HOME");
        assert_eq!(
            answer, None,
            "a missing answer must not default to enabled — it is no answer at all"
        );
    }

    #[test]
    fn test_local_answer_requires_provenance_not_a_bare_flag() {
        // A bare `telemetryEnabled: true` (which `get_settings` supplies as a
        // default) without the provenance marker is NOT an answer.
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(
            home.path(),
            r#"{"machineId":"mid-p","telemetryEnabled":true}"#,
        );
        write_tokens_for_subject(home.path(), "sub-a");
        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());

        let answer = read_local_telemetry_enabled(Some("sub-a"));

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_TEST_HOME");
        assert_eq!(
            answer, None,
            "a bare flag without provenance is not consent"
        );
    }

    #[test]
    fn test_local_answer_is_account_scoped() {
        // Account A answered on this machine. When account B is signed in, B must
        // NOT inherit A's cached answer — the record is bound to A's subject.
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(
            home.path(),
            r#"{"machineId":"mid-scope","telemetryEnabled":true,"telemetryOptInAnsweredAt":"2026-07-27T10:00:00Z","telemetryOptInSub":"sub-a"}"#,
        );
        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());

        // Account A: sees its own answer.
        write_tokens_for_subject(home.path(), "sub-a");
        let a = read_local_telemetry_enabled(Some("sub-a"));
        // Account B: the cached answer belongs to A, so B gets no answer.
        write_tokens_for_subject(home.path(), "sub-b");
        let b = read_local_telemetry_enabled(Some("sub-b"));

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_TEST_HOME");
        assert_eq!(a, Some(true), "account A reads its own answer");
        assert_eq!(b, None, "account B must not inherit account A's answer");
    }
    #[tokio::test]
    async fn offline_fallback_uses_in_flight_caller_after_account_switch() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(500).set_body_string("offline"))
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(
            home.path(),
            r#"{"telemetryEnabled":true,"telemetryOptInAnsweredAt":"2026-07-27T10:00:00Z","telemetryOptInSub":"sub-a"}"#,
        );
        write_tokens_for_subject(home.path(), "sub-b");
        std::env::set_var("HOME", home.path());

        let vault_for_in_flight_a = VaultClient::new(server.uri(), id_token_for_subject("sub-a"));
        let enabled = resolve_telemetry_enabled(&vault_for_in_flight_a).await;

        std::env::remove_var("HOME");
        assert!(
            enabled,
            "account B's token file must not replace in-flight account A"
        );
    }

    #[tokio::test]
    async fn test_skill_telemetry_opt_in_false_sends_no_events() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": false})))
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-desktop-off"}"#);
        std::env::set_var("HOME", home.path());

        let vault = VaultClient::new(server.uri(), "test-jwt");
        let result = emit_desktop_telemetry_with_vault(
            &vault,
            "manual_sync_completed".to_string(),
            Some(json!({"filesDownloaded": 3})),
            None,
            None,
        )
        .await;

        std::env::remove_var("HOME");

        assert!(result.is_ok());
        let reqs = server.received_requests().await.unwrap();
        let posts: Vec<_> = reqs
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST)
            .collect();
        assert_eq!(
            posts.len(),
            0,
            "no event POST expected when telemetry is off"
        );
    }

    #[tokio::test]
    async fn test_operational_telemetry_posts_when_skill_opt_in_is_declined() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/telemetry/events"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-desktop-on"}"#);
        std::env::set_var("HOME", home.path());
        let install_attempt_id = crate::commands::first_run::install_attempt_id()
            .expect("the persisted install attempt id is available");

        let vault = VaultClient::new(server.uri(), "test-jwt");
        let result = emit_desktop_operational_telemetry_with_vault(
            &vault,
            "desktop_onboarding_step".to_string(),
            Some(json!({
                "step": "welcome-signin",
                "action": "entered",
                "surface": "desktop_installer",
                "flow": "first_install",
                "platform": "macos",
                "durationMs": 2,
                "companyUid": "cmp_private-company",
                "path": "/Users/alice/HQ",
                "email": "alice@example.com",
                "message": "free text should not leave the client"
            })),
            Some("11111111-1111-4111-8111-111111111111".to_string()),
            Some("2026-08-31T10:00:00.000Z".to_string()),
        )
        .await;

        std::env::remove_var("HOME");

        assert!(result.is_ok());
        let reqs = server.received_requests().await.unwrap();
        let posts: Vec<_> = reqs
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST)
            .collect();
        assert_eq!(posts.len(), 1, "one event POST expected");
        let body: Value = serde_json::from_slice(&posts[0].body).unwrap();
        let event = &body["events"][0];
        assert_eq!(event["eventName"], "desktop_onboarding_step");
        assert_eq!(event["app"], "hq-desktop-app");
        assert_eq!(event["source"], "desktop");
        assert_eq!(event["consentBasis"], "no-consent");
        assert_eq!(event["schemaVersion"], 1);
        assert_eq!(event["occurredAt"], "2026-08-31T10:00:00.000Z");
        assert_eq!(event["sessionId"], "11111111-1111-4111-8111-111111111111");
        assert_eq!(event["installAttemptId"], install_attempt_id);

        let allowed_event_keys = [
            "eventName",
            "app",
            "source",
            "occurredAt",
            "consentBasis",
            "schemaVersion",
            "idempotencyKey",
            "sessionId",
            "installAttemptId",
            "properties",
        ];
        let event_keys = event.as_object().unwrap();
        assert!(event_keys
            .keys()
            .all(|key| allowed_event_keys.contains(&key.as_str())));
        for unexpected_key in ["machineId", "appVersion", "companyUid", "personUid"] {
            assert!(
                event.get(unexpected_key).is_none(),
                "{unexpected_key} must not be sent"
            );
        }

        let props = event["properties"].as_object().unwrap();
        assert_eq!(
            props.get("step").and_then(|v| v.as_str()),
            Some("welcome-signin")
        );
        assert_eq!(
            props.get("surface").and_then(|v| v.as_str()),
            Some("desktop_installer")
        );
        assert_eq!(props.get("durationMs").and_then(|v| v.as_u64()), Some(2));
        assert!(!props.contains_key("path"));
        assert!(!props.contains_key("email"));
        assert!(!props.contains_key("message"));
        assert!(!props.contains_key("companyUid"));

        assert!(
            !reqs
                .iter()
                .any(|request| request.url.path() == "/v1/usage/opt-in"),
            "operational telemetry must not wait for or read the skill consent"
        );
    }

    #[test]
    fn desktop_update_outcome_uses_v2_and_the_install_join_key() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-update-test"}"#);
        std::env::set_var("HOME", home.path());
        let install_attempt_id = crate::commands::first_run::install_attempt_id()
            .expect("the persisted install attempt id is available");

        let event = build_desktop_telemetry_event(
            "desktop_update_outcome".to_string(),
            Some(json!({
                "stage": "download_ok",
                "fromVersion": "0.10.386",
                "toVersion": "0.10.387",
                "channel": "stable",
                "autoUpdate": true,
                "error": "private diagnostic text must be dropped"
            })),
            None,
            None,
            "no-consent",
        );

        std::env::remove_var("HOME");
        let event = serde_json::to_value(event).unwrap();
        assert_eq!(event["schemaVersion"], 2);
        assert_eq!(event["installAttemptId"], install_attempt_id);
        assert_eq!(event["properties"]["stage"], "download_ok");
        assert_eq!(event["properties"]["fromVersion"], "0.10.386");
        assert_eq!(event["properties"]["toVersion"], "0.10.387");
        assert_eq!(event["properties"]["channel"], "stable");
        assert_eq!(event["properties"]["autoUpdate"], true);
        assert!(event["properties"].get("error").is_none());
    }

    #[test]
    fn post_cap_update_outcomes_are_operational_and_keep_closed_reason() {
        let event = build_desktop_telemetry_event(
            "desktop_auto_update_post_cap_outcome".to_string(),
            Some(json!({
                "outcome": "still-held-by",
                "holdReason": "CoreUpdateInProgress",
                "email": "private@example.com",
            })),
            None,
            None,
            "no-consent",
        );
        assert!(is_operational_desktop_event_name(&event.event_name));
        assert_eq!(event.properties["outcome"], "still-held-by");
        assert_eq!(event.properties["holdReason"], "CoreUpdateInProgress");
        assert!(event.properties.get("email").is_none());
    }

    #[tokio::test]
    async fn test_operational_telemetry_rejects_non_operational_event_names() {
        // Builds mint the install id under the current HOME.
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;
        let vault = VaultClient::new(server.uri(), "test-jwt");

        let result = emit_desktop_operational_telemetry_with_vault(
            &vault,
            "manual_sync_completed".to_string(),
            Some(json!({"filesDownloaded": 3})),
            None,
            None,
        )
        .await;

        assert_eq!(
            result.unwrap_err(),
            "event is not approved operational telemetry: manual_sync_completed"
        );
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_opted_in_user_emits_operational_and_skill_telemetry() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/telemetry/events"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-both"}"#);
        write_jsonl(
            home.path(),
            "project",
            "session.jsonl",
            &[USER_ROW, ASST_ROW],
        );
        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let vault = VaultClient::new(server.uri(), "test-jwt");
        emit_desktop_operational_telemetry_with_vault(
            &vault,
            "desktop_setup_completed".to_string(),
            Some(json!({"stageCount": 3})),
            None,
            None,
        )
        .await
        .unwrap();
        let app = make_app_handle();
        send_telemetry_if_opted_in(&app, "/hq", "test-jwt")
            .await
            .unwrap();

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        let requests = server.received_requests().await.unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.method == wiremock::http::Method::POST
                    && request.url.path() == "/v1/telemetry/events")
                .count(),
            1,
            "the setup record is emitted"
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.method == wiremock::http::Method::POST
                    && request.url.path() == "/v1/usage")
                .count(),
            1,
            "the opted-in skill batch is emitted"
        );
    }

    #[test]
    fn funnel_operational_rows_carry_the_trusted_app_version() {
        // Builds mint the install id under the current HOME.
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        // Regression: the PR 1264 funnel rows reached hq-pro with no version.
        for (op, _, _) in crate::commands::cdp_mirror::OPERATIONAL_MIRRORS {
            let event = build_desktop_telemetry_event(
                op.to_string(),
                Some(json!({ "appVersion": "renderer-controlled-version" })),
                None,
                None,
                "no-consent",
            );
            assert_eq!(
                event.properties["appVersion"],
                crate::app_version::current(),
                "{op} must carry the build's app version"
            );
        }
    }

    async fn first_open_posts(server: &MockServer) -> Vec<Value> {
        server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|request| request.method == wiremock::http::Method::POST)
            .map(|request| serde_json::from_slice::<Value>(&request.body).unwrap())
            // HQ_VAULT_API_URL is process-wide, so a test running alongside
            // can post its own rows here; count only the first-open rows.
            .filter(|body| body["events"][0]["eventName"] == "desktop_app_opened")
            .collect()
    }

    async fn first_open_server(status: u16) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/telemetry/events"))
            .respond_with(ResponseTemplate::new(status).set_body_string("{}"))
            .mount(&server)
            .await;
        server
    }

    fn first_open_held(home: &std::path::Path) -> bool {
        hq_desktop_core::first_run::read_menubar_obj(&home.join(".hq/menubar.json"))
            .get(crate::commands::cdp_mirror::FIRST_OPEN_PENDING_KEY)
            .and_then(Value::as_bool)
            == Some(true)
    }

    #[tokio::test]
    async fn first_launch_app_opened_is_held_until_a_session_exists() {
        // Regression: the first launch has no session, so its
        // `desktop_app_opened isFirstLaunch=true` row was dropped and only
        // signed-in relaunches (`false`) ever reached hq-pro.
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = first_open_server(200).await;
        let home = setup_home();
        write_menubar(home.path(), "{}");
        let _home = scoped_home(home.path());
        crate::commands::cognito::clear_tokens().await.unwrap();
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        // What `cdp_mirror::init` does on a first launch.
        crate::commands::cdp_mirror::hold_first_open();

        let without_session = crate::commands::cdp_mirror::flush_pending_first_open_now().await;
        assert!(!without_session, "no session: the row stays held");
        assert!(first_open_held(home.path()));
        write_valid_access_token(home.path());
        assert!(
            crate::commands::cdp_mirror::flush_pending_first_open_now().await,
            "the held row is sent once a session exists"
        );
        assert!(!first_open_held(home.path()));
        assert!(
            !crate::commands::cdp_mirror::flush_pending_first_open_now().await,
            "sent once"
        );
        std::env::remove_var("HQ_VAULT_API_URL");

        let posts = first_open_posts(&server).await;
        assert_eq!(posts.len(), 1);
        let event = &posts[0]["events"][0];
        assert_eq!(event["eventName"], "desktop_app_opened");
        assert_eq!(event["properties"]["isFirstLaunch"], true);
        assert_eq!(
            event["properties"]["appVersion"],
            crate::app_version::current()
        );
    }

    #[tokio::test]
    async fn overlapping_first_open_flushes_send_one_row() {
        // Regression: a flush checked the pending flag before taking the guard,
        // so a flush that checked, then took the guard after another flush had
        // sent and released it, sent the row a second time.
        use crate::commands::cdp_mirror::{
            flush_pending_first_open_now, FirstOpenGuardHook, FIRST_OPEN_GUARD_HOOK,
        };
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = first_open_server(200).await;
        let home = setup_home();
        write_menubar(home.path(), "{}");
        let _home = scoped_home(home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());
        write_valid_access_token(home.path());
        crate::commands::cdp_mirror::hold_first_open();

        let hook = std::sync::Arc::new(FirstOpenGuardHook {
            reached: tokio::sync::Notify::new(),
            resume: tokio::sync::Notify::new(),
        });
        let late =
            tokio::spawn(FIRST_OPEN_GUARD_HOOK.scope(hook.clone(), flush_pending_first_open_now()));
        // `late` has seen the pending row and is parked before the guard.
        hook.reached.notified().await;
        let early = flush_pending_first_open_now().await;
        hook.resume.notify_one();
        let late = late.await.unwrap();
        std::env::remove_var("HQ_VAULT_API_URL");

        assert!(early, "the first flush sends the row");
        assert!(!late, "the overlapping flush finds it already sent");
        assert!(!first_open_held(home.path()));
        let posts = first_open_posts(&server).await;
        assert_eq!(posts.len(), 1, "exactly one POST");
        let install = crate::commands::first_run::install_attempt_id().unwrap();
        assert_eq!(
            posts[0]["events"][0]["idempotencyKey"],
            crate::commands::cdp_mirror::first_open_idempotency_key(&install)
        );
    }

    #[test]
    fn background_telemetry_flush_path_is_captured_before_home_changes() {
        // Models a scheduled task whose first poll happens after another test
        // changes HOME: the production task builders must already own this path.
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let scheduled_home = setup_home();
        let later_home = setup_home();

        let _scheduled_home = scoped_home(scheduled_home.path());
        let scheduled_path = crate::commands::cdp_mirror::capture_background_flush_path();
        let scheduled_path = scheduled_path.expect("HOME A has a menubar path");
        assert!(crate::commands::cdp_mirror::flush_path_matches_current_home(
            &scheduled_path
        ));
        let _later_home = scoped_home(later_home.path());

        assert_eq!(
            scheduled_path,
            scheduled_home.path().join(".hq/menubar.json"),
            "the path is captured synchronously before a background task is polled"
        );
        assert!(!crate::commands::cdp_mirror::flush_path_matches_current_home(
            &scheduled_path
        ));
        assert_ne!(scheduled_path, later_home.path().join(".hq/menubar.json"));
    }

    #[test]
    fn first_launch_app_opened_carries_a_stable_install_idempotency_key() {
        // Regression: the held first-launch row had no idempotencyKey, so a
        // repeated send was stored twice by hq-pro.
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), "{}");
        let _home = scoped_home(home.path());
        let build = |first: bool| {
            build_desktop_telemetry_event(
                "desktop_app_opened".to_string(),
                Some(json!({ "isFirstLaunch": first })),
                None,
                None,
                "no-consent",
            )
        };
        let first = build(true);
        let retry = build(true);
        let install = crate::commands::first_run::install_attempt_id().unwrap();
        let key = first.idempotency_key.clone().unwrap();
        assert_eq!(key, format!("hq-desktop-app:first-open:{install}"));
        assert_eq!(retry.idempotency_key.as_deref(), Some(key.as_str()));
        // hq-pro's envelope accepts [A-Za-z0-9_.:#-]{1,200} for idempotencyKey.
        assert!(key.len() <= 200);
        assert!(key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:#-".contains(&b)));
        assert_eq!(
            serde_json::to_value(&first).unwrap()["idempotencyKey"],
            json!(key)
        );
        assert!(
            build(false).idempotency_key.is_none(),
            "relaunch rows are not deduped"
        );
    }

    fn first_open_warnings(log: &std::path::Path) -> Vec<String> {
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.contains("[cdp] WARN first_open"))
            .map(str::to_string)
            .collect()
    }

    #[tokio::test]
    async fn first_open_failures_are_logged_as_warnings() {
        // Regression: the hold write, the send and the clear write each
        // dropped their error without a trace.
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let logs = TempDir::new().unwrap();
        let log = logs.path().join("hq-sync.log");
        let _log = hq_desktop_core::logfile::LogOverrideGuard::new(log.clone());
        let server = first_open_server(500).await;
        let home = setup_home();
        let _home = scoped_home(home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        // Hold: menubar.json is a directory, so the write fails.
        std::fs::create_dir_all(home.path().join(".hq/menubar.json")).unwrap();
        crate::commands::cdp_mirror::hold_first_open();
        let warnings = first_open_warnings(&log);
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(warnings[0].contains("hold_write_failed"), "{warnings:?}");
        std::fs::remove_dir_all(home.path().join(".hq/menubar.json")).unwrap();

        // Send: hq-pro answers 500; the row stays held.
        write_menubar(home.path(), "{}");
        write_valid_access_token(home.path());
        crate::commands::cdp_mirror::hold_first_open();
        assert!(!crate::commands::cdp_mirror::flush_pending_first_open_now().await);
        assert!(first_open_held(home.path()));
        let warnings = first_open_warnings(&log);
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert!(
            warnings[1].contains("send_failed_held_for_retry"),
            "{warnings:?}"
        );

        // Clear: the send succeeds but the config directory is read-only.
        #[cfg(unix)]
        {
            server.reset().await;
            Mock::given(method("POST"))
                .and(path("/v1/telemetry/events"))
                .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
                .mount(&server)
                .await;
            crate::commands::first_run::install_attempt_id().unwrap();
            let hq_dir = home.path().join(".hq");
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hq_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
            let sent = crate::commands::cdp_mirror::flush_pending_first_open_now().await;
            std::fs::set_permissions(&hq_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::env::remove_var("HQ_VAULT_API_URL");
            assert!(sent);
            let warnings = first_open_warnings(&log);
            assert_eq!(warnings.len(), 3, "{warnings:?}");
            assert!(warnings[2].contains("clear_write_failed"), "{warnings:?}");
        }
        std::env::remove_var("HQ_VAULT_API_URL");
    }

    async fn auth_failure_posts(server: &MockServer) -> Vec<Value> {
        server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|request| request.method == wiremock::http::Method::POST)
            .map(|request| serde_json::from_slice::<Value>(&request.body).unwrap())
            .flat_map(|body| body["events"].as_array().cloned().unwrap_or_default())
            .filter(|event| event["eventName"] == "desktop_auth_failure")
            .collect()
    }

    #[tokio::test]
    async fn first_sign_in_failure_before_a_token_reaches_hq_pro_after_sign_in() {
        // Regression: a brand-new user has no token until token_exchange_ok,
        // so a sign-in failure before that was never sent to hq-pro. Only
        // returning users' sign-in rows reached it.
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = first_open_server(200).await;
        let home = setup_home();
        write_menubar(home.path(), "{}");
        let _home = scoped_home(home.path());
        crate::commands::cognito::clear_tokens().await.unwrap();
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        // First-time sign-in, no token: the provider page fails to open.
        let _ = emit_desktop_operational_telemetry(
            "desktop_auth_failure".to_string(),
            Some(json!({
                "provider": "google",
                "step": "provider_page_opened",
                "errorCategory": "network",
            })),
            None,
            None,
        )
        .await;
        assert!(
            auth_failure_posts(&server).await.is_empty(),
            "no session yet"
        );

        // The app quits here; only what is on disk carries over. On the next
        // launch the user signs in and the app reports token_exchange_ok.
        write_valid_access_token(home.path());
        emit_desktop_operational_telemetry(
            "desktop_auth_progress".to_string(),
            Some(json!({ "provider": "google", "step": "token_exchange_ok" })),
            None,
            None,
        )
        .await
        .unwrap();
        std::env::remove_var("HQ_VAULT_API_URL");

        let failures = auth_failure_posts(&server).await;
        assert_eq!(failures.len(), 1, "the pre-token failure must reach hq-pro");
        assert_eq!(failures[0]["properties"]["step"], "provider_page_opened");
        assert_eq!(failures[0]["properties"]["errorCategory"], "network");
    }

    fn held_auth_rows(home: &std::path::Path) -> Vec<Value> {
        crate::commands::cdp_mirror::held_auth_rows_at(
            &home.join(".hq/menubar.json"),
            chrono::Utc::now().timestamp_millis() as u64,
        )
    }

    async fn emit_pre_token_failure(step: &str) {
        emit_desktop_operational_telemetry(
            "desktop_auth_failure".to_string(),
            Some(json!({
                "provider": "google",
                "step": step,
                "errorCategory": "network",
                "message": "connect error: secret-callback-code-123",
            })),
            None,
            None,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn held_auth_failure_uses_home_captured_before_token_resolution() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let original_home = setup_home();
        let changed_home = setup_home();
        write_menubar(original_home.path(), "{}");
        write_menubar(changed_home.path(), "{}");
        let _home = scoped_home(original_home.path());

        let result = access_token_or_hold_auth_event(
            "desktop_auth_failure",
            Some(&json!({ "provider": "google", "step": "callback_received" })),
            None,
            None,
            async {
                std::env::set_var("HOME", changed_home.path());
                Err("Not signed in".to_string())
            },
        )
        .await;
        std::env::set_var("HOME", original_home.path());

        assert_eq!(result.unwrap(), None);
        assert_eq!(held_auth_rows(original_home.path()).len(), 1);
        assert!(held_auth_rows(changed_home.path()).is_empty());
    }

    #[tokio::test]
    async fn held_sign_in_failure_survives_app_quit_with_labels_only() {
        // Regression: the row lived nowhere once the app quit after a failed
        // first sign-in. It must be on disk, with closed labels only.
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = first_open_server(200).await;
        let home = setup_home();
        write_menubar(home.path(), "{}");
        let _home = scoped_home(home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        emit_pre_token_failure("provider_page_opened").await;
        // Quit: nothing in memory carries over; read what a relaunch reads.
        let raw = std::fs::read_to_string(home.path().join(".hq/menubar.json")).unwrap();
        assert!(
            !raw.contains("secret-callback-code"),
            "no raw error text on disk"
        );
        let held = held_auth_rows(home.path());
        assert_eq!(held.len(), 1);
        assert_eq!(
            held[0]["properties"],
            json!({ "provider": "google", "step": "provider_page_opened", "errorCategory": "network" })
        );

        // Next launch, user signs in; the launch-time flush sends it.
        write_valid_access_token(home.path());
        assert_eq!(
            crate::commands::cdp_mirror::flush_held_auth_rows_now().await,
            1
        );
        std::env::remove_var("HQ_VAULT_API_URL");
        assert!(held_auth_rows(home.path()).is_empty());
        let failures = auth_failure_posts(&server).await;
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0]["occurredAt"], held[0]["occurredAt"]);
        assert!(failures[0]["properties"].get("message").is_none());
    }

    #[tokio::test]
    async fn held_sign_in_failure_is_delivered_exactly_once_after_sign_in() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = first_open_server(200).await;
        let home = setup_home();
        write_menubar(home.path(), "{}");
        let _home = scoped_home(home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        emit_pre_token_failure("callback_received").await;
        let key = held_auth_rows(home.path())[0]["idempotencyKey"]
            .as_str()
            .unwrap()
            .to_string();
        write_valid_access_token(home.path());
        for step in ["sign_in_started", "token_exchange_ok"] {
            emit_desktop_operational_telemetry(
                "desktop_auth_progress".to_string(),
                Some(json!({ "provider": "google", "step": step })),
                None,
                None,
            )
            .await
            .unwrap();
        }
        assert_eq!(
            crate::commands::cdp_mirror::flush_held_auth_rows_now().await,
            0
        );
        std::env::remove_var("HQ_VAULT_API_URL");

        let failures = auth_failure_posts(&server).await;
        assert_eq!(failures.len(), 1, "delivered exactly once");
        assert_eq!(failures[0]["idempotencyKey"], json!(key));
        assert!(key.starts_with("hq-desktop-app:auth-held:") && key.len() <= 200);
        assert!(held_auth_rows(home.path()).is_empty());
    }

    #[tokio::test]
    async fn held_sign_in_failure_stays_on_its_home_when_token_home_disagrees() {
        // The menubar path follows HOME. The token resolver follows
        // HQ_TEST_HOME. A signed resolver home must not turn an unsigned
        // install's first sign-in failure into a delivered row.
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = first_open_server(200).await;
        let unsigned = setup_home();
        let signed = setup_home();
        write_menubar(unsigned.path(), "{}");
        write_menubar(signed.path(), "{}");
        write_valid_access_token(signed.path());
        let _home = scoped_home(unsigned.path());
        std::env::set_var("HQ_TEST_HOME", signed.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        emit_pre_token_failure("provider_page_opened").await;

        std::env::remove_var("HQ_VAULT_API_URL");
        let held = held_auth_rows(unsigned.path());
        assert_eq!(held.len(), 1);
        assert_eq!(
            held[0]["properties"],
            json!({ "provider": "google", "step": "provider_page_opened", "errorCategory": "network" })
        );
        assert!(held_auth_rows(signed.path()).is_empty());
        assert!(
            auth_failure_posts(&server).await.is_empty(),
            "a foreign token must not deliver the unsigned install's failure"
        );
        let raw = std::fs::read_to_string(unsigned.path().join(".hq/menubar.json")).unwrap();
        assert!(!raw.contains("secret-callback-code"));
    }

    #[tokio::test]
    async fn held_sign_in_row_is_not_flushed_with_a_different_homes_token() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = first_open_server(200).await;
        let unsigned = setup_home();
        let signed = setup_home();
        write_menubar(unsigned.path(), "{}");
        write_menubar(signed.path(), "{}");
        write_valid_access_token(signed.path());
        let _home = scoped_home(unsigned.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        emit_pre_token_failure("callback_received").await;
        assert_eq!(held_auth_rows(unsigned.path()).len(), 1);
        std::env::set_var("HQ_TEST_HOME", signed.path());

        let emitted = emit_desktop_operational_telemetry(
            crate::commands::cdp_mirror::OP_SYNC_STARTED.to_string(),
            Some(json!({ "trigger": "manual", "flow": "sync" })),
            None,
            None,
        )
        .await;
        assert!(emitted.is_err(), "the unsigned install has no session");
        assert_eq!(
            crate::commands::cdp_mirror::flush_held_auth_rows_now().await,
            0
        );
        std::env::remove_var("HQ_VAULT_API_URL");
        assert_eq!(held_auth_rows(unsigned.path()).len(), 1);
        assert!(held_auth_rows(signed.path()).is_empty());
        assert!(
            auth_failure_posts(&server).await.is_empty(),
            "the success-path flush must not clear the row with the other home's token"
        );
    }

    #[test]
    fn held_sign_in_rows_are_capped_and_expire() {
        use crate::commands::cdp_mirror::{
            held_auth_rows_at, hold_auth_row_at, AUTH_HELD_CAP, AUTH_HELD_TTL_MS,
        };
        let _home = setup_home();
        write_menubar(_home.path(), "{}");
        let other_home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(other_home.path().join(".hq")).unwrap();
        write_menubar(other_home.path(), "{}");
        let other_path = other_home.path().join(".hq/menubar.json");
        let expected_install_id = crate::commands::first_run::ensure_install_attempt_id(
            &other_path,
            || "33333333-3333-4333-8333-333333333333".to_string(),
        )
        .unwrap();
        let start = 1_800_000_000_000u64;
        let session_id = "22222222-2222-4222-8222-222222222222";
        let props = |i: usize| json!({ "provider": format!("p{i}"), "step": "sign_in_started" });
        for i in 0..AUTH_HELD_CAP + 5 {
            hold_auth_row_at(
                &other_path,
                "desktop_auth_progress",
                Some(&props(i)),
                Some(session_id),
                start + i as u64,
            )
            .unwrap();
        }
        let rows = held_auth_rows_at(&other_path, start + 100);
        assert_eq!(rows.len(), AUTH_HELD_CAP, "capped");
        assert_eq!(
            rows[0]["properties"]["provider"], "p5",
            "oldest dropped first"
        );
        assert_eq!(
            rows[0]["installAttemptId"],
            expected_install_id,
            "held rows use the install id from the supplied menubar path"
        );
        assert_eq!(rows[0]["sessionId"], session_id);

        // Past the TTL every row is gone, and the next hold prunes the file.
        let later = start + AUTH_HELD_TTL_MS + 100;
        assert!(held_auth_rows_at(&other_path, later).is_empty(), "expired");
        hold_auth_row_at(&other_path, "desktop_auth_failure", Some(&props(99)), None, later).unwrap();
        let stored = hq_desktop_core::first_run::read_menubar_obj(&other_path);
        assert_eq!(stored["cdpAuthHeld"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_daily_active_event_uses_stable_utc_day_values() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-07-15T14:30:05.250Z")
            .unwrap()
            .with_timezone(&chrono::Utc);

        let first = build_daily_active_event(now);
        let retry = build_daily_active_event(now);

        // Regression: the row used to be stamped 00:00:00Z, so every daytime
        // read of hq-pro telemetry returned no daily-active rows.
        assert_eq!(first.occurred_at, "2026-07-15T14:30:05.250Z");
        let later_same_day = build_daily_active_event(now + chrono::Duration::hours(6));
        assert_eq!(
            later_same_day.idempotency_key, first.idempotency_key,
            "re-sends on the same UTC day share one idempotency key"
        );
        assert_eq!(
            first.idempotency_key.as_deref(),
            Some("hq-desktop-app:daily-active:2026-07-15")
        );
        assert_eq!(first.occurred_at, retry.occurred_at);
        assert_eq!(first.idempotency_key, retry.idempotency_key);
        assert_eq!(
            first.properties["appVersion"],
            crate::app_version::current()
        );
        let platform = first.properties["platform"].as_str().unwrap();
        assert!(
            crate::commands::version_gate::DESKTOP_PLATFORM_VALUES.contains(&platform),
            "daily-active platform must remain in the closed desktop vocabulary"
        );

        let serialized = serde_json::to_value(&first).unwrap();
        assert_eq!(serialized["eventName"], "desktop_app_daily_active");
        assert_eq!(serialized["app"], "hq-desktop-app");
        assert_eq!(serialized["source"], "desktop");
        assert_eq!(serialized["consentBasis"], "no-consent");
        assert_eq!(
            serialized["idempotencyKey"],
            "hq-desktop-app:daily-active:2026-07-15"
        );
        assert_eq!(
            serialized["properties"]["appVersion"],
            crate::app_version::current()
        );
        assert_eq!(serialized["properties"]["platform"], platform);
        for unexpected_key in ["machineId", "appVersion", "companyUid", "personUid"] {
            assert!(serialized.get(unexpected_key).is_none());
        }
    }

    #[tokio::test]
    async fn test_daily_active_posts_when_skill_opt_in_is_declined() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/telemetry/events"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;

        let vault = VaultClient::new(server.uri(), "test-jwt");
        let now = chrono::Utc::now();

        let result = emit_daily_active_with_vault(&vault, now, None).await;

        assert!(result.is_ok());
        let reqs = server.received_requests().await.unwrap();
        let posts: Vec<_> = reqs
            .iter()
            .filter(|request| request.method == wiremock::http::Method::POST)
            .collect();
        assert_eq!(posts.len(), 1);
        let body: Value = serde_json::from_slice(&posts[0].body).unwrap();
        assert_eq!(body["events"][0]["consentBasis"], "no-consent");
        assert!(
            !reqs
                .iter()
                .any(|request| request.url.path() == "/v1/usage/opt-in"),
            "app launch telemetry must not consult skill consent"
        );
    }

    #[tokio::test]
    async fn test_daily_active_missing_or_invalid_token_does_not_fail_startup() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;
        let now = chrono::Utc::now();

        for token_contents in [None, Some("{not valid json")] {
            let home = setup_home();
            if let Some(token_contents) = token_contents {
                fs::write(home.path().join(".hq/cognito-tokens.json"), token_contents).unwrap();
            }

            std::env::set_var("HQ_TEST_HOME", home.path());
            std::env::set_var("HQ_VAULT_API_URL", server.uri());
            emit_daily_active_at(
                now,
                DesktopLivenessContext {
                    launch_source: "unknown",
                    start_at_login: "unknown",
                },
            )
            .await;
            std::env::remove_var("HQ_TEST_HOME");
            std::env::remove_var("HQ_VAULT_API_URL");
        }

        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_daily_active_non_success_response_is_swallowed() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/telemetry/events"))
            .respond_with(ResponseTemplate::new(503).set_body_string("unavailable"))
            .mount(&server)
            .await;

        let home = setup_home();
        write_valid_access_token(home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let now = chrono::Utc::now();
        emit_daily_active_at(
            now,
            DesktopLivenessContext {
                launch_source: "unknown",
                start_at_login: "unknown",
            },
        )
        .await;

        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        // A 503 is retryable under the shared request policy, so the emit
        // exhausts its attempt budget and still swallows the failure.
        let reqs = server.received_requests().await.unwrap();
        assert_eq!(
            reqs.iter()
                .filter(|request| request.method == wiremock::http::Method::POST)
                .count(),
            hq_desktop_core::request_policy::RETRY_MAX_ATTEMPTS as usize
        );
    }

    // ── Version heartbeat ────────────────────────────────────────────────────

    #[test]
    fn version_heartbeat_schedule_is_launch_then_6h_and_post_update_is_immediate() {
        assert_eq!(
            version_heartbeat_delay(VersionHeartbeatTrigger::Launch),
            Duration::ZERO,
            "launch emits as soon as a session exists, without delaying startup"
        );
        assert_eq!(
            version_heartbeat_delay(VersionHeartbeatTrigger::PostUpdate),
            Duration::ZERO,
            "an installed update heartbeats before restart/exit"
        );
        assert_eq!(
            version_heartbeat_delay(VersionHeartbeatTrigger::Interval),
            Duration::from_secs(6 * 60 * 60)
        );
        assert_eq!(
            next_version_heartbeat_delay(VersionHeartbeatOutcome::Sent),
            Duration::from_secs(6 * 60 * 60)
        );
        assert_eq!(
            next_version_heartbeat_delay(VersionHeartbeatOutcome::Failed),
            Duration::from_secs(6 * 60 * 60)
        );
        assert_eq!(
            next_version_heartbeat_delay(VersionHeartbeatOutcome::NoSession),
            Duration::from_secs(30)
        );
        assert!(
            next_version_heartbeat_delay(VersionHeartbeatOutcome::NoSession)
                < next_version_heartbeat_delay(VersionHeartbeatOutcome::Sent)
        );
    }

    #[test]
    fn version_heartbeat_payload_is_the_usage_empty_batch_shape() {
        let batch = build_version_heartbeat_batch("mach-abc-123", "0.10.178", Some("5.10.2"));
        let serialized = serde_json::to_value(&batch).unwrap();
        assert_eq!(serialized["machineId"], "mach-abc-123");
        assert_eq!(serialized["installerVersion"], "0.10.178");
        assert_eq!(serialized["cliVersion"], "5.10.2");
        assert_eq!(serialized["events"], json!([]));
        let obj = serialized.as_object().expect("object");
        assert_eq!(obj.len(), 4, "only the usage allowlist top-level keys");
        for unexpected in [
            "platform",
            "arch",
            "osVersion",
            "os_version",
            "personUid",
            "appVersion",
        ] {
            assert!(
                serialized.get(unexpected).is_none(),
                "usage ingest rejects extra top-level field {unexpected}"
            );
        }
    }

    #[test]
    fn version_heartbeat_payload_omits_unresolved_cli_version() {
        let batch = build_version_heartbeat_batch("mach-1", "0.10.178", None);
        let serialized = serde_json::to_value(&batch).unwrap();
        assert!(serialized.get("cliVersion").is_none());
        assert_eq!(serialized["events"], json!([]));
    }

    #[test]
    fn version_heartbeat_client_name_is_the_gtm_mapped_desktop_app() {
        assert_eq!(VERSION_HEARTBEAT_CLIENT_NAME, "hq-desktop-app");
    }

    #[test]
    fn version_heartbeat_log_prefix_truncates_machine_id() {
        assert_eq!(machine_id_log_prefix("abcdefgh-ijkl-mnop"), "abcdefgh");
        assert_eq!(machine_id_log_prefix("short"), "short");
        assert_eq!(machine_id_log_prefix(""), "-");
    }

    #[test]
    fn version_heartbeat_is_wired_at_launch_and_after_update() {
        let main = include_str!("../main.rs");
        let daily = main
            .find("commands::telemetry::setup_daily_active_emit(")
            .expect("daily-active setup");
        let heartbeat = main
            .find("commands::telemetry::setup_version_heartbeat();")
            .expect("version heartbeat setup");
        assert!(
            heartbeat > daily,
            "version heartbeat starts next to daily-active, after it"
        );

        let updater = include_str!("../updater.rs");
        assert!(
            updater.contains("emit_version_heartbeat_after_update"),
            "macOS update install must heartbeat before restart"
        );

        let windows = include_str!("../windows_update.rs");
        assert!(
            windows.contains("emit_version_heartbeat_after_update"),
            "Windows update handoff must heartbeat before exit"
        );
    }

    #[tokio::test]
    async fn version_heartbeat_posts_empty_usage_batch_without_consulting_consent() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": false})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .and(wiremock::matchers::header(
                "x-hq-client-name",
                "hq-desktop-app",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({
                "ok": true, "written": 0, "skipped": []
            })))
            .mount(&server)
            .await;

        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-heartbeat-consent"}"#);
        write_valid_access_token(home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let outcome = emit_version_heartbeat_once(None).await;

        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        assert_eq!(outcome, VersionHeartbeatOutcome::Sent);
        let reqs = server.received_requests().await.unwrap();
        assert!(
            !reqs
                .iter()
                .any(|request| request.url.path() == "/v1/usage/opt-in"),
            "version/presence must not consult skill consent"
        );
        assert!(
            !reqs
                .iter()
                .any(|request| request.url.path() == "/v1/telemetry/events"),
            "heartbeat must not emit skill or operational product events"
        );
        let posts: Vec<_> = reqs
            .iter()
            .filter(|request| {
                request.method == wiremock::http::Method::POST && request.url.path() == "/v1/usage"
            })
            .collect();
        assert_eq!(posts.len(), 1);
        let body: Value = serde_json::from_slice(&posts[0].body).unwrap();
        assert_eq!(body["machineId"], "mid-heartbeat-consent");
        assert_eq!(body["installerVersion"], crate::app_version::current());
        assert_eq!(body["events"], json!([]));
        let client_name = posts[0]
            .headers
            .get("x-hq-client-name")
            .and_then(|value| value.to_str().ok());
        assert_eq!(client_name, Some("hq-desktop-app"));
    }

    #[tokio::test]
    async fn version_heartbeat_post_update_sends_the_installed_version() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({
                "ok": true, "written": 0, "skipped": []
            })))
            .mount(&server)
            .await;

        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-post-update"}"#);
        write_valid_access_token(home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        emit_version_heartbeat_after_update("0.10.200").await;

        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        let reqs = server.received_requests().await.unwrap();
        let posts: Vec<_> = reqs
            .iter()
            .filter(|request| request.url.path() == "/v1/usage")
            .collect();
        assert_eq!(posts.len(), 1);
        let body: Value = serde_json::from_slice(&posts[0].body).unwrap();
        assert_eq!(body["installerVersion"], "0.10.200");
        assert_eq!(body["machineId"], "mid-post-update");
        assert_eq!(body["events"], json!([]));
    }

    #[tokio::test]
    async fn version_heartbeat_missing_session_does_not_post_or_panic() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-no-session"}"#);
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let outcome = emit_version_heartbeat_once(None).await;

        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        assert_eq!(outcome, VersionHeartbeatOutcome::NoSession);
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn version_heartbeat_http_failure_is_swallowed_without_retry() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(ResponseTemplate::new(503).set_body_string("unavailable"))
            .expect(1)
            .mount(&server)
            .await;

        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-http-fail"}"#);
        write_valid_access_token(home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let outcome = emit_version_heartbeat_once(None).await;

        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        assert_eq!(outcome, VersionHeartbeatOutcome::Failed);
    }

    #[tokio::test]
    async fn version_heartbeat_retries_transport_error_once_then_succeeds() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let attempts = AtomicUsize::new(0);
        let batch = build_version_heartbeat_batch("m1", "1.0.0", None);
        let result = post_heartbeat_attempts(|| {
            let n = attempts.fetch_add(1, Ordering::SeqCst);
            let batch = batch.clone();
            async move {
                if n == 0 {
                    post_version_heartbeat_request("http://127.0.0.1:1", "tok", &batch).await
                } else {
                    Ok(())
                }
            }
        })
        .await;
        assert!(result.is_ok());
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn version_heartbeat_transport_failure_does_not_panic() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let attempts = AtomicUsize::new(0);
        let batch = build_version_heartbeat_batch("m1", "1.0.0", None);
        let result = post_heartbeat_attempts(|| {
            attempts.fetch_add(1, Ordering::SeqCst);
            let batch = batch.clone();
            async move { post_version_heartbeat_request("http://127.0.0.1:1", "tok", &batch).await }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert!(heartbeat_error_is_retryable(result.as_ref().unwrap_err()));
    }

    #[test]
    fn setup_version_heartbeat_is_fire_and_forget() {
        // `setup_version_heartbeat` is a sync fn that only spawns; the first
        // emit is inside the task (`version_heartbeat_delay(Launch) == 0`).
        // Do not call it here — the spawned loop would outlive the test.
        assert_eq!(
            version_heartbeat_delay(VersionHeartbeatTrigger::Launch),
            Duration::ZERO
        );
        let _: fn() = setup_version_heartbeat;
    }

    // ── (a) opt-in=false → 0 bytes sent ──────────────────────────────────────

    #[tokio::test]
    async fn test_opt_in_false_sends_nothing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": false})))
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"test-id","hqPath":"/foo"}"#);
        write_jsonl(home.path(), "proj", "session.jsonl", &[USER_ROW, ASST_ROW]);
        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();
        let result = send_telemetry_if_opted_in(&handle, "/hq", "test-jwt").await;

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        assert!(result.is_ok());
        let reqs = server.received_requests().await.unwrap();
        let posts: Vec<_> = reqs
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST)
            .collect();
        assert_eq!(posts.len(), 0, "no POST expected when opt-in is false");
    }

    // ── US-003 AC3: withdrawal halts emission on the NEXT cycle, no restart ────
    //
    // The collection cycle re-resolves consent every time (step 2 of
    // `send_telemetry_if_opted_in`), so a server-side withdrawal takes effect on
    // the very next cycle with nothing cached across cycles and no app restart.
    // Two cycles run against the SAME process/state: cycle 1 sees the server say
    // enabled and emits; between cycles the server flips to declined; cycle 2
    // must emit nothing. If the consent value were cached across cycles, cycle 2
    // would still POST — this test would fail.
    #[tokio::test]
    async fn test_withdrawal_halts_emission_on_next_cycle_without_restart() {
        let server = MockServer::start().await;
        // Cycle 1: opted in at cycle start and again immediately before POST.
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .up_to_n_times(2)
            .with_priority(1)
            .mount(&server)
            .await;
        // Cycle 2 onward: withdrawn. A lower priority (higher number) makes this
        // the fallback once both cycle-1 checks are exhausted.
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": false})))
            .with_priority(2)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-withdraw"}"#);
        write_jsonl(home.path(), "proj", "s.jsonl", &[USER_ROW, ASST_ROW]);
        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();

        // Cycle 1: server says enabled → events are POSTed.
        send_telemetry_if_opted_in(&handle, "/hq", "test-jwt")
            .await
            .unwrap();
        let posts_after_cycle1 = server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST)
            .count();
        assert!(
            posts_after_cycle1 >= 1,
            "cycle 1 should emit while opted in"
        );

        // Add a fresh row so cycle 2 has NEW content to send. If consent were
        // cached from cycle 1, this row would be POSTed — it must not be.
        write_jsonl(home.path(), "proj2", "s2.jsonl", &[USER_ROW]);

        // Cycle 2: server now says withdrawn → no restart, and no further POST.
        send_telemetry_if_opted_in(&handle, "/hq", "test-jwt")
            .await
            .unwrap();

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        let posts_after_cycle2 = server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST)
            .count();
        assert_eq!(
            posts_after_cycle2, posts_after_cycle1,
            "cycle 2 must emit NOTHING once the server records a withdrawal — \
             consent is re-resolved per cycle, never cached across cycles"
        );
    }

    // ── (b) Missing cursor file → all files at offset 0 ──────────────────────

    #[tokio::test]
    async fn test_missing_cursor_starts_at_offset_zero() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-b","hqPath":"/foo"}"#);
        let jsonl_path = write_jsonl(home.path(), "proj", "s.jsonl", &[USER_ROW, ASST_ROW]);
        let file_size = fs::metadata(&jsonl_path).unwrap().len();

        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();
        let result = send_telemetry_if_opted_in(&handle, "/hq", "test-jwt").await;

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        assert!(result.is_ok());

        // Cursor file should exist with correct offset
        let cursor = read_cursor(home.path());
        let path_str = normalize_cursor_file_key(&jsonl_path);
        let entry = cursor
            .files
            .get(&path_str)
            .expect("cursor should have entry for the file");
        assert_eq!(
            entry.offset, file_size,
            "cursor offset should equal file size"
        );

        // POST should have been made with 2 events
        let reqs = server.received_requests().await.unwrap();
        let posts: Vec<_> = reqs
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST)
            .collect();
        assert!(!posts.is_empty(), "at least 1 POST expected");
        let body: Value = serde_json::from_slice(&posts[0].body).unwrap();
        let events = body["events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
    }

    // ── (c) Strip-list removes every REMOVE field ─────────────────────────────

    #[tokio::test]
    async fn test_strip_list_removes_remove_fields() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-c"}"#);
        // Row containing ALL REMOVE fields
        let full_row = r#"{"type":"user","timestamp":"2026-04-25T10:00:00Z","sessionId":"s1","uuid":"u1","parentUuid":null,"userType":"human","entrypoint":"cli","cwd":"/Users/x","gitBranch":"main","version":"1.0","content":[{"type":"text"}],"thinking":"internal","text":"raw","toolUseIds":["t1"],"toolResults":[{"id":"t1"}],"message":{"role":"user","content":[{"type":"text","text":"hi"}],"model":"claude","thinking":"x","text":"y","stop_sequence":"\n\nHuman:","id":"msg_1","usage":{"input_tokens":5,"output_tokens":2}}}"#;
        write_jsonl(home.path(), "proj", "full.jsonl", &[full_row]);

        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();
        let result = send_telemetry_if_opted_in(&handle, "/hq", "tok").await;

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        assert!(result.is_ok());

        let reqs = server.received_requests().await.unwrap();
        let posts: Vec<_> = reqs
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST)
            .collect();
        assert!(!posts.is_empty());
        let body: Value = serde_json::from_slice(&posts[0].body).unwrap();
        // Server allowlist (KEEP_FIELDS in hq-pro vault-service /v1/usage):
        //   sessionId, timestamp, uuid, cwd, gitBranch, userType, model,
        //   inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens
        let allowed: std::collections::HashSet<&str> = [
            "sessionId",
            "timestamp",
            "uuid",
            "cwd",
            "gitBranch",
            "userType",
            "model",
            "inputTokens",
            "outputTokens",
            "cacheCreationInputTokens",
            "cacheReadInputTokens",
        ]
        .into_iter()
        .collect();
        for event in body["events"].as_array().unwrap() {
            let obj = event.as_object().unwrap();
            for key in obj.keys() {
                assert!(
                    allowed.contains(key.as_str()),
                    "field `{}` is not in server allowlist",
                    key,
                );
            }
            // `message` must be flattened — no nested object should remain
            assert!(!obj.contains_key("message"), "`message` must not be nested");
            // Sensitive fields must be absent
            for removed in &["content", "thinking", "text", "toolUseIds", "toolResults"] {
                assert!(!obj.contains_key(*removed), "`{}` must be absent", removed);
            }
        }
    }

    // ── (d) 1 MB cap rollover ─────────────────────────────────────────────────

    #[tokio::test]
    async fn test_one_mb_cap_causes_rollover() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-d"}"#);

        // Each row carries two valid maximum-size allowlisted fields. Their
        // aggregate wire payload exceeds 1 MB without relying on rejected data.
        const EVENT_COUNT: usize = 150;
        let bounded_path = "x".repeat(MAX_PATH_BYTES);
        let mut lines = Vec::new();
        for i in 0..EVENT_COUNT {
            let row = json!({
                "type": "user",
                "timestamp": format!("2026-04-25T10:00:{:02}Z", i % 60),
                "sessionId": "s1",
                "uuid": format!("u{}", i),
                "parentUuid": null,
                "userType": "human",
                "entrypoint": "cli",
                "cwd": bounded_path.clone(),
                "gitBranch": bounded_path.clone(),
                "version": "1.0",
                "message": {"role": "user", "content": [{"type": "text", "text": "hi"}], "id": "m"}
            });
            lines.push(serde_json::to_string(&row).unwrap());
        }
        let lines_str: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        let path = write_jsonl(home.path(), "proj", "large.jsonl", &lines_str);

        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();
        let result = send_telemetry_if_opted_in(&handle, "/hq", "tok").await;

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        assert!(result.is_ok());

        let reqs = server.received_requests().await.unwrap();
        let posts: Vec<_> = reqs
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST)
            .collect();
        assert!(
            posts.len() >= 2,
            "expected ≥2 POSTs due to 1 MB rollover, got {}",
            posts.len()
        );

        let submitted_events: usize = posts
            .iter()
            .map(|post| {
                assert!(
                    post.body.len() <= MAX_BATCH_BYTES,
                    "every batch must be at most 1 MB, got {} bytes",
                    post.body.len()
                );
                serde_json::from_slice::<Value>(&post.body).unwrap()["events"]
                    .as_array()
                    .unwrap()
                    .len()
            })
            .sum();
        assert_eq!(submitted_events, EVENT_COUNT);
        let cursor = read_cursor(home.path());
        assert_eq!(
            cursor.files[&normalize_cursor_file_key(&path)].offset,
            fs::metadata(path).unwrap().len()
        );
    }

    // ── finding #6: a withdrawal made MID-CYCLE halts emission at once ─────────
    //
    // A collection cycle can span several 1 MB batches. If consent is checked
    // only once at the top, an in-flight cycle keeps flushing batches after the
    // user withdraws. Here the top-of-cycle check sees "enabled" (so the cycle
    // starts and flushes batch 1), then the server flips to "declined"; the
    // per-flush re-check must then STOP — no further batch may be POSTed.
    #[tokio::test]
    async fn test_withdrawal_mid_cycle_halts_further_batches() {
        let server = MockServer::start().await;
        // The cycle re-checks consent before EACH flush past the first. With ~2
        // batches there are two consent GETs after the top-of-cycle one: the
        // rollover between batch 1 and batch 2, and the final flush. Model:
        // top-check + rollover both see "enabled" (so batch 1 is emitted), then
        // the final re-check sees the withdrawal → batch 2 is dropped. So the
        // first TWO GETs return enabled, and every one after returns declined.
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .up_to_n_times(2)
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": false})))
            .with_priority(2)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-midwithdraw"}"#);

        // Use the same valid bounded aggregate as the rollover test so this
        // genuinely reaches a second flush.
        let bounded_path = "x".repeat(MAX_PATH_BYTES);
        let mut lines = Vec::new();
        for i in 0..150usize {
            let row = json!({
                "type": "user",
                "timestamp": format!("2026-04-25T10:00:{:02}Z", i % 60),
                "sessionId": "s1",
                "uuid": format!("u{}", i),
                "parentUuid": null,
                "userType": "human",
                "entrypoint": "cli",
                "cwd": bounded_path.clone(),
                "gitBranch": bounded_path.clone(),
                "version": "1.0",
                "message": {"role": "user", "content": [{"type": "text", "text": "hi"}], "id": "m"}
            });
            lines.push(serde_json::to_string(&row).unwrap());
        }
        let lines_str: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_jsonl(home.path(), "proj", "large.jsonl", &lines_str);

        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();
        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        // Batch 1 flushed while still opted in; the withdrawal detected before
        // the next flush stops emission — so exactly ONE usage POST, not ≥2.
        let usage_posts = server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST && r.url.path() == "/v1/usage")
            .count();
        assert_eq!(
            usage_posts, 1,
            "a mid-cycle withdrawal must halt further batches — the cycle emits \
             what was in flight, then stops the moment the server records the \
             withdrawal"
        );
    }

    #[tokio::test]
    async fn withdrawal_during_single_batch_scan_prevents_first_post() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"enabled": true})))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"enabled": false})))
            .with_priority(2)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-single-withdraw"}"#);
        write_jsonl(home.path(), "proj", "single.jsonl", &[USER_ROW]);
        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();
        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        let requests = server.received_requests().await.unwrap();
        let usage_posts = requests
            .iter()
            .filter(|request| request.method == wiremock::http::Method::POST)
            .count();
        assert_eq!(
            usage_posts, 0,
            "withdrawal before the first POST must stop upload"
        );
    }

    // ── (e) Non-200 does NOT advance cursor ───────────────────────────────────

    #[tokio::test]
    async fn test_non_200_does_not_advance_cursor() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(ResponseTemplate::new(500).set_body_string("error"))
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-e"}"#);
        let jsonl_path = write_jsonl(
            home.path(),
            "proj",
            "s.jsonl",
            &[USER_ROW, ASST_ROW, USER_ROW],
        );

        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();
        let result = send_telemetry_if_opted_in(&handle, "/hq", "tok").await;

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        assert!(result.is_ok());

        let path_str = normalize_cursor_file_key(&jsonl_path);
        // Cursor entry must be absent (or at 0), NOT at EOF
        let cursor_file = home.path().join(".hq/telemetry-cursor.json");
        if cursor_file.exists() {
            let cursor = read_cursor(home.path());
            if let Some(entry) = cursor.files.get(&path_str) {
                assert_eq!(entry.offset, 0, "cursor must not advance on 500");
            }
            // If absent, that's also acceptable
        }
        // Verify that no entry with non-zero offset exists
        if cursor_file.exists() {
            let cursor = read_cursor(home.path());
            let entry_offset = cursor.files.get(&path_str).map(|e| e.offset).unwrap_or(0);
            assert_eq!(
                entry_offset, 0,
                "cursor offset must be 0 (or absent) after failed POST"
            );
        }
    }

    // ── (f) Atomic cursor write ───────────────────────────────────────────────

    #[tokio::test]
    async fn test_atomic_cursor_write_no_tmp_file() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-f"}"#);
        write_jsonl(home.path(), "proj", "s.jsonl", &[USER_ROW]);

        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();
        let result = send_telemetry_if_opted_in(&handle, "/hq", "tok").await;

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        assert!(result.is_ok());
        assert!(
            !home.path().join(".hq/telemetry-cursor.json.tmp").exists(),
            "no .tmp file should remain after atomic write"
        );
        assert!(
            home.path().join(".hq/telemetry-cursor.json").exists(),
            "cursor file must exist after successful run"
        );
    }

    // ── (g) New files discovered between runs start at offset 0 ──────────────

    #[tokio::test]
    async fn test_new_file_between_runs_starts_at_zero() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-g"}"#);

        // Run 1: only fixture A
        let _path_a = write_jsonl(home.path(), "proj-a", "a.jsonl", &[USER_ROW]);
        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();
        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();

        let posts_run1 = server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST)
            .count();
        assert!(posts_run1 >= 1, "run 1 should POST fixture A");

        // Run 2: add fixture B
        let path_b = write_jsonl(home.path(), "proj-b", "b.jsonl", &[ASST_ROW]);
        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        let cursor = read_cursor(home.path());
        let path_b_str = normalize_cursor_file_key(&path_b);
        let b_size = fs::metadata(&path_b).unwrap().len();
        let b_entry = cursor
            .files
            .get(&path_b_str)
            .expect("cursor should have an entry for fixture B after run 2");
        assert_eq!(
            b_entry.offset, b_size,
            "fixture B should be fully consumed in run 2"
        );
    }

    // ── (h) Truncated/rotated file resets cursor ──────────────────────────────

    #[tokio::test]
    async fn test_rotated_file_resets_cursor() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-h"}"#);

        // Run 1: fixture A with 3 rows
        let path_a = write_jsonl(
            home.path(),
            "proj",
            "a.jsonl",
            &[USER_ROW, ASST_ROW, USER_ROW],
        );
        let original_size = fs::metadata(&path_a).unwrap().len();
        assert!(original_size > 0);

        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();
        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();

        // Verify run 1 set cursor to EOF
        let cursor_after_run1 = read_cursor(home.path());
        let path_a_str = normalize_cursor_file_key(&path_a);
        let entry1 = cursor_after_run1.files.get(&path_a_str).unwrap();
        assert_eq!(entry1.offset, original_size);

        // Truncate A to 0 bytes (size < stored_offset → rotation trigger)
        {
            let _f = fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&path_a)
                .unwrap();
        }
        assert_eq!(fs::metadata(&path_a).unwrap().len(), 0);

        // Run 2: A is now empty after truncation
        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        // Cursor for A should be reset to 0
        let cursor_after_run2 = read_cursor(home.path());
        let entry2_offset = cursor_after_run2
            .files
            .get(&path_a_str)
            .map(|e| e.offset)
            .unwrap_or(0);
        assert_eq!(
            entry2_offset, 0,
            "cursor must be reset to 0 after file rotation/truncation"
        );
    }

    // ── (i) GET opt-in HTTP 500 → fallback reads the account-scoped local answer

    #[tokio::test]
    async fn test_opt_in_500_fallback_true_runs_telemetry() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(500).set_body_string("error"))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        // A GENUINE opt-in answer for the signed-in account: enabled + provenance
        // + a subject binding that matches the token. A bare flag would (rightly)
        // no longer be honoured — see test_local_answer_requires_provenance.
        write_menubar(
            home.path(),
            r#"{"machineId":"mid-i1","telemetryEnabled":true,"telemetryOptInAnsweredAt":"2026-07-27T10:00:00Z","telemetryOptInSub":"sub-i1"}"#,
        );
        write_tokens_for_subject(home.path(), "sub-i1");
        write_jsonl(home.path(), "proj", "s.jsonl", &[USER_ROW]);

        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();
        let token = id_token_for_subject("sub-i1");
        let result = send_telemetry_if_opted_in(&handle, "/hq", &token).await;

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        assert!(result.is_ok());
        let reqs = server.received_requests().await.unwrap();
        let posts: Vec<_> = reqs
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST)
            .collect();
        assert!(
            !posts.is_empty(),
            "a genuine account-bound opt-in in fallback → should POST ≥1"
        );
    }

    #[tokio::test]
    async fn test_opt_in_500_fallback_missing_answer_skips_telemetry() {
        // On a server-read failure with NO genuine local answer, collection must
        // NOT happen. This is the finding #4 regression: the old default-true
        // fallback would collect for someone who never answered.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(500).set_body_string("error"))
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-i0"}"#);
        write_tokens_for_subject(home.path(), "sub-i0");
        write_jsonl(home.path(), "proj", "s.jsonl", &[USER_ROW]);

        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();
        let token = id_token_for_subject("sub-i0");
        let result = send_telemetry_if_opted_in(&handle, "/hq", &token).await;

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        assert!(result.is_ok());
        let reqs = server.received_requests().await.unwrap();
        let posts: Vec<_> = reqs
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST)
            .collect();
        assert_eq!(
            posts.len(),
            0,
            "no genuine local answer → fallback resolves to no-collection"
        );
    }

    #[tokio::test]
    async fn test_opt_in_500_fallback_false_skips_telemetry() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(500).set_body_string("error"))
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        // A genuine, account-bound opt-OUT answer for the signed-in account.
        write_menubar(
            home.path(),
            r#"{"machineId":"mid-i2","telemetryEnabled":false,"telemetryOptInAnsweredAt":"2026-07-27T10:00:00Z","telemetryOptInSub":"sub-i2"}"#,
        );
        write_tokens_for_subject(home.path(), "sub-i2");
        write_jsonl(home.path(), "proj", "s.jsonl", &[USER_ROW]);

        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();
        let token = id_token_for_subject("sub-i2");
        let result = send_telemetry_if_opted_in(&handle, "/hq", &token).await;

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        assert!(result.is_ok());
        let reqs = server.received_requests().await.unwrap();
        let posts: Vec<_> = reqs
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST)
            .collect();
        assert_eq!(
            posts.len(),
            0,
            "telemetryEnabled=false in fallback → no POST"
        );
    }

    // ── test_telemetry_strips_prompt_bodies (fixture-based) ───────────────────

    #[test]
    fn test_telemetry_strips_prompt_bodies() {
        let fixtures_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/claude-projects");

        let mut checked = 0usize;
        for entry in walkdir::WalkDir::new(&fixtures_dir)
            .into_iter()
            .flatten()
            .filter(|e| e.path().extension().map_or(false, |x| x == "jsonl"))
        {
            let content = fs::read_to_string(entry.path()).expect("read fixture");
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let parsed: Value = serde_json::from_str(trimmed).expect("parse fixture line");
                let sanitized =
                    sanitize_row(&parsed).expect("sanitize_row must return Some for valid rows");
                let obj = sanitized.as_object().unwrap();

                // Every sanitized field must be in the server's KEEP allowlist
                let allowed: std::collections::HashSet<&str> = [
                    "sessionId",
                    "timestamp",
                    "uuid",
                    "cwd",
                    "gitBranch",
                    "userType",
                    "model",
                    "inputTokens",
                    "outputTokens",
                    "cacheCreationInputTokens",
                    "cacheReadInputTokens",
                ]
                .into_iter()
                .collect();
                for key in obj.keys() {
                    assert!(
                        allowed.contains(key.as_str()),
                        "fixture {:?}: field `{}` is not in server allowlist",
                        entry.path(),
                        key,
                    );
                }
                // Sensitive fields must be absent at top level
                for removed in &["content", "thinking", "text", "toolUseIds", "toolResults"] {
                    assert!(
                        !obj.contains_key(*removed),
                        "fixture {:?}: top-level `{}` must not survive sanitization",
                        entry.path(),
                        removed,
                    );
                }
                // `message` must be flattened
                assert!(
                    !obj.contains_key("message"),
                    "fixture {:?}: `message` must be flattened — no sub-object should remain",
                    entry.path()
                );

                checked += 1;
            }
        }
        assert!(checked > 0, "must have processed at least one fixture row");
    }

    // ── US-005: launch-time re-prompt decision ────────────────────────────────

    use crate::commands::vault_client::TelemetryOptInResponse;

    fn opt_in_resp(
        enabled: bool,
        stale: Option<bool>,
        person_uid: Option<&str>,
    ) -> TelemetryOptInResponse {
        TelemetryOptInResponse {
            enabled,
            updated_at: None,
            unset: Some(false),
            person_uid: person_uid.map(|s| s.to_string()),
            consent_version: None,
            source: None,
            answered_by: None,
            stale,
        }
    }

    #[test]
    fn reprompt_shown_once_for_a_stale_record_then_suppressed() {
        // A stale record with a known person and no prior guard → re-prompt.
        let resp = opt_in_resp(true, Some(true), Some("prs_alice"));
        let first = decide_reprompt(&resp, 1, None, None);
        assert!(first.should_reprompt);
        assert_eq!(first.person_uid.as_deref(), Some("prs_alice"));

        // After the guard records (v1, prs_alice) — whether via dismissal or an
        // answer — the SAME version+person must NOT re-prompt again.
        let second = decide_reprompt(&resp, 1, Some(1), Some("prs_alice"));
        assert!(!second.should_reprompt);
    }

    #[test]
    fn reprompt_not_shown_when_record_is_current() {
        // A current, self-given answer is never stale, so never re-prompted.
        let resp = opt_in_resp(true, Some(false), Some("prs_alice"));
        assert!(!decide_reprompt(&resp, 1, None, None).should_reprompt);
    }

    #[test]
    fn reprompt_suppressed_when_server_omits_the_stale_field() {
        // An older server that predates `stale` sends `None`. The client must not
        // re-derive staleness; `None` means "do not re-prompt".
        let resp = opt_in_resp(true, None, Some("prs_alice"));
        assert!(!decide_reprompt(&resp, 1, None, None).should_reprompt);
    }

    #[test]
    fn reprompt_suppressed_without_a_person_to_key_the_guard() {
        // Stale but no person_uid: re-prompting would re-fire every launch because
        // the "shown once" guard could not be keyed to anyone. Fail safe.
        let resp = opt_in_resp(true, Some(true), None);
        let decision = decide_reprompt(&resp, 1, None, None);
        assert!(!decision.should_reprompt);
        assert!(decision.person_uid.is_none());
    }

    #[test]
    fn reprompt_re_fires_when_the_consent_version_is_bumped() {
        // Guard names (v1, prs_alice); the current version is now 2. The bump
        // makes the stored pair no longer match, so a still-stale record is
        // re-prompted once more.
        let resp = opt_in_resp(true, Some(true), Some("prs_alice"));
        assert!(decide_reprompt(&resp, 2, Some(1), Some("prs_alice")).should_reprompt);
    }

    #[test]
    fn reprompt_re_fires_for_a_different_person_on_the_same_machine() {
        // The guard is keyed per person: a machine where prs_alice was already
        // re-prompted must still re-prompt prs_bob (a stale record of his own).
        let resp = opt_in_resp(true, Some(true), Some("prs_bob"));
        assert!(decide_reprompt(&resp, 1, Some(1), Some("prs_alice")).should_reprompt);
    }

    #[test]
    fn reprompt_guard_round_trips_through_menubar_json() {
        let home = setup_home();
        let path = home.path().join(".hq/menubar.json");
        write_menubar(home.path(), r#"{"machineId":"mid-reprompt"}"#);

        // No guard written yet.
        assert_eq!(read_reprompt_guard(&path), (None, None));

        // Marking writes the (version, person) pair and preserves other keys.
        hq_desktop_core::first_run::merge_menubar_flags(
            &path,
            &[
                (REPROMPT_VERSION_KEY, Value::from(1u32)),
                (REPROMPT_PERSON_KEY, Value::String("prs_alice".to_string())),
            ],
        )
        .unwrap();

        assert_eq!(
            read_reprompt_guard(&path),
            (Some(1), Some("prs_alice".to_string()))
        );
        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["machineId"], "mid-reprompt");
    }

    // ── findings #3 / #7: offline withdrawal survives reconciliation, and the
    //    replay carries the cached surface + consent version. ──────────────────

    #[test]
    fn local_answer_is_newer_compares_timestamps_and_fails_safe() {
        // Strictly newer local answer → true (an offline decision the server
        // hasn't seen).
        assert!(local_answer_is_newer(
            Some("2026-07-28T10:00:00Z"),
            Some("2026-07-27T10:00:00Z"),
        ));
        // Same or older → false (the server is authoritative).
        assert!(!local_answer_is_newer(
            Some("2026-07-27T10:00:00Z"),
            Some("2026-07-27T10:00:00Z"),
        ));
        assert!(!local_answer_is_newer(
            Some("2026-07-26T10:00:00Z"),
            Some("2026-07-27T10:00:00Z"),
        ));
        // Missing or unparseable → fail SAFE (never clobber).
        assert!(!local_answer_is_newer(None, Some("2026-07-27T10:00:00Z")));
        assert!(!local_answer_is_newer(Some("2026-07-27T10:00:00Z"), None));
        assert!(!local_answer_is_newer(
            Some("garbage"),
            Some("2026-07-27T10:00:00Z")
        ));
    }

    /// Mount a GET `/v1/usage/opt-in` returning `get_body`, and a POST
    /// `/v1/usage/opt-in` that accepts the replay so requests can be inspected.
    async fn mount_opt_in(server: &MockServer, get_body: Value) {
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&get_body))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(server)
            .await;
    }

    fn opt_in_posts(reqs: &[wiremock::Request]) -> Vec<Value> {
        reqs.iter()
            .filter(|r| {
                r.method == wiremock::http::Method::POST && r.url.path() == "/v1/usage/opt-in"
            })
            .map(|r| serde_json::from_slice(&r.body).unwrap())
            .collect()
    }

    // Finding #3: an offline withdrawal recorded AFTER the server last saw `true`
    // must be replayed (unconditionally) so it wins — never dropped because "the
    // server already has an answer".
    #[tokio::test]
    async fn reassert_replays_a_newer_offline_withdrawal_unconditionally() {
        let server = MockServer::start().await;
        // Server still holds the stale `true`, last written yesterday.
        mount_opt_in(
            &server,
            json!({
                "enabled": true,
                "updatedAt": "2026-07-27T10:00:00Z",
                "unset": false,
                "personUid": "prs_alice"
            }),
        )
        .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        // Local record: a genuine, account-bound WITHDRAWAL made offline TODAY,
        // newer than the server's value, with cached provenance.
        write_menubar(
            home.path(),
            r#"{"machineId":"mid-wd","telemetryEnabled":false,"telemetryOptInAnsweredAt":"2026-07-28T09:00:00Z","telemetryOptInSub":"sub-alice","telemetryOptInSurface":"settings","telemetryConsentVersion":1}"#,
        );
        std::env::set_var("HOME", home.path());

        let vault = VaultClient::new(server.uri(), id_token_for_subject("sub-alice"));
        reassert_consent_for_person(&vault, "prs_alice").await;

        std::env::remove_var("HOME");

        let posts = opt_in_posts(&server.received_requests().await.unwrap());
        assert_eq!(posts.len(), 1, "the newer withdrawal must be replayed");
        // It wins: enabled=false, written UNCONDITIONALLY (no onlyIfUnset), and
        // carries the cached provenance (finding #7).
        assert_eq!(posts[0]["enabled"], json!(false));
        assert!(
            posts[0].get("onlyIfUnset").is_none(),
            "a newer withdrawal is written unconditionally so it cannot be dropped"
        );
        assert_eq!(posts[0]["surface"], json!("settings"));
        assert_eq!(posts[0]["consentVersion"], json!(1));
    }

    // Finding #3 (converse): when the server's answer is at least as new as the
    // local one, the server is authoritative — do NOT replay.
    #[tokio::test]
    async fn reassert_does_not_replay_when_server_answer_is_newer() {
        let server = MockServer::start().await;
        mount_opt_in(
            &server,
            json!({
                "enabled": true,
                "updatedAt": "2026-07-29T10:00:00Z",
                "unset": false,
                "personUid": "prs_alice"
            }),
        )
        .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        // Local answer is OLDER than the server's.
        write_menubar(
            home.path(),
            r#"{"machineId":"mid-old","telemetryEnabled":false,"telemetryOptInAnsweredAt":"2026-07-28T09:00:00Z","telemetryOptInSub":"sub-alice"}"#,
        );
        std::env::set_var("HOME", home.path());

        let vault = VaultClient::new(server.uri(), id_token_for_subject("sub-alice"));
        reassert_consent_for_person(&vault, "prs_alice").await;

        std::env::remove_var("HOME");

        let posts = opt_in_posts(&server.received_requests().await.unwrap());
        assert_eq!(posts.len(), 0, "the server's newer answer is authoritative");
    }

    // Finding #7: on a server that has NO answer, the conditional replay still
    // carries the cached surface + consent version.
    #[tokio::test]
    async fn reassert_replay_on_unset_server_carries_cached_provenance() {
        let server = MockServer::start().await;
        mount_opt_in(
            &server,
            json!({
                "enabled": false,
                "updatedAt": null,
                "unset": true,
                "personUid": "prs_alice"
            }),
        )
        .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(
            home.path(),
            r#"{"machineId":"mid-unset","telemetryEnabled":true,"telemetryOptInAnsweredAt":"2026-07-28T09:00:00Z","telemetryOptInSub":"sub-alice","telemetryOptInSurface":"onboarding","telemetryConsentVersion":1}"#,
        );
        std::env::set_var("HOME", home.path());

        let vault = VaultClient::new(server.uri(), id_token_for_subject("sub-alice"));
        reassert_consent_for_person(&vault, "prs_alice").await;

        std::env::remove_var("HOME");

        let posts = opt_in_posts(&server.received_requests().await.unwrap());
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0]["enabled"], json!(true));
        assert_eq!(posts[0]["onlyIfUnset"], json!(true));
        assert_eq!(posts[0]["surface"], json!("onboarding"));
        assert_eq!(posts[0]["consentVersion"], json!(1));
    }
    fn write_codex_rollout(home: &std::path::Path, contents: &str) -> std::path::PathBuf {
        let dir = home.join(".codex/sessions/2026/07/23");
        fs::create_dir_all(&dir).unwrap();
        let path =
            dir.join("rollout-2026-07-23T10-00-00-019de12c-d83e-78c2-9bb3-cbb8146965e4.jsonl");
        fs::write(&path, contents).unwrap();
        path
    }

    const MULTI_DATE_CODEX_ROLLOUT: &str = concat!(
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"fixture-session\",\"cwd\":\"/repo\",\"git\":{\"branch\":\"feature/telemetry\"}}}\n",
        "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-fixture\"}}\n",
        "{\"timestamp\":\"2026-07-28T23:59:59Z\",\"uuid\":\"fixture-1\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":10,\"output_tokens\":3,\"reasoning_output_tokens\":2,\"cached_input_tokens\":4},\"total_token_usage\":{\"input_tokens\":10,\"output_tokens\":3,\"reasoning_output_tokens\":2,\"cached_input_tokens\":4}}}}\n",
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"base_instructions\",\"text\":\"sensitive instructions must stay local\"}}\n",
        "{\"timestamp\":\"2026-07-29T00:00:01Z\",\"uuid\":\"fixture-2\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":7,\"output_tokens\":5,\"reasoning_output_tokens\":1,\"cached_input_tokens\":2},\"total_token_usage\":{\"input_tokens\":17,\"output_tokens\":8,\"reasoning_output_tokens\":3,\"cached_input_tokens\":6}}}}\n",
        "{\"type\":\"function_call_output\",\"payload\":{\"output\":\"sensitive tool output must stay local\"}}\n",
        "{\"timestamp\":\"2026-07-29T00:00:02Z\",\"uuid\":\"fixture-3\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":2,\"output_tokens\":1,\"reasoning_output_tokens\":4,\"cached_input_tokens\":1},\"total_token_usage\":{\"input_tokens\":19,\"output_tokens\":9,\"reasoning_output_tokens\":7,\"cached_input_tokens\":7}}}}\n",
    );

    fn codex_fixture(model: &str, uuid: &str) -> String {
        [
            json!({"type":"session_meta","payload":{"id":"codex-session","cwd":"/repo","git_branch":"main"}}),
            json!({"type":"turn_context","payload":{"model":model}}),
            json!({"timestamp":uuid,"uuid":uuid,"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":2,"output_tokens":3}}}}),
        ]
        .into_iter().map(|row| row.to_string()).collect::<Vec<_>>().join("\n") + "\n"
    }

    async fn post_bodies(server: &MockServer) -> Vec<Value> {
        server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|request| request.method == wiremock::http::Method::POST)
            .map(|request| serde_json::from_slice(&request.body).unwrap())
            .collect()
    }

    #[test]
    fn missing_codex_uuid_is_stable_across_replay() {
        let record = json!({
            "timestamp": "2026-07-29T10:00:00Z",
            "type": "event_msg",
            "payload": {"type": "token_count", "info": {"last_token_usage": {
                "input_tokens": 2, "output_tokens": 3
            }}}
        });
        let mut first_context = CodexUsageContext::new("rollout-a");
        let first = codex_usage_row_at(&record, &mut first_context, "rollout-a", 120, 240).unwrap();
        let mut replay_context = CodexUsageContext::new("rollout-a");
        let replay =
            codex_usage_row_at(&record, &mut replay_context, "rollout-a", 120, 240).unwrap();
        let mut other_line_context = CodexUsageContext::new("rollout-a");
        let other_line =
            codex_usage_row_at(&record, &mut other_line_context, "rollout-a", 241, 361).unwrap();

        assert_eq!(first["uuid"], replay["uuid"]);
        assert_ne!(first["uuid"], other_line["uuid"]);
        assert!(first["uuid"].as_str().unwrap().starts_with("codex-"));
    }

    #[test]
    fn unterminated_eof_fragment_retries_after_append_completion() {
        use std::io::Write;

        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("rollout.jsonl");
        let complete = json!({
            "timestamp": "final",
            "type": "event_msg",
            "payload": {"type": "token_count", "info": {"last_token_usage": {
                "input_tokens": 1, "output_tokens": 2
            }}}
        })
        .to_string();
        let fragment = &complete[..complete.len() - 1];
        fs::write(&path, fragment).unwrap();
        let saved = CodexUsageContext {
            turn_model: Some("fragment-model".to_string()),
            ..CodexUsageContext::default()
        };

        let mut first =
            CodexRolloutScanner::open(&path, 0, "rollout", Some(saved.clone())).unwrap();
        assert!(first.next_bounded(u64::MAX).is_none());

        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"}")
            .unwrap();
        let mut retry = CodexRolloutScanner::open(&path, 0, "rollout", Some(saved)).unwrap();
        let (row, offset, _) = retry.next_bounded(u64::MAX).unwrap();
        assert_eq!(row.unwrap()["model"], "fragment-model");
        assert_eq!(offset, complete.len() as u64);
    }

    #[test]
    fn ordinary_line_crossing_scan_slice_rewinds_and_emits_next_cycle() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("rollout.jsonl");
        let record = json!({
            "timestamp": "2026-07-29T10:00:00Z",
            "uuid": "slice-boundary-event",
            "type": "event_msg",
            "payload": {"type": "token_count", "info": {"last_token_usage": {
                "input_tokens": 1, "output_tokens": 2
            }}}
        })
        .to_string()
            + "\n";
        fs::write(&path, &record).unwrap();
        let saved = CodexUsageContext {
            turn_model: Some("slice-model".to_string()),
            ..CodexUsageContext::default()
        };

        let mut first =
            CodexRolloutScanner::open(&path, 0, "rollout", Some(saved.clone())).unwrap();
        assert!(first.next_bounded((record.len() / 2) as u64).is_none());
        assert_eq!(first.reader.stream_position().unwrap(), 0);

        let mut next_cycle = CodexRolloutScanner::open(&path, 0, "rollout", Some(saved)).unwrap();
        let (row, offset, context) = next_cycle.next_bounded(record.len() as u64).unwrap();
        let row = row.unwrap();
        assert_eq!(row["uuid"], "slice-boundary-event");
        assert_eq!(row["model"], "slice-model");
        assert_eq!(offset, record.len() as u64);
        assert!(!context.discarding_partial_line);
    }

    #[test]
    fn sanitizer_rejects_nested_and_unbounded_scalar_metadata() {
        let secret = "private-prompt-fragment";
        let row = sanitize_row(&json!({
            "timestamp": {"nested": secret},
            "uuid": [secret],
            "sessionId": secret.repeat(MAX_ID_BYTES),
            "cwd": {"nested": secret},
            "gitBranch": secret.repeat(MAX_PATH_BYTES),
            "userType": true,
            "message": {
                "model": {"nested": secret},
                "usage": {
                    "input_tokens": secret,
                    "output_tokens": {"nested": secret}
                }
            }
        }))
        .unwrap();

        assert_eq!(row, json!({}));
        assert!(!serde_json::to_string(&row).unwrap().contains(secret));
    }

    #[test]
    fn old_cursor_without_upload_backoff_fields_uses_zero_defaults() {
        let cursor: TelemetryCursor = serde_json::from_value(json!({
            "version": "1",
            "files": {}
        }))
        .unwrap();

        assert_eq!(cursor.consecutive_unaccepted_flushes, 0);
        assert_eq!(cursor.retry_after_unix_secs, 0);
    }

    #[test]
    fn settled_ack_requires_every_submitted_event() {
        let full = UsageAck {
            ok: true,
            written: 2,
            deduped: 0,
            skipped: vec![],
        };
        let deduped = UsageAck {
            ok: true,
            written: 1,
            deduped: 1,
            skipped: vec![],
        };
        let partial = UsageAck {
            ok: true,
            written: 1,
            deduped: 0,
            skipped: vec![],
        };
        let skipped = UsageAck {
            ok: true,
            written: 1,
            deduped: 0,
            skipped: vec![json!({"index": 1, "code": "invalid"})],
        };
        let duplicate_skips = UsageAck {
            ok: true,
            written: 0,
            deduped: 0,
            skipped: vec![
                json!({"index": 0, "code": "invalid"}),
                json!({"index": 0, "code": "invalid"}),
            ],
        };
        let out_of_range_skip = UsageAck {
            ok: true,
            written: 0,
            deduped: 0,
            skipped: vec![json!({"index": 2, "code": "invalid"})],
        };
        let missing_index = UsageAck {
            ok: true,
            written: 1,
            deduped: 0,
            skipped: vec![json!({"code": "invalid"})],
        };

        assert!(usage_ack_is_complete(&full, 2));
        assert!(usage_ack_is_complete(&deduped, 2));
        assert!(usage_ack_is_complete(&skipped, 2));
        assert!(!usage_ack_is_complete(&partial, 2));
        assert!(!usage_ack_is_complete(&duplicate_skips, 2));
        assert!(!usage_ack_is_complete(&out_of_range_skip, 2));
        assert!(!usage_ack_is_complete(&missing_index, 2));
        assert!(!usage_ack_is_complete(
            &UsageAck {
                ok: true,
                written: 0,
                deduped: 0,
                skipped: vec![json!({"index": 1, "code": "invalid"})],
            },
            2
        ));
    }

    #[tokio::test]
    async fn partial_http_ack_keeps_sources_until_full_retry() {
        let partial_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"enabled": true})))
            .mount(&partial_server)
            .await;
        let partial_vault = VaultClient::new(partial_server.uri(), "token");

        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "ok": true,
                "written": 0,
                "deduped": 0,
                "skipped": []
            })))
            .mount(&partial_server)
            .await;
        let source = || test_source("rollout", 99);
        let event = || json!({"uuid": "stable-event", "inputTokens": 1});
        let (mut planner, batch) = test_upload_batch(
            "machine",
            "version",
            Some("9.9.9"),
            vec![event()],
            vec![source()],
        );
        let mut committed = HashMap::new();
        let mut cursor = TelemetryCursor::default();

        assert_eq!(
            flush_batch(
                &partial_vault,
                &partial_server.uri(),
                "token",
                "machine",
                "version",
                Some("9.9.9"),
                &mut cursor,
                1_000,
                &mut planner,
                batch,
                &mut committed,
            )
            .await,
            FlushOutcome::Unaccepted {
                reason: "ack_count_mismatch"
            }
        );
        assert!(committed.is_empty());

        let full_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"enabled": true})))
            .mount(&full_server)
            .await;
        let full_vault = VaultClient::new(full_server.uri(), "token");

        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&full_server)
            .await;
        let (mut retry_planner, retry_batch) = test_upload_batch(
            "machine",
            "version",
            Some("9.9.9"),
            vec![event()],
            vec![source()],
        );
        assert!(flush_batch(
            &full_vault,
            &full_server.uri(),
            "token",
            "machine",
            "version",
            Some("9.9.9"),
            &mut cursor,
            1_001,
            &mut retry_planner,
            retry_batch,
            &mut committed,
        )
        .await
        .is_accepted());
        assert_eq!(committed["rollout"].offset, 99);
        assert_eq!(cursor.consecutive_unaccepted_flushes, 0);
        let partial_body = post_bodies(&partial_server).await;
        let retry_body = post_bodies(&full_server).await;
        assert_eq!(partial_body[0]["events"][0]["uuid"], "stable-event");
        assert_eq!(retry_body[0]["events"][0]["uuid"], "stable-event");
    }

    #[tokio::test]
    async fn fully_accounted_skipped_ack_commits_cursor_and_prevents_resend() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(|request: &wiremock::Request| {
                let event_count = serde_json::from_slice::<Value>(&request.body)
                    .ok()
                    .and_then(|body| body.get("events").and_then(Value::as_array).map(Vec::len))
                    .unwrap_or(0);
                let skipped = (0..event_count)
                    .map(|index| json!({"index": index, "code": "invalid"}))
                    .collect::<Vec<_>>();
                ResponseTemplate::new(200).set_body_json(json!({
                    "ok": true,
                    "written": 0,
                    "deduped": 0,
                    "skipped": skipped
                }))
            })
            .mount(&server)
            .await;

        let _guard = ENV_MUTEX.lock().unwrap_or_else(|error| error.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"skip-ack"}"#);
        let source_path = write_jsonl(
            home.path(),
            "project",
            "session.jsonl",
            &[USER_ROW, ASST_ROW],
        );
        let source_key = normalize_cursor_file_key(&source_path);
        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());
        let app = make_app_handle();

        send_telemetry_if_opted_in(&app, "/hq", "test-jwt")
            .await
            .unwrap();
        let cursor = read_cursor(home.path());
        assert_eq!(
            cursor.files[&source_key].offset,
            fs::metadata(&source_path).unwrap().len()
        );

        send_telemetry_if_opted_in(&app, "/hq", "test-jwt")
            .await
            .unwrap();
        std::env::remove_var("HOME");
        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        assert_eq!(post_bodies(&server).await.len(), 1);
    }

    #[tokio::test]
    async fn third_unaccepted_flush_suppresses_next_cycle_inside_backoff() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"enabled": true})))
            .mount(&server)
            .await;
        let posts = Arc::new(AtomicUsize::new(0));
        let post_counter = posts.clone();
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(move |request: &wiremock::Request| {
                let attempt = post_counter.fetch_add(1, Ordering::SeqCst);
                if attempt < 3 {
                    ResponseTemplate::new(500).set_body_string("retry")
                } else {
                    complete_ack(request)
                }
            })
            .mount(&server)
            .await;

        let _guard = ENV_MUTEX.lock().unwrap_or_else(|error| error.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"backoff"}"#);
        write_jsonl(home.path(), "project", "session.jsonl", &[USER_ROW]);
        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());
        let app = make_app_handle();

        for _ in 0..3 {
            send_telemetry_if_opted_in(&app, "/hq", "test-jwt")
                .await
                .unwrap();
        }
        let mut cursor = read_cursor(home.path());
        assert_eq!(cursor.consecutive_unaccepted_flushes, 3);
        assert!(cursor.retry_after_unix_secs > unix_now_secs());

        send_telemetry_if_opted_in(&app, "/hq", "test-jwt")
            .await
            .unwrap();
        assert_eq!(posts.load(Ordering::SeqCst), 3);

        // Move the persisted deadline to the past so the accepted response can
        // prove it resets the counter without sleeping through the real delay.
        cursor.retry_after_unix_secs = 0;
        save_cursor(&cursor).unwrap();
        send_telemetry_if_opted_in(&app, "/hq", "test-jwt")
            .await
            .unwrap();

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");
        assert_eq!(posts.load(Ordering::SeqCst), 4);
        let cursor = read_cursor(home.path());
        assert_eq!(cursor.consecutive_unaccepted_flushes, 0);
        assert_eq!(cursor.retry_after_unix_secs, 0);
    }

    #[tokio::test]
    async fn overlapping_cycles_serialize_backoff_cursor_updates() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"enabled": true})))
            .mount(&server)
            .await;
        let posts = Arc::new(AtomicUsize::new(0));
        let post_counter = posts.clone();
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(move |_request: &wiremock::Request| {
                post_counter.fetch_add(1, Ordering::SeqCst);
                ResponseTemplate::new(500)
                    .set_delay(Duration::from_millis(100))
                    .set_body_string("retry")
            })
            .mount(&server)
            .await;

        let _guard = ENV_MUTEX.lock().unwrap_or_else(|error| error.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"overlapping"}"#);
        write_jsonl(home.path(), "project", "session.jsonl", &[USER_ROW]);
        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_TEST_HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());
        let app = make_app_handle();

        let first = send_telemetry_if_opted_in(&app, "/hq", "test-jwt");
        let second = send_telemetry_if_opted_in(&app, "/hq", "test-jwt");
        let (first, second) = tokio::join!(first, second);
        first.unwrap();
        second.unwrap();

        std::env::remove_var("HOME");
        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");
        assert_eq!(posts.load(Ordering::SeqCst), 2);
        assert_eq!(read_cursor(home.path()).consecutive_unaccepted_flushes, 2);
    }

    #[tokio::test]
    async fn retry_delay_starts_at_flush_failure_time() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(ResponseTemplate::new(500).set_body_string("retry"))
            .mount(&server)
            .await;

        let vault = VaultClient::new(server.uri(), "token");
        let (mut planner, batch) = test_upload_batch(
            "machine",
            "version",
            None,
            vec![json!({"uuid": "event", "inputTokens": 1})],
            vec![test_source("rollout", 99)],
        );
        let mut cursor = TelemetryCursor {
            consecutive_unaccepted_flushes: 2,
            ..TelemetryCursor::default()
        };
        let mut committed = HashMap::new();

        assert!(matches!(
            flush_batch(
                &vault,
                &server.uri(),
                "token",
                "machine",
                "version",
                None,
                &mut cursor,
                1,
                &mut planner,
                batch,
                &mut committed,
            )
            .await,
            FlushOutcome::Unaccepted {
                reason: "http_status"
            }
        ));
        assert!(cursor.retry_after_unix_secs > unix_now_secs() + 298);
    }

    #[test]
    fn unaccepted_flush_backoff_grows_exponentially_and_caps_at_one_hour() {
        assert_eq!(usage_retry_delay_secs(0), 0);
        assert_eq!(usage_retry_delay_secs(2), 0);
        assert_eq!(usage_retry_delay_secs(3), 5 * 60);
        assert_eq!(usage_retry_delay_secs(4), 10 * 60);
        assert_eq!(usage_retry_delay_secs(5), 20 * 60);
        assert_eq!(usage_retry_delay_secs(6), 40 * 60);
        assert_eq!(usage_retry_delay_secs(7), 60 * 60);
        assert_eq!(usage_retry_delay_secs(u8::MAX), 60 * 60);
    }

    #[tokio::test]
    async fn unparseable_success_ack_keeps_sources_uncommitted() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not-json"))
            .mount(&server)
            .await;

        let vault = VaultClient::new(server.uri(), "token");
        let (mut planner, batch) = test_upload_batch(
            "machine",
            "version",
            None,
            vec![json!({"uuid": "event", "inputTokens": 1})],
            vec![test_source("rollout", 99)],
        );
        let mut cursor = TelemetryCursor::default();
        let mut committed = HashMap::new();

        assert_eq!(
            flush_batch(
                &vault,
                &server.uri(),
                "token",
                "machine",
                "version",
                None,
                &mut cursor,
                1_000,
                &mut planner,
                batch,
                &mut committed,
            )
            .await,
            FlushOutcome::Unaccepted {
                reason: "unparseable_ack"
            }
        );
        assert!(committed.is_empty());
        assert_eq!(cursor.consecutive_unaccepted_flushes, 1);
    }

    #[test]
    fn source_checkpoints_coalesce_per_file() {
        let mut planner = UsageUploadPlanner::new(0, MAX_BATCH_BYTES, None);
        for offset in 1..=10_000 {
            planner.record_source(test_source("rollout-a", offset));
        }
        planner.record_source(test_source("rollout-b", 7));
        let sources = planner.take_zero_event_sources().unwrap();

        assert_eq!(sources.len(), 2);
        assert_eq!(
            sources
                .iter()
                .find(|s| s.file_path == "rollout-a")
                .unwrap()
                .end_offset,
            10_000
        );
    }

    #[test]
    fn unshippable_single_event_is_detected_without_serializing_content_to_logs() {
        let secret = "private-content".repeat(MAX_BATCH_BYTES);
        let event = json!({"cwd": secret});
        assert!(!single_event_fits("machine", "version", &event));

        let sanitized = sanitize_row(&event).unwrap();
        assert!(single_event_fits("machine", "version", &sanitized));
        assert_eq!(sanitized, json!({}));
    }

    #[test]
    fn rollout_order_prefers_fresh_work_over_old_backfill() {
        use std::time::{Duration, SystemTime};

        let rollout = |id: &str, age_secs: u64| {
            (
                id.to_string(),
                RolloutFile {
                    path: std::path::PathBuf::from(id),
                    size: 1,
                    mtime: SystemTime::UNIX_EPOCH + Duration::from_secs(age_secs),
                },
            )
        };
        let mut rollouts = vec![
            rollout("old", 1),
            rollout("fresh", 10),
            rollout("middle", 5),
        ];
        sort_rollouts_freshest_first(&mut rollouts);
        assert_eq!(
            rollouts
                .into_iter()
                .map(|entry| entry.0)
                .collect::<Vec<_>>(),
            ["fresh", "middle", "old"]
        );
    }

    #[tokio::test]
    async fn older_rollout_advances_while_newer_rollout_keeps_growing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"enabled": true})))
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"codex-fair"}"#);
        let dir = home.path().join(".codex/sessions/2026/07/29");
        fs::create_dir_all(&dir).unwrap();
        let older_path =
            dir.join("rollout-2026-07-29T10-00-00-019de12c-d83e-78c2-9bb3-cbb8146965e1.jsonl");
        let newer_path =
            dir.join("rollout-2026-07-29T11-00-00-019de12c-d83e-78c2-9bb3-cbb8146965e2.jsonl");
        let padding =
            json!({"type":"event_msg","payload":{"type":"user_message","message":"x".repeat(1024)}})
                .to_string() + "\n";
        let mut older = String::new();
        while older.len() < 3 * 1024 * 1024 {
            older.push_str(&padding);
        }
        fs::write(&older_path, &older).unwrap();
        fs::write(&newer_path, &older).unwrap();

        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());
        let handle = make_app_handle();
        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        let first_cursor = read_cursor(home.path());
        let older_key = normalize_cursor_file_key(&older_path);
        let newer_key = normalize_cursor_file_key(&newer_path);
        let first_older_offset = first_cursor.files[&older_key].offset;
        assert!(first_older_offset > 0);
        assert!(first_older_offset < older.len() as u64);

        use std::io::Write;
        let growth = padding.repeat(1024);
        fs::OpenOptions::new()
            .append(true)
            .open(&newer_path)
            .unwrap()
            .write_all(growth.as_bytes())
            .unwrap();

        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        std::env::remove_var("HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        let second_cursor = read_cursor(home.path());
        assert!(
            second_cursor.files[&older_key].offset > first_older_offset,
            "the older rollout must advance on every bounded pass"
        );
        assert_eq!(
            second_cursor.files[&older_key].offset,
            older.len() as u64,
            "the older backfill completes despite fresh work"
        );
        assert!(
            second_cursor.files[&newer_key].offset < (older.len() + growth.len()) as u64,
            "the growing rollout remains bounded by its fair slice"
        );
    }

    #[tokio::test]
    async fn more_than_sixty_four_near_limit_lines_advance_across_bounded_syncs() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"codex-many-rollouts"}"#);
        let dir = home.path().join(".codex/sessions/2026/07/29");
        fs::create_dir_all(&dir).unwrap();
        const ROLLOUT_COUNT: usize = 65;
        let old_divided_slice = MAX_CODEX_SCAN_BYTES_PER_SYNC / ROLLOUT_COUNT as u64;
        let mut rollouts = Vec::new();
        for index in 0..ROLLOUT_COUNT {
            let rollout_id = format!("019de12c-d83e-78c2-9bb3-{index:012x}");
            let path = dir.join(format!("rollout-2026-07-29T10-00-00-{rollout_id}.jsonl"));
            let line = json!({
                "timestamp":"2026-07-29T10:00:00Z",
                "type":"event_msg",
                "padding":"x".repeat(64_800),
                "payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":2,"output_tokens":3}}}
            })
            .to_string()
                + "\n";
            assert!(line.len() as u64 > old_divided_slice);
            assert!(line.len() as u64 <= MAX_CODEX_LINE_BYTES);
            fs::write(&path, &line).unwrap();
            rollouts.push((normalize_cursor_file_key(&path), line.len() as u64));
        }

        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());
        let handle = make_app_handle();
        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();

        let first = read_cursor(home.path());
        let advanced = rollouts
            .iter()
            .filter(|(path, _)| first.files[path].offset > 0)
            .count();
        let deferred: Vec<_> = rollouts
            .iter()
            .filter(|(path, _)| first.files[path].offset == 0)
            .collect();
        assert_eq!(advanced, 64);
        assert_eq!(deferred.len(), 1);
        assert_eq!(
            first.codex_next_rollout.as_deref(),
            Some(deferred[0].0.as_str())
        );

        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        std::env::remove_var("HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        let second = read_cursor(home.path());
        assert!(rollouts
            .iter()
            .all(|(path, size)| second.files[path].offset == *size));
        assert!(second.codex_next_rollout.is_none());
    }

    #[tokio::test]
    async fn dense_rollouts_share_global_batch_cap_without_starvation() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"codex-batch-fair"}"#);
        let dir = home.path().join(".codex/sessions/2026/07/29");
        fs::create_dir_all(&dir).unwrap();
        let older_path =
            dir.join("rollout-2026-07-29T10-00-00-019de12c-d83e-78c2-9bb3-cbb8146965f1.jsonl");
        let newer_path =
            dir.join("rollout-2026-07-29T11-00-00-019de12c-d83e-78c2-9bb3-cbb8146965f2.jsonl");
        let dense_rollout = |session: &str| {
            let bounded_path = "x".repeat(MAX_PATH_BYTES);
            let mut records = vec![
                json!({"type":"session_meta","payload":{"id":session,"cwd":bounded_path.clone(),"gitBranch":bounded_path}}),
                json!({"type":"turn_context","payload":{"model":"gpt-dense"}}),
            ];
            for index in 0..350 {
                records.push(json!({"timestamp":"2026-07-29T10:00:00Z","uuid":format!("{session}-{index}"),"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":2,"output_tokens":3}}}}));
            }
            records
                .into_iter()
                .map(|record| record.to_string())
                .collect::<Vec<_>>()
                .join("\n")
                + "\n"
        };
        let older = dense_rollout("older-dense");
        let newer = dense_rollout("newer-dense");
        fs::write(&older_path, &older).unwrap();
        fs::write(&newer_path, &newer).unwrap();

        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());
        let handle = make_app_handle();
        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        std::env::remove_var("HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        let posts = post_bodies(&server).await;
        assert_eq!(posts.len(), MAX_CODEX_BATCHES_PER_SYNC);
        let cursor = read_cursor(home.path());
        let older_key = normalize_cursor_file_key(&older_path);
        let newer_key = normalize_cursor_file_key(&newer_path);
        assert!(
            cursor.files[&newer_key].offset > 0,
            "the dense newest rollout receives its priority share"
        );
        assert!(
            cursor.files[&older_key].offset > 0,
            "the older rollout advances before the newest can consume all four batches"
        );
        assert!(cursor.files[&newer_key].offset < newer.len() as u64);
        assert!(cursor.files[&older_key].offset < older.len() as u64);
    }

    #[tokio::test]
    async fn codex_rows_share_batch_resume_and_only_send_appends() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"codex-combined"}"#);
        write_jsonl(home.path(), "proj", "claude.jsonl", &[USER_ROW]);
        let initial = codex_fixture("gpt-codex-a", "codex-1");
        let codex_path = write_codex_rollout(home.path(), &initial);
        let codex_key = normalize_cursor_file_key(&codex_path);
        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());
        let handle = make_app_handle();
        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        let first = post_bodies(&server).await;
        assert_eq!(
            first.len(),
            1,
            "Claude and Codex rows should share one batch"
        );
        assert_eq!(first[0]["events"].as_array().unwrap().len(), 2);
        assert!(first[0]["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["model"] == "gpt-codex-a"));
        assert_eq!(
            read_cursor(home.path()).files[&codex_key].offset,
            initial.len() as u64
        );
        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        assert_eq!(
            post_bodies(&server).await.len(),
            1,
            "ingested rerun must not POST"
        );
        let appended = codex_fixture("gpt-codex-b", "codex-2");
        use std::io::Write;
        fs::OpenOptions::new()
            .append(true)
            .open(&codex_path)
            .unwrap()
            .write_all(appended.as_bytes())
            .unwrap();
        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        std::env::remove_var("HOME");
        std::env::remove_var("HQ_VAULT_API_URL");
        let final_posts = post_bodies(&server).await;
        assert_eq!(final_posts.len(), 2);
        assert_eq!(final_posts[1]["events"].as_array().unwrap().len(), 1);
        assert_eq!(final_posts[1]["events"][0]["uuid"], "codex-2");
        assert_eq!(final_posts[1]["events"][0]["model"], "gpt-codex-b");
        assert_eq!(
            read_cursor(home.path()).files[&codex_key].offset,
            (initial.len() + appended.len()) as u64
        );
    }

    #[tokio::test]
    async fn failed_codex_batch_keeps_cursor_and_next_run_resends() {
        let failed_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .mount(&failed_server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(ResponseTemplate::new(500).set_body_string("error"))
            .mount(&failed_server)
            .await;
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"codex-retry"}"#);
        let rollout = codex_fixture("gpt-retry", "retry-event");
        let codex_path = write_codex_rollout(home.path(), &rollout);
        let codex_key = normalize_cursor_file_key(&codex_path);
        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", failed_server.uri());
        let handle = make_app_handle();
        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        assert_eq!(read_cursor(home.path()).files[&codex_key].offset, 0);
        let retry_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .mount(&retry_server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&retry_server)
            .await;
        std::env::set_var("HQ_VAULT_API_URL", retry_server.uri());
        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        std::env::remove_var("HOME");
        std::env::remove_var("HQ_VAULT_API_URL");
        assert_eq!(
            read_cursor(home.path()).files[&codex_key].offset,
            rollout.len() as u64
        );
        let retry_posts = post_bodies(&retry_server).await;
        assert_eq!(retry_posts.len(), 1);
        assert_eq!(retry_posts[0]["events"][0]["uuid"], "retry-event");
        assert_eq!(retry_posts[0]["events"][0]["model"], "gpt-retry");
    }

    #[tokio::test]
    async fn large_codex_backfill_is_bounded_and_resumes_with_saved_context() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"codex-bounded"}"#);
        const EVENT_COUNT: usize = 600;
        let bounded_path = "x".repeat(MAX_PATH_BYTES);
        let mut records = vec![
            json!({"type":"session_meta","payload":{"id":"bounded-session","cwd":bounded_path.clone(),"gitBranch":bounded_path.clone()}}),
            json!({"type":"turn_context","payload":{"model":"gpt-bounded"}}),
        ];
        for index in 1..=EVENT_COUNT {
            records.push(json!({"timestamp":format!("2026-07-29T10:{:02}:{:02}Z", (index / 60) % 60, index % 60),"uuid":format!("u{index}"),"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":2,"output_tokens":3}}}}));
        }
        let rollout = records
            .into_iter()
            .map(|row| row.to_string())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let codex_path = write_codex_rollout(home.path(), &rollout);
        let codex_key = normalize_cursor_file_key(&codex_path);
        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());
        let handle = make_app_handle();

        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        let first_posts = post_bodies(&server).await;
        assert_eq!(first_posts.len(), MAX_CODEX_BATCHES_PER_SYNC);
        let first_sent: usize = first_posts
            .iter()
            .map(|body| body["events"].as_array().unwrap().len())
            .sum();
        assert!(first_sent > 0 && first_sent < EVENT_COUNT);
        assert!(first_posts
            .iter()
            .all(|body| { serde_json::to_vec(body).unwrap().len() <= MAX_BATCH_BYTES }));
        let partial = read_cursor(home.path()).files[&codex_key].clone();
        assert!(partial.offset > 0 && partial.offset < rollout.len() as u64);
        assert_eq!(
            partial.context.as_ref().and_then(CodexUsageContext::model),
            Some("gpt-bounded")
        );

        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .open(&codex_path)
            .unwrap();
        file.write_all(&vec![b' '; partial.offset as usize])
            .unwrap();
        drop(file);

        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        std::env::remove_var("HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        let all_posts = post_bodies(&server).await;
        let resumed_posts = &all_posts[MAX_CODEX_BATCHES_PER_SYNC..];
        assert!(!resumed_posts.is_empty());
        assert!(resumed_posts
            .iter()
            .all(|body| { serde_json::to_vec(body).unwrap().len() <= MAX_BATCH_BYTES }));
        let resumed_events: Vec<&Value> = resumed_posts
            .iter()
            .flat_map(|body| body["events"].as_array().unwrap())
            .collect();
        assert_eq!(
            resumed_events.len(),
            EVENT_COUNT - first_sent,
            "second sync sends exactly the unacked tail"
        );
        assert!(resumed_events
            .iter()
            .all(|event| event["model"] == "gpt-bounded"));
        assert_eq!(
            resumed_events.first().unwrap()["uuid"],
            format!("u{}", first_sent + 1)
        );
        assert_eq!(
            read_cursor(home.path()).files[&codex_key].offset,
            rollout.len() as u64
        );
    }

    #[tokio::test]
    async fn sparse_codex_rollout_advances_by_scan_budget_without_posting() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"codex-sparse"}"#);
        let mut rollout =
            json!({"type":"session_meta","payload":{"id":"sparse-session"}}).to_string() + "\n";
        rollout.push_str(
            &(json!({"type":"turn_context","payload":{"model":"gpt-sparse"}}).to_string() + "\n"),
        );
        rollout.push_str("malformed rollout line\n");
        let malformed_end = rollout.len() as u64;
        let padding = "x".repeat(1024);
        while rollout.len() < (MAX_CODEX_SCAN_BYTES_PER_SYNC as usize + 1024 * 1024) {
            rollout.push_str(&(json!({"type":"event_msg","payload":{"type":"user_message","message":padding.clone()}}).to_string() + "\n"));
        }
        let codex_path = write_codex_rollout(home.path(), &rollout);
        let codex_key = normalize_cursor_file_key(&codex_path);
        let _home_scope = scoped_home(home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());
        let handle = make_app_handle();

        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        assert!(
            post_bodies(&server).await.is_empty(),
            "zero-token slice must not POST"
        );
        let partial = read_cursor(home.path()).files[&codex_key].clone();
        let fair_slice = per_rollout_scan_budget(1);
        assert!(
            partial.offset <= fair_slice,
            "scan progress must remain inside the per-rollout byte slice"
        );
        assert!(
            partial.offset >= fair_slice.saturating_sub(MAX_CODEX_LINE_BYTES),
            "rewinding the boundary record may leave at most one valid line uncommitted"
        );
        assert!(partial.offset < rollout.len() as u64);
        assert!(
            partial.offset > malformed_end,
            "malformed lines still advance progress"
        );
        assert_eq!(
            partial.context.as_ref().and_then(CodexUsageContext::model),
            Some("gpt-sparse")
        );

        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        std::env::remove_var("HQ_VAULT_API_URL");
        assert!(post_bodies(&server).await.is_empty());
        assert_eq!(
            read_cursor(home.path()).files[&codex_key].offset,
            rollout.len() as u64
        );
    }

    #[tokio::test]
    async fn oversized_codex_line_is_checkpointed_in_bounded_chunks() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(complete_ack)
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"codex-oversized"}"#);
        let mut rollout =
            json!({"type":"session_meta","payload":{"id":"oversized-session"}}).to_string() + "\n";
        rollout.push_str(
            &(json!({"type":"turn_context","payload":{"model":"gpt-after-large"}}).to_string()
                + "\n"),
        );
        rollout.push_str("{\"ignored\":\"");
        rollout.push_str(&"x".repeat(9 * 1024 * 1024));
        rollout.push_str("\"}\n");
        rollout.push_str(&codex_fixture("gpt-after-large", "after-large"));
        let codex_path = write_codex_rollout(home.path(), &rollout);
        let codex_key = normalize_cursor_file_key(&codex_path);
        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());
        let handle = make_app_handle();

        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        let first = read_cursor(home.path()).files[&codex_key].clone();
        assert_eq!(first.offset, MAX_CODEX_SCAN_BYTES_PER_SYNC);
        assert!(first.context.as_ref().unwrap().discarding_partial_line);
        assert!(post_bodies(&server).await.is_empty());

        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        let second = read_cursor(home.path()).files[&codex_key].clone();
        assert_eq!(second.offset, 2 * MAX_CODEX_SCAN_BYTES_PER_SYNC);
        assert!(second.context.as_ref().unwrap().discarding_partial_line);
        assert!(post_bodies(&server).await.is_empty());

        send_telemetry_if_opted_in(&handle, "/hq", "tok")
            .await
            .unwrap();
        std::env::remove_var("HOME");
        std::env::remove_var("HQ_VAULT_API_URL");
        let posts = post_bodies(&server).await;
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0]["events"].as_array().unwrap().len(), 1);
        assert_eq!(posts[0]["events"][0]["uuid"], "after-large");
        assert_eq!(posts[0]["events"][0]["model"], "gpt-after-large");
        assert_eq!(
            read_cursor(home.path()).files[&codex_key].offset,
            rollout.len() as u64
        );
    }

    // ── (a) opt-in=false → 0 bytes sent ──────────────────────────────────────

    #[test]
    fn codex_candidates_resume_stored_offset_and_reset_shrunk_files() {
        let home = setup_home();
        let rollout = write_codex_rollout(home.path(), "first\nsecond\n");
        let path = normalize_cursor_file_key(&rollout);
        let mtime = mtime_secs(&fs::metadata(&rollout).unwrap());
        let mut cursor = TelemetryCursor::default();
        cursor.files.insert(
            path.clone(),
            CursorEntry {
                offset: 3,
                mtime,
                context: Some(CodexUsageContext::default()),
            },
        );

        let candidates = codex_candidate_entries(&home.path().join(".codex"), &cursor);
        assert_eq!(
            candidates[&path].offset, 3,
            "grown rollout resumes at stored offset"
        );

        let legacy = candidate_cursor_entry(
            Some(&CursorEntry {
                offset: 3,
                mtime,
                context: None,
            }),
            10_000,
            mtime,
        );
        assert_eq!(
            legacy.offset, 0,
            "legacy contextless cursor resets for bounded scan"
        );

        cursor.files.insert(
            path.clone(),
            CursorEntry {
                offset: 10_000,
                mtime,
                context: Some(CodexUsageContext::default()),
            },
        );
        let candidates = codex_candidate_entries(&home.path().join(".codex"), &cursor);
        assert_eq!(candidates[&path].offset, 0, "shrunk rollout resets to zero");
        assert!(
            candidates[&path].context.is_none(),
            "rotation clears saved context"
        );

        let rolled_back = candidate_cursor_entry(
            Some(&CursorEntry {
                offset: 3,
                mtime: mtime + 1,
                context: Some(CodexUsageContext::default()),
            }),
            10_000,
            mtime,
        );
        assert_eq!(rolled_back.offset, 0, "mtime rollback resets to zero");
    }

    #[test]
    fn missing_codex_dir_produces_no_candidates() {
        let home = setup_home();
        let candidates =
            codex_candidate_entries(&home.path().join(".codex"), &TelemetryCursor::default());
        assert!(candidates.is_empty());
    }

    #[test]
    fn codex_token_count_maps_delta_and_only_allowlisted_fields() {
        let mut context = CodexUsageContext::new("filename-session");
        assert!(codex_usage_row(
            &json!({
                "type": "session_meta",
                "payload": {
                    "id": "meta-session",
                    "cwd": "/work/project",
                    "git": {"branch": "feature/usage"},
                    "originator": "codex_cli_rs",
                    "thread_source": "subagent",
                    "model": "session-model"
                }
            }),
            &mut context,
        )
        .is_none());
        assert!(codex_usage_row(
            &json!({"type": "turn_context", "payload": {"model": "gpt-current"}}),
            &mut context,
        )
        .is_none());

        let row = codex_usage_row(
            &json!({
                "timestamp": "2026-07-29T10:00:00Z",
                "type": "event_msg",
                "uuid": "event-uuid",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {
                            "input_tokens": 9000,
                            "output_tokens": 8000,
                            "cached_input_tokens": 7000
                        },
                        "last_token_usage": {
                            "input_tokens": 11,
                            "output_tokens": 7,
                            "reasoning_output_tokens": 5,
                            "cached_input_tokens": 3
                        }
                    },
                    "raw_content": "must never leave the machine"
                }
            }),
            &mut context,
        )
        .unwrap();

        assert_eq!(
            row,
            json!({
                "sessionId": "meta-session",
                "timestamp": "2026-07-29T10:00:00Z",
                "uuid": "event-uuid",
                "cwd": "/work/project",
                "gitBranch": "feature/usage",
                "model": "gpt-current",
                "inputTokens": 11,
                "outputTokens": 12,
                "cacheReadInputTokens": 3
            })
        );
        assert!(row.get("cacheCreationInputTokens").is_none());
    }

    #[test]
    fn multi_date_codex_fixture_preserves_timestamps_and_sums_to_final_total() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("rollout-multi-date.jsonl");
        fs::write(&path, MULTI_DATE_CODEX_ROLLOUT).unwrap();
        let mut scanner = CodexRolloutScanner::open(&path, 0, "filename-session", None).unwrap();
        let mut rows = Vec::new();

        while let Some((row, _, _)) = scanner.next_bounded(u64::MAX) {
            if let Some(row) = row {
                rows.push(row);
            }
        }

        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows.iter()
                .map(|row| row["timestamp"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "2026-07-28T23:59:59Z",
                "2026-07-29T00:00:01Z",
                "2026-07-29T00:00:02Z",
            ]
        );
        assert!(rows.iter().all(|row| row["model"] == "gpt-fixture"));

        let input_total: u64 = rows
            .iter()
            .map(|row| row["inputTokens"].as_u64().unwrap())
            .sum();
        let output_total: u64 = rows
            .iter()
            .map(|row| row["outputTokens"].as_u64().unwrap())
            .sum();
        let cache_total: u64 = rows
            .iter()
            .map(|row| row["cacheReadInputTokens"].as_u64().unwrap())
            .sum();
        let final_usage = MULTI_DATE_CODEX_ROLLOUT
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|record| {
                record
                    .get("payload")?
                    .get("info")?
                    .get("total_token_usage")
                    .cloned()
            })
            .last()
            .unwrap();
        assert_eq!(input_total, final_usage["input_tokens"].as_u64().unwrap());
        assert_eq!(
            output_total,
            final_usage["output_tokens"].as_u64().unwrap()
                + final_usage["reasoning_output_tokens"].as_u64().unwrap()
        );
        assert_eq!(
            cache_total,
            final_usage["cached_input_tokens"].as_u64().unwrap()
        );

        const ALLOWLIST: [&str; 10] = [
            "sessionId",
            "timestamp",
            "uuid",
            "cwd",
            "gitBranch",
            "userType",
            "model",
            "inputTokens",
            "outputTokens",
            "cacheReadInputTokens",
        ];
        assert!(rows.iter().all(|row| {
            row.as_object()
                .unwrap()
                .keys()
                .all(|key| ALLOWLIST.contains(&key.as_str()))
        }));
        let encoded = serde_json::to_string(&rows).unwrap();
        assert!(!encoded.contains("sensitive instructions"));
        assert!(!encoded.contains("sensitive tool output"));
    }

    #[test]
    fn codex_model_fallbacks_and_mid_session_switches_are_respected() {
        let mut context = CodexUsageContext::new("filename-session");
        codex_usage_row(
            &json!({
                "type": "session_meta",
                "payload": {"model": "session-model"}
            }),
            &mut context,
        );
        let token = |timestamp: &str| {
            json!({
                "timestamp": timestamp,
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {"last_token_usage": {"input_tokens": 1, "output_tokens": 2}}
                }
            })
        };

        let session_fallback = codex_usage_row(&token("t1"), &mut context).unwrap();
        assert_eq!(session_fallback["model"], "session-model");

        codex_usage_row(
            &json!({
                "type": "turn_context",
                "payload": {
                    "collaboration_mode": {"settings": {"model": "collab-model"}}
                }
            }),
            &mut context,
        );
        let collaboration_fallback = codex_usage_row(&token("t2"), &mut context).unwrap();
        assert_eq!(collaboration_fallback["model"], "collab-model");

        codex_usage_row(
            &json!({"type": "turn_context", "payload": {"model": "turn-model-a"}}),
            &mut context,
        );
        let first_turn = codex_usage_row(&token("t3"), &mut context).unwrap();
        assert_eq!(first_turn["model"], "turn-model-a");

        codex_usage_row(
            &json!({"type": "turn_context", "payload": {"model": "turn-model-b"}}),
            &mut context,
        );
        let switched_turn = codex_usage_row(&token("t4"), &mut context).unwrap();
        assert_eq!(switched_turn["model"], "turn-model-b");
    }

    #[test]
    fn codex_rollout_resumes_at_cursor_without_buffering_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("rollout.jsonl");
        let lines = [
            json!({
                "type": "session_meta",
                "payload": {"id": "session-id", "cwd": "/repo", "git_branch": "main"}
            }),
            json!({"type": "turn_context", "payload": {"model": "model-a"}}),
            json!({
                "timestamp": "first",
                "type": "event_msg",
                "payload": {"type": "token_count", "info": {"last_token_usage": {"input_tokens": 2, "output_tokens": 3}}}
            }),
            json!({"type": "turn_context", "payload": {"model": "model-b"}}),
            json!({
                "timestamp": "second",
                "type": "event_msg",
                "payload": {"type": "token_count", "info": {"last_token_usage": {"input_tokens": 5, "output_tokens": 7}}}
            }),
        ];
        let encoded: Vec<String> = lines.iter().map(Value::to_string).collect();
        let contents = format!("{}\n", encoded.join("\n"));
        fs::write(&path, &contents).unwrap();
        let start_offset = encoded[..3].iter().map(|line| line.len() as u64 + 1).sum();

        let saved_context = CodexUsageContext {
            session_id: Some("session-id".to_string()),
            turn_model: Some("model-a".to_string()),
            ..CodexUsageContext::default()
        };
        let mut scanner =
            CodexRolloutScanner::open(&path, start_offset, "filename-id", Some(saved_context))
                .unwrap();
        let mut emitted = Vec::new();
        while let Some((row, offset, context)) = scanner.next_bounded(u64::MAX) {
            if let Some(row) = row {
                emitted.push((row, offset, context));
            }
        }

        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].0["timestamp"], "second");
        assert_eq!(emitted[0].0["model"], "model-b");
        assert_eq!(emitted[0].0["sessionId"], "session-id");
        assert_eq!(emitted[0].1, contents.len() as u64);
    }

    #[test]
    fn codex_scanner_parses_final_record_without_newline() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("rollout.jsonl");
        let record = json!({"timestamp":"final","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1,"output_tokens":2}}}}).to_string();
        fs::write(&path, &record).unwrap();
        let saved = CodexUsageContext {
            turn_model: Some("final-model".to_string()),
            ..CodexUsageContext::default()
        };
        let mut scanner = CodexRolloutScanner::open(&path, 0, "session", Some(saved)).unwrap();
        let (row, offset, _) = scanner.next_bounded(record.len() as u64).unwrap();
        assert_eq!(row.unwrap()["model"], "final-model");
        assert_eq!(offset, record.len() as u64);
    }

    #[test]
    fn anon_id_is_attached_only_as_a_safe_label() {
        let mut props = serde_json::json!({ "step": "x", "anonId": "spoofed" });
        attach_anon_id(&mut props, Some("vyg-abc".into()));
        assert_eq!(props["anonId"], "vyg-abc");
        let mut props = serde_json::json!({ "anonId": "spoofed" });
        attach_anon_id(&mut props, Some("bad id/with?url".into()));
        assert!(props.get("anonId").is_none());
        let mut props = serde_json::json!({});
        attach_anon_id(&mut props, None);
        assert!(props.get("anonId").is_none());
    }

    #[test]
    fn install_tag_read_is_operational_and_keeps_only_labels() {
        assert!(is_operational_desktop_event_name("install_tag_read"));
        let event = build_desktop_telemetry_event(
            "install_tag_read".into(),
            Some(serde_json::json!({
                "found": true,
                "source": "whereFroms",
                "url": "https://x.com/HQ.dmg?aid=vyg-1&secret=1"
            })),
            None,
            None,
            "no-consent",
        );
        assert_eq!(event.properties["found"], true);
        assert_eq!(event.properties["source"], "whereFroms");
        assert!(event.properties.get("url").is_none());
    }
}

#[cfg(test)]
mod desktop_liveness_telemetry_regression_tests {
    use super::*;

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-10-05T09:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[test]
    fn daily_active_has_closed_liveness_context_only_when_enabled() {
        let off = build_daily_active_event_with_liveness(now(), None);
        assert_eq!(off.properties, json!({
            "platform": crate::commands::version_gate::platform_tag(),
            "appVersion": crate::app_version::current(),
        }));
        let on = build_daily_active_event_with_liveness(
            now(),
            Some(DesktopLivenessContext {
                launch_source: "login_item",
                start_at_login: "registration_failed",
            }),
        );
        assert_eq!(on.properties["launch_source"], "login_item");
        assert_eq!(on.properties["start_at_login"], "registration_failed");
    }

    #[test]
    fn each_launch_source_and_registration_state_is_closed() {
        assert_eq!(classify_desktop_launch_source(false, true, true), "login_item");
        assert_eq!(classify_desktop_launch_source(false, false, true), "user");
        assert_eq!(classify_desktop_launch_source(true, true, true), "update_restart");
        assert_eq!(classify_desktop_launch_source(false, false, false), "unknown");

        assert_eq!(classify_start_at_login(Some(true), Some(true)), "registered");
        assert_eq!(classify_start_at_login(Some(false), Some(false)), "opted_out");
        assert_eq!(classify_start_at_login(Some(true), Some(false)), "registration_failed");
        assert_eq!(classify_start_at_login(None, None), "unknown");
    }

    #[test]
    fn each_quit_reason_and_setup_age_bucket_is_emitted_closed() {
        let reasons = [
            (DesktopQuitReason::TrayQuit, "tray_quit"),
            (DesktopQuitReason::AppMenuQuit, "app_menu_quit"),
            (DesktopQuitReason::OsShutdown, "os_shutdown"),
            (DesktopQuitReason::UpdateRestart, "update_restart"),
            (DesktopQuitReason::Unknown, "unknown"),
        ];
        for (reason, expected) in reasons {
            let event = build_desktop_quit_event(now(), reason, Some(now()));
            assert_eq!(event.event_name, "desktop_app_quit");
            assert_eq!(event.properties["reason"], expected);
        }
        let sanitized = sanitize_desktop_quit_properties(Some(json!({
            "reason": "arbitrary-text",
            "days_since_setup": "900",
            "unexpected": "discard-me",
        })));
        assert_eq!(sanitized, json!({ "reason": "unknown", "days_since_setup": "unknown" }));
        let ages = [
            (Some(now()), "0"),
            (Some(now() - chrono::Duration::days(1)), "1-7"),
            (Some(now() - chrono::Duration::days(8)), "8+"),
            (None, "unknown"),
            (Some(now() + chrono::Duration::seconds(1)), "unknown"),
        ];
        for (setup_at, expected) in ages {
            let event = build_desktop_quit_event(now(), DesktopQuitReason::Unknown, setup_at);
            assert_eq!(event.properties["days_since_setup"], expected);
        }
    }

    #[test]
    fn flag_off_or_unreadable_emits_no_new_fields_or_quit_event() {
        let context = DesktopLivenessContext {
            launch_source: "user",
            start_at_login: "registered",
        };
        assert!(!liveness_flag_is_enabled(Ok(None)));
        assert!(!liveness_flag_is_enabled(Err(())));
        assert!(liveness_flag_is_enabled(Ok(Some(true))));
        assert_eq!(daily_active_liveness_context(false, context), None);
        assert_eq!(daily_active_liveness_context(true, context), Some(context));
        assert!(quit_event_when_enabled(false, now(), DesktopQuitReason::TrayQuit, None).is_none());
        let unchanged = build_daily_active_event_with_liveness(now(), None);
        assert!(!unchanged.properties.as_object().unwrap().contains_key("launch_source"));
        assert!(!unchanged.properties.as_object().unwrap().contains_key("start_at_login"));
    }

    #[test]
    fn failed_quit_telemetry_result_does_not_hold_exit() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        report_quit_telemetry_attempt(sender, Err("offline".to_string()));
        let started = std::time::Instant::now();
        wait_for_quit_telemetry_attempt(receiver);
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[tokio::test]
    async fn daily_active_liveness_flag_is_resolved_once_and_cached() {
        let cache = AtomicU8::new(LIVENESS_FLAG_UNKNOWN);
        let reads = std::sync::atomic::AtomicUsize::new(0);

        let first = resolve_liveness_flag_once_with(&cache, || async {
            reads.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        })
        .await;
        let second = resolve_liveness_flag_once_with(&cache, || async {
            reads.fetch_add(1, Ordering::SeqCst);
            Ok(Some(true))
        })
        .await;

        assert!(!first);
        assert!(!second);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(cache.load(Ordering::Acquire), LIVENESS_FLAG_OFF);
    }

    #[test]
    fn quit_unknown_or_off_skips_flag_fetch_and_wait() {
        for state in [LIVENESS_FLAG_UNKNOWN, LIVENESS_FLAG_OFF] {
            let cache = AtomicU8::new(state);
            let flag_fetches = std::sync::atomic::AtomicUsize::new(0);
            let waits = std::sync::atomic::AtomicUsize::new(0);

            let attempted = with_cached_liveness_on(&cache, || {
                flag_fetches.fetch_add(1, Ordering::SeqCst);
                waits.fetch_add(1, Ordering::SeqCst);
            });

            assert!(!attempted);
            assert_eq!(flag_fetches.load(Ordering::SeqCst), 0);
            assert_eq!(waits.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn quit_path_uses_only_cached_gate_before_any_wait() {
        let source = include_str!("telemetry.rs");
        let quit = source
            .split("pub fn emit_desktop_quit_before_exit(")
            .nth(1)
            .expect("quit telemetry function");
        let body = quit
            .split("\npub fn emit_noted_desktop_quit_before_exit")
            .next()
            .expect("quit telemetry function body");

        assert!(!body.contains("feature_flag_read"));
        assert!(body.find("with_cached_liveness_on(").unwrap()
            < body.find("sync_channel(1)").unwrap());
        assert!(body.find("sync_channel(1)").unwrap()
            < body.find("wait_for_quit_telemetry_attempt(").unwrap());
    }

    #[test]
    fn cached_on_quit_builds_event_with_the_noted_reason() {
        let cache = AtomicU8::new(LIVENESS_FLAG_ON);
        let event = quit_event_for_cached_liveness(
            &cache,
            now(),
            DesktopQuitReason::AppMenuQuit,
            Some(now()),
        )
        .expect("cached-on quit has an event");

        assert_eq!(event.event_name, "desktop_app_quit");
        assert_eq!(event.properties["reason"], "app_menu_quit");
    }

    #[test]
    fn deferred_update_restart_does_not_latch_an_update_quit_reason() {
        let source = include_str!("autostart.rs");
        let restart = source
            .split("fn restart_preferring_launch_agent_with_update_version(")
            .nth(1)
            .expect("restart implementation");
        let deferred = restart
            .find("return false;")
            .expect("protected activity defers restart");
        let reason_latched = restart
            .find("note_desktop_quit_reason(")
            .expect("successful update restart labels its exit");
        assert!(reason_latched > deferred);
    }

    #[test]
    fn desktop_quit_is_an_approved_operational_event() {
        assert!(is_operational_desktop_event_name("desktop_app_quit"));
    }
}
