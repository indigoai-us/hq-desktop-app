//! HQ Work install detection, launcher, and signed installer.
//!
//! Detection is **state**, not a setup trigger: a missing or present app is a
//! boolean for later handoff UI. `hq_work_installed` / `launch_hq_work` must
//! never open onboarding, import, or desktop-alt windows.
//!
//! `install_hq_work` is the explicit user-initiated installer (US-003 card
//! Install). It is not opened by detection. US-004 silent co-install calls
//! `install_hq_work_with` / `verify_hq_work_bytes` with no windows or dialogs.
//!
//! Bundle id: `ai.getindigo.hq-work`.

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// HQ Work macOS application bundle identifier.
pub const HQ_WORK_BUNDLE_ID: &str = "ai.getindigo.hq-work";

const INSTALL_CACHE_TTL: Duration = Duration::from_secs(45);

static INSTALL_CACHE: Mutex<Option<(bool, Instant)>> = Mutex::new(None);
static CO_INSTALL_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// How `launch_hq_work` will invoke `open` after validation. Tests assert this
/// instead of spawning the OS opener.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HqWorkLaunchTarget {
    BundleId,
    Url(String),
}

/// Spotlight stdout → installed. Any non-empty trimmed line counts.
pub fn parse_mdfind_output(stdout: &str) -> bool {
    stdout.lines().any(|line| !line.trim().is_empty())
}

/// TTL cache around an injectable probe. `(installed, did_probe)`.
/// A miss, stale entry, or `cached = None` (refresh) calls `probe`.
pub fn detect_with_cache(
    now: Instant,
    cached: Option<(bool, Instant)>,
    ttl: Duration,
    probe: impl FnOnce() -> bool,
) -> (bool, bool) {
    if let Some((installed, at)) = cached {
        if now.saturating_duration_since(at) < ttl {
            return (installed, false);
        }
    }
    (probe(), true)
}

fn is_hex_digit(byte: u8) -> bool {
    byte.is_ascii_hexdigit()
}

fn is_allowed_hqwork_url_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'.'
                | b'_'
                | b'~'
                | b':'
                | b'/'
                | b'?'
                | b'#'
                | b'['
                | b']'
                | b'@'
                | b'!'
                | b'$'
                | b'&'
                | b'('
                | b')'
                | b'*'
                | b'+'
                | b','
                | b';'
                | b'='
        )
}

/// Validate a `hqwork://open?...` deep link byte-for-byte before it is handed
/// to `open`. Same allowlist as `launch::validate_claude_deep_link`.
pub fn validate_hqwork_deep_link(url: &str) -> Result<(), String> {
    if !url.starts_with("hqwork://open?") {
        if url.is_empty() {
            return Err("refusing to open empty hqwork URL".to_string());
        }
        if url.starts_with("hqwork://") {
            return Err(format!(
                "refusing to open hqwork URL that is not hqwork://open?: {url}"
            ));
        }
        return Err(format!("refusing to open non-hqwork scheme: {url}"));
    }

    let bytes = url.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if !(0x21..=0x7e).contains(&byte) {
            return Err(format!(
                "refusing to open hqwork:// URL with whitespace/control byte at offset {i}"
            ));
        }
        match byte {
            b'"' | b'\'' | b'`' | b'<' | b'>' | b'\\' | b'|' => {
                return Err(format!(
                    "refusing to open hqwork:// URL with disallowed character {:?}",
                    byte as char
                ));
            }
            b'%' => {
                if i + 2 >= bytes.len()
                    || !is_hex_digit(bytes[i + 1])
                    || !is_hex_digit(bytes[i + 2])
                {
                    return Err(
                        "refusing to open hqwork:// URL with malformed percent escape".to_string(),
                    );
                }
                i += 3;
                continue;
            }
            _ if is_allowed_hqwork_url_byte(byte) => {}
            _ => {
                return Err(format!(
                    "refusing to open hqwork:// URL with disallowed character {:?}",
                    byte as char
                ));
            }
        }
        i += 1;
    }

    Ok(())
}

/// Plan the `open` invocation without spawning it.
pub fn launch_plan(url: Option<&str>) -> Result<HqWorkLaunchTarget, String> {
    match url {
        Some(target) => {
            validate_hqwork_deep_link(target)?;
            Ok(HqWorkLaunchTarget::Url(target.to_string()))
        }
        None => Ok(HqWorkLaunchTarget::BundleId),
    }
}

#[cfg(target_os = "macos")]
fn hq_work_ns_string(value: &str) -> *mut objc2::runtime::AnyObject {
    use objc2::{class, msg_send};
    // SAFETY: bytes stay valid for this message; NSString is autoreleased.
    unsafe {
        let bytes = value.as_ptr() as *const std::ffi::c_void;
        msg_send![
            class!(NSString),
            stringWithBytes: bytes,
            length: value.len(),
            encoding: 4usize /* NSUTF8StringEncoding */
        ]
    }
}

/// Primary macOS probe: NSWorkspace URLForApplicationWithBundleIdentifier.
#[cfg(target_os = "macos")]
fn nsworkspace_has_hq_work() -> bool {
    use objc2::{class, msg_send, runtime::AnyObject};
    unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace.is_null() {
            return false;
        }
        let bundle_id = hq_work_ns_string(HQ_WORK_BUNDLE_ID);
        if bundle_id.is_null() {
            return false;
        }
        let url: *mut AnyObject =
            msg_send![workspace, URLForApplicationWithBundleIdentifier: bundle_id];
        !url.is_null()
    }
}

#[cfg(target_os = "macos")]
fn mdfind_has_hq_work() -> bool {
    let output = Command::new("mdfind")
        .arg(format!(
            "kMDItemCFBundleIdentifier == \"{HQ_WORK_BUNDLE_ID}\""
        ))
        .output();
    match output {
        Ok(out) => parse_mdfind_output(&String::from_utf8_lossy(&out.stdout)),
        Err(_) => false,
    }
}

fn probe_installed() -> bool {
    #[cfg(target_os = "macos")]
    {
        if nsworkspace_has_hq_work() {
            return true;
        }
        mdfind_has_hq_work()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

fn cache_lock() -> std::sync::MutexGuard<'static, Option<(bool, Instant)>> {
    INSTALL_CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Force a re-probe and rewrite the cache (app-activate / window focus).
pub fn refresh_hq_work_install_cache() {
    let installed = probe_installed();
    *cache_lock() = Some((installed, Instant::now()));
}

/// Cached install state. Missing/stale cache probes; never opens setup.
#[tauri::command]
pub fn hq_work_installed() -> bool {
    let now = Instant::now();
    let mut cache = cache_lock();
    let (installed, did_probe) = detect_with_cache(now, *cache, INSTALL_CACHE_TTL, probe_installed);
    if did_probe {
        *cache = Some((installed, now));
    }
    installed
}

#[cfg(target_os = "macos")]
fn open_with_args(args: &[&str]) -> Result<(), String> {
    let output = Command::new("open")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run open: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "open exited {}: {}",
            output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            stderr.trim()
        ));
    }
    Ok(())
}

/// Launch HQ Work, optionally with a validated `hqwork://open?...` URL.
#[tauri::command]
pub fn launch_hq_work(url: Option<String>) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("HQ Work launch is only supported on macOS".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        match launch_plan(url.as_deref())? {
            HqWorkLaunchTarget::Url(target) => open_with_args(&[target.as_str()]),
            HqWorkLaunchTarget::BundleId => open_with_args(&["-b", HQ_WORK_BUNDLE_ID]),
        }
    }
}

// ── US-003 handoff intercept + signed installer ──────────────────────────────

/// HQ Work updater feed (Tauri latest.json).
pub const HQ_WORK_FEED_URL: &str =
    "https://indigo-electron-releases.s3.us-east-1.amazonaws.com/hq-work/latest.json";

/// Frontend event that opens the compact "desktop view moved" overlay.
pub const HANDOFF_SHOW_CARD_EVENT: &str = "handoff:show-card";

/// HQ Work updater pubkey from hq-work-mono `tauri.conf.json` (Tauri minisign blob).
pub const HQ_WORK_UPDATER_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEZERDlGOUI4NDhCRTVFRTQKUldUa1hyNUl1UG5aL2UzeGhpdzBsRzdKV3dkQWx3VzlDeTFLdGFnSW5UL3FrbDAvcnhSby9vcjUK";

const CARD_SHOWN_KEY: &str = "hqWorkHandoffCardShown";
const MAX_INSTALLER_BYTES: usize = 400 * 1024 * 1024;
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);

/// What `open_desktop_alt_window_inner` should do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopAltHandoffPlan {
    OpenDesktopAlt,
    ShowHandoffCard { first_show: bool },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffCardEvent {
    pub first_show: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HqWorkFeed {
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub platforms: HashMap<String, HqWorkFeedPlatform>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HqWorkFeedPlatform {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub signature: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallerKind {
    Dmg,
    AppTarGz,
}

/// Intercept desktop-alt only when the handoff flag is on and HQ Work is missing.
pub fn should_intercept_desktop_alt(handoff_enabled: bool, installed: bool) -> bool {
    handoff_enabled && !installed
}

pub fn plan_desktop_alt_open(
    handoff_enabled: bool,
    installed: bool,
    card_already_shown: bool,
) -> DesktopAltHandoffPlan {
    if should_intercept_desktop_alt(handoff_enabled, installed) {
        DesktopAltHandoffPlan::ShowHandoffCard {
            first_show: !card_already_shown,
        }
    } else {
        DesktopAltHandoffPlan::OpenDesktopAlt
    }
}

pub fn hq_work_handoff_card_shown_from_json(contents: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(contents)
        .ok()
        .and_then(|v| v.get(CARD_SHOWN_KEY).and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

#[tauri::command]
pub fn get_hq_work_handoff_card_shown() -> Result<bool, String> {
    let path = crate::util::paths::menubar_json_path()?;
    if !path.exists() {
        return Ok(false);
    }
    let Ok(contents) = fs::read_to_string(&path) else {
        return Ok(false);
    };
    Ok(hq_work_handoff_card_shown_from_json(&contents))
}

#[tauri::command]
pub fn mark_hq_work_handoff_card_shown() -> Result<(), String> {
    let path = crate::util::paths::menubar_json_path()?;
    hq_desktop_core::first_run::merge_menubar_flags(
        &path,
        &[(CARD_SHOWN_KEY, serde_json::json!(true))],
    )
}

/// If the handoff card should replace desktop-alt, show the compact popover,
/// emit `handoff:show-card`, persist first-show, and return `true`.
pub fn maybe_intercept_desktop_alt_handoff(app: &AppHandle) -> Result<bool, String> {
    if !cfg!(target_os = "macos") {
        let _ = app;
        return Ok(false);
    }
    let enabled = crate::commands::config::get_hq_work_handoff().unwrap_or(false);
    let installed = hq_work_installed();
    let shown = get_hq_work_handoff_card_shown().unwrap_or(false);
    match plan_desktop_alt_open(enabled, installed, shown) {
        DesktopAltHandoffPlan::OpenDesktopAlt => Ok(false),
        DesktopAltHandoffPlan::ShowHandoffCard { first_show } => {
            if first_show {
                let _ = mark_hq_work_handoff_card_shown();
            }
            reveal_handoff_card(app, first_show);
            Ok(true)
        }
    }
}

fn reveal_handoff_card(app: &AppHandle, first_show: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::tray::show_popover_window(&handle);
    });
    let _ = app.emit(
        HANDOFF_SHOW_CARD_EVENT,
        HandoffCardEvent { first_show },
    );
}

pub fn parse_hq_work_feed(json: &str) -> Result<HqWorkFeed, String> {
    serde_json::from_str(json).map_err(|e| format!("HQ Work feed parse failed: {e}"))
}

pub fn pick_darwin_platform<'a>(
    feed: &'a HqWorkFeed,
    platform_key: &str,
) -> Result<&'a HqWorkFeedPlatform, String> {
    feed.platforms.get(platform_key).ok_or_else(|| {
        format!("HQ Work feed has no installer for {platform_key}")
    })
}

pub fn require_artifact_signature(platform: &HqWorkFeedPlatform) -> Result<(), String> {
    if platform.url.trim().is_empty() {
        return Err("HQ Work feed is missing an installer URL".into());
    }
    if platform.signature.trim().is_empty() {
        return Err("HQ Work feed is missing a signature".into());
    }
    Ok(())
}

pub fn current_darwin_platform_key() -> Result<&'static str, String> {
    if cfg!(target_arch = "aarch64") {
        Ok("darwin-aarch64")
    } else if cfg!(target_arch = "x86_64") {
        Ok("darwin-x86_64")
    } else {
        Err("HQ Work install requires darwin aarch64 or x86_64".into())
    }
}

pub fn darwin_platform_key_for_arch(arch: &str) -> Result<&'static str, String> {
    match arch {
        "aarch64" => Ok("darwin-aarch64"),
        "x86_64" => Ok("darwin-x86_64"),
        other => Err(format!("HQ Work install has no darwin mapping for {other}")),
    }
}

pub fn installer_kind_from_url(url: &str) -> Result<InstallerKind, String> {
    let path = url
        .split('?')
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    if path.ends_with(".dmg") {
        Ok(InstallerKind::Dmg)
    } else if path.ends_with(".app.tar.gz") || path.ends_with(".tar.gz") {
        Ok(InstallerKind::AppTarGz)
    } else {
        Err(format!("unsupported HQ Work installer URL: {url}"))
    }
}

fn decode_tauri_minisign_blob(blob: &str) -> Result<String, String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(blob.trim())
        .map_err(|e| format!("invalid minisign encoding: {e}"))?;
    String::from_utf8(decoded).map_err(|_| "minisign blob is not utf-8".into())
}

/// Same trust chain as `tauri-plugin-updater`: base64-decode the pubkey and
/// signature blobs, then minisign-verify (allow_legacy = true).
pub fn verify_hq_work_bytes(bytes: &[u8], signature: &str) -> Result<(), String> {
    if signature.trim().is_empty() {
        return Err("refusing to install unsigned HQ Work bytes".into());
    }
    let pk_pem = decode_tauri_minisign_blob(HQ_WORK_UPDATER_PUBKEY)?;
    let sig_pem = decode_tauri_minisign_blob(signature)?;
    let public_key =
        PublicKey::decode(&pk_pem).map_err(|e| format!("HQ Work pubkey: {e}"))?;
    let sig = Signature::decode(&sig_pem).map_err(|e| format!("HQ Work signature: {e}"))?;
    public_key
        .verify(bytes, &sig, true)
        .map_err(|_| "HQ Work signature verification failed".to_string())?;
    Ok(())
}

/// Injectable install pipeline. Tests supply HTTP; production uses reqwest.
pub fn install_hq_work_with(
    fetch_feed: impl FnOnce(&str) -> Result<String, String>,
    fetch_bytes: impl FnOnce(&str) -> Result<Vec<u8>, String>,
    platform_key: &str,
    install_bytes: impl FnOnce(&[u8], InstallerKind) -> Result<(), String>,
) -> Result<(), String> {
    let feed = parse_hq_work_feed(&fetch_feed(HQ_WORK_FEED_URL)?)?;
    let artifact = pick_darwin_platform(&feed, platform_key)?;
    require_artifact_signature(artifact)?;
    let kind = installer_kind_from_url(&artifact.url)?;
    let url = artifact.url.clone();
    let signature = artifact.signature.clone();
    let bytes = fetch_bytes(&url)?;
    verify_hq_work_bytes(&bytes, &signature)?;
    install_bytes(&bytes, kind)?;
    Ok(())
}

fn http_get_text(url: &str) -> Result<String, String> {
    require_https(url)?;
    reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("HQ Work HTTP client: {e}"))?
        .get(url)
        .send()
        .map_err(|e| format!("HQ Work feed fetch failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("HQ Work feed HTTP error: {e}"))?
        .text()
        .map_err(|e| format!("HQ Work feed read failed: {e}"))
}

fn http_get_bytes(url: &str) -> Result<Vec<u8>, String> {
    require_https(url)?;
    let response = reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("HQ Work HTTP client: {e}"))?
        .get(url)
        .send()
        .map_err(|e| format!("HQ Work installer fetch failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("HQ Work installer HTTP error: {e}"))?;
    if let Some(len) = response.content_length() {
        if len as usize > MAX_INSTALLER_BYTES {
            return Err("HQ Work installer is larger than expected".into());
        }
    }
    let bytes = response
        .bytes()
        .map_err(|e| format!("HQ Work installer read failed: {e}"))?;
    if bytes.len() > MAX_INSTALLER_BYTES {
        return Err("HQ Work installer is larger than expected".into());
    }
    Ok(bytes.to_vec())
}

fn require_https(url: &str) -> Result<(), String> {
    if url.starts_with("https://") {
        Ok(())
    } else {
        Err("refusing to download HQ Work over non-HTTPS".into())
    }
}

fn unique_temp_dir(prefix: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).map_err(|e| format!("temp dir: {e}"))?;
    Ok(dir)
}

pub fn find_app_bundle(root: &Path) -> Result<PathBuf, String> {
    let mut found = Vec::new();
    walk_app_bundles(root, &mut found);
    if found.is_empty() {
        return Err("HQ Work.app was not found in the installer".into());
    }
    if let Some(preferred) = found.iter().find(|path| {
        path.file_name().and_then(|n| n.to_str()) == Some("HQ Work.app")
    }) {
        return Ok(preferred.clone());
    }
    Ok(found.swap_remove(0))
}

fn walk_app_bundles(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) == Some("app") {
            out.push(path);
        } else {
            walk_app_bundles(&path, out);
        }
    }
}

fn is_safe_archive_path(path: &Path) -> bool {
    let mut comps = path.components();
    match comps.next() {
        Some(Component::Normal(_)) => {}
        _ => return false,
    }
    comps.all(|c| matches!(c, Component::Normal(_)))
}

/// Extract a `.app.tar.gz` into `dest_dir` and return the `.app` path.
pub fn extract_app_bundle_from_tarball(bytes: &[u8], dest_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(dest_dir).map_err(|e| format!("extract dir: {e}"))?;
    let gz = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(gz);
    let entries = archive
        .entries()
        .map_err(|e| format!("HQ Work archive: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("HQ Work archive entry: {e}"))?;
        let rel = entry
            .path()
            .map_err(|e| format!("HQ Work archive path: {e}"))?
            .into_owned();
        if !is_safe_archive_path(&rel) {
            continue;
        }
        let out = dest_dir.join(&rel);
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("extract parent: {e}"))?;
        }
        entry
            .unpack(&out)
            .map_err(|e| format!("HQ Work extract failed: {e}"))?;
    }
    find_app_bundle(dest_dir)
}

#[cfg(target_os = "macos")]
fn copy_app_to_applications(src: &Path) -> Result<(), String> {
    let dest = PathBuf::from("/Applications/HQ Work.app");
    let staging = PathBuf::from("/Applications/HQ Work.app.installing");
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|e| format!("could not clear installer staging: {e}"))?;
    }
    let status = Command::new("ditto")
        .arg(src)
        .arg(&staging)
        .status()
        .map_err(|e| format!("ditto failed: {e}"))?;
    if !status.success() {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "ditto exited {}",
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "unknown".into())
        ));
    }
    if dest.exists() {
        if let Err(e) = fs::remove_dir_all(&dest) {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("could not replace existing HQ Work.app: {e}"));
        }
    }
    fs::rename(&staging, &dest)
        .map_err(|e| format!("could not move HQ Work.app into /Applications: {e}"))
}

#[cfg(target_os = "macos")]
fn install_from_dmg(dmg: &Path) -> Result<(), String> {
    let mount = unique_temp_dir("hq-work-dmg")?;
    let attach = Command::new("hdiutil")
        .args(["attach", "-nobrowse", "-readonly", "-noverify", "-mountpoint"])
        .arg(&mount)
        .arg(dmg)
        .output()
        .map_err(|e| format!("hdiutil attach failed: {e}"))?;
    let result = (|| {
        if !attach.status.success() {
            return Err(format!(
                "hdiutil attach failed: {}",
                String::from_utf8_lossy(&attach.stderr).trim()
            ));
        }
        let app = find_app_bundle(&mount)?;
        copy_app_to_applications(&app)
    })();
    let _ = Command::new("hdiutil")
        .args(["detach", "-quiet", "-force"])
        .arg(&mount)
        .status();
    let _ = fs::remove_dir_all(&mount);
    result
}

fn install_verified_bytes(bytes: &[u8], kind: InstallerKind) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (bytes, kind);
        Err("HQ Work install is only supported on macOS".into())
    }
    #[cfg(target_os = "macos")]
    {
        match kind {
            InstallerKind::Dmg => {
                let dir = unique_temp_dir("hq-work-installer")?;
                let dmg = dir.join("HQ-Work.dmg");
                let result = (|| {
                    fs::write(&dmg, bytes).map_err(|e| format!("failed to write dmg: {e}"))?;
                    install_from_dmg(&dmg)
                })();
                let _ = fs::remove_dir_all(&dir);
                result
            }
            InstallerKind::AppTarGz => {
                let dir = unique_temp_dir("hq-work-tar")?;
                let result = (|| {
                    let app = extract_app_bundle_from_tarball(bytes, &dir)?;
                    copy_app_to_applications(&app)
                })();
                let _ = fs::remove_dir_all(&dir);
                result
            }
        }
    }
}

/// Download the signed HQ Work installer from the updater feed, verify, install.
#[tauri::command]
pub async fn install_hq_work() -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        Err("HQ Work install is only supported on macOS".into())
    }
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let platform = current_darwin_platform_key()?;
            install_hq_work_with(http_get_text, http_get_bytes, platform, install_verified_bytes)?;
            refresh_hq_work_install_cache();
            Ok(())
        })
        .await
        .map_err(|e| format!("HQ Work install task failed: {e}"))?
    }
}

// ── US-004 silent co-install (post-update / next launch) ──────────────────────

const UNINSTALLED_KEY: &str = "hqWorkUninstalled";
const LAST_SEEN_KEY: &str = "hqWorkLastSeenInstalled";
const CO_INSTALLED_VERSION_KEY: &str = "hqWorkCoInstalledForVersion";
const CO_INSTALL_ATTEMPT_COUNT: usize = 3;

/// Inputs for the pure skip/run table. `current_version` is the running Sync
/// version (`APP_VERSION` / Cargo package version).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoInstallDecisionInput<'a> {
    pub handoff_enabled: bool,
    pub installed: bool,
    pub uninstalled: bool,
    pub co_installed_for_version: Option<&'a str>,
    pub current_version: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoInstallSkipReason {
    FlagOff,
    AlreadyInstalled,
    Uninstalled,
    AlreadyAttemptedThisVersion,
}

impl CoInstallSkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FlagOff => "flag off",
            Self::AlreadyInstalled => "already installed",
            Self::Uninstalled => "user uninstalled HQ Work",
            Self::AlreadyAttemptedThisVersion => "already attempted this version",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoInstallAction {
    Run,
    Skip(CoInstallSkipReason),
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CoInstallPersisted {
    pub uninstalled: bool,
    pub last_seen_installed: bool,
    pub co_installed_for_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoInstallOutcome {
    Skipped(&'static str),
    Installed,
    Failed(String),
}

struct CoInstallGuard;

impl Drop for CoInstallGuard {
    fn drop(&mut self) {
        CO_INSTALL_IN_PROGRESS.store(false, Ordering::Release);
    }
}

fn try_begin_co_install() -> Option<CoInstallGuard> {
    CO_INSTALL_IN_PROGRESS
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .ok()
        .map(|_| CoInstallGuard)
}

/// Skip when the handoff flag is off, HQ Work is present, the user uninstalled
/// it, or this Sync version already attempted co-install.
pub fn maybe_co_install_decision(input: &CoInstallDecisionInput<'_>) -> CoInstallAction {
    if !input.handoff_enabled {
        return CoInstallAction::Skip(CoInstallSkipReason::FlagOff);
    }
    if input.installed {
        return CoInstallAction::Skip(CoInstallSkipReason::AlreadyInstalled);
    }
    if input.uninstalled {
        return CoInstallAction::Skip(CoInstallSkipReason::Uninstalled);
    }
    if input
        .co_installed_for_version
        .is_some_and(|v| !v.is_empty() && v == input.current_version)
    {
        return CoInstallAction::Skip(CoInstallSkipReason::AlreadyAttemptedThisVersion);
    }
    CoInstallAction::Run
}

/// Previously installed, now missing, and we are not in the middle of our own
/// install → treat as a user uninstall.
pub fn should_mark_hq_work_uninstalled(
    last_seen_installed: bool,
    now_installed: bool,
    our_install_running: bool,
) -> bool {
    last_seen_installed && !now_installed && !our_install_running
}

pub fn apply_install_observation(
    persisted: &CoInstallPersisted,
    now_installed: bool,
    our_install_running: bool,
) -> CoInstallPersisted {
    let mut next = persisted.clone();
    if now_installed {
        next.last_seen_installed = true;
    } else if should_mark_hq_work_uninstalled(
        persisted.last_seen_installed,
        now_installed,
        our_install_running,
    ) {
        next.uninstalled = true;
        next.last_seen_installed = false;
    }
    next
}

pub fn maybe_co_install_from_state(
    handoff_enabled: bool,
    installed: bool,
    persisted: &CoInstallPersisted,
    current_version: &str,
) -> (CoInstallPersisted, CoInstallAction) {
    let observed = apply_install_observation(persisted, installed, false);
    let action = maybe_co_install_decision(&CoInstallDecisionInput {
        handoff_enabled,
        installed,
        uninstalled: observed.uninstalled,
        co_installed_for_version: observed.co_installed_for_version.as_deref(),
        current_version,
    });
    (observed, action)
}

pub fn co_install_persisted_from_json(contents: &str) -> CoInstallPersisted {
    let v = serde_json::from_str::<serde_json::Value>(contents)
        .ok()
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    CoInstallPersisted {
        uninstalled: v
            .get(UNINSTALLED_KEY)
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
        last_seen_installed: v
            .get(LAST_SEEN_KEY)
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
        co_installed_for_version: v
            .get(CO_INSTALLED_VERSION_KEY)
            .and_then(|s| s.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    }
}

pub fn co_install_error_is_retryable(err: &str) -> bool {
    let e = err.to_lowercase();
    !(e.contains("signature")
        || e.contains("unsigned")
        || e.contains("minisign")
        || e.contains("only supported on macos"))
}

pub fn co_install_backoff_delay(attempt_index: usize) -> Duration {
    Duration::from_secs(1u64 << attempt_index.min(2))
}

pub fn run_co_install_with_retries<F, S>(mut install: F, mut sleep: S) -> Result<(), String>
where
    F: FnMut() -> Result<(), String>,
    S: FnMut(Duration),
{
    let mut last_err = String::from("co-install failed");
    for attempt in 0..CO_INSTALL_ATTEMPT_COUNT {
        match install() {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_err = err;
                let more = attempt + 1 < CO_INSTALL_ATTEMPT_COUNT;
                if more && co_install_error_is_retryable(&last_err) {
                    sleep(co_install_backoff_delay(attempt));
                } else if !co_install_error_is_retryable(&last_err) {
                    break;
                }
            }
        }
    }
    Err(last_err)
}

fn persist_co_install_state(path: &Path, state: &CoInstallPersisted) -> Result<(), String> {
    let uninstalled = serde_json::json!(state.uninstalled);
    let last_seen = serde_json::json!(state.last_seen_installed);
    match state.co_installed_for_version.as_deref() {
        Some(version) => hq_desktop_core::first_run::merge_menubar_flags(
            path,
            &[
                (UNINSTALLED_KEY, uninstalled),
                (LAST_SEEN_KEY, last_seen),
                (CO_INSTALLED_VERSION_KEY, serde_json::json!(version)),
            ],
        ),
        None => hq_desktop_core::first_run::merge_menubar_flags(
            path,
            &[(UNINSTALLED_KEY, uninstalled), (LAST_SEEN_KEY, last_seen)],
        ),
    }
}

fn handoff_log(msg: &str) {
    crate::util::logfile::log("handoff", msg);
}

/// Injectable co-install. Tests supply a fake installer and zero-duration sleep.
pub fn maybe_co_install_at<F, S>(
    menubar_path: &Path,
    handoff_enabled: bool,
    installed: bool,
    current_version: &str,
    install: F,
    sleep: S,
) -> CoInstallOutcome
where
    F: FnMut() -> Result<(), String>,
    S: FnMut(Duration),
{
    let persisted = if menubar_path.exists() {
        fs::read_to_string(menubar_path)
            .ok()
            .map(|s| co_install_persisted_from_json(&s))
            .unwrap_or_default()
    } else {
        CoInstallPersisted::default()
    };
    let (observed, action) =
        maybe_co_install_from_state(handoff_enabled, installed, &persisted, current_version);
    if observed != persisted {
        let _ = persist_co_install_state(menubar_path, &observed);
    }
    match action {
        CoInstallAction::Skip(reason) => {
            handoff_log(&format!("co_install skipped: {}", reason.as_str()));
            CoInstallOutcome::Skipped(reason.as_str())
        }
        CoInstallAction::Run => {
            let result = run_co_install_with_retries(install, sleep);
            let mut after = observed;
            after.co_installed_for_version = Some(current_version.to_string());
            match &result {
                Ok(()) => {
                    after.last_seen_installed = true;
                    refresh_hq_work_install_cache();
                    handoff_log("co_install ok");
                }
                Err(err) => {
                    handoff_log(&format!("co_install failed: {err}"));
                }
            }
            let _ = persist_co_install_state(menubar_path, &after);
            match result {
                Ok(()) => CoInstallOutcome::Installed,
                Err(err) => CoInstallOutcome::Failed(err),
            }
        }
    }
}

fn co_install_from_release_feed() -> Result<(), String> {
    let platform = current_darwin_platform_key()?;
    install_hq_work_with(http_get_text, http_get_bytes, platform, install_verified_bytes)
}

/// Canonical silent co-install. Next-launch is the path that survives macOS
/// updater process kill. Never shows windows or dialogs.
pub fn maybe_co_install_hq_work() {
    let Some(_guard) = try_begin_co_install() else {
        handoff_log("co_install skipped: already in progress");
        return;
    };
    let macos = cfg!(target_os = "macos");
    if !macos {
        handoff_log("co_install skipped: not macos");
    }
    let enabled = macos && crate::commands::config::get_hq_work_handoff().unwrap_or(false);
    let installed = hq_work_installed();
    let path = match crate::util::paths::menubar_json_path() {
        Ok(path) => path,
        Err(err) => {
            handoff_log(&format!("co_install failed: {err}"));
            return;
        }
    };
    let _ = maybe_co_install_at(
        &path,
        enabled,
        installed,
        env!("APP_VERSION"),
        co_install_from_release_feed,
        |d| std::thread::sleep(d),
    );
}

/// Fire-and-forget spawn. Callers must not wait on HQ Work download.
pub fn spawn_maybe_co_install_hq_work() {
    tauri::async_runtime::spawn(async {
        if let Err(err) = tauri::async_runtime::spawn_blocking(maybe_co_install_hq_work).await {
            handoff_log(&format!("co_install task failed: {err}"));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn bundle_id_is_hq_work() {
        assert_eq!(HQ_WORK_BUNDLE_ID, "ai.getindigo.hq-work");
    }

    #[test]
    fn parse_mdfind_output_empty_is_false() {
        assert!(!parse_mdfind_output(""));
        assert!(!parse_mdfind_output("   \n\t\n  "));
    }

    #[test]
    fn parse_mdfind_output_one_path_is_true() {
        assert!(parse_mdfind_output("/Applications/HQ Work.app\n"));
    }

    #[test]
    fn parse_mdfind_output_multiple_paths_is_true() {
        assert!(parse_mdfind_output(
            "/Applications/HQ Work.app\n/Users/test/HQ Work.app\n"
        ));
    }

    #[test]
    fn detect_with_cache_hit_skips_probe() {
        let at = Instant::now();
        let now = at + Duration::from_secs(1);
        let probes = Cell::new(0);
        let (installed, did_probe) =
            detect_with_cache(now, Some((true, at)), Duration::from_secs(45), || {
                probes.set(probes.get() + 1);
                false
            });
        assert!(installed);
        assert!(!did_probe);
        assert_eq!(probes.get(), 0);
    }

    #[test]
    fn detect_with_cache_miss_probes() {
        let now = Instant::now();
        let probes = Cell::new(0);
        let (installed, did_probe) = detect_with_cache(now, None, Duration::from_secs(45), || {
            probes.set(probes.get() + 1);
            true
        });
        assert!(installed);
        assert!(did_probe);
        assert_eq!(probes.get(), 1);
    }

    #[test]
    fn detect_with_cache_stale_probes() {
        let at = Instant::now();
        let now = at + Duration::from_secs(46);
        let probes = Cell::new(0);
        let (installed, did_probe) =
            detect_with_cache(now, Some((false, at)), Duration::from_secs(45), || {
                probes.set(probes.get() + 1);
                true
            });
        assert!(installed);
        assert!(did_probe);
        assert_eq!(probes.get(), 1);
    }

    #[test]
    fn detect_with_cache_refresh_none_forces_probe() {
        // refresh_hq_work_install_cache ignores TTL by probing unconditionally;
        // callers model that as cached = None.
        let now = Instant::now();
        let probes = Cell::new(0);
        let (_installed, did_probe) = detect_with_cache(now, None, Duration::from_secs(45), || {
            probes.set(probes.get() + 1);
            false
        });
        assert!(did_probe);
        assert_eq!(probes.get(), 1);
    }

    #[test]
    fn validate_hqwork_accepts_open_query() {
        assert!(validate_hqwork_deep_link("hqwork://open?channel=abc").is_ok());
        assert!(validate_hqwork_deep_link("hqwork://open?channel=X&reply=Y").is_ok());
        assert!(validate_hqwork_deep_link("hqwork://open?person=prs_1").is_ok());
    }

    #[test]
    fn validate_hqwork_rejects_missing_query_and_other_schemes() {
        assert!(validate_hqwork_deep_link("").is_err());
        assert!(validate_hqwork_deep_link("hqwork://").is_err());
        assert!(validate_hqwork_deep_link("hqwork://open").is_err());
        assert!(validate_hqwork_deep_link("hqwork://foo").is_err());
        assert!(validate_hqwork_deep_link("https://example.com").is_err());
        assert!(validate_hqwork_deep_link("claude://code/new?q=hi").is_err());
    }

    #[test]
    fn validate_hqwork_rejects_whitespace_metacharacters_and_bad_percent() {
        assert!(validate_hqwork_deep_link("hqwork://open?channel=a b").is_err());
        assert!(validate_hqwork_deep_link("hqwork://open?channel=\"x\"").is_err());
        assert!(validate_hqwork_deep_link("hqwork://open?channel='x'").is_err());
        assert!(validate_hqwork_deep_link("hqwork://open?channel=`x`").is_err());
        assert!(validate_hqwork_deep_link("hqwork://open?channel=<x>").is_err());
        assert!(validate_hqwork_deep_link("hqwork://open?channel=a\\b").is_err());
        assert!(validate_hqwork_deep_link("hqwork://open?channel=a|b").is_err());
        assert!(validate_hqwork_deep_link("hqwork://open?channel=%zz").is_err());
        assert!(validate_hqwork_deep_link("hqwork://open?channel=%2").is_err());
        assert!(validate_hqwork_deep_link("hqwork://open?channel=%").is_err());
    }

    #[test]
    fn launch_plan_none_is_bundle_id() {
        assert_eq!(launch_plan(None).unwrap(), HqWorkLaunchTarget::BundleId);
    }

    #[test]
    fn launch_plan_valid_url_is_url_target() {
        let url = "hqwork://open?channel=X";
        assert_eq!(
            launch_plan(Some(url)).unwrap(),
            HqWorkLaunchTarget::Url(url.to_string())
        );
    }

    #[test]
    fn launch_plan_invalid_url_is_err_without_spawn() {
        assert!(launch_plan(Some("https://evil.example")).is_err());
        assert!(launch_plan(Some("hqwork://open")).is_err());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn launch_hq_work_non_macos_errors() {
        let err = launch_hq_work(None).unwrap_err();
        assert!(err.contains("only supported on macOS"));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn hq_work_installed_non_macos_is_false() {
        assert!(!hq_work_installed());
    }

    fn sample_feed(signature: &str) -> String {
        format!(
            r#"{{
                "version": "0.1.25",
                "platforms": {{
                    "darwin-aarch64": {{
                        "signature": "{signature}",
                        "url": "https://indigo-electron-releases.s3.us-east-1.amazonaws.com/hq-work/HQ-Work.dmg"
                    }},
                    "darwin-x86_64": {{
                        "signature": "{signature}",
                        "url": "https://indigo-electron-releases.s3.us-east-1.amazonaws.com/hq-work/HQ-Work_x64.app.tar.gz"
                    }}
                }}
            }}"#
        )
    }

    #[test]
    fn intercepts_only_when_flag_on_and_not_installed() {
        assert!(should_intercept_desktop_alt(true, false));
        assert!(!should_intercept_desktop_alt(false, false));
        assert!(!should_intercept_desktop_alt(true, true));
        assert!(!should_intercept_desktop_alt(false, true));
    }

    #[test]
    fn plan_first_show_then_quiet_rerun() {
        assert_eq!(
            plan_desktop_alt_open(true, false, false),
            DesktopAltHandoffPlan::ShowHandoffCard { first_show: true }
        );
        assert_eq!(
            plan_desktop_alt_open(true, false, true),
            DesktopAltHandoffPlan::ShowHandoffCard { first_show: false }
        );
        assert_eq!(
            plan_desktop_alt_open(false, false, false),
            DesktopAltHandoffPlan::OpenDesktopAlt
        );
        assert_eq!(
            plan_desktop_alt_open(true, true, false),
            DesktopAltHandoffPlan::OpenDesktopAlt
        );
    }

    #[test]
    fn feed_parse_picks_darwin_arch_platforms() {
        let feed = parse_hq_work_feed(&sample_feed("c2ln")).unwrap();
        assert_eq!(feed.version.as_deref(), Some("0.1.25"));
        let arm = pick_darwin_platform(&feed, "darwin-aarch64").unwrap();
        assert!(arm.url.ends_with("HQ-Work.dmg"));
        let intel = pick_darwin_platform(&feed, "darwin-x86_64").unwrap();
        assert!(intel.url.ends_with(".app.tar.gz"));
        assert!(pick_darwin_platform(&feed, "windows-x86_64").is_err());
    }

    #[test]
    fn reject_missing_signature_before_download() {
        let feed = r#"{
            "platforms": {
                "darwin-aarch64": {
                    "url": "https://indigo-electron-releases.s3.us-east-1.amazonaws.com/hq-work/HQ-Work.dmg",
                    "signature": ""
                }
            }
        }"#;
        let mut downloaded = false;
        let err = install_hq_work_with(
            |_| Ok(feed.to_string()),
            |_| {
                downloaded = true;
                Ok(vec![1, 2, 3])
            },
            "darwin-aarch64",
            |_, _| panic!("install must not run"),
        )
        .unwrap_err();
        assert!(err.to_lowercase().contains("signature"), "{err}");
        assert!(!downloaded);
    }

    #[test]
    fn reject_missing_platform_without_download() {
        let feed = r#"{"platforms":{"darwin-aarch64":{"url":"https://x/a.dmg","signature":"abc"}}}"#;
        let mut downloaded = false;
        let err = install_hq_work_with(
            |_| Ok(feed.to_string()),
            |_| {
                downloaded = true;
                Ok(vec![1, 2, 3])
            },
            "darwin-x86_64",
            |_, _| panic!("install must not run"),
        )
        .unwrap_err();
        assert!(err.contains("darwin-x86_64"), "{err}");
        assert!(!downloaded);
    }

    #[test]
    fn installer_kind_from_feed_urls() {
        assert_eq!(
            installer_kind_from_url(
                "https://indigo-electron-releases.s3.us-east-1.amazonaws.com/hq-work/HQ-Work.dmg"
            )
            .unwrap(),
            InstallerKind::Dmg
        );
        assert_eq!(
            installer_kind_from_url(
                "https://indigo-electron-releases.s3.us-east-1.amazonaws.com/hq-work/HQ-Work_0.1.25_aarch64.app.tar.gz"
            )
            .unwrap(),
            InstallerKind::AppTarGz
        );
        assert!(installer_kind_from_url("https://example/HQ-Work.zip").is_err());
    }

    #[test]
    fn darwin_platform_key_maps_arch() {
        assert_eq!(darwin_platform_key_for_arch("aarch64").unwrap(), "darwin-aarch64");
        assert_eq!(darwin_platform_key_for_arch("x86_64").unwrap(), "darwin-x86_64");
        assert!(darwin_platform_key_for_arch("arm").is_err());
    }

    #[test]
    fn hq_work_updater_pubkey_decodes() {
        let pem = decode_tauri_minisign_blob(HQ_WORK_UPDATER_PUBKEY).unwrap();
        assert!(pem.contains("minisign public key"));
        PublicKey::decode(&pem).unwrap();
    }

    #[test]
    fn verify_rejects_unsigned_and_garbage_signatures() {
        let err = verify_hq_work_bytes(&[1, 2, 3], "").unwrap_err();
        assert!(err.contains("unsigned"), "{err}");
        assert!(verify_hq_work_bytes(&[1, 2, 3], "not-base64!!!").is_err());
    }

    #[test]
    fn card_shown_json_and_merge_persist() {
        assert!(!hq_work_handoff_card_shown_from_json("{}"));
        assert!(!hq_work_handoff_card_shown_from_json("not-json"));
        assert!(hq_work_handoff_card_shown_from_json(
            r#"{"hqWorkHandoffCardShown":true}"#
        ));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("menubar.json");
        fs::write(&path, r#"{"hqPath":"/tmp/HQ"}"#).unwrap();
        hq_desktop_core::first_run::merge_menubar_flags(
            &path,
            &[(CARD_SHOWN_KEY, serde_json::json!(true))],
        )
        .unwrap();
        let contents = fs::read_to_string(&path).unwrap();
        assert!(hq_work_handoff_card_shown_from_json(&contents));
        assert!(contents.contains("hqPath"));
    }

    #[test]
    fn find_app_bundle_prefers_hq_work() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Other.app")).unwrap();
        fs::create_dir_all(dir.path().join("nested/HQ Work.app")).unwrap();
        let found = find_app_bundle(dir.path()).unwrap();
        assert_eq!(found.file_name().unwrap(), "HQ Work.app");
    }

    #[test]
    fn extract_app_bundle_from_tarball_finds_app() {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        header.set_cksum();
        builder
            .append_data(&mut header, "HQ Work.app", std::io::empty())
            .unwrap();
        let mut file_header = tar::Header::new_gnu();
        let body = b"ok";
        file_header.set_size(body.len() as u64);
        file_header.set_cksum();
        builder
            .append_data(
                &mut file_header,
                "HQ Work.app/Contents/Info.plist",
                &body[..],
            )
            .unwrap();
        let tar_bytes = builder.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, &tar_bytes).unwrap();
        let gz = encoder.finish().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let app = extract_app_bundle_from_tarball(&gz, dest.path()).unwrap();
        assert_eq!(app.file_name().unwrap(), "HQ Work.app");
        assert!(app.join("Contents/Info.plist").is_file());
    }

    #[test]
    fn install_pipeline_does_not_hit_network_on_injected_http() {
        let feed = sample_feed("c2ln");
        let err = install_hq_work_with(
            |url| {
                assert_eq!(url, HQ_WORK_FEED_URL);
                Ok(feed.clone())
            },
            |_| Ok(b"not-a-real-dmg".to_vec()),
            "darwin-aarch64",
            |_, _| panic!("must not install unsigned/unverified bytes"),
        )
        .unwrap_err();
        assert!(
            err.contains("signature") || err.contains("minisign") || err.contains("encoding"),
            "{err}"
        );
    }

    fn decision_input<'a>(
        flag: bool,
        installed: bool,
        uninstalled: bool,
        version_marker: Option<&'a str>,
        current: &'a str,
    ) -> CoInstallDecisionInput<'a> {
        CoInstallDecisionInput {
            handoff_enabled: flag,
            installed,
            uninstalled,
            co_installed_for_version: version_marker,
            current_version: current,
        }
    }

    #[test]
    fn co_install_decision_table_skip_and_run() {
        let current = "0.10.150";
        assert_eq!(
            maybe_co_install_decision(&decision_input(true, false, false, None, current)),
            CoInstallAction::Run
        );
        assert_eq!(
            maybe_co_install_decision(&decision_input(false, false, false, None, current)),
            CoInstallAction::Skip(CoInstallSkipReason::FlagOff)
        );
        assert_eq!(
            maybe_co_install_decision(&decision_input(true, true, false, None, current)),
            CoInstallAction::Skip(CoInstallSkipReason::AlreadyInstalled)
        );
        assert_eq!(
            maybe_co_install_decision(&decision_input(true, false, true, None, current)),
            CoInstallAction::Skip(CoInstallSkipReason::Uninstalled)
        );
        assert_eq!(
            maybe_co_install_decision(&decision_input(
                true,
                false,
                false,
                Some("0.10.150"),
                current
            )),
            CoInstallAction::Skip(CoInstallSkipReason::AlreadyAttemptedThisVersion)
        );
        assert_eq!(
            maybe_co_install_decision(&decision_input(
                true,
                false,
                false,
                Some("0.10.149"),
                current
            )),
            CoInstallAction::Run
        );
        assert_eq!(
            maybe_co_install_decision(&decision_input(true, false, false, Some(""), current)),
            CoInstallAction::Run
        );
        // ANY skip condition wins; flag off beats an otherwise-runnable state.
        assert_eq!(
            maybe_co_install_decision(&decision_input(false, false, true, Some(current), current)),
            CoInstallAction::Skip(CoInstallSkipReason::FlagOff)
        );
    }

    #[test]
    fn uninstall_marker_when_last_seen_installed_now_missing() {
        assert!(should_mark_hq_work_uninstalled(true, false, false));
        assert!(!should_mark_hq_work_uninstalled(true, false, true));
        assert!(!should_mark_hq_work_uninstalled(false, false, false));
        assert!(!should_mark_hq_work_uninstalled(true, true, false));

        let persisted = CoInstallPersisted {
            last_seen_installed: true,
            ..CoInstallPersisted::default()
        };
        let (observed, action) =
            maybe_co_install_from_state(true, false, &persisted, "0.10.150");
        assert!(observed.uninstalled);
        assert!(!observed.last_seen_installed);
        assert_eq!(
            action,
            CoInstallAction::Skip(CoInstallSkipReason::Uninstalled)
        );
    }

    #[test]
    fn last_seen_installed_updated_when_present() {
        let persisted = CoInstallPersisted::default();
        let (observed, action) = maybe_co_install_from_state(true, true, &persisted, "0.10.150");
        assert!(observed.last_seen_installed);
        assert!(!observed.uninstalled);
        assert_eq!(
            action,
            CoInstallAction::Skip(CoInstallSkipReason::AlreadyInstalled)
        );
    }

    #[test]
    fn retries_three_times_with_exponential_backoff_then_gives_up() {
        let calls = Cell::new(0);
        let sleeps = std::cell::RefCell::new(Vec::new());
        let err = run_co_install_with_retries(
            || {
                calls.set(calls.get() + 1);
                Err("network down".into())
            },
            |d| sleeps.borrow_mut().push(d),
        )
        .unwrap_err();
        assert_eq!(err, "network down");
        assert_eq!(calls.get(), 3);
        assert_eq!(
            sleeps.borrow().as_slice(),
            &[Duration::from_secs(1), Duration::from_secs(2)]
        );
    }

    #[test]
    fn retries_until_fake_installer_succeeds() {
        let calls = Cell::new(0);
        let sleeps = std::cell::RefCell::new(Vec::new());
        run_co_install_with_retries(
            || {
                let n = calls.get() + 1;
                calls.set(n);
                if n < 3 {
                    Err("transient".into())
                } else {
                    Ok(())
                }
            },
            |d| sleeps.borrow_mut().push(d),
        )
        .unwrap();
        assert_eq!(calls.get(), 3);
        assert_eq!(
            sleeps.borrow().as_slice(),
            &[Duration::from_secs(1), Duration::from_secs(2)]
        );
    }

    #[test]
    fn signature_failure_does_not_retry() {
        let calls = Cell::new(0);
        let sleeps = std::cell::RefCell::new(Vec::new());
        let err = run_co_install_with_retries(
            || {
                calls.set(calls.get() + 1);
                Err("HQ Work signature verification failed".into())
            },
            |d| sleeps.borrow_mut().push(d),
        )
        .unwrap_err();
        assert!(err.contains("signature"), "{err}");
        assert_eq!(calls.get(), 1);
        assert!(sleeps.borrow().is_empty());
        assert!(!co_install_error_is_retryable("refusing to install unsigned HQ Work bytes"));
        assert!(!co_install_error_is_retryable("invalid minisign encoding"));
    }

    #[test]
    fn maybe_co_install_at_honors_uninstall_marker_without_calling_installer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("menubar.json");
        fs::write(
            &path,
            r#"{"hqWorkUninstalled":true,"hqPath":"/tmp/HQ"}"#,
        )
        .unwrap();
        let calls = Cell::new(0);
        let outcome = maybe_co_install_at(
            &path,
            true,
            false,
            "0.10.150",
            || {
                calls.set(calls.get() + 1);
                panic!("must not co-install after uninstall");
            },
            |_| {},
        );
        assert_eq!(
            outcome,
            CoInstallOutcome::Skipped("user uninstalled HQ Work")
        );
        assert_eq!(calls.get(), 0);
        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.contains("hqPath"));
        assert!(!contents.contains("hqWorkCoInstalledForVersion"));
    }

    #[test]
    fn maybe_co_install_at_sets_uninstall_marker_from_last_seen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("menubar.json");
        fs::write(&path, r#"{"hqWorkLastSeenInstalled":true}"#).unwrap();
        let calls = Cell::new(0);
        let outcome = maybe_co_install_at(
            &path,
            true,
            false,
            "0.10.150",
            || {
                calls.set(calls.get() + 1);
                panic!("must not co-install after inferred uninstall");
            },
            |_| {},
        );
        assert_eq!(
            outcome,
            CoInstallOutcome::Skipped("user uninstalled HQ Work")
        );
        assert_eq!(calls.get(), 0);
        let persisted = co_install_persisted_from_json(&fs::read_to_string(&path).unwrap());
        assert!(persisted.uninstalled);
        assert!(!persisted.last_seen_installed);
        assert!(persisted.co_installed_for_version.is_none());
    }

    #[test]
    fn maybe_co_install_at_writes_version_marker_after_silent_fail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("menubar.json");
        fs::write(&path, "{}").unwrap();
        let calls = Cell::new(0);
        let outcome = maybe_co_install_at(
            &path,
            true,
            false,
            "0.10.150",
            || {
                calls.set(calls.get() + 1);
                Err("network down".into())
            },
            |_| {},
        );
        assert_eq!(calls.get(), 3);
        match outcome {
            CoInstallOutcome::Failed(err) => assert_eq!(err, "network down"),
            other => panic!("expected Failed, got {other:?}"),
        }
        let persisted = co_install_persisted_from_json(&fs::read_to_string(&path).unwrap());
        assert_eq!(
            persisted.co_installed_for_version.as_deref(),
            Some("0.10.150")
        );
        assert!(!persisted.last_seen_installed);

        let calls_after = Cell::new(0);
        let skipped = maybe_co_install_at(
            &path,
            true,
            false,
            "0.10.150",
            || {
                calls_after.set(calls_after.get() + 1);
                panic!("must not loop on the same Sync version");
            },
            |_| {},
        );
        assert_eq!(
            skipped,
            CoInstallOutcome::Skipped("already attempted this version")
        );
        assert_eq!(calls_after.get(), 0);
    }

    #[test]
    fn maybe_co_install_at_success_marks_version_and_last_seen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("menubar.json");
        fs::write(&path, r#"{"hqPath":"/tmp/HQ"}"#).unwrap();
        let calls = Cell::new(0);
        let outcome = maybe_co_install_at(
            &path,
            true,
            false,
            "0.10.150",
            || {
                calls.set(calls.get() + 1);
                Ok(())
            },
            |_| panic!("success must not sleep"),
        );
        assert_eq!(outcome, CoInstallOutcome::Installed);
        assert_eq!(calls.get(), 1);
        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.contains("hqPath"));
        let persisted = co_install_persisted_from_json(&contents);
        assert_eq!(
            persisted.co_installed_for_version.as_deref(),
            Some("0.10.150")
        );
        assert!(persisted.last_seen_installed);
        assert!(!persisted.uninstalled);
    }

    #[test]
    fn maybe_co_install_at_runs_again_on_new_sync_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("menubar.json");
        fs::write(
            &path,
            r#"{"hqWorkCoInstalledForVersion":"0.10.149"}"#,
        )
        .unwrap();
        let calls = Cell::new(0);
        let outcome = maybe_co_install_at(
            &path,
            true,
            false,
            "0.10.150",
            || {
                calls.set(calls.get() + 1);
                Ok(())
            },
            |_| {},
        );
        assert_eq!(outcome, CoInstallOutcome::Installed);
        assert_eq!(calls.get(), 1);
        let persisted = co_install_persisted_from_json(&fs::read_to_string(&path).unwrap());
        assert_eq!(
            persisted.co_installed_for_version.as_deref(),
            Some("0.10.150")
        );
    }

    #[test]
    fn maybe_co_install_at_skips_flag_off_without_installer_or_version_marker() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("menubar.json");
        fs::write(&path, "{}").unwrap();
        let calls = Cell::new(0);
        let outcome = maybe_co_install_at(
            &path,
            false,
            false,
            "0.10.150",
            || {
                calls.set(calls.get() + 1);
                panic!("flag off must not install");
            },
            |_| {},
        );
        assert_eq!(outcome, CoInstallOutcome::Skipped("flag off"));
        assert_eq!(calls.get(), 0);
        let persisted = co_install_persisted_from_json(&fs::read_to_string(&path).unwrap());
        assert!(persisted.co_installed_for_version.is_none());
    }

    #[test]
    fn co_install_backoff_is_1s_2s_4s() {
        assert_eq!(co_install_backoff_delay(0), Duration::from_secs(1));
        assert_eq!(co_install_backoff_delay(1), Duration::from_secs(2));
        assert_eq!(co_install_backoff_delay(2), Duration::from_secs(4));
    }

    #[test]
    fn json_helpers_read_co_install_keys() {
        let parsed = co_install_persisted_from_json(
            r#"{"hqWorkUninstalled":true,"hqWorkLastSeenInstalled":false,"hqWorkCoInstalledForVersion":"0.10.150"}"#,
        );
        assert!(parsed.uninstalled);
        assert!(!parsed.last_seen_installed);
        assert_eq!(parsed.co_installed_for_version.as_deref(), Some("0.10.150"));
        assert_eq!(
            co_install_persisted_from_json("not-json"),
            CoInstallPersisted::default()
        );
    }
}
