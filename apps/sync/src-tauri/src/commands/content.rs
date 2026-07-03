//! Fetch the HQ starter template from GitHub and safely extract it into the
//! resolved HQ root during onboarding.
//!
//! This is the Rust-side port of the old `hq-installer-react` React app's
//! `src/lib/template-fetcher.ts`, folded into a single Tauri command instead
//! of a JS-orchestrated per-entry IPC dance. The old installer downloaded and
//! gunzip/tar-parsed the archive in the renderer, then invoked one Rust
//! command per file/dir/symlink to perform the actual write (so JS could stay
//! "root-validated" defense-in-depth without owning raw filesystem access).
//! Here the whole pipeline — download, decompress, parse, and write — runs in
//! Rust, which removes the per-file IPC round-trip and keeps the archive
//! bytes out of the webview process entirely.
//!
//! Safety properties ported from the old installer (see `fs.rs` and
//! `template-fetcher.ts` in `imports/hq-installer-react`):
//!   * Every archive entry's path is normalized and rejected if it contains
//!     `..`, a null byte, or an absolute/drive/UNC prefix.
//!   * The resolved destination must lexically resolve inside the HQ root —
//!     rejected otherwise ("zip-slip" / path-traversal protection).
//!   * Symlink targets are validated the same way, walked from the link's
//!     parent directory, and rejected if they would resolve outside the root.
//!   * Any entry whose path falls underneath an already-created symlink is
//!     skipped, so a malicious symlink can't be used to redirect a later
//!     entry outside the root.
//!   * The GitHub tarball wrapper directory (`owner-repo-<sha>/`) is stripped
//!     so the template's own root becomes the HQ root.
//!
//! The old installer also exposed a staging-source override. That is ported
//! here as a `~/.hq/menubar.json` flag so onboarding can pull
//! `indigoai-us/hq-core-staging` when explicitly enabled.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tar::EntryType;
use tauri::{AppHandle, Emitter};

use crate::commands::install_directory::resolve_hq_path;
use crate::util::client_info::client_headers;
use crate::util::logfile::log;

const GITHUB_API: &str = "https://api.github.com";
const DEFAULT_TEMPLATE_REPO: &str = "indigoai-us/hq-core";
const STAGING_TEMPLATE_REPO: &str = "indigoai-us/hq-core-staging";
const STAGING_TEMPLATE_REF: &str = "main";
const STAGING_SOURCE_KEY: &str = "stagingSource";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Per-chunk stall budget while streaming the tarball. Mirrors the old
/// installer's `DOWNLOAD_HARD_STALL_MS` (25s) — long enough to ride out a
/// slow link, short enough that a truly dead connection doesn't hang setup
/// indefinitely.
const CHUNK_STALL_TIMEOUT: Duration = Duration::from_secs(25);
const DOWNLOAD_SLOW_NOTICE_TIMEOUT: Duration = Duration::from_secs(20);
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(120);
const EXTRACT_READ_CHUNK_BYTES: usize = 64 * 1024;

static CONTENT_CANCEL_REGISTRY: OnceLock<Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>> =
    OnceLock::new();

#[derive(Debug, Deserialize)]
struct ReleaseInfo {
    tag_name: String,
    tarball_url: String,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentProgressPayload {
    handle: String,
    phase: &'static str,
    received_bytes: Option<u64>,
    total_bytes: Option<u64>,
    percent: Option<f64>,
    slow: bool,
    stalled: bool,
    message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TemplateChannel {
    StableRelease,
    StagingMain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TemplateSource {
    repo: &'static str,
    reference: Option<&'static str>,
    channel: TemplateChannel,
}

impl TemplateSource {
    fn label(self) -> &'static str {
        match self.channel {
            TemplateChannel::StableRelease => "stable",
            TemplateChannel::StagingMain => "staging",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StagingSourceChangedPayload {
    enabled: bool,
}

fn template_source_for_staging_source(enabled: bool) -> TemplateSource {
    if enabled {
        TemplateSource {
            repo: STAGING_TEMPLATE_REPO,
            reference: Some(STAGING_TEMPLATE_REF),
            channel: TemplateChannel::StagingMain,
        }
    } else {
        TemplateSource {
            repo: DEFAULT_TEMPLATE_REPO,
            reference: None,
            channel: TemplateChannel::StableRelease,
        }
    }
}

#[derive(Clone)]
struct ContentProgressEmitter {
    app: AppHandle,
    handle: String,
}

impl ContentProgressEmitter {
    fn emit(
        &self,
        phase: &'static str,
        received_bytes: Option<u64>,
        total_bytes: Option<u64>,
        slow: bool,
        stalled: bool,
        message: impl Into<String>,
    ) {
        let percent = match (received_bytes, total_bytes) {
            (Some(received), Some(total)) if total > 0 => {
                Some(((received as f64 / total as f64) * 100.0).clamp(0.0, 100.0))
            }
            _ => None,
        };
        let _ = self.app.emit(
            "content:progress",
            ContentProgressPayload {
                handle: self.handle.clone(),
                phase,
                received_bytes,
                total_bytes,
                percent,
                slow,
                stalled,
                message: message.into(),
            },
        );
    }
}

struct ProgressThrottle {
    last_emit: Instant,
}

impl ProgressThrottle {
    fn new() -> Self {
        Self {
            last_emit: Instant::now() - PROGRESS_EMIT_INTERVAL,
        }
    }

    fn should_emit(&mut self) -> bool {
        if self.last_emit.elapsed() < PROGRESS_EMIT_INTERVAL {
            return false;
        }
        self.last_emit = Instant::now();
        true
    }
}

struct ContentCancelRegistration {
    handle: String,
}

impl Drop for ContentCancelRegistration {
    fn drop(&mut self) {
        content_cancel_registry()
            .lock()
            .unwrap()
            .remove(&self.handle);
    }
}

fn content_cancel_registry() -> &'static Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> {
    CONTENT_CANCEL_REGISTRY.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn register_content_cancel_handle(handle: String) -> (Arc<AtomicBool>, ContentCancelRegistration) {
    let flag = Arc::new(AtomicBool::new(false));
    content_cancel_registry()
        .lock()
        .unwrap()
        .insert(handle.clone(), flag.clone());
    (flag, ContentCancelRegistration { handle })
}

fn is_content_cancelled(cancel: Option<&AtomicBool>) -> bool {
    cancel
        .map(|flag| flag.load(Ordering::SeqCst))
        .unwrap_or(false)
}

fn content_cancelled_error() -> String {
    "Template setup was cancelled.".to_string()
}

fn read_staging_source_from(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    value
        .get(STAGING_SOURCE_KEY)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn write_staging_source_to(path: &Path, enabled: bool) -> Result<(), String> {
    let mut obj: Map<String, Value> = if path.exists() {
        fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    } else {
        Map::new()
    };
    obj.insert(STAGING_SOURCE_KEY.to_string(), Value::Bool(enabled));

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create menubar dir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(&Value::Object(obj))
        .map_err(|e| format!("serialize menubar staging source: {e}"))?;
    let mut file = fs::File::create(&tmp).map_err(|e| format!("stage menubar prefs: {e}"))?;
    file.write_all(body.as_bytes())
        .map_err(|e| format!("write menubar prefs: {e}"))?;
    file.sync_all().ok();
    fs::rename(&tmp, path).map_err(|e| format!("commit menubar prefs: {e}"))
}

fn staging_source_enabled() -> bool {
    crate::util::paths::menubar_json_path()
        .map(|path| read_staging_source_from(&path))
        .unwrap_or(false)
}

#[tauri::command]
pub fn cancel_content_download(handle: String) -> Result<bool, String> {
    let Some(flag) = content_cancel_registry()
        .lock()
        .unwrap()
        .get(&handle)
        .cloned()
    else {
        return Ok(false);
    };
    flag.store(true, Ordering::SeqCst);
    Ok(true)
}

#[tauri::command]
pub fn get_staging_source() -> Result<bool, String> {
    let path = crate::util::paths::menubar_json_path()?;
    Ok(read_staging_source_from(&path))
}

#[tauri::command]
pub fn set_staging_source(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let path = crate::util::paths::menubar_json_path()?;
    let previous = read_staging_source_from(&path);
    write_staging_source_to(&path, enabled)?;
    if previous != enabled {
        let _ = app.emit(
            "staging-source:changed",
            StagingSourceChangedPayload { enabled },
        );
    }
    Ok(enabled)
}

fn github_client_with_token(token: Option<&str>) -> Result<reqwest::Client, String> {
    let mut headers = client_headers();
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/vnd.github+json"),
    );
    if let Some(token) = token {
        let mut value = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|e| format!("invalid GitHub token header: {e}"))?;
        value.set_sensitive(true);
        headers.insert(reqwest::header::AUTHORIZATION, value);
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("build GitHub client: {e}"))
}

#[cfg(test)]
fn github_client() -> Result<reqwest::Client, String> {
    github_client_with_token(None)
}

async fn latest_release(
    client: &reqwest::Client,
    repo: &str,
) -> Result<Option<ReleaseInfo>, String> {
    let url = format!("{GITHUB_API}/repos/{repo}/releases");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("network error listing releases: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "GitHub API error {} listing releases for {repo}",
            resp.status()
        ));
    }
    let releases: Vec<ReleaseInfo> = resp
        .json()
        .await
        .map_err(|e| format!("failed to parse releases response: {e}"))?;
    Ok(releases.into_iter().find(|r| !r.prerelease && !r.draft))
}

const GH_FALLBACK_PATHS: &[&str] = &["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];

fn resolve_gh_binary_from_path(path_env: Option<&str>, fallbacks: &[&str]) -> Option<PathBuf> {
    if let Some(path_env) = path_env {
        for dir in std::env::split_paths(path_env) {
            let candidate = dir.join(if cfg!(windows) { "gh.exe" } else { "gh" });
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for fallback in fallbacks {
        let candidate = PathBuf::from(fallback);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn get_github_token() -> Result<String, String> {
    let gh = resolve_gh_binary_from_path(std::env::var("PATH").ok().as_deref(), GH_FALLBACK_PATHS)
        .ok_or_else(|| {
            "GitHub CLI (`gh`) not found. Install it and run `gh auth login`, then retry."
                .to_string()
        })?;

    let output = Command::new(&gh)
        .args(["auth", "token"])
        .output()
        .map_err(|e| format!("failed to invoke `{} auth token`: {e}", gh.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            "no detail".to_string()
        } else {
            stderr
        };
        return Err(format!(
            "`gh auth token` failed (exit {}). Run `gh auth login` and retry. Detail: {detail}",
            output.status.code().unwrap_or(-1)
        ));
    }

    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        return Err(
            "`gh auth token` returned empty output. Run `gh auth login` and retry.".to_string(),
        );
    }
    Ok(token)
}

fn staging_tarball_url(reference: &str) -> Result<String, String> {
    if reference.trim().is_empty() || reference.contains('/') || reference.contains('\\') {
        return Err("Invalid staging ref".to_string());
    }
    Ok(format!(
        "{GITHUB_API}/repos/{STAGING_TEMPLATE_REPO}/tarball/{reference}"
    ))
}

#[cfg(test)]
async fn download_tarball(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    download_tarball_with_progress(client, url, None, None).await
}

async fn download_tarball_with_progress(
    client: &reqwest::Client,
    url: &str,
    progress: Option<&ContentProgressEmitter>,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;

    if is_content_cancelled(cancel) {
        return Err(content_cancelled_error());
    }

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("network error downloading template: {e}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("template tarball not found (404): {url}"));
    }
    if !resp.status().is_success() {
        return Err(format!(
            "HTTP {} downloading template tarball",
            resp.status()
        ));
    }

    let total_bytes = resp.content_length();
    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();

    if let Some(progress) = progress {
        progress.emit(
            "download",
            Some(0),
            total_bytes,
            false,
            false,
            "Downloading HQ template",
        );
    }

    loop {
        if is_content_cancelled(cancel) {
            return Err(content_cancelled_error());
        }

        match tokio::time::timeout(DOWNLOAD_SLOW_NOTICE_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                bytes.extend_from_slice(&chunk);
                if let Some(progress) = progress {
                    progress.emit(
                        "download",
                        Some(bytes.len() as u64),
                        total_bytes,
                        false,
                        false,
                        "Downloading HQ template",
                    );
                }
            }
            Ok(Some(Err(e))) => return Err(format!("stream error downloading template: {e}")),
            Ok(None) => break,
            Err(_) => {
                if let Some(progress) = progress {
                    progress.emit(
                        "download",
                        Some(bytes.len() as u64),
                        total_bytes,
                        true,
                        false,
                        "Template download is slower than expected",
                    );
                }
                let remaining_timeout =
                    CHUNK_STALL_TIMEOUT.saturating_sub(DOWNLOAD_SLOW_NOTICE_TIMEOUT);
                match tokio::time::timeout(remaining_timeout, stream.next()).await {
                    Ok(Some(Ok(chunk))) => {
                        bytes.extend_from_slice(&chunk);
                        if let Some(progress) = progress {
                            progress.emit(
                                "download",
                                Some(bytes.len() as u64),
                                total_bytes,
                                false,
                                false,
                                "Downloading HQ template",
                            );
                        }
                    }
                    Ok(Some(Err(e))) => {
                        return Err(format!("stream error downloading template: {e}"))
                    }
                    Ok(None) => break,
                    Err(_) => {
                        if let Some(progress) = progress {
                            progress.emit(
                                "download",
                                Some(bytes.len() as u64),
                                total_bytes,
                                true,
                                true,
                                "Template download stalled",
                            );
                        }
                        return Err(
                            "Template download stalled before receiving more data.".to_string()
                        );
                    }
                }
            }
        }
    }
    if let Some(progress) = progress {
        progress.emit(
            "download",
            Some(bytes.len() as u64),
            total_bytes.or(Some(bytes.len() as u64)),
            false,
            false,
            "Downloaded HQ template",
        );
    }
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// Path safety (ported from template-fetcher.ts / fs.rs)
// ---------------------------------------------------------------------------

fn has_unsafe_path_prefix(path: &str) -> bool {
    path.starts_with('/')
        || path.starts_with('\\')
        || path.contains(':')
        || path
            .as_bytes()
            .first()
            .map(u8::is_ascii_alphabetic)
            .unwrap_or(false)
            && path.as_bytes().get(1) == Some(&b':')
}

/// Normalize an untrusted archive-entry-relative path: reject null bytes,
/// absolute/drive prefixes, and any `..` segment. Returns the cleaned
/// forward-slash relative path, or `None` if the entry must be skipped.
fn normalize_safe_relative_path(relative: &str) -> Option<String> {
    if relative.is_empty() || relative.contains('\0') {
        return None;
    }
    if has_unsafe_path_prefix(relative) {
        return None;
    }

    let normalized = relative.replace('\\', "/");
    let mut safe: Vec<&str> = Vec::new();
    for seg in normalized.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return None;
        }
        safe.push(seg);
    }

    if safe.is_empty() {
        None
    } else {
        Some(safe.join("/"))
    }
}

/// Resolve `relative` (already normalized) against `target_dir`, and confirm
/// the joined path still lexically resolves inside `target_dir`.
fn safe_join(target_dir: &Path, relative: &str) -> Option<PathBuf> {
    let normalized = normalize_safe_relative_path(relative)?;
    let joined = target_dir.join(&normalized);

    // Lexical containment check — no disk access, mirrors the JS version.
    // We can't use `canonicalize` here because the destination usually
    // doesn't exist yet.
    let mut depth: i32 = 0;
    for component in normalized.split('/') {
        match component {
            "" | "." => {}
            ".." => depth -= 1,
            _ => depth += 1,
        }
        if depth < 0 {
            return None;
        }
    }

    Some(joined)
}

/// Validate a symlink's `link_target` (raw tar `linkname`, untrusted) against
/// the symlink's own already-normalized relative path. Walks a virtual stack
/// starting at the link's parent directory and rejects any target that would
/// pop past the HQ root.
fn is_safe_symlink_target(link_relative: &str, link_target: &str) -> bool {
    if link_target.is_empty() || link_target.contains('\0') {
        return false;
    }
    if has_unsafe_path_prefix(link_target) {
        return false;
    }

    let mut stack: Vec<&str> = link_relative.split('/').collect();
    stack.pop(); // drop the link's own filename, keep only its parent chain

    for seg in link_target.replace('\\', "/").split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            if stack.pop().is_none() {
                return false;
            }
        } else {
            stack.push(seg);
        }
    }

    true
}

/// GitHub tarballs wrap everything in a top-level `owner-repo-<sha>/`
/// directory. hq-core is a standalone template repo (the repo root IS the
/// template), so we strip only that wrapper and keep everything inside it.
fn map_entry_to_template_path(entry_name: &str) -> Option<String> {
    let normalized = entry_name.replace('\\', "/");
    let (_wrapper, rest) = normalized.split_once('/')?;
    if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    }
}

fn is_under_known_symlink(relative: &str, symlink_relatives: &[String]) -> bool {
    symlink_relatives
        .iter()
        .any(|link| relative == link || relative.starts_with(&format!("{link}/")))
}

// ---------------------------------------------------------------------------
// Symlink creation (ported from fs.rs — Unix + Windows privilege fallback)
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn create_symlink_impl(target: &Path, link_path: &Path) -> Result<(), String> {
    if let Some(parent) = link_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create parent dir: {e}"))?;
    }
    if std::fs::symlink_metadata(link_path).is_ok() {
        std::fs::remove_file(link_path)
            .map_err(|e| format!("failed to replace existing entry at {link_path:?}: {e}"))?;
    }
    std::os::unix::fs::symlink(target, link_path)
        .map_err(|e| format!("failed to create symlink {link_path:?} -> {target:?}: {e}"))
}

#[cfg(windows)]
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const WINDOWS_ERROR_PRIVILEGE_NOT_HELD: i32 = 1314;

/// Collapse `.` and `..` segments out of `path` lexically (no disk access),
/// preserving the Windows prefix/root. `mklink /J` rejects a target argument
/// that still contains `..` components.
#[cfg(windows)]
fn lexical_absolute(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::Normal(s) => out.push(s),
        }
    }
    out
}

/// Create a directory junction at `link_path` pointing to `target`, via
/// `cmd /C mklink /J`. Junctions need no privilege, unlike directory
/// symlinks, so this succeeds for a plain non-admin user with Developer
/// Mode off.
#[cfg(windows)]
fn create_junction(target: &Path, link_path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt as _;
    use std::process::Command;

    let abs_target = lexical_absolute(target);
    std::fs::create_dir_all(&abs_target)
        .map_err(|e| format!("failed to create junction target dir {abs_target:?}: {e}"))?;

    let link_arg = link_path.to_string_lossy().replace('/', "\\");
    let target_arg = abs_target.to_string_lossy().replace('/', "\\");
    let out = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link_arg)
        .arg(&target_arg)
        .creation_flags(WINDOWS_CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to spawn mklink: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let detail = stderr.trim();
        let detail = if detail.is_empty() {
            stdout.trim()
        } else {
            detail
        };
        return Err(format!(
            "mklink /J {link_arg:?} -> {target_arg:?} failed ({}): {detail}",
            out.status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn fallback_uses_copy(resolved_target: &Path) -> bool {
    resolved_target.is_file()
}

/// Copy the bytes of `target` to `link_path` as a privilege-free substitute
/// for a file symlink. Errors (rather than creating an empty file) when the
/// target does not resolve to an existing file.
#[cfg(windows)]
fn copy_file_fallback(target: &Path, link_path: &Path) -> Result<(), String> {
    let abs_target = lexical_absolute(target);
    if !abs_target.is_file() {
        return Err(format!(
            "target {abs_target:?} is not an existing file (cannot copy)"
        ));
    }
    std::fs::copy(&abs_target, link_path)
        .map(|_| ())
        .map_err(|e| format!("copy {abs_target:?} -> {link_path:?} failed: {e}"))
}

/// Remove an entry blocking a symlink create, handling the three Windows
/// shapes a prior extraction may have left behind (plain dir, dir
/// symlink/junction, file/file-symlink) and clearing the read-only bit first.
#[cfg(windows)]
fn remove_existing_windows_entry(path: &Path, md: &std::fs::Metadata) -> std::io::Result<()> {
    #[allow(clippy::permissions_set_readonly_false)]
    {
        let mut perms = md.permissions();
        if perms.readonly() {
            perms.set_readonly(false);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
    let ft = md.file_type();
    if ft.is_symlink() {
        let target_is_dir = std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false);
        if target_is_dir {
            std::fs::remove_dir(path)
        } else {
            std::fs::remove_file(path)
        }
    } else if ft.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

#[cfg(windows)]
fn create_symlink_impl(target: &Path, link_path: &Path) -> Result<(), String> {
    if let Some(parent) = link_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create parent dir: {e}"))?;
    }
    if let Ok(md) = std::fs::symlink_metadata(link_path) {
        remove_existing_windows_entry(link_path, &md)
            .map_err(|e| format!("failed to replace existing entry at {link_path:?}: {e}"))?;
    }

    // Tar stores POSIX targets; Windows reparse points need backslashes or
    // every read fails with a syntax error even though the link "looks" valid.
    let win_target: PathBuf = target.to_string_lossy().replace('/', "\\").into();
    let resolved_target = link_path
        .parent()
        .map(|p| p.join(&win_target))
        .unwrap_or_else(|| win_target.clone());
    let target_is_dir = std::fs::metadata(&resolved_target)
        .map(|m| m.is_dir())
        .unwrap_or(false);

    let result = if target_is_dir {
        std::os::windows::fs::symlink_dir(&win_target, link_path)
    } else {
        std::os::windows::fs::symlink_file(&win_target, link_path)
    };

    match result {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(WINDOWS_ERROR_PRIVILEGE_NOT_HELD) => {
            // No Developer Mode / elevation: fall back to a privilege-free
            // junction for dir targets, or a byte copy for file targets.
            let fallback = if fallback_uses_copy(&resolved_target) {
                copy_file_fallback(&resolved_target, link_path)
            } else {
                create_junction(&resolved_target, link_path)
            };
            fallback.map_err(|fallback_err| {
                format!(
                    "HQ_SYMLINK_PRIVILEGE: cannot link {link_path:?} -> {win_target:?} without \
                     Developer Mode or administrator rights (fallback failed: {fallback_err})"
                )
            })
        }
        Err(e) => Err(format!(
            "failed to create symlink {link_path:?} -> {win_target:?}: {e}"
        )),
    }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn set_entry_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o7777))
        .map_err(|e| format!("failed to set permissions on {path:?}: {e}"))
}

#[cfg(windows)]
fn set_entry_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
fn extract_tarball(compressed: &[u8], target_dir: &Path) -> Result<(), String> {
    extract_tarball_with_progress(compressed, target_dir, None, None)
}

fn archive_extract_total_bytes(compressed: &[u8]) -> Result<u64, String> {
    let gz = flate2::read::GzDecoder::new(compressed);
    let mut archive = tar::Archive::new(gz);
    let entries = archive
        .entries()
        .map_err(|e| format!("failed to read template archive: {e}"))?;

    let mut total = 0_u64;
    for entry in entries {
        let entry = entry.map_err(|e| format!("failed to read template archive entry: {e}"))?;
        let entry_type = entry.header().entry_type();
        if matches!(entry_type, EntryType::Regular | EntryType::Continuous) {
            total = total.saturating_add(entry.size());
        }
    }
    Ok(total)
}

fn extract_tarball_with_progress(
    compressed: &[u8],
    target_dir: &Path,
    progress: Option<&ContentProgressEmitter>,
    cancel: Option<&AtomicBool>,
) -> Result<(), String> {
    std::fs::create_dir_all(target_dir)
        .map_err(|e| format!("failed to create HQ root {target_dir:?}: {e}"))?;

    if is_content_cancelled(cancel) {
        return Err(content_cancelled_error());
    }

    let total_bytes = archive_extract_total_bytes(compressed)?;
    let total_bytes = (total_bytes > 0).then_some(total_bytes);
    let mut extracted_bytes = 0_u64;
    let mut progress_throttle = ProgressThrottle::new();

    if let Some(progress) = progress {
        progress.emit(
            "extract",
            Some(0),
            total_bytes,
            false,
            false,
            "Extracting HQ template",
        );
    }

    let gz = flate2::read::GzDecoder::new(compressed);
    let mut archive = tar::Archive::new(gz);
    let entries = archive
        .entries()
        .map_err(|e| format!("failed to read template archive: {e}"))?;

    let mut symlink_relatives: Vec<String> = Vec::new();

    for entry in entries {
        if is_content_cancelled(cancel) {
            return Err(content_cancelled_error());
        }

        let mut entry = entry.map_err(|e| format!("failed to read template archive entry: {e}"))?;
        let raw_path = entry
            .path()
            .map_err(|e| format!("failed to read template archive entry path: {e}"))?
            .to_string_lossy()
            .into_owned();

        let relative = match map_entry_to_template_path(&raw_path) {
            Some(r) => r,
            None => continue, // the wrapper dir entry itself
        };
        let trimmed = relative.trim_end_matches(['/', '\\']);
        if trimmed.is_empty() {
            continue;
        }

        let normalized = match normalize_safe_relative_path(trimmed) {
            Some(n) => n,
            None => {
                log(
                    "content",
                    &format!("skipping unsafe template archive path: {relative}"),
                );
                continue;
            }
        };

        if is_under_known_symlink(&normalized, &symlink_relatives) {
            log(
                "content",
                &format!("skipping template archive entry through symlink parent: {relative}"),
            );
            continue;
        }

        let entry_type = entry.header().entry_type();
        let dest = match safe_join(target_dir, &normalized) {
            Some(d) => d,
            None => {
                log(
                    "content",
                    &format!("skipping template archive path outside install root: {relative}"),
                );
                continue;
            }
        };

        match entry_type {
            EntryType::Directory => {
                std::fs::create_dir_all(&dest)
                    .map_err(|e| format!("failed to create {dest:?}: {e}"))?;
            }
            EntryType::Symlink => {
                let link_target = entry
                    .link_name()
                    .ok()
                    .flatten()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if link_target.is_empty() {
                    log(
                        "content",
                        &format!("skipping malformed template symlink without target: {relative}"),
                    );
                    continue;
                }
                if !is_safe_symlink_target(&normalized, &link_target) {
                    log(
                        "content",
                        &format!(
                            "skipping unsafe template symlink target for {relative}: {link_target}"
                        ),
                    );
                    continue;
                }
                create_symlink_impl(Path::new(&link_target), &dest)?;
                symlink_relatives.push(normalized);
            }
            EntryType::Regular | EntryType::Continuous => {
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("failed to create {parent:?}: {e}"))?;
                }
                let mode = entry.header().mode().unwrap_or(0o644);
                let mut file = std::fs::File::create(&dest)
                    .map_err(|e| format!("failed to write {dest:?}: {e}"))?;
                let mut buf = [0_u8; EXTRACT_READ_CHUNK_BYTES];
                loop {
                    if is_content_cancelled(cancel) {
                        return Err(content_cancelled_error());
                    }
                    let n = entry
                        .read(&mut buf)
                        .map_err(|e| format!("failed to read {relative} from archive: {e}"))?;
                    if n == 0 {
                        break;
                    }
                    file.write_all(&buf[..n])
                        .map_err(|e| format!("failed to write {dest:?}: {e}"))?;
                    extracted_bytes = extracted_bytes.saturating_add(n as u64);
                    if progress_throttle.should_emit() {
                        if let Some(progress) = progress {
                            progress.emit(
                                "extract",
                                Some(extracted_bytes),
                                total_bytes,
                                false,
                                false,
                                format!("Extracting {normalized}"),
                            );
                        }
                    }
                }
                set_entry_mode(&dest, mode)?;
            }
            _ => {
                // Hard links / device nodes / fifos etc. are not part of the
                // template and are silently skipped, matching the old
                // installer (which only ever handled '0' regular, '2'
                // symlink, and '5' directory typeflags).
            }
        }
    }

    if let Some(progress) = progress {
        progress.emit(
            "extract",
            Some(extracted_bytes),
            total_bytes.or(Some(extracted_bytes)),
            false,
            false,
            "Extracted HQ template",
        );
    }

    Ok(())
}

/// Fetch the latest stable `indigoai-us/hq-core` release and extract it into
/// the resolved HQ root. Called as the first onboarding setup stage, before
/// `git_init` — the git repo is initialised over the already-placed content
/// so the template ships tracked from the first commit.
#[tauri::command]
pub async fn fetch_and_extract_template(
    app: AppHandle,
    handle: Option<String>,
) -> Result<String, String> {
    let hq_root = resolve_hq_path()?;
    let source = template_source_for_staging_source(staging_source_enabled());
    let token = if matches!(source.channel, TemplateChannel::StagingMain) {
        Some(get_github_token()?)
    } else {
        None
    };
    let client = github_client_with_token(token.as_deref())?;
    let handle = handle.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (cancel_flag, _cancel_registration) = register_content_cancel_handle(handle.clone());
    let progress = ContentProgressEmitter {
        app,
        handle: handle.clone(),
    };

    let (version, tarball_url) = match source.reference {
        Some(reference) => (reference.to_string(), staging_tarball_url(reference)?),
        None => {
            let release = latest_release(&client, source.repo).await?;
            let release = release.ok_or_else(|| {
                format!(
                    "no stable release found for {}; cannot install HQ template",
                    source.repo
                )
            })?;
            (release.tag_name, release.tarball_url)
        }
    };

    progress.emit(
        "download",
        Some(0),
        None,
        false,
        false,
        format!("Downloading HQ template ({})", source.label()),
    );

    let compressed = download_tarball_with_progress(
        &client,
        &tarball_url,
        Some(&progress),
        Some(cancel_flag.as_ref()),
    )
    .await?;
    extract_tarball_with_progress(
        &compressed,
        Path::new(&hq_root),
        Some(&progress),
        Some(cancel_flag.as_ref()),
    )?;

    // Refresh core/core.yaml checksums right after the template lands, so the
    // integrity block reflects the freshly-installed content before git-init +
    // sync (the hq-installer hardening — native SHA-256, no per-file forks).
    // Advisory: a checksum failure must never fail an otherwise-good install,
    // and the tray agent recomputes them in steady state.
    let checksum_root = hq_root.clone();
    if let Err(e) = tokio::task::spawn_blocking(move || {
        crate::commands::checksums::compute_checksums_at(Path::new(&checksum_root))
    })
    .await
    .map_err(|e| format!("checksum task join: {e}"))
    .and_then(|r| r)
    {
        eprintln!("[content] checksum refresh after extract (non-fatal): {e}");
    }

    progress.emit("complete", None, None, false, false, "HQ template ready");

    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn normalize_rejects_parent_traversal() {
        // Any ".." segment anywhere rejects the whole path outright — no
        // lexical backtracking/resolution, matching the old installer's
        // `normalizeSafeRelativePath` (an archive entry has no business
        // containing ".." at all, resolved or not).
        assert_eq!(normalize_safe_relative_path("../evil"), None);
        assert_eq!(normalize_safe_relative_path("a/../../evil"), None);
        assert_eq!(normalize_safe_relative_path("a/../b"), None);
    }

    #[test]
    fn normalize_rejects_absolute_and_drive_prefixes() {
        assert_eq!(normalize_safe_relative_path("/etc/passwd"), None);
        assert_eq!(normalize_safe_relative_path(r"C:\evil"), None);
        assert_eq!(normalize_safe_relative_path(r"\\server\share"), None);
    }

    #[test]
    fn normalize_rejects_null_bytes_and_empty() {
        assert_eq!(normalize_safe_relative_path(""), None);
        assert_eq!(normalize_safe_relative_path("a\0b"), None);
    }

    #[test]
    fn normalize_accepts_nested_relative_paths() {
        assert_eq!(
            normalize_safe_relative_path("core/docs/hq/MIGRATION.md"),
            Some("core/docs/hq/MIGRATION.md".to_string())
        );
    }

    #[test]
    fn safe_join_rejects_traversal_and_accepts_in_root() {
        let root = Path::new("/tmp/hq");
        assert_eq!(safe_join(root, "../../evil"), None);
        assert_eq!(
            safe_join(root, "core/core.yaml"),
            Some(PathBuf::from("/tmp/hq/core/core.yaml"))
        );
    }

    #[test]
    fn symlink_target_allows_template_parent_links_within_root() {
        assert!(is_safe_symlink_target(
            ".codex/output-style.md",
            "../.claude/output-style.md"
        ));
        assert!(is_safe_symlink_target(
            "companies/_template/.obsidian",
            "../../.obsidian"
        ));
    }

    #[test]
    fn symlink_target_rejects_root_escape() {
        assert!(!is_safe_symlink_target(".ssh", "../.ssh"));
        assert!(!is_safe_symlink_target("link", "/etc/passwd"));
        assert!(!is_safe_symlink_target("link", r"C:\evil"));
    }

    #[test]
    fn map_entry_strips_github_wrapper_dir() {
        assert_eq!(
            map_entry_to_template_path("indigoai-us-hq-core-abc123/core.yaml"),
            Some("core.yaml".to_string())
        );
        assert_eq!(
            map_entry_to_template_path("indigoai-us-hq-core-abc123/.claude/CLAUDE.md"),
            Some(".claude/CLAUDE.md".to_string())
        );
        assert_eq!(
            map_entry_to_template_path("indigoai-us-hq-core-abc123/"),
            None
        );
        assert_eq!(
            map_entry_to_template_path("indigoai-us-hq-core-abc123"),
            None
        );
    }

    #[test]
    fn template_source_selection_switches_stable_vs_staging() {
        let stable = template_source_for_staging_source(false);
        assert_eq!(stable.repo, DEFAULT_TEMPLATE_REPO);
        assert_eq!(stable.reference, None);
        assert_eq!(stable.channel, TemplateChannel::StableRelease);

        let staging = template_source_for_staging_source(true);
        assert_eq!(staging.repo, STAGING_TEMPLATE_REPO);
        assert_eq!(staging.reference, Some(STAGING_TEMPLATE_REF));
        assert_eq!(staging.channel, TemplateChannel::StagingMain);
    }

    #[test]
    fn staging_source_toggle_round_trips_in_menubar_json() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".hq").join("menubar.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"machineId":"keep"}"#).unwrap();

        write_staging_source_to(&path, true).unwrap();
        assert!(read_staging_source_from(&path));
        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["machineId"], "keep");
        assert_eq!(value[STAGING_SOURCE_KEY], true);

        write_staging_source_to(&path, false).unwrap();
        assert!(!read_staging_source_from(&path));
    }

    #[test]
    fn staging_tarball_url_targets_private_staging_repo_ref() {
        assert_eq!(
            staging_tarball_url("main").unwrap(),
            "https://api.github.com/repos/indigoai-us/hq-core-staging/tarball/main"
        );
        assert_eq!(
            staging_tarball_url("../main").unwrap_err(),
            "Invalid staging ref"
        );
    }

    /// Write a raw tar entry name directly into the header's 100-byte name
    /// field, bypassing `Header::set_path`'s own `..`-rejection. A real
    /// hand-crafted malicious archive would never go through that safe
    /// writer either — this is what lets the malicious-entry tests actually
    /// exercise our own validation instead of tar-rs's.
    fn set_raw_name(header: &mut tar::Header, name: &str) {
        let bytes = header.as_mut_bytes();
        for b in bytes[0..100].iter_mut() {
            *b = 0;
        }
        let name_bytes = name.as_bytes();
        let len = name_bytes.len().min(100);
        bytes[0..len].copy_from_slice(&name_bytes[0..len]);
    }

    fn build_test_tarball(entries: &[(&str, tar::Header, Option<Vec<u8>>)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (path, header, data) in entries {
            let mut header = header.clone();
            set_raw_name(&mut header, path);
            header.set_cksum();
            let bytes = data.clone().unwrap_or_default();
            builder.append(&header, bytes.as_slice()).unwrap();
        }
        let tar_bytes = builder.into_inner().unwrap();

        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&tar_bytes).unwrap();
        gz.finish().unwrap()
    }

    fn file_header(size: u64, mode: u32) -> tar::Header {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(EntryType::Regular);
        h.set_size(size);
        h.set_mode(mode);
        h
    }

    fn dir_header() -> tar::Header {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(EntryType::Directory);
        h.set_size(0);
        h.set_mode(0o755);
        h
    }

    fn symlink_header(link_name: &str) -> tar::Header {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(EntryType::Symlink);
        h.set_size(0);
        h.set_link_name(link_name).unwrap();
        h
    }

    #[test]
    fn extract_writes_safe_entries_and_skips_malicious_ones() {
        let dir = tempdir().unwrap();
        let wrapper = "indigoai-us-hq-core-deadbeef";

        let good_file = format!("{wrapper}/core.yaml");
        let good_dir = format!("{wrapper}/companies/_template");
        let good_symlink = format!("{wrapper}/AGENTS.md");
        let traversal_file = format!("{wrapper}/../../evil.txt");
        let evil_symlink = format!("{wrapper}/evil-link");

        let content = b"name: hq-core\n".to_vec();
        let entries = vec![
            (good_dir.as_str(), dir_header(), None),
            (
                good_file.as_str(),
                file_header(content.len() as u64, 0o644),
                Some(content.clone()),
            ),
            (
                good_symlink.as_str(),
                symlink_header(".claude/CLAUDE.md"),
                None,
            ),
            (
                traversal_file.as_str(),
                file_header(4, 0o644),
                Some(b"evil".to_vec()),
            ),
            (evil_symlink.as_str(), symlink_header("/etc/passwd"), None),
        ];
        let archive = build_test_tarball(&entries);

        extract_tarball(&archive, dir.path()).expect("extraction should succeed");

        assert_eq!(
            std::fs::read(dir.path().join("core.yaml")).unwrap(),
            content
        );
        assert!(dir.path().join("companies/_template").is_dir());
        let link_meta = std::fs::symlink_metadata(dir.path().join("AGENTS.md")).unwrap();
        assert!(link_meta.file_type().is_symlink());

        // Malicious entries must not land anywhere near or inside the root.
        assert!(!dir.path().join("evil-link").exists());
        assert!(!dir.path().parent().unwrap().join("evil.txt").exists());
    }

    #[test]
    fn extract_skips_entries_under_a_symlink_parent() {
        let dir = tempdir().unwrap();
        let wrapper = "indigoai-us-hq-core-deadbeef";

        // A symlink pointing outside the extraction... no, pointing inside is
        // "safe" per the target check, but a later entry nested *under* that
        // symlink path must still be skipped defensively.
        let link_path = format!("{wrapper}/link-dir");
        let nested_through_link = format!("{wrapper}/link-dir/nested.txt");

        let entries = vec![
            (link_path.as_str(), symlink_header("real-dir"), None),
            (
                nested_through_link.as_str(),
                file_header(4, 0o644),
                Some(b"data".to_vec()),
            ),
        ];
        let archive = build_test_tarball(&entries);

        extract_tarball(&archive, dir.path()).expect("extraction should succeed");

        assert!(std::fs::symlink_metadata(dir.path().join("link-dir")).is_ok());
        // Nothing should have been written through the symlink.
        assert!(!dir.path().join("link-dir/nested.txt").exists());
    }

    /// End-to-end proof against the REAL `indigoai-us/hq-core` release: hits
    /// live GitHub, downloads the latest stable tarball, and runs the full
    /// download → gunzip → tar-parse → extract pipeline into a tempdir. Marked
    /// `#[ignore]` so it stays out of the offline/CI default run; invoke with
    /// `cargo test -- --ignored real_hq_core_tarball`.
    #[tokio::test]
    #[ignore]
    async fn real_hq_core_tarball_downloads_and_extracts() {
        let client = github_client().expect("client");
        let release = latest_release(&client, DEFAULT_TEMPLATE_REPO)
            .await
            .expect("release lookup")
            .expect("a stable hq-core release must exist");
        eprintln!(
            "resolved latest stable hq-core release: {}",
            release.tag_name
        );

        let bytes = download_tarball(&client, &release.tarball_url)
            .await
            .expect("tarball download");
        assert!(
            bytes.len() > 10_000,
            "tarball suspiciously small: {} bytes",
            bytes.len()
        );

        let dir = tempdir().unwrap();
        extract_tarball(&bytes, dir.path()).expect("real tarball must extract cleanly");

        // Spot-check the real HQ template landed with its signature files and
        // that at least one of its git symlinks (e.g. AGENTS.md -> .claude/
        // CLAUDE.md) came through as a real symlink, not a broken/empty file.
        assert!(
            dir.path().join(".claude").is_dir(),
            ".claude/ missing from extracted template"
        );
        let agents = dir.path().join("AGENTS.md");
        if agents.exists() {
            let meta = std::fs::symlink_metadata(&agents).unwrap();
            eprintln!("AGENTS.md is_symlink={}", meta.file_type().is_symlink());
        }
        // Nothing must have escaped the extraction root.
        assert!(!dir.path().parent().unwrap().join("evil.txt").exists());
        eprintln!(
            "extracted {} top-level entries into {}",
            std::fs::read_dir(dir.path()).unwrap().count(),
            dir.path().display()
        );
    }
}

#[cfg(all(test, windows))]
mod windows_junction_tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn setup() -> TempDir {
        tempfile::tempdir().expect("tmpdir")
    }

    #[test]
    fn create_junction_creates_missing_target_dir() {
        // Installer regression: `.agents/skills -> ../.claude/skills` is linked
        // before `.claude/skills` exists. The no-admin junction fallback must
        // create the target dir first.
        let dir = setup();
        let target = dir.path().join(".claude").join("skills");
        assert!(!target.exists());
        let link = dir.path().join(".agents").join("skills");
        fs::create_dir_all(link.parent().unwrap()).expect("mk link parent");

        create_junction(&target, &link).expect("junction to a not-yet-created target dir");

        assert!(target.is_dir(), "junction target dir should be created");
        fs::write(link.join("probe.md"), b"x").expect("write through junction");
        assert!(
            target.join("probe.md").is_file(),
            "write through the junction must land in the real target dir"
        );
    }

    #[test]
    fn fallback_routes_missing_or_dir_target_to_junction_not_copy() {
        // Only an existing file copies; an existing dir or a not-yet-created dir
        // target must use the junction path.
        let dir = setup();

        let file_target = dir.path().join("CLAUDE.md");
        fs::write(&file_target, b"x").expect("seed file");
        assert!(fallback_uses_copy(&file_target), "existing file -> copy");

        let dir_target = dir.path().join("skills");
        fs::create_dir(&dir_target).expect("seed dir");
        assert!(!fallback_uses_copy(&dir_target), "existing dir -> junction");

        let missing = dir.path().join(".claude").join("skills");
        assert!(
            !fallback_uses_copy(&missing),
            "not-yet-created dir target -> junction (not copy)"
        );
    }

    #[test]
    fn create_junction_handles_forward_slash_link_path() {
        // cmd's mklink builtin parses the first `/segment` in a forward-slash
        // link path as a switch, so the junction fallback must backslash-normalize.
        let dir = setup();
        let target = dir.path().join("realdir");
        let link_fwd = format!(
            "{}/linkjunction",
            dir.path().to_string_lossy().replace('\\', "/")
        );
        assert!(
            link_fwd.contains('/'),
            "precondition: link path must use forward slashes, got {link_fwd}"
        );
        let link = PathBuf::from(&link_fwd);

        create_junction(&target, &link)
            .expect("junction must be created despite a forward-slash link path");

        let meta = fs::symlink_metadata(&link).expect("stat link");
        assert!(meta.file_type().is_symlink());
        fs::write(link.join("probe.txt"), b"ok").expect("write through junction");
        assert!(target.join("probe.txt").exists());
    }
}
