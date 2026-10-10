//! Cross-platform AI coding tool detection used by the onboarding Done screen.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

#[cfg(windows)]
use crate::commands::install_deps::extended_search_path;
use crate::commands::install_directory::resolve_hq_path;
use crate::util::paths;

const CLI_PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const RECENCY_MAX_DEPTH: usize = 2;
const RECENCY_MAX_ENTRIES: usize = 2_000;
const CLAUDE_DESKTOP_CONNECTOR_SOURCE_SET: &str = "claude_desktop_config";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AiTools {
    pub claude_cli: bool,
    pub claude_desktop: bool,
    pub codex_cli: bool,
    pub codex_desktop: bool,
    pub grok_cli: bool,
    pub claude_last_used_ms: Option<u64>,
    pub codex_last_used_ms: Option<u64>,
    pub grok_last_used_ms: Option<u64>,
    pub any: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClaudeReady {
    pub installed: bool,
    pub desktop_installed: bool,
    pub logged_in: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeDesktopConnectors {
    pub present: bool,
    pub count: u32,
    pub outcome: &'static str,
    pub inspected_sources: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorImportResult {
    pub ok: bool,
    pub message: String,
    pub error_category: &'static str,
}

/// Probe the installed AI tools. Blocking: launches up to three shell
/// probes (each bounded by `CLI_PROBE_TIMEOUT`) and stats up to
/// `RECENCY_MAX_ENTRIES` config entries per tool. Never call this on the
/// main thread — see `detect_ai_tools` for the command wrapper.
pub fn detect_ai_tools_blocking() -> AiTools {
    let mut tools = detect_ai_tools_in(
        claude_desktop_installed(),
        codex_desktop_installed(),
        None,
        CLI_PROBE_TIMEOUT,
    );
    // The Codex CLI ships INSIDE the ChatGPT app bundle
    // (Contents/Resources/codex or codex-cli/bin/codex), so a machine with the desktop app has a
    // full CLI even when nothing is on PATH. Count it: workspace launches
    // resolve the bundled binary directly.
    if !tools.codex_cli && crate::commands::launch::bundled_codex_bin().is_some() {
        tools.codex_cli = true;
        tools.any = true;
    }
    // Same for Claude: the desktop app manages a verified Claude Code CLI under
    // Application Support and never adds it to PATH. Sessions spawn that
    // binary directly (see agent_session::claude::claude_program), so it is an
    // installed CLI in every sense that matters to the user.
    if !tools.claude_cli && crate::commands::launch::bundled_claude_bin().is_some() {
        tools.claude_cli = true;
        tools.any = true;
    }
    if let Some(home) = dirs::home_dir() {
        tools.claude_last_used_ms = last_used_ms_in(&cli_config_dir_in(&home, "claude"));
        tools.codex_last_used_ms = last_used_ms_in(&cli_config_dir_in(&home, "codex"));
        tools.grok_last_used_ms = last_used_ms_in(&cli_config_dir_in(&home, "grok"));
    }
    tools
}

/// The desktop shell calls this while it boots. A synchronous Tauri command
/// runs inline on the main thread inside WebKit's IPC handler, so the shell
/// probes and the config-tree stats above froze every window, every other
/// command, and the boot watchdog's own `shell_ready` for as long as the disk
/// took — seconds to tens of seconds under sync load. Run it on the blocking
/// pool instead.
#[tauri::command]
pub async fn detect_ai_tools() -> AiTools {
    match tokio::task::spawn_blocking(detect_ai_tools_blocking).await {
        Ok(tools) => tools,
        Err(error) => {
            crate::util::logfile::log(
                "ai-tools",
                &format!("detect_ai_tools blocking task failed ({error}); probing inline"),
            );
            detect_ai_tools_blocking()
        }
    }
}

/// Claude Code, Codex, and Grok CLIs keep their user config in dot-directories
/// under the platform home directory, including Windows' `%USERPROFILE%`.
fn cli_config_dir_in(home: &Path, tool: &str) -> std::path::PathBuf {
    home.join(format!(".{tool}"))
}

#[tauri::command]
pub fn detect_claude_ready() -> ClaudeReady {
    // This is polled during installation, so it is filesystem-only: detect_ai_tools
    // launches shell probes that can take up to four seconds each.
    let home = dirs::home_dir();
    let desktop_installed = claude_desktop_installed();
    ClaudeReady {
        installed: desktop_installed || claude_cli_on_search_path(),
        desktop_installed,
        logged_in: home.as_deref().is_some_and(claude_logged_in_in),
    }
}

/// Read Claude Desktop's documented MCP configuration without treating a
/// missing, unreadable, or malformed file as an onboarding error.
#[tauri::command]
pub fn detect_claude_desktop_connectors() -> ClaudeDesktopConnectors {
    let config_path = claude_desktop_config_path();
    let desktop_installed = claude_desktop_installed();
    #[cfg(target_os = "linux")]
    let desktop_installed =
        linux_connector_config_indicates_desktop(desktop_installed, config_path.as_deref());
    detect_claude_desktop_connectors_in(desktop_installed, config_path.as_deref())
}

/// Run the existing CLI importer from the configured HQ root for one company.
///
/// Integrations are company-scoped. hq-cli only guesses a company when the
/// person has exactly one active membership, and exits 1 for a person with
/// none, so the wizard always names the company picked or created in the
/// flow. Without a valid company this never spawns the CLI.
///
/// A failed import never turns into a Tauri command error that could trap the
/// onboarding flow. Each outcome is written to hq-sync.log (ok, exit code,
/// category, first stderr line) so the next failure can be diagnosed there.
#[tauri::command]
pub async fn import_claude_desktop_connectors(company: Option<String>) -> ConnectorImportResult {
    import_connectors_with(company.as_deref(), run_hq_integrations_import, |line| {
        crate::util::logfile::log("ai-tools", line)
    })
    .await
}

/// One import attempt: what it returned, the CLI exit code when it ran, and
/// the short detail (first stderr line or the app-side reason) for the log.
struct ImportAttempt {
    result: ConnectorImportResult,
    exit_code: Option<i32>,
    detail: Option<String>,
}

/// The import with its CLI runner and logger injected, so tests can prove the
/// CLI is never run without a company and never touch the real hq-sync.log.
async fn import_connectors_with<Run, Fut>(
    company: Option<&str>,
    run: Run,
    log: impl Fn(&str),
) -> ConnectorImportResult
where
    Run: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = ImportAttempt>,
{
    let attempt = match connector_import_company(company) {
        Some(company) => run(company).await,
        None => ImportAttempt {
            result: ConnectorImportResult {
                ok: false,
                message: "No company selected for the connector import.".to_string(),
                error_category: "not-found",
            },
            exit_code: None,
            detail: Some("no company selected".to_string()),
        },
    };
    log(&connector_import_log_line(
        &attempt.result,
        attempt.exit_code,
        attempt.detail.as_deref(),
    ));
    attempt.result
}

async fn run_hq_integrations_import(company: String) -> ImportAttempt {
    let hq_root = match resolve_hq_path() {
        Ok(path) => path,
        Err(error) => {
            return ImportAttempt {
                result: ConnectorImportResult {
                    ok: false,
                    message: error,
                    error_category: "not-found",
                },
                exit_code: None,
                detail: Some("HQ folder not resolved".to_string()),
            }
        }
    };
    let hq = paths::resolve_bin("hq");
    let mut command = paths::tokio_spawn_command(&hq, &[]);
    let output = command
        .args(connector_import_args(&company))
        .current_dir(&hq_root)
        .env("PATH", paths::child_path())
        .env("HQ_NO_UPDATE_CHECK", "1")
        .env("HQ_ROOT", &hq_root)
        .output()
        .await;

    match output {
        Ok(output) if output.status.success() => ImportAttempt {
            result: ConnectorImportResult {
                ok: true,
                message: hq_command_message(&output.stdout, &output.stderr, "Import completed."),
                error_category: "unknown",
            },
            exit_code: output.status.code(),
            detail: None,
        },
        Ok(output) => {
            let code = output.status.code();
            ImportAttempt {
                result: ConnectorImportResult {
                    ok: false,
                    message: hq_command_message(
                        &output.stdout,
                        &output.stderr,
                        &format!(
                            "hq integrations import exited with status {}.",
                            code.unwrap_or(-1)
                        ),
                    ),
                    error_category: "exit-nonzero",
                },
                exit_code: code,
                detail: first_line(&output.stderr),
            }
        }
        Err(error) => ImportAttempt {
            result: ConnectorImportResult {
                ok: false,
                message: format!("Failed to spawn hq integrations import: {error}"),
                error_category: "spawn-failed",
            },
            exit_code: None,
            detail: Some(error.to_string()),
        },
    }
}

/// The company reference handed to `hq integrations import --company`. hq-cli
/// accepts a company slug or a `cmp_` uid there. Anything else (empty, a
/// leading dash that could read as a flag, other characters) is refused so
/// the CLI never receives a guess or an injected option.
fn connector_import_company(company: Option<&str>) -> Option<String> {
    let company = company?.trim();
    let valid = !company.is_empty()
        && company.len() <= 128
        && !company.starts_with('-')
        && company
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    valid.then(|| company.to_string())
}

fn connector_import_args(company: &str) -> [&str; 4] {
    ["integrations", "import", "--company", company]
}

fn first_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(200).collect())
}

/// One log line per import attempt. Only the first stderr line (or the
/// app-side reason) is kept, capped at 200 characters, never stdout.
fn connector_import_log_line(
    result: &ConnectorImportResult,
    exit_code: Option<i32>,
    stderr_first_line: Option<&str>,
) -> String {
    let exit = exit_code.map_or_else(|| "none".to_string(), |code| code.to_string());
    let mut line = format!(
        "connector import ok={} exit={} category={}",
        result.ok,
        exit,
        if result.ok {
            "none"
        } else {
            result.error_category
        },
    );
    if !result.ok {
        if let Some(detail) = stderr_first_line.filter(|detail| !detail.is_empty()) {
            line.push_str(&format!(" detail={detail:?}"));
        }
    }
    line
}

fn hq_command_message(stdout: &[u8], stderr: &[u8], fallback: &str) -> String {
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout}\n{stderr}"),
        (false, true) => stdout,
        (true, false) => stderr,
        (true, true) => fallback.to_string(),
    }
}

fn claude_desktop_connector_result(
    present: bool,
    count: u32,
    outcome: &'static str,
) -> ClaudeDesktopConnectors {
    ClaudeDesktopConnectors {
        present,
        count,
        outcome,
        inspected_sources: CLAUDE_DESKTOP_CONNECTOR_SOURCE_SET,
    }
}

fn detect_claude_desktop_connectors_in(
    desktop_installed: bool,
    config_path: Option<&Path>,
) -> ClaudeDesktopConnectors {
    if !desktop_installed {
        return claude_desktop_connector_result(false, 0, "tool_not_installed");
    }
    let Some(path) = config_path else {
        return claude_desktop_connector_result(false, 0, "config_path_unavailable");
    };
    detect_claude_desktop_connectors_at_path(path)
}

fn detect_claude_desktop_connectors_at_path(path: &Path) -> ClaudeDesktopConnectors {
    let present = match fs::metadata(path) {
        Ok(metadata) => metadata.is_file(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return claude_desktop_connector_result(false, 0, "config_missing")
        }
        Err(_) => return claude_desktop_connector_result(false, 0, "config_unreadable"),
    };
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(_) => return claude_desktop_connector_result(present, 0, "config_unreadable"),
    };
    let json = match serde_json::from_str::<Value>(&contents) {
        Ok(json) => json,
        Err(_) => return claude_desktop_connector_result(true, 0, "config_invalid"),
    };
    let Some(servers) = json.get("mcpServers").and_then(Value::as_object) else {
        return claude_desktop_connector_result(true, 0, "zero_servers");
    };
    let Ok(count) = u32::try_from(servers.len()) else {
        return claude_desktop_connector_result(true, 0, "unknown");
    };
    if count == 0 {
        claude_desktop_connector_result(true, 0, "zero_servers")
    } else {
        claude_desktop_connector_result(true, count, "servers_detected")
    }
}

#[cfg(target_os = "macos")]
fn claude_desktop_config_path() -> Option<PathBuf> {
    dirs::home_dir()
        .map(|home| home.join("Library/Application Support/Claude/claude_desktop_config.json"))
}

#[cfg(target_os = "linux")]
fn claude_desktop_config_path() -> Option<PathBuf> {
    linux_claude_desktop_config_path_in(
        std::env::var_os("XDG_CONFIG_HOME").as_deref(),
        dirs::home_dir().as_deref(),
    )
}

#[cfg(target_os = "linux")]
fn linux_claude_desktop_config_path_in(
    xdg_config_home: Option<&OsStr>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    xdg_config_home
        .map(PathBuf::from)
        .or_else(|| home.map(|home| home.join(".config")))
        .map(|config_home| config_home.join("Claude/claude_desktop_config.json"))
}

/// Linux distributions do not install a macOS-style application bundle. A
/// Claude Desktop config at the documented XDG location is therefore the
/// supported local signal that its connector probe can run.
#[cfg(target_os = "linux")]
fn linux_connector_config_indicates_desktop(
    desktop_installed: bool,
    config_path: Option<&Path>,
) -> bool {
    desktop_installed || config_path.is_some_and(Path::is_file)
}

#[cfg(windows)]
fn claude_desktop_config_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|app_data| app_data.join("Claude/claude_desktop_config.json"))
}

fn detect_ai_tools_in(
    claude_desktop: bool,
    codex_desktop: bool,
    path_override: Option<OsString>,
    timeout: Duration,
) -> AiTools {
    let probes = ["claude", "codex", "grok"].map(|binary| {
        let path_override = path_override.clone();
        std::thread::spawn(move || cli_runnable(binary, path_override.as_deref(), timeout))
    });

    let [claude_cli, codex_cli, grok_cli] = probes.map(|probe| probe.join().unwrap_or(false));
    let any = claude_cli || claude_desktop || codex_cli || codex_desktop || grok_cli;

    AiTools {
        claude_cli,
        claude_desktop,
        codex_cli,
        codex_desktop,
        grok_cli,
        claude_last_used_ms: None,
        codex_last_used_ms: None,
        grok_last_used_ms: None,
        any,
    }
}

/// Bounded config-tree mtime resolver; individual filesystem failures are ignored.
fn last_used_ms_in(base: &Path) -> Option<u64> {
    fn update(latest: &mut Option<u64>, path: &Path) {
        let Ok(time) = fs::metadata(path).and_then(|metadata| metadata.modified()) else {
            return;
        };
        let Ok(duration) = time.duration_since(UNIX_EPOCH) else {
            return;
        };
        let millis = duration.as_millis().try_into().unwrap_or(u64::MAX);
        *latest = Some(latest.map_or(millis, |current| current.max(millis)));
    }
    fn walk(path: &Path, depth: usize, examined: &mut usize, latest: &mut Option<u64>) {
        update(latest, path);
        if depth >= RECENCY_MAX_DEPTH || *examined >= RECENCY_MAX_ENTRIES {
            return;
        }
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            if *examined >= RECENCY_MAX_ENTRIES {
                return;
            }
            *examined += 1;
            let path = entry.path();
            update(latest, &path);
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                walk(&path, depth + 1, examined, latest);
            }
        }
    }
    let mut latest = None;
    let mut examined = 0;
    walk(base, 0, &mut examined, &mut latest);
    latest
}

#[cfg(not(windows))]
fn claude_cli_on_search_path() -> bool {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path).any(|directory| directory.join("claude").is_file())
}

#[cfg(windows)]
fn claude_cli_on_search_path() -> bool {
    let path = extended_search_path();
    std::env::split_paths(&path).any(|directory| {
        ["exe", "cmd", "bat"]
            .iter()
            .any(|extension| directory.join(format!("claude.{extension}")).is_file())
    })
}

/// Claude Code markers only. Claude Desktop credentials are held in macOS
/// Keychain/Windows DPAPI; its documented `claude_desktop_config.json` can be
/// created before login, so treating it as proof of sign-in would be a false
/// positive. The onboarding watcher uses a bounded installed-only fallback for
/// Desktop instead of reading credentials or inventing a filesystem marker.
fn claude_logged_in_in(home: &Path) -> bool {
    if home.join(".claude/.credentials.json").is_file() {
        return true;
    }
    fs::read_to_string(home.join(".claude.json"))
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .is_some_and(|json| json.get("oauthAccount").is_some())
}

fn cli_runnable(binary: &str, path_override: Option<&OsStr>, timeout: Duration) -> bool {
    // The Done-screen launcher opens a fresh terminal, so the CLI needs to
    // resolve and run through that terminal's PATH/login-shell environment.
    #[cfg(not(windows))]
    let mut command = unix_probe_command(binary, path_override.is_some());
    #[cfg(windows)]
    let mut command = windows_probe_command(binary);

    if let Some(path) = path_override {
        command.env("PATH", path);
    }

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    command_success_with_timeout(command, timeout)
}

#[cfg(not(windows))]
fn unix_probe_command(binary: &str, deterministic_test_path: bool) -> Command {
    let shell = if deterministic_test_path {
        OsString::from("/bin/sh")
    } else {
        std::env::var_os("SHELL").unwrap_or_else(|| OsString::from("/bin/sh"))
    };
    let quoted = shell_single_quote(binary);
    let mut command = Command::new(shell);
    // Production uses a login shell so PATH matches a fresh Terminal window.
    // Tests intentionally avoid `-l`: macOS path_helper rewrites PATH in login
    // shells and can leak real system tools into fixture-only probes.
    let flag = if deterministic_test_path { "-c" } else { "-lc" };
    command.args([
        flag,
        &format!("command -v {quoted} >/dev/null 2>&1 && {quoted} --version"),
    ]);
    command
}

#[cfg(windows)]
fn windows_probe_command(binary: &str) -> Command {
    let comspec = std::env::var_os("COMSPEC").unwrap_or_else(|| OsString::from("cmd.exe"));
    let mut command = Command::new(comspec);
    command.args(["/C", &format!("{binary} --version")]);
    command.env("PATH", extended_search_path());
    // Background AI-tool capability probes must not flash a console window.
    // Explicit user-requested terminals (Done-screen launchers) stay visible.
    crate::util::paths::no_window(&mut command);
    command
}

#[cfg(not(windows))]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn command_success_with_timeout(mut command: Command, timeout: Duration) -> bool {
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return false,
    };
    let started = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }

        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }

        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(not(windows))]
fn claude_desktop_installed() -> bool {
    if std::path::Path::new("/Applications/Claude.app").exists() {
        return true;
    }

    dirs::home_dir()
        .map(|home| home.join("Applications/Claude.app").exists())
        .unwrap_or(false)
}

#[cfg(windows)]
fn claude_desktop_installed() -> bool {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
    claude_desktop_installed_in(local.as_deref(), program_files.as_deref())
}

#[cfg(windows)]
fn claude_desktop_installed_in(local: Option<&Path>, program_files: Option<&Path>) -> bool {
    let in_local = local.is_some_and(|local| {
        local.join("AnthropicClaude").join("claude.exe").is_file()
            || local
                .join("Programs")
                .join("Claude")
                .join("Claude.exe")
                .is_file()
    });
    let in_program_files = program_files
        .is_some_and(|program_files| program_files.join("Claude").join("Claude.exe").is_file());
    in_local || in_program_files
}

/// Bundle names that ship desktop Codex on macOS.
///
/// Codex desktop is distributed inside the ChatGPT app — `/Applications/
/// ChatGPT.app`, bundle id `com.openai.codex`, registering the `codex://`
/// scheme. Probing only for `Codex.app` therefore reports "not installed" on
/// a machine that has Codex and can launch it: `launch_codex_desktop` runs
/// `open -a Codex`, which LaunchServices resolves to that same bundle. The
/// detector was the only half that went by filename.
///
/// Both names are kept: `Codex.app` for anyone carrying the standalone build,
/// `ChatGPT.app` for the current distribution.
#[cfg(not(windows))]
const CODEX_DESKTOP_BUNDLES: [&str; 2] = ["Codex.app", "ChatGPT.app"];

#[cfg(not(windows))]
fn codex_desktop_installed() -> bool {
    codex_desktop_installed_in(
        std::path::Path::new("/Applications"),
        dirs::home_dir()
            .map(|home| home.join("Applications"))
            .as_deref(),
    )
}

#[cfg(not(windows))]
fn codex_desktop_installed_in(system: &Path, user: Option<&Path>) -> bool {
    CODEX_DESKTOP_BUNDLES.iter().any(|bundle| {
        system.join(bundle).exists() || user.is_some_and(|user_dir| user_dir.join(bundle).exists())
    })
}

#[cfg(windows)]
fn codex_desktop_installed() -> bool {
    let Ok(local) = std::env::var("LOCALAPPDATA") else {
        return false;
    };
    let base = PathBuf::from(local).join("Programs").join("Codex");
    base.join("Codex.exe").exists() || base.join("codex.exe").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_reflects_desktop_tools() {
        let tools = detect_ai_tools_in(
            true,
            false,
            Some(OsString::from("/definitely/not/a/real/path")),
            Duration::from_millis(100),
        );
        assert!(tools.claude_desktop);
        assert!(tools.any);

        let tools = detect_ai_tools_in(
            false,
            true,
            Some(OsString::from("/definitely/not/a/real/path")),
            Duration::from_millis(100),
        );
        assert!(tools.codex_desktop);
        assert!(tools.any);
    }

    #[test]
    fn any_is_false_when_no_tools_are_found() {
        let dir = tempfile::tempdir().expect("tempdir");
        let tools = detect_ai_tools_in(
            false,
            false,
            Some(dir.path().as_os_str().to_os_string()),
            Duration::from_millis(100),
        );

        assert_eq!(
            tools,
            AiTools {
                claude_cli: false,
                claude_desktop: false,
                codex_cli: false,
                codex_desktop: false,
                grok_cli: false,
                claude_last_used_ms: None,
                codex_last_used_ms: None,
                grok_last_used_ms: None,
                any: false,
            }
        );
    }

    #[test]
    fn resolves_recency_and_skips_missing_fixture_directories() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(last_used_ms_in(&dir.path().join("missing")), None);
        fs::create_dir(dir.path().join(".claude")).expect("create fixture");
        fs::write(dir.path().join(".claude/history.jsonl"), "history").expect("write fixture");
        assert!(last_used_ms_in(&dir.path().join(".claude")).is_some());
    }

    #[cfg(not(windows))]
    #[test]
    fn resolves_cli_recency_dirs_under_the_home_directory() {
        let home = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            cli_config_dir_in(home.path(), "claude"),
            home.path().join(".claude")
        );
        assert_eq!(
            cli_config_dir_in(home.path(), "codex"),
            home.path().join(".codex")
        );
        assert_eq!(
            cli_config_dir_in(home.path(), "grok"),
            home.path().join(".grok")
        );
    }

    #[test]
    fn detects_present_and_absent_claude_login_markers() {
        let home = tempfile::tempdir().expect("tempdir");
        assert!(!claude_logged_in_in(home.path()));
        fs::create_dir(home.path().join(".claude")).expect("create config");
        fs::write(home.path().join(".claude/.credentials.json"), "{}").expect("write credentials");
        assert!(claude_logged_in_in(home.path()));
        let oauth_home = tempfile::tempdir().expect("tempdir");
        fs::write(
            oauth_home.path().join(".claude.json"),
            r#"{"oauthAccount":{}}"#,
        )
        .expect("write oauth marker");
        assert!(claude_logged_in_in(oauth_home.path()));
    }

    #[test]
    fn classifies_each_claude_desktop_connector_config_result_without_exposing_its_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = dir.path().join("claude_desktop_config.json");

        let tool_missing = detect_claude_desktop_connectors_in(false, Some(&config));
        assert_eq!(tool_missing.outcome, "tool_not_installed");
        assert_eq!(tool_missing.inspected_sources, "claude_desktop_config");

        let config_path_unavailable = detect_claude_desktop_connectors_in(true, None);
        assert_eq!(config_path_unavailable.outcome, "config_path_unavailable");

        let missing = detect_claude_desktop_connectors_in(true, Some(&config));
        assert!(!missing.present);
        assert_eq!(missing.count, 0);
        assert_eq!(missing.outcome, "config_missing");

        fs::write(&config, r#"{"mcpServers":{"linear":{},"notion":{}}}"#).expect("write config");
        let detected = detect_claude_desktop_connectors_in(true, Some(&config));
        assert!(detected.present);
        assert_eq!(detected.count, 2);
        assert_eq!(detected.outcome, "servers_detected");

        fs::write(&config, "not json").expect("write invalid config");
        let invalid = detect_claude_desktop_connectors_in(true, Some(&config));
        assert!(invalid.present);
        assert_eq!(invalid.count, 0);
        assert_eq!(invalid.outcome, "config_invalid");

        fs::write(&config, r#"{"mcpServers":{}}"#).expect("write empty config");
        let empty = detect_claude_desktop_connectors_in(true, Some(&config));
        assert_eq!(empty.outcome, "zero_servers");

        fs::remove_file(&config).expect("remove config");
        fs::create_dir(&config).expect("create unreadable fixture directory");
        let unreadable = detect_claude_desktop_connectors_in(true, Some(&config));
        assert_eq!(unreadable.outcome, "config_unreadable");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn resolves_claude_desktop_config_under_xdg_config_home() {
        let xdg_config_home = tempfile::tempdir().expect("tempdir");
        let home = tempfile::tempdir().expect("tempdir");

        let path = linux_claude_desktop_config_path_in(
            Some(xdg_config_home.path().as_os_str()),
            Some(home.path()),
        );

        assert_eq!(
            path,
            Some(
                xdg_config_home
                    .path()
                    .join("Claude/claude_desktop_config.json")
            )
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_connector_probe_uses_supported_config_as_desktop_evidence() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = dir.path().join("Claude/claude_desktop_config.json");

        assert!(!linux_connector_config_indicates_desktop(
            false,
            Some(&config)
        ));
        fs::create_dir_all(config.parent().expect("config parent")).expect("create config parent");
        fs::write(&config, r#"{"mcpServers":{"linear":{}}}"#).expect("write config");

        let detected = detect_claude_desktop_connectors_in(
            linux_connector_config_indicates_desktop(false, Some(&config)),
            Some(&config),
        );
        assert!(detected.present);
        assert_eq!(detected.count, 1);
        assert_eq!(detected.outcome, "servers_detected");
    }

    #[test]
    fn connector_import_passes_the_named_company() {
        assert_eq!(
            connector_import_company(Some("acme")).as_deref(),
            Some("acme")
        );
        assert_eq!(
            connector_import_company(Some(" cmp_01ABCdef ")).as_deref(),
            Some("cmp_01ABCdef")
        );
        assert_eq!(
            connector_import_args("acme"),
            ["integrations", "import", "--company", "acme"]
        );
    }

    #[test]
    fn connector_import_refuses_a_missing_or_unsafe_company() {
        assert_eq!(connector_import_company(None), None);
        assert_eq!(connector_import_company(Some("")), None);
        assert_eq!(connector_import_company(Some("   ")), None);
        assert_eq!(connector_import_company(Some("--dry-run")), None);
        assert_eq!(connector_import_company(Some("acme co")), None);
        assert_eq!(connector_import_company(Some("acme;rm")), None);
        assert_eq!(connector_import_company(Some(&"a".repeat(129))), None);
    }

    #[tokio::test]
    async fn connector_import_without_a_company_never_runs_the_cli() {
        for company in [None, Some(""), Some("--dry-run")] {
            let spawned = std::cell::Cell::new(false);
            let logged = std::cell::RefCell::new(Vec::<String>::new());
            let result = import_connectors_with(
                company,
                |_company| {
                    spawned.set(true);
                    async { unreachable!("the CLI must not run without a company") }
                },
                |line| logged.borrow_mut().push(line.to_string()),
            )
            .await;
            assert!(!spawned.get(), "{company:?} must not run the CLI");
            assert!(!result.ok);
            assert_eq!(result.error_category, "not-found");
            assert_eq!(
                logged.into_inner(),
                vec!["connector import ok=false exit=none category=not-found \
                     detail=\"no company selected\""
                    .to_string()]
            );
        }
    }

    #[tokio::test]
    async fn connector_import_runs_the_cli_for_the_named_company_and_logs_its_exit() {
        let ran_for = std::cell::RefCell::new(None::<String>);
        let logged = std::cell::RefCell::new(Vec::<String>::new());
        let result = import_connectors_with(
            Some("acme"),
            |company| {
                *ran_for.borrow_mut() = Some(company);
                async {
                    ImportAttempt {
                        result: ConnectorImportResult {
                            ok: false,
                            message: "raw".to_string(),
                            error_category: "exit-nonzero",
                        },
                        exit_code: Some(1),
                        detail: Some("hq: something failed".to_string()),
                    }
                }
            },
            |line| logged.borrow_mut().push(line.to_string()),
        )
        .await;
        assert_eq!(ran_for.into_inner().as_deref(), Some("acme"));
        assert_eq!(result.error_category, "exit-nonzero");
        assert_eq!(
            logged.into_inner(),
            vec!["connector import ok=false exit=1 category=exit-nonzero \
                 detail=\"hq: something failed\""
                .to_string()]
        );
    }

    #[test]
    fn connector_import_log_line_names_outcome_exit_and_category() {
        let failed = ConnectorImportResult {
            ok: false,
            message: "stdout noise\nmore".to_string(),
            error_category: "exit-nonzero",
        };
        assert_eq!(
            connector_import_log_line(
                &failed,
                Some(1),
                Some("hq: No active company memberships found.")
            ),
            "connector import ok=false exit=1 category=exit-nonzero \
             detail=\"hq: No active company memberships found.\""
        );
        let ok = ConnectorImportResult {
            ok: true,
            message: "Imported 2 connectors".to_string(),
            error_category: "unknown",
        };
        assert_eq!(
            connector_import_log_line(&ok, Some(0), None),
            "connector import ok=true exit=0 category=none"
        );
        assert_eq!(
            first_line(b"\n  hq: first line  \nsecond\n").as_deref(),
            Some("hq: first line")
        );
    }

    #[test]
    fn combines_hq_command_output_without_losing_stderr() {
        assert_eq!(
            hq_command_message(b"done\n", b"warning\n", "fallback"),
            "done\nwarning"
        );
        assert_eq!(hq_command_message(b"", b"", "fallback"), "fallback");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn desktop_config_is_not_mistaken_for_a_macos_login_marker() {
        let home = tempfile::tempdir().expect("tempdir");
        let config = home
            .path()
            .join("Library/Application Support/Claude/claude_desktop_config.json");
        fs::create_dir_all(config.parent().expect("config parent")).expect("create config parent");
        fs::write(config, "{}").expect("write desktop config");
        assert!(!claude_logged_in_in(home.path()));
    }

    #[cfg(windows)]
    #[test]
    fn desktop_config_is_not_mistaken_for_a_windows_login_marker() {
        let home = tempfile::tempdir().expect("tempdir");
        let config = home
            .path()
            .join("AppData/Roaming/Claude/claude_desktop_config.json");
        fs::create_dir_all(config.parent().expect("config parent")).expect("create config parent");
        fs::write(config, "{}").expect("write desktop config");
        assert!(!claude_logged_in_in(home.path()));
    }

    #[cfg(windows)]
    #[test]
    fn resolves_windows_cli_recency_dirs_under_userprofile() {
        let home = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            cli_config_dir_in(home.path(), "claude"),
            home.path().join(".claude")
        );
        assert_eq!(
            cli_config_dir_in(home.path(), "codex"),
            home.path().join(".codex")
        );
        assert_eq!(
            cli_config_dir_in(home.path(), "grok"),
            home.path().join(".grok")
        );
    }

    #[cfg(windows)]
    #[test]
    fn detects_supported_windows_claude_desktop_installer_layouts() {
        let root = tempfile::tempdir().expect("tempdir");
        let local = root.path().join("LocalAppData");
        let program_files = root.path().join("ProgramFiles");
        let direct = local.join("AnthropicClaude/claude.exe");
        fs::create_dir_all(direct.parent().expect("direct parent")).expect("create direct parent");
        fs::write(&direct, "").expect("write direct fixture");
        assert!(claude_desktop_installed_in(Some(&local), None));

        fs::remove_file(&direct).expect("remove direct fixture");
        let program = local.join("Programs/Claude/Claude.exe");
        fs::create_dir_all(program.parent().expect("program parent"))
            .expect("create program parent");
        fs::write(&program, "").expect("write program fixture");
        assert!(claude_desktop_installed_in(Some(&local), None));

        fs::remove_file(&program).expect("remove program fixture");
        let machine = program_files.join("Claude/Claude.exe");
        fs::create_dir_all(machine.parent().expect("machine parent"))
            .expect("create machine parent");
        fs::write(&machine, "").expect("write machine fixture");
        assert!(claude_desktop_installed_in(None, Some(&program_files)));
    }

    #[cfg(unix)]
    #[test]
    fn detects_supported_clis_on_supplied_path() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["claude", "codex", "grok"] {
            let path = dir.path().join(name);
            let mut file = std::fs::File::create(&path).expect("create fake cli");
            writeln!(file, "#!/bin/sh").expect("write shebang");
            writeln!(file, "test \"$1\" = \"--version\"").expect("write version check");
            writeln!(file, "echo '{name} 1.2.3'").expect("write version output");
            let mut perms = file.metadata().expect("metadata").permissions();
            drop(file);
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).expect("chmod fake cli");
        }

        let tools = detect_ai_tools_in(
            false,
            false,
            Some(dir.path().as_os_str().to_os_string()),
            Duration::from_secs(10),
        );
        assert!(tools.claude_cli);
        assert!(tools.codex_cli);
        assert!(tools.grok_cli);
        assert!(tools.any);
    }

    #[cfg(unix)]
    #[test]
    fn ignores_non_executable_cli_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("claude"), b"not executable").expect("write fake cli");

        let tools = detect_ai_tools_in(
            false,
            false,
            Some(dir.path().as_os_str().to_os_string()),
            Duration::from_millis(100),
        );
        assert!(!tools.claude_cli);
        assert!(!tools.any);
    }

    #[cfg(unix)]
    #[test]
    fn ignores_cli_that_exits_non_zero() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("claude");
        std::fs::write(&path, "#!/bin/sh\nexit 42\n").expect("write fake cli");
        let mut perms = std::fs::metadata(&path).expect("metadata").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod fake cli");

        let tools = detect_ai_tools_in(
            false,
            false,
            Some(dir.path().as_os_str().to_os_string()),
            Duration::from_millis(100),
        );
        assert!(!tools.claude_cli);
        assert!(!tools.any);
    }

    #[cfg(unix)]
    #[test]
    fn ignores_cli_that_times_out() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("claude");
        std::fs::write(&path, "#!/bin/sh\nsleep 5\n").expect("write fake cli");
        let mut perms = std::fs::metadata(&path).expect("metadata").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod fake cli");

        let tools = detect_ai_tools_in(
            false,
            false,
            Some(dir.path().as_os_str().to_os_string()),
            Duration::from_millis(100),
        );
        assert!(!tools.claude_cli);
        assert!(!tools.any);
    }
}

#[cfg(all(test, not(windows)))]
mod codex_desktop_tests {
    use super::codex_desktop_installed_in;
    use std::fs;
    use tempfile::tempdir;

    /// Regression: desktop Codex ships as ChatGPT.app (bundle id
    /// com.openai.codex). Probing only for Codex.app reported "not installed"
    /// on a machine that has it, so the Ready screen offered an install link
    /// for a tool the user already had — while `open -a Codex` would have
    /// launched it fine.
    #[test]
    fn finds_codex_shipped_inside_the_chatgpt_app() {
        let dir = tempdir().unwrap();
        let apps = dir.path().join("Applications");
        fs::create_dir_all(apps.join("ChatGPT.app")).unwrap();
        assert!(codex_desktop_installed_in(&apps, None));
    }

    #[test]
    fn still_finds_the_standalone_codex_app() {
        let dir = tempdir().unwrap();
        let apps = dir.path().join("Applications");
        fs::create_dir_all(apps.join("Codex.app")).unwrap();
        assert!(codex_desktop_installed_in(&apps, None));
    }

    #[test]
    fn finds_a_user_installed_bundle() {
        let dir = tempdir().unwrap();
        let system = dir.path().join("Applications");
        let user = dir.path().join("home/Applications");
        fs::create_dir_all(&system).unwrap();
        fs::create_dir_all(user.join("ChatGPT.app")).unwrap();
        assert!(codex_desktop_installed_in(&system, Some(&user)));
    }

    #[test]
    fn reports_absent_when_neither_bundle_exists() {
        let dir = tempdir().unwrap();
        let apps = dir.path().join("Applications");
        fs::create_dir_all(apps.join("Safari.app")).unwrap();
        assert!(!codex_desktop_installed_in(&apps, None));
    }
}

#[cfg(all(test, not(windows)))]
mod real_machine_probe {
    use super::detect_ai_tools_blocking;

    /// Diagnostic, not a gate. Runs the production detector against the real
    /// machine and prints what the Ready screen would render, so "why is there
    /// no Codex button?" can be answered from this machine's actual disk
    /// rather than from the browser harness, whose answers are fixtures.
    ///
    /// `#[ignore]` because the result depends on what is installed. Run with:
    #[test]
    fn detect_ai_tools_command_is_async_so_probes_stay_off_the_main_thread() {
        let src = include_str!("ai_tools.rs");
        let production = src.split("mod tests").next().expect("production source");
        assert!(
            production.contains("pub async fn detect_ai_tools() -> AiTools"),
            "detect_ai_tools must be an async command: a sync command runs on the main thread"
        );
        assert!(
            production.contains("spawn_blocking(detect_ai_tools_blocking)"),
            "detect_ai_tools must run the blocking probe on the blocking pool"
        );
    }

    ///   cargo test real_machine_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn report_what_the_ready_screen_would_show() {
        let tools = detect_ai_tools_blocking();

        let slot = |installed: bool, name: &str| {
            if installed {
                format!("Open in {name}")
            } else {
                format!("Install {name}")
            }
        };

        println!("\n--- detected on this machine ---");
        println!("  claude_cli     = {}", tools.claude_cli);
        println!("  claude_desktop = {}", tools.claude_desktop);
        println!("  codex_cli      = {}", tools.codex_cli);
        println!("  codex_desktop  = {}", tools.codex_desktop);
        println!("  grok_cli       = {}", tools.grok_cli);
        println!("--- Ready screen would render ---");
        println!(
            "  [{}]  [{}]",
            slot(tools.claude_cli || tools.claude_desktop, "Claude Code"),
            slot(tools.codex_cli || tools.codex_desktop, "Codex"),
        );
        println!();
    }
}
