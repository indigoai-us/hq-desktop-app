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
use crate::util::win32_path::strip_windows_verbatim_prefix;

#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// Map a frontend tool identifier to the CLI binary we launch. The allowlist is
/// the security boundary: only these three values ever reach a shell.
pub(crate) fn cli_binary_for(tool: &str) -> Result<&'static str, String> {
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
#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_single_quote_escape(s: &str) -> String {
    s.replace('\'', "''")
}

/// Longest first prompt handed to a terminal CLI. The heal prompts are a few
/// hundred characters; the cap keeps a runaway caller from building a
/// multi-megabyte Terminal command.
pub(crate) const TERMINAL_PROMPT_MAX_CHARS: usize = 4000;

/// Make renderer-supplied prompt text safe to hand to a terminal CLI as ONE
/// argument.
///
/// Every control character (newlines, tabs, carriage returns, escape, NUL,
/// DEL, C1) and every Unicode whitespace or line/paragraph separator becomes a
/// space, runs of them collapse to one space, and the result is trimmed and
/// capped at `TERMINAL_PROMPT_MAX_CHARS` characters. One printable line is
/// what Terminal's `do script` and PowerShell keep as one command: a raw
/// newline would be typed into the terminal as Return and split it. Quotes
/// are kept; the platform quoting below escapes them. Empty input is `None`,
/// which launches the tool with no prompt at all.
pub(crate) fn sanitize_terminal_prompt(prompt: Option<&str>) -> Option<String> {
    let raw = prompt?;
    let mut out = String::new();
    let mut count = 0usize;
    let mut pending_space = false;
    for ch in raw.chars() {
        if ch.is_whitespace() || ch.is_control() {
            pending_space = count > 0;
            continue;
        }
        let needed = if pending_space { 2 } else { 1 };
        if count + needed > TERMINAL_PROMPT_MAX_CHARS {
            break;
        }
        if pending_space {
            out.push(' ');
            count += 1;
            pending_space = false;
        }
        out.push(ch);
        count += 1;
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// POSIX single-quote a value: wrap in `'…'` and turn each `'` into `'\''`.
/// Inside single quotes the shell expands nothing (`$`, backticks, `\`, `"`
/// and `!` are all literal), so this is a complete escape for NUL-free text.
fn posix_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The shell line Terminal runs: `cd '<path>' && <binary>` and, with a prompt,
/// ` -- '<prompt>'`. The `--` ends option parsing in grok, codex (clap) and
/// claude (commander), so a prompt that starts with `--` is still the
/// positional PROMPT and never read as an option.
pub(crate) fn unix_terminal_shell_command(
    path: &str,
    binary: &str,
    prompt: Option<&str>,
) -> String {
    format!(
        "cd {} && {}",
        posix_single_quote(path),
        unix_terminal_tool_command(binary, prompt)
    )
}

/// `<binary>` and, with a prompt, ` -- '<prompt>'`: the part of
/// [`unix_terminal_shell_command`] after the `cd`.
fn unix_terminal_tool_command(binary: &str, prompt: Option<&str>) -> String {
    match prompt {
        Some(prompt) => format!("{binary} -- {}", posix_single_quote(prompt)),
        None => binary.to_string(),
    }
}

#[cfg_attr(windows, allow(dead_code))]
/// POSIX sh text that puts each managed CLI dir (the npm bin holding hq, qmd
/// and claude, then the managed node bin) at the front of PATH unless it is
/// already there. Dirs are prepended last to first so they end up in
/// `managed` order. A dir that is empty or holds a `:` or a control
/// character cannot go on PATH and is skipped. No usable dir gives an empty
/// prefix.
///
/// A dir already on PATH is left where it is, so a user's own earlier `hq`
/// (or a stale `npm -g` copy listed before the managed dir by an rc file)
/// still wins in that case; only missing dirs are added. Users without the
/// installer rc block get HQ's Node and npm first in the session, ahead of
/// volta or nvm project pins.
pub(crate) fn unix_terminal_path_prefix(managed: &[PathBuf]) -> String {
    let mut dirs: Vec<String> = Vec::new();
    for dir in managed {
        let dir = dir.to_string_lossy();
        let unusable = dir.is_empty() || dir.contains(':') || dir.chars().any(char::is_control);
        if !unusable && !dirs.iter().any(|seen| seen.as_str() == dir) {
            dirs.push(dir.into_owned());
        }
    }
    if dirs.is_empty() {
        return String::new();
    }
    // One loop names each dir once, which keeps the line Terminal types
    // short (see `TERMINAL_TYPED_LINE_MAX_BYTES`).
    let list: Vec<String> = dirs
        .iter()
        .rev()
        .map(|dir| posix_single_quote(dir))
        .collect();
    format!(
        "for d in {}; do case \":$PATH:\" in *\":$d:\"*|*\":$d/:\"*) ;; *) PATH=\"$d${{PATH:+:$PATH}}\";; esac; done; export PATH; ",
        list.join(" ")
    )
}

/// Longest line the app types into a new Terminal window. Terminal's
/// `do script` usually types while the login shell is still reading its rc
/// files, and macOS drops typed-ahead input over about 1,024 bytes (the
/// whole line, newline included). Anything longer goes through a script
/// file (see [`unix_terminal_launch`]).
pub(crate) const TERMINAL_TYPED_LINE_MAX_BYTES: usize = 900;

/// What a macOS Terminal launch types, and the script file it needs first.
#[cfg_attr(windows, allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct TerminalLaunch {
    /// The line typed into Terminal. Always at most
    /// `TERMINAL_TYPED_LINE_MAX_BYTES` bytes.
    pub line: String,
    /// `Some(text)` when `line` runs a script file: the caller must write
    /// `text` to the script path (new file, mode 0600) before typing `line`.
    pub script: Option<String>,
}

/// True when `path` can be typed into any login shell (sh, zsh, bash,
/// fish, tcsh) unquoted and is read the same way by all of them.
fn is_plain_shell_word(path: &str) -> bool {
    !path.is_empty()
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'-'))
}

/// The Terminal launch for a session. When the session line from
/// [`unix_terminal_session_command`] fits in
/// `TERMINAL_TYPED_LINE_MAX_BYTES`, it is typed as is. Otherwise (a long
/// prompt, folder or home path) the `cd`, the PATH change and the tool go
/// into a `/bin/sh` script at `script_path` and the typed line is only
/// `/bin/sh <script_path>`. The script deletes itself when it starts.
/// `script_path` must be a plain shell word (letters, digits, `/._-`) so
/// every login shell reads it unquoted; the prompt and folder are only ever
/// inside the script, POSIX-quoted.
pub(crate) fn unix_terminal_launch(
    path: &str,
    binary: &str,
    prompt: Option<&str>,
    managed: &[PathBuf],
    script_path: &std::path::Path,
) -> Result<TerminalLaunch, String> {
    let line = unix_terminal_session_command(path, binary, prompt, managed);
    if line.len() <= TERMINAL_TYPED_LINE_MAX_BYTES {
        return Ok(TerminalLaunch { line, script: None });
    }
    let script_path = script_path
        .to_str()
        .filter(|p| is_plain_shell_word(p))
        .ok_or_else(|| "terminal script path is not a plain shell word".to_string())?;
    let line = format!("/bin/sh {script_path}");
    if line.len() > TERMINAL_TYPED_LINE_MAX_BYTES {
        return Err("terminal script path is too long".to_string());
    }
    let script = format!(
        "rm -f -- {}\ncd {} || exit 1\n{}exec {}\n",
        posix_single_quote(script_path),
        posix_single_quote(path),
        unix_terminal_path_prefix(managed),
        unix_terminal_tool_command(binary, prompt)
    );
    Ok(TerminalLaunch {
        line,
        script: Some(script),
    })
}

/// A new, unused script path for [`unix_terminal_launch`]: the user's temp
/// dir when its path is a plain shell word, else `/tmp`.
#[cfg(not(windows))]
fn terminal_script_path() -> PathBuf {
    let dir = std::env::temp_dir();
    let dir = if dir.to_str().is_some_and(is_plain_shell_word) {
        dir
    } else {
        PathBuf::from("/tmp")
    };
    dir.join(format!("hq-terminal-{}.sh", uuid::Uuid::new_v4().simple()))
}

/// Write a launch script as a new file only the user can read. `create_new`
/// fails rather than following a planted file or symlink.
#[cfg(not(windows))]
fn write_terminal_script(path: &std::path::Path, text: &str) -> Result<(), String> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("Failed to create terminal script: {e}"))?;
    file.write_all(text.as_bytes())
        .map_err(|e| format!("Failed to write terminal script: {e}"))
}

#[cfg_attr(windows, allow(dead_code))]
/// The line Terminal runs for a session: [`unix_terminal_shell_command`]
/// with the managed CLI dirs put on PATH first (see
/// [`unix_terminal_path_prefix`]). Terminal hands the line to the user's
/// login shell, which may be zsh, bash, fish, tcsh or another shell, and
/// those shells quote differently: fish reads `\'` inside single quotes and
/// csh expands `!` there. So the PATH change and the tool run in `/bin/sh`
/// from a base64-encoded script; after the `cd`, which is the same as
/// before, the login shell only parses fixed text and base64 characters.
/// The PATH change runs after the user's rc files, so their PATH is kept,
/// and it writes no file. With no usable managed dir the line is unchanged.
pub(crate) fn unix_terminal_session_command(
    path: &str,
    binary: &str,
    prompt: Option<&str>,
    managed: &[PathBuf],
) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let prefix = unix_terminal_path_prefix(managed);
    if prefix.is_empty() {
        return unix_terminal_shell_command(path, binary, prompt);
    }
    let script = STANDARD.encode(format!(
        "{prefix}exec {}",
        unix_terminal_tool_command(binary, prompt)
    ));
    format!(
        "cd {} && /bin/sh -c 'eval \"$(echo {script} | /usr/bin/base64 --decode)\"'",
        posix_single_quote(path)
    )
}

/// `base` PATH for a child the app spawns, with the managed CLI dirs that
/// exist on this machine put in front unless already present. A dir already
/// in `base` keeps its place, so where `base` is the extended search path
/// (which lists the managed Node bin before the npm bin) the order is
/// unchanged and this only adds a dir `base` lacks.
fn managed_cli_child_path(base: &str) -> String {
    hq_desktop_core::paths::path_with_managed_cli(
        Some(base),
        &hq_desktop_core::paths::managed_cli_session_dirs(),
        cfg!(windows),
    )
}

/// Wrap a shell line in the AppleScript that opens it in Terminal. Inside an
/// AppleScript string literal only `\` and `"` are special; both are escaped.
/// A sanitized prompt has no newlines, so the literal stays on one line.
pub(crate) fn terminal_applescript(shell_cmd: &str) -> String {
    let applescript_safe = shell_cmd.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        r#"tell application "Terminal"
    activate
    do script "{}"
end tell"#,
        applescript_safe
    )
}

/// The PowerShell script for a Windows terminal launch with a prompt:
/// optional `Set-Location`, then `<binary> '--' '<prompt>'`.
///
/// The prompt is a PowerShell single-quoted literal (nothing expands inside
/// one, and `'` doubles to `''`). PowerShell also treats the curly single
/// quotes U+2018..U+201B as quote delimiters, so those become ASCII `'`
/// first. Windows PowerShell 5.1 hands an argument that contains `"` to a
/// native program without escaping it, which splits the argument, so `"` and
/// the curly double quotes become `'` too, and trailing backslashes (which
/// would escape the closing quote PowerShell adds) are dropped. `'--'` is
/// quoted so PowerShell passes it on to npm's `.ps1` shims instead of reading
/// it as its own end-of-parameters marker.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn windows_powershell_cli_script(
    set_location: Option<&str>,
    binary: &str,
    prompt: Option<&str>,
) -> String {
    let mut script = String::new();
    if let Some(path) = set_location {
        script.push_str("Set-Location -LiteralPath '");
        script.push_str(&powershell_single_quote_escape(path));
        script.push_str("'; ");
    }
    script.push_str(binary);
    if let Some(prompt) = prompt {
        let normalized: String = prompt
            .chars()
            .map(|ch| match ch {
                '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
                '"' | '\u{201C}' | '\u{201D}' | '\u{201E}' => '\'',
                other => other,
            })
            .collect();
        let normalized = normalized.trim_end_matches('\\');
        script.push_str(" '--' '");
        script.push_str(&powershell_single_quote_escape(normalized));
        script.push('\'');
    }
    script
}

/// `powershell.exe -EncodedCommand` payload: base64 of the UTF-16LE script.
/// Base64 has no `;`, quotes or spaces, so neither wt.exe's own `;` command
/// splitting nor outer argument quoting can change the script.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn powershell_encoded_command(script: &str) -> String {
    use base64::Engine as _;
    let bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
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
    validate_deep_link_bytes(url, "claude")
}

/// Same byte-level allowlist as `validate_claude_deep_link`, restricted to the
/// `codex://` scheme registered by the ChatGPT desktop app. HQ opens
/// `codex://threads/new?prompt=…` links so Codex inside ChatGPT can install
/// the Codex CLI without the person opening a terminal.
pub fn validate_codex_deep_link(url: &str) -> Result<(), String> {
    validate_deep_link_bytes(url, "codex")
}

/// Scheme-parameterised byte validator shared by every assistant deep-link
/// command. Every acceptance rule matches the original `validate_claude_deep_link`.
fn validate_deep_link_bytes(url: &str, scheme: &'static str) -> Result<(), String> {
    let prefix_owned;
    let prefix: &str = if scheme.is_empty() {
        return Err("refusing to open URL: empty scheme".to_string());
    } else {
        prefix_owned = format!("{scheme}://");
        prefix_owned.as_str()
    };
    if !url.starts_with(prefix) {
        return Err(format!("refusing to open non-{scheme} scheme: {}", url));
    }
    if url.len() == prefix.len() {
        return Err(format!("refusing to open empty {scheme}:// URL"));
    }

    let bytes = url.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if !(0x21..=0x7e).contains(&byte) {
            return Err(format!(
                "refusing to open {scheme}:// URL with whitespace/control byte at offset {i}"
            ));
        }
        match byte {
            b'"' | b'\'' | b'`' | b'<' | b'>' | b'\\' | b'|' => {
                return Err(format!(
                    "refusing to open {scheme}:// URL with disallowed character {:?}",
                    byte as char
                ));
            }
            b'%' => {
                if i + 2 >= bytes.len()
                    || !is_hex_digit(bytes[i + 1])
                    || !is_hex_digit(bytes[i + 2])
                {
                    return Err(format!(
                        "refusing to open {scheme}:// URL with malformed percent escape"
                    ));
                }
                i += 3;
                continue;
            }
            _ if is_allowed_claude_url_byte(byte) => {}
            _ => {
                return Err(format!(
                    "refusing to open {scheme}:// URL with disallowed character {:?}",
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

/// Where the ChatGPT app carries its embedded Codex CLI. Codex desktop is
/// distributed inside ChatGPT.app, and the bundle ships the full CLI, so a
/// machine with the app needs NOTHING installed for a workspace launch.
///
/// The CLI's place in the bundle has moved: ChatGPT 26.928 (bundle id
/// `com.openai.codex`) ships it at `Contents/Resources/codex-cli/bin/codex`
/// and no longer at `Contents/Resources/codex`, where older builds had it.
/// Both are tried, newest layout first.
#[cfg(target_os = "macos")]
pub fn bundled_codex_bin() -> Option<std::path::PathBuf> {
    let mut app_dirs = vec![std::path::PathBuf::from("/Applications")];
    if let Some(home) = dirs::home_dir() {
        app_dirs.push(home.join("Applications"));
    }
    bundled_codex_bin_in(&app_dirs)
}

/// The bundled Codex CLI inside ChatGPT.app or Codex.app under any of
/// `app_dirs`, checked in order.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn bundled_codex_bin_in(app_dirs: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    const BUNDLES: [&str; 2] = ["ChatGPT.app", "Codex.app"];
    const CLI_PATHS: [&str; 2] = [
        "Contents/Resources/codex-cli/bin/codex",
        "Contents/Resources/codex",
    ];
    app_dirs
        .iter()
        .flat_map(|dir| BUNDLES.iter().map(move |bundle| dir.join(bundle)))
        .flat_map(|app| CLI_PATHS.iter().map(move |rel| app.join(rel)))
        .find(|p| p.is_file())
}

#[cfg(not(target_os = "macos"))]
pub fn bundled_codex_bin() -> Option<std::path::PathBuf> {
    None
}

/// Where the Claude desktop app keeps the Claude Code CLI it manages.
///
/// Claude.app (`com.anthropic.claudefordesktop`) does NOT put a `claude`
/// binary inside its bundle or on PATH. Its Code tab downloads a versioned,
/// verified copy of Claude Code to
/// `~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude`
/// and writes a `.verified` marker beside it once the download checks out.
/// Verified on a fresh macOS 15.7 machine with Claude.app 1.49585 (Claude Code
/// 2.1.260): that binary answers `--version` and shares the desktop app's
/// sign-in, so a machine with the desktop app has a full, authenticated CLI
/// even when `command -v claude` finds nothing. Prefer the newest verified
/// version so the CLI tracks desktop updates.
#[cfg(target_os = "macos")]
pub fn bundled_claude_bin() -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    bundled_claude_bin_in(&home.join("Library/Application Support/Claude/claude-code"))
}

#[cfg(not(target_os = "macos"))]
pub fn bundled_claude_bin() -> Option<std::path::PathBuf> {
    None
}

/// Newest verified Claude Code binary under a desktop-managed `claude-code`
/// directory. Versions sort numerically (`2.1.260` > `2.1.9`); unverified or
/// half-downloaded versions are skipped so we never spawn a torn binary.
pub(crate) fn bundled_claude_bin_in(managed_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let entries = std::fs::read_dir(managed_dir).ok()?;
    let mut candidates: Vec<(Vec<u64>, std::path::PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let dir = entry.path();
            let name = entry.file_name();
            let name = name.to_str()?;
            let version: Vec<u64> = name
                .split('.')
                .map(|part| part.parse::<u64>().ok())
                .collect::<Option<Vec<u64>>>()?;
            let binary = dir.join("claude.app/Contents/MacOS/claude");
            (dir.join(".verified").is_file() && binary.is_file()).then_some((version, binary))
        })
        .collect();
    candidates.sort();
    candidates.pop().map(|(_, binary)| binary)
}

/// The new-thread deep link that pre-fills the composer. The app parses the
/// `prompt` parameter (verified against its persisted state); `cwd` on this
/// URL is IGNORED by current builds — the workspace only opens via
/// `codex app <path>` — which is why this link is fired AFTER the workspace
/// launch, never instead of it.
pub fn codex_thread_url(prompt: &str) -> String {
    let mut encoded = String::new();
    for byte in prompt.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    format!("codex://threads/new?prompt={encoded}")
}

/// Open the Codex DESKTOP app with `path` loaded as the workspace, and
/// optionally pre-fill the composer with `prompt` (e.g. "/setup" during
/// onboarding — parity with the Claude deep link).
///
/// Evidence trail, verified on real machines:
/// - `codex app <path>` (the CLI subcommand) is the ONLY route that opens
///   the desktop app IN a folder;
/// - the bare `codex://threads/new?cwd=…` link does NOT open the workspace
///   (the app never parses `cwd`), but DOES parse `prompt`;
/// - a folder passed as an open-document (`open -a Codex <dir>`) is ignored.
///
/// Binary resolution: the ChatGPT-bundled CLI first (present on every
/// desktop-app machine, needs nothing installed), then a login-shell `codex`
/// for CLI-only installs (pnpm home / homebrew / npm global).
#[cfg(not(windows))]
#[tauri::command]
pub fn launch_codex_workspace(path: String, prompt: Option<String>) -> Result<(), String> {
    let result = launch_codex_workspace_impl(path, prompt);
    crate::commands::cdp_mirror::note_agent_session_launched("codex", "codex_app", &result);
    result
}

#[cfg(not(windows))]
fn launch_codex_workspace_impl(path: String, prompt: Option<String>) -> Result<(), String> {
    let target = expand_home_path(&path)?;
    if !target.is_dir() {
        return Err(format!(
            "workspace folder does not exist: {}",
            target.display()
        ));
    }
    let child_path = managed_cli_child_path(&crate::commands::install_deps::extended_search_path());
    let output = match bundled_codex_bin() {
        Some(bin) => Command::new(bin)
            .args(["app", &target.to_string_lossy()])
            .env("PATH", &child_path)
            .output(),
        None => {
            let escaped = target.to_string_lossy().replace('\'', "'\\''");
            let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
            Command::new(shell)
                .args(["-lc", &format!("codex app '{escaped}'")])
                .env("PATH", &child_path)
                .output()
        }
    }
    .map_err(|e| format!("failed to run codex app: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "codex app failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    if let Some(prompt) = prompt.as_deref().filter(|p| !p.trim().is_empty()) {
        // The app needs a beat to finish opening the workspace before it will
        // route a new-thread link into it. Fire-and-forget: a missed prompt
        // is a pre-typed convenience lost, never a failed launch.
        let url = codex_thread_url(prompt);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let _ = Command::new("open").arg(&url).status();
        });
    }
    Ok(())
}

/// Windows counterpart. No bundled-binary path is known for the Windows
/// build, so resolution goes through the extended search path.
#[cfg(windows)]
#[tauri::command]
pub fn launch_codex_workspace(path: String, prompt: Option<String>) -> Result<(), String> {
    let result = launch_codex_workspace_impl(path, prompt);
    crate::commands::cdp_mirror::note_agent_session_launched("codex", "codex_app", &result);
    result
}

#[cfg(windows)]
fn launch_codex_workspace_impl(path: String, prompt: Option<String>) -> Result<(), String> {
    let target = expand_home_path(&path)?;
    if !target.is_dir() {
        return Err(format!(
            "workspace folder does not exist: {}",
            target.display()
        ));
    }
    let comspec = std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into());
    let output = Command::new(&comspec)
        .args(["/C", "codex", "app", &target.to_string_lossy()])
        .env(
            "PATH",
            managed_cli_child_path(&crate::commands::install_deps::extended_search_path()),
        )
        .output()
        .map_err(|e| format!("failed to run codex app: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "codex app failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    if let Some(prompt) = prompt.as_deref().filter(|p| !p.trim().is_empty()) {
        let url = codex_thread_url(prompt);
        let comspec = comspec.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let _ = Command::new(comspec)
                .args(["/C", "start", "", &url])
                .status();
        });
    }
    Ok(())
}

/// Claude Code permission modes a launch may ask for (`claude --permission-mode`).
const CLAUDE_PERMISSION_MODES: &[&str] = &["default", "acceptEdits", "plan", "bypassPermissions"];

/// POSIX shell single-quoting: the whole value is literal, `'` becomes `'\''`.
fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// PowerShell single-quoting: the whole value is literal, `'` becomes `''`.
#[cfg_attr(not(windows), allow(dead_code))]
fn ps_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The arguments after `claude` for a launch: `--permission-mode <mode>` when
/// the caller asked for one of the allowed modes (the Daily Brief asks for
/// `bypassPermissions`), then the initial prompt as one quoted positional
/// argument. The mode is allowlisted; the prompt is free text, so it is
/// flattened to one line (control characters become spaces) and quoted by
/// `quote` for the target shell. Empty input adds nothing.
fn claude_args(
    permission_mode: Option<&str>,
    prompt: Option<&str>,
    quote: fn(&str) -> String,
) -> Result<String, String> {
    let mut args: Vec<String> = Vec::new();
    match permission_mode.map(str::trim).filter(|m| !m.is_empty()) {
        None => {}
        Some(mode) if CLAUDE_PERMISSION_MODES.contains(&mode) => {
            args.push(format!("--permission-mode {mode}"))
        }
        Some(mode) => return Err(format!("unknown Claude permission mode: {mode}")),
    }
    let line = prompt
        .unwrap_or("")
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if !line.is_empty() {
        args.push(quote(&line));
    }
    Ok(args.join(" "))
}

/// The macOS `claude` command line: `claude [--permission-mode <mode>] ['<prompt>']`.
fn claude_command(permission_mode: Option<&str>, prompt: Option<&str>) -> Result<String, String> {
    let args = claude_args(permission_mode, prompt, sh_single_quote)?;
    Ok(if args.is_empty() {
        "claude".to_string()
    } else {
        format!("claude {args}")
    })
}

/// Open a new Terminal window at `path` and auto-run `claude`, optionally in
/// a permission mode and with an initial prompt (`permissionMode` and
/// `prompt` from the renderer; both absent = the plain launch).
#[cfg(not(windows))]
#[tauri::command]
pub fn launch_claude_code(
    path: String,
    permission_mode: Option<String>,
    prompt: Option<String>,
) -> Result<(), String> {
    let result = claude_command(permission_mode.as_deref(), prompt.as_deref())
        .and_then(|cmd| spawn_cli_terminal_unix(&path, &cmd));
    crate::commands::cdp_mirror::note_agent_session_launched("claude", "terminal", &result);
    result
}

/// Open a new Terminal window at `path` and auto-run a CLI coding tool,
/// optionally with a first prompt (see `sanitize_terminal_prompt`).
#[cfg(not(windows))]
#[tauri::command]
pub fn launch_cli_in_terminal(
    path: String,
    tool: String,
    prompt: Option<String>,
) -> Result<(), String> {
    let prompt = sanitize_terminal_prompt(prompt.as_deref());
    let result = cli_binary_for(&tool)
        .and_then(|binary| spawn_cli_terminal_unix_with_prompt(&path, binary, prompt.as_deref()));
    let provider = cli_binary_for(&tool).unwrap_or("other");
    crate::commands::cdp_mirror::note_agent_session_launched(provider, "terminal", &result);
    result
}

/// Shared macOS terminal-launch helper. `binary` must come from a trusted source
/// (a literal or `cli_binary_for`) because it is interpolated into the shell
/// command.
#[cfg(not(windows))]
fn spawn_cli_terminal_unix(path: &str, binary: &str) -> Result<(), String> {
    spawn_cli_terminal_unix_with_prompt(path, binary, None)
}

/// `spawn_cli_terminal_unix` with an optional prompt that has already been
/// through `sanitize_terminal_prompt`.
#[cfg(not(windows))]
fn spawn_cli_terminal_unix_with_prompt(
    path: &str,
    binary: &str,
    prompt: Option<&str>,
) -> Result<(), String> {
    let script_path = terminal_script_path();
    let launch = unix_terminal_launch(
        path,
        binary,
        prompt,
        &hq_desktop_core::paths::managed_cli_session_dirs(),
        &script_path,
    )?;
    if let Some(text) = &launch.script {
        write_terminal_script(&script_path, text)?;
    }
    let script = terminal_applescript(&launch.line);

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to spawn osascript: {e}"));
    let failed = !matches!(&output, Ok(out) if out.status.success());
    if failed && launch.script.is_some() {
        // Terminal never ran the script, so nothing else will delete it.
        let _ = std::fs::remove_file(&script_path);
    }
    let output = output?;

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

/// Open a Windows Terminal window at `path` and auto-run `claude`, optionally
/// in a permission mode.
#[cfg(windows)]
#[tauri::command]
pub fn launch_claude_code(
    path: String,
    permission_mode: Option<String>,
    prompt: Option<String>,
) -> Result<(), String> {
    let result = claude_args(
        permission_mode.as_deref(),
        prompt.as_deref(),
        ps_single_quote,
    )
    .and_then(|args| spawn_cli_terminal_windows_args(&path, "claude", &args));
    crate::commands::cdp_mirror::note_agent_session_launched("claude", "terminal", &result);
    result
}

/// Open a Windows Terminal (or PowerShell) window at `path` and auto-run a CLI
/// coding tool. `tool` is validated against the `cli_binary_for` allowlist so
/// the launched binary can never be attacker-controlled.
#[cfg(windows)]
#[tauri::command]
pub fn launch_cli_in_terminal(
    path: String,
    tool: String,
    prompt: Option<String>,
) -> Result<(), String> {
    let prompt = sanitize_terminal_prompt(prompt.as_deref());
    let result = cli_binary_for(&tool).and_then(|binary| {
        spawn_cli_terminal_windows_with_prompt(&path, binary, prompt.as_deref())
    });
    let provider = cli_binary_for(&tool).unwrap_or("other");
    crate::commands::cdp_mirror::note_agent_session_launched(provider, "terminal", &result);
    result
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
    spawn_cli_terminal_windows_command(path, binary, binary, None)
}

/// As `spawn_cli_terminal_windows`, with trusted arguments after the binary
/// (`args` must come from an allowlist, never the renderer's free text).
#[cfg(windows)]
fn spawn_cli_terminal_windows_args(path: &str, binary: &str, args: &str) -> Result<(), String> {
    let command = if args.is_empty() {
        binary.to_string()
    } else {
        format!("{binary} {args}")
    };
    spawn_cli_terminal_windows_command(path, binary, &command, None)
}

/// `spawn_cli_terminal_windows` with an optional prompt that has already been
/// through `sanitize_terminal_prompt`. Without a prompt the command line is
/// exactly what it was before prompts existed.
#[cfg(windows)]
fn spawn_cli_terminal_windows_with_prompt(
    path: &str,
    binary: &str,
    prompt: Option<&str>,
) -> Result<(), String> {
    spawn_cli_terminal_windows_command(path, binary, binary, prompt)
}

/// The one Windows spawn. `binary` is what is looked up on PATH; `command` is
/// the trusted command line to run (the binary alone, or the binary plus
/// allowlisted arguments); a `prompt` travels as an encoded script instead.
#[cfg(windows)]
fn spawn_cli_terminal_windows_command(
    path: &str,
    binary: &str,
    command: &str,
    prompt: Option<&str>,
) -> Result<(), String> {
    let escaped = powershell_single_quote_escape(path);
    let search_path = managed_cli_child_path(&extended_search_path());
    find_in_search_path(binary, &search_path)
        .ok_or_else(|| format!("Could not find {binary} on PATH"))?;
    let wt = find_in_search_path("wt.exe", &search_path)
        .or_else(|| find_in_search_path("wt", &search_path));

    if let Some(prompt) = prompt {
        // The script travels as -EncodedCommand so the prompt never meets
        // wt.exe's `;` splitting or the outer argument quoting.
        return match wt {
            Some(wt_path) => {
                let script = windows_powershell_cli_script(None, binary, Some(prompt));
                Command::new(wt_path)
                    .args([
                        "-d",
                        path,
                        "powershell.exe",
                        "-NoProfile",
                        "-NoExit",
                        "-EncodedCommand",
                    ])
                    .arg(powershell_encoded_command(&script))
                    .env("PATH", &search_path)
                    .creation_flags(CREATE_NEW_CONSOLE)
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("Failed to spawn Windows Terminal: {e}"))
            }
            None => {
                let script = windows_powershell_cli_script(Some(path), binary, Some(prompt));
                Command::new("powershell.exe")
                    .args(["-NoProfile", "-NoExit", "-EncodedCommand"])
                    .arg(powershell_encoded_command(&script))
                    .env("PATH", &search_path)
                    .creation_flags(CREATE_NEW_CONSOLE)
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("Failed to spawn PowerShell: {e}"))
            }
        };
    }

    if let Some(wt_path) = wt {
        Command::new(wt_path)
            .args([
                "-d",
                path,
                "powershell.exe",
                "-NoProfile",
                "-NoExit",
                "-Command",
                command,
            ])
            .env("PATH", &search_path)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to spawn Windows Terminal: {e}"))?;
    } else {
        let ps_cmd = format!("Set-Location -LiteralPath '{escaped}'; {command}");
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
    let explorer_target = strip_windows_verbatim_prefix(&target.to_string_lossy());
    // `explorer <dir>` opens the folder; explorer exits non-zero in some
    // shells even on success, so we don't gate on the status code — a spawn
    // failure is the only meaningful error here.
    Command::new("explorer")
        .arg(&explorer_target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch Explorer: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::test_support::ENV_MUTEX;

    #[test]
    fn claude_command_adds_only_an_allowed_permission_mode() {
        assert_eq!(claude_command(None, None).unwrap(), "claude");
        assert_eq!(claude_command(Some("  "), Some("  ")).unwrap(), "claude");
        assert_eq!(
            claude_command(Some("bypassPermissions"), None).unwrap(),
            "claude --permission-mode bypassPermissions"
        );
        assert!(claude_command(Some("bypassPermissions; rm -rf ~"), None).is_err());
        assert!(claude_command(Some("yolo"), Some("hi")).is_err());
    }

    #[test]
    fn claude_command_passes_the_prompt_as_one_quoted_argument() {
        let cmd = claude_command(
            Some("bypassPermissions"),
            Some("Pick up my session \"Daily brief\" (Corey's) $(rm -rf ~) `x`\nthen continue"),
        )
        .unwrap();
        assert_eq!(
            cmd,
            "claude --permission-mode bypassPermissions 'Pick up my session \"Daily brief\" (Corey'\\''s) $(rm -rf ~) `x` then continue'"
        );
        // Prompt only, no mode.
        assert_eq!(
            claude_command(None, Some("hello")).unwrap(),
            "claude 'hello'"
        );
        // Windows (PowerShell) quoting doubles the single quote.
        assert_eq!(
            claude_args(
                Some("bypassPermissions"),
                Some("Corey's brief"),
                ps_single_quote
            )
            .unwrap(),
            "--permission-mode bypassPermissions 'Corey''s brief'"
        );
    }

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
    fn bundled_codex_bin_finds_the_cli_where_current_and_older_chatgpt_builds_keep_it() {
        let root = std::env::temp_dir().join(format!("hq-codex-bin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let system = root.join("Applications");
        let user = root.join("home/Applications");
        assert_eq!(bundled_codex_bin_in(&[system.clone(), user.clone()]), None);

        // Older ChatGPT.app: Contents/Resources/codex, in the user folder.
        let old = user.join("ChatGPT.app/Contents/Resources/codex");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, b"#!/bin/sh\n").unwrap();
        assert_eq!(
            bundled_codex_bin_in(&[system.clone(), user.clone()]),
            Some(old.clone())
        );

        // Current ChatGPT.app (26.928): Contents/Resources/codex-cli/bin/codex.
        let current = system.join("ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
        std::fs::create_dir_all(current.parent().unwrap()).unwrap();
        std::fs::write(&current, b"#!/bin/sh\n").unwrap();
        assert_eq!(
            bundled_codex_bin_in(&[system.clone(), user.clone()]),
            Some(current)
        );

        // A standalone Codex.app with the new layout.
        let standalone_root = root.join("standalone");
        let standalone = standalone_root.join("Codex.app/Contents/Resources/codex-cli/bin/codex");
        std::fs::create_dir_all(standalone.parent().unwrap()).unwrap();
        std::fs::write(&standalone, b"#!/bin/sh\n").unwrap();
        assert_eq!(bundled_codex_bin_in(&[standalone_root]), Some(standalone));
        let _ = std::fs::remove_dir_all(&root);
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

    /// The `codex://` validator inherits the same byte allow-list; these
    /// pins verify the scheme lock and the security-relevant rejects don't
    /// silently regress when someone adds a scheme parameter.
    #[test]
    fn codex_deep_link_accepts_the_install_prompt_url_shape() {
        assert!(validate_codex_deep_link("codex://threads/new?prompt=install%20codex").is_ok());
        assert!(validate_codex_deep_link("codex://launch").is_ok());
    }

    #[test]
    fn codex_deep_link_rejects_non_codex_schemes_and_empty_body() {
        assert!(validate_codex_deep_link("claude://code/new").is_err());
        assert!(validate_codex_deep_link("https://evil.example/x").is_err());
        assert!(validate_codex_deep_link("codex://").is_err());
    }

    #[test]
    fn codex_deep_link_rejects_shell_metacharacters_and_control_bytes() {
        for evil in [
            "codex://threads/new?prompt=`whoami`",
            "codex://threads/new?prompt=one two",
            "codex://threads/new?prompt=one\ttwo",
            "codex://threads/new?prompt=<xss>",
            "codex://threads/new?prompt=|pipe",
        ] {
            assert!(
                validate_codex_deep_link(evil).is_err(),
                "should reject: {evil}"
            );
        }
    }

    #[test]
    fn codex_deep_link_rejects_malformed_percent_escape() {
        assert!(validate_codex_deep_link("codex://x%2").is_err());
        assert!(validate_codex_deep_link("codex://x%zz").is_err());
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

#[cfg(test)]
mod codex_workspace_tests {
    use super::codex_thread_url;

    #[test]
    fn thread_url_encodes_the_prompt_for_the_composer() {
        // The onboarding parity case: "/setup" pre-typed, exactly as the
        // installer's Claude deep link does. Slash must be percent-encoded —
        // the app's router treats a raw slash as a path segment.
        assert_eq!(
            codex_thread_url("/setup"),
            "codex://threads/new?prompt=%2Fsetup"
        );
        assert_eq!(
            codex_thread_url("fix the build & ship"),
            "codex://threads/new?prompt=fix%20the%20build%20%26%20ship"
        );
        // Unreserved characters pass through untouched.
        assert_eq!(
            codex_thread_url("hello-world_1.2~x"),
            "codex://threads/new?prompt=hello-world_1.2~x"
        );
    }
}

#[cfg(test)]
mod bundled_claude_tests {
    use super::bundled_claude_bin_in;
    use std::fs;
    use tempfile::tempdir;

    fn install(managed: &std::path::Path, version: &str, verified: bool) {
        let bin_dir = managed.join(version).join("claude.app/Contents/MacOS");
        fs::create_dir_all(&bin_dir).unwrap();
        fs::write(bin_dir.join("claude"), b"#!/bin/sh\n").unwrap();
        if verified {
            fs::write(managed.join(version).join(".verified"), b"sha").unwrap();
        }
    }

    /// Regression: a fresh Mac with only Claude.app installed reported
    /// "Claude Code is not installed" in Sessions, because the CLI the desktop
    /// app manages lives under Application Support, not on PATH.
    #[test]
    fn finds_the_desktop_managed_claude_code_cli() {
        let dir = tempdir().unwrap();
        install(dir.path(), "2.1.260", true);
        assert_eq!(
            bundled_claude_bin_in(dir.path()),
            Some(dir.path().join("2.1.260/claude.app/Contents/MacOS/claude"))
        );
    }

    #[test]
    fn prefers_the_newest_verified_version_numerically() {
        let dir = tempdir().unwrap();
        install(dir.path(), "2.1.9", true);
        install(dir.path(), "2.1.260", true);
        install(dir.path(), "2.2.0", false);
        assert_eq!(
            bundled_claude_bin_in(dir.path()),
            Some(dir.path().join("2.1.260/claude.app/Contents/MacOS/claude"))
        );
    }

    #[test]
    fn ignores_unverified_or_partial_downloads_and_missing_dirs() {
        let dir = tempdir().unwrap();
        install(dir.path(), "2.1.260", false);
        fs::create_dir_all(dir.path().join("2.1.261")).unwrap();
        fs::write(dir.path().join("2.1.261/.verified"), b"sha").unwrap();
        assert_eq!(bundled_claude_bin_in(dir.path()), None);
        assert_eq!(bundled_claude_bin_in(&dir.path().join("absent")), None);
    }
}

#[cfg(test)]
mod terminal_prompt_tests {
    use super::*;

    /// Single quote, double quote, newline, tab, `$`, a backtick and a
    /// backslash, starting with `--` so an option parser would grab it.
    const HOSTILE: &str = "--version it's \"quoted\"\nsecond line\t$HOME `x` \\n end";
    const SANITIZED: &str = "--version it's \"quoted\" second line $HOME `x` \\n end";

    #[test]
    fn sanitize_flattens_control_characters_into_one_line() {
        assert_eq!(
            sanitize_terminal_prompt(Some(HOSTILE)).as_deref(),
            Some(SANITIZED)
        );
        assert_eq!(
            sanitize_terminal_prompt(Some("  a\r\n\r\n\u{1b}[31m b\u{2028}c\u{0}d  ")).as_deref(),
            Some("a [31m b c d")
        );
    }

    #[test]
    fn sanitize_turns_empty_or_blank_into_no_prompt() {
        assert_eq!(sanitize_terminal_prompt(None), None);
        assert_eq!(sanitize_terminal_prompt(Some("")), None);
        assert_eq!(sanitize_terminal_prompt(Some(" \n\t\r ")), None);
    }

    #[test]
    fn sanitize_caps_the_prompt_length() {
        let long = "word ".repeat(TERMINAL_PROMPT_MAX_CHARS);
        let out = sanitize_terminal_prompt(Some(&long)).unwrap();
        assert!(out.chars().count() <= TERMINAL_PROMPT_MAX_CHARS);
        assert!(!out.ends_with(' '));
        let wide = "é".repeat(TERMINAL_PROMPT_MAX_CHARS + 10);
        assert_eq!(
            sanitize_terminal_prompt(Some(&wide))
                .unwrap()
                .chars()
                .count(),
            TERMINAL_PROMPT_MAX_CHARS
        );
    }

    #[test]
    fn unix_command_without_a_prompt_is_unchanged() {
        assert_eq!(
            unix_terminal_shell_command("/Users/me/HQ", "grok", None),
            "cd '/Users/me/HQ' && grok"
        );
    }

    #[test]
    fn unix_command_binds_the_prompt_after_double_dash_as_one_argument() {
        let prompt = sanitize_terminal_prompt(Some(HOSTILE)).unwrap();
        assert_eq!(
            unix_terminal_shell_command("/Users/me/it's HQ", "grok", Some(&prompt)),
            r#"cd '/Users/me/it'\''s HQ' && grok -- '--version it'\''s "quoted" second line $HOME `x` \n end'"#
        );
    }

    #[test]
    fn applescript_escapes_backslashes_and_double_quotes() {
        let prompt = sanitize_terminal_prompt(Some(HOSTILE)).unwrap();
        let script = terminal_applescript(&unix_terminal_shell_command(
            "/Users/me/HQ",
            "grok",
            Some(&prompt),
        ));
        assert_eq!(
            script,
            r#"tell application "Terminal"
    activate
    do script "cd '/Users/me/HQ' && grok -- '--version it'\\''s \"quoted\" second line $HOME `x` \\n end'"
end tell"#
        );
    }

    /// The shell itself sees exactly two arguments after the binary: `--` and
    /// the prompt, byte for byte.
    #[cfg(unix)]
    #[test]
    fn shell_receives_double_dash_then_the_exact_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let prompt = sanitize_terminal_prompt(Some(HOSTILE)).unwrap();
        let cmd = unix_terminal_shell_command(&path, "printf '[%s]\\n'", Some(&prompt));
        let out = Command::new("/bin/sh")
            .arg("-c")
            .arg(&cmd)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            String::from_utf8(out.stdout).unwrap(),
            format!("[--]\n[{SANITIZED}]\n")
        );
    }

    /// AppleScript decodes the `do script` literal back to the exact shell
    /// line we built.
    #[cfg(target_os = "macos")]
    #[test]
    fn applescript_literal_round_trips_to_the_shell_line() {
        let prompt = sanitize_terminal_prompt(Some(HOSTILE)).unwrap();
        let shell_cmd = unix_terminal_shell_command("/Users/me/HQ", "grok", Some(&prompt));
        let script = terminal_applescript(&shell_cmd);
        let literal = script
            .split("do script ")
            .nth(1)
            .unwrap()
            .split("\nend tell")
            .next()
            .unwrap();
        let out = Command::new("osascript")
            .arg("-e")
            .arg(format!("return {literal}"))
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            String::from_utf8(out.stdout)
                .unwrap()
                .trim_end_matches('\n'),
            shell_cmd
        );
    }

    /// Runs `prefix` then prints PATH in a clean `/bin/sh` with PATH set to
    /// `path`.
    #[cfg(unix)]
    fn sh_path_after(prefix: &str, path: &str) -> String {
        let out = Command::new("/bin/sh")
            .env_clear()
            .env("PATH", path)
            .arg("-c")
            .arg(format!("{prefix}printf %s \"$PATH\""))
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap()
    }

    #[cfg(unix)]
    fn managed_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let npm = dir.path().join("it's a toolchain/npm-global/bin");
        let node = dir.path().join("it's a toolchain/node/bin");
        (dir, npm, node)
    }

    /// Login shells Terminal may hand the session line to, with the flags
    /// that keep each one from reading the user's rc files. Only the ones
    /// installed here are returned; `/bin/sh` is always among them.
    #[cfg(unix)]
    fn login_shells() -> Vec<(&'static str, &'static [&'static str])> {
        let shells: [(&'static str, &'static [&'static str]); 6] = [
            ("/bin/sh", &[]),
            ("/bin/zsh", &["-f"]),
            ("/bin/bash", &["--norc", "--noprofile"]),
            ("/bin/tcsh", &["-f"]),
            ("/bin/csh", &["-f"]),
            ("/bin/dash", &[]),
        ];
        let found: Vec<_> = shells
            .into_iter()
            .filter(|(shell, _)| std::path::Path::new(shell).exists())
            .collect();
        assert!(found.iter().any(|(shell, _)| *shell == "/bin/sh"));
        found
    }

    /// Runs a Terminal session line in `shell` the way Terminal would, after
    /// the rc files have set PATH to `path`, and returns its stdout.
    #[cfg(unix)]
    fn run_session_line(shell: &str, flags: &[&str], line: &str, path: &str) -> String {
        let out = Command::new(shell)
            .env_clear()
            .env("PATH", path)
            .args(flags)
            .arg("-c")
            .arg(line)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{shell}: {}\n{line}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout)
            .unwrap()
            .trim_end_matches('\n')
            .to_string()
    }

    #[cfg(unix)]
    #[test]
    fn session_path_includes_the_managed_cli_dirs_first() {
        let (_dir, npm, node) = managed_fixture();
        let prefix = unix_terminal_path_prefix(&[npm.clone(), node.clone()]);
        assert_eq!(
            sh_path_after(&prefix, "/usr/bin:/bin"),
            format!("{}:{}:/usr/bin:/bin", npm.display(), node.display())
        );
    }

    #[cfg(unix)]
    #[test]
    fn session_path_keeps_the_existing_path_in_order() {
        let (_dir, npm, _node) = managed_fixture();
        let prefix = unix_terminal_path_prefix(std::slice::from_ref(&npm));
        let existing = "/opt/homebrew/bin:/Users/me/.cargo/bin:/usr/bin:/bin";
        assert_eq!(
            sh_path_after(&prefix, existing),
            format!("{}:{existing}", npm.display())
        );
    }

    #[cfg(unix)]
    #[test]
    fn session_path_does_not_add_a_dir_that_is_already_there() {
        let (_dir, npm, node) = managed_fixture();
        let prefix = unix_terminal_path_prefix(&[npm.clone(), node.clone()]);
        let existing = format!("/usr/bin:{}:/bin:{}/", npm.display(), node.display());
        assert_eq!(sh_path_after(&prefix, &existing), existing);

        // Running the prefix twice (a nested shell) adds nothing the second time.
        let once = sh_path_after(&prefix, "/usr/bin");
        assert_eq!(
            sh_path_after(&format!("{prefix}{prefix}"), "/usr/bin"),
            once
        );
    }

    #[cfg(unix)]
    #[test]
    fn session_path_without_a_path_has_no_empty_entry() {
        let (_dir, npm, node) = managed_fixture();
        let prefix = unix_terminal_path_prefix(&[npm.clone(), node.clone()]);
        // An empty PATH, not an unset one: sh fills in its own default when PATH is unset.
        assert_eq!(
            sh_path_after(&prefix, ""),
            format!("{}:{}", npm.display(), node.display())
        );
    }

    #[test]
    fn session_path_prefix_skips_dirs_that_cannot_go_on_path() {
        let managed = [
            PathBuf::from(""),
            PathBuf::from("/a:b/bin"),
            PathBuf::from("/a\nb/bin"),
            PathBuf::from("/ok/bin"),
            PathBuf::from("/ok/bin"),
        ];
        let prefix = unix_terminal_path_prefix(&managed);
        assert_eq!(prefix.matches("/ok/bin").count(), 1, "{prefix}");
        assert!(!prefix.contains("/a"), "{prefix}");
    }

    #[test]
    fn session_line_is_unchanged_without_managed_dirs() {
        assert_eq!(unix_terminal_path_prefix(&[]), "");
        assert_eq!(
            unix_terminal_session_command("/Users/me/HQ", "codex", Some("hi"), &[]),
            unix_terminal_shell_command("/Users/me/HQ", "codex", Some("hi"))
        );
        assert_eq!(
            unix_terminal_session_command("/Users/me/HQ", "codex", None, &[PathBuf::from("/a:b")]),
            unix_terminal_shell_command("/Users/me/HQ", "codex", None)
        );
    }

    /// The session line puts the managed dirs on PATH, keeps the existing
    /// PATH, changes to the folder and passes the prompt through unchanged in
    /// every login shell installed here, csh-family shells included.
    #[cfg(unix)]
    #[test]
    fn session_line_puts_the_managed_dirs_on_path_in_every_login_shell() {
        let (dir, npm, node) = managed_fixture();
        let folder = dir.path().join("it's my \"HQ\" $HOME");
        std::fs::create_dir_all(&folder).unwrap();
        let folder = folder.canonicalize().unwrap();
        let folder_str = folder.to_str().unwrap();
        let managed = [npm.clone(), node.clone()];
        let path_line =
            unix_terminal_session_command(folder_str, "/usr/bin/printenv", Some("PATH"), &managed);
        let pwd_line = unix_terminal_session_command(folder_str, "/bin/pwd", None, &managed);
        let prompt = "it's \\ \"q\" !x $HOME `id`\nline two";
        let echo_line =
            unix_terminal_session_command(folder_str, "/bin/echo", Some(prompt), &managed);
        for (shell, flags) in login_shells() {
            assert_eq!(
                run_session_line(shell, flags, &path_line, "/usr/bin:/bin"),
                format!("{}:{}:/usr/bin:/bin", npm.display(), node.display()),
                "{shell}"
            );
            let already = format!("/usr/bin:{}:{}:/bin", npm.display(), node.display());
            assert_eq!(
                run_session_line(shell, flags, &path_line, &already),
                already,
                "{shell}"
            );
            assert_eq!(
                run_session_line(shell, flags, &pwd_line, "/usr/bin:/bin"),
                folder_str,
                "{shell}"
            );
            assert_eq!(
                run_session_line(shell, flags, &echo_line, "/usr/bin:/bin"),
                format!("-- {prompt}"),
                "{shell}"
            );
        }
    }

    /// After the `cd`, the login shell only sees fixed text and base64, so
    /// fish (which reads `\'` inside single quotes) and csh (which expands
    /// `!`) parse it the same way sh does.
    #[test]
    fn session_line_gives_the_login_shell_only_fixed_text_after_the_cd() {
        let line = unix_terminal_session_command(
            "/Users/o'neil/HQ",
            "claude",
            Some("it's \\ done!"),
            &[PathBuf::from("/m/it's/npm-global/bin")],
        );
        let (cd, rest) = line.split_once(" && ").unwrap();
        assert_eq!(cd, "cd '/Users/o'\\''neil/HQ'");
        let script = rest
            .strip_prefix("/bin/sh -c 'eval \"$(echo ")
            .and_then(|rest| rest.strip_suffix(" | /usr/bin/base64 --decode)\"'"))
            .unwrap_or_else(|| panic!("{line}"));
        assert!(
            script
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=')),
            "{line}"
        );
    }

    fn long_home_managed() -> Vec<PathBuf> {
        let home = format!("/Users/{}", "a".repeat(64));
        vec![
            PathBuf::from(format!(
                "{home}/Library/Application Support/Indigo HQ/toolchain/npm-global/bin"
            )),
            PathBuf::from(format!(
                "{home}/Library/Application Support/Indigo HQ/toolchain/node/bin"
            )),
        ]
    }

    /// The PATH loop names each managed dir once.
    #[test]
    fn session_path_prefix_names_each_dir_once() {
        let managed = long_home_managed();
        let prefix = unix_terminal_path_prefix(&managed);
        for dir in &managed {
            assert_eq!(prefix.matches(dir.to_str().unwrap()).count(), 1, "{prefix}");
        }
    }

    /// The typed line stays under macOS's ~1,024-byte typed-ahead limit for
    /// a long home path, a long folder and prompts up to the 4,000-char cap.
    #[test]
    fn typed_line_stays_under_the_bound_for_long_paths_and_prompts() {
        let managed = long_home_managed();
        let folder = format!("/Users/{}/HQ/companies/{}", "a".repeat(64), "b".repeat(200));
        let script_path = PathBuf::from("/var/folders/xy/abc_123/T/hq-terminal-0123.sh");
        for len in [0usize, 10, 300, 500, 1000, 1500, TERMINAL_PROMPT_MAX_CHARS] {
            let prompt = "p".repeat(len);
            let prompt = (len > 0).then_some(prompt.as_str());
            for binary in ["claude", "codex", "grok"] {
                for (path, managed) in [
                    ("/Users/me/HQ", &managed[..]),
                    (folder.as_str(), &managed[..]),
                    (folder.as_str(), &[][..]),
                ] {
                    let launch =
                        unix_terminal_launch(path, binary, prompt, managed, &script_path).unwrap();
                    assert!(
                        launch.line.len() <= TERMINAL_TYPED_LINE_MAX_BYTES,
                        "{len}: {}",
                        launch.line
                    );
                    assert!(terminal_applescript(&launch.line).len() < 1024);
                    assert!(!launch.line.contains('\n'));
                }
            }
        }
        // A short launch types the session line itself and writes no script.
        let short =
            unix_terminal_launch("/Users/me/HQ", "codex", Some("hi"), &managed, &script_path)
                .unwrap();
        assert_eq!(short.script, None);
        assert_eq!(
            short.line,
            unix_terminal_session_command("/Users/me/HQ", "codex", Some("hi"), &managed)
        );
    }

    /// `launch_claude_code` puts the prompt in the binary string (no length
    /// cap there), so a long Claude prompt must also go through the script.
    #[test]
    fn long_claude_prompt_launch_uses_the_script() {
        let managed = long_home_managed();
        let script_path = PathBuf::from("/tmp/hq-terminal-0123.sh");
        let cmd = claude_command(Some("bypassPermissions"), Some(&"q".repeat(5000))).unwrap();
        let launch =
            unix_terminal_launch("/Users/me/HQ", &cmd, None, &managed, &script_path).unwrap();
        assert_eq!(launch.line, "/bin/sh /tmp/hq-terminal-0123.sh");
        assert!(launch.script.unwrap().contains(&cmd));
    }

    #[test]
    fn script_launch_rejects_a_script_path_that_needs_quoting() {
        let prompt = "p".repeat(2000);
        for bad in [
            "/tmp/it's.sh",
            "/tmp/a b.sh",
            "/tmp/$x.sh",
            "/tmp/!x.sh",
            "",
        ] {
            assert!(
                unix_terminal_launch(
                    "/Users/me",
                    "codex",
                    Some(&prompt),
                    &[],
                    std::path::Path::new(bad)
                )
                .is_err(),
                "{bad}"
            );
        }
    }

    /// A long launch runs from the script in every login shell installed
    /// here: the folder, PATH and the exact prompt (quotes, `$`, backticks,
    /// `!`) arrive unchanged, nothing in the prompt runs, and the script
    /// deletes itself.
    #[cfg(unix)]
    #[test]
    fn script_launch_runs_the_tool_with_the_exact_prompt_in_every_login_shell() {
        let (dir, npm, node) = managed_fixture();
        let folder = dir.path().join("it's my \"HQ\" $HOME");
        std::fs::create_dir_all(&folder).unwrap();
        let folder = folder.canonicalize().unwrap();
        let folder_str = folder.to_str().unwrap();
        let managed = [npm.clone(), node.clone()];
        let marker = dir.path().join("pwned");
        let prompt = format!(
            "it's \\ \"q\" !x $HOME `touch {m}` $(touch {m}) ; touch {m} {}",
            "x".repeat(1200),
            m = marker.display()
        );
        let script_dir = tempfile::tempdir().unwrap();
        let script_dir = script_dir.path().canonicalize().unwrap();
        for (i, (shell, flags)) in login_shells().into_iter().enumerate() {
            let script_path = script_dir.join(format!("hq-terminal-{i}.sh"));
            if !is_plain_shell_word(script_path.to_str().unwrap()) {
                return; // temp dir path needs quoting on this host; covered by the rejection test
            }
            let echo = unix_terminal_launch(
                folder_str,
                "/bin/echo",
                Some(&prompt),
                &managed,
                &script_path,
            )
            .unwrap();
            let text = echo.script.clone().expect("long launch uses a script");
            assert!(echo.line.len() <= TERMINAL_TYPED_LINE_MAX_BYTES);
            write_terminal_script(&script_path, &text).unwrap();
            assert_eq!(
                run_session_line(shell, flags, &echo.line, "/usr/bin:/bin"),
                format!("-- {prompt}"),
                "{shell}"
            );
            assert!(!script_path.exists(), "{shell}: script left behind");
            assert!(!marker.exists(), "{shell}: prompt text ran");

            let long = "y".repeat(1200);
            let env =
                unix_terminal_launch(folder_str, "/bin/sh", Some(&long), &managed, &script_path)
                    .unwrap();
            // `/bin/sh -- <long>` would try to run a file; check PATH and cwd via the script text instead.
            let text = env.script.unwrap();
            let text = text.replace(
                &format!("exec /bin/sh -- '{long}'"),
                "/usr/bin/printenv PATH; /bin/pwd",
            );
            write_terminal_script(&script_path, &text).unwrap();
            assert_eq!(
                run_session_line(shell, flags, &env.line, "/usr/bin:/bin"),
                format!(
                    "{}:{}:/usr/bin:/bin\n{folder_str}",
                    npm.display(),
                    node.display()
                ),
                "{shell}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn script_file_is_new_and_private() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hq-terminal-x.sh");
        write_terminal_script(&path, "true\n").unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // An existing file (or a planted symlink) is never written through.
        assert!(write_terminal_script(&path, "false\n").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "true\n");
    }

    /// The full session line survives AppleScript escaping.
    #[cfg(target_os = "macos")]
    #[test]
    fn applescript_literal_round_trips_the_session_line() {
        let managed = [PathBuf::from(
            "/Users/me/Library/Application Support/Indigo HQ/toolchain/npm-global/bin",
        )];
        let shell_cmd = unix_terminal_session_command(
            "/Users/o'neil/HQ",
            "codex",
            Some("say \"hi\""),
            &managed,
        );
        assert!(
            shell_cmd.starts_with("cd '/Users/o'\\''neil/HQ' && /bin/sh -c '"),
            "{shell_cmd}"
        );
        let script = terminal_applescript(&shell_cmd);
        let literal = script
            .split("do script ")
            .nth(1)
            .unwrap()
            .split("\nend tell")
            .next()
            .unwrap();
        let out = Command::new("osascript")
            .arg("-e")
            .arg(format!("return {literal}"))
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            String::from_utf8(out.stdout)
                .unwrap()
                .trim_end_matches('\n'),
            shell_cmd
        );
    }

    #[test]
    fn powershell_script_without_a_prompt_is_the_bare_binary() {
        assert_eq!(windows_powershell_cli_script(None, "grok", None), "grok");
    }

    #[test]
    fn powershell_script_quotes_double_dash_and_the_prompt() {
        let prompt = sanitize_terminal_prompt(Some(HOSTILE)).unwrap();
        assert_eq!(
            windows_powershell_cli_script(None, "grok", Some(&prompt)),
            "grok '--' '--version it''s ''quoted'' second line $HOME `x` \\n end'"
        );
        assert_eq!(
            windows_powershell_cli_script(
                Some(r"C:\Users\o'neil\HQ"),
                "codex",
                Some("fix it\u{2019}s path\\\\")
            ),
            r"Set-Location -LiteralPath 'C:\Users\o''neil\HQ'; codex '--' 'fix it''s path'"
        );
    }

    #[test]
    fn powershell_encoded_command_is_base64_utf16le() {
        use base64::Engine as _;
        let script = windows_powershell_cli_script(None, "grok", Some("a; b 'c' “d”"));
        let encoded = powershell_encoded_command(&script);
        assert!(encoded
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')));
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .unwrap();
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), script);
        assert_eq!(script, "grok '--' 'a; b ''c'' ''d'''");
    }
}
