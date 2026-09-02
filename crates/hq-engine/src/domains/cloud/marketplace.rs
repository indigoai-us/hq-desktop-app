//! Native marketplace upload commands.
//!
//! This module owns the filesystem-to-wire boundary for marketplace publishing
//! and creator-avatar uploads. Network I/O remains dependency-injected through
//! the cloud transport so contract tests never contact HQ services.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::{
    public_request, request, response_text, status_code, CloudContext, CloudRequest, CloudResponse,
    CloudTransport, HttpVerb,
};
use crate::{CancellationFlag, EngineError};

const MAX_PACK_SOURCE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PACK_ARCHIVE_BYTES: usize = 7 * 1024 * 1024;
const MAX_PACKAGE_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_PACK_ENTRIES: usize = 10_000;
const PACK_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageManifest {
    name: String,
    version: String,
    publisher: String,
    access: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "type")]
    listing_type: Option<String>,
    #[serde(default)]
    requires: Option<PackageRequirements>,
    #[serde(default)]
    contributes: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    author: Option<PackageAuthor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageRequirements {
    hq_core: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageAuthor {
    handle: Option<String>,
}

struct PreparedPack {
    name: String,
    version: String,
    listing_type: &'static str,
    summary: Option<String>,
    contributes: String,
    creator_handle: Option<String>,
    tarball: String,
}

pub(super) fn publish(
    params: &Map<String, Value>,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
) -> Result<Value, EngineError> {
    cancellation.check()?;
    let path = required_string(params, "path")?;
    let pack = prepare_pack(path, cancellation)?;
    cancellation.check()?;

    let mut body = Map::new();
    body.insert("type".to_string(), json!(pack.listing_type));
    body.insert("name".to_string(), json!(pack.name));
    body.insert("slug".to_string(), json!(derive_slug(&pack.name)));
    body.insert("version".to_string(), json!(pack.version));
    if let Some(summary) = pack.summary.as_ref() {
        body.insert("summary".to_string(), json!(summary));
    }
    body.insert("contributes".to_string(), json!(pack.contributes));
    if let Some(handle) = pack.creator_handle.as_ref() {
        body.insert("creatorHandle".to_string(), json!(handle));
    }
    body.insert("tarball".to_string(), json!(pack.tarball));

    let response = transport
        .send(
            request(
                HttpVerb::Post,
                format!("{}/v1/listings", context.base_url.trim_end_matches('/')),
                context,
                Some(Value::Object(body)),
            ),
            cancellation,
        )
        .map_err(|error| redact_engine_error(error, &context.access_token))?;
    cancellation.check()?;
    parse_publish_response(response, &pack, &context.access_token)
}

pub(super) fn upload_avatar(
    params: &Map<String, Value>,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
) -> Result<Value, EngineError> {
    cancellation.check()?;
    let path = required_string(params, "filePath")?;
    let (bytes, content_type) = read_avatar_bounded(path, cancellation)?;
    cancellation.check()?;
    let response = transport
        .send(
            request(
                HttpVerb::Post,
                format!(
                    "{}/v1/creators/me/avatar",
                    context.base_url.trim_end_matches('/')
                ),
                context,
                Some(json!({
                    "contentType": content_type,
                    "data": encode_base64(&bytes),
                })),
            ),
            cancellation,
        )
        .map_err(|error| redact_engine_error(error, &context.access_token))?;
    cancellation.check()?;

    hq_desktop_core::marketplace::parse_avatar_upload_response(
        status_code(response.status)?,
        &response_text(&response.body),
    )
    .map(Value::String)
    .map_err(|message| {
        let message = redact_message(&message, &context.access_token);
        let (code, retryable) = match response.status {
            401 | 403 => ("cloud_auth_required", false),
            408 | 429 => ("marketplace_avatar_upload_failed", true),
            status if status >= 500 => ("marketplace_avatar_upload_failed", true),
            _ => ("marketplace_avatar_upload_failed", false),
        };
        EngineError::new(code, message, retryable)
    })
}

pub(super) fn execute_cloud_command(
    method: &str,
    params: &Map<String, Value>,
    cancellation: &CancellationFlag,
    context: &CloudContext,
    transport: &dyn CloudTransport,
) -> Result<Value, EngineError> {
    cancellation.check()?;
    let base = context.base_url.trim_end_matches('/');
    match method {
        "list_moderation_queue" => {
            let response = send_marketplace(
                transport,
                request(
                    HttpVerb::Get,
                    format!("{base}/v1/moderation/queue"),
                    context,
                    None,
                ),
                cancellation,
                &context.access_token,
            )?;
            parsed_value(
                hq_desktop_core::marketplace::parse_queue_response(
                    status_code(response.status)?,
                    &response_text(&response.body),
                ),
                "marketplace_moderation_queue_failed",
                response.status,
                &context.access_token,
            )
        }
        "get_marketplace_listing" => {
            let id = required_safe_id(params, "id", "listing")?;
            let response = send_marketplace(
                transport,
                public_request(HttpVerb::Get, format!("{base}/v1/listings/{id}"), None),
                cancellation,
                "",
            )?;
            parsed_value(
                hq_desktop_core::marketplace::parse_detail_response(
                    status_code(response.status)?,
                    &response_text(&response.body),
                ),
                "marketplace_listing_failed",
                response.status,
                "",
            )
        }
        "get_creator_profile" => {
            let handle = required_string(params, "handle")?;
            if !valid_handle(handle) {
                return Err(invalid_params(format!(
                    "invalid creator handle: {handle:?}"
                )));
            }
            let response = send_marketplace(
                transport,
                public_request(HttpVerb::Get, format!("{base}/v1/creators/{handle}"), None),
                cancellation,
                "",
            )?;
            parsed_value(
                hq_desktop_core::marketplace::parse_public_profile_response(
                    status_code(response.status)?,
                    &response_text(&response.body),
                ),
                "marketplace_creator_profile_failed",
                response.status,
                "",
            )
        }
        "get_my_creator" => {
            let response = send_marketplace(
                transport,
                request(
                    HttpVerb::Get,
                    format!("{base}/v1/creators/me"),
                    context,
                    None,
                ),
                cancellation,
                &context.access_token,
            )?;
            parsed_value(
                hq_desktop_core::marketplace::parse_my_creator_response(
                    status_code(response.status)?,
                    &response_text(&response.body),
                ),
                "marketplace_my_creator_failed",
                response.status,
                &context.access_token,
            )
        }
        "claim_creator_handle" => {
            let handle = required_string(params, "handle")?;
            let response = send_marketplace(
                transport,
                request(
                    HttpVerb::Post,
                    format!("{base}/v1/creators/claim"),
                    context,
                    Some(json!({ "handle": handle })),
                ),
                cancellation,
                &context.access_token,
            )?;
            match hq_desktop_core::marketplace::parse_claim_response(
                status_code(response.status)?,
                &response_text(&response.body),
            ) {
                Ok(result) => crate::to_value(result),
                Err(error) => {
                    let code = if error.taken {
                        "marketplace_handle_taken"
                    } else {
                        "marketplace_claim_failed"
                    };
                    Err(EngineError::new(
                        code,
                        redact_message(&error.message, &context.access_token),
                        retryable_status(response.status),
                    ))
                }
            }
        }
        "update_creator_profile" => {
            let body = profile_update_body(params)?;
            let response = send_marketplace(
                transport,
                request(
                    HttpVerb::Put,
                    format!("{base}/v1/creators/me/profile"),
                    context,
                    Some(Value::Object(body)),
                ),
                cancellation,
                &context.access_token,
            )?;
            parsed_value(
                hq_desktop_core::marketplace::parse_profile_update_response(
                    status_code(response.status)?,
                    &response_text(&response.body),
                ),
                "marketplace_profile_update_failed",
                response.status,
                &context.access_token,
            )
        }
        "request_creator_access" => {
            let mut body = Map::new();
            if let Some(reason) = optional_trimmed(params, "reason")? {
                body.insert("reason".to_string(), json!(reason));
            }
            if let Some(handle) = optional_trimmed(params, "handle")? {
                body.insert("handle".to_string(), json!(handle));
            }
            let response = send_marketplace(
                transport,
                request(
                    HttpVerb::Post,
                    format!("{base}/v1/creators/request-access"),
                    context,
                    Some(Value::Object(body)),
                ),
                cancellation,
                &context.access_token,
            )?;
            parsed_value(
                hq_desktop_core::marketplace::parse_request_access_response(
                    status_code(response.status)?,
                    &response_text(&response.body),
                ),
                "marketplace_creator_access_failed",
                response.status,
                &context.access_token,
            )
        }
        "list_creator_applications" => {
            let response = send_marketplace(
                transport,
                request(
                    HttpVerb::Get,
                    format!("{base}/v1/creators/applications"),
                    context,
                    None,
                ),
                cancellation,
                &context.access_token,
            )?;
            parsed_value(
                hq_desktop_core::marketplace::parse_creator_applications_response(
                    status_code(response.status)?,
                    &response_text(&response.body),
                ),
                "marketplace_creator_applications_failed",
                response.status,
                &context.access_token,
            )
        }
        "decide_creator_application" => {
            let id = required_safe_id(params, "id", "application")?;
            let decision = hq_desktop_core::marketplace::ApplicationDecision::from_str(
                required_string(params, "decision")?,
            )
            .map_err(invalid_params)?;
            let mut body = Map::from_iter([("decision".to_string(), json!(decision.wire()))]);
            if let Some(note) = optional_trimmed(params, "note")? {
                body.insert("note".to_string(), json!(note));
            }
            let response = send_marketplace(
                transport,
                request(
                    HttpVerb::Post,
                    format!("{base}/v1/creators/applications/{id}"),
                    context,
                    Some(Value::Object(body)),
                ),
                cancellation,
                &context.access_token,
            )?;
            parsed_value(
                hq_desktop_core::marketplace::parse_application_decision_response(
                    id,
                    decision,
                    status_code(response.status)?,
                    &response_text(&response.body),
                ),
                "marketplace_creator_application_decision_failed",
                response.status,
                &context.access_token,
            )
        }
        "decide_moderation_listing" => {
            let id = required_safe_id(params, "id", "listing")?;
            let decision = hq_desktop_core::marketplace::Decision::from_str(required_string(
                params, "decision",
            )?)
            .map_err(invalid_params)?;
            let mut body = Map::from_iter([("decision".to_string(), json!(decision.wire()))]);
            if let Some(note) = optional_trimmed(params, "note")? {
                body.insert("note".to_string(), json!(note));
            }
            if let Some(version_lock) = optional_trimmed(params, "versionLock")? {
                body.insert("versionLock".to_string(), json!(version_lock));
            }
            let response = send_marketplace(
                transport,
                request(
                    HttpVerb::Post,
                    format!("{base}/v1/moderation/listings/{id}"),
                    context,
                    Some(Value::Object(body)),
                ),
                cancellation,
                &context.access_token,
            )?;
            parsed_value(
                hq_desktop_core::marketplace::parse_decision_response(
                    id,
                    decision,
                    status_code(response.status)?,
                    &response_text(&response.body),
                ),
                "marketplace_moderation_decision_failed",
                response.status,
                &context.access_token,
            )
        }
        "yank_marketplace_listing" => {
            let id = required_safe_id(params, "id", "listing")?;
            let reason = required_string(params, "reason")?;
            let response = send_marketplace(
                transport,
                request(
                    HttpVerb::Post,
                    format!("{base}/v1/moderation/listings/{id}/yank"),
                    context,
                    Some(json!({ "reason": reason })),
                ),
                cancellation,
                &context.access_token,
            )?;
            parsed_value(
                hq_desktop_core::marketplace::parse_yank_response(
                    id,
                    status_code(response.status)?,
                    &response_text(&response.body),
                ),
                "marketplace_yank_failed",
                response.status,
                &context.access_token,
            )
        }
        "record_marketplace_install" => {
            let id = required_safe_id(params, "listingId", "listing")?;
            let scope_value = params
                .get("scope")
                .filter(|value| !value.is_null())
                .ok_or_else(|| invalid_params("`scope` is required"))?;
            let scope: hq_desktop_core::marketplace::InstallScope =
                serde_json::from_value(scope_value.clone())
                    .map_err(|error| invalid_params(format!("invalid install scope: {error}")))?;
            let body =
                hq_desktop_core::marketplace::install_event_body(&scope).map_err(invalid_params)?;
            let response = send_marketplace(
                transport,
                request(
                    HttpVerb::Post,
                    format!("{base}/v1/listings/{id}/installs"),
                    context,
                    Some(body),
                ),
                cancellation,
                &context.access_token,
            )?;
            parsed_value(
                hq_desktop_core::marketplace::parse_install_event_response(
                    status_code(response.status)?,
                    &response_text(&response.body),
                ),
                "marketplace_install_metrics_failed",
                response.status,
                &context.access_token,
            )
        }
        _ => Err(EngineError::new(
            "method_not_found",
            format!("Marketplace method `{method}` is not implemented"),
            false,
        )),
    }
}

fn send_marketplace(
    transport: &dyn CloudTransport,
    request: CloudRequest,
    cancellation: &CancellationFlag,
    secret: &str,
) -> Result<CloudResponse, EngineError> {
    cancellation.check()?;
    let response = transport
        .send(request, cancellation)
        .map_err(|error| redact_engine_error(error, secret))?;
    cancellation.check()?;
    Ok(response)
}

fn parsed_value<T: Serialize>(
    result: Result<T, String>,
    code: &'static str,
    status: u16,
    secret: &str,
) -> Result<Value, EngineError> {
    result
        .map_err(|message| {
            EngineError::new(
                code,
                redact_message(&message, secret),
                retryable_status(status),
            )
        })
        .and_then(crate::to_value)
}

fn retryable_status(status: u16) -> bool {
    status == 408 || status == 429 || status >= 500
}

fn required_safe_id<'a>(
    params: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<&'a str, EngineError> {
    let id = required_string(params, key)?;
    if hq_desktop_core::marketplace::is_safe_id(id) {
        Ok(id)
    } else {
        Err(invalid_params(format!("invalid {label} id: {id:?}")))
    }
}

fn optional_trimmed<'a>(
    params: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, EngineError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.trim()).filter(|value| !value.is_empty())),
        Some(_) => Err(invalid_params(format!("`{key}` must be a string or null"))),
    }
}

fn profile_update_body(params: &Map<String, Value>) -> Result<Map<String, Value>, EngineError> {
    let mut body = Map::new();
    for key in ["bio", "tipUrl"] {
        match params.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(value)) => {
                body.insert(key.to_string(), Value::String(value.clone()));
            }
            Some(_) => return Err(invalid_params(format!("`{key}` must be a string or null"))),
        }
    }
    if let Some(value) = params.get("socialLinks").filter(|value| !value.is_null()) {
        let links: Vec<hq_desktop_core::marketplace::SocialLink> =
            serde_json::from_value(value.clone())
                .map_err(|error| invalid_params(format!("invalid socialLinks: {error}")))?;
        body.insert(
            "socialLinks".to_string(),
            serde_json::to_value(links).map_err(|error| {
                EngineError::new(
                    "cloud_request_invalid",
                    format!("Could not encode socialLinks: {error}"),
                    false,
                )
            })?,
        );
    }
    Ok(body)
}

fn valid_handle(handle: &str) -> bool {
    !handle.is_empty()
        && handle.len() <= 64
        && handle
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn invalid_params(message: impl Into<String>) -> EngineError {
    EngineError::new("invalid_params", message, false)
}

fn required_string<'a>(params: &'a Map<String, Value>, key: &str) -> Result<&'a str, EngineError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            EngineError::new(
                "invalid_params",
                format!("`{key}` must be a non-empty string"),
                false,
            )
        })
}

fn prepare_pack(
    raw_path: &str,
    cancellation: &CancellationFlag,
) -> Result<PreparedPack, EngineError> {
    cancellation.check()?;
    let selected = hq_desktop_core::marketplace::validate_publish_path(raw_path)
        .map_err(|message| EngineError::new("marketplace_manifest_invalid", message, false))?;
    let root = fs::canonicalize(selected).map_err(|_| {
        EngineError::new(
            "marketplace_manifest_invalid",
            "The selected marketplace pack could not be resolved",
            false,
        )
    })?;
    let manifest_bytes = read_bounded_file(
        &root.join("package.yaml"),
        MAX_PACKAGE_MANIFEST_BYTES,
        "marketplace_manifest_invalid",
        "package.yaml",
        cancellation,
    )?;
    let manifest: PackageManifest = serde_yaml::from_slice(&manifest_bytes).map_err(|error| {
        EngineError::new(
            "marketplace_manifest_invalid",
            format!("package.yaml is not valid YAML: {error}"),
            false,
        )
    })?;
    validate_manifest(&manifest, &root)?;
    preflight_pack_tree(&root, cancellation)?;
    let archive = create_archive(&root, cancellation)?;
    if archive.len() > MAX_PACK_ARCHIVE_BYTES {
        return Err(EngineError::new(
            "marketplace_pack_too_large",
            format!(
                "The compressed marketplace pack exceeds the {} MiB upload limit",
                MAX_PACK_ARCHIVE_BYTES / (1024 * 1024)
            ),
            false,
        ));
    }
    cancellation.check()?;

    let has_workers = manifest
        .contributes
        .get("workers")
        .is_some_and(|entries| !entries.is_empty());
    let has_skills = manifest
        .contributes
        .get("skills")
        .is_some_and(|entries| !entries.is_empty());
    let listing_type = match manifest.listing_type.as_deref() {
        Some("skill") => "skill",
        Some("worker") => "worker",
        _ if has_workers && !has_skills => "worker",
        _ => "skill",
    };
    let contributes = summarize_contributes(&manifest.contributes);
    let summary = manifest
        .description
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let creator_handle = manifest
        .author
        .as_ref()
        .and_then(|author| author.handle.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    Ok(PreparedPack {
        name: manifest.name,
        version: manifest.version,
        listing_type,
        summary,
        contributes,
        creator_handle,
        tarball: encode_base64(&archive),
    })
}

fn validate_manifest(manifest: &PackageManifest, root: &Path) -> Result<(), EngineError> {
    if !valid_pack_name(&manifest.name) {
        return Err(manifest_error(
            "package.yaml `name` must match `hq-pack-[a-z0-9][a-z0-9-]*`",
        ));
    }
    if !valid_semver(&manifest.version) {
        return Err(manifest_error(
            "package.yaml `version` must be valid semantic versioning",
        ));
    }
    if !valid_publisher(&manifest.publisher) {
        return Err(manifest_error(
            "package.yaml `publisher` must be an @-prefixed package scope",
        ));
    }
    if manifest.access != "public" && manifest.access != "private" {
        return Err(manifest_error(
            "package.yaml `access` must be `public` or `private`",
        ));
    }
    let hq_core = manifest
        .requires
        .as_ref()
        .and_then(|requires| requires.hq_core.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if hq_core.is_none() {
        return Err(manifest_error(
            "package.yaml `requires.hqCore` must be a non-empty version range",
        ));
    }
    if manifest.contributes.is_empty()
        || !manifest
            .contributes
            .values()
            .any(|entries| !entries.is_empty())
    {
        return Err(manifest_error(
            "package.yaml `contributes` must contain at least one entry",
        ));
    }
    for (kind, entries) in &manifest.contributes {
        for entry in entries {
            if !valid_contribution_name(entry) {
                return Err(manifest_error(format!(
                    "package.yaml `contributes.{kind}` contains an unsafe name"
                )));
            }
            let required_path = match kind.as_str() {
                "skills" => Some(root.join("skills").join(entry).join("SKILL.md")),
                "workers" => Some(root.join("workers").join(entry).join("worker.yaml")),
                _ => None,
            };
            if required_path.as_ref().is_some_and(|path| !path.is_file()) {
                return Err(manifest_error(format!(
                    "package.yaml declares `{kind}: {entry}` but its payload is missing"
                )));
            }
        }
    }
    Ok(())
}

fn preflight_pack_tree(root: &Path, cancellation: &CancellationFlag) -> Result<(), EngineError> {
    let mut stack = vec![root.to_path_buf()];
    let mut entries_seen = 0usize;
    let mut source_bytes = 0u64;
    while let Some(directory) = stack.pop() {
        cancellation.check()?;
        let entries = fs::read_dir(directory).map_err(|_| {
            EngineError::new(
                "marketplace_pack_unreadable",
                "The selected marketplace pack contains an unreadable directory",
                false,
            )
        })?;
        for entry in entries {
            cancellation.check()?;
            let entry = entry.map_err(|_| {
                EngineError::new(
                    "marketplace_pack_unreadable",
                    "The selected marketplace pack contains an unreadable entry",
                    false,
                )
            })?;
            let name = entry.file_name();
            if is_excluded_entry(&name.to_string_lossy()) {
                continue;
            }
            entries_seen += 1;
            if entries_seen > MAX_PACK_ENTRIES {
                return Err(EngineError::new(
                    "marketplace_pack_too_large",
                    "The marketplace pack contains too many files",
                    false,
                ));
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(|_| {
                EngineError::new(
                    "marketplace_pack_unreadable",
                    "The selected marketplace pack contains an unreadable entry",
                    false,
                )
            })?;
            let file_type = metadata.file_type();
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                source_bytes = source_bytes.checked_add(metadata.len()).ok_or_else(|| {
                    EngineError::new(
                        "marketplace_pack_too_large",
                        "The marketplace pack size could not be represented safely",
                        false,
                    )
                })?;
                if source_bytes > MAX_PACK_SOURCE_BYTES {
                    return Err(EngineError::new(
                        "marketplace_pack_too_large",
                        format!(
                            "The marketplace pack exceeds the {} MiB source limit",
                            MAX_PACK_SOURCE_BYTES / (1024 * 1024)
                        ),
                        false,
                    ));
                }
            } else if !file_type.is_symlink() {
                return Err(EngineError::new(
                    "marketplace_pack_unsupported_entry",
                    "The marketplace pack contains an unsupported special file",
                    false,
                ));
            }
        }
    }
    Ok(())
}

fn create_archive(root: &Path, cancellation: &CancellationFlag) -> Result<Vec<u8>, EngineError> {
    let temporary = TemporaryArchive::new()?;
    let archive_path = temporary.path.join("pack.tar.gz");
    let mut child = Command::new("/usr/bin/tar")
        .args(["-czf"])
        .arg(&archive_path)
        .arg("-C")
        .arg(root)
        .args([
            "--exclude=.git",
            "--exclude=node_modules",
            "--exclude=.DS_Store",
            ".",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| {
            EngineError::new(
                "marketplace_pack_failed",
                "The native marketplace packer could not start",
                true,
            )
        })?;
    let started = Instant::now();
    let status = loop {
        if cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(EngineError::cancelled());
        }
        if started.elapsed() > PACK_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(EngineError::new(
                "marketplace_pack_timeout",
                "The native marketplace packer timed out",
                true,
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(EngineError::new(
                    "marketplace_pack_failed",
                    "The native marketplace packer stopped unexpectedly",
                    true,
                ));
            }
        }
    };
    if !status.success() {
        return Err(EngineError::new(
            "marketplace_pack_failed",
            "The selected marketplace pack could not be archived",
            false,
        ));
    }
    read_bounded_file(
        &archive_path,
        MAX_PACK_ARCHIVE_BYTES,
        "marketplace_pack_too_large",
        "compressed marketplace pack",
        cancellation,
    )
}

fn read_avatar_bounded(
    raw_path: &str,
    cancellation: &CancellationFlag,
) -> Result<(Vec<u8>, String), EngineError> {
    cancellation.check()?;
    let path = Path::new(raw_path.trim());
    let content_type =
        hq_desktop_core::marketplace::avatar_content_type(raw_path).ok_or_else(|| {
            EngineError::new(
                "marketplace_avatar_invalid",
                "Avatar must be a PNG, JPEG, WebP, or GIF image",
                false,
            )
        })?;
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        EngineError::new(
            "marketplace_avatar_invalid",
            "The selected avatar file was not found",
            false,
        )
    })?;
    if !metadata.file_type().is_file() {
        return Err(EngineError::new(
            "marketplace_avatar_invalid",
            "The selected avatar must be a regular image file",
            false,
        ));
    }
    if metadata.len() > hq_desktop_core::marketplace::MAX_AVATAR_BYTES as u64 {
        return Err(EngineError::new(
            "marketplace_avatar_too_large",
            "Avatar exceeds the 2 MiB upload limit",
            false,
        ));
    }
    let bytes = read_bounded_file(
        path,
        hq_desktop_core::marketplace::MAX_AVATAR_BYTES,
        "marketplace_avatar_too_large",
        "avatar",
        cancellation,
    )?;
    if bytes.is_empty() {
        return Err(EngineError::new(
            "marketplace_avatar_invalid",
            "The selected avatar file is empty",
            false,
        ));
    }
    Ok((bytes, content_type))
}

fn read_bounded_file(
    path: &Path,
    maximum: usize,
    limit_code: &str,
    label: &str,
    cancellation: &CancellationFlag,
) -> Result<Vec<u8>, EngineError> {
    cancellation.check()?;
    let metadata = fs::metadata(path).map_err(|_| {
        EngineError::new(
            if label == "package.yaml" {
                "marketplace_manifest_invalid"
            } else {
                "marketplace_file_unreadable"
            },
            format!("{label} is missing or unreadable"),
            false,
        )
    })?;
    if !metadata.is_file() {
        return Err(EngineError::new(
            if label == "package.yaml" {
                "marketplace_manifest_invalid"
            } else {
                "marketplace_file_unreadable"
            },
            format!("{label} must be a regular file"),
            false,
        ));
    }
    if metadata.len() > maximum as u64 {
        return Err(EngineError::new(
            limit_code,
            format!("{label} exceeds its safe read limit"),
            false,
        ));
    }
    let file = File::open(path).map_err(|_| {
        EngineError::new(
            "marketplace_file_unreadable",
            format!("{label} could not be opened"),
            false,
        )
    })?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            EngineError::new(
                "marketplace_file_unreadable",
                format!("{label} could not be read"),
                false,
            )
        })?;
    cancellation.check()?;
    if bytes.len() > maximum {
        return Err(EngineError::new(
            limit_code,
            format!("{label} exceeds its safe read limit"),
            false,
        ));
    }
    Ok(bytes)
}

fn parse_publish_response(
    response: CloudResponse,
    pack: &PreparedPack,
    secret: &str,
) -> Result<Value, EngineError> {
    if !(200..300).contains(&response.status) {
        return Err(publish_response_error(response, pack, secret));
    }
    let listing = response
        .body
        .get("listing")
        .filter(|value| value.is_object())
        .unwrap_or(&response.body);
    let listing_id = listing
        .get("listingId")
        .or_else(|| listing.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            EngineError::new(
                "cloud_response_invalid",
                "Marketplace publish succeeded without a listing identifier",
                false,
            )
        })?;
    let listing_status = listing
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("pending_review");
    let creator_handle = listing
        .get("creatorHandle")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut notice = format!(
        "Published {}@{} — listing {} ({}).",
        pack.name, pack.version, listing_id, listing_status
    );
    if let Some(handle) = creator_handle {
        notice.push_str(&format!(" Attributed to @{handle}."));
    }
    let result = hq_desktop_core::marketplace::parse_publish_outcome(true, &notice, "").map_err(
        |error| {
            EngineError::new(
                "cloud_response_invalid",
                redact_message(&error.message, secret),
                false,
            )
        },
    )?;
    crate::to_value(result)
}

fn publish_response_error(
    response: CloudResponse,
    pack: &PreparedPack,
    secret: &str,
) -> EngineError {
    let code = response
        .body
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let detail = response
        .body
        .get("error")
        .or_else(|| response.body.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("Marketplace publish failed");
    let detail = redact_message(detail, secret);
    let parsed =
        hq_desktop_core::marketplace::parse_publish_outcome(false, "", &format!("Error: {detail}"))
            .expect_err("a failed publish outcome always returns PublishError");
    if code == "NOT_VERIFIED_CREATOR" || parsed.not_verified {
        return EngineError::new(
            "marketplace_creator_not_verified",
            "Only verified creators can publish to the marketplace; request creator access first",
            false,
        );
    }
    if response.status == 409 {
        return EngineError::new(
            "marketplace_version_exists",
            format!(
                "{}@{} is already published; bump package.yaml `version` and try again",
                pack.name, pack.version
            ),
            false,
        );
    }
    if response.status == 401 || response.status == 403 {
        return EngineError::new(
            "cloud_auth_required",
            "Sign in again before publishing to the marketplace",
            false,
        );
    }
    EngineError::new(
        "marketplace_publish_failed",
        parsed.message,
        response.status == 408 || response.status == 429 || response.status >= 500,
    )
}

fn redact_engine_error(error: EngineError, secret: &str) -> EngineError {
    EngineError::new(
        error.code,
        redact_message(&error.message, secret),
        error.retryable,
    )
}

fn redact_message(message: &str, secret: &str) -> String {
    let mut output = if secret.is_empty() {
        message.to_string()
    } else {
        message.replace(secret, "<redacted>")
    };
    if output.chars().count() > 512 {
        output = output.chars().take(512).collect();
        output.push('…');
    }
    output
}

fn derive_slug(name: &str) -> &str {
    name.strip_prefix("hq-pack-").unwrap_or(name)
}

fn summarize_contributes(contributes: &BTreeMap<String, Vec<String>>) -> String {
    contributes
        .iter()
        .filter(|(_, entries)| !entries.is_empty())
        .map(|(kind, entries)| format!("{kind}: {}", entries.join(", ")))
        .collect::<Vec<_>>()
        .join("; ")
}

fn valid_pack_name(name: &str) -> bool {
    name.strip_prefix("hq-pack-").is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    })
}

fn valid_publisher(publisher: &str) -> bool {
    publisher.strip_prefix('@').is_some_and(|scope| {
        !scope.is_empty()
            && scope
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            && scope
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

fn valid_semver(version: &str) -> bool {
    let mut build_parts = version.split('+');
    let version = build_parts.next().unwrap_or_default();
    let build = build_parts.next();
    if build_parts.next().is_some()
        || build.is_some_and(|value| !valid_semver_identifiers(value, false))
    {
        return false;
    }
    let (core, prerelease) = version
        .split_once('-')
        .map_or((version, None), |(core, pre)| (core, Some(pre)));
    let mut components = core.split('.');
    let numbers = [components.next(), components.next(), components.next()];
    if components.next().is_some()
        || numbers.iter().any(|component| {
            component.is_none_or(|value| {
                value.is_empty()
                    || !value.bytes().all(|byte| byte.is_ascii_digit())
                    || (value.len() > 1 && value.starts_with('0'))
            })
        })
    {
        return false;
    }
    prerelease.is_none_or(|pre| valid_semver_identifiers(pre, true))
}

fn valid_semver_identifiers(value: &str, reject_numeric_leading_zero: bool) -> bool {
    !value.is_empty()
        && value.split('.').all(|identifier| {
            !identifier.is_empty()
                && identifier
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && (!reject_numeric_leading_zero
                    || !identifier.bytes().all(|byte| byte.is_ascii_digit())
                    || identifier.len() == 1
                    || !identifier.starts_with('0'))
        })
}

fn valid_contribution_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn is_excluded_entry(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | ".DS_Store")
}

fn manifest_error(message: impl Into<String>) -> EngineError {
    EngineError::new("marketplace_manifest_invalid", message, false)
}

fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or_default();
        let third = chunk.get(2).copied().unwrap_or_default();
        output.push(ALPHABET[(first >> 2) as usize] as char);
        output.push(ALPHABET[(((first & 0b11) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(ALPHABET[(((second & 0b1111) << 2) | (third >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(ALPHABET[(third & 0b11_1111) as usize] as char);
        } else {
            output.push('=');
        }
    }
    output
}

struct TemporaryArchive {
    path: PathBuf,
}

impl TemporaryArchive {
    fn new() -> Result<Self, EngineError> {
        let path = std::env::temp_dir().join(format!(
            "hq-native-marketplace-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&path).map_err(|_| {
            EngineError::new(
                "marketplace_pack_failed",
                "A private temporary pack directory could not be created",
                true,
            )
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).map_err(|_| {
                EngineError::new(
                    "marketplace_pack_failed",
                    "The temporary pack directory could not be secured",
                    true,
                )
            })?;
        }
        Ok(Self { path })
    }
}

impl Drop for TemporaryArchive {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::fs;
    use std::sync::Mutex;

    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::domains::cloud::{execute_with_transport, CloudRequest, CloudResponse, HttpVerb};

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

        fn requests(&self) -> Vec<CloudRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl CloudTransport for MockTransport {
        fn send(
            &self,
            request: CloudRequest,
            cancellation: &CancellationFlag,
        ) -> Result<CloudResponse, EngineError> {
            cancellation.check()?;
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

    fn run(method: &str, params: Value, transport: &MockTransport) -> Result<Value, EngineError> {
        execute_with_transport(
            method,
            &params,
            &CancellationFlag::default(),
            &context(),
            transport,
        )
    }

    fn valid_pack() -> (TempDir, String) {
        let temporary = tempfile::tempdir().unwrap();
        let pack = temporary.path().join("pack");
        fs::create_dir_all(pack.join("skills/demo")).unwrap();
        fs::write(pack.join("skills/demo/SKILL.md"), "# Demo\n").unwrap();
        fs::write(
            pack.join("package.yaml"),
            r#"name: hq-pack-demo
version: 1.2.3
publisher: '@indigo'
access: public
description: Native marketplace demo
requires:
  hqCore: '>=14.2.0'
contributes:
  skills:
    - demo
"#,
        )
        .unwrap();
        (temporary, pack.to_string_lossy().into_owned())
    }

    #[test]
    fn publish_uses_authenticated_json_contract_and_core_result_parser() {
        let (_temporary, path) = valid_pack();
        let transport = MockTransport::returning([CloudResponse {
            status: 201,
            body: json!({
                "listing": {
                    "listingId": "lst_native_1",
                    "status": "pending_review",
                    "creatorHandle": "ada"
                }
            }),
        }]);

        let output = run(
            "publish_marketplace_pack",
            json!({"path": path}),
            &transport,
        )
        .unwrap();

        assert_eq!(output["listingId"], "lst_native_1");
        assert_eq!(output["status"], "pending_review");
        assert!(output["notice"]
            .as_str()
            .unwrap()
            .contains("Attributed to @ada"));
        let request = &transport.requests()[0];
        assert_eq!(request.method, HttpVerb::Post);
        assert_eq!(request.url, "https://vault.example.test/v1/listings");
        assert_eq!(request.bearer_token.as_deref(), Some("secret-bearer"));
        let body = request.body.as_ref().unwrap();
        assert_eq!(body["type"], "skill");
        assert_eq!(body["name"], "hq-pack-demo");
        assert_eq!(body["slug"], "demo");
        assert_eq!(body["version"], "1.2.3");
        assert_eq!(body["summary"], "Native marketplace demo");
        assert_eq!(body["contributes"], "skills: demo");
        assert!(body["tarball"].as_str().unwrap().starts_with("H4sI"));
    }

    #[test]
    fn publish_rejects_invalid_manifest_before_network() {
        let temporary = tempfile::tempdir().unwrap();
        let transport = MockTransport::default();

        let error = run(
            "publish_marketplace_pack",
            json!({"path": temporary.path().to_string_lossy()}),
            &transport,
        )
        .unwrap_err();

        assert_eq!(error.code, "marketplace_manifest_invalid");
        assert!(error.message.contains("package.yaml"));
        assert!(transport.requests().is_empty());
    }

    #[test]
    fn publish_rejects_oversize_source_before_pack_or_network() {
        let (_temporary, path) = valid_pack();
        let oversized = std::path::Path::new(&path).join("oversized.bin");
        let file = fs::File::create(&oversized).unwrap();
        file.set_len(MAX_PACK_SOURCE_BYTES + 1).unwrap();
        let transport = MockTransport::default();

        let error = run(
            "publish_marketplace_pack",
            json!({"path": path}),
            &transport,
        )
        .unwrap_err();

        assert_eq!(error.code, "marketplace_pack_too_large");
        assert!(transport.requests().is_empty());
    }

    #[test]
    fn publish_honors_cancellation_before_filesystem_or_network() {
        let (_temporary, path) = valid_pack();
        let transport = MockTransport::default();
        let cancellation = CancellationFlag::default();
        cancellation.cancel();

        let error = execute_with_transport(
            "publish_marketplace_pack",
            &json!({"path": path}),
            &cancellation,
            &context(),
            &transport,
        )
        .unwrap_err();

        assert_eq!(error.code, "request_cancelled");
        assert!(transport.requests().is_empty());
    }

    #[test]
    fn publish_classifies_creator_gate_without_leaking_token_or_payload() {
        let (_temporary, path) = valid_pack();
        let transport = MockTransport::returning([CloudResponse {
            status: 403,
            body: json!({
                "code": "NOT_VERIFIED_CREATOR",
                "error": "Only verified creators can publish: secret-bearer"
            }),
        }]);

        let error = run(
            "publish_marketplace_pack",
            json!({"path": path}),
            &transport,
        )
        .unwrap_err();

        assert_eq!(error.code, "marketplace_creator_not_verified");
        assert!(error
            .message
            .to_ascii_lowercase()
            .contains("verified creator"));
        assert!(!error.message.contains("secret-bearer"));
        assert!(!error.message.contains("H4sI"));
    }

    #[test]
    fn avatar_upload_is_bounded_authenticated_and_returns_parsed_url() {
        let temporary = tempfile::tempdir().unwrap();
        let avatar = temporary.path().join("avatar.png");
        fs::write(&avatar, [0x89, b'P', b'N', b'G']).unwrap();
        let transport = MockTransport::returning([CloudResponse {
            status: 200,
            body: json!({"avatarUrl": "https://cdn.example.test/avatar.png"}),
        }]);

        let output = run(
            "upload_creator_avatar",
            json!({"filePath": avatar.to_string_lossy()}),
            &transport,
        )
        .unwrap();

        assert_eq!(output, "https://cdn.example.test/avatar.png");
        let request = &transport.requests()[0];
        assert_eq!(request.method, HttpVerb::Post);
        assert_eq!(
            request.url,
            "https://vault.example.test/v1/creators/me/avatar"
        );
        assert_eq!(request.bearer_token.as_deref(), Some("secret-bearer"));
        assert_eq!(
            request.body,
            Some(json!({
                "contentType": "image/png",
                "data": "iVBORw=="
            }))
        );
    }

    #[test]
    fn avatar_rejects_unsupported_type_before_network() {
        let temporary = tempfile::tempdir().unwrap();
        let avatar = temporary.path().join("avatar.txt");
        fs::write(&avatar, b"not an image").unwrap();
        let transport = MockTransport::default();

        let error = run(
            "upload_creator_avatar",
            json!({"filePath": avatar.to_string_lossy()}),
            &transport,
        )
        .unwrap_err();

        assert_eq!(error.code, "marketplace_avatar_invalid");
        assert!(transport.requests().is_empty());
    }

    #[test]
    fn avatar_rejects_oversize_sparse_file_without_unbounded_read() {
        let temporary = tempfile::tempdir().unwrap();
        let avatar = temporary.path().join("avatar.png");
        let file = fs::File::create(&avatar).unwrap();
        file.set_len(hq_desktop_core::marketplace::MAX_AVATAR_BYTES as u64 + 1)
            .unwrap();
        let transport = MockTransport::default();

        let error = run(
            "upload_creator_avatar",
            json!({"filePath": avatar.to_string_lossy()}),
            &transport,
        )
        .unwrap_err();

        assert_eq!(error.code, "marketplace_avatar_too_large");
        assert!(transport.requests().is_empty());
    }

    #[test]
    fn avatar_honors_cancellation_before_file_read_or_network() {
        let temporary = tempfile::tempdir().unwrap();
        let avatar = temporary.path().join("avatar.png");
        fs::write(&avatar, [0x89, b'P', b'N', b'G']).unwrap();
        let transport = MockTransport::default();
        let cancellation = CancellationFlag::default();
        cancellation.cancel();

        let error = execute_with_transport(
            "upload_creator_avatar",
            &json!({"filePath": avatar.to_string_lossy()}),
            &cancellation,
            &context(),
            &transport,
        )
        .unwrap_err();

        assert_eq!(error.code, "request_cancelled");
        assert!(transport.requests().is_empty());
    }

    #[test]
    fn avatar_server_failure_is_retryable_and_redacts_bearer_token() {
        let temporary = tempfile::tempdir().unwrap();
        let avatar = temporary.path().join("avatar.png");
        fs::write(&avatar, [0x89, b'P', b'N', b'G']).unwrap();
        let transport = MockTransport::returning([CloudResponse {
            status: 503,
            body: json!({"error": "retry with secret-bearer"}),
        }]);

        let error = run(
            "upload_creator_avatar",
            json!({"filePath": avatar.to_string_lossy()}),
            &transport,
        )
        .unwrap_err();

        assert_eq!(error.code, "marketplace_avatar_upload_failed");
        assert!(error.retryable);
        assert!(!error.message.contains("secret-bearer"));
        assert!(!format!("{:?}", transport.requests()[0]).contains("iVBORw"));
    }

    #[test]
    fn semantic_version_validation_rejects_malformed_build_metadata() {
        assert!(valid_semver("1.2.3"));
        assert!(valid_semver("1.2.3-beta.1+native.7"));
        assert!(!valid_semver("1.2.3+"));
        assert!(!valid_semver("1.2.3+bad metadata"));
        assert!(!valid_semver("01.2.3"));
    }

    #[test]
    fn native_tarball_excludes_vcs_dependencies_and_finder_junk() {
        let (_temporary, path) = valid_pack();
        let root = std::path::Path::new(&path);
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join(".git/config"), "private").unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "private").unwrap();
        fs::write(root.join(".DS_Store"), "private").unwrap();

        let archive = create_archive(root, &CancellationFlag::default()).unwrap();
        let inspection = tempfile::tempdir().unwrap();
        let archive_path = inspection.path().join("pack.tar.gz");
        fs::write(&archive_path, archive).unwrap();
        let output = std::process::Command::new("/usr/bin/tar")
            .args(["-tzf"])
            .arg(&archive_path)
            .output()
            .unwrap();
        assert!(output.status.success());
        let listing = String::from_utf8(output.stdout).unwrap();

        assert!(listing.contains("package.yaml"));
        assert!(listing.contains("skills/demo/SKILL.md"));
        assert!(!listing.contains(".git"));
        assert!(!listing.contains("node_modules"));
        assert!(!listing.contains(".DS_Store"));
    }

    #[test]
    fn moderation_queue_is_authenticated_and_parsed_by_core() {
        let transport = MockTransport::returning([CloudResponse {
            status: 200,
            body: json!({
                "queue": [{
                    "id": "lst_pending_1",
                    "type": "skill",
                    "name": "Native Review",
                    "slug": "native-review",
                    "version": "1.0.0",
                    "author": "ada",
                    "submittedAt": "2026-07-26T20:00:00Z",
                    "files": ["package.yaml", "skills/demo/SKILL.md"],
                    "instructions": [{
                        "path": "skills/demo/SKILL.md",
                        "text": "# Demo"
                    }],
                    "injectionScan": [],
                    "versionLock": "lock-1"
                }]
            }),
        }]);

        let output = run("list_moderation_queue", json!({}), &transport).unwrap();

        assert_eq!(output[0]["id"], "lst_pending_1");
        assert_eq!(output[0]["versionLock"], "lock-1");
        let request = &transport.requests()[0];
        assert_eq!(request.method, HttpVerb::Get);
        assert_eq!(
            request.url,
            "https://vault.example.test/v1/moderation/queue"
        );
        assert_eq!(request.bearer_token.as_deref(), Some("secret-bearer"));
        assert_eq!(request.body, None);
    }

    #[test]
    fn moderation_queue_admin_denial_is_actionable_and_redacted() {
        let transport = MockTransport::returning([CloudResponse {
            status: 403,
            body: json!({"error": "secret-bearer may not review"}),
        }]);

        let error = run("list_moderation_queue", json!({}), &transport).unwrap_err();

        assert_eq!(error.code, "marketplace_moderation_queue_failed");
        assert!(error.message.contains("admin only"));
        assert!(!error.message.contains("secret-bearer"));
        assert!(!error.retryable);
    }

    #[test]
    fn public_listing_detail_uses_no_bearer_and_rejects_unsafe_ids() {
        let transport = MockTransport::returning([CloudResponse {
            status: 200,
            body: json!({
                "listing": {
                    "id": "lst_public_1",
                    "type": "skill",
                    "name": "Native",
                    "slug": "native",
                    "version": "1.0.0",
                    "author": "ada",
                    "createdAt": "2026-07-26T20:00:00Z",
                    "downloadUrl": "https://download.example.test/native"
                }
            }),
        }]);

        let output = run(
            "get_marketplace_listing",
            json!({"id": "lst_public_1"}),
            &transport,
        )
        .unwrap();

        assert_eq!(output["id"], "lst_public_1");
        assert_eq!(
            output["downloadUrl"],
            "https://download.example.test/native"
        );
        let request = &transport.requests()[0];
        assert_eq!(request.method, HttpVerb::Get);
        assert_eq!(
            request.url,
            "https://vault.example.test/v1/listings/lst_public_1"
        );
        assert_eq!(request.bearer_token, None);

        let rejected = MockTransport::default();
        let error = run(
            "get_marketplace_listing",
            json!({"id": "../internal"}),
            &rejected,
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid_params");
        assert!(rejected.requests().is_empty());
    }

    #[test]
    fn public_creator_profile_uses_no_bearer_and_core_projection() {
        let transport = MockTransport::returning([CloudResponse {
            status: 200,
            body: json!({
                "creator": {
                    "handle": "ada_native",
                    "displayName": "Ada",
                    "bio": "Native apps",
                    "socialLinks": []
                },
                "listings": []
            }),
        }]);

        let output = run(
            "get_creator_profile",
            json!({"handle": "ada_native"}),
            &transport,
        )
        .unwrap();

        assert_eq!(output["creator"]["handle"], "ada_native");
        let request = &transport.requests()[0];
        assert_eq!(
            request.url,
            "https://vault.example.test/v1/creators/ada_native"
        );
        assert_eq!(request.bearer_token, None);
    }

    #[test]
    fn my_creator_maps_not_claimed_to_null() {
        let transport = MockTransport::returning([CloudResponse {
            status: 404,
            body: json!({"code": "NO_CREATOR"}),
        }]);

        let output = run("get_my_creator", json!({}), &transport).unwrap();

        assert_eq!(output, Value::Null);
        let request = &transport.requests()[0];
        assert_eq!(request.url, "https://vault.example.test/v1/creators/me");
        assert_eq!(request.bearer_token.as_deref(), Some("secret-bearer"));
    }

    #[test]
    fn claim_creator_handle_preserves_typed_claim_result_and_body() {
        let transport = MockTransport::returning([CloudResponse {
            status: 201,
            body: json!({
                "handle": "ada-native",
                "uid": "crt_1",
                "createdAt": "2026-07-26T20:00:00Z"
            }),
        }]);

        let output = run(
            "claim_creator_handle",
            json!({"handle": "  ada-native  "}),
            &transport,
        )
        .unwrap();

        assert_eq!(output["handle"], "ada-native");
        let request = &transport.requests()[0];
        assert_eq!(request.method, HttpVerb::Post);
        assert_eq!(request.url, "https://vault.example.test/v1/creators/claim");
        assert_eq!(request.body, Some(json!({"handle": "ada-native"})));
    }

    #[test]
    fn profile_update_preserves_partial_merge_contract() {
        let transport = MockTransport::returning([CloudResponse {
            status: 200,
            body: json!({
                "handle": "ada-native",
                "profile": {
                    "bio": "",
                    "tipUrl": "https://example.test/tip",
                    "socialLinks": []
                }
            }),
        }]);

        let output = run(
            "update_creator_profile",
            json!({
                "bio": "",
                "tipUrl": "https://example.test/tip"
            }),
            &transport,
        )
        .unwrap();

        assert_eq!(output["handle"], "ada-native");
        let request = &transport.requests()[0];
        assert_eq!(request.method, HttpVerb::Put);
        assert_eq!(
            request.body,
            Some(json!({
                "bio": "",
                "tipUrl": "https://example.test/tip"
            }))
        );
    }

    #[test]
    fn creator_access_request_trims_optional_fields_and_parses_confirmation() {
        let transport = MockTransport::returning([CloudResponse {
            status: 202,
            body: json!({"message": "Application received."}),
        }]);

        let output = run(
            "request_creator_access",
            json!({
                "reason": "  I build native tools. ",
                "handle": "  ada-native "
            }),
            &transport,
        )
        .unwrap();

        assert_eq!(output, "Application received.");
        assert_eq!(
            transport.requests()[0].body,
            Some(json!({
                "reason": "I build native tools.",
                "handle": "ada-native"
            }))
        );
    }

    #[test]
    fn creator_application_queue_and_decision_use_admin_contracts() {
        let list_transport = MockTransport::returning([CloudResponse {
            status: 200,
            body: json!({
                "applications": [{
                    "applicationId": "app_1",
                    "applicantEmail": "ada@example.test",
                    "handle": "ada-native",
                    "reason": "Native tools",
                    "status": "pending"
                }]
            }),
        }]);

        let applications = run("list_creator_applications", json!({}), &list_transport).unwrap();
        assert_eq!(applications[0]["applicationId"], "app_1");
        assert_eq!(
            list_transport.requests()[0].url,
            "https://vault.example.test/v1/creators/applications"
        );

        let decide_transport = MockTransport::returning([CloudResponse {
            status: 200,
            body: json!({
                "applicationId": "app_1",
                "status": "approved",
                "reviewedBy": "admin",
                "reviewedAt": "2026-07-26T20:10:00Z"
            }),
        }]);
        let decision = run(
            "decide_creator_application",
            json!({
                "id": "app_1",
                "decision": "approved",
                "note": "  Strong native work. "
            }),
            &decide_transport,
        )
        .unwrap();
        assert_eq!(decision["status"], "approved");
        let request = &decide_transport.requests()[0];
        assert_eq!(
            request.url,
            "https://vault.example.test/v1/creators/applications/app_1"
        );
        assert_eq!(
            request.body,
            Some(json!({
                "decision": "approve",
                "note": "Strong native work."
            }))
        );
    }

    #[test]
    fn moderation_decision_forwards_version_lock_and_normalizes_decision() {
        let transport = MockTransport::returning([CloudResponse {
            status: 200,
            body: json!({
                "listing": {"status": "approved"},
                "note": "Looks good"
            }),
        }]);

        let output = run(
            "decide_moderation_listing",
            json!({
                "id": "lst_pending_1",
                "decision": "approved",
                "note": "  Looks good ",
                "versionLock": " lock-1 "
            }),
            &transport,
        )
        .unwrap();

        assert_eq!(output["status"], "approved");
        assert_eq!(
            transport.requests()[0].body,
            Some(json!({
                "decision": "approve",
                "note": "Looks good",
                "versionLock": "lock-1"
            }))
        );
    }

    #[test]
    fn yank_requires_reason_and_returns_core_result() {
        let rejected = MockTransport::default();
        let error = run(
            "yank_marketplace_listing",
            json!({"id": "lst_1", "reason": "   "}),
            &rejected,
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid_params");
        assert!(rejected.requests().is_empty());

        let transport = MockTransport::returning([CloudResponse {
            status: 200,
            body: json!({
                "listing": {"status": "yanked"},
                "note": "Existing installs remain."
            }),
        }]);
        let output = run(
            "yank_marketplace_listing",
            json!({"id": "lst_1", "reason": "  Unsafe instructions  "}),
            &transport,
        )
        .unwrap();
        assert_eq!(output["id"], "lst_1");
        assert_eq!(output["status"], "yanked");
        assert_eq!(
            transport.requests()[0].body,
            Some(json!({"reason": "Unsafe instructions"}))
        );
    }

    #[test]
    fn install_metrics_use_typed_company_scope_body() {
        let transport = MockTransport::returning([CloudResponse {
            status: 204,
            body: Value::Null,
        }]);

        let output = run(
            "record_marketplace_install",
            json!({
                "listingId": "lst_1",
                "scope": {"kind": "company", "slug": "indigo"}
            }),
            &transport,
        )
        .unwrap();

        assert_eq!(output, Value::Null);
        let request = &transport.requests()[0];
        assert_eq!(
            request.url,
            "https://vault.example.test/v1/listings/lst_1/installs"
        );
        assert_eq!(
            request.body,
            Some(json!({"scope": "company", "companySlug": "indigo"}))
        );
    }
}
