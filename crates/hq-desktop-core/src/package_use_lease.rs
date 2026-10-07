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

use crate::package_root::LEGACY_ROOT_ID;
use sha2::{Digest, Sha256};

const STATE_SUBDIR: &str = "hq-cli/package-use";
const WINDOWS_STATE_SUBDIR: &str = "hq-cli/state/package-use";
const UPDATE_REQUEST_NAME: &str = "update.pending.json";
const DEFAULT_MAX_PACKAGE_USE_HOLDER_AGE_MS: u64 = 3 * 60 * 60 * 1000;
const MAX_PACKAGE_USE_HOLDER_AGE_ENV: &str = "HQ_CLI_PACKAGE_USE_MAX_HOLDER_AGE_MS";
// The Node writer and macOS kernel reader derive process-start timestamps from
// separate sources. Keep this bounded allowance specific to macOS.
#[cfg(any(target_os = "macos", test))]
const MACOS_PROCESS_START_TOLERANCE_MS: u64 = 1_000;
pub const PACKAGE_USE_LEASE_TIMEOUT_ERROR: &str =
    "The HQ CLI is still running. Close active HQ CLI work and retry the update; npm was not started.";
const ROOT_SCOPED_ADMISSION_PRECONDITION_FAILED: &str =
    "Root-scoped package-use admission precondition failed: current hq-cli readers do not inspect root IDs";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageUseLeasePaths {
    pub lease_directory: PathBuf,
    pub update_request_path: PathBuf,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct LeaseRecord {
    pub pid: u32,
    pub start_time_ms: u64,
    pub hq_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
}

impl LeaseRecord {
    /// Return the validated root identity, treating missing or invalid values as legacy.
    pub fn effective_root_id(&self) -> &str {
        self.root_id
            .as_deref()
            .filter(|root_id| is_valid_root_id(root_id))
            .unwrap_or(LEGACY_ROOT_ID)
    }
}

fn is_valid_root_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(*byte, b'.' | b'_' | b'-')
        })
}

/// Split records that have already passed the package-use liveness filter.
/// Invalid target ids use the same legacy identity as invalid record values.
pub fn split_live_records_by_root<'a>(
    records: &'a [LeaseRecord],
    target_root_id: &str,
) -> (Vec<&'a LeaseRecord>, Vec<&'a LeaseRecord>) {
    let target_root_id = if is_valid_root_id(target_root_id) {
        target_root_id
    } else {
        LEGACY_ROOT_ID
    };
    let (same_root, other_root): (Vec<_>, Vec<_>) = records
        .iter()
        .partition(|record| record.effective_root_id() == target_root_id);
    (same_root, other_root)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveHolderCountBucket {
    Zero,
    One,
    TwoToThree,
    FourPlus,
}

impl LiveHolderCountBucket {
    pub fn as_tag(self) -> &'static str {
        match self {
            Self::Zero => "0",
            Self::One => "1",
            Self::TwoToThree => "2-3",
            Self::FourPlus => "4+",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HolderVersionBucket {
    Pre53424,
    Current,
    Mixed,
    Unknown,
}

impl HolderVersionBucket {
    pub fn as_tag(self) -> &'static str {
        match self {
            Self::Pre53424 => "pre_5_342_4",
            Self::Current => "current",
            Self::Mixed => "mixed",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HolderAgeBucket {
    Under10m,
    From10mTo1h,
    From1hTo24h,
    Over24h,
    Unknown,
}

impl HolderAgeBucket {
    pub fn as_tag(self) -> &'static str {
        match self {
            Self::Under10m => "<10m",
            Self::From10mTo1h => "10m-1h",
            Self::From1hTo24h => "1h-24h",
            Self::Over24h => ">24h",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HolderPurposeBucket {
    Absent,
    Command,
    ResidentPreload,
    McpServe,
    Hook,
    Daemon,
    Unknown,
}

impl HolderPurposeBucket {
    pub fn as_tag(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Command => "command",
            Self::ResidentPreload => "resident-preload",
            Self::McpServe => "mcp-serve",
            Self::Hook => "hook",
            Self::Daemon => "daemon",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PackageUseLeaseTimeoutSummary {
    pub live_holder_count: LiveHolderCountBucket,
    pub same_root_live_holder_count: LiveHolderCountBucket,
    pub other_root_live_holder_count: LiveHolderCountBucket,
    pub holder_version: HolderVersionBucket,
    pub oldest_holder_age: HolderAgeBucket,
    pub oldest_holder_purpose: HolderPurposeBucket,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PackageUseLeaseRootSummary {
    pub same_root: PackageUseLeaseTimeoutSummary,
    pub other_root: PackageUseLeaseTimeoutSummary,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PackageUseLeaseWaitError {
    Timeout(PackageUseLeaseTimeoutSummary),
    Other(String),
}

impl std::fmt::Display for PackageUseLeaseWaitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Timeout(_) => f.write_str(PACKAGE_USE_LEASE_TIMEOUT_ERROR),
            Self::Other(error) => f.write_str(error),
        }
    }
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

fn live_holder_count_bucket(count: usize) -> LiveHolderCountBucket {
    match count {
        0 => LiveHolderCountBucket::Zero,
        1 => LiveHolderCountBucket::One,
        2..=3 => LiveHolderCountBucket::TwoToThree,
        _ => LiveHolderCountBucket::FourPlus,
    }
}

fn classify_holder_version_bucket<'a>(
    versions: impl IntoIterator<Item = Option<&'a str>>,
) -> HolderVersionBucket {
    let threshold = semver::Version::new(5, 342, 4);
    let mut has_pre = false;
    let mut has_current = false;
    let mut found = false;

    for version in versions {
        found = true;
        let Some(version) = version.and_then(|value| semver::Version::parse(value).ok()) else {
            return HolderVersionBucket::Unknown;
        };
        if version < threshold {
            has_pre = true;
        } else {
            has_current = true;
        }
    }

    match (found, has_pre, has_current) {
        (false, _, _) => HolderVersionBucket::Unknown,
        (_, true, true) => HolderVersionBucket::Mixed,
        (_, true, false) => HolderVersionBucket::Pre53424,
        (_, false, true) => HolderVersionBucket::Current,
        _ => HolderVersionBucket::Unknown,
    }
}

fn holder_age_bucket(age_ms: Option<u64>) -> HolderAgeBucket {
    match age_ms {
        Some(age) if age < 10 * 60 * 1000 => HolderAgeBucket::Under10m,
        Some(age) if age < 60 * 60 * 1000 => HolderAgeBucket::From10mTo1h,
        Some(age) if age <= 24 * 60 * 60 * 1000 => HolderAgeBucket::From1hTo24h,
        Some(_) => HolderAgeBucket::Over24h,
        None => HolderAgeBucket::Unknown,
    }
}

fn holder_purpose_bucket(purpose: Option<&str>) -> HolderPurposeBucket {
    match purpose {
        None => HolderPurposeBucket::Absent,
        Some("command") => HolderPurposeBucket::Command,
        Some("resident-preload") => HolderPurposeBucket::ResidentPreload,
        Some("mcp-serve") => HolderPurposeBucket::McpServe,
        Some("hook") => HolderPurposeBucket::Hook,
        Some("daemon") => HolderPurposeBucket::Daemon,
        Some(_) => HolderPurposeBucket::Unknown,
    }
}

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn timeout_summary(records: &[LeaseRecord], now_ms: u64) -> PackageUseLeaseTimeoutSummary {
    let versions = records
        .iter()
        .map(|record| (!record.hq_version.is_empty()).then_some(record.hq_version.as_str()));
    let mut oldest_age_ms = None;
    let mut age_unknown = records.is_empty();
    for record in records {
        match now_ms.checked_sub(record.start_time_ms) {
            Some(age) => {
                oldest_age_ms = Some(oldest_age_ms.map_or(age, |oldest: u64| oldest.max(age)))
            }
            None => age_unknown = true,
        }
    }
    let oldest_holder_purpose = records
        .iter()
        .min_by_key(|record| record.start_time_ms)
        .map(|record| holder_purpose_bucket(record.purpose.as_deref()))
        .unwrap_or(HolderPurposeBucket::Absent);
    PackageUseLeaseTimeoutSummary {
        live_holder_count: live_holder_count_bucket(records.len()),
        same_root_live_holder_count: live_holder_count_bucket(records.len()),
        other_root_live_holder_count: LiveHolderCountBucket::Zero,
        holder_version: classify_holder_version_bucket(versions),
        oldest_holder_age: if age_unknown {
            HolderAgeBucket::Unknown
        } else {
            holder_age_bucket(oldest_age_ms)
        },
        oldest_holder_purpose,
    }
}

fn root_scoped_timeout_summary(
    records: &[LeaseRecord],
    target_root_id: &str,
    now_ms: u64,
) -> PackageUseLeaseRootSummary {
    let (same_root, other_root) = split_live_records_by_root(records, target_root_id);
    let same_root: Vec<_> = same_root.into_iter().cloned().collect();
    let other_root: Vec<_> = other_root.into_iter().cloned().collect();
    PackageUseLeaseRootSummary {
        same_root: timeout_summary(&same_root, now_ms),
        other_root: timeout_summary(&other_root, now_ms),
    }
}

fn lease_record_is_live(record: &LeaseRecord) -> bool {
    process_start_time_ms(record.pid)
        .is_some_and(|actual| same_process_start(actual, record.start_time_ms))
}

fn maximum_package_use_holder_age_ms_from(value: Option<&str>) -> u64 {
    value
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_PACKAGE_USE_HOLDER_AGE_MS)
}

fn maximum_package_use_holder_age_ms() -> u64 {
    maximum_package_use_holder_age_ms_from(
        std::env::var(MAX_PACKAGE_USE_HOLDER_AGE_ENV)
            .ok()
            .as_deref(),
    )
}

fn lease_file_exceeds_maximum_hold(
    modified_at: Option<std::time::SystemTime>,
    now_ms: u64,
    maximum_age_ms: u64,
) -> bool {
    modified_at
        .and_then(|modified_at| modified_at.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|modified_at| u64::try_from(modified_at.as_millis()).ok())
        .and_then(|modified_at_ms| now_ms.checked_sub(modified_at_ms))
        .is_some_and(|age_ms| age_ms > maximum_age_ms)
}

fn scan_live_lease_records(paths: &PackageUseLeasePaths) -> Result<Vec<LeaseRecord>, String> {
    let entries = fs::read_dir(&paths.lease_directory).map_err(|error| {
        format!(
            "Could not inspect HQ CLI package-use leases ({})",
            error_label(&error)
        )
    })?;
    let mut live_records = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "Could not inspect an HQ CLI package-use lease ({})",
                error_label(&error)
            )
        })?;
        let path = entry.path();
        if path == paths.update_request_path
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
        let record = serde_json::from_slice::<LeaseRecord>(&bytes)
            .map_err(|error| format!("Could not decode an HQ CLI package-use lease ({error})"))?;
        if lease_record_is_live(&record) {
            live_records.push(record);
        }
    }
    Ok(live_records)
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
    target_root_id: String,
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
            purpose: None,
            root_id: None,
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
        Self::begin_at_with_root_id(paths, None)
    }

    /// Create an updater request for a root the desktop is about to mutate.
    /// Invalid target IDs retain the legacy prefix-wide behavior.
    pub fn begin_for_root(prefix: &Path, target_root_id: &str) -> Result<Self, String> {
        let paths = package_use_lease_paths(prefix)?;
        let target_root_id = if is_valid_root_id(target_root_id) {
            target_root_id
        } else {
            LEGACY_ROOT_ID
        };
        Self::begin_at_with_root_id(paths, Some(target_root_id))
    }

    fn begin_at_with_root_id(
        paths: PackageUseLeasePaths,
        root_id: Option<&str>,
    ) -> Result<Self, String> {
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
            purpose: None,
            root_id: root_id.map(str::to_owned),
        };
        atomic_write(
            &paths.update_request_path,
            &serde_json::to_vec(&record)
                .map_err(|error| format!("Could not encode the HQ CLI update request ({error})"))?,
        )?;
        Ok(Self {
            paths,
            owns_request: true,
            target_root_id: root_id
                .filter(|root_id| is_valid_root_id(root_id))
                .unwrap_or(LEGACY_ROOT_ID)
                .to_owned(),
        })
    }

    /// Read live holders and summarize them relative to a target package root.
    /// This snapshot is read-only; dead records are excluded but not removed.
    pub fn live_holder_summary_by_root(
        &self,
        target_root_id: &str,
    ) -> Result<PackageUseLeaseRootSummary, String> {
        let live_records = scan_live_lease_records(&self.paths)?;
        Ok(root_scoped_timeout_summary(
            &live_records,
            target_root_id,
            now_epoch_ms(),
        ))
    }

    /// Clear stale reader records under the caller's exclusive updater lock;
    /// return `None` while at least one PID/start-time identity is live.
    fn try_acquire_with_live_records(
        &mut self,
    ) -> Result<(Option<PackageUseUpdateGuard>, Vec<LeaseRecord>), String> {
        self.try_acquire_with_live_records_at(now_epoch_ms())
    }

    fn try_acquire_with_live_records_at(
        &mut self,
        now_ms: u64,
    ) -> Result<(Option<PackageUseUpdateGuard>, Vec<LeaseRecord>), String> {
        let entries = fs::read_dir(&self.paths.lease_directory).map_err(|error| {
            format!(
                "Could not inspect HQ CLI package-use leases ({})",
                error_label(&error)
            )
        })?;
        let mut live_records = Vec::new();
        let maximum_hold_age_ms = maximum_package_use_holder_age_ms();
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
            let lease_modified_at = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok());
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
            // Three hours is far above normal npm package operations, while
            // the observed incident distribution is dominated by holders over
            // 24 hours. Preserve every young live holder (including daemon and
            // MCP purposes); reclaim an over-ceiling holder regardless of its
            // optional purpose field while this caller owns the updater lock.
            if lease_record_is_live(&record)
                && !lease_file_exceeds_maximum_hold(lease_modified_at, now_ms, maximum_hold_age_ms)
            {
                live_records.push(record);
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
        if !live_records.is_empty() {
            return Ok((None, live_records));
        }
        self.owns_request = false;
        Ok((
            Some(PackageUseUpdateGuard {
                request_path: self.paths.update_request_path.clone(),
            }),
            live_records,
        ))
    }

    /// Root-scoped admission requires current hq-cli readers to inspect root IDs.
    pub fn try_acquire_for_root(
        &mut self,
        target_root_id: &str,
    ) -> Result<Option<PackageUseUpdateGuard>, String> {
        if target_root_id != LEGACY_ROOT_ID {
            return Err(ROOT_SCOPED_ADMISSION_PRECONDITION_FAILED.to_string());
        }
        self.try_acquire()
    }

    /// Root-scoped admission requires current hq-cli readers to inspect root IDs.
    pub async fn wait_for_root_with_summary(
        self,
        target_root_id: &str,
        timeout: Duration,
    ) -> Result<PackageUseUpdateGuard, PackageUseLeaseWaitError> {
        if target_root_id != LEGACY_ROOT_ID {
            return Err(PackageUseLeaseWaitError::Other(
                ROOT_SCOPED_ADMISSION_PRECONDITION_FAILED.to_string(),
            ));
        }
        self.wait_with_summary(timeout).await
    }

    /// Clear stale leases and report whether any live holder still blocks the update.
    pub fn try_acquire(&mut self) -> Result<Option<PackageUseUpdateGuard>, String> {
        self.try_acquire_with_live_records()
            .map(|(guard, _live_records)| guard)
    }

    pub async fn wait(self, timeout: Duration) -> Result<PackageUseUpdateGuard, String> {
        self.wait_with_summary(timeout)
            .await
            .map_err(|error| error.to_string())
    }

    /// Wait as before, retaining a bounded snapshot of live records only if the
    /// existing timeout expires.
    pub async fn wait_with_summary(
        self,
        timeout: Duration,
    ) -> Result<PackageUseUpdateGuard, PackageUseLeaseWaitError> {
        self.wait_with_summary_using(timeout, |request, root_id| {
            request.live_holder_summary_by_root(root_id)
        })
        .await
    }

    async fn wait_with_summary_using<F>(
        mut self,
        timeout: Duration,
        mut summarize: F,
    ) -> Result<PackageUseUpdateGuard, PackageUseLeaseWaitError>
    where
        F: FnMut(&Self, &str) -> Result<PackageUseLeaseRootSummary, String>,
    {
        let started = tokio::time::Instant::now();
        loop {
            let (guard, live_records) = self
                .try_acquire_with_live_records()
                .map_err(PackageUseLeaseWaitError::Other)?;
            if let Some(guard) = guard {
                return Ok(guard);
            }
            if started.elapsed() >= timeout {
                let mut summary = timeout_summary(&live_records, now_epoch_ms());
                match summarize(&self, &self.target_root_id) {
                    Ok(roots) => {
                        summary.same_root_live_holder_count = roots.same_root.live_holder_count;
                        summary.other_root_live_holder_count = roots.other_root.live_holder_count;
                    }
                    Err(error) => {
                        eprintln!("HQ CLI package-use timeout summary unavailable ({error})");
                    }
                }
                return Err(PackageUseLeaseWaitError::Timeout(summary));
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
    let tolerance_ms = process_start_tolerance_ms();
    // Debug and test builds only: report the first observed delta per process
    // so CI can measure the macOS skew. Written straight to stderr because the
    // test harness hides eprintln! output of passing tests. Release builds do
    // not include it, and it does not affect liveness.
    #[cfg(all(target_os = "macos", debug_assertions))]
    {
        use std::io::Write;
        static SKEW_DIAGNOSTIC_EMITTED: std::sync::atomic::AtomicBool =
            std::sync::atomic::AtomicBool::new(false);
        let delta_ms = actual_ms.abs_diff(recorded_ms);
        if !SKEW_DIAGNOSTIC_EMITTED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            let _ = writeln!(
                std::io::stderr(),
                "HQ CLI package-use lease process-start delta: {delta_ms}ms (tolerance {tolerance_ms}ms)"
            );
        }
    }
    same_process_start_with_tolerance(actual_ms, recorded_ms, tolerance_ms)
}

fn same_process_start_with_tolerance(actual_ms: u64, recorded_ms: u64, tolerance_ms: u64) -> bool {
    actual_ms.abs_diff(recorded_ms) <= tolerance_ms
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
    // `btime` is only whole-second precision; uptime plus the current wall clock
    // recovers the sub-second boot epoch needed to compare against Node's origin.
    let uptime = fs::read_to_string("/proc/uptime")
        .ok()?
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    let boot_epoch_ms = linux_boot_epoch_ms(boot, uptime, now_ms)?;
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if hz <= 0 {
        return None;
    }
    Some(boot_epoch_ms.saturating_add(ticks.saturating_mul(1000) / hz as u64))
}

#[cfg(target_os = "linux")]
fn linux_boot_epoch_ms(btime_seconds: u64, uptime_seconds: f64, now_ms: u64) -> Option<u64> {
    if !uptime_seconds.is_finite() || uptime_seconds < 0.0 {
        return None;
    }
    let uptime_ms = (uptime_seconds * 1000.0).round() as u64;
    let precise_boot_epoch_ms = now_ms.saturating_sub(uptime_ms);
    let coarse_boot_epoch_ms = btime_seconds.saturating_mul(1000);
    if precise_boot_epoch_ms.abs_diff(coarse_boot_epoch_ms) > 1000 {
        return Some(coarse_boot_epoch_ms);
    }
    Some(precise_boot_epoch_ms)
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
    MACOS_PROCESS_START_TOLERANCE_MS
}
#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn process_start_tolerance_ms() -> u64 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::time::UNIX_EPOCH;
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
        record_with_root(path, pid, start_time_ms, None);
    }

    fn record_with_root(path: &Path, pid: u32, start_time_ms: u64, root_id: Option<&str>) {
        record_with_details(path, pid, start_time_ms, "5.304.0", None, root_id);
    }

    fn record_with_details(
        path: &Path,
        pid: u32,
        start_time_ms: u64,
        hq_version: &str,
        purpose: Option<&str>,
        root_id: Option<&str>,
    ) {
        let value = LeaseRecord {
            pid,
            start_time_ms,
            hq_version: hq_version.to_string(),
            purpose: purpose.map(str::to_string),
            root_id: root_id.map(str::to_string),
        };
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    fn set_file_modified_time_ms(path: &Path, modified_at_ms: u64) {
        let modified_at = UNIX_EPOCH + Duration::from_millis(modified_at_ms);
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified_at))
            .unwrap();
    }

    #[test]
    fn package_use_holder_age_override_is_positive_and_falls_back_to_default() {
        assert_eq!(
            maximum_package_use_holder_age_ms_from(None),
            DEFAULT_MAX_PACKAGE_USE_HOLDER_AGE_MS
        );
        assert_eq!(
            maximum_package_use_holder_age_ms_from(Some("invalid")),
            DEFAULT_MAX_PACKAGE_USE_HOLDER_AGE_MS
        );
        assert_eq!(
            maximum_package_use_holder_age_ms_from(Some("0")),
            DEFAULT_MAX_PACKAGE_USE_HOLDER_AGE_MS
        );
        assert_eq!(maximum_package_use_holder_age_ms_from(Some("1200")), 1200);
    }

    fn record_with_version(path: &Path, pid: u32, start_time_ms: u64, hq_version: &str) {
        let value = LeaseRecord {
            pid,
            start_time_ms,
            hq_version: hq_version.to_string(),
            purpose: None,
            root_id: None,
        };
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    #[test]
    fn lease_record_accepts_missing_and_unknown_fields_and_optional_purpose() {
        let legacy: LeaseRecord =
            serde_json::from_str(r#"{"pid":1,"start_time_ms":2,"hq_version":"5.342.4"}"#).unwrap();
        assert_eq!(legacy.purpose, None);
        assert_eq!(legacy.effective_root_id(), LEGACY_ROOT_ID);

        let with_purpose: LeaseRecord = serde_json::from_str(
            r#"{"pid":1,"start_time_ms":2,"hq_version":"5.342.4","purpose":"resident-preload","future_field":true}"#,
        )
        .unwrap();
        assert_eq!(with_purpose.purpose.as_deref(), Some("resident-preload"));

        let unknown_purpose: LeaseRecord = serde_json::from_str(
            r#"{"pid":1,"start_time_ms":2,"hq_version":"5.342.4","purpose":"future-worker"}"#,
        )
        .unwrap();
        assert_eq!(
            holder_purpose_bucket(unknown_purpose.purpose.as_deref()),
            HolderPurposeBucket::Unknown
        );
    }

    #[test]
    fn lease_record_root_id_is_optional_and_validated() {
        let legacy: LeaseRecord =
            serde_json::from_str(r#"{"pid":1,"start_time_ms":2,"hq_version":"5.342.4"}"#).unwrap();
        assert_eq!(legacy.root_id, None);
        assert_eq!(legacy.effective_root_id(), "legacy");

        let valid: LeaseRecord = serde_json::from_str(
            r#"{"pid":1,"start_time_ms":2,"hq_version":"5.342.4","root_id":"team.root-1_a"}"#,
        )
        .unwrap();
        assert_eq!(valid.root_id.as_deref(), Some("team.root-1_a"));
        assert_eq!(valid.effective_root_id(), "team.root-1_a");

        let too_long = "a".repeat(65);
        for invalid in ["Upper", "a/b", too_long.as_str(), ""] {
            let json = format!(
                r#"{{"pid":1,"start_time_ms":2,"hq_version":"5.342.4","root_id":"{invalid}"}}"#
            );
            let record: LeaseRecord = serde_json::from_str(&json).unwrap();
            assert_eq!(record.effective_root_id(), "legacy", "root_id={invalid:?}");
        }
    }

    #[test]
    fn live_holder_split_groups_legacy_and_other_roots() {
        let records: Vec<LeaseRecord> = [
            r#"{"pid":1,"start_time_ms":1,"hq_version":"5.342.4"}"#,
            r#"{"pid":2,"start_time_ms":2,"hq_version":"5.342.4","root_id":"legacy"}"#,
            r#"{"pid":3,"start_time_ms":3,"hq_version":"5.342.4","root_id":"bad/root"}"#,
            r#"{"pid":4,"start_time_ms":4,"hq_version":"5.342.4","root_id":"root-b"}"#,
        ]
        .into_iter()
        .map(|json| serde_json::from_str(json).unwrap())
        .collect();

        let (same_root, other_root) = split_live_records_by_root(&records, "legacy");
        assert_eq!(
            same_root
                .iter()
                .map(|record| record.pid)
                .collect::<Vec<_>>(),
            [1, 2, 3]
        );
        assert_eq!(
            other_root
                .iter()
                .map(|record| record.pid)
                .collect::<Vec<_>>(),
            [4]
        );
    }

    #[test]
    fn root_scoped_live_summary_splits_roots_and_excludes_dead_records() {
        let (_temp, paths) = fixture();
        let pid = std::process::id();
        let start_time_ms = process_start_time_ms(pid).unwrap();
        record_with_details(
            &paths
                .lease_directory
                .join(format!("{pid}-{start_time_ms}.json")),
            pid,
            start_time_ms,
            "5.342.3",
            Some("hook"),
            None,
        );
        record_with_details(
            &paths
                .lease_directory
                .join(format!("{pid}-{start_time_ms}-other.json")),
            pid,
            start_time_ms,
            "5.342.4",
            Some("daemon"),
            Some("root-b"),
        );
        record_with_root(&paths.lease_directory.join("stale.json"), u32::MAX, 1, None);
        record_with_root(
            &paths.lease_directory.join("stale-other.json"),
            u32::MAX,
            1,
            Some("root-b"),
        );

        let request = PackageUseUpdateRequest::begin_at(paths).unwrap();
        let summary = request.live_holder_summary_by_root("legacy").unwrap();
        assert_eq!(
            summary.same_root.live_holder_count,
            LiveHolderCountBucket::One
        );
        assert_eq!(
            summary.other_root.live_holder_count,
            LiveHolderCountBucket::One
        );
        assert_eq!(
            summary.same_root.holder_version,
            HolderVersionBucket::Pre53424
        );
        assert_eq!(
            summary.other_root.holder_version,
            HolderVersionBucket::Current
        );
        assert_eq!(
            summary.same_root.oldest_holder_purpose,
            HolderPurposeBucket::Hook
        );
        assert_eq!(
            summary.other_root.oldest_holder_purpose,
            HolderPurposeBucket::Daemon
        );
        assert_ne!(
            summary.same_root.oldest_holder_age,
            HolderAgeBucket::Unknown
        );
        assert_eq!(
            summary.same_root.oldest_holder_age,
            summary.other_root.oldest_holder_age
        );
    }

    #[test]
    fn legacy_root_summary_matches_prefix_wide_for_legacy_records() {
        let (_temp, paths) = fixture();
        let pid = std::process::id();
        let start_time_ms = process_start_time_ms(pid).unwrap();
        record(
            &paths
                .lease_directory
                .join(format!("{pid}-{start_time_ms}.json")),
            pid,
            start_time_ms,
        );
        record(
            &paths
                .lease_directory
                .join(format!("{pid}-{start_time_ms}-second.json")),
            pid,
            start_time_ms,
        );

        let request = PackageUseUpdateRequest::begin_at(paths.clone()).unwrap();
        let live_records = scan_live_lease_records(&paths).unwrap();
        let now_ms = 1_000_000_000_000;
        let prefix_wide = timeout_summary(&live_records, now_ms);
        let legacy_target = root_scoped_timeout_summary(&live_records, "legacy", now_ms);
        let invalid_target = root_scoped_timeout_summary(&live_records, "Bad/Root", now_ms);

        assert_eq!(legacy_target.same_root, prefix_wide);
        assert_eq!(invalid_target.same_root, prefix_wide);
        assert_eq!(
            legacy_target.other_root.live_holder_count,
            LiveHolderCountBucket::Zero
        );
        let from_api = request
            .live_holder_summary_by_root("legacy")
            .unwrap()
            .same_root;
        assert_eq!(from_api.live_holder_count, prefix_wide.live_holder_count);
        assert_eq!(from_api.holder_version, prefix_wide.holder_version);
        assert_eq!(
            from_api.oldest_holder_purpose,
            prefix_wide.oldest_holder_purpose
        );
    }

    #[test]
    fn holder_purpose_bucket_is_closed_and_maps_missing_separately() {
        for (raw, expected, tag) in [
            (Some("command"), HolderPurposeBucket::Command, "command"),
            (
                Some("resident-preload"),
                HolderPurposeBucket::ResidentPreload,
                "resident-preload",
            ),
            (
                Some("mcp-serve"),
                HolderPurposeBucket::McpServe,
                "mcp-serve",
            ),
            (Some("hook"), HolderPurposeBucket::Hook, "hook"),
            (Some("daemon"), HolderPurposeBucket::Daemon, "daemon"),
            (None, HolderPurposeBucket::Absent, "absent"),
            (
                Some("unrecognized"),
                HolderPurposeBucket::Unknown,
                "unknown",
            ),
        ] {
            let bucket = holder_purpose_bucket(raw);
            assert_eq!(bucket, expected);
            assert_eq!(bucket.as_tag(), tag);
        }
    }

    #[test]
    fn timeout_summary_uses_the_oldest_holders_purpose() {
        let records = [
            LeaseRecord {
                pid: 1,
                start_time_ms: 900,
                hq_version: "5.342.4".to_string(),
                purpose: Some("command".to_string()),
                root_id: None,
            },
            LeaseRecord {
                pid: 2,
                start_time_ms: 100,
                hq_version: "5.342.4".to_string(),
                purpose: Some("daemon".to_string()),
                root_id: None,
            },
        ];
        let summary = timeout_summary(&records, 1_000);
        assert_eq!(summary.oldest_holder_purpose, HolderPurposeBucket::Daemon);
    }

    #[test]
    fn holder_version_bucket_uses_the_5342_4_boundary_and_closed_values() {
        assert_eq!(
            classify_holder_version_bucket([Some("5.342.3")]),
            HolderVersionBucket::Pre53424
        );
        assert_eq!(
            classify_holder_version_bucket([Some("5.342.4")]),
            HolderVersionBucket::Current
        );
        assert_eq!(
            classify_holder_version_bucket([Some("5.343.0")]),
            HolderVersionBucket::Current
        );
        assert_eq!(
            classify_holder_version_bucket([Some("5.342.4-rc.1")]),
            HolderVersionBucket::Pre53424
        );
        assert_eq!(
            classify_holder_version_bucket([Some("5.342.3"), Some("5.342.4")]),
            HolderVersionBucket::Mixed
        );
        assert_eq!(
            classify_holder_version_bucket([Some("not-semver")]),
            HolderVersionBucket::Unknown
        );
        assert_eq!(
            classify_holder_version_bucket([None]),
            HolderVersionBucket::Unknown
        );
    }

    #[test]
    fn holder_age_bucket_covers_each_boundary() {
        assert_eq!(holder_age_bucket(Some(599_999)), HolderAgeBucket::Under10m);
        assert_eq!(
            holder_age_bucket(Some(600_000)),
            HolderAgeBucket::From10mTo1h
        );
        assert_eq!(
            holder_age_bucket(Some(3_599_999)),
            HolderAgeBucket::From10mTo1h
        );
        assert_eq!(
            holder_age_bucket(Some(3_600_000)),
            HolderAgeBucket::From1hTo24h
        );
        assert_eq!(
            holder_age_bucket(Some(86_400_000)),
            HolderAgeBucket::From1hTo24h
        );
        assert_eq!(
            holder_age_bucket(Some(86_400_001)),
            HolderAgeBucket::Over24h
        );
        assert_eq!(holder_age_bucket(None), HolderAgeBucket::Unknown);
    }

    #[test]
    fn live_holder_count_bucket_is_bounded() {
        assert_eq!(live_holder_count_bucket(0), LiveHolderCountBucket::Zero);
        assert_eq!(live_holder_count_bucket(1), LiveHolderCountBucket::One);
        assert_eq!(
            live_holder_count_bucket(2),
            LiveHolderCountBucket::TwoToThree
        );
        assert_eq!(
            live_holder_count_bucket(3),
            LiveHolderCountBucket::TwoToThree
        );
        assert_eq!(live_holder_count_bucket(4), LiveHolderCountBucket::FourPlus);
        assert_eq!(
            live_holder_count_bucket(100),
            LiveHolderCountBucket::FourPlus
        );
    }

    #[tokio::test]
    async fn root_scoped_admission_refuses_until_cli_readers_support_root_ids() {
        let (_temp, paths) = fixture();
        let pid = std::process::id();
        let start = process_start_time_ms(pid).unwrap();
        record_with_root(
            &paths.lease_directory.join(format!("{pid}-{start}.json")),
            pid,
            start,
            Some("root-a"),
        );
        let mut request = PackageUseUpdateRequest::begin_at(paths.clone()).unwrap();

        let acquire_error = match request.try_acquire_for_root("root-a") {
            Err(error) => error,
            Ok(_) => panic!("root-scoped acquisition must refuse until CLI readers support root IDs"),
        };
        assert!(acquire_error.contains(ROOT_SCOPED_ADMISSION_PRECONDITION_FAILED));
        drop(request);

        let request = PackageUseUpdateRequest::begin_at(paths).unwrap();
        let wait_error = match request
            .wait_for_root_with_summary("root-a", Duration::ZERO)
            .await
        {
            Err(error) => error,
            Ok(_) => panic!("root-scoped wait must refuse until CLI readers support root IDs"),
        };
        let PackageUseLeaseWaitError::Other(message) = wait_error else {
            panic!("root-scoped wait must report the unmet reader precondition");
        };
        assert!(message.contains(ROOT_SCOPED_ADMISSION_PRECONDITION_FAILED));
    }

    #[tokio::test]
    async fn rootless_lease_protects_the_legacy_tree() {
        let (_temp, paths) = fixture();
        let pid = std::process::id();
        let start = process_start_time_ms(pid).unwrap();
        record(
            &paths.lease_directory.join(format!("{pid}-{start}.json")),
            pid,
            start,
        );
        let request =
            PackageUseUpdateRequest::begin_at_with_root_id(paths, Some(LEGACY_ROOT_ID)).unwrap();

        let error = match request
            .wait_for_root_with_summary(LEGACY_ROOT_ID, Duration::ZERO)
            .await
        {
            Err(error) => error,
            Ok(_guard) => panic!("a rootless legacy lease must protect the legacy tree"),
        };
        let PackageUseLeaseWaitError::Timeout(summary) = error else {
            panic!("a rootless legacy lease must produce the existing timeout error");
        };
        assert_eq!(summary.live_holder_count, LiveHolderCountBucket::One);
    }

    #[test]
    fn legacy_scoped_acquire_matches_prefix_wide_for_legacy_holders() {
        let (_temp, paths) = fixture();
        let pid = std::process::id();
        let start = process_start_time_ms(pid).unwrap();
        record(
            &paths.lease_directory.join(format!("{pid}-{start}.json")),
            pid,
            start,
        );
        let mut scoped = PackageUseUpdateRequest::begin_at(paths.clone()).unwrap();
        assert!(scoped.try_acquire_for_root(LEGACY_ROOT_ID).unwrap().is_none());
        assert!(scoped.try_acquire_for_root("INVALID/ROOT").is_err());
        drop(scoped);

        let mut prefix_wide = PackageUseUpdateRequest::begin_at(paths).unwrap();
        assert!(prefix_wide.try_acquire().unwrap().is_none());
    }

    #[test]
    fn reclaims_a_live_over_ceiling_legacy_holder_with_absent_purpose() {
        let (_temp, paths) = fixture();
        let pid = std::process::id();
        let start = process_start_time_ms(pid).unwrap();
        let lease_path = paths.lease_directory.join(format!("{pid}-{start}.json"));
        record_with_details(&lease_path, pid, start, "5.304.0", None, None);
        let now_ms = start + DEFAULT_MAX_PACKAGE_USE_HOLDER_AGE_MS + 1;
        set_file_modified_time_ms(&lease_path, start);
        let mut request = PackageUseUpdateRequest::begin_at(paths).unwrap();

        let (guard, live_records) = request
            .try_acquire_with_live_records_at(now_ms)
            .unwrap();

        assert!(
            guard.is_some(),
            "an over-ceiling live holder must be reclaimed"
        );
        assert!(live_records.is_empty());
        assert!(
            !lease_path.exists(),
            "the stale live-holder record is removed"
        );
    }

    #[test]
    fn keeps_a_recent_lease_from_a_long_running_live_process() {
        let (_temp, paths) = fixture();
        let pid = std::process::id();
        let process_start_ms = process_start_time_ms(pid).unwrap();
        let now_ms = process_start_ms + DEFAULT_MAX_PACKAGE_USE_HOLDER_AGE_MS + 60_000;
        let lease_path = paths
            .lease_directory
            .join(format!("{pid}-{process_start_ms}.json"));
        record_with_details(
            &lease_path,
            pid,
            process_start_ms,
            "5.342.4",
            Some("daemon"),
            None,
        );
        set_file_modified_time_ms(&lease_path, now_ms - 60_000);
        let mut request = PackageUseUpdateRequest::begin_at(paths).unwrap();

        let (guard, live_records) = request
            .try_acquire_with_live_records_at(now_ms)
            .unwrap();

        assert!(guard.is_none(), "a recent lease must keep blocking the updater");
        assert_eq!(live_records.len(), 1, "the live lease stays in the scan");
        assert!(lease_path.exists(), "a recent live lease must not be removed");
    }

    #[tokio::test]
    async fn waits_for_a_young_live_daemon_and_keeps_its_age_bucket() {
        let (_temp, paths) = fixture();
        let pid = std::process::id();
        let start = process_start_time_ms(pid).unwrap();
        record_with_details(
            &paths.lease_directory.join(format!("{pid}-{start}.json")),
            pid,
            start,
            "5.342.4",
            Some("daemon"),
            None,
        );
        let request = PackageUseUpdateRequest::begin_at(paths).unwrap();

        let error = match request.wait_with_summary(Duration::ZERO).await {
            Err(error) => error,
            Ok(_guard) => panic!("a young live daemon must preserve the timeout report"),
        };
        let PackageUseLeaseWaitError::Timeout(summary) = error else {
            panic!("a young live daemon must preserve the timeout report");
        };

        assert_eq!(summary.live_holder_count, LiveHolderCountBucket::One);
        assert_eq!(summary.oldest_holder_age, HolderAgeBucket::Under10m);
        assert_eq!(summary.oldest_holder_purpose, HolderPurposeBucket::Daemon);
    }

    #[test]
    fn update_request_keeps_pid_and_records_legacy_root_id() {
        let (_temp, paths) = fixture();
        let request = PackageUseUpdateRequest::begin_at_with_root_id(
            paths.clone(),
            Some(LEGACY_ROOT_ID),
        )
        .unwrap();
        let request_record: serde_json::Value =
            serde_json::from_slice(&fs::read(&paths.update_request_path).unwrap()).unwrap();
        assert_eq!(request_record["pid"].as_u64(), Some(std::process::id() as u64));
        assert!(request_record["start_time_ms"].as_u64().is_some());
        assert_eq!(request_record["hq_version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(request_record["root_id"].as_str(), Some("legacy"));
        drop(request);
    }

    #[tokio::test]
    async fn other_root_live_holder_blocks_legacy_prefix_update_wait() {
        let (_temp, paths) = fixture();
        let pid = std::process::id();
        let start = process_start_time_ms(pid).unwrap();
        let other_root = paths.lease_directory.join(format!("{pid}-{start}-other.json"));
        record_with_root(&other_root, pid, start, Some("versioned-a1"));
        let request = PackageUseUpdateRequest::begin_at_with_root_id(
            paths.clone(),
            Some(LEGACY_ROOT_ID),
        )
        .unwrap();

        let error = match request
            .wait_for_root_with_summary(LEGACY_ROOT_ID, Duration::ZERO)
            .await
        {
            Err(error) => error,
            Ok(_guard) => panic!("a prefix-wide update must wait for a live holder of any root"),
        };
        let PackageUseLeaseWaitError::Timeout(summary) = error else {
            panic!("a prefix-wide update must time out while another root holds the lease");
        };
        assert_eq!(summary.same_root_live_holder_count, LiveHolderCountBucket::Zero);
        assert_eq!(summary.other_root_live_holder_count, LiveHolderCountBucket::One);
        assert!(other_root.exists(), "the live other-root lease must remain");
    }

    #[tokio::test]
    async fn prefix_timeout_summary_splits_same_and_other_root_holder_counts() {
        let (_temp, paths) = fixture();
        let pid = std::process::id();
        let start = process_start_time_ms(pid).unwrap();
        record_with_root(
            &paths.lease_directory.join(format!("{pid}-{start}-legacy.json")),
            pid,
            start,
            Some(LEGACY_ROOT_ID),
        );
        for suffix in ["other-a", "other-b"] {
            record_with_root(
                &paths
                    .lease_directory
                    .join(format!("{pid}-{start}-{suffix}.json")),
                pid,
                start,
                Some("versioned-a1"),
            );
        }
        let request = PackageUseUpdateRequest::begin_at_with_root_id(
            paths,
            Some(LEGACY_ROOT_ID),
        )
        .unwrap();

        let error = match request.wait_with_summary(Duration::ZERO).await {
            Err(error) => error,
            Ok(_) => panic!("all roots must block a prefix-wide update"),
        };
        let PackageUseLeaseWaitError::Timeout(summary) = error else {
            panic!("expected the live leases to produce a timeout summary");
        };
        assert_eq!(summary.same_root_live_holder_count, LiveHolderCountBucket::One);
        assert_eq!(
            summary.other_root_live_holder_count,
            LiveHolderCountBucket::TwoToThree
        );
    }

    #[tokio::test]
    async fn legacy_and_rootless_holders_still_block_legacy_update_wait() {
        for root_id in [Some(LEGACY_ROOT_ID), None] {
            let (_temp, paths) = fixture();
            let pid = std::process::id();
            let start = process_start_time_ms(pid).unwrap();
            let holder_path = paths.lease_directory.join(format!("{pid}-{start}.json"));
            record_with_root(&holder_path, pid, start, root_id);
            let request = PackageUseUpdateRequest::begin_at_with_root_id(
                paths,
                Some(LEGACY_ROOT_ID),
            )
            .unwrap();

            assert!(matches!(
                request
                    .wait_for_root_with_summary(LEGACY_ROOT_ID, Duration::ZERO)
                    .await,
                Err(PackageUseLeaseWaitError::Timeout(_))
            ));
        }
    }

    #[tokio::test]
    async fn timeout_summary_read_failure_preserves_timeout_error_for_caller() {
        let (_temp, paths) = fixture();
        let pid = std::process::id();
        let start = process_start_time_ms(pid).unwrap();
        record(
            &paths.lease_directory.join(format!("{pid}-{start}.json")),
            pid,
            start,
        );
        let request = PackageUseUpdateRequest::begin_at(paths).unwrap();

        let error = match request
            .wait_with_summary_using(Duration::ZERO, |request, root_id| {
                fs::remove_dir_all(&request.paths.lease_directory).unwrap();
                request.live_holder_summary_by_root(root_id)
            })
            .await
        {
            Err(error) => error,
            Ok(_) => panic!("expected the live holder to time out"),
        };

        assert_eq!(error.to_string(), PACKAGE_USE_LEASE_TIMEOUT_ERROR);
    }

    #[tokio::test]
    async fn timed_out_wait_summarizes_the_live_holder_in_its_fixture_directory() {
        let (_temp, paths) = fixture();
        let pid = std::process::id();
        let start = process_start_time_ms(pid).unwrap();
        record_with_version(
            &paths.lease_directory.join(format!("{pid}-{start}.json")),
            pid,
            start,
            "5.342.3",
        );
        let request = PackageUseUpdateRequest::begin_at(paths).unwrap();

        let error = match request.wait_with_summary(Duration::ZERO).await {
            Err(error) => error,
            Ok(_guard) => panic!("expected a timeout while a live holder remains"),
        };

        let PackageUseLeaseWaitError::Timeout(summary) = error else {
            panic!("expected a timeout summary for a live lease");
        };
        assert_eq!(summary.live_holder_count, LiveHolderCountBucket::One);
        assert_eq!(summary.holder_version, HolderVersionBucket::Pre53424);
        assert_eq!(
            summary.oldest_holder_age,
            holder_age_bucket(Some(now_epoch_ms().saturating_sub(start)))
        );
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
    fn macos_start_time_skew_is_live_but_reused_pid_is_stale() {
        // The first offset is just beyond the previous 20ms bound; the second
        // represents a reused PID and must remain outside the 1s allowance.
        let actual_start_ms: u64 = 10_000;
        let runtime_origin_start_ms = actual_start_ms + 21;
        let observed_delta_ms = actual_start_ms.abs_diff(runtime_origin_start_ms);
        assert!(
            same_process_start_with_tolerance(
                actual_start_ms,
                runtime_origin_start_ms,
                MACOS_PROCESS_START_TOLERANCE_MS,
            ),
            "observed macOS process-start delta was {observed_delta_ms}ms; tolerance is {MACOS_PROCESS_START_TOLERANCE_MS}ms"
        );

        let reused_pid_start_ms = actual_start_ms + 5_000;
        assert!(
            !same_process_start_with_tolerance(
                actual_start_ms,
                reused_pid_start_ms,
                MACOS_PROCESS_START_TOLERANCE_MS,
            ),
            "a 5000ms reused-PID offset must remain stale"
        );
    }

    #[tokio::test]
    async fn wait_timeout_returns_the_package_use_lease_timeout_error() {
        let (_temp, paths) = fixture();
        let pid = std::process::id();
        let start = process_start_time_ms(pid).unwrap();
        record(
            &paths.lease_directory.join(format!("{pid}-{start}.json")),
            pid,
            start,
        );
        let request = PackageUseUpdateRequest::begin_at(paths).unwrap();

        let result = request.wait(Duration::from_millis(200)).await;

        assert_eq!(
            result.as_ref().err().map(String::as_str),
            Some(PACKAGE_USE_LEASE_TIMEOUT_ERROR)
        );
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

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_live_lease_with_900ms_btime_precision_gap_is_not_stale() {
        let btime_seconds = 1_700_000_000;
        let uptime_seconds = 1_000.0;
        let now_ms = 1_700_001_000_900;
        let recorded_origin_ms = now_ms - (uptime_seconds * 1000.0) as u64;
        let boot_epoch_ms = linux_boot_epoch_ms(btime_seconds, uptime_seconds, now_ms).unwrap();
        let start_ticks = 123_456;
        let hz = 100u64;
        let computed_start_ms = boot_epoch_ms + start_ticks * 1000 / hz;
        let recorded_start_ms = recorded_origin_ms + start_ticks * 1000 / hz;

        assert_eq!(recorded_origin_ms.abs_diff(btime_seconds * 1000), 900);
        assert!(same_process_start(computed_start_ms, recorded_start_ms));
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
                purpose: None,
                root_id: None,
            };
            atomic_write(
                &paths.update_request_path,
                &serde_json::to_vec(&record).unwrap(),
            )?;
            Ok(Self {
                paths,
                owns_request: true,
                target_root_id: LEGACY_ROOT_ID.to_owned(),
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
