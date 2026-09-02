//! Authenticated HQ cloud and collaboration command owner.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::local::CoreBackend;
use crate::{CancellationFlag, EngineError};

mod marketplace;
mod realtime;

pub(crate) const IMPLEMENTED_METHODS: &[&str] = &[
    "list_contacts",
    "list_company_members",
    "list_syncable_workspaces",
    "get_unread_summary",
    "list_channels",
    "fetch_channel",
    "create_channel",
    "create_group_dm",
    "join_channel",
    "invite_to_channel",
    "send_channel_message",
    "list_channel_members",
    "remove_channel_member",
    "mark_channel_read",
    "send_dm",
    "send_dm_to_email",
    "fetch_dm_thread",
    "list_dm_requests",
    "respond_dm_request",
    "fetch_thread",
    "send_thread_reply",
    "toggle_reaction",
    "fetch_reactions",
    "get_company_summary",
    "get_company_board",
    "get_company_crm_projection_vault",
    "get_company_project_creators",
    "get_company_activity",
    "get_company_team_telemetry",
    "get_company_deployments",
    "get_company_secrets",
    "get_sync_mode",
    "set_sync_mode",
    "list_marketplace_listings",
    "get_marketplace_listing",
    "list_moderation_queue",
    "decide_moderation_listing",
    "yank_marketplace_listing",
    "request_creator_access",
    "list_creator_applications",
    "decide_creator_application",
    "claim_creator_handle",
    "claim_pending_company_invite",
    "update_creator_profile",
    "get_creator_profile",
    "get_my_creator",
    "record_marketplace_install",
    "publish_marketplace_pack",
    "upload_creator_avatar",
    "fetch_notification_history",
    "refresh_tokens",
    "emit_desktop_telemetry_if_opted_in",
    "post_telemetry_opt_in",
    "poll_dm_inbox",
    "poll_shared_with_me",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HttpVerb {
    Get,
    Post,
    Put,
    Delete,
}

#[derive(Clone, PartialEq)]
struct CloudRequest {
    method: HttpVerb,
    url: String,
    bearer_token: Option<String>,
    headers: Vec<(String, String)>,
    body: Option<Value>,
}

impl fmt::Debug for CloudRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CloudRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field(
                "bearer_token",
                &self.bearer_token.as_ref().map(|_| "<redacted>"),
            )
            .field("headers", &self.headers)
            .field("body", &self.body.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq)]
struct CloudResponse {
    status: u16,
    body: Value,
}

trait CloudTransport {
    fn send(
        &self,
        request: CloudRequest,
        cancellation: &CancellationFlag,
    ) -> Result<CloudResponse, EngineError>;
}

trait TokenRefresher {
    fn refresh(&self) -> Result<Value, EngineError>;
}

struct CognitoTokenRefresher;

impl TokenRefresher for CognitoTokenRefresher {
    fn refresh(&self) -> Result<Value, EngineError> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                EngineError::new(
                    "token_refresh_failed",
                    format!("Could not initialize authentication refresh: {error}"),
                    true,
                )
            })?;
        runtime.block_on(async {
            let tokens = hq_desktop_core::cognito::get_tokens()
                .await
                .map_err(|message| EngineError::new("token_refresh_failed", message, false))?
                .ok_or_else(|| {
                    EngineError::new(
                        "auth_not_signed_in",
                        "No tokens found; sign in to HQ first",
                        false,
                    )
                })?;
            let refreshed = hq_desktop_core::cognito::refresh_access_token(&tokens.refresh_token)
                .await
                .map_err(|message| {
                    EngineError::new(
                        "token_refresh_failed",
                        format!("HQ authentication could not be refreshed: {message}"),
                        false,
                    )
                })?;
            let expires_at = hq_desktop_core::cognito::expires_at_iso(&refreshed);
            hq_desktop_core::cognito::set_tokens(&refreshed)
                .await
                .map_err(|message| {
                    EngineError::new(
                        "token_refresh_failed",
                        format!("Refreshed HQ credentials could not be saved: {message}"),
                        false,
                    )
                })?;
            crate::to_value(hq_desktop_core::cognito::AuthState {
                authenticated: true,
                expires_at: Some(expires_at),
            })
        })
    }
}

struct ReqwestCloudTransport {
    client: reqwest::blocking::Client,
}

impl ReqwestCloudTransport {
    fn new() -> Result<Self, EngineError> {
        reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(format!("HQ-Native/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map(|client| Self { client })
            .map_err(|error| {
                EngineError::new(
                    "cloud_client_unavailable",
                    format!("Could not initialize the secure cloud client: {error}"),
                    true,
                )
            })
    }
}

impl CloudTransport for ReqwestCloudTransport {
    fn send(
        &self,
        request: CloudRequest,
        cancellation: &CancellationFlag,
    ) -> Result<CloudResponse, EngineError> {
        cancellation.check()?;
        let builder = match request.method {
            HttpVerb::Get => self.client.get(&request.url),
            HttpVerb::Post => self.client.post(&request.url),
            HttpVerb::Put => self.client.put(&request.url),
            HttpVerb::Delete => self.client.delete(&request.url),
        };
        let builder = if let Some(token) = request.bearer_token.as_deref() {
            builder.bearer_auth(token)
        } else {
            builder
        };
        let builder = request
            .headers
            .iter()
            .fold(builder, |builder, (name, value)| {
                builder.header(name, value)
            });
        let builder = if let Some(body) = request.body.as_ref() {
            builder.json(body)
        } else {
            builder
        };
        let response = builder.send().map_err(|error| {
            EngineError::new(
                "cloud_network_error",
                format!("HQ cloud could not be reached: {error}"),
                true,
            )
        })?;
        cancellation.check()?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|error| {
            EngineError::new(
                "cloud_response_error",
                format!("HQ cloud returned an unreadable response: {error}"),
                true,
            )
        })?;
        let body = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or_else(|_| json!({ "error": text }))
        };
        Ok(CloudResponse { status, body })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CloudContext {
    base_url: String,
    access_token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntity {
    uid: String,
    slug: String,
    name: Option<String>,
    bucket_name: Option<String>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    deleted: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMembership {
    company_uid: String,
    status: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    invited_by: Option<String>,
    #[serde(default)]
    invited_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingWorkspaceInvite {
    company_uid: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    invited_by: Option<String>,
    #[serde(default)]
    invited_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct WorkspaceCloudSnapshot {
    person: Option<WorkspaceEntity>,
    memberships: Vec<WorkspaceMembership>,
    entities: BTreeMap<String, WorkspaceEntity>,
}

impl CloudContext {
    fn public_from_local_state() -> Result<Self, EngineError> {
        let base_url = hq_desktop_core::marketplace::api_base()
            .map_err(|message| EngineError::new("cloud_config_unavailable", message, false))?;
        Ok(Self {
            base_url,
            access_token: String::new(),
        })
    }

    fn from_local_state() -> Result<Self, EngineError> {
        let config = hq_desktop_core::config::read_hq_config_lenient()
            .map_err(|message| EngineError::new("cloud_config_unavailable", message, false))?
            .ok_or_else(|| {
                EngineError::new(
                    "cloud_config_unavailable",
                    "HQ is not configured for cloud access",
                    false,
                )
            })?;
        let base_url = config.vault_api_url.trim().trim_end_matches('/');
        if base_url.is_empty() {
            return Err(EngineError::new(
                "cloud_config_unavailable",
                "HQ cloud URL is missing from the local configuration",
                false,
            ));
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                EngineError::new(
                    "cloud_auth_unavailable",
                    format!("Could not initialize authentication: {error}"),
                    true,
                )
            })?;
        let access_token = runtime
            .block_on(hq_desktop_core::cognito::get_valid_access_token())
            .map_err(|message| {
                EngineError::new(
                    "cloud_auth_unavailable",
                    format!("HQ cloud authentication is unavailable: {message}"),
                    false,
                )
            })?;
        Ok(Self {
            base_url: base_url.to_string(),
            access_token,
        })
    }
}

fn execute_with_publish_progress<F>(
    backend: &CoreBackend,
    method: &str,
    operation: F,
) -> Result<Value, EngineError>
where
    F: FnOnce() -> Result<Value, EngineError>,
{
    if method != "publish_marketplace_pack" {
        return operation();
    }

    backend.emit_domain_event(
        None,
        "marketplace:publish-progress",
        json!({"stream":"stdout","line":"Preparing marketplace submission"}),
    );
    let result = operation();
    match &result {
        Ok(_) => {
            backend.emit_domain_event(
                None,
                "marketplace:publish-progress",
                json!({
                    "stream":"stdout",
                    "line":"Marketplace submission accepted for review"
                }),
            );
        }
        Err(error) => {
            let line = if error.message.trim().is_empty() {
                "Marketplace submission failed"
            } else {
                error.message.trim()
            };
            backend.emit_domain_event(
                None,
                "marketplace:publish-progress",
                json!({"stream":"stderr","line":line}),
            );
        }
    }
    result
}

pub(crate) fn execute(
    backend: &CoreBackend,
    method: &str,
    params: &Value,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    cancellation.check()?;
    if realtime::handles(method) {
        params_object(method, params)?;
        // Legacy poll commands are best-effort background wakes: missing auth,
        // an incomplete local cloud configuration, or client construction must
        // not turn into a user-facing error loop.
        let context = match CloudContext::from_local_state() {
            Ok(context) => context,
            Err(_) => return Ok(Value::Null),
        };
        let transport = match ReqwestCloudTransport::new() {
            Ok(transport) => transport,
            Err(_) => return Ok(Value::Null),
        };
        return realtime::execute(backend, method, params, cancellation, &context, &transport);
    }
    if method == "get_unread_summary" {
        params_object(method, params)?;
        let unread_dms = backend.session_orchestration_state().unread_dms();
        let context = match CloudContext::from_local_state() {
            Ok(context) => context,
            Err(_) => {
                return Ok(json!({
                    "unreadDms": unread_dms,
                    "pendingRequests": 0,
                }));
            }
        };
        let transport = match ReqwestCloudTransport::new() {
            Ok(transport) => transport,
            Err(_) => {
                return Ok(json!({
                    "unreadDms": unread_dms,
                    "pendingRequests": 0,
                }));
            }
        };
        return unread_summary_with_transport(unread_dms, cancellation, &context, &transport);
    }
    if method == "refresh_tokens" {
        return execute_refresh_with(cancellation, &CognitoTokenRefresher);
    }
    if method == "list_syncable_workspaces" {
        params_object(method, params)?;
        let hq_root = backend.hq_root()?;
        let cloud = CloudContext::from_local_state().and_then(|context| {
            let transport = ReqwestCloudTransport::new()?;
            fetch_workspace_cloud_snapshot(cancellation, &context, &transport)
        });
        return assemble_syncable_workspaces(&hq_root, cloud);
    }
    if method == "emit_desktop_telemetry_if_opted_in" {
        let context = CloudContext::from_local_state()?;
        let transport = ReqwestCloudTransport::new()?;
        let local_enabled = backend
            .menubar_path()
            .ok()
            .map(|path| hq_desktop_core::first_run::read_menubar_obj(&path))
            .and_then(|prefs| prefs.get("telemetryEnabled").and_then(Value::as_bool))
            .unwrap_or(true);
        return emit_desktop_telemetry_with_transport(
            params,
            local_enabled,
            cancellation,
            &context,
            &transport,
        );
    }
    let context = if matches!(
        method,
        "list_marketplace_listings" | "get_marketplace_listing" | "get_creator_profile"
    ) {
        CloudContext::public_from_local_state()?
    } else {
        CloudContext::from_local_state()?
    };
    let transport = ReqwestCloudTransport::new()?;
    let output = execute_with_publish_progress(backend, method, || {
        execute_with_transport(method, params, cancellation, &context, &transport)
    })?;
    if method == "respond_dm_request" {
        let params = params_object(method, params)?;
        let pair_key = required_trimmed(params, "pairKey")?;
        let action = required_trimmed(params, "action")?;
        let state = hq_desktop_core::dm_notify::respond_action_state(action);
        backend.emit_domain_event(
            None,
            "dm:request-update",
            json!({"pairKey": pair_key, "state": state}),
        );
    }
    Ok(output)
}

fn execute_refresh_with(
    cancellation: &CancellationFlag,
    refresher: &dyn TokenRefresher,
) -> Result<Value, EngineError> {
    cancellation.check()?;
    let result = refresher.refresh()?;
    cancellation.check()?;
    Ok(result)
}

fn is_safe_desktop_telemetry_name(event_name: &str) -> bool {
    !event_name.is_empty()
        && event_name.len() <= 96
        && event_name
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

fn is_safe_desktop_telemetry_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(
            |byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-' | b'.'),
        )
}

fn sanitize_desktop_telemetry_properties(properties: Option<&Value>) -> Value {
    let Some(Value::Object(input)) = properties else {
        return Value::Object(Map::new());
    };
    let mut output = Map::new();
    for (key, value) in input {
        let allowed_key = matches!(
            key.as_str(),
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
        );
        if !allowed_key {
            continue;
        }
        let safe_value = match value {
            Value::Bool(_) => key == "enabled",
            Value::Number(number) => number.as_i64().is_some() || number.as_u64().is_some(),
            Value::String(label) => is_safe_desktop_telemetry_label(label),
            _ => false,
        };
        if safe_value {
            output.insert(key.clone(), value.clone());
        }
    }
    Value::Object(output)
}

fn emit_desktop_telemetry_with_transport(
    params: &Value,
    local_enabled: bool,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
) -> Result<Value, EngineError> {
    cancellation.check()?;
    let params = params_object("emit_desktop_telemetry_if_opted_in", params)?;
    let event_name = params
        .get("eventName")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("`eventName` must be a string"))?;
    if !is_safe_desktop_telemetry_name(event_name) {
        return Err(invalid_params(format!(
            "invalid telemetry event name: {event_name}"
        )));
    }
    let base = context.base_url.trim_end_matches('/');
    let enabled = match transport.send(
        request(
            HttpVerb::Get,
            format!("{base}/v1/usage/opt-in"),
            context,
            None,
        ),
        cancellation,
    ) {
        Ok(response) => ensure_success(response)
            .ok()
            .and_then(|body| body.get("enabled").and_then(Value::as_bool))
            .unwrap_or(local_enabled),
        Err(error) if error.code == "request_cancelled" => return Err(error),
        Err(_) => local_enabled,
    };
    cancellation.check()?;
    if !enabled {
        return Ok(Value::Null);
    }

    let event = json!({
        "eventName": event_name,
        "app": "hq-desktop-app",
        "source": "desktop",
        "occurredAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "consentBasis": "desktop-opt-in",
        "schemaVersion": 1,
        "properties": sanitize_desktop_telemetry_properties(params.get("properties")),
    });
    ensure_success(transport.send(
        request(
            HttpVerb::Post,
            format!("{base}/v1/telemetry/events"),
            context,
            Some(json!({"events":[event]})),
        ),
        cancellation,
    )?)?;
    cancellation.check()?;
    Ok(Value::Null)
}

fn decode_cloud_array<T: DeserializeOwned>(body: &Value, key: &str) -> Result<Vec<T>, EngineError> {
    serde_json::from_value(body.get(key).cloned().unwrap_or_else(|| json!([]))).map_err(|error| {
        EngineError::new(
            "cloud_response_invalid",
            format!("HQ cloud `{key}` payload is invalid: {error}"),
            false,
        )
    })
}

fn fetch_workspace_cloud_snapshot(
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
) -> Result<WorkspaceCloudSnapshot, EngineError> {
    cancellation.check()?;
    let base = context.base_url.trim_end_matches('/');
    let people = ensure_success(transport.send(
        request(
            HttpVerb::Get,
            format!("{base}/entity/by-type/person"),
            context,
            None,
        ),
        cancellation,
    )?)?;
    let mut people = decode_cloud_array::<WorkspaceEntity>(&people, "entities")?;
    people.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.uid.cmp(&right.uid))
    });
    let person = people.into_iter().next();
    let mut memberships = if let Some(person) = person.as_ref() {
        let body = ensure_success(transport.send(
            request(
                HttpVerb::Get,
                format!(
                    "{base}/membership/person/{}",
                    hq_desktop_core::messages::esc_seg(&person.uid)
                ),
                context,
                None,
            ),
            cancellation,
        )?)?;
        decode_cloud_array::<WorkspaceMembership>(&body, "memberships")?
    } else {
        Vec::new()
    };

    match transport.send(
        request(
            HttpVerb::Get,
            format!("{base}/membership/pending-by-email"),
            context,
            None,
        ),
        cancellation,
    ) {
        Ok(response) => {
            if let Ok(body) = ensure_success(response) {
                if let Ok(invites) = decode_cloud_array::<PendingWorkspaceInvite>(&body, "invites")
                {
                    for invite in invites {
                        if memberships
                            .iter()
                            .any(|membership| membership.company_uid == invite.company_uid)
                        {
                            continue;
                        }
                        memberships.push(WorkspaceMembership {
                            company_uid: invite.company_uid,
                            status: "pending".to_string(),
                            role: invite.role,
                            invited_by: invite.invited_by,
                            invited_at: invite.invited_at,
                        });
                    }
                }
            }
        }
        Err(error) if error.code == "request_cancelled" => return Err(error),
        Err(_) => {}
    }

    let mut entities = BTreeMap::new();
    let mut company_uids = memberships
        .iter()
        .map(|membership| membership.company_uid.clone())
        .collect::<Vec<_>>();
    company_uids.sort();
    company_uids.dedup();
    for company_uid in company_uids {
        cancellation.check()?;
        let response = transport.send(
            request(
                HttpVerb::Get,
                format!(
                    "{base}/entity/{}",
                    hq_desktop_core::messages::esc_seg(&company_uid)
                ),
                context,
                None,
            ),
            cancellation,
        )?;
        if response.status == 404 {
            continue;
        }
        let body = ensure_success(response)?;
        let entity = serde_json::from_value::<WorkspaceEntity>(
            body.get("entity").cloned().unwrap_or(Value::Null),
        )
        .map_err(|error| {
            EngineError::new(
                "cloud_response_invalid",
                format!("HQ cloud company entity is invalid: {error}"),
                false,
            )
        })?;
        if !entity.deleted {
            entities.insert(company_uid, entity);
        }
    }
    memberships.retain(|membership| entities.contains_key(&membership.company_uid));
    Ok(WorkspaceCloudSnapshot {
        person,
        memberships,
        entities,
    })
}

fn assemble_syncable_workspaces(
    hq_root: &Path,
    cloud: Result<WorkspaceCloudSnapshot, EngineError>,
) -> Result<Value, EngineError> {
    use hq_desktop_core::workspaces::{
        discover_local_companies, humanize_slug, last_synced_at, Workspace, WorkspaceKind,
        WorkspaceState, WorkspacesResult,
    };

    let (local_companies, manifest_error) = discover_local_companies(hq_root);
    let (cloud_reachable, error, snapshot) = match cloud {
        Ok(snapshot) => (true, None, snapshot),
        Err(error) => (
            false,
            Some(error.message),
            WorkspaceCloudSnapshot::default(),
        ),
    };
    let entities_by_slug = snapshot
        .entities
        .values()
        .map(|entity| (entity.slug.as_str(), entity))
        .collect::<BTreeMap<_, _>>();
    let mut companies = BTreeMap::new();
    for local in &local_companies {
        if !local.dir_exists {
            continue;
        }
        let entity = entities_by_slug.get(local.slug.as_str()).copied();
        let membership = entity.and_then(|entity| {
            snapshot
                .memberships
                .iter()
                .find(|membership| membership.company_uid == entity.uid)
        });
        let (state, cloud_uid, bucket_name, broken_reason) =
            match (&local.cloud_uid, entity, cloud_reachable) {
                (Some(expected), Some(entity), true) if expected == &entity.uid => (
                    WorkspaceState::Synced,
                    Some(entity.uid.clone()),
                    entity
                        .bucket_name
                        .clone()
                        .or_else(|| local.bucket_name.clone()),
                    None,
                ),
                (Some(expected), Some(entity), true) => (
                    WorkspaceState::Broken,
                    Some(expected.clone()),
                    local.bucket_name.clone(),
                    Some(format!(
                    "manifest cloud_uid {expected} does not match cloud entity {} for this slug",
                    entity.uid
                )),
                ),
                (Some(expected), None, true) => (
                    WorkspaceState::Broken,
                    Some(expected.clone()),
                    local.bucket_name.clone(),
                    Some(format!(
                        "manifest cloud_uid {expected} not found in your cloud memberships"
                    )),
                ),
                (Some(expected), _, false) => (
                    WorkspaceState::Synced,
                    Some(expected.clone()),
                    local.bucket_name.clone(),
                    None,
                ),
                (None, Some(entity), true) => (
                    WorkspaceState::Synced,
                    Some(entity.uid.clone()),
                    entity.bucket_name.clone(),
                    None,
                ),
                (None, _, _) => (WorkspaceState::LocalOnly, None, None, None),
            };
        companies.insert(
            local.slug.clone(),
            Workspace {
                slug: local.slug.clone(),
                display_name: local
                    .display_name
                    .clone()
                    .unwrap_or_else(|| humanize_slug(&local.slug)),
                kind: WorkspaceKind::Company,
                state,
                cloud_uid,
                bucket_name,
                has_local_folder: true,
                local_path: Some(local.path.to_string_lossy().into_owned()),
                membership_status: membership.map(|membership| membership.status.clone()),
                role: membership.and_then(|membership| membership.role.clone()),
                last_synced_at: last_synced_at(&local.slug),
                broken_reason,
                invited_by: membership.and_then(|membership| membership.invited_by.clone()),
                invited_at: membership.and_then(|membership| membership.invited_at.clone()),
            },
        );
    }
    for membership in &snapshot.memberships {
        let Some(entity) = snapshot.entities.get(&membership.company_uid) else {
            continue;
        };
        if entity.slug == "personal" || companies.contains_key(&entity.slug) {
            continue;
        }
        companies.insert(
            entity.slug.clone(),
            Workspace {
                slug: entity.slug.clone(),
                display_name: entity
                    .name
                    .clone()
                    .unwrap_or_else(|| humanize_slug(&entity.slug)),
                kind: WorkspaceKind::Company,
                state: WorkspaceState::CloudOnly,
                cloud_uid: Some(entity.uid.clone()),
                bucket_name: entity.bucket_name.clone(),
                has_local_folder: false,
                local_path: None,
                membership_status: Some(membership.status.clone()),
                role: membership.role.clone(),
                last_synced_at: last_synced_at(&entity.slug),
                broken_reason: None,
                invited_by: membership.invited_by.clone(),
                invited_at: membership.invited_at.clone(),
            },
        );
    }

    let local_personal = hq_root.is_dir();
    let mut workspaces = vec![Workspace {
        slug: "personal".to_string(),
        display_name: snapshot
            .person
            .as_ref()
            .and_then(|person| person.name.clone())
            .unwrap_or_else(|| "Personal".to_string()),
        kind: WorkspaceKind::Personal,
        state: WorkspaceState::Personal,
        cloud_uid: snapshot.person.as_ref().map(|person| person.uid.clone()),
        bucket_name: snapshot
            .person
            .as_ref()
            .and_then(|person| person.bucket_name.clone()),
        has_local_folder: local_personal,
        local_path: local_personal.then(|| hq_root.to_string_lossy().into_owned()),
        membership_status: None,
        role: None,
        last_synced_at: last_synced_at("__hq_personal_vault__"),
        broken_reason: None,
        invited_by: None,
        invited_at: None,
    }];
    workspaces.extend(companies.into_values());
    crate::to_value(WorkspacesResult {
        workspaces,
        cloud_reachable,
        error,
        hq_folder_path: hq_root.to_string_lossy().into_owned(),
        manifest_error,
    })
}

fn execute_with_transport(
    method: &str,
    params: &Value,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
) -> Result<Value, EngineError> {
    cancellation.check()?;
    let params = params_object(method, params)?;
    let base = context.base_url.trim_end_matches('/');
    let response = match method {
        "claim_pending_company_invite" => {
            let company_slug = optional_trimmed(params, "companySlug")?;
            let people = ensure_success(transport.send(
                request(
                    HttpVerb::Get,
                    format!("{base}/entity/by-type/person"),
                    context,
                    None,
                ),
                cancellation,
            )?)?;
            let mut people = decode_cloud_array::<WorkspaceEntity>(&people, "entities")?;
            people.sort_by(|left, right| {
                left.created_at
                    .cmp(&right.created_at)
                    .then_with(|| left.uid.cmp(&right.uid))
            });
            let person = people.into_iter().next().ok_or_else(|| {
                EngineError::new(
                    "person_entity_missing",
                    "No person entity for this account — sign out and back in, then try Accept again.",
                    false,
                )
            })?;
            let pending = ensure_success(transport.send(
                request(
                    HttpVerb::Get,
                    format!("{base}/membership/pending-by-email"),
                    context,
                    None,
                ),
                cancellation,
            )?)?;
            let pending = decode_cloud_array::<PendingWorkspaceInvite>(&pending, "invites")?;
            if pending.is_empty() {
                let slug_hint = company_slug
                    .map(|slug| format!(" for {slug}"))
                    .unwrap_or_default();
                json!({
                    "ok":true,
                    "claimedSlugs":[],
                    "message":format!(
                        "No email-keyed pending invite{slug_hint}. If you still see an invite, run Sync — or use the invite email link for a legacy token invite."
                    )
                })
            } else {
                let claimed = ensure_success(transport.send(
                    request(
                        HttpVerb::Post,
                        format!("{base}/membership/claim-by-email"),
                        context,
                        Some(json!({"personUid":person.uid})),
                    ),
                    cancellation,
                )?)?;
                let claimed = decode_cloud_array::<WorkspaceMembership>(&claimed, "claimed")?;
                let mut slugs = Vec::new();
                for membership in claimed {
                    cancellation.check()?;
                    let response = transport.send(
                        request(
                            HttpVerb::Get,
                            format!(
                                "{base}/entity/{}",
                                hq_desktop_core::messages::esc_seg(&membership.company_uid)
                            ),
                            context,
                            None,
                        ),
                        cancellation,
                    )?;
                    if response.status == 404 {
                        continue;
                    }
                    let body = ensure_success(response)?;
                    if let Ok(entity) = serde_json::from_value::<WorkspaceEntity>(
                        body.get("entity").cloned().unwrap_or(Value::Null),
                    ) {
                        if !entity.slug.is_empty() && !slugs.contains(&entity.slug) {
                            slugs.push(entity.slug);
                        }
                    }
                }
                let message = match slugs.as_slice() {
                    [] => "Invite claim completed. Run Sync to pull any newly joined companies."
                        .to_string(),
                    [slug] => format!("Joined {slug}. Run Sync to pull it onto this Mac."),
                    _ => format!(
                        "Joined {}. Run Sync to pull them onto this Mac.",
                        slugs.join(", ")
                    ),
                };
                json!({"ok":true,"claimedSlugs":slugs,"message":message})
            }
        }
        "list_contacts" => ensure_success(transport.send(
            request(
                HttpVerb::Get,
                format!("{base}/v1/notify/contacts"),
                context,
                None,
            ),
            cancellation,
        )?)?,
        "list_company_members" => {
            let company_uid = required_trimmed(params, "companyUid")?;
            ensure_success(transport.send(
                request(
                    HttpVerb::Get,
                    format!(
                        "{base}/v1/notify/contacts?companyUid={}",
                        encode_query_value(company_uid)
                    ),
                    context,
                    None,
                ),
                cancellation,
            )?)?
        }
        "list_channels" => ensure_success(transport.send(
            request(
                HttpVerb::Get,
                format!("{base}/v1/notify/channels"),
                context,
                None,
            ),
            cancellation,
        )?)?,
        "fetch_channel" => {
            let channel_id = required_trimmed(params, "channelId")?;
            let mut url = format!(
                "{base}/v1/notify/channels/{}/messages",
                hq_desktop_core::messages::esc_seg(channel_id)
            );
            let mut query = Vec::new();
            if let Some(limit) = optional_u32(params, "limit")? {
                query.push(format!("limit={limit}"));
            }
            if let Some(cursor) = optional_trimmed(params, "cursor")? {
                query.push(format!(
                    "cursor={}",
                    hq_desktop_core::messages::esc_seg(cursor)
                ));
            }
            if !query.is_empty() {
                url.push('?');
                url.push_str(&query.join("&"));
            }
            ensure_success(
                transport.send(request(HttpVerb::Get, url, context, None), cancellation)?,
            )?
        }
        "create_channel" => {
            let name = required_trimmed(params, "name")?;
            let scope = required_trimmed(params, "scope")?.to_ascii_lowercase();
            if scope != "personal" && scope != "company" {
                return Err(invalid_params("scope must be `personal` or `company`"));
            }
            let company_uid = optional_trimmed(params, "companyUid")?;
            if scope == "company" && company_uid.is_none() {
                return Err(invalid_params(
                    "companyUid is required for a company channel",
                ));
            }
            let invite = optional_string_array(params, "invite")?;
            let body =
                hq_desktop_core::messages::build_create_payload(name, &scope, company_uid, &invite);
            let response = ensure_success(transport.send(
                request(
                    HttpVerb::Post,
                    format!("{base}/v1/notify/channels"),
                    context,
                    Some(body),
                ),
                cancellation,
            )?)?;
            response.get("channel").cloned().ok_or_else(|| {
                EngineError::new(
                    "cloud_response_invalid",
                    "Create channel response is missing `channel`",
                    false,
                )
            })?
        }
        "create_group_dm" => {
            let participants = required_string_array(params, "participants")?;
            if participants.len() < 2 {
                return Err(invalid_params(
                    "participants must contain at least two other people",
                ));
            }
            let body = hq_desktop_core::messages::build_group_payload(&participants);
            let response = ensure_success(transport.send(
                request(
                    HttpVerb::Post,
                    format!("{base}/v1/notify/channels"),
                    context,
                    Some(body),
                ),
                cancellation,
            )?)?;
            response.get("channel").cloned().ok_or_else(|| {
                EngineError::new(
                    "cloud_response_invalid",
                    "Create group response is missing `channel`",
                    false,
                )
            })?
        }
        "join_channel" => {
            let channel_id = required_trimmed(params, "channelId")?;
            ensure_success(transport.send(
                request(
                    HttpVerb::Post,
                    format!(
                        "{base}/v1/notify/channels/{}/members",
                        hq_desktop_core::messages::esc_seg(channel_id)
                    ),
                    context,
                    Some(json!({})),
                ),
                cancellation,
            )?)?
        }
        "invite_to_channel" => {
            let channel_id = required_trimmed(params, "channelId")?;
            let person_uids = required_string_array(params, "personUids")?;
            if person_uids.is_empty() {
                return Err(invalid_params("at least one person is required"));
            }
            let url = format!(
                "{base}/v1/notify/channels/{}/members",
                hq_desktop_core::messages::esc_seg(channel_id)
            );
            let mut latest = None;
            for person_uid in person_uids {
                cancellation.check()?;
                latest = Some(ensure_success(transport.send(
                    request(
                        HttpVerb::Post,
                        url.clone(),
                        context,
                        Some(hq_desktop_core::messages::invite_member_payload(
                            &person_uid,
                        )),
                    ),
                    cancellation,
                )?)?);
            }
            latest.ok_or_else(|| invalid_params("at least one person is required"))?
        }
        "send_channel_message" => {
            let channel_id = required_trimmed(params, "channelId")?;
            let body = required_trimmed(params, "body")?;
            ensure_success(transport.send(
                request(
                    HttpVerb::Post,
                    format!(
                        "{base}/v1/notify/channels/{}/messages",
                        hq_desktop_core::messages::esc_seg(channel_id)
                    ),
                    context,
                    Some(json!({ "body": body })),
                ),
                cancellation,
            )?)?;
            Value::Null
        }
        "list_channel_members" => {
            let channel_id = required_trimmed(params, "channelId")?;
            let response = transport.send(
                request(
                    HttpVerb::Get,
                    format!(
                        "{base}/v1/notify/channels/{}/members",
                        hq_desktop_core::messages::esc_seg(channel_id)
                    ),
                    context,
                    None,
                ),
                cancellation,
            )?;
            if response.status == 404 {
                json!({ "members": [] })
            } else {
                ensure_success(response)?
            }
        }
        "remove_channel_member" => {
            let channel_id = required_trimmed(params, "channelId")?;
            let person_uid = required_trimmed(params, "personUid")?;
            let body = ensure_success(transport.send(
                request(
                    HttpVerb::Delete,
                    format!(
                        "{base}/v1/notify/channels/{}/members/{}",
                        hq_desktop_core::messages::esc_seg(channel_id),
                        hq_desktop_core::messages::esc_seg(person_uid)
                    ),
                    context,
                    None,
                ),
                cancellation,
            )?)?;
            if body.is_null() {
                json!({"members": []})
            } else {
                body
            }
        }
        "mark_channel_read" => {
            let channel_id = required_trimmed(params, "channelId")?;
            ensure_success(transport.send(
                request(
                    HttpVerb::Post,
                    format!(
                        "{base}/v1/notify/channels/{}/read",
                        hq_desktop_core::messages::esc_seg(channel_id)
                    ),
                    context,
                    Some(json!({})),
                ),
                cancellation,
            )?)?;
            Value::Null
        }
        "send_dm" => {
            let person_uid = required_trimmed(params, "toPersonUid")?;
            let body = required_trimmed(params, "body")?;
            ensure_success(transport.send(
                request(
                    HttpVerb::Post,
                    format!("{base}/v1/notify/dm"),
                    context,
                    Some(hq_desktop_core::dm_notify::build_send_payload(
                        person_uid, body,
                    )),
                ),
                cancellation,
            )?)?;
            Value::Null
        }
        "send_dm_to_email" => {
            let person_uid = optional_trimmed(params, "toPersonUid")?;
            let email = optional_trimmed(params, "toEmail")?;
            let body = required_trimmed(params, "body")?;
            if person_uid.is_none() && email.is_none() {
                return Err(invalid_params(
                    "either `toPersonUid` or `toEmail` is required",
                ));
            }
            let response = transport.send(
                request(
                    HttpVerb::Post,
                    format!("{base}/v1/notify/dm"),
                    context,
                    Some(hq_desktop_core::dm_notify::build_compose_payload(
                        person_uid, email, body,
                    )),
                ),
                cancellation,
            )?;
            let status = response.status;
            let body = ensure_success(response)?;
            crate::to_value(hq_desktop_core::dm_notify::classify_send_response(
                status, &body,
            ))?
        }
        "fetch_dm_thread" => {
            let person_uid = required_trimmed(params, "withPersonUid")?;
            let limit = optional_u32(params, "limit")?;
            let cursor = optional_trimmed(params, "cursor")?;
            let url = hq_desktop_core::dm_notify::build_thread_url(base, person_uid, limit, cursor);
            ensure_success(
                transport.send(request(HttpVerb::Get, url, context, None), cancellation)?,
            )?
        }
        "list_dm_requests" => ensure_success(transport.send(
            request(
                HttpVerb::Get,
                format!("{base}/v1/notify/connections/requests"),
                context,
                None,
            ),
            cancellation,
        )?)?,
        "respond_dm_request" => {
            let pair_key = required_trimmed(params, "pairKey")?;
            let action = required_trimmed(params, "action")?;
            let path = hq_desktop_core::dm_notify::respond_action_path(action)
                .ok_or_else(|| invalid_params(format!("unsupported action: {action}")))?;
            ensure_success(transport.send(
                request(
                    HttpVerb::Post,
                    format!("{base}/v1/notify/connections/{path}"),
                    context,
                    Some(json!({"pairKey": pair_key})),
                ),
                cancellation,
            )?)?;
            Value::Null
        }
        "fetch_thread" => {
            let root = required_trimmed(params, "rootEventId")?;
            let scope =
                hq_desktop_core::dm_notify::normalize_scope(required_trimmed(params, "scope")?);
            let channel_id = optional_trimmed(params, "channelId")?;
            let person_uid = optional_trimmed(params, "withPersonUid")?;
            if scope == "channel" && channel_id.is_none() {
                return Err(invalid_params(
                    "`channelId` is required for a channel thread",
                ));
            }
            if scope == "dm" && person_uid.is_none() {
                return Err(invalid_params(
                    "`withPersonUid` is required for a DM thread",
                ));
            }
            let url = hq_desktop_core::dm_notify::build_threads_url(
                base, root, &scope, channel_id, person_uid,
            );
            ensure_success(
                transport.send(request(HttpVerb::Get, url, context, None), cancellation)?,
            )?
        }
        "send_thread_reply" => {
            let root = required_trimmed(params, "rootEventId")?;
            let body = required_trimmed(params, "body")?;
            let scope =
                hq_desktop_core::dm_notify::normalize_scope(required_trimmed(params, "scope")?);
            let channel_id = optional_trimmed(params, "channelId")?;
            let person_uid = optional_trimmed(params, "toPersonUid")?;
            let url = if scope == "channel" {
                let channel_id = channel_id.ok_or_else(|| {
                    invalid_params("`channelId` is required for a channel thread reply")
                })?;
                format!(
                    "{base}/v1/notify/channels/{}/messages",
                    hq_desktop_core::dm_notify::esc_thread_seg(channel_id)
                )
            } else {
                if person_uid.is_none() {
                    return Err(invalid_params(
                        "`toPersonUid` is required for a DM thread reply",
                    ));
                }
                format!("{base}/v1/notify/dm")
            };
            let body = hq_desktop_core::dm_notify::build_thread_reply_payload(
                &scope, root, person_uid, body,
            );
            ensure_success(transport.send(
                request(HttpVerb::Post, url, context, Some(body)),
                cancellation,
            )?)?;
            Value::Null
        }
        "toggle_reaction" => {
            let message_scope = required_trimmed(params, "messageScope")?;
            let message_id = required_trimmed(params, "messageId")?;
            let emoji = required_trimmed(params, "emoji")?;
            let add = required_bool(params, "add")?;
            ensure_success(transport.send(
                request(
                    if add {
                        HttpVerb::Post
                    } else {
                        HttpVerb::Delete
                    },
                    format!("{base}/v1/notify/reactions"),
                    context,
                    Some(hq_desktop_core::messages::build_reaction_payload(
                        message_scope,
                        message_id,
                        emoji,
                    )),
                ),
                cancellation,
            )?)?;
            Value::Null
        }
        "fetch_reactions" => {
            let scope = required_trimmed(params, "messageScope")?;
            let message_id = required_trimmed(params, "messageId")?;
            let url = hq_desktop_core::messages::build_reactions_url(base, scope, message_id);
            ensure_success(
                transport.send(request(HttpVerb::Get, url, context, None), cancellation)?,
            )?
            .get("reactions")
            .cloned()
            .ok_or_else(|| {
                EngineError::new(
                    "cloud_response_invalid",
                    "Reactions response is missing `reactions`",
                    false,
                )
            })?
        }
        "get_company_summary" => {
            company_summary(company_slug(params)?, context, transport, cancellation)?
        }
        "get_company_board" => {
            let company_uid =
                resolve_company_uid(company_slug(params)?, context, transport, cancellation)?;
            company_board(&company_uid, context, transport, cancellation)?
        }
        "get_company_crm_projection_vault" => {
            let company_uid =
                resolve_company_uid(company_slug(params)?, context, transport, cancellation)?;
            company_crm_projection(&company_uid, context, transport, cancellation)?
        }
        "get_company_project_creators" => {
            let company_uid =
                resolve_company_uid(company_slug(params)?, context, transport, cancellation)?;
            company_project_creators(&company_uid, context, transport, cancellation)?
        }
        "get_company_activity" => {
            let company_uid =
                resolve_company_uid(company_slug(params)?, context, transport, cancellation)?;
            company_activity(&company_uid, context, transport, cancellation)?
        }
        "get_company_team_telemetry" => {
            let company_uid =
                resolve_company_uid(company_slug(params)?, context, transport, cancellation)?;
            let from = optional_trimmed(params, "from")?
                .map(str::to_string)
                .unwrap_or_else(|| {
                    (chrono::Utc::now() - chrono::Duration::days(30))
                        .format("%Y-%m-%d")
                        .to_string()
                });
            let to = optional_trimmed(params, "to")?
                .map(str::to_string)
                .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());
            let url = format!(
                "{base}/v1/telemetry/company?companyUid={}&from={}&to={}",
                encode_query_value(&company_uid),
                encode_query_value(&from),
                encode_query_value(&to),
            );
            ensure_success(
                transport.send(request(HttpVerb::Get, url, context, None), cancellation)?,
            )?
        }
        "get_company_deployments" => {
            company_deployments(company_slug(params)?, context, transport, cancellation)?
        }
        "get_company_secrets" => {
            let company_uid =
                resolve_company_uid(company_slug(params)?, context, transport, cancellation)?;
            company_secrets(&company_uid, context, transport, cancellation)?
        }
        "get_sync_mode" => {
            let membership_key = resolve_membership_key(
                required_trimmed(params, "companySlug")?,
                context,
                transport,
                cancellation,
            )?;
            let url = format!(
                "{base}/v1/memberships/{}/sync-config",
                encode_query_value(&membership_key)
            );
            ensure_success(
                transport.send(request(HttpVerb::Get, url, context, None), cancellation)?,
            )?
        }
        "set_sync_mode" => {
            let company_slug = required_trimmed(params, "companySlug")?;
            let mode = required_trimmed(params, "mode")?;
            if mode == "custom" {
                return Err(invalid_params(
                    "custom sync mode needs paths; use `hq sync mode custom --paths …`",
                ));
            }
            if mode != "all" && mode != "shared" {
                return Err(invalid_params("`mode` must be `all` or `shared`"));
            }
            let membership_key =
                resolve_membership_key(company_slug, context, transport, cancellation)?;
            let url = format!(
                "{base}/v1/memberships/{}/sync-config",
                encode_query_value(&membership_key)
            );
            ensure_success(transport.send(
                request(
                    HttpVerb::Put,
                    url,
                    context,
                    Some(json!({
                        "syncMode": mode,
                        "customPaths": null,
                    })),
                ),
                cancellation,
            )?)?
        }
        "list_marketplace_listings" => {
            let mut url = format!("{base}/v1/listings");
            if let Some(query) = optional_trimmed(params, "query")? {
                url.push_str("?q=");
                url.push_str(&encode_query_value(query));
            }
            let response =
                transport.send(public_request(HttpVerb::Get, url, None), cancellation)?;
            let listings = hq_desktop_core::marketplace::parse_browse_response(
                status_code(response.status)?,
                &response_text(&response.body),
            )
            .map_err(|message| surface_error("marketplace listings", response.status, message))?;
            crate::to_value(listings)?
        }
        "publish_marketplace_pack" => {
            marketplace::publish(params, cancellation, context, transport)?
        }
        "upload_creator_avatar" => {
            marketplace::upload_avatar(params, cancellation, context, transport)?
        }
        "get_marketplace_listing"
        | "list_moderation_queue"
        | "decide_moderation_listing"
        | "yank_marketplace_listing"
        | "request_creator_access"
        | "list_creator_applications"
        | "decide_creator_application"
        | "claim_creator_handle"
        | "update_creator_profile"
        | "get_creator_profile"
        | "get_my_creator"
        | "record_marketplace_install" => {
            marketplace::execute_cloud_command(method, params, cancellation, context, transport)?
        }
        "fetch_notification_history" => {
            let limit = optional_u32(params, "limit")?.unwrap_or(100).clamp(1, 200);
            let dms = history_source(
                transport.send(
                    request(
                        HttpVerb::Get,
                        format!("{base}/v1/notify/inbox?limit={limit}"),
                        context,
                        None,
                    ),
                    cancellation,
                ),
                "events",
            );
            let shares = history_source(
                transport.send(
                    request(
                        HttpVerb::Get,
                        format!("{base}/v1/files/shared-with-me?limit={limit}"),
                        context,
                        None,
                    ),
                    cancellation,
                ),
                "events",
            );
            let files = history_source(
                transport.send(
                    request(
                        HttpVerb::Get,
                        format!("{base}/v1/notify/file-history?limit={limit}"),
                        context,
                        None,
                    ),
                    cancellation,
                ),
                "files",
            )
            .unwrap_or_default();
            if dms.is_err() && shares.is_err() {
                let retryable = dms.as_ref().err().is_some_and(|error| error.retryable)
                    || shares.as_ref().err().is_some_and(|error| error.retryable);
                return Err(EngineError::new(
                    "notification_history_unavailable",
                    "Could not load direct-message or shared-file history",
                    retryable,
                ));
            }
            json!({
                "dms": dms.unwrap_or_default(),
                "shares": shares.unwrap_or_default(),
                "files": files,
            })
        }
        "post_telemetry_opt_in" => {
            let enabled = required_bool(params, "enabled")?;
            retry_telemetry_opt_in(
                enabled,
                cancellation,
                context,
                transport,
                &[Duration::from_secs(1), Duration::from_secs(3)],
                &std::thread::sleep,
            )?;
            Value::Null
        }
        _ => {
            return Err(EngineError::new(
                "method_not_found",
                format!("Cloud method `{method}` is not implemented"),
                false,
            ));
        }
    };
    cancellation.check()?;
    Ok(response)
}

fn request(
    method: HttpVerb,
    url: String,
    context: &CloudContext,
    body: Option<Value>,
) -> CloudRequest {
    CloudRequest {
        method,
        url,
        bearer_token: Some(context.access_token.clone()),
        headers: Vec::new(),
        body,
    }
}

fn public_request(method: HttpVerb, url: String, body: Option<Value>) -> CloudRequest {
    CloudRequest {
        method,
        url,
        bearer_token: None,
        headers: Vec::new(),
        body,
    }
}

fn request_with_headers(
    method: HttpVerb,
    url: String,
    context: &CloudContext,
    headers: Vec<(String, String)>,
    body: Option<Value>,
) -> CloudRequest {
    let mut request = request(method, url, context, body);
    request.headers = headers;
    request
}

fn company_slug(params: &serde_json::Map<String, Value>) -> Result<&str, EngineError> {
    let slug = required_trimmed(params, "slug")?;
    hq_desktop_core::desktop_alt::normalize_slug(slug).map_err(invalid_params)?;
    Ok(slug)
}

fn resolve_company_uid(
    slug: &str,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    cancellation: &CancellationFlag,
) -> Result<String, EngineError> {
    let url = format!(
        "{}/entity/by-slug/company/{}",
        context.base_url.trim_end_matches('/'),
        hq_desktop_core::messages::esc_seg(slug)
    );
    let body =
        ensure_success(transport.send(request(HttpVerb::Get, url, context, None), cancellation)?)?;
    let uid = body
        .get("entity")
        .and_then(|entity| entity.get("uid"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|uid| !uid.is_empty())
        .ok_or_else(|| {
            EngineError::new(
                "cloud_response_invalid",
                format!("No cloud company was found for `{slug}`"),
                false,
            )
        })?;
    if !hq_desktop_core::desktop_alt::is_url_safe_id(uid) {
        return Err(EngineError::new(
            "cloud_response_invalid",
            "HQ cloud returned an invalid company identifier",
            false,
        ));
    }
    Ok(uid.to_string())
}

fn resolve_membership_key(
    slug: &str,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    cancellation: &CancellationFlag,
) -> Result<String, EngineError> {
    let company_uid = resolve_company_uid(slug, context, transport, cancellation)?;
    let body = ensure_success(transport.send(
        request(
            HttpVerb::Get,
            format!("{}/membership/me", context.base_url.trim_end_matches('/')),
            context,
            None,
        ),
        cancellation,
    )?)?;
    let membership = body
        .get("memberships")
        .and_then(Value::as_array)
        .and_then(|memberships| {
            memberships.iter().find(|membership| {
                membership.get("companyUid").and_then(Value::as_str) == Some(company_uid.as_str())
            })
        })
        .ok_or_else(|| {
            EngineError::new(
                "cloud_membership_missing",
                format!("You do not have a cloud membership in `{slug}`"),
                false,
            )
        })?;
    if let Some(key) = membership
        .get("membershipKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        return Ok(key.to_string());
    }
    let person_uid = membership
        .get("personUid")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|uid| !uid.is_empty())
        .ok_or_else(|| {
            EngineError::new(
                "cloud_response_invalid",
                "HQ cloud membership is missing its person identifier",
                false,
            )
        })?;
    Ok(format!("{person_uid}#{company_uid}"))
}

fn company_board(
    company_uid: &str,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    let url = hq_desktop_core::desktop_alt::board_url(&context.base_url, company_uid)
        .map_err(invalid_params)?;
    let response = transport.send(request(HttpVerb::Get, url, context, None), cancellation)?;
    let status = status_code(response.status)?;
    let board =
        hq_desktop_core::desktop_alt::parse_board_response(status, &response_text(&response.body))
            .map_err(|message| surface_error("board", response.status, message))?;
    crate::to_value(board)
}

fn company_crm_projection(
    company_uid: &str,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    let url = hq_desktop_core::desktop_alt::crm_projection_url(&context.base_url, company_uid)
        .map_err(invalid_params)?;
    let response = transport.send(request(HttpVerb::Get, url, context, None), cancellation)?;
    let status = status_code(response.status)?;
    hq_desktop_core::desktop_alt::parse_crm_projection_response(
        status,
        &response_text(&response.body),
    )
    .map_err(|message| surface_error("CRM projection", response.status, message))
}

fn company_project_creators(
    company_uid: &str,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    let url = hq_desktop_core::desktop_alt::board_url(&context.base_url, company_uid)
        .map_err(invalid_params)?;
    let response = transport.send(request(HttpVerb::Get, url, context, None), cancellation)?;
    if !(200..300).contains(&response.status) {
        return Ok(json!([]));
    }
    let creators =
        hq_desktop_core::desktop_alt::parse_project_creators(&response_text(&response.body))
            .map_err(|message| surface_error("project creators", response.status, message))?;
    crate::to_value(creators)
}

fn company_activity(
    company_uid: &str,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    let url = hq_desktop_core::desktop_alt::activity_url(&context.base_url, company_uid)
        .map_err(invalid_params)?;
    let response = transport.send(request(HttpVerb::Get, url, context, None), cancellation)?;
    let status = status_code(response.status)?;
    let activity = hq_desktop_core::desktop_alt::parse_activity_response(
        status,
        &response_text(&response.body),
    )
    .map_err(|message| surface_error("activity", response.status, message))?;
    crate::to_value(activity)
}

fn company_deployments(
    slug: &str,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    const HQ_DEPLOY_API_BASE: &str = "https://api.indigo-hq.com";
    let url = hq_desktop_core::desktop_alt::deployments_url(HQ_DEPLOY_API_BASE);
    let response = transport.send(
        request_with_headers(
            HttpVerb::Get,
            url,
            context,
            vec![("x-org-slug".to_string(), slug.to_string())],
            None,
        ),
        cancellation,
    )?;
    let status = status_code(response.status)?;
    let deployments = hq_desktop_core::desktop_alt::parse_deployments_response(
        status,
        &response_text(&response.body),
        slug,
    )
    .map_err(|message| surface_error("deployments", response.status, message))?;
    crate::to_value(deployments)
}

fn company_secrets(
    company_uid: &str,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    let url = hq_desktop_core::desktop_alt::secrets_url(&context.base_url, company_uid)
        .map_err(invalid_params)?;
    let response = transport.send(request(HttpVerb::Get, url, context, None), cancellation)?;
    let status = status_code(response.status)?;
    let secrets = hq_desktop_core::desktop_alt::parse_secrets_response(
        status,
        &response_text(&response.body),
    )
    .map_err(|message| surface_error("secrets", response.status, message))?;
    crate::to_value(secrets)
}

fn company_summary(
    slug: &str,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    let company_uid = resolve_company_uid(slug, context, transport, cancellation)?;
    let board = company_board(&company_uid, context, transport, cancellation);
    let activity = company_activity(&company_uid, context, transport, cancellation);
    let deployments = company_deployments(slug, context, transport, cancellation);
    let secrets = company_secrets(&company_uid, context, transport, cancellation);
    for result in [&board, &activity, &deployments, &secrets] {
        if let Err(error) = result {
            if error.code == "cloud_auth_required" {
                return Err(error.clone());
            }
        }
    }
    Ok(json!({
        "board": board
            .ok()
            .as_ref()
            .map(board_card_count)
            .unwrap_or(0),
        "activity": {
            "last7d": activity
                .ok()
                .as_ref()
                .and_then(|value| value.pointer("/stats/files7"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
        },
        "deployments": deployments
            .ok()
            .as_ref()
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        "secrets": secrets
            .ok()
            .as_ref()
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
    }))
}

fn board_card_count(board: &Value) -> usize {
    ["inbox", "doing", "review", "done"]
        .iter()
        .filter_map(|column| board.get(column).and_then(Value::as_array))
        .map(Vec::len)
        .sum()
}

fn status_code(status: u16) -> Result<reqwest::StatusCode, EngineError> {
    reqwest::StatusCode::from_u16(status).map_err(|error| {
        EngineError::new(
            "cloud_response_invalid",
            format!("HQ cloud returned an invalid HTTP status: {error}"),
            false,
        )
    })
}

fn response_text(body: &Value) -> String {
    if body.is_null() {
        String::new()
    } else {
        body.to_string()
    }
}

fn surface_error(surface: &str, status: u16, message: String) -> EngineError {
    if status == 401 || status == 403 || message.starts_with("AUTH_REQUIRED:") {
        EngineError::new(
            "cloud_auth_required",
            format!("Sign in again to load company {surface}"),
            false,
        )
    } else {
        EngineError::new(
            "cloud_response_invalid",
            format!("Could not load company {surface}: {message}"),
            status == 408 || status == 429 || status >= 500,
        )
    }
}

fn encode_query_value(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn ensure_success(response: CloudResponse) -> Result<Value, EngineError> {
    if (200..300).contains(&response.status) {
        return Ok(response.body);
    }
    let detail = response
        .body
        .get("error")
        .and_then(Value::as_str)
        .or_else(|| response.body.get("message").and_then(Value::as_str))
        .unwrap_or("HQ cloud request failed");
    Err(EngineError::new(
        "cloud_http_error",
        format!("HQ cloud returned status {}: {detail}", response.status),
        response.status == 408 || response.status == 429 || response.status >= 500,
    ))
}

fn history_source(
    response: Result<CloudResponse, EngineError>,
    key: &str,
) -> Result<Vec<Value>, EngineError> {
    let body = ensure_success(response?)?;
    body.get(key)
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| {
            EngineError::new(
                "cloud_response_invalid",
                format!("Notification history is missing `{key}`"),
                false,
            )
        })
}

fn retry_telemetry_opt_in(
    enabled: bool,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
    retry_delays: &[Duration],
    sleep: &dyn Fn(Duration),
) -> Result<(), EngineError> {
    let base = context.base_url.trim_end_matches('/');
    let mut last_error = None;
    for attempt in 0..=retry_delays.len() {
        cancellation.check()?;
        let result = transport
            .send(
                request(
                    HttpVerb::Post,
                    format!("{base}/v1/usage/opt-in"),
                    context,
                    Some(json!({"enabled": enabled})),
                ),
                cancellation,
            )
            .and_then(ensure_success);
        match result {
            Ok(_) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        if let Some(delay) = retry_delays.get(attempt).copied() {
            sleep(delay);
            cancellation.check()?;
        }
    }
    let error = last_error.unwrap_or_else(|| {
        EngineError::new(
            "telemetry_opt_in_failed",
            "HQ could not save the telemetry preference",
            true,
        )
    });
    Err(EngineError::new(
        "telemetry_opt_in_failed",
        format!(
            "HQ could not save the telemetry preference after {} attempts: {}",
            retry_delays.len() + 1,
            error.message
        ),
        error.retryable,
    ))
}

fn unread_summary_with_transport(
    unread_dms: u32,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
) -> Result<Value, EngineError> {
    cancellation.check()?;
    let base = context.base_url.trim_end_matches('/');
    let pending_requests = match transport
        .send(
            request(
                HttpVerb::Get,
                format!("{base}/v1/notify/connections/requests"),
                context,
                None,
            ),
            cancellation,
        )
        .and_then(ensure_success)
    {
        Ok(body) => body
            .get("requests")
            .and_then(Value::as_array)
            .map_or(0, Vec::len) as u32,
        Err(error) if error.code == "request_cancelled" => return Err(error),
        Err(_) => 0,
    };
    cancellation.check()?;
    Ok(json!({
        "unreadDms": unread_dms,
        "pendingRequests": pending_requests,
    }))
}

fn params_object<'a>(
    method: &str,
    params: &'a Value,
) -> Result<&'a serde_json::Map<String, Value>, EngineError> {
    params
        .as_object()
        .ok_or_else(|| invalid_params(format!("`{method}` params must be a JSON object")))
}

fn required_trimmed<'a>(
    params: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, EngineError> {
    optional_trimmed(params, key)?
        .ok_or_else(|| invalid_params(format!("`{key}` must not be empty")))
}

fn optional_trimmed<'a>(
    params: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, EngineError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.trim()).filter(|value| !value.is_empty())),
        Some(_) => Err(invalid_params(format!("`{key}` must be a string"))),
    }
}

fn optional_u32(
    params: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<u32>, EngineError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .map(Some)
            .ok_or_else(|| invalid_params(format!("`{key}` must be a positive integer"))),
        Some(_) => Err(invalid_params(format!(
            "`{key}` must be a positive integer"
        ))),
    }
}

fn required_bool(params: &serde_json::Map<String, Value>, key: &str) -> Result<bool, EngineError> {
    params
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid_params(format!("`{key}` must be a boolean")))
}

fn required_string_array(
    params: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Vec<String>, EngineError> {
    let values = params
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_params(format!("`{key}` must be an array of strings")))?;
    let mut output = Vec::with_capacity(values.len());
    for value in values {
        let item = value
            .as_str()
            .ok_or_else(|| invalid_params(format!("`{key}` must contain only strings")))?
            .trim();
        if !item.is_empty() {
            output.push(item.to_string());
        }
    }
    Ok(output)
}

fn optional_string_array(
    params: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Vec<String>, EngineError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(_) => required_string_array(params, key),
    }
}

fn invalid_params(message: impl Into<String>) -> EngineError {
    EngineError::new("invalid_params", message, false)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;

    #[derive(Default)]
    struct MockTransport {
        requests: Mutex<Vec<CloudRequest>>,
        responses: Mutex<VecDeque<Result<CloudResponse, EngineError>>>,
    }

    impl MockTransport {
        fn returning(responses: impl IntoIterator<Item = CloudResponse>) -> Self {
            Self {
                requests: Mutex::default(),
                responses: Mutex::new(responses.into_iter().map(Ok).collect()),
            }
        }

        fn returning_results(
            responses: impl IntoIterator<Item = Result<CloudResponse, EngineError>>,
        ) -> Self {
            Self {
                requests: Mutex::default(),
                responses: Mutex::new(responses.into_iter().collect()),
            }
        }

        fn requests(&self) -> Vec<CloudRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl CloudTransport for MockTransport {
        fn send(
            &self,
            request: CloudRequest,
            _cancellation: &CancellationFlag,
        ) -> Result<CloudResponse, EngineError> {
            self.requests.lock().unwrap().push(request);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("mock response")
        }
    }

    fn context() -> CloudContext {
        CloudContext {
            base_url: "https://vault.example.test/".to_string(),
            access_token: "secret-bearer".to_string(),
        }
    }

    fn ok(body: Value) -> CloudResponse {
        CloudResponse { status: 200, body }
    }

    fn run(method: &str, params: Value, transport: &MockTransport) -> Result<Value, EngineError> {
        execute_with_transport(
            method,
            &params,
            &CancellationFlag::default(),
            &context(),
            transport,
        )
    }

    #[test]
    fn marketplace_publish_wrapper_emits_typed_start_and_terminal_progress() {
        let temp = tempfile::tempdir().unwrap();
        let backend = CoreBackend::with_roots(
            temp.path(),
            temp.path().join(".claude"),
            temp.path().join(".codex"),
        );
        let mut events = backend.event_bus().subscribe();

        let output = execute_with_publish_progress(&backend, "publish_marketplace_pack", || {
            Ok(json!({"listingId":"listing-1","status":"pending_review"}))
        })
        .unwrap();
        assert_eq!(output["listingId"], "listing-1");

        let started = events.try_recv().unwrap();
        let completed = events.try_recv().unwrap();
        assert_eq!(started.name, "marketplace:publish-progress");
        assert_eq!(
            started.data,
            json!({"stream":"stdout","line":"Preparing marketplace submission"})
        );
        assert_eq!(completed.name, "marketplace:publish-progress");
        assert_eq!(
            completed.data,
            json!({"stream":"stdout","line":"Marketplace submission accepted for review"})
        );

        let error = execute_with_publish_progress(&backend, "publish_marketplace_pack", || {
            Err(EngineError::new(
                "marketplace_publish_failed",
                "Creator access required",
                false,
            ))
        })
        .unwrap_err();
        assert_eq!(error.code, "marketplace_publish_failed");
        assert_eq!(
            events.try_recv().unwrap().data,
            json!({"stream":"stdout","line":"Preparing marketplace submission"})
        );
        assert_eq!(
            events.try_recv().unwrap().data,
            json!({"stream":"stderr","line":"Creator access required"})
        );
    }

    #[test]
    fn list_channels_gets_authenticated_collection_and_preserves_payload() {
        let transport = MockTransport::returning([ok(json!({
            "channels": [{
                "channelId": "channel-1",
                "name": "Product",
                "scope": "company"
            }]
        }))]);

        let output = run("list_channels", json!({}), &transport).unwrap();

        assert_eq!(output["channels"][0]["channelId"], "channel-1");
        assert_eq!(
            transport.requests(),
            [CloudRequest {
                method: HttpVerb::Get,
                url: "https://vault.example.test/v1/notify/channels".to_string(),
                bearer_token: Some("secret-bearer".to_string()),
                headers: Vec::new(),
                body: None,
            }]
        );
    }

    #[test]
    fn fetch_channel_escapes_id_and_cursor_and_forwards_pagination() {
        let transport = MockTransport::returning([ok(json!({"messages": [], "nextCursor": null}))]);

        run(
            "fetch_channel",
            json!({
                "channelId": "team/launch",
                "limit": 25,
                "cursor": "next page"
            }),
            &transport,
        )
        .unwrap();

        assert_eq!(
            transport.requests()[0].url,
            "https://vault.example.test/v1/notify/channels/team%2Flaunch/messages?limit=25&cursor=next%20page"
        );
    }

    #[test]
    fn create_channel_uses_core_wire_shape_and_unwraps_channel_envelope() {
        let transport = MockTransport::returning([ok(json!({
            "channel": {
                "channelId": "channel-2",
                "name": "Launch",
                "scope": "company"
            }
        }))]);

        let output = run(
            "create_channel",
            json!({
                "name": "  Launch  ",
                "scope": "COMPANY",
                "companyUid": "company-1",
                "invite": ["person-1"]
            }),
            &transport,
        )
        .unwrap();

        assert_eq!(output["channelId"], "channel-2");
        let request = &transport.requests()[0];
        assert_eq!(request.method, HttpVerb::Post);
        assert_eq!(
            request.body,
            Some(json!({
                "name": "Launch",
                "scope": "company",
                "companyUid": "company-1",
                "invite": ["person-1"]
            }))
        );
    }

    #[test]
    fn create_group_dm_rejects_too_few_people_before_network() {
        let transport = MockTransport::default();

        let error = run(
            "create_group_dm",
            json!({"participants": ["person-1"]}),
            &transport,
        )
        .unwrap_err();

        assert_eq!(error.code, "invalid_params");
        assert!(transport.requests().is_empty());
    }

    #[test]
    fn send_channel_message_trims_body_and_returns_null() {
        let transport = MockTransport::returning([ok(json!({"accepted": true}))]);

        let output = run(
            "send_channel_message",
            json!({"channelId": "channel-1", "body": "  Ship it  "}),
            &transport,
        )
        .unwrap();

        assert_eq!(output, Value::Null);
        assert_eq!(
            transport.requests()[0].body,
            Some(json!({"body": "Ship it"}))
        );
    }

    #[test]
    fn list_channel_members_treats_missing_endpoint_as_empty_roster() {
        let transport = MockTransport::returning([CloudResponse {
            status: 404,
            body: json!({"error": "not found"}),
        }]);

        let output = run(
            "list_channel_members",
            json!({"channelId": "channel-1"}),
            &transport,
        )
        .unwrap();

        assert_eq!(output, json!({"members": []}));
    }

    #[test]
    fn server_errors_are_actionable_retryable_and_never_expose_bearer_token() {
        let transport = MockTransport::returning([CloudResponse {
            status: 503,
            body: json!({"error": "temporarily unavailable"}),
        }]);

        let error = run("list_channels", json!({}), &transport).unwrap_err();

        assert_eq!(error.code, "cloud_http_error");
        assert!(error.retryable);
        assert!(error.message.contains("temporarily unavailable"));
        assert!(!error.message.contains("secret-bearer"));
    }

    #[test]
    fn cancellation_prevents_network_dispatch() {
        let transport = MockTransport::default();
        let cancellation = CancellationFlag::default();
        cancellation.cancel();

        let error = execute_with_transport(
            "list_channels",
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
    fn send_dm_uses_person_recipient_wire_shape() {
        let transport = MockTransport::returning([ok(json!({"delivered": true}))]);

        let output = run(
            "send_dm",
            json!({"toPersonUid": "person-2", "body": "  Hello  "}),
            &transport,
        )
        .unwrap();

        assert_eq!(output, Value::Null);
        assert_eq!(
            transport.requests()[0].body,
            Some(json!({"toPersonUid": "person-2", "body": "Hello"}))
        );
    }

    #[test]
    fn compose_dm_prefers_person_uid_and_maps_accepted_to_pending_state() {
        let transport = MockTransport::returning([CloudResponse {
            status: 202,
            body: json!({"state": "connection_requested"}),
        }]);

        let output = run(
            "send_dm_to_email",
            json!({
                "toEmail": "person@example.test",
                "toPersonUid": "person-2",
                "body": "Hello"
            }),
            &transport,
        )
        .unwrap();

        assert_eq!(output, json!({"state": "connectionRequested"}));
        assert_eq!(
            transport.requests()[0].body,
            Some(json!({"toPersonUid": "person-2", "body": "Hello"}))
        );
    }

    #[test]
    fn fetch_dm_thread_uses_existing_pagination_contract() {
        let transport = MockTransport::returning([ok(json!({
            "messages": [],
            "nextCursor": "older"
        }))]);

        run(
            "fetch_dm_thread",
            json!({
                "withPersonUid": "person-2",
                "limit": 40,
                "cursor": "cursor-1"
            }),
            &transport,
        )
        .unwrap();

        assert_eq!(
            transport.requests()[0].url,
            "https://vault.example.test/v1/notify/thread?withPersonUid=person-2&limit=40&cursor=cursor-1"
        );
    }

    #[test]
    fn list_dm_requests_gets_pending_connections() {
        let transport = MockTransport::returning([ok(json!({
            "requests": [{"pairKey": "pair-1"}]
        }))]);

        let output = run("list_dm_requests", json!({}), &transport).unwrap();

        assert_eq!(output["requests"][0]["pairKey"], "pair-1");
        assert_eq!(
            transport.requests()[0].url,
            "https://vault.example.test/v1/notify/connections/requests"
        );
    }

    #[test]
    fn fetch_thread_requires_address_for_selected_scope() {
        let transport = MockTransport::default();

        let error = run(
            "fetch_thread",
            json!({
                "scope": "channel",
                "rootEventId": "event-1"
            }),
            &transport,
        )
        .unwrap_err();

        assert_eq!(error.code, "invalid_params");
        assert!(error.message.contains("channelId"));
        assert!(transport.requests().is_empty());
    }

    #[test]
    fn send_thread_reply_builds_channel_url_and_payload() {
        let transport = MockTransport::returning([ok(json!({"accepted": true}))]);

        let output = run(
            "send_thread_reply",
            json!({
                "scope": "channel",
                "rootEventId": "root-1",
                "body": "  A reply  ",
                "channelId": "channel/1"
            }),
            &transport,
        )
        .unwrap();

        assert_eq!(output, Value::Null);
        assert_eq!(
            transport.requests()[0].url,
            "https://vault.example.test/v1/notify/channels/channel%2F1/messages"
        );
        assert_eq!(
            transport.requests()[0].body,
            Some(json!({"body": "A reply", "rootEventId": "root-1"}))
        );
    }

    #[test]
    fn fetch_reactions_unwraps_server_envelope() {
        let transport = MockTransport::returning([ok(json!({
            "messageScope": "dm:person-2",
            "messageId": "event-1",
            "reactions": [{
                "emoji": "👍",
                "count": 2,
                "reactedByMe": true
            }]
        }))]);

        let output = run(
            "fetch_reactions",
            json!({
                "messageScope": "dm:person-2",
                "messageId": "event-1"
            }),
            &transport,
        )
        .unwrap();

        assert_eq!(
            output,
            json!([{
                "emoji": "👍",
                "count": 2,
                "reactedByMe": true
            }])
        );
    }

    #[test]
    fn contacts_and_company_members_preserve_the_legacy_collection_contract() {
        let contacts = MockTransport::returning([ok(json!({
            "contacts": [{"personUid": "person-1", "displayName": "Ada"}]
        }))]);
        let members = MockTransport::returning([ok(json!({
            "contacts": [{"personUid": "person-2", "displayName": "Grace"}]
        }))]);

        let contacts_output = run("list_contacts", json!({}), &contacts).unwrap();
        let members_output = run(
            "list_company_members",
            json!({"companyUid": "company/a"}),
            &members,
        )
        .unwrap();

        assert_eq!(contacts_output["contacts"][0]["personUid"], "person-1");
        assert_eq!(members_output["contacts"][0]["personUid"], "person-2");
        assert_eq!(
            contacts.requests()[0].url,
            "https://vault.example.test/v1/notify/contacts"
        );
        assert_eq!(
            members.requests()[0].url,
            "https://vault.example.test/v1/notify/contacts?companyUid=company%2Fa"
        );
    }

    #[test]
    fn channel_membership_mutations_keep_exact_wire_shapes() {
        let join = MockTransport::returning([ok(json!({
            "channelId": "channel-1",
            "name": "Launch",
            "scope": "company"
        }))]);
        let invite = MockTransport::returning([
            ok(json!({"members": [{"personUid": "person-1"}]})),
            ok(json!({
                "members": [
                    {"personUid": "person-1"},
                    {"personUid": "person-2"}
                ]
            })),
        ]);
        let remove = MockTransport::returning([ok(json!({
            "members": [{"personUid": "person-2"}]
        }))]);

        let joined = run("join_channel", json!({"channelId": "channel/1"}), &join).unwrap();
        let invited = run(
            "invite_to_channel",
            json!({
                "channelId": "channel/1",
                "personUids": ["person-1", " ", "person-2"]
            }),
            &invite,
        )
        .unwrap();
        let removed = run(
            "remove_channel_member",
            json!({"channelId": "channel/1", "personUid": "person/1"}),
            &remove,
        )
        .unwrap();

        assert_eq!(joined["channelId"], "channel-1");
        assert_eq!(invited["members"].as_array().unwrap().len(), 2);
        assert_eq!(removed["members"][0]["personUid"], "person-2");
        assert_eq!(join.requests()[0].body, Some(json!({})));
        assert_eq!(
            invite
                .requests()
                .iter()
                .map(|request| request.body.clone().unwrap())
                .collect::<Vec<_>>(),
            [
                json!({"toPersonUid": "person-1"}),
                json!({"toPersonUid": "person-2"})
            ]
        );
        assert_eq!(
            remove.requests()[0].url,
            "https://vault.example.test/v1/notify/channels/channel%2F1/members/person%2F1"
        );
    }

    #[test]
    fn mark_read_and_reaction_mutations_return_null_and_keep_payloads() {
        let read = MockTransport::returning([ok(json!({"ok": true}))]);
        let add = MockTransport::returning([ok(json!({"ok": true}))]);
        let remove = MockTransport::returning([ok(json!({"ok": true}))]);

        let read_output = run(
            "mark_channel_read",
            json!({"channelId": "channel/1"}),
            &read,
        )
        .unwrap();
        let add_output = run(
            "toggle_reaction",
            json!({
                "messageScope": "dm:person-1",
                "messageId": "event-1",
                "emoji": "👍",
                "add": true
            }),
            &add,
        )
        .unwrap();
        let remove_output = run(
            "toggle_reaction",
            json!({
                "messageScope": "dm:person-1",
                "messageId": "event-1",
                "emoji": "👍",
                "add": false
            }),
            &remove,
        )
        .unwrap();

        assert_eq!(read_output, Value::Null);
        assert_eq!(add_output, Value::Null);
        assert_eq!(remove_output, Value::Null);
        assert_eq!(read.requests()[0].body, Some(json!({})));
        assert_eq!(
            add.requests()[0].body,
            Some(json!({
                "messageScope": "dm:person-1",
                "messageId": "event-1",
                "emoji": "👍"
            }))
        );
        assert_ne!(add.requests()[0].method, remove.requests()[0].method);
    }

    #[test]
    fn responding_to_dm_requests_validates_action_and_posts_pair_key() {
        let transport = MockTransport::returning([ok(json!({"ok": true}))]);

        let output = run(
            "respond_dm_request",
            json!({"pairKey": "pair-1", "action": "ACCEPT"}),
            &transport,
        )
        .unwrap();

        assert_eq!(output, Value::Null);
        assert_eq!(
            transport.requests()[0].url,
            "https://vault.example.test/v1/notify/connections/accept"
        );
        assert_eq!(
            transport.requests()[0].body,
            Some(json!({"pairKey": "pair-1"}))
        );

        let invalid = MockTransport::default();
        let error = run(
            "respond_dm_request",
            json!({"pairKey": "pair-1", "action": "erase"}),
            &invalid,
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid_params");
        assert!(invalid.requests().is_empty());
    }

    #[test]
    fn telemetry_preference_posts_the_authenticated_opt_in_contract() {
        let transport = MockTransport::returning([ok(Value::Null)]);

        let output = run(
            "post_telemetry_opt_in",
            json!({"enabled": true}),
            &transport,
        )
        .unwrap();

        assert_eq!(output, Value::Null);
        assert_eq!(
            transport.requests()[0].url,
            "https://vault.example.test/v1/usage/opt-in"
        );
        assert_eq!(transport.requests()[0].body, Some(json!({"enabled": true})));
    }

    #[test]
    fn desktop_telemetry_checks_consent_and_sanitizes_the_exact_event_contract() {
        let transport = MockTransport::returning([ok(json!({"enabled": true})), ok(Value::Null)]);

        let output = emit_desktop_telemetry_with_transport(
            &json!({
                "eventName":"desktop_sync_complete",
                "properties":{
                    "provider":"indigo",
                    "enabled":true,
                    "filesDownloaded":7,
                    "unsafe":"secret",
                    "result":"contains spaces"
                }
            }),
            true,
            &CancellationFlag::default(),
            &context(),
            &transport,
        )
        .unwrap();

        assert_eq!(output, Value::Null);
        let requests = transport.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0],
            CloudRequest {
                method: HttpVerb::Get,
                url: "https://vault.example.test/v1/usage/opt-in".to_string(),
                bearer_token: Some("secret-bearer".to_string()),
                headers: Vec::new(),
                body: None,
            }
        );
        assert_eq!(requests[1].method, HttpVerb::Post);
        assert_eq!(
            requests[1].url,
            "https://vault.example.test/v1/telemetry/events"
        );
        let event = &requests[1].body.as_ref().unwrap()["events"][0];
        assert_eq!(event["eventName"], "desktop_sync_complete");
        assert_eq!(event["app"], "hq-desktop-app");
        assert_eq!(event["source"], "desktop");
        assert_eq!(event["consentBasis"], "desktop-opt-in");
        assert_eq!(event["schemaVersion"], 1);
        assert_eq!(
            event["properties"],
            json!({"provider":"indigo","enabled":true,"filesDownloaded":7})
        );
        assert!(event["occurredAt"].as_str().unwrap().ends_with('Z'));
        assert!(event.get("idempotencyKey").is_none());
    }

    #[test]
    fn desktop_telemetry_uses_disabled_local_consent_when_cloud_probe_fails() {
        let transport = MockTransport::returning_results([Err(EngineError::new(
            "cloud_network_error",
            "offline",
            true,
        ))]);

        let output = emit_desktop_telemetry_with_transport(
            &json!({"eventName":"desktop_sync_complete"}),
            false,
            &CancellationFlag::default(),
            &context(),
            &transport,
        )
        .unwrap();

        assert_eq!(output, Value::Null);
        assert_eq!(transport.requests().len(), 1);
    }

    #[test]
    fn workspace_listing_merges_local_cloud_and_pending_invite_state() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("companies/local")).unwrap();
        let transport = MockTransport::returning([
            ok(json!({"entities":[{
                "uid":"prs_1","slug":"corey","name":"Corey","bucketName":"personal-bucket",
                "createdAt":"2026-01-01T00:00:00Z"
            }]})),
            ok(json!({"memberships":[]})),
            ok(json!({"invites":[{
                "companyUid":"cmp_1","role":"member","invitedBy":"prs_owner",
                "invitedAt":"2026-07-01T00:00:00Z"
            }]})),
            ok(json!({"entity":{
                "uid":"cmp_1","slug":"cloud-team","name":"Cloud Team",
                "bucketName":"company-bucket","createdAt":"2026-01-02T00:00:00Z"
            }})),
        ]);

        let snapshot =
            fetch_workspace_cloud_snapshot(&CancellationFlag::default(), &context(), &transport)
                .unwrap();
        let output = assemble_syncable_workspaces(temp.path(), Ok(snapshot)).unwrap();

        assert_eq!(output["cloudReachable"], true);
        assert_eq!(output["workspaces"][0]["slug"], "personal");
        assert_eq!(output["workspaces"][0]["cloudUid"], "prs_1");
        assert!(output["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .any(|workspace| workspace["slug"] == "local" && workspace["state"] == "local-only"));
        assert!(output["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .any(|workspace| workspace["slug"] == "cloud-team"
                && workspace["state"] == "cloud-only"
                && workspace["membershipStatus"] == "pending"));
    }

    #[test]
    fn pending_invite_claim_posts_person_uid_and_resolves_joined_slug() {
        let transport = MockTransport::returning([
            ok(json!({"entities":[{
                "uid":"prs_1","slug":"corey","name":"Corey",
                "createdAt":"2026-01-01T00:00:00Z"
            }]})),
            ok(json!({"invites":[{"companyUid":"cmp_1"}]})),
            ok(json!({"claimed":[{
                "personUid":"prs_1","companyUid":"cmp_1","status":"active"
            }]})),
            ok(json!({"entity":{
                "uid":"cmp_1","slug":"indigo","name":"Indigo",
                "createdAt":"2026-01-02T00:00:00Z"
            }})),
        ]);

        let output = run(
            "claim_pending_company_invite",
            json!({"companySlug":"indigo"}),
            &transport,
        )
        .unwrap();

        assert_eq!(output["ok"], true);
        assert_eq!(output["claimedSlugs"], json!(["indigo"]));
        assert!(output["message"]
            .as_str()
            .unwrap()
            .contains("Joined indigo"));
        assert_eq!(
            transport.requests()[2].body,
            Some(json!({"personUid":"prs_1"}))
        );
    }

    #[test]
    fn telemetry_preference_retries_exactly_and_honors_cancellation_between_attempts() {
        let transport = MockTransport::returning([
            CloudResponse {
                status: 503,
                body: json!({"error": "first"}),
            },
            CloudResponse {
                status: 502,
                body: json!({"error": "second"}),
            },
            ok(Value::Null),
        ]);
        let slept = Mutex::new(Vec::new());
        retry_telemetry_opt_in(
            false,
            &CancellationFlag::default(),
            &context(),
            &transport,
            &[Duration::from_secs(1), Duration::from_secs(3)],
            &|delay| slept.lock().unwrap().push(delay),
        )
        .unwrap();
        assert_eq!(transport.requests().len(), 3);
        assert_eq!(
            *slept.lock().unwrap(),
            [Duration::from_secs(1), Duration::from_secs(3)]
        );

        let cancelled_transport = MockTransport::returning_results([Err(EngineError::new(
            "cloud_network_error",
            "temporarily unavailable",
            true,
        ))]);
        let cancellation = CancellationFlag::default();
        let error = retry_telemetry_opt_in(
            true,
            &cancellation,
            &context(),
            &cancelled_transport,
            &[Duration::from_secs(1), Duration::from_secs(3)],
            &|_| cancellation.cancel(),
        )
        .unwrap_err();
        assert_eq!(error.code, "request_cancelled");
        assert_eq!(cancelled_transport.requests().len(), 1);
    }

    #[test]
    fn unread_summary_combines_session_dms_with_live_requests_and_degrades_safely() {
        let healthy = MockTransport::returning([ok(json!({
            "requests": [{"pairKey": "pair-1"}, {"pairKey": "pair-2"}]
        }))]);
        let output =
            unread_summary_with_transport(4, &CancellationFlag::default(), &context(), &healthy)
                .unwrap();
        assert_eq!(output, json!({"unreadDms": 4, "pendingRequests": 2}));

        let unavailable = MockTransport::returning([CloudResponse {
            status: 503,
            body: json!({"error": "unavailable"}),
        }]);
        let degraded = unread_summary_with_transport(
            4,
            &CancellationFlag::default(),
            &context(),
            &unavailable,
        )
        .unwrap();
        assert_eq!(degraded, json!({"unreadDms": 4, "pendingRequests": 0}));
    }

    #[test]
    fn company_board_resolves_slug_then_parses_native_board_shape() {
        let transport = MockTransport::returning([
            ok(json!({"entity": {"uid": "company-1"}})),
            ok(json!({
                "inbox": [{"id": "project-1", "title": "Launch"}],
                "doing": [],
                "review": [],
                "done": []
            })),
        ]);

        let output = run("get_company_board", json!({"slug": "indigo"}), &transport).unwrap();

        assert_eq!(output["inbox"][0]["title"], "Launch");
        assert_eq!(
            transport.requests()[0].url,
            "https://vault.example.test/entity/by-slug/company/indigo"
        );
        assert_eq!(
            transport.requests()[1].url,
            "https://vault.example.test/companies/company-1/board"
        );
    }

    #[test]
    fn missing_crm_projection_degrades_to_null() {
        let transport = MockTransport::returning([
            ok(json!({"entity": {"uid": "company-1"}})),
            CloudResponse {
                status: 404,
                body: json!({"error": "projection not provisioned"}),
            },
        ]);

        let output = run(
            "get_company_crm_projection_vault",
            json!({"slug": "indigo"}),
            &transport,
        )
        .unwrap();

        assert_eq!(output, Value::Null);
    }

    #[test]
    fn project_creators_keep_only_real_creator_metadata() {
        let transport = MockTransport::returning([
            ok(json!({"entity": {"uid": "company-1"}})),
            ok(json!({
                "projects": [
                    {
                        "id": "project-1",
                        "prdPath": "projects/launch/prd.json",
                        "createdByName": "Ada"
                    },
                    {
                        "id": "project-2",
                        "createdByName": " "
                    }
                ]
            })),
        ]);

        let output = run(
            "get_company_project_creators",
            json!({"slug": "indigo"}),
            &transport,
        )
        .unwrap();

        assert_eq!(
            output,
            json!([{
                "id": "project-1",
                "prdPath": "projects/launch/prd.json",
                "creator": "Ada"
            }])
        );
    }

    #[test]
    fn activity_and_telemetry_preserve_cloud_payloads() {
        let activity = MockTransport::returning([
            ok(json!({"entity": {"uid": "company-1"}})),
            ok(json!({
                "stats": {"files7": 9},
                "sparkline": [1, 3, 5]
            })),
        ]);
        let telemetry = MockTransport::returning([
            ok(json!({"entity": {"uid": "company-1"}})),
            ok(json!({"humans": 3, "agents": 2})),
        ]);

        let activity_output =
            run("get_company_activity", json!({"slug": "indigo"}), &activity).unwrap();
        let telemetry_output = run(
            "get_company_team_telemetry",
            json!({
                "slug": "indigo",
                "from": "2026-07-01",
                "to": "2026-07-26"
            }),
            &telemetry,
        )
        .unwrap();

        assert_eq!(activity_output["stats"]["files7"], 9);
        assert_eq!(telemetry_output, json!({"humans": 3, "agents": 2}));
        assert_eq!(
            telemetry.requests()[1].url,
            "https://vault.example.test/v1/telemetry/company?companyUid=company-1&from=2026-07-01&to=2026-07-26"
        );
    }

    #[test]
    fn deployments_are_scoped_by_company_header() {
        let transport = MockTransport::returning([ok(json!({"apps": []}))]);

        let output = run(
            "get_company_deployments",
            json!({"slug": "indigo"}),
            &transport,
        )
        .unwrap();

        assert_eq!(output, json!([]));
        let request = &transport.requests()[0];
        assert_eq!(request.url, "https://api.indigo-hq.com/api/apps");
        assert_eq!(
            request.headers,
            [("x-org-slug".to_string(), "indigo".to_string())]
        );
    }

    #[test]
    fn secrets_return_structure_without_secret_values() {
        let transport = MockTransport::returning([
            ok(json!({"entity": {"uid": "company-1"}})),
            ok(json!({
                "secrets": [{
                    "key": "prod/API_KEY",
                    "value": "must-never-reach-swift",
                    "updatedAt": "2026-07-26"
                }]
            })),
        ]);

        let output = run("get_company_secrets", json!({"slug": "indigo"}), &transport).unwrap();

        assert_eq!(output[0]["env"], "prod");
        assert_eq!(output[0]["items"][0]["key"], "API_KEY");
        assert!(!output.to_string().contains("must-never-reach-swift"));
    }

    #[test]
    fn company_summary_aggregates_real_surface_counts() {
        let transport = MockTransport::returning([
            ok(json!({"entity": {"uid": "company-1"}})),
            ok(json!({
                "inbox": [{"id": "project-1", "title": "Launch"}],
                "doing": [],
                "review": [],
                "done": []
            })),
            ok(json!({
                "stats": {"files7": 7}
            })),
            ok(json!({
                "apps": [{
                    "name": "hq",
                    "url": "https://hq.indigo-hq.com"
                }]
            })),
            ok(json!({
                "secrets": [{
                    "key": "prod/API_KEY"
                }]
            })),
        ]);

        let output = run("get_company_summary", json!({"slug": "indigo"}), &transport).unwrap();

        assert_eq!(
            output,
            json!({
                "board": 1,
                "activity": {"last7d": 7},
                "deployments": 1,
                "secrets": 1
            })
        );
    }

    #[test]
    fn get_sync_mode_resolves_membership_key_and_escapes_composite_id() {
        let transport = MockTransport::returning([
            ok(json!({"entity": {"uid": "company-1"}})),
            ok(json!({
                "memberships": [{
                    "personUid": "person-1",
                    "companyUid": "company-1",
                    "membershipKey": "person-1#company-1"
                }]
            })),
            ok(json!({
                "syncMode": "shared",
                "customPaths": [],
                "isDefault": false
            })),
        ]);

        let output = run(
            "get_sync_mode",
            json!({"companySlug": "indigo"}),
            &transport,
        )
        .unwrap();

        assert_eq!(output["syncMode"], "shared");
        assert_eq!(
            transport.requests()[2].url,
            "https://vault.example.test/v1/memberships/person-1%23company-1/sync-config"
        );
    }

    #[test]
    fn set_sync_mode_validates_toggle_and_puts_exact_body() {
        let transport = MockTransport::returning([
            ok(json!({"entity": {"uid": "company-1"}})),
            ok(json!({
                "memberships": [{
                    "personUid": "person-1",
                    "companyUid": "company-1"
                }]
            })),
            ok(json!({
                "syncMode": "all",
                "customPaths": null,
                "isDefault": false
            })),
        ]);

        let output = run(
            "set_sync_mode",
            json!({
                "companySlug": "indigo",
                "mode": "all"
            }),
            &transport,
        )
        .unwrap();

        assert_eq!(output["syncMode"], "all");
        let request = &transport.requests()[2];
        assert_eq!(request.method, HttpVerb::Put);
        assert_eq!(
            request.body,
            Some(json!({"syncMode": "all", "customPaths": null}))
        );
    }

    #[test]
    fn set_sync_mode_rejects_custom_without_cli_paths() {
        let transport = MockTransport::default();

        let error = run(
            "set_sync_mode",
            json!({
                "companySlug": "indigo",
                "mode": "custom"
            }),
            &transport,
        )
        .unwrap_err();

        assert_eq!(error.code, "invalid_params");
        assert!(error.message.contains("hq sync mode custom"));
        assert!(transport.requests().is_empty());
    }

    #[test]
    fn marketplace_browse_is_public_query_encoded_and_redacted() {
        let transport = MockTransport::returning([ok(json!({
            "listings": [{
                "id": "listing-1",
                "type": "skill",
                "name": "Native craft",
                "slug": "native-craft",
                "version": "1.0.0",
                "author": "ada",
                "createdAt": "2026-07-26T00:00:00Z",
                "creatorUid": "must-not-cross-boundary",
                "s3Key": "must-not-cross-boundary"
            }]
        }))]);

        let output = run(
            "list_marketplace_listings",
            json!({"query": "native craft"}),
            &transport,
        )
        .unwrap();

        assert_eq!(output[0]["slug"], "native-craft");
        assert!(output[0].get("creatorUid").is_none());
        assert!(output[0].get("s3Key").is_none());
        let request = &transport.requests()[0];
        assert_eq!(
            request.url,
            "https://vault.example.test/v1/listings?q=native%20craft"
        );
        assert!(request.bearer_token.is_none());
    }

    #[test]
    fn notification_history_keeps_healthy_sources_when_one_is_unavailable() {
        let transport = MockTransport::returning([
            ok(json!({
                "events": [{
                    "eventId": "dm-1",
                    "body": "Hello"
                }]
            })),
            CloudResponse {
                status: 503,
                body: json!({"error": "shares unavailable"}),
            },
            CloudResponse {
                status: 404,
                body: json!({"error": "file history not deployed"}),
            },
        ]);

        let output = run(
            "fetch_notification_history",
            json!({"limit": 500}),
            &transport,
        )
        .unwrap();

        assert_eq!(output["dms"][0]["eventId"], "dm-1");
        assert_eq!(output["shares"], json!([]));
        assert_eq!(output["files"], json!([]));
        assert_eq!(
            transport.requests()[0].url,
            "https://vault.example.test/v1/notify/inbox?limit=200"
        );
        assert_eq!(
            transport.requests()[1].url,
            "https://vault.example.test/v1/files/shared-with-me?limit=200"
        );
        assert_eq!(
            transport.requests()[2].url,
            "https://vault.example.test/v1/notify/file-history?limit=200"
        );
    }

    #[test]
    fn notification_history_fails_when_dm_and_share_sources_both_fail() {
        let transport = MockTransport::returning([
            CloudResponse {
                status: 503,
                body: json!({"error": "dm unavailable"}),
            },
            CloudResponse {
                status: 502,
                body: json!({"error": "shares unavailable"}),
            },
            ok(json!({"files": []})),
        ]);

        let error = run("fetch_notification_history", json!({}), &transport).unwrap_err();

        assert_eq!(error.code, "notification_history_unavailable");
        assert!(error.retryable);
    }

    struct MockTokenRefresher {
        calls: Mutex<u32>,
        result: Result<Value, EngineError>,
    }

    impl TokenRefresher for MockTokenRefresher {
        fn refresh(&self) -> Result<Value, EngineError> {
            *self.calls.lock().unwrap() += 1;
            self.result.clone()
        }
    }

    #[test]
    fn refresh_tokens_delegates_to_persisting_auth_boundary() {
        let refresher = MockTokenRefresher {
            calls: Mutex::new(0),
            result: Ok(json!({
                "authenticated": true,
                "expiresAt": "2026-07-26T21:00:00.000Z"
            })),
        };

        let output = execute_refresh_with(&CancellationFlag::default(), &refresher).unwrap();

        assert_eq!(output["authenticated"], true);
        assert_eq!(*refresher.calls.lock().unwrap(), 1);
    }

    #[test]
    fn refresh_tokens_honors_cancellation_before_auth_mutation() {
        let refresher = MockTokenRefresher {
            calls: Mutex::new(0),
            result: Ok(json!({"authenticated": true})),
        };
        let cancellation = CancellationFlag::default();
        cancellation.cancel();

        let error = execute_refresh_with(&cancellation, &refresher).unwrap_err();

        assert_eq!(error.code, "request_cancelled");
        assert_eq!(*refresher.calls.lock().unwrap(), 0);
    }
}
