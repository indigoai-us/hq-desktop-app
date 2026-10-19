use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, UNIX_EPOCH};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::util::{logfile::log, paths};

const LOG_TAG: &str = "hq-anywhere";
const CLAUDE_BLOCK_BEGIN: &str = "<!-- hq-anywhere:begin";
const CODEX_BLOCK_BEGIN: &str =
    "<!-- hq-anywhere:begin (managed by `hq install --global --runtime codex`";
const MANAGED_BLOCK_END: &str = "<!-- hq-anywhere:end -->";
const HQ_MCP_PACK: &str = "hq-anywhere";
/// The same wait Continue uses for the Enable step. A hung `hq install` must
/// not hold [`global_install_lock`] past it, or a later toggle or launch sync
/// waits until the process ends.
const HQ_ANYWHERE_COMMAND_DEADLINE: Duration = Duration::from_secs(20);

fn safe_renderer_failure(_details: &str) -> String {
    "HQ Anywhere setup failed. Tap to retry.".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GlobalRuntime {
    Claude,
    Codex,
}

impl GlobalRuntime {
    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    fn home_dir(self) -> &'static str {
        match self {
            Self::Claude => ".claude",
            Self::Codex => ".codex",
        }
    }

    fn binary_name(self) -> &'static str {
        self.as_str()
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum RuntimeAction {
    Install,
    Uninstall,
}

fn global_runtime_args(action: RuntimeAction, runtime: GlobalRuntime) -> Vec<String> {
    let action = match action {
        RuntimeAction::Install => "install",
        RuntimeAction::Uninstall => "uninstall",
    };
    vec![
        action.to_string(),
        "--global".to_string(),
        "--runtime".to_string(),
        runtime.as_str().to_string(),
    ]
}

fn detect_present_runtimes(home: &Path, path_entries: &[PathBuf]) -> Vec<GlobalRuntime> {
    [GlobalRuntime::Claude, GlobalRuntime::Codex]
        .into_iter()
        .filter(|runtime| {
            home.join(runtime.home_dir()).exists()
                || runtime_binary_on_path(runtime.binary_name(), path_entries)
        })
        .collect()
}

fn runtime_binary_on_path(binary: &str, path_entries: &[PathBuf]) -> bool {
    #[cfg(windows)]
    let extensions = [".exe", ".cmd", ".bat", ".com"];
    #[cfg(not(windows))]
    let extensions = [""];

    path_entries.iter().any(|directory| {
        extensions.iter().any(|extension| {
            let candidate = directory.join(format!("{binary}{extension}"));
            if !candidate.is_file() {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                return fs::metadata(candidate)
                    .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
                    .unwrap_or(false);
            }
            #[cfg(not(unix))]
            {
                true
            }
        })
    })
}

fn has_managed_block(path: &Path, begin: &str) -> bool {
    fs::read_to_string(path)
        .map(|contents| contents.contains(begin) && contents.contains(MANAGED_BLOCK_END))
        .unwrap_or(false)
}

fn claude_mcp_is_hq_anywhere(home: &Path) -> bool {
    let value: Value = match fs::read_to_string(home.join(".claude.json"))
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
    {
        Some(value) => value,
        None => return false,
    };
    value
        .get("mcpServers")
        .and_then(|servers| servers.get("hq"))
        .and_then(|server| server.get("_hqPack"))
        .and_then(Value::as_str)
        == Some(HQ_MCP_PACK)
}

fn codex_mcp_is_hq_anywhere(home: &Path) -> bool {
    fs::read_to_string(home.join(".codex/config.toml"))
        .map(|contents| {
            let mut in_hq_server = false;
            contents.lines().any(|line| {
                let line = line.trim();
                if line.starts_with('[') && line.ends_with(']') {
                    in_hq_server = line == "[mcp_servers.hq]";
                    return false;
                }
                if !in_hq_server {
                    return false;
                }
                let Some((key, value)) = line.split_once('=') else {
                    return false;
                };
                let value = value.trim();
                key.trim() == "_hqPack"
                    && value.len() >= 2
                    && value.starts_with('"')
                    && value.ends_with('"')
                    && &value[1..value.len() - 1] == HQ_MCP_PACK
            })
        })
        .unwrap_or(false)
}

fn global_runtime_is_installed(home: &Path, runtime: GlobalRuntime) -> bool {
    match runtime {
        GlobalRuntime::Claude => {
            has_managed_block(&home.join(".claude/CLAUDE.md"), CLAUDE_BLOCK_BEGIN)
                && claude_mcp_is_hq_anywhere(home)
        }
        GlobalRuntime::Codex => {
            has_managed_block(&home.join(".codex/AGENTS.md"), CODEX_BLOCK_BEGIN)
                && codex_mcp_is_hq_anywhere(home)
        }
    }
}

/// The CLI's own install record, `~/.hq/anywhere/<runtime>-install.json`. A
/// plugin-mode install (`hq install --global --via plugin`) writes this and
/// neither the managed block nor the MCP entry.
fn install_state_file(home: &Path, runtime: GlobalRuntime) -> PathBuf {
    home.join(".hq/anywhere")
        .join(format!("{}-install.json", runtime.as_str()))
}

/// True when any part of the HQ Anywhere setup is on disk for `runtime`: the
/// managed instructions block, the HQ MCP entry or the CLI's install record.
/// `hq uninstall` exits 1 with "No HQ global install found" when nothing is
/// there, so an opted-out person must not run it against a clean home. Before
/// this check the startup reconcile ran it on every launch and the renderer
/// retried it twice more. `~/.hq/root` alone is not counted: the CLI also
/// accepts it, but it only points at the HQ folder and exists on homes with no
/// runtime install.
fn global_runtime_has_any_install(home: &Path, runtime: GlobalRuntime) -> bool {
    let wrote_files = match runtime {
        GlobalRuntime::Claude => {
            has_managed_block(&home.join(".claude/CLAUDE.md"), CLAUDE_BLOCK_BEGIN)
                || claude_mcp_is_hq_anywhere(home)
        }
        GlobalRuntime::Codex => {
            has_managed_block(&home.join(".codex/AGENTS.md"), CODEX_BLOCK_BEGIN)
                || codex_mcp_is_hq_anywhere(home)
        }
    };
    wrote_files || install_state_file(home, runtime).is_file()
}

/// Written by HQ Desktop when it installs or adopts the HQ Anywhere setup for
/// `runtime`: `~/.hq/anywhere/<runtime>-desktop-enabled`. The file names the
/// install it recorded (see [`install_fingerprint`]). The launch reconcile
/// removes a setup only when that record still matches; a person turning the
/// switch off removes it whenever a record exists. A setup made with `hq install --global` and never turned on in the
/// desktop has no marker, so launch sync leaves it in place. A marker left
/// behind by `hq uninstall --global` then `hq install --global` does not match
/// the fresh install, so launch sync drops the marker and leaves the install.
fn desktop_marker_file(home: &Path, runtime: GlobalRuntime) -> PathBuf {
    home.join(".hq/anywhere")
        .join(format!("{}-desktop-enabled", runtime.as_str()))
}

/// Why a turn-off reached [`apply_global_install`]. The person flipping the
/// Settings switch (or answering the onboarding question) chose to remove the
/// setup. The launch reconcile only repeats a saved choice, so it must never
/// remove an install the desktop cannot prove it made or took on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GlobalInstallTrigger {
    PersonChoice,
    Reconcile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkerOrigin {
    Adopted,
    Installed,
}

impl MarkerOrigin {
    fn as_str(self) -> &'static str {
        match self {
            Self::Adopted => "adopted",
            Self::Installed => "installed",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "adopted" => Some(Self::Adopted),
            "installed" => Some(Self::Installed),
            _ => None,
        }
    }
}

fn file_stamp(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let modified = meta.modified().ok()?;
    let stamp = modified.duration_since(UNIX_EPOCH).unwrap_or_default();
    let digest = Sha256::digest(&bytes);
    Some(format!(
        "{}:{}:{}:{digest:x}",
        stamp.as_secs(),
        stamp.subsec_nanos(),
        bytes.len()
    ))
}

/// The managed instructions block in `path`, from its begin marker through
/// the end marker. Text the person keeps around the block is not part of it.
fn managed_block_text(path: &Path, begin: &str) -> Option<String> {
    let contents = fs::read_to_string(path).ok()?;
    let start = contents.find(begin)?;
    let end = contents[start..].find(MANAGED_BLOCK_END)? + start + MANAGED_BLOCK_END.len();
    Some(contents[start..end].to_string())
}

/// The `mcpServers.hq` entry in `~/.claude.json`, serialized. Other keys in
/// that file (startup counters, project history, other servers) are not part
/// of it.
fn claude_mcp_entry_text(home: &Path) -> Option<String> {
    let value: Value =
        serde_json::from_str(&fs::read_to_string(home.join(".claude.json")).ok()?).ok()?;
    let entry = value.get("mcpServers")?.get("hq")?;
    serde_json::to_string(entry).ok()
}

/// The `[mcp_servers.hq]` table (and any `[mcp_servers.hq.*]` sub-table) in
/// `~/.codex/config.toml`, as its trimmed non-blank lines. Other tables and
/// top-level keys are not part of it.
fn codex_mcp_entry_text(home: &Path) -> Option<String> {
    let contents = fs::read_to_string(home.join(".codex/config.toml")).ok()?;
    let mut in_hq_server = false;
    let mut lines = Vec::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_hq_server = line == "[mcp_servers.hq]" || line.starts_with("[mcp_servers.hq.");
        }
        if in_hq_server && !line.is_empty() {
            lines.push(line);
        }
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn text_digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// Identity of the HQ Anywhere setup currently on disk for `runtime`. It
/// covers only what `hq install --global` owns: its install record (path,
/// mtime and content, so a CLI reinstall changes it), the managed block and
/// the `hq` MCP entry. Edits elsewhere in `CLAUDE.md`, `AGENTS.md`,
/// `.claude.json` or `config.toml` leave it unchanged.
fn install_fingerprint(home: &Path, runtime: GlobalRuntime) -> String {
    let state = file_stamp(&install_state_file(home, runtime)).unwrap_or_default();
    let (managed, mcp) = match runtime {
        GlobalRuntime::Claude => (
            managed_block_text(&home.join(".claude/CLAUDE.md"), CLAUDE_BLOCK_BEGIN),
            claude_mcp_is_hq_anywhere(home)
                .then(|| claude_mcp_entry_text(home))
                .flatten(),
        ),
        GlobalRuntime::Codex => (
            managed_block_text(&home.join(".codex/AGENTS.md"), CODEX_BLOCK_BEGIN),
            codex_mcp_is_hq_anywhere(home)
                .then(|| codex_mcp_entry_text(home))
                .flatten(),
        ),
    };
    let managed = managed.as_deref().map(text_digest).unwrap_or_default();
    let mcp = mcp.as_deref().map(text_digest).unwrap_or_default();
    format!("v2\nstate={state}\nmanaged={managed}\nmcp={mcp}")
}

fn fingerprint_identifies_install(fingerprint: &str) -> bool {
    fingerprint.lines().skip(1).any(|line| {
        line.split_once('=')
            .is_some_and(|(_, value)| !value.is_empty())
    })
}

fn read_desktop_record(home: &Path, runtime: GlobalRuntime) -> Option<Value> {
    let raw = fs::read_to_string(desktop_marker_file(home, runtime)).ok()?;
    serde_json::from_str(raw.trim()).ok()
}

fn marker_origin(home: &Path, runtime: GlobalRuntime) -> Option<MarkerOrigin> {
    read_desktop_record(home, runtime)
        .and_then(|record| {
            record
                .get("origin")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .as_deref()
        .and_then(MarkerOrigin::parse)
}

/// True when the record was written for the files that are on disk now.
/// A legacy `1\n` marker, a `v: 1` record (whole-file stamps) or a record
/// whose HQ-owned content was replaced does not match.
fn marker_matches(home: &Path, runtime: GlobalRuntime) -> bool {
    let Some(record) = read_desktop_record(home, runtime) else {
        return false;
    };
    if record.get("v").and_then(Value::as_u64) != Some(2) {
        return false;
    }
    let Some(stored) = record.get("fingerprint").and_then(Value::as_str) else {
        return false;
    };
    fingerprint_identifies_install(stored) && stored == install_fingerprint(home, runtime)
}

/// True when an uninstall started and has not finished yet.
fn marker_uninstall_pending(home: &Path, runtime: GlobalRuntime) -> bool {
    read_desktop_record(home, runtime)
        .and_then(|record| record.get("uninstall_pending").and_then(Value::as_bool))
        .unwrap_or(false)
}

fn write_desktop_marker(home: &Path, runtime: GlobalRuntime, origin: MarkerOrigin) {
    write_desktop_record(
        home,
        runtime,
        serde_json::json!({
            "v": 2,
            "origin": origin.as_str(),
            "fingerprint": install_fingerprint(home, runtime),
        }),
    );
}

/// Marks the record before `hq uninstall --global` runs. The CLI removes the
/// MCP entry first and its install record last, so an uninstall that fails
/// or times out part way leaves files that no longer match the fingerprint.
/// The mark keeps the next launch with the setting off removing the rest.
fn mark_uninstall_pending(home: &Path, runtime: GlobalRuntime) {
    let mut record = read_desktop_record(home, runtime)
        .filter(Value::is_object)
        .unwrap_or_else(|| {
            serde_json::json!({
                "v": 2,
                "fingerprint": install_fingerprint(home, runtime),
            })
        });
    record["uninstall_pending"] = Value::Bool(true);
    write_desktop_record(home, runtime, record);
}

fn write_desktop_record(home: &Path, runtime: GlobalRuntime, body: Value) {
    let marker = desktop_marker_file(home, runtime);
    let written = serde_json::to_vec(&body)
        .map_err(|error| error.to_string())
        .and_then(|bytes| {
            marker
                .parent()
                .map(fs::create_dir_all)
                .unwrap_or(Ok(()))
                .and_then(|()| fs::write(&marker, bytes))
                .map_err(|error| error.to_string())
        });
    if let Err(error) = written {
        log(
            LOG_TAG,
            &format!(
                "could not record that HQ Desktop set up {}: {error}",
                runtime.as_str()
            ),
        );
    }
}

/// True when either runtime has an adopted record that still matches the
/// install on disk.
pub fn desktop_adopted_install(home: &Path) -> bool {
    [GlobalRuntime::Claude, GlobalRuntime::Codex]
        .into_iter()
        .any(|runtime| {
            marker_origin(home, runtime) == Some(MarkerOrigin::Adopted)
                && marker_matches(home, runtime)
        })
}

fn clear_desktop_marker(home: &Path, runtime: GlobalRuntime) {
    let marker = desktop_marker_file(home, runtime);
    if marker.exists() {
        if let Err(error) = fs::remove_file(&marker) {
            log(
                LOG_TAG,
                &format!(
                    "could not clear the HQ Desktop record for {}: {error}",
                    runtime.as_str()
                ),
            );
        }
    }
}

fn global_install_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Apply or remove the current user's HQ Anywhere setup in supported runtimes.
/// The shell-out stays on the async Tauri runtime and uses the shared HQ CLI runner.
///
/// The renderer calls this at startup (`reconcileHqAnywhereGlobalRuntime` in
/// `App.svelte`) as well as from the setting toggle. Only the shipped HQ
/// bundle runs it: any other bundle (scratch, Lane Check, worktree builds)
/// shares the owner's Claude and Codex home folders, so it logs one skip line
/// and changes nothing. On 2026-10-10 an
/// `ai.indigo.hq-lane-check.conflict-toast` bundle ran
/// `hq uninstall --global --runtime claude` from here at launch.
#[tauri::command]
pub async fn set_hq_anywhere_global_install(
    enabled: bool,
    explicit: Option<bool>,
) -> Result<(), String> {
    let trigger = if explicit.unwrap_or(false) {
        GlobalInstallTrigger::PersonChoice
    } else {
        GlobalInstallTrigger::Reconcile
    };
    run_global_install(enabled, trigger, None).await
}

/// First-run "Continue in <tool>": install the HQ Anywhere global runtime
/// setup (hooks, memory, skills) for the one tool the person chose, whether or
/// not that tool's home folder exists yet. Same bundle gate and lock as
/// [`set_hq_anywhere_global_install`].
#[tauri::command]
pub async fn install_hq_runtime_for_tool(runtime: String) -> Result<(), String> {
    let runtime = parse_tool_runtime(&runtime)?;
    run_global_install(true, GlobalInstallTrigger::PersonChoice, Some(runtime)).await
}

/// The webview supplies `runtime`, so the error never echoes it back.
fn parse_tool_runtime(runtime: &str) -> Result<GlobalRuntime, String> {
    GlobalRuntime::parse(runtime).ok_or_else(|| "Unsupported coding tool".to_string())
}

/// Returned when a one-tool install is refused because this build may not
/// change the owner's coding tools. It is not success: nothing was installed.
pub const HQ_ANYWHERE_NOT_INSTALLED: &str = "not-installed";

/// Startup reconcile (`only` is None) still returns Ok for a disallowed
/// identity, so a scratch launch does not mark setup as failed. A one-tool
/// install returns [`HQ_ANYWHERE_NOT_INSTALLED`] instead of looking installed.
fn disallowed_install_result(
    identity: &crate::scratch_build::LaunchIdentity,
    only: Option<GlobalRuntime>,
) -> Result<(), String> {
    if identity.allows("HQ Anywhere global runtime setup") {
        return Ok(());
    }
    if only.is_some() {
        return Err(HQ_ANYWHERE_NOT_INSTALLED.to_string());
    }
    Ok(())
}

/// The same check the install skip uses (`global_runtime_is_installed`).
pub fn runtime_installed_for_tool(home: &Path, runtime: &str) -> Result<bool, String> {
    Ok(global_runtime_is_installed(
        home,
        parse_tool_runtime(runtime)?,
    ))
}

/// Cheap read for the welcome report and later briefs. Does not install.
#[tauri::command]
pub fn hq_anywhere_runtime_installed(runtime: String) -> Result<bool, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Could not resolve the home directory.".to_string())?;
    runtime_installed_for_tool(&home, &runtime)
}

async fn run_global_install(
    enabled: bool,
    trigger: GlobalInstallTrigger,
    only: Option<GlobalRuntime>,
) -> Result<(), String> {
    let identity = crate::scratch_build::LaunchIdentity::current();
    // A disallowed one-tool install is an error. A disallowed startup
    // reconcile stays Ok and must return here, before any home lookup.
    disallowed_install_result(&identity, only)?;
    if !identity.is_production() {
        return Ok(());
    }
    let home =
        dirs::home_dir().ok_or_else(|| "Could not resolve the home directory.".to_string())?;
    let path_env = paths::child_path();
    let path_entries = std::env::split_paths(OsStr::new(&path_env)).collect::<Vec<_>>();
    apply_global_install_locked(
        &identity,
        enabled,
        trigger,
        only,
        &home,
        &path_entries,
        HQ_ANYWHERE_COMMAND_DEADLINE,
        || crate::commands::install_directory::resolve_hq_path().map(PathBuf::from),
        |args, hq_root| async move {
            let args = args.iter().map(String::as_str).collect::<Vec<_>>();
            crate::commands::install_stages::run_hq_global_runtime_plain(&args, &hq_root).await
        },
    )
    .await
}

/// Holds [`global_install_lock`] around [`apply_global_install`]. The command
/// deadline is inside the lock, so a hung `hq` releases it when the deadline
/// fires instead of blocking the next toggle or launch sync.
async fn apply_global_install_locked<R, F, Fut>(
    identity: &crate::scratch_build::LaunchIdentity,
    enabled: bool,
    trigger: GlobalInstallTrigger,
    only: Option<GlobalRuntime>,
    home: &Path,
    path_entries: &[PathBuf],
    command_deadline: Duration,
    resolve_hq_root: R,
    run_hq: F,
) -> Result<(), String>
where
    R: FnOnce() -> Result<PathBuf, String>,
    F: FnMut(Vec<String>, PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let _guard = global_install_lock().lock().await;
    apply_global_install(
        identity,
        enabled,
        trigger,
        only,
        home,
        path_entries,
        command_deadline,
        resolve_hq_root,
        run_hq,
    )
    .await
}

/// The body of [`set_hq_anywhere_global_install`] with the bundle identity,
/// home folder, PATH, HQ root and `hq` runner passed in, so tests can assert
/// on exactly which `hq` commands run.
async fn apply_global_install<R, F, Fut>(
    identity: &crate::scratch_build::LaunchIdentity,
    enabled: bool,
    trigger: GlobalInstallTrigger,
    only: Option<GlobalRuntime>,
    home: &Path,
    path_entries: &[PathBuf],
    command_deadline: Duration,
    resolve_hq_root: R,
    mut run_hq: F,
) -> Result<(), String>
where
    R: FnOnce() -> Result<PathBuf, String>,
    F: FnMut(Vec<String>, PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    // The command already gated (and logged); this repeat keeps the seam
    // itself safe for any other caller.
    if !identity.is_production() {
        return Ok(());
    }
    let runtimes = match only {
        Some(runtime) => vec![runtime],
        None => detect_present_runtimes(home, path_entries),
    };
    if runtimes.is_empty() {
        log(
            LOG_TAG,
            "no supported coding runtime was detected; nothing to configure",
        );
        return Ok(());
    }

    let action = if enabled {
        RuntimeAction::Install
    } else {
        RuntimeAction::Uninstall
    };
    let mut pending = Vec::new();
    for runtime in runtimes {
        if enabled && global_runtime_is_installed(home, runtime) {
            // A later launch with the switch still on must not relabel an
            // install HQ Desktop created. Settings only says that turning the
            // switch off removes the install when the desktop took on one
            // that was already there.
            let desktop_made_this_install = marker_origin(home, runtime)
                == Some(MarkerOrigin::Installed)
                && marker_matches(home, runtime);
            if !desktop_made_this_install {
                write_desktop_marker(home, runtime, MarkerOrigin::Adopted);
            } else if marker_uninstall_pending(home, runtime) {
                // An uninstall failed before it changed anything and the
                // switch is on again, so drop the pending removal.
                write_desktop_marker(home, runtime, MarkerOrigin::Installed);
            }
            log(
                LOG_TAG,
                &format!(
                    "{} global setup is already installed; skipping",
                    runtime.as_str()
                ),
            );
        } else if !enabled && !global_runtime_has_any_install(home, runtime) {
            clear_desktop_marker(home, runtime);
            log(
                LOG_TAG,
                &format!(
                    "{} has no global setup to remove; skipping",
                    runtime.as_str()
                ),
            );
        } else if !enabled && !desktop_marker_file(home, runtime).is_file() {
            log(
                LOG_TAG,
                &format!(
                    "{} global setup was set up outside HQ Desktop (hq install --global); leaving it",
                    runtime.as_str()
                ),
            );
        } else if !enabled
            && trigger == GlobalInstallTrigger::Reconcile
            && !marker_matches(home, runtime)
            && !marker_uninstall_pending(home, runtime)
        {
            clear_desktop_marker(home, runtime);
            log(
                LOG_TAG,
                &format!(
                    "{} desktop record does not match the current install; leaving it",
                    runtime.as_str()
                ),
            );
        } else {
            pending.push(runtime);
        }
    }
    if pending.is_empty() {
        return Ok(());
    }

    let hq_root = resolve_hq_root()?;
    let mut failures = Vec::new();
    for runtime in pending {
        let argv = global_runtime_args(action, runtime);
        log(LOG_TAG, &format!("running hq {}", argv.join(" ")));
        if !enabled {
            mark_uninstall_pending(home, runtime);
        }
        match tokio::time::timeout(command_deadline, run_hq(argv, hq_root.clone())).await {
            Ok(Ok(())) => {
                if enabled {
                    write_desktop_marker(home, runtime, MarkerOrigin::Installed);
                } else {
                    clear_desktop_marker(home, runtime);
                }
                log(
                    LOG_TAG,
                    &format!("{} global setup completed", runtime.as_str()),
                );
            }
            Ok(Err(error)) => {
                log(
                    LOG_TAG,
                    &format!("{} global setup failed: {error}", runtime.as_str()),
                );
                failures.push(format!("{} global setup failed: {error}", runtime.as_str()));
            }
            Err(_elapsed) => {
                log(
                    LOG_TAG,
                    &format!(
                        "{} global setup hit the shared deadline; releasing the HQ Anywhere lock",
                        runtime.as_str()
                    ),
                );
                failures.push(format!(
                    "{} global setup failed: timed out",
                    runtime.as_str()
                ));
                // This command already used the whole deadline. Stop here so
                // the lock drops instead of starting another `hq`.
                break;
            }
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(safe_renderer_failure(&failures.join("; ")))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::{
        apply_global_install, apply_global_install_locked, desktop_adopted_install,
        detect_present_runtimes, disallowed_install_result, global_runtime_args,
        global_runtime_is_installed, parse_tool_runtime, runtime_installed_for_tool,
        safe_renderer_failure, write_desktop_marker, GlobalInstallTrigger, GlobalRuntime,
        MarkerOrigin, RuntimeAction, HQ_ANYWHERE_NOT_INSTALLED,
    };
    use crate::scratch_build::LaunchIdentity;

    const SCRATCH_BUNDLE_ID: &str = "ai.indigo.hq-lane-check.conflict-toast";

    fn bundle(id: Option<&str>) -> LaunchIdentity {
        LaunchIdentity {
            scratch_flag: false,
            bundle_identifier: id.map(str::to_string),
        }
    }

    fn production() -> LaunchIdentity {
        bundle(Some(hq_platform::autostart::PRODUCTION_BUNDLE_IDENTIFIER))
    }

    /// Runs the startup reconcile body against a home with Claude and Codex
    /// present. Returns the result, every `hq` argv the runner was asked to
    /// run, and whether the HQ root was resolved.
    fn run_startup_reconcile(
        identity: LaunchIdentity,
        enabled: bool,
    ) -> (Result<(), String>, Vec<Vec<String>>, bool) {
        run_global_install_in(identity, enabled, None, |home| {
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::create_dir_all(home.join(".codex")).unwrap();
        })
    }

    fn write_claude_install(home: &Path) {
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::write(
            home.join(".claude/CLAUDE.md"),
            "<!-- hq-anywhere:begin managed -->\nHQ\n<!-- hq-anywhere:end -->\n",
        )
        .unwrap();
        fs::write(
            home.join(".claude.json"),
            r#"{"mcpServers":{"hq":{"_hqPack":"hq-anywhere"}}}"#,
        )
        .unwrap();
        write_cli_install_record(home, "claude");
    }

    /// `hq install --global` writes `~/.hq/anywhere/<runtime>-install.json` on
    /// every install, plugin or not, so the fakes do too.
    fn write_cli_install_record(home: &Path, runtime: &str) {
        fs::create_dir_all(home.join(".hq/anywhere")).unwrap();
        fs::write(
            home.join(format!(".hq/anywhere/{runtime}-install.json")),
            format!(r#"{{"runtime":"{runtime}","version":"1.0.0"}}"#),
        )
        .unwrap();
    }

    fn write_codex_install(home: &Path) {
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(
            home.join(".codex/AGENTS.md"),
            "<!-- hq-anywhere:begin (managed by `hq install --global --runtime codex`) -->\nHQ\n<!-- hq-anywhere:end -->\n",
        )
        .unwrap();
        fs::write(
            home.join(".codex/config.toml"),
            "[mcp_servers.hq]\ncommand = \"hq-mcp\"\n_hqPack = \"hq-anywhere\"\n",
        )
        .unwrap();
        write_cli_install_record(home, "codex");
    }

    fn write_desktop_marker_for(home: &Path, runtime: &str) {
        let runtime = GlobalRuntime::parse(runtime).expect("test runtime name");
        write_desktop_marker(home, runtime, MarkerOrigin::Installed);
    }

    /// Runs [`apply_global_install`] against a temporary home that `seed`
    /// prepares. Returns the result, every `hq` argv the runner was asked to
    /// run, and whether the HQ root was resolved.
    fn run_global_install_in(
        identity: LaunchIdentity,
        enabled: bool,
        only: Option<GlobalRuntime>,
        seed: impl FnOnce(&Path),
    ) -> (Result<(), String>, Vec<Vec<String>>, bool) {
        let home = TempHome::new();
        seed(home.path());
        let calls = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let resolved = Arc::new(Mutex::new(false));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let result = runtime.block_on(apply_global_install(
            &identity,
            enabled,
            GlobalInstallTrigger::Reconcile,
            only,
            home.path(),
            &[],
            Duration::from_secs(20),
            {
                let resolved = resolved.clone();
                move || {
                    *resolved.lock().unwrap() = true;
                    Ok(PathBuf::from("/tmp/hq-root-for-test"))
                }
            },
            {
                let calls = calls.clone();
                move |argv: Vec<String>, _hq_root: PathBuf| {
                    calls.lock().unwrap().push(argv);
                    async { Ok(()) }
                }
            },
        ));
        let calls = calls.lock().unwrap().clone();
        let resolved = *resolved.lock().unwrap();
        (result, calls, resolved)
    }

    #[test]
    fn a_scratch_bundle_makes_no_install_or_uninstall_call_at_startup() {
        for enabled in [false, true] {
            for identity in [
                bundle(Some(SCRATCH_BUNDLE_ID)),
                bundle(Some("ai.indigo.hq-lane-check")),
                bundle(Some("ai.indigo.hq-sync-menubar-dev")),
                bundle(None),
                LaunchIdentity {
                    scratch_flag: true,
                    bundle_identifier: Some(
                        hq_platform::autostart::PRODUCTION_BUNDLE_IDENTIFIER.to_string(),
                    ),
                },
            ] {
                let (result, calls, resolved) = run_startup_reconcile(identity.clone(), enabled);
                assert_eq!(result, Ok(()), "{identity:?}");
                assert!(calls.is_empty(), "{identity:?} ran hq {calls:?}");
                assert!(!resolved, "{identity:?} resolved the HQ root");
            }
        }
    }

    #[test]
    fn the_production_bundle_still_runs_the_global_runtime_commands() {
        let (result, calls, resolved) = run_global_install_in(production(), false, None, |home| {
            write_claude_install(home);
            write_codex_install(home);
            write_desktop_marker_for(home, "claude");
            write_desktop_marker_for(home, "codex");
        });
        assert_eq!(result, Ok(()));
        assert!(resolved);
        assert_eq!(
            calls,
            [
                ["uninstall", "--global", "--runtime", "claude"],
                ["uninstall", "--global", "--runtime", "codex"],
            ]
        );

        let (result, calls, _) = run_startup_reconcile(production(), true);
        assert_eq!(result, Ok(()));
        assert_eq!(
            calls,
            [
                ["install", "--global", "--runtime", "claude"],
                ["install", "--global", "--runtime", "codex"],
            ]
        );
    }

    /// The 2026-10-15 log showed `hq uninstall --global --runtime claude`
    /// failing with "No HQ global install found" in bursts of three, about
    /// 4 s apart, for a person with HQ Anywhere off and nothing installed.
    #[test]
    fn an_opted_out_person_with_nothing_installed_runs_no_uninstall() {
        let (result, calls, resolved) = run_startup_reconcile(production(), false);
        assert_eq!(result, Ok(()));
        assert!(calls.is_empty(), "ran hq {calls:?}");
        assert!(!resolved, "resolved the HQ root with nothing to remove");
    }

    #[test]
    fn uninstall_still_removes_a_partial_install() {
        let (result, calls, _) = run_global_install_in(production(), false, None, |home| {
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::write(
                home.join(".claude.json"),
                r#"{"mcpServers":{"hq":{"_hqPack":"hq-anywhere"}}}"#,
            )
            .unwrap();
            fs::create_dir_all(home.join(".codex")).unwrap();
            fs::write(
                home.join(".codex/AGENTS.md"),
                "<!-- hq-anywhere:begin (managed by `hq install --global --runtime codex`) -->\nHQ\n<!-- hq-anywhere:end -->\n",
            )
            .unwrap();
            write_desktop_marker_for(home, "claude");
            write_desktop_marker_for(home, "codex");
        });
        assert_eq!(result, Ok(()));
        assert_eq!(
            calls,
            [
                ["uninstall", "--global", "--runtime", "claude"],
                ["uninstall", "--global", "--runtime", "codex"],
            ]
        );
    }

    #[test]
    fn uninstall_removes_a_plugin_mode_install_known_only_by_its_install_record() {
        let (result, calls, _) = run_global_install_in(production(), false, None, |home| {
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::create_dir_all(home.join(".hq/anywhere")).unwrap();
            fs::write(
                home.join(".hq/anywhere/claude-install.json"),
                r#"{"plugin":{"pluginId":"hq@hq"}}"#,
            )
            .unwrap();
            write_desktop_marker_for(home, "claude");
        });
        assert_eq!(result, Ok(()));
        assert_eq!(calls, [["uninstall", "--global", "--runtime", "claude"]]);
    }

    /// HQ Anywhere is on by default and the saved desktop setting defaults to
    /// false, so launch sync asks for an uninstall for everyone who never
    /// turned it on. A setup made with `hq install --global` has no desktop
    /// record and must survive that request.
    #[test]
    fn launch_sync_leaves_a_cli_made_install_the_desktop_never_turned_on() {
        let (result, calls, resolved) = run_global_install_in(production(), false, None, |home| {
            write_claude_install(home);
            write_codex_install(home);
        });
        assert_eq!(result, Ok(()));
        assert!(calls.is_empty(), "removed a CLI-made install: {calls:?}");
        assert!(!resolved, "resolved the HQ root with nothing to remove");
    }

    #[test]
    fn launch_sync_leaves_a_cli_made_plugin_install_the_desktop_never_turned_on() {
        let (result, calls, _) = run_global_install_in(production(), false, None, |home| {
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::create_dir_all(home.join(".hq/anywhere")).unwrap();
            fs::write(
                home.join(".hq/anywhere/claude-install.json"),
                r#"{"plugin":{"pluginId":"hq@hq"}}"#,
            )
            .unwrap();
        });
        assert_eq!(result, Ok(()));
        assert!(calls.is_empty(), "removed a CLI-made install: {calls:?}");
    }

    /// `hq uninstall --global` then `hq install --global`, with no desktop
    /// launch in between, leaves the desktop's record pointing at an install
    /// that is gone. The fresh CLI install must survive the next launch with
    /// the setting off, and the stale record must be dropped.
    #[test]
    fn launch_sync_does_not_remove_a_fresh_cli_install_after_a_stale_desktop_record() {
        let home = TempHome::new();
        write_claude_install(home.path());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let calls = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let run = |enabled: bool| {
            let calls = calls.clone();
            runtime.block_on(apply_global_install(
                &production(),
                enabled,
                GlobalInstallTrigger::Reconcile,
                None,
                home.path(),
                &[],
                Duration::from_secs(20),
                || Ok(PathBuf::from("/tmp/hq-root-for-test")),
                move |argv: Vec<String>, _hq_root: PathBuf| {
                    calls.lock().unwrap().push(argv);
                    async { Ok(()) }
                },
            ))
        };

        assert_eq!(run(true), Ok(()));
        let marker = home.path().join(".hq/anywhere/claude-desktop-enabled");
        assert!(
            marker.is_file(),
            "desktop did not record the install it adopted"
        );

        fs::remove_file(home.path().join(".claude/CLAUDE.md")).unwrap();
        fs::remove_file(home.path().join(".claude.json")).unwrap();
        fs::write(
            home.path().join(".claude/CLAUDE.md"),
            "<!-- hq-anywhere:begin managed -->\nHQ fresh\n<!-- hq-anywhere:end -->\n",
        )
        .unwrap();
        fs::write(
            home.path().join(".claude.json"),
            r#"{"mcpServers":{"hq":{"_hqPack":"hq-anywhere","installed":"fresh"}}}"#,
        )
        .unwrap();

        calls.lock().unwrap().clear();
        assert_eq!(run(false), Ok(()));
        assert!(
            calls.lock().unwrap().is_empty(),
            "removed a fresh CLI install: {:?}",
            calls.lock().unwrap()
        );
        assert!(!marker.exists(), "stale desktop record was kept");
    }

    #[test]
    fn launch_sync_removes_only_the_runtime_the_desktop_turned_on() {
        let (result, calls, _) = run_global_install_in(production(), false, None, |home| {
            write_claude_install(home);
            write_codex_install(home);
            write_desktop_marker_for(home, "codex");
        });
        assert_eq!(result, Ok(()));
        assert_eq!(calls, [["uninstall", "--global", "--runtime", "codex"]]);
    }

    /// Install, adopt and uninstall keep the desktop record in step, so a
    /// later turn-off removes what the desktop set up and nothing else.
    #[test]
    fn the_desktop_record_follows_install_adopt_and_uninstall() {
        let home = TempHome::new();
        let marker = |runtime: &str| {
            home.path()
                .join(format!(".hq/anywhere/{runtime}-desktop-enabled"))
        };
        write_claude_install(home.path());
        fs::create_dir_all(home.path().join(".codex")).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let calls = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let home_path = home.path().to_path_buf();
        let run = |enabled: bool| {
            let calls = calls.clone();
            let home_path = home_path.clone();
            runtime.block_on(apply_global_install(
                &production(),
                enabled,
                GlobalInstallTrigger::Reconcile,
                None,
                home.path(),
                &[],
                Duration::from_secs(20),
                || Ok(PathBuf::from("/tmp/hq-root-for-test")),
                move |argv: Vec<String>, _hq_root: PathBuf| {
                    if argv.first().map(String::as_str) == Some("install")
                        && argv.iter().any(|arg| arg == "codex")
                    {
                        write_codex_install(&home_path);
                    }
                    calls.lock().unwrap().push(argv);
                    async { Ok(()) }
                },
            ))
        };

        assert_eq!(run(true), Ok(()));
        assert!(
            marker("claude").is_file(),
            "did not adopt the existing claude setup"
        );
        assert!(
            desktop_adopted_install(home.path()),
            "an adopted install was not reported to Settings"
        );
        assert!(
            marker("codex").is_file(),
            "did not record the codex install"
        );
        assert_eq!(
            calls.lock().unwrap().clone(),
            [["install", "--global", "--runtime", "codex"]]
        );

        calls.lock().unwrap().clear();
        assert_eq!(run(false), Ok(()));
        assert_eq!(
            calls.lock().unwrap().clone(),
            [
                ["uninstall", "--global", "--runtime", "claude"],
                ["uninstall", "--global", "--runtime", "codex"],
            ]
        );
        assert!(!marker("claude").exists());
        assert!(!marker("codex").exists());
    }

    #[test]
    fn a_failed_uninstall_keeps_the_desktop_record() {
        let home = TempHome::new();
        write_claude_install(home.path());
        write_desktop_marker_for(home.path(), "claude");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let result = runtime.block_on(apply_global_install(
            &production(),
            false,
            GlobalInstallTrigger::Reconcile,
            Some(GlobalRuntime::Claude),
            home.path(),
            &[],
            Duration::from_secs(20),
            || Ok(PathBuf::from("/tmp/hq-root-for-test")),
            |_argv: Vec<String>, _hq_root: PathBuf| async { Err("boom".to_string()) },
        ));
        assert!(result.is_err());
        assert!(home
            .path()
            .join(".hq/anywhere/claude-desktop-enabled")
            .is_file());
    }

    /// Installing writes origin "installed". The next launch with the switch
    /// still on must leave that label alone, or Settings would claim the
    /// person had an install HQ Desktop only took on.
    #[test]
    fn a_later_launch_does_not_relabel_a_desktop_install_as_adopted() {
        let home = TempHome::new();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let home_path = home.path().to_path_buf();
        let calls = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let run = |enabled: bool| {
            let calls = calls.clone();
            let home_path = home_path.clone();
            runtime.block_on(apply_global_install(
                &production(),
                enabled,
                GlobalInstallTrigger::Reconcile,
                Some(GlobalRuntime::Claude),
                home.path(),
                &[],
                Duration::from_secs(20),
                || Ok(PathBuf::from("/tmp/hq-root-for-test")),
                move |argv: Vec<String>, _hq_root: PathBuf| {
                    if argv.first().map(String::as_str) == Some("install") {
                        write_claude_install(&home_path);
                    }
                    calls.lock().unwrap().push(argv);
                    async { Ok(()) }
                },
            ))
        };

        assert_eq!(run(true), Ok(()));
        let marker_path = home.path().join(".hq/anywhere/claude-desktop-enabled");
        let marker = fs::read_to_string(&marker_path).unwrap();
        assert!(
            marker.contains("\"origin\":\"installed\""),
            "desktop install was not recorded as its own: {marker}"
        );
        assert!(
            !desktop_adopted_install(home.path()),
            "a desktop install was reported as adopted"
        );

        calls.lock().unwrap().clear();
        assert_eq!(run(true), Ok(()));
        assert!(
            calls.lock().unwrap().is_empty(),
            "relaunched install: {:?}",
            calls.lock().unwrap()
        );
        let marker = fs::read_to_string(&marker_path).unwrap();
        assert!(
            marker.contains("\"origin\":\"installed\""),
            "a later launch relabeled the desktop install: {marker}"
        );
        assert!(!desktop_adopted_install(home.path()));

        calls.lock().unwrap().clear();
        assert_eq!(run(false), Ok(()));
        assert_eq!(
            calls.lock().unwrap().clone(),
            [["uninstall", "--global", "--runtime", "claude"]]
        );
        assert!(!marker_path.exists());
    }

    /// A matching record still authorises uninstall. The files are the ones
    /// the desktop adopted, so turning the setting off removes that install.
    #[test]
    fn a_matching_desktop_record_still_uninstalls_when_the_setting_is_turned_off() {
        let (result, calls, _) = run_global_install_in(production(), false, None, |home| {
            write_claude_install(home);
            write_desktop_marker_for(home, "claude");
        });
        assert_eq!(result, Ok(()));
        assert_eq!(calls, [["uninstall", "--global", "--runtime", "claude"]]);
    }

    /// Runs [`apply_global_install`] once against `home`. An `hq install`
    /// writes that runtime's files, the way the CLI does. Returns the result
    /// and every `hq` argv the runner was asked to run.
    fn apply_in(
        home: &Path,
        enabled: bool,
        trigger: GlobalInstallTrigger,
    ) -> (Result<(), String>, Vec<Vec<String>>) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let calls = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let home_path = home.to_path_buf();
        let result = runtime.block_on(apply_global_install(
            &production(),
            enabled,
            trigger,
            None,
            home,
            &[],
            Duration::from_secs(20),
            || Ok(PathBuf::from("/tmp/hq-root-for-test")),
            {
                let calls = calls.clone();
                move |argv: Vec<String>, _hq_root: PathBuf| {
                    if argv.first().map(String::as_str) == Some("install") {
                        if argv.iter().any(|arg| arg == "claude") {
                            write_claude_install(&home_path);
                        } else if argv.iter().any(|arg| arg == "codex") {
                            write_codex_install(&home_path);
                        }
                    }
                    calls.lock().unwrap().push(argv);
                    async { Ok(()) }
                }
            },
        ));
        let calls = calls.lock().unwrap().clone();
        (result, calls)
    }

    fn append(path: &Path, text: &str) {
        let mut contents = fs::read_to_string(path).unwrap_or_default();
        contents.push_str(text);
        fs::write(path, contents).unwrap();
    }

    /// Claude Code rewrites `~/.claude.json` all the time (startup counts,
    /// project history), and people add their own lines to CLAUDE.md. Those
    /// edits leave the HQ block and the HQ MCP entry alone, so the desktop
    /// record must still match and turning the setting off must remove the
    /// install the desktop made.
    #[test]
    fn unrelated_edits_to_claude_files_keep_the_desktop_record() {
        let home = TempHome::new();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        let (result, calls) = apply_in(home.path(), true, GlobalInstallTrigger::PersonChoice);
        assert_eq!(result, Ok(()));
        assert_eq!(calls, [["install", "--global", "--runtime", "claude"]]);

        fs::write(
            home.path().join(".claude.json"),
            r#"{"numStartups":5,"projects":{"/tmp/x":{}},"mcpServers":{"hq":{"_hqPack":"hq-anywhere"}}}"#,
        )
        .unwrap();
        append(&home.path().join(".claude/CLAUDE.md"), "\nMy own note.\n");

        let (result, calls) = apply_in(home.path(), false, GlobalInstallTrigger::Reconcile);
        assert_eq!(result, Ok(()));
        assert_eq!(calls, [["uninstall", "--global", "--runtime", "claude"]]);
    }

    /// The Codex side of the same check: another MCP server added to
    /// config.toml and a line added to AGENTS.md outside the HQ block.
    #[test]
    fn unrelated_edits_to_codex_files_keep_the_desktop_record() {
        let home = TempHome::new();
        fs::create_dir_all(home.path().join(".codex")).unwrap();
        let (result, calls) = apply_in(home.path(), true, GlobalInstallTrigger::PersonChoice);
        assert_eq!(result, Ok(()));
        assert_eq!(calls, [["install", "--global", "--runtime", "codex"]]);

        let config = home.path().join(".codex/config.toml");
        let original = fs::read_to_string(&config).unwrap();
        fs::write(
            &config,
            format!("model = \"o4\"\n\n{original}\n[mcp_servers.other]\ncommand = \"other\"\n"),
        )
        .unwrap();
        append(&home.path().join(".codex/AGENTS.md"), "\nMy own note.\n");

        let (result, calls) = apply_in(home.path(), false, GlobalInstallTrigger::Reconcile);
        assert_eq!(result, Ok(()));
        assert_eq!(calls, [["uninstall", "--global", "--runtime", "codex"]]);
    }

    /// The counterpart: a CLI reinstall that rewrote the HQ block, or only the
    /// HQ MCP entry, is not the install the desktop recorded. Launch sync
    /// leaves it in place.
    #[test]
    fn a_replaced_hq_block_or_mcp_entry_is_left_by_launch_sync() {
        for replace_block in [true, false] {
            let home = TempHome::new();
            fs::create_dir_all(home.path().join(".claude")).unwrap();
            let (result, _) = apply_in(home.path(), true, GlobalInstallTrigger::PersonChoice);
            assert_eq!(result, Ok(()));
            if replace_block {
                fs::write(
                    home.path().join(".claude/CLAUDE.md"),
                    "<!-- hq-anywhere:begin managed -->\nHQ fresh\n<!-- hq-anywhere:end -->\n",
                )
                .unwrap();
            } else {
                fs::write(
                    home.path().join(".claude.json"),
                    r#"{"mcpServers":{"hq":{"_hqPack":"hq-anywhere","installed":"fresh"}}}"#,
                )
                .unwrap();
            }

            let (result, calls) = apply_in(home.path(), false, GlobalInstallTrigger::Reconcile);
            assert_eq!(result, Ok(()));
            assert!(
                calls.is_empty(),
                "launch sync removed a replaced install (replace_block={replace_block}): {calls:?}"
            );
            assert!(!home
                .path()
                .join(".hq/anywhere/claude-desktop-enabled")
                .exists());
        }
    }

    /// Turning the switch off is the person's choice. A desktop record that
    /// no longer matches must not stop the removal they asked for.
    #[test]
    fn turning_the_switch_off_removes_the_install_when_the_record_is_stale() {
        let home = TempHome::new();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        let (result, _) = apply_in(home.path(), true, GlobalInstallTrigger::PersonChoice);
        assert_eq!(result, Ok(()));
        fs::write(
            home.path().join(".claude/CLAUDE.md"),
            "<!-- hq-anywhere:begin managed -->\nHQ fresh\n<!-- hq-anywhere:end -->\n",
        )
        .unwrap();

        let (result, calls) = apply_in(home.path(), false, GlobalInstallTrigger::PersonChoice);
        assert_eq!(result, Ok(()));
        assert_eq!(calls, [["uninstall", "--global", "--runtime", "claude"]]);
        assert!(!home
            .path()
            .join(".hq/anywhere/claude-desktop-enabled")
            .exists());
    }

    /// A setup made only with `hq install --global` has no desktop record.
    /// Turning the switch off leaves it, as it did before the record existed.
    #[test]
    fn turning_the_switch_off_leaves_an_install_with_no_desktop_record() {
        let home = TempHome::new();
        write_claude_install(home.path());
        let (result, calls) = apply_in(home.path(), false, GlobalInstallTrigger::PersonChoice);
        assert_eq!(result, Ok(()));
        assert!(calls.is_empty(), "removed a CLI-made install: {calls:?}");
    }

    /// Unrelated edits must not relabel a desktop install as adopted on the
    /// next launch, or Settings would describe the wrong install.
    #[test]
    fn unrelated_edits_do_not_relabel_a_desktop_install_as_adopted() {
        let home = TempHome::new();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        let (result, _) = apply_in(home.path(), true, GlobalInstallTrigger::PersonChoice);
        assert_eq!(result, Ok(()));
        fs::write(
            home.path().join(".claude.json"),
            r#"{"numStartups":9,"mcpServers":{"hq":{"_hqPack":"hq-anywhere"}}}"#,
        )
        .unwrap();

        let (result, calls) = apply_in(home.path(), true, GlobalInstallTrigger::Reconcile);
        assert_eq!(result, Ok(()));
        assert!(calls.is_empty(), "relaunched install: {calls:?}");
        assert!(
            !desktop_adopted_install(home.path()),
            "an unrelated edit relabeled the desktop install as adopted"
        );
    }

    /// Runs one launch sync with the setting off, using `run_hq` in place of
    /// the CLI and `deadline` as the command deadline.
    fn launch_sync_off_with<F, Fut>(
        home: &Path,
        deadline: Duration,
        run_hq: F,
    ) -> Result<(), String>
    where
        F: FnMut(Vec<String>, PathBuf) -> Fut,
        Fut: std::future::Future<Output = Result<(), String>>,
    {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        runtime.block_on(apply_global_install(
            &production(),
            false,
            GlobalInstallTrigger::Reconcile,
            Some(GlobalRuntime::Claude),
            home,
            &[],
            deadline,
            || Ok(PathBuf::from("/tmp/hq-root-for-test")),
            run_hq,
        ))
    }

    /// `hq uninstall --global` removes the HQ MCP entry first. Stands in for
    /// a run that got that far and then stopped.
    fn remove_claude_mcp_entry(home: &Path) {
        fs::write(home.join(".claude.json"), r#"{"mcpServers":{}}"#).unwrap();
    }

    /// The CLI removes the MCP entry first and its install record last. A
    /// launch uninstall that fails in between changes the HQ-owned content,
    /// so the record no longer matches. The next launch with the setting off
    /// must still finish the removal instead of dropping the record and
    /// leaving the rest of the install behind.
    #[test]
    fn a_partly_failed_launch_uninstall_is_retried_on_the_next_launch() {
        let home = TempHome::new();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        let (result, _) = apply_in(home.path(), true, GlobalInstallTrigger::PersonChoice);
        assert_eq!(result, Ok(()));
        let marker = home.path().join(".hq/anywhere/claude-desktop-enabled");

        let home_path = home.path().to_path_buf();
        let result =
            launch_sync_off_with(home.path(), Duration::from_secs(20), move |_argv, _root| {
                remove_claude_mcp_entry(&home_path);
                async { Err("hooks could not be removed".to_string()) }
            });
        assert!(result.is_err());
        assert!(
            marker.is_file(),
            "a failed uninstall dropped the desktop record"
        );

        let calls = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let result = launch_sync_off_with(home.path(), Duration::from_secs(20), {
            let calls = calls.clone();
            move |argv, _root| {
                calls.lock().unwrap().push(argv);
                async { Ok(()) }
            }
        });
        assert_eq!(result, Ok(()));
        assert_eq!(
            calls.lock().unwrap().clone(),
            [["uninstall", "--global", "--runtime", "claude"]],
            "the next launch did not finish the removal"
        );
        assert!(
            !marker.exists(),
            "a finished uninstall kept the desktop record"
        );
    }

    /// The same for an uninstall that the 20 s deadline stops after the CLI
    /// removed the MCP entry.
    #[test]
    fn a_timed_out_launch_uninstall_is_retried_on_the_next_launch() {
        let home = TempHome::new();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        let (result, _) = apply_in(home.path(), true, GlobalInstallTrigger::PersonChoice);
        assert_eq!(result, Ok(()));
        let marker = home.path().join(".hq/anywhere/claude-desktop-enabled");

        let home_path = home.path().to_path_buf();
        let result = launch_sync_off_with(
            home.path(),
            Duration::from_millis(80),
            move |_argv, _root| {
                remove_claude_mcp_entry(&home_path);
                std::future::pending::<Result<(), String>>()
            },
        );
        assert!(result.is_err());
        assert!(
            marker.is_file(),
            "a timed-out uninstall dropped the desktop record"
        );

        let calls = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let result = launch_sync_off_with(home.path(), Duration::from_secs(20), {
            let calls = calls.clone();
            move |argv, _root| {
                calls.lock().unwrap().push(argv);
                async { Ok(()) }
            }
        });
        assert_eq!(result, Ok(()));
        assert_eq!(
            calls.lock().unwrap().clone(),
            [["uninstall", "--global", "--runtime", "claude"]],
            "the next launch did not finish the removal"
        );
        assert!(!marker.exists());
    }

    /// Turning the setting back on after a failed uninstall installs again
    /// and leaves a plain record, so a later launch is back to matching the
    /// fingerprint only.
    #[test]
    fn turning_the_setting_on_after_a_failed_uninstall_clears_the_pending_removal() {
        let home = TempHome::new();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        let (result, _) = apply_in(home.path(), true, GlobalInstallTrigger::PersonChoice);
        assert_eq!(result, Ok(()));
        let home_path = home.path().to_path_buf();
        let result =
            launch_sync_off_with(home.path(), Duration::from_secs(20), move |_argv, _root| {
                remove_claude_mcp_entry(&home_path);
                async { Err("boom".to_string()) }
            });
        assert!(result.is_err());

        let (result, calls) = apply_in(home.path(), true, GlobalInstallTrigger::Reconcile);
        assert_eq!(result, Ok(()));
        assert_eq!(calls, [["install", "--global", "--runtime", "claude"]]);
        let record =
            fs::read_to_string(home.path().join(".hq/anywhere/claude-desktop-enabled")).unwrap();
        assert!(
            !record.contains("uninstall_pending"),
            "the reinstall kept the pending removal: {record}"
        );
    }

    /// The real CLI rewrites its install record on every install. A later
    /// same-version reinstall that writes byte-identical files still gives
    /// that record a new modified time, so launch sync leaves it.
    #[test]
    fn a_same_version_cli_reinstall_is_left_by_launch_sync() {
        let home = TempHome::new();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        let (result, _) = apply_in(home.path(), true, GlobalInstallTrigger::PersonChoice);
        assert_eq!(result, Ok(()));

        let record = home.path().join(".hq/anywhere/claude-install.json");
        let bytes = fs::read(&record).unwrap();
        let modified = fs::metadata(&record).unwrap().modified().unwrap();
        write_claude_install(home.path());
        fs::write(&record, &bytes).unwrap();
        fs::File::options()
            .write(true)
            .open(&record)
            .unwrap()
            .set_modified(modified + Duration::from_secs(60))
            .unwrap();

        let (result, calls) = apply_in(home.path(), false, GlobalInstallTrigger::Reconcile);
        assert_eq!(result, Ok(()));
        assert!(
            calls.is_empty(),
            "launch sync removed a CLI reinstall: {calls:?}"
        );
    }

    /// A hung `hq install` must drop the shared lock when the 20s deadline
    /// fires. The test uses a short deadline so it does not wait 20s. A later
    /// call has to acquire that same lock.
    #[test]
    fn a_hung_install_releases_the_lock_when_the_deadline_fires() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        runtime.block_on(async {
            let home = TempHome::new();
            fs::create_dir_all(home.path().join(".claude")).unwrap();
            let (entered_tx, entered_rx) = tokio::sync::oneshot::channel::<()>();
            let entered = Arc::new(Mutex::new(Some(entered_tx)));
            let home_path = home.path().to_path_buf();
            let hung = tokio::spawn(async move {
                apply_global_install_locked(
                    &production(),
                    true,
                    GlobalInstallTrigger::Reconcile,
                    Some(GlobalRuntime::Claude),
                    &home_path,
                    &[],
                    Duration::from_millis(80),
                    || Ok(PathBuf::from("/tmp/hq-root-for-test")),
                    move |_argv: Vec<String>, _hq_root: PathBuf| {
                        let entered = entered.clone();
                        async move {
                            if let Some(tx) = entered.lock().unwrap().take() {
                                let _ = tx.send(());
                            }
                            std::future::pending::<Result<(), String>>().await
                        }
                    },
                )
                .await
            });

            tokio::time::timeout(Duration::from_secs(2), entered_rx)
                .await
                .expect("hung install never took the lock")
                .expect("entered channel closed");

            let started = std::time::Instant::now();
            let second = tokio::time::timeout(
                Duration::from_secs(2),
                apply_global_install_locked(
                    &production(),
                    false,
                    GlobalInstallTrigger::Reconcile,
                    Some(GlobalRuntime::Claude),
                    home.path(),
                    &[],
                    Duration::from_secs(5),
                    || Ok(PathBuf::from("/tmp/hq-root-for-test")),
                    |_argv: Vec<String>, _hq_root: PathBuf| async { Ok(()) },
                ),
            )
            .await;
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "later sync waited on the hung install"
            );
            assert_eq!(
                second.expect("lock was still held after the deadline"),
                Ok(())
            );
            let hung_result = tokio::time::timeout(Duration::from_secs(2), hung)
                .await
                .expect("hung install did not finish when the deadline fired")
                .expect("hung task panicked");
            assert!(hung_result.is_err(), "a timed-out install reported success");
            assert!(
                !home
                    .path()
                    .join(".hq/anywhere/claude-desktop-enabled")
                    .exists(),
                "a timed-out install recorded itself"
            );
        });
    }

    #[test]
    fn the_hq_root_pointer_alone_is_not_an_install() {
        let (result, calls, _) = run_global_install_in(production(), false, None, |home| {
            fs::create_dir_all(home.join(".claude")).unwrap();
            fs::create_dir_all(home.join(".codex")).unwrap();
            fs::create_dir_all(home.join(".hq")).unwrap();
            fs::write(home.join(".hq/root"), "/tmp/HQ\n").unwrap();
        });
        assert_eq!(result, Ok(()));
        assert!(calls.is_empty(), "ran hq {calls:?}");
    }

    #[test]
    fn installing_for_one_tool_runs_only_that_runtime_even_before_its_folder_exists() {
        let (result, calls, resolved) =
            run_global_install_in(production(), true, Some(GlobalRuntime::Codex), |home| {
                fs::create_dir_all(home.join(".claude")).unwrap();
            });
        assert_eq!(result, Ok(()));
        assert!(resolved);
        assert_eq!(calls, [["install", "--global", "--runtime", "codex"]]);

        let (result, calls, _) =
            run_global_install_in(production(), true, Some(GlobalRuntime::Claude), |home| {
                write_claude_install(home);
            });
        assert_eq!(result, Ok(()));
        assert!(
            calls.is_empty(),
            "reinstalled an installed runtime: {calls:?}"
        );

        let (result, calls, _) = run_global_install_in(
            bundle(Some(SCRATCH_BUNDLE_ID)),
            true,
            Some(GlobalRuntime::Claude),
            |_| {},
        );
        assert_eq!(result, Ok(()));
        assert!(calls.is_empty(), "a scratch bundle ran hq {calls:?}");
    }

    #[test]
    fn a_disallowed_one_tool_install_is_not_installed() {
        let scratch = bundle(Some(SCRATCH_BUNDLE_ID));
        assert_eq!(
            disallowed_install_result(&scratch, Some(GlobalRuntime::Claude)),
            Err(HQ_ANYWHERE_NOT_INSTALLED.to_string())
        );
        assert_eq!(disallowed_install_result(&scratch, None), Ok(()));
        assert_eq!(
            disallowed_install_result(&production(), Some(GlobalRuntime::Codex)),
            Ok(())
        );
    }

    #[test]
    fn runtime_installed_for_tool_uses_the_full_install_check() {
        let home = TempHome::new();
        assert_eq!(runtime_installed_for_tool(home.path(), "claude"), Ok(false));
        write_claude_install(home.path());
        assert_eq!(runtime_installed_for_tool(home.path(), "claude"), Ok(true));
        assert_eq!(runtime_installed_for_tool(home.path(), "codex"), Ok(false));
        assert!(runtime_installed_for_tool(home.path(), "grok").is_err());
    }

    #[test]
    fn parses_only_the_supported_tool_names() {
        assert_eq!(GlobalRuntime::parse("claude"), Some(GlobalRuntime::Claude));
        assert_eq!(GlobalRuntime::parse("codex"), Some(GlobalRuntime::Codex));
        assert_eq!(GlobalRuntime::parse("grok"), None);
        assert_eq!(GlobalRuntime::parse("Claude --global"), None);
    }

    #[test]
    fn an_unsupported_tool_error_does_not_echo_the_renderer_string() {
        assert_eq!(parse_tool_runtime("claude"), Ok(GlobalRuntime::Claude));
        assert_eq!(
            parse_tool_runtime("<img src=x> --global"),
            Err("Unsupported coding tool".to_string())
        );
    }

    struct TempHome(PathBuf);

    impl TempHome {
        fn new() -> Self {
            // The clock alone collides between parallel tests on macOS, whose
            // clock has microsecond resolution; the counter keeps homes apart.
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock is after the epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "hq-anywhere-runtime-test-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temporary HOME");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn put_binary(bin_dir: &Path, name: &str) {
        fs::create_dir_all(bin_dir).expect("create temporary PATH entry");
        let binary = bin_dir.join(name);
        fs::write(&binary, "test executable").expect("write fake runtime binary");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&binary)
                .expect("read fake binary")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(binary, permissions).expect("mark fake binary executable");
        }
    }

    fn executable_name(base: &str) -> String {
        if cfg!(windows) {
            format!("{base}.exe")
        } else {
            base.to_string()
        }
    }

    #[test]
    fn builds_exact_install_and_uninstall_argv_for_each_runtime() {
        assert_eq!(
            global_runtime_args(RuntimeAction::Install, GlobalRuntime::Claude),
            ["install", "--global", "--runtime", "claude"]
        );
        assert_eq!(
            global_runtime_args(RuntimeAction::Install, GlobalRuntime::Codex),
            ["install", "--global", "--runtime", "codex"]
        );
        assert_eq!(
            global_runtime_args(RuntimeAction::Uninstall, GlobalRuntime::Claude),
            ["uninstall", "--global", "--runtime", "claude"]
        );
        assert_eq!(
            global_runtime_args(RuntimeAction::Uninstall, GlobalRuntime::Codex),
            ["uninstall", "--global", "--runtime", "codex"]
        );
    }

    #[test]
    fn detects_both_runtimes_from_their_home_directories() {
        let home = TempHome::new();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        fs::create_dir_all(home.path().join(".codex")).unwrap();

        assert_eq!(
            detect_present_runtimes(home.path(), &[]),
            [GlobalRuntime::Claude, GlobalRuntime::Codex]
        );
    }

    #[test]
    fn detects_claude_only_when_its_binary_is_on_path() {
        let home = TempHome::new();
        let bin = home.path().join("bin");
        put_binary(&bin, &executable_name("claude"));

        assert_eq!(
            detect_present_runtimes(home.path(), &[bin]),
            [GlobalRuntime::Claude]
        );
    }

    #[test]
    fn detects_codex_only_when_its_binary_is_on_path() {
        let home = TempHome::new();
        let bin = home.path().join("bin");
        put_binary(&bin, &executable_name("codex"));

        assert_eq!(
            detect_present_runtimes(home.path(), &[bin]),
            [GlobalRuntime::Codex]
        );
    }

    #[test]
    fn detects_no_runtime_when_neither_home_nor_path_has_one() {
        let home = TempHome::new();
        let bin = home.path().join("bin");
        fs::create_dir_all(&bin).unwrap();

        assert!(detect_present_runtimes(home.path(), &[bin]).is_empty());
    }

    #[test]
    fn skips_a_runtime_only_when_its_managed_block_and_hq_mcp_entry_exist() {
        let home = TempHome::new();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        fs::write(
            home.path().join(".claude/CLAUDE.md"),
            "<!-- hq-anywhere:begin managed -->\nHQ\n<!-- hq-anywhere:end -->\n",
        )
        .unwrap();
        fs::write(
            home.path().join(".claude.json"),
            r#"{"mcpServers":{"hq":{"_hqPack":"hq-anywhere"}}}"#,
        )
        .unwrap();
        assert!(global_runtime_is_installed(
            home.path(),
            GlobalRuntime::Claude
        ));

        fs::create_dir_all(home.path().join(".codex")).unwrap();
        fs::write(
            home.path().join(".codex/AGENTS.md"),
            "<!-- hq-anywhere:begin (managed by `hq install --global --runtime codex`) -->\nHQ\n<!-- hq-anywhere:end -->\n",
        )
        .unwrap();
        fs::write(
            home.path().join(".codex/config.toml"),
            "[mcp_servers.hq]\ncommand = \"hq-mcp\"\n_hqPack = \"hq-anywhere\"\n",
        )
        .unwrap();
        assert!(global_runtime_is_installed(
            home.path(),
            GlobalRuntime::Codex
        ));
    }

    #[test]
    fn does_not_skip_codex_setup_for_a_foreign_hq_mcp_entry() {
        let home = TempHome::new();
        fs::create_dir_all(home.path().join(".codex")).unwrap();
        fs::write(
            home.path().join(".codex/AGENTS.md"),
            "<!-- hq-anywhere:begin (managed by `hq install --global --runtime codex`) -->\nHQ\n<!-- hq-anywhere:end -->\n",
        )
        .unwrap();
        fs::write(
            home.path().join(".codex/config.toml"),
            "[mcp_servers.hq]\ncommand = \"other-server\"\n_hqPack = \"another-pack\"\n",
        )
        .unwrap();

        assert!(!global_runtime_is_installed(
            home.path(),
            GlobalRuntime::Codex
        ));
    }

    #[test]
    fn renderer_failure_does_not_expose_cli_diagnostics() {
        let details = "hq install failed: secret path and raw stderr";
        let renderer_message = safe_renderer_failure(details);

        assert_eq!(renderer_message, "HQ Anywhere setup failed. Tap to retry.");
        assert!(!renderer_message.contains("secret path"));
        assert!(!renderer_message.contains("raw stderr"));
    }
}
