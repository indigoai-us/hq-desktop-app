//! The #welcome secret card → vault, with the value never entering the agent
//! session, the transcript, a shell argument, or this log.
//!
//! `hq secrets set <NAME> --from-stdin [--personal | --company <slug>]` reads
//! the value from stdin. This is the first-party product form the
//! `hq-third-party-secret-capture-via-generate-link` policy allows: the
//! plaintext goes field → this process → CLI stdin → vault, and nowhere else.

use std::process::Stdio;

use tokio::io::AsyncWriteExt;

use crate::util::hq_resolver::{self, HqInvocation};
use crate::util::logfile::log;
use crate::util::paths;

const LOG_TAG: &str = "setup-secret";

/// Secret names the vault accepts; also keeps a name from smuggling flags.
fn valid_secret_name(name: &str) -> bool {
    let len = name.len();
    (1..=128).contains(&len)
        && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'))
}

fn valid_company_slug(slug: &str) -> bool {
    let len = slug.len();
    (1..=64).contains(&len)
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The argv after `hq`, built once so a test can pin it. Never includes the value.
pub(crate) fn secrets_set_args(
    name: &str,
    scope: &str,
    company: Option<&str>,
) -> Result<Vec<String>, String> {
    if !valid_secret_name(name) {
        return Err("That secret name is not valid. Use letters, digits, `_`, `.`, `/` or `-`.".into());
    }
    let mut args = vec!["secrets".to_string(), "set".to_string(), name.to_string(), "--from-stdin".to_string()];
    match scope {
        "company" => {
            let slug = company.map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| {
                "A company secret needs the company it belongs to.".to_string()
            })?;
            if !valid_company_slug(slug) {
                return Err("That company slug is not valid.".into());
            }
            args.push("--company".into());
            args.push(slug.to_string());
        }
        _ => args.push("--personal".into()),
    }
    Ok(args)
}

/// Store a credential collected by the #welcome secret card.
#[tauri::command]
pub async fn setup_store_secret(
    name: String,
    scope: String,
    company: Option<String>,
    value: String,
) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err("Paste the value first.".into());
    }
    let args = secrets_set_args(&name, &scope, company.as_deref())?;
    let invocation: HqInvocation = hq_resolver::resolve_hq();
    let _npx_guard = invocation.npx_serial_guard().await;
    log(LOG_TAG, &format!("store ({}): hq {}", invocation.label(), args.join(" ")));

    let mut cmd = invocation.command();
    cmd.args(&args)
        .env("PATH", paths::child_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start the HQ command line ({e})."))?;
    {
        let mut stdin = child.stdin.take().ok_or("Could not hand the value to HQ.")?;
        stdin
            .write_all(value.as_bytes())
            .await
            .map_err(|e| format!("Could not hand the value to HQ ({e})."))?;
        stdin.shutdown().await.ok();
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("HQ did not finish storing the secret ({e})."))?;
    if output.status.success() {
        log(LOG_TAG, &format!("stored name={name} scope={scope}"));
        return Ok(());
    }
    // Only the CLI's own (value-free) diagnostics; never the input.
    let stderr = String::from_utf8_lossy(&output.stderr);
    let line = stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("HQ could not store the secret.");
    log(LOG_TAG, &format!("failed name={name} scope={scope} status={:?}", output.status.code()));
    Err(line.to_string())
}

#[cfg(test)]
mod tests {
    use super::secrets_set_args;

    #[test]
    fn personal_secret_reads_from_stdin_and_never_carries_the_value() {
        let args = secrets_set_args("DATABASE_URL", "personal", None).unwrap();
        assert_eq!(args, ["secrets", "set", "DATABASE_URL", "--from-stdin", "--personal"]);
    }

    #[test]
    fn company_secret_targets_the_slug() {
        let args = secrets_set_args("STRIPE_API_KEY", "company", Some("hqtestco")).unwrap();
        assert_eq!(
            args,
            ["secrets", "set", "STRIPE_API_KEY", "--from-stdin", "--company", "hqtestco"]
        );
        assert!(secrets_set_args("STRIPE_API_KEY", "company", None).is_err());
        assert!(secrets_set_args("STRIPE_API_KEY", "company", Some("Bad Slug")).is_err());
    }

    #[test]
    fn a_name_that_looks_like_a_flag_or_is_empty_is_refused() {
        assert!(secrets_set_args("--token", "personal", None).is_err());
        assert!(secrets_set_args("", "personal", None).is_err());
        assert!(secrets_set_args("has space", "personal", None).is_err());
    }
}
