//! Are the agent CLIs installed, signed in, and is HQ set up on this Mac?
//!
//! Extracted from the former `agent_session` module when the in-app Sessions
//! feature was removed. Settings → AI tools and Settings → Bots both read this
//! to decide what to offer, so it outlived the Sessions runtime unchanged.

use hq_desktop_core::claude_launch::{probe_hq_setup, HqSetupReadiness};
use hq_desktop_core::workspaces::{
    discover_local_companies, humanize_slug, resolve_hq_folder_path,
};
use serde::Serialize;

use super::{RuntimeStatus, SessionTool};
use crate::util::logfile::log;

const LOG_TAG: &str = "agent-providers";

/// Everything the UI needs to decide whether it can offer a provider at all,
/// and what to say when it cannot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub hq_root: String,
    /// True when `.claude/settings.json` wires the hooks HQ depends on.
    pub hooks_ready: bool,
    /// The exact technical reason `hooks_ready` is false. Support-log grade;
    /// the page shows plain words and self-heals instead of printing this.
    pub hooks_error: Option<String>,
    /// What the page must do first: nothing, install the HQ template, or
    /// rescue the `.claude` layer. `hooks_ready` is `hq_setup == Ready`.
    pub hq_setup: HqSetupReadiness,
    pub claude_available: bool,
    /// The Claude Code CLI signs in separately from Claude Desktop.
    pub claude_logged_in: bool,
    pub codex_available: bool,
    /// The Codex CLI signs in separately from the ChatGPT desktop app.
    pub codex_logged_in: bool,
    pub grok_available: bool,
    /// The Grok CLI signs in separately from grok.com in the browser.
    pub grok_logged_in: bool,
    /// The one thing the three booleans above cannot say: WHICH of
    /// not-installed / could-not-check / signed-out a runtime is in. The
    /// booleans stay for the older panes that read them; every new surface
    /// should read these, because `available == false` and
    /// `logged_in == false` look identical and lead to a Sign in that cannot
    /// succeed.
    pub claude_status: RuntimeStatus,
    pub codex_status: RuntimeStatus,
    pub grok_status: RuntimeStatus,
    pub companies: Vec<CompanyOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyOption {
    pub slug: String,
    pub display_name: String,
    pub cloud_uid: Option<String>,
}

async fn local_lookup<T: Send + 'static>(
    read: impl FnOnce() -> Result<T, String> + Send + 'static,
    deadline: std::time::Duration,
) -> Result<T, String> {
    tokio::time::timeout(deadline, tauri::async_runtime::spawn_blocking(read))
        .await
        .map_err(|_| "Setup lookup timed out. Please retry.".to_owned())?
        .map_err(|_| "Setup lookup failed. Please retry.".to_owned())?
}

/// The status arm alone, for the support log. Never the `searched` list (long)
/// nor anything a CLI printed.
fn status_tag(status: &RuntimeStatus) -> &'static str {
    match status {
        RuntimeStatus::SignedIn => "signed_in",
        RuntimeStatus::SignedOut => "signed_out",
        RuntimeStatus::NotInstalled { .. } => "not_installed",
        RuntimeStatus::ProbeFailed { .. } => "probe_failed",
    }
}

#[tauri::command]
pub async fn agent_session_preflight() -> Result<Preflight, String> {
    let (hq_root, setup, tools, entries) = local_lookup(
        || {
            let hq_root = resolve_hq_folder_path()?;
            let setup = probe_hq_setup(&hq_root);
            let tools = crate::commands::ai_tools::detect_ai_tools();
            let (entries, _) = discover_local_companies(&hq_root);
            Ok::<_, String>((hq_root, setup, tools, entries))
        },
        std::time::Duration::from_secs(8),
    )
    .await?;
    // Ask each provider, not stale account markers left behind after sign-out.
    //
    // The provider is asked even when `detect_ai_tools` reported no CLI: that
    // detection is a login-shell `command -v` with a 4s cap, so a slow or
    // unusual shell makes an installed CLI look absent — and short-circuiting
    // on it is what turned "I could not check" into "not signed in". The
    // resolver lookup inside `runtime_status` is the authority on presence;
    // the shell probe only promotes a status the lookup could not place.
    let (claude_status, codex_status, grok_status) = tokio::join!(
        super::runtime_status(SessionTool::Claude),
        super::runtime_status(SessionTool::Codex),
        super::runtime_status(SessionTool::Grok),
    );
    let claude_logged_in = claude_status.is_signed_in();
    let codex_logged_in = codex_status.is_signed_in();
    let grok_logged_in = grok_status.is_signed_in();
    // `available` keeps its old meaning for the panes that read it: either
    // evidence of an installed CLI counts.
    let claude_available = tools.claude_cli || claude_status.is_installed();
    let codex_available = tools.codex_cli || codex_status.is_installed();
    let grok_available = tools.grok_cli || grok_status.is_installed();
    // One line per preflight so a support log answers "why did AI tools say
    // Claude Code is not installed" without a debug build.
    log(
        LOG_TAG,
        &format!(
            "preflight claude_cli={} claude_desktop={} claude_logged_in={} codex_cli={} codex_desktop={} codex_logged_in={} hooks_ready={} hq_setup={:?} detail={} claude_status={} codex_status={} grok_status={}",
            tools.claude_cli,
            tools.claude_desktop,
            claude_logged_in,
            tools.codex_cli,
            tools.codex_desktop,
            codex_logged_in,
            setup.is_ready(),
            setup.readiness,
            setup.detail.as_deref().unwrap_or("-"),
            status_tag(&claude_status),
            status_tag(&codex_status),
            status_tag(&grok_status)
        ),
    );
    let companies = entries
        .into_iter()
        .map(|entry| CompanyOption {
            display_name: entry
                .display_name
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| humanize_slug(&entry.slug)),
            slug: entry.slug,
            cloud_uid: entry.cloud_uid,
        })
        .collect();

    Ok(Preflight {
        hq_root: hq_root.to_string_lossy().into_owned(),
        hooks_ready: setup.is_ready(),
        hq_setup: setup.readiness,
        hooks_error: setup.detail,
        claude_available,
        claude_logged_in,
        codex_available,
        codex_logged_in,
        grok_available,
        grok_logged_in,
        claude_status,
        codex_status,
        grok_status,
        companies,
    })
}
