//! Parse each CLI's "am I signed in?" probe output.
//!
//! Extracted from the former `agent_session::{codex,grok}` modules and
//! `grok_wire::login_status_from_models` when the Sessions feature was
//! removed. Behaviour is unchanged — these strings are the CLIs' contract.

/// `codex login status` prints `Logged in` / `Logged in using …` when signed in.
pub fn codex_login_status_succeeded(success: bool, stdout: &[u8], stderr: &[u8]) -> bool {
    success
        && [stdout, stderr].iter().any(|stream| {
            String::from_utf8_lossy(stream).lines().any(|line| {
                let line = line.trim();
                line == "Logged in" || line.starts_with("Logged in using ")
            })
        })
}

/// `grok models` reports sign-in on stdout (`You are logged in with grok.com.`).
/// `Err(())` means the probe was inconclusive, never "signed out".
pub fn grok_login_status_succeeded(
    success: bool,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<bool, ()> {
    let combined = [stdout, stderr]
        .iter()
        .map(|stream| String::from_utf8_lossy(stream))
        .collect::<Vec<_>>()
        .join("\n");
    let lower = combined.to_ascii_lowercase();
    if lower.contains("you are logged in") {
        return Ok(true);
    }
    if lower.contains("not logged in") || lower.contains("not signed in") {
        return Ok(false);
    }
    if success && lower.contains("grok-") {
        return Ok(true);
    }
    Err(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_reads_both_logged_in_spellings() {
        assert!(codex_login_status_succeeded(true, b"Logged in\n", b""));
        assert!(codex_login_status_succeeded(
            true,
            b"Logged in using ChatGPT\n",
            b""
        ));
        assert!(!codex_login_status_succeeded(true, b"Not logged in\n", b""));
        assert!(!codex_login_status_succeeded(false, b"Logged in\n", b""));
    }

    #[test]
    fn grok_distinguishes_signed_out_from_inconclusive() {
        assert_eq!(
            grok_login_status_succeeded(true, b"You are logged in with grok.com.", b""),
            Ok(true)
        );
        assert_eq!(
            grok_login_status_succeeded(true, b"Not logged in", b""),
            Ok(false)
        );
        assert_eq!(grok_login_status_succeeded(false, b"", b""), Err(()));
    }
}
