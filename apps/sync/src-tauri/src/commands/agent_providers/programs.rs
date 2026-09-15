//! Resolve the program path for each agent CLI.
//!
//! Extracted verbatim from the former `agent_session::{claude,codex,grok}`
//! modules; the launch allowlist stays the single place a tool name becomes a
//! program to run.

use std::path::PathBuf;

use hq_desktop_core::paths;

pub fn claude_program() -> String {
    select_claude_program(paths::resolve_bin_with_kind("claude"), || {
        crate::commands::launch::bundled_claude_bin()
    })
}

pub fn codex_program() -> String {
    // Through the launch allowlist even though the name is a literal here:
    // the allowlist is the one place a tool name becomes a program to run, and
    // a second spelling of that rule is a second place to get it wrong.
    let binary = crate::commands::launch::cli_binary_for("codex").unwrap_or("codex");
    select_codex_program(crate::commands::launch::bundled_codex_bin(), || {
        paths::resolve_bin(binary)
    })
}

pub fn grok_program() -> String {
    let binary = crate::commands::launch::cli_binary_for("grok").unwrap_or("grok");
    paths::resolve_bin(binary)
}

fn select_claude_program(
    resolved: paths::ResolvedProgram,
    bundled: impl FnOnce() -> Option<PathBuf>,
) -> String {
    if resolved.is_resolved() {
        return resolved.path;
    }
    bundled()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(resolved.path)
}

fn select_codex_program(bundled: Option<PathBuf>, fallback: impl FnOnce() -> String) -> String {
    bundled
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_prefers_bundled_runtime_over_stale_path_cli() {
        let bundled = PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex");
        assert_eq!(
            select_codex_program(Some(bundled.clone()), || panic!("PATH must not win")),
            bundled.to_string_lossy()
        );
        assert_eq!(
            select_codex_program(None, || "/usr/local/bin/codex".into()),
            "/usr/local/bin/codex"
        );
    }
}
