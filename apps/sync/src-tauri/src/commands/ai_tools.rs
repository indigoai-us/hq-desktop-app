//! Cross-platform AI coding tool detection used by the onboarding Done screen.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::Path;
#[cfg(windows)]
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

#[cfg(windows)]
use crate::commands::install_deps::extended_search_path;

const CLI_PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const RECENCY_MAX_DEPTH: usize = 2;
const RECENCY_MAX_ENTRIES: usize = 2_000;

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

#[tauri::command]
pub fn detect_ai_tools() -> AiTools {
    let mut tools = detect_ai_tools_in(
        claude_desktop_installed(),
        codex_desktop_installed(),
        None,
        CLI_PROBE_TIMEOUT,
    );
    if let Some(home) = dirs::home_dir() {
        tools.claude_last_used_ms = last_used_ms_in(&cli_config_dir_in(&home, "claude"));
        tools.codex_last_used_ms = last_used_ms_in(&cli_config_dir_in(&home, "codex"));
        tools.grok_last_used_ms = last_used_ms_in(&cli_config_dir_in(&home, "grok"));
    }
    tools
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

#[cfg(not(windows))]
fn codex_desktop_installed() -> bool {
    if std::path::Path::new("/Applications/Codex.app").exists() {
        return true;
    }

    dirs::home_dir()
        .map(|home| home.join("Applications/Codex.app").exists())
        .unwrap_or(false)
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
