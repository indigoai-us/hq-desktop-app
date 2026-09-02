//! Keep the webview on the packaged UI. http(s)/mailto handoffs go to the OS
//! browser; every other scheme is dropped so a message link cannot navigate
//! the shell or launch a local app.

use tauri::{AppHandle, Manager, Runtime, Url};
use tauri_plugin_shell::ShellExt;

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "tauri.localhost")
        || host.ends_with(".localhost")
}

/// In-webview navigation that must keep loading (app protocol + local dev).
pub fn is_app_navigation(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" | "ipc" | "blob" | "data" | "about" | "hq-recovery" => true,
        "http" | "https" => url.host_str().is_some_and(is_loopback_host),
        _ => false,
    }
}

/// Credential-free http(s)/mailto — the only schemes we hand to the OS opener.
pub fn is_browser_url(url: &Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    matches!(url.scheme(), "http" | "https" | "mailto")
}

#[allow(deprecated)]
fn open_browser<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    let _ = app.shell().open(url.as_str(), None);
}

/// Open in the default browser when the URL is an allowed external scheme.
pub fn open_if_browser_url<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    if is_browser_url(url) {
        open_browser(app, url);
    }
}

/// Plugin / builder navigation hook: stay in-app for local loads, otherwise
/// open an allowed URL externally and cancel the webview navigation.
pub fn allow_navigation<R: Runtime>(app: &AppHandle<R>, url: &Url) -> bool {
    if is_app_navigation(url) {
        return true;
    }
    if is_browser_url(url) {
        open_browser(app, url);
    }
    false
}

/// Deny `window.open` / `target=_blank` webviews; route allowed URLs out.
pub fn deny_webview_new_windows<'a, R: Runtime, M: Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
    app: &AppHandle<R>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    let app = app.clone();
    builder.on_new_window(move |url, _features| {
        open_if_browser_url(&app, &url);
        tauri::webview::NewWindowResponse::Deny
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Url {
        Url::parse(raw).expect(raw)
    }

    #[test]
    fn app_navigation_allows_local_and_custom_protocols() {
        assert!(is_app_navigation(&parse(
            "http://localhost:1421/desktop-alt.html"
        )));
        assert!(is_app_navigation(&parse(
            "https://tauri.localhost/index.html"
        )));
        assert!(is_app_navigation(&parse("tauri://localhost/index.html")));
        assert!(is_app_navigation(&parse("hq-recovery://localhost/index.html")));
        assert!(is_app_navigation(&parse("about:blank")));
        assert!(!is_app_navigation(&parse("https://example.com/docs")));
        assert!(!is_app_navigation(&parse("mailto:ada@example.com")));
    }

    #[test]
    fn browser_url_allows_http_https_mailto_only() {
        assert!(is_browser_url(&parse("https://example.com/docs")));
        assert!(is_browser_url(&parse("http://example.com")));
        assert!(is_browser_url(&parse("mailto:ada@example.com")));
        assert!(!is_browser_url(&parse("javascript:alert(1)")));
        assert!(!is_browser_url(&parse("file:///etc/passwd")));
        assert!(!is_browser_url(&parse("tel:+15555550100")));
        assert!(!is_browser_url(&parse("https://user:pass@example.com")));
    }
}
