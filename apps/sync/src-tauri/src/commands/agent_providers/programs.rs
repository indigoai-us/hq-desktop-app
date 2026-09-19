//! Resolve the program path for each agent CLI.
//!
//! Extracted verbatim from the former `agent_session::{claude,codex,grok}`
//! modules; the launch allowlist stays the single place a tool name becomes a
//! program to run.

use std::path::PathBuf;

use hq_desktop_core::paths;

pub fn claude_program() -> String {
    claude_lookup().path
}

/// Whether a program lookup actually FOUND a binary, and what it landed on.
///
/// [`paths::resolve_bin_with_kind`] falls back to the bare name when it finds
/// nothing, so `claude_program()` alone cannot tell "installed here" from
/// "nowhere on this Mac" — spawning the bare name just fails with os error 2,
/// which the probe used to fold into "not signed in". Callers that must report
/// the difference read `found`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgramLookup {
    pub path: String,
    pub found: bool,
}

pub fn claude_lookup() -> ProgramLookup {
    select_claude_lookup(paths::resolve_bin_with_kind("claude"), || {
        crate::commands::launch::bundled_claude_bin()
    })
}

pub fn codex_lookup() -> ProgramLookup {
    let binary = crate::commands::launch::cli_binary_for("codex").unwrap_or("codex");
    select_codex_lookup(crate::commands::launch::bundled_codex_bin(), || {
        paths::resolve_bin_with_kind(binary)
    })
}

pub fn grok_lookup() -> ProgramLookup {
    let binary = crate::commands::launch::cli_binary_for("grok").unwrap_or("grok");
    let resolved = paths::resolve_bin_with_kind(binary);
    ProgramLookup {
        found: resolved.is_resolved(),
        path: resolved.path,
    }
}

/// A resolved `claude`, else the CLI Claude Desktop manages under Application
/// Support, else the bare name marked NOT found.
///
/// The bundled copy still counts as installed — sessions spawn that binary
/// directly — but when neither exists the lookup must say so rather than hand
/// back a bare `claude` that fails to spawn and reads as "signed out".
fn select_claude_lookup(
    resolved: paths::ResolvedProgram,
    bundled: impl FnOnce() -> Option<PathBuf>,
) -> ProgramLookup {
    if resolved.is_resolved() {
        return ProgramLookup {
            path: resolved.path,
            found: true,
        };
    }
    match bundled() {
        Some(bundled) => ProgramLookup {
            path: bundled.to_string_lossy().into_owned(),
            found: true,
        },
        None => ProgramLookup {
            path: resolved.path,
            found: false,
        },
    }
}

fn select_codex_lookup(
    bundled: Option<PathBuf>,
    fallback: impl FnOnce() -> paths::ResolvedProgram,
) -> ProgramLookup {
    match bundled {
        Some(bundled) => ProgramLookup {
            path: bundled.to_string_lossy().into_owned(),
            found: true,
        },
        None => {
            let resolved = fallback();
            ProgramLookup {
                found: resolved.is_resolved(),
                path: resolved.path,
            }
        }
    }
}

// Through the launch allowlist even though the names are literals here: the
// allowlist is the one place a tool name becomes a program to run, and a second
// spelling of that rule is a second place to get it wrong. Both live in the
// `*_lookup` functions above, which these thin wrappers read.
pub fn codex_program() -> String {
    codex_lookup().path
}

pub fn grok_program() -> String {
    grok_lookup().path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_prefers_bundled_runtime_over_stale_path_cli() {
        let bundled = PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex");
        let found = select_codex_lookup(Some(bundled.clone()), || panic!("PATH must not win"));
        assert_eq!(found.path, bundled.to_string_lossy());
        assert!(found.found);

        let on_path = select_codex_lookup(None, || paths::ResolvedProgram {
            path: "/usr/local/bin/codex".into(),
            kind: paths::ResolvedProgramKind::Exe,
        });
        assert_eq!(on_path.path, "/usr/local/bin/codex");
        assert!(on_path.found);
    }

    /// The whole point of the lookup: nothing on disk is NOT "signed out".
    #[test]
    fn an_unresolved_codex_is_reported_as_not_found() {
        let missing = select_codex_lookup(None, || paths::ResolvedProgram::not_resolved("codex"));
        assert_eq!(missing.path, "codex");
        assert!(!missing.found);
    }

    #[test]
    fn claude_falls_back_to_the_bundled_cli_before_reporting_absent() {
        let bundled = PathBuf::from("/Users/x/Library/Application Support/Claude/claude");
        let from_bundle =
            select_claude_lookup(paths::ResolvedProgram::not_resolved("claude"), || {
                Some(bundled.clone())
            });
        assert_eq!(from_bundle.path, bundled.to_string_lossy());
        assert!(from_bundle.found);

        let on_path = select_claude_lookup(
            paths::ResolvedProgram {
                path: "/opt/homebrew/bin/claude".into(),
                kind: paths::ResolvedProgramKind::Exe,
            },
            || panic!("a resolved CLI must win over the bundle"),
        );
        assert_eq!(on_path.path, "/opt/homebrew/bin/claude");
        assert!(on_path.found);

        let nowhere =
            select_claude_lookup(paths::ResolvedProgram::not_resolved("claude"), || None);
        assert_eq!(nowhere.path, "claude");
        assert!(!nowhere.found);
    }
}
