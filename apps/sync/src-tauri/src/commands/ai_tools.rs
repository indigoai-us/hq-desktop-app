//! Cross-platform AI coding tool detection used by the onboarding Done screen.

use std::ffi::{OsStr, OsString};
#[cfg(windows)]
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

#[cfg(windows)]
use crate::commands::install_deps::extended_search_path;

const CLI_PROBE_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AiTools {
    pub claude_cli: bool,
    pub claude_desktop: bool,
    pub codex_cli: bool,
    pub codex_desktop: bool,
    pub grok_cli: bool,
    pub any: bool,
}

#[tauri::command]
pub fn detect_ai_tools() -> AiTools {
    detect_ai_tools_in(
        claude_desktop_installed(),
        codex_desktop_installed(),
        None,
        CLI_PROBE_TIMEOUT,
    )
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
        any,
    }
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
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        if local.join("AnthropicClaude").join("claude.exe").exists()
            || local
                .join("Programs")
                .join("Claude")
                .join("Claude.exe")
                .exists()
        {
            return true;
        }
    }
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        if PathBuf::from(program_files)
            .join("Claude")
            .join("Claude.exe")
            .exists()
        {
            return true;
        }
    }
    false
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
                any: false,
            }
        );
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
