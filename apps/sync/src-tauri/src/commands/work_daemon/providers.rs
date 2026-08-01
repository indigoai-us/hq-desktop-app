//! Work-thread provider routing — decide (purely) how to open a local session
//! for a thread's `localSession.provider`, then execute that decision.
//!
//! Split deliberately in two:
//!
//!   * [`plan_launch`] is **pure**: given the provider, the bound HQ folder, the
//!     prefill text, and a snapshot of which runtimes this machine actually has
//!     ([`ProviderEnv`]), it returns the [`LaunchAction`] to perform or the
//!     reason the runtime is unavailable. Every routing rule is unit-tested here
//!     without spawning a process or opening a window.
//!   * [`execute`] performs the IO, reusing the existing launch primitives —
//!     it introduces no new shell surface of its own.
//!
//! ## Per-provider routing
//!
//! | provider | macOS | Windows | unavailable → |
//! |---|---|---|---|
//! | `claude` | existing `claude://code/new?q=…&folder=…` deep link, through `validate_claude_deep_link` + `claude_launch::preflight_claude_code_url` | `claude` CLI in Windows Terminal (`launch_cli_in_terminal`) | `blocked` event |
//! | `codex`  | NEW `codex://threads/new?path=…&prompt=…` into `/Applications/ChatGPT.app` | `codex` CLI in Windows Terminal | `blocked` event |
//! | `grok`   | `grok` CLI in a visible Terminal — **never** a deep link | `grok` CLI in Windows Terminal | `blocked` event |
//!
//! Grok is terminal-only on purpose: `/Applications/Grok Build Desktop.app` is an
//! experimental in-house build that declares NO `CFBundleURLTypes` (re-verified
//! 2026-07-31), and most users do not have it at all — so there is nothing to
//! deep-link into and depending on it would be a latent break.
//!
//! Deep links are macOS-centric. On Windows every provider degrades to the
//! already-shipped `launch_cli_in_terminal` path (whose `cli_binary_for`
//! allowlist covers exactly these three tools), so the cfg(windows) build stays
//! whole rather than growing a second, weaker URL boundary.
//!
//! ## Failure posture
//!
//! Nothing here panics or propagates a fatal error. An unavailable runtime is an
//! `Err(String)` the caller turns into a `blocked` event, leaving the thread
//! unclaimed and un-deduped so a later wake can retry once the runtime appears.

use hq_desktop_core::work_mesh::{build_claude_code_url, build_codex_thread_url, LocalProvider};

/// Where Codex lives on macOS. Codex ships INSIDE the ChatGPT desktop app; its
/// `Info.plist` declares `CFBundleURLSchemes: ["codex"]`. The Codex CLI's own
/// `codex app <dir>` shells out to exactly `open -a <this path> "codex://…"`.
#[cfg(not(windows))]
pub const CHATGPT_APP_PATH: &str = "/Applications/ChatGPT.app";

/// What the daemon should actually do to open a session. Returned by the pure
/// planner so routing can be asserted without touching the OS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchAction {
    /// Dispatch a `claude://code/new` URL through the existing validated opener.
    ClaudeDeepLink(String),
    /// Dispatch a `codex://threads/new` URL to the ChatGPT desktop app.
    CodexDeepLink(String),
    /// Open a visible terminal at `path` running `tool` (the `cli_binary_for`
    /// allowlist token).
    Terminal {
        path: String,
        tool: &'static str,
    },
}

/// A snapshot of which local runtimes this machine can actually drive. Injected
/// rather than probed inside the planner so the routing rules stay pure.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProviderEnv {
    /// Claude Code Desktop is installed (macOS `Claude.app`, Windows exe).
    pub claude_desktop: bool,
    /// The ChatGPT desktop app — which is what registers the `codex` scheme —
    /// is present. On Windows this stands for "the `codex` CLI is on PATH".
    pub codex_runtime: bool,
    /// The `grok` CLI is resolvable on PATH.
    pub grok_cli: bool,
    /// The `claude` CLI is resolvable on PATH. Only consulted on Windows, where
    /// there is no registered URL scheme and every provider degrades to the
    /// terminal launcher — hence the cfg'd dead-code allowance rather than a
    /// cfg'd field (the struct shape stays identical across platforms, so tests
    /// and callers do not fork).
    #[cfg_attr(not(windows), allow(dead_code))]
    pub claude_cli: bool,
    /// The `codex` CLI is resolvable on PATH. Windows-only, as above.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub codex_cli: bool,
}

/// Decide how to open a local session, or why we cannot.
///
/// `hq_folder` is the already-bound HQ root; `prefill` is the fenced session
/// brief from `work_mesh::build_work_thread_session_prefill`.
pub fn plan_launch(
    provider: LocalProvider,
    hq_folder: &str,
    prefill: &str,
    env: &ProviderEnv,
) -> Result<LaunchAction, String> {
    #[cfg(not(windows))]
    {
        match provider {
            LocalProvider::Claude => {
                if !env.claude_desktop {
                    return Err(
                        "Claude Code Desktop is not installed on this machine (no Claude.app)"
                            .to_string(),
                    );
                }
                build_claude_code_url(hq_folder, prefill).map(LaunchAction::ClaudeDeepLink)
            }
            LocalProvider::Codex => {
                if !env.codex_runtime {
                    return Err(format!(
                        "Codex is not available on this machine — Codex ships inside the \
                         ChatGPT desktop app and {CHATGPT_APP_PATH} is not installed"
                    ));
                }
                build_codex_thread_url(hq_folder, prefill).map(LaunchAction::CodexDeepLink)
            }
            LocalProvider::Grok => {
                if !env.grok_cli {
                    return Err(
                        "the `grok` CLI is not on PATH (Grok has no deep link — it is \
                         terminal-only)"
                            .to_string(),
                    );
                }
                Ok(LaunchAction::Terminal {
                    path: hq_folder.to_string(),
                    tool: LocalProvider::Grok.tool(),
                })
            }
        }
    }

    // Windows has no registered agent URL schemes to open, so every provider
    // degrades to the existing terminal launcher rather than failing the build
    // or dispatching a URL nothing would handle. `prefill` cannot ride a
    // terminal invocation, so the session starts at the HQ root and the operator
    // is told where the brief is — see `execute`.
    #[cfg(windows)]
    {
        let _ = prefill;
        let (available, tool) = match provider {
            LocalProvider::Claude => (env.claude_cli, LocalProvider::Claude.tool()),
            LocalProvider::Codex => (env.codex_cli, LocalProvider::Codex.tool()),
            LocalProvider::Grok => (env.grok_cli, LocalProvider::Grok.tool()),
        };
        if !available {
            return Err(format!("the `{tool}` CLI is not on PATH on this machine"));
        }
        Ok(LaunchAction::Terminal {
            path: hq_folder.to_string(),
            tool,
        })
    }
}

/// Probe the machine for the runtimes [`plan_launch`] routes to. Cheap
/// filesystem / PATH checks only; never spawns the runtimes themselves.
pub fn detect_provider_env() -> ProviderEnv {
    ProviderEnv {
        claude_desktop: claude_desktop_installed(),
        codex_runtime: codex_runtime_present(),
        grok_cli: cli_on_path("grok"),
        claude_cli: cli_on_path("claude"),
        codex_cli: cli_on_path("codex"),
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
    // Windows never dispatches the deep link, so desktop presence is not the
    // gate there — the CLI probe is.
    false
}

/// Codex's URL handler is the ChatGPT desktop app's, so its presence IS the
/// availability signal on macOS. On Windows the terminal fallback is used, so
/// the CLI probe carries the decision instead.
#[cfg(not(windows))]
fn codex_runtime_present() -> bool {
    if std::path::Path::new(CHATGPT_APP_PATH).exists() {
        return true;
    }
    dirs::home_dir()
        .map(|home| home.join("Applications/ChatGPT.app").exists())
        .unwrap_or(false)
}

#[cfg(windows)]
fn codex_runtime_present() -> bool {
    false
}

/// Whether `name` resolves to a runnable binary. Uses the shared
/// `paths::resolve_bin` resolver so launchd's minimal PATH (and the Windows
/// extended search path) are handled the same way the rest of the app handles
/// them — `resolve_bin` returns the bare name when nothing was found.
fn cli_on_path(name: &str) -> bool {
    let resolved = crate::util::paths::resolve_bin(name);
    resolved != name && std::path::Path::new(&resolved).exists()
}

/// Perform a planned launch. Every branch routes through an already-shipped
/// launch primitive; this function adds no new shell surface.
pub fn execute(action: LaunchAction) -> Result<(), String> {
    match action {
        LaunchAction::ClaudeDeepLink(url) => {
            // Reuse the exact command the "Open in Claude Code" button uses:
            // byte-allowlist validation, then the HQ-root marker preflight +
            // folder rebind, then the platform opener.
            crate::commands::app::open_claude_code_link(url)
        }
        LaunchAction::CodexDeepLink(url) => open_codex_link(&url),
        LaunchAction::Terminal { path, tool } => {
            crate::commands::launch::launch_cli_in_terminal(path, tool.to_string())
        }
    }
}

/// Hand a validated `codex://` URL to the ChatGPT desktop app.
///
/// `open -a <app> <url>` (rather than a bare `open <url>`) mirrors exactly what
/// the Codex CLI itself emits, so the link cannot be captured by some other
/// handler that happens to have claimed the `codex` scheme.
#[cfg(not(windows))]
fn open_codex_link(url: &str) -> Result<(), String> {
    crate::commands::launch::validate_codex_deep_link(url)?;

    let output = std::process::Command::new("open")
        .arg("-a")
        .arg(CHATGPT_APP_PATH)
        .arg(url)
        .output()
        .map_err(|e| format!("Failed to run open: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "open -a {CHATGPT_APP_PATH} exited {}: {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    Ok(())
}

/// Windows never plans a `CodexDeepLink` (see `plan_launch`), so this is an
/// unreachable-by-construction guard that keeps the cfg(windows) build whole
/// without inventing a Windows URL boundary.
#[cfg(windows)]
fn open_codex_link(_url: &str) -> Result<(), String> {
    Err("codex:// deep links are macOS-only; use the terminal launcher".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_available() -> ProviderEnv {
        ProviderEnv {
            claude_desktop: true,
            codex_runtime: true,
            grok_cli: true,
            claude_cli: true,
            codex_cli: true,
        }
    }

    // ── per-provider routing (the three legs of the contract) ────────────────

    #[test]
    #[cfg(not(windows))]
    fn claude_routes_to_the_existing_claude_deep_link() {
        let action = plan_launch(
            LocalProvider::Claude,
            "/Users/me/HQ",
            "brief",
            &all_available(),
        )
        .expect("claude plans");
        match action {
            LaunchAction::ClaudeDeepLink(url) => {
                assert!(url.starts_with("claude://code/new?"), "url = {url}");
                assert!(url.contains("q=brief"), "url = {url}");
                assert!(url.contains("folder=%2FUsers%2Fme%2FHQ"), "url = {url}");
            }
            other => panic!("claude must route to the claude deep link, got {other:?}"),
        }
    }

    #[test]
    #[cfg(not(windows))]
    fn codex_routes_to_the_new_codex_deep_link() {
        let action = plan_launch(
            LocalProvider::Codex,
            "/Users/me/HQ",
            "brief",
            &all_available(),
        )
        .expect("codex plans");
        match action {
            LaunchAction::CodexDeepLink(url) => {
                assert!(url.starts_with("codex://threads/new?"), "url = {url}");
                assert!(url.contains("path=%2FUsers%2Fme%2FHQ"), "url = {url}");
                assert!(url.contains("prompt=brief"), "url = {url}");
            }
            other => panic!("codex must route to the codex deep link, got {other:?}"),
        }
    }

    #[test]
    fn grok_routes_to_a_terminal_never_a_deep_link() {
        let action = plan_launch(
            LocalProvider::Grok,
            "/Users/me/HQ",
            "brief",
            &all_available(),
        )
        .expect("grok plans");
        assert_eq!(
            action,
            LaunchAction::Terminal {
                path: "/Users/me/HQ".to_string(),
                tool: "grok",
            },
            "Grok Build Desktop declares no URL types — terminal only"
        );
    }

    // ── unavailable runtime → a reason the caller turns into `blocked` ───────

    #[test]
    #[cfg(not(windows))]
    fn missing_chatgpt_app_makes_codex_unavailable_with_a_named_reason() {
        let env = ProviderEnv {
            codex_runtime: false,
            ..all_available()
        };
        let err = plan_launch(LocalProvider::Codex, "/Users/me/HQ", "brief", &env)
            .expect_err("codex must be unavailable");
        assert!(err.contains("ChatGPT"), "reason should name the runtime: {err}");
        assert!(err.contains(CHATGPT_APP_PATH), "reason should be actionable: {err}");
    }

    #[test]
    #[cfg(not(windows))]
    fn missing_claude_desktop_makes_claude_unavailable() {
        let env = ProviderEnv {
            claude_desktop: false,
            ..all_available()
        };
        let err = plan_launch(LocalProvider::Claude, "/Users/me/HQ", "brief", &env)
            .expect_err("claude must be unavailable");
        assert!(err.contains("Claude"), "{err}");
    }

    #[test]
    fn missing_grok_cli_makes_grok_unavailable() {
        let env = ProviderEnv {
            grok_cli: false,
            ..all_available()
        };
        let err = plan_launch(LocalProvider::Grok, "/Users/me/HQ", "brief", &env)
            .expect_err("grok must be unavailable");
        assert!(err.contains("grok"), "{err}");
    }

    #[test]
    fn every_provider_is_unavailable_on_a_bare_machine_and_none_panic() {
        let bare = ProviderEnv::default();
        for provider in [
            LocalProvider::Claude,
            LocalProvider::Codex,
            LocalProvider::Grok,
        ] {
            let result = plan_launch(provider, "/Users/me/HQ", "brief", &bare);
            assert!(
                result.is_err(),
                "{provider:?} must report unavailable, not launch"
            );
            assert!(
                !result.unwrap_err().is_empty(),
                "{provider:?} must name a reason for the blocked event"
            );
        }
    }

    // ── Windows degradation ──────────────────────────────────────────────────

    #[test]
    #[cfg(windows)]
    fn windows_degrades_every_provider_to_the_terminal_launcher() {
        for (provider, tool) in [
            (LocalProvider::Claude, "claude"),
            (LocalProvider::Codex, "codex"),
            (LocalProvider::Grok, "grok"),
        ] {
            let action = plan_launch(provider, "C:\\HQ", "brief", &all_available())
                .expect("windows plans a terminal launch");
            assert_eq!(
                action,
                LaunchAction::Terminal {
                    path: "C:\\HQ".to_string(),
                    tool,
                }
            );
        }
    }
}
