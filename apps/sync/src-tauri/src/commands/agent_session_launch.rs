//! "Open this session outside the app" — reopen an in-app Sessions thread in
//! its native CLI surface.
//!
//! This is a shell boundary, so it mirrors the hardening in
//! [`crate::commands::launch`] rather than relaxing it:
//!
//!   * the binary comes from `launch::cli_binary_for`'s three-value allowlist —
//!     never from the caller's string;
//!   * the session id is validated as a **UUID** before it is interpolated, so
//!     no quote, space, or shell metacharacter can reach the command line
//!     (both Claude's `~/.claude/projects/**/<uuid>.jsonl` and Codex's
//!     `rollout-<ts>-<uuid>.jsonl` ids are lowercase-hex UUIDs);
//!   * nothing else in the command is caller-controlled.
//!
//! Surface choice, from the evidence in `launch.rs` /
//! `hq_desktop_core::claude_launch`:
//!
//!   * **Claude** — the only known deep link is `claude://code/new?…`, which
//!     starts a *new* conversation. There is no documented resume deep link, so
//!     resuming goes to a Terminal running `claude --resume <id>`. We do not
//!     invent a `claude://` resume URL.
//!   * **Codex** — `codex app <path>` opens the desktop app *at a folder*, not
//!     at a thread (the app ignores `cwd` on `codex://threads/new`), so a
//!     thread resume also goes to a Terminal, running `codex resume <id>`.
//!
//! `opened` therefore reports `"terminal"` today. The `"desktop"` value is
//! reserved for the moment a real resume deep link exists, so the frontend
//! contract does not have to change then.

use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::os::windows::process::CommandExt as _;
use std::process::Command;

use crate::commands::launch::cli_binary_for;

#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInAppOutcome {
    /// `"terminal"` | `"desktop"`.
    pub opened: String,
    /// Human-readable description of what was launched.
    pub detail: String,
}

/// Reopen a CLI session outside the app.
///
/// `tool` must be `"claude"` or `"codex"`; `cliSessionId` must be a UUID.
#[tauri::command]
pub fn agent_session_open_in_app(
    tool: String,
    cli_session_id: String,
) -> Result<OpenInAppOutcome, String> {
    let binary = resume_binary(&tool)?;
    let session_id = validate_session_id(&cli_session_id)?;
    let args = resume_args(&tool, &session_id)?;

    let hq_root = hq_desktop_core::workspaces::resolve_hq_folder_path()?;
    let cwd = hq_root.to_string_lossy().into_owned();

    spawn_resume_terminal(&cwd, binary, &args)?;

    Ok(OpenInAppOutcome {
        opened: "terminal".to_string(),
        detail: format!("{binary} {} in {cwd}", args.join(" ")),
    })
}

/// Tools that have a resume surface. Grok's is `grok --resume <id>`.
fn resume_binary(tool: &str) -> Result<&'static str, String> {
    match tool {
        "claude" | "codex" | "grok" => cli_binary_for(tool),
        other => Err(format!("Unsupported CLI tool for resume: {other}")),
    }
}

/// The resume arguments for each tool. Every element is either a literal or an
/// already-validated UUID.
fn resume_args(tool: &str, session_id: &str) -> Result<Vec<String>, String> {
    match tool {
        "claude" => Ok(vec!["--resume".to_string(), session_id.to_string()]),
        "codex" => Ok(vec!["resume".to_string(), session_id.to_string()]),
        "grok" => Ok(vec!["--resume".to_string(), session_id.to_string()]),
        other => Err(format!("Unsupported CLI tool for resume: {other}")),
    }
}

/// Validate a CLI session id as a canonical UUID (`8-4-4-4-12` hex).
///
/// This is the security gate for the interpolation below, so it is a whitelist
/// on shape *and* alphabet — not a blocklist of dangerous characters.
fn validate_session_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    if id.len() != 36 {
        return Err(format!(
            "invalid session id (expected a 36-character UUID, got {} characters)",
            id.chars().count()
        ));
    }
    let groups = [8usize, 4, 4, 4, 12];
    let mut parts = id.split('-');
    for expected in groups {
        let Some(part) = parts.next() else {
            return Err("invalid session id (malformed UUID)".to_string());
        };
        if part.len() != expected || !part.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid session id (malformed UUID)".to_string());
        }
    }
    if parts.next().is_some() {
        return Err("invalid session id (malformed UUID)".to_string());
    }
    Ok(id.to_ascii_lowercase())
}

/// Open a Terminal window at `cwd` running `binary <args…>`.
///
/// `binary` and `args` must both come from trusted sources (a literal, the
/// `cli_binary_for` allowlist, or a validated UUID) because they are
/// interpolated into a shell command. `cwd` is quote-escaped.
#[cfg(not(windows))]
fn spawn_resume_terminal(cwd: &str, binary: &str, args: &[String]) -> Result<(), String> {
    let escaped_cwd = cwd.replace('\'', "'\\''");
    let shell_cmd = format!("cd '{}' && {} {}", escaped_cwd, binary, args.join(" "));
    let applescript_safe = shell_cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        r#"tell application "Terminal"
    activate
    do script "{}"
end tell"#,
        applescript_safe
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to spawn osascript: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "osascript failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn spawn_resume_terminal(cwd: &str, binary: &str, args: &[String]) -> Result<(), String> {
    let search_path = crate::commands::install_deps::extended_search_path();
    let joined = args.join(" ");

    let wt = which_in_path("wt.exe", &search_path).or_else(|| which_in_path("wt", &search_path));
    if let Some(wt_path) = wt {
        let mut command = Command::new(wt_path);
        command.args([
            "-d",
            cwd,
            "powershell.exe",
            "-NoProfile",
            "-NoExit",
            "-Command",
            &format!("{binary} {joined}"),
        ]);
        command
            .env("PATH", &search_path)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to spawn Windows Terminal: {e}"))
    } else {
        let escaped = cwd.replace('\'', "''");
        let ps_cmd = format!("Set-Location -LiteralPath '{escaped}'; {binary} {joined}");
        Command::new("powershell.exe")
            .args(["-NoProfile", "-NoExit", "-Command", &ps_cmd])
            .env("PATH", &search_path)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to spawn PowerShell: {e}"))
    }
}

#[cfg(windows)]
fn which_in_path(binary: &str, search_path: &str) -> Option<std::path::PathBuf> {
    for dir in std::env::split_paths(search_path) {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            return Some(candidate);
        }
        let with_exe = candidate.with_extension("exe");
        if with_exe.is_file() {
            return Some(with_exe);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_real_claude_and_codex_session_ids() {
        // Shapes taken from `~/.claude/projects/**/<id>.jsonl` and
        // `~/.codex/sessions/**/rollout-<ts>-<id>.jsonl`.
        assert_eq!(
            validate_session_id("006601d4-d91b-4c39-af7b-ff52e8ec73a4").unwrap(),
            "006601d4-d91b-4c39-af7b-ff52e8ec73a4"
        );
        assert_eq!(
            validate_session_id("01a01ef6-1052-7371-9d2d-47292120f593").unwrap(),
            "01a01ef6-1052-7371-9d2d-47292120f593"
        );
        // Surrounding whitespace is trimmed and hex is normalized to lowercase.
        assert_eq!(
            validate_session_id("  006601D4-D91B-4C39-AF7B-FF52E8EC73A4 ").unwrap(),
            "006601d4-d91b-4c39-af7b-ff52e8ec73a4"
        );
    }

    #[test]
    fn rejects_shell_metacharacters_and_injection_attempts() {
        for evil in [
            "006601d4-d91b-4c39-af7b-ff52e8ec73a4; rm -rf ~",
            "006601d4-d91b-4c39-af7b-ff52e8ec7'a4",
            "006601d4-d91b-4c39-af7b-ff52e8ec73a$",
            "$(whoami)-d91b-4c39-af7b-ff52e8ec73a4",
            "006601d4-d91b-4c39-af7b-ff52e8ec73a4\n--dangerous",
            "../../etc/passwd",
            "`id`",
        ] {
            assert!(
                validate_session_id(evil).is_err(),
                "should reject: {evil:?}"
            );
        }
    }

    #[test]
    fn rejects_malformed_uuid_shapes() {
        for bad in [
            "",
            "not-a-uuid",
            "006601d4d91b4c39af7bff52e8ec73a4",      // no dashes
            "006601d4-d91b-4c39-af7b-ff52e8ec73a",   // too short
            "006601d4-d91b-4c39-af7b-ff52e8ec73a44", // too long
            "006601d4-d91b-4c39-af7b-ff52e8ec73g4",  // non-hex
            "006601d4-d91b-4c39-af7b-ff52-8ec73a4",  // wrong grouping
            "006601d4--91b-4c39-af7b-ff52e8ec73a41", // empty group
        ] {
            assert!(validate_session_id(bad).is_err(), "should reject: {bad:?}");
        }
    }

    #[test]
    fn resume_binary_uses_the_launcher_allowlist() {
        assert_eq!(resume_binary("claude").unwrap(), "claude");
        assert_eq!(resume_binary("codex").unwrap(), "codex");
        assert_eq!(resume_binary("grok").unwrap(), "grok");
        for bad in ["", "Claude", "claude.exe", "bash", "claude; rm -rf ~"] {
            assert!(resume_binary(bad).is_err(), "should reject: {bad}");
        }
    }

    #[test]
    fn resume_args_match_each_cli() {
        let id = "006601d4-d91b-4c39-af7b-ff52e8ec73a4";
        assert_eq!(resume_args("claude", id).unwrap(), vec!["--resume", id]);
        assert_eq!(resume_args("codex", id).unwrap(), vec!["resume", id]);
        assert_eq!(resume_args("grok", id).unwrap(), vec!["--resume", id]);
    }
}
