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

/// Model override handed to `hq bot create --model`. Closed character set so
/// nothing shell- or flag-like can ride along (argv is never shell-parsed,
/// but the CLI would otherwise see a nonsense model id).
fn validate_model(model: &str) -> Result<String, String> {
    let trimmed = model.trim();
    let ok = !trimmed.is_empty()
        && trimmed.len() <= 64
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
        && !trimmed.starts_with('-');
    if ok {
        Ok(trimmed.to_string())
    } else {
        Err("Model ids use letters, digits, dots, colons, underscores, and hyphens.".to_string())
    }
}

/// Worker id from `core/workers/registry.yaml` (`hq bot create --worker`).
fn validate_worker(worker: &str) -> Result<String, String> {
    let trimmed = worker.trim();
    let ok = !trimmed.is_empty()
        && trimmed.len() <= 64
        && trimmed
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-'))
        && !trimmed.starts_with('-');
    if ok {
        Ok(trimmed.to_string())
    } else {
        Err("Worker ids use lowercase letters, digits, underscores, and hyphens.".to_string())
    }
}

/// Bot intro handed to `hq bot create --intro`: the first message the bot
/// sends when it comes online. Free text, but bounded and free of control
/// characters so it can never smuggle a newline-delimited flag or terminal
/// escape into the CLI's argv or the bot's config.
const INTRO_MAX_CHARS: usize = 500;

fn validate_intro(intro: &str) -> Result<String, String> {
    let trimmed = intro.trim();
    if trimmed.is_empty() {
        return Err("The intro is empty.".to_string());
    }
    if trimmed.chars().count() > INTRO_MAX_CHARS {
        return Err(format!("Keep the intro under {INTRO_MAX_CHARS} characters."));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("The intro can't contain control characters.".to_string());
    }
    Ok(trimmed.to_string())
}

/// Memory location for `hq bot create --memory`: HQ-synced or this Mac only.
fn validate_memory(memory: &str) -> Result<&'static str, String> {
    match memory.trim() {
        "synced" => Ok("synced"),
        "local" => Ok("local"),
        other => Err(format!("Unknown memory location \"{other}\"; expected synced or local.")),
    }
}

/// argv for `hq bot create` (without the trailing `--json`, which
/// `run_hq_bot` appends). Pure so the flag mapping is unit-testable — the
/// JS side sends camelCase (`autoApprove`) and Tauri maps it to
/// `auto_approve`; a mismatch would silently drop the setting.
#[allow(clippy::too_many_arguments)]
fn create_args(
    name: &str,
    runtime: &str,
    model: Option<&str>,
    auto_approve: Option<bool>,
    worker: Option<&str>,
    intro: Option<&str>,
    memory: Option<&str>,
) -> Result<Vec<String>, String> {
    let name = validate_name(name)?;
    let runtime = validate_runtime(runtime)?;
    let mut args = vec!["create".to_string(), name, "--runtime".to_string(), runtime.to_string()];
    if let Some(model) = model.map(str::trim).filter(|m| !m.is_empty()) {
        args.push("--model".to_string());
        args.push(validate_model(model)?);
    }
    if auto_approve == Some(false) {
        args.push("--no-auto-approve".to_string());
    }
    if let Some(worker) = worker.map(str::trim).filter(|w| !w.is_empty()) {
        args.push("--worker".to_string());
        args.push(validate_worker(worker)?);
    }
    if let Some(intro) = intro.map(str::trim).filter(|i| !i.is_empty()) {
        args.push("--intro".to_string());
        args.push(validate_intro(intro)?);
    }
    if let Some(memory) = memory.map(str::trim).filter(|m| !m.is_empty()) {
        args.push("--memory".to_string());
        args.push(validate_memory(memory)?.to_string());
    }
    Ok(args)
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

/// `hq bot create <name> --runtime <runtime> [--model m] [--no-auto-approve]
/// [--worker id] [--intro text] [--memory synced|local] --json`: provisions
/// the identity, scaffolds (or binds) the worker folder, installs the launchd
/// agent, and starts the bot.
#[tauri::command]
pub async fn local_bots_create(
    name: String,
    runtime: String,
    model: Option<String>,
    auto_approve: Option<bool>,
    worker: Option<String>,
    intro: Option<String>,
    memory: Option<String>,
) -> Result<Value, String> {
    let args = create_args(
        &name,
        &runtime,
        model.as_deref(),
        auto_approve,
        worker.as_deref(),
        intro.as_deref(),
        memory.as_deref(),
    )?;
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    run_hq_bot(&argv, Duration::from_secs(150)).await
}

/// `hq bot workers --json` → `{ workers: [{ id, path, company?, description?,
/// summary?, skillCount?, name?, source? }] }`:
/// company/core workers a bot can be created from.
#[tauri::command]
pub async fn local_bots_workers() -> Result<Value, String> {
    run_hq_bot(&["workers"], Duration::from_secs(45)).await
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
    fn create_args_map_every_setting_to_a_cli_flag() {
        assert_eq!(
            create_args("scout", "claude", None, None, None, None, None).unwrap(),
            vec!["create", "scout", "--runtime", "claude"]
        );
        assert_eq!(
            create_args("scout", "grok", Some("grok-4.5"), Some(true), Some(""), Some(""), Some("")).unwrap(),
            vec!["create", "scout", "--runtime", "grok", "--model", "grok-4.5"]
        );
        assert_eq!(
            create_args("iris", "claude", None, Some(false), Some("iris-cx"), None, None).unwrap(),
            vec!["create", "iris", "--runtime", "claude", "--no-auto-approve", "--worker", "iris-cx"]
        );
        assert!(create_args("scout", "claude", Some("--dangerously"), None, None, None, None).is_err());
        assert!(create_args("scout", "claude", None, None, Some("../x"), None, None).is_err());
        assert!(create_args("scout", "claude", None, None, Some("Iris"), None, None).is_err());
        assert!(create_args("Scout", "claude", None, None, None, None, None).is_err());
    }

    #[test]
    fn create_args_pass_intro_and_memory() {
        assert_eq!(
            create_args("scout", "claude", None, None, None, Some(" Hi, I'm Scout. "), Some("local")).unwrap(),
            vec!["create", "scout", "--runtime", "claude", "--intro", "Hi, I'm Scout.", "--memory", "local"]
        );
        assert_eq!(
            create_args("scout", "claude", None, None, None, None, Some("synced")).unwrap(),
            vec!["create", "scout", "--runtime", "claude", "--memory", "synced"]
        );
        // Intro: bounded, no control characters (newlines included).
        let long = "x".repeat(INTRO_MAX_CHARS + 1);
        assert!(create_args("scout", "claude", None, None, None, Some(&long), None).is_err());
        assert!(create_args("scout", "claude", None, None, None, Some("hi\nthere"), None).is_err());
        assert!(create_args("scout", "claude", None, None, None, Some("hi\u{1b}[31m"), None).is_err());
        assert_eq!(validate_intro(&"y".repeat(INTRO_MAX_CHARS)).unwrap().len(), INTRO_MAX_CHARS);
        // Memory is a closed enum.
        assert!(create_args("scout", "claude", None, None, None, None, Some("cloud")).is_err());
        assert!(validate_memory("LOCAL").is_err());
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
