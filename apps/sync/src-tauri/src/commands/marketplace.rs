//! Creator-marketplace browse client (US-008).
//!
//! Backs the desktop-alt **Marketplace** tab. Calls the PUBLIC hq-pro listings
//! routes — `GET /v1/listings` (browse) and `GET /v1/listings/{id}` (detail) —
//! both declared `authorizationType: NONE`, so NO Cognito token is attached.
//! Everything returned has already passed through the server-side
//! `toPublicListing` allowlist (US-005): only `approved` listings, redacted to a
//! public shape that never leaks moderation state, the author's internal uid, or
//! the raw S3 key. We mirror that public projection 1:1 here.
//!
//! Wire contract (hq-pro `src/listings/public-projection.ts`):
//!   * Browse  → `{ "listings": PublicListing[] }`
//!   * Detail  → `{ "listing": PublicListing & { downloadUrl } }`
//!   * PublicListing = { id, type, name, slug, version, author, summary?,
//!     contributes?, createdAt } — `author` is the public HANDLE string (not an
//!     object; the internal `creatorUid` is never exposed).
//!
//! Base URL resolution reuses the core marketplace helper, which follows the
//! same env/config/default precedence as the sync pipeline. The HTTP client is
//! the shared timeout-guarded `util::client_info::build_client`.
//!
//! These are app-registered Tauri commands authorized by `core:default` in
//! `capabilities/desktop-alt.json` (custom commands are not gated by per-command
//! permission identifiers), so no allow-* tokens are added. Unlike the Board /
//! Library readers this surface is intentionally NOT behind the Indigo gate: the
//! marketplace is public, so any signed-in (or not) desktop user can browse it.

use std::path::Path;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

#[allow(unused_imports)]
pub use hq_desktop_core::marketplace::{
    api_base, avatar_content_type, extract_error_message, install_argv, install_event_body,
    is_not_verified_error, is_safe_company_slug, is_safe_id, marketplace_source,
    parse_application_decision_response, parse_avatar_upload_response, parse_browse_response,
    parse_claim_response, parse_creator_applications_response, parse_decision_response,
    parse_detail_response, parse_install_event_response, parse_listing_notice,
    parse_my_creator_response, parse_profile_update_response, parse_public_profile_response,
    parse_publish_outcome, parse_queue_response, parse_request_access_response,
    parse_yank_response, read_avatar_file, resolve_company_dir, resolve_hq_folder, role_is_admin,
    urlencoding_encode, validate_publish_path, ApplicationDecision, ApplicationDecisionResult,
    ApplicationsEnvelope, BrowseEnvelope, ClaimError, ClaimResult, CreatorApplication,
    CreatorProfile, Decision, DetailEnvelope, InjectionFlag, InstallScope, InstructionDoc,
    MarketplaceListing, MarketplaceListingDetail, ModerationDecisionResult, ModerationQueueItem,
    MyCreator, MyCreatorEnvelope, PublicCreatorPreview, PublishError, PublishResult,
    QueueEnvelope, SocialLink, YankResult, MAX_AVATAR_BYTES,
};

use crate::commands::sync::{resolve_jwt, resolve_vault_api_url};
use crate::commands::vault_client::VaultClient;
use crate::util::client_info::build_client;
use crate::util::logfile::log;
use crate::util::paths;

// ---- commands ---------------------------------------------------------------

/// Browse approved marketplace listings. Public route — NO auth token attached.
/// An optional `query` is forwarded as `?q=` so the server filters server-side
/// (the UI also filters client-side over the returned set for instant feedback).
#[tauri::command]
pub async fn list_marketplace_listings(
    query: Option<String>,
) -> Result<Vec<MarketplaceListing>, String> {
    let base = api_base()?;
    let mut url = format!("{base}/v1/listings");
    if let Some(q) = query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        url = format!("{url}?q={}", urlencoding_encode(q));
    }

    let res = build_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("listings fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("listings read: {e}"))?;

    parse_browse_response(status, &text)
}

/// Fetch one approved listing's public detail (incl. the presigned download
/// URL). Public route — NO auth token attached.
#[tauri::command]
pub async fn get_marketplace_listing(id: String) -> Result<MarketplaceListingDetail, String> {
    let id = id.trim();
    if !is_safe_id(id) {
        return Err(format!("invalid listing id: {id:?}"));
    }
    let base = api_base()?;
    let url = format!("{base}/v1/listings/{id}");

    let res = build_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("listing fetch: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| format!("listing read: {e}"))?;

    parse_detail_response(status, &text)
}

/// Yank (emergency takedown) a marketplace listing. Admin-gated on the SERVER
/// (`@getindigo.ai` id_token) — this command forwards the caller's bearer token
/// and relays the outcome. A `reason` is required (recorded for the audit trail).
///
/// On success the listing is flipped to `status = yanked` server-side and
/// instantly disappears from public browse + detail + install — a runtime status
/// flip, no deploy. Already-installed users are NOT auto-removed in v1 (the
/// returned `note` says so; the panel renders it).
#[tauri::command]
pub async fn yank_marketplace_listing(id: String, reason: String) -> Result<YankResult, String> {
    let id = id.trim();
    if !is_safe_id(id) {
        return Err(format!("invalid listing id: {id:?}"));
    }
    let reason = reason.trim();
    if reason.is_empty() {
        return Err("a reason is required to yank a listing".to_string());
    }

    let base = api_base()?;
    let url = format!("{base}/v1/moderation/listings/{id}/yank");
    // Authed: the moderation routes are admin-gated server-side, so we MUST
    // attach the caller's bearer token. The server is the authorization boundary.
    let jwt = resolve_jwt().await?;

    let res = build_client()
        .post(&url)
        .bearer_auth(&jwt)
        .json(&serde_json::json!({ "reason": reason }))
        .send()
        .await
        .map_err(|e| format!("yank request: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| format!("yank read: {e}"))?;

    parse_yank_response(id, status, &text)
}

/// List the moderation queue (pending_review listings). Admin-gated SERVER-SIDE;
/// we attach the caller's bearer token and relay the outcome. A non-admin gets a
/// 403 (surfaced as a clear "admin only" error so the panel can lock itself).
#[tauri::command]
pub async fn list_moderation_queue() -> Result<Vec<ModerationQueueItem>, String> {
    let base = api_base()?;
    let url = format!("{base}/v1/moderation/queue");
    let jwt = resolve_jwt().await?;

    let res = build_client()
        .get(&url)
        .bearer_auth(&jwt)
        .send()
        .await
        .map_err(|e| format!("moderation queue fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("moderation queue read: {e}"))?;

    parse_queue_response(status, &text)
}

/// Approve or reject a pending_review listing (admin-gated server-side). `note`
/// is optional (recorded for the audit trail). On approve the listing flips to
/// `approved` and becomes public; on reject it flips to `rejected`. Carries the
/// optimistic-lock token (when known) so a concurrent approve+reject race is a
/// 409, not a silent inconsistency.
#[tauri::command]
pub async fn decide_moderation_listing(
    id: String,
    decision: String,
    note: Option<String>,
    version_lock: Option<String>,
) -> Result<ModerationDecisionResult, String> {
    let id = id.trim();
    if !is_safe_id(id) {
        return Err(format!("invalid listing id: {id:?}"));
    }
    let decision = Decision::from_str(&decision)?;
    let note = note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());

    let base = api_base()?;
    let url = format!("{base}/v1/moderation/listings/{id}");
    let jwt = resolve_jwt().await?;

    let mut body = serde_json::json!({ "decision": decision.wire() });
    if let Some(n) = &note {
        body["note"] = serde_json::Value::String(n.clone());
    }
    if let Some(v) = version_lock
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        body["versionLock"] = serde_json::Value::String(v.to_string());
    }

    let res = build_client()
        .post(&url)
        .bearer_auth(&jwt)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("moderation decide request: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("moderation decide read: {e}"))?;

    parse_decision_response(id, decision, status, &text)
}

/// Verify, against vault membership truth, that the signed-in operator is an
/// admin/owner of `company_slug`. Default-deny: any failure to positively
/// confirm an admin/owner membership for that exact company → error.
async fn assert_company_admin(company_slug: &str) -> Result<(), String> {
    let vault_url = resolve_vault_api_url()?;
    let jwt = resolve_jwt().await?;
    let vault = VaultClient::new(&vault_url, &jwt);

    // Find the company entity by slug, then confirm the caller has an
    // admin/owner membership for that entity's uid.
    let entity = vault
        .find_my_company_by_slug(company_slug)
        .await
        .map_err(|e| format!("resolve company '{company_slug}': {e}"))?
        .ok_or_else(|| format!("company '{company_slug}' not found in your cloud"))?;
    if entity.deleted {
        return Err(format!("company '{company_slug}' is deleted"));
    }

    // Resolve the caller's own person entity (oldest = canonical, same heuristic
    // as workspaces.rs), then list that person's memberships.
    let mut persons = vault
        .list_entities_by_type("person")
        .await
        .map_err(|e| format!("list person entities: {e}"))?;
    persons.sort_by(|a, b| match a.created_at.cmp(&b.created_at) {
        std::cmp::Ordering::Equal => a.uid.cmp(&b.uid),
        ord => ord,
    });
    let person = persons
        .into_iter()
        .next()
        .ok_or_else(|| "no person entity for the signed-in user".to_string())?;

    let memberships = vault
        .list_memberships(&person.uid)
        .await
        .map_err(|e| format!("list memberships: {e}"))?;

    let admin = memberships.iter().any(|m| {
        m.company_uid == entity.uid
            && m.status.eq_ignore_ascii_case("active")
            && role_is_admin(m.role.as_deref())
    });
    if !admin {
        return Err(format!(
            "company install requires company-admin: you are not an admin of '{company_slug}'"
        ));
    }
    Ok(())
}

/// Install a marketplace pack into the chosen scope. Streams `hq install` output
/// to the window as `marketplace:install-progress` lines, terminating with
/// `marketplace:install-complete` / `marketplace:install-error`.
///
/// Security (enforced here, not in the UI):
///   * Company scope re-verifies admin via vault membership truth (default-deny).
///   * Company target is contained to `companies/{co}/` (no cross-company write).
///   * Hook-consent is preserved (no `--allow-hooks`) so wiring is never silent —
///     including on teammates' machines after the pack syncs.
#[tauri::command]
pub async fn install_marketplace_pack(
    app: AppHandle,
    slug: String,
    version: Option<String>,
    scope: InstallScope,
) -> Result<(), String> {
    let source = marketplace_source(&slug, version.as_deref())?;
    let hq_root = resolve_hq_folder();

    // ---- Security gate: company scope requires admin + path containment ----
    if let InstallScope::Company { slug: co } = &scope {
        // (a) Path containment FIRST (cheap, no network) — reject a malformed or
        // escaping slug before we ever touch the vault or spawn a process.
        let company_dir = resolve_company_dir(&hq_root, co)?;
        log(
            "marketplace",
            &format!(
                "company install target contained at {}",
                company_dir.display()
            ),
        );
        // (b) Admin gate against vault truth — default-deny on any failure.
        assert_company_admin(co).await?;
        log(
            "marketplace",
            &format!("admin gate passed for company '{co}' install of {source}"),
        );
    }

    let argv = install_argv(&source, &scope);
    stream_install(&app, &source, &scope, &hq_root, argv).await
}

/// Spawn `hq install …`, relaying stdout/stderr as progress events and a terminal
/// complete/error event. Hook-consent prompts the CLI emits flow through as
/// progress lines so the UI can surface them.
async fn stream_install(
    app: &AppHandle,
    source: &str,
    scope: &InstallScope,
    hq_root: &Path,
    argv: Vec<String>,
) -> Result<(), String> {
    let hq = paths::resolve_bin("hq");
    let scope_label = match scope {
        InstallScope::Personal => "personal".to_string(),
        InstallScope::Company { slug } => format!("company:{slug}"),
    };
    log(
        "marketplace",
        &format!("install `hq {}` (scope={scope_label})", argv.join(" ")),
    );

    let mut cmd = paths::tokio_spawn_command(&hq, &[]);
    let mut child = cmd
        .args(&argv)
        // node-shebang PATH fix — same as packages.rs.
        .env("PATH", paths::child_path())
        .current_dir(hq_root)
        .env("HQ_NO_UPDATE_CHECK", "1")
        .env("HQ_ROOT", hq_root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn `hq {}`: {e}", argv.join(" ")))?;

    let emit_line = |app: &AppHandle, source: &str, scope_label: &str, line: String| {
        let _ = app.emit(
            "marketplace:install-progress",
            serde_json::json!({ "source": source, "scope": scope_label, "line": line }),
        );
    };

    if let Some(out) = child.stdout.take() {
        let app = app.clone();
        let source = source.to_string();
        let scope_label = scope_label.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emit_line(&app, &source, &scope_label, line);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let app = app.clone();
        let source = source.to_string();
        let scope_label = scope_label.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emit_line(&app, &source, &scope_label, line);
            }
        });
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("await `hq {}`: {e}", argv.join(" ")))?;

    if status.success() {
        let _ = app.emit(
            "marketplace:install-complete",
            serde_json::json!({ "source": source, "scope": scope_label }),
        );
        Ok(())
    } else {
        let msg = format!(
            "`hq {}` exited {}",
            argv.join(" "),
            status.code().unwrap_or(-1)
        );
        let _ = app.emit(
            "marketplace:install-error",
            serde_json::json!({ "source": source, "scope": scope_label, "message": msg }),
        );
        Err(msg)
    }
}

/// Record a marketplace install event (best-effort install metrics, US-019).
/// Forwards the caller's bearer token to `POST /v1/listings/{id}/installs`; the
/// installer uid is derived server-side from the token, and the body carries the
/// install scope (personal | company + companySlug). Mirrors
/// `yank_marketplace_listing` / `decide_moderation_listing` (authed bearer
/// forwarding).
///
/// The desktop install flow calls this fire-and-forget AFTER a successful install
/// and IGNORES the outcome — a metrics write must never fail or block an install.
/// The typed `Result` exists so a caller (or test) that cares can observe it.
#[tauri::command]
pub async fn record_marketplace_install(
    listing_id: String,
    scope: InstallScope,
) -> Result<(), String> {
    let id = listing_id.trim();
    if !is_safe_id(id) {
        return Err(format!("invalid listing id: {id:?}"));
    }
    let body = install_event_body(&scope)?;

    let base = api_base()?;
    let url = format!("{base}/v1/listings/{id}/installs");
    // Authed: the installer uid is read from the bearer token's Cognito sub, so we
    // MUST attach the caller's token (same pattern as yank / decide).
    let jwt = resolve_jwt().await?;

    let res = build_client()
        .post(&url)
        .bearer_auth(&jwt)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("install metrics request: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("install metrics read: {e}"))?;

    parse_install_event_response(status, &text)
}

/// Publish a local skill/worker directory to the marketplace by shelling out to
/// the US-004 `hq publish <path>` CLI. Streams the CLI's stdout/stderr to the
/// window as `marketplace:publish-progress` lines, and returns a typed
/// `PublishResult` (listing id + `pending_review` status) on success.
///
/// On failure the returned `PublishError` carries the CLI's message and a
/// `not_verified` flag so the panel can show the request-access prompt for the
/// verified-creator gate (US-011) vs. an inline validation error otherwise.
///
/// Verification + validation are enforced by the CLI/server, never trusted from
/// the UI — this command is a thin, auth-passthrough wrapper (the CLI reads the
/// cached Cognito token itself, exactly like US-009's install path).
#[tauri::command]
pub async fn publish_marketplace_pack(
    app: AppHandle,
    path: String,
) -> Result<PublishResult, PublishError> {
    let dir = validate_publish_path(&path).map_err(|message| PublishError {
        message,
        not_verified: false,
    })?;
    let hq_root = resolve_hq_folder();
    let hq = paths::resolve_bin("hq");

    let path_str = dir.to_string_lossy().to_string();
    log("marketplace", &format!("publish `hq publish {path_str}`"));

    let mut cmd = paths::tokio_spawn_command(&hq, &[]);
    let mut child = cmd
        .args(["publish", &path_str])
        .env("PATH", paths::child_path())
        .current_dir(&hq_root)
        .env("HQ_NO_UPDATE_CHECK", "1")
        .env("HQ_ROOT", &hq_root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| PublishError {
            message: format!("spawn `hq publish`: {e}"),
            not_verified: false,
        })?;

    // Capture stdout + stderr fully (we need them to parse the result), while
    // ALSO relaying each line to the UI as live progress.
    let stdout_acc = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let stderr_acc = std::sync::Arc::new(std::sync::Mutex::new(String::new()));

    let mut handles = Vec::new();
    if let Some(out) = child.stdout.take() {
        let app = app.clone();
        let acc = stdout_acc.clone();
        handles.push(tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "marketplace:publish-progress",
                    serde_json::json!({ "stream": "stdout", "line": line }),
                );
                if let Ok(mut s) = acc.lock() {
                    s.push_str(&line);
                    s.push('\n');
                }
            }
        }));
    }
    if let Some(err) = child.stderr.take() {
        let app = app.clone();
        let acc = stderr_acc.clone();
        handles.push(tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app.emit(
                    "marketplace:publish-progress",
                    serde_json::json!({ "stream": "stderr", "line": line }),
                );
                if let Ok(mut s) = acc.lock() {
                    s.push_str(&line);
                    s.push('\n');
                }
            }
        }));
    }

    let status = child.wait().await.map_err(|e| PublishError {
        message: format!("await `hq publish`: {e}"),
        not_verified: false,
    })?;
    // Ensure both reader tasks have drained before we read the buffers.
    for h in handles {
        let _ = h.await;
    }

    let stdout = stdout_acc.lock().map(|s| s.clone()).unwrap_or_default();
    let stderr = stderr_acc.lock().map(|s| s.clone()).unwrap_or_default();

    match parse_publish_outcome(status.success(), &stdout, &stderr) {
        Ok(result) => {
            let _ = app.emit(
                "marketplace:publish-complete",
                serde_json::json!({ "listingId": result.listing_id, "status": result.status }),
            );
            Ok(result)
        }
        Err(err) => {
            let _ = app.emit(
                "marketplace:publish-error",
                serde_json::json!({ "message": err.message, "notVerified": err.not_verified }),
            );
            Err(err)
        }
    }
}

/// Open a native folder picker for the Submit flow and return the chosen pack
/// directory (or `None` if the user cancelled). Mirrors `folder_picker::pick_folder`
/// but titled for choosing a skill/worker pack to publish. Holds a `ModalGuard`
/// for the dialog's lifetime so the popover/window doesn't steal key-window focus
/// and dismiss the panel.
#[tauri::command]
pub async fn pick_pack_directory() -> Result<Option<String>, String> {
    let _guard = crate::tray::ModalGuard::new();
    let result = rfd::AsyncFileDialog::new()
        .set_title("Choose a skill or worker folder to publish")
        .pick_folder()
        .await;
    Ok(result.map(|handle| handle.path().to_string_lossy().to_string()))
}

/// Request verified-creator access (the unverified Submit affordance, US-011).
/// POSTs `/v1/creators/request-access` with the caller's bearer token, a required
/// `reason` (the applicant's pitch), and an optional `handle`; returns the
/// server's human guidance message. The server records the application and an
/// Indigo admin reviews it out-of-band (the creator-application review funnel).
///
/// The wire contract is `{ reason: string, handle?: string }`. The server replies
/// 202 `{ status, code, applicationId, requestAccessPath }` on first submission,
/// or 409 `{ code: "APPLICATION_PENDING", error, applicationId }` when the caller
/// already has a pending application — the parser surfaces that as a clear
/// "already pending" message so the panel can render the duplicate state.
#[tauri::command]
pub async fn request_creator_access(
    reason: Option<String>,
    handle: Option<String>,
) -> Result<String, String> {
    let base = api_base()?;
    let url = format!("{base}/v1/creators/request-access");
    let jwt = resolve_jwt().await?;

    let reason = reason
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty());
    let handle = handle
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty());
    let mut body = match &reason {
        Some(r) => serde_json::json!({ "reason": r }),
        None => serde_json::json!({}),
    };
    if let Some(h) = &handle {
        body["handle"] = serde_json::Value::String(h.clone());
    }

    let res = build_client()
        .post(&url)
        .bearer_auth(&jwt)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request-access request: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("request-access read: {e}"))?;

    parse_request_access_response(status, &text)
}

/// List pending creator-access applications (admin-gated SERVER-SIDE). We attach
/// the caller's bearer token and relay the outcome; a non-admin gets a 403
/// (surfaced as a clear "admin only" error so the panel locks its Requests view).
#[tauri::command]
pub async fn list_creator_applications() -> Result<Vec<CreatorApplication>, String> {
    let base = api_base()?;
    let url = format!("{base}/v1/creators/applications");
    let jwt = resolve_jwt().await?;

    let res = build_client()
        .get(&url)
        .bearer_auth(&jwt)
        .send()
        .await
        .map_err(|e| format!("creator applications fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("creator applications read: {e}"))?;

    parse_creator_applications_response(status, &text)
}

/// Approve or deny a pending creator-access application (admin-gated server-side).
/// `note` is optional (recorded for the audit trail). On approve the applicant
/// becomes a verified creator; on deny the application is closed. Maps the server
/// statuses: 401 → sign-in required, 403 → admin only, 404 → applicant has no
/// entity row (approve), 409 → the application is no longer pending.
#[tauri::command]
pub async fn decide_creator_application(
    id: String,
    decision: String,
    note: Option<String>,
) -> Result<ApplicationDecisionResult, String> {
    let id = id.trim();
    if !is_safe_id(id) {
        return Err(format!("invalid application id: {id:?}"));
    }
    let decision = ApplicationDecision::from_str(&decision)?;
    let note = note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());

    let base = api_base()?;
    let url = format!("{base}/v1/creators/applications/{id}");
    let jwt = resolve_jwt().await?;

    let mut body = serde_json::json!({ "decision": decision.wire() });
    if let Some(n) = &note {
        body["note"] = serde_json::Value::String(n.clone());
    }

    let res = build_client()
        .post(&url)
        .bearer_auth(&jwt)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("creator application decide request: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("creator application decide read: {e}"))?;

    parse_application_decision_response(id, decision, status, &text)
}

/// Claim a creator handle. Authed (JWT). On success returns the linked handle;
/// on failure returns a typed `ClaimError` that classifies the duplicate (409 →
/// `taken`), reserved/confusable (403), and malformed (400) cases so the panel
/// surfaces the right inline feedback.
#[tauri::command]
pub async fn claim_creator_handle(handle: String) -> Result<ClaimResult, ClaimError> {
    let trimmed = handle.trim();
    if trimmed.is_empty() {
        return Err(ClaimError {
            message: "enter a handle to claim".to_string(),
            code: "HANDLE_FORMAT_INVALID".to_string(),
            taken: false,
        });
    }

    let base = api_base().map_err(|message| ClaimError {
        message,
        code: String::new(),
        taken: false,
    })?;
    let url = format!("{base}/v1/creators/claim");
    let jwt = resolve_jwt().await.map_err(|message| ClaimError {
        message,
        code: String::new(),
        taken: false,
    })?;

    let res = build_client()
        .post(&url)
        .bearer_auth(&jwt)
        .json(&serde_json::json!({ "handle": trimmed }))
        .send()
        .await
        .map_err(|e| ClaimError {
            message: format!("claim request: {e}"),
            code: String::new(),
            taken: false,
        })?;
    let status = res.status();
    let text = res.text().await.map_err(|e| ClaimError {
        message: format!("claim read: {e}"),
        code: String::new(),
        taken: false,
    })?;

    parse_claim_response(status, &text)
}

/// Update the caller's OWN creator profile (bio, socialLinks, tipUrl). Authed
/// (JWT). Only the fields the panel sends are forwarded — an absent field leaves
/// the stored value unchanged; an explicit empty string/array clears it (the
/// server's partial-merge semantics). Every URL is http(s)-validated SERVER-SIDE
/// (a 400 with the reason is surfaced inline). Returns the merged profile.
#[tauri::command]
pub async fn update_creator_profile(
    bio: Option<String>,
    social_links: Option<Vec<SocialLink>>,
    tip_url: Option<String>,
) -> Result<CreatorProfile, String> {
    let base = api_base()?;
    let url = format!("{base}/v1/creators/me/profile");
    let jwt = resolve_jwt().await?;

    // Build a partial body: only include keys the caller actually supplied so
    // the server's "absent = leave unchanged" merge works as intended.
    let mut body = serde_json::Map::new();
    if let Some(b) = bio {
        body.insert("bio".to_string(), serde_json::Value::String(b));
    }
    if let Some(t) = tip_url {
        body.insert("tipUrl".to_string(), serde_json::Value::String(t));
    }
    if let Some(links) = social_links {
        body.insert(
            "socialLinks".to_string(),
            serde_json::to_value(links).map_err(|e| format!("encode social links: {e}"))?,
        );
    }

    let res = build_client()
        .put(&url)
        .bearer_auth(&jwt)
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|e| format!("profile update request: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("profile update read: {e}"))?;

    parse_profile_update_response(status, &text)
}

/// Upload the caller's OWN avatar. Authed (JWT). Reads the picked file, base64-
/// encodes it, and POSTs `{ contentType, data }`. The server enforces image-only
/// + ≤2 MiB; we pre-check both locally for fast feedback. Returns the presigned
/// avatar URL so the panel can render it immediately.
#[tauri::command]
pub async fn upload_creator_avatar(file_path: String) -> Result<String, String> {
    let (bytes, content_type) = read_avatar_file(&file_path)?;
    let base = api_base()?;
    let url = format!("{base}/v1/creators/me/avatar");
    let jwt = resolve_jwt().await?;

    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);

    let res = build_client()
        .post(&url)
        .bearer_auth(&jwt)
        .json(&serde_json::json!({ "contentType": content_type, "data": data }))
        .send()
        .await
        .map_err(|e| format!("avatar upload request: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("avatar upload read: {e}"))?;

    parse_avatar_upload_response(status, &text)
}

/// Open a native file picker for an avatar image and return the chosen path (or
/// `None` if cancelled). Holds a `ModalGuard` for the dialog's lifetime so the
/// popover/window doesn't steal key-window focus and dismiss the panel.
#[tauri::command]
pub async fn pick_avatar_file() -> Result<Option<String>, String> {
    let _guard = crate::tray::ModalGuard::new();
    let result = rfd::AsyncFileDialog::new()
        .set_title("Choose an avatar image")
        .add_filter("Images", &["png", "jpg", "jpeg", "webp", "gif"])
        .pick_file()
        .await;
    Ok(result.map(|handle| handle.path().to_string_lossy().to_string()))
}

/// Fetch a creator's PUBLIC profile + approved listings for the preview. Public
/// route — NO auth token attached. A non-existent handle is a clean 404.
#[tauri::command]
pub async fn get_creator_profile(handle: String) -> Result<PublicCreatorPreview, String> {
    let handle = handle.trim();
    if handle.is_empty() {
        return Err("no handle to preview".to_string());
    }
    // The handle is a single path segment; reject anything that could escape it.
    if !handle
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        || handle.len() > 64
    {
        return Err(format!("invalid handle: {handle:?}"));
    }
    let base = api_base()?;
    let url = format!("{base}/v1/creators/{handle}");

    let res = build_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("profile fetch: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| format!("profile read: {e}"))?;

    parse_public_profile_response(status, &text)
}

/// Read the signed-in caller's own claimed creator profile, if any. Authed (JWT).
/// `Ok(Some(..))` → the caller has a handle (Profile tab prefills the edit step);
/// `Ok(None)` → the caller has not claimed one (Profile tab shows the claim
/// step); `Err(..)` → signed out / transport / not-yet-implemented (the panel
/// degrades to the claim step on any error — see the panel's `$effect`).
#[tauri::command]
pub async fn get_my_creator() -> Result<Option<MyCreator>, String> {
    let base = api_base()?;
    let url = format!("{base}/v1/creators/me");
    let jwt = resolve_jwt().await?;

    let res = build_client()
        .get(&url)
        .bearer_auth(&jwt)
        .send()
        .await
        .map_err(|e| format!("my-creator fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("my-creator read: {e}"))?;

    parse_my_creator_response(status, &text)
}
