//! HQ Work install detection and launcher.
//!
//! Detection is **state**, not a setup trigger: a missing or present app is a
//! boolean for later handoff UI. These commands must never open onboarding,
//! installer, import, or desktop-alt windows.
//!
//! Bundle id: `ai.getindigo.hq-work`.

#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// HQ Work macOS application bundle identifier.
pub const HQ_WORK_BUNDLE_ID: &str = "ai.getindigo.hq-work";

const INSTALL_CACHE_TTL: Duration = Duration::from_secs(45);

static INSTALL_CACHE: Mutex<Option<(bool, Instant)>> = Mutex::new(None);

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
}
