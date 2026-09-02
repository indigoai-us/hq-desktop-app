//! Recall SDK and GStreamer meeting/recording command owner.

use std::fmt;
use std::fs;
use std::io::ErrorKind;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::local::CoreBackend;
use crate::{to_value, CancellationFlag, EngineError};

pub(crate) const IMPLEMENTED_METHODS: &[&str] = &[
    "meeting_detect_feature_enabled",
    "meetings_feature_enabled",
    "meetings_list_active_detections",
    "meetings_list_active_recordings",
    "meetings_list_upcoming",
    "meetings_list_accounts",
    "meetings_list_calendars_for_account",
    "meetings_list_scheduled_bots",
    "meetings_set_company",
    "meetings_invite_bot",
    "meetings_join_bot_now",
    "meetings_list_memberships",
    "meetings_cancel_bot",
    "meetings_check_bot_for_url",
    "meetings_notify_detected",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MeetingVerb {
    Get,
    Post,
}

#[derive(Clone, PartialEq)]
struct MeetingRequest {
    method: MeetingVerb,
    url: String,
    bearer_token: String,
    body: Option<Value>,
}

impl fmt::Debug for MeetingRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MeetingRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("bearer_token", &"<redacted>")
            .field("body", &self.body)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq)]
struct MeetingResponse {
    status: u16,
    body: Value,
}

trait MeetingTransport {
    fn send(
        &self,
        request: MeetingRequest,
        cancellation: &CancellationFlag,
    ) -> Result<MeetingResponse, EngineError>;
}

struct ReqwestMeetingTransport {
    client: reqwest::blocking::Client,
}

impl ReqwestMeetingTransport {
    fn new() -> Result<Self, EngineError> {
        reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(format!("HQ-Native/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map(|client| Self { client })
            .map_err(|error| {
                EngineError::new(
                    "meetings_client_unavailable",
                    format!("Could not initialize the meetings service: {error}"),
                    true,
                )
            })
    }
}

impl MeetingTransport for ReqwestMeetingTransport {
    fn send(
        &self,
        request: MeetingRequest,
        cancellation: &CancellationFlag,
    ) -> Result<MeetingResponse, EngineError> {
        cancellation.check()?;
        let builder = match request.method {
            MeetingVerb::Get => self.client.get(&request.url),
            MeetingVerb::Post => self.client.post(&request.url),
        }
        .bearer_auth(&request.bearer_token);
        let builder = if let Some(body) = request.body.as_ref() {
            builder.json(body)
        } else {
            builder
        };
        let response = builder.send().map_err(|error| {
            EngineError::new(
                "meetings_network_error",
                format!("The meetings service could not be reached: {error}"),
                true,
            )
        })?;
        cancellation.check()?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|_| {
            EngineError::new(
                "meetings_response_unreadable",
                "The meetings service returned an unreadable response",
                true,
            )
        })?;
        let body = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::Null)
        };
        Ok(MeetingResponse { status, body })
    }
}

#[derive(Clone)]
struct MeetingContext {
    base_url: String,
    access_token: String,
}

impl fmt::Debug for MeetingContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MeetingContext")
            .field("base_url", &self.base_url)
            .field("access_token", &"<redacted>")
            .finish()
    }
}

impl MeetingContext {
    fn from_local_state() -> Result<Self, EngineError> {
        let config = hq_desktop_core::config::read_hq_config_lenient()
            .map_err(|message| EngineError::new("meetings_config_unavailable", message, false))?
            .ok_or_else(|| {
                EngineError::new(
                    "meetings_config_unavailable",
                    "HQ is not configured for meetings",
                    false,
                )
            })?;
        let base_url = config.vault_api_url.trim().trim_end_matches('/');
        if base_url.is_empty() {
            return Err(EngineError::new(
                "meetings_config_unavailable",
                "The configured HQ service URL is empty",
                false,
            ));
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                EngineError::new(
                    "meetings_auth_unavailable",
                    format!("Could not initialize meetings authentication: {error}"),
                    true,
                )
            })?;
        let access_token = runtime
            .block_on(hq_desktop_core::cognito::get_valid_access_token())
            .map_err(|message| {
                EngineError::new(
                    "meetings_auth_required",
                    format!("Sign in again to use meetings: {message}"),
                    false,
                )
            })?;
        Ok(Self {
            base_url: base_url.to_string(),
            access_token,
        })
    }
}

pub(crate) fn execute(
    backend: &CoreBackend,
    method: &str,
    params: &Value,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    cancellation.check()?;
    if is_local_meeting_method(method) {
        return execute_local_meeting(backend, method, params, cancellation);
    }
    let context = MeetingContext::from_local_state()?;
    let transport = ReqwestMeetingTransport::new()?;
    execute_with_transport(backend, method, params, cancellation, &context, &transport)
}

fn is_local_meeting_method(method: &str) -> bool {
    matches!(
        method,
        "meeting_detect_feature_enabled"
            | "meetings_feature_enabled"
            | "meetings_list_active_detections"
            | "meetings_list_active_recordings"
            | "meetings_notify_detected"
    )
}

fn execute_local_meeting(
    backend: &CoreBackend,
    method: &str,
    params: &Value,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    match method {
        "meeting_detect_feature_enabled" | "meetings_feature_enabled" => to_value(
            hq_desktop_core::feature_gate::email_present(backend.identity_email()?.as_deref()),
        ),
        "meetings_list_active_detections" => {
            to_value(hq_desktop_core::recall_sdk::active_detections_snapshot())
        }
        "meetings_list_active_recordings" => {
            let ledger = hq_desktop_core::recordings_ledger::read_ledger().unwrap_or_default();
            to_value(hq_desktop_core::recall_sdk::active_recordings_from_ledger(
                ledger,
            ))
        }
        "meetings_notify_detected" => {
            let params: NotifyDetectedParams = decode_params(method, params)?;
            let policy = read_meeting_notify_policy(backend)?;
            cancellation.check()?;
            let decision = decide_meeting_notification(
                &policy,
                params.payload,
                chrono::Utc::now(),
                hq_desktop_core::meeting_ledger::claim_notify,
            );
            cancellation.check()?;
            to_value(decision)
        }
        _ => Err(method_not_found(method)),
    }
}

fn execute_with_transport(
    backend: &CoreBackend,
    method: &str,
    params: &Value,
    cancellation: &CancellationFlag,
    context: &MeetingContext,
    transport: &impl MeetingTransport,
) -> Result<Value, EngineError> {
    cancellation.check()?;
    if is_local_meeting_method(method) {
        return execute_local_meeting(backend, method, params, cancellation);
    }

    match method {
        "meetings_list_upcoming" => {
            let body = send_success(
                context,
                transport,
                cancellation,
                MeetingVerb::Get,
                "/v1/calendar/events".to_string(),
                None,
                method,
            )?;
            let response: hq_desktop_core::meetings::EventsResponse =
                decode_response(method, body)?;
            to_value(response.events)
        }
        "meetings_list_accounts" => {
            let body = send_success(
                context,
                transport,
                cancellation,
                MeetingVerb::Get,
                "/v1/google/accounts".to_string(),
                None,
                method,
            )?;
            let response: hq_desktop_core::meetings::AccountsResponse =
                decode_response(method, body)?;
            to_value(response.accounts)
        }
        "meetings_list_calendars_for_account" => {
            let params: CalendarsParams = decode_params(method, params)?;
            let account_id = required_trimmed(method, "accountId", params.account_id)?;
            if !account_id.starts_with("acct_")
                || !hq_desktop_core::meetings::is_url_safe_id(&account_id)
            {
                return Err(invalid_param(
                    method,
                    "`accountId` must be a valid acct_ identifier",
                ));
            }
            let body = send_success(
                context,
                transport,
                cancellation,
                MeetingVerb::Get,
                format!(
                    "/v1/calendar/calendars?accountId={}",
                    hq_desktop_core::meetings::encode_query_value(&account_id)
                ),
                None,
                method,
            )?;
            let response: hq_desktop_core::meetings::CalendarsResponse =
                decode_response(method, body)?;
            to_value(hq_desktop_core::meetings::AccountCalendars {
                calendars: response.calendars,
                selected_calendar_ids: response
                    .selected_calendars
                    .into_iter()
                    .map(|calendar| calendar.id)
                    .collect(),
            })
        }
        "meetings_list_scheduled_bots" => {
            let params: ScheduledBotsParams = decode_params(method, params)?;
            let query = params
                .calendar_event_ids
                .unwrap_or_default()
                .into_iter()
                .map(|id| hq_desktop_core::meetings::encode_query_value(id.trim()))
                .filter(|id| !id.is_empty())
                .collect::<Vec<_>>();
            let path = if query.is_empty() {
                "/v1/bot/list".to_string()
            } else {
                format!("/v1/bot/list?calendarEventIds={}", query.join(","))
            };
            let body = send_success(
                context,
                transport,
                cancellation,
                MeetingVerb::Get,
                path,
                None,
                method,
            )?;
            let response: hq_desktop_core::meetings::BotsResponse = decode_response(method, body)?;
            to_value(response.bots)
        }
        "meetings_set_company" => {
            let params: SetCompanyParams = decode_params(method, params)?;
            let meeting_id = required_safe_id(method, "meetingId", params.meeting_id)?;
            let company_id = required_trimmed(method, "companyId", params.company_id)?;
            let request_body = to_value(hq_desktop_core::meetings::build_set_company_body(
                &company_id,
                params.apply_to_series.unwrap_or(true),
            ))?;
            let response = send(
                context,
                transport,
                cancellation,
                MeetingVerb::Post,
                format!("/v1/meetings/{meeting_id}/company"),
                Some(request_body),
            )?;
            if !(200..300).contains(&response.status) {
                let parsed =
                    serde_json::from_value::<hq_desktop_core::meetings::SetCompanyErrorBody>(
                        response.body,
                    )
                    .ok();
                return Err(EngineError::new(
                    "meetings_set_company_failed",
                    hq_desktop_core::meetings::set_company_error_message(parsed),
                    response.status >= 500 || response.status == 429,
                ));
            }
            let result: hq_desktop_core::meetings::SetCompanyResult =
                decode_response(method, response.body)?;
            to_value(result)
        }
        "meetings_invite_bot" | "meetings_join_bot_now" => {
            let params: InviteBotParams = decode_params(method, params)?;
            let meeting_url = required_meeting_url(method, params.meeting_url)?;
            let company_id = trimmed_optional(params.company_id);
            let calendar_event_id = trimmed_optional(params.calendar_event_id);
            let calendar_series_id = trimmed_optional(params.calendar_series_id);
            let participants = if method == "meetings_invite_bot" {
                participants_best_effort(
                    context,
                    transport,
                    cancellation,
                    &meeting_url,
                    calendar_event_id.as_deref(),
                )?
            } else {
                Vec::new()
            };
            let request_body = to_value(hq_desktop_core::meetings::InviteBotBody {
                meeting_url,
                calendar_event_id,
                calendar_series_id,
                participants,
            })?;
            let endpoint = if method == "meetings_invite_bot" {
                "/v1/bot/invite"
            } else {
                "/v1/bot/join-now"
            };
            let path = company_id.map_or_else(
                || endpoint.to_string(),
                |company_id| {
                    format!(
                        "{endpoint}?companyId={}",
                        hq_desktop_core::meetings::encode_query_value(&company_id)
                    )
                },
            );
            let body = send_success(
                context,
                transport,
                cancellation,
                MeetingVerb::Post,
                path,
                Some(request_body),
                method,
            )?;
            let bot: hq_desktop_core::meetings::ScheduledBot = decode_response(method, body)?;
            to_value(bot)
        }
        "meetings_list_memberships" => {
            let body = send_success(
                context,
                transport,
                cancellation,
                MeetingVerb::Get,
                "/membership/me".to_string(),
                None,
                method,
            )?;
            let response: MembershipsResponse = decode_response(method, body)?;
            to_value(
                response
                    .memberships
                    .into_iter()
                    .map(|membership| hq_desktop_core::meetings::CompanyMembership {
                        company_uid: membership.company_uid,
                        company_name: membership.company_name,
                        role: membership.role,
                        status: membership.status,
                    })
                    .collect::<Vec<_>>(),
            )
        }
        "meetings_cancel_bot" => {
            let params: CancelBotParams = decode_params(method, params)?;
            let bot_id = required_safe_id(method, "botId", params.bot_id)?;
            let body = send_success(
                context,
                transport,
                cancellation,
                MeetingVerb::Post,
                format!("/v1/bot/{bot_id}/cancel"),
                None,
                method,
            )?;
            let result: hq_desktop_core::meetings::CancelBotResult = decode_response(method, body)?;
            to_value(result)
        }
        "meetings_check_bot_for_url" => {
            let params: CheckBotParams = decode_params(method, params)?;
            let meeting_url = required_meeting_url(method, params.meeting_url)?;
            let mut path = format!(
                "/v1/bot/list?meetingUrl={}",
                hq_desktop_core::meetings::encode_query_value(&meeting_url)
            );
            if let Some(event_id) = trimmed_optional(params.event_id) {
                path.push_str("&eventId=");
                path.push_str(&hq_desktop_core::meetings::encode_query_value(&event_id));
            }
            let body = send_success(
                context,
                transport,
                cancellation,
                MeetingVerb::Get,
                path,
                None,
                method,
            )?;
            let response: hq_desktop_core::meetings::BotsResponse = decode_response(method, body)?;
            to_value(hq_desktop_core::meetings::first_active_bot(response.bots))
        }
        _ => Err(method_not_found(method)),
    }
}

fn send_success(
    context: &MeetingContext,
    transport: &impl MeetingTransport,
    cancellation: &CancellationFlag,
    verb: MeetingVerb,
    path: String,
    body: Option<Value>,
    method: &str,
) -> Result<Value, EngineError> {
    let response = send(context, transport, cancellation, verb, path, body)?;
    if (200..300).contains(&response.status) {
        Ok(response.body)
    } else {
        Err(EngineError::new(
            "meetings_request_failed",
            format!(
                "{method} was rejected by the meetings service (HTTP {})",
                response.status
            ),
            response.status >= 500 || response.status == 429,
        ))
    }
}

fn send(
    context: &MeetingContext,
    transport: &impl MeetingTransport,
    cancellation: &CancellationFlag,
    method: MeetingVerb,
    path: String,
    body: Option<Value>,
) -> Result<MeetingResponse, EngineError> {
    cancellation.check()?;
    let response = transport.send(
        MeetingRequest {
            method,
            url: format!("{}{}", context.base_url, path),
            bearer_token: context.access_token.clone(),
            body,
        },
        cancellation,
    )?;
    cancellation.check()?;
    Ok(response)
}

fn participants_best_effort(
    context: &MeetingContext,
    transport: &impl MeetingTransport,
    cancellation: &CancellationFlag,
    meeting_url: &str,
    event_id: Option<&str>,
) -> Result<Vec<hq_desktop_core::meetings::OntologyParticipant>, EngineError> {
    let mut path = format!(
        "/v1/ontology/participants?meetingUrl={}",
        hq_desktop_core::meetings::encode_query_value(meeting_url)
    );
    if let Some(event_id) = event_id {
        path.push_str("&eventId=");
        path.push_str(&hq_desktop_core::meetings::encode_query_value(event_id));
    }
    match send(
        context,
        transport,
        cancellation,
        MeetingVerb::Get,
        path,
        None,
    ) {
        Ok(response) if (200..300).contains(&response.status) => {
            #[derive(Deserialize)]
            struct ParticipantsResponse {
                #[serde(default)]
                participants: Vec<hq_desktop_core::meetings::OntologyParticipant>,
            }
            Ok(
                serde_json::from_value::<ParticipantsResponse>(response.body)
                    .map(|response| response.participants)
                    .unwrap_or_default(),
            )
        }
        Err(error) if error.code == "request_cancelled" => Err(error),
        Ok(_) | Err(_) => Ok(Vec::new()),
    }
}

fn decode_response<T: DeserializeOwned>(method: &str, value: Value) -> Result<T, EngineError> {
    serde_json::from_value(value).map_err(|_| {
        EngineError::new(
            "meetings_invalid_response",
            format!("{method} received an invalid response from the meetings service"),
            false,
        )
    })
}

fn decode_params<T: DeserializeOwned>(method: &str, value: &Value) -> Result<T, EngineError> {
    serde_json::from_value(value.clone()).map_err(|error| {
        EngineError::new(
            "invalid_params",
            format!("{method} params are invalid: {error}"),
            false,
        )
    })
}

fn required_trimmed(method: &str, name: &str, value: String) -> Result<String, EngineError> {
    let value = value.trim();
    if value.is_empty() {
        Err(invalid_param(method, &format!("`{name}` is required")))
    } else {
        Ok(value.to_string())
    }
}

fn required_safe_id(method: &str, name: &str, value: String) -> Result<String, EngineError> {
    let value = required_trimmed(method, name, value)?;
    if hq_desktop_core::meetings::is_url_safe_id(&value) {
        Ok(value)
    } else {
        Err(invalid_param(
            method,
            &format!("`{name}` contains invalid characters"),
        ))
    }
}

fn required_meeting_url(method: &str, value: String) -> Result<String, EngineError> {
    let value = required_trimmed(method, "meetingUrl", value)?;
    if value.len() > 4_096 || !(value.starts_with("https://") || value.starts_with("http://")) {
        Err(invalid_param(
            method,
            "`meetingUrl` must be an HTTP or HTTPS URL no longer than 4096 bytes",
        ))
    } else {
        Ok(value)
    }
}

fn trimmed_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn invalid_param(method: &str, detail: &str) -> EngineError {
    EngineError::new("invalid_params", format!("{method}: {detail}"), false)
}

fn method_not_found(method: &str) -> EngineError {
    EngineError::new(
        "method_not_found",
        format!("Meetings/recording method `{method}` is not implemented"),
        false,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MeetingNotifyPolicy {
    notifications: bool,
    enabled: bool,
    platforms: Option<Vec<String>>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeetingNotifySettings {
    #[serde(default)]
    notifications: Option<bool>,
    #[serde(default)]
    meeting_detect_notify: Option<hq_desktop_core::config::MeetingDetectNotifyPrefs>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct MeetingNotifyDecision {
    allowed: bool,
    reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    notification: Option<MeetingNotificationDescriptor>,
}

impl MeetingNotifyDecision {
    fn suppressed(reason: &'static str) -> Self {
        Self {
            allowed: false,
            reason,
            notification: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct MeetingNotificationDescriptor {
    title: String,
    body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    window_id: Option<String>,
    platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    meeting_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_event_id: Option<String>,
}

fn read_meeting_notify_policy(backend: &CoreBackend) -> Result<MeetingNotifyPolicy, EngineError> {
    let path = backend.menubar_path()?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(EngineError::new(
                "settings_read_failed",
                format!("Could not read {}: {error}", path.display()),
                true,
            ));
        }
    };
    let settings = if raw.is_empty() {
        MeetingNotifySettings::default()
    } else {
        serde_json::from_str::<MeetingNotifySettings>(&raw).map_err(|error| {
            EngineError::new(
                "settings_invalid",
                format!("Could not parse {}: {error}", path.display()),
                false,
            )
        })?
    };
    let meeting = settings.meeting_detect_notify.as_ref();
    Ok(MeetingNotifyPolicy {
        notifications: settings.notifications.unwrap_or(true),
        enabled: meeting.and_then(|prefs| prefs.enabled).unwrap_or(true),
        platforms: meeting.and_then(|prefs| prefs.platforms.clone()),
    })
}

fn decide_meeting_notification<F>(
    policy: &MeetingNotifyPolicy,
    payload: hq_desktop_core::meetings::NotifyDetectedPayload,
    now: chrono::DateTime<chrono::Utc>,
    claim: F,
) -> MeetingNotifyDecision
where
    F: FnOnce(&str, chrono::DateTime<chrono::Utc>) -> bool,
{
    if !policy.notifications {
        return MeetingNotifyDecision::suppressed("notifications-disabled");
    }
    if !policy.enabled {
        return MeetingNotifyDecision::suppressed("meeting-notify-disabled");
    }

    let platform = payload
        .platform
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !platform.is_empty()
        && policy.platforms.as_ref().is_some_and(|allowed| {
            !allowed.is_empty()
                && !allowed
                    .iter()
                    .any(|candidate| candidate.to_ascii_lowercase() == platform)
        })
    {
        return MeetingNotifyDecision::suppressed("platform-filtered");
    }

    let Some(key) = hq_desktop_core::meeting_ledger::stable_key(
        payload.meeting_url.as_deref(),
        payload.source_event_id.as_deref(),
    ) else {
        return MeetingNotifyDecision::suppressed("missing-stable-key");
    };
    if !claim(&key, now) {
        return MeetingNotifyDecision::suppressed("already-claimed");
    }

    let title = hq_desktop_core::meetings::build_notification_title(&platform);
    let body = hq_desktop_core::meetings::build_notification_body(
        &platform,
        payload.summary.as_deref(),
        payload.meeting_url.as_deref(),
    );
    MeetingNotifyDecision {
        allowed: true,
        reason: "allowed",
        notification: Some(MeetingNotificationDescriptor {
            title,
            body,
            window_id: payload.window_id,
            platform,
            meeting_url: payload.meeting_url,
            source_event_id: payload.source_event_id,
        }),
    }
}

#[derive(Deserialize)]
struct NotifyDetectedParams {
    payload: hq_desktop_core::meetings::NotifyDetectedPayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarsParams {
    account_id: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledBotsParams {
    #[serde(default)]
    calendar_event_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetCompanyParams {
    meeting_id: String,
    company_id: String,
    #[serde(default)]
    apply_to_series: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InviteBotParams {
    meeting_url: String,
    #[serde(default)]
    calendar_event_id: Option<String>,
    #[serde(default)]
    calendar_series_id: Option<String>,
    #[serde(default)]
    company_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelBotParams {
    #[serde(alias = "bot_id")]
    bot_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckBotParams {
    meeting_url: String,
    #[serde(default)]
    event_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MembershipsResponse {
    #[serde(default)]
    memberships: Vec<MembershipWire>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MembershipWire {
    company_uid: String,
    #[serde(default)]
    company_name: Option<String>,
    #[serde(default)]
    role: Option<String>,
    status: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MockMeetingTransport {
        responses: Mutex<VecDeque<MeetingResponse>>,
        requests: Mutex<Vec<MeetingRequest>>,
    }

    impl MockMeetingTransport {
        fn returning(responses: impl IntoIterator<Item = MeetingResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().collect()),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> Vec<MeetingRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl MeetingTransport for MockMeetingTransport {
        fn send(
            &self,
            request: MeetingRequest,
            cancellation: &CancellationFlag,
        ) -> Result<MeetingResponse, EngineError> {
            cancellation.check()?;
            self.requests.lock().unwrap().push(request);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| EngineError::new("test_transport_empty", "no response", false))
        }
    }

    fn context() -> MeetingContext {
        MeetingContext {
            base_url: "https://vault.example.test".to_string(),
            access_token: "secret-bearer".to_string(),
        }
    }

    fn backend() -> CoreBackend {
        let temp = tempfile::tempdir().unwrap();
        CoreBackend::with_roots(
            temp.path().join("HQ"),
            temp.path().join("claude"),
            temp.path().join("codex"),
        )
        .with_identity_email(Some("person@example.com"))
    }

    fn run(
        method: &str,
        params: Value,
        transport: &MockMeetingTransport,
    ) -> Result<Value, EngineError> {
        execute_with_transport(
            &backend(),
            method,
            &params,
            &CancellationFlag::default(),
            &context(),
            transport,
        )
    }

    #[test]
    fn upcoming_events_use_authenticated_get_and_unwrap_the_wire_response() {
        let transport = MockMeetingTransport::returning([MeetingResponse {
            status: 200,
            body: json!({
                "events": [{
                    "id": "evt-1",
                    "summary": "Native review",
                    "start": {"dateTime": "2026-07-27T15:00:00Z"},
                    "end": {"dateTime": "2026-07-27T15:30:00Z"},
                    "status": "confirmed",
                    "meetingUrl": "https://meet.google.com/abc-defg-hij"
                }]
            }),
        }]);

        let result = run("meetings_list_upcoming", json!({}), &transport).unwrap();

        assert_eq!(result.as_array().unwrap().len(), 1);
        assert_eq!(result[0]["id"], "evt-1");
        assert_eq!(
            transport.requests(),
            vec![MeetingRequest {
                method: MeetingVerb::Get,
                url: "https://vault.example.test/v1/calendar/events".to_string(),
                bearer_token: "secret-bearer".to_string(),
                body: None,
            }]
        );
    }

    #[test]
    fn calendar_account_id_is_validated_before_network_dispatch() {
        let transport = MockMeetingTransport::default();

        let error = run(
            "meetings_list_calendars_for_account",
            json!({"accountId": "../other"}),
            &transport,
        )
        .unwrap_err();

        assert_eq!(error.code, "invalid_params");
        assert!(transport.requests().is_empty());
    }

    #[test]
    fn scheduled_bot_filter_percent_encodes_each_event_id() {
        let transport = MockMeetingTransport::returning([MeetingResponse {
            status: 200,
            body: json!({"bots": []}),
        }]);

        let result = run(
            "meetings_list_scheduled_bots",
            json!({"calendarEventIds": ["evt 1?x=2#frag", "evt-2"]}),
            &transport,
        )
        .unwrap();

        assert_eq!(result, json!([]));
        assert_eq!(
            transport.requests()[0].url,
            "https://vault.example.test/v1/bot/list?calendarEventIds=evt+1%3Fx%3D2%23frag,evt-2"
        );
    }

    #[test]
    fn invite_enriches_participants_best_effort_then_posts_the_bot() {
        let transport = MockMeetingTransport::returning([
            MeetingResponse {
                status: 200,
                body: json!({
                    "participants": [{
                        "entityId": "per-1",
                        "canonicalName": "Corey",
                        "email": "corey@example.com",
                        "confidence": 0.9,
                        "source": "ontology"
                    }]
                }),
            },
            MeetingResponse {
                status: 201,
                body: json!({
                    "botId": "bot-1",
                    "meetingUrl": "https://zoom.us/j/123",
                    "platform": "zoom",
                    "status": "scheduled"
                }),
            },
        ]);

        let result = run(
            "meetings_invite_bot",
            json!({
                "meetingUrl": "https://zoom.us/j/123",
                "calendarEventId": "evt-1",
                "calendarSeriesId": "series-1",
                "companyId": "cmp-1"
            }),
            &transport,
        )
        .unwrap();

        assert_eq!(result["botId"], "bot-1");
        let requests = transport.requests();
        assert_eq!(
            requests[0].url,
            "https://vault.example.test/v1/ontology/participants?meetingUrl=https%3A%2F%2Fzoom.us%2Fj%2F123&eventId=evt-1"
        );
        assert_eq!(
            requests[1].url,
            "https://vault.example.test/v1/bot/invite?companyId=cmp-1"
        );
        assert_eq!(
            requests[1].body.as_ref().unwrap()["participants"][0]["entityId"],
            "per-1"
        );
    }

    #[test]
    fn set_company_validates_path_id_and_uses_camel_case_body() {
        let transport = MockMeetingTransport::returning([MeetingResponse {
            status: 200,
            body: json!({
                "ok": true,
                "meetingId": "meeting-1",
                "companyId": "cmp-1",
                "appliedToSeries": false
            }),
        }]);

        let result = run(
            "meetings_set_company",
            json!({
                "meetingId": "meeting-1",
                "companyId": "cmp-1",
                "applyToSeries": false
            }),
            &transport,
        )
        .unwrap();

        assert_eq!(result["ok"], true);
        assert_eq!(
            transport.requests()[0],
            MeetingRequest {
                method: MeetingVerb::Post,
                url: "https://vault.example.test/v1/meetings/meeting-1/company".to_string(),
                bearer_token: "secret-bearer".to_string(),
                body: Some(json!({"companyId": "cmp-1", "applyToSeries": false})),
            }
        );
    }

    #[test]
    fn memberships_are_projected_without_credential_fields() {
        let transport = MockMeetingTransport::returning([MeetingResponse {
            status: 200,
            body: json!({
                "memberships": [{
                    "personUid": "per-1",
                    "companyUid": "cmp-1",
                    "companyName": "Indigo",
                    "role": "owner",
                    "status": "active",
                    "secretAccessKey": "must-not-cross"
                }]
            }),
        }]);

        let result = run("meetings_list_memberships", json!({}), &transport).unwrap();

        assert_eq!(
            result,
            json!([{
                "companyUid": "cmp-1",
                "companyName": "Indigo",
                "role": "owner",
                "status": "active"
            }])
        );
        assert!(!result.to_string().contains("must-not-cross"));
    }

    #[test]
    fn cancellation_prevents_meeting_network_dispatch() {
        let transport = MockMeetingTransport::default();
        let cancellation = CancellationFlag::default();
        cancellation.cancel();

        let error = execute_with_transport(
            &backend(),
            "meetings_list_accounts",
            &json!({}),
            &cancellation,
            &context(),
            &transport,
        )
        .unwrap_err();

        assert_eq!(error.code, "request_cancelled");
        assert!(transport.requests().is_empty());
    }

    #[test]
    fn meeting_notification_dispatch_reads_fresh_settings_and_preserves_wire_shape() {
        let temp = tempfile::tempdir().unwrap();
        let hq = temp.path();
        let settings_path = hq.join(".hq/menubar.json");
        std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
        std::fs::write(
            &settings_path,
            r#"{"notifications":false,"meetingDetectNotify":{"enabled":true}}"#,
        )
        .unwrap();
        let backend = CoreBackend::with_roots(hq, hq.join("claude"), hq.join("codex"));

        let decision = execute(
            &backend,
            "meetings_notify_detected",
            &json!({
                "payload": {
                    "meetingUrl": "https://zoom.us/j/native",
                    "windowId": "window-native",
                    "platform": "zoom",
                    "summary": "Native review",
                    "sourceEventId": "event-native"
                }
            }),
            &CancellationFlag::default(),
        )
        .unwrap();

        assert_eq!(
            decision,
            json!({
                "allowed": false,
                "reason": "notifications-disabled"
            })
        );

        std::fs::write(
            &settings_path,
            r#"{"notifications":true,"meetingDetectNotify":{"enabled":false}}"#,
        )
        .unwrap();
        let decision = execute(
            &backend,
            "meetings_notify_detected",
            &json!({"payload":{"meetingUrl":"https://zoom.us/j/native"}}),
            &CancellationFlag::default(),
        )
        .unwrap();
        assert_eq!(decision["reason"], "meeting-notify-disabled");
    }

    #[test]
    fn meeting_notification_policy_gates_before_claiming_the_durable_ledger() {
        let payload = hq_desktop_core::meetings::NotifyDetectedPayload {
            meeting_url: Some("https://zoom.us/j/123".to_string()),
            window_id: Some("window-1".to_string()),
            platform: Some("zoom".to_string()),
            summary: Some("Weekly review".to_string()),
            source_event_id: Some("event-1".to_string()),
        };
        for (policy, reason) in [
            (
                MeetingNotifyPolicy {
                    notifications: false,
                    enabled: true,
                    platforms: None,
                },
                "notifications-disabled",
            ),
            (
                MeetingNotifyPolicy {
                    notifications: true,
                    enabled: false,
                    platforms: None,
                },
                "meeting-notify-disabled",
            ),
            (
                MeetingNotifyPolicy {
                    notifications: true,
                    enabled: true,
                    platforms: Some(vec!["meet".to_string()]),
                },
                "platform-filtered",
            ),
        ] {
            let claim_calls = std::sync::atomic::AtomicUsize::new(0);
            let decision = decide_meeting_notification(
                &policy,
                payload.clone(),
                chrono::Utc::now(),
                |_, _| {
                    claim_calls.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                    true
                },
            );

            assert!(!decision.allowed);
            assert_eq!(decision.reason, reason);
            assert!(decision.notification.is_none());
            assert_eq!(claim_calls.load(std::sync::atomic::Ordering::Acquire), 0);
        }
    }

    #[test]
    fn meeting_notification_claim_returns_an_exact_native_delivery_descriptor() {
        let payload = hq_desktop_core::meetings::NotifyDetectedPayload {
            meeting_url: Some("https://meet.google.com/native".to_string()),
            window_id: Some("window-native-42".to_string()),
            platform: Some("MeEt".to_string()),
            summary: Some("Native review".to_string()),
            source_event_id: Some("event-native-42".to_string()),
        };
        let policy = MeetingNotifyPolicy {
            notifications: true,
            enabled: true,
            platforms: Some(vec!["zoom".to_string(), "MEET".to_string()]),
        };
        let claimed_key = Mutex::new(None);
        let decision =
            decide_meeting_notification(&policy, payload.clone(), chrono::Utc::now(), |key, _| {
                *claimed_key.lock().unwrap() = Some(key.to_string());
                true
            });

        assert_eq!(
            claimed_key.lock().unwrap().as_deref(),
            Some("https://meet.google.com/native")
        );
        assert_eq!(
            to_value(decision).unwrap(),
            json!({
                "allowed":true,
                "reason":"allowed",
                "notification":{
                    "title":"Meet meeting detected",
                    "body":"Meet: Native review",
                    "windowId":"window-native-42",
                    "platform":"meet",
                    "meetingUrl":"https://meet.google.com/native",
                    "sourceEventId":"event-native-42"
                }
            })
        );

        let suppressed =
            decide_meeting_notification(&policy, payload, chrono::Utc::now(), |_, _| false);
        assert!(!suppressed.allowed);
        assert_eq!(suppressed.reason, "already-claimed");
        assert!(suppressed.notification.is_none());
    }
}
