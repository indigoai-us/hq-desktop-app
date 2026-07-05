//! Validated launch/reveal helpers — the security boundary for the handful of
//! commands that hand a user- or renderer-supplied string to the OS shell.
//!
//! Ported from the `hq-installer` `launch.rs` hardening. Two boundaries live
//! here:
//!
//!   * `validate_claude_deep_link` — a byte-level allowlist for `claude://`
//!     deep links before they reach `open`/ShellExecute. The renderer builds
//!     these URLs, but a compromised or buggy caller must not be able to smuggle
//!     shell metacharacters, quotes, whitespace/control bytes, or a malformed
//!     percent-escape through. `open_claude_code_link` calls this before opening.
//!
//!   * `validate_reveal_target` — canonical home-containment for `reveal_folder`
//!     so "show this in Finder/Explorer" can never be pointed outside the user's
//!     home directory (e.g. `/etc`, another user's home).
//!
//! The pure validators and terminal CLI allowlist are unit-tested. The terminal
//! spawn itself opens a visible Terminal/Windows Terminal window and needs
//! on-device smoke rather than a headless unit test.

#[cfg(windows)]
use std::ffi::OsString;
#[cfg(windows)]
use std::os::windows::process::CommandExt as _;
use std::path::PathBuf;
use std::process::Command;

#[cfg(windows)]
use crate::commands::install_deps::extended_search_path;

#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// Map a frontend tool identifier to the CLI binary we launch. The allowlist is
/// the security boundary: only these three values ever reach a shell.
fn cli_binary_for(tool: &str) -> Result<&'static str, String> {
    match tool {
        "claude" => Ok("claude"),
        "codex" => Ok("codex"),
        "grok" => Ok("grok"),
        other => Err(format!("Unsupported CLI tool: {other}")),
    }
}

/// PowerShell single-quote escaping: ' -> ''. Apply before wrapping the
/// resulting string in single quotes when handing a literal string to
/// PowerShell.
#[cfg(windows)]
fn powershell_single_quote_escape(s: &str) -> String {
    s.replace('\'', "''")
}

fn is_hex_digit(byte: u8) -> bool {
    byte.is_ascii_hexdigit()
}

/// The unreserved + reserved URI bytes we permit inside a `claude://` deep
/// link (RFC 3986 pchar/query/fragment set) — everything a legitimately
/// encoded deep link needs, and nothing that carries meaning to a shell.
fn is_allowed_claude_url_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'.'
                | b'_'
                | b'~'
                | b':'
                | b'/'
                | b'?'
                | b'#'
                | b'['
                | b']'
                | b'@'
                | b'!'
                | b'$'
                | b'&'
                | b'('
                | b')'
                | b'*'
                | b'+'
                | b','
                | b';'
                | b'='
        )
}

/// Validate a `claude://` deep link byte-for-byte before it is handed to the
/// OS URL opener. Rejects a non-`claude://` scheme, an empty URL, any
/// whitespace/control byte, the shell-dangerous set (`"' \` < > \ |`), and a
/// malformed `%XX` percent-escape.
pub fn validate_claude_deep_link(url: &str) -> Result<(), String> {
    if !url.starts_with("claude://") {
        return Err(format!("refusing to open non-claude scheme: {}", url));
    }
    if url.len() == "claude://".len() {
        return Err("refusing to open empty claude:// URL".to_string());
    }

    let bytes = url.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if !(0x21..=0x7e).contains(&byte) {
            return Err(format!(
                "refusing to open claude:// URL with whitespace/control byte at offset {i}"
            ));
        }
        match byte {
            b'"' | b'\'' | b'`' | b'<' | b'>' | b'\\' | b'|' => {
                return Err(format!(
                    "refusing to open claude:// URL with disallowed character {:?}",
                    byte as char
                ));
            }
            b'%' => {
                if i + 2 >= bytes.len()
                    || !is_hex_digit(bytes[i + 1])
                    || !is_hex_digit(bytes[i + 2])
                {
                    return Err(
                        "refusing to open claude:// URL with malformed percent escape".to_string(),
                    );
                }
                i += 3;
                continue;
            }
            _ if is_allowed_claude_url_byte(byte) => {}
            _ => {
                return Err(format!(
                    "refusing to open claude:// URL with disallowed character {:?}",
                    byte as char
                ));
            }
        }
        i += 1;
    }

    Ok(())
}

/// Expand a leading `~` / `~/` to the user's home directory. Any other path is
/// returned unchanged (still subject to the containment guard below).
fn expand_home_path(path: &str) -> Result<PathBuf, String> {
    if path == "~" {
        return dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string());
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return dirs::home_dir()
            .map(|home| home.join(rest))
            .ok_or_else(|| "Could not determine home directory".to_string());
    }
    Ok(PathBuf::from(path))
}

/// Resolve `path` and confirm it lives inside the user's home directory.
/// Canonicalizes the home dir (and the target when it exists) so a symlink or
/// `..` can't sneak the reveal target outside home. Returns the (un-
/// canonicalized) target to hand to the OS opener.
fn validate_reveal_target(path: &str) -> Result<PathBuf, String> {
    let target = expand_home_path(path)?;
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    let canonical_home = home
        .canonicalize()
        .map_err(|e| format!("Failed to resolve home directory: {e}"))?;

    let target_for_guard = target.canonicalize().unwrap_or_else(|_| target.clone());
    if !target_for_guard.starts_with(&canonical_home) {
        return Err(format!(
            "refusing to reveal path outside home directory: {}",
            target.display()
        ));
    }

    Ok(target)
}

/// Open a new Terminal window at `path` and auto-run `claude`.
#[cfg(not(windows))]
#[tauri::command]
pub fn launch_claude_code(path: String) -> Result<(), String> {
    spawn_cli_terminal_unix(&path, "claude")
}

/// Open a new Terminal window at `path` and auto-run a CLI coding tool.
#[cfg(not(windows))]
#[tauri::command]
pub fn launch_cli_in_terminal(path: String, tool: String) -> Result<(), String> {
    let binary = cli_binary_for(&tool)?;
    spawn_cli_terminal_unix(&path, binary)
}

/// Shared macOS terminal-launch helper. `binary` must come from a trusted source
/// (a literal or `cli_binary_for`) because it is interpolated into the shell
/// command.
#[cfg(not(windows))]
fn spawn_cli_terminal_unix(path: &str, binary: &str) -> Result<(), String> {
    let escaped_path = path.replace('\'', "'\\''");
    let shell_cmd = format!("cd '{}' && {}", escaped_path, binary);
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

/// Open a Windows Terminal window at `path` and auto-run `claude`.
#[cfg(windows)]
#[tauri::command]
pub fn launch_claude_code(path: String) -> Result<(), String> {
    spawn_cli_terminal_windows(&path, "claude")
}

/// Open a Windows Terminal (or PowerShell) window at `path` and auto-run a CLI
/// coding tool. `tool` is validated against the `cli_binary_for` allowlist so
/// the launched binary can never be attacker-controlled.
#[cfg(windows)]
#[tauri::command]
pub fn launch_cli_in_terminal(path: String, tool: String) -> Result<(), String> {
    let binary = cli_binary_for(&tool)?;
    spawn_cli_terminal_windows(&path, binary)
}

#[cfg(windows)]
fn find_in_search_path(binary_name: &str, search_path: &str) -> Option<PathBuf> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let binary_path = std::path::Path::new(binary_name);
    let has_separator = binary_name.contains('/') || binary_name.contains('\\');

    if binary_path.is_absolute() || has_separator {
        let candidate = if binary_path.is_absolute() {
            binary_path.to_path_buf()
        } else {
            cwd.join(binary_path)
        };
        return executable_candidate(&candidate);
    }

    for dir in std::env::split_paths(search_path) {
        let base = if dir.as_os_str().is_empty() {
            cwd.clone()
        } else {
            dir
        };
        let candidate = base.join(binary_path);
        if let Some(found) = executable_candidate(&candidate) {
            return Some(found);
        }
    }

    None
}

#[cfg(windows)]
fn executable_candidate(candidate: &std::path::Path) -> Option<PathBuf> {
    if candidate.is_file() {
        return Some(candidate.to_path_buf());
    }
    if candidate.extension().is_some() {
        return None;
    }
    let pathext =
        std::env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
    for ext in pathext.to_string_lossy().split(';') {
        if ext.is_empty() {
            continue;
        }
        let with_ext = candidate.with_extension(ext.trim_start_matches('.'));
        if with_ext.is_file() {
            return Some(with_ext);
        }
    }
    None
}

/// Shared Windows terminal-launch helper. `binary` must come from a trusted
/// source (a literal or `cli_binary_for`) because it is passed verbatim as the
/// command to run in the new console.
#[cfg(windows)]
fn spawn_cli_terminal_windows(path: &str, binary: &str) -> Result<(), String> {
    let escaped = powershell_single_quote_escape(path);
    let search_path = extended_search_path();
    let wt = find_in_search_path("wt.exe", &search_path)
        .or_else(|| find_in_search_path("wt", &search_path));

    if let Some(wt_path) = wt {
        Command::new(wt_path)
            .args([
                "-d",
                path,
                "powershell.exe",
                "-NoProfile",
                "-NoExit",
                "-Command",
                binary,
            ])
            .env("PATH", &search_path)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to spawn Windows Terminal: {e}"))?;
    } else {
        let ps_cmd = format!("Set-Location -LiteralPath '{escaped}'; {binary}");
        Command::new("powershell.exe")
            .args(["-NoProfile", "-NoExit", "-Command", &ps_cmd])
            .env("PATH", &search_path)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to spawn PowerShell: {e}"))?;
    }
    Ok(())
}

/// Reveal a folder in the OS file manager (Finder / Explorer). The path is
/// validated to live inside the user's home directory before it is opened, so
/// the renderer can only ever reveal HQ-owned locations.
#[cfg(not(windows))]
#[tauri::command]
pub fn reveal_folder(path: String) -> Result<(), String> {
    let target = validate_reveal_target(&path)?;
    let output = Command::new("open")
        .arg(&target)
        .output()
        .map_err(|e| format!("Failed to run open: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "open exited {}: {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    Ok(())
}

#[cfg(windows)]
#[tauri::command]
pub fn reveal_folder(path: String) -> Result<(), String> {
    let target = validate_reveal_target(&path)?;
    // `explorer <dir>` opens the folder; explorer exits non-zero in some
    // shells even on success, so we don't gate on the status code — a spawn
    // failure is the only meaningful error here.
    Command::new("explorer")
        .arg(&target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch Explorer: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::test_support::ENV_MUTEX;

    #[test]
    fn deep_link_accepts_a_well_formed_url() {
        assert!(validate_claude_deep_link("claude://code/new?path=%2Ftmp%2Fhq&ide=1").is_ok());
        assert!(validate_claude_deep_link("claude://code/open?repo=hq-desktop-app").is_ok());
    }

    #[test]
    fn deep_link_rejects_non_claude_scheme() {
        assert!(validate_claude_deep_link("https://evil.example/x").is_err());
        assert!(validate_claude_deep_link("file:///etc/passwd").is_err());
        assert!(validate_claude_deep_link("claude:/oops").is_err());
    }

    #[test]
    fn deep_link_rejects_empty_body() {
        assert!(validate_claude_deep_link("claude://").is_err());
    }

    #[test]
    fn deep_link_rejects_whitespace_and_control_bytes() {
        assert!(validate_claude_deep_link("claude://code new").is_err());
        assert!(validate_claude_deep_link("claude://code\tnew").is_err());
        assert!(validate_claude_deep_link("claude://code\nnew").is_err());
    }

    #[test]
    fn deep_link_rejects_shell_metacharacters() {
        for evil in [
            "claude://code/new\"; rm -rf ~",
            "claude://code/new'`whoami`",
            "claude://code/new<redirect",
            "claude://code/new|pipe",
            "claude://code/new\\escape",
        ] {
            assert!(
                validate_claude_deep_link(evil).is_err(),
                "should reject: {evil}"
            );
        }
    }

    #[test]
    fn deep_link_rejects_malformed_percent_escape() {
        assert!(validate_claude_deep_link("claude://x%2").is_err());
        assert!(validate_claude_deep_link("claude://x%zz").is_err());
        assert!(validate_claude_deep_link("claude://x%").is_err());
    }

    #[test]
    fn reveal_target_rejects_paths_outside_home() {
        // Serialize against tests that mutate the process-global HOME (e.g.
        // telemetry tests) so `validate_reveal_target` reads a stable home dir.
        let _env = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        // Absolute paths outside home are rejected.
        assert!(validate_reveal_target("/etc").is_err());
        assert!(validate_reveal_target("/tmp").is_err());
        assert!(validate_reveal_target("/").is_err());
    }

    #[test]
    fn reveal_target_accepts_home_and_expands_tilde() {
        // Serialize against tests that mutate the process-global HOME (e.g.
        // telemetry tests). Without this, a concurrent test can point HOME at a
        // temp dir mid-run, so `dirs::home_dir()` and the containment check
        // disagree and this test flakes.
        let _env = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = dirs::home_dir().expect("home dir");
        // `~` resolves to home and passes containment.
        let resolved = validate_reveal_target("~").expect("~ should resolve to home");
        assert_eq!(resolved, home);
        // A concrete path inside home passes and expands the tilde.
        let inside = validate_reveal_target("~/Downloads").expect("~/Downloads inside home");
        assert_eq!(inside, home.join("Downloads"));
    }

    #[test]
    fn reveal_target_rejects_tilde_parent_escape() {
        let _env = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        // `~/..` canonicalizes above home and is rejected.
        assert!(validate_reveal_target("~/../..").is_err());
    }

    #[test]
    fn cli_binary_allowlist_accepts_supported_tools() {
        assert_eq!(cli_binary_for("claude").unwrap(), "claude");
        assert_eq!(cli_binary_for("codex").unwrap(), "codex");
        assert_eq!(cli_binary_for("grok").unwrap(), "grok");
    }

    #[test]
    fn cli_binary_allowlist_rejects_everything_else() {
        for tool in ["", "Claude", "claude.exe", "bash", "claude; rm -rf ~"] {
            assert!(cli_binary_for(tool).is_err(), "should reject: {tool}");
        }
    }
}
