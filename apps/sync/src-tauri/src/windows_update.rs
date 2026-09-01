//! Windows update handoff.
//!
//! The Tauri updater launches NSIS and immediately calls `process::exit`, which
//! bypasses HQ's normal exit teardown. This module keeps the verified download
//! but hands installation to a copied, signed HQ executable. The helper waits
//! for the parent to exit cleanly before NSIS can touch the installed files.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::Update;
use ulid::Ulid;
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

use crate::util::logfile::log;

const HELPER_FLAG: &str = "--hq-update-helper";
const PARENT_PID_ARG: &str = "--parent-pid";
const INSTALLER_ARG: &str = "--installer";
const EXPECTED_SHA_ARG: &str = "--expected-sha256";
const READY_FILE_ARG: &str = "--ready-file";
const RECEIPT_FILE_ARG: &str = "--receipt-file";
const ORIGINAL_EXE_ARG: &str = "--original-exe";
const HELPER_READY_TIMEOUT: Duration = Duration::from_secs(10);
const PARENT_EXIT_TIMEOUT_MS: u32 = 120_000;
const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(10);
const STALE_STAGING_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateReceipt<'a> {
    state: &'a str,
    version: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
}

#[derive(Deserialize)]
struct StoredUpdateReceipt {
    state: String,
}

struct StagedUpdate {
    root: PathBuf,
    helper: PathBuf,
    installer: PathBuf,
    ready: PathBuf,
    receipt: PathBuf,
    original_exe: PathBuf,
    sha256: String,
    version: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn file_sha256_hex(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("read staged installer: {error}"))?;
    Ok(sha256_hex(&bytes))
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("create {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("write {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("sync {}: {error}", path.display()))
}

fn write_receipt(path: &Path, state: &str, version: &str, detail: Option<&str>) {
    let receipt = UpdateReceipt {
        state,
        version,
        detail,
    };
    let result = serde_json::to_vec(&receipt)
        .map_err(|error| error.to_string())
        .and_then(|bytes| fs::write(path, bytes).map_err(|error| error.to_string()));
    if let Err(error) = result {
        log(
            "updater",
            &format!("could not write update receipt: {error}"),
        );
    }
}

fn stage_update(bytes: &[u8], version: &str) -> Result<StagedUpdate, String> {
    if !bytes.starts_with(b"MZ") {
        return Err("verified Windows update is not a PE executable".to_string());
    }
    let root =
        std::env::temp_dir()
            .join("hq-desktop-update")
            .join(format!("{}-{}", version, Ulid::new()));
    fs::create_dir_all(&root)
        .map_err(|error| format!("create update staging directory: {error}"))?;

    let result: Result<StagedUpdate, String> = (|| {
        let installer = root.join("hq-update-installer.exe");
        write_new_file(&installer, bytes)?;
        let sha256 = sha256_hex(bytes);

        let original_exe = std::env::current_exe()
            .map_err(|error| format!("resolve current HQ executable: {error}"))?;
        let helper = root.join("hq-update-helper.exe");
        fs::copy(&original_exe, &helper)
            .map_err(|error| format!("copy signed update helper: {error}"))?;

        let staged = StagedUpdate {
            root: root.clone(),
            helper,
            installer,
            ready: root.join("helper.ready"),
            receipt: root.join("receipt.json"),
            original_exe,
            sha256,
            version: version.to_string(),
        };
        write_receipt(&staged.receipt, "staged", version, None);
        Ok(staged)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&root);
    }
    result
}

fn cleanup_staged_update(staged: &StagedUpdate) {
    if let Err(error) = fs::remove_dir_all(&staged.root) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log(
                "updater",
                &format!("could not remove update staging directory: {error}"),
            );
        }
    }
}

fn stop_helper_and_cleanup(helper: &mut Child, staged: &StagedUpdate) {
    let _ = helper.kill();
    let _ = helper.wait();
    cleanup_staged_update(staged);
}

fn is_terminal_receipt_state(state: &str) -> bool {
    matches!(state, "installed" | "rolled-back" | "failed")
}

fn should_cleanup_staging_dir(state: Option<&str>, age: Duration) -> bool {
    state.is_some_and(is_terminal_receipt_state) || age >= STALE_STAGING_MAX_AGE
}

fn staging_dir_age(path: &Path) -> Duration {
    let receipt = path.join("receipt.json");
    let modified = fs::metadata(&receipt)
        .or_else(|_| fs::metadata(path))
        .and_then(|metadata| metadata.modified());
    modified
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .unwrap_or_default()
}

fn receipt_state(path: &Path) -> Option<String> {
    let bytes = fs::read(path.join("receipt.json")).ok()?;
    serde_json::from_slice::<StoredUpdateReceipt>(&bytes)
        .ok()
        .map(|receipt| receipt.state)
}

fn cleanup_update_staging_dirs() {
    let root = std::env::temp_dir().join("hq-desktop-update");
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let state = receipt_state(&path);
        if should_cleanup_staging_dir(state.as_deref(), staging_dir_age(&path)) {
            if let Err(error) = fs::remove_dir_all(&path) {
                log(
                    "updater",
                    &format!(
                        "could not clean completed or abandoned update staging directory {}: {error}",
                        path.display()
                    ),
                );
            }
        }
    }
    let _ = fs::remove_dir(&root);
}

fn spawn_helper(staged: &StagedUpdate) -> Result<std::process::Child, String> {
    Command::new(&staged.helper)
        .arg(HELPER_FLAG)
        .arg(PARENT_PID_ARG)
        .arg(std::process::id().to_string())
        .arg(INSTALLER_ARG)
        .arg(&staged.installer)
        .arg(EXPECTED_SHA_ARG)
        .arg(&staged.sha256)
        .arg(READY_FILE_ARG)
        .arg(&staged.ready)
        .arg(RECEIPT_FILE_ARG)
        .arg(&staged.receipt)
        .arg(ORIGINAL_EXE_ARG)
        .arg(&staged.original_exe)
        .arg("--target-version")
        .arg(&staged.version)
        .spawn()
        .map_err(|error| format!("launch update helper: {error}"))
}

/// Download through Tauri (including minisign verification), then prepare the
/// helper, stop HQ-owned processes, and exit through Tauri's normal lifecycle.
pub async fn install_verified_update(app: &AppHandle, update: &Update) -> Result<(), String> {
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    if crate::updater::sync_in_progress() {
        return Err(crate::updater::UPDATE_DEFERRED_DURING_SYNC.to_string());
    }

    let staged = stage_update(&bytes, &update.version)?;
    let mut helper = match spawn_helper(&staged) {
        Ok(helper) => helper,
        Err(error) => {
            cleanup_staged_update(&staged);
            return Err(error);
        }
    };
    let started = tokio::time::Instant::now();
    while !staged.ready.is_file() {
        if started.elapsed() >= HELPER_READY_TIMEOUT {
            stop_helper_and_cleanup(&mut helper, &staged);
            return Err("Windows update helper did not become ready".to_string());
        }
        match helper.try_wait() {
            Ok(Some(status)) => {
                cleanup_staged_update(&staged);
                return Err(format!("Windows update helper exited early: {status}"));
            }
            Ok(None) => {}
            Err(error) => {
                stop_helper_and_cleanup(&mut helper, &staged);
                return Err(format!("poll update helper: {error}"));
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Recheck after the download and helper startup. A manual sync gets to
    // finish; the updater will retry instead of interrupting it.
    if crate::updater::sync_in_progress() {
        stop_helper_and_cleanup(&mut helper, &staged);
        return Err(crate::updater::UPDATE_DEFERRED_DURING_SYNC.to_string());
    }
    let quiescence = match crate::commands::process::quiesce_for_update(PROCESS_EXIT_TIMEOUT) {
        Ok(quiescence) => quiescence,
        Err(error) => {
            stop_helper_and_cleanup(&mut helper, &staged);
            return Err(error);
        }
    };
    write_receipt(&staged.receipt, "parent-exiting", &staged.version, None);
    log(
        "updater",
        &format!(
            "Windows update {} staged; exiting for installer handoff",
            staged.version
        ),
    );
    quiescence.commit();
    app.exit(0);
    Ok(())
}

fn arg_value(args: &[String], name: &str) -> Result<String, String> {
    let index = args
        .iter()
        .position(|arg| arg == name)
        .ok_or_else(|| format!("missing {name}"))?;
    args.get(index + 1)
        .cloned()
        .ok_or_else(|| format!("missing value for {name}"))
}

fn require_helper_sibling(helper_dir: &Path, path: &Path, label: &str) -> Result<(), String> {
    if path.parent() == Some(helper_dir) {
        Ok(())
    } else {
        Err(format!("{label} must be staged beside the update helper"))
    }
}

fn wait_for_parent(parent_pid: u32) -> Result<(), String> {
    unsafe {
        let Ok(parent) = OpenProcess(PROCESS_SYNCHRONIZE, false, parent_pid) else {
            return Ok(());
        };
        let result = WaitForSingleObject(parent, PARENT_EXIT_TIMEOUT_MS);
        let _ = CloseHandle(parent);
        if result == WAIT_OBJECT_0 {
            Ok(())
        } else {
            Err("timed out waiting for the HQ parent process to exit".to_string())
        }
    }
}

/// The helper executable is a byte-for-byte copy of the pre-update HQ binary.
/// If NSIS fails after touching the install directory, put that known-working
/// executable back before relaunching so the user is not stranded without an
/// app or a manual recovery surface.
fn restore_original_executable(helper: &Path, original_exe: &Path) -> Result<(), String> {
    fs::copy(helper, original_exe)
        .map_err(|error| format!("restore prior HQ executable: {error}"))?;
    Command::new(original_exe)
        .spawn()
        .map_err(|error| format!("relaunch restored HQ executable: {error}"))?;
    Ok(())
}

fn run_helper(args: &[String]) -> Result<(), String> {
    let parent_pid = arg_value(args, PARENT_PID_ARG)?
        .parse::<u32>()
        .map_err(|_| "invalid parent pid".to_string())?;
    let installer = PathBuf::from(arg_value(args, INSTALLER_ARG)?);
    let expected_sha = arg_value(args, EXPECTED_SHA_ARG)?;
    let ready = PathBuf::from(arg_value(args, READY_FILE_ARG)?);
    let receipt = PathBuf::from(arg_value(args, RECEIPT_FILE_ARG)?);
    let original_exe = PathBuf::from(arg_value(args, ORIGINAL_EXE_ARG)?);
    let version = arg_value(args, "--target-version")?;
    let helper = std::env::current_exe().map_err(|error| error.to_string())?;
    let helper_dir = helper
        .parent()
        .ok_or_else(|| "update helper has no parent directory".to_string())?;
    require_helper_sibling(helper_dir, &installer, "installer")?;
    require_helper_sibling(helper_dir, &ready, "ready marker")?;
    require_helper_sibling(helper_dir, &receipt, "receipt")?;

    let actual_sha = file_sha256_hex(&installer)?;
    if expected_sha.len() != 64 || !actual_sha.eq_ignore_ascii_case(&expected_sha) {
        return Err("staged installer checksum changed before launch".to_string());
    }
    write_new_file(&ready, b"ready")?;
    write_receipt(&receipt, "waiting-for-parent", &version, None);
    wait_for_parent(parent_pid)?;

    write_receipt(&receipt, "installing", &version, None);
    let result = Command::new(&installer)
        .args(["/P", "/R", "/UPDATE"])
        .status()
        .map_err(|error| format!("launch NSIS updater: {error}"));
    match result {
        Ok(status) if status.success() => {
            write_receipt(&receipt, "installed", &version, None);
            Ok(())
        }
        Ok(status) => {
            let detail = format!("NSIS exited with {status}");
            match restore_original_executable(&helper, &original_exe) {
                Ok(()) => {
                    write_receipt(&receipt, "rolled-back", &version, Some(&detail));
                    Err(detail)
                }
                Err(rollback_error) => {
                    let combined = format!("{detail}; rollback failed: {rollback_error}");
                    write_receipt(&receipt, "failed", &version, Some(&combined));
                    Err(combined)
                }
            }
        }
        Err(error) => {
            match restore_original_executable(&helper, &original_exe) {
                Ok(()) => {
                    write_receipt(&receipt, "rolled-back", &version, Some(&error));
                    Err(error)
                }
                Err(rollback_error) => {
                    let combined = format!("{error}; rollback failed: {rollback_error}");
                    write_receipt(&receipt, "failed", &version, Some(&combined));
                    Err(combined)
                }
            }
        }
    }
}

/// Dispatch the copied helper before Sentry, single-instance, or Tauri setup.
/// Returns normally only for a standard app launch.
pub fn run_helper_if_requested() {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|arg| arg == HELPER_FLAG) {
        cleanup_update_staging_dirs();
        return;
    }
    let code = match run_helper(&args) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Windows update helper failed: {error}");
            1
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_rejects_paths_outside_its_staging_directory() {
        let helper_dir = Path::new(r"C:\Temp\hq-update");
        assert!(require_helper_sibling(
            helper_dir,
            Path::new(r"C:\Temp\hq-update\installer.exe"),
            "installer"
        )
        .is_ok());
        assert!(require_helper_sibling(
            helper_dir,
            Path::new(r"C:\Windows\System32\notepad.exe"),
            "installer"
        )
        .is_err());
    }

    #[test]
    fn helper_checksum_contract_is_sha256() {
        assert_eq!(
            sha256_hex(b"hq-update"),
            "504cb0ca325c9fade5fd05e16db3b71ec6329bbe79d8e2ed9af0a3b1dd206547"
        );
    }

    #[test]
    fn staging_cleanup_removes_terminal_and_abandoned_attempts() {
        assert!(should_cleanup_staging_dir(
            Some("installed"),
            Duration::ZERO
        ));
        assert!(should_cleanup_staging_dir(
            Some("rolled-back"),
            Duration::ZERO
        ));
        assert!(should_cleanup_staging_dir(
            Some("failed"),
            Duration::ZERO
        ));
        assert!(!should_cleanup_staging_dir(
            Some("installing"),
            Duration::ZERO
        ));
        assert!(should_cleanup_staging_dir(
            None,
            STALE_STAGING_MAX_AGE
        ));
    }
}
