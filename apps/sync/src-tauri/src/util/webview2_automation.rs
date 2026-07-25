//! WebView2 automation bridge (Windows only).
//!
//! msedgedriver's ONLY channel for putting `--remote-debugging-port` into a
//! WebView2 *host* app is the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
//! environment variable it sets on the process it launches. wry 0.55.1 severs
//! that channel: `create_environment` (wry/src/webview2/mod.rs:294) always
//! calls `ICoreWebView2EnvironmentOptions::put_AdditionalBrowserArguments` —
//! the `unwrap_or_else` there supplies a default string, so no code path
//! leaves the property unset — and once that property is set the WebView2
//! Runtime ignores the environment variable wholesale.
//!
//! The observable consequence on CI was that `msedgewebview2.exe` launched
//! with nothing but wry's default arg string: no `--remote-debugging-port`, so
//! no DevToolsActivePort file was ever written, so every session died with
//! `session not created: DevToolsActivePort file doesn't exist` after
//! msedgedriver's 60s wait. Nothing outside the app can repair that — it is a
//! structural gap in wry for every WebView2 app — so the app forwards the
//! variable itself through Tauri's `additionalBrowserArgs`, which feeds the
//! same `put_AdditionalBrowserArguments` call and therefore wins.
//!
//! Two rules make this safe:
//!
//! 1. **Gated on the variable being present.** A normal launch never sets
//!    `additionalBrowserArgs` at all, so wry takes its default path byte for
//!    byte and remote debugging is never enabled for real users.
//! 2. **wry's defaults are re-included.** Setting the property *replaces*
//!    wry's default string rather than extending it, so dropping it would
//!    silently re-enable the WebView2 mini-menu / SmartScreen components the
//!    default exists to disable.

/// The variable msedgedriver (and any other WebView2 automation host) uses to
/// pass browser switches to a WebView2 app.
const AUTOMATION_ARGS_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

/// wry 0.55.1's default `AdditionalBrowserArguments` string *for this app*.
///
/// Transcribed from `wry-0.55.1/src/webview2/mod.rs:294-321`, which composes:
///   - `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`
///     (unconditional — wry#535 / tauri#1345),
///   - ` --autoplay-policy=no-user-gesture-required` when `attributes.autoplay`
///     is true. It always is here: wry defaults `autoplay: true`
///     (wry/src/lib.rs:843) and tauri-runtime-wry 2.11.3 never calls
///     `with_autoplay`, so nothing in this app turns it off. The switch is also
///     present on the `msedgewebview2.exe` command line captured from CI,
///     confirming the composed value empirically.
///   - proxy switches when a proxy is configured. This app configures none (no
///     `proxyUrl` in any `tauri*.conf.json`, no `proxy_url` builder call), and
///     the captured command line carries no `--proxy-server`.
///
/// Keep in sync with wry on upgrade — `wry_default_args_match_upstream` below
/// pins the transcription, but only a read of the upgraded source can confirm
/// it is still right.
const WRY_DEFAULT_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// Compose the `additionalBrowserArgs` value for a webview, given whatever an
/// automation host injected via the environment.
///
/// `None` means "do not set `additionalBrowserArgs` at all", which is what
/// keeps wry on its own default path.
///
/// The injected switches are forwarded verbatim rather than filtered down to
/// `--remote-debugging-port`: msedgedriver's set (`--enable-automation`,
/// `--test-type=webdriver`, …) is what it expects the browser it drives to
/// have been started with, and hand-picking would silently diverge from
/// whatever driver version happens to be installed.
fn compose_browser_args(injected: Option<&str>) -> Option<String> {
    let injected = injected?.trim();
    if injected.is_empty() {
        return None;
    }
    Some(format!("{WRY_DEFAULT_BROWSER_ARGS} {injected}"))
}

/// `additionalBrowserArgs` to apply to every window this process creates, or
/// `None` when the app was not launched by a WebView2 automation host.
///
/// Every window must get the *same* value: wry builds one WebView2 environment
/// per webview, and the Runtime refuses to create a second environment with
/// different browser arguments against a user data folder already in use.
pub fn automation_browser_args() -> Option<String> {
    compose_browser_args(std::env::var(AUTOMATION_ARGS_ENV).ok().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_or_empty_injection_leaves_wry_defaults_alone() {
        // The production path: no automation host, so no `additionalBrowserArgs`
        // is set and wry composes its own default string.
        assert_eq!(compose_browser_args(None), None);
        assert_eq!(compose_browser_args(Some("")), None);
        assert_eq!(compose_browser_args(Some("   ")), None);
    }

    #[test]
    fn injected_switches_are_appended_to_wry_defaults() {
        let composed = compose_browser_args(Some(
            "--enable-automation --remote-debugging-port=0 --test-type=webdriver",
        ))
        .expect("injected switches must produce args");

        // The regression this module exists for: the driver's debugging port
        // has to survive into the value handed to WebView2.
        assert!(composed.contains("--remote-debugging-port=0"));
        assert!(composed.contains("--enable-automation"));
        assert!(composed.contains("--test-type=webdriver"));
    }

    #[test]
    fn wry_defaults_are_preserved_when_overriding() {
        let composed =
            compose_browser_args(Some("--remote-debugging-port=0")).expect("args expected");

        // Setting `additionalBrowserArgs` REPLACES wry's default string, so
        // losing these would silently re-enable the WebView2 mini-menu and
        // SmartScreen components in the automated build.
        assert!(composed.starts_with(WRY_DEFAULT_BROWSER_ARGS));
        assert!(composed.contains("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"));
        assert!(composed.contains("--autoplay-policy=no-user-gesture-required"));
    }

    #[test]
    fn wry_default_args_match_upstream() {
        // Pins the transcription of wry 0.55.1's default. A wry upgrade that
        // changes the default arg set must update this constant deliberately.
        assert_eq!(
            WRY_DEFAULT_BROWSER_ARGS,
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required"
        );
    }
}
