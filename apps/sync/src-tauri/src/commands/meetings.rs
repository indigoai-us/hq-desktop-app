//! Meeting invite UX — Tauri commands for the discreet meeting icon + modal
//! in the Popover (gated to @getindigo.ai for v1).
//!
//! The icon opens a modal that lists upcoming meetings (from the user's
//! connected Google calendars) plus an input field for inviting the bot to
//! an ad-hoc meeting URL. Per-row Invite/Uninvite toggles the Recall.ai
//! bot scheduled for that meeting; when the calendar has a company mapping,
//! the bot's transcript lands in the mapped company's vault (hq-pro routes
//! based on `companyId`).
//!
//! Feature gate: `meetings_feature_enabled()` decodes the locally-cached
//! id_token claims and returns true iff `email` ends in @getindigo.ai. Same
//! allowlist as hq-console's `isCalendarFeatureEnabled`. No signature
//! verification — the token came from Cognito via our own OAuth flow and
//! lives on local disk; we trust it for the duration of the session.
//!
//! HTTP surface: thin reqwest wrapper around the hq-pro routes shipped by
//! the meeting-pipeline project:
//!   GET    /v1/calendar/events                       — upcoming events
//!   GET    /v1/bot/list?calendarEventIds=...         — bots for given events
//!   POST   /v1/bot/invite                            — schedule a new bot
//!   POST   /v1/bot/{botId}/cancel                    — cancel scheduled bot

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::cognito;
use crate::commands::sync::resolve_vault_api_url;
use crate::util::client_info::build_client;

#[allow(unused_imports)]
pub use hq_desktop_core::meetings::{
    build_notification_body, build_notification_title, build_set_company_body, dedupe_new,
    encode_query_value, first_active_bot, is_recorded, is_unattributed, is_url_safe_id,
    select_recorded, select_unattributed, set_company_error_message, AccountCalendars,
    AccountsResponse, BotsResponse, CalendarsResponse, CancelBotResult, CompanyMembership,
    EventTime, EventsResponse, GoogleAccount, GoogleCalendar, InviteBotBody, MeetingEvent,
    NotifyDetectedPayload, OntologyParticipant, ScheduledBot, SelectedCalendarRef, SetCompanyBody,
    SetCompanyErrorBody, SetCompanyResult,
};

// ── Feature flag ─────────────────────────────────────────────────────────────

/// Returns true for any signed-in user (GA — the Meetings feature graduated
/// from the Indigo dogfood).
///
/// Delegates to `feature_gate::desktop_features_enabled()`, which caches the
/// result for the process lifetime (the Cognito email claim is stable across
/// token rotations). Quiet on missing/malformed tokens (returns false) so the
/// popover never breaks because the user is signed out.
#[tauri::command]
pub async fn meetings_feature_enabled() -> Result<bool, String> {
    Ok(crate::util::feature_gate::desktop_features_enabled().await)
}

/// Fetch ontology-resolved participants for a meeting, with a hard 2-second
/// timeout. Returns an empty vec on any error (timeout, network, non-200) so
/// the bot invite is never blocked. Called just before `POST /v1/bot/invite`.
async fn fetch_participants_best_effort(
    base: &str,
    auth: &str,
    meeting_url: &str,
    event_id: Option<&str>,
) -> Vec<OntologyParticipant> {
    let mut req = build_client()
        .get(format!("{base}/v1/ontology/participants"))
        .header("authorization", auth)
        .query(&[("meetingUrl", meeting_url)]);
    if let Some(id) = event_id.filter(|s| !s.is_empty()) {
        req = req.query(&[("eventId", id)]);
    }
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), req.send()).await;
    let res = match result {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            crate::util::logfile::log("meetings", &format!("participants fetch error: {e}"));
            return vec![];
        }
        Err(_elapsed) => {
            crate::util::logfile::log("meetings", "participants fetch timed out (2s)");
            return vec![];
        }
    };
    if !res.status().is_success() {
        return vec![];
    }
    let text = match res.text().await {
        Ok(t) => t,
        Err(_) => return vec![],
    };
    #[derive(Deserialize)]
    struct ParticipantsResponse {
        #[serde(default)]
        participants: Vec<OntologyParticipant>,
    }
    serde_json::from_str::<ParticipantsResponse>(&text)
        .map(|r| r.participants)
        .unwrap_or_default()
}

// ── Detail window (Upcoming Meetings) ────────────────────────────────────────

/// Open or focus the standalone Upcoming Meetings window. Mirrors the
/// `new-files-detail` pattern — the modal-on-popover UX squeezed the existing
/// sync UI and made the list cramped. The detached window can grow, decorations
/// give the user a proper close affordance, and the popover stays untouched.
///
/// Unlike `open_new_files_detail`, there's no payload handshake — the window
/// fetches its own data via `meetings_list_upcoming` + `meetings_list_scheduled_bots`
/// directly on mount.
#[tauri::command]
pub async fn open_meetings_window(
    app: AppHandle,
    focus_meeting_id: Option<String>,
) -> Result<(), String> {
    const LABEL: &str = "meetings-window";

    if let Some(window) = app.get_webview_window(LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        // Warm path: the window already exists, so its `meetings:focus-meeting`
        // listener is mounted — a live emit is delivered immediately. (Global
        // `emit` per the codebase convention; only this window listens for it.)
        if let Some(id) = focus_meeting_id.filter(|s| !s.trim().is_empty()) {
            app.emit(
                "meetings:focus-meeting",
                serde_json::json!({ "meetingId": id }),
            )
            .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    // Use the bundled HQ app icon for this window's macOS dock / Cmd-Tab /
    // window-switcher representation. Without an explicit `.icon(...)` the
    // detached webview window falls back to the generic file-folder icon,
    // which reads as "some random app's window" in the switcher. The PNG
    // is baked into the binary at compile time so we don't depend on any
    // runtime filesystem path being correct.
    //
    // Future polish: composite a small calendar badge in the lower-right
    // corner so this window's icon is distinguishable from the main HQ
    // Sync window at a glance. Skipped here because (a) it requires an
    // image-processing step in the build pipeline and (b) the window-
    // switcher icon is rendered very small, so the badge would likely be
    // illegible at that scale anyway.
    const HQ_ICON_PNG: &[u8] = include_bytes!("../../icons/128x128@2x.png");
    let icon = tauri::image::Image::from_bytes(HQ_ICON_PNG)
        .map_err(|e| format!("load window icon: {e}"))?;

    tauri::WebviewWindowBuilder::new(&app, LABEL, tauri::WebviewUrl::App("index.html".into()))
        .title("Upcoming Meetings")
        .inner_size(460.0, 600.0)
        .min_inner_size(380.0, 400.0)
        .resizable(true)
        .decorations(true)
        .icon(icon)
        .map_err(|e| format!("attach window icon: {e}"))?
        .visible(true)
        .build()
        .map_err(|e| e.to_string())?;

    // Cold path: the window was just built, so its JS `meetings:focus-meeting`
    // listener is NOT yet mounted — a timed emit would race the webview and be
    // lost (see the "Multi-window ready handshake" gotcha in CLAUDE.md). Instead
    // stash the id; the meetings view drains it via `meetings_take_pending_focus`
    // on mount, after its listener + row refs are ready.
    if let Some(id) = focus_meeting_id.filter(|s| !s.trim().is_empty()) {
        set_pending_focus(Some(id));
    }

    Ok(())
}

/// One-shot "focus this meeting when the window mounts" hand-off. Set by
/// `open_meetings_window` on the cold path (window freshly built, JS listener
/// not yet live) and drained exactly once by the meetings view on mount via
/// `meetings_take_pending_focus`. A `OnceLock<Mutex<…>>` rather than Tauri
/// managed state so it is reachable from the free-standing command without an
/// `AppHandle`.
static PENDING_FOCUS_MEETING_ID: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn pending_focus() -> &'static Mutex<Option<String>> {
    PENDING_FOCUS_MEETING_ID.get_or_init(|| Mutex::new(None))
}

fn set_pending_focus(id: Option<String>) {
    let mut guard = pending_focus().lock().unwrap_or_else(|p| p.into_inner());
    *guard = id;
}

/// Drain the pending focus-meeting id (set when the Meetings window was opened
/// cold from a deep-link / notification). Returns it at most once, then clears
/// it so a later normal open doesn't re-focus a stale meeting.
#[tauri::command]
pub async fn meetings_take_pending_focus() -> Option<String> {
    let mut guard = pending_focus().lock().unwrap_or_else(|p| p.into_inner());
    guard.take()
}

// ── HTTP wrappers ─────────────────────────────────────────────────────────────

async fn auth_header() -> Result<String, String> {
    // Use the centralised valid-token helper so an expired access token
    // refreshes + persists transparently. The old version read the raw
    // stored access_token, which silently broke every meetings call
    // once the 1h Cognito TTL elapsed (popover sync runs `get_auth_state`
    // periodically and refreshed there, hiding the bug from the main UI).
    let token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;
    Ok(format!("Bearer {token}"))
}

async fn vault_base() -> Result<String, String> {
    resolve_vault_api_url().map(|u| u.trim_end_matches('/').to_string())
}

/// `GET /v1/calendar/events` — upcoming events from the caller's selected
/// calendars (within hq-pro's configured sync window).
#[tauri::command]
pub async fn meetings_list_upcoming() -> Result<Vec<MeetingEvent>, String> {
    let base = vault_base().await?;
    let auth = auth_header().await?;
    let res = build_client()
        .get(format!("{base}/v1/calendar/events"))
        .header("authorization", &auth)
        .send()
        .await
        .map_err(|e| format!("events fetch: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| format!("events read: {e}"))?;
    if !status.is_success() {
        return Err(format!("events HTTP {status}: {text}"));
    }
    let parsed: EventsResponse =
        serde_json::from_str(&text).map_err(|e| format!("events parse: {e} — body: {text}"))?;
    Ok(parsed.events)
}

// ── Per-account calendar lookup (multi-account filter UX) ─────────────────────

/// `GET /v1/google/accounts` — list every connected Google account on the
/// signed-in person. Returns empty vec when the user has no connections
/// (e.g. fresh install). The frontend uses this to label events with the
/// source account email and to drive the calendar-filter dropdown.
#[tauri::command]
pub async fn meetings_list_accounts() -> Result<Vec<GoogleAccount>, String> {
    let base = vault_base().await?;
    let auth = auth_header().await?;
    let res = build_client()
        .get(format!("{base}/v1/google/accounts"))
        .header("authorization", &auth)
        .send()
        .await
        .map_err(|e| format!("accounts fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("accounts read: {e}"))?;
    if !status.is_success() {
        return Err(format!("accounts HTTP {status}: {text}"));
    }
    let parsed: AccountsResponse =
        serde_json::from_str(&text).map_err(|e| format!("accounts parse: {e} — body: {text}"))?;
    Ok(parsed.accounts)
}

/// `GET /v1/calendar/calendars?accountId=…` — list every calendar visible
/// to one connected account AND surface that account's currently-enabled
/// selection. The frontend calls this once per account (in parallel) so
/// the multi-account filter dropdown can render calendar names grouped
/// by account, scoped to what's actually being fanned-out against by
/// hq-pro.
#[tauri::command]
pub async fn meetings_list_calendars_for_account(
    account_id: String,
) -> Result<AccountCalendars, String> {
    let base = vault_base().await?;
    let auth = auth_header().await?;
    // accountId is an `acct_{ulid}` (Crockford base32 + ASCII underscore) —
    // URL-safe by construction, no encoding needed. We still guard the
    // shape so a malformed value from the renderer surfaces as a clean
    // 400 from hq-pro rather than a malformed URL.
    if !account_id.starts_with("acct_") {
        return Err(format!("invalid accountId: {account_id}"));
    }
    let url = format!("{base}/v1/calendar/calendars?accountId={account_id}");
    let res = build_client()
        .get(url)
        .header("authorization", &auth)
        .send()
        .await
        .map_err(|e| format!("calendars fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("calendars read: {e}"))?;
    if !status.is_success() {
        return Err(format!("calendars HTTP {status}: {text}"));
    }
    let parsed: CalendarsResponse =
        serde_json::from_str(&text).map_err(|e| format!("calendars parse: {e} — body: {text}"))?;
    Ok(AccountCalendars {
        calendars: parsed.calendars,
        selected_calendar_ids: parsed
            .selected_calendars
            .into_iter()
            .map(|s| s.id)
            .collect(),
    })
}

/// `GET /v1/bot/list` (optionally `?calendarEventIds=a,b,c`) — bots for the
/// caller. Filter param lets the UI ask only about the events it's rendering.
#[tauri::command]
pub async fn meetings_list_scheduled_bots(
    calendar_event_ids: Option<Vec<String>>,
) -> Result<Vec<ScheduledBot>, String> {
    let base = vault_base().await?;
    let auth = auth_header().await?;
    let mut url = format!("{base}/v1/bot/list");
    if let Some(ids) = calendar_event_ids.as_ref() {
        if !ids.is_empty() {
            let joined = ids
                .iter()
                .map(|id| encode_query_value(id))
                .collect::<Vec<_>>()
                .join(",");
            url.push_str(&format!("?calendarEventIds={joined}"));
        }
    }
    let res = build_client()
        .get(url)
        .header("authorization", &auth)
        .send()
        .await
        .map_err(|e| format!("bot/list fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("bot/list read: {e}"))?;
    if !status.is_success() {
        return Err(format!("bot/list HTTP {status}: {text}"));
    }
    let parsed: BotsResponse =
        serde_json::from_str(&text).map_err(|e| format!("bot/list parse: {e} — body: {text}"))?;
    Ok(parsed.bots)
}

#[tauri::command]
pub async fn meetings_set_company(
    meeting_id: String,
    company_id: String,
    apply_to_series: Option<bool>,
) -> Result<SetCompanyResult, String> {
    let meeting_id = meeting_id.trim().to_string();
    let company_id = company_id.trim().to_string();
    if meeting_id.is_empty() {
        return Err("meetingId is required".to_string());
    }
    if !is_url_safe_id(&meeting_id) {
        return Err(format!("meetingId has invalid characters: {meeting_id:?}"));
    }
    if company_id.is_empty() {
        return Err("companyId is required".to_string());
    }

    let base = vault_base().await?;
    let auth = auth_header().await?;
    let url = format!("{base}/v1/meetings/{meeting_id}/company");
    let body = build_set_company_body(&company_id, apply_to_series.unwrap_or(true));
    let res = build_client()
        .post(url)
        .header("authorization", &auth)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("meeting/company fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("meeting/company read: {e}"))?;
    if !status.is_success() {
        crate::util::logfile::log(
            "meetings",
            &format!("meeting/company HTTP {status}: {text}"),
        );
        let parsed = serde_json::from_str::<SetCompanyErrorBody>(&text).ok();
        return Err(set_company_error_message(parsed));
    }
    serde_json::from_str(&text).map_err(|e| format!("meeting/company parse: {e} — body: {text}"))
}

/// `POST /v1/bot/invite` — schedule a Recall.ai bot for a meeting. Pass
/// `company_id` as a query param so hq-pro routes the transcript to that
/// company's vault (it validates the caller is a member). Omit to land
/// the meeting in the user's personal vault.
#[tauri::command]
pub async fn meetings_invite_bot(
    meeting_url: String,
    calendar_event_id: Option<String>,
    calendar_series_id: Option<String>,
    company_id: Option<String>,
) -> Result<ScheduledBot, String> {
    let base = vault_base().await?;
    let auth = auth_header().await?;
    let mut url = format!("{base}/v1/bot/invite");
    if let Some(cid) = company_id.as_ref() {
        if !cid.is_empty() {
            url.push_str(&format!("?companyId={cid}"));
        }
    }
    // Fetch ontology-resolved participants best-effort (US-005).
    // 2-second deadline; empty vec on any failure so the invite always fires.
    let participants =
        fetch_participants_best_effort(&base, &auth, &meeting_url, calendar_event_id.as_deref())
            .await;

    let body = InviteBotBody {
        meeting_url,
        calendar_event_id,
        calendar_series_id,
        participants,
    };
    let res = build_client()
        .post(url)
        .header("authorization", &auth)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("bot/invite fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("bot/invite read: {e}"))?;
    if !status.is_success() {
        return Err(format!("bot/invite HTTP {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("bot/invite parse: {e} — body: {text}"))
}

/// `POST /v1/bot/join-now` — force the Recall.ai bot to join NOW for
/// `meeting_url`, regardless of any pre-scheduled `join_at`. Backs the
/// MeetingsWindow row's bot-join-now icon button. Server-side
/// (`bot.service.ts::joinBotNow`) decides the right path:
///
///   - existing `scheduled` bot → PATCH Recall `join_at = now`
///   - existing `joining`/`recording` bot → no-op, return as-is
///   - otherwise → flip any `completed` siblings to `failed`, then create
///     a fresh bot with no `join_at` so Recall joins immediately
///
/// Same request shape as `meetings_invite_bot` so the UI handler can
/// hand off the same `meeting_url` + `calendar_event_id` + `company_id`
/// triple without re-derivation.
#[tauri::command]
pub async fn meetings_join_bot_now(
    meeting_url: String,
    calendar_event_id: Option<String>,
    calendar_series_id: Option<String>,
    company_id: Option<String>,
) -> Result<ScheduledBot, String> {
    let base = vault_base().await?;
    let auth = auth_header().await?;
    let mut url = format!("{base}/v1/bot/join-now");
    if let Some(cid) = company_id.as_ref() {
        if !cid.is_empty() {
            url.push_str(&format!("?companyId={cid}"));
        }
    }

    let body = InviteBotBody {
        meeting_url,
        calendar_event_id,
        calendar_series_id,
        // join-now reuses an existing bot record when one already exists
        // for the meeting; if not, the server creates a fresh one. We
        // don't have ontology participants in scope here (we'd need a
        // calendar event id resolvable to the meeting), so let the server
        // either reuse the existing bot's `participants` array or accept
        // an empty list for the fresh-create case. Best-effort enrichment
        // for the bot-invite path lives in `meetings_invite_bot`.
        participants: Vec::new(),
    };
    let res = build_client()
        .post(url)
        .header("authorization", &auth)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("bot/join-now fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("bot/join-now read: {e}"))?;
    if !status.is_success() {
        return Err(format!("bot/join-now HTTP {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("bot/join-now parse: {e} — body: {text}"))
}

#[tauri::command]
pub async fn meetings_list_memberships() -> Result<Vec<CompanyMembership>, String> {
    let base = vault_base().await?;
    let auth = auth_header().await?;
    // Strip the "Bearer " prefix to match VaultClient's expected token format.
    let token = auth.strip_prefix("Bearer ").unwrap_or(&auth);
    let client = crate::commands::vault_client::VaultClient::new(&base, token);
    let memberships = client
        .list_my_memberships()
        .await
        .map_err(|e| format!("memberships fetch: {e}"))?;
    // Project down to the fields the modal needs — keeps the JSON wire
    // payload tight and decouples the UI from the internal vault type.
    Ok(memberships
        .into_iter()
        .map(|m| CompanyMembership {
            company_uid: m.company_uid,
            company_name: m.company_name,
            role: m.role,
            status: m.status,
        })
        .collect())
}

/// `POST /v1/bot/{botId}/cancel` — uninvite a scheduled bot. hq-pro validates
/// caller ownership before calling Recall.ai bot-leave.
///
/// `bot_id` must be a Recall.ai bot id (UUID-style — `[a-zA-Z0-9_-]+`). We
/// validate the shape before concatenating into the path to keep the URL
/// well-formed without pulling in a percent-encoding crate.
#[tauri::command]
pub async fn meetings_cancel_bot(bot_id: String) -> Result<CancelBotResult, String> {
    if bot_id.is_empty() {
        return Err("bot_id is required".to_string());
    }
    if !is_url_safe_id(&bot_id) {
        return Err(format!("bot_id has invalid characters: {bot_id:?}"));
    }
    let base = vault_base().await?;
    let auth = auth_header().await?;
    let url = format!("{base}/v1/bot/{bot_id}/cancel");
    let res = build_client()
        .post(url)
        .header("authorization", &auth)
        .send()
        .await
        .map_err(|e| format!("bot/cancel fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("bot/cancel read: {e}"))?;
    if !status.is_success() {
        return Err(format!("bot/cancel HTTP {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("bot/cancel parse: {e} — body: {text}"))
}

// ── Detection-triggered notification commands ─────────────────────────────────

/// Check whether an active bot already exists for the given meeting URL.
///
/// Returns `Some(bot)` when a bot with an active status (`scheduled`,
/// `joining`, `recording`, `processing` — hq-pro's normalized `BotStatus`) is
/// found. The Svelte handler calls this before `meetings_notify_detected`; a
/// bot already in the room means we should skip the notification.
///
/// Query: `GET /v1/bot/list?meetingUrl=<url>[&eventId=<id>]`
#[tauri::command]
pub async fn meetings_check_bot_for_url(
    meeting_url: String,
    event_id: Option<String>,
) -> Result<Option<ScheduledBot>, String> {
    let base = vault_base().await?;
    let auth = auth_header().await?;
    let mut req = build_client()
        .get(format!("{base}/v1/bot/list"))
        .header("authorization", &auth)
        .query(&[("meetingUrl", meeting_url.as_str())]);
    if let Some(id) = event_id.as_deref().filter(|s| !s.is_empty()) {
        req = req.query(&[("eventId", id)]);
    }
    let res = req
        .send()
        .await
        .map_err(|e| format!("bot/list check: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("bot/list check read: {e}"))?;
    if !status.is_success() {
        return Err(format!("bot/list check HTTP {status}: {text}"));
    }
    let parsed: BotsResponse = serde_json::from_str(&text)
        .map_err(|e| format!("bot/list check parse: {e} — body: {text}"))?;
    // hq-pro already narrows the `?meetingUrl=` query to active bots; pick the
    // first whose normalized status still counts as active (see
    // `first_active_bot`). Matching hq-pro's vocabulary here is what keeps the
    // detect-meeting notification suppressed for a scheduled meeting whose bot
    // has already joined the call.
    Ok(first_active_bot(parsed.bots))
}

static UNATTRIBUTED_SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn unattributed_seen() -> &'static Mutex<HashSet<String>> {
    UNATTRIBUTED_SEEN.get_or_init(|| Mutex::new(HashSet::new()))
}

const UNATTRIBUTED_POLL_INTERVAL_SECS: u64 = 120;

pub fn setup_unattributed_meeting_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        poll_unattributed_once(app.clone()).await;
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(
            UNATTRIBUTED_POLL_INTERVAL_SECS,
        ));
        interval.tick().await;
        loop {
            interval.tick().await;
            poll_unattributed_once(app.clone()).await;
        }
    });
}

pub async fn poll_unattributed_once(app: AppHandle) {
    let settings = match crate::commands::settings::get_settings().await {
        Ok(settings) => settings,
        Err(e) => {
            crate::util::logfile::log(
                "meetings",
                &format!("unattributed poll settings failed: {e}"),
            );
            return;
        }
    };
    if !settings.notifications.unwrap_or(true) {
        return;
    }

    let base = match vault_base().await {
        Ok(base) => base,
        Err(e) => {
            crate::util::logfile::log("meetings", &format!("unattributed poll base failed: {e}"));
            return;
        }
    };
    let auth = match auth_header().await {
        Ok(auth) => auth,
        Err(e) => {
            crate::util::logfile::log("meetings", &format!("unattributed poll auth failed: {e}"));
            return;
        }
    };

    let res = match build_client()
        .get(format!("{base}/v1/bot/list"))
        .header("authorization", &auth)
        .send()
        .await
    {
        Ok(res) => res,
        Err(e) => {
            crate::util::logfile::log("meetings", &format!("unattributed poll fetch failed: {e}"));
            return;
        }
    };
    let status = res.status();
    let text = match res.text().await {
        Ok(text) => text,
        Err(e) => {
            crate::util::logfile::log("meetings", &format!("unattributed poll read failed: {e}"));
            return;
        }
    };
    if !status.is_success() {
        crate::util::logfile::log(
            "meetings",
            &format!("unattributed poll HTTP {status}: {text}"),
        );
        return;
    }
    let parsed: BotsResponse = match serde_json::from_str(&text) {
        Ok(parsed) => parsed,
        Err(e) => {
            crate::util::logfile::log("meetings", &format!("unattributed poll parse failed: {e}"));
            return;
        }
    };
    let candidates = select_unattributed(&parsed.bots);
    let new_ids = {
        let mut guard = unattributed_seen()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        dedupe_new(&mut guard, &candidates)
    };
    for meeting_id in new_ids {
        let title = parsed
            .bots
            .iter()
            .find(|bot| bot.bot_id == meeting_id)
            .and_then(|bot| bot.meeting_title.clone());
        if let Err(e) = crate::commands::banner::show_unattributed_meeting_banner(
            app.clone(),
            meeting_id,
            title,
        )
        .await
        {
            crate::util::logfile::log("meetings", &format!("unattributed banner failed: {e}"));
        }
    }
}

/// Fire a macOS notification for a detected meeting, gated on:
///
/// 1. `notifications` pref in `~/.hq/menubar.json` (read fresh on each call
///    so pref changes take effect without restart — US-007 requirement)
/// 2. `meetingDetectNotify.enabled` and the per-platform allow-list
/// 3. Meeting-notify ledger dedup (suppress if already notified within 6 h)
///
/// Returns `true` when the notification was fired, `false` if suppressed.
/// Also increments the tray `Prompt` badge on a successful fire.
#[tauri::command]
pub async fn meetings_notify_detected(
    app: AppHandle,
    payload: NotifyDetectedPayload,
) -> Result<bool, String> {
    use crate::commands::settings::get_settings;
    use crate::tray::{get_prompt_pending, set_prompt_badge};
    use crate::util::meeting_ledger::{claim_notify, stable_key};
    use chrono::Utc;
    use tauri::Emitter;

    // 1. Top-level notifications pref.
    let settings = get_settings().await?;
    if !settings.notifications.unwrap_or(true) {
        return Ok(false);
    }

    // 2. Meeting-detect-notify sub-pref + per-platform filter.
    let mdn = settings.meeting_detect_notify.as_ref();
    if !mdn.and_then(|m| m.enabled).unwrap_or(true) {
        return Ok(false);
    }
    let platform_lc = payload
        .platform
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !platform_lc.is_empty() {
        if let Some(allowed) = mdn.and_then(|m| m.platforms.as_ref()) {
            if !allowed.is_empty()
                && !allowed
                    .iter()
                    .any(|p| p.to_ascii_lowercase() == platform_lc)
            {
                return Ok(false);
            }
        }
    }

    // 3. Dedup via ledger — atomic single-flight claim.
    //
    // The SDK emits `meeting:detected` once but Tauri fans it out to EVERY
    // webview, so both the popover (App.svelte) and the desktop-alt window
    // (activeMeetings.ts) can invoke this command for the same meeting
    // concurrently. `claim_notify` takes a process-wide lock and performs
    // read→should_suppress→mark(Notified)→write as one indivisible step, so the
    // second caller observes the first's just-written entry and loses the race.
    // This is the authoritative guard against double-notifying; the source-level
    // dedup in activeMeetings.ts is defence-in-depth on top of it.
    //
    // The claim runs synchronously and BEFORE any `.await` below — the ledger
    // lock guard must never be held across an await point (it is dropped here,
    // before the async banner dispatch).
    let key = match stable_key(
        payload.meeting_url.as_deref(),
        payload.source_event_id.as_deref(),
    ) {
        Some(k) => k,
        None => return Ok(false),
    };
    let now = Utc::now();
    if !claim_notify(&key, now) {
        // Either already notified/recorded within the suppression window, or a
        // concurrent caller won the claim. Do not fire a second banner.
        return Ok(false);
    }

    // 4. Build notification body: "<Platform>: <summary or url>".
    let body = build_notification_body(
        &platform_lc,
        payload.summary.as_deref(),
        payload.meeting_url.as_deref(),
    );

    // 5. Custom-banner path (default). When `customBanner` is on, deliver the
    // detection through the in-app liquid-glass banner — the same HQ-branded
    // surface as DM / share / update — instead of the native UN/osascript/legacy
    // stack below. The banner runs in-process, so a body-click opens the Meetings
    // window straight from `App.svelte`'s banner-action router (no UN delegate
    // needed) and the chip starts recording. The native delivery below is kept
    // only as the `customBanner: false` fallback (older macOS / opt-out).
    // US-003: widget takeover must never fall back to native banners
    if crate::commands::banner::custom_banner_enabled()
        || crate::commands::widget::takeover_active(&app)
    {
        let title = build_notification_title(&platform_lc);
        let window_id = payload.window_id.clone().unwrap_or_default();
        if let Err(e) = crate::commands::banner::show_meeting_banner(
            app.clone(),
            title,
            body.clone(),
            window_id,
            platform_lc.clone(),
        )
        .await
        {
            crate::util::logfile::log("meetings", &format!("custom meeting banner failed: {e}"));
        }
        // Ledger already marked Notified by `claim_notify` above (the claim is
        // what authorised this fire), so we only bump the tray badge here.
        set_prompt_badge(&app, get_prompt_pending() + 1);
        return Ok(true);
    }

    // 6. Native fallback (customBanner off). Fire via `mac-notification-sys` directly so we
    // can attach a "Record" action button AND learn when the user clicks
    // the notification body. `tauri-plugin-notification` 2.3.3's desktop
    // path ignores `action_type_id` (it's mobile-only at that layer), so
    // we bypass it for this specific surface and keep the rest of the
    // app's plugin-based notifications unchanged.
    //
    // Wire shape:
    //   Notification body click  → emit `notification:meeting-action`
    //                              with action="open"
    //   "Record" action button   → emit `notification:meeting-action`
    //                              with action="record"
    //   Anything else (dismiss,  → no event (silently dropped)
    //   ignore, timeout)
    //
    // The Svelte side listens for the event and either focuses the
    // popover (action=open) or invokes `start_recording` directly
    // (action=record).
    //
    // mac-notification-sys's `send()` is blocking when `wait_for_click`
    // is true — it returns the response only after the user interacts.
    // We spawn a dedicated thread per notification so the async Tauri
    // command itself never blocks; the thread captures the windowId via
    // closure and lives until the user dismisses the notification (or
    // macOS auto-dismisses it).
    #[cfg(target_os = "macos")]
    {
        // Register the bundle identifier with mac-notification-sys once per
        // process lifetime. Without this, the library calls
        // `get_bundle_identifier_or_default("use_default")` internally, which
        // triggers a macOS "Choose Application" picker because Launch
        // Services can't resolve the literal string "use_default" to an
        // installed app (observed in field test on 2026-05-25). Calling
        // `set_application` with our real bundle id makes notifications
        // attribute correctly to HQ Sync and skips the picker.
        //
        // `set_application` itself is guarded by an internal `Once`, so
        // calling it on every notification send would be safe — but wrapping
        // in our own OnceLock keeps the log line at one-per-process.
        static NOTIFICATION_APP_INIT: OnceLock<()> = OnceLock::new();
        NOTIFICATION_APP_INIT.get_or_init(|| {
            const BUNDLE_ID: &str = "ai.indigo.hq-sync-menubar";
            match mac_notification_sys::set_application(BUNDLE_ID) {
                Ok(()) => {
                    crate::util::logfile::log(
                        "meetings",
                        &format!("mac-notification-sys: registered bundle {BUNDLE_ID}"),
                    );
                }
                Err(e) => {
                    crate::util::logfile::log(
                        "meetings",
                        &format!("mac-notification-sys: set_application({BUNDLE_ID}) failed: {e}"),
                    );
                }
            }
        });

        let window_id_for_thread = payload.window_id.clone().unwrap_or_default();
        let platform_for_thread = platform_lc.clone();
        let title_for_thread = build_notification_title(&platform_lc);
        let body_for_thread = body.clone();
        let app_for_thread = app.clone();
        std::thread::spawn(move || {
            // ── Clickable delivery: UNUserNotificationCenter ────────────────
            // When notification permission is *granted*, deliver through
            // UNUserNotificationCenter instead of osascript. A UN banner carries
            // a click callback (via the delegate installed at launch in
            // `un_notify.rs`), so clicking the banner opens the desktop-alt
            // "HQ Meetings" window — even on a *cold* click where no frontend
            // `notification:meeting-action` listener exists yet (the delegate
            // opens the window straight from Rust). UN silently DROPS the request
            // when status != "granted", so we gate strictly on "granted" and fall
            // through to the always-visible osascript path otherwise — zero
            // regression for non-granted users. One delivery path per branch, so
            // there's never a double banner.
            #[cfg(target_os = "macos")]
            if hq_platform::notifications::permission_state_without_app() == "granted" {
                crate::commands::un_notify::deliver_clickable(
                    &title_for_thread,
                    &body_for_thread,
                    &window_id_for_thread,
                    &platform_for_thread,
                );
                return;
            }

            // ── Primary delivery: AppleScript ───────────────────────────────
            // macOS 26 (Sequoia) blocks NSUserNotification from being mixed
            // with UNUserNotificationCenter in the same process. usernoted
            // logs:
            //   Error: Legacy client ai.indigo.hq-sync-menubar connecting to
            //   modern client. Denying message N from <LegacyConnection>.
            // Once anything in the process touches UN (the
            // `notification_permission_state` IPC probe is enough), the
            // legacy `mac-notification-sys` deliver path is silently denied
            // forever. `osascript display notification` doesn't go through
            // the per-process legacy/modern gate — it's NotificationCenter's
            // own scripting bridge — so it fires reliably regardless.
            //
            // Trade-off vs. the legacy library: no action button. We lose
            // the inline "Record" button on the banner. Mitigation: the
            // popover's calendar icon now tints yellow on detection (see
            // MeetingIcon.svelte), so the user has an obvious in-app affordance
            // to act on the detection. Click on the notification body still
            // focuses HQ Sync (macOS's default behavior for any app's
            // notification), and our `notification:meeting-action` event
            // listener treats that as action="open" via the popover.
            //
            // Long-term: migrate to UNUserNotificationCenter via objc2 +
            // UNNotificationCategory + UNNotificationAction("RECORD") so the
            // Record button comes back. Tracked as a follow-up.
            let osa_body = body_for_thread.replace('\\', "\\\\").replace('"', "\\\"");
            let osa_title = title_for_thread.replace('\\', "\\\\").replace('"', "\\\"");
            let script = format!("display notification \"{osa_body}\" with title \"{osa_title}\"");
            match std::process::Command::new("/usr/bin/osascript")
                .args(["-e", &script])
                .output()
            {
                Ok(out) if out.status.success() => {
                    crate::util::logfile::log("meetings", "osascript notification fired");
                }
                Ok(out) => {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    crate::util::logfile::log(
                        "meetings",
                        &format!(
                            "osascript notification non-zero exit ({}): {}",
                            out.status, stderr
                        ),
                    );
                }
                Err(e) => {
                    crate::util::logfile::log("meetings", &format!("osascript spawn failed: {e}"));
                }
            }

            // ── Secondary delivery: legacy mac-notification-sys ────────────
            // Still attempted because: (1) some users may be on older macOS
            // where the legacy path works (Catalina/Big Sur/Monterey/Ventura),
            // and (2) it carries the Record action button via the response
            // thread. On Sequoia+ this thread's `send()` is denied by
            // usernoted and either errors immediately or returns
            // NotificationResponse::None — both paths are logged below so the
            // failure mode is visible.
            let mut notification = mac_notification_sys::Notification::default();
            notification
                .title(&title_for_thread)
                .message(&body_for_thread)
                // `main_button` attaches a single action button labelled
                // "Record". On older macOS this surfaces inline (alert
                // style) or on hover (banner style). Sequoia denies the
                // whole deliver, so this never reaches the user there.
                .main_button(mac_notification_sys::MainButton::SingleAction("Record"))
                // Block the thread until the user interacts (or macOS
                // auto-dismisses, which surfaces as None).
                .wait_for_click(true);
            match notification.send() {
                Ok(resp) => {
                    // Log the raw response variant so a "user said they got no
                    // notification" report can be cross-referenced against what
                    // mac-notification-sys actually returned. None/timeout reads
                    // identically to "macOS silently dropped the banner due to
                    // missing UNUserNotificationCenter authorization" in the
                    // logs — surfacing the variant makes that distinguishable.
                    let variant = match &resp {
                        mac_notification_sys::NotificationResponse::ActionButton(n) => {
                            format!("ActionButton({n})")
                        }
                        mac_notification_sys::NotificationResponse::Click => "Click".to_string(),
                        mac_notification_sys::NotificationResponse::CloseButton(_) => {
                            "CloseButton".to_string()
                        }
                        mac_notification_sys::NotificationResponse::Reply(_) => "Reply".to_string(),
                        mac_notification_sys::NotificationResponse::None => "None".to_string(),
                    };
                    crate::util::logfile::log(
                        "meetings",
                        &format!("mac-notification-sys response: {variant}"),
                    );
                    let action = match resp {
                        mac_notification_sys::NotificationResponse::ActionButton(name)
                            if name.eq_ignore_ascii_case("record") =>
                        {
                            Some("record")
                        }
                        mac_notification_sys::NotificationResponse::Click => Some("open"),
                        // CloseButton, Reply, None — no actionable signal for us.
                        _ => None,
                    };
                    if let Some(action) = action {
                        let payload = crate::events::NotificationMeetingActionEvent {
                            action: action.to_string(),
                            window_id: window_id_for_thread,
                            platform: platform_for_thread,
                            meeting_id: None,
                        };
                        if let Err(e) = app_for_thread
                            .emit(crate::events::EVENT_NOTIFICATION_MEETING_ACTION, &payload)
                        {
                            crate::util::logfile::log(
                                "meetings",
                                &format!("emit notification:meeting-action failed: {e}"),
                            );
                        }
                    }
                }
                Err(e) => {
                    crate::util::logfile::log(
                        "meetings",
                        &format!("mac-notification-sys send failed: {e}"),
                    );
                }
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let title = build_notification_title(&platform_lc);
        match app
            .notification()
            .builder()
            .title(&title)
            .body(&body)
            .show()
        {
            Ok(()) => crate::util::logfile::log("meetings", "meeting toast notification fired"),
            Err(e) => crate::util::logfile::log(
                "meetings",
                &format!("meeting toast notification failed: {e}"),
            ),
        }
    }

    // 6. Bump tray badge. The ledger was already marked Notified atomically by
    // `claim_notify` above (the claim is what authorised this fire), so there is
    // no second read-modify-write here — that non-atomic re-write was the source
    // of the double-notification race.
    set_prompt_badge(&app, get_prompt_pending() + 1);

    Ok(true)
}

/// Decrement the meeting-prompt tray badge by one (saturating).
///
/// Call when the user opens MeetingsWindow or acts on a notification.
/// Saturating so a double-call doesn't underflow to `usize::MAX`.
#[tauri::command]
pub async fn meetings_clear_prompt_badge(app: AppHandle) {
    use crate::tray::{get_prompt_pending, set_prompt_badge};
    set_prompt_badge(&app, get_prompt_pending().saturating_sub(1));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduled_bot_event_id_query_encoding_escapes_reserved_chars() {
        assert_eq!(encode_query_value("event_123-abc.def"), "event_123-abc.def");
        assert_eq!(
            encode_query_value("event 1?x=2#frag"),
            "event+1%3Fx%3D2%23frag"
        );
    }

    #[test]
    fn meetings_cancel_bot_result_parses_series_response() {
        let json = r#"{
            "botId": "bot-abc",
            "status": "failed",
            "cancelled": true,
            "scope": "series",
            "cancelledCount": 3,
            "failedCount": 1,
            "calendarSeriesId": "series-1",
            "recurringMeeting": true,
            "cancelledBotIds": ["bot-abc", "bot-def", "bot-ghi"]
        }"#;
        let result: CancelBotResult = serde_json::from_str(json).expect("cancel result parse");
        assert_eq!(result.bot_id, "bot-abc");
        assert_eq!(result.scope.as_deref(), Some("series"));
        assert_eq!(result.cancelled_count, Some(3));
        assert_eq!(result.failed_count, Some(1));
        assert_eq!(result.calendar_series_id.as_deref(), Some("series-1"));
        assert!(result.recurring_meeting);
        assert_eq!(result.cancelled_bot_ids.len(), 3);
    }
}
