//! Per-process package-use records shared with the hq-cli npm installer.
//!
//! CLI processes publish a small JSON record atomically and remove it on normal
//! exit. Desktop requests exclusive package-update admission with an atomic
//! marker, then waits for each recorded PID/start-time pair to exit. Stale
//! records are removed only while the caller holds the desktop updater lock.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

const STATE_SUBDIR: &str = "hq-cli/package-use";
const WINDOWS_STATE_SUBDIR: &str = "hq-cli/state/package-use";
const UPDATE_REQUEST_NAME: &str = "update.pending.json";
pub const PACKAGE_USE_LEASE_TIMEOUT_ERROR: &str =
    "The HQ CLI is still running. Close active HQ CLI work and retry the update; npm was not started.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageUseLeasePaths {
    pub lease_directory: PathBuf,
    pub update_request_path: PathBuf,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
struct LeaseRecord {
    pid: u32,
    start_time_ms: u64,
    hq_version: String,
}

fn normalized_prefix(prefix: &Path) -> Result<String, String> {
    let canonical = canonicalize_allow_missing(prefix).map_err(|error| {
        format!(
            "Could not resolve the HQ CLI npm prefix ({})",
            error_label(&error)
        )
    })?;
    let mut normalized = canonical.to_string_lossy().replace('\\', "/");
    if normalized.to_ascii_lowercase().starts_with("//?/unc/") {
        normalized.replace_range(..8, "//");
    } else if normalized.starts_with("//?/") {
        normalized.replace_range(..4, "");
    }
    if cfg!(windows) {
        normalized = normalized.to_lowercase();
    }
    Ok(normalized)
}

fn canonicalize_allow_missing(path: &Path) -> io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut missing = Vec::new();
    let mut cursor = absolute.as_path();
    loop {
        match fs::canonicalize(cursor) {
            Ok(mut resolved) => {
                for part in missing.iter().rev() {
                    resolved.push(part);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let Some(name) = cursor.file_name() else {
                    return Err(error);
                };
                missing.push(name.to_os_string());
                let Some(parent) = cursor.parent() else {
                    return Err(error);
                };
                cursor = parent;
            }
            Err(error) => return Err(error),
        }
    }
}

fn error_label(error: &io::Error) -> String {
    error
        .raw_os_error()
        .map(|code| format!("os-error-{code}"))
        .unwrap_or_else(|| format!("{:?}", error.kind()))
}

fn lease_paths(prefix: &Path, state_directory: &Path) -> Result<PackageUseLeasePaths, String> {
    let digest = format!(
        "{:x}",
        Sha256::digest(normalized_prefix(prefix)?.as_bytes())
    );
    let lease_directory = state_directory.join(digest);
    Ok(PackageUseLeasePaths {
        update_request_path: lease_directory.join(UPDATE_REQUEST_NAME),
        lease_directory,
    })
}

fn windows_state_directory(local_app_data: &std::ffi::OsStr) -> PathBuf {
    PathBuf::from(local_app_data).join(WINDOWS_STATE_SUBDIR)
}

/// Return the hq-cli-shared per-prefix lease directory.
pub fn package_use_lease_paths(prefix: &Path) -> Result<PackageUseLeasePaths, String> {
    let state_directory = if cfg!(windows) {
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "LOCALAPPDATA is unavailable for the HQ CLI update lease".to_string())?;
        windows_state_directory(&local_app_data)
    } else {
        let state_home = std::env::var("XDG_STATE_HOME")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let home = state_home
            .as_ref()
            .map(PathBuf::from)
            .or_else(dirs::home_dir)
            .ok_or_else(|| "Could not resolve the HQ CLI state directory".to_string())?;
        let base = if state_home.is_some() {
            home
        } else {
            home.join(".local/state")
        };
        base.join(STATE_SUBDIR)
    };
    lease_paths(prefix, &state_directory)
}

fn create_lease_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path)
    }
}

fn atomic_write(path: &Path, body: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid HQ CLI lease path".to_string())?;
    create_lease_directory(parent).map_err(|error| {
        format!(
            "Could not prepare the HQ CLI update lease ({})",
            error_label(&error)
        )
    })?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = parent.join(format!(
        "{}.{}-{nonce}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|error| {
        format!(
            "Could not create the HQ CLI update lease ({})",
            error_label(&error)
        )
    })?;
    if let Err(error) = file.write_all(body).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temp);
        return Err(format!(
            "Could not write the HQ CLI update lease ({})",
            error_label(&error)
        ));
    }
    drop(file);
    if path.exists() {
        let _ = fs::remove_file(&temp);
        return Err("Another HQ CLI update request is already present".to_string());
    }
    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!(
            "Could not publish the HQ CLI update lease ({})",
            error_label(&error)
        )
    })
}

/// Active update request. The updater's existing cross-process writer lock
/// serializes request creation and stale-record cleanup.
pub struct PackageUseUpdateRequest {
    paths: PackageUseLeasePaths,
    owns_request: bool,
}

/// Keeps new CLI processes out while npm mutates the selected prefix.
pub struct PackageUseUpdateGuard {
    request_path: PathBuf,
}

/// Current-process lease writer used by Rust-side clients and cross-process tests.
pub struct PackageUseCliGuard {
    lease_path: PathBuf,
}

impl PackageUseCliGuard {
    pub fn acquire(prefix: &Path) -> Result<Self, String> {
        let paths = package_use_lease_paths(prefix)?;
        let record = LeaseRecord {
            pid: std::process::id(),
            start_time_ms: current_process_start_time_ms(),
            hq_version: env!("CARGO_PKG_VERSION").to_string(),
        };
        let lease_path = paths
            .lease_directory
            .join(format!("{}-{}.json", record.pid, record.start_time_ms));
        atomic_write(
            &lease_path,
            &serde_json::to_vec(&record).map_err(|error| {
                format!("Could not encode the HQ CLI package-use lease ({error})")
            })?,
        )?;
        Ok(Self { lease_path })
    }
}

impl Drop for PackageUseCliGuard {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.lease_path) {
            if error.kind() != io::ErrorKind::NotFound {
                eprintln!(
                    "HQ CLI package-use lease release failed ({})",
                    error_label(&error)
                );
            }
        }
    }
}

impl PackageUseUpdateRequest {
    pub fn begin(prefix: &Path) -> Result<Self, String> {
        let paths = package_use_lease_paths(prefix)?;
        match fs::read(&paths.update_request_path) {
            Ok(bytes) => {
                let previous = serde_json::from_slice::<LeaseRecord>(&bytes).map_err(|error| {
                    format!("Could not decode the existing HQ CLI update request ({error})")
                })?;
                let live = process_start_time_ms(previous.pid)
                    .is_some_and(|actual| same_process_start(actual, previous.start_time_ms));
                if live {
                    return Err("Another HQ CLI update request is already present".to_string());
                }
                match fs::remove_file(&paths.update_request_path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!(
                            "Could not remove a stale HQ CLI update request ({})",
                            error_label(&error)
                        ))
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Could not read the existing HQ CLI update request ({})",
                    error_label(&error)
                ))
            }
        }
        let record = LeaseRecord {
            pid: std::process::id(),
            start_time_ms: current_process_start_time_ms(),
            hq_version: env!("CARGO_PKG_VERSION").to_string(),
        };
        atomic_write(
            &paths.update_request_path,
            &serde_json::to_vec(&record)
                .map_err(|error| format!("Could not encode the HQ CLI update request ({error})"))?,
        )?;
        Ok(Self {
            paths,
            owns_request: true,
        })
    }

    /// Clear stale reader records under the caller's exclusive updater lock;
    /// return `None` while at least one PID/start-time identity is live.
    pub fn try_acquire(&mut self) -> Result<Option<PackageUseUpdateGuard>, String> {
        let entries = fs::read_dir(&self.paths.lease_directory).map_err(|error| {
            format!(
                "Could not inspect HQ CLI package-use leases ({})",
                error_label(&error)
            )
        })?;
        let mut live = false;
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!(
                    "Could not inspect an HQ CLI package-use lease ({})",
                    error_label(&error)
                )
            })?;
            let path = entry.path();
            if path == self.paths.update_request_path
                || path.extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!(
                        "Could not read an HQ CLI package-use lease ({})",
                        error_label(&error)
                    ))
                }
            };
            let record = serde_json::from_slice::<LeaseRecord>(&bytes).map_err(|error| {
                format!("Could not decode an HQ CLI package-use lease ({error})")
            })?;
            if process_start_time_ms(record.pid)
                .is_some_and(|actual| same_process_start(actual, record.start_time_ms))
            {
                live = true;
            } else {
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!(
                            "Could not remove a stale HQ CLI package-use lease ({})",
                            error_label(&error)
                        ))
                    }
                }
            }
        }
        if live {
            return Ok(None);
        }
        self.owns_request = false;
        Ok(Some(PackageUseUpdateGuard {
            request_path: self.paths.update_request_path.clone(),
        }))
    }

    pub async fn wait(mut self, timeout: Duration) -> Result<PackageUseUpdateGuard, String> {
        let started = tokio::time::Instant::now();
        loop {
            if let Some(guard) = self.try_acquire()? {
                return Ok(guard);
            }
            if started.elapsed() >= timeout {
                return Err(PACKAGE_USE_LEASE_TIMEOUT_ERROR.to_string());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

impl Drop for PackageUseUpdateRequest {
    fn drop(&mut self) {
        if !self.owns_request {
            return;
        }
        if let Err(error) = fs::remove_file(&self.paths.update_request_path) {
            if error.kind() != io::ErrorKind::NotFound {
                eprintln!(
                    "HQ CLI update request release failed ({})",
                    error_label(&error)
                );
            }
        }
    }
}

impl Drop for PackageUseUpdateGuard {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.request_path) {
            if error.kind() != io::ErrorKind::NotFound {
                eprintln!(
                    "HQ CLI update request release failed ({})",
                    error_label(&error)
                );
            }
        }
    }
}

fn same_process_start(actual_ms: u64, recorded_ms: u64) -> bool {
    actual_ms.abs_diff(recorded_ms) <= process_start_tolerance_ms()
}

#[cfg(target_os = "windows")]
fn process_start_time_ms(pid: u32) -> Option<u64> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let result =
        unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) };
    unsafe {
        let _ = CloseHandle(process);
    }
    result.ok()?;
    let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    Some(ticks.saturating_sub(116_444_736_000_000_000) / 10_000)
}

#[cfg(target_os = "linux")]
fn process_start_time_ms(pid: u32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = stat.rfind(')')?;
    let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    let ticks: u64 = fields.get(19)?.parse().ok()?; // field 22, after pid and comm
    let boot = fs::read_to_string("/proc/stat")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("btime "))?
        .parse::<u64>()
        .ok()?;
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if hz <= 0 {
        return None;
    }
    Some(
        boot.saturating_mul(1000)
            .saturating_add(ticks.saturating_mul(1000) / hz as u64),
    )
}

#[cfg(target_os = "macos")]
fn process_start_time_ms(pid: u32) -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if read != size {
        return None;
    }
    let info = unsafe { info.assume_init() };
    Some(
        info.pbi_start_tvsec
            .saturating_mul(1000)
            .saturating_add(info.pbi_start_tvusec / 1000),
    )
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn process_start_time_ms(_pid: u32) -> Option<u64> {
    None
}

fn current_process_start_time_ms() -> u64 {
    process_start_time_ms(std::process::id()).unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    })
}

#[cfg(target_os = "windows")]
fn process_start_tolerance_ms() -> u64 {
    20
}
#[cfg(target_os = "linux")]
fn process_start_tolerance_ms() -> u64 {
    20
}
#[cfg(target_os = "macos")]
fn process_start_tolerance_ms() -> u64 {
    20
}
#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn process_start_tolerance_ms() -> u64 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fixture() -> (tempfile::TempDir, PackageUseLeasePaths) {
        let temp = tempdir().unwrap();
        let prefix = temp.path().join("npm-prefix");
        fs::create_dir_all(&prefix).unwrap();
        let paths = lease_paths(&prefix, &temp.path().join("state")).unwrap();
        create_lease_directory(&paths.lease_directory).unwrap();
        (temp, paths)
    }

    fn record(path: &Path, pid: u32, start_time_ms: u64) {
        let value = LeaseRecord {
            pid,
            start_time_ms,
            hq_version: "5.304.0".to_string(),
        };
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    #[test]
    fn desktop_paths_use_a_per_prefix_directory_and_shared_state_root() {
        let temp = tempdir().unwrap();
        let prefix = temp.path().join("prefix");
        fs::create_dir_all(&prefix).unwrap();
        let paths = lease_paths(&prefix, &temp.path().join("state")).unwrap();
        assert_eq!(
            paths.update_request_path.file_name().unwrap(),
            UPDATE_REQUEST_NAME
        );
        assert!(paths
            .update_request_path
            .starts_with(&paths.lease_directory));
        assert!(!paths
            .lease_directory
            .to_string_lossy()
            .contains(&prefix.to_string_lossy().to_string()));
    }

    #[test]
    fn a_live_lease_blocks_package_mutation() {
        let (_temp, paths) = fixture();
        let start = process_start_time_ms(std::process::id()).unwrap();
        record(
            &paths
                .lease_directory
                .join(format!("{}-{start}.json", std::process::id())),
            std::process::id(),
            start,
        );
        let mut request = PackageUseUpdateRequest::begin_at(paths).unwrap();
        assert!(request.try_acquire().unwrap().is_none());
    }

    #[test]
    fn a_dead_pid_lease_is_removed_and_does_not_block_mutation() {
        let (_temp, paths) = fixture();
        let file = paths.lease_directory.join("4294967295-1.json");
        record(&file, u32::MAX, 1);
        let mut request = PackageUseUpdateRequest::begin_at(paths).unwrap();
        assert!(request.try_acquire().unwrap().is_some());
        assert!(!file.exists());
    }

    #[test]
    fn a_reused_pid_with_a_different_start_time_is_stale() {
        let (_temp, paths) = fixture();
        let actual = process_start_time_ms(std::process::id()).unwrap();
        let different = actual.saturating_sub(60_000);
        let file = paths
            .lease_directory
            .join(format!("{}-{different}.json", std::process::id()));
        record(&file, std::process::id(), different);
        let mut request = PackageUseUpdateRequest::begin_at(paths).unwrap();
        assert!(request.try_acquire().unwrap().is_some());
        assert!(!file.exists());
    }

    impl PackageUseUpdateRequest {
        fn begin_at(paths: PackageUseLeasePaths) -> Result<Self, String> {
            let record = LeaseRecord {
                pid: std::process::id(),
                start_time_ms: current_process_start_time_ms(),
                hq_version: "test".to_string(),
            };
            atomic_write(
                &paths.update_request_path,
                &serde_json::to_vec(&record).unwrap(),
            )?;
            Ok(Self {
                paths,
                owns_request: true,
            })
        }
    }

    #[test]
    fn windows_state_directory_matches_cli_contract() {
        let actual = windows_state_directory(std::ffi::OsStr::new(r"C:\Users\me\AppData\Local"));
        assert_eq!(
            actual.to_string_lossy().replace('\\', "/"),
            r"C:/Users/me/AppData/Local/hq-cli/state/package-use"
        );
    }
}
