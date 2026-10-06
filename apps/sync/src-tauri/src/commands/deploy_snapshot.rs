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
//! Only macOS can capture today (WKWebView `takeSnapshot`). Other platforms
//! return an error and the panel falls back to the page's og:image.
//!
//! This file has no `crate::` imports so the capture test in
//! `tests/deploy_snapshot_capture.rs` can include it directly.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

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
        "deploy-snapshot-{}",
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

/// Read (or render and store) the snapshot for one deployed app.
pub async fn load_snapshot<R: Runtime>(
    app: &AppHandle<R>,
    dir: &Path,
    app_id: &str,
    page_url: &str,
    deployed_at: &str,
    refresh: bool,
) -> Result<DeploySnapshot, String> {
    let page = validate_snapshot_url(page_url)?;
    let (app_hash, stem) = snapshot_stem(app_id, deployed_at);
    if !refresh {
        if let Some(hit) = read_snapshot(dir, &stem) {
            return to_snapshot(&hit);
        }
    }
    let png = capture_page(app, page, CAPTURE_TIMEOUT, false).await?;
    let snapshot = to_snapshot(&png)?;
    if let Err(err) = write_snapshot(dir, &app_hash, &stem, &png, CACHE_CAP_BYTES) {
        eprintln!("[deploy-snapshot] {err}");
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn deploy_app_snapshot(
    app: AppHandle,
    app_id: String,
    url: String,
    deployed_at: String,
    refresh: Option<bool>,
) -> Result<DeploySnapshot, String> {
    let dir = cache_dir(&app)?;
    let result = load_snapshot(
        &app,
        &dir,
        &app_id,
        &url,
        &deployed_at,
        refresh.unwrap_or(false),
    )
    .await;
    if let Err(err) = &result {
        eprintln!("[deploy-snapshot] {app_id}: {err}");
    }
    result
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
