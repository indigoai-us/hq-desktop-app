//! WebView2 automation bridge (Windows only, `e2e-automation` feature only).
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
//! # Why the gate is a cargo feature and not the environment variable
//!
//! `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` is not a trustworthy signal. It is
//! an ordinary user environment variable: any code running as the user can
//! persist it into `HKCU\Environment` (`setx`) with no elevation, and every
//! later launch of the app inherits it. A forwarder gated only on the
//! variable being present would therefore hand any local process a way to make
//! the *shipped* app open a CDP listener on next start — and CDP inside this
//! app's webview reaches `window.__TAURI__.core.invoke`, i.e. the whole Rust
//! command surface (fs, secrets, sync), not merely the page. wry's
//! unconditional `put_AdditionalBrowserArguments` was accidentally protecting
//! against exactly that, so a forwarder must not remove the protection while
//! leaving the attack in place.
//!
//! The gate is therefore `--features e2e-automation`, which is **off by
//! default and never enabled for a shipped build**. In a default build the
//! variable is not read at all: `automation_browser_args` compiles down to a
//! constant `None` (see the `cfg(not(feature = "e2e-automation"))` definition
//! below), so nothing an attacker can set reaches the WebView2 environment.
//! `cfg!(debug_assertions)` would not have sufficed — the installer E2E job
//! drives a *release* build.
//!
//! # The cost of that choice, stated plainly
//!
//! Both Windows jobs in `.github/workflows/windows-check.yml` pass
//! `--features e2e-automation`, so the binary they drive is not the binary
//! users install: it differs by this one gate. The installer E2E job in
//! particular no longer exercises an artifact byte-identical to the shipped
//! one. It still proves the packaged/installed/real-Runtime path works, but a
//! regression living *inside* this feature gate is invisible to production,
//! and a packaging regression that only manifests with the feature off would
//! not be caught there. That is the smaller of the two available risks, not
//! the absence of risk.
//!
//! # The other rule that keeps this correct
//!
//! **wry's defaults are re-included.** Setting the property *replaces* wry's
//! default string rather than extending it, so dropping it would silently
//! re-enable the WebView2 mini-menu / SmartScreen components the default
//! exists to disable.

/// The variable msedgedriver (and any other WebView2 automation host) uses to
/// pass browser switches to a WebView2 app.
#[cfg_attr(not(feature = "e2e-automation"), allow(dead_code))]
const AUTOMATION_ARGS_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

/// wry's default `AdditionalBrowserArguments` string *for this app*.
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
#[cfg_attr(not(feature = "e2e-automation"), allow(dead_code))]
const WRY_DEFAULT_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// The wry version [`WRY_DEFAULT_BROWSER_ARGS`] was transcribed by reading.
///
/// Enforced against the version actually resolved in `Cargo.lock` by
/// `wry_default_args_match_the_reviewed_wry_version` below; `build.rs` parses
/// the lockfile and emits the answer as `RESOLVED_WRY_VERSIONS`.
#[cfg_attr(not(test), allow(dead_code))]
const TRANSCRIBED_FROM_WRY_VERSION: &str = "0.55.1";

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
#[cfg_attr(not(feature = "e2e-automation"), allow(dead_code))]
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
#[cfg(feature = "e2e-automation")]
pub fn automation_browser_args() -> Option<String> {
    compose_browser_args(std::env::var(AUTOMATION_ARGS_ENV).ok().as_deref())
}

/// Shipped definition: the automation environment variable is never read.
///
/// This is the entirety of the default-build behaviour. `AUTOMATION_ARGS_ENV`
/// is not referenced from any reachable path here, so a user-writable
/// `HKCU\Environment` entry cannot put `--remote-debugging-port` — or anything
/// else — into the app's WebView2 environment.
#[cfg(not(feature = "e2e-automation"))]
pub fn automation_browser_args() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_or_empty_injection_leaves_wry_defaults_alone() {
        // No automation host, so no `additionalBrowserArgs` is set and wry
        // composes its own default string.
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

    /// Upstream-drift detection for the transcription above.
    ///
    /// `WRY_DEFAULT_BROWSER_ARGS` duplicates a string that lives inside wry's
    /// private `create_environment`; wry exports nothing to compare it
    /// against, so no assertion can diff the two directly — and asserting the
    /// constant equals a hand-copied duplicate of itself would verify nothing
    /// whatsoever. What *can* be pinned is the input to the transcription:
    /// `build.rs` parses the resolved `Cargo.lock` and emits every locked
    /// `wry` version as `RESOLVED_WRY_VERSIONS`. A `cargo update` that moves
    /// wry — or a graph that resolves two wry versions — fails here and forces
    /// a deliberate re-read of the new `create_environment` before the
    /// constant is blessed for that version.
    #[test]
    fn wry_default_args_match_the_reviewed_wry_version() {
        assert_eq!(
            env!("RESOLVED_WRY_VERSIONS"),
            TRANSCRIBED_FROM_WRY_VERSION,
            "the resolved wry version no longer matches the one \
             WRY_DEFAULT_BROWSER_ARGS was transcribed from. Re-read \
             `create_environment` in the new wry (src/webview2/mod.rs, the \
             `put_AdditionalBrowserArguments` call), update \
             WRY_DEFAULT_BROWSER_ARGS to whatever it now composes for this \
             app's attributes, then update TRANSCRIBED_FROM_WRY_VERSION. An \
             empty left-hand side means build.rs found no `wry` package in \
             Cargo.lock at all; a comma-separated one means the graph resolved \
             more than one wry."
        );
    }

    /// The shipped configuration must have no runtime switch at all.
    ///
    /// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` is user-writable and persistent
    /// (`setx` / `HKCU\Environment`), so a default build that honoured it
    /// would let any local process turn the next launch of the installed app
    /// into a CDP listener with reach into `window.__TAURI__.core.invoke`.
    #[test]
    #[cfg(not(feature = "e2e-automation"))]
    fn default_build_ignores_the_automation_env_var() {
        std::env::set_var(AUTOMATION_ARGS_ENV, "--remote-debugging-port=9222");
        let args = automation_browser_args();
        std::env::remove_var(AUTOMATION_ARGS_ENV);

        assert_eq!(
            args, None,
            "a build without --features e2e-automation must never forward \
             WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS into the app's webviews"
        );
    }

    /// Mirror of the test above: with the feature compiled in the variable is
    /// honoured, otherwise the CI jobs that pass `--features e2e-automation`
    /// would be driving an app that silently ignores msedgedriver.
    #[test]
    #[cfg(feature = "e2e-automation")]
    fn automation_build_forwards_the_env_var() {
        std::env::set_var(AUTOMATION_ARGS_ENV, "--remote-debugging-port=9222");
        let args = automation_browser_args();
        std::env::remove_var(AUTOMATION_ARGS_ENV);

        let args = args.expect("the e2e-automation build must forward injected switches");
        assert!(args.starts_with(WRY_DEFAULT_BROWSER_ARGS));
        assert!(args.contains("--remote-debugging-port=9222"));
    }
}
