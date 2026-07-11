//! Feature gate for the expanded desktop window surface.
//!
//! GA gate for the expanded popover/desktop window. This surface graduated
//! from the Indigo-only dogfood: it now delegates to
//! `feature_gate::desktop_features_enabled()`, which admits **any** signed-in
//! user (non-empty email claim). There is no parallel cache here — the GA
//! gate owns its own process-lifetime OnceLock cache.
//!
//! On cold start (cache uninitialised) the underlying
//! `desktop_features_enabled()` call awaits `compute_ga_gate()` and returns
//! the canonical email-derived answer instead of falling back to false. This
//! matters because the popover mounts and invokes the gate before any cloud
//! round-trip has had a chance to seed an unrelated cache — we owe the caller
//! the real answer, not a default.
//!
//! See `src-tauri/src/commands/meetings.rs::meetings_feature_enabled` for
//! the reference pattern this command mirrors.
//!
//! Result type is `Result<bool, String>` to match the established gate
//! command shape, but `desktop_features_enabled()` itself never errors — the
//! Ok arm is always taken.

use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager};

#[allow(unused_imports)]
pub use hq_desktop_core::desktop_alt::{
    activity_url, board_url, bool_field, build_file_tree, build_node, crm_projection_url,
    deployment_entry_from_value, deployment_last_deploy, deployment_matches_selected_slug,
    deployment_org_slug, deployment_rows, deployment_size, deployment_version, deployments_url,
    derive_initials, dir_has_visible_children, first_row_key_names, format_board_date,
    format_bytes, format_deployment_age, is_activity_not_provisioned, is_auth_required_error,
    is_board_not_provisioned, is_deployments_not_provisioned, is_dev_noise,
    is_safe_deployment_host, is_safe_deployment_label, is_secrets_not_provisioned, is_url_safe_id,
    is_within, json_code, json_kind, lexically_normalize, list_dir_entries,
    live_cloud_uid_from_broken_reason, nested_number_field, nested_string_field,
    normalize_deployment_host, normalize_deployment_state, normalize_slug, number_field,
    parse_activity_response, parse_board_response, parse_company_activity, parse_company_board,
    parse_crm_projection_response, parse_deployment_entries, parse_deployments_response,
    parse_project_creators, parse_secret_envs, parse_secrets_response, read_file_content,
    read_file_content_capped, resolve_company_uid_from_workspaces, resolve_hq_folder,
    secret_env_and_key, secret_key, secret_rotation, secret_rows, secret_structure_summary,
    secret_updated_at, secrets_url, string_field, subdomain_from_url, summary_count_or_auth,
    ActivityContributor, ActivityEntry, ActivityStats, BoardCard, BoardColumn,
    BoardCreatorEnvelope, BoardCreatorProject, CompanyActivity, CompanyActivitySummary,
    CompanyBoard, CompanySummary, DeploymentEntry, DirEntry, FileNode, LiveBoardAssignee,
    LiveBoardModel, LiveBoardProject, ProjectCreator, SecretEnv, SecretItem, DEV_NOISE_NAMES,
};

use crate::commands::cognito;
use crate::commands::sync::resolve_vault_api_url;
use crate::util::client_info::build_client;

const WINDOW_LABEL: &str = "desktop-alt";
const HQ_DEPLOY_API_BASE: &str = "https://api.indigo-hq.com";

#[tauri::command]
pub async fn desktop_alt_enabled() -> Result<bool, String> {
    Ok(crate::util::feature_gate::desktop_features_enabled().await)
}

/// Admin gate for the desktop-alt Moderation surface (UX only — the server is
/// the sole authorization boundary). True iff the signed-in email ends in
/// `@getindigo.ai`.
///
/// Distinct from [`desktop_alt_enabled`], which is the GA gate (true for any
/// signed-in user) controlling access to the window itself. The Moderation nav
/// row + panel must use THIS gate so normal HQ users never see the reviewer
/// surface — a non-admin who reaches the underlying commands still gets a 403.
#[tauri::command]
pub async fn desktop_alt_is_admin() -> Result<bool, String> {
    Ok(crate::util::feature_gate::is_indigo_user().await)
}

#[tauri::command]
pub async fn get_company_summary(slug: String) -> Result<CompanySummary, String> {
    if slug.trim().is_empty() {
        return Err("company slug is required".to_string());
    }

    // Aggregate the four real per-panel commands. Each surface is
    // best-effort: a non-auth failure (404 not-provisioned, network, parse)
    // contributes 0 so one dead endpoint doesn't zero the others. Auth
    // failures are different — they must propagate so the UI can route to
    // sign-in rather than silently rendering empty counts.
    // DIAGNOSTIC: capture each surface's raw Result (count or error string)
    // before collapsing, so a "panel shows 0" can be traced to the exact
    // surface + reason. Counts and error messages only — never secret values.
    let board_res = get_company_board(slug.clone())
        .await
        .map(|b| b.card_count());
    let activity_res = get_company_activity(slug.clone()).await.map(|a| a.last7d());
    let deployments_res = get_company_deployments(slug.clone())
        .await
        .map(|d| u32::try_from(d.len()).unwrap_or(u32::MAX));
    let secrets_res = get_company_secrets(slug)
        .await
        .map(|s| u32::try_from(s.len()).unwrap_or(u32::MAX));
    eprintln!(
        "[desktop-alt] summary surfaces: board={board_res:?} activity={activity_res:?} deployments={deployments_res:?} secrets={secrets_res:?}"
    );

    let board = summary_count_or_auth(board_res)?;
    let last7d = summary_count_or_auth(activity_res)?;
    let deployments = summary_count_or_auth(deployments_res)?;
    let secrets = summary_count_or_auth(secrets_res)?;
    eprintln!(
        "[desktop-alt] summary final: board={board} activity={last7d} deployments={deployments} secrets={secrets}"
    );

    Ok(CompanySummary {
        board,
        activity: CompanyActivitySummary { last7d },
        deployments,
        secrets,
    })
}

#[tauri::command]
pub async fn get_company_board(slug: String) -> Result<CompanyBoard, String> {
    let slug = normalize_slug(&slug)?;
    let company_uid = resolve_company_uid(&slug).await?;
    let url = board_url(&vault_base()?, &company_uid)?;
    let token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;

    let res = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("board fetch: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| format!("board read: {e}"))?;
    eprintln!(
        "[desktop-alt] board GET {url} -> HTTP {} ({} bytes): {}",
        status,
        text.len(),
        text.chars().take(200).collect::<String>()
    );

    parse_board_response(status, &text)
}

/// Vault-API fallback for the CRM projection (hq-native-crm US-010).
///
/// The Accounts surface reads `crm-projection.json` LOCAL-FIRST (via
/// `projects_local::get_company_crm_projection`); when the local copy is missing
/// — never synced to this Mac, CRM not enabled, or a sync in flight — the
/// frontend falls back to this vault read, EXACTLY as the Board surface falls
/// back to `get_company_board`.
///
/// Returns the raw projection JSON pass-through (the shape is owned by the
/// hq-pro producer and normalized in the frontend). A not-provisioned vault, a
/// 404 (the route may not be deployed yet), or any non-auth failure degrades to
/// JSON `null` — the surface renders its calm empty state. A 401/403 propagates
/// as `AUTH_REQUIRED:` so the shell can route to sign-in. NO network is made to
/// Attio / Stripe / PandaDoc / Neon — only to the company's own vault API.
#[tauri::command]
pub async fn get_company_crm_projection_vault(slug: String) -> Result<serde_json::Value, String> {
    let slug = normalize_slug(&slug)?;
    let company_uid = resolve_company_uid(&slug).await?;
    let url = crm_projection_url(&vault_base()?, &company_uid)?;
    let token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;

    let res = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("crm-projection fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("crm-projection read: {e}"))?;
    eprintln!(
        "[desktop-alt] crm-projection GET {url} -> HTTP {} ({} bytes)",
        status,
        text.len(),
    );

    parse_crm_projection_response(status, &text)
}

#[tauri::command]
pub async fn get_company_project_creators(slug: String) -> Result<Vec<ProjectCreator>, String> {
    let slug = normalize_slug(&slug)?;
    let company_uid = resolve_company_uid(&slug).await?;
    let url = board_url(&vault_base()?, &company_uid)?;
    let token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;
    let res = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("creators fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("creators read: {e}"))?;
    // A missing / unprovisioned board (or no ACL) is not an error here — the
    // Lead column simply falls back to "Unassigned". Only the body parse below
    // can fail, and only on a 2xx with malformed JSON.
    if !status.is_success() {
        return Ok(Vec::new());
    }
    parse_project_creators(&text).map_err(|e| format!("creators parse: {e}"))
}

#[tauri::command]
pub async fn get_company_activity(slug: String) -> Result<CompanyActivity, String> {
    let slug = normalize_slug(&slug)?;
    let company_uid = resolve_company_uid(&slug).await?;
    let url = activity_url(&vault_base()?, &company_uid)?;
    let token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;

    let res = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("activity fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("activity read: {e}"))?;
    eprintln!(
        "[desktop-alt] activity GET {url} -> HTTP {} ({} bytes): {}",
        status,
        text.len(),
        text.chars().take(200).collect::<String>()
    );

    parse_activity_response(status, &text)
}

/// Company team telemetry for the Team tab (company-detail-desktop-ia).
/// Proxies `GET /v1/telemetry/company?companyUid=&from=&to=` on the vault/hq-pro base.
/// Returns the raw JSON object for the frontend normalizer (humans vs agents, skills).
#[tauri::command]
pub async fn get_company_team_telemetry(
    slug: String,
    from: Option<String>,
    to: Option<String>,
) -> Result<serde_json::Value, String> {
    let slug = normalize_slug(&slug)?;
    let company_uid = resolve_company_uid(&slug).await?;
    if !is_url_safe_id(&company_uid) {
        return Err(format!("company uid has invalid characters: {company_uid:?}"));
    }
    let base = vault_base()?;
    let from = from.unwrap_or_else(|| {
        let d = chrono::Utc::now() - chrono::Duration::days(30);
        d.format("%Y-%m-%d").to_string()
    });
    let to = to.unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%d").to_string());
    let url = format!(
        "{}/v1/telemetry/company?companyUid={}&from={}&to={}",
        base.trim_end_matches('/'),
        urlencoding_encode(&company_uid),
        urlencoding_encode(&from),
        urlencoding_encode(&to),
    );
    let token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;

    let res = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("team telemetry fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("team telemetry read: {e}"))?;
    eprintln!(
        "[desktop-alt] team telemetry GET {url} -> HTTP {} ({} bytes)",
        status,
        text.len()
    );
    if status.as_u16() == 401 {
        return Err(format!("auth: unauthorized 401 — {text}"));
    }
    if status.as_u16() == 403 {
        return Err(format!("forbidden 403 — {text}"));
    }
    if !status.is_success() {
        return Err(format!("team telemetry HTTP {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("team telemetry parse: {e}"))
}

/// Minimal query-value encoder (uid/date are already constrained).
fn urlencoding_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[tauri::command]
pub async fn get_company_deployments(slug: String) -> Result<Vec<DeploymentEntry>, String> {
    let slug = normalize_slug(&slug)?;
    let url = deployments_url(HQ_DEPLOY_API_BASE);
    let token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;

    let res = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {token}"))
        .header("x-org-slug", &slug)
        .send()
        .await
        .map_err(|e| format!("deployments fetch: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("deployments read: {e}"))?;
    eprintln!(
        "[desktop-alt] deployments GET {url} (x-org-slug={slug}) -> HTTP {} ({} bytes): {}",
        status,
        text.len(),
        text.chars().take(200).collect::<String>()
    );

    parse_deployments_response(status, &text, &slug)
}

#[tauri::command]
pub async fn get_company_secrets(slug: String) -> Result<Vec<SecretEnv>, String> {
    let slug = normalize_slug(&slug)?;
    let company_uid = resolve_company_uid(&slug).await?;
    let url = secrets_url(&vault_base()?, &company_uid)?;
    let token = cognito::get_valid_access_token()
        .await
        .map_err(|e| format!("auth: {e}"))?;

    let res = build_client()
        .get(&url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("secrets fetch: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| format!("secrets read: {e}"))?;
    // Secrets response bodies can carry plaintext secret values, so log
    // only status + byte length here (never a body snippet).
    eprintln!(
        "[desktop-alt] secrets GET {url} -> HTTP {} ({} bytes)",
        status,
        text.len()
    );

    parse_secrets_response(status, &text)
}

/// Route the desktop-alt window should land on the next time it mounts. Set by
/// callers that open the window with a specific intent — e.g. a "meeting
/// detected" notification click wants the Meetings screen, not the default Sync
/// screen. The frontend consumes this once on mount via
/// `desktop_alt_consume_pending_route`. For an already-open window we instead
/// emit `desktop:navigate` (see `open_desktop_alt_window_inner`), so the
/// pending slot is only relevant to a fresh build.
static PENDING_ROUTE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn pending_route_cell() -> &'static Mutex<Option<String>> {
    PENDING_ROUTE.get_or_init(|| Mutex::new(None))
}

fn set_pending_route(route: Option<&str>) {
    if let Ok(mut cell) = pending_route_cell().lock() {
        *cell = route.map(|r| r.to_string());
    }
}

/// Take (and clear) the route the desktop-alt window should open on. Returns
/// `None` when nothing was queued — the frontend then keeps its default initial
/// route. Called once by `DesktopApp` on mount.
#[tauri::command]
pub fn desktop_alt_consume_pending_route() -> Option<String> {
    pending_route_cell()
        .lock()
        .ok()
        .and_then(|mut cell| cell.take())
}

/// Dev-only render audit for local desktop verification. No-ops unless
/// `HQ_DEV_AUDIT_DESKTOP_RENDER=1` is set before launch.
#[tauri::command]
pub fn desktop_alt_dev_audit_render(
    company_row_count: usize,
    footer: Option<String>,
    names: Vec<String>,
    has_more_companies_text: bool,
) {
    if std::env::var("HQ_DEV_AUDIT_DESKTOP_RENDER").ok().as_deref() != Some("1") {
        return;
    }

    let sample = names.into_iter().take(12).collect::<Vec<_>>().join(" | ");
    let footer = footer.unwrap_or_default();
    let line = format!(
        "render company_rows={company_row_count} has_more_companies_text={has_more_companies_text} footer={footer:?} sample={sample:?}"
    );
    crate::util::logfile::log("desktop-alt-dev", &line);
    eprintln!("[desktop-alt-dev] {line}");
}

/// Open or focus the expanded desktop window (GA — any signed-in user).
///
/// The window is declared in `tauri.conf.json` as hidden, so normal app
/// startup does not surface it. This command is still defensive and can
/// rebuild the window if it was closed earlier in the session.
///
/// `route` (optional) lands the window on a specific screen — e.g. `"meetings"`
/// from the meeting-detected notification. Omitted (the manual "open new UX"
/// button) keeps the default Sync screen.
#[tauri::command]
pub async fn open_desktop_alt_window(app: AppHandle, route: Option<String>) -> Result<(), String> {
    open_desktop_alt_window_inner(app, route.as_deref()).await
}

/// Window open/focus body, callable from non-command contexts (e.g. the
/// `UNUserNotificationCenter` delegate handling a cold notification click,
/// where no `#[tauri::command]` invocation is in flight). Keeps the GA
/// gate (signed-in check) so the delegate path is defense-in-depth too.
///
/// `route` routes the window to a screen: an already-open window gets a live
/// `desktop:navigate` event; a fresh build queues the route for the frontend
/// to consume on mount.
pub async fn open_desktop_alt_window_inner(
    app: AppHandle,
    route: Option<&str>,
) -> Result<(), String> {
    if !desktop_alt_enabled().await? {
        return Err("desktop-alt requires a signed-in user".to_string());
    }

    // One HQ window at a time: opening the desktop view hides the classic
    // popover (whether summoned via shortcut, menu, or the popover's own
    // "Open desktop view" button).
    if let Some(popover) = app.get_webview_window("main") {
        let _ = popover.hide();
    }

    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        // Already mounted: it won't re-consume a pending route, so push the
        // navigation live. Fire-and-forget — a missing listener is harmless.
        if let Some(route) = route {
            let _ = app.emit("desktop:navigate", route);
        }
        return Ok(());
    }

    // Fresh build: queue the route so the window picks it up on mount via
    // `desktop_alt_consume_pending_route`.
    set_pending_route(route);

    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        WINDOW_LABEL,
        tauri::WebviewUrl::App("desktop-alt.html".into()),
    )
    // Empty native title: the Overlay title bar would otherwise paint "HQ"
    // over the custom titlebar's sync-status text (the verdict). The window's
    // own UI provides the heading, so the macOS title is intentionally blank.
    .title("")
    .inner_size(1180.0, 760.0)
    .min_inner_size(960.0, 600.0)
    .resizable(true)
    .decorations(true)
    // Transparent so the native Liquid Glass backing view (applied below) shows
    // through. The desktop CSS paints translucent surfaces over it; the
    // reduced-transparency media query restores a solid window for that a11y
    // setting. See src/glass.rs.
    .transparent(true)
    .visible(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);
    }

    let _window = builder.build().map_err(|e| e.to_string())?;

    // Apply the macOS 26 Liquid Glass material (NSGlassEffectView) behind the
    // webview, falling back to NSVisualEffectView vibrancy on older macOS.
    // AppKit is main-thread-only, so hop onto the main thread and re-fetch the
    // window by label inside the closure (mirrors commands/banner.rs).
    #[cfg(target_os = "macos")]
    {
        let app_for_glass = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(win) = app_for_glass.get_webview_window(WINDOW_LABEL) {
                crate::glass::apply_liquid_glass_window(&win);
            }
        });
    }

    #[cfg(target_os = "windows")]
    {
        hq_platform::window_effects::apply_popover_vibrancy(&_window);
    }

    Ok(())
}

async fn resolve_company_uid(slug: &str) -> Result<String, String> {
    let result = crate::commands::workspaces::list_syncable_workspaces().await?;
    resolve_company_uid_from_workspaces(result.workspaces, slug)
}

fn vault_base() -> Result<String, String> {
    resolve_vault_api_url().map(|u| u.trim_end_matches('/').to_string())
}

/// Files have an empty `children` vec.
#[tauri::command]
pub async fn get_company_file_tree(slug: String) -> Result<FileNode, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("file explorer requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    build_file_tree(&hq, &slug)
}

/// Pure body for `get_company_file_tree` — takes an explicit HQ root so the

/// Read a single file's UTF-8 text content by HQ-folder-relative path.
///
/// Enforces the same `MAX_FILE_BYTES` (50MB) size cap the sync filter uses —
/// the cap is checked from file metadata BEFORE any bytes are read, so an
/// oversized file never gets loaded into memory. Binary (non-UTF-8) files
/// return a clear "cannot preview binary file" error rather than mojibake.
#[tauri::command]
pub async fn get_company_file_content(path: String) -> Result<String, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("file explorer requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    read_file_content(&hq, &path)
}

/// List the immediate children of an HQ-relative directory for the lazy file
/// explorer (US-010).
///
/// `rel_path` is HQ-folder-relative with forward slashes; an empty string (or
/// `"."`) lists the HQ ROOT (top-level `companies/`, `repos/`, `core/`,
/// `personal/`, `workspace/`, …). Children are filtered through the SAME
/// curated dev-noise set ([`DEV_NOISE_NAMES`] + dot-directories) as the eager
/// tree, and the SAME `is_within` HQ-folder guard rejects `..` traversal /
/// absolute escapes. Returns only immediate children (no recursion), sorted
/// directories-before-files then case-insensitive alphabetical.
#[tauri::command]
pub async fn list_hq_dir(rel_path: String) -> Result<Vec<DirEntry>, String> {
    if !crate::util::feature_gate::desktop_features_enabled().await {
        return Err("file explorer requires a signed-in user".to_string());
    }
    let hq = resolve_hq_folder();
    list_dir_entries(&hq, &rel_path)
}
