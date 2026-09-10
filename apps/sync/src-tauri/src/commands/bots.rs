//! Personal local bots (local-bots US-009).
//!
//! Every command shells to the hq CLI (`hq bot … --json`) through the same
//! launch boundary the connector importer and bug reporter use: the resolved
//! `hq` binary, the child PATH, and the configured HQ root. The CLI owns the
//! bot's identity, credentials, launchd agent, and process; the app only asks
//! and shows. Secrets never cross this boundary — `hq bot` never prints them.

use std::time::Duration;

use serde_json::Value;

use crate::commands::install_directory::resolve_hq_path;
use crate::util::logfile::log;
use crate::util::paths;

const LOG_TAG: &str = "local-bots";

fn validate_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    let ok = !trimmed.is_empty()
        && trimmed.len() <= 40
        && trimmed
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !trimmed.starts_with('-')
        && !trimmed.ends_with('-')
        && !trimmed.contains("--");
    if ok {
        Ok(trimmed.to_string())
    } else {
        Err("Bot names use lowercase letters, digits, and single hyphens (for example \"assistant\").".to_string())
    }
}

fn validate_runtime(runtime: &str) -> Result<&'static str, String> {
    match runtime.trim() {
        "claude" => Ok("claude"),
        "codex" => Ok("codex"),
        "grok" => Ok("grok"),
        other => Err(format!("Unknown runtime \"{other}\"; expected claude, codex, or grok.")),
    }
}

/// Run `hq bot <args…> --json` and parse its stdout as JSON. A non-zero exit
/// surfaces the CLI's own (already user-facing) message.
async fn run_hq_bot(args: &[&str], timeout: Duration) -> Result<Value, String> {
    let hq_root = resolve_hq_path()?;
    let hq = paths::resolve_bin("hq");
    let mut argv: Vec<&str> = vec!["bot"];
    argv.extend_from_slice(args);
    argv.push("--json");
    log(LOG_TAG, &format!("hq {}", argv.join(" ")));
    let mut command = paths::tokio_spawn_command(&hq, &argv);
    let output = tokio::time::timeout(
        timeout,
        command
            .current_dir(&hq_root)
            .env("PATH", paths::child_path())
            .env("HQ_NO_UPDATE_CHECK", "1")
            .env("HQ_ROOT", &hq_root)
            .output(),
    )
    .await
    .map_err(|_| format!("hq bot {} did not finish within {}s", args.join(" "), timeout.as_secs()))?
    .map_err(|e| format!("Could not start the hq CLI: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let message = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("hq bot {} exited with status {}", args.join(" "), output.status.code().unwrap_or(-1))
        };
        log(LOG_TAG, &format!("hq bot {} failed: {}", args.join(" "), message.replace('\n', " | ")));
        return Err(strip_ansi(&message));
    }
    // The CLI prints one JSON document; tolerate a stray leading line.
    let start = stdout.find('{').unwrap_or(0);
    serde_json::from_str::<Value>(&stdout[start..])
        .map_err(|e| format!("hq bot {} returned unreadable output: {e}", args.join(" ")))
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // ESC [ … m
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// `hq bot list --json` → `{ bots: [...] }`.
#[tauri::command]
pub async fn local_bots_list() -> Result<Value, String> {
    run_hq_bot(&["list"], Duration::from_secs(45)).await
}

/// `hq bot create <name> --runtime <runtime> --json`: provisions the identity,
/// scaffolds the worker folder, installs the launchd agent, and starts the bot.
#[tauri::command]
pub async fn local_bots_create(name: String, runtime: String) -> Result<Value, String> {
    let name = validate_name(&name)?;
    let runtime = validate_runtime(&runtime)?;
    run_hq_bot(&["create", &name, "--runtime", runtime], Duration::from_secs(150)).await
}

#[tauri::command]
pub async fn local_bots_start(name: String) -> Result<Value, String> {
    let name = validate_name(&name)?;
    run_hq_bot(&["start", &name], Duration::from_secs(60)).await
}

#[tauri::command]
pub async fn local_bots_stop(name: String) -> Result<Value, String> {
    let name = validate_name(&name)?;
    run_hq_bot(&["stop", &name], Duration::from_secs(60)).await
}

#[tauri::command]
pub async fn local_bots_remove(name: String) -> Result<Value, String> {
    let name = validate_name(&name)?;
    run_hq_bot(&["rm", &name, "--yes"], Duration::from_secs(120)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_slugs() {
        assert_eq!(validate_name("assistant").unwrap(), "assistant");
        assert_eq!(validate_name(" scout-2 ").unwrap(), "scout-2");
        assert!(validate_name("Scout").is_err());
        assert!(validate_name("-x").is_err());
        assert!(validate_name("a--b").is_err());
        assert!(validate_name("../etc").is_err());
        assert!(validate_name("").is_err());
    }

    #[test]
    fn runtimes_are_closed() {
        assert_eq!(validate_runtime("grok").unwrap(), "grok");
        assert!(validate_runtime("gemini").is_err());
    }

    #[test]
    fn ansi_is_stripped_from_cli_errors() {
        assert_eq!(strip_ansi("\u{1b}[31mNo bot named \"x\"\u{1b}[39m"), "No bot named \"x\"");
    }
}
