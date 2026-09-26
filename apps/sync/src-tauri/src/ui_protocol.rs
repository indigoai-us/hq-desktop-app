//! Runtime UI protocol: serves the Svelte frontend from a directory next to
//! the binary instead of baking it into `generate_context!()`. This is the
//! prebuilt-shell pipeline's core mechanism — the compiled shell binary is
//! reused across releases, and only `Resources/ui/` changes per release. See
//! `docs/RELEASE.md`.
//!
//! Dev: serves from `<CARGO_MANIFEST_DIR>/../dist` (the Vite build output).
//! Prod (macOS): serves from `<bundle>/Contents/Resources/ui/`.
//! Prod (other platforms): serves from `<exe_dir>/ui/` (mirrors
//! `hq_desktop_core::runtime_version::resources_dir_from_current_exe`).
//!
//! The window loads this origin instead of the built-in `tauri://localhost`
//! asset protocol, so replacing only `Resources/ui/` on disk changes what the
//! app shows without recompiling or re-signing the Rust binary.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use tauri::http::{Response, StatusCode};
use url::Url;

pub const SCHEME: &str = "hq-ui";

/// Same CSP the app has always shipped (see `tauri.conf.json`
/// `app.security.csp`) — kept identical so this protocol is not a policy
/// downgrade from the asset protocol it replaces.
const CSP: &str = "img-src 'self' data: asset: blob: https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com";

/// Resolve the root directory this protocol serves files from.
///
/// `None` means "no UI directory is present" (e.g. a shell binary run
/// standalone with no `Resources/ui` assembled yet) — callers must treat
/// that as every request 404ing rather than panicking.
pub fn ui_root_dir() -> Option<PathBuf> {
    // A verified UI hot bundle (outside the signed bundle, in the app data
    // dir) wins over `Resources/ui` when its gates pass; the choice is cached
    // per page load. See `ui_hot_update`.
    if crate::ui_hot_update::hot_root().is_some() {
        return crate::ui_hot_update::served_root();
    }
    builtin_ui_root_dir()
}

/// `Resources/ui` (or the dev `../dist`), ignoring hot bundles.
pub fn builtin_ui_root_dir() -> Option<PathBuf> {
    // An assembled `Resources/ui` always wins, including in debug builds, so
    // a locally built bundle serves exactly what was assembled into it (this
    // is what lets a UI-only change be dropped into a bundle without a Rust
    // rebuild). The dev `../dist` is only a fallback for `tauri dev` / bare
    // `cargo run`, where no bundle exists.
    if let Some(resources) = hq_desktop_core::runtime_version::resources_dir_from_current_exe() {
        let ui_dir = resources.join("ui");
        if ui_dir.is_dir() {
            return ui_dir.canonicalize().ok();
        }
    }
    #[cfg(debug_assertions)]
    {
        let dev_dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist");
        if dev_dist.is_dir() {
            return dev_dist.canonicalize().ok();
        }
    }
    None
}

/// Log, once per process, which directory the UI is served from (or that
/// none was found). Makes "which UI is this bundle running?" answerable from
/// the app log without attaching a debugger.
fn log_ui_root_once(root: Option<&Path>) {
    static LOGGED: std::sync::Once = std::sync::Once::new();
    LOGGED.call_once(|| match root {
        Some(dir) => eprintln!("[hq-ui] serving UI from {}", dir.display()),
        None => eprintln!("[hq-ui] no UI directory found (no Resources/ui and no dev dist); every request will 404"),
    });
}

/// Build the `WebviewUrl` a window should load for a given entry file
/// (e.g. `"index.html"`, `"desktop-alt.html"`). Windows/Android use the
/// `http://<scheme>.localhost/` form WebView2 requires for custom protocols;
/// everywhere else uses the `<scheme>://localhost/` form, mirroring
/// `recovery::recovery_url`.
pub fn ui_url(entry: &str) -> tauri::WebviewUrl {
    #[cfg(any(target_os = "windows", target_os = "android"))]
    {
        tauri::WebviewUrl::CustomProtocol(
            Url::parse(&format!("http://{SCHEME}.localhost/{entry}")).expect("ui url"),
        )
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        tauri::WebviewUrl::CustomProtocol(
            Url::parse(&format!("{SCHEME}://localhost/{entry}")).expect("ui url"),
        )
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "map" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Resolve a request path against `root`, guarding against traversal outside
/// it. Returns `None` if the request escapes `root` (e.g. `../../etc/passwd`)
/// or the resolved file does not exist. A path with no extension and no
/// existing file falls back to `index.html` for SPA client-side routing.
pub fn resolve_request_path(root: &Path, request_path: &str) -> Option<PathBuf> {
    // Canonicalize the root itself first — on macOS `std::env::temp_dir()`
    // (and some real deployment paths) resolve through a symlink, so
    // comparing an un-resolved root against a resolved candidate would
    // reject every legitimate request.
    let root = &root.canonicalize().ok()?;
    let trimmed = request_path.trim_start_matches('/');
    let relative = if trimmed.is_empty() {
        "index.html"
    } else {
        trimmed
    };

    let candidate = root.join(relative);
    if let Some(resolved) = canonical_within(root, &candidate) {
        return Some(resolved);
    }

    // SPA fallback: an extensionless path with no matching file (a client
    // route like `/settings`) resolves to the app shell.
    if Path::new(relative).extension().is_none() {
        let index = root.join("index.html");
        return canonical_within(root, &index);
    }

    None
}

fn canonical_within(root: &Path, candidate: &Path) -> Option<PathBuf> {
    let resolved = candidate.canonicalize().ok()?;
    if resolved.is_file() && resolved.starts_with(root) {
        Some(resolved)
    } else {
        None
    }
}

fn not_found() -> Response<Cow<'static, [u8]>> {
    empty_response(StatusCode::NOT_FOUND)
}

fn empty_response(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .body(Cow::Borrowed(&[] as &[u8]))
        .expect("empty ui response body")
}

/// Status for a request that resolved to no file. WebView2 requests
/// `/favicon.ico` on its own; the UI bundle ships none, and a 404 there is
/// logged as a console error (which the Windows pre-auth smoke rejects). The
/// Tauri asset protocol this replaces never 404'd it, so answer 204 instead.
/// Every other missing file stays a 404.
pub fn missing_file_status(request_path: &str) -> StatusCode {
    if request_path == "/favicon.ico" {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

pub fn register_protocol(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_uri_scheme_protocol(SCHEME, |ctx, request| {
        crate::ui_hot_update::init(ctx.app_handle());
        let root = ui_root_dir();
        log_ui_root_once(root.as_deref());
        let Some(root) = root else {
            return not_found();
        };
        let path = request.uri().path();
        let Some(resolved) = resolve_request_path(&root, path) else {
            return empty_response(missing_file_status(path));
        };
        if resolved.extension().is_some_and(|e| e == "html") {
            crate::ui_hot_update::note_document(path);
        }
        if std::env::var_os("HQ_UI_TRACE").is_some() {
            eprintln!("[hq-ui] {path} -> {}", resolved.display());
        }
        let bytes = match std::fs::read(&resolved) {
            Ok(bytes) => bytes,
            Err(err) => {
                eprintln!("[hq-ui] failed to read {}: {err}", resolved.display());
                return not_found();
            }
        };
        Response::builder()
            .header("Content-Type", mime_for(&resolved))
            .header("Content-Security-Policy", CSP)
            .header("Cache-Control", "no-store")
            .body(Cow::Owned(bytes))
            .unwrap_or_else(|_| {
                Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .body(Cow::Borrowed(&[] as &[u8]))
                    .expect("empty ui error body")
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hq-ui-protocol-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn mime_types_cover_common_assets() {
        assert_eq!(mime_for(Path::new("a/index.html")), "text/html; charset=utf-8");
        assert_eq!(mime_for(Path::new("a/app.js")), "text/javascript; charset=utf-8");
        assert_eq!(mime_for(Path::new("a/app.css")), "text/css; charset=utf-8");
        assert_eq!(mime_for(Path::new("a/data.json")), "application/json");
        assert_eq!(mime_for(Path::new("a/icon.svg")), "image/svg+xml");
        assert_eq!(mime_for(Path::new("a/font.woff2")), "font/woff2");
        assert_eq!(mime_for(Path::new("a/blob.bin")), "application/octet-stream");
    }

    #[test]
    fn resolves_root_to_index_html() {
        let root = temp_root("root-index");
        fs::write(root.join("index.html"), b"<html>shell</html>").unwrap();
        let resolved = resolve_request_path(&root, "/").expect("resolves");
        assert_eq!(resolved.file_name().unwrap(), "index.html");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolves_existing_asset() {
        let root = temp_root("existing-asset");
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(root.join("assets/app.js"), b"console.log(1)").unwrap();
        let resolved = resolve_request_path(&root, "/assets/app.js").expect("resolves");
        assert_eq!(resolved.file_name().unwrap(), "app.js");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn spa_fallback_serves_index_for_client_route() {
        let root = temp_root("spa-fallback");
        fs::write(root.join("index.html"), b"<html>shell</html>").unwrap();
        let resolved = resolve_request_path(&root, "/settings/profile").expect("resolves");
        assert_eq!(resolved.file_name().unwrap(), "index.html");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_favicon_is_no_content_but_other_missing_files_are_not_found() {
        assert_eq!(missing_file_status("/favicon.ico"), StatusCode::NO_CONTENT);
        assert_eq!(missing_file_status("/assets/missing.js"), StatusCode::NOT_FOUND);
        assert_eq!(missing_file_status("/nested/favicon.ico"), StatusCode::NOT_FOUND);
    }

    #[test]
    fn missing_asset_with_extension_is_not_found() {
        let root = temp_root("missing-asset");
        fs::write(root.join("index.html"), b"<html>shell</html>").unwrap();
        assert!(resolve_request_path(&root, "/assets/missing.js").is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn path_traversal_outside_root_is_rejected() {
        let root = temp_root("traversal-root");
        let outside = temp_root("traversal-outside");
        fs::write(root.join("index.html"), b"<html>shell</html>").unwrap();
        fs::write(outside.join("secret.txt"), b"nope").unwrap();

        // Craft a request path that, joined naively, would climb out of root.
        let escaping = format!(
            "../{}/secret.txt",
            outside.file_name().unwrap().to_str().unwrap()
        );
        assert!(resolve_request_path(&root, &escaping).is_none());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn ui_root_dir_returns_none_when_absent() {
        // In this test process there is no assembled Resources/ui and (in
        // release-mode test runs) no dev ../dist either, so the resolver must
        // degrade to None rather than panicking.
        let _ = ui_root_dir();
    }
}
