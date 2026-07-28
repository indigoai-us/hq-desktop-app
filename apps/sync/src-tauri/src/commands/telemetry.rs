//! Telemetry collector — scan ~/.claude/projects/**/*.jsonl on each sync,
//! apply the KEEP/REMOVE allowlist, batch up to 1 MB, POST to /v1/usage.
//!
//! Dispatched from the `AllComplete` arm of `handle_sync_line` via
//! `tauri::async_runtime::spawn`. Does NOT block the sync loop.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::commands::sync::resolve_vault_api_url;
use crate::commands::vault_client::{
    RawTelemetryEvent, TelemetryEventsBatch, UsageBatch, VaultClient,
};
use crate::util::paths;

// ── Cursor schema ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CursorEntry {
    offset: u64,
    mtime: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TelemetryCursor {
    version: String,
    files: HashMap<String, CursorEntry>,
}

impl Default for TelemetryCursor {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            files: HashMap::new(),
        }
    }
}

fn cursor_path() -> Option<std::path::PathBuf> {
    paths::home_dir().map(|h| h.join(".hq/telemetry-cursor.json"))
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
fn sanitize_row(row: &Value) -> Option<Value> {
    let obj = row.as_object()?;
    let mut out = serde_json::Map::new();

    macro_rules! copy_opt {
        ($key:expr) => {
            if let Some(v) = obj.get($key) {
                out.insert($key.to_string(), v.clone());
            }
        };
    }

    copy_opt!("sessionId");
    copy_opt!("timestamp");
    copy_opt!("uuid");
    copy_opt!("cwd");
    copy_opt!("gitBranch");
    copy_opt!("userType");

    // Promote message.model and flatten message.usage.* into top-level
    // camelCase fields the server expects.
    if let Some(msg) = obj.get("message").and_then(|v| v.as_object()) {
        if let Some(v) = msg.get("model") {
            out.insert("model".to_string(), v.clone());
        }
        if let Some(usage) = msg.get("usage").and_then(|v| v.as_object()) {
            if let Some(v) = usage.get("input_tokens") {
                out.insert("inputTokens".to_string(), v.clone());
            }
            if let Some(v) = usage.get("output_tokens") {
                out.insert("outputTokens".to_string(), v.clone());
            }
            if let Some(v) = usage.get("cache_creation_input_tokens") {
                out.insert("cacheCreationInputTokens".to_string(), v.clone());
            }
            if let Some(v) = usage.get("cache_read_input_tokens") {
                out.insert("cacheReadInputTokens".to_string(), v.clone());
            }
        }
    }

    Some(Value::Object(out))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn read_local_telemetry_enabled() -> bool {
    let home = paths::home_dir().unwrap_or_default();
    let path = home.join(".hq/menubar.json");
    if let Ok(contents) = fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<Value>(&contents) {
            return v
                .get("telemetryEnabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
        }
    }
    true
}

fn write_menubar_telemetry_pref_to(path: &Path, enabled: bool) -> Result<(), String> {
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
///   4. The server must report `unset` — proving both that no answer is
///      recorded AND that this server understands `onlyIfUnset`. An older
///      server silently ignores that flag and writes unconditionally, so
///      without this probe the "conditional" replay could clobber a real
///      choice.
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

    // Guard 4: only act when the server itself says there is no recorded answer.
    // `unset: None` means the server predates this field — and therefore also
    // ignores `onlyIfUnset` — so we must not write at all.
    match vault.get_telemetry_opt_in().await {
        Ok(resp) if resp.unset == Some(true) => {}
        Ok(resp) => {
            // Consent IS recorded — nothing to repair. Record that fact so this
            // stops re-checking: `write_menubar_telemetry_pref` clears the
            // person binding on every deliberate answer, so without this the
            // early return never fires again and each sync repeats this GET
            // forever (twice, on the cache-miss path).
            //
            // Only bind when the server names the same person we resolved, so
            // a mismatched response can never mislabel the record.
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
        Err(err) => {
            eprintln!("[telemetry] consent state unreadable, skipping re-assert: {err}");
            return;
        }
    }

    // This is a self-heal REPLAY of a cached answer, not a fresh answer, so it
    // carries no onboarding/settings provenance of its own.
    match vault
        .post_telemetry_opt_in_opts(enabled, true, None, None)
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

#[tauri::command]
pub fn write_menubar_telemetry_pref(enabled: bool) -> Result<(), String> {
    let path = crate::util::paths::menubar_json_path()?;
    write_menubar_telemetry_pref_to(&path, enabled)
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
            read_local_telemetry_enabled()
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
            Ok(TelemetryConsentStatus {
                enabled: read_local_telemetry_enabled(),
                source: TelemetryConsentSource::LocalCache,
                updated_at: None,
                consent_version: None,
                unset: false,
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
pub async fn consent_reprompt_status(consent_version: u32) -> Result<ConsentRepromptStatus, String> {
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
pub fn mark_consent_reprompt_shown(
    consent_version: u32,
    person_uid: String,
) -> Result<(), String> {
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

fn allowed_desktop_property_key(key: &str) -> bool {
    matches!(
        key,
        "provider"
            | "surface"
            | "source"
            | "result"
            | "errorKind"
            | "enabled"
            | "companiesAttempted"
            | "filesDownloaded"
            | "bytesDownloaded"
            | "filesSkipped"
            | "errorCount"
            | "stageCount"
            | "failedStageCount"
            | "detectedToolCount"
    )
}

fn sanitize_desktop_properties(properties: Option<Value>) -> Value {
    let Some(Value::Object(input)) = properties else {
        return Value::Object(Map::new());
    };

    let mut out = Map::new();

    for (key, value) in input {
        if !allowed_desktop_property_key(&key) {
            continue;
        }

        let keep = match &value {
            Value::Bool(_) => key == "enabled",
            Value::Number(n) => n.as_i64().is_some() || n.as_u64().is_some(),
            Value::String(s) => is_safe_label_value(s),
            _ => false,
        };
        if keep {
            out.insert(key, value);
        }
    }

    Value::Object(out)
}

fn build_desktop_telemetry_event(
    event_name: String,
    properties: Option<Value>,
) -> RawTelemetryEvent {
    let properties = sanitize_desktop_properties(properties);
    RawTelemetryEvent {
        event_name,
        app: "hq-desktop-app".to_string(),
        source: "desktop".to_string(),
        occurred_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        consent_basis: "desktop-opt-in".to_string(),
        schema_version: 1,
        idempotency_key: None,
        properties,
    }
}

async fn emit_desktop_telemetry_with_vault(
    vault: &VaultClient,
    event_name: String,
    properties: Option<Value>,
) -> Result<(), String> {
    if !is_safe_event_name(&event_name) {
        return Err(format!("invalid telemetry event name: {event_name}"));
    }

    if !resolve_telemetry_enabled(vault).await {
        return Ok(());
    }

    let event = build_desktop_telemetry_event(event_name, properties);
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
) -> Result<(), String> {
    let access_token = crate::commands::cognito::get_valid_access_token().await?;
    let api_url = resolve_vault_api_url()?;
    let vault = VaultClient::new(&api_url, &access_token);
    emit_desktop_telemetry_with_vault(&vault, event_name, properties).await
}

fn build_daily_active_event(utc_day: chrono::NaiveDate) -> RawTelemetryEvent {
    let day = utc_day.format("%Y-%m-%d");
    let occurred_at = utc_day
        .and_hms_opt(0, 0, 0)
        .expect("midnight is a valid UTC time")
        .and_utc()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    RawTelemetryEvent {
        event_name: "desktop_app_daily_active".to_string(),
        app: "hq-desktop-app".to_string(),
        source: "desktop".to_string(),
        occurred_at,
        consent_basis: "desktop-opt-in".to_string(),
        schema_version: 1,
        idempotency_key: Some(format!("hq-desktop-app:daily-active:{day}")),
        properties: Value::Object(Map::new()),
    }
}

async fn emit_daily_active_with_vault(
    vault: &VaultClient,
    utc_day: chrono::NaiveDate,
) -> Result<(), String> {
    if !resolve_telemetry_enabled(vault).await {
        return Ok(());
    }

    let batch = TelemetryEventsBatch {
        events: vec![build_daily_active_event(utc_day)],
    };
    vault
        .post_telemetry_events(&batch)
        .await
        .map_err(|e| e.to_string())
}

async fn emit_daily_active_for_utc_day(utc_day: chrono::NaiveDate) {
    let result = async {
        let access_token = crate::commands::cognito::get_valid_access_token().await?;
        let api_url = resolve_vault_api_url()?;
        let vault = VaultClient::new(&api_url, &access_token);
        emit_daily_active_with_vault(&vault, utc_day).await
    }
    .await;

    if result.is_err() {
        eprintln!("[telemetry] desktop-app-daily-active-failed");
    }
}

/// Start a best-effort daily-active emit without delaying application startup.
pub fn setup_daily_active_emit() {
    let utc_day = chrono::Utc::now().date_naive();
    tauri::async_runtime::spawn(async move {
        emit_daily_active_for_utc_day(utc_day).await;
    });
}

fn read_machine_id() -> String {
    let home = paths::home_dir().unwrap_or_default();
    let path = home.join(".hq/menubar.json");
    if let Ok(contents) = fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<Value>(&contents) {
            if let Some(id) = v.get("machineId").and_then(|v| v.as_str()) {
                if !id.is_empty() {
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
struct RowSource {
    file_path: String,
    end_offset: u64,
    mtime: u64,
}

const MAX_BATCH_BYTES: usize = 1_000_000;

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
    // 1. Build VaultClient
    let api_url = resolve_vault_api_url()?;
    let vault = VaultClient::new(&api_url, jwt);

    // 2. Opt-in check
    if !resolve_telemetry_enabled(&vault).await {
        return Ok(());
    }

    // 3. Load cursor
    let cursor = load_cursor();
    let loaded_files = cursor.files.clone();
    let mut newly_committed: HashMap<String, CursorEntry> = HashMap::new();
    let mut rotation_resets: HashMap<String, CursorEntry> = HashMap::new();

    // 4. Enumerate ~/.claude/projects/**/*.jsonl
    let home = paths::home_dir().ok_or("home dir unavailable")?;
    let pattern = format!("{}/.claude/projects/**/*.jsonl", home.display());
    let file_paths: Vec<_> = match glob::glob(&pattern) {
        Ok(g) => g.flatten().filter(|p| p.is_file()).collect(),
        Err(_) => return Ok(()),
    };

    let machine_id = read_machine_id();
    let installer_version = env!("CARGO_PKG_VERSION").to_string();

    let mut batch_events: Vec<Value> = Vec::new();
    let mut batch_sources: Vec<RowSource> = Vec::new();

    for file_path in &file_paths {
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

            // Check if adding this row would exceed 1 MB
            if !batch_events.is_empty() {
                let candidate =
                    build_wire_payload(&machine_id, &installer_version, &batch_events, &sanitized);
                if candidate.len() > MAX_BATCH_BYTES {
                    // Flush current batch
                    flush_batch(
                        &vault,
                        &machine_id,
                        &installer_version,
                        &mut batch_events,
                        &mut batch_sources,
                        &mut newly_committed,
                    )
                    .await;
                }
            }

            batch_events.push(sanitized);
            batch_sources.push(RowSource {
                file_path: path_str.clone(),
                end_offset: line_end_offsets[i],
                mtime: current_mtime,
            });
        }
    }

    // Flush remaining batch
    if !batch_events.is_empty() {
        flush_batch(
            &vault,
            &machine_id,
            &installer_version,
            &mut batch_events,
            &mut batch_sources,
            &mut newly_committed,
        )
        .await;
    }

    // Build final cursor: loaded < rotation_resets < newly_committed
    let mut final_files = loaded_files;
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
    };
    save_cursor(&final_cursor)?;

    Ok(())
}

/// Build the full wire payload JSON for size-checking.
fn build_wire_payload(
    machine_id: &str,
    installer_version: &str,
    existing: &[Value],
    candidate: &Value,
) -> Vec<u8> {
    let mut events = existing.to_vec();
    events.push(candidate.clone());
    let payload = serde_json::json!({
        "machineId": machine_id,
        "installerVersion": installer_version,
        "events": events,
    });
    serde_json::to_vec(&payload).unwrap_or_default()
}

async fn flush_batch(
    vault: &VaultClient,
    machine_id: &str,
    installer_version: &str,
    batch_events: &mut Vec<Value>,
    batch_sources: &mut Vec<RowSource>,
    newly_committed: &mut HashMap<String, CursorEntry>,
) {
    let batch = UsageBatch {
        machine_id: machine_id.to_string(),
        installer_version: installer_version.to_string(),
        events: std::mem::take(batch_events),
    };
    let sources = std::mem::take(batch_sources);

    if vault.post_usage(&batch).await.is_ok() {
        // Advance cursor to max end_offset per file in this batch
        let mut max_per_file: HashMap<String, (u64, u64)> = HashMap::new();
        for src in &sources {
            max_per_file
                .entry(src.file_path.clone())
                .and_modify(|(_, off)| *off = (*off).max(src.end_offset))
                .or_insert((src.mtime, src.end_offset));
        }
        for (fp, (mtime, offset)) in max_per_file {
            newly_committed.insert(fp, CursorEntry { offset, mtime });
        }
    }
    // On non-200: batch_events and batch_sources are already cleared (mem::take),
    // and we do NOT advance newly_committed for this batch's files.
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::test_support::ENV_MUTEX;
    use serde_json::json;
    use std::fs;
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // ── Test helpers ─────────────────────────────────────────────────────────

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

        write_menubar_telemetry_pref_to(&path, true).unwrap();

        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["machineId"], "mid-keep");
        assert_eq!(v["hqPath"], "/foo");
        assert_eq!(v["syncOnLaunch"], false);
        assert_eq!(v["telemetryEnabled"], true);
    }

    #[test]
    fn test_write_menubar_telemetry_pref_creates_file_when_missing() {
        let home = TempDir::new().unwrap();
        let path = home.path().join(".hq/menubar.json");

        write_menubar_telemetry_pref_to(&path, false).unwrap();

        let v: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["telemetryEnabled"], false);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn test_missing_local_telemetry_pref_defaults_true() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-default"}"#);
        std::env::set_var("HOME", home.path());

        let enabled = read_local_telemetry_enabled();

        std::env::remove_var("HOME");
        assert!(enabled, "missing telemetryEnabled should default ON");
    }

    #[tokio::test]
    async fn test_desktop_telemetry_opt_in_false_sends_no_events() {
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
    async fn test_desktop_telemetry_posts_sanitized_envelope() {
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

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-desktop-on"}"#);
        std::env::set_var("HOME", home.path());

        let vault = VaultClient::new(server.uri(), "test-jwt");
        let result = emit_desktop_telemetry_with_vault(
            &vault,
            "telemetry_preference_changed".to_string(),
            Some(json!({
                "enabled": true,
                "surface": "settings-popover",
                "filesDownloaded": 2,
                "companyUid": "cmp_private-company",
                "path": "/Users/alice/HQ",
                "email": "alice@example.com",
                "message": "free text should not leave the client"
            })),
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
        assert_eq!(event["eventName"], "telemetry_preference_changed");
        assert_eq!(event["app"], "hq-desktop-app");
        assert_eq!(event["source"], "desktop");
        assert_eq!(event["consentBasis"], "desktop-opt-in");
        assert_eq!(event["schemaVersion"], 1);
        assert!(event["occurredAt"].as_str().is_some());

        let allowed_event_keys = [
            "eventName",
            "app",
            "source",
            "occurredAt",
            "consentBasis",
            "schemaVersion",
            "idempotencyKey",
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
        assert_eq!(props.get("enabled").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            props.get("surface").and_then(|v| v.as_str()),
            Some("settings-popover")
        );
        assert_eq!(
            props.get("filesDownloaded").and_then(|v| v.as_u64()),
            Some(2)
        );
        assert!(!props.contains_key("path"));
        assert!(!props.contains_key("email"));
        assert!(!props.contains_key("message"));
        assert!(!props.contains_key("companyUid"));
    }

    #[test]
    fn test_daily_active_event_uses_stable_utc_day_values() {
        let utc_day = chrono::NaiveDate::from_ymd_opt(2026, 7, 15).unwrap();

        let first = build_daily_active_event(utc_day);
        let retry = build_daily_active_event(utc_day);

        assert_eq!(first.occurred_at, "2026-07-15T00:00:00.000Z");
        assert_eq!(
            first.idempotency_key.as_deref(),
            Some("hq-desktop-app:daily-active:2026-07-15")
        );
        assert_eq!(first.occurred_at, retry.occurred_at);
        assert_eq!(first.idempotency_key, retry.idempotency_key);
        assert_eq!(first.properties, json!({}));

        let serialized = serde_json::to_value(&first).unwrap();
        assert_eq!(serialized["eventName"], "desktop_app_daily_active");
        assert_eq!(serialized["app"], "hq-desktop-app");
        assert_eq!(serialized["source"], "desktop");
        assert_eq!(
            serialized["idempotencyKey"],
            "hq-desktop-app:daily-active:2026-07-15"
        );
        assert_eq!(serialized["properties"], json!({}));
        for unexpected_key in ["machineId", "appVersion", "companyUid", "personUid"] {
            assert!(serialized.get(unexpected_key).is_none());
        }
    }

    #[tokio::test]
    async fn test_daily_active_opt_out_sends_no_event() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": false})))
            .mount(&server)
            .await;

        let vault = VaultClient::new(server.uri(), "test-jwt");
        let utc_day = chrono::NaiveDate::from_ymd_opt(2026, 7, 15).unwrap();

        let result = emit_daily_active_with_vault(&vault, utc_day).await;

        assert!(result.is_ok());
        let reqs = server.received_requests().await.unwrap();
        assert!(reqs
            .iter()
            .all(|request| request.method != wiremock::http::Method::POST));
    }

    #[tokio::test]
    async fn test_daily_active_missing_or_invalid_token_does_not_fail_startup() {
        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let server = MockServer::start().await;
        let utc_day = chrono::NaiveDate::from_ymd_opt(2026, 7, 15).unwrap();

        for token_contents in [None, Some("{not valid json")] {
            let home = setup_home();
            if let Some(token_contents) = token_contents {
                fs::write(home.path().join(".hq/cognito-tokens.json"), token_contents).unwrap();
            }

            std::env::set_var("HQ_TEST_HOME", home.path());
            std::env::set_var("HQ_VAULT_API_URL", server.uri());
            emit_daily_active_for_utc_day(utc_day).await;
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

        let utc_day = chrono::NaiveDate::from_ymd_opt(2026, 7, 15).unwrap();
        emit_daily_active_for_utc_day(utc_day).await;

        std::env::remove_var("HQ_TEST_HOME");
        std::env::remove_var("HQ_VAULT_API_URL");

        let reqs = server.received_requests().await.unwrap();
        assert_eq!(
            reqs.iter()
                .filter(|request| request.method == wiremock::http::Method::POST)
                .count(),
            1
        );
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
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();
        let result = send_telemetry_if_opted_in(&handle, "/hq", "test-jwt").await;

        std::env::remove_var("HOME");
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
        // Cycle 1: opted in.
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": true})))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        // Cycle 2 onward: withdrawn. A lower priority (higher number) makes this
        // the fallback once the one-shot cycle-1 mock is exhausted.
        Mock::given(method("GET"))
            .and(path("/v1/usage/opt-in"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&json!({"enabled": false})))
            .with_priority(2)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-withdraw"}"#);
        write_jsonl(home.path(), "proj", "s.jsonl", &[USER_ROW, ASST_ROW]);
        std::env::set_var("HOME", home.path());
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
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-b","hqPath":"/foo"}"#);
        let jsonl_path = write_jsonl(home.path(), "proj", "s.jsonl", &[USER_ROW, ASST_ROW]);
        let file_size = fs::metadata(&jsonl_path).unwrap().len();

        std::env::set_var("HOME", home.path());
        std::env::set_var("HQ_VAULT_API_URL", server.uri());

        let handle = make_app_handle();
        let result = send_telemetry_if_opted_in(&handle, "/hq", "test-jwt").await;

        std::env::remove_var("HOME");
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
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
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
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        write_menubar(home.path(), r#"{"machineId":"mid-d"}"#);

        // Generate ~50 rows with a large gitBranch so sanitized rows are ~25 KB each
        // 50 * 25 KB ≈ 1.25 MB > 1 MB → should produce ≥2 batches
        let long_branch = "x".repeat(25_000);
        let mut lines = Vec::new();
        for i in 0..50usize {
            let row = json!({
                "type": "user",
                "timestamp": format!("2026-04-25T10:00:{:02}Z", i % 60),
                "sessionId": "s1",
                "uuid": format!("u{}", i),
                "parentUuid": null,
                "userType": "human",
                "entrypoint": "cli",
                "cwd": "/Users/x",
                "gitBranch": long_branch,
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

        // Last batch must be < 1 MB
        let last_post = posts.last().unwrap();
        assert!(
            last_post.body.len() < MAX_BATCH_BYTES,
            "last batch must be < 1 MB, got {} bytes",
            last_post.body.len()
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
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
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
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
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
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
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

    // ── (i) GET opt-in HTTP 500 → fallback reads menubar.json ─────────────────

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
            .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
            .mount(&server)
            .await;

        let _g = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = setup_home();
        // menubar.json has telemetryEnabled: true
        write_menubar(
            home.path(),
            r#"{"machineId":"mid-i1","telemetryEnabled":true}"#,
        );
        write_jsonl(home.path(), "proj", "s.jsonl", &[USER_ROW]);

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
            !posts.is_empty(),
            "telemetryEnabled=true in fallback → should POST ≥1"
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
        // menubar.json has telemetryEnabled: false
        write_menubar(
            home.path(),
            r#"{"machineId":"mid-i2","telemetryEnabled":false}"#,
        );
        write_jsonl(home.path(), "proj", "s.jsonl", &[USER_ROW]);

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
}
