//! Rendered page snapshot for one deployed app (Deployments side panel).
//!
//! When a row is selected the page asks for a snapshot. The desktop loads the
//! deployed URL in a hidden window, waits for the page to finish loading plus a
//! short settle, captures it at a fixed 1280x800 desktop viewport, and stores
//! the PNG under `<app data>/deploy-snapshots/`. Entries are keyed by app id and
//! deploy time, so a redeploy takes a new snapshot; the cache is also capped by
//! size and evicts the least recently used files first.
//!
//! The hidden window is locked down: it uses a private (incognito) data store,
//! so it carries no cookies and no HQ session; devtools are off; it may not
//! open new windows; it only navigates to https pages; no capability names its
//! label, so the page has no access to app commands. It is closed after every
//! capture, success or failure.
//!
//! Protected apps (password, company, invited-only) are captured through a
//! preview session from hq-deploy (see `deploy_preview_pass.rs`). WKWebView
//! cannot add headers to sub-resource loads, so the hidden window loads
//! `hqpreview://<host>/<path>` instead of the https URL. The `hqpreview` scheme
//! handler fetches each request from `https://<host>/<path>` and adds the
//! session header. Relative and root-relative URLs resolve against the scheme,
//! so the page, its css, js and images all go through the handler. The handler
//! serves only hosts with a live session, only GET/HEAD, never follows
//! redirects, and drops `Set-Cookie`. The session is removed after the
//! capture.
//!
//! Only macOS can capture today (WKWebView `takeSnapshot`). Other platforms
//! return an error and the panel falls back to the page's og:image.
//!
//! This file has no `crate::` imports so the capture test in
//! `tests/deploy_snapshot_capture.rs` can include it directly.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};

use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};

/// Desktop viewport the page lays out at, in CSS pixels.
pub const VIEW_WIDTH: u32 = 1280;
pub const VIEW_HEIGHT: u32 = 800;
/// Total time allowed for load + settle + capture before the panel falls back.
pub const CAPTURE_TIMEOUT: Duration = Duration::from_secs(8);
/// Wait after the load event so fonts, images and first animations paint.
pub const SETTLE: Duration = Duration::from_millis(700);
/// Size cap for the snapshot cache; least recently used files go first.
pub const CACHE_CAP_BYTES: u64 = 40 * 1024 * 1024;

static NEXT_LABEL: AtomicU64 = AtomicU64::new(0);

/// Label prefix of the hidden snapshot windows. The app-wide external-links
/// hook skips these so a capture load is not handed to the system browser;
/// the window's own `on_navigation` below is the gate for them.
pub const SNAPSHOT_LABEL_PREFIX: &str = "deploy-snapshot-";

/// Custom scheme the hidden window uses for protected pages.
pub const PREVIEW_SCHEME: &str = "hqpreview";
/// Request header hq-deploy's gate accepts in place of the access cookie.
pub const PREVIEW_SESSION_HEADER: &str = "x-hq-preview-session";
/// The server session lives 60 s; stop using it a little earlier.
pub const PREVIEW_SESSION_TTL: Duration = Duration::from_secs(55);

struct PreviewSession {
    token: String,
    expires: Instant,
}

static PREVIEW_SESSIONS: LazyLock<Mutex<HashMap<String, PreviewSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static PREVIEW_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(CAPTURE_TIMEOUT)
        .build()
        .unwrap_or_else(|err| {
            eprintln!("[deploy-snapshot] preview client fallback: {err}");
            reqwest::Client::new()
        })
});

/// Make `host` servable through the preview scheme for `ttl`.
pub fn register_preview_session(host: &str, token: String, ttl: Duration) {
    if let Ok(mut map) = PREVIEW_SESSIONS.lock() {
        map.insert(
            host.to_ascii_lowercase(),
            PreviewSession {
                token,
                expires: Instant::now() + ttl,
            },
        );
    }
}

pub fn clear_preview_session(host: &str) {
    if let Ok(mut map) = PREVIEW_SESSIONS.lock() {
        map.remove(&host.to_ascii_lowercase());
    }
}

fn preview_session_for(host: &str) -> Option<String> {
    let mut map = PREVIEW_SESSIONS.lock().ok()?;
    let key = host.to_ascii_lowercase();
    match map.get(&key) {
        Some(s) if s.expires > Instant::now() => Some(s.token.clone()),
        Some(_) => {
            map.remove(&key);
            None
        }
        None => None,
    }
}

/// `https://host/path?q` → `hqpreview://host/path?q`.
pub fn preview_page_url(page: &url::Url) -> Option<url::Url> {
    let host = page.host_str()?;
    let mut out = url::Url::parse(&format!("{PREVIEW_SCHEME}://{host}/")).ok()?;
    out.set_path(page.path());
    out.set_query(page.query());
    Some(out)
}

/// `hqpreview://host/path?q` → `https://host/path?q`. Anything else is None.
pub fn upstream_url(uri: &str) -> Option<url::Url> {
    let parsed = url::Url::parse(uri).ok()?;
    if parsed.scheme() != PREVIEW_SCHEME
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    let host = parsed.host_str()?;
    let mut out = url::Url::parse(&format!("https://{host}/")).ok()?;
    out.set_path(parsed.path());
    out.set_query(parsed.query());
    Some(out)
}

fn preview_response(status: u16, body: &[u8]) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("cache-control", "no-store")
        .body(body.to_vec())
        .unwrap_or_default()
}

/// Build the upstream request for one preview-scheme request, or the error
/// response to return instead.
pub fn preview_upstream_request(
    client: &reqwest::Client,
    method: &tauri::http::Method,
    uri: &str,
) -> Result<reqwest::Request, tauri::http::Response<Vec<u8>>> {
    if method != tauri::http::Method::GET && method != tauri::http::Method::HEAD {
        return Err(preview_response(405, b"method not allowed"));
    }
    let Some(target) = upstream_url(uri) else {
        return Err(preview_response(404, b"not found"));
    };
    let Some(token) = target.host_str().and_then(preview_session_for) else {
        return Err(preview_response(404, b"not found"));
    };
    let verb = if method == tauri::http::Method::HEAD {
        reqwest::Method::HEAD
    } else {
        reqwest::Method::GET
    };
    client
        .request(verb, target)
        .header(PREVIEW_SESSION_HEADER, token)
        .build()
        .map_err(|_| preview_response(502, b"bad gateway"))
}

/// Handler for the `hqpreview` scheme. Redirects are not followed: a redirect
/// here means the gate refused the session, and following it would render the
/// sign-in page. `Set-Cookie` from the site is dropped.
pub async fn proxy_preview_request(
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let client = &*PREVIEW_CLIENT;
    let upstream =
        match preview_upstream_request(client, request.method(), &request.uri().to_string()) {
            Ok(req) => req,
            Err(resp) => return resp,
        };
    let res = match client.execute(upstream).await {
        Ok(res) => res,
        Err(err) => {
            eprintln!(
                "[deploy-snapshot] preview fetch failed: {}",
                err.without_url()
            );
            return preview_response(502, b"bad gateway");
        }
    };
    let status = res.status().as_u16();
    if res.status().is_redirection() {
        return preview_response(502, b"preview refused");
    }
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = match res.bytes().await {
        Ok(b) => b.to_vec(),
        Err(_) => return preview_response(502, b"bad gateway"),
    };
    let mut builder = tauri::http::Response::builder()
        .status(status)
        .header("cache-control", "no-store");
    if let Some(ct) = content_type {
        builder = builder.header("content-type", ct);
    }
    builder.body(body).unwrap_or_default()
}

/// Check that the page itself opens with the session before loading the
/// hidden window, so a refused session falls back instead of capturing an
/// error page.
pub async fn probe_preview_page(page: &url::Url) -> Result<(), String> {
    let uri = preview_page_url(page)
        .ok_or("snapshot: unreadable url")?
        .to_string();
    let req = preview_upstream_request(&PREVIEW_CLIENT, &tauri::http::Method::GET, &uri)
        .map_err(|_| "snapshot: preview session missing".to_string())?;
    let res = PREVIEW_CLIENT
        .execute(req)
        .await
        .map_err(|e| format!("snapshot: preview probe failed: {}", e.without_url()))?;
    if !res.status().is_success() {
        return Err(format!(
            "snapshot: preview refused ({})",
            res.status().as_u16()
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploySnapshot {
    /// PNG as a `data:image/png;base64,` URL.
    pub snapshot: String,
    pub width: u32,
    pub height: u32,
}

/// Cache file names: `<app hash>-<deploy hash>.png`. The app hash lets a new
/// deploy find and remove the app's older snapshots.
pub fn snapshot_stem(app_id: &str, deployed_at: &str) -> (String, String) {
    let app = hex16(app_id);
    (app.clone(), format!("{app}-{}", hex16(deployed_at)))
}

fn hex16(value: &str) -> String {
    let digest = Sha256::digest(format!("snapshot:{value}").as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Only https pages are rendered.
pub fn validate_snapshot_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|_| "snapshot: unreadable url".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err("snapshot: only https pages are rendered".to_string());
    }
    Ok(parsed)
}

/// Width and height from a PNG header, or None when the bytes are not a PNG.
pub fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.len() < 24 || bytes[..8] != SIG || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((w, h))
}

fn to_snapshot(png: &[u8]) -> Result<DeploySnapshot, String> {
    let (width, height) = png_dimensions(png).ok_or("snapshot: not a png")?;
    Ok(DeploySnapshot {
        snapshot: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        ),
        width,
        height,
    })
}

/// Read a cached snapshot and mark it recently used.
pub fn read_snapshot(dir: &Path, stem: &str) -> Option<Vec<u8>> {
    let path = dir.join(format!("{stem}.png"));
    let bytes = std::fs::read(&path).ok()?;
    if png_dimensions(&bytes).is_none() {
        eprintln!("[deploy-snapshot] dropping unreadable cache entry");
        if let Err(err) = std::fs::remove_file(&path) {
            eprintln!("[deploy-snapshot] unreadable entry not removed: {err}");
        }
        return None;
    }
    if let Err(err) = std::fs::File::options()
        .write(true)
        .open(&path)
        .and_then(|f| f.set_modified(SystemTime::now()))
    {
        eprintln!("[deploy-snapshot] recency not updated: {err}");
    }
    Some(bytes)
}

/// Store a snapshot, remove the app's snapshots for older deploys, then evict
/// least recently used files until the cache is within `cap_bytes`.
pub fn write_snapshot(
    dir: &Path,
    app_hash: &str,
    stem: &str,
    png: &[u8],
    cap_bytes: u64,
) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("snapshot cache dir: {e}"))?;
    let name = format!("{stem}.png");
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir)
        .map_err(|e| format!("snapshot cache read: {e}"))?
        .flatten()
    {
        let file = entry.file_name().to_string_lossy().to_string();
        if !file.ends_with(".png") || file == name {
            continue;
        }
        if file.starts_with(&format!("{app_hash}-")) {
            if let Err(err) = std::fs::remove_file(entry.path()) {
                eprintln!("[deploy-snapshot] stale entry not removed: {err}");
            }
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            let used = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            files.push((used, meta.len(), entry.path()));
        }
    }
    std::fs::write(dir.join(&name), png).map_err(|e| format!("snapshot cache write: {e}"))?;
    let mut total: u64 = png.len() as u64 + files.iter().map(|f| f.1).sum::<u64>();
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= cap_bytes {
            break;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => total = total.saturating_sub(len),
            Err(err) => eprintln!("[deploy-snapshot] evict failed: {err}"),
        }
    }
    Ok(())
}

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("deploy-snapshots"))
        .map_err(|e| format!("snapshot cache dir: {e}"))
}

/// Load `url` in a hidden, locked-down window and return a PNG of the first
/// 1280x800 CSS pixels, rendered at 2x (2560x1600). The window is closed on
/// every path. `allow_http_loopback` exists for the local fixture test only.
pub async fn capture_page<R: Runtime>(
    app: &AppHandle<R>,
    url: url::Url,
    timeout: Duration,
    allow_http_loopback: bool,
) -> Result<Vec<u8>, String> {
    let label = format!(
        "{SNAPSHOT_LABEL_PREFIX}{}",
        NEXT_LABEL.fetch_add(1, Ordering::Relaxed)
    );
    let window = open_hidden(app, &label, url, allow_http_loopback)?;
    let result = tokio::time::timeout(timeout, wait_and_capture(&window)).await;
    if let Err(err) = window.destroy() {
        eprintln!("[deploy-snapshot] hidden window not destroyed: {err}");
    }
    match result {
        Ok(inner) => inner,
        Err(_) => Err("snapshot: timed out".to_string()),
    }
}

struct Hidden<R: Runtime> {
    window: tauri::WebviewWindow<R>,
    loaded: tokio::sync::watch::Receiver<bool>,
}

impl<R: Runtime> Hidden<R> {
    fn destroy(&self) -> tauri::Result<()> {
        self.window.destroy()
    }
}

fn open_hidden<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    url: url::Url,
    allow_http_loopback: bool,
) -> Result<Hidden<R>, String> {
    let (tx, loaded) = tokio::sync::watch::channel(false);
    let window = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::External(url))
        .title("")
        .inner_size(VIEW_WIDTH as f64, VIEW_HEIGHT as f64)
        .resizable(false)
        .decorations(false)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .devtools(false)
        .incognito(true)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_navigation(move |next| {
            next.scheme() == "https"
                || next.scheme() == PREVIEW_SCHEME
                || (allow_http_loopback
                    && next.scheme() == "http"
                    && next.host_str() == Some("127.0.0.1"))
        })
        .on_page_load(move |_, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                tx.send_replace(true);
            }
        })
        .build()
        .map_err(|e| format!("snapshot window: {e}"))?;
    Ok(Hidden { window, loaded })
}

async fn wait_and_capture<R: Runtime>(hidden: &Hidden<R>) -> Result<Vec<u8>, String> {
    let mut loaded = hidden.loaded.clone();
    loaded
        .wait_for(|done| *done)
        .await
        .map_err(|_| "snapshot: window closed before load".to_string())?;
    tokio::time::sleep(SETTLE).await;
    snapshot_webview(&hidden.window).await
}

#[cfg(target_os = "macos")]
async fn snapshot_webview<R: Runtime>(window: &tauri::WebviewWindow<R>) -> Result<Vec<u8>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    window
        .with_webview(move |platform| {
            // Runs on the main thread, where WebKit and AppKit calls belong.
            // SAFETY: on macOS `inner()` is the live WKWebView backing this window.
            let webview: &objc2_web_kit::WKWebView =
                unsafe { &*(platform.inner() as *const objc2_web_kit::WKWebView) };
            macos::snapshot(webview, tx);
        })
        .map_err(|e| format!("snapshot webview: {e}"))?;
    rx.await
        .map_err(|_| "snapshot: capture dropped".to_string())?
}

#[cfg(not(target_os = "macos"))]
async fn snapshot_webview<R: Runtime>(_: &tauri::WebviewWindow<R>) -> Result<Vec<u8>, String> {
    Err("snapshot: not supported on this platform".to_string())
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext, NSImage,
    };
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    use super::{VIEW_HEIGHT, VIEW_WIDTH};

    type Reply = tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>;

    pub(super) fn snapshot(webview: &WKWebView, reply: Reply) {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = reply.send(Err("snapshot: not on main thread".to_string()));
            return;
        };
        let reply = Mutex::new(Some(reply));
        let done = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
            let result = if image.is_null() {
                Err("snapshot: webkit returned no image".to_string())
            } else {
                // SAFETY: WebKit hands us a valid NSImage for the block's duration.
                encode_png(unsafe { &*image })
            };
            if let Some(tx) = reply.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(result);
            }
        });
        unsafe {
            let config = WKSnapshotConfiguration::new(mtm);
            config.setRect(CGRect::new(
                CGPoint::new(0.0, 0.0),
                CGSize::new(VIEW_WIDTH as f64, VIEW_HEIGHT as f64),
            ));
            config.setSnapshotWidth(Some(&NSNumber::new_f64(VIEW_WIDTH as f64)));
            config.setAfterScreenUpdates(true);
            webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &done);
        }
    }

    /// Draw the snapshot into a fixed 2x bitmap so the output size does not
    /// depend on the display the hidden window was created on.
    fn encode_png(image: &NSImage) -> Result<Vec<u8>, String> {
        let (w, h) = ((VIEW_WIDTH * 2) as isize, (VIEW_HEIGHT * 2) as isize);
        let rep: Retained<NSBitmapImageRep> = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(),
                std::ptr::null_mut(),
                w,
                h,
                8,
                4,
                true,
                false,
                NSDeviceRGBColorSpace,
                0,
                0,
            )
        }
        .ok_or("snapshot: bitmap alloc failed")?;
        let ctx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)
            .ok_or("snapshot: no graphics context")?;
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&ctx));
        image.drawInRect(CGRect::new(
            CGPoint::new(0.0, 0.0),
            CGSize::new(w as f64, h as f64),
        ));
        ctx.flushGraphics();
        NSGraphicsContext::restoreGraphicsState_class();
        let data = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
        }
        .ok_or("snapshot: png encode failed")?;
        Ok(data.to_vec())
    }
}

/// A stored snapshot for this deploy, if any.
pub fn cached_snapshot(dir: &Path, app_id: &str, deployed_at: &str) -> Option<DeploySnapshot> {
    let (_, stem) = snapshot_stem(app_id, deployed_at);
    read_snapshot(dir, &stem).and_then(|png| to_snapshot(&png).ok())
}

/// Read (or render and store) the snapshot for one deployed app. With a
/// `preview_session` the page is loaded through the preview scheme.
pub async fn load_snapshot<R: Runtime>(
    app: &AppHandle<R>,
    dir: &Path,
    app_id: &str,
    page_url: &str,
    deployed_at: &str,
    refresh: bool,
    preview_session: Option<String>,
) -> Result<DeploySnapshot, String> {
    let page = validate_snapshot_url(page_url)?;
    let (app_hash, stem) = snapshot_stem(app_id, deployed_at);
    if !refresh {
        if let Some(hit) = read_snapshot(dir, &stem) {
            return to_snapshot(&hit);
        }
    }
    let png = match preview_session {
        None => capture_page(app, page, CAPTURE_TIMEOUT, false).await?,
        Some(token) => {
            let host = page
                .host_str()
                .ok_or("snapshot: unreadable url")?
                .to_string();
            register_preview_session(&host, token, PREVIEW_SESSION_TTL);
            let result = async {
                probe_preview_page(&page).await?;
                let target = preview_page_url(&page).ok_or("snapshot: unreadable url")?;
                capture_page(app, target, CAPTURE_TIMEOUT, false).await
            }
            .await;
            clear_preview_session(&host);
            result?
        }
    };
    let snapshot = to_snapshot(&png)?;
    if let Err(err) = write_snapshot(dir, &app_hash, &stem, &png, CACHE_CAP_BYTES) {
        eprintln!("[deploy-snapshot] {err}");
    }
    Ok(snapshot)
}

pub fn cache_dir_for<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    cache_dir(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32, pad: usize) -> Vec<u8> {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend(std::iter::repeat_n(0, pad));
        b
    }

    #[test]
    fn preview_scheme_maps_to_the_same_https_path() {
        let page = url::Url::parse("https://secret.indigo-hq.com/docs/a?x=1").unwrap();
        let mapped = preview_page_url(&page).unwrap();
        assert_eq!(
            mapped.as_str(),
            "hqpreview://secret.indigo-hq.com/docs/a?x=1"
        );
        assert_eq!(upstream_url(mapped.as_str()).unwrap(), page);
        // Root-relative assets keep the host.
        assert_eq!(
            upstream_url("hqpreview://secret.indigo-hq.com/assets/app.js")
                .unwrap()
                .as_str(),
            "https://secret.indigo-hq.com/assets/app.js"
        );
        assert!(upstream_url("https://secret.indigo-hq.com/").is_none());
        assert!(upstream_url("hqpreview://secret.indigo-hq.com:8443/").is_none());
        assert!(upstream_url("hqpreview://user@secret.indigo-hq.com/").is_none());
    }

    #[test]
    fn preview_requests_need_a_live_session_and_get_the_header() {
        let client = reqwest::Client::new();
        let get = tauri::http::Method::GET;
        let host = "only-this.indigo-hq.com";
        let uri = format!("hqpreview://{host}/assets/a.css");
        assert_eq!(
            preview_upstream_request(&client, &get, &uri)
                .unwrap_err()
                .status(),
            404
        );

        register_preview_session(host, "sess-1".into(), Duration::from_secs(30));
        let req = preview_upstream_request(&client, &get, &uri).unwrap();
        assert_eq!(req.url().as_str(), format!("https://{host}/assets/a.css"));
        assert_eq!(req.headers().get(PREVIEW_SESSION_HEADER).unwrap(), "sess-1");
        // Another host gets nothing.
        let other = "hqpreview://other.indigo-hq.com/";
        assert_eq!(
            preview_upstream_request(&client, &get, other)
                .unwrap_err()
                .status(),
            404
        );
        // Only GET and HEAD.
        let post = tauri::http::Method::POST;
        assert_eq!(
            preview_upstream_request(&client, &post, &uri)
                .unwrap_err()
                .status(),
            405
        );

        clear_preview_session(host);
        assert_eq!(
            preview_upstream_request(&client, &get, &uri)
                .unwrap_err()
                .status(),
            404
        );
    }

    #[test]
    fn expired_preview_sessions_are_not_used() {
        let client = reqwest::Client::new();
        let host = "expired.indigo-hq.com";
        register_preview_session(host, "old".into(), Duration::from_millis(0));
        std::thread::sleep(Duration::from_millis(5));
        let uri = format!("hqpreview://{host}/");
        assert_eq!(
            preview_upstream_request(&client, &tauri::http::Method::GET, &uri)
                .unwrap_err()
                .status(),
            404
        );
    }

    #[test]
    fn reads_png_dimensions() {
        assert_eq!(png_dimensions(&png(2560, 1600, 0)), Some((2560, 1600)));
        assert_eq!(png_dimensions(b"GIF89a................."), None);
        assert_eq!(png_dimensions(&[]), None);
    }

    #[test]
    fn only_https_pages_are_rendered() {
        assert!(validate_snapshot_url("https://demo.indigo-hq.com/").is_ok());
        assert!(validate_snapshot_url("http://demo.indigo-hq.com/").is_err());
        assert!(validate_snapshot_url("file:///etc/hosts").is_err());
        assert!(validate_snapshot_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn key_changes_with_deploy_and_redeploy_removes_old_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let (app, first) = snapshot_stem("personal:demo", "2026-10-01T00:00:00Z");
        let (same, second) = snapshot_stem("personal:demo", "2026-10-05T00:00:00Z");
        assert_eq!(app, same);
        assert_ne!(first, second);
        write_snapshot(dir.path(), &app, &first, &png(4, 4, 0), u64::MAX).unwrap();
        assert!(read_snapshot(dir.path(), &first).is_some());
        write_snapshot(dir.path(), &app, &second, &png(4, 4, 0), u64::MAX).unwrap();
        assert!(read_snapshot(dir.path(), &first).is_none());
        assert!(read_snapshot(dir.path(), &second).is_some());
    }

    #[test]
    fn evicts_least_recently_used_above_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let entry = |id: &str| snapshot_stem(id, "d");
        let body = png(4, 4, 1000);
        let size = body.len() as u64;
        let (a_hash, a) = entry("a");
        let (b_hash, b) = entry("b");
        let (c_hash, c) = entry("c");
        write_snapshot(dir.path(), &a_hash, &a, &body, u64::MAX).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        write_snapshot(dir.path(), &b_hash, &b, &body, u64::MAX).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        // Reading "a" makes it the most recently used, so "b" is evicted next.
        assert!(read_snapshot(dir.path(), &a).is_some());
        std::thread::sleep(Duration::from_millis(20));
        write_snapshot(dir.path(), &c_hash, &c, &body, size * 2).unwrap();
        assert!(read_snapshot(dir.path(), &a).is_some());
        assert!(read_snapshot(dir.path(), &b).is_none());
        assert!(read_snapshot(dir.path(), &c).is_some());
    }

    #[test]
    fn unreadable_cache_entry_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let (_, stem) = snapshot_stem("x", "d");
        std::fs::write(dir.path().join(format!("{stem}.png")), b"nope").unwrap();
        assert!(read_snapshot(dir.path(), &stem).is_none());
        assert!(!dir.path().join(format!("{stem}.png")).exists());
    }

    #[test]
    fn snapshot_payload_is_a_png_data_url_with_its_size() {
        let s = to_snapshot(&png(2560, 1600, 0)).unwrap();
        assert!(s.snapshot.starts_with("data:image/png;base64,"));
        assert_eq!((s.width, s.height), (2560, 1600));
        assert!(to_snapshot(b"not a png").is_err());
    }
}
