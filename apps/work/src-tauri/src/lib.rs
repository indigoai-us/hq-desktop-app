//! HQ Work mobile shell.
//!
//! Responsibilities, in full:
//!   1. host the shared Svelte build in a webview;
//!   2. tell that Svelte code which OS it is running on.
//!
//! Anything beyond those two things belongs in the shared source, not here.
//! Web, desktop and mobile render ONE Svelte app; divergence is a branch on
//! the platform value this shell reports, never a second implementation.

/// The OS string handed to the webview as `window.__HQ_HOST_OS__`.
///
/// Taken from Rust's compile-time target rather than probed at runtime, so it
/// cannot disagree with the binary that is actually executing. The values line
/// up with `resolveHostPlatform()` in `packages/platform/src/host-platform.ts`.
const fn host_os() -> &'static str {
    if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// Injected before any page script runs, so the very first render already knows
/// its platform and no component has to re-detect it later.
fn os_handshake_script() -> String {
    format!(
        "Object.defineProperty(window, '__HQ_HOST_OS__', {{ value: {}, writable: false, configurable: false }});",
        serde_json::Value::String(host_os().to_string())
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // `os` backs the platform fallback path; `notification` and `http` are
        // the only native capabilities the mobile capability table claims.
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        // Sign-in, and nothing else: `opener` hands the Cognito hosted UI to
        // the system browser, `deep-link` receives the hqmobile:// callback it
        // redirects to. The scheme itself is registered in the platform
        // manifests (Info.plist / AndroidManifest), which is where iOS and
        // Android read it from -- the plugin's own config covers desktop only.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let script = os_handshake_script();
            #[allow(unused_variables)]
            let handle = app.handle();
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("HQ Work")
            .initialization_script(&script)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running HQ Work");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_os_is_one_of_the_values_the_shared_resolver_understands() {
        // resolveHostPlatform() switches on exactly these strings; anything
        // else silently falls through to its "unknown native shell" branch.
        assert!(matches!(
            host_os(),
            "ios" | "android" | "macos" | "windows" | "linux"
        ));
    }

    #[test]
    fn handshake_script_defines_the_global_the_webview_reads() {
        let script = os_handshake_script();
        assert!(script.contains("__HQ_HOST_OS__"));
        assert!(script.contains(&format!("\"{}\"", host_os())));
        // Must be non-writable: a page script overwriting the platform would
        // hand the UI the wrong capability table.
        assert!(script.contains("writable: false"));
    }
}
